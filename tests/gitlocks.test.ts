// SPDX-License-Identifier: AGPL-3.0-or-later
// gitlocks.ts on its own: which processes count as possible lock holders, the precision of the
// post-SIGKILL "created since the child started" rule, and linked worktrees. The end-to-end cases
// (a stale lock in a real cycle, a human's commit, a held descriptor) live in syncer.test.ts.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtemp, mkdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  classifyLinuxProcess,
  defaultLockHolderCheck,
  gitLockCapable,
  linuxLockRef,
  listGitLocks,
  macosLockHolders,
  mayHoldRepoLocks,
  reapGitLocks,
  resolveGitDirs,
} from '../src/gitlocks';
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
  // A non-dumpable process: its /proc/<pid>/fd is unreadable even to its own user, as for `(sd-pam)`
  // under every systemd --user, ssh-agent and most Electron apps. `name` sets its comm.
  function nonDumpableHolder(lock: string, name: string | null) {
    const rename = name === null ? '' : `ctypes.CDLL(None).prctl(15, ctypes.c_char_p(b"${name}"), 0, 0, 0); `;
    return Bun.spawn(
      [
        'python3',
        '-c',
        `import ctypes,sys,time; ${rename}ctypes.CDLL(None).prctl(4,0,0,0,0); f=open(sys.argv[1]); print("ready",flush=True); time.sleep(30)`,
        lock,
      ],
      { stdout: 'pipe', stderr: 'ignore' },
    );
  }

  async function ready(p: ReturnType<typeof nonDumpableHolder>): Promise<void> {
    const reader = p.stdout.getReader();
    await reader.read();
    reader.releaseLock();
  }

  const python = process.platform === 'linux' && Bun.spawnSync(['python3', '-c', '']).exitCode === 0;

  test.skipIf(!python)('a non-dumpable process that is not git does not block a repair (the accepted gap)', async () => {
    const dir = await repo();
    const lock = join(dir, '.git', 'index.lock');
    await writeFile(lock, '');
    const holder = nonDumpableHolder(lock, null);
    try {
      await ready(holder);
      const repairs = await reapGitLocks(dir, { olderThanMs: 0, reason: 'stale', stamp: 't', holderCheck: testScopedLockHolderCheck });
      expect(repairs.map((r) => r.lock)).toEqual([join('.git', 'index.lock')]);
    } finally {
      holder.kill('SIGKILL');
      await holder.exited;
    }
  });

  test.skipIf(!python)('a non-dumpable process whose command name is git blocks it, unreadable fds or not', async () => {
    const dir = await repo();
    const lock = join(dir, '.git', 'index.lock');
    await writeFile(lock, '');
    const holder = nonDumpableHolder(lock, 'git');
    try {
      await ready(holder);
      const repairs = await reapGitLocks(dir, { olderThanMs: 0, reason: 'stale', stamp: 't', holderCheck: testScopedLockHolderCheck });
      expect(repairs).toEqual([]);
      expect(await exists(lock)).toBe(true);
    } finally {
      holder.kill('SIGKILL');
      await holder.exited;
    }
  });

  // Unscoped: the production check against this machine's real process table. A Linux user session
  // always has non-dumpable processes of its own; counting them as holders made every verdict
  // 'unknown' and no lock was ever repaired. The whole-machine verdict may be 'held' if something on
  // this machine is running git right now, so that part asserts only "not unknown"; the spawned
  // process's own classification is asserted exactly.
  test.skipIf(!python)('production check, real process table: a non-dumpable non-git process is not a holder', async () => {
    const dir = await repo();
    const lock = join(dir, '.git', 'index.lock');
    await writeFile(lock, '');
    const holder = nonDumpableHolder(lock, null);
    const gitNamed = nonDumpableHolder(lock, 'git');
    try {
      await ready(holder);
      await ready(gitNamed);
      const ref = await linuxLockRef(lock);
      expect(await classifyLinuxProcess(holder.pid, ref, new Set())).toBe('other');
      expect(await classifyLinuxProcess(gitNamed.pid, ref, new Set())).toBe('git-may-lock');
      expect(await defaultLockHolderCheck(lock)).not.toBe('unknown');
    } finally {
      holder.kill('SIGKILL');
      gitNamed.kill('SIGKILL');
      await holder.exited;
      await gitNamed.exited;
    }
  });

  test('gitLockCapable trusts the subcommand only when argv[0] is git', () => {
    expect(gitLockCapable('git', ['git', 'log'])).toBe(false);
    expect(gitLockCapable('git', ['/usr/bin/git', 'commit', '-a'])).toBe(true);
    // `exec -a my-committer git commit -a`: comm says git, argv[0] does not.
    expect(gitLockCapable('git', ['my-committer', 'commit', '-a'])).toBe(true);
    expect(gitLockCapable('git', ['my-committer', 'log'])).toBe(true);
    expect(gitLockCapable('git-remote-http', ['/usr/lib/git-core/git-remote-http', 'origin'])).toBe(false);
    expect(gitLockCapable('python3', ['python3', 'x.py'])).toBe(false);
  });

  test('global options that take a value are skipped before the subcommand', () => {
    expect(mayHoldRepoLocks(['git', '--attr-source', 'HEAD', 'log'])).toBe(false);
    expect(mayHoldRepoLocks(['git', '--shallow-file', 'x', 'show'])).toBe(false);
  });

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

describe('macOS: a git run by absolute path', () => {
  const ide = '/Applications/Some Tool.app/Contents/Resources/git/bin/git';
  const fixture = (argsLine: string) => async (argv: string[]) => {
    if (argv[0] === 'lsof') return { code: 1, stdout: '', stderr: '' };
    if (argv.includes('pid=,comm=')) return { code: 0, stdout: `  300 ${ide}\n`, stderr: '' };
    return { code: 0, stdout: `  300 ${argsLine}\n`, stderr: '' };
  };

  test('an editor\'s long-lived cat-file --batch, launched by full path, does not block repairs', async () => {
    expect(await macosLockHolders('/tmp/r/.git/index.lock', new Set(), fixture(`${ide} cat-file --batch`))).toBe('free');
  });

  test('a commit launched the same way does, and so does an args line that does not start with the exact path', async () => {
    expect(await macosLockHolders('/tmp/r/.git/index.lock', new Set(), fixture(`${ide} commit -a`))).toBe('held');
    expect(await macosLockHolders('/tmp/r/.git/index.lock', new Set(), fixture('/somewhere/else/git cat-file --batch'))).toBe('held');
  });
});
