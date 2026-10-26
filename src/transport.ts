// SPDX-License-Identifier: AGPL-3.0-or-later
// EasyTier transport supervisor + clock vetting. Owns: TOML generation (pure),
// per-peer rx/tx wedge detection, and suspend/resume-aware clock vetting.

import type { FleetConfig } from './types';
import type { RunResult } from './util';
import { clockDriftMs, log, run, sleep } from './util';
import { clockSyncProbeFor, currentPlatform, serviceManagerFor } from './platform';
import type { ClockSyncState, PlatformId } from './platform';

// ---------------------------------------------------------------------------
// TOML generation (pure)
// ---------------------------------------------------------------------------

export interface EasytierTomlOpts {
  secret: string;
  listeners: string[];
  peerUris: string[];
  hostname: string;
  // TUN virtual address for this machine (cfg.meshIp). Without it easytier
  // assigns no address and the node's mesh HTTP/gossip has nothing to bind to.
  ipv4: string;
}

// Basic-string escaping shared by TOML and JSON for the character set we emit
// (quote, backslash, control chars) — JSON.stringify produces valid TOML
// basic strings for these inputs.
function tomlString(s: string): string {
  return JSON.stringify(s);
}

function tomlStringArray(items: string[]): string {
  return '[' + items.map(tomlString).join(', ') + ']';
}

// Emits the v2.6.4 easytier-core TOML. rpc_portal is intentionally never
// written here — it is a CLI flag (-r <rpcAddr>) on the systemd ExecStart,
// per the pinned design (rpc portal is loopback-only and process-scoped).
export function generateEasytierToml(cfg: FleetConfig, opts: EasytierTomlOpts): string {
  const lines: string[] = [];
  lines.push(
    `# rpc_portal is passed as a CLI flag (-r ${cfg.easytier.rpcAddr}) in the systemd unit, not in this file.`,
  );
  // TOML: every top-level key must precede the first table header — a key
  // emitted after [network_identity] would silently belong to that table.
  lines.push(`hostname = ${tomlString(opts.hostname)}`);
  lines.push(`ipv4 = ${tomlString(opts.ipv4)}`);
  lines.push('dhcp = false');
  lines.push(`listeners = ${tomlStringArray(opts.listeners)}`);
  lines.push('');
  lines.push('[network_identity]');
  lines.push(`network_name = ${tomlString(cfg.networkName)}`);
  lines.push(`network_secret = ${tomlString(opts.secret)}`);
  for (const uri of opts.peerUris) {
    lines.push('');
    lines.push('[[peer]]');
    lines.push(`uri = ${tomlString(uri)}`);
  }
  lines.push('');
  lines.push('[flags]');
  lines.push('relay_network_whitelist = ""');
  lines.push('enable_ipv6 = true');
  return lines.join('\n') + '\n';
}

// ---------------------------------------------------------------------------
// Transport supervisor
// ---------------------------------------------------------------------------

export interface TransportDeps {
  runner?: typeof run;
  // Injected by tests so reannounceSelf()'s settle gap does not cost real time.
  sleep?: (ms: number) => Promise<void>;
}

export interface PeerSample {
  hostname: string;
  rxBytes: number;
  txBytes: number;
}

// ---------------------------------------------------------------------------
// Connector-level diagnosis
//
// An empty peer table has three very different causes and, until now, one
// message. `easytier-cli connector list` separates them: a connector that
// reports Connected while the peer table stays empty means the transport is up
// and the mesh session is simply not converging -- the signature of a phantom
// LAN candidate (see planPeerDial) or a half-open session -- which is a
// different fault from "every dial is failing", and wants a different fix.
// ---------------------------------------------------------------------------

export type ConnectorStatus = 'connected' | 'connecting' | 'unknown';

export interface ConnectorSample {
  uri: string;
  status: ConnectorStatus;
}

// easytier v2.6.4 emits the enum ordinal in JSON (0 = Connected, 2 = Connecting),
// and the human table renders the names. Accept both; anything unrecognised is
// 'unknown', which counts as "not connected" without being asserted as failed.
function toConnectorStatus(v: unknown): ConnectorStatus {
  if (v === 0) return 'connected';
  if (v === 2) return 'connecting';
  if (typeof v === 'string') {
    const s = v.toLowerCase();
    if (s === 'connected') return 'connected';
    if (s === 'connecting') return 'connecting';
  }
  return 'unknown';
}

