// SPDX-License-Identifier: AGPL-3.0-or-later
// MCP-owned SSH access for machines that do not run a node. This registry never enters gossip,
// pairing, or the syncer. The existing agent-origin switch gates every mutation and command.
import { randomUUID } from 'node:crypto';
import { stat } from 'node:fs/promises';
import { expandHome, patchConfig, validateAccessTarget } from './config';
import type { AccessTargetConfig, AuditEntry, FleetConfig } from './types';
import { canonicalJson, runBytes } from './util';

export type AccessContent = { type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string };
export interface AccessResult { content: AccessContent[]; isError?: boolean }
export interface AccessDeps {
  cfg: FleetConfig;
  auditAppend: (kind: string, detail: Record<string, unknown>) => Promise<AuditEntry>;
  runner?: typeof runBytes;
  persist?: typeof patchConfig;
}

const text = (value: unknown, isError = false): AccessResult => ({
  content: [{ type: 'text', text: JSON.stringify(value) }], ...(isError ? { isError: true } : {}),
});
export const shellQuote = (s: string): string => `'${s.replace(/'/g, `'"'"'`)}'`;
const sshPath = (s: string): string => expandHome(s).replace(/%/g, '%%');

// Stock macOS and Linux Perl supplies a remote process-group deadline independently of the
// origin's SSH timeout. No runtime or repository installation is required on the target.
// Kill the group on completion too: background children must not survive a bounded MCP call.
export const REMOTE_RUNNER = `use POSIX qw(setsid); my $seconds=shift; my $pid=fork();
defined($pid) or die "fork failed\\n";
if (!$pid) { setsid() >= 0 or exit 126; exec { $ARGV[0] } @ARGV; exit 127; }
sub stop { kill 'TERM', -$pid; kill 'TERM', $pid; select undef,undef,undef,0.2; kill 'KILL', -$pid; }
$SIG{ALRM}=sub { stop(); waitpid($pid,0); exit 124; };
$SIG{HUP}=$SIG{TERM}=sub { stop(); waitpid($pid,0); exit 125; };
alarm $seconds; waitpid($pid,0); my $status=$?; alarm 0; stop();
exit (($status & 127) ? 128+($status & 127) : $status >> 8);`;

