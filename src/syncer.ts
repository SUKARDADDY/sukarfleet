// SPDX-License-Identifier: AGPL-3.0-or-later
// Section 03 sync cycle: multi-repo peer-to-peer git state machine.
// Single writer per machine on sync/<machine>. main is never touched here.

import { join, dirname, isAbsolute } from 'node:path';
import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import type { FleetConfig, RepoConfig, PresenceRepoStat, MachineKey } from './types';
import { run, runBytes, log, atomicWrite, nowMs, sleep as utilSleep, TransitionGate, SYNC_DEFERRED_PREFIX } from './util';
import { buildAuthHeader } from './keys';
import { reapGitLocks, resolveGitDirs, type LockHolderCheck, type LockRepair } from './gitlocks';

// util.run reports its own timeout kill as exit 124, which a command may also exit with
// legitimately; elapsed time is what actually disambiguates them. Mirrors sshadmin.ts's identical
// constant and comment -- the two files independently need the same slack for the same reason.
const TIMEOUT_SLACK_MS = 250;

export interface SyncerDeps {
  isClockVetted: () => boolean;
  onRepoStat: (repo: string, stat: PresenceRepoStat) => void;
  onGithubPush: (repo: string, okMs: number | null) => void;
  // Called INSTEAD of onGithubPush when the repo has no `origin` at all, so the daemon can drop
  // it from the GitHub-push table entirely. Optional: an additive seam, and a caller that omits
  // it keeps the previous behaviour. See pushOrigin for why a null is not good enough.
  onGithubPushNotApplicable?: (repo: string) => void;
  onConflictArtifact: (repo: string, path: string) => void;
  // Fired after a corrupt .git/index was quarantined and rebuilt from HEAD (see repairIndex).
  // Optional, additive: a caller that omits it keeps the previous behaviour and learns about the
  // repair from the log line repairIndex writes anyway. It exists so a caller can surface the
  // quarantine path somewhere an operator will actually look.
  onIndexRepaired?: (repo: string, quarantinedTo: string) => void;
  // Fired after zero-byte loose objects were quarantined and refetched (see repairEmptyObjects).
  // Optional and additive, for the same reason as onIndexRepaired. `recoveredFrom` names the
  // remote whose refetch made the object store whole again.
  onObjectsRepaired?: (repo: string, quarantinedTo: string, recoveredFrom: string) => void;
  // Fired after an orphaned git lock was retired (see reapStaleLocks and reapKilledChildLocks).
  // Optional and additive like the two above. Awaited, so a caller that records the repair (node.ts
  // writes a signed audit entry) finishes before the cycle moves on or a shutdown exits.
  onLockRepaired?: (repo: string, repair: LockRepair) => void | Promise<void>;
  // Fired after origin's copy of sync/<machine> was merged back into the local branch so the push
  // could go through (see reconcileOwnBranch). Optional and additive, awaited for the same reason.
  onOwnBranchMerged?: (repo: string, detail: OwnBranchMerge) => void | Promise<void>;
  // Fired after paths a Windows checkout cannot hold were taken out of the index (see
  // untrackUnportable). Optional and additive, awaited like the two above.
  onUnportableUntracked?: (repo: string, paths: string[]) => void | Promise<void>;
  // This machine's signing identity. Required to attach the x-fleet-auth header that
  // gitserve.ts mandates on every peer fetch (see fetchAll below). Contract addition —
  // callers construct this the same way Gossip does, via keys.loadOrCreateMachineKey().
  machineKey: MachineKey;
  // Fired after every bounded git/postMerge step completes. The daemon uses it as the
  // watchdog progress mark: one repo's full syncOnce can legitimately exceed the sync
  // freshness window (push retries + backoff against a dead network run ~5min), so
  // per-repo marking alone starves the watchdog on outages. Every step is individually
  // time-bounded, so a step completing is honest proof the loop is advancing.
  onStep?: () => void;
}

// What reconcileOwnBranch did, for the audit entry. Commit ids and a count only: no file content and
// no paths, since the audit log reaches every machine and may be pushed to a remote.
export interface OwnBranchMerge {
  branch: string;
  originTip: string;
  localTipBefore: string;
  localTipAfter: string;
  // Paths that conflicted and were settled by the ordinary peer-merge rules.
  conflicts: number;
}

interface MergeTipResult {
  outcome: 'contained' | 'merged' | 'deferred';
  unionRegenNeeded: boolean;
  conflicts: number;
}

// What one sync cycle observed that a caller outside the Syncer needs. Deliberately narrow: the
// per-repo stats keep flowing through SyncerDeps.onRepoStat, and callers that only drive the cycle
// (`await syncer.syncOnce(repo)`) can go on ignoring the return value.
export interface SyncOnceResult {
  // Did the origin fetch succeed this cycle? null when the repo has no origin remote configured.
  originFetchOk: boolean | null;
}

export interface SyncerOptions {
  sleep?: (ms: number) => Promise<void>;
  debounceMs?: number;
  pushBackoffMs?: number[];
  gitTimeoutMs?: number;
  fetchTimeoutMs?: number;
  // Bound on one `fetch --refetch` during object repair. It downloads the whole repo, as a fresh
  // clone would, so the ordinary fetch bound is too tight for it.
  refetchTimeoutMs?: number;
  postMergeTimeoutMs?: number;
  now?: () => number;
  // Test seam for the git subprocess (mirrors sshadmin.ts's deps.runner convention). Defaults to
  // util.run. Only the `git()` helper below is routed through it -- postMerge argv and the raw
  // gitShowBytes path are untouched, since the timeout-vs-real-error classification this seam
  // exists for only applies to fetchAll/pushOrigin.
  gitRunner?: typeof run;
  // Test seam for the stale-lock holder check (gitlocks.ts). Defaults to the per-platform check.
  lockHolderCheck?: LockHolderCheck;
}

