// SPDX-License-Identifier: AGPL-3.0-or-later
// Tests for the ssh admin lane (src/sshadmin.ts).
//
// Real behavior wherever it is reachable without root: ssh-keygen actually generates the fleet
// identity, fingerprints are cross-checked against `ssh-keygen -lf`, and authorized_keys /
// known_hosts are written to and re-read from disk. The two things that cannot be exercised on a
// test box -- a live sudo authentication and a live ssh connection -- are driven through the
// module's declared seams (deps.secrets, deps.runner), and the assertions are about the exact
// argv/stdin those seams observe, which is the part that has to be right.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, open, readFile, readdir, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defaultConfig } from '../src/config';
import {
  DESTRUCTIVE_PATTERNS,
  SshAdmin,
  buildSshArgv,
  classifySshOutcome,
  decodeExecLocal,
  encodeExecLocal,
  forcedCommand,
  isRefusedArgv,
  maxEnvelopeBytes,
  sshFingerprint,
} from '../src/sshadmin';
import type { SshAdminDeps, SudoBroker } from '../src/sshadmin';
import type {
  AdminRunRequest,
  AuditEntry,
  ExecLocalResponse,
  FleetConfig,
  PairBundle,
  PeerView,
} from '../src/types';
import type { RunOptions, RunResult } from '../src/util';
import { run } from '../src/util';

const SENTINEL_PASSWORD = 'correct-horse-battery-staple-7719';

let dir: string;
let stateRoot: string;
let clock: number;
let prevStateEnv: string | undefined;

// The target leg's replay guard writes one marker per runId under stateDir(), so every test needs
// its own state root -- otherwise a fixed runId reused across tests is a genuine duplicate.
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'sukarfleet-sshadmin-'));
  stateRoot = join(dir, 'state');
  await mkdir(stateRoot, { recursive: true });
  prevStateEnv = process.env.SUKARFLEET_STATE;
  process.env.SUKARFLEET_STATE = stateRoot;
  clock = 1_700_000_000_000;
});

afterEach(async () => {
  if (prevStateEnv === undefined) delete process.env.SUKARFLEET_STATE;
  else process.env.SUKARFLEET_STATE = prevStateEnv;
  await rm(dir, { recursive: true, force: true });
});

function runMarkerDir(): string {
  return join(stateRoot, 'admin-runs');
}

const now = (): number => clock;

function cfgFor(machine: string, overrides: Partial<FleetConfig['admin']> = {}): FleetConfig {
  const base = defaultConfig(machine);
  return {
    ...base,
    machine,
    role: machine === 'alpha' ? 'anchor' : 'roamer',
    meshIp: machine === 'alpha' ? '192.0.2.1' : '192.0.2.2',
    peers: [],
    admin: {
      ...base.admin,
      enabled: true,
      // These tests exercise lane MECHANICS -- transport, host keys, capture caps, the registry --
      // not origin policy, and the request helper below stamps an agent origin. Stated explicitly
      // so the agent-origin gate (which defaults to 'refuse') does not silently turn every case in
      // this file into a refusal test. The gate has its own tests.
      agentOrigin: 'allow',
      sshUser: 'fleetuser',
      keyPath: join(dir, 'id_sukarfleet_ed25519'),
      knownHostsPath: join(dir, 'known_hosts'),
      authorizedKeysPath: join(dir, 'authorized_keys'),
      secretsDir: join(dir, 'secrets'),
      ...overrides,
    },
  };
}

function withPeer(cfg: FleetConfig, peer: Partial<FleetConfig['peers'][number]>): FleetConfig {
  return {
    ...cfg,
    peers: [
      {
        name: 'alpha',
        meshIp: '192.0.2.1',
        nodePort: 7710,
        publicKeyJwk: { kty: 'EC' } as JsonWebKey,
        ...peer,
      },
    ],
  };
}

// ---------------------------------------------------------------------------
// Scripted runner: records every invocation and replays queued results.
// ---------------------------------------------------------------------------

interface RunCall {
  argv: string[];
  opts: RunOptions;
}

interface ScriptedResult extends Partial<RunResult> {
  advanceMs?: number;
}

function scriptRunner(results: ScriptedResult[]): { runner: typeof run; calls: RunCall[] } {
  const calls: RunCall[] = [];
  const runner = (async (argv: string[], opts: RunOptions = {}): Promise<RunResult> => {
    calls.push({ argv: [...argv], opts });
    const next = results.shift() ?? { code: 0, stdout: '', stderr: '' };
    clock += next.advanceMs ?? 0;
    return {
      code: next.code ?? 0,
      stdout: next.stdout ?? '',
      stderr: next.stderr ?? '',
      ...(next.truncated !== undefined ? { truncated: next.truncated } : {}),
    };
  }) as typeof run;
  return { runner, calls };
}

function envelope(patch: Partial<ExecLocalResponse> = {}): string {
  const res: ExecLocalResponse = {
    v: 1,
    exitCode: 0,
    stdout: 'ok\n',
    stderr: '',
    truncated: false,
    durationMs: 5,
    ...patch,
  };
  return JSON.stringify(res) + '\n';
}

interface Harness {
  admin: SshAdmin;
  calls: RunCall[];
  audits: { kind: string; detail: Record<string, unknown> }[];
  broker: SudoBroker & { staleCalls: number[] };
}

function harness(cfg: FleetConfig, results: ScriptedResult[], brokerOverride?: Partial<SudoBroker>): Harness {
  const { runner, calls } = scriptRunner(results);
  const audits: { kind: string; detail: Record<string, unknown> }[] = [];
  const staleCalls: number[] = [];
  const broker = {
    staleCalls,
    withSudoPassword: async <T,>(_cfg: FleetConfig, fn: (pw: string) => Promise<T>): Promise<T> =>
      fn(SENTINEL_PASSWORD),
    markStale: async (_cfg: FleetConfig, atMs: number): Promise<void> => {
      staleCalls.push(atMs);
    },
    status: async (): Promise<{ present: boolean; stale: boolean }> => ({ present: true, stale: false }),
    ...brokerOverride,
  } as SudoBroker & { staleCalls: number[] };

  const deps: SshAdminDeps = {
    cfg,
    auditAppend: async (kind, detail): Promise<AuditEntry> => {
      audits.push({ kind, detail });
      return { v: 1, machine: cfg.machine, seq: audits.length, tsMs: now(), kind, detail, sigB64: '' };
    },
    peerView: (): PeerView | null => null,
    now,
    runner,
    secrets: broker,
    publicKeyJwk: { kty: 'EC' } as JsonWebKey,
    sshHostKeyDir: join(dir, 'etcssh'),
  };
  return { admin: new SshAdmin(deps), calls, audits, broker };
}

// A pinned known_hosts line in the exact shape pinHostKeys writes. The blob is not a real key --
// nothing under test here fingerprints it; what matters is the host token and the marker.
async function pinHostToken(cfg: FleetConfig, token: string, machine: string): Promise<void> {
  await writeFile(
    cfg.admin.knownHostsPath,
    `${token} ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIPINNED # sukarfleet:${machine}\n`,
    'utf8',
  );
}

function request(patch: Partial<AdminRunRequest> = {}): AdminRunRequest {
  return {
    machine: 'alpha',
    argv: ['systemctl', 'restart', 'easytier-fleet.service'],
    reason: 'restart the mesh after a config change',
    requestedBy: { kind: 'agent', client: 'fleet.admin_run' },
    ...patch,
  };
}

// ---------------------------------------------------------------------------
// argv construction
// ---------------------------------------------------------------------------

