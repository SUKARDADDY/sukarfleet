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

// The shell's "command not found". A seam reports an absent tool as a non-zero result carrying the
// reason, never as an exception.
const SPAWN_FAILED_CODE = 127;

// Bun.spawn raises ENOENT when the binary does not exist, and that is not a hypothetical: the first
// real Windows boot of this daemon died on `uv_spawn 'timedatectl'`. A seam that lets that through
// is failing obscurely, which is exactly what rule 2 above forbids. Absent tool and failed tool
// arrive at the call site as the same shape -- a non-zero exit whose stderr says what happened.
async function runSeam(runner: Runner, argv: string[], opts?: { timeoutMs?: number }): Promise<RunResult> {
  try {
    return await runner(argv, opts);
  } catch (err) {
    return { code: SPAWN_FAILED_CODE, stdout: '', stderr: `could not run ${argv[0]}: ${String(err)}` };
  }
}

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
    const res = await runSeam(runner, ['sudo', '-n', 'systemctl', 'restart', serviceName]);
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
    const res = await runSeam(runner, ['launchctl', 'kickstart', '-k', target]);
    return res.code === 0
      ? { ok: true, detail: `launchctl kickstarted ${target}` }
      : { ok: false, detail: `launchctl kickstart failed (exit ${res.code}): ${res.stderr.slice(0, 300)}` };
  },
};

