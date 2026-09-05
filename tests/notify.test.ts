// SPDX-License-Identifier: AGPL-3.0-or-later
// Tests for src/notify.ts's module-level delivery-failure latch (P5).
//
// osNotify's TransitionGate is a process-wide singleton (one notification channel per process, so
// one latch is what "delivery is currently broken" means) -- which also means it is NOT reset
// between tests, or between this file and any other file that calls osNotify (e.g.
// platform.test.ts). beforeEach forces one observed success via the existing injectable `runner`
// param before every test, so each test starts from a known-good gate state regardless of
// execution order.

import { afterAll, beforeEach, describe, expect, test } from 'bun:test';
import { osNotify } from '../src/notify';
import type { RunResult } from '../src/util';

interface LogLine {
  level: string;
  msg: string;
  [k: string]: unknown;
}

function captureLogs(): { lines: LogLine[]; restore: () => void } {
  const lines: LogLine[] = [];
  const real = console.log;
  console.log = (...args: unknown[]): void => {
    try {
      lines.push(JSON.parse(args.map(String).join(' ')));
    } catch {
      // non-JSON console output, not a log() line -- ignore
    }
  };
  return {
    lines,
    restore: () => {
      console.log = real;
    },
  };
}

const okRunner = async (): Promise<RunResult> => ({ code: 0, stdout: '', stderr: '' });
const failRunner = async (): Promise<RunResult> => ({ code: 1, stdout: '', stderr: 'no session bus' });
const throwingRunner = async (): Promise<RunResult> => {
  throw new Error('dbus exploded');
};

beforeEach(async () => {
  await osNotify('low', 'reset', 'reset', okRunner);
});

// Belt-and-braces alongside beforeEach: the module-global latch (and Class F's lastWarnMs) must
// never leak PAST this file either -- any other file that calls osNotify (e.g. platform.test.ts)
// starts from a known-good state regardless of test execution order across files.
afterAll(async () => {
  await osNotify('low', 'reset', 'reset', okRunner);
});

describe('osNotify delivery-failure latch', () => {
  test('first failure warns once; a repeat while still broken debounces to debug', async () => {
    const { lines, restore } = captureLogs();
    try {
      await osNotify('critical', 't1', 'b1', failRunner);
      await osNotify('critical', 't2', 'b2', failRunner);
      await osNotify('critical', 't3', 'b3', failRunner);
    } finally {
      restore();
    }
    const notDelivered = lines.filter((l) => l.msg === 'osNotify: notification not delivered');
    expect(notDelivered).toHaveLength(3);
    expect(notDelivered.map((l) => l.level)).toEqual(['warn', 'debug', 'debug']);
  });

  test('a throwing runner feeds the same gate as a failing backend', async () => {
    const { lines, restore } = captureLogs();
    try {
      await osNotify('critical', 't1', 'b1', throwingRunner);
      await osNotify('critical', 't2', 'b2', throwingRunner);
    } finally {
      restore();
    }
    const threw = lines.filter((l) => l.msg === 'osNotify: notification backend threw');
    expect(threw).toHaveLength(2);
    expect(threw[0]!.level).toBe('warn');
    expect(threw[1]!.level).toBe('debug');
  });

  test('re-arms on success: the next failure after a recovery warns again', async () => {
    const { lines, restore } = captureLogs();
    try {
      await osNotify('critical', 't1', 'b1', failRunner); // entered -> warn
      await osNotify('critical', 't2', 'b2', failRunner); // still-bad -> debug
      await osNotify('critical', 't3', 'b3', okRunner); // recovered
      await osNotify('critical', 't4', 'b4', failRunner); // entered again -> warn
    } finally {
      restore();
    }
    const notDelivered = lines.filter((l) => l.msg === 'osNotify: notification not delivered');
    expect(notDelivered.map((l) => l.level)).toEqual(['warn', 'debug', 'warn']);
  });

  // Class F: the latch previously only re-armed on a recovery. A channel that stays broken for a
  // long time (no recovery ever happens) must still warn again on a schedule, using the injectable
  // `now` seam so the test doesn't wait 30 real minutes.
  test('time-based re-arm: still broken past NOTIFY_REWARN_MS warns again with no recovery in between', async () => {
    let t = 0;
    const now = (): number => t;
    const { lines, restore } = captureLogs();
    try {
      await osNotify('critical', 't1', 'b1', failRunner, now); // entered -> warn (lastWarnMs = 0)
      t += 5 * 60_000; // 5 minutes later, well under the 30-minute re-arm window
      await osNotify('critical', 't2', 'b2', failRunner, now); // still-bad -> debug
      t += 25 * 60_000; // total 30 minutes since the last WARN -- exactly at the re-arm boundary
      await osNotify('critical', 't3', 'b3', failRunner, now); // re-armed -> warn again
      t += 1000; // just after the fresh warn, well under 30 minutes again
      await osNotify('critical', 't4', 'b4', failRunner, now); // still-bad again -> debug
    } finally {
      restore();
    }
    const notDelivered = lines.filter((l) => l.msg === 'osNotify: notification not delivered');
    expect(notDelivered.map((l) => l.level)).toEqual(['warn', 'debug', 'warn', 'debug']);
  });

  test('time-based re-arm does not fire early: still under NOTIFY_REWARN_MS stays debounced', async () => {
    let t = 0;
    const now = (): number => t;
    const { lines, restore } = captureLogs();
    try {
      await osNotify('critical', 't1', 'b1', failRunner, now); // entered -> warn
      t += 29 * 60_000 + 59_000; // 1s short of the 30-minute re-arm window
      await osNotify('critical', 't2', 'b2', failRunner, now); // still debounced -> debug
    } finally {
      restore();
    }
    const notDelivered = lines.filter((l) => l.msg === 'osNotify: notification not delivered');
    expect(notDelivered.map((l) => l.level)).toEqual(['warn', 'debug']);
  });

  test('a successful delivery always logs at debug, never warn', async () => {
    const { lines, restore } = captureLogs();
    try {
      await osNotify('low', 't', 'b', okRunner);
    } finally {
      restore();
    }
    const delivered = lines.filter((l) => l.msg === 'osNotify: delivered');
    expect(delivered).toHaveLength(1);
    expect(delivered[0]!.level).toBe('debug');
  });
});
