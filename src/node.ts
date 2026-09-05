// SPDX-License-Identifier: AGPL-3.0-or-later
// sukarfleet node daemon entry point. Wires config, keys, gossip, sync, health,
// transport/clock, endpoints and gitserve into one unprivileged Bun process.

import type {
  AuditEntry,
  FleetConfig,
  IdentityPatch,
  MeshSecretState,
  PairBundle,
  PeerConfig,
  RepoConfig,
  GossipEnvelope,
  PresencePayload,
  PresenceRepoStat,
  PeerView,
  UiAdminLaneView,
  UiState,
} from './types';
import { expandHome, loadConfig, patchConfig, persistLegacyMigration, stateDir } from './config';
import { atomicWrite, clockDriftMs, log, nowMs, run, sdNotify, readJsonFile } from './util';

import { buildAuthHeader, loadOrCreateMachineKey, writeSecretFile } from './keys';
import { Gossip } from './gossip';
import { Syncer } from './syncer';
import { Health, type HealthSelf } from './health';
import { Transport, ClockSentinel, SUSPEND_JUMP_MS } from './transport';
import * as endpoints from './endpoints';
import * as derive from './derive';
import * as gitserve from './gitserve';
import { join, dirname } from 'node:path';

import {
  AuditLog,
  AUDIT_KIND_JOB_ISSUED,
  AUDIT_KIND_JOB_EXECUTED,
  AUDIT_KIND_JOB_EXPIRED,
  AUDIT_KIND_CREDENTIAL_SET,
  AUDIT_KIND_CREDENTIAL_REMOVED,
  AUDIT_KIND_ADMIN_RUN_COMPLETED,
  AUDIT_KIND_ADMIN_RUN_REFUSED,
  flushLocalToUnion,
  crossCheckAuditLog,
  loadForkBaseline,
  type CrossCheckFlagKind,
} from './audit';
import { startMcpServer, type McpDeps, type McpServerHandle } from './mcp';
import { readCappedBody, DEFAULT_MAX_BODY_BYTES, BODY_READ_TIMEOUT_MS } from './http';

// --- SSH admin lane wiring ------------------------------------------------
// Constructed unconditionally: the GUI that switches this lane on has to be reachable on a machine
// where every admin flag is still false. Each module refuses internally -- sshadmin.ts on
// cfg.admin.enabled (origin leg), cfg.admin.acceptIncoming (target leg) and cfg.admin.agentOrigin
// (who may drive it), uiserve.ts on cfg.admin.uiEnabled -- so "constructed" never means
// "permitted".
import { randomBytes } from 'node:crypto';
import { SshAdmin } from './sshadmin';
import { Pairing } from './pairing';
import { UiRoutes, type UiRoutesDeps } from './uiserve';
import * as secrets from './secrets';

const LOOPBACK_ADDRS = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);

// Durable record of the peers whose last dial hit a pinned-host-key mismatch, `{ machine: atMs }`
// under stateDir(). It exists because the fault it feeds is one docs/RUNBOOK-P3.md says never
// auto-heals: sshadmin.ts's run registry is a 20-entry in-memory map that stop() clears and newer
// runs evict, so deriving the fault from it let a restart -- or twenty unrelated runs -- silence a
// critical alarm while the lane kept refusing every call.
const HOSTKEY_ALERTS_FILE = 'admin-hostkey-alerts.json';

// Operator-facing loopback routes, matched EXACTLY. A prefix test here shadowed the mesh route
// /exec/membership-witness (see the dispatch site for the full account).
const OPERATOR_LOOPBACK_ROUTES = new Set(['/exec/audit/tail']);

// Rejects any request that a browser could have issued cross-origin. Loopback-only is a network
// boundary, not an authentication boundary: a web page the operator visits can POST to
// 127.0.0.1, and a text/plain body makes that a CORS-"simple" request needing no preflight. The
// Origin/Sec-Fetch-Site checks catch browser-issued requests; requiring application/json forces a
// preflight this handler never answers. A non-browser local client (curl, the CLI) sends neither
// header and sets the correct content type, so it is unaffected.
function rejectCrossSite(req: Request): Response | null {
  if (req.method !== 'POST' && req.method !== 'PUT' && req.method !== 'DELETE') return null;
  if (req.headers.get('origin') !== null) {
    return jsonResponse({ error: 'cross-origin requests are not accepted on operator routes' }, 403);
  }
  const site = req.headers.get('sec-fetch-site');
  if (site !== null && site !== 'same-origin' && site !== 'none') {
    return jsonResponse({ error: 'cross-site requests are not accepted on operator routes' }, 403);
  }
  const ctype = (req.headers.get('content-type') ?? '').split(';')[0]!.trim().toLowerCase();
  if (ctype !== 'application/json') {
    return jsonResponse({ error: 'content-type must be application/json' }, 415);
  }
  return null;
}

// Bounded JSON read for the operator loopback routes, mirroring execroutes.ts's mesh-side cap.
async function readCappedJson(req: Request): Promise<unknown> {
  const res = await readCappedBody(req, DEFAULT_MAX_BODY_BYTES, BODY_READ_TIMEOUT_MS);
  if (!res.ok) throw new Error(`body read failed: ${res.reason}`);
  return JSON.parse(new TextDecoder().decode(res.bytes));
}

// Relative filename (inside a repo working tree) sukarfleet's audit-log union file uses by
// convention (audit.ts's flushLocalToUnion/regenerateUnionLog). Only engaged when the operator
// has explicitly opted in by listing this exact path in FleetConfig.unionPaths -- config.ts's own
// contract for which repo paths get union-merged instead of newest-wins on conflict (see
// syncer.ts). node.ts does not silently rewrite the operator's unionPaths array; it only checks
// whether this convention name is already present before wiring the flush/cross-check pipeline
// (closes the audit/safety-pipeline-unwired class without inventing config the operator never set).
const AUDIT_UNION_RELATIVE_PATH = 'sukarfleet-audit.jsonl';

interface LoopHandle {
  stop(): void;
}

interface MinimalServer {
  requestIP(req: Request): { address: string } | null;
  stop(force?: boolean): void;
}

// Exported for tests/node-exec.test.ts -- the exec loop below reuses this exact mechanism, so
// tests exercise the real scheduling primitive rather than a stand-in.
export function scheduleLoop(name: string, intervalMs: number, fn: () => Promise<void>): LoopHandle {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let stopped = false;

  const tick = async (): Promise<void> => {
    if (stopped) return;
    try {
      await fn();
    } catch (err) {
      log('error', `${name} loop iteration failed`, { error: String(err) });
    } finally {
      if (!stopped) {
        timer = setTimeout(tick, intervalMs);
        (timer as unknown as { unref?: () => void }).unref?.();
      }
    }
  };

  // First tick runs immediately: a loop whose first run waits a full interval
  // races the systemd watchdog when intervalMs >= WatchdogSec (the sync loop
  // at 120s/120s died exactly at its first-ever tick), and an immediate first
  // sync/gossip is what the operator expects at startup anyway.
  timer = setTimeout(tick, 0);
  (timer as unknown as { unref?: () => void }).unref?.();

  return {
    stop(): void {
      stopped = true;
      if (timer) clearTimeout(timer);
    },
  };
}

async function checkAdopted(repo: RepoConfig, machine: string): Promise<boolean> {
  const wantBranch = `sync/${machine}`;
  const res = await run(['git', '-C', repo.path, 'rev-parse', '--abbrev-ref', 'HEAD'], {
    timeoutMs: 15000,
  });
  if (res.code !== 0) {
    log('warn', 'repo not adopted -- run scripts/cutover.sh', {
      repo: repo.name,
      path: repo.path,
      reason: 'HEAD check failed',
      stderr: res.stderr.trim(),
    });
    return false;
  }
  const head = res.stdout.trim();
  if (head !== wantBranch) {
    log('warn', 'repo not adopted -- run scripts/cutover.sh', {
      repo: repo.name,
      path: repo.path,
      head,
      want: wantBranch,
    });
    return false;
  }
  return true;
}

// Pure watchdog-freshness predicate, exported so tests/node-exec.test.ts can pin exact boundary
// behavior without spinning up the daemon. gossipFresh/syncFresh/execFresh below all resolve to
// this same formula (age strictly less than the window).
export function isLoopFresh(nowMsVal: number, lastOkMs: number, windowMs: number): boolean {
  return nowMsVal - lastOkMs < windowMs;
}

// P3 single-pusher takeover streak threshold: a roamer needs this many CONSECUTIVE syncLoop ticks
// of anchorDaemonOnline === false before it takes over pushing derive's derived main. Exported so
// tests IMPORT it rather than re-hardcoding the number the gate actually checks.
export const TAKEOVER_STREAK = 2;

