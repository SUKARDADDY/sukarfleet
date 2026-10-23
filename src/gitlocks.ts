// SPDX-License-Identifier: AGPL-3.0-or-later
// Orphaned git lock files: finding them, proving nobody owns them, and retiring them.
//
// git serialises writers with O_EXCL lock files (`index.lock`, `refs/heads/x.lock`, ...). A writer
// creates the lock, writes the new content into it, and renames it over the real file; on error or
// SIGTERM it deletes the lock itself. SIGKILL, a power cut or a crash leaves it behind, and from then
// on every git command that needs it dies with "Unable to create '...lock': File exists" -- forever,
// because git never times a lock out. A synced repo stayed wedged that way for twelve days on a live
// fleet: step (1) of every cycle, `git add`, failed on a stale empty index.lock, so nothing after it
// ran either.
//
// Two callers, two ways of deciding a lock is a candidate, one way of deciding it may go:
//
//   - syncer.ts at the start of every repo cycle: a lock whose last write is older than
//     thresholds.staleGitLockMin. Age alone proves nothing (see below), it only narrows the search.
//   - util.runBytes's afterKill hook, after the daemon itself SIGKILLed a git child: a lock CREATED
//     no earlier than that child started. Created, not modified -- birth time, allowing only for the
//     kernel's coarse file clock (see isCandidate).
//
// Either way a candidate is retired only when nothing alive may still own it, and the holder check
// fails closed: an answer of "could not tell" keeps the lock, and the next cycle asks again.
//
// Why "nobody has it open" is not enough, and the holder check also asks which git processes are
// working in the repo: git does not keep a lock's file descriptor open while it holds the lock.
// `git commit -a` writes the new index into index.lock, CLOSES it, starts the editor, and renames
// the lock into place only when the editor exits -- a human composing a message for twenty minutes
// holds index.lock the whole time with no descriptor open on it. Ref locks are closed the same way
// between write and rename. A check that only looked for open descriptors would delete that lock out
// from under a live commit. So a lock counts as held when any process has it open OR any git process
// that can take locks is working inside the repository (its cwd is in it, or its argv names it).
//
// Which locks, and why these: the ones a stale copy of wedges sync. index.lock, HEAD.lock and
// ORIG_HEAD.lock in the per-worktree git dir (add, commit, merge, checkout); config.lock (remote
// set-url, which is how a new peer's remote is wired); packed-refs.lock (fetch --prune deleting a
// ref); and every refs/**/*.lock (the commit moving sync/<machine>, the fetch moving a remote-tracking
// ref). Deliberately NOT: shallow.lock (no sync repo is shallow), gc.log.lock and the objects/
// locks (a failed auto-gc or commit-graph write never fails the command that triggered it, so a
// stale one does not wedge anything), next-index-*.lock (a partial commit's private scratch index,
// which nothing else ever waits for), and the reftable backend (no sync repo uses it, and its lock
// protocol is different enough to deserve its own reading rather than a pattern match).
//
// Non-empty locks are retired too, and moved rather than deleted. git's lock protocol means a lock's
// content is never consulted by anyone but the process that wrote it: it becomes real only when that
// process renames it into place, and a lock whose writer is dead will never be renamed. A non-empty
// orphan is therefore a half-finished write that never happened -- the real index/ref/config is the
// old one, untouched -- and removing the lock loses nothing git would ever have read. The one thing
// it holds is evidence of what was in flight when the writer died, so, like repairIndex's corrupt
// index, a non-empty lock is moved to <commondir>/sukarfleet-stale-locks/<ts>/ instead of unlinked.
// An empty lock carries no bytes worth keeping; its name, size and mtime go into the audit entry.

import { link, lstat, mkdir, readdir, readFile, readlink, realpath, rename, stat, unlink } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, sep } from 'node:path';
import { randomBytes } from 'node:crypto';
import { log, run } from './util';

export type LockHolderVerdict = 'free' | 'held' | 'unknown';

// `lockPath` is the lock's canonical path; `repoRoots` are the canonical worktree, git dir and common
// dir. Injectable through SyncerOptions so a test can force the fail-closed branch.
export type LockHolderCheck = (lockPath: string, repoRoots: readonly string[]) => Promise<LockHolderVerdict>;

export interface GitDirs {
  worktree: string;
  // Per-worktree state: index, HEAD, ORIG_HEAD.
  gitDir: string;
  // Shared state: config, refs, packed-refs. The same directory as gitDir outside linked worktrees.
  commonDir: string;
}

