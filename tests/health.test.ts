// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Health, formatDuration } from '../src/health';
import type { HealthSelf } from '../src/health';
import type { Urgency } from '../src/notify';
import { defaultConfig } from '../src/config';
import type { FleetConfig, PeerView, GossipEnvelope } from '../src/types';

interface NotifyCall {
  urgency: Urgency;
  title: string;
  body: string;
}

function fakeNotifier(): { calls: NotifyCall[]; notifier: (u: Urgency, t: string, b: string) => Promise<void> } {
  const calls: NotifyCall[] = [];
  return {
    calls,
    notifier: async (urgency, title, body) => {
      calls.push({ urgency, title, body });
    },
  };
}

function healthyCfg(overrides: Partial<FleetConfig['thresholds']> = {}, role: FleetConfig['role'] = 'anchor'): FleetConfig {
  const cfg = defaultConfig('alpha');
  cfg.role = role;
  cfg.thresholds = { ...cfg.thresholds, ...overrides };
  return cfg;
}

function healthySelf(): HealthSelf {
  return {
    repos: {},
    githubPushOkMs: {},
    clockVetted: true,
    transportWedged: false,
    anchorReachable: null,
  };
}

function envelopeWithRepoStat(machine: string, tsMs: number, lastSyncOkMs: number | null): GossipEnvelope {
  return {
    v: 1,
    machine,
    tsMs,
    seq: 1,
    payload: {
      repos: { repoA: { lastSyncOkMs, lastCommit: 'deadbeef', syncError: null } },
      githubPushOkMs: {},
      clockMs: tsMs,
      flags: [],
    },
    sigB64: 'test-sig',
  };
}

let prevState: string | undefined;
let tmpDir: string;

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), 'sukarfleet-health-test-'));
  prevState = process.env.SUKARFLEET_STATE;
  process.env.SUKARFLEET_STATE = tmpDir;
});

afterEach(async () => {
  if (prevState === undefined) delete process.env.SUKARFLEET_STATE;
  else process.env.SUKARFLEET_STATE = prevState;
  await rm(tmpDir, { recursive: true, force: true });
});

describe('formatDuration', () => {
  test('renders minutes under an hour', () => {
    expect(formatDuration(47 * 60000)).toBe('47m');
  });
  test('renders hours and minutes', () => {
    expect(formatDuration(65 * 60000)).toBe('1h5m');
  });
  test('unknown for non-finite gaps', () => {
    expect(formatDuration(Number.POSITIVE_INFINITY)).toBe('unknown');
  });
});

describe('Health.evaluate: audit integrity', () => {
  const t0 = Date.UTC(2026, 0, 1, 12, 0, 0);

  test('an absent verdict raises nothing (the check did not run)', async () => {
    const { calls, notifier } = fakeNotifier();
    const health = new Health(healthyCfg({}), notifier);
    await health.evaluate(t0, healthySelf(), []);
    expect(calls.filter((c) => c.title.includes('audit'))).toHaveLength(0);
  });

  test('a clean verdict raises nothing', async () => {
    const { calls, notifier } = fakeNotifier();
    const health = new Health(healthyCfg({}), notifier);
    const self = healthySelf();
    self.auditIntegrity = { invalidSignatures: 0, unverifiableSigners: 0, unacceptedForks: 0, seqGaps: 0 };
    await health.evaluate(t0, self, []);
    expect(calls.filter((c) => c.title.includes('audit'))).toHaveLength(0);
  });

  test('a bad signature is critical — somebody edited the replicated log', async () => {
    const { calls, notifier } = fakeNotifier();
    const health = new Health(healthyCfg({}), notifier);
    const self = healthySelf();
    self.auditIntegrity = { invalidSignatures: 2, unverifiableSigners: 0, unacceptedForks: 0, seqGaps: 0 };
    await health.evaluate(t0, self, []);
    const audit = calls.filter((c) => c.title.includes('audit'));
    expect(audit).toHaveLength(1);
    expect(audit[0]!.urgency).toBe('critical');
    expect(audit[0]!.body).toContain('2 audit entries failed signature verification');
  });

  test('signature and gap faults latch separately, so a forgery is not hidden behind a gap', async () => {
    const { calls, notifier } = fakeNotifier();
    const health = new Health(healthyCfg({}), notifier);
    const self = healthySelf();
    self.auditIntegrity = { invalidSignatures: 0, unverifiableSigners: 0, unacceptedForks: 0, seqGaps: 1 };
    await health.evaluate(t0, self, []);
    expect(calls.filter((c) => c.title.includes('audit'))).toHaveLength(1);

    // A real forgery now appears while the gap fault is still latched: it must still notify.
    self.auditIntegrity = { invalidSignatures: 1, unverifiableSigners: 0, unacceptedForks: 0, seqGaps: 1 };
    await health.evaluate(t0 + 1000, self, []);
    const audit = calls.filter((c) => c.title.includes('audit'));
    expect(audit).toHaveLength(2);
    expect(audit[1]!.urgency).toBe('critical');
  });
});

