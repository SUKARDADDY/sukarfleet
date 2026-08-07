// SPDX-License-Identifier: AGPL-3.0-or-later
// Pure decision points extracted from node.ts's loops, pinned here without spinning up the daemon
// (the import.meta.main guard on node.ts is what makes importing it for these functions safe).

import { describe, expect, test } from 'bun:test';
import { nextAnchorDownStreak, shouldPushDerivedMain, watchdogShouldPing } from '../src/node';
import { clockDriftMs } from '../src/util';
import { SUSPEND_JUMP_MS } from '../src/transport';

describe('shouldPushDerivedMain (P3 single-pusher policy)', () => {
  const cases: Array<{ role: 'anchor' | 'roamer'; anchorReachable: boolean | null; want: boolean }> = [
    { role: 'anchor', anchorReachable: true, want: true },
    { role: 'anchor', anchorReachable: false, want: true },
    { role: 'anchor', anchorReachable: null, want: true },
    { role: 'roamer', anchorReachable: true, want: false },
    { role: 'roamer', anchorReachable: false, want: true },
    { role: 'roamer', anchorReachable: null, want: false },
  ];
  for (const { role, anchorReachable, want } of cases) {
    test(`role=${role} anchorReachable=${anchorReachable} -> ${want}`, () => {
      expect(shouldPushDerivedMain(role, anchorReachable)).toBe(want);
    });
  }
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
