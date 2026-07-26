// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The platform boundary.
//
// The daemon grew up on Linux, where each of these seams had exactly one implementation written
// inline at its call site. This module is where those single implementations become a choice.
//
// Two rules govern everything here, and they are the difference between "experimental" meaning
// "might work" and "experimental" meaning "will tell you the truth":
//
//   1. NEVER ask a capability question. Ask the system to DO the thing and see what happens.
//      This is not a style preference. The pre-extraction daemon deliberately contains no
//      `has-tpm2`-style probe because one produced a confidently wrong answer on real hardware:
//      TPM sealing was reported available and was in fact refused for an unprivileged user. A
//      round trip catches that on day one; a query never does.
//
//   2. A seam that cannot work on a platform must FAIL HONESTLY -- a clear refusal naming the
//      platform and the missing capability -- rather than throwing something generic at the first
//      real call, or worse, appearing to succeed.
//
// Support levels are deliberately not a boolean. `supported` means it runs here every day;
// `experimental` means it is implemented and untested by the maintainers; `unsupported` means
// there is no honest implementation and the seam says so out loud.

import { log, run } from './util';
import type { RunResult } from './util';

export type PlatformId = 'linux' | 'macos' | 'windows' | 'unknown';

export type SupportLevel = 'supported' | 'experimental' | 'unsupported';

export type Runner = (argv: string[], opts?: { timeoutMs?: number }) => Promise<RunResult>;

const DEFAULT_TIMEOUT_MS = 10000;

const defaultRunner: Runner = (argv, opts) => run(argv, { timeoutMs: opts?.timeoutMs ?? DEFAULT_TIMEOUT_MS });

export function currentPlatform(): PlatformId {
  switch (process.platform) {
    case 'linux':
      return 'linux';
    case 'darwin':
      return 'macos';
    case 'win32':
      return 'windows';
    default:
      return 'unknown';
  }
}

// A seam's outcome. `ok` is what happened, not what was predicted; `detail` is for humans and is
// safe to log (never carries credential material).
export interface SeamResult {
  ok: boolean;
  detail: string;
}

// ---------------------------------------------------------------------------
// Service manager
//
// Restarting the mesh transport's service. Linux runs this under `sudo -n`, which is the house
// pattern: a passwordless rule for one narrow command, never an interactive prompt.
// ---------------------------------------------------------------------------

export interface ServiceManager {
  readonly platform: PlatformId;
  readonly support: SupportLevel;
  restart(serviceName: string, runner?: Runner): Promise<SeamResult>;
}

const linuxServiceManager: ServiceManager = {
  platform: 'linux',
  support: 'supported',
  async restart(serviceName, runner = defaultRunner) {
    const res = await runner(['sudo', '-n', 'systemctl', 'restart', serviceName]);
    return res.code === 0
      ? { ok: true, detail: `systemctl restarted ${serviceName}` }
      : { ok: false, detail: `systemctl restart failed (exit ${res.code}): ${res.stderr.slice(0, 300)}` };
  },
};

const macosServiceManager: ServiceManager = {
  platform: 'macos',
  support: 'experimental',
  async restart(serviceName, runner = defaultRunner) {
    // `kickstart -k` stops the job if running and starts it again, which is launchd's closest
    // equivalent to `systemctl restart`. The gui/<uid> domain matches a per-user agent, which is
    // what this daemon installs as.
    const target = `gui/${process.getuid?.() ?? 501}/${serviceName}`;
    const res = await runner(['launchctl', 'kickstart', '-k', target]);
    return res.code === 0
      ? { ok: true, detail: `launchctl kickstarted ${target}` }
      : { ok: false, detail: `launchctl kickstart failed (exit ${res.code}): ${res.stderr.slice(0, 300)}` };
  },
};

const windowsServiceManager: ServiceManager = {
  platform: 'windows',
  support: 'experimental',
  async restart(serviceName, runner = defaultRunner) {
    const res = await runner([
      'powershell',
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      `Restart-Service -Name '${serviceName.replace(/'/g, "''")}' -Force`,
    ]);
    return res.code === 0
      ? { ok: true, detail: `Restart-Service restarted ${serviceName}` }
      : { ok: false, detail: `Restart-Service failed (exit ${res.code}): ${res.stderr.slice(0, 300)}` };
  },
};

