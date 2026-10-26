// SPDX-License-Identifier: AGPL-3.0-or-later
// Graceful shutdown: drainChildren (util.ts), the afterKill hook on util.run's own SIGKILL, and the
// two node.ts pieces shutdown() is built from (scheduleLoop's idle() and the time budget). The
// failure these exist for: the daemon exited over a running git, the service manager SIGKILLed it,
// and the index.lock it left wedged a repo for twelve days.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtemp, mkdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { allowChildSpawns, drainChildren, liveChildCount, run, runBytes, RUN_REFUSED_SHUTTING_DOWN } from '../src/util';
import { reapGitLocks } from '../src/gitlocks';
import { testScopedLockHolderCheck } from './support/proc-scope';
import {
  scheduleLoop,
  SHUTDOWN_KILL_WAIT_MS,
  SHUTDOWN_SETTLE_MS,
  SHUTDOWN_TERM_GRACE_MS,
  SYSTEMD_DEFAULT_TIMEOUT_STOP_MS,
} from '../src/node';

let base: string;

beforeEach(async () => {
  base = await mkdtemp(join(tmpdir(), 'sukarfleet-shutdown-'));
});

afterEach(async () => {
  // A drain leaves spawning refused, as it must for a daemon about to exit; the suite carries on.
  allowChildSpawns();
  await rm(base, { recursive: true, force: true });
});

