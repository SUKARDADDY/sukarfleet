// SPDX-License-Identifier: AGPL-3.0-or-later
// Derived `main` materialized view (plan section 03).
// Deterministic, byte-identical across machines: every input feeding commit bytes
// is sorted in C-locale/codepoint order and every identity/date field is pinned.
// Pure git plumbing (for-each-ref/merge-tree/commit-tree/write-tree/update-index);
// no checkouts, the working tree and the repo's real index are never touched
// (all index ops use a private GIT_INDEX_FILE).

import { join } from 'node:path';
import { mkdir, rm } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import { log, run, type RunResult } from './util';

const DERIVED_REF = 'refs/sukarfleet/derived-main';
const ORIGIN_MAIN_REF = 'refs/remotes/origin/main';
const AUTHOR_NAME = 'sukarfleet';
const AUTHOR_EMAIL = 'fleet@sukarfleet.local';
const SYNC_SEG = '/sync/';

// How many times a refused or failed derived-main push is retried on later ticks before this
// machine stops asking and waits for the inputs to change. Exported so tests IMPORT the number the
// retry leg actually checks rather than re-hardcoding it.
export const MAX_PUSH_RETRIES = 3;

// Per-repo push state carried between ticks, keyed by repo path. Module-level because updateMain is
// a plain function called once per repo per tick, not an object with a lifetime -- the daemon
// process is that lifetime. Everything here is a memory of what THIS process did or last saw, and
// is safe to lose on restart: a fresh process simply re-baselines and retries once more.
//
// The push this machine still owes for a repo, with the number of retries already spent on it. Set
// whenever a push is refused or fails, cleared on a successful push and whenever a new sha is
// minted (the new sha is what is owed from then on).
const owedPush = new Map<string, { sha: string; attempts: number }>();
// The last sha THIS machine put on origin's main, so a later reading of the tracking ref can tell
// "our own push came back" from "somebody else is pushing".
const lastPushedSha = new Map<string, string>();
// The tracking ref as of the previous originMainMovedByOther() call, so a main that simply has not
// moved is not re-read as a foreign push on every tick.
const lastSeenOriginMain = new Map<string, string>();

export interface UpdateMainResult {
  sha: string | null;
  pushed: boolean;
  skipped: string | null;
}

export interface UpdateMainOpts {
  fetchedOnly?: boolean;
  // Paths that are never newest-wins clobbered: conflicts on these are resolved by
  // taking the union of both sides' content, then (if postMerge is given) re-running
  // the regenerator over the result. Mirrors must-keep #3 for the derived snapshot.
  unionPaths?: string[];
  postMerge?: string[][];
  postMergeTimeoutMs?: number;
  // Single-pusher policy (P3, node.ts's shouldPushDerivedMain): gates ONLY the push leg below.
  // Default true. The local refs/sukarfleet/derived-main update always runs regardless -- it is
  // free, and it is what keeps the derived sha diffable across the fleet even on the machine that
  // is not this cycle's pusher.
  push?: boolean;
}

interface Tip {
  machine: string;
  sha: string;
  committerTs: number;
}

// Codepoint (C-locale) comparison. Machine names/shas are ASCII here, but this
// is the sort that feeds commit bytes, so it must never be locale-dependent.
function cmpCodepoint(a: string, b: string): number {
  const ai = Array.from(a);
  const bi = Array.from(b);
  const len = Math.min(ai.length, bi.length);
  for (let i = 0; i < len; i++) {
    const ac = ai[i]!.codePointAt(0)!;
    const bc = bi[i]!.codePointAt(0)!;
    if (ac !== bc) return ac - bc;
  }
  return ai.length - bi.length;
}

async function git(repoPath: string, argv: string[], stdin?: string): Promise<RunResult> {
  return run(['git', ...argv], {
    cwd: repoPath,
    stdin,
    env: {
      GIT_AUTHOR_NAME: AUTHOR_NAME,
      GIT_AUTHOR_EMAIL: AUTHOR_EMAIL,
      GIT_COMMITTER_NAME: AUTHOR_NAME,
      GIT_COMMITTER_EMAIL: AUTHOR_EMAIL,
    },
  });
}

async function gitOK(repoPath: string, argv: string[], stdin?: string): Promise<string> {
  const r = await git(repoPath, argv, stdin);
  if (r.code !== 0) {
    throw new Error(`git ${argv.join(' ')} failed (code ${r.code}): ${r.stderr.trim() || r.stdout.trim()}`);
  }
  return r.stdout;
}

