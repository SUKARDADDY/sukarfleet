// SPDX-License-Identifier: AGPL-3.0-or-later
// Section 03 sync cycle: multi-repo peer-to-peer git state machine.
// Single writer per machine on sync/<machine>. main is never touched here.

import { join, dirname } from 'node:path';
import { stat } from 'node:fs/promises';
import type { FleetConfig, RepoConfig, PresenceRepoStat, MachineKey } from './types';
import { run, runBytes, log, atomicWrite, nowMs, sleep as utilSleep, TransitionGate } from './util';
import { buildAuthHeader } from './keys';

// util.run reports its own timeout kill as exit 124, which a command may also exit with
// legitimately; elapsed time is what actually disambiguates them. Mirrors sshadmin.ts's identical
// constant and comment -- the two files independently need the same slack for the same reason.
const TIMEOUT_SLACK_MS = 250;

export interface SyncerDeps {
  isClockVetted: () => boolean;
  onRepoStat: (repo: string, stat: PresenceRepoStat) => void;
  onGithubPush: (repo: string, okMs: number | null) => void;
  onConflictArtifact: (repo: string, path: string) => void;
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

export interface SyncerOptions {
  sleep?: (ms: number) => Promise<void>;
  debounceMs?: number;
  pushBackoffMs?: number[];
  gitTimeoutMs?: number;
  fetchTimeoutMs?: number;
  postMergeTimeoutMs?: number;
  now?: () => number;
  // Test seam for the git subprocess (mirrors sshadmin.ts's deps.runner convention). Defaults to
  // util.run. Only the `git()` helper below is routed through it -- postMerge argv and the raw
  // gitShowBytes path are untouched, since the timeout-vs-real-error classification this seam
  // exists for only applies to fetchAll/pushOrigin.
  gitRunner?: typeof run;
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
  private readonly postMergeTimeoutMs: number;
  private readonly now: () => number;
  private readonly gitRunner: typeof run;
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
    this.postMergeTimeoutMs = opts.postMergeTimeoutMs ?? 120000;
    this.now = opts.now ?? nowMs;
    this.gitRunner = opts.gitRunner ?? run;
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

  async syncOnce(repo: RepoConfig): Promise<void> {
    try {
      const branchR = await this.gitOk(repo.path, ['symbolic-ref', '--short', 'HEAD']);
      const branch = branchR.stdout.trim();
      const want = `sync/${this.cfg.machine}`;
      if (branch !== want) {
        throw new Error(`refusing sync: HEAD is '${branch}', expected '${want}' (single-writer)`);
      }

      const vetted = this.deps.isClockVetted();
      if (vetted) {
        await this.autoCommit(repo.path);
      } else {
        log('info', 'clock unvetted; skipping auto-commit', { repo: repo.name });
      }

      await this.fetchAll(repo);
      const { mergedAny, unionRegenNeeded } = await this.mergePeers(repo, vetted);
      await this.runPostMerge(repo, mergedAny, unionRegenNeeded);
      await this.pushOrigin(repo);

      const lastCommit = await this.head(repo.path);
      this.deps.onRepoStat(repo.name, { lastSyncOkMs: this.now(), lastCommit, syncError: null });
    } catch (err) {
      // Never leave the repo wedged mid-merge.
      await this.git(repo.path, ['merge', '--abort']).catch(() => {});
      const lastCommit = await this.head(repo.path).catch(() => null);
      const msg = err instanceof Error ? err.message : String(err);
      log('error', 'sync cycle failed', { repo: repo.name, error: msg });
      this.deps.onRepoStat(repo.name, { lastSyncOkMs: null, lastCommit, syncError: msg });
    }
  }

  // (1) auto-commit: write-quiet debounce + per-file (size,mtime) stability re-check.
  private async autoCommit(repoPath: string): Promise<boolean> {
    const st = await this.gitOk(repoPath, ['status', '--porcelain', '-z']);
    const paths = parsePorcelainZ(st.stdout);
    if (paths.length === 0) return false;

    const before = new Map<string, string>();
    for (const p of paths) before.set(p, await statSig(join(repoPath, p)));
    await this.sleep(this.debounceMs);

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
    if (stable.length === 0) return false;

    // `git add -A -- <paths>` exits 1 if ANY explicitly-named path is ignored-and-untracked,
    // so a single gitignored file in the changed set aborted the whole repo's sync cycle.
    // status legitimately reports such paths — e.g. a staged `git rm --cached` of a
    // now-ignored machine-local secret whose working copy still sits on disk. Drop them
    // rather than -f them: -f would commit exactly the secret the ignore rule exists to keep
    // out. Anything already staged for a dropped path stays in the index and is still
    // committed below, since the commit takes no pathspec.
    const addable = await this.dropIgnored(repoPath, await this.dropVanished(repoPath, stable, absent));
    if (addable.length > 0) {
      await this.gitOk(repoPath, ['add', '-A', '--', ...addable]);
    }
    const staged = await this.git(repoPath, ['diff', '--cached', '--quiet']);
    if (staged.code === 0) return false;
    await this.gitOk(repoPath, ['commit', '-m', `sync: ${this.cfg.machine} ${this.isoNow()}`]);
    return true;
  }