export interface LockRepair {
  // Path of the lock relative to the repository's worktree, e.g. `.git/index.lock`.
  lock: string;
  reason: 'stale' | 'orphaned-by-kill';
  sizeBytes: number;
  // The lock's mtime: when its writer last touched it.
  lastWriteMs: number;
  action: 'removed' | 'quarantined';
  quarantinedTo?: string;
}

export interface ReapOptions {
  // Exactly one of the two selectors. olderThanMs: a lock last written at least this long before
  // `now`. createdSinceMs: a lock whose birth time is at or after this instant.
  olderThanMs?: number;
  now?: number;
  createdSinceMs?: number;
  reason: LockRepair['reason'];
  // Filesystem-safe timestamp naming the quarantine directory for non-empty locks.
  stamp: string;
  holderCheck?: LockHolderCheck;
  // The uid whose locks may be retired; null skips the check. Defaults to this process's uid where
  // the platform has one. A lock some other account created belongs to a process this daemon
  // cannot see into (another user's /proc/<pid>/fd and cwd are closed to it), so it is never ours
  // to judge.
  uid?: number | null;
}

const GIT_DIR_LOCKS = ['index.lock', 'HEAD.lock', 'ORIG_HEAD.lock'];
const COMMON_DIR_LOCKS = ['config.lock', 'packed-refs.lock'];
const QUARANTINE_DIR = 'sukarfleet-stale-locks';
// One scheduler tick at the slowest common kernel HZ (100), doubled. See isCandidate.
const FS_CLOCK_SLACK_MS = 20;
// A refs/ tree deeper than this is not something this daemon made; stop rather than wander.
const MAX_REF_DEPTH = 16;

// Where git keeps this repository's state, read from the filesystem rather than asked of git: the
// afterKill path runs while a shutdown is refusing new children, and a spawn here would be refused.
// Handles a plain repo (.git directory) and a linked worktree or submodule (.git file naming the
// git dir, plus a `commondir` file there).
export async function resolveGitDirs(repoPath: string): Promise<GitDirs | null> {
  const dotGit = join(repoPath, '.git');
  try {
    const st = await stat(dotGit);
    let gitDir: string;
    if (st.isDirectory()) {
      gitDir = dotGit;
    } else if (st.isFile()) {
      const m = /^gitdir:\s*(.+?)\s*$/m.exec(await readFile(dotGit, 'utf8'));
      if (!m) return null;
      gitDir = isAbsolute(m[1]!) ? m[1]! : join(repoPath, m[1]!);
    } else {
      return null;
    }
    let commonDir = gitDir;
    try {
      const c = (await readFile(join(gitDir, 'commondir'), 'utf8')).trim();
      if (c) commonDir = isAbsolute(c) ? c : join(gitDir, c);
    } catch {
      // No commondir file: not a linked worktree, the git dir is the common dir.
    }
    return { worktree: repoPath, gitDir, commonDir };
  } catch {
    return null;
  }
}

// Every lock file in the set the header names, as absolute paths. Existence only; nothing is judged.
export async function listGitLocks(dirs: GitDirs): Promise<string[]> {
  const found = new Set<string>();
  const fixed = [
    ...GIT_DIR_LOCKS.map((n) => join(dirs.gitDir, n)),
    ...COMMON_DIR_LOCKS.map((n) => join(dirs.commonDir, n)),
  ];
  for (const p of fixed) {
    try {
      if ((await lstat(p)).isFile()) found.add(p);
    } catch {
      // absent: the normal case
    }
  }
  await walkRefLocks(join(dirs.commonDir, 'refs'), 0, found);
  return [...found];
}

async function walkRefLocks(dir: string, depth: number, found: Set<string>): Promise<void> {
  if (depth > MAX_REF_DEPTH) return;
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    const p = join(dir, e.name);
    let isDir = e.isDirectory();
    let isFile = e.isFile();
    if (!isDir && !isFile && !e.isSymbolicLink()) {
      // A filesystem that does not report entry types: ask.
      try {
        const st = await lstat(p);
        isDir = st.isDirectory();
        isFile = st.isFile();
      } catch {
        continue;
      }
    }
    if (isDir) await walkRefLocks(p, depth + 1, found);
    else if (isFile && e.name.endsWith('.lock')) found.add(p);
  }
}

