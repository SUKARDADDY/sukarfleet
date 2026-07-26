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

import { log, run } from './util';
import type { RunResult } from './util';
import { notificationBackendFor } from './platform';
import type { Urgency } from './platform';

export type { Urgency } from './platform';
export { NOTIFY_APP_ID, buildNotifyArgv, buildGtkNotifyArgv } from './platform';

export type NotifyRunner = (argv: string[]) => Promise<RunResult>;

const NOTIFY_TIMEOUT_MS = 10000;

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
      log('debug', 'osNotify: delivered', { detail: res.detail, platform: backend.platform });
      return;
    }
    log('warn', 'osNotify: notification not delivered', {
      detail: res.detail,
      platform: backend.platform,
      support: backend.support,
    });
  } catch (err) {
    log('warn', 'osNotify: notification backend threw', { error: String(err) });
  }
}