export function accessSshArgv(target: AccessTargetConfig, timeoutSec: number, argv: string[], connectSec: number): string[] {
  const remoteCommand = ['exec', '/usr/bin/perl', '-e', REMOTE_RUNNER, '--', String(timeoutSec), ...argv].map(shellQuote).join(' ');
  if (Buffer.byteLength(remoteCommand, 'utf8') > 65536) throw new Error('encoded SSH command exceeds 64 KiB after shell quoting');
  const optionPath = (path: string): string => `"${sshPath(path).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
  return [
    'ssh', '-F', 'none', '-T', '-o', 'BatchMode=yes', '-o', 'IdentitiesOnly=yes',
    '-o', 'IdentityAgent=none', '-o', 'StrictHostKeyChecking=yes', '-o', 'UpdateHostKeys=no',
    '-o', 'GlobalKnownHostsFile=none', '-o', `UserKnownHostsFile=${optionPath(target.knownHostsFile)}`,
    '-o', 'ClearAllForwardings=yes', '-o', 'PermitLocalCommand=no', '-o', 'ProxyCommand=none',
    '-o', 'ProxyJump=none', '-o', 'ControlMaster=no', '-o', 'ControlPath=none',
    '-o', `ConnectTimeout=${connectSec}`, '-o', 'ServerAliveInterval=5', '-o', 'ServerAliveCountMax=2',
    // -i stats its value before token expansion. IdentityFile as an option expands %% correctly.
    // The explicit none entry prevents OpenSSH loading default identities if this key disappears.
    '-o', 'IdentityFile=none', '-o', `IdentityFile=${optionPath(target.identityFile)}`,
    '-o', 'PreferredAuthentications=publickey',
    '-p', String(target.port), '-l', target.user, '--', target.host, remoteCommand,
  ];
}

function macScreenshot(target: AccessTargetConfig): string {
  const command = target.screenshotCommand ?? ['/usr/sbin/screencapture', '-x', '-t', 'png', '{output}'];
  const capture = command.map((arg) => arg === '{output}' ? '"$d/screen.png"' : shellQuote(arg)).join(' ');
  return `set -eu
d=$(/usr/bin/mktemp -d)
trap '/bin/rm -rf -- "$d"' EXIT
${capture} >/dev/null
/usr/bin/sips --resampleHeightWidthMax 1600 "$d/screen.png" >/dev/null
/bin/cat "$d/screen.png"`;
}

function isCapturedPng(bytes: Uint8Array): boolean {
  const b = Buffer.from(bytes);
  return b.length >= 57 && b.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex')) &&
    b.toString('ascii', 12, 16) === 'IHDR' && b.readUInt32BE(16) > 0 && b.readUInt32BE(16) <= 1600 &&
    b.readUInt32BE(20) > 0 && b.readUInt32BE(20) <= 1600 && b.toString('ascii', b.length - 8, b.length - 4) === 'IEND';
}

export class AccessOnly {
  private runner: typeof runBytes;
  private persist: typeof patchConfig;
  private starts: number[] = [];
  constructor(private deps: AccessDeps) {
    this.runner = deps.runner ?? runBytes;
    this.persist = deps.persist ?? patchConfig;
  }

  private gate(reason: unknown): asserts reason is string {
    if (!this.deps.cfg.admin.enabled) throw new Error('the admin lane is disabled on the origin');
    if (this.deps.cfg.admin.agentOrigin !== 'allow') throw new Error('agent-origin access is refused on the origin');
    if (typeof reason !== 'string' || !reason.trim() || reason.length > 1024) throw new Error('a reason of 1-1024 characters is required');
    const now = Date.now();
    this.starts = this.starts.filter((t) => now - t < 60000);
    if (this.starts.length >= this.deps.cfg.admin.ratePerMin) throw new Error('access-only rate limit reached; wait before another call');
    this.starts.push(now);
  }

  private async checkFiles(target: AccessTargetConfig): Promise<void> {
    for (const [field, forbidden] of [['identityFile', 0o077], ['knownHostsFile', 0o022]] as const) {
      const info = await stat(expandHome(target[field]));
      if (!info.isFile() || info.size === 0 || (info.mode & forbidden) ||
          (process.getuid && info.uid !== process.getuid())) {
        throw new Error(`${field} must be a nonempty file owned by the node account with private or read-only permissions`);
      }
    }
    const token = target.port === 22 ? target.host : `[${target.host}]:${target.port}`;
    const pin = await this.runner(['ssh-keygen', '-F', token, '-f', expandHome(target.knownHostsFile)], {
      timeoutMs: 5000, maxCaptureBytes: 16384,
    });
    if (pin.code !== 0) throw new Error('no SSH host key is pinned for this address and port; no connection attempted');
  }

  private target(machine: unknown): AccessTargetConfig {
    const target = this.deps.cfg.accessTargets?.find((t) => t.name === machine);
    if (!target) throw new Error('unknown access-only machine; use fleet.access_register first');
    return target;
  }

  async call(name: string, args: Record<string, unknown>): Promise<AccessResult> {
    if (name === 'fleet.access_list') {
      return text({ origin: this.deps.cfg.machine, machines: (this.deps.cfg.accessTargets ?? []).map((t) => ({
        name: t.name, host: t.host, port: t.port, user: t.user, platform: t.platform,
        mode: 'access-only', sync: false,
      })) });
    }
    const runId = randomUUID();
    let requested = false;
    try {
      this.gate(args.reason);
      if (name === 'fleet.access_register') {
        const target = { name: args.machine, host: args.host, port: args.port ?? 22, user: args.user,
          identityFile: args.identityFile, knownHostsFile: args.knownHostsFile, platform: args.platform,
          screenshotCommand: args.screenshotCommand };
        validateAccessTarget(target);
        if (target.name === this.deps.cfg.machine || this.deps.cfg.peers.some((p) => p.name === target.name)) {
          throw new Error('access-only name conflicts with a full node');
        }
        await this.checkFiles(target);
        if (args.replace !== undefined && typeof args.replace !== 'boolean') throw new Error('replace must be a boolean');
        await this.deps.auditAppend('access-register-requested', { runId, clientLabel: 'mcp', reason: args.reason, target });
        requested = true;
        const saved = await this.persist((raw) => {
          const targets = (raw.accessTargets ?? []) as AccessTargetConfig[];
          const old = targets.find((t) => t.name === target.name);
          if (old && canonicalJson(old) !== canonicalJson(target) && args.replace !== true) {
            throw new Error('target already exists with different settings; replace:true is required');
          }
          raw.accessTargets = [...targets.filter((t) => t.name !== target.name), target];
        });
        this.deps.cfg.accessTargets = saved.accessTargets;
        await this.deps.auditAppend('access-register-completed', { runId, machine: target.name });
        return text({ runId, machine: target.name, registered: true, mode: 'access-only', sync: false });
      }
      const target = this.target(args.machine);
      const screenshot = name === 'fleet.screenshot';
      if (!screenshot && name !== 'fleet.run') throw new Error('unknown access-only operation');
      if (screenshot && target.platform !== 'macos') throw new Error('fleet.screenshot currently supports macOS targets');
      const argv = screenshot ? ['/bin/sh', '-c', macScreenshot(target)] : args.argv;
      if (!Array.isArray(argv) || !argv.length || argv.length > 128 ||
          argv.some((a) => typeof a !== 'string' || a.includes('\0')) ||
          !argv[0] || Buffer.byteLength(JSON.stringify(argv)) > 65536) throw new Error('argv must contain 1-128 strings, at most 64 KiB, without NUL');
      if (args.asRoot !== undefined && typeof args.asRoot !== 'boolean') throw new Error('asRoot must be a boolean');
      const timeoutSec = args.timeoutSec ?? this.deps.cfg.admin.runTimeoutSec;
      if (!Number.isInteger(timeoutSec) || (timeoutSec as number) < 1 || (timeoutSec as number) > this.deps.cfg.admin.maxRunTimeoutSec) {
        throw new Error('timeoutSec must be a positive integer within admin.maxRunTimeoutSec');
      }
      const command = !screenshot && args.asRoot === true ? ['sudo', '-n', '--', ...argv] : argv;
      const transportArgv = accessSshArgv(target, timeoutSec as number, command, this.deps.cfg.admin.connectTimeoutSec);
      await this.checkFiles(target);
      await this.deps.auditAppend('access-run-requested', {
        runId, clientLabel: 'mcp', machine: target.name, reason: args.reason,
        operation: name, argv: screenshot ? (target.screenshotCommand ?? ['/usr/sbin/screencapture']) : command, timeoutSec,
      });
      requested = true;
      const started = Date.now();
      const result = await this.runner(transportArgv, {
        timeoutMs: ((timeoutSec as number) + this.deps.cfg.admin.connectTimeoutSec + 5) * 1000,
        maxCaptureBytes: screenshot ? 8 * 1024 * 1024 : this.deps.cfg.admin.maxOutputBytes,
      });
      const exitCode = result.code === 255 || result.timedOut || result.signalCode ? null : result.code;
      const meta = { runId, machine: target.name, exitCode, durationMs: Date.now() - started,
        truncated: result.truncated ?? false, stderr: result.stderr,
        ...(exitCode === null ? { message: 'SSH failed; remote completion is unknown. Do not automatically retry.' } : {}),
      };
      let auditRecorded = true;
      try {
        await this.deps.auditAppend('access-run-completed', { runId, machine: target.name, exitCode,
          durationMs: meta.durationMs, truncated: meta.truncated, outputBytes: result.stdout.length });
      } catch { auditRecorded = false; }
      if (screenshot) {
        if (exitCode !== 0 || meta.truncated || !isCapturedPng(result.stdout)) {
          return text({ ...meta, auditRecorded, message: meta.message ?? 'Screen capture failed. Verify an unlocked desktop and macOS Screen Recording permission for the capture process.' }, true);
        }
        return { content: [{ type: 'text', text: JSON.stringify({ ...meta, auditRecorded }) },
          { type: 'image', mimeType: 'image/png', data: Buffer.from(result.stdout).toString('base64') }] };
      }
      return text({ ...meta, auditRecorded, stdout: new TextDecoder().decode(result.stdout) }, exitCode === null);
    } catch (error) {
      const message = String(error);
      await this.deps.auditAppend('access-refused', { runId, clientLabel: 'mcp', operation: name,
        machine: typeof args.machine === 'string' ? args.machine : null, requested, message }).catch(() => {});
      return text({ runId, error: message, ...(requested ? { message: 'An operation was requested; inspect its state before retrying.' } : {}) }, true);
    }
  }
}
