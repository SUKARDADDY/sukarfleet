// SPDX-License-Identifier: AGPL-3.0-or-later
// Pure decision points extracted from node.ts's loops, pinned here without spinning up the daemon
// (the import.meta.main guard on node.ts is what makes importing it for these functions safe).

import { describe, expect, test } from 'bun:test';
import { nextAnchorDownStreak, shouldPushDerivedMain } from '../src/node';

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