describe('buildSshArgv', () => {
  test('pins every option, token for token, over the mesh', () => {
    const cfg = withPeer(cfgFor('beta'), {});
    const argv = buildSshArgv(cfg, cfg.peers[0]!, 'PAYLOAD', false);
    expect(argv).toEqual([
      'ssh',
      '-T',
      '-F',
      'none',
      '-o',
      'BatchMode=yes',
      '-o',
      'StrictHostKeyChecking=yes',
      '-o',
      `UserKnownHostsFile=${join(dir, 'known_hosts')}`,
      '-o',
      'GlobalKnownHostsFile=/dev/null',
      '-o',
      'IdentitiesOnly=yes',
      '-o',
      'IdentityAgent=none',
      '-o',
      'ClearAllForwardings=yes',
      '-o',
      'RequestTTY=no',
      '-o',
      'ConnectTimeout=8',
      '-o',
      'ServerAliveInterval=15',
      '-o',
      'ServerAliveCountMax=4',
      '-i',
      join(dir, 'id_sukarfleet_ed25519'),
      '-p',
      '22',
      '-l',
      'fleetuser',
      '192.0.2.1',
      'PAYLOAD',
    ]);
  });

  test('adds exactly one ProxyCommand option for the Cloudflare fallback', () => {
    const cfg = withPeer(cfgFor('beta'), { sshFallbackHost: 'ssh.example.com' });
    const mesh = buildSshArgv(cfg, cfg.peers[0]!, 'P', false);
    const cf = buildSshArgv(cfg, cfg.peers[0]!, 'P', true);
    expect(cf.length).toBe(mesh.length + 2);
    expect(cf).toContain('ProxyCommand=cloudflared access ssh --hostname ssh.example.com');
    expect(cf.filter((t) => t.startsWith('ProxyCommand=')).length).toBe(1);
  });

  test('peer overrides win over the admin defaults', () => {
    const cfg = withPeer(cfgFor('beta'), { sshHost: 'anchor.example.com', sshPort: 2222 });
    const argv = buildSshArgv(cfg, cfg.peers[0]!, 'P', false);
    expect(argv[argv.length - 2]).toBe('anchor.example.com');
    expect(argv[argv.indexOf('-p') + 1]).toBe('2222');
  });
});

// ---------------------------------------------------------------------------
// payload codec
// ---------------------------------------------------------------------------

describe('exec-local payload codec', () => {
  const good = {
    v: 1 as const,
    runId: 'abc-123',
    originMachine: 'beta',
    argv: ['id', '-u'],
    reason: 'check the effective uid',
    timeoutSec: 30,
  };

  test('round trips', () => {
    expect(decodeExecLocal(encodeExecLocal(good))).toEqual(good);
  });

  test('carries no credential field of any kind', () => {
    const json = Buffer.from(encodeExecLocal(good), 'base64').toString('utf8');
    expect(Object.keys(JSON.parse(json)).sort()).toEqual([
      'argv',
      'originMachine',
      'reason',
      'runId',
      'timeoutSec',
      'v',
    ]);
  });

  const rejected: [string, unknown][] = [
    ['empty argv', { ...good, argv: [] }],
    ['too many argv tokens', { ...good, argv: Array.from({ length: 65 }, () => 'x') }],
    ['NUL in an argv token', { ...good, argv: ['id', 'a\0b'] }],
    ['non-string argv token', { ...good, argv: ['id', 7] }],
    ['empty reason', { ...good, reason: '   ' }],
    ['bad version', { ...good, v: 2 }],
    ['non-integer timeout', { ...good, timeoutSec: 1.5 }],
    ['runId with shell metacharacters', { ...good, runId: 'a;rm -rf /' }],
  ];
  for (const [name, payload] of rejected) {
    test(`refuses ${name}`, () => {
      const b64 = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64');
      expect(() => decodeExecLocal(b64)).toThrow();
    });
  }

  test('refuses a payload over 8 KiB', () => {
    const big = { ...good, reason: 'x'.repeat(900), argv: Array.from({ length: 60 }, () => 'y'.repeat(200)) };
    const b64 = Buffer.from(JSON.stringify(big), 'utf8').toString('base64');
    expect(() => decodeExecLocal(b64)).toThrow(/8192/);
  });

  test('refuses non-base64 input', () => {
    expect(() => decodeExecLocal('not base64!!')).toThrow();
    expect(() => decodeExecLocal('')).toThrow();
  });
});

// ---------------------------------------------------------------------------
// refusal set + destructive tripwire
// ---------------------------------------------------------------------------

describe('isRefusedArgv', () => {
  test('allows an ordinary admin command', () => {
    const cfg = cfgFor('alpha');
    expect(isRefusedArgv(cfg, ['systemctl', 'restart', 'easytier-fleet.service'])).toBeNull();
    expect(isRefusedArgv(cfg, ['journalctl', '-u', 'sukarfleet', '-n', '50'])).toBeNull();
  });

  test('refuses anything naming the credential store', () => {
    const cfg = cfgFor('alpha');
    expect(isRefusedArgv(cfg, ['cat', join(dir, 'secrets', 'sudo.cred')])).toBe('refused-argv');
    expect(isRefusedArgv(cfg, ['ls', '-la', join(dir, 'secrets')])).toBe('refused-argv');
    expect(isRefusedArgv(cfg, ['cat', 'sudo.meta.json'])).toBe('refused-argv');
  });

  test('refuses systemd-creds decrypt, direct or wrapped in a shell string', () => {
    const cfg = cfgFor('alpha');
    expect(isRefusedArgv(cfg, ['systemd-creds', 'decrypt', 'x.cred', '-'])).toBe('refused-argv');
    expect(isRefusedArgv(cfg, ['/usr/bin/systemd-creds', 'decrypt', 'x.cred'])).toBe('refused-argv');
    expect(isRefusedArgv(cfg, ['sh', '-c', 'systemd-creds decrypt x.cred -'])).toBe('refused-argv');
  });

  test('does not refuse systemd-creds for a non-decrypt verb', () => {
    expect(isRefusedArgv(cfgFor('alpha'), ['systemd-creds', 'list'])).toBeNull();
  });
});