// C-locale/codepoint order (never locale-dependent). Feeds deterministic tie-breaks.
function codepointCompare(a: string, b: string): number {
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

export class Syncer {
  private readonly cfg: FleetConfig;
  private readonly deps: SyncerDeps;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly debounceMs: number;
  private readonly pushBackoffMs: number[];
  private readonly gitTimeoutMs: number;
  private readonly fetchTimeoutMs: number;
  private readonly refetchTimeoutMs: number;
  private readonly postMergeTimeoutMs: number;
  private readonly now: () => number;
  private readonly gitRunner: typeof run;
  private readonly lockHolderCheck: LockHolderCheck | undefined;
  private readonly staleLockMs: number;
  // When each repo last completed a cycle. Only a cycle that is DEFERRED (a git lock somebody else
  // holds) reads it, to report the last real success instead of a null that reads as "never synced"
  // -- see runCycle's catch.
  private readonly lastOkMs = new Map<string, number>();
  // When this Syncer was built: the stand-in for "last success" on a deferral before any cycle has
  // succeeded since the daemon started. Null there would read as "never synced" and raise
  // self-sync-stale (and a notification, and a "recovered" one a cycle later) for nothing more than
  // a person holding a lock across a restart. node.ts seeds its loop-freshness marks the same way.
  private readonly bootMs: number;
  // When each repo's current run of deferred cycles began. A deferral only becomes visible text in
  // syncError once it has lasted staleGitLockMin -- and even then as a SYNC_DEFERRED_PREFIX note
  // that health.ts shows and never alarms on.
  private readonly deferredSince = new Map<string, number>();
  // stop(): no new cycle starts, sleeps return at once, push retries give up. The git step already
  // running is never interrupted here; drainChildren in util.ts owns that.
  private stopping = false;
  private wakeStopped: () => void = () => {};
  private readonly stopped = new Promise<void>((resolve) => {
    this.wakeStopped = resolve;
  });
  // Keyed `fetch:<repo>:<remote>`. Only a TIMED-OUT fleet-<peer> fetch is fed through this gate;
  // origin fetches and every real (non-timeout) git error stay warn unconditionally, every cycle.
  private readonly fetchGate = new TransitionGate();
  // Keyed `push:<repo>`. Only the FINAL retry attempt of a push is a candidate to warn at all;
  // among final attempts, only a timeout classification is gated (a persistently-down GitHub
  // warns once on transition, not every sync cycle) -- a real error on the final attempt still
  // warns unconditionally.
  private readonly pushGate = new TransitionGate();

  constructor(cfg: FleetConfig, deps: SyncerDeps, opts: SyncerOptions = {}) {
    this.cfg = cfg;
    this.deps = deps;
    this.sleep = opts.sleep ?? utilSleep;
    this.debounceMs = opts.debounceMs ?? 3000;
    this.pushBackoffMs = opts.pushBackoffMs ?? [5000, 15000, 45000];
    this.gitTimeoutMs = opts.gitTimeoutMs ?? 60000;
    this.fetchTimeoutMs = opts.fetchTimeoutMs ?? 60000;
    this.refetchTimeoutMs = opts.refetchTimeoutMs ?? 300000;
    this.postMergeTimeoutMs = opts.postMergeTimeoutMs ?? 120000;
    this.now = opts.now ?? nowMs;
    this.gitRunner = opts.gitRunner ?? run;
    this.lockHolderCheck = opts.lockHolderCheck;
    this.staleLockMs = cfg.thresholds.staleGitLockMin * 60000;
    this.bootMs = this.now();
  }

  // Shutdown. A cycle in flight keeps going -- it finishes the step it is on and whatever it needs
  // to leave the repo consistent -- but stops waiting: the write-quiet debounce and push backoff
  // return immediately and a failed push is not retried, so a cycle parked in a 45 s backoff does
  // not spend the whole shutdown budget asleep. A cycle that has not started yet never starts.
  stop(): void {
    this.stopping = true;
    this.wakeStopped();
  }

  private async pause(ms: number): Promise<void> {
    if (this.stopping) return;
    await Promise.race([this.sleep(ms), this.stopped]);
  }

  // One-time cutover helper: branch sync/<machine> at HEAD and check it out.
  async adoptRepo(repoPath: string, machine: string): Promise<void> {
    const gitDirR = await this.git(repoPath, ['rev-parse', '--git-dir']);
    if (gitDirR.code !== 0) {
      throw new Error(`adoptRepo: ${repoPath} is not a git repo: ${gitDirR.stderr.trim()}`);
    }
    const gitDir = gitDirR.stdout.trim();
    const gitDirAbs = gitDir.startsWith('/') ? gitDir : join(repoPath, gitDir);
    for (const marker of ['MERGE_HEAD', 'CHERRY_PICK_HEAD', 'REVERT_HEAD', 'rebase-merge', 'rebase-apply']) {
      if (await pathExists(join(gitDirAbs, marker))) {
        throw new Error(`adoptRepo: refusing — ${marker} present (unfinished rebase/merge) in ${repoPath}`);
      }
    }
    const branch = `sync/${machine}`;
    const exists = await this.git(repoPath, ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`]);
    if (exists.code === 0) {
      await this.gitOk(repoPath, ['checkout', branch]);
    } else {
      await this.gitOk(repoPath, ['checkout', '-b', branch]);
    }
    // Pin at adoption so the derived-main byte-identity contract (§03/must-keep #10) holds
    // even once a CRLF-defaulting machine (e.g. win11) enrolls; on the current Linux pair
    // this is a no-op (autocrlf already defaults false).
    await this.gitOk(repoPath, ['config', 'core.autocrlf', 'false']);
  }

  // Point fleet-<peer> remotes at each peer's git-over-HTTP endpoint (read/upload-pack).
  // NOTE: the daemon must call this once at startup (and again whenever cfg.peers changes,
  // e.g. a peer's meshIp/nodePort moves) *before* the sync loop starts calling syncOnce.
  // It is deliberately NOT invoked from syncOnce/fetchAll: it force-overwrites each
  // fleet-<peer> remote's URL every call (by design — see the idempotency test), so
  // running it every sync tick would fight any operator/test override of that remote and
  // adds needless git-config churn to the hot loop for a config-driven, not tick-driven,
  // concern.
  async ensureFleetRemotes(repo: RepoConfig): Promise<void> {
    for (const peer of this.cfg.peers) {
      if (peer.name === this.cfg.machine) continue;
      const remote = `fleet-${peer.name}`;
      const url = `http://${peer.meshIp}:${peer.nodePort}/git/${repo.name}`;
      const setr = await this.git(repo.path, ['remote', 'set-url', remote, url]);
      if (setr.code !== 0) {
        await this.gitOk(repo.path, ['remote', 'add', remote, url]);
      }
    }
  }

  // originFetchOk answers one question for P3's single-pusher gate in node.ts: did THIS cycle
  // actually reach origin, the repo derive force-pushes main to? `null` means the repo has no
  // origin remote configured, so there was nothing to reach and nothing to push. `false` covers
  // both a failed fetch and a cycle that threw before fetchAll ran -- either way this machine has
  // no fresh view of origin, which is exactly when a roamer must not take over the push.
  //
  // A cycle that throws AFTER a successful fetchAll still reports true, deliberately: the question
  // is whether origin was reached this cycle, and it was. The later step that failed (merge,
  // postMerge, pushOrigin) is reported through onRepoStat's syncError, and the lease baseline this
  // answer exists to vouch for is genuinely fresh.
  //
  // A cycle that fails on a CORRUPT INDEX is retried once, after repairIndex rebuilds it. The
  // index is derived state -- every byte of it can be recomputed from HEAD plus the worktree --
  // so a machine that loses it to an unclean shutdown is not damaged, it is merely stuck, and it
  // stays stuck forever without this: `git status` is the first thing autoCommit runs, so the repo
  // never syncs, never pushes, and reports the same fault every alarm interval until a human runs
  // two commands. A cycle that fails on EMPTY LOOSE OBJECTS is retried once too, after
  // repairEmptyObjects refetches them. More repairs run inside the cycle rather than around it: an
  // orphaned git lock is retired before the first step (reapStaleLocks), a merge this daemon left
  // half-done is aborted and redone (settleStrandedMerge), a path a Windows peer cannot check out
  // is taken out of the index (untrackUnportable), and a push that origin rejects because it holds
  // commits on sync/<machine> the local branch lost is merged and retried (reconcileOwnBranch).
  // Each clears the same bar -- it cannot lose committed history or decide a conflict the ordinary
  // merge rules would not -- and nothing else here self-heals, deliberately. See each repair for
  // its own argument.
  async syncOnce(repo: RepoConfig): Promise<SyncOnceResult> {
    if (this.stopping) return { originFetchOk: false };
    const first = await this.runCycle(repo);
    if (first.damage === null) return { originFetchOk: first.originFetchOk };
    const repaired =
      first.damage === 'index' ? await this.repairIndex(repo) : await this.repairEmptyObjects(repo);
    if (!repaired) return { originFetchOk: first.originFetchOk };
    const second = await this.runCycle(repo);
    return { originFetchOk: second.originFetchOk };
  }

  // One attempt at a full cycle. Reports whether it died on repairable local git damage so
  // syncOnce can decide to repair and re-enter; every other outcome is already fully reported
  // through onRepoStat before this returns.
  private async runCycle(repo: RepoConfig): Promise<{ originFetchOk: boolean | null; damage: RepairableDamage | null }> {
    let originFetchOk: boolean | null = false;
    try {
      await this.reapStaleLocks(repo);
      const branchR = await this.gitOk(repo.path, ['symbolic-ref', '--short', 'HEAD']);
      const branch = branchR.stdout.trim();
      const want = `sync/${this.cfg.machine}`;
      if (branch !== want) {
        throw new Error(`refusing sync: HEAD is '${branch}', expected '${want}' (single-writer)`);
      }

      await this.settleStrandedMerge(repo);

      const vetted = this.deps.isClockVetted();
      if (vetted) {
        await this.autoCommit(repo);
      } else {
        log('info', 'clock unvetted; skipping auto-commit', { repo: repo.name });
      }

      originFetchOk = await this.fetchAll(repo);
      const { mergedAny, unionRegenNeeded } = await this.mergePeers(repo, vetted);
      await this.runPostMerge(repo, mergedAny, unionRegenNeeded);
      await this.pushOrigin(repo, vetted);

      const lastCommit = await this.head(repo.path);
      const okMs = this.now();
      this.lastOkMs.set(repo.name, okMs);
      this.deferredSince.delete(repo.name);
      this.deps.onRepoStat(repo.name, { lastSyncOkMs: okMs, lastCommit, syncError: null });
      return { originFetchOk, damage: null };
    } catch (err) {
      // Never leave the repo wedged mid-merge -- but only a merge this daemon started. This used to
      // run `merge --abort` unconditionally, which also threw away a merge a person had open on the
      // sync branch whenever an unrelated step failed. Allowed while a shutdown is draining: this
      // is the step that keeps a half-done merge from outliving the process.
      await this.abortOwnMerge(repo).catch(() => {});
      const lastCommit = await this.head(repo.path).catch(() => null);
      const raw = err instanceof Error ? err.message : String(err);
      // Bounded before it goes anywhere: this string reaches /status, the health fault message, a
      // desktop notification and every peer through gossip. Unbounded, one failed `git add -A --
      // <every changed path>` was 226,000 characters of argv in all of those places.
      const msg = boundErrorText(raw);
      if (this.stopping) {
        // A shutdown cut this cycle short (drainChildren refuses new children). Not a fault, and
        // not worth persisting as one into the last gossip snapshot.
        log('info', 'sync cycle interrupted by shutdown', { repo: repo.name });
        return { originFetchOk, damage: null };
      }
      const deferral = err instanceof SyncDeferred ? err.reason : isGitLockBusyError(raw) ? lockBusyReason(raw) : null;
      if (deferral !== null) {
        // Something a person (or another tool) is in the middle of: a git holding a lock this cycle
        // needed -- a commit with its editor open, an IDE's background refresh, a lock
        // reapStaleLocks could not yet prove orphaned -- or a merge left unfinished by hand.
        // Waiting is the fix, so this is not reported as an error: that would raise a critical
        // fault and a desktop notification every time a person and the daemon touched the same
        // repo at once. The stat keeps the last real success (or boot), so a deferral that never
        // ends still surfaces as self-sync-stale once syncStaleMin passes; and once it has lasted
        // staleGitLockMin, syncError carries the reason as a SYNC_DEFERRED_PREFIX note, so that
        // stale fault has an explanation next to it in /status. health.ts never alarms on the note.
        const now = this.now();
        const since = this.deferredSince.get(repo.name) ?? now;
        this.deferredSince.set(repo.name, since);
        const note =
          now - since >= this.staleLockMs
            ? boundErrorText(`${SYNC_DEFERRED_PREFIX}${deferral} (since ${new Date(since).toISOString()})`)
            : null;
        log('info', 'sync deferred; retrying next cycle', { repo: repo.name, reason: deferral, error: msg });
        this.deps.onRepoStat(repo.name, {
          lastSyncOkMs: this.lastOkMs.get(repo.name) ?? this.bootMs,
          lastCommit,
          syncError: note,
        });
        return { originFetchOk, damage: null };
      }
      this.deferredSince.delete(repo.name);
      log('error', 'sync cycle failed', { repo: repo.name, error: msg });
      this.deps.onRepoStat(repo.name, { lastSyncOkMs: null, lastCommit, syncError: msg });
      const damage: RepairableDamage | null = isCorruptIndexError(raw)
        ? 'index'
        : isEmptyObjectError(raw)
          ? 'empty-objects'
          : null;
      return { originFetchOk, damage };
    }
  }

  // A merge the daemon itself started and never finished: the process died, or a shutdown's bound
  // ran out, between `git merge` and its commit or abort. MERGE_HEAD is still there, conflict markers
  // may be in the worktree, and the next autoCommit would `git add` those markers and commit them as
  // the merge's resolution -- and then they propagate to every machine. So before anything else
  // touches the tree, a merge this daemon owns is aborted (the next mergePeers redoes it under the
  // ordinary rules), and a merge it does not own is waited on, never committed.
  //
  // Ownership is the marker mergeTip writes before `git merge` (MERGE_MARKER, holding the tip it
  // merged) and removes once the merge has settled. A MERGE_HEAD that matches it is ours. One
  // without it is a person's merge on the sync branch, and finishing that is theirs to do.
  private async settleStrandedMerge(repo: RepoConfig): Promise<void> {
    const state = await this.mergeOwnership(repo);
    if (state === 'none') return;
    if (state === 'theirs') {
      throw new SyncDeferred('an unfinished merge (MERGE_HEAD) is waiting to be completed or aborted by hand');
    }
    const complaint = await this.abortOwnMerge(repo);
    if ((await this.mergeOwnership(repo)) !== 'none') {
      // Neither `merge --abort` nor `reset --merge` could put the tree back -- conflict markers
      // staged, the file edited again since. Committing now would record those markers as the
      // merge's resolution and ship them to every machine, so this repo is not committed at all
      // until a person sorts it out. Deferred, not failed: no alarm, a note once it has lasted.
      // The reason says which: a lock somebody holds (that clears by itself) reads differently from
      // a tree git will not reset (that needs a person).
      throw new SyncDeferred(
        isGitLockBusyError(complaint)
          ? `${lockBusyReason(complaint)} to abort an unfinished merge`
          : `a merge this daemon started could not be aborted (${firstVerdict(complaint)}); it needs finishing or aborting by hand`,
      );
    }
    log('warn', 'merge repair: aborted a merge this daemon left unfinished; it is redone this cycle', { repo: repo.name });
  }

  // Whose merge is in progress, if any. 'ours' only when MERGE_MARKER names the very commit
  // MERGE_HEAD does. Clears a marker left over from a merge that has already ended.
  private async mergeOwnership(repo: RepoConfig): Promise<'none' | 'ours' | 'theirs'> {
    const dirs = await resolveGitDirs(repo.path);
    if (dirs === null) return 'none';
    const marker = join(dirs.gitDir, MERGE_MARKER);
    let mergeHead: string;
    try {
      mergeHead = (await readFile(join(dirs.gitDir, 'MERGE_HEAD'), 'utf8')).trim();
    } catch {
      await rm(marker, { force: true }).catch(() => {});
      return 'none';
    }
    let ours = '';
    try {
      ours = (await readFile(marker, 'utf8')).trim();
    } catch {
      // no marker: not ours
    }
    return ours.length > 0 && ours === mergeHead ? 'ours' : 'theirs';
  }

  // Abort the merge in progress if, and only if, this daemon started it.
  // Abort the merge in progress if, and only if, this daemon started it. Returns git's complaint when
  // neither --abort nor reset --merge would do it (empty when nothing failed).
  private async abortOwnMerge(repo: RepoConfig): Promise<string> {
    if ((await this.mergeOwnership(repo)) !== 'ours') return '';
    let complaint = '';
    const abort = await this.gitRecover(repo.path, ['merge', '--abort']);
    if (abort.code !== 0) {
      // --abort refuses on some half-states (no ORIG_HEAD); reset --merge is what it runs anyway.
      const reset = await this.gitRecover(repo.path, ['reset', '--merge']);
      if (reset.code !== 0) complaint = reset.stderr.trim() || abort.stderr.trim();
    }
    const dirs = await resolveGitDirs(repo.path);
    if (dirs !== null && !(await pathExists(join(dirs.gitDir, 'MERGE_HEAD')))) {
      await rm(join(dirs.gitDir, MERGE_MARKER), { force: true });
    }
    return complaint;
  }

  // Retire this repo's orphaned git locks before the cycle's first step, so a lock left by a crash
  // costs at most staleGitLockMin and the cycle that clears it also syncs. gitlocks.ts carries the
  // whole argument: which locks, why age only nominates and a holder check decides, and why that
  // check fails closed. Never throws -- a lock that cannot be judged stays put, and the cycle runs
  // into it and defers (see runCycle's catch) exactly as it would have without this pass.
  private async reapStaleLocks(repo: RepoConfig): Promise<void> {
    let repairs: LockRepair[];
    try {
      repairs = await reapGitLocks(repo.path, {
        olderThanMs: this.staleLockMs,
        now: this.now(),
        reason: 'stale',
        stamp: this.fsIso(),
        holderCheck: this.lockHolderCheck,
      });
    } catch (err) {
      log('info', 'git lock: stale-lock check failed; will retry next cycle', { repo: repo.name, error: String(err) });
      return;
    }
    for (const repair of repairs) await this.reportLockRepair(repo.name, repair);
  }

  // The afterKill hook every git step carries (see git() below): util.runBytes calls it only when
  // it had to SIGKILL that step, the one signal git cannot clean up after. Any lock in this repo
  // created since the step started, and that nothing alive may own, is that step's orphan.
  private async reapKilledChildLocks(repoPath: string, startedAtMs: number): Promise<void> {
    const repoName = this.cfg.repos.find((r) => r.path === repoPath)?.name ?? repoPath;
    let repairs: LockRepair[];
    try {
      repairs = await reapGitLocks(repoPath, {
        createdSinceMs: startedAtMs,
        reason: 'orphaned-by-kill',
        stamp: this.fsIso(),
        holderCheck: this.lockHolderCheck,
      });
    } catch (err) {
      log('info', 'git lock: post-kill cleanup failed; the stale-lock pass will catch it', {
        repo: repoName,
        error: String(err),
      });
      return;
    }
    for (const repair of repairs) await this.reportLockRepair(repoName, repair);
  }

  private async reportLockRepair(repoName: string, repair: LockRepair): Promise<void> {
    log('warn', 'git lock repair: retired an orphaned lock', { repo: repoName, ...repair });
    try {
      await this.deps.onLockRepaired?.(repoName, repair);
    } catch (err) {
      log('error', 'git lock repair: recording the repair failed', { repo: repoName, error: String(err) });
    }
  }

  // Quarantine a corrupt .git/index and rebuild it from HEAD. Returns whether the rebuild left a
  // working index -- a false answer means the cycle should NOT be retried, and the original error
  // stands as the reported fault.
  //
  // Why this one repair and nothing else: the index holds no information that is not recoverable
  // from HEAD and the worktree. Rebuilding it cannot lose committed history, cannot touch a file
  // in the worktree, and cannot resolve a conflict a human had not already resolved. The single
  // thing it discards is staged-but-uncommitted intent, which in a sukarfleet repo does not exist
  // -- autoCommit re-derives the whole changed set from `git status` on every cycle, so the next
  // one stages exactly what this one would have. No other sync failure has that property, so no
  // other sync failure is repaired here.
  //
  // The corrupt file is moved, never deleted, mirroring the conflict-artifact rule: a machine that
  // ate its own index during a power cut is a forensics subject, and the evidence costs 30 KB.
  private async repairIndex(repo: RepoConfig): Promise<boolean> {
    const indexPathR = await this.git(repo.path, ['rev-parse', '--git-path', 'index']);
    if (indexPathR.code !== 0) return false;
    const rel = indexPathR.stdout.trim();
    if (rel.length === 0) return false;
    const indexPath = isAbsolute(rel) ? rel : join(repo.path, rel);
    const quarantine = `${indexPath}.corrupt-${this.fsIso()}`;

    try {
      await rename(indexPath, quarantine);
    } catch (err) {
      log('error', 'index repair: could not quarantine the corrupt index', {
        repo: repo.name,
        error: String(err),
      });
      return false;
    }

    // An unborn HEAD (a repo with no commit yet) has no tree to read; an empty index is the
    // correct rebuild there, and `read-tree HEAD` would just fail.
    const hasHead = await this.git(repo.path, ['rev-parse', '--verify', '--quiet', 'HEAD']);
    const rebuild =
      hasHead.code === 0
        ? await this.git(repo.path, ['read-tree', 'HEAD'])
        : await this.git(repo.path, ['read-tree', '--empty']);
    if (rebuild.code !== 0) {
      log('error', 'index repair: rebuild from HEAD failed', {
        repo: repo.name,
        quarantine,
        error: rebuild.stderr.trim(),
      });
      return false;
    }

    // Prove the rebuilt index is actually usable before claiming a repair: read-tree can succeed
    // and still leave something status chokes on, and a false "repaired" here would turn one
    // honest fault into a retry loop that reports a different error every cycle.
    const verify = await this.git(repo.path, ['status', '--porcelain', '-z']);
    if (verify.code !== 0) {
      log('error', 'index repair: rebuilt index still unusable', {
        repo: repo.name,
        quarantine,
        error: verify.stderr.trim(),
      });
      return false;
    }

    log('warn', 'index repair: rebuilt a corrupt git index from HEAD', { repo: repo.name, quarantine });
    this.deps.onIndexRepaired?.(repo.name, quarantine);
    return true;
  }

  // Quarantine every zero-byte loose object and refetch the store from the remotes, one at a time,
  // until it is whole again. Returns whether it is -- a false answer means
  // the cycle should NOT be retried, and the original error stands as the reported fault.
  //
  // Why this repair clears the same bar as repairIndex: a loose object is named by the hash of its
  // content, and git writes one to a temp file and renames it into place, so a zero-byte file
  // under an object's final name is never a write in progress and never a valid object. It is
  // what a lost page cache leaves behind. Moving it aside discards nothing, and a refetch can only
  // bring back the exact bytes that hash, because git verifies every object it receives. What it
  // cannot do is invent an object no remote has: a commit made here and lost before any push stays
  // lost, the repair reports failure, and a human decides.
  //
  // --refetch, not a plain fetch: a plain one negotiates from the local refs, and when a ref names
  // one of the emptied objects the negotiation itself dies ("did not send all necessary objects").
  // A refetch sends no haves and takes the whole pack, as a fresh clone would. Fleet peers are
  // tried before origin: the mesh is cheaper than GitHub, and a peer may hold commits this machine
  // synced to it but never pushed.
  //
  // When no remote answered at all (the usual state for a minute after the reboot that caused
  // this), the empty files are put back, so the next cycle fails the same way and tries again.
  // Leaving them moved would turn the error into "bad object", which no longer matches, and one
  // offline cycle would disable the repair for good. When a remote did answer and the store is
  // still not whole, the object really is gone: the files stay quarantined, the next error names
  // a missing object, and the repair does not run again.
  private async repairEmptyObjects(repo: RepoConfig): Promise<boolean> {
    const objectsPathR = await this.git(repo.path, ['rev-parse', '--git-path', 'objects']);
    if (objectsPathR.code !== 0) return false;
    const rel = objectsPathR.stdout.trim();
    if (rel.length === 0) return false;
    const objectsDir = isAbsolute(rel) ? rel : join(repo.path, rel);
    const loosePath = (oid: string) => join(objectsDir, oid.slice(0, 2), oid.slice(2));

    const empties = await findEmptyLooseObjects(objectsDir);
    if (empties.length === 0) return false;

    // Kept, not deleted, for the same reason as the corrupt index: the files carry no bytes, but
    // their names and mtimes say which objects a crash took and when.
    const quarantine = join(dirname(objectsDir), `objects.empty-${this.fsIso()}`);
    const moved: string[] = [];
    try {
      await mkdir(quarantine, { recursive: true });
      for (const oid of empties) {
        await rename(loosePath(oid), join(quarantine, oid));
        moved.push(oid);
      }
    } catch (err) {
      log('error', 'object repair: could not quarantine empty objects', {
        repo: repo.name,
        error: String(err),
      });
      await this.unquarantine(repo, quarantine, moved, loosePath);
      return false;
    }

    const succeed = (source: string): true => {
      log('warn', 'object repair: restored empty loose objects', {
        repo: repo.name,
        source,
        objects: empties.length,
        quarantine,
      });
      this.deps.onObjectsRepaired?.(repo.name, quarantine, source);
      return true;
    };

    const remotesR = await this.git(repo.path, ['remote']);
    const present = new Set(
      remotesR.code === 0 ? remotesR.stdout.split('\n').map((s) => s.trim()).filter(Boolean) : [],
    );
    const order = [...this.remoteNames().filter((r) => r !== 'origin'), 'origin'];
    let anyAnswered = false;
    for (const remote of order) {
      if (!present.has(remote)) continue;
      const args = await this.fetchAuthArgs(repo, remote);
      args.push('fetch', '--refetch', remote);
      // A dead peer must not cost the full refetch bound; a live one on the mesh finishes well
      // inside a minute.
      const timeoutMs = remote.startsWith('fleet-') ? Math.min(this.refetchTimeoutMs, 60000) : this.refetchTimeoutMs;
      const r = await this.git(repo.path, args, timeoutMs);
      this.deps.onStep?.();
      if (r.code !== 0) {
        // A refetch also fails against a live remote, when a local ref names an object that remote
        // never had ("did not send all necessary objects"). That remote answered, and its answer
        // is that it cannot help. Only a separate probe tells that apart from a dead link.
        const probeArgs = await this.fetchAuthArgs(repo, remote);
        probeArgs.push('ls-remote', '--heads', remote);
        const probeTimeout = remote.startsWith('fleet-') ? Math.min(this.fetchTimeoutMs, 10000) : this.fetchTimeoutMs;
        if ((await this.git(repo.path, probeArgs, probeTimeout)).code === 0) anyAnswered = true;
        log('info', 'object repair: refetch failed; trying the next remote', {
          repo: repo.name,
          remote,
          stderr: r.stderr.trim().slice(0, 300),
        });
        continue;
      }
      anyAnswered = true;
      if (await this.objectStoreWhole(repo)) return succeed(remote);
    }

    if (!anyAnswered) {
      log('warn', 'object repair: no remote reachable; will retry next cycle', {
        repo: repo.name,
        objects: empties,
      });
      await this.unquarantine(repo, quarantine, moved, loosePath);
      return false;
    }
    log('error', 'object repair: no remote could restore the empty objects', {
      repo: repo.name,
      objects: empties,
      quarantine,
    });
    return false;
  }

  // Is every ref's history present, and can the cycle run? connectivity-only checks that every
  // object reachable from a ref, the index or a reflog exists, without inflating blobs; with the
  // zero-byte files moved out, existing is the same as intact for the objects that were lost.
  //
  // One recovery on the way: a blob that was staged but not yet committed is on no remote, so a
  // refetch cannot bring it back and the index alone still points at it. The index is derived state (see repairIndex), so it is
  // rebuilt from HEAD and the check runs again; autoCommit re-stages the worktree next cycle.
  private async objectStoreWhole(repo: RepoConfig): Promise<boolean> {
    const check = async () => {
      const fsck = await this.git(repo.path, ['fsck', '--connectivity-only', '--no-dangling'], this.refetchTimeoutMs);
      if (fsck.code !== 0) return false;
      return (await this.git(repo.path, ['status', '--porcelain', '-z'])).code === 0;
    };
    if (await check()) return true;
    const head = await this.git(repo.path, ['rev-parse', '--verify', '--quiet', 'HEAD^{commit}']);
    if (head.code !== 0) return false;
    if ((await this.git(repo.path, ['read-tree', 'HEAD'])).code !== 0) return false;
    return await check();
  }

  // Put quarantined zero-byte files back under their object names, so the next cycle hits the
  // same "is empty" error and repairs again.
  private async unquarantine(
    repo: RepoConfig,
    quarantine: string,
    moved: readonly string[],
    loosePath: (oid: string) => string,
  ): Promise<void> {
    for (const oid of moved) {
      // Something wrote the real object meanwhile (a refetch's loose unpack, a concurrent add):
      // never clobber it with the empty file.
      if (await pathExists(loosePath(oid))) continue;
      try {
        await rename(join(quarantine, oid), loosePath(oid));
      } catch (err) {
        log('error', 'object repair: could not put an empty object back', {
          repo: repo.name,
          oid,
          error: String(err),
        });
      }
    }
  }

  // The signed x-fleet-auth header a fleet-<peer> fetch needs (see fetchAll); nothing for origin.
  private async fetchAuthArgs(repo: RepoConfig, remote: string): Promise<string[]> {
    if (!remote.startsWith('fleet-')) return [];
    const header = await buildAuthHeader('GIT', `/git/${repo.name}`, this.cfg.machine, this.deps.machineKey);
    return ['-c', `http.extraHeader=x-fleet-auth: ${header}`];
  }

  // (1) auto-commit: write-quiet debounce + per-file (size,mtime) stability re-check.
  //
  // Only paths every machine can check out are ever staged. The fleet is mixed, and a path Windows
  // cannot represent (`check:css.log`) commits fine on Linux and then fails every merge on the
  // Windows peer, every cycle, forever. So untracked files with such names are left on disk and out
  // of the commit, and any already in the index are taken out of it (untrackUnportable). Untracked
  // files are listed one by one (-uall): a collapsed `?? dir/` entry would let `git add -- dir/`
  // stage whatever unportable names sit inside it.
  //
  // A tree with unmerged entries is never committed: that would record conflict markers as the
  // resolution. settleStrandedMerge handles the daemon's own merges; anything else (a person's
  // cherry-pick or stash pop) is waited on.
  private async autoCommit(repo: RepoConfig): Promise<boolean> {
    const repoPath = repo.path;
    const untracked = await this.untrackUnportable(repo);
    const st = await this.gitOk(repoPath, ['status', '--porcelain', '-z', '--untracked-files=all']);
    if (hasUnmergedZ(st.stdout)) {
      throw new SyncDeferred('unmerged paths in the index are waiting to be resolved by hand');
    }
    const all = parsePorcelainZ(st.stdout);
    const paths = all.filter(isPortablePath);
    if (paths.length < all.length) {
      // Every cycle, by design, and at debug: these files are simply not synced.
      log('debug', 'auto-commit: leaving paths a Windows checkout cannot hold out of the commit', {
        repo: repo.name,
        paths: all.filter((p) => !isPortablePath(p)).slice(0, 10),
      });
    }
    if (paths.length === 0 && untracked === 0) return false;

    let addable: string[] = [];
    if (paths.length > 0) {
      addable = await this.stablePaths(repoPath, paths);
      // stop() made the debounce return early, so the (size,mtime) re-check above compared two
      // instants with no gap between them and proves nothing. Commit nothing rather than a file
      // caught half-written.
      if (this.stopping) return false;
    }
    if (addable.length > 0) {
      await this.gitOk(repoPath, ['add', '-A', '--', ...addable]);
    }
    const staged = await this.git(repoPath, ['diff', '--cached', '--quiet']);
    if (staged.code === 0) return false;
    await this.commitOrDefer(repo, ['-m', `sync: ${this.cfg.machine} ${this.isoNow()}`]);
    return true;
  }

  // Take every path a Windows checkout cannot hold out of the index, leaving the files on disk.
  // Returns how many. Runs before EVERY commit the daemon makes -- autoCommit, the postMerge
  // regenerators' commit, a merge's commit -- because each of them stages broadly (`add -A`, or a
  // merge bringing in a peer's tree), and a filter on one path would be a filter on none. The resulting staged deletion is committed by autoCommit like any other
  // change, so the path leaves every machine's tree -- which is the point: a Windows peer cannot
  // merge a tree that contains it. Recorded in the audit log, because it removes files from
  // everyone else's checkout without anybody asking.
  private async untrackUnportable(repo: RepoConfig): Promise<number> {
    const r = await this.gitOk(repo.path, ['ls-files', '-z']);
    const bad = [...new Set(r.stdout.split('\0').filter(Boolean))].filter((p) => !isPortablePath(p));
    if (bad.length === 0) return 0;
    for (let i = 0; i < bad.length; i += 200) {
      // --literal-pathspecs: these names are full of `*` and `?`, which git would otherwise glob.
      // -f: without it git refuses to drop an entry whose staged content differs from both HEAD and
      // the file on disk (staged, then edited: status AM), and that refusal failed every cycle
      // before fetch. --cached still means the file on disk is never touched.
      await this.gitOk(repo.path, [
        '--literal-pathspecs',
        'rm',
        '--cached',
        '-f',
        '-q',
        '--ignore-unmatch',
        '--',
        ...bad.slice(i, i + 200),
      ]);
    }
    // Reported only for a path a commit actually carried -- HEAD's tree, or the tree being merged
    // in. A path that was merely staged (by hand, or by a broad `add` of a file an earlier untrack
    // left on disk) was never part of the repo, and reporting it would write an audit entry every
    // cycle for the same file.
    const committed = new Set<string>();
    for (const rev of ['HEAD', 'MERGE_HEAD']) {
      for (let i = 0; i < bad.length; i += 200) {
        const r = await this.git(repo.path, ['--literal-pathspecs', 'ls-tree', '-r', '-z', '--name-only', rev, '--', ...bad.slice(i, i + 200)]);
        if (r.code === 0) for (const p of r.stdout.split('\0')) if (p) committed.add(p);
      }
    }
    const reported = bad.filter((p) => committed.has(p));
    if (reported.length === 0) {
      log('debug', 'auto-commit: unstaged paths a Windows checkout cannot hold', { repo: repo.name, paths: bad.slice(0, 10) });
      return bad.length;
    }
    log('warn', 'auto-commit: untracked paths a Windows checkout cannot hold; the files stay on disk', {
      repo: repo.name,
      count: reported.length,
      paths: reported.slice(0, 10),
    });
    try {
      await this.deps.onUnportableUntracked?.(repo.name, reported);
    } catch (err) {
      log('error', 'auto-commit: recording the untracked paths failed', { repo: repo.name, error: String(err) });
    }
    return bad.length;
  }

  // `git add -A`, minus every path a Windows checkout cannot hold. The broad add that commitAll and a
  // merge's resolution used to run re-staged files an earlier untrack had deliberately left on disk,
  // so the untrack ran again, and logged and audited again, every cycle. Paths are named explicitly
  // and literally, through the same dropVanished/dropIgnored filters autoCommit uses.
  private async stagePortable(repo: RepoConfig): Promise<void> {
    const st = await this.gitOk(repo.path, ['status', '--porcelain', '-z', '--untracked-files=all']);
    const paths = parsePorcelainZ(st.stdout).filter(isPortablePath);
    if (paths.length === 0) return;
    const absent: string[] = [];
    for (const p of paths) if ((await statSig(join(repo.path, p))) === 'MISSING') absent.push(p);
    const addable = await this.dropIgnored(repo.path, await this.dropVanished(repo.path, paths, absent));
    if (addable.length > 0) await this.gitOk(repo.path, ['--literal-pathspecs', 'add', '-A', '--', ...addable]);
  }

  // Every commit the daemon makes goes through here. A commit that fails while the repo has commit
  // hooks installed (a transcrypt pre-commit is the live case) is the hook saying no -- something a
  // person has to look at, and not something retrying every two minutes will change -- so it defers,
  // with the hook's own words as the reason, instead of failing every cycle. Without hooks a failed
  // commit is a real error, as before.
  private async commitOrDefer(repo: RepoConfig, args: string[]): Promise<void> {
    const r = await this.git(repo.path, ['commit', ...args]);
    if (r.code === 0) return;
    const why = r.stderr.trim() || r.stdout.trim();
    if (await this.hasCommitHooks(repo)) {
      throw new SyncDeferred(`a commit hook refused the daemon's commit: ${firstVerdict(why)}`);
    }
    throw new Error(`git commit ${describeArgs(args)} failed (code ${r.code}): ${why}`);
  }

  private async hasCommitHooks(repo: RepoConfig): Promise<boolean> {
    // --git-path hooks honours core.hooksPath.
    const r = await this.git(repo.path, ['rev-parse', '--git-path', 'hooks']);
    if (r.code !== 0) return false;
    const rel = r.stdout.trim();
    const dir = isAbsolute(rel) ? rel : join(repo.path, rel);
    for (const hook of ['pre-commit', 'prepare-commit-msg', 'commit-msg', 'pre-merge-commit']) {
      try {
        if ((await stat(join(dir, hook))).mode & 0o111) return true;
      } catch {
        // not installed
      }
    }
    return false;
  }

  // The write-quiet debounce: the subset of `paths` whose (size, mtime) did not move across it,
  // minus what `git add` would refuse (see dropIgnored and dropVanished).
  private async stablePaths(repoPath: string, paths: string[]): Promise<string[]> {
    const before = new Map<string, string>();
    for (const p of paths) before.set(p, await statSig(join(repoPath, p)));
    await this.pause(this.debounceMs);

    const stable: string[] = [];
    const absent: string[] = [];
    for (const p of paths) {
      const after = await statSig(join(repoPath, p));
      if (after !== before.get(p)) continue;
      stable.push(p);
      // Not on disk. Harmless on its own (an unstaged delete is still an index entry), but
      // it is the precondition for the unmatchable-pathspec case dropVanished handles.
      if (after === 'MISSING') absent.push(p);
    }
    if (stable.length === 0) return [];

    // `git add -A -- <paths>` exits 1 if ANY explicitly-named path is ignored-and-untracked,
    // so a single gitignored file in the changed set aborted the whole repo's sync cycle.
    // status legitimately reports such paths — e.g. a staged `git rm --cached` of a
    // now-ignored machine-local secret whose working copy still sits on disk. Drop them
    // rather than -f them: -f would commit exactly the secret the ignore rule exists to keep
    // out. Anything already staged for a dropped path stays in the index and is still
    // committed below, since the commit takes no pathspec.
    return await this.dropIgnored(repoPath, await this.dropVanished(repoPath, stable, absent));
  }

  // (2) fetch origin + every fleet-<peer>, tolerating unreachable remotes.
  // Returns whether the origin fetch succeeded this cycle (null: no origin remote configured).
  // Unreachable fleet peers stay tolerated and do not affect the answer -- during a real anchor
  // outage the fleet-<anchor> fetch fails by construction, since the anchor's git server lives
  // inside the daemon that just died, and that is the case takeover exists for.
  private async fetchAll(repo: RepoConfig): Promise<boolean | null> {
    const remotesR = await this.git(repo.path, ['remote']);
    // `git remote` itself failed, so this cycle cannot even tell whether an origin exists. Report
    // false, not null: null means "no origin remote, nothing to veto", and an unanswerable question
    // must not read as a licence to take over the push. Nothing is fetched either way -- the loop
    // below would find an empty remote set.
    if (remotesR.code !== 0) return false;
    const present = new Set(remotesR.stdout.split('\n').map((s) => s.trim()).filter(Boolean));
    let originFetchOk: boolean | null = null;
    for (const remote of this.remoteNames()) {
      if (!present.has(remote)) continue;
      // fleet-<peer> remotes are served by gitserve.ts, which requires a signed
      // x-fleet-auth header (see its AUTH NORMALIZATION note: method token "GIT", path
      // "/git/<repoName>", one signature covering the whole clone/fetch session — the
      // header cannot be baked into the remote's static config since it embeds a 120s-window
      // timestamp, so it is computed fresh per fetch here and injected via
      // `-c http.extraHeader`. origin (GitHub) uses its own credential handling and needs no
      // header; git ignores http.extraHeader for non-HTTP transports so this is harmless to
      // pass unconditionally to fleet-* fetches only.
      const args = await this.fetchAuthArgs(repo, remote);
      args.push('fetch', '--prune', remote);
      // Fleet remotes live on the LAN/mesh: they connect in milliseconds or
      // they are down. A dead peer must cost ~10s, not a full origin-grade
      // timeout per repo per cycle (three repos made first cycles run minutes).
      const isFleet = remote.startsWith('fleet-');
      const timeoutMs = isFleet ? Math.min(this.fetchTimeoutMs, 10000) : this.fetchTimeoutMs;
      const startedMs = this.now();
      const r = await this.git(repo.path, args, timeoutMs);
      const durationMs = this.now() - startedMs;
      // Keyed on the remote name, not on !isFleet: origin is the push target, and this must not
      // start tracking some other non-fleet remote if remoteNames() ever grows one.
      if (remote === 'origin') originFetchOk = r.code === 0;
      if (r.code !== 0) {
        const timedOut = r.code === 124 && durationMs >= timeoutMs - TIMEOUT_SLACK_MS;
        const detail = { repo: repo.name, remote, code: r.code, stderr: r.stderr.trim().slice(0, 300) };
        if (isFleet && timedOut) {
          // A dead peer times out every cycle by construction; log loud only on the flip.
          // Origin fetch failures and every real (non-timeout) git error skip the gate and
          // always warn -- those are the ones an operator needs to see every time.
          const transition = this.fetchGate.observe(`fetch:${repo.name}:${remote}`, true);
          log(transition === 'entered' ? 'info' : 'debug', 'fetch timed out; continuing', detail);
        } else {
          // Gate hygiene (Class E): a real (non-timeout) error always warns unconditionally, but
          // for a fleet remote it must ALSO clear the timeout gate -- otherwise a LATER, genuinely
          // fresh timeout outage silently opens at 'still-bad'/debug instead of 'entered'/info,
          // because the gate was left latched from an earlier, unrelated timeout streak that this
          // real error actually resolved.
          if (isFleet) this.fetchGate.observe(`fetch:${repo.name}:${remote}`, false);
          log('warn', 'fetch failed; continuing', detail);
        }
      } else if (isFleet) {
        this.fetchGate.observe(`fetch:${repo.name}:${remote}`, false);
      }
    }
    return originFetchOk;
  }

  // (3) merge each peer's newest sync/<peer> tip into sync/<machine> with conflict rules.
  private async mergePeers(
    repo: RepoConfig,
    vetted: boolean,
  ): Promise<{ mergedAny: boolean; unionRegenNeeded: boolean }> {
    let mergedAny = false;
    let unionRegenNeeded = false;
    const remotes = this.remoteNames();
    const peerNames = this.cfg.peers
      .map((p) => p.name)
      .filter((n) => n !== this.cfg.machine)
      .sort(codepointCompare);

    for (const peerName of peerNames) {
      // Resolve the newest tip of this peer across every remote that carries it.
      const candidates: { remote: string; ct: number }[] = [];
      for (const remote of remotes) {
        const ref = `refs/remotes/${remote}/sync/${peerName}`;
        const r = await this.git(repo.path, ['log', '-1', '--format=%ct', ref]);
        if (r.code === 0) {
          const ct = parseInt(r.stdout.trim(), 10);
          if (Number.isFinite(ct)) candidates.push({ remote, ct });
        }
      }
      if (candidates.length === 0) continue;
      candidates.sort((a, b) => b.ct - a.ct || codepointCompare(a.remote, b.remote));
      const bestRef = `refs/remotes/${candidates[0]!.remote}/sync/${peerName}`;
      const theirsTip = (await this.gitOk(repo.path, ['rev-parse', bestRef])).stdout.trim();
      const r = await this.mergeTip(repo, {
        theirsTip,
        peer: peerName,
        source: `${peerName} (${candidates[0]!.remote})`,
        vetted,
      });
      if (r.outcome === 'merged') mergedAny = true;
      if (r.unionRegenNeeded) unionRegenNeeded = true;
    }

    return { mergedAny, unionRegenNeeded };
  }

  // Merge one tip into sync/<machine> under the conflict rules. Shared by mergePeers (a peer's
  // sync branch) and reconcileOwnBranch (origin's copy of our own), so the two can never drift:
  // union paths take the merge and leave reconciliation to the postMerge regenerator, every other
  // path is newest-wins by author time -- held while the clock is unvetted -- with the loser kept
  // under .sync-conflicts/. `peer` names the other side for the tie-break (codepoint order against
  // this machine's name) and the conflict-artifact directory; `source` is for error messages.
  //
  // 'contained': nothing to do, or the merge left HEAD where it was. 'deferred': not merged this
  // cycle, the repo untouched. A merge that would commit unreconciled content throws, after aborting.
  private async mergeTip(
    repo: RepoConfig,
    m: { theirsTip: string; peer: string; source: string; vetted: boolean },
  ): Promise<MergeTipResult> {
    const { theirsTip, peer: peerName } = m;
    let unionRegenNeeded = false;
    const oursTip = await this.head(repo.path);
    if (oursTip === null) return { outcome: 'deferred', unionRegenNeeded, conflicts: 0 };

    const anc = await this.git(repo.path, ['merge-base', '--is-ancestor', theirsTip, 'HEAD']);
    if (anc.code === 0) return { outcome: 'contained', unionRegenNeeded, conflicts: 0 };

    // Ownership marker for settleStrandedMerge, written before the merge starts and removed only
    // once MERGE_HEAD is gone again -- so a process that dies in between leaves both behind, and the
    // next cycle knows the half-done merge is its own to abort.
    const dirs = await resolveGitDirs(repo.path);
    const marker = dirs === null ? null : join(dirs.gitDir, MERGE_MARKER);
    if (marker !== null) await writeFile(marker, `${theirsTip}\n`);
    try {
      return await this.mergeAndResolve(repo, m, oursTip);
    } finally {
      if (marker !== null && dirs !== null && !(await pathExists(join(dirs.gitDir, 'MERGE_HEAD')))) {
        await rm(marker, { force: true }).catch(() => {});
      }
    }
  }

  private async mergeAndResolve(
    repo: RepoConfig,
    m: { theirsTip: string; peer: string; source: string; vetted: boolean },
    oursTip: string,
  ): Promise<MergeTipResult> {
    const { theirsTip, peer: peerName } = m;
    let unionRegenNeeded = false;
    // A plain `git merge`, so hooks run exactly as they always have: pre-merge-commit and
    // commit-msg, then post-merge -- not pre-commit, which a `--no-commit` + `commit` pair would run
    // instead. A peer on an older version may have committed a path Windows cannot hold; the merge
    // records the peer's tree as it is, and a follow-up commit in the same step takes the path out
    // again, so the tip this cycle pushes is portable either way.
    const merge = await this.git(repo.path, ['merge', '--no-ff', '--no-edit', theirsTip]);
    if (merge.code === 0) {
      if ((await this.untrackUnportable(repo)) > 0) {
        const staged = await this.git(repo.path, ['diff', '--cached', '--quiet']);
        if (staged.code !== 0) await this.commitOrDefer(repo, ['-m', `sync: ${this.cfg.machine} ${this.isoNow()}`]);
      }
      const newHead = await this.head(repo.path);
      return { outcome: newHead !== oursTip ? 'merged' : 'contained', unionRegenNeeded, conflicts: 0 };
    }
    if (/Not committing merge/.test(merge.stderr)) {
      // A pre-merge-commit or commit-msg hook said no. The merge is ours and still open: close it,
      // and wait for a person rather than retry into the same refusal every cycle.
      await this.gitRecover(repo.path, ['merge', '--abort']);
      throw new SyncDeferred(`a merge hook refused the merge of ${m.source}: ${firstVerdict(merge.stderr)}`);
    }

    const conflicted = await this.conflictedPaths(repo.path);
    if (conflicted.length === 0) {
      await this.gitRecover(repo.path, ['merge', '--abort']);
      throw new Error(`merge of ${m.source} failed without conflicts: ${merge.stderr.trim()}`);
    }

    // Union paths are resolved by taking the merge and re-running the postMerge
    // regenerator (must-keep #3) — never by newest-wins. That only produces a correct
    // file if a regenerator is actually configured to reconcile it; commit nothing and
    // fail loudly rather than silently leaving unreconciled merge content in place.
    const hasUnionConflict = conflicted.some((p) => this.cfg.unionPaths.includes(p));
    if (hasUnionConflict && (!repo.postMerge || repo.postMerge.length === 0)) {
      await this.gitRecover(repo.path, ['merge', '--abort']);
      throw new Error(
        `sync cycle: union-path conflict with ${peerName} in ${repo.name} has no postMerge regenerator configured — refusing to commit unreconciled content`,
      );
    }

    // Newest-wins resolution depends on this machine's clock; hold it until vetted.
    const hasNewestWins = conflicted.some((p) => !this.cfg.unionPaths.includes(p));
    if (hasNewestWins && !m.vetted) {
      await this.gitRecover(repo.path, ['merge', '--abort']);
      log('warn', 'conflict needs newest-wins but clock unvetted; deferring peer merge', {
        repo: repo.name,
        peer: peerName,
      });
      return { outcome: 'deferred', unionRegenNeeded, conflicts: 0 };
    }

    const fsIso = this.fsIso();
    for (const path of conflicted) {
      if (this.cfg.unionPaths.includes(path)) {
        // Take the merge, not a side: git's failed `merge --no-ff` already left its own
        // 3-way merge attempt in the worktree (conflict markers around the overlapping
        // hunks, but BOTH sides' content present). Discarding that in favor of
        // --theirs/--ours (the old behavior) silently drops whichever side lost — fatal
        // for a grow-only union file with no other source of truth. Leave it as-is and
        // let the postMerge regenerator (asserted present above) reconcile it. Only pick
        // a single side when the path is genuinely absent from the tree (e.g. a
        // delete/modify conflict), so a union path is never deleted outright.
        const presentInTree = await pathExists(join(repo.path, path));
        if (!presentInTree) {
          const co = await this.git(repo.path, ['checkout', '--theirs', '--', path]);
          if (co.code !== 0) await this.git(repo.path, ['checkout', '--ours', '--', path]);
        }
        await this.git(repo.path, ['add', '--', path]);
        unionRegenNeeded = true;
        continue;
      }
      // Newest-wins by last author timestamp touching the path; tie -> machine name ascending.
      const oursAt = await this.lastAuthorAt(repo.path, oursTip, path);
      const theirsAt = await this.lastAuthorAt(repo.path, theirsTip, path);
      let winnerOurs: boolean;
      if (oursAt > theirsAt) winnerOurs = true;
      else if (theirsAt > oursAt) winnerOurs = false;
      else winnerOurs = codepointCompare(this.cfg.machine, peerName) < 0;

      const loserMachine = winnerOurs ? peerName : this.cfg.machine;
      const losingTip = winnerOurs ? theirsTip : oursTip;
      await this.git(repo.path, ['checkout', winnerOurs ? '--ours' : '--theirs', '--', path]);
      await this.git(repo.path, ['add', '--', path]);

      // Raw bytes, not util.run's UTF-8-decoding text() — the losing version may be
      // binary; a lossy decode would corrupt the preserved conflict artifact (mirrors
      // gitserve.ts's runGitBinary, which exists for the identical reason).
      const show = await this.gitShowBytes(repo.path, `${losingTip}:${path}`);
      if (show.code === 0) {
        const rel = join('.sync-conflicts', `${fsIso}-${loserMachine}`, path);
        await atomicWrite(join(repo.path, rel), show.stdout);
        await this.git(repo.path, ['add', '--', rel]);
        this.deps.onConflictArtifact(repo.name, rel);
      }
    }

    await this.stagePortable(repo);
    await this.untrackUnportable(repo);
    await this.commitOrDefer(repo, ['--no-edit']);
    return { outcome: 'merged', unionRegenNeeded, conflicts: conflicted.length };
  }

  // (4) postMerge regenerators (union authority), then commit any regenerated changes.
  private async runPostMerge(repo: RepoConfig, mergedAny: boolean, unionRegenNeeded: boolean): Promise<void> {
    const pm = repo.postMerge;
    if (!pm || pm.length === 0) {
      if (unionRegenNeeded) {
        log('warn', 'union conflict resolved but no postMerge regenerator configured', { repo: repo.name });
      }
      return;
    }
    if (!mergedAny && !unionRegenNeeded) return;

    for (const argv of pm) {
      if (argv.length === 0) continue;
      const r = await run(argv, { cwd: repo.path, timeoutMs: this.postMergeTimeoutMs });
      this.deps.onStep?.();
      if (r.code !== 0) {
        throw new Error(`postMerge [${argv.join(' ')}] failed (code ${r.code}): ${r.stderr.trim().slice(0, 300)}`);
      }
    }
    await this.commitAll(repo, `postmerge: ${this.cfg.machine} ${this.isoNow()}`);
  }

  // (5) push sync/<machine> to origin with retries+backoff; skip cleanly when origin is absent.
  // A non-fast-forward rejection is not retried as-is (waiting cannot change the answer): it gets
  // one reconcileOwnBranch per cycle, and an immediate retry if that merged origin's copy in.
  private async pushOrigin(repo: RepoConfig, vetted: boolean): Promise<void> {
    const originUrl = await this.git(repo.path, ['remote', 'get-url', 'origin']);
    if (originUrl.code !== 0) {
      // No GitHub backup for this repo. Say so explicitly rather than leaving the boot-time null
      // in the table: health.ts reads a null as "overdue by forever" and raises github-push-stale
      // every cycle, so a machine that was never meant to push alarms permanently -- and that
      // fault drags the peer's syncStale true, misreporting a repo that is syncing perfectly.
      this.deps.onGithubPushNotApplicable?.(repo.name);
      return;
    }
    const branch = `sync/${this.cfg.machine}`;
    const attempts = this.pushBackoffMs.length + 1;
    let reconciled = false;
    let retryNow = false;
    for (let i = 0; i < attempts; i++) {
      if (i > 0 && !retryNow) {
        if (this.stopping) break;
        await this.pause(this.pushBackoffMs[i - 1]!);
      }
      retryNow = false;
      const startedMs = this.now();
      const r = await this.git(repo.path, ['push', 'origin', branch]);
      const durationMs = this.now() - startedMs;
      if (r.code === 0) {
        this.pushGate.observe(`push:${repo.name}`, false);
        this.deps.onGithubPush(repo.name, this.now());
        return;
      }
      if (!reconciled && isNonFastForwardRejection(r.stderr)) {
        reconciled = true;
        if (await this.reconcileOwnBranch(repo, vetted)) {
          // Retry straight away and without spending an attempt: this is a new push, not a repeat
          // of the rejected one.
          retryNow = true;
          i--;
          continue;
        }
        log('info', 'push to origin rejected as non-fast-forward; merging origin is deferred to the next cycle', {
          repo: repo.name,
        });
        break;
      }
      const isFinal = i === attempts - 1;
      const detail = { repo: repo.name, attempt: i + 1, code: r.code, stderr: r.stderr.trim().slice(0, 300) };
      if (!isFinal) {
        // Backoff attempts 1..N-1 retry in seconds; only the exhausted final attempt is worth an
        // operator's attention.
        log('debug', 'push to origin failed; retrying', detail);
        continue;
      }
      const timedOut = r.code === 124 && durationMs >= this.gitTimeoutMs - TIMEOUT_SLACK_MS;
      if (timedOut) {
        // A persistently unreachable GitHub times out on the final attempt every sync cycle;
        // log loud only on the flip. A real error on the final attempt (auth, non-fast-forward,
        // etc.) always warns -- that is never a "wait it out" condition.
        const transition = this.pushGate.observe(`push:${repo.name}`, true);
        log(transition === 'entered' ? 'warn' : 'debug', 'push to origin failed', detail);
      } else {
        // Gate hygiene (Class E): warns unconditionally either way, but must ALSO clear the
        // timeout gate here -- otherwise a LATER, genuinely fresh timeout streak silently opens at
        // 'still-bad'/debug instead of 'entered'/warn, because the gate was left latched from an
        // earlier, unrelated timeout streak that this real error actually resolved.
        this.pushGate.observe(`push:${repo.name}`, false);
        log('warn', 'push to origin failed', detail);
      }
    }
    this.deps.onGithubPush(repo.name, null);
  }

  // origin rejected sync/<machine> as non-fast-forward: origin holds commits on this machine's own
  // branch that the local branch does not. This machine is the branch's only writer, so those are
  // its own commits that the local repo lost -- seen live after a crash, where origin kept a merge
  // commit the re-converged local branch no longer had, and every push for five days was rejected
  // until a human merged origin's copy back by hand. That merge is the repair, done here.
  //
  // Merged, never forced and never rebased: a force-push would destroy whatever origin holds that
  // nowhere else does, and a rebase would rewrite commits peers have already merged. The merge goes
  // through mergeTip, so it is held to exactly the peer-merge rules -- union paths through the
  // postMerge regenerator, newest-wins only on a vetted clock, the loser preserved. Origin's copy is
  // labelled `<machine>-origin` for the conflict-artifact directory, and on a tied author time the
  // local side wins (its name sorts first). Anything mergeTip will not do safely leaves the repo as
  // it was and returns false, and the next cycle tries again; that is not a fault.
  //
  // Returns whether the push is worth retrying now.
  private async reconcileOwnBranch(repo: RepoConfig, vetted: boolean): Promise<boolean> {
    const branch = `sync/${this.cfg.machine}`;
    const trackingRef = `refs/remotes/origin/${branch}`;
    const fetched = await this.git(repo.path, ['fetch', 'origin', `+refs/heads/${branch}:${trackingRef}`], this.fetchTimeoutMs);
    if (fetched.code !== 0) {
      log('info', 'own-branch merge: could not fetch origin\'s copy; will retry next cycle', {
        repo: repo.name,
        stderr: fetched.stderr.trim().slice(0, 300),
      });
      return false;
    }
    const originTipR = await this.git(repo.path, ['rev-parse', '--verify', '--quiet', `${trackingRef}^{commit}`]);
    const localTipBefore = await this.head(repo.path);
    if (originTipR.code !== 0 || localTipBefore === null) return false;
    const originTip = originTipR.stdout.trim();

    let r: MergeTipResult;
    try {
      r = await this.mergeTip(repo, {
        theirsTip: originTip,
        peer: `${this.cfg.machine}-origin`,
        source: `origin's ${branch}`,
        vetted,
      });
    } catch (err) {
      // mergeTip aborts before it throws; this is belt and braces for a throw from a git step.
      await this.abortOwnMerge(repo).catch(() => {});
      log('info', 'own-branch merge: not safe to merge origin\'s copy this cycle', {
        repo: repo.name,
        error: boundErrorText(err instanceof Error ? err.message : String(err)),
      });
      return false;
    }
    if (r.outcome === 'deferred') return false;
    // Already contained: origin moved between our push and this fetch, or rejected for a reason the
    // fetch has since resolved. One more push answers which.
    if (r.outcome === 'contained') return true;

    // The same regenerators a peer merge would run; a failure here is the same fault it would be.
    await this.runPostMerge(repo, true, r.unionRegenNeeded);
    const localTipAfter = (await this.head(repo.path)) ?? localTipBefore;
    const detail: OwnBranchMerge = { branch, originTip, localTipBefore, localTipAfter, conflicts: r.conflicts };
    log('warn', 'own-branch merge: merged origin\'s copy of the sync branch back in', { repo: repo.name, ...detail });
    try {
      await this.deps.onOwnBranchMerged?.(repo.name, detail);
    } catch (err) {
      log('error', 'own-branch merge: recording the repair failed', { repo: repo.name, error: String(err) });
    }
    return true;
  }

  private remoteNames(): string[] {
    return ['origin', ...this.cfg.peers.filter((p) => p.name !== this.cfg.machine).map((p) => `fleet-${p.name}`)];
  }

  private async commitAll(repo: RepoConfig, msg: string): Promise<boolean> {
    await this.stagePortable(repo);
    await this.untrackUnportable(repo);
    const staged = await this.git(repo.path, ['diff', '--cached', '--quiet']);
    if (staged.code === 0) return false;
    await this.commitOrDefer(repo, ['-m', msg]);
    return true;
  }

  private async conflictedPaths(repoPath: string): Promise<string[]> {
    const r = await this.git(repoPath, ['diff', '--name-only', '--diff-filter=U', '-z']);
    if (r.code !== 0) throw new Error(`could not list conflicted paths (code ${r.code}): ${r.stderr.trim()}`);
    return r.stdout.split('\0').filter(Boolean);
  }

  private async lastAuthorAt(repoPath: string, tip: string, path: string): Promise<number> {
    const r = await this.git(repoPath, ['log', '-1', '--format=%at', tip, '--', path]);
    const n = parseInt(r.stdout.trim(), 10);
    return Number.isFinite(n) ? n : 0;
  }

  private async head(repoPath: string): Promise<string | null> {
    const r = await this.git(repoPath, ['rev-parse', 'HEAD']);
    return r.code === 0 ? r.stdout.trim() : null;
  }

  private async git(cwd: string, args: string[], timeoutMs?: number, evenWhileDraining = false) {
    const r = await this.gitRunner(['git', ...args], {
      cwd,
      timeoutMs: timeoutMs ?? this.gitTimeoutMs,
      afterKill: ({ startedAtMs }) => this.reapKilledChildLocks(cwd, startedAtMs),
      ...(evenWhileDraining ? { evenWhileDraining: true } : {}),
    });
    this.deps.onStep?.();
    return r;
  }

  // A git step that puts the repo BACK into a consistent state (`merge --abort`). It runs even
  // after a shutdown's drain has started refusing new children: refusing it is what used to strand
  // MERGE_HEAD and conflict markers for the next boot to commit.
  private async gitRecover(cwd: string, args: string[]) {
    return await this.git(cwd, args, undefined, true);
  }

  // util.runBytes keeps stdout as raw bytes instead of decoding UTF-8 text — required for
  // `git show <tip>:<path>` when the blob may be binary (mirrors gitserve.ts).
  private async gitShowBytes(
    cwd: string,
    ref: string,
  ): Promise<{ code: number; stdout: Uint8Array; stderr: string }> {
    const r = await runBytes(['git', 'show', ref], { cwd, timeoutMs: this.gitTimeoutMs });
    this.deps.onStep?.();
    return r;
  }

  private async gitOk(cwd: string, args: string[], timeoutMs?: number) {
    const r = await this.git(cwd, args, timeoutMs);
    if (r.code !== 0) {
      throw new Error(`git ${describeArgs(args)} failed (code ${r.code}): ${r.stderr.trim() || r.stdout.trim()}`);
    }
    return r;
  }

  // Subset of `paths` that `git add` will accept: everything except ignored-and-untracked.
  // check-ignore is index-aware — it reports nothing for a TRACKED path even when a
  // .gitignore rule matches it — so this can never silently drop a real modification to a
  // tracked file; it only drops paths `git add` would have refused outright.
  private async dropIgnored(repoPath: string, paths: string[]): Promise<string[]> {
    // -z makes both stdin and stdout NUL-delimited, so paths containing newlines survive.
    // Exit codes: 0 = at least one path ignored, 1 = none ignored (not a failure),
    // anything else = real error.
    const r = await run(['git', 'check-ignore', '-z', '--stdin'], {
      cwd: repoPath,
      timeoutMs: this.gitTimeoutMs,
      stdin: paths.join('\0'),
    });
    this.deps.onStep?.();
    if (r.code === 1) return paths;
    if (r.code !== 0) {
      throw new Error(`git check-ignore failed (code ${r.code}): ${r.stderr.trim()}`);
    }
    const ignored = new Set(r.stdout.split('\0').filter(Boolean));
    if (ignored.size === 0) return paths;
    log('info', 'skipping ignored paths in auto-commit', {
      repo: repoPath,
      paths: [...ignored].slice(0, 10),
    });
    return paths.filter((p) => !ignored.has(p));
  }

  // Subset of `paths` that still resolves to something: `git add -A -- <paths>` exits 128 the
  // moment ONE named path matches neither the worktree nor the index, and that aborts the whole
  // repo's cycle. Two everyday commands produce such a path — `git mv` (status names both ends
  // of the rename, and the old end is gone from disk AND from the index) and `git rm` (staged
  // delete, likewise gone from both). An *unstaged* delete is not affected: the path is still an
  // index entry, so the pathspec resolves. Dropping these loses nothing, because their change is
  // already staged and the commit below takes no pathspec.
  //
  // `absent` is the already-computed subset that is missing from disk, so the common case costs
  // no git call at all: a path present on disk can never be the unmatchable one.
  private async dropVanished(repoPath: string, paths: string[], absent: string[]): Promise<string[]> {
    if (absent.length === 0) return paths;
    // -z keeps paths with newlines intact. ls-files reports the subset still in the index;
    // a pathspec matching nothing is not an error here, unlike in `add`.
    const r = await run(['git', 'ls-files', '-z', '--', ...absent], {
      cwd: repoPath,
      timeoutMs: this.gitTimeoutMs,
    });
    this.deps.onStep?.();
    if (r.code !== 0) {
      throw new Error(`git ls-files failed (code ${r.code}): ${r.stderr.trim()}`);
    }
    const inIndex = new Set(r.stdout.split('\0').filter(Boolean));
    const vanished = new Set(absent.filter((p) => !inIndex.has(p)));
    if (vanished.size === 0) return paths;
    log('info', 'skipping vanished paths in auto-commit', {
      repo: repoPath,
      paths: [...vanished].slice(0, 10),
    });
    return paths.filter((p) => !vanished.has(p));
  }

  private isoNow(): string {
    return new Date(this.now()).toISOString();
  }

  // Filesystem-safe timestamp: a repo may sit on a filesystem that rejects ':' in filenames
  // (fuseblk, exFAT, NTFS), where an ISO timestamp would fail to create the file at all.
  private fsIso(): string {
    return this.isoNow().replace(/[:.]/g, '-');
  }
}

// git's own words when it cannot read .git/index. Every one of these means the file's bytes are
// not a valid index: a truncated write, a zero-filled block from a lost page cache, or a header
// git does not recognise. Matched on the message rather than an exit code because git reports all
// of them as a plain fatal with code 128, the same code a hundred ordinary failures use.
//
// Deliberately NOT here: `index.lock` (another process holds it -- waiting is the fix, not
// rebuilding), and `unmerged` / `needs merge` (a real conflict state a rebuild would paper over).
const CORRUPT_INDEX_PATTERNS = [
  'unknown index entry format',
  'bad index file sha1 signature',
  'index file corrupt',
  'index file smaller than expected',
  'index uses',
  'malformed index',
];

export function isCorruptIndexError(message: string): boolean {
  const m = message.toLowerCase();
  if (m.includes('index.lock')) return false;
  return CORRUPT_INDEX_PATTERNS.some((p) => m.includes(p));
}

type RepairableDamage = 'index' | 'empty-objects';

// Written into the git dir by mergeTip for the length of a merge; see settleStrandedMerge.
const MERGE_MARKER = 'sukarfleet-merge';

// A cycle that stopped because something somebody else is in the middle of has to finish first.
// Not a fault: runCycle reports it as a deferral (see its catch).
class SyncDeferred extends Error {
  constructor(readonly reason: string) {
    super(reason);
  }
}

// git's own one-line verdict out of a complaint: the first `fatal:` or `error:` line, else the first
// line, kept short enough for a status note.
function firstVerdict(text: string): string {
  const lines = text.split('\n').map((l) => l.trim()).filter(Boolean);
  const v = lines.find((l) => /^(fatal|error):/i.test(l)) ?? lines[0] ?? 'no reason given';
  return v.length <= 300 ? v : `${v.slice(0, 300)}…`;
}

// The lock git named, for the deferral note. Falls back to a generic phrase.
function lockBusyReason(message: string): string {
  const m = /'([^'\n]*\.lock)'/.exec(message);
  return m ? `waiting for another git to release ${m[1]}` : 'waiting for another git to release a lock';
}