// Parses `easytier-cli -o json connector list`. Returns null on any shape it
// cannot trust, matching pollOnce's never-throw contract.
export function parseConnectorJson(stdout: string): ConnectorSample[] | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return null;
  }
  if (!Array.isArray(parsed)) return null;
  const out: ConnectorSample[] = [];
  for (const entry of parsed) {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) continue;
    const rec = entry as Record<string, unknown>;
    const url = rec.url;
    if (typeof url !== 'object' || url === null) continue;
    const uri = (url as Record<string, unknown>).url;
    if (typeof uri !== 'string' || uri.length === 0) continue;
    out.push({ uri, status: toConnectorStatus(rec.status) });
  }
  return out;
}

export type TransportFault =
  // A non-local peer is present: the mesh is up, whatever else may be wrong.
  | 'ok'
  // No connectors at all -- this node was never told who to dial.
  | 'no-connectors'
  // Every connector is still dialling: no path to the peer exists right now.
  | 'all-connectors-down'
  // At least one connector is Connected, yet no peer ever appeared. The
  // transport works and the mesh session is not converging over it.
  | 'connected-without-peer';

export interface TransportDiagnosis {
  fault: TransportFault;
  connectedUris: string[];
  dialingUris: string[];
  summary: string;
}

export function diagnoseTransport(
  nonLocalPeerCount: number,
  connectors: ConnectorSample[],
): TransportDiagnosis {
  const connectedUris = connectors.filter((c) => c.status === 'connected').map((c) => c.uri);
  const dialingUris = connectors.filter((c) => c.status !== 'connected').map((c) => c.uri);

  if (nonLocalPeerCount > 0) {
    return { fault: 'ok', connectedUris, dialingUris, summary: 'mesh up: at least one non-local peer is present' };
  }
  if (connectors.length === 0) {
    return { fault: 'no-connectors', connectedUris, dialingUris, summary: 'no peer connectors are configured on this node' };
  }
  if (connectedUris.length > 0) {
    return {
      fault: 'connected-without-peer',
      connectedUris,
      dialingUris,
      summary:
        `transport is connected (${connectedUris.join(', ')}) but no peer joined the mesh: ` +
        'the session is not converging -- suspect a phantom LAN candidate or a half-open session on the far side',
    };
  }
  return {
    fault: 'all-connectors-down',
    connectedUris,
    dialingUris,
    summary: `no connector reached its peer (still dialling: ${dialingUris.join(', ')})`,
  };
}

// ---------------------------------------------------------------------------
// Route audit: a peer that is on the mesh but has no route here
//
// diagnoseTransport only speaks when the peer table is empty. EasyTier 2.6.4
// can also lose ONE peer while every other peer stays up (upstream #2597,
// fixed in 2.7.0 by #2599): a node deletes a peer's route metadata after a
// short outage, and its route-sync partner never resends it, because the
// partner still records the deleting node as holding that version and its
// incremental cursor has moved past the record. The peer's own connection to
// this node can be live the whole time. The tell is in `peer-center`, which
// keeps listing the peer id (with no hostname or IPv4, since those come from
// the missing route) while `peer list` has no row for it.
//
// The record only travels again when its owner publishes a NEW version of its
// route info. That is what reannounceSelf() forces on the owner's side, and
// why a restart of the node that lost the route is never required.
// ---------------------------------------------------------------------------

export interface PeerCenterRow {
  nodeId: string;
  hostname: string;
  directPeerIds: string[];
}

function idString(v: unknown): string | null {
  if (typeof v === 'string' && v.length > 0) return v;
  if (typeof v === 'number' && Number.isInteger(v) && v >= 0) return String(v);
  return null;
}

// Parses `easytier-cli -o json peer-center`. Returns null on any shape it
// cannot trust; rows or direct-peer entries without an id are skipped.
export function parsePeerCenterJson(stdout: string): PeerCenterRow[] | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return null;
  }
  if (!Array.isArray(parsed)) return null;
  const rows: PeerCenterRow[] = [];
  for (const entry of parsed) {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) continue;
    const rec = entry as Record<string, unknown>;
    const nodeId = idString(rec.node_id);
    if (nodeId === null) continue;
    const directPeerIds: string[] = [];
    if (Array.isArray(rec.direct_peers)) {
      for (const d of rec.direct_peers) {
        if (typeof d !== 'object' || d === null) continue;
        const id = idString((d as Record<string, unknown>).node_id);
        if (id !== null) directPeerIds.push(id);
      }
    }
    rows.push({ nodeId, hostname: typeof rec.hostname === 'string' ? rec.hostname : '', directPeerIds });
  }
  return rows;
}