// Find, vet and retire this repo's orphaned locks. Never throws for a single lock: a lock that
// cannot be judged or moved is left exactly where it was and the rest are still considered.
export async function reapGitLocks(repoPath: string, opts: ReapOptions): Promise<LockRepair[]> {
  const dirs = await resolveGitDirs(repoPath);
  if (dirs === null) return [];
  const locks = await listGitLocks(dirs);
  if (locks.length === 0) return [];

  const uid = opts.uid !== undefined ? opts.uid : typeof process.getuid === 'function' ? process.getuid() : null;
  const holderCheck = opts.holderCheck ?? defaultLockHolderCheck;
  const roots = await canonicalRoots(dirs);
  const repairs: LockRepair[] = [];

  for (const lockPath of locks) {
    let st;
    try {
      st = await lstat(lockPath);
    } catch {
      continue; // released while we looked: the best outcome there is
    }
    if (!st.isFile()) continue;
    if (uid !== null && st.uid !== uid) continue;
    if (!isCandidate(st, opts)) continue;

    const rel = relative(repoPath, lockPath);
    let canonical: string;
    try {
      canonical = await realpath(lockPath);
    } catch {
      continue;
    }
    let verdict: LockHolderVerdict;
    try {
      verdict = await holderCheck(canonical, roots);
    } catch (err) {
      verdict = 'unknown';
      log('info', 'git lock: holder check failed; leaving the lock for the next cycle', {
        repo: repoPath,
        lock: rel,
        error: String(err),
      });
    }
    if (verdict !== 'free') {
      // Not an alarm either way: 'held' is a live git doing its job (a human's commit, an editor
      // open), 'unknown' is this platform declining to answer, and both are re-asked next cycle.
      log('info', 'git lock: still possibly in use; not touching it', { repo: repoPath, lock: rel, verdict });
      continue;
    }

    const outcome = await retireLock(lockPath, st, dirs, rel, opts.stamp);
    if (outcome === null) continue;
    repairs.push({
      lock: rel,
      reason: opts.reason,
      sizeBytes: st.size,
      lastWriteMs: st.mtimeMs,
      action: outcome.action,
      ...(outcome.quarantinedTo ? { quarantinedTo: outcome.quarantinedTo } : {}),
    });
  }
  return repairs;
}

function isCandidate(st: { mtimeMs: number; birthtimeMs: number }, opts: ReapOptions): boolean {
  if (opts.createdSinceMs !== undefined) {
    // Birth time or nothing. A filesystem that does not record it reports 0, and mtime is no
    // substitute: a lock created before the child started by somebody else, and written after, has
    // a late mtime and is not ours. Such a lock waits for the stale-lock pass and its holder check.
    //
    // FS_CLOCK_SLACK_MS exists because the kernel stamps files from its coarse clock, which runs up
    // to one scheduler tick behind the clock Date.now() reads: a lock the child created a moment
    // after the spawn was measured to carry a birth time 0.3 ms BEFORE it. Without the slack the
    // rule missed the very lock it is for. The slack does not loosen what gets deleted -- a lock
    // somebody else created in that window is still only retired if the holder check finds no live
    // owner, and a lock with no live owner is an orphan whoever made it.
    return st.birthtimeMs > 0 && st.birthtimeMs >= opts.createdSinceMs - FS_CLOCK_SLACK_MS;
  }
  if (opts.olderThanMs !== undefined) {
    const now = opts.now ?? Date.now();
    // A future mtime (a clock that was stepped back) is not stale, however far ahead it reads.
    return st.mtimeMs <= now && now - st.mtimeMs >= opts.olderThanMs;
  }
  return false;
}

