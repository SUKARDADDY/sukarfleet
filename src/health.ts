// SPDX-License-Identifier: AGPL-3.0-or-later
// Sync-health state machine: latched OS alarms + daily all-green digest.
// Pure logic + injectable clock/notifier; no timers of its own — node.ts drives evaluate() on its loop.

import { join } from 'node:path';
import type { FleetConfig, PeerView } from './types';
import { stateDir } from './config';
import { atomicWrite, readJsonFile, log } from './util';
import { osNotify } from './notify';
import type { Urgency } from './notify';

const GITHUB_PUSH_STALE_MS = 6 * 60 * 60 * 1000; // fixed 6h threshold, per brief (not config-driven)

export type FaultClass =
  | 'self-sync-error'
  | 'self-sync-stale'
  | 'github-push-stale'
  | 'peer-offline'
  | 'peer-online-sync-stale'
  | 'transport-wedged'
  | 'anchor-unreachable'
  | 'clock-unvetted'
  | 'admin-credential-stale'
  | 'admin-hostkey-mismatch'
  | 'admin-peer-unreachable'
  | 'admin-lane-unconfigured'
  | 'audit-integrity';

export interface HealthSelf {
  repos: Record<string, { lastSyncOkMs: number | null; lastCommit: string | null; syncError: string | null }>;
  githubPushOkMs: Record<string, number | null>;
  clockVetted: boolean;
  transportWedged: boolean;
  anchorReachable: boolean | null;
  // SSH admin lane (p3-ssh-admin). Optional: absent means the caller is not reporting on the lane
  // at all (a pre-p3 caller, or a health tick that ran before the lane was constructed), which
  // raises no admin faults. Never a password, never a credential value -- booleans and machine
  // names only.
  admin?: {
    credentialStale: boolean;
    hostkeyMismatch: string[]; // peer machines whose pinned host key stopped matching
    unreachablePeers: string[]; // paired peers the lane could not reach this cycle
    configured: boolean; // ssh key + known_hosts present
  };
  // Result of the last audit-log cross-check. Absent means the check did not run this tick (the
  // union file is not opted into unionPaths, or the flush failed) -- which raises nothing, the
  // same way an absent `admin` raises no admin faults. Counts only: a fault message reaches a
  // desktop notification, and an audit detail can carry an argv.
  auditIntegrity?: {
    invalidSignatures: number; // entries whose signature did not verify against the enrolled key
    unverifiableSigners: number; // entries claiming a machine with no enrolled key
    unacceptedForks: number; // same-seq conflicts not in this machine's fork baseline
    seqGaps: number; // missing entries in some machine's sequence
  };
}

export type Notifier = (urgency: Urgency, title: string, body: string) => Promise<void>;

export interface FaultSnapshot {
  key: string;
  faultClass: FaultClass;
  message: string;
  urgency: Urgency;
  firstSeenMs: number;
  lastNotifiedMs: number;
}

export interface HealthStateSnapshot {
  faults: FaultSnapshot[];
  digestDate: string | null;
}

interface ActiveFault {
  key: string;
  faultClass: FaultClass;
  message: string;
  urgency: Urgency;
}

interface PersistedFault {
  faultClass: FaultClass;
  message: string;
  urgency: Urgency;
  firstSeenMs: number;
  lastNotifiedMs: number;
}

interface PersistedState {
  faults: Record<string, PersistedFault>;
  digestDate: string | null;
}

function emptyState(): PersistedState {
  return { faults: {}, digestDate: null };
}

// "47m" under an hour; "1h5m" (no minutes suffix when exact); "2d3h" beyond a day. "unknown" for an
// unbounded gap (e.g. a repo/peer that has never reported a successful sync).
export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms)) return 'unknown';
  const totalMin = Math.max(0, Math.floor(ms / 60000));
  if (totalMin < 60) return `${totalMin}m`;
  const totalHours = Math.floor(totalMin / 60);
  const remMin = totalMin % 60;
  if (totalHours < 24) return remMin > 0 ? `${totalHours}h${remMin}m` : `${totalHours}h`;
  const days = Math.floor(totalHours / 24);
  const remHours = totalHours % 24;
  return remHours > 0 ? `${days}d${remHours}h` : `${days}d`;
}

const URGENCY_RANK: Record<Urgency, number> = { low: 0, normal: 1, critical: 2 };
// Joined multi-fault bodies are capped so one batched notification cannot grow unbounded with the
// fault count -- a desktop toast is a glance, not a report.
const BATCH_BODY_CAP = 800;