export interface UnroutedPeer {
  peerId: string;
  // Last hostname this node saw on a routed row for the id, when it saw one.
  hostname: string | null;
  // 'direct-connection': this node's own peer-center row says it holds a live
  // connection to the peer. 'peer-center': another node reports the peer.
  evidence: 'direct-connection' | 'peer-center';
}

// Peer ids that a LIVE node reports as its direct peer but that have no row in
// this node's peer list. Pure. A live reporter is this node itself or a node
// routed here. Two kinds of stale data are filtered out this way:
// - The center keeps a departed peer's OWN row for up to 180s, so a peer's
//   own row never counts as evidence. Live nodes stop listing a departed peer
//   within about 20s.
// - When this node has lost every route, its copy of the center stops
//   refreshing. With nothing non-local routed, there is no live reporter
//   besides this node's own stale row, so the function reports nothing and
//   leaves the outage to the transport diagnosis.
// myPeerId null means the peer list carried no local row, which leaves this
// node unable to tell its own id from a lost one, so it reports nothing.
export function findUnroutedPeers(
  myPeerId: string | null,
  routedIds: ReadonlySet<string>,
  center: readonly PeerCenterRow[],
  knownNames: ReadonlyMap<string, string> = new Map(),
): UnroutedPeer[] {
  if (myPeerId === null) return [];
  if (![...routedIds].some((id) => id !== myPeerId)) return [];
  const evidence = new Map<string, UnroutedPeer['evidence']>();
  for (const row of center) {
    const reporterIsMe = row.nodeId === myPeerId;
    if (!reporterIsMe && !routedIds.has(row.nodeId)) continue;
    for (const id of row.directPeerIds) {
      if (id === myPeerId || id === row.nodeId || routedIds.has(id)) continue;
      if (reporterIsMe || !evidence.has(id)) evidence.set(id, reporterIsMe ? 'direct-connection' : 'peer-center');
    }
  }
  return [...evidence.keys()].sort().map((id) => ({
    peerId: id,
    hostname: knownNames.get(id) ?? null,
    evidence: evidence.get(id)!,
  }));
}

// Consecutive polls a peer must stay unrouted before it is reported (~90s at
// the default 30s poll). Live nodes can list a departed peer for about 20s
// after it leaves, and EasyTier can keep its route for up to 90s after its
// connections drop. Three polls ride out the ordinary churn of
// a reconnect without hiding a route that never comes back.
export const ROUTE_MISS_POLLS = 3;

// Configured peers whose silence points at a one-way route: this node routes
// to the peer, the peer center shows it alive on the mesh, and yet no signed
// gossip has arrived from it. If the peer cannot route back to this node,
// that is exactly how it looks from this side. Pure.
export function oneWayRouteSuspects(
  silentPeers: readonly string[],
  routedHostnames: ReadonlySet<string>,
  center: readonly PeerCenterRow[] | null,
): string[] {
  if (center === null) return [];
  const alive = new Set(center.filter((r) => r.directPeerIds.length > 0).map((r) => r.hostname));
  return silentPeers.filter((name) => routedHostnames.has(name) && alive.has(name)).sort();
}

// Polls a one-way suspicion must persist before this node re-announces itself,
// and the least time between two re-announcements. A re-announce is cheap and
// harmless, but a peer whose daemon is simply stopped also looks silent, and
// that must cost one re-announce per interval, not one per poll.
export const REANNOUNCE_SUSPECT_POLLS = 3;
export const REANNOUNCE_MIN_INTERVAL_MS = 15 * 60 * 1000;

// Streak and rate-limit bookkeeping for reannounceSelf(). Pure state machine:
// observe() is fed each poll's suspects and answers which of them, if any,
// warrant a re-announce now.
export class ReannounceGate {
  private readonly streaks = new Map<string, number>();
  private lastFiredMs: number | null = null;

  observe(nowMs: number, suspects: readonly string[]): string[] {
    const current = new Set(suspects);
    for (const name of [...this.streaks.keys()]) if (!current.has(name)) this.streaks.delete(name);
    for (const name of current) this.streaks.set(name, (this.streaks.get(name) ?? 0) + 1);
    const ripe = [...this.streaks].filter(([, n]) => n >= REANNOUNCE_SUSPECT_POLLS).map(([name]) => name).sort();
    if (ripe.length === 0) return [];
    if (this.lastFiredMs !== null && nowMs - this.lastFiredMs < REANNOUNCE_MIN_INTERVAL_MS) return [];
    this.lastFiredMs = nowMs;
    return ripe;
  }
}