// P3 single-pusher policy (Class A fix). Previously this gate read transport.anchorReachable() --
// the EasyTier PEER TABLE, a different systemd unit than the anchor's node daemon. That mismatch
// had two failure modes, both landing on "the fleet loses its single pusher": (1) the anchor
// daemon dies while the mesh stays up -- the roamer still sees the anchor in the peer table, reads
// reachable, and nobody ever pushes for the whole outage; (2) a roamer whose anchorReachable()
// never has a trusted sighting to report (zero configured peers, or an easytier CLI poll that
// never succeeds) reads null forever, which the old gate treated as "don't take over" forever too.
//
// The fix keys the gate on the anchor DAEMON's own heartbeat instead: gossip.getPeerViews' `online`
// is true only when a signed envelope from that peer arrived within gossipSec x peerOfflineFactor
// -- direct evidence the daemon process itself is alive and broadcasting, not merely that the mesh
// transport can see a peer. transport.anchorReachable() is left untouched (health.ts still reads
// it for the separate anchor-unreachable alarm); this gate no longer consults it at all.
//
// anchorDaemonOnline is `null` only when this machine has no configured peers at all --
// anchorDaemonOnlineFromGossip below returns null exactly then, since gossip.getPeerViews always
// returns one PeerView per configured peer and `online` on each is a plain boolean, never null.
//
// KNOWN HONESTY LIMIT (accepted, bounded): a roamer that takes over on this signal may push its
// own last-fetched (possibly stale) refs if the mesh itself is also down -- the daemon heartbeat
// and the transport are different failure axes, and this gate only observes the former. A
// subsequent successful fetch/merge cycle corrects it.
//
// What an earlier version of this comment wrongly waved away as "no dual-pusher risk either way":
// the takeover signal is receive-side, so an ordinary network change on the ROAMER is enough to
// stop the anchor's gossip from arriving. The streak reaches TAKEOVER_STREAK and the roamer starts
// force-pushing a main built from its last-fetched refs while the anchor, perfectly alive, keeps
// force-pushing its own -- two divergent pushers on one refs/heads/main. Three things bound that
// now, none of them a change to this gate, which stays pure and unchanged:
//   1. derive.ts pushes the derived main under --force-with-lease against the last-fetched
//      refs/remotes/origin/main, so no single push discards a main this machine had not seen: it
//      is refused and logged. That is a guarantee about one push and nothing more -- every cycle
//      fetches origin, which refreshes the baseline, so the next lease is valid again.
//   2. The yield rule, which is the actual defence. Before a roamer takes over for a repo, node.ts
//      asks derive.originMainMovedByOther: if origin's main now holds a sha this machine did not
//      push, somebody else is demonstrably pushing, so the roamer stands down for that repo and
//      resets its streak -- whatever gossip says about the anchor's heartbeat.
//   3. derive.ts retries a refused push at most derive.MAX_PUSH_RETRIES times and then leaves
//      origin alone until inputs change, so a machine losing the argument stops arguing.
//
// What honestly remains: a roamer whose own inputs change can push ONCE before it observes the
// other pusher and yields. So during a mesh-only partition main can still alternate a bounded
// number of times -- one round per roamer input change, not one per tick -- and it stops the moment
// the roamer sees a main it did not push. It self-heals when the mesh returns and gossip resets the
// streak. The origin-fetch veto in pushAllowedForRepo is a narrow guard on top of this, not the
// main defence: see its comment for the exact (small) shape of what it catches.
export function shouldPushThisTick(
  role: 'anchor' | 'roamer',
  anchorDaemonOnline: boolean | null,
  streak: number,
): boolean {
  if (role === 'anchor') return true;
  // No peers configured at all: there is no anchor to defer to, so this solo machine is its own
  // pusher -- restores the pre-P3 behavior for that shape of config.
  if (anchorDaemonOnline === null) return true;
  return anchorDaemonOnline === false && streak >= TAKEOVER_STREAK;
}

// Per-repo veto layered on top of shouldPushThisTick, which stays pure and unchanged above. Only a
// ROAMER that is pushing BECAUSE it read the anchor daemon offline is a takeover, and there are two
// independent reasons to refuse one for a given repo.
//
// originFetchOk === false -- this cycle never reached origin. Worth being honest about how little
// this catches: the takeover fires whenever the ANCHOR's gossip stops arriving, and in most of
// those shapes (mesh/EasyTier down, LAN change, VPN, firewall on the mesh port) the roamer still
// reaches GitHub perfectly well, so this reads true and the takeover stands. It refuses only the
// roamer that is fully offline -- the one that could not have pushed anyway. It is kept because it
// costs nothing, and because a machine that cannot see origin is holding a stale lease baseline and
// has no business trying; it is a narrow guard, not the defence against two pushers.
//
// originMovedByOther === true -- origin's main moved under a push this machine did not make. That
// is direct evidence of another live pusher, and it is the veto that actually bounds the two-pusher
// window (see shouldPushThisTick's honesty note). node.ts samples derive.originMainMovedByOther
// after the cycle's fetch on every roamer tick, latches a sighting made while the anchor reads
// offline, and hands it in here on the tick that would otherwise push, resetting the takeover
// streak at the call site.
//
// Why the ORIGIN fetch and not the fleet-peer fetch: during a genuine anchor outage the
// fleet-<anchor> fetch fails by construction (the anchor's git server lives inside the daemon that
// died), so gating on fleet fetches would veto precisely the case takeover exists for.
//
// Untouched by design: the anchor (never a takeover), a roamer whose push decision was already
// false, and a solo roamer with no configured peers (anchorDaemonOnline null, so no anchor was
// deferred to and nothing was taken over). originFetchOk null means the repo has no origin remote
// at all -- nothing to fetch, nothing to push to, no reason to veto.
export function pushAllowedForRepo(
  role: 'anchor' | 'roamer',
  push: boolean,
  anchorDaemonOnline: boolean | null,
  originFetchOk: boolean | null,
  originMovedByOther: boolean,
): boolean {
  if (!push) return false;
  if (role !== 'roamer') return true;
  if (anchorDaemonOnline !== false) return true; // not a takeover
  if (originFetchOk === false) return false;
  return !originMovedByOther;
}

// Reads the anchor daemon's liveness the same way transport.ts's anchorReachable() identifies
// "the anchor": PeerConfig carries no role marker (see types.ts), and the standard hub-and-spoke
// topology gives a roamer exactly one peer anyway, so "all configured peers offline in gossip" is
// treated as anchor-down. Returns null (not false) when there are zero configured peers -- see
// shouldPushThisTick's null case above.
export function anchorDaemonOnlineFromGossip(views: readonly { online: boolean }[]): boolean | null {
  if (views.length === 0) return null;
  return views.some((v) => v.online);
}

// Roamer-only debounce layered on top of shouldPushThisTick: the roamer only starts pushing once
// the anchor-daemon-online signal (anchorDaemonOnlineFromGossip, NOT transport.anchorReachable())
// has read false for two CONSECUTIVE syncLoop ticks (one lost/racy gossip cycle must not flip who
// pushes), and yields the instant a tick sees anything else -- true or null resets the streak to
// zero, not just recovery. The anchor never calls this: its push decision never depends on the
// streak. Exported so tests/node-exec.test.ts can pin the debounce boundary.
export function nextAnchorDownStreak(prevStreak: number, anchorDaemonOnlineNow: boolean | null): number {
  return anchorDaemonOnlineNow === false ? prevStreak + 1 : 0;
}

// P4 watchdog grace-window arithmetic (Class B fix). Pulled out of watchdogLoop's body so the
// safety-critical part -- deciding whether THIS tick earns a fresh post-resume grace window -- is
// pure and directly testable, rather than only reachable by driving the live scheduled loop.
//
// Grants a fresh window (nowMs + windowMs) ONLY when driftMs is a genuine jump (> SUSPEND_JUMP_MS)
// AND the previous window has already expired (nowMs >= prevGraceUntilMs). That second condition
// is the hardening the panel asked for: without it, a suspend/resume cycle that lands WHILE an
// earlier grace window is still open would extend that window indefinitely -- back-to-back suspend
// cycles must not add up to continuous grace, since grace exists to cover one resume's catch-up
// time, not to become a standing exemption from the watchdog. A merely-stale tick (driftMs at or
// below the threshold) never renews anything, jump or not: the return value is prevGraceUntilMs,
// byte-identical, so callers can detect "did a grant just happen" with `!==`.
export function nextWatchdogGrace(prevGraceUntilMs: number, driftMs: number, nowMs: number, windowMs: number): number {
  if (nowMs < prevGraceUntilMs) return prevGraceUntilMs; // previous window still open: refuse a new grant
  if (driftMs > SUSPEND_JUMP_MS) return nowMs + windowMs; // fresh jump, no open window: grant
  return prevGraceUntilMs; // merely stale (including driftMs === SUSPEND_JUMP_MS exactly): unchanged
}

// P4 watchdog suspend-awareness. Fresh marks always ping. Stale marks still ping while nowMs is
// inside the one-shot post-resume grace window (graceUntilMs) -- granted once by watchdogLoop when
// its own tick-to-tick clockDriftMs exceeds SUSPEND_JUMP_MS, and never renewed by a later stale
// tick, so a real wedge that happens to span a suspend still withholds once the grace expires.
// graceUntilMs of 0 (the pre-jump default) never satisfies nowMs < graceUntilMs, so a daemon that
// never suspends behaves exactly as before P4. Exported so tests/node-exec.test.ts can pin every
// boundary without a live loop.
export function watchdogShouldPing(gossipFresh: boolean, syncFresh: boolean, nowMsVal: number, graceUntilMs: number): boolean {
  if (gossipFresh && syncFresh) return true;
  return nowMsVal < graceUntilMs;
}