describe('Health.evaluate', () => {
  test('fault latches on first detection and re-raises on schedule, not before', async () => {
    const cfg = healthyCfg({ alarmRepeatMin: 10 });
    const { calls, notifier } = fakeNotifier();
    const health = new Health(cfg, notifier);

    const t0 = Date.UTC(2026, 0, 1, 12, 0, 0);
    const self = healthySelf();
    self.repos.repoA = { lastSyncOkMs: t0, lastCommit: 'abc', syncError: 'boom' };

    await health.evaluate(t0, self, []);
    expect(calls.length).toBe(1);
    expect(calls[0]!.urgency).toBe('critical');
    expect(calls[0]!.body).toContain('boom');

    // 5 minutes later: still within the 10-minute repeat window, no re-notify.
    await health.evaluate(t0 + 5 * 60000, self, []);
    expect(calls.length).toBe(1);

    // Past the repeat window: latch re-raises.
    await health.evaluate(t0 + 10 * 60000 + 1, self, []);
    expect(calls.length).toBe(2);
    expect(calls[1]!.body).toContain('boom');
  });

  // P5: a cleared fault and the same-tick all-green digest are two notification-worthy events
  // landing in one evaluate() call, so they coalesce into a single batched notification instead
  // of firing as two separate calls.
  test('recovery notice and the same-tick all-green digest coalesce into one batch', async () => {
    const cfg = healthyCfg({ alarmRepeatMin: 30 });
    const { calls, notifier } = fakeNotifier();
    const health = new Health(cfg, notifier);

    const t0 = Date.UTC(2026, 0, 1, 12, 0, 0);
    const self = healthySelf();
    self.repos.repoA = { lastSyncOkMs: t0, lastCommit: 'abc', syncError: 'boom' };
    await health.evaluate(t0, self, []);
    expect(calls.length).toBe(1); // single fault, unchanged format
    expect(calls[0]!.title).toBe('sukarfleet: sync error');

    const healed = healthySelf();
    healed.repos.repoA = { lastSyncOkMs: t0, lastCommit: 'abc', syncError: null };
    await health.evaluate(t0 + 60000, healed, []);
    expect(calls.length).toBe(2);
    const batch = calls[1]!;
    expect(batch.title).toBe('sukarfleet: 2 fault updates');
    expect(batch.body).toContain('cleared');
    expect(batch.body).toContain('No active faults');
    // Restores the recovery-title guard P5's coalescing lost: the cleared item's
    // "recovered — ..." title format must still be legible inside the batched body.
    expect(batch.body).toContain('recovered');
    // BLOCKING (Class C): the batched item is genuinely mixed urgency -- recovery is 'normal',
    // the all-green digest is 'low' -- and the batch must report the WORST of the two, 'normal',
    // not silently default to the digest's 'low'.
    expect(batch.urgency).toBe('normal');

    // Staying healthy shouldn't re-fire a second recovery notice or digest.
    await health.evaluate(t0 + 120000, healed, []);
    expect(calls.length).toBe(2);
  });

  test('daily all-green digest fires once per calendar day, only while green', async () => {
    const cfg = healthyCfg();
    const { calls, notifier } = fakeNotifier();
    const health = new Health(cfg, notifier);
    const self = healthySelf();

    const day1 = Date.UTC(2026, 0, 1, 9, 0, 0);
    await health.evaluate(day1, self, []);
    expect(calls.filter((c) => c.title.includes('all green')).length).toBe(1);

    // Later same day: no second digest.
    await health.evaluate(day1 + 3 * 3600_000, self, []);
    expect(calls.filter((c) => c.title.includes('all green')).length).toBe(1);

    // A fault appears: still no digest for that evaluation.
    const faulted = healthySelf();
    faulted.transportWedged = true;
    await health.evaluate(day1 + 4 * 3600_000, faulted, []);
    expect(calls.filter((c) => c.title.includes('all green')).length).toBe(1);

    // Fault clears in its own tick, same day: a recovery notice, not a digest (digestDate is
    // already today's). Isolates the recovery event from the next digest so day2 below is not a
    // coalesced batch -- that combination is covered by the recovery+digest test above.
    await health.evaluate(day1 + 5 * 3600_000, self, []);
    expect(calls.filter((c) => c.title.includes('all green')).length).toBe(1);

    // Next calendar day, healthy again: digest fires.
    const day2 = Date.UTC(2026, 0, 2, 9, 0, 0);
    await health.evaluate(day2, self, []);
    expect(calls.filter((c) => c.title.includes('all green')).length).toBe(2);
  });

  test('persists latch state across a simulated restart (new Health instance, same state dir)', async () => {
    const cfg = healthyCfg({ alarmRepeatMin: 10 });
    const t0 = Date.UTC(2026, 0, 1, 12, 0, 0);
    const self = healthySelf();
    self.repos.repoA = { lastSyncOkMs: t0, lastCommit: 'abc', syncError: 'boom' };

    const first = fakeNotifier();
    const healthA = new Health(cfg, first.notifier);
    await healthA.evaluate(t0, self, []);
    expect(first.calls.length).toBe(1);

    // Simulate a process restart: fresh Health instance, same on-disk state dir.
    const second = fakeNotifier();
    const healthB = new Health(cfg, second.notifier);
    await healthB.evaluate(t0 + 60000, self, []);
    // Still within the repeat window relative to the persisted lastNotifiedMs -> no re-notify.
    expect(second.calls.length).toBe(0);

    await healthB.evaluate(t0 + 11 * 60000, self, []);
    expect(second.calls.length).toBe(1);

    const state = await healthB.getState();
    expect(state.faults.length).toBe(1);
    expect(state.faults[0]!.key).toBe('self-sync-error:repoA');
  });

  test('peer online-but-stale wording matches "online, sync stale 47m"', async () => {
    const cfg = healthyCfg();
    const { calls, notifier } = fakeNotifier();
    const health = new Health(cfg, notifier);
    const self = healthySelf();

    const t0 = Date.UTC(2026, 0, 1, 12, 0, 0);
    const lastSyncOkMs = t0 - 47 * 60000;
    const peer: PeerView = {
      name: 'beta',
      lastSeenMs: t0 - 1000,
      lastEnvelope: envelopeWithRepoStat('beta', t0 - 1000, lastSyncOkMs),
      online: true,
      syncStale: true,
    };

    await health.evaluate(t0, self, [peer]);
    expect(calls.length).toBe(1);
    expect(calls[0]!.body).toBe('beta: online, sync stale 47m');
    expect(calls[0]!.urgency).toBe('normal');
  });

  test('offline peer produces a distinct peer-offline fault, not sync-stale wording', async () => {
    const cfg = healthyCfg();
    const { calls, notifier } = fakeNotifier();
    const health = new Health(cfg, notifier);
    const self = healthySelf();
    const t0 = Date.UTC(2026, 0, 1, 12, 0, 0);
    const peer: PeerView = {
      name: 'beta',
      lastSeenMs: t0 - 3600_000,
      lastEnvelope: null,
      online: false,
      syncStale: true,
    };
    await health.evaluate(t0, self, [peer]);
    expect(calls.length).toBe(1);
    expect(calls[0]!.body).toBe('beta: offline');
    expect(calls[0]!.urgency).toBe('critical');
  });

  test('anchor-unreachable only raised for roamer role', async () => {
    const anchorCfg = healthyCfg({}, 'anchor');
    const { calls: anchorCalls, notifier: anchorNotifier } = fakeNotifier();
    const anchorHealth = new Health(anchorCfg, anchorNotifier);
    const self = healthySelf();
    self.anchorReachable = false;
    const t0 = Date.UTC(2026, 0, 1, 12, 0, 0);
    await anchorHealth.evaluate(t0, self, []);
    expect(anchorCalls.some((c) => c.title.includes('anchor unreachable'))).toBe(false);

    const roamerCfg = healthyCfg({}, 'roamer');
    const { calls: roamerCalls, notifier: roamerNotifier } = fakeNotifier();
    const roamerHealth = new Health(roamerCfg, roamerNotifier);
    await roamerHealth.evaluate(t0, self, []);
    expect(roamerCalls.some((c) => c.title.includes('anchor unreachable'))).toBe(true);
  });

  test('anchor-unreachable names the transport cause when the daemon knows it', async () => {
    const cfg = healthyCfg({}, 'roamer');
    const { calls, notifier } = fakeNotifier();
    const health = new Health(cfg, notifier);
    const self = healthySelf();
    self.anchorReachable = false;
    self.transportFault = 'connected-without-peer';
    await health.evaluate(Date.UTC(2026, 0, 1, 12, 0, 0), self, []);
    expect(calls.some((c) => c.title.includes('anchor unreachable'))).toBe(true);
    const state = await health.getState();
    expect(state.faults.some((f) => f.message === 'anchor unreachable (connected-without-peer)')).toBe(true);
  });

  test('an ok or absent transport fault leaves the plain message untouched', async () => {
    for (const fault of [undefined, null, 'ok']) {
      const cfg = healthyCfg({}, 'roamer');
      const { notifier } = fakeNotifier();
      const health = new Health(cfg, notifier);
      const self = healthySelf();
      self.anchorReachable = false;
      self.transportFault = fault as string | null | undefined;
      await health.evaluate(Date.UTC(2026, 0, 1, 12, 0, 0), self, []);
      const state = await health.getState();
      expect(state.faults.some((f) => f.message === 'anchor unreachable')).toBe(true);
    }
  });

  test('getState exposes faults with firstSeenMs/lastNotifiedMs and digest date', async () => {
    const cfg = healthyCfg();
    const { notifier } = fakeNotifier();
    const health = new Health(cfg, notifier);
    const self = healthySelf();
    const t0 = Date.UTC(2026, 0, 1, 12, 0, 0);
    await health.evaluate(t0, self, []);
    const state = await health.getState();
    expect(state.faults).toEqual([]);
    expect(state.digestDate).toBe('2026-01-01');
  });
});