// Gap between creating and revoking the throwaway credential. EasyTier folds
// its own state into its published route info once a second, so the two
// changes must land on different ticks or the second undoes the first unseen.
const REANNOUNCE_SETTLE_MS = 3000;
// Lifetime of the throwaway credential if the revoke never lands.
const REANNOUNCE_CREDENTIAL_TTL_SEC = 60;

interface PollRecord {
  atMs: number;
  hadNonLocalPeer: boolean;
  deltaBytes: number;
}

// A roamer needs this many consecutive trusted anchor-free polls before the
// verdict flips to unreachable (~90s at the default 30s poll): one lost poll
// must not raise a critical alarm. Recovery is instant on the next sighting.
export const ANCHOR_MISS_POLLS = 3;

function toFiniteNumber(v: unknown): number {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string') {
    const n = Number(v);
    if (Number.isFinite(n)) return n;
  }
  return 0;
}

export class Transport {
  private readonly runner: typeof run;
  private cumulativeTotal: number | null = null;
  private readonly history: PollRecord[] = [];
  private anchorMissStreak = 0;
  private anchorSeen: boolean | null = null;
  private lastDiagnosis: TransportDiagnosis | null = null;
  private readonly sleep: (ms: number) => Promise<void>;
  // Route audit state. knownNames remembers the hostname of every id this node
  // has seen on a routed row, so an alarm about a lost route can still name the
  // machine: the peer center cannot, because it reads names from the very route
  // that is missing.
  private readonly knownNames = new Map<string, string>();
  private readonly routeMissStreak = new Map<string, number>();
  private confirmedUnrouted: UnroutedPeer[] = [];
  private lastCenter: PeerCenterRow[] | null = null;
  private lastRoutedHostnames = new Set<string>();

  constructor(
    private readonly cfg: FleetConfig,
    deps: TransportDeps = {},
  ) {
    this.runner = deps.runner ?? run;
    this.sleep = deps.sleep ?? sleep;
  }

  // easytier-cli may simply not be there -- a fresh Windows machine that has not installed the
  // mesh yet is the ordinary case -- and Bun.spawn raises ENOENT rather than returning an exit
  // code. Every poll below documents that it never throws, so the absent binary has to arrive as
  // the failure it is: a non-zero result whose stderr names the reason, handled by the same branch
  // that already handles a CLI which ran and refused.
  private async runCli(argv: string[], timeoutMs: number): Promise<RunResult> {
    try {
      return await this.runner(argv, { timeoutMs });
    } catch (err) {
      return { code: 127, stdout: '', stderr: `could not run ${argv[0]}: ${String(err)}` };
    }
  }

  // Polls the loopback RPC portal with two commands (real v2.6.4 interface,
  // verified on the installed binary): `-o json peer list` for peer presence
  // (its rx/tx values are humanized display strings, useless as counters) and
  // `-o json stats` for the raw aggregate traffic_bytes_rx/tx counters that
  // feed wedge detection. Returns null (and logs a warning) on any shape it
  // cannot trust; never throws.
  async pollOnce(nowMs: number): Promise<PeerSample[] | null> {
    const base = [this.cfg.easytier.cliPath, '-p', this.cfg.easytier.rpcAddr, '-o', 'json'];
    const res = await this.runCli([...base, 'peer', 'list'], 30000);
    if (res.code !== 0) {
      log('warn', 'transport: easytier-cli peer poll failed', { code: res.code, stderr: res.stderr.slice(0, 500) });
      this.recordPoll(nowMs, false, 0);
      return null;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(res.stdout);
    } catch (err) {
      log('warn', 'transport: easytier-cli peer output not valid JSON', { error: String(err) });
      this.recordPoll(nowMs, false, 0);
      return null;
    }
    if (!Array.isArray(parsed)) {
      log('warn', 'transport: easytier-cli peer output not an array', { typeofValue: typeof parsed });
      this.recordPoll(nowMs, false, 0);
      return null;
    }

    const samples: PeerSample[] = [];
    const routedIds = new Set<string>();
    let myPeerId: string | null = null;
    for (const entry of parsed) {
      if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) continue;
      const rec = entry as Record<string, unknown>;
      const hostname = typeof rec.hostname === 'string' && rec.hostname.length > 0 ? rec.hostname : null;
      const id = idString(rec.id);
      if (id !== null) {
        routedIds.add(id);
        if (rec.cost === 'Local') myPeerId = id;
        if (hostname) this.knownNames.set(id, hostname);
      }
      if (!hostname) continue;
      samples.push({ hostname, rxBytes: toFiniteNumber(rec.rx_bytes), txBytes: toFiniteNumber(rec.tx_bytes) });
    }
    const nonLocal = samples.filter((s) => s.hostname !== this.cfg.machine);
    this.lastRoutedHostnames = new Set(nonLocal.map((s) => s.hostname));
    await this.refreshRouteAudit(base, myPeerId, routedIds);