function isLoopback(server: MinimalServer, req: Request): boolean {
  const ip = server.requestIP(req);
  if (!ip) return false; // unix socket / unknown: fail closed
  return LOOPBACK_ADDRS.has(ip.address);
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

// Class G: pulled out of buildUiState's admin object literal so the additive uiAssets field (and
// the rest of the admin lane view) is directly testable without spinning up the daemon --
// buildUiState itself is a closure inside main() and cannot be exercised any other way. Pure
// projection: every input is already resolved by the caller (adminLaneConfigured(), secrets.status,
// sshAdmin.trust()), so this does no I/O of its own.
export interface BuildAdminLaneViewArgs {
  cfg: FleetConfig;
  configured: boolean;
  credential: {
    present: boolean;
    stale: boolean;
    sealed: 'tpm2' | 'user' | 'plaintext' | null;
    setAtMs: number | null;
  };
  sshKeyFingerprint: string | null;
}

export function buildAdminLaneView(args: BuildAdminLaneViewArgs): UiAdminLaneView {
  const { cfg, configured, credential, sshKeyFingerprint } = args;
  return {
    enabled: cfg.admin.enabled,
    acceptIncoming: cfg.admin.acceptIncoming,
    uiEnabled: cfg.admin.uiEnabled,
    configured,
    credentialPresent: credential.present,
    credentialStale: credential.stale,
    credentialSealed: credential.sealed,
    credentialSetAtMs: credential.setAtMs,
    sshUser: cfg.admin.sshUser,
    sshKeyFingerprint,
    runTimeoutSec: cfg.admin.runTimeoutSec,
    maxRunTimeoutSec: cfg.admin.maxRunTimeoutSec,
    ratePerMin: cfg.admin.ratePerMin,
    // config.ts's mergeDefaults always fills this (default true), so the ?? is defensive only --
    // a raw FleetConfig built by hand (e.g. in a test) without it still gets the pre-P6 meaning.
    uiAssets: cfg.admin.uiAssets ?? true,
  };
}

// --- Shape guards for the loopback-only CLI-facing exec routes (see fetchHandler below) --------
// These mirror execroutes.ts's isSignedJobShape style: cheap, non-throwing structural checks on
// caller-supplied JSON before it ever reaches jobqueue.ts/membership.ts.

async function main(): Promise<void> {
  const cfg: FleetConfig = await loadConfig();
  // Write the legacy-exec migration into config.json so the migrated values are VISIBLE in the
  // file rather than re-derived on every boot. Best effort by construction: mergeDefaults already
  // applied the same answer in memory, which is what this process runs on, so a failed write costs
  // a repeated log line and nothing else.
  await persistLegacyMigration();
  const key = await loadOrCreateMachineKey(cfg.machine);
  const enrolledPeers = new Set(cfg.peers.filter((p) => p.publicKeyJwk !== null).map((p) => p.name));
  for (const p of cfg.peers) {
    if (!enrolledPeers.has(p.name)) {
      log('warn', 'peer configured without a public key -- pending enrollment, excluded from health alarms', {
        peer: p.name,
      });
    }
  }

  log('info', 'sukarfleet node starting', {
    machine: cfg.machine,
    role: cfg.role,
    port: cfg.nodePort,
    repos: cfg.repos.map((r) => r.name),
  });

  // Startup adopt check: never sync a repo whose HEAD is not sync/<machine>.
  const adopted = new Set<string>();
  for (const repo of cfg.repos) {
    if (await checkAdopted(repo, cfg.machine)) adopted.add(repo.name);
  }

  const transport = new Transport(cfg);

  // Mutable runtime state consulted by /status and the loops below.
  const selfRepoStats = new Map<string, PresenceRepoStat>();
  const githubPushOkMs = new Map<string, number | null>();
  for (const repo of cfg.repos) {
    selfRepoStats.set(repo.name, {
      lastSyncOkMs: null,
      lastCommit: null,
      syncError: adopted.has(repo.name) ? null : 'not adopted -- run scripts/cutover.sh',
    });
    githubPushOkMs.set(repo.name, null);
  }

  // Initialized to boot time, not 0: "hasn't been due yet" must read as fresh,
  // or the watchdog starves before a slow first cycle can complete.
  let gossipLoopOkMs = nowMs();
  let syncLoopOkMs = nowMs();
  let lastTransportSummary: unknown = null;
  let lastTransportRestartOk: boolean | null = null;
  // P3 single-pusher takeover debounce (nextAnchorDownStreak); consulted for the roamer role only,
  // stays 0 and unused on the anchor.
  let anchorDownStreak = 0;
  // Per-repo latch for the yield rule: a foreign push sighted on a tick that was not going to push
  // must not be forgotten by the time the streak makes this roamer a pusher, or a mesh-only
  // partition in which the anchor pushes on the "wrong" tick slips past the rule. Latched only
  // while the anchor reads offline in gossip and cleared the moment it reads online, so a push the
  // anchor made during a healthy period can never surface later as a false yield.
  const foreignPushSeen = new Map<string, boolean>();
  // P4 watchdog suspend-awareness. watchdogLoop keeps its OWN mono/wall baseline -- deliberately
  // separate from clockSentinel's, which only resets on a detected jump -- so it always measures
  // drift since the immediately preceding tick, not since the last resume. graceUntilMs is 0 until
  // a jump is first detected, so a daemon that never suspends never enters the grace branch below.
  let watchdogPrevMonoNs = Bun.nanoseconds();
  let watchdogPrevWallMs = nowMs();
  let watchdogGraceUntilMs = 0;

  // Builds (and, if changed, publishes) this machine's signed endpoint file. Used both
  // at startup and as ClockSentinel's post-resume republish step.
  async function republishEndpoint(): Promise<void> {
    try {
      const [wanIp, lanIpAddr] = await Promise.all([endpoints.probeWanIp(), endpoints.lanIp()]);
      if (lanIpAddr === null) {
        log('warn', 'endpoint publish skipped: no LAN IPv4 address detected');
        return;
      }
      await endpoints.publishEndpointFile(cfg, key, { wanIp, lanIp: lanIpAddr });
    } catch (err) {
      log('error', 'endpoint publish failed', { error: String(err) });
    }
  }

  const clockSentinel = new ClockSentinel(cfg, {
    pollTransport: async (nowMsVal: number) => {
      const poll = await transport.pollOnce(nowMsVal);
      lastTransportSummary = poll;
      return poll;
    },
    isWedged: (nowMsVal: number) => transport.wedged(nowMsVal),
    restartTransport: async () => {
      const ok = await transport.restartTransport();
      lastTransportRestartOk = ok;
      log(ok ? 'warn' : 'error', 'transport wedged -- restart attempted', { restarted: ok });
      return ok;
    },
    onEndpointRepublish: republishEndpoint,
  });

  function buildPresencePayload(): PresencePayload {
    const flags: string[] = [];
    if (!clockSentinel.isClockVetted()) flags.push('clock-unvetted');
    if (lastTransportRestartOk === false) flags.push('transport-restart-failed');
    const repos: Record<string, PresenceRepoStat> = {};
    for (const [name, stat] of selfRepoStats) repos[name] = stat;
    const pushMs: Record<string, number | null> = {};
    for (const [name, ms] of githubPushOkMs) pushMs[name] = ms;
    return { repos, githubPushOkMs: pushMs, clockMs: nowMs(), flags };
  }

  const gossip = new Gossip(cfg, key, buildPresencePayload);
  await gossip.restore();

  const syncer = new Syncer(cfg, {
    machineKey: key,
    isClockVetted: () => clockSentinel.isClockVetted(),
    // Watchdog progress mark per completed git/postMerge step: every step is
    // individually time-bounded (util.runBytes SIGKILL-escalates and never awaits
    // pipe EOF unboundedly), so a completing step is honest liveness. Per-repo
    // marking alone starves the watchdog when one repo's cycle legitimately runs
    // long (push retries + backoff against a dead network ~5min > freshness window).
    onStep: () => {
      syncLoopOkMs = nowMs();
    },
    onRepoStat: (repoName, stat) => selfRepoStats.set(repoName, stat),
    onGithubPush: (repoName, okMs) => githubPushOkMs.set(repoName, okMs),
    onConflictArtifact: (repoName, path) => {
      log('warn', 'sync: losing side of a conflict preserved as an artifact', { repo: repoName, path });
    },
  });

  const health = new Health(cfg);

  // Point the fleet-<peer> remotes at each peer's git-over-HTTP endpoint so fetchAll has
  // something to fetch from; without this, cross-machine convergence never happens.
  for (const repo of cfg.repos) {
    if (!adopted.has(repo.name)) continue;
    try {
      await syncer.ensureFleetRemotes(repo);
    } catch (err) {
      log('error', 'ensureFleetRemotes failed', { repo: repo.name, error: String(err) });
    }
  }

  // Publish our endpoint file and attempt an initial clock vet before serving traffic.
  // Steady-state re-vetting (the transport loop, below) is the only other place this is
  // ever retried -- without this call the clock could otherwise stay unvetted forever.
  await republishEndpoint();
  await clockSentinel.vet();

  // The audit log. The admin lane records every call, refusal and pairing into it, and every entry
  // this machine appends carries `prev`, so its run is hash-chained from its genesis forward: an
  // entry edited or replaced after that genesis is detectable, trailing truncation of the newest
  // entries is not (see audit.ts's crossCheckAuditLog). Construction touches no disk and opens no
  // port -- AuditLog reads its sequence lazily on the first append -- so a node that appends
  // nothing is byte-identical to one that never built it.
  const auditLog = new AuditLog(cfg.machine, key);
  const auditAppend = (kind: string, detail: Record<string, unknown>): Promise<AuditEntry> =>
    auditLog.append(kind, detail);
  // Most-recent-first, per McpDeps.tailAudit's and UiRoutesDeps.tailAudit's shared contract.
  const tailAudit = async (limit: number): Promise<AuditEntry[]> => {
    const all = await auditLog.readAll();
    return all.slice(-limit).reverse();
  };

  // The MCP server handle. Declared here so shutdown() and fetchHandler below can reference it
  // unconditionally; it is started further down regardless of any other lane.
  let mcpHandle: McpServerHandle | null = null;

  // --- SSH admin lane -----------------------------------------------------
  // Everything below is constructed unconditionally; see the import block's note. The only
  // structural coupling to the rest of main() is that
  // applyPeer mutates cfg.peers in place and re-runs syncer.ensureFleetRemotes -- every other
  // consumer reads cfg.peers at call time, so a pair takes effect without a restart.
  const bootMs = nowMs();

  // The file is the authority (see HOSTKEY_ALERTS_FILE); this Map is a mirror, loaded once here, so
  // the 30s health tick stays synchronous and never reads disk on the alarm path.
  const hostkeyAlertsPath = join(stateDir(), HOSTKEY_ALERTS_FILE);
  const hostkeyAlerts = new Map<string, number>();
  for (const [machine, atMs] of Object.entries((await readJsonFile<Record<string, unknown>>(hostkeyAlertsPath)) ?? {})) {
    if (typeof atMs === 'number' && Number.isFinite(atMs)) hostkeyAlerts.set(machine, atMs);
  }

  async function persistHostkeyAlerts(): Promise<void> {
    await atomicWrite(hostkeyAlertsPath, `${JSON.stringify(Object.fromEntries(hostkeyAlerts))}\n`);
  }

  // Cleared on exactly the two events docs/RUNBOOK-P3.md names as recovery: a later run to that
  // machine that completed (the pin matched again), or a successful re-pin through pairing.
  async function clearHostkeyAlert(machine: string): Promise<void> {
    if (!hostkeyAlerts.delete(machine)) return;
    await persistHostkeyAlerts();
    log('info', 'admin: host-key mismatch alert cleared', { machine });
  }

  // Every admin-run outcome already passes through an audit append, so the origin leg's
  // hostkey-mismatch refusal is observable here with no second channel into sshadmin.ts. Only
  // origin-leg entries carry targetMachine -- the target leg records originMachine instead, and is
  // deliberately ignored, since only the dialling side can observe a pin mismatch at all. The
  // append is what must not be lost: a failure to persist the alert degrades to a log, mirroring
  // sshadmin.ts's own audit() contract that a bookkeeping failure never costs the run its result.
  const adminAuditAppend = async (kind: string, detail: Record<string, unknown>): Promise<AuditEntry> => {
    const entry = await auditAppend(kind, detail);
    const machine = typeof detail.targetMachine === 'string' ? detail.targetMachine : '';
    if (machine) {
      try {
        if (kind === AUDIT_KIND_ADMIN_RUN_REFUSED && detail.refusal === 'hostkey-mismatch') {
          if (!hostkeyAlerts.has(machine)) {
            hostkeyAlerts.set(machine, nowMs());
            await persistHostkeyAlerts();
          }
        } else if (kind === AUDIT_KIND_ADMIN_RUN_COMPLETED) {
          await clearHostkeyAlert(machine);
        }
      } catch (err) {
        log('error', 'admin: host-key alert state write failed', { machine, error: String(err) });
      }
    }
    return entry;
  };

  const sshAdmin = new SshAdmin({
    cfg,
    auditAppend: adminAuditAppend,
    peerView: (name) => gossip.getPeerViews(nowMs()).find((p) => p.name === name) ?? null,
    now: nowMs,
  });

  // Best-effort: quickstart.sh normally created this key already. A machine without one still
  // serves its GUI and its status -- it simply cannot pair or originate a call, which is exactly
  // what the preflight below and the admin-lane-unconfigured fault report.
  try {
    const identity = await sshAdmin.ensureSshIdentity();
    if (identity.created) log('info', 'admin: generated the fleet ssh identity', { keyPath: cfg.admin.keyPath });
  } catch (err) {
    log('warn', 'admin: no usable fleet ssh identity -- pairing and admin runs stay refused', {
      keyPath: cfg.admin.keyPath,
      error: String(err),
    });
  }

  // "Configured" is the pair of files an admin call cannot proceed without: this machine's fleet
  // ssh key, and a known_hosts carrying at least one pinned peer.
  async function adminLaneConfigured(): Promise<boolean> {
    const [hasKey, hasKnownHosts] = await Promise.all([
      Bun.file(expandHome(cfg.admin.keyPath)).exists().catch(() => false),
      Bun.file(expandHome(cfg.admin.knownHostsPath)).exists().catch(() => false),
    ]);
    return hasKey && hasKnownHosts;
  }

  // The ONLY place peer configuration is mutated at runtime, and it is all-or-nothing. Order is
  // load-bearing, and the ordering invariant is a trust one, not a convenience one:
  //   1. config.json, through patchConfig -- it validates BEFORE it writes, so a bundle that would
  //      produce an unloadable config leaves the file byte-identical and this throws instead;
  //   2. the in-memory cfg.peers array, which gossip.ts/gitserve.ts/execroutes.ts/syncer.ts all
  //      read at call time, so the pair is live with no restart;
  //   3. known_hosts (pinHostKeys) -- it reads cfg.peers for the peer's port and sshHost override,
  //      so it must run after step 2;
  //   4. authorized_keys (writeAuthorizedKey) LAST. It is the grant that lets the peer open a
  //      root-capable channel into this machine, and every check that grant relies on -- including
  //      the pin from step 3 -- must already be on disk when it lands. The most-trusting,
  //      least-reversible step goes last, never before what it depends on.
  //   5. the git remotes, per syncer.ensureFleetRemotes's own "re-run me when peers change"
  //      contract. Best-effort and outside the rollback: a stale remote costs a sync cycle, not
  //      trust.
  // Steps 1-4 are wrapped: any throw restores the pre-call state and rethrows, so pairing.ts's 500
  // ("nothing was paired") is true rather than a description of a half-trusted machine.
  async function applyPeer(bundle: PairBundle): Promise<void> {
    const priorPeer = cfg.peers.find((p) => p.name === bundle.machine) ?? null;
    const priorEnrolled = enrolledPeers.has(bundle.machine);

    const merged = await patchConfig((raw) => {
      const peers = Array.isArray(raw.peers) ? [...(raw.peers as unknown[])] : [];
      const fields: Record<string, unknown> = {
        name: bundle.machine,
        meshIp: bundle.meshIp,
        nodePort: bundle.nodePort,
        publicKeyJwk: bundle.publicKeyJwk,
      };
      // The peer's own account name, validated against SSH_USER_RE by pairing.ts before it reaches
      // here. Stored per peer because the origin leg dials `-l <peer.sshUser ?? admin.sshUser>`:
      // without it a peer whose account name differs from ours pairs successfully and then fails
      // every single run with Permission denied (publickey), with no config field to correct it.
      // Absent means "the same account name this machine uses".
      if (typeof bundle.sshUser === 'string' && bundle.sshUser.length > 0) fields.sshUser = bundle.sshUser;
      // Persisted so the acceptIncoming switch can remove and rebuild this peer's grant without
      // destroying the pairing -- before this, the authorized_keys line was the only copy. Public
      // key material only, already validated as a single bare key line by pairing.ts.
      if (typeof bundle.sshPublicKey === 'string' && bundle.sshPublicKey.length > 0) {
        fields.sshPublicKey = bundle.sshPublicKey;
      }
      const at = peers.findIndex(
        (p) => typeof p === 'object' && p !== null && (p as Record<string, unknown>).name === bundle.machine,
      );
      if (at >= 0) {
        // Re-pairing carries the mesh identity, not the operator's local overrides: sshHost,
        // sshPort, sshFallbackHost and a hand-set sshUser on an existing entry survive untouched.
        const existing = peers[at] as Record<string, unknown>;
        const entry = { ...existing, ...fields };
        if (typeof existing.sshUser === 'string' && existing.sshUser.length > 0) entry.sshUser = existing.sshUser;
        peers[at] = entry;
      } else {
        peers.push(fields);
      }
      raw.peers = peers;
    });

    cfg.peers.length = 0;
    cfg.peers.push(...merged.peers);
    // Without this the freshly paired peer stays out of the health loop's alarm set until the next
    // restart, so a machine that went offline an hour after pairing would never raise peer-offline.
    for (const p of merged.peers) {
      if (p.publicKeyJwk !== null) enrolledPeers.add(p.name);
    }

    try {
      await sshAdmin.pinHostKeys(bundle);
      await sshAdmin.writeAuthorizedKey(bundle);
    } catch (err) {
      await rollbackPeer(bundle.machine, priorPeer, priorEnrolled);
      throw err;
    }

    // A fresh pin IS the runbook's recovery path for a mismatch, so pairing closes the alarm the
    // same way a subsequent clean run does.
    await clearHostkeyAlert(bundle.machine).catch((err: unknown) => {
      log('error', 'admin: could not clear the host-key alert after pairing', {
        machine: bundle.machine,
        error: String(err),
      });
    });

    for (const repo of cfg.repos) {
      if (!adopted.has(repo.name)) continue;
      try {
        await syncer.ensureFleetRemotes(repo);
      } catch (err) {
        log('error', 'admin: ensureFleetRemotes after pairing failed', { repo: repo.name, error: String(err) });
      }
    }
  }

  // Undo for a failed applyPeer. The SSH files are cleared with revokePeer rather than restored to
  // their previous lines: for a half-applied pairing the only safe direction is less trust, and a
  // peer whose apply threw has to be paired again regardless. config.json and the in-memory arrays
  // ARE restored exactly, so an operator's sshHost/sshPort/sshFallbackHost overrides on a peer that
  // was already there survive a failed re-pair. Both halves are independently guarded: a rollback
  // that itself fails must still report the original failure, which is what pairing.ts surfaces.
  async function rollbackPeer(machine: string, prior: PeerConfig | null, priorEnrolled: boolean): Promise<void> {
    try {
      await sshAdmin.revokePeer(machine);
    } catch (err) {
      log('error', 'admin: rolling back a failed pairing could not clear the ssh trust files', {
        machine,
        error: String(err),
      });
    }
    try {
      const merged = await patchConfig((raw) => {
        const peers = Array.isArray(raw.peers) ? [...(raw.peers as unknown[])] : [];
        const at = peers.findIndex(
          (p) => typeof p === 'object' && p !== null && (p as Record<string, unknown>).name === machine,
        );
        if (at >= 0) {
          if (prior) peers[at] = { ...prior };
          else peers.splice(at, 1);
        } else if (prior) {
          peers.push({ ...prior });
        }
        raw.peers = peers;
      });
      cfg.peers.length = 0;
      cfg.peers.push(...merged.peers);
    } catch (err) {
      log('error', 'admin: rolling back a failed pairing could not restore config.json', {
        machine,
        error: String(err),
      });
    }
    if (!priorEnrolled) enrolledPeers.delete(machine);
  }

  const pairing = new Pairing({
    cfg,
    auditAppend,
    localBundle: () => sshAdmin.localBundle(),
    applyPeer,
    now: nowMs,
  });

  // secrets.ts owns the credential; this adapter owns its audit trail. The detail is `{ user }`
  // and nothing else -- audit.ts's content contract forbids the password, its hash and its length.
  // `pw` is forwarded to secrets.setSudoPassword and is not read, logged, or interpolated anywhere
  // in this scope; the outcome's `message` is dropped by uiserve.ts before any response is built.
  const secretsPort: UiRoutesDeps['secrets'] = {
    status: () => secrets.status(cfg),
    set: async (pw) => {
      const outcome = await secrets.setSudoPassword(cfg, pw);
      if (outcome.ok) {
        const { user } = await secrets.status(cfg);
        // The credential is already on disk; a failed audit append must not turn a successful
        // store into a 500 the operator would retype their password over. Logged and degraded.
        await auditAppend(AUDIT_KIND_CREDENTIAL_SET, { user }).catch((err: unknown) => {
          log('error', 'admin: credential-set audit append failed', { error: String(err) });
        });
      }
      return outcome;
    },
    remove: async () => {
      const { user } = await secrets.status(cfg);
      await secrets.removeSudoPassword(cfg);
      await auditAppend(AUDIT_KIND_CREDENTIAL_REMOVED, { user }).catch((err: unknown) => {
        log('error', 'admin: credential-removed audit append failed', { error: String(err) });
      });
    },
    sealAvailable: () => secrets.sealAvailable(),
  };

  // The mesh secret staged by the GUI's setup card for install-elevated.sh --adopt-pending-secret,
  // which reads this file and shreds it. Written 0600 and never passed as an argument to anything,
  // so the secret reaches no command line, no shell history and no ps output.
  const pendingSecretPath = join(stateDir(), 'pending-easytier-secret');

  // The GUI polls /api/ui/state every 3s and this is the only field behind a subprocess, so the
  // service probe is memoized. Short enough that the setup card still reflects the one root step
  // within a poll or two of it finishing.
  const MESH_STATE_TTL_MS = 10_000;
  let meshServiceActive: { atMs: number; active: boolean } | null = null;

  // 'installed' is read from the mesh service, not from /etc/easytier/fleet.toml: that directory
  // is 0700 root-owned, so an unprivileged stat there always answers "absent". A staged file
  // outranks a running service -- it means a secret is queued that the installer has not adopted.
  async function meshSecretState(): Promise<MeshSecretState> {
    if (await Bun.file(pendingSecretPath).exists().catch(() => false)) return 'pending';
    const now = nowMs();
    if (!meshServiceActive || now - meshServiceActive.atMs >= MESH_STATE_TTL_MS) {
      const res = await run(['systemctl', 'is-active', 'easytier-fleet.service'], { timeoutMs: 5000 });
      meshServiceActive = { atMs: now, active: res.code === 0 };
    }
    return meshServiceActive.active ? 'installed' : 'none';
  }

  const networkSecretPort: UiRoutesDeps['networkSecret'] = {
    reveal: async () => {
      const file = Bun.file(pendingSecretPath);
      if (!(await file.exists().catch(() => false))) return null;
      const text = (await file.text()).trim();
      return text.length > 0 ? text : null;
    },
    stage: async (s) => {
      await writeSecretFile(pendingSecretPath, `${s.trim()}\n`);
      log('info', 'admin: mesh secret staged for the installer', { path: pendingSecretPath });
    },
    generate: async () => {
      const secret = randomBytes(32).toString('base64');
      await writeSecretFile(pendingSecretPath, `${secret}\n`);
      log('info', 'admin: mesh secret generated and staged', { path: pendingSecretPath });
      return secret;
    },
    state: meshSecretState,
  };

  // Identity fields are consumed once at boot -- the servers bind cfg.nodePort, gossip signs as
  // cfg.machine -- so a change is written to disk and takes effect on the next start; the GUI's
  // Restart button is the second half of this flow. cfg is deliberately NOT mutated here: a live
  // cfg.machine that disagrees with the key this process is already signing with is worse than a
  // stale one.
  async function patchIdentity(id: IdentityPatch): Promise<{ ok: boolean; message?: string }> {
    try {
      await patchConfig((raw) => {
        if (id.machine !== undefined) raw.machine = id.machine;
        if (id.role !== undefined) raw.role = id.role;
        if (id.meshIp !== undefined) raw.meshIp = id.meshIp;
        if (id.nodePort !== undefined) raw.nodePort = id.nodePort;
        if (id.networkName !== undefined) raw.networkName = id.networkName;
      });
      log('info', 'admin: identity patched -- restart to apply', { fields: Object.keys(id) });
      return { ok: true };
    } catch (err) {
      // config.ts's validation messages name the offending field and carry no secret material.
      return { ok: false, message: String(err) };
    }
  }

  // The operator's two lane switches. Both directions of the lane are patched here because both are
  // read per call and neither needs a restart: sshadmin.ts's origin leg gates on cfg.admin.enabled,
  // its target leg on cfg.admin.acceptIncoming. `enabled` in particular had no operator surface at
  // all, which left the whole lane inert on a machine whose config predates it -- there is no
  // enable path anywhere else, and auto-flipping a privileged lane on upgrade is not one.
  async function setLane(patch: { enabled?: boolean; acceptIncoming?: boolean }): Promise<void> {
    await patchConfig((raw) => {
      const admin =
        typeof raw.admin === 'object' && raw.admin !== null && !Array.isArray(raw.admin)
          ? (raw.admin as Record<string, unknown>)
          : {};
      if (patch.enabled !== undefined) admin.enabled = patch.enabled;
      if (patch.acceptIncoming !== undefined) admin.acceptIncoming = patch.acceptIncoming;
      raw.admin = admin;
    });
    // Only after the file is written: a live cfg that disagrees with disk is the state a crash
    // between the two would leave behind, and the disk copy is what the next boot fails closed on.
    if (patch.enabled !== undefined) cfg.admin.enabled = patch.enabled;
    if (patch.acceptIncoming !== undefined) cfg.admin.acceptIncoming = patch.acceptIncoming;

    // acceptIncoming is the inbound door, so flipping it moves the authorized_keys grant itself
    // rather than only changing what the forced command decides. Off must mean sshd turns the peer
    // away, not that the peer authenticates and is refused one layer later.
    if (patch.acceptIncoming !== undefined) await applyInboundDoor('lane switch');
  }

  // Single place that reconciles the grant files with cfg.admin.acceptIncoming. Called on the
  // switch and once at startup, so a hand-edited config or a config restored from backup converges
  // to the same state as the GUI would produce. Never throws into a caller: a grant file that
  // cannot be written is logged and alarmed, and the daemon keeps running.
  async function applyInboundDoor(why: string): Promise<void> {
    try {
      if (cfg.admin.acceptIncoming) {
        const { restored, missingKey } = await sshAdmin.openInboundDoor();
        if (restored.length) log('info', 'admin: inbound grants installed', { why, peers: restored });
        if (missingKey.length) {
          log('warn', 'admin: peer has no stored ssh key -- re-pair to reopen the lane for it', {
            why,
            peers: missingKey,
          });
        }
      } else {
        const { removed } = await sshAdmin.closeInboundDoor();
        if (removed.length) {
          log('info', 'admin: inbound grants removed, peers can no longer authenticate here', {
            why,
            peers: removed,
          });
        }
      }
    } catch (err) {
      log('error', 'admin: could not reconcile the inbound grant files', { why, error: String(err) });
    }
  }

  // systemd tears this process down mid-call, so this await never resolves normally -- the SIGTERM
  // handler below runs instead. uiserve.ts has already written its 200 before scheduling this.
  async function restartDaemon(): Promise<void> {
    await run(['systemctl', '--user', 'restart', 'sukarfleet.service'], { timeoutMs: 10000 });
  }

  async function buildUiState(): Promise<UiState> {
    const now = nowMs();
    const views = new Map(gossip.getPeerViews(now).map((p) => [p.name, p]));
    const presence = buildPresencePayload();
    const healthState = await health.getState();
    const credential = await secrets.status(cfg);
    const trust = await sshAdmin.trust().catch(() => null);
    const meshSecret = await meshSecretState();

    const identityReady = cfg.machine.length > 0 && cfg.meshIp.length > 0;
    const credentialReady = credential.present && !credential.stale;
    const paired = cfg.peers.some((p) => p.publicKeyJwk !== null);

    return {
      v: 1,
      nowMs: now,
      self: {
        machine: cfg.machine,
        role: cfg.role,
        meshIp: cfg.meshIp,
        nodePort: cfg.nodePort,
        uptimeSec: Math.floor((now - bootMs) / 1000),
      },
      peers: cfg.peers.map((p) => {
        const view = views.get(p.name) ?? null;
        return {
          name: p.name,
          meshIp: p.meshIp,
          nodePort: p.nodePort,
          online: view?.online ?? false,
          lastSeenMs: view?.lastSeenMs ?? null,
          // A peer we have never heard from is stale, not fresh -- same default the health loop uses.
          syncStale: view?.syncStale ?? true,
          paired: p.publicKeyJwk !== null,
          sshHost: p.sshHost ?? null,
          sshFallbackHost: p.sshFallbackHost ?? null,
        };
      }),
      repos: cfg.repos.map((r) => {
        const stat = presence.repos[r.name];
        return {
          name: r.name,
          path: r.path,
          lastSyncOkMs: stat?.lastSyncOkMs ?? null,
          lastCommit: stat?.lastCommit ?? null,
          syncError: stat?.syncError ?? null,
        };
      }),
      faults: healthState.faults.map((f) => ({
        key: f.key,
        faultClass: f.faultClass,
        message: f.message,
        urgency: f.urgency,
        firstSeenMs: f.firstSeenMs,
      })),
      admin: buildAdminLaneView({
        cfg,
        configured: await adminLaneConfigured(),
        credential,
        sshKeyFingerprint: trust?.sshKeyFingerprint || null,
      }),
      setup: {
        complete: identityReady && meshSecret === 'installed' && credentialReady && paired,
        identity: identityReady,
        meshSecret,
        credential: credentialReady,
        paired,
      },
      pairing: pairing.codeState(),
    };
  }

  const uiRoutes = new UiRoutes({
    cfg,
    // Adapts node.ts's isLoopback (which takes the fuller server shape this file uses) to
    // types.ts's MinimalServer. The predicate itself is untouched -- it is the one gate every
    // operator-facing route in this daemon already shares.
    isLoopback: (srv, req) => isLoopback(srv as MinimalServer, req),
    buildState: buildUiState,
    secrets: secretsPort,
    sshAdmin,
    pairing,
    tailAudit,
    patchIdentity,
    networkSecret: networkSecretPort,
    setLane,
    restartDaemon,
  });

  // A host-key mismatch is only observable by attempting a connection, so it is recorded when the
  // dial refuses and read back here from the durable alert file -- never from the run registry,
  // whose lifetime (20 entries, cleared on stop) is shorter than the fault's, which the runbook
  // says never auto-heals. Filtered to configured peers so an entry for a peer the operator has
  // since removed cannot hold a critical fault open forever.
  function hostkeyMismatchPeers(): string[] {
    return [...hostkeyAlerts.keys()].filter((machine) => cfg.peers.some((p) => p.name === machine));
  }

  // Startup preflight. The fault itself is raised by the health loop (through HealthSelf.admin);
  // this is the one log line that says so at boot, when the operator is actually looking.
  if (cfg.admin.enabled && !(await adminLaneConfigured())) {
    log('warn', 'admin: lane enabled but not configured -- pair a peer from the GUI before using it', {
      keyPath: cfg.admin.keyPath,
      knownHostsPath: cfg.admin.knownHostsPath,
    });
  }

  // Backfill peers[].sshPublicKey for pairings made before it was persisted. This MUST run before
  // the reconcile below: for those peers the live authorized_keys line is the only copy of the
  // key, so closing the door first would lose it and force a re-pair to ever reopen.
  try {
    const recovered = await sshAdmin.recoverStoredPeerKeys();
    const needed = cfg.peers.filter((p) => recovered.has(p.name) && !p.sshPublicKey);
    if (needed.length > 0) {
      await patchConfig((raw) => {
        const peers = Array.isArray(raw.peers) ? (raw.peers as Record<string, unknown>[]) : [];
        for (const p of peers) {
          const key = typeof p.name === 'string' ? recovered.get(p.name) : undefined;
          if (key && !p.sshPublicKey) p.sshPublicKey = key;
        }
      });
      for (const p of cfg.peers) {
        const key = recovered.get(p.name);
        if (key && !p.sshPublicKey) p.sshPublicKey = key;
      }
      log('info', 'admin: recovered peer ssh keys from the live grants', {
        peers: needed.map((p) => p.name),
      });
    }
  } catch (err) {
    log('warn', 'admin: could not backfill peer ssh keys', { error: String(err) });
  }

  // Converge the grant files onto the switch. A config edited by hand, restored from a backup, or
  // left behind by a crash mid-toggle ends up in the same state the GUI would have produced.
  await applyInboundDoor('startup');

  // Loopback-only MCP surface: the wedge, and the way an agent reaches this fleet. Started
  // unconditionally -- an agent has to be able to READ fleet state (peers, audit tail, admin
  // status) even on a machine where the admin lane is off or refuses agent-origin runs. Deps
  // mirror mcp.ts's McpDeps contract exactly.
  mcpHandle = startMcpServer(
    {
      cfg,
      listPeers: () => gossip.getPeerViews(nowMs()),
      tailAudit,
      adminRun: (req) => sshAdmin.runAdmin(req),
      adminStatus: () => sshAdmin.status(),
    },
    { port: cfg.mcpPort },
  );

  // --- HTTP server -----------------------------------------------------
  async function fetchHandler(req: Request, srv: MinimalServer): Promise<Response> {
    const url = new URL(req.url);

    if (req.method === 'POST' && url.pathname === '/gossip') {
      let envelope: GossipEnvelope;
      try {
        // Capped like every other body-accepting route. This one faces the mesh and its signature
        // is checked only after the body is in hand, so an unpaired member that can reach the port
        // could otherwise make us allocate first and reject afterwards.
        envelope = (await readCappedJson(req)) as GossipEnvelope;
      } catch {
        return new Response('bad json', { status: 400 });
      }
      try {
        const accepted = await gossip.receive(envelope, cfg.peers);
        if (!accepted) return new Response(null, { status: 401 });
        clockSentinel.offerPeerClock(envelope.machine, envelope.payload.clockMs, nowMs());
        return new Response(null, { status: 204 });
      } catch (err) {
        log('error', 'gossip receive failed', { error: String(err) });
        return new Response(null, { status: 401 });
      }
    }

    if (req.method === 'GET' && url.pathname === '/status') {
      if (!isLoopback(srv, req)) return new Response('forbidden', { status: 403 });
      const presence = buildPresencePayload();
      const healthState = await health.getState();
      return jsonResponse({
        nowMs: nowMs(),
        self: {
          machine: cfg.machine,
          role: cfg.role,
          clockVetted: clockSentinel.isClockVetted(),
          transport: lastTransportSummary,
          repos: presence.repos,
          githubPushOkMs: presence.githubPushOkMs,
          flags: presence.flags,
        },
        peers: gossip.getPeerViews(nowMs()),
        alarms: healthState.faults.map((f) => ({
          message: f.message,
          faultClass: f.faultClass,
          since: f.firstSeenMs,
        })),
        health: healthState,
      });
    }

    if (req.method === 'GET' && url.pathname === '/health') {
      return jsonResponse({ ok: true });
    }

    // The SSH admin lane's GUI, its JSON API, and the mesh-reachable POST /pair/hello
    // (p3-ssh-admin). One line by design: UiRoutes owns /ui, /api/ui/ and /pair/ wholesale and
    // returns null for anything outside them, so it can neither shadow nor be shadowed by any
    // branch above or below -- the prefixes are disjoint from /gossip, /status, /health, /exec/*
    // and /git/*, which makes the position of this line a readability choice, not a semantic one.
    const uiRes = await uiRoutes.handle(req, srv);
    if (uiRes) return uiRes;

    // --- Loopback-only CLI-facing routes -------------------------------------------------
    // `audit tail` is what remains of this group after the signed-job verbs were dropped. The path
    // still says /exec/ because renaming it is a change to a running system for no operational gain
    // during the canary window; see docs/FROZEN-WARTS.md.
    //
    // Loopback is NOT a caller identity: any local process, including a web page in a browser on
    // this machine, can reach 127.0.0.1. A CORS-"simple" cross-origin request needs no preflight
    // and would otherwise land here with operator authority, so any Origin or cross-site fetch
    // marker is rejected outright.
    if (OPERATOR_LOOPBACK_ROUTES.has(url.pathname)) {
      if (!isLoopback(srv, req)) return new Response('forbidden', { status: 403 });
      const csrf = rejectCrossSite(req);
      if (csrf) return csrf;

      if (req.method === 'GET' && url.pathname === '/exec/audit/tail') {
        const limitParam = Number(url.searchParams.get('limit'));
        const limit = Number.isFinite(limitParam) && limitParam > 0 ? Math.floor(limitParam) : 20;
        const all = await auditLog.readAll();
        return jsonResponse({ entries: all.slice(-limit).reverse() }); // most-recent-first
      }

      return new Response('not found', { status: 404 });
    }

    if (url.pathname.startsWith('/git/')) {
      try {
        return await gitserve.handleGitRequest(req, cfg, url.pathname);
      } catch (err) {
        log('error', 'gitserve request failed', { error: String(err), path: url.pathname });
        return new Response('internal error', { status: 500 });
      }
    }

    return new Response('not found', { status: 404 });
  }

  // Peer-facing surfaces (/gossip, /git) are bound to the mesh interface only, not every
  // interface on the host; /status additionally gets a dedicated loopback-only listener so
  // the CLI (which always dials 127.0.0.1) keeps working without widening the peer surface.
  const meshBindHost = cfg.meshIp.length > 0 ? cfg.meshIp : '0.0.0.0';
  if (meshBindHost === '0.0.0.0') {
    log('warn', 'node: no meshIp configured -- peer-facing server binding to 0.0.0.0 (all interfaces)', {});
  }
  const meshServer = Bun.serve({
    hostname: meshBindHost,
    port: cfg.nodePort,
    idleTimeout: 0,
    fetch: fetchHandler,
  }) as unknown as MinimalServer;
  const statusServer =
    meshBindHost === '127.0.0.1' || meshBindHost === '::1' || meshBindHost === '0.0.0.0'
      ? null
      : (Bun.serve({
          hostname: '127.0.0.1',
          port: cfg.nodePort,
          idleTimeout: 0,
          fetch: fetchHandler,
        }) as unknown as MinimalServer);

  // --- Loops -------------------------------------------------------------
  const gossipLoop = scheduleLoop('gossip', cfg.intervals.gossipSec * 1000, async () => {
    const now = nowMs();
    await gossip.broadcastOnce();
    await gossip.persistEvery(now);
    gossipLoopOkMs = now;
  });

  // Picks the single repo the audit union file may be flushed into, or null to skip flushing.
  //
  // Fail-closed by design, and warns exactly once per condition rather than every cycle. The
  // audit union file is per-machine and divergent by construction, so the repo carrying it MUST
  // have a postMerge entry that re-runs the union regenerator; without one, syncer.ts throws on
  // the first add/add conflict and that repo's sync loop wedges forever. Refusing to flush costs
  // only the git-shared copy of the audit log (the authoritative one still accumulates in
  // stateDir()); flushing into an unprepared repo costs the whole sync lane.
  // Verdict of the last audit cross-check, fed to health.ts. `undefined` until the first check
  // runs -- an absent verdict raises nothing, exactly like an absent `admin` block.
  let auditIntegrity: HealthSelf['auditIntegrity'];
  // Digests of entries already known to verify. Entries are immutable once signed, so this only
  // ever saves work; anything whose bytes differ is a different entry and gets checked. Lives for
  // the daemon's lifetime, so a restart re-verifies the whole log from scratch.
  const auditVerifiedDigests = new Set<string>();

  // The signers this machine will accept audit entries from: itself, plus every peer that has
  // completed enrolment. A machine absent here has its entries flagged `unverifiable-signer`
  // rather than trusted -- crossCheckAuditLog fails closed, and so does this.
  function auditSignerKeys(): Record<string, JsonWebKey> {
    const keys: Record<string, JsonWebKey> = { [cfg.machine]: key.publicKeyJwk };
    for (const peer of cfg.peers) if (peer.publicKeyJwk) keys[peer.name] = peer.publicKeyJwk;
    return keys;
  }

  // Verifies every signature in the regenerated union file and reports what is wrong with it.
  //
  // Reads only -- it never rewrites, quarantines or drops a line. That is deliberate: the union
  // file is git-synced, so deleting a line here would propagate the deletion to every machine, and
  // a tampered log that is loudly flagged is worth more than a quietly repaired one. Equally, it
  // must never throw: wedging the sync loop over a bad audit line would turn a forensics problem
  // into an outage.
  async function crossCheckFlushedEntries(entries: AuditEntry[]): Promise<HealthSelf['auditIntegrity']> {
    const report = await crossCheckAuditLog(entries, {
      nowMs: nowMs(),
      publicKeyJwkByMachine: auditSignerKeys(),
      acceptedForkFingerprints: await loadForkBaseline(),
      verifiedDigests: auditVerifiedDigests,
    });
    const count = (kind: CrossCheckFlagKind): number => report.flags.filter((f) => f.kind === kind).length;
    const verdict = {
      invalidSignatures: count('signature-invalid'),
      unverifiableSigners: count('unverifiable-signer'),
      unacceptedForks: count('seq-fork'),
      seqGaps: count('seq-gap'),
      chainBreaks: count('chain-broken'),
    };
    if (report.flags.length > 0) {
      log('error', 'audit: cross-check found problems in the replicated log', {
        ...verdict,
        // Details name machines, seqs and kinds -- never an argv, which an audit detail can carry.
        examples: report.flags.slice(0, 5).map((f) => `${f.kind}: ${f.detail}`),
      });
    } else {
      log('debug', 'audit: cross-check clean', { entries: entries.length, cached: auditVerifiedDigests.size });
    }
    return verdict;
  }

  let auditRepoWarned = false;
  function resolveAuditRepo(): RepoConfig | null {
    const name = cfg.admin.auditRepo;
    if (!name) {
      if (!auditRepoWarned) {
        auditRepoWarned = true;
        log('warn', 'audit: union path opted into unionPaths but admin.auditRepo is unset -- not flushing', {
          hint: 'set admin.auditRepo to the repo whose postMerge regenerates the audit union file',
        });
      }
      return null;
    }
    const repo = cfg.repos.find((r) => r.name === name);
    if (!repo || !adopted.has(repo.name)) {
      if (!auditRepoWarned) {
        auditRepoWarned = true;
        log('warn', 'audit: admin.auditRepo names a repo that is not configured/adopted -- not flushing', { auditRepo: name });
      }
      return null;
    }
    const hasRegenerator = (repo.postMerge ?? []).some((argv) =>
      argv.some((tok) => tok.includes('audit') && (tok.includes('regen') || tok.includes('union'))),
    );
    if (!hasRegenerator) {
      if (!auditRepoWarned) {
        auditRepoWarned = true;
        log('error', 'audit: admin.auditRepo has no postMerge audit-union regenerator -- refusing to flush (would wedge sync on the first conflict)', {
          auditRepo: repo.name,
        });
      }
      return null;
    }
    return repo;
  }

  const syncLoop = scheduleLoop('sync', cfg.intervals.syncSec * 1000, async () => {
    if (!clockSentinel.isClockVetted()) {
      log('info', 'sync loop: clock unvetted, holding commits/merges this cycle', {
        machine: cfg.machine,
      });
    }
    // Audit git-flush. Copies this machine's local entries into the union file inside a synced
    // repo, gated only on the operator having opted that file into cfg.unionPaths -- node.ts does
    // not silently invent that config (see AUDIT_UNION_RELATIVE_PATH).
    //
    // Deliberately OUTSIDE the per-repo loop, and flushed to exactly ONE repo. This block used to
    // sit inside the loop, so it wrote the union file into EVERY adopted repo -- each copy holding
    // only that machine's own entries, i.e. divergent by construction. On the first add/add
    // conflict a repo with no postMerge regenerator wedges its sync loop permanently, every cycle.
    //
    // Runs BEFORE the sync pass, so the flushed file's update rides the same autoCommit as
    // everything else this cycle.
    const auditRepo = cfg.unionPaths.includes(AUDIT_UNION_RELATIVE_PATH) ? resolveAuditRepo() : null;
    if (auditRepo) {
      try {
        const unionAbsPath = join(auditRepo.path, AUDIT_UNION_RELATIVE_PATH);
        const flushResult = await flushLocalToUnion(unionAbsPath);
        log('debug', 'audit: flushed local entries into the union file', {
          repo: auditRepo.name,
          entries: flushResult.entries.length,
        });
        auditIntegrity = await crossCheckFlushedEntries(flushResult.entries);
      } catch (err) {
        // Deliberately does NOT clear auditIntegrity: a flush that failed this cycle is a reason to
        // keep showing the last verdict, not to silently retract a forgery alarm.
        log('error', 'audit: flush/cross-check failed', { repo: auditRepo.name, error: String(err) });
      }
    }

    // P3 single-pusher policy: one decision per tick, reused for every repo below (the debounce
    // counts syncLoop ticks, not per-repo calls). Keyed on the anchor daemon's own gossip
    // heartbeat (Class A fix), never transport.anchorReachable() -- see shouldPushThisTick's
    // doc comment for why. Read once here so every repo this tick agrees, rather than each racing
    // a fresh gossip snapshot.
    const anchorDaemonOnlineNow = anchorDaemonOnlineFromGossip(gossip.getPeerViews(nowMs()));
    if (cfg.role === 'roamer') anchorDownStreak = nextAnchorDownStreak(anchorDownStreak, anchorDaemonOnlineNow);
    const push = shouldPushThisTick(cfg.role, anchorDaemonOnlineNow, anchorDownStreak);

    for (const repo of cfg.repos) {
      if (!adopted.has(repo.name)) continue; // never sync on main

      const sync = await syncer.syncOnce(repo);
      // Yield check, roamer-only. The observer is asked on EVERY roamer tick, not only on a tick
      // that would push, so its baseline is always "origin's main as of the previous tick". Sampling
      // only on push ticks let the baseline go stale across the anchor's whole healthy period, and
      // the next outage then opened with a false "moved by another pusher" for a push the anchor
      // made minutes earlier -- a wasted takeover tick and a streak reset, seen live. The read is
      // one local rev-parse of refs/remotes/origin/main as the fetch above just left it; no
      // network, and the anchor never asks. The answer is acted on only when this tick would
      // otherwise push: a main this machine did not push means somebody else is pushing, so stand
      // down for this repo and drop the streak, which makes the roamer wait out another full
      // TAKEOVER_STREAK before it considers taking over again. The streak lives here, not in the
      // pure gate, which is why the reset is at the call site.
      let originMovedByOther = false;
      if (cfg.role === 'roamer') {
        const moved = await derive.originMainMovedByOther(repo.path);
        let seen = foreignPushSeen.get(repo.name) ?? false;
        if (anchorDaemonOnlineNow !== false) seen = false;
        else if (moved) seen = true;
        if (seen && push) {
          originMovedByOther = true;
          seen = false;
          log('info', 'derive: main on origin moved by another pusher, yielding takeover', {
            repo: repo.name,
          });
          anchorDownStreak = 0;
        }
        foreignPushSeen.set(repo.name, seen);
      }
      // Per-repo veto on the tick's decision. One line per repo per tick when it fires, at info --
      // a refused takeover is the difference between one pusher and two, so it must be visible in
      // a normal log rather than only under debug. The yield above logs its own reason, so this
      // line is only for the other veto: the repo whose origin fetch failed this cycle.
      const repoPush = pushAllowedForRepo(
        cfg.role,
        push,
        anchorDaemonOnlineNow,
        sync.originFetchOk,
        originMovedByOther,
      );
      if (push && !repoPush && !originMovedByOther) {
        log('info', 'derive: takeover push refused, origin fetch failed this cycle', {
          repo: repo.name,
        });
      }
      try {
        const derived = await derive.updateMain(repo.path, { push: repoPush });
        // A fresh sha existed and this machine sat it out. At info, not debug: who pushed is an
        // operational fact, and this is the line that says the roamer is deferring rather than
        // racing the anchor -- at one line per repo per sync tick, cheap enough to keep in a
        // normal log. Skipped for 'unchanged-inputs': that tick minted nothing, so there was
        // never anything to suppress.
        if (cfg.role === 'roamer' && !originMovedByOther && derived.skipped === 'push-suppressed-non-owner') {
          log('info', 'derive: push suppressed this tick, anchor is the pusher', {
            repo: repo.name,
            sha: derived.sha,
          });
        }
      } catch (err) {
        log('error', 'derive.updateMain failed', { repo: repo.name, error: String(err) });
      }
      // Per-repo mark on top of the Syncer onStep per-step marks (see above);
      // covers derive.updateMain and repos that need no git steps.
      syncLoopOkMs = nowMs();
    }
    syncLoopOkMs = nowMs();
  });

  // Owns the only clockSentinel.check() call in the process: check() consumes its own
  // "did we just jump" signal (it returns true exactly once per suspend/resume event), so
  // calling it from more than one loop would let a second caller silently miss the event.
  const transportLoop = scheduleLoop('transport', cfg.intervals.transportPollSec * 1000, async () => {
    const now = nowMs();
    const jumped = await clockSentinel.check(now);
    if (jumped) {
      log('warn', 'suspend/resume jump detected -- running resume sequence', { machine: cfg.machine });
      // The loop-freshness marks are wall-clock based, so hours of suspend read as
      // hours of staleness the instant we resume — the watchdog would withhold
      // pings and systemd would kill a perfectly healthy process before the first
      // post-resume cycle can complete. Sleep time is not loop time; reset both.
      gossipLoopOkMs = now;
      syncLoopOkMs = now;
      await clockSentinel.resumeSequence(now);
      return;
    }
    const poll = await transport.pollOnce(now);
    lastTransportSummary = poll;
    if (transport.wedged(now)) {
      lastTransportRestartOk = await transport.restartTransport();
      log(lastTransportRestartOk ? 'warn' : 'error', 'transport wedged', {
        restarted: lastTransportRestartOk,
      });
    }
    if (!clockSentinel.isClockVetted()) {
      await clockSentinel.vet();
    }
  });

  const healthLoop = scheduleLoop('health', 30 * 1000, async () => {
    const now = nowMs();
    const repos: Record<string, PresenceRepoStat> = {};
    for (const [name, stat] of selfRepoStats) repos[name] = stat;
    const pushMs: Record<string, number | null> = {};
    for (const [name, ms] of githubPushOkMs) pushMs[name] = ms;

    // Admin-lane facts for health.ts's four p3 fault branches. Booleans and machine names only --
    // nothing credential-shaped can reach a desktop notification through this. A failure here
    // degrades to "no admin faults this tick" rather than taking the health loop down: the lane
    // being unreadable is not itself an emergency, and scheduleLoop would otherwise log an
    // iteration failure every 30s.
    let adminSelf: HealthSelf['admin'];
    try {
      const credential = await secrets.status(cfg);
      const entries = await sshAdmin.status();
      adminSelf = {
        credentialStale: credential.present && credential.stale,
        hostkeyMismatch: hostkeyMismatchPeers(),
        unreachablePeers: entries
          .filter((e) => !e.self && e.paired && e.reachable === false)
          .map((e) => e.machine),
        // A machine that never switched the lane on is not "unconfigured", it is uninvolved: only
        // cfg.admin.enabled makes the missing key/known_hosts worth alarming about (plan L6.6).
        configured: !cfg.admin.enabled || (await adminLaneConfigured()),
      };
    } catch (err) {
      log('warn', 'health: admin lane state unavailable this tick', { error: String(err) });
      adminSelf = undefined;
    }

    await health.evaluate(
      now,
      {
        repos,
        githubPushOkMs: pushMs,
        clockVetted: clockSentinel.isClockVetted(),
        transportWedged: transport.wedged(now),
        anchorReachable: transport.anchorReachable(),
        transportFault: transport.diagnosis()?.fault ?? null,
        admin: adminSelf,
        auditIntegrity,
      },
      // A peer with no enrolled public key cannot gossip verifiably yet —
      // "pending enrollment", not "offline". Alarming on it would nag the
      // operator about a machine that was never expected online. /status
      // still lists every configured peer.
      gossip.getPeerViews(now).filter((p) => enrolledPeers.has(p.name)),
    );
  });

  const watchdogIntervalMs = Math.max(1000, (cfg.intervals.watchdogSec / 3) * 1000);
  const watchdogLoop = scheduleLoop('watchdog', watchdogIntervalMs, async () => {
    const now = nowMs();
    const syncFreshWindowMs = Math.max(cfg.intervals.watchdogSec, cfg.intervals.syncSec * 2.5) * 1000;

    // Suspend/resume detection local to this loop (separate from clockSentinel's -- see the
    // baseline declarations above): a drift since the PREVIOUS tick beyond SUSPEND_JUMP_MS means
    // something happened between ticks that wall-clock loop-freshness marks cannot tell apart from
    // a wedge. Baseline always advances, jump or not, so this always measures since-last-tick.
    const nowMonoNs = Bun.nanoseconds();
    const drift = clockDriftMs(watchdogPrevMonoNs, watchdogPrevWallMs, nowMonoNs, now);
    watchdogPrevMonoNs = nowMonoNs;
    watchdogPrevWallMs = now;
    // nextWatchdogGrace (Class B fix) is a no-op unless this tick both crosses SUSPEND_JUMP_MS AND
    // the previous grant has already expired -- a fresh jump landing mid an already-open window is
    // refused, not extended, so back-to-back suspend cycles can't add up to continuous grace.
    const nextGrace = nextWatchdogGrace(watchdogGraceUntilMs, drift, now, syncFreshWindowMs);
    if (nextGrace !== watchdogGraceUntilMs) {
      watchdogGraceUntilMs = nextGrace;
      log('info', 'watchdog: clock jump detected mid-tick, granting post-resume grace', {
        driftMs: drift,
        graceUntilMs: watchdogGraceUntilMs,
      });
    }

    const gossipFresh = isLoopFresh(now, gossipLoopOkMs, cfg.intervals.watchdogSec * 1000);
    const syncFresh = isLoopFresh(now, syncLoopOkMs, syncFreshWindowMs);
    const fresh = gossipFresh && syncFresh;

    if (watchdogShouldPing(gossipFresh, syncFresh, now, watchdogGraceUntilMs)) {
      sdNotify('WATCHDOG=1');
      if (!fresh) {
        log('info', 'watchdog: pinging despite stale marks (post-resume grace)', {
          gossipFresh,
          syncFresh,
          graceUntilMs: watchdogGraceUntilMs,
        });
      }
    } else {
      log('warn', 'watchdog ping withheld -- a loop is stale or wedged', {
        gossipFresh,
        syncFresh,
        gossipAgeMs: now - gossipLoopOkMs,
        syncAgeMs: now - syncLoopOkMs,
      });
    }
  });

  sdNotify('READY=1');
  log('info', 'sukarfleet node ready', {
    machine: cfg.machine,
    role: cfg.role,
    port: cfg.nodePort,
    adoptedRepos: [...adopted],
  });

  let shuttingDown = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    log('info', 'shutting down', { signal });
    gossipLoop.stop();
    syncLoop.stop();
    transportLoop.stop();
    healthLoop.stop();
    watchdogLoop.stop();
    sshAdmin.stop();
    mcpHandle?.stop();
    meshServer.stop();
    statusServer?.stop();
    try {
      await gossip.snapshot();
    } catch (err) {
      log('error', 'final gossip snapshot failed', { error: String(err) });
    }
    process.exit(0);
  };

  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}

// Guarded so tests/node-exec.test.ts can import this module (for scheduleLoop/isLoopFresh) without
// the whole daemon springing to life -- import.meta.main is true only when this file is the actual
// entry point (`bun run src/node.ts`), which is unchanged from before this guard was added.
if (import.meta.main) {
  main().catch((err) => {
    log('error', 'sukarfleet node failed to start', { error: String(err) });
    process.exit(1);
  });
}
