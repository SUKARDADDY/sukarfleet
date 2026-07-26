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

  let pushed = false;
  if (await originExists(repoPath)) {
    const r = await git(repoPath, ['push', '--force', 'origin', `${sha}:refs/heads/main`]);
    if (r.code === 0) {
      pushed = true;
    } else {
      log('warn', 'derive: force-push of main to origin failed', {
        repo: repoPath,
        sha,
        code: r.code,
        stderr: r.stderr.trim().slice(0, 500),
      });
    }
  }

  return { sha, pushed, skipped: null };
}