    // A third CLI round-trip is only worth taking when something is already
    // wrong: with a non-local peer present the verdict is 'ok' by definition,
    // and connectors add nothing.
    if (nonLocal.length === 0) {
      await this.refreshDiagnosis(base, 0);
    } else {
      this.lastDiagnosis = diagnoseTransport(nonLocal.length, []);
    }

    // Anchor-reachability evidence (roamer only). P1's mesh is hub-and-spoke —
    // a roamer's transport path exists only via the anchor's WAN forwards — so
    // any configured peer present in the peer table means the anchor is
    // reachable. Failed polls return above and carry no evidence either way.
    if (this.cfg.role === 'roamer' && this.cfg.peers.length > 0) {
      const peerNames = new Set(this.cfg.peers.map((p) => p.name));
      if (samples.some((s) => peerNames.has(s.hostname))) {
        this.anchorMissStreak = 0;
        this.anchorSeen = true;
      } else if (++this.anchorMissStreak >= ANCHOR_MISS_POLLS) {
        this.anchorSeen = false;
      }
    }

    // Aggregate byte counters. A failed stats read means "no movement
    // evidence", so the poll is recorded without a non-local peer — a wedge
    // verdict needs both peers present AND counters flat, never a blind spot.
    const statsTotal = await this.readStatsTotal(base);
    if (statsTotal === null) {
      this.recordPoll(nowMs, false, 0);
      return samples;
    }
    let deltaBytes = 0;
    // First poll has no baseline; treat as zero delta rather than counting
    // the full cumulative total as "movement".
    if (this.cumulativeTotal !== null) deltaBytes = Math.max(0, statsTotal - this.cumulativeTotal);
    this.cumulativeTotal = statsTotal;
    this.recordPoll(nowMs, nonLocal.length > 0, deltaBytes);
    return samples;
  }

  // Reads `connector list` and classifies why the peer table is empty. Never
  // throws and never blocks a poll: an unreadable connector list leaves the
  // diagnosis null (unknown), which reads as "no opinion", not as "healthy".
  private async refreshDiagnosis(base: string[], nonLocalPeerCount: number): Promise<void> {
    const res = await this.runCli([...base, 'connector', 'list'], 30000);
    if (res.code !== 0) {
      log('warn', 'transport: easytier-cli connector poll failed', { code: res.code, stderr: res.stderr.slice(0, 500) });
      this.lastDiagnosis = null;
      return;
    }
    const connectors = parseConnectorJson(res.stdout);
    if (connectors === null) {
      log('warn', 'transport: easytier-cli connector output not usable JSON', {});
      this.lastDiagnosis = null;
      return;
    }
    const next = diagnoseTransport(nonLocalPeerCount, connectors);
    // One line per transition, not one per poll: this fires every 30s while a
    // fleet is down, and a repeated identical warning is how a real signal gets
    // trained out of the log.
    if (this.lastDiagnosis === null || this.lastDiagnosis.fault !== next.fault) {
      log('warn', 'transport: mesh fault', {
        fault: next.fault,
        summary: next.summary,
        connected: next.connectedUris,
        dialing: next.dialingUris,
      });
    }
    this.lastDiagnosis = next;
  }

  // Reads `peer-center` and compares it with the routed ids from this poll's
  // peer list. Never throws. An unreadable peer center clears the snapshot the
  // re-announce check reads, but keeps the streaks: one failed read must not
  // reset a count that is about to confirm a real loss, and must not confirm it
  // either.
  private async refreshRouteAudit(base: string[], myPeerId: string | null, routedIds: Set<string>): Promise<void> {
    const res = await this.runCli([...base, 'peer-center'], 30000);
    const center = res.code === 0 ? parsePeerCenterJson(res.stdout) : null;
    if (center === null) {
      if (res.code !== 0) {
        log('warn', 'transport: easytier-cli peer-center poll failed', { code: res.code, stderr: res.stderr.slice(0, 500) });
      } else {
        log('warn', 'transport: easytier-cli peer-center output not usable JSON', {});
      }
      this.lastCenter = null;
      // The peer list alone can still prove a recovery: an id routed again is no longer lost, even
      // on a poll that cannot read the peer center. Clear it now rather than keeping a critical
      // alarm up until the next readable poll.
      for (const id of routedIds) this.routeMissStreak.delete(id);
      this.confirmedUnrouted = this.confirmedUnrouted.filter((u) => !routedIds.has(u.peerId));
      return;
    }
    this.lastCenter = center;
    // Keep names only for ids still in view, or a peer that restarts often (a
    // new id each time) grows this map forever.
    const inView = new Set(routedIds);
    for (const row of center) for (const id of [row.nodeId, ...row.directPeerIds]) inView.add(id);
    for (const id of [...this.knownNames.keys()]) if (!inView.has(id)) this.knownNames.delete(id);
    const unrouted = findUnroutedPeers(myPeerId, routedIds, center, this.knownNames);
    const current = new Set(unrouted.map((u) => u.peerId));
    for (const id of [...this.routeMissStreak.keys()]) if (!current.has(id)) this.routeMissStreak.delete(id);
    for (const id of current) this.routeMissStreak.set(id, (this.routeMissStreak.get(id) ?? 0) + 1);
    const next = unrouted.filter((u) => (this.routeMissStreak.get(u.peerId) ?? 0) >= ROUTE_MISS_POLLS);
    // One line per change of the confirmed set, not one per poll.
    const key = (list: UnroutedPeer[]) => list.map((u) => u.peerId).join(',');
    if (key(next) !== key(this.confirmedUnrouted)) {
      if (next.length > 0) {
        log('warn', 'transport: peer on the mesh has no route here', {
          peers: next.map((u) => ({ peerId: u.peerId, hostname: u.hostname, evidence: u.evidence })),
        });
      } else {
        log('info', 'transport: every peer on the mesh has a route again', {});
      }
    }
    this.confirmedUnrouted = next;
  }

  // Peers the peer center reports that have had no route here for at least
  // ROUTE_MISS_POLLS consecutive polls.
  unroutedPeers(): UnroutedPeer[] {
    return this.confirmedUnrouted;
  }

  // Configured peers from `silentPeers` (no recent signed gossip) that look
  // like they cannot route back to this node. See oneWayRouteSuspects.
  oneWaySuspects(silentPeers: readonly string[]): string[] {
    return oneWayRouteSuspects(silentPeers, this.lastRoutedHostnames, this.lastCenter);
  }

  // Makes this node publish a new version of its EasyTier route info, which
  // every peer accepts and passes on, including one whose sync partner stopped
  // resending the old version (upstream #2597). 2.6.4 has no direct command
  // for that. The only runtime field its CLI can change is the list of trusted
  // credential keys, so this creates a throwaway credential and revokes it.
  // Nothing else changes: no connection drops and no route moves.
  //
  // The credential is never usable. Its secret goes to the CLI's stdout, which
  // this method never reads or logs; it carries no groups and no relay right,
  // cannot be reused, is revoked after REANNOUNCE_SETTLE_MS, and expires after
  // REANNOUNCE_CREDENTIAL_TTL_SEC if the revoke fails. Never throws.
  async reannounceSelf(nowMs: number): Promise<boolean> {
    const base = [this.cfg.easytier.cliPath, '-p', this.cfg.easytier.rpcAddr];
    const credentialId = `sukarfleet-reannounce-${nowMs}`;
    const gen = await this.runCli(
      [...base, 'credential', 'generate', '--ttl', String(REANNOUNCE_CREDENTIAL_TTL_SEC), '--credential-id', credentialId, '--reusable', 'false'],
      30000,
    );
    if (gen.code !== 0) {
      log('warn', 'transport: route re-announce failed at generate', { code: gen.code, stderr: gen.stderr.slice(0, 500) });
      return false;
    }
    await this.sleep(REANNOUNCE_SETTLE_MS);
    const rev = await this.runCli([...base, 'credential', 'revoke', credentialId], 30000);
    if (rev.code !== 0) {
      log('warn', 'transport: route re-announce could not revoke its credential; it expires on its own', {
        credentialId,
        ttlSec: REANNOUNCE_CREDENTIAL_TTL_SEC,
        code: rev.code,
        stderr: rev.stderr.slice(0, 500),
      });
    }
    return true;
  }

  // Latest connector-level verdict, or null when it could not be established.
  // Null is "no opinion" -- never read it as healthy.
  diagnosis(): TransportDiagnosis | null {
    return this.lastDiagnosis;
  }

  // Sums traffic_bytes_rx + traffic_bytes_tx from `easytier-cli stats`.
  private async readStatsTotal(base: string[]): Promise<number | null> {
    const res = await this.runCli([...base, 'stats'], 30000);
    if (res.code !== 0) {
      log('warn', 'transport: easytier-cli stats poll failed', { code: res.code, stderr: res.stderr.slice(0, 500) });
      return null;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(res.stdout);
    } catch (err) {
      log('warn', 'transport: easytier-cli stats output not valid JSON', { error: String(err) });
      return null;
    }
    if (!Array.isArray(parsed)) {
      log('warn', 'transport: easytier-cli stats output not an array', { typeofValue: typeof parsed });
      return null;
    }
    let total = 0;
    let seen = false;
    for (const entry of parsed) {
      if (typeof entry !== 'object' || entry === null) continue;
      const rec = entry as Record<string, unknown>;
      if (rec.name === 'traffic_bytes_rx' || rec.name === 'traffic_bytes_tx') {
        total += toFiniteNumber(rec.value);
        seen = true;
      }
    }
    if (!seen) {
      log('warn', 'transport: stats output carries no traffic_bytes_rx/tx metrics', {});
      return null;
    }
    return total;
  }

  private recordPoll(atMs: number, hadNonLocalPeer: boolean, deltaBytes: number): void {
    this.history.push({ atMs, hadNonLocalPeer, deltaBytes });
    const cap = Math.max(this.cfg.thresholds.wedgePolls, 1) * 4;
    if (this.history.length > cap) this.history.splice(0, this.history.length - cap);
  }

  // True when the last thresholds.wedgePolls polls all observed at least one
  // non-local peer present and zero total rx+tx delta.
  wedged(_nowMs: number): boolean {
    const n = this.cfg.thresholds.wedgePolls;
    if (this.history.length < n) return false;
    const recent = this.history.slice(-n);
    return recent.every((r) => r.hadNonLocalPeer && r.deltaBytes === 0);
  }

  // Roamer-only anchor verdict for health: null until the first trusted poll
  // (and always null on the anchor itself), true on any sighting, false only
  // after ANCHOR_MISS_POLLS consecutive anchor-free polls.
  anchorReachable(): boolean | null {
    return this.anchorSeen;
  }

  async restartTransport(): Promise<boolean> {
    // Restarting a service is one of the four seams that were Linux-only inline calls before the
    // extraction (platform.ts). The runner stays injectable for tests, and a platform with no
    // honest implementation refuses by name rather than failing obscurely at the first call.
    const manager = serviceManagerFor();
    const res = await manager.restart(this.cfg.easytier.serviceName, (argv, opts) =>
      this.runner(argv, { timeoutMs: opts?.timeoutMs ?? 30000 }),
    );
    if (!res.ok) {
      log('error', 'transport: restart failed', {
        service: this.cfg.easytier.serviceName,
        platform: manager.platform,
        support: manager.support,
        detail: res.detail,
      });
      return false;
    }
    log('info', 'transport: restarted mesh transport service', {
      service: this.cfg.easytier.serviceName,
      detail: res.detail,
    });
    // A restart invalidates the evidence that triggered it: clear the wedge
    // streak and the counter baseline, or a peer that reconnects quietly can
    // re-trip wedged() on the very next poll and loop the restarts. The anchor
    // miss streak is evidence too; the last verdict stands until fresh polls.
    this.history.length = 0;
    this.cumulativeTotal = null;
    this.anchorMissStreak = 0;
    return true;
  }
}

