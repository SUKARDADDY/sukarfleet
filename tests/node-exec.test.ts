// SPDX-License-Identifier: AGPL-3.0-or-later
// Pure decision points extracted from node.ts's loops, pinned here without spinning up the daemon
// (the import.meta.main guard on node.ts is what makes importing it for these functions safe).

import { describe, expect, test } from 'bun:test';
import {
  anchorDaemonOnlineFromGossip,
  buildAdminLaneView,
  nextAnchorDownStreak,
  nextWatchdogGrace,
  shouldPushThisTick,
  TAKEOVER_STREAK,
  watchdogShouldPing,
} from '../src/node';
import { clockDriftMs } from '../src/util';
import { SUSPEND_JUMP_MS } from '../src/transport';
import { defaultConfig } from '../src/config';

describe('shouldPushThisTick (P3 single-pusher policy, Class A: gossip-keyed takeover)', () => {
  test('anchor always pushes, regardless of anchorDaemonOnline or streak', () => {
    for (const online of [true, false, null] as const) {
      for (const streak of [0, 1, TAKEOVER_STREAK]) {
        expect(shouldPushThisTick('anchor', online, streak)).toBe(true);
      }
    }
  });

  test('roamer with no configured peers (anchorDaemonOnline=null) always pushes -- restores pre-P3 solo behavior', () => {
    for (const streak of [0, 1, TAKEOVER_STREAK]) {
      expect(shouldPushThisTick('roamer', null, streak)).toBe(true);
    }
  });

  test('roamer with the anchor daemon online never pushes, regardless of streak', () => {
    for (const streak of [0, 1, TAKEOVER_STREAK]) {
      expect(shouldPushThisTick('roamer', true, streak)).toBe(false);
    }
  });

  test('roamer with the anchor daemon offline pushes only once streak reaches TAKEOVER_STREAK', () => {
    expect(shouldPushThisTick('roamer', false, 0)).toBe(false);
    expect(shouldPushThisTick('roamer', false, 1)).toBe(false);
    expect(shouldPushThisTick('roamer', false, TAKEOVER_STREAK - 1)).toBe(false);
    expect(shouldPushThisTick('roamer', false, TAKEOVER_STREAK)).toBe(true);
    expect(shouldPushThisTick('roamer', false, TAKEOVER_STREAK + 1)).toBe(true);
  });

  // Full role x online x streak table, so every combination the brief calls out is pinned in one
  // place, not just the hand-picked cases above.
  const cases: Array<{ role: 'anchor' | 'roamer'; online: boolean | null; streak: number; want: boolean }> = [];
  for (const role of ['anchor', 'roamer'] as const) {
    for (const online of [true, false, null] as const) {
      for (const streak of [0, 1, TAKEOVER_STREAK]) {
        let want: boolean;
        if (role === 'anchor') want = true;
        else if (online === null) want = true;
        else want = online === false && streak >= TAKEOVER_STREAK;
        cases.push({ role, online, streak, want });
      }
    }
  }
  for (const { role, online, streak, want } of cases) {
    test(`role=${role} anchorDaemonOnline=${online} streak=${streak} -> ${want}`, () => {
      expect(shouldPushThisTick(role, online, streak)).toBe(want);
    });
  }
});

describe('anchorDaemonOnlineFromGossip (Class A: anchor liveness from gossip, not the mesh peer table)', () => {
  test('no configured peers -> null (nothing to distrust)', () => {
    expect(anchorDaemonOnlineFromGossip([])).toBeNull();
  });

  test('at least one configured peer online -> true', () => {
    expect(anchorDaemonOnlineFromGossip([{ online: false }, { online: true }])).toBe(true);
  });

  test('every configured peer offline -> false (no role marker on PeerConfig, so "all offline" is the anchor-down signal)', () => {
    expect(anchorDaemonOnlineFromGossip([{ online: false }])).toBe(false);
    expect(anchorDaemonOnlineFromGossip([{ online: false }, { online: false }])).toBe(false);
  });
});