interface PendingNotification {
  urgency: Urgency;
  title: string;
  body: string;
}

// Strips the shared "sukarfleet: " brand prefix so a batched body line reads "sync error: <msg>"
// instead of repeating the brand on every item -- the coalesced toast's own title already carries
// it once ("sukarfleet: N fault updates"). Only used building the multi-item body below; the
// single-fault path keeps its title/body exactly as before, untouched.
function shortLabel(title: string): string {
  return title.replace(/^sukarfleet:\s*/, '');
}

function worstUrgency(items: readonly { urgency: Urgency }[]): Urgency {
  let worst: Urgency = 'low';
  for (const item of items) {
    if (URGENCY_RANK[item.urgency] > URGENCY_RANK[worst]) worst = item.urgency;
  }
  return worst;
}

function localDateString(ms: number): string {
  const d = new Date(ms);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

// Worst-case staleness across a peer's self-reported repo stats, from its last verified gossip
// envelope. Null when we have no envelope to derive a number from.
function peerStaleMs(peer: PeerView, now: number): number {
  const env = peer.lastEnvelope;
  if (!env) return Number.POSITIVE_INFINITY;
  const stats = Object.values(env.payload.repos);
  if (stats.length === 0) return Number.POSITIVE_INFINITY;
  let worst = 0;
  for (const stat of stats) {
    const gap = stat.lastSyncOkMs === null ? Number.POSITIVE_INFINITY : now - stat.lastSyncOkMs;
    if (gap > worst) worst = gap;
  }
  return worst;
}

function titleFor(faultClass: FaultClass): string {
  switch (faultClass) {
    case 'self-sync-error':
      return 'sukarfleet: sync error';
    case 'self-sync-stale':
      return 'sukarfleet: sync stale';
    case 'github-push-stale':
      return 'sukarfleet: GitHub push stale';
    case 'peer-offline':
      return 'sukarfleet: peer offline';
    case 'peer-online-sync-stale':
      return 'sukarfleet: peer sync stale';
    case 'transport-wedged':
      return 'sukarfleet: transport wedged';
    case 'anchor-unreachable':
      return 'sukarfleet: anchor unreachable';
    case 'clock-unvetted':
      return 'sukarfleet: clock unvetted';
    case 'admin-credential-stale':
      return 'sukarfleet: admin credential stale';
    case 'admin-hostkey-mismatch':
      return 'sukarfleet: admin host key mismatch';
    case 'admin-peer-unreachable':
      return 'sukarfleet: admin peer unreachable';
    case 'admin-lane-unconfigured':
      return 'sukarfleet: admin lane unconfigured';
    case 'audit-integrity':
      return 'sukarfleet: audit log integrity';
  }
}

function computeActiveFaults(cfg: FleetConfig, self: HealthSelf, peers: PeerView[], now: number): ActiveFault[] {
  const faults: ActiveFault[] = [];
  const staleMs = cfg.thresholds.syncStaleMin * 60000;

  for (const [repoName, stat] of Object.entries(self.repos)) {
    if (stat.syncError) {
      faults.push({
        key: `self-sync-error:${repoName}`,
        faultClass: 'self-sync-error',
        urgency: 'critical',
        message: `${repoName}: sync error — ${stat.syncError}`,
      });
    }
    const gap = stat.lastSyncOkMs === null ? Number.POSITIVE_INFINITY : now - stat.lastSyncOkMs;
    if (gap > staleMs) {
      faults.push({
        key: `self-sync-stale:${repoName}`,
        faultClass: 'self-sync-stale',
        urgency: 'normal',
        message: `${repoName}: sync stale ${formatDuration(gap)}`,
      });
    }
  }

  for (const [repoName, ts] of Object.entries(self.githubPushOkMs)) {
    const gap = ts === null ? Number.POSITIVE_INFINITY : now - ts;
    if (gap > GITHUB_PUSH_STALE_MS) {
      faults.push({
        key: `github-push-stale:${repoName}`,
        faultClass: 'github-push-stale',
        urgency: 'normal',
        message: `${repoName}: GitHub push stale ${formatDuration(gap)}`,
      });
    }
  }

  for (const peer of peers) {
    if (!peer.online) {
      faults.push({
        key: `peer-offline:${peer.name}`,
        faultClass: 'peer-offline',
        urgency: 'critical',
        message: `${peer.name}: offline`,
      });
    } else if (peer.syncStale) {
      const gap = peerStaleMs(peer, now);
      faults.push({
        key: `peer-online-sync-stale:${peer.name}`,
        faultClass: 'peer-online-sync-stale',
        urgency: 'normal',
        message: `${peer.name}: online, sync stale ${formatDuration(gap)}`,
      });
    }
  }

  if (self.transportWedged) {
    faults.push({
      key: 'transport-wedged',
      faultClass: 'transport-wedged',
      urgency: 'critical',
      message: 'transport wedged — restart triggered',
    });
  }

  if (cfg.role === 'roamer' && self.anchorReachable === false) {
    faults.push({
      key: 'anchor-unreachable',
      faultClass: 'anchor-unreachable',
      urgency: 'critical',
      message: 'anchor unreachable',
    });
  }

  if (!self.clockVetted) {
    faults.push({
      key: 'clock-unvetted',
      faultClass: 'clock-unvetted',
      urgency: 'low',
      message: 'clock not vetted (NTP unsynced or suspend/resume jump detected)',
    });
  }

  const admin = self.admin;
  if (admin) {
    // Critical: a stale credential means every admin call on this machine now fails, and the fix
    // is a human retyping a password in the GUI. Silence here would look like an unexplained
    // refusal at the worst moment.
    if (admin.credentialStale) {
      faults.push({
        key: 'admin-credential-stale',
        faultClass: 'admin-credential-stale',
        urgency: 'critical',
        message: 'admin credential rejected by sudo — re-enter it in the GUI',
      });
    }
    // Critical and never auto-healed: a changed host key is either a reinstall or an
    // interception, and the lane refuses to connect until a human says which.
    for (const machine of admin.hostkeyMismatch) {
      faults.push({
        key: `admin-hostkey-mismatch:${machine}`,
        faultClass: 'admin-hostkey-mismatch',
        urgency: 'critical',
        message: `${machine}: admin host key does not match the pinned one`,
      });
    }
    for (const machine of admin.unreachablePeers) {
      faults.push({
        key: `admin-peer-unreachable:${machine}`,
        faultClass: 'admin-peer-unreachable',
        urgency: 'normal',
        message: `${machine}: admin lane unreachable`,
      });
    }
    if (!admin.configured) {
      faults.push({
        key: 'admin-lane-unconfigured',
        faultClass: 'admin-lane-unconfigured',
        urgency: 'normal',
        message: 'admin lane enabled but not configured (missing ssh key or known_hosts)',
      });
    }
  }

  // Audit-log integrity. A signature that does not verify is the one condition here that means
  // somebody edited the replicated log: the entries are signed by the machine that minted them,
  // so a bad signature is not drift, it is a rewrite. Separate keys per condition, so a real
  // forgery is not hidden behind an already-firing gap alarm.
  const audit = self.auditIntegrity;
  if (audit) {
    if (audit.invalidSignatures > 0) {
      faults.push({
        key: 'audit-integrity:signature',
        faultClass: 'audit-integrity',
        urgency: 'critical',
        message: `${audit.invalidSignatures} audit entr${audit.invalidSignatures === 1 ? 'y' : 'ies'} failed signature verification — the replicated log has been edited`,
      });
    }
    if (audit.unacceptedForks > 0) {
      faults.push({
        key: 'audit-integrity:fork',
        faultClass: 'audit-integrity',
        urgency: 'critical',
        message: `${audit.unacceptedForks} audit seq fork(s) not in this machine's baseline — two signed entries claim one sequence number`,
      });
    }
    if (audit.unverifiableSigners > 0) {
      faults.push({
        key: 'audit-integrity:signer',
        faultClass: 'audit-integrity',
        urgency: 'normal',
        message: `${audit.unverifiableSigners} audit entr${audit.unverifiableSigners === 1 ? 'y' : 'ies'} from a machine with no enrolled key`,
      });
    }
    if (audit.seqGaps > 0) {
      faults.push({
        key: 'audit-integrity:gap',
        faultClass: 'audit-integrity',
        urgency: 'normal',
        message: `${audit.seqGaps} gap(s) in an audit sequence — entries are missing from the log`,
      });
    }
  }

  return faults;
}

export class Health {
  private readonly cfg: FleetConfig;
  private readonly notifier: Notifier;
  private readonly statePath: string;
  private state: PersistedState = emptyState();
  private readonly ready: Promise<void>;

  constructor(cfg: FleetConfig, notifier: Notifier = osNotify) {
    this.cfg = cfg;
    this.notifier = notifier;
    this.statePath = join(stateDir(), 'health.json');
    this.ready = this.load();
  }

  private async load(): Promise<void> {
    const loaded = await readJsonFile<PersistedState>(this.statePath);
    if (loaded && typeof loaded === 'object' && loaded.faults) {
      this.state = { faults: loaded.faults, digestDate: loaded.digestDate ?? null };
    }
  }

  private async persist(): Promise<void> {
    await atomicWrite(this.statePath, JSON.stringify(this.state));
  }

  private async safeNotify(urgency: Urgency, title: string, body: string): Promise<void> {
    try {
      await this.notifier(urgency, title, body);
    } catch (err) {
      log('error', 'health: notifier threw', { error: String(err) });
    }
  }

  // Sends at most one OS notification per evaluate() call, however many fault transitions it saw.
  // A single-item tick keeps today's exact title/body (no format change for the common case); a
  // multi-item tick coalesces into one "N fault updates" notification, worst urgency wins.
  // notifications.os:false skips the flush entirely -- e.g. a machine running the tray app, which
  // polls the daemon's fault state itself and would otherwise double-notify.
  private async flushNotifications(pending: PendingNotification[]): Promise<void> {
    if (!this.cfg.notifications.os) return;
    if (pending.length === 0) return;
    if (pending.length === 1) {
      const only = pending[0]!;
      await this.safeNotify(only.urgency, only.title, only.body);
      return;
    }
    const urgency = worstUrgency(pending);
    const title = `sukarfleet: ${pending.length} fault updates`;
    // Each item prefixed with its own short label (Class C: a 5-fault toast should name its fault
    // classes, not just say "5 fault updates"), capped AFTER joining so the cap bounds the whole
    // notification body regardless of how many items contributed to it.
    const body = pending
      .map((p) => `${shortLabel(p.title)}: ${p.body}`)
      .join('; ')
      .slice(0, BATCH_BODY_CAP);
    await this.safeNotify(urgency, title, body);
  }

  async evaluate(now: number, self: HealthSelf, peers: PeerView[]): Promise<void> {
    await this.ready;
    const repeatMs = this.cfg.thresholds.alarmRepeatMin * 60000;
    const active = computeActiveFaults(this.cfg, self, peers, now);
    const activeKeys = new Set(active.map((f) => f.key));
    let changed = false;
    const pending: PendingNotification[] = [];

    for (const fault of active) {
      const existing = this.state.faults[fault.key];
      if (!existing) {
        this.state.faults[fault.key] = {
          faultClass: fault.faultClass,
          message: fault.message,
          urgency: fault.urgency,
          firstSeenMs: now,
          lastNotifiedMs: now,
        };
        changed = true;
        pending.push({ urgency: fault.urgency, title: titleFor(fault.faultClass), body: fault.message });
        continue;
      }
      if (existing.message !== fault.message) {
        existing.message = fault.message;
        changed = true;
      }
      if (now - existing.lastNotifiedMs >= repeatMs) {
        existing.lastNotifiedMs = now;
        changed = true;
        pending.push({ urgency: fault.urgency, title: titleFor(fault.faultClass), body: fault.message });
      }
    }

    for (const key of Object.keys(this.state.faults)) {
      if (activeKeys.has(key)) continue;
      const cleared = this.state.faults[key]!;
      delete this.state.faults[key];
      changed = true;
      pending.push({
        urgency: 'normal',
        title: `sukarfleet: recovered — ${titleFor(cleared.faultClass)}`,
        body: `${cleared.message} — cleared`,
      });
    }

    if (active.length === 0) {
      const today = localDateString(now);
      if (this.state.digestDate !== today) {
        this.state.digestDate = today;
        changed = true;
        pending.push({ urgency: 'low', title: 'sukarfleet: all green', body: 'No active faults.' });
      }
    }

    await this.flushNotifications(pending);
    if (changed) await this.persist();
  }

  async getState(): Promise<HealthStateSnapshot> {
    await this.ready;
    const faults = Object.entries(this.state.faults)
      .map(([key, f]) => ({ key, ...f }))
      .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
    return { faults, digestDate: this.state.digestDate };
  }
}