const unsupportedServiceManager: ServiceManager = {
  platform: 'unknown',
  support: 'unsupported',
  async restart(serviceName) {
    return {
      ok: false,
      detail:
        `no service manager implementation for platform "${process.platform}" -- cannot restart ` +
        `${serviceName}. Restart it by hand; sync is unaffected.`,
    };
  },
};

export function serviceManagerFor(platform: PlatformId = currentPlatform()): ServiceManager {
  switch (platform) {
    case 'linux':
      return linuxServiceManager;
    case 'macos':
      return macosServiceManager;
    case 'windows':
      return windowsServiceManager;
    default:
      return unsupportedServiceManager;
  }
}

// ---------------------------------------------------------------------------
// Desktop notification
//
// Failure here is cosmetic and must NEVER block or fail a sync. Every path below swallows its
// errors into a logged warning; nothing throws out of osNotify.
// ---------------------------------------------------------------------------

export type Urgency = 'low' | 'normal' | 'critical';

export const NOTIFY_APP_ID = 'org.sukarfleet.node';

export interface NotificationBackend {
  readonly platform: PlatformId;
  readonly support: SupportLevel;
  notify(urgency: Urgency, title: string, body: string, runner?: Runner): Promise<SeamResult>;
}

const URGENCY_BYTE: Record<Urgency, number> = { low: 0, normal: 1, critical: 2 };
const GTK_PRIORITY: Record<Urgency, string> = { low: 'low', normal: 'normal', critical: 'urgent' };

// GVariant text-format double-quoted string escaping.
function gvariantString(s: string): string {
  return '"' + s.replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"';
}

// Exported for direct unit testing against the recorded argv shape.
export function buildNotifyArgv(urgency: Urgency, title: string, body: string): string[] {
  return [
    'gdbus',
    'call',
    '--session',
    '--dest',
    'org.freedesktop.Notifications',
    '--object-path',
    '/org/freedesktop/Notifications',
    '--method',
    'org.freedesktop.Notifications.Notify',
    'sukarfleet',
    '0',
    '',
    title,
    body,
    '[]',
    `{'urgency': <byte ${URGENCY_BYTE[urgency]}>}`,
    '5000',
  ];
}

export function buildGtkNotifyArgv(urgency: Urgency, title: string, body: string): string[] {
  const payload =
    `{'title': <${gvariantString(title)}>, 'body': <${gvariantString(body)}>, ` +
    `'priority': <'${GTK_PRIORITY[urgency]}'>}`;
  return [
    'gdbus',
    'call',
    '--session',
    '--dest',
    'org.gtk.Notifications',
    '--object-path',
    '/org/gtk/Notifications',
    '--method',
    'org.gtk.Notifications.AddNotification',
    NOTIFY_APP_ID,
    'sukarfleet-alert',
    payload,
  ];
}

// Primary channel: org.freedesktop.Notifications. Fallback: org.gtk.Notifications, which
// gnome-shell owns even where the freedesktop service cannot activate (a missing /usr/bin/gjs
// breaks org.gnome.Shell.Notifications activation on some distributions). The GTK protocol needs
// an installed .desktop entry matching NOTIFY_APP_ID, which the installer lays down.
const linuxNotificationBackend: NotificationBackend = {
  platform: 'linux',
  support: 'supported',
  async notify(urgency, title, body, runner = defaultRunner) {
    const fdo = await runner(buildNotifyArgv(urgency, title, body));
    if (fdo.code === 0) return { ok: true, detail: 'delivered via org.freedesktop.Notifications' };
    const gtk = await runner(buildGtkNotifyArgv(urgency, title, body));
    if (gtk.code === 0) return { ok: true, detail: 'delivered via org.gtk.Notifications fallback' };
    return {
      ok: false,
      detail:
        `both notification channels failed (fdo exit ${fdo.code}: ${fdo.stderr.slice(0, 150)}; ` +
        `gtk exit ${gtk.code}: ${gtk.stderr.slice(0, 150)})`,
    };
  },
};