// Characters, names and endings a Windows filesystem refuses in a path component. git for Windows
// enforces the same list (core.protectNTFS), which is how an unportable name from a Linux machine
// turns into "invalid path ... Merge with strategy ort failed" on the Windows peer.
const WINDOWS_BAD_CHARS = /[<>:"|?*\\\x00-\x1f]/;
const WINDOWS_RESERVED_NAME = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9]|conin\$|conout\$) *(?:\..*)?$/i;

// Can every machine in a mixed fleet check this repo-relative path out? Applied on every platform:
// what matters is where the commit goes, not where it was made.
export function isPortablePath(path: string): boolean {
  for (const c of path.split('/')) {
    if (c.length === 0) continue;
    if (WINDOWS_BAD_CHARS.test(c)) return false;
    if (c.endsWith('.') || c.endsWith(' ')) return false;
    if (WINDOWS_RESERVED_NAME.test(c)) return false;
  }
  return true;
}

// git's words when a lock it needs already exists: `Unable to create '.../index.lock': File exists`,
// `cannot lock ref 'refs/heads/x': Unable to create '.../x.lock': File exists`, `could not lock
// config file .git/config: File exists`. Every one of them is "somebody else holds this", which a
// later cycle resolves by itself -- or reapStaleLocks does, once the holder is provably gone.
export function isGitLockBusyError(message: string): boolean {
  return /\block\b[^\n]*file exists|\.lock'?[^\n]*file exists/i.test(message);
}

