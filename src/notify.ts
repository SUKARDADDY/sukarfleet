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

export async function osNotify(
  urgency: Urgency,
  title: string,
  body: string,
  runner?: NotifyRunner,
): Promise<void> {
  try {
    const backend = notificationBackendFor();
    const res = await backend.notify(urgency, title, body, (argv, opts) =>
      runner ? runner(argv) : run(argv, { timeoutMs: opts?.timeoutMs ?? NOTIFY_TIMEOUT_MS }),
    );
    if (res.ok) {
      deliveryGate.observe(DELIVERY_GATE_KEY, false); // re-arms: the next failure warns again
      log('debug', 'osNotify: delivered', { detail: res.detail, platform: backend.platform });
      return;
    }
    const transition = deliveryGate.observe(DELIVERY_GATE_KEY, true);
    log(transition === 'entered' ? 'warn' : 'debug', 'osNotify: notification not delivered', {
      detail: res.detail,
      platform: backend.platform,
      support: backend.support,
    });
  } catch (err) {
    const transition = deliveryGate.observe(DELIVERY_GATE_KEY, true);
    log(transition === 'entered' ? 'warn' : 'debug', 'osNotify: notification backend threw', {
      error: String(err),
    });
  }
}