const windowsServiceManager: ServiceManager = {
  platform: 'windows',
  support: 'experimental',
  async restart(serviceName, runner = defaultRunner) {
    const res = await runSeam(runner, [
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
      { name: 'credential-store', support: credentialBackendFor(platform).support },
      { name: 'store-privacy-probe', support: storePrivacyProbeFor(platform).support },
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

// ---------------------------------------------------------------------------
// Credential store
//
// The seam supplies ARGV ONLY. It never sees, returns, or handles a plaintext password: secrets.ts
// keeps ownership of the pipe, and plaintext continues to exist on exactly one stack frame there.
// That is deliberate -- a seam that took the password as a parameter would spread the one invariant
// this codebase most needs to keep local across three platform implementations.
//
// Every backend below is a stdin -> stdout filter, so the credential is never an argv element and
// never appears in `ps`.
//
// Scope vocabulary is shared across platforms and is persisted in the credential metadata:
//   'tpm2'  sealed to the machine's TPM. Strongest; in practice needs privileges the daemon
//           does not have, and is tried first only so a better-provisioned machine wins for free.
//   'user'  sealed to this user on this host, inert if copied elsewhere. What actually seals on
//           every platform today: systemd-creds --user, the macOS login Keychain, DPAPI CurrentUser.
//
// What 'user' buys, stated exactly, because SECURITY.md has to repeat it: a credential that leaks
// through a synced repo, a backup or a copied directory is useless to the reader. What it does NOT
// buy: protection from another process running as this same user, which can simply ask the OS to
// decrypt it.
// ---------------------------------------------------------------------------

export type SealScope = 'tpm2' | 'user';

export interface CredentialBackend {
  readonly platform: PlatformId;
  readonly support: SupportLevel;
  // Strongest first. sealAvailable() walks these and keeps the first that survives a live round
  // trip -- never a capability query.
  readonly scopes: readonly SealScope[];
  sealArgv(scope: SealScope, name: string): string[];
  unsealArgv(scope: SealScope, name: string): string[];
}

const linuxCredentialBackend: CredentialBackend = {
  platform: 'linux',
  support: 'supported',
  scopes: ['tpm2', 'user'],
  // --user must be passed to BOTH encrypt and decrypt: a blob sealed in user scope is not readable
  // by a system-scope decrypt and vice versa.
  sealArgv: (scope, name) => [
    'systemd-creds',
    'encrypt',
    ...(scope === 'tpm2' ? ['--with-key=tpm2'] : ['--user']),
    `--name=${name}`,
    '-',
    '-',
  ],
  unsealArgv: (scope, name) => [
    'systemd-creds',
    'decrypt',
    ...(scope === 'tpm2' ? [] : ['--user']),
    `--name=${name}`,
    '-',
    '-',
  ],
};

// `security ... -w` with no value reads the password from stdin when stdin is a pipe, which is what
// keeps it off argv. Only the login keychain is used: it is unlocked with the user's session and
// needs no separate prompt in the daemon's context.
const macosCredentialBackend: CredentialBackend = {
  platform: 'macos',
  support: 'experimental',
  scopes: ['user'],
  sealArgv: (_scope, name) => [
    'security',
    'add-generic-password',
    '-U',
    '-a',
    name,
    '-s',
    name,
    '-w',
  ],
  unsealArgv: (_scope, name) => ['security', 'find-generic-password', '-a', name, '-s', name, '-w'],
};

// DPAPI at CurrentUser scope. ConvertFrom-SecureString produces a blob only this user on this host
// can reverse; the plaintext arrives on stdin and leaves on stdout, never through argv.
const windowsCredentialBackend: CredentialBackend = {
  platform: 'windows',
  support: 'experimental',
  scopes: ['user'],
  sealArgv: () => [
    'powershell',
    '-NoProfile',
    '-NonInteractive',
    '-Command',
    '$in=[Console]::In.ReadToEnd(); ConvertFrom-SecureString -SecureString (ConvertTo-SecureString -String $in -AsPlainText -Force)',
  ],
  unsealArgv: () => [
    'powershell',
    '-NoProfile',
    '-NonInteractive',
    '-Command',
    '$in=[Console]::In.ReadToEnd(); $s=ConvertTo-SecureString -String $in; ' +
      '[Runtime.InteropServices.Marshal]::PtrToStringAuto([Runtime.InteropServices.Marshal]::SecureStringToBSTR($s))',
  ],
};

const unsupportedCredentialBackend: CredentialBackend = {
  platform: 'unknown',
  support: 'unsupported',
  scopes: [],
  sealArgv: () => {
    throw new Error(`no credential store implementation for platform "${process.platform}"`);
  },
  unsealArgv: () => {
    throw new Error(`no credential store implementation for platform "${process.platform}"`);
  },
};

export function credentialBackendFor(platform: PlatformId = currentPlatform()): CredentialBackend {
  switch (platform) {
    case 'linux':
      return linuxCredentialBackend;
    case 'macos':
      return macosCredentialBackend;
    case 'windows':
      return windowsCredentialBackend;
    default:
      return unsupportedCredentialBackend;
  }
}

// ---------------------------------------------------------------------------
// Store privacy probe
//
// A 0700 reading from stat() is meaningless on a filesystem that ignores chmod or synthesises a
// fixed mode from mount options. Asking "is this mode 0700?" on such a filesystem is precisely the
// confidently-wrong answer this module exists to avoid.
//
// Linux can consult the mount table. Everywhere else the honest answer comes from a real
// write-then-stat round trip: create a file at 0600, read its mode back, and believe the result.
// ---------------------------------------------------------------------------

// Filesystems that either ignore chmod outright or synthesise a fixed mode from mount options.
const MODE_BLIND_FSTYPES = new Set([
  'fuseblk',
  'ntfs',
  'ntfs3',
  'vfat',
  'msdos',
  'exfat',
  'iso9660',
  'cifs',
  'smb3',
  'smbfs',
]);

export interface StorePrivacyProbe {
  readonly platform: PlatformId;
  readonly support: SupportLevel;
  // Whether `dir` sits on a filesystem that actually enforces permission bits. Fails CLOSED: an
  // answer that cannot be established is `false`, never an optimistic `true`.
  enforcesMode(dir: string): Promise<SeamResult>;
}

// mountinfo escapes space/tab/newline/backslash in the mount point as octal.
function unescapeMountField(s: string): string {
  return s.replace(/\\([0-7]{3})/g, (_m, oct: string) => String.fromCharCode(parseInt(oct, 8)));
}

// Filesystem type backing `target`, by longest matching mount point in /proc/self/mountinfo.
export async function mountFsType(target: string, mountinfoPath = '/proc/self/mountinfo'): Promise<string | null> {
  // node:fs, not Bun.file: procfs reports st_size 0 and Bun.file().text() honours it, so the whole
  // table reads back as an empty string.
  const { readFile } = await import('node:fs/promises');
  let text: string;
  try {
    text = await readFile(mountinfoPath, 'utf8');
  } catch {
    return null;
  }
  let best: { length: number; fsType: string } | null = null;
  for (const line of text.split('\n')) {
    const sep = line.indexOf(' - ');
    if (sep < 0) continue;
    const mountPoint = unescapeMountField(line.slice(0, sep).split(' ')[4] ?? '');
    const fsType = line.slice(sep + 3).split(' ')[0] ?? '';
    if (!mountPoint || !fsType) continue;
    const prefix = mountPoint.endsWith('/') ? mountPoint : `${mountPoint}/`;
    if (target !== mountPoint && !target.startsWith(prefix)) continue;
    if (best === null || mountPoint.length > best.length) best = { length: mountPoint.length, fsType };
  }
  return best?.fsType ?? null;
}

// The write-then-stat round trip, used wherever a mount table is not available. This is the
// general form of the rule: do the thing and look at what happened.
export async function writeThenStatProbe(dir: string): Promise<SeamResult> {
  const { mkdir, writeFile, stat, unlink } = await import('node:fs/promises');
  const { join } = await import('node:path');
  const { randomBytes } = await import('node:crypto');
  const probe = join(dir, `.mode-probe-${randomBytes(8).toString('hex')}`);
  try {
    await mkdir(dir, { recursive: true, mode: 0o700 });
    await writeFile(probe, 'probe', { mode: 0o600 });
    const st = await stat(probe);
    const mode = st.mode & 0o777;
    if (mode !== 0o600) {
      return {
        ok: false,
        detail: `wrote a file at 0600 and it read back as 0${mode.toString(8)} -- this filesystem does not enforce permission bits`,
      };
    }
    return { ok: true, detail: 'a file written at 0600 read back as 0600' };
  } catch (err) {
    return { ok: false, detail: `could not run a write-then-stat probe in ${dir}: ${String(err)}` };
  } finally {
    await unlink(probe).catch(() => {});
  }
}

const linuxPrivacyProbe: StorePrivacyProbe = {
  platform: 'linux',
  support: 'supported',
  async enforcesMode(dir) {
    const fsType = await mountFsType(dir);
    if (fsType === null) {
      // Unknown filesystem: fall back to the round trip rather than guessing.
      return writeThenStatProbe(dir);
    }
    if (MODE_BLIND_FSTYPES.has(fsType)) {
      return {
        ok: false,
        detail: `the credential store sits on ${fsType}, which does not enforce permission bits, so its 0700 mode proves nothing`,
      };
    }
    return { ok: true, detail: `filesystem ${fsType} enforces permission bits` };
  },
};

const roundTripPrivacyProbe = (platform: PlatformId, support: SupportLevel): StorePrivacyProbe => ({
  platform,
  support,
  enforcesMode: (dir) => writeThenStatProbe(dir),
});

export function storePrivacyProbeFor(platform: PlatformId = currentPlatform()): StorePrivacyProbe {
  switch (platform) {
    case 'linux':
      return linuxPrivacyProbe;
    case 'macos':
      return roundTripPrivacyProbe('macos', 'experimental');
    case 'windows':
      // NTFS carries ACLs rather than POSIX mode bits, so the round trip is expected to report
      // that mode is not enforced. That is an honest answer, and the admin lane refuses on it
      // rather than storing a credential it cannot claim is private.
      return roundTripPrivacyProbe('windows', 'experimental');
    default:
      return roundTripPrivacyProbe('unknown', 'unsupported');
  }
}

// ---------------------------------------------------------------------------
// Clock synchronisation probe
//
// Newest-wins conflict resolution and the audit chain both read this machine's wall clock, so the
// daemon refuses to auto-commit until something has vouched for it. That check used to be one
// inline `timedatectl` call, which is a Linux answer to a question every platform has: the first
// real Windows boot died on `uv_spawn 'timedatectl'` before it ever served a request.
//
// This seam obeys both rules at the top of this file. It never asks whether a time service exists;
// it runs the platform's own time client and reports what came back. And it cannot fail obscurely:
// an absent tool, a timeout, a non-zero exit or output in a language this parser does not read all
// come back as 'unknown'. Three states, not a boolean, because "I could not find out" is a
// different fact from "the clock is wrong" -- both leave the clock unvetted, and only one of them
// is worth going and fixing.
// ---------------------------------------------------------------------------

export type ClockSyncState = 'synced' | 'unsynced' | 'unknown';

export interface ClockSyncProbe {
  readonly platform: PlatformId;
  readonly support: SupportLevel;
  // NEVER throws. Every failure is 'unknown'.
  probe(runner?: Runner): Promise<ClockSyncState>;
}

const CLOCK_PROBE_TIMEOUT_MS = 10000;

const linuxClockSyncProbe: ClockSyncProbe = {
  platform: 'linux',
  support: 'supported',
  async probe(runner = defaultRunner) {
    const res = await runSeam(runner, ['timedatectl', 'show', '-p', 'NTPSynchronized', '--value'], {
      timeoutMs: CLOCK_PROBE_TIMEOUT_MS,
    });
    if (res.code !== 0) return 'unknown';
    const value = res.stdout.trim();
    if (value === 'yes') return 'synced';
    if (value === 'no') return 'unsynced';
    return 'unknown';
  },
};

// A w32tm source that names the machine's own hardware rather than a time server. The leap
// indicator is usually 3 in that state, but not always -- a machine that has been its own reference
// since boot can report 0(no warning) about a clock nothing outside has ever checked.
const LOCAL_CLOCK_SOURCES = ['local cmos clock', 'free-running system clock'];

// Parses `w32tm /query /status`. Exported for direct unit testing against captured output.
//
// Two facts are needed and both must be present. The leap indicator is the NTP-level verdict:
// 0(no warning) is a synchronised clock, 3(not synchronized) is the state Windows reports when the
// time service has never reached a server. The Source line says WHAT it synchronised to, which is
// what separates a real time server from the machine's own oscillator.
//
// Note that w32tm's output is localised: on a non-English Windows these labels are translated and
// nothing here matches, which lands on 'unknown'. That is the honest answer -- an unvetted clock
// and a logged reason -- rather than a confident verdict read from text this does not understand.
export function parseW32tmStatus(text: string): ClockSyncState {
  const lines = text.split(/\r?\n/).map((l) => l.trim());
  const leapLine = lines.find((l) => /^Leap Indicator\s*:/i.test(l));
  const sourceLine = lines.find((l) => /^Source\s*:/i.test(l));
  if (leapLine === undefined || sourceLine === undefined) return 'unknown';

  const source = sourceLine.slice(sourceLine.indexOf(':') + 1).trim();
  if (source.length === 0) return 'unknown';

  const leap = leapLine.slice(leapLine.indexOf(':') + 1).trim();
  const leapDigit = /^(\d)/.exec(leap)?.[1];
  if (leapDigit === undefined) return 'unknown';
  if (leapDigit !== '0') return 'unsynced';

  const lower = source.toLowerCase();
  if (LOCAL_CLOCK_SOURCES.some((s) => lower.startsWith(s))) return 'unsynced';
  return 'synced';
}

const windowsClockSyncProbe: ClockSyncProbe = {
  platform: 'windows',
  support: 'experimental',
  async probe(runner = defaultRunner) {
    // w32tm exits non-zero when the Windows Time service is stopped ("The service has not been
    // started. (0x80070426)"), which is a real and common state on a desktop that has never joined
    // a domain. Unknown, not unsynced: nothing was measured.
    const res = await runSeam(runner, ['w32tm', '/query', '/status'], { timeoutMs: CLOCK_PROBE_TIMEOUT_MS });
    if (res.code !== 0) return 'unknown';
    return parseW32tmStatus(res.stdout);
  },
};

const macosClockSyncProbe: ClockSyncProbe = {
  platform: 'macos',
  support: 'unsupported',
  async probe() {
    // There is no honest macOS probe here yet, so this says so rather than inventing one. `sntp`
    // queries a server over the network instead of reporting what timed(8) believes, so it answers
    // a different question and fails on any machine without egress to that server; and
    // `systemsetup -getusingnetworktime` reports whether the feature is switched ON, which is a
    // capability question -- precisely the confidently-wrong answer this module exists to avoid.
    // Unvetted on macOS means auto-commit holds and the log says why.
    return 'unknown';
  },
};

const unsupportedClockSyncProbe: ClockSyncProbe = {
  platform: 'unknown',
  support: 'unsupported',
  async probe() {
    return 'unknown';
  },
};

export function clockSyncProbeFor(platform: PlatformId = currentPlatform()): ClockSyncProbe {
  switch (platform) {
    case 'linux':
      return linuxClockSyncProbe;
    case 'macos':
      return macosClockSyncProbe;
    case 'windows':
      return windowsClockSyncProbe;
    default:
      return unsupportedClockSyncProbe;
  }
}