function machineFromRef(refname: string): string | null {
  const i = refname.lastIndexOf(SYNC_SEG);
  if (i < 0) return null;
  const m = refname.slice(i + SYNC_SEG.length);
  if (m.length === 0 || m.includes('/')) return null;
  return m;
}

async function enumerateTips(repoPath: string, fetchedOnly: boolean): Promise<Tip[]> {
  const patterns = fetchedOnly
    ? ['refs/remotes/*/sync/*']
    : ['refs/heads/sync/*', 'refs/remotes/*/sync/*'];
  const out = await gitOK(repoPath, [
    'for-each-ref',
    '--format=%(objectname) %(committerdate:unix) %(refname)',
    ...patterns,
  ]);
  // Newest committer date per machine; tie -> lexicographically greatest sha.
  const byMachine = new Map<string, Tip>();
  for (const line of out.split('\n')) {
    if (line.length === 0) continue;
    const sp1 = line.indexOf(' ');
    const sp2 = line.indexOf(' ', sp1 + 1);
    if (sp1 < 0 || sp2 < 0) continue;
    const sha = line.slice(0, sp1);
    const ts = Number(line.slice(sp1 + 1, sp2));
    const refname = line.slice(sp2 + 1);
    const machine = machineFromRef(refname);
    if (machine === null || !Number.isFinite(ts)) continue;
    const prev = byMachine.get(machine);
    if (
      prev === undefined ||
      ts > prev.committerTs ||
      (ts === prev.committerTs && sha > prev.sha)
    ) {
      byMachine.set(machine, { machine, sha, committerTs: ts });
    }
  }
  return Array.from(byMachine.values()).sort((a, b) => cmpCodepoint(a.machine, b.machine));
}

// One conflicted path's base(1)/ours(2)/theirs(3) stage entries, as reported by
// `merge-tree --write-tree`. A missing stage means that side deleted the path.
interface ConflictEntry {
  path: string;
  base: Entry | null;
  ours: Entry | null;
  theirs: Entry | null;
}

interface MergeResult {
  tree: string;
  conflicts: ConflictEntry[];
}

async function mergeTree(repoPath: string, a: string, b: string): Promise<MergeResult> {
  // Rename detection off + stable path encoding: pinned so two honest gits agree byte-for-byte.
  const r = await git(repoPath, [
    '-c',
    'core.quotePath=false',
    'merge-tree',
    '--write-tree',
    '--no-messages',
    '-X',
    'no-renames',
    a,
    b,
  ]);
  if (r.code !== 0 && r.code !== 1) {
    throw new Error(`git merge-tree failed (code ${r.code}): ${r.stderr.trim() || r.stdout.trim()}`);
  }
  const lines = r.stdout.split('\n').filter((l) => l.length > 0);
  const tree = lines[0] ?? '';
  if (tree.length === 0) throw new Error('git merge-tree produced no tree');
  if (r.code === 0) return { tree, conflicts: [] };
  // Remaining lines are `<mode> <object> <stage>\t<path>` entries, one per conflicted
  // stage per path (stage 1 = merge base, 2 = ours/`a`, 3 = theirs/`b`).
  const byPath = new Map<string, ConflictEntry>();
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i]!;
    const tab = line.indexOf('\t');
    if (tab < 0) continue; // defensive: skip any non-entry line
    const path = line.slice(tab + 1);
    const meta = line.slice(0, tab).trim().split(/\s+/);
    const mode = meta[0];
    const sha = meta[1];
    const stage = meta[2];
    if (!mode || !sha || !stage) continue;
    let entry = byPath.get(path);
    if (entry === undefined) {
      entry = { path, base: null, ours: null, theirs: null };
      byPath.set(path, entry);
    }
    if (stage === '1') entry.base = { mode, sha };
    else if (stage === '2') entry.ours = { mode, sha };
    else if (stage === '3') entry.theirs = { mode, sha };
  }
  return { tree, conflicts: Array.from(byPath.values()) };
}

// last author timestamp on `sha`'s history that touched `path`; null if never present.
async function lastAuthorTs(repoPath: string, sha: string, path: string): Promise<number | null> {
  const out = (await gitOK(repoPath, ['log', '-1', '--format=%at', sha, '--', path])).trim();
  if (out.length === 0) return null;
  const n = Number(out);
  return Number.isFinite(n) ? n : null;
}