// git push's verdict when the remote branch holds commits the local one does not. Not translated by
// git, unlike the hint text around it.
export function isNonFastForwardRejection(stderr: string): boolean {
  return /\[rejected\][^\n]*\((?:non-fast-forward|fetch first)\)/.test(stderr);
}

// The ceiling on any sync error this daemon reports. It travels further than a log line: /status,
// the health fault message, the desktop notification, every peer's gossip and every MCP answer
// built from those.
export const SYNC_ERROR_MAX_CHARS = 2000;
const ERROR_HEAD_CHARS = 400;
const ERROR_LINE_CHARS = 400;

// Fit an error into SYNC_ERROR_MAX_CHARS without losing the part that says what went wrong. Short
// text passes through untouched. Long text keeps its opening (which step failed) and then every
// line git marks `fatal:` or `error:` (why), wherever in the text it sits; what goes is the bulk in
// between -- in practice a `git add -A -- <path> <path> ...` argv, which once made a single sync
// error 226,000 characters long.
export function boundErrorText(text: string, max: number = SYNC_ERROR_MAX_CHARS): string {
  if (text.length <= max) return text;
  const clip = (s: string, n: number) => (s.length <= n ? s : `${s.slice(0, n)}…`);
  let out = `${clip(text, ERROR_HEAD_CHARS)} [${text.length} chars, shortened]`;
  const verdicts = new Set((text.match(/\b(?:fatal|error): [^\n]*/gi) ?? []).map((v) => clip(v.trim(), ERROR_LINE_CHARS)));
  for (const v of verdicts) {
    if (out.length + 1 + v.length > max) break;
    out += `\n${v}`;
  }
  return out.length <= max ? out : out.slice(0, max);
}

