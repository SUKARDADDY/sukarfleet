// SPDX-License-Identifier: AGPL-3.0-or-later
// gitlocks.ts on its own: which processes count as possible lock holders, the precision of the
// post-SIGKILL "created since the child started" rule, and linked worktrees. The end-to-end cases
// (a stale lock in a real cycle, a human's commit, a held descriptor) live in syncer.test.ts.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtemp, mkdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { listGitLocks, macosLockHolders, mayHoldRepoLocks, reapGitLocks, resolveGitDirs } from '../src/gitlocks';
import { testScopedLockHolderCheck } from './support/proc-scope';
import { run } from '../src/util';

let base: string;

beforeEach(async () => {
  base = await mkdtemp(join(tmpdir(), 'sukarfleet-locks-'));
});

afterEach(async () => {
  await rm(base, { recursive: true, force: true });
});

async function git(cwd: string, args: string[]) {
  const r = await run(['git', ...args], { cwd });
  if (r.code !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
  return r;
}

async function repo(name = 'r'): Promise<string> {
  const dir = join(base, name);
  await mkdir(dir, { recursive: true });
  await git(dir, ['init', '-q', '-b', 'main']);
  await git(dir, ['config', 'user.email', 'r@test']);
  await git(dir, ['config', 'user.name', 'r']);
  await git(dir, ['config', 'commit.gpgsign', 'false']);
  await writeFile(join(dir, 'a.txt'), 'a');
  await git(dir, ['add', '-A']);
  await git(dir, ['commit', '-q', '-m', 'base']);
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

const free = async () => 'free' as const;

describe('mayHoldRepoLocks', () => {
  test('a git that writes counts, whatever its options', () => {
    expect(mayHoldRepoLocks(['git', 'commit', '-a'])).toBe(true);
    expect(mayHoldRepoLocks(['/usr/bin/git', '-C', '/some/repo', 'add', '-A'])).toBe(true);
    expect(mayHoldRepoLocks(['git', '-c', 'core.editor=vi', 'rebase', '-i'])).toBe(true);
    expect(mayHoldRepoLocks(['C:\\Program Files\\Git\\cmd\\git.exe', 'merge', 'x'])).toBe(true);
    // Options only, no subcommand: an unknown shape answers yes.
    expect(mayHoldRepoLocks(['git'])).toBe(true);
  });

  test('the long-lived helpers that never lock the repo do not count', () => {
    // What a dead mesh connection leaves behind after the daemon's own fetch timeout.
    expect(mayHoldRepoLocks(['/usr/lib/git-core/git', 'remote-http', 'fleet-peer', 'http://192.0.2.1:7710/git/r'])).toBe(false);
    expect(mayHoldRepoLocks(['/usr/lib/git-core/git-remote-http', 'fleet-peer', 'http://192.0.2.1:7710/git/r'])).toBe(false);
    expect(mayHoldRepoLocks(['git', 'credential-cache--daemon', '/run/sock'])).toBe(false);
    expect(mayHoldRepoLocks(['git', 'fsmonitor--daemon', 'run'])).toBe(false);
    expect(mayHoldRepoLocks(['git', 'upload-pack', '--stateless-rpc', '.'])).toBe(false);
    expect(mayHoldRepoLocks(['git', 'cat-file', '--batch'])).toBe(false);
  });

  test('read-only commands a person leaves in a pager do not count; status and writers still do', () => {
    for (const sub of ['log', 'show', 'diff', 'blame', 'grep', 'ls-files', 'rev-parse', 'for-each-ref']) {
      expect(mayHoldRepoLocks(['git', sub])).toBe(false);
    }
    // status refreshes the index opportunistically and is what an IDE runs in a loop: kept.
    for (const sub of ['status', 'commit', 'merge', 'rebase', 'update-ref', 'gc', 'maintenance', 'reflog', 'branch', 'config']) {
      expect(mayHoldRepoLocks(['git', sub])).toBe(true);
    }
  });

  test('anything that is not git does not count by name', () => {
    expect(mayHoldRepoLocks(['bash'])).toBe(false);
    expect(mayHoldRepoLocks(['gitstatusd'])).toBe(false);
    expect(mayHoldRepoLocks([])).toBe(false);
  });
});

describe('reapGitLocks: created-since (the post-SIGKILL rule)', () => {
  test('a lock created before the killed child started is not its orphan, and stays', async () => {
    const dir = await repo();
    const lock = join(dir, '.git', 'index.lock');
    await writeFile(lock, '');
    // Well past the slack allowed for the kernel's coarse file clock.
    await new Promise((r) => setTimeout(r, 100));
    const startedAtMs = Date.now();

    const repairs = await reapGitLocks(dir, { createdSinceMs: startedAtMs, reason: 'orphaned-by-kill', stamp: 't', holderCheck: free });

    expect(repairs).toEqual([]);
    expect(await exists(lock)).toBe(true);
  });

  test('a lock created after it started is retired, even one the coarse file clock stamps a tick early', async () => {
    const dir = await repo();
    const startedAtMs = Date.now();
    const lock = join(dir, '.git', 'refs', 'heads', 'main.lock');
    await writeFile(lock, '');

    const repairs = await reapGitLocks(dir, { createdSinceMs: startedAtMs, reason: 'orphaned-by-kill', stamp: 't', holderCheck: free });

    expect(repairs.map((r) => [r.lock, r.action])).toEqual([[join('.git', 'refs', 'heads', 'main.lock'), 'removed']]);
    expect(await exists(lock)).toBe(false);
  });

  test('a fresh lock somebody still holds stays, even inside the window', async () => {
    const dir = await repo();
    const startedAtMs = Date.now();
    await new Promise((r) => setTimeout(r, 30));
    const lock = join(dir, '.git', 'index.lock');
    await writeFile(lock, '');

    const repairs = await reapGitLocks(dir, {
      createdSinceMs: startedAtMs,
      reason: 'orphaned-by-kill',
      stamp: 't',
      holderCheck: async () => 'held',
    });

    expect(repairs).toEqual([]);
    expect(await exists(lock)).toBe(true);
  });
});

describe('reapGitLocks: ownership', () => {
  test.skipIf(typeof process.getuid !== 'function')('a lock owned by another account is never touched', async () => {
    const dir = await repo();
    const lock = join(dir, '.git', 'index.lock');
    await writeFile(lock, '');

    const repairs = await reapGitLocks(dir, {
      olderThanMs: 0,
      reason: 'stale',
      stamp: 't',
      holderCheck: free,
      uid: process.getuid!() + 1,
    });

    expect(repairs).toEqual([]);
    expect(await exists(lock)).toBe(true);
  });

  test('a stepped-back clock does not make a lock stale', async () => {
    const dir = await repo();
    const lock = join(dir, '.git', 'index.lock');
    await writeFile(lock, '');

    const repairs = await reapGitLocks(dir, {
      olderThanMs: 1,
      now: Date.now() - 60 * 60_000,
      reason: 'stale',
      stamp: 't',
      holderCheck: free,
    });

    expect(repairs).toEqual([]);
    expect(await exists(lock)).toBe(true);
  });
});

describe('resolveGitDirs and listGitLocks', () => {
  test('a linked worktree: index.lock in its own git dir, ref locks in the shared one', async () => {
    const main = await repo('main');
    const wt = join(base, 'wt');
    await git(main, ['worktree', 'add', '-q', '-b', 'side', wt]);
    const dirs = await resolveGitDirs(wt);
    expect(dirs).not.toBeNull();
    expect(dirs!.gitDir).toBe(join(main, '.git', 'worktrees', 'wt'));
    expect(dirs!.commonDir).toBe(join(main, '.git'));

    await writeFile(join(dirs!.gitDir, 'index.lock'), '');
    await writeFile(join(main, '.git', 'packed-refs.lock'), '');
    await writeFile(join(main, '.git', 'refs', 'heads', 'side.lock'), '');
    // Not in the set: a partial commit's scratch index and an objects/ lock wedge nothing.
    await writeFile(join(dirs!.gitDir, 'next-index-123.lock'), '');
    await mkdir(join(main, '.git', 'objects', 'info'), { recursive: true });
    await writeFile(join(main, '.git', 'objects', 'info', 'commit-graphs.lock'), '');

    const locks = (await listGitLocks(dirs!)).sort();
    expect(locks).toEqual(
      [
        join(dirs!.gitDir, 'index.lock'),
        join(main, '.git', 'packed-refs.lock'),
        join(main, '.git', 'refs', 'heads', 'side.lock'),
      ].sort(),
    );
  });

  test('not a repository: nothing to do', async () => {
    expect(await resolveGitDirs(base)).toBeNull();
    expect(await reapGitLocks(base, { olderThanMs: 0, reason: 'stale', stamp: 't', holderCheck: free })).toEqual([]);
  });
});

describe('the machine-wide holder check', () => {
  test.skipIf(process.platform !== 'linux' || Bun.spawnSync(['python3', '-c', '']).exitCode !== 0)(
    'a same-user process whose fds cannot be read counts as holding the lock (non-dumpable holder)',
    async () => {
      const dir = await repo();
      const lock = join(dir, '.git', 'index.lock');
      await writeFile(lock, '');
      // PR_SET_DUMPABLE=0 makes /proc/<pid>/fd unreadable even to the same user.
      const holder = Bun.spawn(
        [
          'python3',
          '-c',
          'import ctypes,sys,time; ctypes.CDLL(None).prctl(4,0,0,0,0); f=open(sys.argv[1]); print("ready",flush=True); time.sleep(30)',
          lock,
        ],
        { stdout: 'pipe', stderr: 'ignore' },
      );
      try {
        const reader = holder.stdout.getReader();
        await reader.read(); // "ready"
        reader.releaseLock();
        const repairs = await reapGitLocks(dir, {
          olderThanMs: 0,
          reason: 'stale',
          stamp: 't',
          holderCheck: testScopedLockHolderCheck,
        });
        expect(repairs).toEqual([]);
        expect(await exists(lock)).toBe(true);
      } finally {
        holder.kill('SIGKILL');
        await holder.exited;
      }
    },
  );

  test('macOS: a git whose ps line has a path with spaces counts as a holder', async () => {
    const calls: string[][] = [];
    const probe = async (argv: string[]) => {
      calls.push(argv);
      if (argv[0] === 'lsof') return { code: 1, stdout: '', stderr: '' }; // nobody has it open
      if (argv.includes('pid=,comm=')) return { code: 0, stdout: '  100 /usr/bin/git\n  200 /bin/zsh\n', stderr: '' };
      // `ps -o args=` joins argv with spaces: the git dir's path splits into pieces.
      return { code: 0, stdout: '  100 git --git-dir=/Volumes/Shared Drive/notes repo/.git update-ref --stdin\n', stderr: '' };
    };
    expect(await macosLockHolders('/Volumes/Shared Drive/notes repo/.git/refs/heads/x.lock', new Set(), probe)).toBe('held');
  });

  test('macOS: only lock-free gits and the daemon\'s own children running means free', async () => {
    const probe = async (argv: string[]) => {
      if (argv[0] === 'lsof') return { code: 1, stdout: '', stderr: '' };
      if (argv.includes('pid=,comm='))
        return {
          code: 0,
          stdout: '  100 /usr/bin/git\n  101 /usr/libexec/git-core/git-remote-https\n  102 /usr/bin/git\n  103 /usr/bin/git\n',
          stderr: '',
        };
      return { code: 0, stdout: '  100 git log --oneline\n  102 git cat-file --batch\n', stderr: '' };
    };
    // 103 is one of the daemon's own children.
    expect(await macosLockHolders('/tmp/r/.git/index.lock', new Set([103]), probe)).toBe('free');
  });

  test('macOS: lsof finding the lock open, or failing, never reads as free', async () => {
    const open = async (argv: string[]) => (argv[0] === 'lsof' ? { code: 0, stdout: 'p42\n', stderr: '' } : null);
    expect(await macosLockHolders('/tmp/r/.git/index.lock', new Set(), open)).toBe('held');
    const broken = async () => null;
    expect(await macosLockHolders('/tmp/r/.git/index.lock', new Set(), broken)).toBe('unknown');
  });
});