  // (2) fetch origin + every fleet-<peer>, tolerating unreachable remotes.
  private async fetchAll(repo: RepoConfig): Promise<void> {
    const remotesR = await this.git(repo.path, ['remote']);
    const present = new Set(remotesR.stdout.split('\n').map((s) => s.trim()).filter(Boolean));
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
      const args: string[] = [];
      if (remote.startsWith('fleet-')) {
        const header = await buildAuthHeader('GIT', `/git/${repo.name}`, this.cfg.machine, this.deps.machineKey);
        args.push('-c', `http.extraHeader=x-fleet-auth: ${header}`);
      }
      args.push('fetch', '--prune', remote);
      // Fleet remotes live on the LAN/mesh: they connect in milliseconds or
      // they are down. A dead peer must cost ~10s, not a full origin-grade
      // timeout per repo per cycle (three repos made first cycles run minutes).
      const isFleet = remote.startsWith('fleet-');
      const timeoutMs = isFleet ? Math.min(this.fetchTimeoutMs, 10000) : this.fetchTimeoutMs;
      const startedMs = this.now();
      const r = await this.git(repo.path, args, timeoutMs);
      const durationMs = this.now() - startedMs;
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
          log('warn', 'fetch failed; continuing', detail);
        }
      } else if (isFleet) {
        this.fetchGate.observe(`fetch:${repo.name}:${remote}`, false);
      }
    }
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
      const oursTip = await this.head(repo.path);
      if (oursTip === null) continue;

      const anc = await this.git(repo.path, ['merge-base', '--is-ancestor', theirsTip, 'HEAD']);
      if (anc.code === 0) continue; // already contained

      const merge = await this.git(repo.path, ['merge', '--no-ff', '--no-edit', theirsTip]);
      if (merge.code === 0) {
        const newHead = await this.head(repo.path);
        if (newHead !== oursTip) mergedAny = true;
        continue;
      }

      const conflicted = await this.conflictedPaths(repo.path);
      if (conflicted.length === 0) {
        await this.git(repo.path, ['merge', '--abort']);
        throw new Error(`merge of ${peerName} (${candidates[0]!.remote}) failed without conflicts: ${merge.stderr.trim()}`);
      }

      // Union paths are resolved by taking the merge and re-running the postMerge
      // regenerator (must-keep #3) — never by newest-wins. That only produces a correct
      // file if a regenerator is actually configured to reconcile it; commit nothing and
      // fail loudly rather than silently leaving unreconciled merge content in place.
      const hasUnionConflict = conflicted.some((p) => this.cfg.unionPaths.includes(p));
      if (hasUnionConflict && (!repo.postMerge || repo.postMerge.length === 0)) {
        await this.git(repo.path, ['merge', '--abort']);
        throw new Error(
          `sync cycle: union-path conflict with ${peerName} in ${repo.name} has no postMerge regenerator configured — refusing to commit unreconciled content`,
        );
      }

      // Newest-wins resolution depends on this machine's clock; hold it until vetted.
      const hasNewestWins = conflicted.some((p) => !this.cfg.unionPaths.includes(p));
      if (hasNewestWins && !vetted) {
        await this.git(repo.path, ['merge', '--abort']);
        log('warn', 'conflict needs newest-wins but clock unvetted; deferring peer merge', {
          repo: repo.name,
          peer: peerName,
        });
        continue;
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

      await this.gitOk(repo.path, ['add', '-A']);
      await this.gitOk(repo.path, ['commit', '--no-edit']);
      mergedAny = true;
    }

    return { mergedAny, unionRegenNeeded };
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
    await this.commitAll(repo.path, `postmerge: ${this.cfg.machine} ${this.isoNow()}`);
  }

  // (5) push sync/<machine> to origin with retries+backoff; skip cleanly when origin is absent.
  private async pushOrigin(repo: RepoConfig): Promise<void> {
    const originUrl = await this.git(repo.path, ['remote', 'get-url', 'origin']);
    if (originUrl.code !== 0) return; // no GitHub backup configured
    const branch = `sync/${this.cfg.machine}`;
    const attempts = this.pushBackoffMs.length + 1;
    for (let i = 0; i < attempts; i++) {
      if (i > 0) await this.sleep(this.pushBackoffMs[i - 1]!);
      const startedMs = this.now();
      const r = await this.git(repo.path, ['push', 'origin', branch]);
      const durationMs = this.now() - startedMs;
      if (r.code === 0) {
        this.pushGate.observe(`push:${repo.name}`, false);
        this.deps.onGithubPush(repo.name, this.now());
        return;
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
        log('warn', 'push to origin failed', detail);
      }
    }
    this.deps.onGithubPush(repo.name, null);
  }

  private remoteNames(): string[] {
    return ['origin', ...this.cfg.peers.filter((p) => p.name !== this.cfg.machine).map((p) => `fleet-${p.name}`)];
  }

  private async commitAll(repoPath: string, msg: string): Promise<boolean> {
    await this.gitOk(repoPath, ['add', '-A']);
    const staged = await this.git(repoPath, ['diff', '--cached', '--quiet']);
    if (staged.code === 0) return false;
    await this.gitOk(repoPath, ['commit', '-m', msg]);
    return true;
  }

  private async conflictedPaths(repoPath: string): Promise<string[]> {
    const r = await this.git(repoPath, ['diff', '--name-only', '--diff-filter=U', '-z']);
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

  private async git(cwd: string, args: string[], timeoutMs?: number) {
    const r = await this.gitRunner(['git', ...args], { cwd, timeoutMs: timeoutMs ?? this.gitTimeoutMs });
    this.deps.onStep?.();
    return r;
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
      throw new Error(`git ${args.join(' ')} failed (code ${r.code}): ${r.stderr.trim() || r.stdout.trim()}`);
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