// osascript is present on every macOS install, so this needs no dependency. Note that macOS
// silently drops notifications from an unsigned background process in some configurations -- the
// call succeeds and nothing appears. That is a platform behaviour this cannot detect, and it is
// exactly why notification failure must stay cosmetic.
const macosNotificationBackend: NotificationBackend = {
  platform: 'macos',
  support: 'experimental',
  async notify(_urgency, title, body, runner = defaultRunner) {
    const esc = (s: string): string => s.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
    const res = await runner([
      'osascript',
      '-e',
      `display notification "${esc(body)}" with title "${esc(title)}"`,
    ]);
    return res.code === 0
      ? { ok: true, detail: 'delivered via osascript' }
      : { ok: false, detail: `osascript failed (exit ${res.code}): ${res.stderr.slice(0, 300)}` };
  },
};

// Windows toast without a third-party module means driving WinRT from PowerShell. It works on
// Windows 10+ and is fussy about the AppUserModelId, which is why this is experimental rather
// than supported.
const windowsNotificationBackend: NotificationBackend = {
  platform: 'windows',
  support: 'experimental',
  async notify(_urgency, title, body, runner = defaultRunner) {
    const esc = (s: string): string => s.replace(/'/g, "''");
    const script = [
      '[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType=WindowsRuntime] > $null',
      '$t = [Windows.UI.Notifications.ToastNotificationManager]::GetTemplateContent([Windows.UI.Notifications.ToastTemplateType]::ToastText02)',
      `$t.GetElementsByTagName('text').Item(0).AppendChild($t.CreateTextNode('${esc(title)}')) > $null`,
      `$t.GetElementsByTagName('text').Item(1).AppendChild($t.CreateTextNode('${esc(body)}')) > $null`,
      `[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier('${NOTIFY_APP_ID}').Show([Windows.UI.Notifications.ToastNotification]::new($t))`,
    ].join('; ');
    const res = await runner(['powershell', '-NoProfile', '-NonInteractive', '-Command', script]);
    return res.code === 0
      ? { ok: true, detail: 'delivered via WinRT toast' }
      : { ok: false, detail: `toast failed (exit ${res.code}): ${res.stderr.slice(0, 300)}` };
  },
};

const unsupportedNotificationBackend: NotificationBackend = {
  platform: 'unknown',
  support: 'unsupported',
  async notify() {
    return { ok: false, detail: `no notification implementation for platform "${process.platform}"` };
  },
};

export function notificationBackendFor(platform: PlatformId = currentPlatform()): NotificationBackend {
  switch (platform) {
    case 'linux':
      return linuxNotificationBackend;
    case 'macos':
      return macosNotificationBackend;
    case 'windows':
      return windowsNotificationBackend;
    default:
      return unsupportedNotificationBackend;
  }
}

// ---------------------------------------------------------------------------
// Support reporting
//
// What the installer prints and the GUI shows. Honest by construction: it reports the declared
// level of each seam on THIS platform, and says plainly that a level is a claim about testing, not
// a promise about behaviour.
// ---------------------------------------------------------------------------

export interface PlatformReport {
  platform: PlatformId;
  seams: { name: string; support: SupportLevel }[];
}

export function platformReport(platform: PlatformId = currentPlatform()): PlatformReport {
  return {
    platform,
    seams: [
      { name: 'service-manager', support: serviceManagerFor(platform).support },
      { name: 'notification', support: notificationBackendFor(platform).support },
    ],
  };
}

export function logPlatformReport(platform: PlatformId = currentPlatform()): void {
  const rep = platformReport(platform);
  const experimental = rep.seams.filter((s) => s.support !== 'supported');
  if (experimental.length === 0) return;
  log('info', 'platform: some seams are not routinely tested on this platform', {
    platform: rep.platform,
    seams: experimental.map((s) => `${s.name}=${s.support}`).join(','),
  });
}