async function git(cwd: string, args: string[]) {
  const r = await run(['git', ...args], { cwd });
  if (r.code !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
  return r;
}

async function repo(): Promise<string> {
  const dir = join(base, 'r');
  await mkdir(dir, { recursive: true });
  await git(dir, ['init', '-q', '-b', 'main']);
  await git(dir, ['config', 'user.email', 'r@test']);
  await git(dir, ['config', 'user.name', 'r']);
  await git(dir, ['config', 'commit.gpgsign', 'false']);
  await writeFile(join(dir, 'a.txt'), 'one');
  await git(dir, ['add', '-A']);
  await git(dir, ['commit', '-q', '-m', 'base']);
  await writeFile(join(dir, 'a.txt'), 'two');
  return dir;
}

async function exists(p: string): Promise<boolean> {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

async function waitFor(cond: () => Promise<boolean>, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await cond()) return;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error('condition not met in time');
}

// A git child that holds index.lock for as long as its "editor" runs: `git commit -a` writes the new
// index into the lock and renames it into place only after the editor exits.
function commitHoldingLock(dir: string, editor: string) {
  return run(['git', 'commit', '-a'], { cwd: dir, timeoutMs: 120_000, env: { GIT_EDITOR: editor } });
}

describe('drainChildren', () => {
  test('waits for an in-flight git to finish on its own, and leaves no lock', async () => {
    const dir = await repo();
    const lock = join(dir, '.git', 'index.lock');
    const child = commitHoldingLock(dir, 'sleep 1; echo "drained commit" >');
    await waitFor(() => exists(lock));

    const t0 = Date.now();
    const drained = await drainChildren({ settleMs: 10_000, termGraceMs: 4000, killWaitMs: 2000 });

    expect(drained).toEqual({ terminated: 0, killed: 0, abandoned: 0 });
    expect(Date.now() - t0).toBeGreaterThanOrEqual(500); // it really waited for the commit
    expect((await child).code).toBe(0);
    expect(await exists(lock)).toBe(false);
    allowChildSpawns();
    expect((await git(dir, ['log', '-1', '--format=%s'])).stdout.trim()).toBe('drained commit');
  });

  test('past the bound, SIGTERM: git removes its own lock on the way out', async () => {
    const dir = await repo();
    const lock = join(dir, '.git', 'index.lock');
    // The orphaned editor keeps the output pipe open for a while, which is what termGraceMs has to
    // cover (util's pipe drain gives up after 2 s).
    const child = commitHoldingLock(dir, 'sleep 6; true');
    await waitFor(() => exists(lock));

    const t0 = Date.now();
    const drained = await drainChildren({ settleMs: 300, termGraceMs: 4000, killWaitMs: 2000 });

    expect(drained).toEqual({ terminated: 1, killed: 0, abandoned: 0 });
    expect(Date.now() - t0).toBeLessThan(5000);
    expect((await child).code).not.toBe(0);
    expect(await exists(lock)).toBe(false);
    expect(liveChildCount()).toBe(0);
  });

  test.skipIf(process.platform === 'win32')('a child that ignores SIGTERM is SIGKILLed and its orphaned lock cleared', async () => {
    const dir = await repo();
    const lock = join(dir, '.git', 'index.lock');
    const hooked: number[] = [];
    const child = runBytes(['sh', '-c', 'trap "" TERM; : > .git/index.lock; exec sleep 30'], {
      cwd: dir,
      timeoutMs: 120_000,
      afterKill: async ({ startedAtMs }) => {
        hooked.push(startedAtMs);
        await reapGitLocks(dir, { createdSinceMs: startedAtMs, reason: 'orphaned-by-kill', stamp: 't', holderCheck: testScopedLockHolderCheck });
      },
    });
    await waitFor(() => exists(lock));

    const drained = await drainChildren({ settleMs: 200, termGraceMs: 300, killWaitMs: 5000 });

    expect(drained).toEqual({ terminated: 1, killed: 1, abandoned: 0 });
    expect((await child).signalCode).toBe('SIGKILL');
    expect(hooked).toHaveLength(1);
    expect(await exists(lock)).toBe(false);
  });

  test('a wedged await cannot hold shutdown: the bound wins', async () => {
    const t0 = Date.now();
    const drained = await drainChildren({ settled: new Promise(() => {}), settleMs: 200, termGraceMs: 100, killWaitMs: 100 });
    expect(Date.now() - t0).toBeLessThan(1500);
    expect(drained).toEqual({ terminated: 0, killed: 0, abandoned: 0 });
  });

  test('once drained, nothing new is started -- except a step that restores consistency', async () => {
    await drainChildren({ settleMs: 0, termGraceMs: 0, killWaitMs: 0 });
    const r = await run(['git', '--version']);
    expect(r.code).toBe(RUN_REFUSED_SHUTTING_DOWN);
    expect(r.stderr).toContain('shutting down');
    // What syncer.ts's `merge --abort` and gitlocks.ts's lsof/tasklist probes use.
    expect((await run(['git', '--version'], { evenWhileDraining: true })).code).toBe(0);
    allowChildSpawns();
    expect((await run(['git', '--version'])).code).toBe(0);
  });
});

describe('util.run afterKill', () => {
  test.skipIf(process.platform === 'win32')('runs after the timeout escalation to SIGKILL, and only then', async () => {
    const calls: string[] = [];
    // Dies of the SIGTERM: git would have cleaned up after itself, so there is nothing to clear.
    const polite = await run(['sh', '-c', 'exec sleep 30'], {
      timeoutMs: 100,
      killGraceMs: 2000,
      afterKill: async () => {
        calls.push('polite');
      },
    });
    expect(polite.code).toBe(124);
    // Ignores SIGTERM and has to be SIGKILLed.
    const stubborn = await runBytes(['sh', '-c', 'trap "" TERM; exec sleep 30'], {
      timeoutMs: 100,
      killGraceMs: 200,
      afterKill: async () => {
        calls.push('stubborn');
      },
    });
    expect(stubborn.code).toBe(124);
    expect(stubborn.signalCode).toBe('SIGKILL');
    // Exits normally.
    await run(['true'], {
      afterKill: async () => {
        calls.push('clean');
      },
    });
    expect(calls).toEqual(['stubborn']);
  });

  test('a hook that throws costs the caller nothing', async () => {
    const r = await run(['sh', '-c', 'trap "" TERM; exec sleep 30'], {
      timeoutMs: 100,
      killGraceMs: 100,
      afterKill: async () => {
        throw new Error('boom');
      },
    });
    expect(r.code).toBe(124);
  });
});

describe('node.ts shutdown pieces', () => {
  test('the whole drain budget fits inside systemd\'s default TimeoutStopSec, with room to spare', () => {
    const budget = SHUTDOWN_SETTLE_MS + SHUTDOWN_TERM_GRACE_MS + SHUTDOWN_KILL_WAIT_MS;
    expect(budget).toBeLessThanOrEqual(SYSTEMD_DEFAULT_TIMEOUT_STOP_MS / 2);
    expect(SHUTDOWN_SETTLE_MS).toBeGreaterThanOrEqual(30_000);
  });

  test('scheduleLoop idle() resolves when the in-flight iteration ends, and stop() starts no other', async () => {
    let release: () => void = () => {};
    let runs = 0;
    const loop = scheduleLoop('test', 10, async () => {
      runs++;
      await new Promise<void>((r) => {
        release = r;
      });
    });
    await waitFor(async () => runs === 1);
    loop.stop();
    let idle = false;
    const p = loop.idle().then(() => {
      idle = true;
    });
    await new Promise((r) => setTimeout(r, 30));
    expect(idle).toBe(false);
    release();
    await p;
    expect(idle).toBe(true);
    await new Promise((r) => setTimeout(r, 50));
    expect(runs).toBe(1);
    await loop.idle(); // settled for good
  });
});