// ---------------------------------------------------------------------------
// Clock vetting
// ---------------------------------------------------------------------------

export interface ClockSentinelDeps {
  runner?: typeof run;
  // Which platform's time client to ask. Defaults to this machine's; injected by tests.
  platform?: PlatformId;
  now?: () => number;
  monotonicNs?: () => number;
  onResume?: () => void | Promise<void>;
  // Injected transport orchestration for resumeSequence(); left undefined in
  // tests that only exercise clock logic.
  pollTransport?: (nowMs: number) => Promise<unknown>;
  isWedged?: (nowMs: number) => boolean;
  restartTransport?: () => Promise<boolean>;
  onEndpointRepublish?: () => void | Promise<void>;
}

// Exported for node.ts's watchdogLoop (P4), which grants its own post-resume grace window off the
// same threshold rather than inventing a second one.
export const SUSPEND_JUMP_MS = 60000;
const PEER_OFFSET_WINDOW = 8; // recent readings kept per peer for the median check

interface PeerOffsetSample {
  machine: string;
  offsetMs: number;
  atMs: number;
}

export class ClockSentinel {
  private baselineMonoNs: number;
  private baselineWallMs: number;
  private vetted = false;
  private lastClockState: ClockSyncState | null = null;
  private peerOffsets: PeerOffsetSample[] = [];