describe('DESTRUCTIVE_PATTERNS', () => {
  test('match the commands the GUI must ask twice about', () => {
    const hits = ['rm -rf /var/log', 'mkfs.ext4 /dev/sdb1', 'dd if=/dev/zero of=/dev/sda', 'shutdown -h now', 'reboot', 'userdel bob'];
    for (const cmd of hits) {
      expect(DESTRUCTIVE_PATTERNS.some((re) => re.test(cmd))).toBe(true);
    }
  });

  test('leave ordinary commands alone', () => {
    for (const cmd of ['systemctl status sukarfleet', 'journalctl -n 20', 'apt list --installed']) {
      expect(DESTRUCTIVE_PATTERNS.some((re) => re.test(cmd))).toBe(false);
    }
  });

  test('are stateless across repeated tests (no /g flag)', () => {
    for (const re of DESTRUCTIVE_PATTERNS) expect(re.global).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// transport fallback selection
// ---------------------------------------------------------------------------

describe('classifySshOutcome', () => {
  test('only a 255 carrying ssh\'s own PRE-SESSION diagnostic is a connect failure', () => {
    expect(classifySshOutcome(255, '', 'ssh: connect to host port 22: No route to host', false).connectFailure).toBe(true);
    expect(classifySshOutcome(255, envelope(), '', false).connectFailure).toBe(false);
    expect(classifySshOutcome(1, '', 'something', false).connectFailure).toBe(false);
    expect(classifySshOutcome(0, envelope(), '', false).connectFailure).toBe(false);
  });

  test('every pre-session diagnostic OpenSSH emits before a session exists is recognized', () => {
    const preSession = [
      'ssh: connect to host 192.0.2.1 port 22: Connection refused',
      'ssh: connect to host 192.0.2.1 port 22: No route to host',
      'ssh: connect to host 192.0.2.1 port 22: Connection timed out',
      'ssh: Could not resolve hostname anchor.example.com: Name or service not known',
      'sukarfleet@192.0.2.1: Permission denied (publickey).',
    ];
    for (const stderr of preSession) {
      expect(classifySshOutcome(255, '', stderr, false).connectFailure).toBe(true);
    }
  });

  // The defect this guards: a ServerAlive timeout (15s x 4) kills a session that ALREADY STARTED
  // the forced command, and ssh reports it as 255 with empty stdout -- because the envelope is
  // written only when the command finishes. Calling that a proven connect failure is what let the
  // Cloudflare re-dial run a root command a second time.
  test('a 255 that could have executed is never a connect failure', () => {
    const midSession = [
      'Timeout, server 192.0.2.1 not responding.',
      'client_loop: send disconnect: Broken pipe',
      'Connection to 192.0.2.1 closed by remote host.',
      '',
    ];
    for (const stderr of midSession) {
      const out = classifySshOutcome(255, '', stderr, false);
      expect(out.connectFailure).toBe(false);
      expect(out.refusal).toBe('unreachable');
      expect(out.message).toContain('may already have run');
    }
  });

  test('a changed host key is never a fallback candidate', () => {
    const out = classifySshOutcome(255, '', 'REMOTE HOST IDENTIFICATION HAS CHANGED!', false);
    expect(out.connectFailure).toBe(false);
    expect(out.refusal).toBe('hostkey-mismatch');
  });
});

describe('transport fallback', () => {
  test('falls back to Cloudflare only after a connect-level failure', async () => {
    const cfg = withPeer(cfgFor('beta'), { sshFallbackHost: 'ssh.example.com' });
    const h = harness(cfg, [
      { code: 255, stdout: '', stderr: 'ssh: connect to host 192.0.2.1 port 22: No route to host' },
      { code: 0, stdout: envelope({ stdout: 'served over cf\n' }) },
    ]);
    const res = await h.admin.runAdmin(request());
    expect(h.calls.length).toBe(2);
    expect(h.calls[0]!.argv.some((t) => t.startsWith('ProxyCommand='))).toBe(false);
    expect(h.calls[1]!.argv.some((t) => t.startsWith('ProxyCommand='))).toBe(true);
    expect(res.transport).toBe('cf');
    expect(res.ok).toBe(true);
  });

  test('NEVER retries a command that actually executed', async () => {
    const cfg = withPeer(cfgFor('beta'), { sshFallbackHost: 'ssh.example.com' });
    // Exit 255 is ambiguous by code alone -- but the target answered, so the command ran.
    const h = harness(cfg, [{ code: 255, stdout: envelope({ exitCode: 255, stdout: 'partial\n' }) }]);
    const res = await h.admin.runAdmin(request());
    expect(h.calls.length).toBe(1);
    expect(res.transport).toBe('mesh');
    expect(res.exitCode).toBe(255);
  });

  test('a non-255 failure is never retried', async () => {
    const cfg = withPeer(cfgFor('beta'), { sshFallbackHost: 'ssh.example.com' });
    const h = harness(cfg, [{ code: 1, stdout: envelope({ exitCode: 1, stdout: '', stderr: 'boom\n' }) }]);
    const res = await h.admin.runAdmin(request());
    expect(h.calls.length).toBe(1);
    expect(res.exitCode).toBe(1);
    expect(res.ok).toBe(false);
  });

  test('a host key mismatch refuses and does not touch the fallback', async () => {
    const cfg = withPeer(cfgFor('beta'), { sshFallbackHost: 'ssh.example.com' });
    await pinHostToken(cfg, '192.0.2.1', 'alpha');
    const h = harness(cfg, [
      { code: 255, stdout: '', stderr: '@@@ WARNING: REMOTE HOST IDENTIFICATION HAS CHANGED! @@@\nHost key verification failed.' },
    ]);
    const res = await h.admin.runAdmin(request());
    expect(h.calls.length).toBe(1);
    expect(res.refusal).toBe('hostkey-mismatch');
    expect(res.exitCode).toBeNull();
  });

  // A 255 the origin cannot prove is a failed CONNECT must not buy a second execution, even with
  // a fallback host configured and even though ssh said nothing on stdout.
  test('a mid-session death never re-dials over the Cloudflare fallback', async () => {
    const cfg = withPeer(cfgFor('beta'), { sshFallbackHost: 'ssh.example.com' });
    const h = harness(cfg, [{ code: 255, stdout: '', stderr: 'Timeout, server 192.0.2.1 not responding.' }]);
    const res = await h.admin.runAdmin(request());
    expect(h.calls.length).toBe(1);
    expect(res.refusal).toBe('unreachable');
    expect(res.message).toContain('may already have run');
  });

  test('without a configured fallback host a connect failure is terminal', async () => {
    const cfg = withPeer(cfgFor('beta'), {});
    const h = harness(cfg, [{ code: 255, stdout: '', stderr: 'connection refused' }]);
    const res = await h.admin.runAdmin(request());
    expect(h.calls.length).toBe(1);
    expect(res.refusal).toBe('unreachable');
  });

  test('the ssh channel carries no stdin at all', async () => {
    const cfg = withPeer(cfgFor('beta'), {});
    const h = harness(cfg, [{ code: 0, stdout: envelope() }]);
    await h.admin.runAdmin(request());
    expect(h.calls[0]!.opts.stdin).toBeUndefined();
    expect(h.calls[0]!.opts.env).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// origin-side gates
// ---------------------------------------------------------------------------

describe('origin gates', () => {
  test('a disabled lane refuses before dialling', async () => {
    const cfg = withPeer(cfgFor('beta', { enabled: false }), {});
    const h = harness(cfg, []);
    const res = await h.admin.runAdmin(request());
    expect(res.refusal).toBe('lane-disabled-local');
    expect(h.calls.length).toBe(0);
  });

  test('an empty reason is a refusal, not a default', async () => {
    const cfg = withPeer(cfgFor('beta'), {});
    const h = harness(cfg, []);
    expect((await h.admin.runAdmin(request({ reason: '  ' }))).refusal).toBe('missing-reason');
    expect(h.calls.length).toBe(0);
  });

  test('an unconfigured or unpaired peer refuses', async () => {
    const h1 = harness(cfgFor('beta'), []);
    expect((await h1.admin.runAdmin(request())).refusal).toBe('not-paired');
    const h2 = harness(withPeer(cfgFor('beta'), { publicKeyJwk: null }), []);
    expect((await h2.admin.runAdmin(request())).refusal).toBe('not-paired');
  });

  test('an empty admin.sshUser refuses as not-configured', async () => {
    const cfg = withPeer(cfgFor('beta', { sshUser: '' }), {});
    const h = harness(cfg, []);
    expect((await h.admin.runAdmin(request())).refusal).toBe('not-configured');
    expect(h.calls.length).toBe(0);
  });

  test('the rate limit is per target and refuses without dialling', async () => {
    const cfg = withPeer(cfgFor('beta', { ratePerMin: 2 }), {});
    const h = harness(cfg, [
      { code: 0, stdout: envelope() },
      { code: 0, stdout: envelope() },
    ]);
    expect((await h.admin.runAdmin(request())).refusal).toBeUndefined();
    expect((await h.admin.runAdmin(request())).refusal).toBeUndefined();
    const third = await h.admin.runAdmin(request());
    expect(third.refusal).toBe('rate-limited');
    expect(h.calls.length).toBe(2);
  });

  test('bad argv never reaches a subprocess', async () => {
    const cfg = withPeer(cfgFor('beta'), {});
    const h = harness(cfg, []);
    expect((await h.admin.runAdmin(request({ argv: [] }))).refusal).toBe('bad-argv');
    expect((await h.admin.runAdmin(request({ argv: ['id\0'] }))).refusal).toBe('bad-argv');
    expect(h.calls.length).toBe(0);
  });

  test('a requested timeout is clamped down to maxRunTimeoutSec, never up', async () => {
    const cfg = withPeer(cfgFor('beta', { maxRunTimeoutSec: 60, runTimeoutSec: 30 }), {});
    const h = harness(cfg, [{ code: 0, stdout: envelope() }]);
    await h.admin.runAdmin(request({ timeoutSec: 99999 }));
    const requested = h.audits.find((a) => a.kind === 'admin-run-requested')!;
    expect(requested.detail.timeoutSec).toBe(60);
    const payload = JSON.parse(
      Buffer.from(h.calls[0]!.argv[h.calls[0]!.argv.length - 1]!, 'base64').toString('utf8'),
    );
    expect(payload.timeoutSec).toBe(60);
  });
});

// ---------------------------------------------------------------------------
// audit contract
// ---------------------------------------------------------------------------

describe('audit', () => {
  test('requested comes before completed, and records byte counts rather than output', async () => {
    const cfg = withPeer(cfgFor('beta'), {});
    const h = harness(cfg, [{ code: 0, stdout: envelope({ stdout: 'SECRET-LOOKING OUTPUT\n' }) }]);
    await h.admin.runAdmin(request());
    expect(h.audits.map((a) => a.kind)).toEqual(['admin-run-requested', 'admin-run-completed']);
    const completed = h.audits[1]!.detail;
    expect(completed.stdoutBytes).toBe('SECRET-LOOKING OUTPUT\n'.length);
    expect(JSON.stringify(h.audits)).not.toContain('SECRET-LOOKING OUTPUT');
    expect(h.audits[0]!.detail.argv).toEqual(request().argv);
  });

  test('a refusal appends admin-run-refused INSTEAD of completed', async () => {
    const cfg = withPeer(cfgFor('beta'), {});
    const h = harness(cfg, [{ code: 255, stdout: '', stderr: 'no route' }]);
    await h.admin.runAdmin(request());
    expect(h.audits.map((a) => a.kind)).toEqual(['admin-run-requested', 'admin-run-refused']);
    expect(h.audits[1]!.detail.refusal).toBe('unreachable');
  });

  test('an audit-log failure degrades the run instead of failing it', async () => {
    const cfg = withPeer(cfgFor('beta'), {});
    const { runner, calls } = scriptRunner([{ code: 0, stdout: envelope() }]);
    const admin = new SshAdmin({
      cfg,
      auditAppend: async () => {
        throw new Error('audit disk full');
      },
      peerView: () => null,
      now,
      runner,
      secrets: harness(cfg, []).broker,
    });
    const res = await admin.runAdmin(request());
    expect(res.ok).toBe(true);
    expect(res.auditSeq).toBeUndefined();
    expect(calls.length).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// target leg
// ---------------------------------------------------------------------------

describe('execLocal', () => {
  const targetCfg = (): FleetConfig => ({
    ...cfgFor('alpha'),
    peers: [{ name: 'beta', meshIp: '192.0.2.2', nodePort: 7710, publicKeyJwk: { kty: 'EC' } as JsonWebKey }],
  });

  function payload(patch: Record<string, unknown> = {}): string {
    return encodeExecLocal({
      v: 1,
      runId: 'run-1',
      originMachine: 'beta',
      argv: ['id', '-u'],
      reason: 'confirm the forced command runs as root',
      timeoutSec: 30,
      ...patch,
    } as never);
  }

  test('invokes sudo with the exact verified flag form, one password line per process', async () => {
    const h = harness(targetCfg(), [
      { code: 0 },
      { code: 0, stdout: '0\n' },
    ]);
    const res = await h.admin.execLocal(payload());
    expect(res.exitCode).toBe(0);
    expect(res.stdout).toBe('0\n');

    expect(h.calls[0]!.argv).toEqual(['sudo', '-S', '-k', '-p', '', '-v']);
    expect(h.calls[0]!.opts.stdin).toBe(`${SENTINEL_PASSWORD}\n`);
    expect(h.calls[1]!.argv).toEqual(['sudo', '-S', '-k', '-p', '', '--', 'id', '-u']);
    expect(h.calls[1]!.opts.stdin).toBe(`${SENTINEL_PASSWORD}\n`);
    // Exactly one line, exactly one newline: a second read yields "Authentication required but
    // not attempted" on sudo-rs.
    for (const call of h.calls) {
      expect(String(call.opts.stdin).split('\n').length).toBe(2);
    }
  });

  test('caps captured output at admin.maxOutputBytes and reports truncation', async () => {
    const cfg = { ...targetCfg(), admin: { ...targetCfg().admin, maxOutputBytes: 1024 } };
    const h = harness(cfg, [{ code: 0 }, { code: 7, stdout: 'x'.repeat(1024), truncated: true }]);
    const res = await h.admin.execLocal(payload());
    expect(h.calls[1]!.opts.maxCaptureBytes).toBe(1024);
    expect(res.truncated).toBe(true);
    expect(res.exitCode).toBe(7);
  });

  test('a rejected password marks the credential stale and never runs the command', async () => {
    const h = harness(targetCfg(), [{ code: 1, stderr: 'sudo: Authentication failed, try again.' }]);
    const res = await h.admin.execLocal(payload());
    expect(res.refusal).toBe('credential-stale');
    expect(res.exitCode).toBeNull();
    expect(h.calls.length).toBe(1);
    expect(h.calls[0]!.argv).toEqual(['sudo', '-S', '-k', '-p', '', '-v']);
    expect(h.broker.staleCalls).toEqual([clock]);
  });

  // The probe is capped at SUDO_PROBE_TIMEOUT_MS and util.run reports its own kill as 124. Reading
  // that as "sudo rejected the password" latches the credential stale -- an in-process latch plus
  // an on-disk flag whose only production reset is retyping the password at THAT machine's GUI.
  test('a probe that timed out never marks the credential stale', async () => {
    const h = harness(targetCfg(), [{ code: 124, advanceMs: 15_000 }]);
    const res = await h.admin.execLocal(payload());
    expect(res.refusal).toBe('timeout');
    expect(res.exitCode).toBeNull();
    expect(h.broker.staleCalls).toEqual([]);
    // The command itself is still never run: a probe that did not answer is not an authentication.
    expect(h.calls.length).toBe(1);
    expect(h.calls[0]!.argv).toEqual(['sudo', '-S', '-k', '-p', '', '-v']);
  });

  test('a genuine early exit 124 from the probe still marks the credential stale', async () => {
    const h = harness(targetCfg(), [{ code: 124, advanceMs: 10 }]);
    const res = await h.admin.execLocal(payload());
    expect(res.refusal).toBe('credential-stale');
    expect(h.broker.staleCalls).toEqual([clock]);
  });

  test('a timeout is reported as a refusal, not as exit 124', async () => {
    const h = harness(targetCfg(), [{ code: 0 }, { code: 124, advanceMs: 30_000 }]);
    const res = await h.admin.execLocal(payload({ timeoutSec: 30 }));
    expect(res.refusal).toBe('timeout');
    expect(res.exitCode).toBeNull();
  });

  test('a genuine exit 124 that finished early is not mistaken for a timeout', async () => {
    const h = harness(targetCfg(), [{ code: 0 }, { code: 124, advanceMs: 10 }]);
    const res = await h.admin.execLocal(payload({ timeoutSec: 30 }));
    expect(res.refusal).toBeUndefined();
    expect(res.exitCode).toBe(124);
  });

  test('the refusal set fires before any sudo process is spawned, and is audited', async () => {
    const cfg = targetCfg();
    const h = harness(cfg, []);
    const res = await h.admin.execLocal(payload({ argv: ['cat', join(cfg.admin.secretsDir, 'sudo.cred')] }));
    expect(res.refusal).toBe('refused-argv');
    expect(h.calls.length).toBe(0);
    expect(h.audits.map((a) => a.kind)).toEqual(['admin-run-refused']);
    expect(h.audits[0]!.detail.refusal).toBe('refused-argv');
  });

  test('systemd-creds decrypt is refused and recorded', async () => {
    const h = harness(targetCfg(), []);
    const res = await h.admin.execLocal(payload({ argv: ['systemd-creds', 'decrypt', 'sudo.cred', '-'] }));
    expect(res.refusal).toBe('refused-argv');
    expect(h.calls.length).toBe(0);
  });

  test('acceptIncoming:false refuses every incoming run', async () => {
    const base = targetCfg();
    const h = harness({ ...base, admin: { ...base.admin, acceptIncoming: false } }, []);
    const res = await h.admin.execLocal(payload());
    expect(res.refusal).toBe('lane-disabled-target');
    expect(h.calls.length).toBe(0);
  });

  test('an origin machine nobody has ever paired with is refused', async () => {
    const h = harness(targetCfg(), []);
    const res = await h.admin.execLocal(payload({ originMachine: 'attacker' }));
    expect(res.refusal).toBe('not-paired');
    expect(h.calls.length).toBe(0);
  });

  test('an undecodable payload is a refusal, is audited, and never spawns anything', async () => {
    const h = harness(targetCfg(), []);
    const res = await h.admin.execLocal('!!!not base64!!!');
    expect(res.refusal).toBe('bad-argv');
    expect(h.calls.length).toBe(0);
    expect(h.audits[0]!.kind).toBe('admin-run-refused');
    // The attacker-supplied bytes are not copied into the log.
    expect(JSON.stringify(h.audits)).not.toContain('!!!not base64!!!');
  });

  test('a credential-store error maps to a fixed refusal, never to the underlying message', async () => {
    const err = Object.assign(new Error('sukarfleet secrets: no sudo credential stored in /x'), {
      reason: 'no-credential',
      name: 'SudoCredentialUnavailable',
    });
    const h = harness(targetCfg(), [], {
      withSudoPassword: async () => {
        throw err;
      },
    });
    const res = await h.admin.execLocal(payload());
    expect(res.refusal).toBe('no-credential');
    expect(res.message).not.toContain('/x');
  });

  test('credentialMode nopasswd never unseals anything', async () => {
    const base = targetCfg();
    const h = harness({ ...base, admin: { ...base.admin, credentialMode: 'nopasswd' } }, [
      { code: 0, stdout: 'root\n' },
    ]);
    const res = await h.admin.execLocal(payload({ argv: ['whoami'] }));
    expect(h.calls.length).toBe(1);
    expect(h.calls[0]!.argv).toEqual(['sudo', '-n', '--', 'whoami']);
    expect(h.calls[0]!.opts.stdin).toBeUndefined();
    expect(res.exitCode).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// replay guard -- one runId, at most one execution, across processes
// ---------------------------------------------------------------------------

describe('the on-disk replay guard', () => {
  const targetCfg = (): FleetConfig => ({
    ...cfgFor('alpha'),
    peers: [{ name: 'beta', meshIp: '192.0.2.2', nodePort: 7710, publicKeyJwk: { kty: 'EC' } as JsonWebKey }],
  });

  function payload(runId: string, argv: string[] = ['id', '-u']): string {
    return encodeExecLocal({
      v: 1,
      runId,
      originMachine: 'beta',
      argv,
      reason: 'the origin re-dialled the same payload',
      timeoutSec: 30,
    });
  }

  test('a redelivered runId is never executed a second time, even by a fresh process', async () => {
    const cfg = targetCfg();
    const first = harness(cfg, [{ code: 0 }, { code: 0, stdout: 'uid=0\n' }]);
    const one = await first.admin.execLocal(payload('replay-1'));
    expect(one.exitCode).toBe(0);
    expect(first.calls.length).toBe(2);

    // The Cloudflare re-dial is a second SSH connection, i.e. a second forced-command PROCESS:
    // nothing in memory survives, which is exactly why the guard is a file both of them see.
    const second = harness(cfg, [{ code: 0 }, { code: 0, stdout: 'uid=0\n' }]);
    const two = await second.admin.execLocal(payload('replay-1'));
    expect(second.calls.length).toBe(0);
    expect(two.exitCode).toBe(0);
    expect(two.message).toContain('was not run again');
    expect(second.audits.map((a) => a.kind)).toEqual(['admin-run-refused']);
    expect(second.audits[0]!.detail.refusal).toBe('duplicate-run');
  });

  test('a duplicate arriving while the first attempt is still in flight starts nothing', async () => {
    await mkdir(runMarkerDir(), { recursive: true });
    // A claimed marker with no recorded outcome: the state a process that is still running -- or
    // that was killed mid-run when its ssh session died -- leaves behind.
    const fh = await open(join(runMarkerDir(), 'replay-2'), 'wx', 0o600);
    await fh.close();

    const h = harness(targetCfg(), [{ code: 0 }, { code: 0, stdout: 'uid=0\n' }]);
    const res = await h.admin.execLocal(payload('replay-2'));
    expect(h.calls.length).toBe(0);
    expect(res.exitCode).toBeNull();
    expect(res.message).toContain('already in flight');
  });

  test('a recorded refusal is replayed as that refusal, still without running anything', async () => {
    const cfg = targetCfg();
    const argv = ['cat', join(cfg.admin.secretsDir, 'sudo.cred')];
    const first = harness(cfg, []);
    expect((await first.admin.execLocal(payload('replay-3', argv))).refusal).toBe('refused-argv');

    const second = harness(cfg, [{ code: 0 }, { code: 0 }]);
    const res = await second.admin.execLocal(payload('replay-3', argv));
    expect(second.calls.length).toBe(0);
    expect(res.refusal).toBe('refused-argv');
    expect(res.message).toContain('was not run again');
  });

  test('the marker records the outcome and never the command output', async () => {
    const h = harness(targetCfg(), [{ code: 0 }, { code: 3, stdout: 'SECRET-LOOKING OUTPUT\n', stderr: 'SECRET-STDERR\n' }]);
    const res = await h.admin.execLocal(payload('replay-4'));
    // The origin gets the real output on the first delivery...
    expect(res.stdout).toBe('SECRET-LOOKING OUTPUT\n');
    // ...and nothing of it is persisted on the target, where it would outlive the run.
    const marker = await readFile(join(runMarkerDir(), 'replay-4'), 'utf8');
    expect(JSON.parse(marker).exitCode).toBe(3);
    expect(marker).not.toContain('SECRET-LOOKING OUTPUT');
    expect(marker).not.toContain('SECRET-STDERR');
  });

  test('a runId can never name a path outside the marker directory', async () => {
    const h = harness(targetCfg(), [{ code: 0 }, { code: 0 }]);
    for (const runId of ['../escape', 'a/b', '..', './escape', '/tmp/escape']) {
      const raw = Buffer.from(
        JSON.stringify({
          v: 1,
          runId,
          originMachine: 'beta',
          argv: ['id'],
          reason: 'path traversal through the run id',
          timeoutSec: 30,
        }),
        'utf8',
      ).toString('base64');
      expect((await h.admin.execLocal(raw)).refusal).toBe('bad-argv');
    }
    expect(h.calls.length).toBe(0);
    expect(await Bun.file(join(stateRoot, 'escape')).exists()).toBe(false);
    expect(await Bun.file(join(dir, 'escape')).exists()).toBe(false);
  });

  test('markers past the TTL are pruned and live ones are kept', async () => {
    await mkdir(runMarkerDir(), { recursive: true });
    const ancient = join(runMarkerDir(), 'ancient-run');
    await writeFile(ancient, '{}\n', 'utf8');
    await utimes(ancient, new Date(1000), new Date(1000));

    const h = harness(targetCfg(), [{ code: 0 }, { code: 0, stdout: 'uid=0\n' }]);
    await h.admin.execLocal(payload('fresh-run'));
    const left = await readdir(runMarkerDir());
    expect(left).toContain('fresh-run');
    expect(left).not.toContain('ancient-run');
  });

  test('a marker directory that cannot be created refuses the run rather than running it', async () => {
    // stateDir() pointed at a FILE: the runs directory cannot exist. Fail closed -- an unusable
    // guard must cost a run, never buy an unguarded execution.
    await writeFile(join(dir, 'not-a-dir'), 'x', 'utf8');
    process.env.SUKARFLEET_STATE = join(dir, 'not-a-dir');
    const h = harness(targetCfg(), [{ code: 0 }, { code: 0 }]);
    const res = await h.admin.execLocal(payload('fail-closed-1'));
    expect(h.calls.length).toBe(0);
    expect(res.refusal).toBe('not-configured');
    expect(h.audits[0]!.kind).toBe('admin-run-refused');
  });
});

// ---------------------------------------------------------------------------
// host key refusals -- "changed" and "never pinned" are different events
// ---------------------------------------------------------------------------

describe('host key refusals', () => {
  const changed = '@@@ WARNING: REMOTE HOST IDENTIFICATION HAS CHANGED! @@@\nHost key verification failed.';
  // OpenSSH's wording for a host it has no key for at all -- same trailing line, different event.
  const neverPinned =
    'No ED25519 host key is known for 192.0.2.1 and you have requested strict checking.\nHost key verification failed.';

  test('a host with no pinned key at all is not a mismatch', async () => {
    const cfg = withPeer(cfgFor('beta'), {});
    const h = harness(cfg, [{ code: 255, stdout: '', stderr: neverPinned }]);
    const res = await h.admin.runAdmin(request());
    expect(res.refusal).toBe('not-paired');
    expect(res.message).toContain('no host key is pinned for 192.0.2.1');
  });

  // The no-attacker trigger: pinHostKeys pins the port known at PAIRING time, buildSshArgv reads
  // the port at CALL time, so adding a peer sshPort override desynchronizes the two.
  test('a pin for a different port is a config drift, not a hostile key change', async () => {
    const cfg = withPeer(cfgFor('beta'), { sshPort: 2222 });
    await pinHostToken(cfg, '192.0.2.1', 'alpha');
    const h = harness(cfg, [{ code: 255, stdout: '', stderr: changed }]);
    const res = await h.admin.runAdmin(request());
    expect(res.refusal).toBe('not-paired');
    expect(res.message).toContain('[192.0.2.1]:2222');
  });

  test('a pin that exists for the dialled host:port and disagrees stays a mismatch', async () => {
    const cfg = withPeer(cfgFor('beta'), { sshPort: 2222 });
    await pinHostToken(cfg, '[192.0.2.1]:2222', 'alpha');
    const h = harness(cfg, [{ code: 255, stdout: '', stderr: changed }]);
    expect((await h.admin.runAdmin(request())).refusal).toBe('hostkey-mismatch');
  });

  test('a pin belonging to another machine does not vouch for this peer', async () => {
    const cfg = withPeer(cfgFor('beta'), {});
    await pinHostToken(cfg, '192.0.2.1', 'someone-else');
    const h = harness(cfg, [{ code: 255, stdout: '', stderr: changed }]);
    expect((await h.admin.runAdmin(request())).refusal).toBe('not-paired');
  });
});

// ---------------------------------------------------------------------------
// origin capture cap -- a command that ran must never come back as nothing
// ---------------------------------------------------------------------------

describe('origin capture cap', () => {
  test('clears a real worst-case envelope, measured rather than assumed', async () => {
    const cfg = withPeer(cfgFor('beta', { maxOutputBytes: 4096 }), {});
    const worst = JSON.stringify({
      v: 1,
      exitCode: 0,
      // NUL is the worst byte JSON can be handed: one byte in, six characters out.
      stdout: '\0'.repeat(4096),
      stderr: '\0'.repeat(4096),
      truncated: true,
      durationMs: 1,
      message: 'x'.repeat(1024),
    });
    expect(worst.length).toBeGreaterThan(4096 * 6 * 2);
    expect(maxEnvelopeBytes(cfg)).toBeGreaterThan(worst.length);

    const h = harness(cfg, [{ code: 0, stdout: envelope() }]);
    await h.admin.runAdmin(request());
    expect(h.calls[0]!.opts.maxCaptureBytes).toBe(maxEnvelopeBytes(cfg));
  });

  test('a truncated envelope still reports the exit code of the command that ran', async () => {
    const cut = JSON.stringify({
      v: 1,
      exitCode: 7,
      stdout: 'a'.repeat(4096),
      stderr: '',
      truncated: false,
      durationMs: 5,
    }).slice(0, 64);
    const h = harness(withPeer(cfgFor('beta'), {}), [{ code: 0, stdout: cut, truncated: true }]);
    const res = await h.admin.runAdmin(request());
    expect(res.exitCode).toBe(7);
    expect(res.ok).toBe(false);
    expect(res.truncated).toBe(true);
    expect(res.message).toContain('the command ran and exited 7');
    // It completed, so it is audited as completed -- not as a refusal that never happened.
    expect(h.audits.map((a) => a.kind)).toEqual(['admin-run-requested', 'admin-run-completed']);
  });

  test('a truncated response whose exit code did not survive says the command may have run', async () => {
    const h = harness(withPeer(cfgFor('beta'), {}), [
      { code: 0, stdout: 'a login banner and nothing else', truncated: true },
    ]);
    const res = await h.admin.runAdmin(request());
    expect(res.exitCode).toBeNull();
    expect(res.truncated).toBe(true);
    expect(res.message).toContain('may have run');
  });

  test('an unparseable response that was not truncated still says exactly that', async () => {
    const h = harness(withPeer(cfgFor('beta'), {}), [{ code: 0, stdout: 'garbage\n', truncated: false }]);
    const res = await h.admin.runAdmin(request());
    expect(res.exitCode).toBeNull();
    expect(res.message).toBe('target returned no parseable response envelope');
  });
});

// ---------------------------------------------------------------------------
// self-targeted runs
// ---------------------------------------------------------------------------

describe('a run against this machine', () => {
  test('skips ssh entirely and reports transport local', async () => {
    const h = harness(cfgFor('beta'), [{ code: 0 }, { code: 0, stdout: 'beta\n' }]);
    const res = await h.admin.runAdmin(request({ machine: 'beta', argv: ['hostname'] }));
    expect(res.transport).toBe('local');
    expect(res.stdout).toBe('beta\n');
    expect(h.calls[0]!.argv[0]).toBe('sudo');
    expect(h.calls.some((c) => c.argv[0] === 'ssh')).toBe(false);
    // One machine, one pair of entries: a second completed leg would look like a duplicate in
    // the synced union file.
    expect(h.audits.map((a) => a.kind)).toEqual(['admin-run-requested', 'admin-run-completed']);
  });

  test('obeys the same target-side gates a remote caller hits', async () => {
    const base = cfgFor('beta');
    const h = harness({ ...base, admin: { ...base.admin, acceptIncoming: false } }, []);
    const res = await h.admin.runAdmin(request({ machine: 'beta', argv: ['hostname'] }));
    expect(res.refusal).toBe('lane-disabled-target');
    expect(h.calls.length).toBe(0);
    expect(h.audits.map((a) => a.kind)).toEqual(['admin-run-requested', 'admin-run-refused']);
  });
});

// ---------------------------------------------------------------------------
// the password may not reach argv, env, logs, audit, or any response
// ---------------------------------------------------------------------------

describe('credential containment', () => {
  test('no sink observed during a full target-leg run contains the password', async () => {
    const cfg = {
      ...cfgFor('alpha'),
      peers: [{ name: 'beta', meshIp: '192.0.2.2', nodePort: 7710, publicKeyJwk: { kty: 'EC' } as JsonWebKey }],
    };
    const h = harness(cfg, [{ code: 0 }, { code: 0, stdout: 'done\n' }]);

    const logged: string[] = [];
    const realLog = console.log;
    console.log = (...args: unknown[]): void => {
      logged.push(args.map(String).join(' '));
    };
    let res: ExecLocalResponse;
    try {
      res = await h.admin.execLocal(
        encodeExecLocal({
          v: 1,
          runId: 'run-2',
          originMachine: 'beta',
          argv: ['id'],
          reason: 'containment sweep',
          timeoutSec: 10,
        }),
      );
    } finally {
      console.log = realLog;
    }

    // argv and env of every subprocess
    for (const call of h.calls) {
      expect(call.argv.join('\u0000')).not.toContain(SENTINEL_PASSWORD);
      expect(JSON.stringify(call.opts.env ?? null)).not.toContain(SENTINEL_PASSWORD);
    }
    // the response envelope, the audit log, and every log line
    expect(JSON.stringify(res)).not.toContain(SENTINEL_PASSWORD);
    expect(JSON.stringify(h.audits)).not.toContain(SENTINEL_PASSWORD);
    expect(logged.join('\n')).not.toContain(SENTINEL_PASSWORD);
    // ...and it did reach the one place it is allowed to be.
    expect(h.calls.every((c) => c.opts.stdin === `${SENTINEL_PASSWORD}\n`)).toBe(true);
  });

  test('withSudoPassword has exactly one call site in the whole source tree', async () => {
    const files = ['sshadmin.ts', 'node.ts', 'cli.ts', 'mcp.ts', 'uiserve.ts', 'pairing.ts', 'execroutes.ts'];
    let sites = 0;
    for (const name of files) {
      const path = join(import.meta.dir, '..', 'src', name);
      if (!(await Bun.file(path).exists())) continue;
      sites += (await Bun.file(path).text()).split('withSudoPassword(').length - 1;
    }
    // One in sshadmin.ts (SshAdmin.runSudo) and nowhere else. secrets.ts's own definition is not
    // in the list; a second consumer anywhere fails this assertion.
    expect(sites).toBe(1);
  });

  test('the plaintext binding is used only as a stdin pipe, never interpolated', async () => {
    const src = await Bun.file(join(import.meta.dir, '..', 'src', 'sshadmin.ts')).text();
    const body = src.slice(src.indexOf('private async runSudo('), src.indexOf('private async runSudoNopasswd('));
    // Every occurrence of the binding is either its declaration or `stdin: pw + '\n'`.
    const uses = body.match(/\bpw\b/g) ?? [];
    const stdinUses = body.match(/stdin: pw \+ '\\n'/g) ?? [];
    expect(uses.length).toBe(stdinUses.length + 1);
    expect(stdinUses.length).toBe(2);
    // Nothing in this module ever hands a child process an environment.
    expect(src).not.toMatch(/\benv:\s/);
  });
});

// ---------------------------------------------------------------------------
// run registry
// ---------------------------------------------------------------------------

describe('run registry', () => {
  test('startRun registers immediately and the view completes in place', async () => {
    const cfg = withPeer(cfgFor('beta'), {});
    const h = harness(cfg, [{ code: 0, stdout: envelope({ stdout: 'hi\n' }) }]);
    const { runId } = await h.admin.startRun(request());
    const view = h.admin.getRun(runId);
    expect(view).not.toBeNull();
    expect(view!.reason).toBe(request().reason);
    await Bun.sleep(5);
    const done = h.admin.getRun(runId)!;
    expect(done.running).toBe(false);
    expect(done.stdout).toBe('hi\n');
    expect(h.admin.listRuns(10)[0]!.runId).toBe(runId);
  });

  test('stop() empties the registry and refuses further runs', async () => {
    const cfg = withPeer(cfgFor('beta'), {});
    const h = harness(cfg, [{ code: 0, stdout: envelope() }]);
    await h.admin.runAdmin(request());
    h.admin.stop();
    expect(h.admin.listRuns(10).length).toBe(0);
    expect((await h.admin.runAdmin(request())).refusal).toBe('lane-disabled-local');
  });
});

// ---------------------------------------------------------------------------
// ssh identity and peer files -- real ssh-keygen, real files on disk
// ---------------------------------------------------------------------------

describe('ssh identity and peer trust files', () => {
  async function realKey(name: string): Promise<{ pub: string; fingerprint: string }> {
    const path = join(dir, name);
    const gen = await run(['ssh-keygen', '-t', 'ed25519', '-N', '', '-C', name, '-f', path], { timeoutMs: 20000 });
    expect(gen.code).toBe(0);
    const pub = (await readFile(`${path}.pub`, 'utf8')).trim();
    const shown = await run(['ssh-keygen', '-lf', `${path}.pub`], { timeoutMs: 20000 });
    return { pub, fingerprint: shown.stdout.trim().split(/\s+/)[1]! };
  }

  test('sshFingerprint agrees with ssh-keygen -lf', async () => {
    const { pub, fingerprint } = await realKey('fp_key');
    expect(sshFingerprint(pub)).toBe(fingerprint);
    expect(sshFingerprint('not a key')).toBeNull();
  });

  test('ensureSshIdentity generates once and is idempotent', async () => {
    const cfg = cfgFor('beta');
    const admin = new SshAdmin({ cfg, auditAppend: async () => ({}) as AuditEntry, peerView: () => null, now });
    const first = await admin.ensureSshIdentity();
    expect(first.created).toBe(true);
    expect(first.sshPublicKey.startsWith('ssh-ed25519 ')).toBe(true);
    const second = await admin.ensureSshIdentity();
    expect(second.created).toBe(false);
    expect(second.sshPublicKey).toBe(first.sshPublicKey);
    // The comment is stripped: authorized_keys gets a bare key line and this machine's own
    // option prefix, never the peer's.
    expect(first.sshPublicKey.split(' ').length).toBe(2);
  });

  test('writeAuthorizedKey builds the option prefix locally and replaces by marker', async () => {
    const { pub } = await realKey('peer_key');
    const cfg = cfgFor('alpha'); // anchor: cloudflared terminates on its loopback
    const h = harness(cfg, []);
    const path = cfg.admin.authorizedKeysPath;
    await writeFile(path, 'ssh-ed25519 AAAAUNRELATED beta-claude-tunnel\n', 'utf8');

    const bundle = (over: Partial<PairBundle> = {}): PairBundle => ({
      v: 1,
      machine: 'beta',
      role: 'roamer',
      meshIp: '192.0.2.2',
      nodePort: 7710,
      publicKeyJwk: {} as JsonWebKey,
      sshUser: 'fleetuser',
      sshPublicKey: pub,
      sshHostKeys: [],
      ...over,
    });

    await h.admin.writeAuthorizedKey(bundle());
    await h.admin.writeAuthorizedKey(bundle());
    const text = await readFile(path, 'utf8');
    const lines = text.trim().split('\n');
    // The unrelated tunnel key survives; our line appears exactly once.
    expect(lines.length).toBe(2);
    expect(lines[0]).toContain('beta-claude-tunnel');
    expect(lines[1]).toBe(
      `from="192.0.2.2,127.0.0.1",restrict,command="${forcedCommand()}" ${pub.split(' ').slice(0, 2).join(' ')} # sukarfleet:beta`,
    );
  });

  test('a roamer never admits loopback in from=', async () => {
    const { pub } = await realKey('peer_key2');
    const h = harness(cfgFor('beta'), []);
    await h.admin.writeAuthorizedKey({
      v: 1,
      machine: 'alpha',
      role: 'anchor',
      meshIp: '192.0.2.1',
      nodePort: 7710,
      publicKeyJwk: {} as JsonWebKey,
      sshUser: 'fleetuser',
      sshPublicKey: pub,
      sshHostKeys: [],
    });
    const text = await readFile(join(dir, 'authorized_keys'), 'utf8');
    expect(text).toContain('from="192.0.2.1",restrict,command=');
    expect(text).not.toContain('127.0.0.1');
  });

  test('a peer cannot inject authorized_keys options through its own bundle', async () => {
    const { pub } = await realKey('peer_key3');
    const h = harness(cfgFor('alpha'), []);
    const base: PairBundle = {
      v: 1,
      machine: 'beta',
      role: 'roamer',
      meshIp: '192.0.2.2',
      nodePort: 7710,
      publicKeyJwk: {} as JsonWebKey,
      sshUser: 'fleetuser',
      sshPublicKey: pub,
      sshHostKeys: [],
    };
    await expect(h.admin.writeAuthorizedKey({ ...base, meshIp: '192.0.2.2",command="rm -rf /' })).rejects.toThrow();
    await expect(h.admin.writeAuthorizedKey({ ...base, sshPublicKey: `${pub}\nssh-ed25519 AAAAEXTRA evil` })).rejects.toThrow();
    await expect(h.admin.writeAuthorizedKey({ ...base, sshPublicKey: 'not-a-key' })).rejects.toThrow();
    await expect(h.admin.writeAuthorizedKey({ ...base, machine: '../../etc/passwd' })).rejects.toThrow();
    expect(await Bun.file(join(dir, 'authorized_keys')).exists()).toBe(false);
  });

  test('pinHostKeys writes a pinned entry per host token and revokePeer removes both files', async () => {
    const { pub } = await realKey('host_key');
    const cfg = {
      ...cfgFor('beta'),
      peers: [
        {
          name: 'alpha',
          meshIp: '192.0.2.1',
          nodePort: 7710,
          publicKeyJwk: { kty: 'EC' } as JsonWebKey,
          sshPort: 2222,
        },
      ],
    };
    const h = harness(cfg, []);
    const bundle: PairBundle = {
      v: 1,
      machine: 'alpha',
      role: 'anchor',
      meshIp: '192.0.2.1',
      nodePort: 7710,
      publicKeyJwk: {} as JsonWebKey,
      sshUser: 'fleetuser',
      sshPublicKey: pub,
      sshHostKeys: [pub],
    };
    await h.admin.pinHostKeys(bundle);
    await h.admin.writeAuthorizedKey(bundle);
    const known = await readFile(join(dir, 'known_hosts'), 'utf8');
    expect(known.trim()).toBe(`[192.0.2.1]:2222 ${pub.split(' ').slice(0, 2).join(' ')} # sukarfleet:alpha`);

    const entries = await h.admin.status();
    const peerEntry = entries.find((e) => e.machine === 'alpha')!;
    expect(peerEntry.paired).toBe(true);
    expect(peerEntry.hostKeyFingerprints).toEqual([sshFingerprint(pub)!]);

    await h.admin.revokePeer('alpha');
    expect((await readFile(join(dir, 'known_hosts'), 'utf8')).trim()).toBe('');
    expect((await readFile(join(dir, 'authorized_keys'), 'utf8')).trim()).toBe('');
  });

  test('pinHostKeys refuses a bundle with no usable host key', async () => {
    const h = harness(cfgFor('beta'), []);
    const bundle: PairBundle = {
      v: 1,
      machine: 'alpha',
      role: 'anchor',
      meshIp: '192.0.2.1',
      nodePort: 7710,
      publicKeyJwk: {} as JsonWebKey,
      sshUser: 'fleetuser',
      sshPublicKey: '',
      sshHostKeys: [],
    };
    await expect(h.admin.pinHostKeys(bundle)).rejects.toThrow();
    await expect(h.admin.pinHostKeys({ ...bundle, sshHostKeys: ['garbage'] })).rejects.toThrow();
  });
});

// ---------------------------------------------------------------------------
// status
// ---------------------------------------------------------------------------

describe('status', () => {
  test('reports self first and never claims a peer credential it cannot see', async () => {
    const cfg = withPeer(cfgFor('beta'), {});
    const h = harness(cfg, []);
    const entries = await h.admin.status();
    expect(entries[0]!.self).toBe(true);
    expect(entries[0]!.machine).toBe('beta');
    expect(entries[0]!.credentialReady).toBe(true);
    const peer = entries[1]!;
    expect(peer.self).toBe(false);
    expect(peer.credentialReady).toBe(false);
    // Not pinned yet, so not paired for this lane even though the mesh key is enrolled.
    expect(peer.paired).toBe(false);
    expect(peer.reachable).toBeNull();
  });

  test('a credential store that cannot be read reads as not-ready, never as ready', async () => {
    const cfg = withPeer(cfgFor('beta'), {});
    const h = harness(cfg, [], {
      status: async () => {
        throw new Error('store unreadable');
      },
    });
    const entries = await h.admin.status();
    expect(entries[0]!.credentialReady).toBe(false);
  });
});

describe('inbound door (admin.acceptIncoming)', () => {
  async function peerKey(name: string): Promise<string> {
    const path = join(dir, `door_${name}`);
    const gen = await run(['ssh-keygen', '-t', 'ed25519', '-N', '', '-C', name, '-f', path], { timeoutMs: 20000 });
    expect(gen.code).toBe(0);
    return (await readFile(`${path}.pub`, 'utf8')).trim();
  }

  test('closing removes only the fleet grant and reopening rebuilds it from the stored key', async () => {
    const pub = await peerKey('roundtrip');
    const cfg = withPeer(cfgFor('beta'), { sshPublicKey: pub });
    const admin = new SshAdmin({ cfg, auditAppend: async () => ({}) as AuditEntry, peerView: () => null, now });
    const path = cfg.admin.authorizedKeysPath;
    // A personal key that must survive both directions -- this file is the operator's own.
    const personal = 'ssh-ed25519 AAAAPERSONALKEY user@host';
    await writeFile(path, `${personal}\n`, 'utf8');

    await admin.openInboundDoor();
    let text = await readFile(path, 'utf8');
    expect(text).toContain(personal);
    expect(text).toContain('# sukarfleet:alpha');
    expect(text).toContain('restrict');

    const closed = await admin.closeInboundDoor();
    expect(closed.removed).toEqual(['alpha']);
    text = await readFile(path, 'utf8');
    // The door is shut: sshd has no fleet grant to match, so the peer never reaches the forced
    // command at all. The operator's own key is untouched.
    expect(text).not.toContain('# sukarfleet:alpha');
    expect(text).not.toContain(pub.split(' ')[1]!);
    expect(text).toContain(personal);

    const reopened = await admin.openInboundDoor();
    expect(reopened.restored).toEqual(['alpha']);
    text = await readFile(path, 'utf8');
    expect(text).toContain('# sukarfleet:alpha');
    expect(text).toContain(pub.split(' ')[1]!);
    expect(text).toContain(personal);
  });

  test('closing is idempotent and leaves known_hosts (outbound trust) alone', async () => {
    const pub = await peerKey('idem');
    const cfg = withPeer(cfgFor('beta'), { sshPublicKey: pub });
    const admin = new SshAdmin({ cfg, auditAppend: async () => ({}) as AuditEntry, peerView: () => null, now });
    await writeFile(cfg.admin.knownHostsPath, `[192.0.2.1]:22 ${pub} # sukarfleet:alpha\n`, 'utf8');
    await admin.openInboundDoor();

    expect((await admin.closeInboundDoor()).removed).toEqual(['alpha']);
    expect((await admin.closeInboundDoor()).removed).toEqual([]);
    // Closing the inbound door must not forget who we are willing to dial.
    expect(await readFile(cfg.admin.knownHostsPath, 'utf8')).toContain('# sukarfleet:alpha');
  });

  test('a peer with no stored key is reported rather than silently skipped', async () => {
    const cfg = withPeer(cfgFor('beta'), {});
    const admin = new SshAdmin({ cfg, auditAppend: async () => ({}) as AuditEntry, peerView: () => null, now });
    const r = await admin.openInboundDoor();
    expect(r.restored).toEqual([]);
    expect(r.missingKey).toEqual(['alpha']);
  });

  test('recoverStoredPeerKeys reads the key back out of a live grant', async () => {
    const pub = await peerKey('recover');
    const cfg = withPeer(cfgFor('beta'), { sshPublicKey: pub });
    const admin = new SshAdmin({ cfg, auditAppend: async () => ({}) as AuditEntry, peerView: () => null, now });
    await admin.openInboundDoor();
    // This is the migration path for a pairing made before the key was persisted: the grant line
    // is the only copy, and it has to be readable back before anything removes it.
    const recovered = await admin.recoverStoredPeerKeys();
    expect(recovered.get('alpha')).toBe(pub.split(' ').slice(0, 2).join(' '));
  });
});