interface Entry {
  mode: string;
  sha: string;
}

async function entryAt(repoPath: string, tipSha: string, path: string): Promise<Entry | null> {
  const out = (await gitOK(repoPath, ['ls-tree', tipSha, '--', path])).trim();
  if (out.length === 0) return null;
  const tab = out.indexOf('\t');
  const meta = (tab < 0 ? out : out.slice(0, tab)).split(/\s+/);
  const mode = meta[0];
  const sha = meta[2];
  if (!mode || !sha) return null;
  return { mode, sha };
}

// Newest-wins per conflicted path: greatest last-author timestamp across all input
// tips, tie broken by machine name ascending (codepoint). The winner's clean blob
// replaces the merge's conflicted entry; a winner that deleted the path removes it.
async function pickWinner(repoPath: string, tips: Tip[], path: string): Promise<Tip | null> {
  let best: Tip | null = null;
  let bestTs = -Infinity;
  for (const t of tips) {
    const ts = await lastAuthorTs(repoPath, t.sha, path);
    if (ts === null) continue;
    if (ts > bestTs || (ts === bestTs && (best === null || cmpCodepoint(t.machine, best.machine) < 0))) {
      best = t;
      bestTs = ts;
    }
  }
  return best;
}

// Content-level union of a conflicted union-path's two sides: a real 3-way merge
// (base/ours/theirs, all from this merge step) via `git merge-file --union`, which
// keeps lines unique to either side instead of picking one and discarding the other.
// Returns null for an add/delete conflict (one side has no content at all), where a
// line-union has no sensible meaning; the caller falls back to newest-wins for that path.
async function unionMergeEntry(repoPath: string, c: ConflictEntry): Promise<Entry | null> {
  if (c.ours === null || c.theirs === null) return null;
  const dir = join(tmpdir(), `sukarfleet-union-${randomBytes(8).toString('hex')}`);
  await mkdir(dir, { recursive: true });
  try {
    const baseText = c.base !== null ? await gitOK(repoPath, ['cat-file', 'blob', c.base.sha]) : '';
    const oursText = await gitOK(repoPath, ['cat-file', 'blob', c.ours.sha]);
    const theirsText = await gitOK(repoPath, ['cat-file', 'blob', c.theirs.sha]);
    const oursFile = join(dir, 'ours');
    const baseFile = join(dir, 'base');
    const theirsFile = join(dir, 'theirs');
    await Bun.write(oursFile, oursText);
    await Bun.write(baseFile, baseText);
    await Bun.write(theirsFile, theirsText);
    // -p: print the merged result to stdout instead of rewriting `oursFile`.
    // --union always resolves every hunk (keeps both sides' lines, no markers left), so
    // a non-zero exit here means a real failure (e.g. binary content), not leftover conflicts.
    const r = await git(repoPath, ['merge-file', '--union', '-p', oursFile, baseFile, theirsFile]);
    if (r.code !== 0) {
      throw new Error(`git merge-file --union failed (code ${r.code}): ${r.stderr.trim()}`);
    }
    const sha = (await gitOK(repoPath, ['hash-object', '-w', '--stdin'], r.stdout)).trim();
    return { mode: c.ours.mode, sha };
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

async function resolveConflicts(
  repoPath: string,
  baseTree: string,
  conflicts: ConflictEntry[],
  tips: Tip[],
  unionPaths: Set<string>,
): Promise<{ tree: string; unionTouched: boolean }> {
  const idx = join(tmpdir(), `sukarfleet-idx-${randomBytes(8).toString('hex')}`);
  let unionTouched = false;
  try {
    await runIndexed(repoPath, idx, ['read-tree', baseTree]);
    for (const c of conflicts) {
      const path = c.path;
      if (unionPaths.has(path)) {
        const merged = await unionMergeEntry(repoPath, c);
        if (merged) {
          unionTouched = true;
          await runIndexed(repoPath, idx, [
            'update-index',
            '--cacheinfo',
            `${merged.mode},${merged.sha},${path}`,
          ]);
          continue;
        }
        log('warn', 'derive: union path has an add/delete conflict, falling back to newest-wins', {
          repo: repoPath,
          path,
        });
      }
      const winner = await pickWinner(repoPath, tips, path);
      const entry = winner ? await entryAt(repoPath, winner.sha, path) : null;
      if (entry) {
        await runIndexed(repoPath, idx, [
          'update-index',
          '--cacheinfo',
          `${entry.mode},${entry.sha},${path}`,
        ]);
      } else {
        await runIndexed(repoPath, idx, ['update-index', '--force-remove', path]);
      }
    }
    const tree = (await runIndexed(repoPath, idx, ['write-tree'])).trim();
    return { tree, unionTouched };
  } finally {
    await rm(idx, { force: true }).catch(() => {});
  }
}

// Runs the repo's postMerge regenerator over `tree` in an isolated linked worktree, never
// touching the repo's primary working tree or real index. The seeding commit is parentless
// and referenced by nothing once the worktree is removed (same discard pattern as the
// intermediate fold commits below).
async function runPostMergeInWorktree(
  repoPath: string,
  tree: string,
  postMerge: string[][],
  timeoutMs: number,
  epochTs: number,
): Promise<string> {
  const scratch = await commitTree(repoPath, tree, [], 'fleet: derive postmerge scratch', epochTs);
  const wtDir = join(tmpdir(), `sukarfleet-derive-wt-${randomBytes(8).toString('hex')}`);
  await gitOK(repoPath, ['worktree', 'add', '--detach', '-q', wtDir, scratch]);
  try {
    for (const argv of postMerge) {
      if (argv.length === 0) continue;
      const r = await run(argv, { cwd: wtDir, timeoutMs });
      if (r.code !== 0) {
        throw new Error(`derive postMerge [${argv.join(' ')}] failed (code ${r.code}): ${r.stderr.trim().slice(0, 300)}`);
      }
    }
    await gitOK(wtDir, ['add', '-A']);
    return (await gitOK(wtDir, ['write-tree'])).trim();
  } finally {
    await git(repoPath, ['worktree', 'remove', '--force', wtDir]);
    await rm(wtDir, { recursive: true, force: true }).catch(() => {});
  }
}

async function runIndexed(repoPath: string, indexFile: string, argv: string[]): Promise<string> {
  const r = await run(['git', ...argv], {
    cwd: repoPath,
    env: {
      GIT_INDEX_FILE: indexFile,
      GIT_AUTHOR_NAME: AUTHOR_NAME,
      GIT_AUTHOR_EMAIL: AUTHOR_EMAIL,
      GIT_COMMITTER_NAME: AUTHOR_NAME,
      GIT_COMMITTER_EMAIL: AUTHOR_EMAIL,
    },
  });
  if (r.code !== 0) {
    throw new Error(`git ${argv.join(' ')} (indexed) failed (code ${r.code}): ${r.stderr.trim() || r.stdout.trim()}`);
  }
  return r.stdout;
}

async function commitTree(
  repoPath: string,
  tree: string,
  parents: string[],
  message: string,
  epochTs: number,
): Promise<string> {
  const date = `${epochTs} +0000`;
  const argv = ['commit-tree', tree];
  for (const p of parents) argv.push('-p', p);
  const r = await run(['git', ...argv], {
    cwd: repoPath,
    stdin: message,
    env: {
      GIT_AUTHOR_NAME: AUTHOR_NAME,
      GIT_AUTHOR_EMAIL: AUTHOR_EMAIL,
      GIT_AUTHOR_DATE: date,
      GIT_COMMITTER_NAME: AUTHOR_NAME,
      GIT_COMMITTER_EMAIL: AUTHOR_EMAIL,
      GIT_COMMITTER_DATE: date,
    },
  });
  if (r.code !== 0) {
    throw new Error(`git commit-tree failed (code ${r.code}): ${r.stderr.trim() || r.stdout.trim()}`);
  }
  return r.stdout.trim();
}

async function refExists(repoPath: string, ref: string): Promise<boolean> {
  const r = await git(repoPath, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`]);
  return r.code === 0 && r.stdout.trim().length > 0;
}

// The input set recorded in a derived commit's message: the "<machine> <sha>" lines.
function parseInputSet(body: string): Set<string> {
  const set = new Set<string>();
  const lines = body.split('\n');
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i]!.trim();
    // Object id is 40 hex on a SHA-1 repo, 64 hex on SHA-256 (object-format=sha256).
    if (/^\S+ (?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(line)) set.add(line);
  }
  return set;
}

function setsEqual(a: Set<string>, b: Set<string>): boolean {
  if (a.size !== b.size) return false;
  for (const v of a) if (!b.has(v)) return false;
  return true;
}

async function storedState(repoPath: string, ref: string): Promise<{ sha: string; set: Set<string> } | null> {
  if (!(await refExists(repoPath, ref))) return null;
  const sha = (await gitOK(repoPath, ['rev-parse', ref])).trim();
  const body = await gitOK(repoPath, ['show', '-s', '--format=%B', ref]);
  return { sha, set: parseInputSet(body) };
}

async function originExists(repoPath: string): Promise<boolean> {
  const r = await git(repoPath, ['config', '--get', 'remote.origin.url']);
  return r.code === 0 && r.stdout.trim().length > 0;
}

// The lease baseline for the derived-main push: origin's main as this machine last saw it, i.e.
// the value of the tracking ref refreshed by the syncer's fetch (and by pushDerivedMain below).
//
// An absent tracking ref is NOT proof that origin has no main, so it does not lease against the
// empty string. A repo adopted from a `clone --single-branch -b dev` carries a refspec that only
// ever fetches dev, so refs/remotes/origin/main stays absent for the life of that clone while
// origin's main is alive and moving; an empty lease there reads as "main must not exist yet" and
// would refuse every push forever, where the pre-lease plain --force worked. So when the ref is
// absent, ask origin directly -- ls-remote answers the same question the lease asks, and comes back
// empty for an origin that genuinely has no main yet.
//
// That fallback is a thinner guarantee than the tracking ref (it is read one round trip before the
// push instead of at the top of the cycle), and it is deliberately temporary: the first successful
// push writes the tracking ref, and every push after it leases against the normal baseline.
async function originMainLease(repoPath: string): Promise<string> {
  const r = await git(repoPath, ['rev-parse', '--verify', '--quiet', ORIGIN_MAIN_REF]);
  if (r.code === 0) return r.stdout.trim();
  const ls = await git(repoPath, ['ls-remote', 'origin', 'refs/heads/main']);
  // Could not ask origin: fall back to the strict "must not exist" expectation. A push is about to
  // be attempted against the same unreachable origin and would fail on its own anyway; the point is
  // to never widen the lease on a guess.
  if (ls.code !== 0) return '';
  const line = ls.stdout.split('\n').find((l) => l.trim().length > 0);
  if (line === undefined) return '';
  return line.split(/\s+/)[0] ?? '';
}

// The only place the derived main is written to origin. The single-pusher gate in node.ts decides
// who SHOULD push; the lease decides what a push is allowed to overwrite. Per push that guarantee
// is exact and worth having: a push lands only if origin's main is still the sha this machine last
// saw, so no push ever silently discards another machine's main. A roamer that took over on a
// stale read of the anchor's liveness is refused and logged instead of racing.
//
// It is a guarantee about ONE push, not about the fleet settling. Every sync cycle fetches origin,
// which refreshes the baseline to whatever the other pusher wrote, so a refused machine's next
// lease is valid again -- the lease alone would let two machines take turns clobbering main, each
// push returning 0. What actually bounds that is the pair around it: node.ts's yield rule (a roamer
// stands down as soon as it sees a main it did not push) and the bounded retry in updateMain (a
// refused push is retried at most MAX_PUSH_RETRIES times, then left alone until inputs change).
//
// The anchor pays nothing for the lease: every successful push refreshes the baseline below, so the
// anchor's lease is always current.
async function pushDerivedMain(repoPath: string, sha: string): Promise<boolean> {
  const lease = await originMainLease(repoPath);
  const r = await git(repoPath, [
    'push',
    `--force-with-lease=refs/heads/main:${lease}`,
    'origin',
    `${sha}:refs/heads/main`,
  ]);
  if (r.code === 0) {
    lastPushedSha.set(repoPath, sha);
    owedPush.delete(repoPath);
    // Refresh the baseline now rather than waiting for the next fetch. git already does this when
    // origin carries the usual +refs/heads/*:refs/remotes/origin/* refspec; doing it explicitly
    // also covers an origin configured by url alone, whose fetch stores nothing under refs/remotes
    // and would otherwise leave every later push leasing against an absent ref.
    //
    // Best effort on purpose. The push has already landed, so a ref-lock or D/F failure here means
    // a stale tracking ref that the next fetch repairs -- not a failed push. Throwing would make
    // node.ts log `derive.updateMain failed` for a push that succeeded.
    const u = await git(repoPath, ['update-ref', ORIGIN_MAIN_REF, sha]);
    if (u.code !== 0) {
      log('warn', 'derive: main pushed but the origin tracking ref could not be updated', {
        repo: repoPath,
        sha,
        code: u.code,
        stderr: u.stderr.trim().slice(0, 500),
      });
    }
    return true;
  }
  // Refused or failed: this machine still owes this sha. Remembering it here is what lets the
  // unchanged-inputs branch of updateMain retry a bounded number of times without inferring
  // "something is owed" from the refs, which is what made the retry unbounded.
  const prevOwed = owedPush.get(repoPath);
  owedPush.set(repoPath, {
    sha,
    attempts: prevOwed !== undefined && prevOwed.sha === sha ? prevOwed.attempts + 1 : 0,
  });
  const stderr = r.stderr.trim();
  if (stderr.includes('stale info')) {
    // git's word for a lease that no longer holds. Distinct message and distinct meaning from a
    // push that simply failed: nothing is wrong with the network, another machine moved main.
    log('warn', 'derive: main moved on origin since last fetch, push refused', {
      repo: repoPath,
      sha,
      expected: lease,
      stderr: stderr.slice(0, 500),
    });
  } else {
    log('warn', 'derive: force-push of main to origin failed', {
      repo: repoPath,
      sha,
      code: r.code,
      stderr: stderr.slice(0, 500),
    });
  }
  return false;
}

// Has origin's main moved under a push that was not ours? Read-only and local: one rev-parse of the
// tracking ref as this cycle's fetch left it, no network. node.ts calls it for a ROAMER that is
// about to take over the push, and a true answer is that roamer's cue to stand down -- somebody
// else is demonstrably pushing, whatever this machine's gossip says about the anchor's heartbeat.
//
// Three answers are deliberately NOT foreign, and each of them is load-bearing:
//   - an absent tracking ref: nothing has been observed to move, so there is nothing to yield to;
//   - the first observation of a repo in this process: it is the baseline. Without this, a roamer
//     taking over after a real anchor death would yield forever to the dead anchor's last push;
//   - a value unchanged since the previous observation: a main that is just sitting there is not
//     evidence of another pusher. This is what lets the roamer take over for good once whoever was
//     pushing actually stops. node.ts asks on every roamer tick precisely so that "previous
//     observation" means the previous tick, not the last time a takeover was considered.
export async function originMainMovedByOther(repoPath: string): Promise<boolean> {
  const r = await git(repoPath, ['rev-parse', '--verify', '--quiet', ORIGIN_MAIN_REF]);
  const current = r.code === 0 ? r.stdout.trim() : '';
  if (current.length === 0) return false;
  const prev = lastSeenOriginMain.get(repoPath);
  lastSeenOriginMain.set(repoPath, current);
  if (prev === undefined || prev === current) return false;
  return current !== lastPushedSha.get(repoPath);
}

export async function updateMain(
  repoPath: string,
  opts: UpdateMainOpts = {},
): Promise<UpdateMainResult> {
  const unionPaths = new Set(opts.unionPaths ?? []);
  const tips = await enumerateTips(repoPath, opts.fetchedOnly === true);
  if (tips.length === 0) {
    return { sha: null, pushed: false, skipped: 'no-sync-branches' };
  }

  const inputSet = new Set(tips.map((t) => `${t.machine} ${t.sha}`));

  // Idempotence: identical input set -> the previously derived commit is byte-identical,
  // so skip without minting. The previous main is never reused as a parent.
  const prior = (await storedState(repoPath, DERIVED_REF)) ?? (await storedState(repoPath, ORIGIN_MAIN_REF));
  if (prior !== null && setsEqual(prior.set, inputSet)) {
    // Unchanged inputs mint nothing, but they must not swallow a push this machine still OWES. A
    // push the lease refused (or one that died on the network) leaves DERIVED_REF already sitting
    // on the derived sha, so the next tick reads the inputs as unchanged and, without this retry,
    // would never push again: origin would keep the main it has until some machine's sync branch
    // happens to move.
    //
    // The retry is driven by memory of our own refused push (owedPush) and bounded, never inferred
    // from the refs. Re-pushing whenever refs/remotes/origin/main differs from the derived sha --
    // the obvious version -- re-pushes on EVERY tick during a partition: the cycle's fetch
    // refreshes that ref to whatever the other pusher wrote, so the lease is valid again and the
    // push lands, and the two machines take turns clobbering main forever, each push returning 0.
    // origin/main differing from ours is not by itself a reason to push. That also means a main
    // hand-pushed to GitHub is left alone until inputs change, exactly as it was before this leg
    // existed. Only this cycle's pusher pays for the check, and it costs one Map lookup.
    const owed = owedPush.get(repoPath);
    if (
      opts.push !== false &&
      owed !== undefined &&
      owed.sha === prior.sha &&
      owed.attempts < MAX_PUSH_RETRIES
    ) {
      const retried = await pushDerivedMain(repoPath, prior.sha);
      const after = owedPush.get(repoPath);
      if (!retried && after !== undefined && after.sha === prior.sha && after.attempts >= MAX_PUSH_RETRIES) {
        // Fires exactly once per owed sha: attempts only reaches the cap on this line, and the
        // guard above stops every later tick. So a permanent refusal (protected branch, revoked
        // token) costs a bounded number of push subprocesses and warns, not one of each per repo
        // per tick for as long as the daemon runs.
        log('warn', 'derive: giving up on main push until inputs change', {
          repo: repoPath,
          sha: prior.sha,
          attempts: after.attempts,
        });
      }
      return { sha: prior.sha, pushed: retried, skipped: 'unchanged-inputs' };
    }
    return { sha: prior.sha, pushed: false, skipped: 'unchanged-inputs' };
  }

  const newestTs = tips.reduce((m, t) => (t.committerTs > m ? t.committerTs : m), tips[0]!.committerTs);

  let finalTree: string;
  let unionTouchedAny = false;
  if (tips.length === 1) {
    finalTree = (await gitOK(repoPath, ['rev-parse', `${tips[0]!.sha}^{tree}`])).trim();
  } else {
    let current = tips[0]!.sha;
    for (let i = 1; i < tips.length; i++) {
      const merged = await mergeTree(repoPath, current, tips[i]!.sha);
      let tree = merged.tree;
      if (merged.conflicts.length > 0) {
        const resolved = await resolveConflicts(repoPath, merged.tree, merged.conflicts, tips, unionPaths);
        tree = resolved.tree;
        if (resolved.unionTouched) unionTouchedAny = true;
      }
      if (i === tips.length - 1) {
        finalTree = tree;
      } else {
        // Intermediate commit only carries ancestry into the next merge base; it is
        // never a parent of the derived main. Identity/date pinned for reproducibility.
        current = await commitTree(repoPath, tree, [current, tips[i]!.sha], 'fleet: derived-intermediate', newestTs);
      }
    }
    // finalTree assigned in the last iteration (tips.length >= 2 guarantees it ran).
    finalTree = finalTree!;
  }

  // unionPaths are never newest-wins clobbered: their conflicts were resolved above by
  // taking the union of both sides, and if a postMerge regenerator is configured, re-run
  // it over the result so union-authoritative derived files (e.g. a manifest) stay correct.
  if (unionTouchedAny) {
    if (opts.postMerge && opts.postMerge.length > 0) {
      finalTree = await runPostMergeInWorktree(
        repoPath,
        finalTree,
        opts.postMerge,
        opts.postMergeTimeoutMs ?? 120000,
        newestTs,
      );
    } else {
      log('warn', 'derive: union path conflict resolved without a postMerge regenerator configured', {
        repo: repoPath,
      });
    }
  }

  const body = tips.map((t) => `${t.machine} ${t.sha}`).join('\n');
  const message = `fleet: derived main\n${body}\n`;
  const parents = tips.map((t) => t.sha);
  const sha = await commitTree(repoPath, finalTree, parents, message, newestTs);

  await gitOK(repoPath, ['update-ref', DERIVED_REF, sha]);
  // A new sha supersedes anything still owed for the old one: nobody wants the previous derived
  // main on origin any more. If this sha's own push fails below, pushDerivedMain records it fresh
  // with attempts 0, which is why changed inputs are what reset a machine that had given up.
  owedPush.delete(repoPath);

  let pushed = false;
  let skipped: string | null = null;
  if (opts.push === false) {
    // Single-pusher policy: this machine is not this cycle's pusher. The origin remote is never
    // even consulted -- originExists() would otherwise fire a subprocess for no reason on every
    // suppressed tick.
    skipped = 'push-suppressed-non-owner';
  } else if (await originExists(repoPath)) {
    pushed = await pushDerivedMain(repoPath, sha);
  }

  return { sha, pushed, skipped };
}