  constructor(
    private readonly cfg: FleetConfig,
    private readonly deps: ClockSentinelDeps = {},
  ) {
    this.baselineMonoNs = (this.deps.monotonicNs ?? Bun.nanoseconds)();
    this.baselineWallMs = (this.deps.now ?? Date.now)();
  }

  // Call periodically with the current wall clock. Detects a suspend/resume
  // by comparing wall-clock elapsed time against monotonic elapsed time
  // since the last baseline; a >60s divergence means the wall clock jumped
  // (sleep, hibernate, or a manual clock change) rather than time simply
  // passing. Resets the baseline and un-vets the clock either way.
  async check(nowMs: number): Promise<boolean> {
    const monoNs = (this.deps.monotonicNs ?? Bun.nanoseconds)();
    const drift = clockDriftMs(this.baselineMonoNs, this.baselineWallMs, monoNs, nowMs);
    if (drift <= SUSPEND_JUMP_MS) return false;

    this.baselineMonoNs = monoNs;
    this.baselineWallMs = nowMs;
    this.vetted = false;
    await this.deps.onResume?.();
    return true;
  }

  // Asks the platform's own time client, through the seam in platform.ts. The probe never throws:
  // an absent or failing client is 'unknown', which is not vetted but is a different fact from a
  // clock the client says is wrong. Only 'synced' vets, so Windows and macOS run the daemon,
  // gossip and sync what they can, and hold auto-commit with the reason on the record.
  async vet(): Promise<boolean> {
    const runner = this.deps.runner ?? run;
    const probe = clockSyncProbeFor(this.deps.platform ?? currentPlatform());
    const state = await probe.probe((argv, opts) => runner(argv, { timeoutMs: opts?.timeoutMs ?? 10000 }));
    // One line per transition, not one per poll: vet() re-runs on every sync cycle while the clock
    // is unvetted, and a warning repeated every two minutes is how a real signal gets ignored.
    if (state !== this.lastClockState) {
      if (state !== 'synced') {
        log('warn', 'transport: clock not vetted by the platform time client', {
          platform: probe.platform,
          support: probe.support,
          state,
        });
      }
      this.lastClockState = state;
    }
    this.vetted = state === 'synced' && !this.peerSkewFlagged();
    return this.vetted;
  }