// argv for an error message. Short argv verbatim; a long one keeps its options and names how many
// pathspecs followed `--` instead of listing them (that list is what made incident errors enormous).
function describeArgs(args: readonly string[]): string {
  const joined = args.join(' ');
  if (joined.length <= 200) return joined;
  const dashes = args.indexOf('--');
  if (dashes >= 0 && dashes < 12) {
    return `${args.slice(0, dashes + 1).join(' ')} <${args.length - dashes - 1} paths>`;
  }
  return `${args.slice(0, 8).join(' ')} … (${args.length} args)`;
}

// git's words for a zero-byte loose object: `error: object file .git/objects/f7/bbed... is empty`.
// Deliberately NOT `bad object` or `missing object` on their own: those also describe a ref that
// names something never fetched, which a refetch-everything repair has no business treating as
// crash damage.
export function isEmptyObjectError(message: string): boolean {
  return /object file \S+ is empty/i.test(message);
}

// Every zero-byte loose object under `objectsDir`, as a full hex object id. Packs, info/ and
// temp files are skipped by shape: only a two-hex-digit directory holding hex-named files is a
// loose object.
async function findEmptyLooseObjects(objectsDir: string): Promise<string[]> {
  const found: string[] = [];
  let dirs: string[];
  try {
    dirs = await readdir(objectsDir);
  } catch {
    return found;
  }
  for (const d of dirs) {
    if (!/^[0-9a-f]{2}$/.test(d)) continue;
    let names: string[];
    try {
      names = await readdir(join(objectsDir, d));
    } catch {
      continue;
    }
    for (const n of names) {
      if (!/^[0-9a-f]{38}([0-9a-f]{24})?$/.test(n)) continue;
      try {
        if ((await stat(join(objectsDir, d, n))).size === 0) found.push(d + n);
      } catch {
        // Vanished mid-scan (a concurrent gc packed it): not damage.
      }
    }
  }
  return found;
}