describe('nextAnchorDownStreak (P3 roamer takeover debounce)', () => {
  test('increments on consecutive false reads', () => {
    let streak = 0;
    streak = nextAnchorDownStreak(streak, false);
    expect(streak).toBe(1);
    streak = nextAnchorDownStreak(streak, false);
    expect(streak).toBe(2);
    streak = nextAnchorDownStreak(streak, false);
    expect(streak).toBe(3);
  });

  test('resets to 0 the instant a tick sees true', () => {
    let streak = nextAnchorDownStreak(0, false);
    streak = nextAnchorDownStreak(streak, false);
    expect(streak).toBe(2);
    streak = nextAnchorDownStreak(streak, true);
    expect(streak).toBe(0);
  });

  test('resets to 0 on null too, not just recovery (true)', () => {
    let streak = nextAnchorDownStreak(0, false);
    streak = nextAnchorDownStreak(streak, false);
    expect(streak).toBe(2);
    streak = nextAnchorDownStreak(streak, null);
    expect(streak).toBe(0);
  });

  test('one lost poll is not enough to cross the takeover threshold, two is', () => {
    let streak = 0;
    streak = nextAnchorDownStreak(streak, false);
    expect(streak >= 2).toBe(false);
    streak = nextAnchorDownStreak(streak, false);
    expect(streak >= 2).toBe(true);
  });

  test('a sighting mid-streak restarts the count, not resumes it', () => {
    let streak = nextAnchorDownStreak(0, false);
    streak = nextAnchorDownStreak(streak, false);
    streak = nextAnchorDownStreak(streak, false);
    expect(streak).toBe(3);
    streak = nextAnchorDownStreak(streak, true);
    expect(streak).toBe(0);
    streak = nextAnchorDownStreak(streak, false);
    expect(streak >= 2).toBe(false); // restarted, does not carry over the prior 3
  });
});

describe('clockDriftMs (P4 watchdog suspend-awareness)', () => {
  test('ordinary elapsed time: mono and wall agree, drift ~0', () => {
    const baselineMonoNs = 0;
    const baselineWallMs = 1_000_000;
    // 20s of monotonic and 20s of wall time both elapsed -- a normal tick.
    const drift = clockDriftMs(baselineMonoNs, baselineWallMs, 20_000 * 1e6, 1_000_000 + 20_000);
    expect(drift).toBe(0);
  });

  test('synthetic 90-minute suspend: monotonic barely moves, wall jumps 90 minutes', () => {
    const baselineMonoNs = 0;
    const baselineWallMs = 1_000_000;
    const NINETY_MIN_MS = 90 * 60 * 1000;
    // Monotonic time is frozen (or nearly so) across a suspend; only a few ms of scheduler jitter
    // pass before the process is unfrozen and this tick runs.
    const nowMonoNs = 5 * 1e6; // 5ms of monotonic progress
    const nowWallMs = baselineWallMs + NINETY_MIN_MS;
    const drift = clockDriftMs(baselineMonoNs, baselineWallMs, nowMonoNs, nowWallMs);
    expect(drift).toBeCloseTo(NINETY_MIN_MS - 5, 0);
    expect(drift).toBeGreaterThan(SUSPEND_JUMP_MS);
  });

  test('a normal tick pair never crosses SUSPEND_JUMP_MS', () => {
    const baselineMonoNs = 123_456_789;
    const baselineWallMs = 2_000_000;
    // A watchdog tick a few seconds later: mono and wall elapse together.
    const elapsedMs = 5000;
    const drift = clockDriftMs(baselineMonoNs, baselineWallMs, baselineMonoNs + elapsedMs * 1e6, baselineWallMs + elapsedMs);
    expect(drift).toBeLessThan(SUSPEND_JUMP_MS);
  });

  test('is symmetric: a backward wall-clock step also reads as drift', () => {
    const baselineMonoNs = 0;
    const baselineWallMs = 1_000_000;
    // Monotonic keeps moving forward but wall time was stepped backward (NTP correction) --
    // the divergence still crosses the threshold and must not cancel out to a negative drift.
    const drift = clockDriftMs(baselineMonoNs, baselineWallMs, 10_000 * 1e6, baselineWallMs - 5 * 60 * 1000);
    expect(drift).toBeGreaterThan(SUSPEND_JUMP_MS);
  });
});

describe('watchdogShouldPing (P4 watchdog suspend-awareness)', () => {
  test('fresh marks always ping, grace or not', () => {
    expect(watchdogShouldPing(true, true, 1000, 0)).toBe(true);
    expect(watchdogShouldPing(true, true, 1000, 2000)).toBe(true);
  });

  test('stale marks ping while inside the grace window', () => {
    expect(watchdogShouldPing(false, true, 1000, 2000)).toBe(true); // gossip stale, in grace
    expect(watchdogShouldPing(true, false, 1000, 2000)).toBe(true); // sync stale, in grace
    expect(watchdogShouldPing(false, false, 1000, 2000)).toBe(true); // both stale, in grace
  });

  test('stale marks withhold once nowMs reaches or passes graceUntilMs', () => {
    expect(watchdogShouldPing(false, true, 2000, 2000)).toBe(false); // exactly at expiry
    expect(watchdogShouldPing(false, true, 2001, 2000)).toBe(false); // past expiry
  });

  test('graceUntilMs of 0 (never granted, the pre-jump default) never satisfies the grace check', () => {
    expect(watchdogShouldPing(false, false, 0, 0)).toBe(false);
    expect(watchdogShouldPing(false, false, 1_700_000_000_000, 0)).toBe(false);
  });

  test('mixed freshness (only one loop stale) withholds outside grace, exactly like today', () => {
    expect(watchdogShouldPing(false, true, 1000, 0)).toBe(false);
    expect(watchdogShouldPing(true, false, 1000, 0)).toBe(false);
  });
});