// Move the lock off its name first, THEN confirm it is the file that was vetted. rename is atomic,
// so between the holder check and here exactly two things can have happened: nothing (the common
// case), or the owner released it and a new writer created a fresh lock under the same name. The
// inode tells them apart, and a fresh lock is put straight back without clobbering anything. The
// temporary name keeps the `.lock` suffix in the same directory, so git never mistakes it for a ref
// while it exists, and the move cannot cross a filesystem.
//
// On Windows a file another process holds open cannot be renamed by default; that failure lands in
// the first catch and reads as "in use", which is what it is. Nothing here forces.
async function retireLock(
  lockPath: string,
  vetted: { ino: number; dev: number; size: number; mtimeMs: number },
  dirs: GitDirs,
  rel: string,
  stamp: string,
): Promise<{ action: LockRepair['action']; quarantinedTo?: string } | null> {
  const aside = join(dirname(lockPath), `${basename(lockPath, '.lock')}.sukarfleet-reap-${randomBytes(4).toString('hex')}.lock`);
  try {
    await rename(lockPath, aside);
  } catch {
    return null;
  }
  let moved;
  try {
    moved = await lstat(aside);
  } catch {
    return null;
  }
  if (moved.ino !== vetted.ino || moved.dev !== vetted.dev || moved.size !== vetted.size || moved.mtimeMs !== vetted.mtimeMs) {
    try {
      // link() refuses to replace an existing file, so this can never clobber a lock that appeared
      // under the name in the meantime.
      await link(aside, lockPath);
      await unlink(aside);
    } catch (err) {
      log('error', 'git lock: moved a lock that changed after it was checked and could not put it back', {
        lock: lockPath,
        movedTo: aside,
        error: String(err),
      });
    }
    return null;
  }
  try {
    if (moved.size === 0) {
      await unlink(aside);
      return { action: 'removed' };
    }
    const dest = join(dirs.commonDir, QUARANTINE_DIR, stamp, rel.split(sep).join('_'));
    await mkdir(dirname(dest), { recursive: true });
    await rename(aside, dest);
    return { action: 'quarantined', quarantinedTo: dest };
  } catch (err) {
    // The lock is off its name, which is the repair; only the tidying failed.
    log('warn', 'git lock: retired a lock but could not tidy it away', { lock: lockPath, movedTo: aside, error: String(err) });
    return { action: 'quarantined', quarantinedTo: aside };
  }
}

async function canonicalRoots(dirs: GitDirs): Promise<string[]> {
  const out = new Set<string>();
  for (const p of [dirs.worktree, dirs.gitDir, dirs.commonDir]) {
    try {
      out.add(await realpath(p));
    } catch {
      out.add(p);
    }
  }
  return [...out];
}

function isWithin(path: string, root: string): boolean {
  return path === root || path.startsWith(root.endsWith(sep) ? root : root + sep);
}

// git subcommands that never take a lock in the repository they run in, so a long-lived one does not
// make every lock in that repo look owned. These are the ones that actually linger: the remote
// helpers (an orphaned `git remote-http` on a dead mesh connection can outlive its fetch by
// minutes -- the daemon's own fetch timeout leaves exactly those behind), credential helpers and
// their cache daemon, the fsmonitor daemon, the server side of a fetch (gitserve.ts serves peers
// with upload-pack), and an editor's long-running `cat-file --batch`.
const LOCK_FREE_SUBCOMMANDS = new Set(['cat-file', 'fsmonitor--daemon', 'upload-pack', 'upload-archive', 'http-fetch', 'version']);
// Global options that take their value as the next argument.
const GIT_OPTS_WITH_VALUE = new Set(['-C', '-c', '--git-dir', '--work-tree', '--namespace', '--config-env', '--super-prefix']);

// Could the process with this argv be a git holding a lock in a repository? Unknown shapes answer
// yes: a false yes costs one cycle's delay, a false no could cost somebody's commit.
export function mayHoldRepoLocks(argv: readonly string[]): boolean {
  if (argv.length === 0) return false;
  const exe = basename(argv[0]!.replace(/\\/g, '/')).toLowerCase().replace(/\.exe$/, '');
  let sub: string | undefined;
  if (exe === 'git') {
    for (let i = 1; i < argv.length; i++) {
      const a = argv[i]!;
      if (GIT_OPTS_WITH_VALUE.has(a)) {
        i++;
        continue;
      }
      if (a.startsWith('-')) continue;
      sub = a;
      break;
    }
  } else if (exe.startsWith('git-')) {
    sub = exe.slice(4);
  } else {
    return false;
  }
  if (sub === undefined) return true;
  if (sub.startsWith('remote-') || sub.startsWith('credential')) return false;
  return !LOCK_FREE_SUBCOMMANDS.has(sub);
}

// The production holder check, per platform. Every branch answers 'unknown' rather than guess when
// its tools are missing or misbehave.
export const defaultLockHolderCheck: LockHolderCheck = async (lockPath, roots) => {
  switch (process.platform) {
    case 'linux':
      return await linuxLockHolders(lockPath, roots);
    case 'darwin':
      return await macosLockHolders(lockPath, roots);
    case 'win32':
      return await windowsLockHolders();
    default:
      return 'unknown';
  }
};

