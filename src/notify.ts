// SPDX-License-Identifier: AGPL-3.0-or-later
//
// OS desktop notifications.
//
// The per-platform mechanics live behind the notification seam in platform.ts; this file is the
// call-site contract the rest of the daemon uses. Never throws: failures are logged as warnings
// and swallowed so callers can fire-and-forget.
//
// That swallowing is deliberate and load-bearing. A notification is cosmetic; a sync is not. There
// is no platform on which a missing notification daemon, a sandboxed osascript, or an unregistered
// toast AppUserModelId may be allowed to fail a sync cycle.

import { log, run, TransitionGate } from './util';
import type { RunResult } from './util';
import { notificationBackendFor } from './platform';
import type { Urgency } from './platform';

export type { Urgency } from './platform';
export { NOTIFY_APP_ID, buildNotifyArgv, buildGtkNotifyArgv } from './platform';

export type NotifyRunner = (argv: string[]) => Promise<RunResult>;

const NOTIFY_TIMEOUT_MS = 10000;

// Module-level, not per-call: there is one notification channel per process, so one latch is what
// "is delivery currently broken" means. A broken session bus used to log the same "not delivered"
// warning once per fault in a single health tick (before P5's coalescing); this turns a
// persistently broken bus into one warn on the flip, not one per attempt.
const deliveryGate = new TransitionGate();
const DELIVERY_GATE_KEY = 'osNotify';

// Class F: the latch above re-arms on success, but a channel that stays broken for hours must not
// go completely silent after its first warn -- an operator glancing at the journal an hour into an
// outage deserves to see it again, not conclude (wrongly) that it self-resolved. 30 minutes ties to
// the spirit of health.ts's thresholds.alarmRepeatMin (its own "still broken, remind me again"
// window) without actually plumbing FleetConfig into this module for one constant.
const NOTIFY_REWARN_MS = 30 * 60_000;

// Timestamp of the last WARN-level (not debug-debounced) delivery-failure log, module-global for
// the same reason deliveryGate is: one channel, one process, one re-arm clock. Reset on every
// recovery so a success always starts the next failure's re-arm window fresh.
let lastWarnMs: number | null = null;

// Shared by both failure sites (a non-ok backend result and a thrown backend call): forces the
// latch back to 'entered' if the last loud warn is older than NOTIFY_REWARN_MS, so a persistently
// broken channel warns again on a schedule instead of debouncing to debug forever after its first
// failure.
function observeFailure(nowMs: number): ReturnType<TransitionGate['observe']> {
  if (lastWarnMs !== null && nowMs - lastWarnMs >= NOTIFY_REWARN_MS) {
    deliveryGate.forget(DELIVERY_GATE_KEY);
  }
  const transition = deliveryGate.observe(DELIVERY_GATE_KEY, true);
  if (transition === 'entered') lastWarnMs = nowMs;
  return transition;
}

export async function osNotify(
  urgency: Urgency,
  title: string,
  body: string,
  runner?: NotifyRunner,
  // Smallest seam for the time-based re-arm above to be test-driven without waiting 30 real
  // minutes: defaults to the real clock, so every existing call site is unaffected.
  now: () => number = Date.now,
): Promise<void> {
  try {
    const backend = notificationBackendFor();
    const res = await backend.notify(urgency, title, body, (argv, opts) =>
      runner ? runner(argv) : run(argv, { timeoutMs: opts?.timeoutMs ?? NOTIFY_TIMEOUT_MS }),
    );
    if (res.ok) {
      deliveryGate.observe(DELIVERY_GATE_KEY, false); // re-arms: the next failure warns again
      lastWarnMs = null;
      log('debug', 'osNotify: delivered', { detail: res.detail, platform: backend.platform });
      return;
    }
    const transition = observeFailure(now());
    log(transition === 'entered' ? 'warn' : 'debug', 'osNotify: notification not delivered', {
      detail: res.detail,
      platform: backend.platform,
      support: backend.support,
    });
  } catch (err) {
    const transition = observeFailure(now());
    log(transition === 'entered' ? 'warn' : 'debug', 'osNotify: notification backend threw', {
      error: String(err),
    });
  }
}