describe('nextWatchdogGrace (P4 watchdog, Class B: pure grace-window arithmetic)', () => {
  const WINDOW_MS = 300_000;

  test('fresh, no jump: 0 stays 0', () => {
    expect(nextWatchdogGrace(0, 0, 1000, WINDOW_MS)).toBe(0);
  });

  test('a genuine jump with no open window grants now+windowMs', () => {
    const now = 1000;
    expect(nextWatchdogGrace(0, SUSPEND_JUMP_MS + 1, now, WINDOW_MS)).toBe(now + WINDOW_MS);
  });

  test('a merely-stale tick during an open window never renews it, unchanged', () => {
    const prevGrace = 500_000;
    // now (10_000) is well before prevGrace (500_000): the window is still open.
    expect(nextWatchdogGrace(prevGrace, 0, 10_000, WINDOW_MS)).toBe(prevGrace);
  });

  test('a second jump DURING an already-open window is refused, not extended', () => {
    const prevGrace = 500_000;
    const now = 10_000; // still well inside the open window
    expect(nextWatchdogGrace(prevGrace, SUSPEND_JUMP_MS + 1, now, WINDOW_MS)).toBe(prevGrace);
  });

  test('a jump after the previous window has expired grants a fresh one', () => {
    const prevGrace = 5_000;
    const now = 10_000; // past prevGrace -- the old window is closed
    expect(nextWatchdogGrace(prevGrace, SUSPEND_JUMP_MS + 1, now, WINDOW_MS)).toBe(now + WINDOW_MS);
  });

  test('boundary: driftMs === SUSPEND_JUMP_MS exactly never grants (strictly greater-than only)', () => {
    expect(nextWatchdogGrace(0, SUSPEND_JUMP_MS, 1000, WINDOW_MS)).toBe(0);
    // Also true with a closed prior window, to isolate the driftMs boundary from the window check.
    expect(nextWatchdogGrace(500, SUSPEND_JUMP_MS, 1000, WINDOW_MS)).toBe(500);
  });

  test('boundary: nowMs === prevGraceUntilMs counts as expired (window closes AT its own boundary)', () => {
    const prevGrace = 1000;
    expect(nextWatchdogGrace(prevGrace, SUSPEND_JUMP_MS + 1, prevGrace, WINDOW_MS)).toBe(prevGrace + WINDOW_MS);
  });
});

describe('buildAdminLaneView (Class G: uiAssets exposed on UiState)', () => {
  function credential(overrides: Partial<Parameters<typeof buildAdminLaneView>[0]['credential']> = {}) {
    return { present: false, stale: false, sealed: null, setAtMs: null, ...overrides };
  }

  test('reflects cfg.admin.uiAssets when explicitly true', () => {
    const cfg = defaultConfig('alpha');
    cfg.admin.uiAssets = true;
    const view = buildAdminLaneView({ cfg, configured: true, credential: credential(), sshKeyFingerprint: null });
    expect(view.uiAssets).toBe(true);
  });

  test('reflects cfg.admin.uiAssets when explicitly false', () => {
    const cfg = defaultConfig('alpha');
    cfg.admin.uiAssets = false;
    const view = buildAdminLaneView({ cfg, configured: true, credential: credential(), sshKeyFingerprint: null });
    expect(view.uiAssets).toBe(false);
  });

  test('defaults to true when uiAssets is absent from cfg.admin (pre-P6 config shape)', () => {
    const cfg = defaultConfig('alpha');
    delete (cfg.admin as { uiAssets?: boolean }).uiAssets;
    const view = buildAdminLaneView({ cfg, configured: true, credential: credential(), sshKeyFingerprint: null });
    expect(view.uiAssets).toBe(true);
  });

  test('passes through the rest of the admin lane view unchanged', () => {
    const cfg = defaultConfig('alpha');
    cfg.admin.enabled = true;
    cfg.admin.acceptIncoming = false;
    cfg.admin.sshUser = 'ariel';
    const view = buildAdminLaneView({
      cfg,
      configured: false,
      credential: credential({ present: true, stale: true, sealed: 'tpm2', setAtMs: 12345 }),
      sshKeyFingerprint: 'SHA256:abc',
    });
    expect(view).toEqual({
      enabled: true,
      acceptIncoming: false,
      uiEnabled: cfg.admin.uiEnabled,
      configured: false,
      credentialPresent: true,
      credentialStale: true,
      credentialSealed: 'tpm2',
      credentialSetAtMs: 12345,
      sshUser: 'ariel',
      sshKeyFingerprint: 'SHA256:abc',
      runTimeoutSec: cfg.admin.runTimeoutSec,
      maxRunTimeoutSec: cfg.admin.maxRunTimeoutSec,
      ratePerMin: cfg.admin.ratePerMin,
      uiAssets: true,
    });
  });
});