// Linux: /proc, read directly. Per process: is it a lock-capable git working in this repo
// (cmdline + cwd), and does it have the lock open (fd links)? Another user's cwd and fd links are
// unreadable and skipped, which is sound only because reapGitLocks never considers a lock that
// another uid created.
async function linuxLockHolders(lockPath: string, roots: readonly string[]): Promise<LockHolderVerdict> {
  let pids: string[];
  try {
    pids = (await readdir('/proc')).filter((d) => /^\d+$/.test(d));
  } catch {
    return 'unknown';
  }
  // /proc mounted but empty, or a hidepid mount hiding everything but ourselves: not an answer.
  if (pids.length <= 1) return 'unknown';
  for (const pid of pids) {
    const base = `/proc/${pid}`;
    let argv: string[];
    try {
      argv = (await readFile(`${base}/cmdline`, 'utf8')).split('\0').filter(Boolean);
    } catch {
      continue; // exited while we looked
    }
    if (mayHoldRepoLocks(argv)) {
      if (argv.some((a) => roots.some((r) => a.includes(r)))) return 'held';
      try {
        const cwd = await readlink(`${base}/cwd`);
        if (roots.some((r) => isWithin(cwd, r))) return 'held';
      } catch {
        // another user's process, or gone
      }
    }
    let fds: string[];
    try {
      fds = await readdir(`${base}/fd`);
    } catch {
      continue;
    }
    for (const fd of fds) {
      try {
        if ((await readlink(`${base}/fd/${fd}`)) === lockPath) return 'held';
      } catch {
        // closed while we looked
      }
    }
  }
  return 'free';
}

async function probe(argv: string[]): Promise<{ code: number; stdout: string; stderr: string } | null> {
  try {
    return await run(argv, { timeoutMs: 10000, evenWhileDraining: true });
  } catch {
    return null; // the tool is absent: Bun.spawn throws ENOENT
  }
}

// macOS: no /proc. lsof answers "is it open" (exit 0 with a p-line: yes; exit 1 with no output:
// no; anything else: no answer), ps supplies argv, and lsof again supplies the cwd of each git
// that could hold a lock.
async function macosLockHolders(lockPath: string, roots: readonly string[]): Promise<LockHolderVerdict> {
  const open = await probe(['lsof', '-w', '-n', '-P', '-F', 'p', '--', lockPath]);
  if (open === null) return 'unknown';
  if (open.code === 0 && /^p\d+/m.test(open.stdout)) return 'held';
  if (!(open.code === 1 && open.stdout.trim() === '')) return 'unknown';

  const ps = await probe(['ps', '-axww', '-o', 'pid=,command=']);
  if (ps === null || ps.code !== 0) return 'unknown';
  const pids: string[] = [];
  for (const line of ps.stdout.split('\n')) {
    const m = /^\s*(\d+)\s+(.*)$/.exec(line);
    if (!m) continue;
    // Whitespace-split argv: paths with spaces split wrong, but only the executable and the
    // subcommand matter here, and the full line is what the root match below reads.
    if (!mayHoldRepoLocks(m[2]!.split(/\s+/))) continue;
    if (roots.some((r) => m[2]!.includes(r))) return 'held';
    pids.push(m[1]!);
  }
  if (pids.length === 0) return 'free';

  // Exit 1 also means "some of those pids exited meanwhile", with the rest still listed.
  const cwds = await probe(['lsof', '-w', '-n', '-P', '-a', '-p', pids.join(','), '-d', 'cwd', '-F', 'n']);
  if (cwds === null || (cwds.code !== 0 && cwds.code !== 1)) return 'unknown';
  for (const line of cwds.stdout.split('\n')) {
    if (line.startsWith('n') && roots.some((r) => isWithin(line.slice(1), r))) return 'held';
  }
  return 'free';
}

// Windows: no cheap way to read another process's cwd. Any git.exe running at all counts as a
// holder, which is coarse and errs the right way: git processes there are short-lived, and the next
// cycle asks again. When none is running, retireLock's rename is the second check -- Windows refuses
// to rename a file another process has open without delete sharing, and that refusal is read as
// "in use", never forced.
async function windowsLockHolders(): Promise<LockHolderVerdict> {
  const r = await probe(['tasklist', '/FO', 'CSV', '/NH']);
  if (r === null || r.code !== 0) return 'unknown';
  for (const line of r.stdout.split(/\r?\n/)) {
    const m = /^"([^"]*)"/.exec(line);
    if (m && m[1]!.toLowerCase() === 'git.exe') return 'held';
  }
  return 'free';
}