async function pathExists(p: string): Promise<boolean> {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

async function statSig(abs: string): Promise<string> {
  try {
    const s = await stat(abs);
    return `${s.size}:${s.mtimeMs}`;
  } catch {
    return 'MISSING';
  }
}

// Does `git status --porcelain -z` report any unmerged entry (DD, AU, UD, UA, DU, AA, UU)?
function hasUnmergedZ(out: string): boolean {
  const fields = out.split('\0');
  for (let i = 0; i < fields.length; i++) {
    const e = fields[i]!;
    if (e.length < 3) continue;
    const xy = e.slice(0, 2);
    if (xy.includes('U') || xy === 'AA' || xy === 'DD') return true;
    if (e[0] === 'R' || e[0] === 'C') i++;
  }
  return false;
}

// Parse `git status --porcelain -z` into the set of worktree paths (both ends of renames).
// The rename source is reported even though it no longer exists in the worktree or the index;
// dropVanished filters it out before `git add` sees it.
function parsePorcelainZ(out: string): string[] {
  const fields = out.split('\0');
  const paths = new Set<string>();
  for (let i = 0; i < fields.length; i++) {
    const e = fields[i]!;
    if (e.length < 3) continue;
    const x = e[0];
    const p = e.slice(3);
    if (p) paths.add(p);
    if (x === 'R' || x === 'C') {
      i++;
      const src = fields[i];
      if (src) paths.add(src);
    }
  }
  return [...paths];
}