describe('Health.evaluate: notification coalescing (P5) + notifications.os knob', () => {
  const t0 = Date.UTC(2026, 0, 1, 12, 0, 0);

  test('3 simultaneous faults coalesce into exactly one call', async () => {
    const cfg = healthyCfg();
    const { calls, notifier } = fakeNotifier();
    const health = new Health(cfg, notifier);
    const self = healthySelf();
    self.repos.repoA = { lastSyncOkMs: t0, lastCommit: 'a', syncError: 'boom-a' };
    self.repos.repoB = { lastSyncOkMs: t0, lastCommit: 'b', syncError: 'boom-b' };
    self.transportWedged = true;

    await health.evaluate(t0, self, []);

    expect(calls.length).toBe(1);
    expect(calls[0]!.title).toBe('sukarfleet: 3 fault updates');
    expect(calls[0]!.urgency).toBe('critical');
    expect(calls[0]!.body).toContain('boom-a');
    expect(calls[0]!.body).toContain('boom-b');
    expect(calls[0]!.body).toContain('wedged');
  });

  // BLOCKING (Class C): a genuinely mixed-urgency 3-fault batch -- two critical, one merely 'low'
  // -- must still report 'critical' overall. The test above happened to mix only same-urgency
  // (critical) faults, which cannot catch worstUrgency defaulting to the wrong item.
  test('3 mixed-urgency faults (2 critical + 1 low) still coalesce to critical overall', async () => {
    const cfg = healthyCfg();
    const { calls, notifier } = fakeNotifier();
    const health = new Health(cfg, notifier);
    const self = healthySelf();
    self.repos.repoA = { lastSyncOkMs: t0, lastCommit: 'a', syncError: 'boom-a' }; // critical
    self.transportWedged = true; // critical
    self.clockVetted = false; // low, non-critical

    await health.evaluate(t0, self, []);

    expect(calls.length).toBe(1);
    expect(calls[0]!.title).toBe('sukarfleet: 3 fault updates');
    expect(calls[0]!.urgency).toBe('critical');
    expect(calls[0]!.body).toContain('boom-a');
    expect(calls[0]!.body).toContain('wedged');
    expect(calls[0]!.body).toContain('clock not vetted');
  });

  // BATCH_BODY_CAP: a batch built from enough long-message faults must never exceed the cap, and
  // the cap is applied AFTER joining (so it can truncate mid-item, not just drop whole items).
  test('a large batch (10 long-message faults) caps the joined body at BATCH_BODY_CAP', async () => {
    const cfg = healthyCfg();
    const { calls, notifier } = fakeNotifier();
    const health = new Health(cfg, notifier);
    const self = healthySelf();
    const longMsg = 'x'.repeat(120);
    for (let i = 0; i < 10; i++) {
      self.repos[`repo${i}`] = { lastSyncOkMs: t0, lastCommit: 'a', syncError: longMsg };
    }

    await health.evaluate(t0, self, []);

    expect(calls.length).toBe(1);
    expect(calls[0]!.title).toBe('sukarfleet: 10 fault updates');
    expect(calls[0]!.body.length).toBe(800);
    // Truncation is a plain .slice(0, 800) of the joined, per-item-labeled string -- verify the
    // exact byte-for-byte cap behavior, not just the length.
    const expectedFull = Object.keys(self.repos)
      .map((repoName) => `sync error: ${repoName}: sync error — ${longMsg}`)
      .join('; ');
    expect(calls[0]!.body).toBe(expectedFull.slice(0, 800));
  });

  test('a single fault keeps today\'s exact title/body format, unchanged', async () => {
    const cfg = healthyCfg();
    const { calls, notifier } = fakeNotifier();
    const health = new Health(cfg, notifier);
    const self = healthySelf();
    self.repos.repoA = { lastSyncOkMs: t0, lastCommit: 'a', syncError: 'boom' };

    await health.evaluate(t0, self, []);

    expect(calls.length).toBe(1);
    expect(calls[0]!.title).toBe('sukarfleet: sync error');
    expect(calls[0]!.body).toBe('repoA: sync error — boom');
  });

  test('notifications.os:false suppresses every OS notification, even multi-fault ticks', async () => {
    const cfg = healthyCfg();
    cfg.notifications = { os: false };
    const { calls, notifier } = fakeNotifier();
    const health = new Health(cfg, notifier);
    const self = healthySelf();
    self.repos.repoA = { lastSyncOkMs: t0, lastCommit: 'a', syncError: 'boom' };
    self.transportWedged = true;

    await health.evaluate(t0, self, []);

    expect(calls.length).toBe(0);
    // notifications.os:false must ONLY gate the OS notification flush -- the fault state machine
    // underneath (what a client like the tray app polls instead) has to keep transitioning and
    // persisting exactly as if notifications were on.
    const state = await health.getState();
    expect(state.faults.map((f) => f.key).sort()).toEqual(['self-sync-error:repoA', 'transport-wedged']);
    expect(state.faults.find((f) => f.key === 'transport-wedged')!.urgency).toBe('critical');

    // A second evaluate() with the faults cleared must still walk the 'recovered' branch: the
    // entries are deleted from state even though no notification is ever sent to see it happen.
    const healed = healthySelf();
    await health.evaluate(t0 + 60000, healed, []);
    expect(calls.length).toBe(0);
    const healedState = await health.getState();
    expect(healedState.faults).toEqual([]);
  });

  test('a cleared fault and a newly entered fault in the same tick coalesce into one batch', async () => {
    const cfg = healthyCfg();
    const { calls, notifier } = fakeNotifier();
    const health = new Health(cfg, notifier);

    const self = healthySelf();
    self.repos.repoA = { lastSyncOkMs: t0, lastCommit: 'abc', syncError: 'boom' };
    await health.evaluate(t0, self, []);
    expect(calls.length).toBe(1);

    const next = healthySelf();
    next.repos.repoA = { lastSyncOkMs: t0 + 60000, lastCommit: 'abc', syncError: null }; // clears
    next.transportWedged = true; // new fault, same tick
    await health.evaluate(t0 + 60000, next, []);

    expect(calls.length).toBe(2);
    expect(calls[1]!.title).toBe('sukarfleet: 2 fault updates');
    expect(calls[1]!.body).toContain('cleared');
    expect(calls[1]!.body).toContain('wedged');
  });
});