  // What the last vet() actually learned, for callers that want to tell "the clock is wrong" apart
  // from "no time client answered". Null until vet() has run once.
  clockSyncState(): ClockSyncState | null {
    return this.lastClockState;
  }

  // Peer-reported presence clockMs, cross-checked against this machine's own
  // clock at receipt time. If the median |offset| across recent readings
  // exceeds thresholds.clockSkewMaxMs, demote to unvetted immediately —
  // don't wait for the next vet() poll.
  offerPeerClock(machine: string, clockMs: number, localNowMs: number): void {
    const offsetMs = clockMs - localNowMs;
    this.peerOffsets = this.peerOffsets.filter((o) => o.machine !== machine);
    this.peerOffsets.push({ machine, offsetMs, atMs: localNowMs });
    if (this.peerOffsets.length > PEER_OFFSET_WINDOW) {
      this.peerOffsets.splice(0, this.peerOffsets.length - PEER_OFFSET_WINDOW);
    }
    if (this.peerSkewFlagged()) this.vetted = false;
  }

  private peerSkewFlagged(): boolean {
    if (this.peerOffsets.length === 0) return false;
    const abs = this.peerOffsets.map((o) => Math.abs(o.offsetMs)).sort((a, b) => a - b);
    const mid = Math.floor(abs.length / 2);
    const median = abs.length % 2 === 1 ? abs[mid]! : (abs[mid - 1]! + abs[mid]!) / 2;
    return median > this.cfg.thresholds.clockSkewMaxMs;
  }

  isClockVetted(): boolean {
    return this.vetted;
  }

  // Full resume pipeline: un-vet, re-poll the transport, republish the
  // endpoint file, re-vet the clock, and restart the transport if it came
  // back wedged. Auto-commits and merges must gate on isClockVetted(), not
  // on this method having run — callers (syncer) hold on their own.
  async resumeSequence(nowMs: number): Promise<void> {
    this.vetted = false;
    if (this.deps.pollTransport) await this.deps.pollTransport(nowMs);
    if (this.deps.onEndpointRepublish) await this.deps.onEndpointRepublish();
    await this.vet();
    if (this.deps.isWedged?.(nowMs) && this.deps.restartTransport) {
      await this.deps.restartTransport();
    }
  }
}
