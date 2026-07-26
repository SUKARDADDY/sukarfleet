// SPDX-License-Identifier: AGPL-3.0-or-later
// EasyTier transport supervisor + clock vetting. Owns: TOML generation (pure),
// per-peer rx/tx wedge detection, and suspend/resume-aware clock vetting.

import type { FleetConfig } from './types';
import { log, run } from './util';
import { serviceManagerFor } from './platform';

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
}

export interface PeerSample {
  hostname: string;
  rxBytes: number;
  txBytes: number;
}

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

  constructor(
    private readonly cfg: FleetConfig,
    deps: TransportDeps = {},
  ) {
    this.runner = deps.runner ?? run;
  }

  // Polls the loopback RPC portal with two commands (real v2.6.4 interface,
  // verified on the installed binary): `-o json peer list` for peer presence
  // (its rx/tx values are humanized display strings, useless as counters) and
  // `-o json stats` for the raw aggregate traffic_bytes_rx/tx counters that
  // feed wedge detection. Returns null (and logs a warning) on any shape it
  // cannot trust; never throws.
  async pollOnce(nowMs: number): Promise<PeerSample[] | null> {
    const base = [this.cfg.easytier.cliPath, '-p', this.cfg.easytier.rpcAddr, '-o', 'json'];
    const res = await this.runner([...base, 'peer', 'list'], { timeoutMs: 30000 });
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
    for (const entry of parsed) {
      if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) continue;
      const rec = entry as Record<string, unknown>;
      const hostname = typeof rec.hostname === 'string' && rec.hostname.length > 0 ? rec.hostname : null;
      if (!hostname) continue;
      samples.push({ hostname, rxBytes: toFiniteNumber(rec.rx_bytes), txBytes: toFiniteNumber(rec.tx_bytes) });
    }
    const nonLocal = samples.filter((s) => s.hostname !== this.cfg.machine);

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

  // Sums traffic_bytes_rx + traffic_bytes_tx from `easytier-cli stats`.
  private async readStatsTotal(base: string[]): Promise<number | null> {
    const res = await this.runner([...base, 'stats'], { timeoutMs: 30000 });
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

const SUSPEND_JUMP_MS = 60000;
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
    const monoElapsedMs = (monoNs - this.baselineMonoNs) / 1e6;
    const wallElapsedMs = nowMs - this.baselineWallMs;
    const drift = Math.abs(wallElapsedMs - monoElapsedMs);
    if (drift <= SUSPEND_JUMP_MS) return false;

    this.baselineMonoNs = monoNs;
    this.baselineWallMs = nowMs;
    this.vetted = false;
    await this.deps.onResume?.();
    return true;
  }

  async vet(): Promise<boolean> {
    const runner = this.deps.runner ?? run;
    const res = await runner(['timedatectl', 'show', '-p', 'NTPSynchronized', '--value'], { timeoutMs: 10000 });
    const ntpOk = res.code === 0 && res.stdout.trim() === 'yes';
    this.vetted = ntpOk && !this.peerSkewFlagged();
    return this.vetted;
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
