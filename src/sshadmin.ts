// SPDX-License-Identifier: AGPL-3.0-or-later
// SSH admin lane (p3-ssh-admin). Owns both legs of a cross-machine `sudo`:
//
//   ORIGIN leg  -- runAdmin/startRun: gate the request, append `admin-run-requested`, dial the
//                  peer over OpenSSH on the mesh (Cloudflare Access ProxyCommand as a fallback),
//                  parse the target's ExecLocalResponse, append `admin-run-completed`.
//   TARGET leg  -- execLocal: the SSH forced command. Decodes the payload, re-gates it locally,
//                  unseals THIS machine's own sudo password and runs the argv under sudo.
//
// The invariant the whole file is shaped around: A SUDO PASSWORD NEVER CROSSES THE NETWORK.
// The origin sends base64(canonicalJson(ExecLocalRequest)) -- a struct with no credential field
// (types.ts) -- over a channel whose stdin is deliberately left closed, and the target unseals
// its own credential locally. Plaintext exists in exactly one frame in this codebase: the
// callback passed to secrets.withSudoPassword in runSudo() below. It is never returned from
// that frame, never logged, never audited, never put in argv, never put in env, and never
// interpolated into any string. Errors raised anywhere inside that frame are replaced with
// fixed strings before they can travel (see CREDENTIAL_ERROR_MESSAGE).
//
// sudo posture (verified live on both machines, which run sudo-rs 0.2.13, NOT GNU sudo):
//   `sudo -S -k -p '' -- <argv>` with exactly ONE password line + '\n' written to stdin, then
//   stdin CLOSED. `-p ''` means sudo emits no prompt text on either stream, so there is nothing
//   to strip and no locale dependency; `-k` forces a genuine re-auth every call so a rotated
//   password surfaces immediately instead of riding a cached timestamp. A second read attempt
//   yields "Authentication required but not attempted", so the probe and the real invocation are
//   two separate processes, each fed its own single line. Do NOT wrap any of this in script(1)
//   or a pty: that hung in testing, and a plain stdin pipe is sufficient.
//
// House pattern #1 holds throughout: every subprocess goes through util.run's bounded runner
// (injectable as deps.runner for tests), never a raw Bun.spawn.
//
// Deliberately imports none of policy.ts / jobqueue.ts / executor.ts / membership.ts / trust.ts /
// rootsign.ts / execroutes.ts -- the P2 ceremony is not on this path (plan §5, 3.1).

import { createHash, randomBytes } from 'node:crypto';
import { open, readdir, stat, unlink } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import type {
  AdminRefusalReason,
  AdminRunRequest,
  AdminRunResult,
  AdminRunView,
  AdminStatusEntry,
  AuditEntry,
  ExecLocalRequest,
  ExecLocalResponse,
  FleetConfig,
  PairBundle,
  PeerConfig,
  PeerView,
} from './types';
import { expandHome, stateDir } from './config';
import { loadOrCreateMachineKey, writeSecretFile } from './keys';
import {
  AUDIT_KIND_ADMIN_RUN_COMPLETED,
  AUDIT_KIND_ADMIN_RUN_REFUSED,
  AUDIT_KIND_ADMIN_RUN_REQUESTED,
} from './audit';
import { canonicalJson, ensureDir, log, nowMs, run } from './util';

// ---------------------------------------------------------------------------
// Tunables. None of these belong in FleetConfig.admin (which pins the operator-facing numbers);
// they are structural limits on the wire payload and local file layout.
// ---------------------------------------------------------------------------

// Payload ceilings. 64 tokens is far above any real admin command and well below anything that
// could stress ARG_MAX or the SSH_ORIGINAL_COMMAND environment slot; 8 KiB bounds the decoded
// JSON so a malicious origin cannot make the target allocate on its say-so.
const MAX_ARGV_TOKENS = 64;
const MAX_PAYLOAD_BYTES = 8192;
const MAX_REASON_CHARS = 1024;

// Seconds added to the target's own timeout before the local ssh process is killed, so the
// remote always wins the race and we get its structured response instead of a dead pipe.
const SSH_OVERHEAD_SEC = 10;
// How much of ssh's OWN stderr (local diagnostics -- "Permission denied (publickey)", host key
// warnings) is kept on a failure path. Never contains credential material: the password is not
// handed to ssh in any form.
const MAX_SSH_STDERR_CHARS = 2048;
// The sudo -v probe is a fixed, short interaction with the local PAM stack.
const SUDO_PROBE_TIMEOUT_MS = 15000;
// util.run reports a timeout kill as exit 124, which a command may also exit with on its own.
// Elapsed time disambiguates: only a run that actually reached its deadline is a timeout.
const TIMEOUT_SLACK_MS = 250;
// Run registry depth. In-memory only, cleared on restart (plan §3: no new state files).
const MAX_REGISTRY_RUNS = 20;
const RATE_WINDOW_MS = 60000;

// Replay guard (target side). The forced command is a FRESH PROCESS per ssh connection, so "have I
// already run this?" cannot live in memory -- the marker has to be a file. One 0600 file per runId
// under stateDir(), created O_EXCL, so a second delivery of the same payload (the origin's
// Cloudflare re-dial) loses the race by construction rather than by classification.
const ADMIN_RUNS_DIRNAME = 'admin-runs';
const RUN_MARKER_MODE = 0o600;
// Comfortably outlives admin.maxRunTimeoutSec plus a fallback dial, and short enough that the
// directory is self-limiting without a count-based sweep.
const RUN_MARKER_TTL_MS = 24 * 60 * 60 * 1000;
// The only shape a runId may have. It admits no '/', no '.', and no NUL, which is what makes
// join(<runs dir>, runId) unable to name anything outside that directory.
const RUN_ID_RE = /^[A-Za-z0-9_-]{1,128}$/;

// One raw output byte can become six JSON characters (a NUL escapes to a \u0000 sequence), and
// the envelope carries two streams the target caps at admin.maxOutputBytes EACH. A cap below the
// worst case does not truncate the result, it destroys it: collectBytes stops accumulating
// mid-string, JSON.parse throws, and a privileged command that ran comes back with no exit code.
const JSON_ESCAPE_WORST_CASE = 6;
// Room for the envelope's scalar fields and message, plus any sshd banner or MOTD ahead of it.
const ENVELOPE_FIXED_OVERHEAD_BYTES = 65536;

// One fixed string for every failure raised inside the credential frame. An error object that
// crossed that boundary could, in principle, carry an interpolated password; this file refuses
// to let any of them travel, at the cost of a less specific message.
const CREDENTIAL_ERROR_MESSAGE = 'sudo credential unavailable on the target machine';

const MARKER_PREFIX = '# sukarfleet:';

// OpenSSH public key line: type + base64 blob + optional comment, single line. Peer-supplied,
// so it is matched rather than trusted -- an unmatched key never reaches authorized_keys.
const SSH_PUBKEY_RE =
  /^(ssh-ed25519|ssh-rsa|ecdsa-sha2-nistp(?:256|384|521)|sk-ssh-ed25519@openssh\.com|sk-ecdsa-sha2-nistp256@openssh\.com) ([A-Za-z0-9+/]+={0,3})(?: [^\r\n]*)?$/;
// Same key shapes as SSH_PUBKEY_RE but unanchored, for pulling a key out of the middle of a full
// authorized_keys line (options + key + marker) during the pre-persistence migration.
const SSH_PUBKEY_TOKEN_RE =
  /(?:ssh-ed25519|ssh-rsa|ecdsa-sha2-nistp(?:256|384|521)|sk-ssh-ed25519@openssh\.com|sk-ecdsa-sha2-nistp256@openssh\.com) [A-Za-z0-9+/]+={0,3}/g;
// Everything that gets embedded in an authorized_keys option field is validated to a charset
// that cannot terminate a quoted string or start a new option.
const MESH_ADDR_RE = /^[0-9A-Fa-f.:]{1,64}$/;
const MACHINE_NAME_RE = /^[A-Za-z0-9._-]{1,64}$/;
// known_hosts host tokens may be DNS names as well as literals, but never whitespace, a comment
// marker, or anything else that would split one line into two.
const SSH_HOST_RE = /^[A-Za-z0-9._:-]{1,255}$/;

// Client-side tripwire copy, exported so the GUI and this module never drift. NOT a boundary:
// `bash -c` defeats every one of them, which is why they drive a typed confirmation rather than
// a refusal. No /g flag -- a stateful lastIndex in a shared array is a bug waiting to happen.
export const DESTRUCTIVE_PATTERNS: readonly RegExp[] = [
  /\brm\b[^|;]*\s-[a-zA-Z]*r[a-zA-Z]*f/,
  /\bmkfs(\.[a-z0-9]+)?\b/,
  /\bdd\b[^|;]*\bof=/,
  />\s*\/dev\/sd[a-z]/,
  /\bshutdown\b/,
  /\breboot\b/,
  /\buserdel\b/,
  /\bchown\b[^|;]*\s-R\b[^|;]*\s\/(\s|$)/,
];

// ---------------------------------------------------------------------------
// The slice of secrets.ts (L1) this module consumes. Declared structurally and resolved lazily
// so the credential module is loaded only on the target leg, on the machine that actually owns a
// credential -- and so tests can exercise every path here without a TPM or a real sudo.
// ---------------------------------------------------------------------------

export interface SudoBroker {
  withSudoPassword<T>(cfg: FleetConfig, fn: (pw: string) => Promise<T>): Promise<T>;
  markStale(cfg: FleetConfig, atMs: number): Promise<void>;
  status(cfg: FleetConfig): Promise<{ present: boolean; stale: boolean }>;
}

let brokerModule: Promise<SudoBroker> | null = null;

function defaultBroker(): Promise<SudoBroker> {
  brokerModule ??= import('./secrets') as Promise<SudoBroker>;
  return brokerModule;
}

export interface SshAdminDeps {
  cfg: FleetConfig;
  auditAppend: (kind: string, detail: Record<string, unknown>) => Promise<AuditEntry>;
  peerView: (name: string) => PeerView | null;
  now?: () => number;
  // Test seams, all additive and all defaulted (mirrors executor.ts's ExecutorDeps.now and
  // keys.ts's opts.keyPath convention). `secrets` defaults to the real secrets.ts module,
  // `publicKeyJwk` to this machine's on-disk machine key, `sshHostKeyDir` to /etc/ssh.
  runner?: typeof run;
  secrets?: SudoBroker;
  publicKeyJwk?: JsonWebKey;
  sshHostKeyDir?: string;
}

// ---------------------------------------------------------------------------
// Payload codec
// ---------------------------------------------------------------------------

export function encodeExecLocal(req: ExecLocalRequest): string {
  const json = canonicalJson(req);
  if (Buffer.byteLength(json, 'utf8') > MAX_PAYLOAD_BYTES) {
    throw new Error(`encodeExecLocal: payload exceeds ${MAX_PAYLOAD_BYTES} bytes`);
  }
  return Buffer.from(json, 'utf8').toString('base64');
}

// Throws on anything it cannot fully vouch for. The caller (execLocal) turns a throw into a
// 'bad-argv' refusal: a payload we cannot parse is never a payload we execute.
export function decodeExecLocal(b64: string): ExecLocalRequest {
  if (typeof b64 !== 'string' || b64.length === 0) throw new Error('decodeExecLocal: empty payload');
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(b64.trim())) throw new Error('decodeExecLocal: payload is not base64');
  const json = Buffer.from(b64.trim(), 'base64').toString('utf8');
  if (Buffer.byteLength(json, 'utf8') > MAX_PAYLOAD_BYTES) {
    throw new Error(`decodeExecLocal: payload exceeds ${MAX_PAYLOAD_BYTES} bytes`);
  }
  if (json.includes('\0')) throw new Error('decodeExecLocal: payload contains NUL');

  const parsed: unknown = JSON.parse(json);
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('decodeExecLocal: payload must be a JSON object');
  }
  const raw = parsed as Record<string, unknown>;
  if (raw.v !== 1) throw new Error('decodeExecLocal: unsupported payload version');

  const runId = raw.runId;
  if (typeof runId !== 'string' || !RUN_ID_RE.test(runId)) {
    throw new Error('decodeExecLocal: bad runId');
  }
  const originMachine = raw.originMachine;
  if (typeof originMachine !== 'string' || !MACHINE_NAME_RE.test(originMachine)) {
    throw new Error('decodeExecLocal: bad originMachine');
  }
  const reason = raw.reason;
  if (typeof reason !== 'string' || reason.trim().length === 0 || reason.length > MAX_REASON_CHARS) {
    throw new Error('decodeExecLocal: bad reason');
  }
  const timeoutSec = raw.timeoutSec;
  if (!Number.isInteger(timeoutSec) || (timeoutSec as number) <= 0) {
    throw new Error('decodeExecLocal: bad timeoutSec');
  }
  const argvErr = argvShapeError(raw.argv);
  if (argvErr) throw new Error(`decodeExecLocal: ${argvErr}`);

  return {
    v: 1,
    runId,
    originMachine,
    argv: (raw.argv as string[]).slice(),
    reason,
    timeoutSec: timeoutSec as number,
  };
}

function argvShapeError(argv: unknown): string | null {
  if (!Array.isArray(argv) || argv.length === 0) return 'argv must be a non-empty array';
  if (argv.length > MAX_ARGV_TOKENS) return `argv exceeds ${MAX_ARGV_TOKENS} tokens`;
  for (const token of argv) {
    if (typeof token !== 'string' || token.length === 0) return 'argv tokens must be non-empty strings';
    // NUL terminates an execve argument: a token carrying one means the argv the operator read
    // and the argv the kernel runs are different strings.
    if (token.includes('\0')) return 'argv token contains NUL';
  }
  return null;
}

// ---------------------------------------------------------------------------
// Target-side refusal set (plan C15).
//
// A TRIPWIRE, NOT A BOUNDARY, and documented as such everywhere it is mentioned: the lane grants
// sudo, so `bash -c` walks around every rule below. Its value is that the obvious way to extract
// the sealed credential -- reading the store, or asking systemd-creds to decrypt it -- becomes a
// refused, audited, permanently recorded anomaly instead of a silent success.
// ---------------------------------------------------------------------------

export function isRefusedArgv(cfg: FleetConfig, argv: string[]): AdminRefusalReason | null {
  const store = expandHome(cfg.admin.secretsDir);
  const raw = cfg.admin.secretsDir;
  for (const token of argv) {
    if (token.includes(store) || token.includes(raw)) return 'refused-argv';
    if (token.includes('sudo.cred') || token.includes('sudo.meta.json')) return 'refused-argv';
  }
  const mentionsCreds = argv.some((t) => t.includes('systemd-creds') || basename(t) === 'systemd-creds');
  const mentionsDecrypt = argv.some((t) => t.includes('decrypt'));
  if (mentionsCreds && mentionsDecrypt) return 'refused-argv';
  return null;
}

// ---------------------------------------------------------------------------
// ssh invocation
// ---------------------------------------------------------------------------

// Pinned token for token (plan §2 L2). Every option here is load-bearing:
//   -F none                      ignore ~/.ssh/config, so a stray Host block cannot redirect us
//   BatchMode=yes                never prompt; a daemon has no tty to answer with
//   StrictHostKeyChecking=yes    an unpinned or changed host key is a hard failure, never a TOFU
//   UserKnownHostsFile=<pinned>  the ONLY host key source; GlobalKnownHostsFile is voided
//   IdentitiesOnly + IdentityAgent=none   use exactly the fleet key, never an agent identity
//   ClearAllForwardings, RequestTTY=no    the channel carries one command and its bytes, nothing else
export function buildSshArgv(
  cfg: FleetConfig,
  peer: PeerConfig,
  payloadB64: string,
  useCf: boolean,
): string[] {
  const admin = cfg.admin;
  const host = peer.sshHost ?? peer.meshIp;
  const port = peer.sshPort ?? admin.sshPort;
  const argv = [
    'ssh',
    '-T',
    '-F',
    'none',
    '-o',
    'BatchMode=yes',
    '-o',
    'StrictHostKeyChecking=yes',
    '-o',
    `UserKnownHostsFile=${expandHome(admin.knownHostsPath)}`,
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
    `ConnectTimeout=${admin.connectTimeoutSec}`,
    '-o',
    'ServerAliveInterval=15',
    '-o',
    'ServerAliveCountMax=4',
  ];
  if (useCf) {
    // Cloudflare Access fallback. cloudflared terminates on the target's loopback, which is why
    // the target's authorized_keys `from=` list has to admit 127.0.0.1 (runbook residual 4) --
    // the access gate for this path is the CF service token, not from=.
    argv.push('-o', `ProxyCommand=cloudflared access ssh --hostname ${peer.sshFallbackHost}`);
  }
  argv.push(
    '-i',
    expandHome(admin.keyPath),
    '-p',
    String(port),
    '-l',
    admin.sshUser,
    host,
    payloadB64,
  );
  return argv;
}

interface SshOutcome {
  // A connect-level failure: ssh itself gave up with no sign that anything ran on the far end.
  // The ONLY state in which retrying over a second transport is safe.
  connectFailure: boolean;
  refusal: AdminRefusalReason | null;
  message: string | null;
}

// Lowercased fragments of ssh's own diagnostics for a failure that happened BEFORE a session
// existed. Matching one of these is the only positive evidence the origin can have that the
// forced command never started. The strings are OpenSSH-version-dependent, which is exactly why
// this list is a narrowing filter and not the whole guard -- the target's on-disk replay marker
// is what actually makes a second execution impossible.
const PRE_SESSION_SSH_FAILURES: readonly string[] = [
  'connection refused',
  'no route to host',
  'connection timed out',
  'could not resolve hostname',
  'permission denied (publickey',
  'connect to host',
];

// Classification is deliberately conservative: anything that is not provably a failed CONNECT is
// treated as "the command may have run", because re-running a command that already executed is
// the one failure mode this lane must never have.
export function classifySshOutcome(code: number, stdout: string, stderr: string, timedOut: boolean): SshOutcome {
  if (timedOut) {
    return { connectFailure: false, refusal: 'timeout', message: 'ssh transport timed out' };
  }
  // Any byte on stdout is the target's response envelope: something ran over there.
  if (stdout.trim().length > 0) return { connectFailure: false, refusal: null, message: null };
  if (code === 0) return { connectFailure: false, refusal: null, message: null };

  const lower = stderr.toLowerCase();
  if (
    lower.includes('host key verification failed') ||
    lower.includes('remote host identification has changed') ||
    lower.includes('no matching host key') ||
    lower.includes('key_from_blob')
  ) {
    // A changed host key is the one connect failure that must NOT fall back: a second transport
    // to a machine whose identity we can no longer verify is exactly the wrong reflex.
    return { connectFailure: false, refusal: 'hostkey-mismatch', message: 'target host key does not match the pinned key' };
  }
  // ssh reserves 255 for its own errors, and it uses the same 255 for a session that died AFTER
  // the forced command started -- a ServerAlive timeout at 15s x 4 produces exactly (255, empty
  // stdout), because the envelope is written only once the command completes. Empty stdout is
  // therefore not evidence of non-execution, and treating it as such is what would let the
  // Cloudflare re-dial run a root command a second time. Only ssh's own PRE-SESSION diagnostics
  // prove nothing ran; everything else at 255 refuses without offering the fallback.
  if (code === 255) {
    if (PRE_SESSION_SSH_FAILURES.some((s) => lower.includes(s))) {
      return { connectFailure: true, refusal: 'unreachable', message: 'ssh could not establish a session' };
    }
    return {
      connectFailure: false,
      refusal: 'unreachable',
      message: 'ssh exited 255 with no response envelope; the command may already have run on the target',
    };
  }
  return { connectFailure: false, refusal: null, message: null };
}

// ---------------------------------------------------------------------------
// authorized_keys / known_hosts helpers
// ---------------------------------------------------------------------------

function normalizePubKey(line: string): string | null {
  const m = SSH_PUBKEY_RE.exec(line.trim());
  if (!m) return null;
  return `${m[1]} ${m[2]}`;
}

// OpenSSH's SHA256 fingerprint: base64 of the sha256 of the raw key blob, padding stripped.
// Computed here rather than shelling out to ssh-keygen -- one less subprocess on a path the
// health loop touches every cycle, and deterministic in tests.
export function sshFingerprint(pubKeyLine: string): string | null {
  const normalized = normalizePubKey(pubKeyLine);
  if (!normalized) return null;
  const blob = normalized.split(' ')[1]!;
  const raw = Buffer.from(blob, 'base64');
  if (raw.length === 0) return null;
  return `SHA256:${createHash('sha256').update(raw).digest('base64').replace(/=+$/, '')}`;
}

function knownHostsToken(host: string, port: number): string {
  return port === 22 ? host : `[${host}]:${port}`;
}

// authorized_keys quotes the option value; a path containing a quote or backslash would
// otherwise let the option list continue past where it looks like it ends.
function escapeOptionValue(v: string): string {
  return v.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

function markerFor(machine: string): string {
  return `${MARKER_PREFIX}${machine}`;
}

// Replace-by-marker, never append-twice. Every line this machine did not write is preserved
// byte for byte -- a real authorized_keys routinely carries keys for unrelated services, and
// losing one takes that service down.
function replaceMarkedLines(existing: string, machine: string, replacement: string[]): string {
  const marker = markerFor(machine);
  const kept = existing
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .filter((line) => !line.trimEnd().endsWith(marker));
  const out = [...kept, ...replacement];
  return out.length > 0 ? out.join('\n') + '\n' : '';
}

async function readFileOrEmpty(path: string): Promise<string> {
  const file = Bun.file(path);
  return (await file.exists()) ? await file.text() : '';
}

// ---------------------------------------------------------------------------
// SshAdmin
// ---------------------------------------------------------------------------

export class SshAdmin {
  private readonly now: () => number;
  private readonly runner: typeof run;
  private readonly registry = new Map<string, AdminRunView>();
  private readonly rateWindow = new Map<string, number[]>();
  private readonly lastRunMs = new Map<string, number>();
  private stopped = false;

  constructor(private readonly deps: SshAdminDeps) {
    this.now = deps.now ?? nowMs;
    this.runner = deps.runner ?? run;
  }

  private get cfg(): FleetConfig {
    return this.deps.cfg;
  }

  stop(): void {
    this.stopped = true;
    this.registry.clear();
    this.rateWindow.clear();
  }

  // -------------------------------------------------------------------------
  // Origin leg
  // -------------------------------------------------------------------------

  async runAdmin(req: AdminRunRequest): Promise<AdminRunResult> {
    const view = this.newView(req);
    this.register(view);
    return this.execute(view, req);
  }

  // Registry-backed variant for the GUI: returns as soon as the run is registered, so the page
  // can poll it by id and a reload picks an in-flight run back up instead of losing it.
  async startRun(req: AdminRunRequest): Promise<{ runId: string }> {
    const view = this.newView(req);
    this.register(view);
    // execute() already swallows every error into the view; the catch here only guards against a
    // future refactor turning it back into a rejection nobody is awaiting.
    void this.execute(view, req).catch((err) => {
      log('warn', 'sshadmin: background run rejected', { runId: view.runId, error: String(err) });
    });
    return { runId: view.runId };
  }

  private newView(req: AdminRunRequest): AdminRunView {
    return {
      runId: mintRunId(),
      machine: typeof req?.machine === 'string' ? req.machine : '',
      ok: false,
      exitCode: null,
      stdout: '',
      stderr: '',
      transport: null,
      durationMs: 0,
      truncated: false,
      startedMs: this.now(),
      finishedMs: null,
      running: true,
      argv: Array.isArray(req?.argv) ? req.argv.filter((t) => typeof t === 'string') : [],
      reason: typeof req?.reason === 'string' ? req.reason : '',
    };
  }

  getRun(runId: string): AdminRunView | null {
    return this.registry.get(runId) ?? null;
  }

  listRuns(limit: number): AdminRunView[] {
    const all = [...this.registry.values()].sort((a, b) => b.startedMs - a.startedMs);
    const n = Number.isInteger(limit) && limit > 0 ? Math.min(limit, MAX_REGISTRY_RUNS) : MAX_REGISTRY_RUNS;
    return all.slice(0, n);
  }

  private register(view: AdminRunView): void {
    this.registry.set(view.runId, view);
    while (this.registry.size > MAX_REGISTRY_RUNS) {
      const oldest = this.registry.keys().next();
      if (oldest.done) break;
      this.registry.delete(oldest.value);
    }
  }

  private async execute(view: AdminRunView, req: AdminRunRequest): Promise<AdminRunResult> {
    try {
      const result = await this.executeInner(view, req);
      return this.finish(view, result);
    } catch (err) {
      // Nothing in the origin leg is allowed to throw at the caller: node.ts's fetch handler and
      // the MCP surface both treat a rejected promise as a 500 with no audit trail.
      log('warn', 'sshadmin: admin run failed unexpectedly', { runId: view.runId, error: String(err) });
      return this.finish(view, { ok: false, exitCode: null, message: 'admin run failed unexpectedly' });
    }
  }

  private finish(view: AdminRunView, patch: Partial<AdminRunResult>): AdminRunResult {
    const finishedMs = this.now();
    Object.assign(view, patch, {
      finishedMs,
      running: false,
      durationMs: patch.durationMs ?? finishedMs - view.startedMs,
    });
    return { ...view };
  }

  private async executeInner(view: AdminRunView, req: AdminRunRequest): Promise<Partial<AdminRunResult>> {
    if (this.stopped) return refuse('lane-disabled-local', 'the admin lane is shutting down');

    const shape = this.validateRequest(req);
    if (shape) return refuse(shape.refusal, shape.message);

    const admin = this.cfg.admin;
    if (!admin.enabled) {
      return refuse('lane-disabled-local', `the admin lane is disabled on ${this.cfg.machine}`);
    }

    // Who may DRIVE the lane, checked separately from whether the lane exists.
    //
    // This is what remains of the signed-job ceremony after the extraction dropped it: that
    // machinery existed to answer one question -- can an agent reach root without a human present?
    // -- and the admin lane never asked it. requestedBy.kind was recorded on every call and then
    // ignored, so an agent and an operator both reached root by the same path.
    //
    // Refused BEFORE the rate-limit token is taken and before the requested-audit entry: a call
    // that is never going to run should not consume the operator's budget. It IS audited, below,
    // because "an agent tried to reach root" is exactly the event worth keeping.
    if (req.requestedBy?.kind === 'agent' && admin.agentOrigin === 'refuse') {
      await this.audit(AUDIT_KIND_ADMIN_RUN_REFUSED, {
        runId: view.runId,
        targetMachine: req.machine,
        argv: req.argv,
        reason: req.reason,
        refusal: 'agent-origin-refused',
        requestedBy: req.requestedBy,
      });
      return refuse(
        'agent-origin-refused',
        `${this.cfg.machine} does not let an agent drive the admin lane (admin.agentOrigin is "refuse")`,
      );
    }

    const timeoutSec = clampTimeout(req.timeoutSec, admin.runTimeoutSec, admin.maxRunTimeoutSec);
    view.machine = req.machine;
    view.argv = req.argv.slice();
    view.reason = req.reason;

    if (!this.takeRateToken(req.machine)) {
      return refuse('rate-limited', `more than ${admin.ratePerMin} admin runs per minute to ${req.machine}`);
    }

    await this.audit(AUDIT_KIND_ADMIN_RUN_REQUESTED, {
      runId: view.runId,
      targetMachine: req.machine,
      argv: view.argv,
      reason: req.reason,
      requestedBy: req.requestedBy,
      timeoutSec,
    });

    const outcome =
      req.machine === this.cfg.machine
        ? await this.executeSelf(view, req, timeoutSec)
        : await this.executeRemote(view, req, timeoutSec);

    this.lastRunMs.set(req.machine, this.now());

    // "Refusals append admin-run-refused INSTEAD of executing": a null exitCode with a refusal
    // means nothing ran, on either machine, so the completed leg would be a lie.
    if (outcome.refusal && outcome.exitCode === null) {
      const seq = await this.audit(AUDIT_KIND_ADMIN_RUN_REFUSED, {
        runId: view.runId,
        targetMachine: req.machine,
        argv: view.argv,
        reason: req.reason,
        refusal: outcome.refusal,
      });
      return { ...outcome, auditSeq: seq };
    }

    const seq = await this.audit(AUDIT_KIND_ADMIN_RUN_COMPLETED, {
      runId: view.runId,
      targetMachine: req.machine,
      argv: view.argv,
      exitCode: outcome.exitCode ?? null,
      durationMs: outcome.durationMs ?? this.now() - view.startedMs,
      transport: outcome.transport ?? null,
      // Byte counts only, never content: the audit union file is replicated to every machine and
      // pushed to GitHub, so command output is exactly the sink a captured secret leaks through.
      stdoutBytes: Buffer.byteLength(outcome.stdout ?? '', 'utf8'),
      stderrBytes: Buffer.byteLength(outcome.stderr ?? '', 'utf8'),
      truncated: outcome.truncated ?? false,
    });
    return { ...outcome, auditSeq: seq };
  }

  private validateRequest(req: AdminRunRequest): { refusal: AdminRefusalReason; message: string } | null {
    if (typeof req !== 'object' || req === null) return { refusal: 'bad-argv', message: 'malformed request' };
    if (typeof req.machine !== 'string' || !MACHINE_NAME_RE.test(req.machine)) {
      return { refusal: 'bad-argv', message: 'machine must be a fleet machine name' };
    }
    if (typeof req.reason !== 'string' || req.reason.trim().length === 0) {
      return { refusal: 'missing-reason', message: 'every admin run needs a reason; it is the audit log' };
    }
    if (req.reason.length > MAX_REASON_CHARS) {
      return { refusal: 'missing-reason', message: `reason exceeds ${MAX_REASON_CHARS} characters` };
    }
    const argvErr = argvShapeError(req.argv);
    if (argvErr) return { refusal: 'bad-argv', message: argvErr };
    if (req.timeoutSec !== undefined && (!Number.isInteger(req.timeoutSec) || req.timeoutSec <= 0)) {
      return { refusal: 'bad-argv', message: 'timeoutSec must be a positive integer' };
    }
    return null;
  }

  // A run against this machine skips ssh entirely but goes through the SAME target-leg gates a
  // remote call would hit, so `acceptIncoming:false` means the same thing in both directions.
  // Only the origin pair of audit entries is written here: a local run has one machine, and a
  // second completed entry from the "target" would show up in the union file as a duplicate leg.
  private async executeSelf(
    view: AdminRunView,
    req: AdminRunRequest,
    timeoutSec: number,
  ): Promise<Partial<AdminRunResult>> {
    const res = await this.runTargetLeg({
      v: 1,
      runId: view.runId,
      originMachine: this.cfg.machine,
      argv: req.argv,
      reason: req.reason,
      timeoutSec,
    });
    return {
      ok: res.exitCode === 0,
      exitCode: res.exitCode,
      stdout: res.stdout,
      stderr: res.stderr,
      transport: 'local',
      durationMs: res.durationMs,
      truncated: res.truncated,
      ...(res.refusal ? { refusal: res.refusal } : {}),
      ...(res.message ? { message: res.message } : {}),
    };
  }

  private async executeRemote(
    view: AdminRunView,
    req: AdminRunRequest,
    timeoutSec: number,
  ): Promise<Partial<AdminRunResult>> {
    const admin = this.cfg.admin;
    const peer = this.cfg.peers.find((p) => p.name === req.machine);
    if (!peer) return refuse('not-paired', `${req.machine} is not a configured peer`);
    if (peer.publicKeyJwk === null) return refuse('not-paired', `${req.machine} is configured but not paired`);
    if (!admin.sshUser) return refuse('not-configured', 'admin.sshUser is empty; run install/quickstart.sh');

    let payload: string;
    try {
      payload = encodeExecLocal({
        v: 1,
        runId: view.runId,
        originMachine: this.cfg.machine,
        argv: req.argv,
        reason: req.reason,
        timeoutSec,
      });
    } catch (err) {
      return refuse('bad-argv', String(err instanceof Error ? err.message : err));
    }

    const first = await this.dial(peer, payload, timeoutSec, false);
    if (!first.connectFailure || !peer.sshFallbackHost) return first.result;

    // Fallback is reached ONLY from a proven connect-level failure (exit 255, empty stdout, no
    // host key complaint). A command that ran and failed is never re-run over a second path.
    log('info', 'sshadmin: mesh connect failed, trying the Cloudflare Access fallback', {
      machine: peer.name,
      runId: view.runId,
    });
    const second = await this.dial(peer, payload, timeoutSec, true);
    return second.result;
  }

  private async dial(
    peer: PeerConfig,
    payload: string,
    timeoutSec: number,
    useCf: boolean,
  ): Promise<{ connectFailure: boolean; result: Partial<AdminRunResult> }> {
    const transport = useCf ? 'cf' : 'mesh';
    const argv = buildSshArgv(this.cfg, peer, payload, useCf);
    const timeoutMs = (timeoutSec + this.cfg.admin.connectTimeoutSec + SSH_OVERHEAD_SEC) * 1000;
    const captureCap = transportCaptureCap(this.cfg);
    const startedMs = this.now();
    // No `stdin` option: the channel to the target carries the payload in argv and nothing else.
    // There is no credential to send, and leaving stdin closed makes that structurally true.
    const res = await this.runner(argv, {
      timeoutMs,
      maxCaptureBytes: captureCap,
    });
    const durationMs = this.now() - startedMs;
    const timedOut = res.code === 124 && durationMs >= timeoutMs - TIMEOUT_SLACK_MS;
    const outcome = classifySshOutcome(res.code, res.stdout, res.stderr, timedOut);

    if (outcome.connectFailure) {
      return {
        connectFailure: true,
        result: {
          ok: false,
          exitCode: null,
          transport: null,
          durationMs,
          refusal: outcome.refusal ?? 'unreachable',
          message: outcome.message ?? 'ssh could not establish a session',
          stderr: clip(res.stderr, MAX_SSH_STDERR_CHARS),
        },
      };
    }
    if (outcome.refusal) {
      const narrowed = await this.narrowHostkeyRefusal(peer, outcome);
      return {
        connectFailure: false,
        result: {
          ok: false,
          exitCode: null,
          transport,
          durationMs,
          refusal: narrowed.refusal,
          message: narrowed.message ?? undefined,
          stderr: clip(res.stderr, MAX_SSH_STDERR_CHARS),
        },
      };
    }

    const parsed = parseExecLocalResponse(res.stdout);
    if (!parsed) {
      // An envelope cut off by the capture cap still proves the command RAN, and JSON.stringify
      // emits the envelope's fields in the order the target builds them, so `exitCode` survives a
      // truncation the streams do not. Reporting "no parseable response" here would throw away
      // the one fact the operator needs about a privileged command that already executed.
      const salvaged = res.truncated === true ? salvageEnvelopeExitCode(res.stdout) : null;
      return {
        connectFailure: false,
        result: {
          ok: salvaged?.exitCode === 0,
          exitCode: salvaged ? salvaged.exitCode : null,
          transport,
          durationMs,
          truncated: res.truncated === true,
          message:
            res.truncated === true
              ? salvaged
                ? `the target's response exceeded ${captureCap} bytes; the command ran and exited ${salvaged.exitCode}, but its output was cut off in transit`
                : `the target's response exceeded ${captureCap} bytes and could not be read; the command may have run`
              : 'target returned no parseable response envelope',
          stderr: clip(res.stderr, MAX_SSH_STDERR_CHARS),
        },
      };
    }
    return {
      connectFailure: false,
      result: {
        ok: parsed.exitCode === 0 && !parsed.refusal,
        exitCode: parsed.exitCode,
        // The target's own stdout/stderr travel inside the envelope; ssh's stderr is local
        // diagnostics and is deliberately not merged into them on the success path.
        stdout: parsed.stdout,
        stderr: parsed.stderr,
        transport,
        durationMs,
        truncated: parsed.truncated || (res.truncated ?? false),
        ...(parsed.refusal ? { refusal: parsed.refusal } : {}),
        ...(parsed.message ? { message: parsed.message } : {}),
      },
    };
  }

  // OpenSSH prints the same trailing "Host key verification failed." whether the pinned key
  // CHANGED or no key was ever pinned for the host:port we dialled, and only the first deserves
  // the hostile-until-proven-otherwise fault docs/RUNBOOK-P3.md attaches to 'hostkey-mismatch'.
  // The second is reachable with no attacker at all: pinHostKeys pins under the port known at
  // PAIRING time while buildSshArgv resolves the port at CALL time, so adding a peer sshPort
  // override desynchronizes them. A fault that can fire on a config edit teaches the operator to
  // ignore the one alarm that must never be ignored.
  private async narrowHostkeyRefusal(
    peer: PeerConfig,
    outcome: SshOutcome,
  ): Promise<{ refusal: AdminRefusalReason; message: string | null }> {
    const refusal = outcome.refusal ?? 'unreachable';
    if (refusal !== 'hostkey-mismatch') return { refusal, message: outcome.message };

    const host = peer.sshHost ?? peer.meshIp;
    const token = knownHostsToken(host, peer.sshPort ?? this.cfg.admin.sshPort);
    const pinned = await this.pinnedHostTokens(peer.name).catch(() => new Set<string>());
    if (pinned.has(token)) return { refusal, message: outcome.message };
    return {
      // No new AdminRefusalReason member (types.ts is not this lane's): 'not-paired' is the
      // truthful one -- for the admin lane, a peer with no pinned host key is not paired -- and
      // its GUI/MCP copy already says "pair the two machines again", which is the fix.
      refusal: 'not-paired',
      message: `no host key is pinned for ${token} on ${this.cfg.machine}; pair with ${peer.name} again`,
    };
  }

  private takeRateToken(machine: string): boolean {
    const cutoff = this.now() - RATE_WINDOW_MS;
    const hits = (this.rateWindow.get(machine) ?? []).filter((t) => t > cutoff);
    if (hits.length >= this.cfg.admin.ratePerMin) {
      this.rateWindow.set(machine, hits);
      return false;
    }
    hits.push(this.now());
    this.rateWindow.set(machine, hits);
    return true;
  }

  private async audit(kind: string, detail: Record<string, unknown>): Promise<number | undefined> {
    try {
      const entry = await this.deps.auditAppend(kind, detail);
      return entry.seq;
    } catch (err) {
      // Degrade, never throw: an audit-log write failure must not also cost us the run's result.
      log('warn', 'sshadmin: audit append failed', { kind, error: String(err) });
      return undefined;
    }
  }

  // -------------------------------------------------------------------------
  // Target leg
  // -------------------------------------------------------------------------

  // The SSH forced command's entry point. Never throws: cli.ts prints whatever this returns as
  // the response envelope, and a thrown error would reach the origin as an empty stdout, i.e.
  // as an apparent connect failure -- which is the one thing that triggers a retry.
  async execLocal(rawB64: string): Promise<ExecLocalResponse> {
    const startedMs = this.now();
    let req: ExecLocalRequest;
    try {
      req = decodeExecLocal(rawB64);
    } catch (err) {
      // An undecodable payload on a key that only this lane's forced command answers is itself
      // the anomaly worth recording. The attacker-supplied bytes are NOT recorded, only the fact.
      await this.audit(AUDIT_KIND_ADMIN_RUN_REFUSED, {
        runId: null,
        originMachine: null,
        argv: [],
        reason: 'undecodable exec-local payload',
        refusal: 'bad-argv',
      });
      return refusalResponse('bad-argv', String(err instanceof Error ? err.message : err), this.now() - startedMs);
    }

    // The SSH key already authenticated the caller; this binds the CLAIMED origin to a machine we
    // actually know, so an audit entry cannot name a machine that was never in the fleet.
    if (req.originMachine !== this.cfg.machine && !this.cfg.peers.some((p) => p.name === req.originMachine)) {
      const res = refusalResponse('not-paired', 'origin machine is not a configured peer', this.now() - startedMs);
      await this.auditTargetRefusal(req, res);
      return res;
    }

    // Replay guard, and the reason it is on THIS side: the origin cannot always tell a connect
    // failure from a session that died after the command started, so a re-dial can deliver the
    // identical payload twice. Claiming the runId on disk before anything runs makes a second
    // execution impossible however the origin classified the first attempt.
    const claim = await this.claimRun(req.runId);
    if (claim.kind === 'unusable') {
      const res = refusalResponse(
        'not-configured',
        'the target machine could not record this run id, so nothing was run',
        this.now() - startedMs,
      );
      await this.auditTargetRefusal(req, res);
      return res;
    }
    if (claim.kind === 'duplicate') {
      const res = replayResponse(claim.recorded, this.cfg.machine, this.now() - startedMs);
      // The audit detail is free-form, so the reason is recorded precisely even though the typed
      // AdminRefusalReason set (types.ts) has no 'duplicate-run' member.
      await this.audit(AUDIT_KIND_ADMIN_RUN_REFUSED, {
        runId: req.runId,
        originMachine: req.originMachine,
        argv: req.argv,
        reason: req.reason,
        refusal: 'duplicate-run',
        alreadyCompleted: claim.recorded !== null,
      });
      return res;
    }

    const result = await this.runTargetLeg(req);
    await this.recordRun(req.runId, result);
    if (result.refusal) {
      await this.auditTargetRefusal(req, result);
      return result;
    }
    await this.audit(AUDIT_KIND_ADMIN_RUN_COMPLETED, {
      runId: req.runId,
      originMachine: req.originMachine,
      argv: req.argv,
      exitCode: result.exitCode,
      durationMs: result.durationMs,
      transport: 'local',
      stdoutBytes: Buffer.byteLength(result.stdout, 'utf8'),
      stderrBytes: Buffer.byteLength(result.stderr, 'utf8'),
      truncated: result.truncated,
    });
    return result;
  }

  // stateDir(), not a config path: the marker set belongs to the MACHINE, and every process that
  // answers the forced command has to see the same one.
  private runMarkerPath(runId: string): string {
    // Belt and braces. decodeExecLocal already matched RUN_ID_RE, and RUN_ID_RE admits neither
    // '/' nor '.', so a runId cannot traverse out of the directory it names a file in -- but this
    // is the function that builds a path out of peer-supplied text, so it re-checks.
    if (!RUN_ID_RE.test(runId)) throw new Error('runMarkerPath: bad runId');
    return join(stateDir(), ADMIN_RUNS_DIRNAME, runId);
  }

  // O_EXCL create ('wx') is the whole guard: the filesystem, not this code, decides who wins.
  // Fails CLOSED -- a marker directory we cannot write is a refusal, never a free execution.
  private async claimRun(
    runId: string,
  ): Promise<{ kind: 'claimed' } | { kind: 'duplicate'; recorded: ExecLocalResponse | null } | { kind: 'unusable' }> {
    let path: string;
    try {
      path = this.runMarkerPath(runId);
      await ensureDir(dirname(path));
      const fh = await open(path, 'wx', RUN_MARKER_MODE);
      await fh.close();
    } catch (err) {
      if ((err as NodeJS.ErrnoException | null)?.code === 'EEXIST') {
        const recorded = await this.readRunMarker(runId);
        log('warn', 'sshadmin: refusing a run id this machine has already accepted', {
          runId,
          alreadyCompleted: recorded !== null,
        });
        return { kind: 'duplicate', recorded };
      }
      log('warn', 'sshadmin: could not claim a run marker', { runId, error: String(err) });
      return { kind: 'unusable' };
    }
    await this.pruneRunMarkers();
    return { kind: 'claimed' };
  }

  // Records the run's OUTCOME, never its output. A replay gets the exit code and the refusal --
  // enough for the origin to stop guessing -- while the command's stdout/stderr, which is the
  // sink a captured secret would leak through, is not persisted anywhere on the target.
  private async recordRun(runId: string, res: ExecLocalResponse): Promise<void> {
    try {
      await writeSecretFile(
        this.runMarkerPath(runId),
        `${JSON.stringify({ ...res, stdout: '', stderr: '' })}\n`,
      );
    } catch (err) {
      // The claim is what prevents a second execution; losing the outcome only costs a replaying
      // origin its exit code.
      log('warn', 'sshadmin: could not record a run outcome', { runId, error: String(err) });
    }
  }

  private async readRunMarker(runId: string): Promise<ExecLocalResponse | null> {
    try {
      return parseExecLocalResponse(await readFileOrEmpty(this.runMarkerPath(runId)));
    } catch {
      return null;
    }
  }

  // Best effort, and deliberately after the claim: a directory we cannot prune is not a reason to
  // refuse a run. Ages are wall-clock file mtimes, so this reads the real clock rather than the
  // injectable one.
  private async pruneRunMarkers(): Promise<void> {
    const dir = join(stateDir(), ADMIN_RUNS_DIRNAME);
    try {
      const cutoff = nowMs() - RUN_MARKER_TTL_MS;
      for (const name of await readdir(dir)) {
        const path = join(dir, name);
        const st = await stat(path).catch(() => null);
        if (st && st.mtimeMs < cutoff) await unlink(path).catch(() => {});
      }
    } catch (err) {
      log('warn', 'sshadmin: could not prune the admin run markers', { dir, error: String(err) });
    }
  }

  private async auditTargetRefusal(req: ExecLocalRequest, res: ExecLocalResponse): Promise<void> {
    await this.audit(AUDIT_KIND_ADMIN_RUN_REFUSED, {
      runId: req.runId,
      originMachine: req.originMachine,
      argv: req.argv,
      reason: req.reason,
      refusal: res.refusal,
    });
  }

  // Gates + sudo. Shared by execLocal (remote caller) and executeSelf (local caller) so the two
  // can never drift apart on what is allowed.
  private async runTargetLeg(req: ExecLocalRequest): Promise<ExecLocalResponse> {
    const startedMs = this.now();
    // The target-side switch, checked here rather than in execLocal so a self-targeted run --
    // which never leaves the machine -- is gated identically to one that arrived over ssh.
    if (!this.cfg.admin.acceptIncoming) {
      return refusalResponse(
        'lane-disabled-target',
        `${this.cfg.machine} is not accepting admin runs`,
        this.now() - startedMs,
      );
    }
    const refused = isRefusedArgv(this.cfg, req.argv);
    if (refused) {
      return refusalResponse(
        refused,
        'this command touches the credential store; refused and recorded',
        this.now() - startedMs,
      );
    }
    const timeoutMs = req.timeoutSec * 1000;

    try {
      const res =
        this.cfg.admin.credentialMode === 'nopasswd'
          ? await this.runSudoNopasswd(req.argv, timeoutMs)
          : await this.runSudo(req.argv, timeoutMs);
      return { ...res, durationMs: this.now() - startedMs };
    } catch (err) {
      // Nothing raised inside the credential frame is allowed to travel verbatim: an error's
      // message is a string that some future edit could have built by interpolation. Only the
      // structured reason enum crosses, mapped to fixed copy.
      const mapped = credentialRefusal(err);
      log('warn', 'sshadmin: target leg failed', {
        runId: req.runId,
        error: sanitizedError(err),
        refusal: mapped.refusal,
      });
      return refusalResponse(mapped.refusal, mapped.message, this.now() - startedMs);
    }
  }

  // THE ONLY CALL SITE OF withSudoPassword IN THIS CODEBASE.
  //
  // `pw` exists in this frame and on two pipes to sudo's stdin. It is not captured by any closure
  // that outlives the callback, not stored on `this`, not concatenated into any message, and not
  // handed to anything but the runner's `stdin` option. Do not add a log(), an audit append, or a
  // template literal anywhere inside the callback below.
  private async runSudo(argv: string[], timeoutMs: number): Promise<Omit<ExecLocalResponse, 'durationMs'>> {
    const broker = this.deps.secrets ?? (await defaultBroker());
    return broker.withSudoPassword(this.cfg, async (pw): Promise<Omit<ExecLocalResponse, 'durationMs'>> => {
      // sudo-rs reads exactly one line and closes; a second read on the same process yields
      // "Authentication required but not attempted", so the probe and the run are two processes.
      // -k defeats the cached timestamp, so a rotated password fails here rather than mid-run.
      const probeStartedMs = this.now();
      const probe = await this.runner(['sudo', '-S', '-k', '-p', '', '-v'], {
        stdin: pw + '\n',
        timeoutMs: SUDO_PROBE_TIMEOUT_MS,
      });
      // util.run reports its own timeout kill as 124 -- the same disambiguation shapeRunResult and
      // secrets.ts already apply. A probe that never got an ANSWER says nothing about whether the
      // stored password is right, and markStale is a one-way door in production: it latches an
      // in-process staleLatch as well as the on-disk flag, and the only way back is retyping the
      // password in that machine's own GUI.
      if (probe.code === 124 && this.now() - probeStartedMs >= SUDO_PROBE_TIMEOUT_MS - TIMEOUT_SLACK_MS) {
        return {
          v: 1,
          exitCode: null,
          stdout: '',
          stderr: '',
          truncated: false,
          refusal: 'timeout',
          message: `sudo did not answer within ${Math.round(SUDO_PROBE_TIMEOUT_MS / 1000)}s on the target; nothing was run`,
        };
      }
      if (probe.code !== 0) {
        await broker.markStale(this.cfg, this.now()).catch(() => {});
        return {
          v: 1,
          exitCode: null,
          stdout: '',
          stderr: '',
          truncated: false,
          refusal: 'credential-stale',
          message: 'the stored sudo password was rejected; re-enter it in the GUI',
        };
      }
      const startedMs = this.now();
      const res = await this.runner(['sudo', '-S', '-k', '-p', '', '--', ...argv], {
        stdin: pw + '\n',
        timeoutMs,
        maxCaptureBytes: this.cfg.admin.maxOutputBytes,
      });
      return this.shapeRunResult(res, this.now() - startedMs, timeoutMs);
    });
  }

  // credentialMode:'nopasswd' -- the structural alternative offered in the runbook: a hand-written
  // narrow sudoers rule and no stored human credential at all. Never auto-installed by anything
  // in this repo; -n makes sudo fail rather than prompt if the rule is not actually there.
  private async runSudoNopasswd(argv: string[], timeoutMs: number): Promise<Omit<ExecLocalResponse, 'durationMs'>> {
    const startedMs = this.now();
    const res = await this.runner(['sudo', '-n', '--', ...argv], {
      timeoutMs,
      maxCaptureBytes: this.cfg.admin.maxOutputBytes,
    });
    return this.shapeRunResult(res, this.now() - startedMs, timeoutMs);
  }

  private shapeRunResult(
    res: { code: number; stdout: string; stderr: string; truncated?: boolean },
    elapsedMs: number,
    timeoutMs: number,
  ): Omit<ExecLocalResponse, 'durationMs'> {
    // util.run reports its own timeout kill as 124, which a command may also exit with legitimately.
    // Elapsed time is what actually distinguishes them.
    if (res.code === 124 && elapsedMs >= timeoutMs - TIMEOUT_SLACK_MS) {
      return {
        v: 1,
        exitCode: null,
        stdout: res.stdout,
        stderr: res.stderr,
        truncated: res.truncated ?? false,
        refusal: 'timeout',
        message: `the command was killed after ${Math.round(timeoutMs / 1000)}s`,
      };
    }
    return {
      v: 1,
      exitCode: res.code,
      stdout: res.stdout,
      stderr: res.stderr,
      truncated: res.truncated ?? false,
    };
  }

  // -------------------------------------------------------------------------
  // SSH identity, trust, and peer files
  // -------------------------------------------------------------------------

  async ensureSshIdentity(): Promise<{ created: boolean; sshPublicKey: string }> {
    const keyPath = expandHome(this.cfg.admin.keyPath);
    const pubPath = `${keyPath}.pub`;
    const existing = normalizePubKey(await readFileOrEmpty(pubPath));
    if (existing && (await Bun.file(keyPath).exists())) return { created: false, sshPublicKey: existing };

    const res = await this.runner(
      ['ssh-keygen', '-t', 'ed25519', '-N', '', '-C', `sukarfleet-${this.cfg.machine}`, '-f', keyPath],
      { timeoutMs: 30000 },
    );
    if (res.code !== 0) throw new Error(`ssh-keygen failed (${res.code}): ${res.stderr.trim()}`);
    const created = normalizePubKey(await readFileOrEmpty(pubPath));
    if (!created) throw new Error(`ssh-keygen produced no usable public key at ${pubPath}`);
    log('info', 'sshadmin: generated fleet ssh identity', { keyPath });
    return { created: true, sshPublicKey: created };
  }

  async trust(): Promise<{
    sshPublicKey: string;
    sshKeyFingerprint: string;
    hostKeys: string[];
    hostKeyFingerprints: string[];
  }> {
    const pubPath = `${expandHome(this.cfg.admin.keyPath)}.pub`;
    const sshPublicKey = normalizePubKey(await readFileOrEmpty(pubPath)) ?? '';
    const hostKeys = await this.localHostKeys();
    return {
      sshPublicKey,
      sshKeyFingerprint: sshPublicKey ? (sshFingerprint(sshPublicKey) ?? '') : '',
      hostKeys,
      hostKeyFingerprints: hostKeys.map((k) => sshFingerprint(k)).filter((f): f is string => f !== null),
    };
  }

  private async localHostKeys(): Promise<string[]> {
    const dir = this.deps.sshHostKeyDir ?? '/etc/ssh';
    try {
      const names = (await readdir(dir)).filter((n) => n.startsWith('ssh_host_') && n.endsWith('_key.pub')).sort();
      const out: string[] = [];
      for (const name of names) {
        const key = normalizePubKey(await readFileOrEmpty(join(dir, name)));
        if (key) out.push(key);
      }
      return out;
    } catch (err) {
      log('warn', 'sshadmin: could not read local ssh host keys', { dir, error: String(err) });
      return [];
    }
  }

  async localBundle(): Promise<PairBundle> {
    const trust = await this.trust();
    const publicKeyJwk =
      this.deps.publicKeyJwk ?? (await loadOrCreateMachineKey(this.cfg.machine)).publicKeyJwk;
    return {
      v: 1,
      machine: this.cfg.machine,
      role: this.cfg.role,
      meshIp: this.cfg.meshIp,
      nodePort: this.cfg.nodePort,
      publicKeyJwk,
      sshUser: this.cfg.admin.sshUser,
      sshPublicKey: trust.sshPublicKey,
      sshHostKeys: trust.hostKeys,
    };
  }

  // The option prefix is ALWAYS built here, from local config plus validated peer fields, and is
  // never accepted from the peer. `restrict` is the load-bearing token: it disables agent and
  // port forwarding, X11, pty allocation and ~ escapes, so the key can do exactly one thing.
  // --- inbound door -------------------------------------------------------
  //
  // admin.acceptIncoming is the INBOUND switch, and "off" has to mean the peer cannot get in at
  // all -- not "gets in and is then refused". Refusing inside the forced command still lets a
  // paired peer authenticate to sshd and start a process here, which is a reachable code path on a
  // machine whose owner switched the lane off. So the grant itself is installed and removed with
  // the switch: off -> sshd rejects the fleet key outright.
  //
  // known_hosts is deliberately NOT touched by either direction. That file is OUTBOUND trust (who
  // we are willing to dial), it grants nobody access to this machine, and dropping it would make
  // closing the door also forget every host key we have pinned.
  //
  // Reopening rebuilds the grant from peers[].sshPublicKey, which is why that field is persisted.
  async closeInboundDoor(): Promise<{ removed: string[] }> {
    const path = expandHome(this.cfg.admin.authorizedKeysPath);
    const existing = await readFileOrEmpty(path);
    if (!existing) return { removed: [] };
    const removed: string[] = [];
    let next = existing;
    for (const peer of this.cfg.peers) {
      const after = replaceMarkedLines(next, peer.name, []);
      if (after !== next) removed.push(peer.name);
      next = after;
    }
    if (next !== existing) await writeSecretFile(path, next);
    return { removed };
  }

  // Rewrites the grant for every peer whose SSH public key we hold. A peer paired before the key
  // was persisted has none; recoverStoredPeerKeys() below backfills those from the live grant, so
  // this only comes up on a peer that was never paired on this build.
  async openInboundDoor(): Promise<{ restored: string[]; missingKey: string[] }> {
    const restored: string[] = [];
    const missingKey: string[] = [];
    for (const peer of this.cfg.peers) {
      const key = normalizePubKey(peer.sshPublicKey ?? '');
      if (!key) {
        if (peer.publicKeyJwk !== null) missingKey.push(peer.name);
        continue;
      }
      await this.writeAuthorizedKey({
        machine: peer.name,
        meshIp: peer.meshIp,
        sshPublicKey: key,
      } as PairBundle);
      restored.push(peer.name);
    }
    return { restored, missingKey };
  }

  // Migration for pairings made before sshPublicKey was persisted: the live authorized_keys line
  // is the only copy, so read it back before anything can remove it. Returns the recovered keys
  // for node.ts to write into the config (this lane does not own config.json).
  async recoverStoredPeerKeys(): Promise<Map<string, string>> {
    const out = new Map<string, string>();
    const existing = await readFileOrEmpty(expandHome(this.cfg.admin.authorizedKeysPath));
    if (!existing) return out;
    for (const line of existing.split('\n')) {
      const idx = line.indexOf(MARKER_PREFIX);
      if (idx === -1) continue;
      const machine = line.slice(idx + MARKER_PREFIX.length).trim();
      if (!MACHINE_NAME_RE.test(machine)) continue;
      // The key sits between the options blob and the marker, but it cannot be found by splitting
      // on the first space: the forced command embedded in the options contains spaces of its own.
      // Anchor on the key-type token instead, and take the LAST one so an option value that
      // happens to contain such a token cannot shadow the real key.
      const body = line.slice(0, idx);
      let key: string | null = null;
      for (const m of body.matchAll(SSH_PUBKEY_TOKEN_RE)) key = normalizePubKey(m[0]);
      if (key) out.set(machine, key);
    }
    return out;
  }

  async writeAuthorizedKey(peer: PairBundle): Promise<void> {
    const key = normalizePubKey(peer?.sshPublicKey ?? '');
    if (!key) throw new Error('writeAuthorizedKey: peer ssh public key is not a valid single-line key');
    if (!MACHINE_NAME_RE.test(peer.machine ?? '')) throw new Error('writeAuthorizedKey: bad peer machine name');
    if (!MESH_ADDR_RE.test(peer.meshIp ?? '')) throw new Error('writeAuthorizedKey: bad peer mesh address');

    // cloudflared terminates on THIS machine's loopback, so the anchor -- the only side an
    // outside-the-mesh peer can reach that way -- has to admit 127.0.0.1 in from=. A roamer never
    // terminates a tunnel, so its from= stays a single mesh address (runbook residual 4).
    const sources = this.cfg.role === 'anchor' ? `${peer.meshIp},127.0.0.1` : peer.meshIp;
    const command = escapeOptionValue(forcedCommand());
    const line = `from="${sources}",restrict,command="${command}" ${key} ${markerFor(peer.machine)}`;

    const path = expandHome(this.cfg.admin.authorizedKeysPath);
    const next = replaceMarkedLines(await readFileOrEmpty(path), peer.machine, [line]);
    await writeSecretFile(path, next);
  }

  async pinHostKeys(peer: PairBundle): Promise<void> {
    if (!MACHINE_NAME_RE.test(peer?.machine ?? '')) throw new Error('pinHostKeys: bad peer machine name');
    if (!MESH_ADDR_RE.test(peer?.meshIp ?? '')) throw new Error('pinHostKeys: bad peer mesh address');
    const configured = this.cfg.peers.find((p) => p.name === peer.machine);
    const port = configured?.sshPort ?? this.cfg.admin.sshPort;
    const hosts = new Set<string>([knownHostsToken(peer.meshIp, port)]);
    // ssh looks up the host key under the name it dialled, so a peer reached via an sshHost
    // override needs that name pinned too -- the CF fallback dials the same name.
    if (configured?.sshHost && SSH_HOST_RE.test(configured.sshHost)) {
      hosts.add(knownHostsToken(configured.sshHost, port));
    }

    const lines: string[] = [];
    for (const raw of peer.sshHostKeys ?? []) {
      const key = normalizePubKey(raw);
      if (!key) throw new Error('pinHostKeys: peer offered an unparseable host key');
      for (const host of hosts) lines.push(`${host} ${key} ${markerFor(peer.machine)}`);
    }
    if (lines.length === 0) throw new Error('pinHostKeys: peer offered no host keys');

    const path = expandHome(this.cfg.admin.knownHostsPath);
    const next = replaceMarkedLines(await readFileOrEmpty(path), peer.machine, lines);
    await writeSecretFile(path, next);
  }

  // Removes this machine's SSH trust in the peer. The peer's config entry and mesh key are
  // node.ts's to remove (patchConfig); this lane owns the two SSH files only.
  async revokePeer(machine: string): Promise<void> {
    if (!MACHINE_NAME_RE.test(machine)) throw new Error('revokePeer: bad machine name');
    for (const path of [
      expandHome(this.cfg.admin.authorizedKeysPath),
      expandHome(this.cfg.admin.knownHostsPath),
    ]) {
      const existing = await readFileOrEmpty(path);
      if (!existing) continue;
      const next = replaceMarkedLines(existing, machine, []);
      if (next !== existing) await writeSecretFile(path, next);
    }
    this.rateWindow.delete(machine);
    this.lastRunMs.delete(machine);
  }

  // -------------------------------------------------------------------------
  // Status
  // -------------------------------------------------------------------------

  // Everything here is what THIS machine knows. `laneEnabled` is the local origin gate for every
  // entry (a peer's own acceptIncoming is only observable by attempting a run), and
  // credentialReady/credentialStale are meaningful for `self` only -- a peer's credential state
  // is never transmitted, by design, so it reads false until a run says otherwise.
  async status(): Promise<AdminStatusEntry[]> {
    const trust = await this.trust().catch(() => null);
    const credential = await this.credentialStatus();
    const configured = new Set(this.cfg.peers.map((p) => p.name));
    const pinned = await this.pinnedHostKeys();

    const self: AdminStatusEntry = {
      machine: this.cfg.machine,
      self: true,
      paired: true,
      reachable: true,
      credentialReady: credential.present && !credential.stale,
      credentialStale: credential.stale,
      laneEnabled: this.cfg.admin.enabled,
      sshKeyFingerprint: trust?.sshKeyFingerprint || null,
      hostKeyFingerprints: trust?.hostKeyFingerprints ?? [],
      lastAdminRunMs: this.lastRunMs.get(this.cfg.machine) ?? null,
    };

    const peers = [...configured].map((name): AdminStatusEntry => {
      const peer = this.cfg.peers.find((p) => p.name === name)!;
      const keys = pinned.get(name) ?? [];
      return {
        machine: name,
        self: false,
        paired: peer.publicKeyJwk !== null && keys.length > 0,
        reachable: this.deps.peerView(name)?.online ?? null,
        credentialReady: false,
        credentialStale: false,
        laneEnabled: this.cfg.admin.enabled,
        sshKeyFingerprint: null,
        hostKeyFingerprints: keys,
        lastAdminRunMs: this.lastRunMs.get(name) ?? null,
      };
    });
    return [self, ...peers];
  }

  private async credentialStatus(): Promise<{ present: boolean; stale: boolean }> {
    try {
      const broker = this.deps.secrets ?? (await defaultBroker());
      const s = await broker.status(this.cfg);
      return { present: s.present, stale: s.stale };
    } catch (err) {
      // A credential store we cannot read is reported as absent, never as ready.
      log('warn', 'sshadmin: could not read credential status', { error: sanitizedError(err) });
      return { present: false, stale: false };
    }
  }

  // The host TOKENS pinned for one machine, as ssh looks them up: '192.0.2.1' or '[192.0.2.1]:2222'.
  // pinnedHostKeys() answers "which keys", which cannot tell "changed" from "never pinned for the
  // host:port this dial actually used".
  private async pinnedHostTokens(machine: string): Promise<Set<string>> {
    const out = new Set<string>();
    const text = await readFileOrEmpty(expandHome(this.cfg.admin.knownHostsPath));
    for (const line of text.split('\n')) {
      const idx = line.indexOf(MARKER_PREFIX);
      if (idx < 0) continue;
      if (line.slice(idx + MARKER_PREFIX.length).trim() !== machine) continue;
      const fields = line.slice(0, idx).trim().split(/\s+/);
      if (fields.length < 3 || !fields[0]) continue;
      for (const token of fields[0].split(',')) out.add(token);
    }
    return out;
  }

  private async pinnedHostKeys(): Promise<Map<string, string[]>> {
    const out = new Map<string, string[]>();
    const text = await readFileOrEmpty(expandHome(this.cfg.admin.knownHostsPath));
    for (const line of text.split('\n')) {
      const idx = line.indexOf(MARKER_PREFIX);
      if (idx < 0) continue;
      const machine = line.slice(idx + MARKER_PREFIX.length).trim();
      const fields = line.slice(0, idx).trim().split(/\s+/);
      if (fields.length < 3) continue;
      const fp = sshFingerprint(`${fields[1]} ${fields[2]}`);
      if (!fp) continue;
      const list = out.get(machine) ?? [];
      if (!list.includes(fp)) list.push(fp);
      out.set(machine, list);
    }
    return out;
  }
}

// ---------------------------------------------------------------------------
// Free helpers
// ---------------------------------------------------------------------------

function mintRunId(): string {
  return randomBytes(9).toString('base64url');
}

// Every origin-side turndown. exitCode stays null -- that is what tells executeInner to append
// admin-run-refused INSTEAD of admin-run-completed, because nothing ran on either machine.
function refuse(refusal: AdminRefusalReason, message: string): Partial<AdminRunResult> {
  return { ok: false, exitCode: null, transport: null, refusal, message };
}

function clampTimeout(requested: number | undefined, fallback: number, ceiling: number): number {
  const wanted = Number.isInteger(requested) && (requested as number) > 0 ? (requested as number) : fallback;
  // Clamping DOWN is the fail-closed direction: a shorter deadline can only reduce exposure.
  return Math.min(wanted, ceiling);
}

// The largest response envelope a well-behaved target can produce: both streams at their raw cap,
// every byte of both escaped the worst way JSON can escape one, plus the scalar fields. Exported
// so the target-side writer can clamp the envelope it emits against the SAME number instead of
// two modules independently guessing (the two are tied to admin.maxOutputBytes, which an operator
// may edit).
export function maxEnvelopeBytes(cfg: FleetConfig): number {
  return cfg.admin.maxOutputBytes * JSON_ESCAPE_WORST_CASE * 2 + ENVELOPE_FIXED_OVERHEAD_BYTES;
}

// The origin's capture cap only has to be AN upper bound on that, never the exact one. Below it,
// a command that ran comes back as no result at all -- a NUL-heavy stdout is enough to get there.
function transportCaptureCap(cfg: FleetConfig): number {
  return maxEnvelopeBytes(cfg);
}

// JSON.stringify walks an object's own keys in insertion order, and every envelope this lane
// builds starts {"v":1,"exitCode":...}, so a truncated envelope still carries its exit code even
// though both streams are gone. Anchored at the start of the line: this reads the envelope's own
// prefix, it does not scrape a number out of arbitrary command output.
const TRUNCATED_ENVELOPE_HEAD_RE = /^\{"v":1,"exitCode":(null|-?\d{1,10})[,}]/;

function salvageEnvelopeExitCode(stdout: string): { exitCode: number | null } | null {
  const line = stdout.split('\n').filter((l) => l.trim().length > 0).pop();
  if (!line) return null;
  const m = TRUNCATED_ENVELOPE_HEAD_RE.exec(line.trim());
  if (!m) return null;
  return { exitCode: m[1] === 'null' ? null : Number(m[1]) };
}

// The answer to a runId this machine has already accepted. Never re-executes, and never invents a
// result it does not have: with no recorded outcome the first attempt is still in flight (or died
// mid-run), and the honest answer is that nothing was started a second time.
//
// No `refusal` on the in-flight branch: types.ts is not this lane's file and none of the existing
// AdminRefusalReason members means "duplicate run" without lying about why. The audit entry
// carries the precise reason.
function replayResponse(
  recorded: ExecLocalResponse | null,
  machine: string,
  durationMs: number,
): ExecLocalResponse {
  if (!recorded) {
    return {
      v: 1,
      exitCode: null,
      stdout: '',
      stderr: '',
      truncated: false,
      durationMs,
      message: `this run id is already in flight on ${machine}; it was not started a second time`,
    };
  }
  return {
    v: 1,
    exitCode: recorded.exitCode,
    stdout: '',
    stderr: '',
    truncated: recorded.truncated,
    durationMs,
    ...(recorded.refusal ? { refusal: recorded.refusal } : {}),
    message: recorded.refusal
      ? `this run id already reached ${machine} and was refused (${recorded.refusal}); it was not run again`
      : `this run id already ran on ${machine} and exited ${recorded.exitCode}; it was not run again, and its output is not retained`,
  };
}

function clip(s: string, max: number): string {
  return s.length <= max ? s : s.slice(0, max);
}

// The forced command in authorized_keys. `import.meta.dir` rather than a cwd-relative path: sshd
// invokes the forced command with no meaningful working directory.
export function forcedCommand(): string {
  return `${process.execPath} run ${join(import.meta.dir, 'cli.ts')} admin exec-local`;
}

function refusalResponse(refusal: AdminRefusalReason, message: string, durationMs: number): ExecLocalResponse {
  return { v: 1, exitCode: null, stdout: '', stderr: '', truncated: false, durationMs, refusal, message };
}

// Errors from the credential path are reduced to a constructor name. Nothing that could have been
// built by interpolating a password ever reaches a log line or a response body.
function sanitizedError(err: unknown): string {
  return err instanceof Error ? err.name : typeof err;
}

// secrets.ts raises SudoCredentialUnavailable with a closed `reason` enum. Read structurally
// rather than by `instanceof`, so this module does not have to import the credential module at
// load time just to name its error class.
function credentialRefusal(err: unknown): { refusal: AdminRefusalReason; message: string } {
  const reason = (err as { reason?: unknown } | null)?.reason;
  switch (reason) {
    case 'credential-stale':
      return { refusal: 'credential-stale', message: 'the stored sudo password was rejected; re-enter it in the GUI' };
    case 'no-credential':
      return { refusal: 'no-credential', message: 'no sudo credential is stored on the target machine' };
    case 'not-private':
      return { refusal: 'not-configured', message: 'the credential store on the target machine is not private' };
    default:
      return { refusal: 'no-credential', message: CREDENTIAL_ERROR_MESSAGE };
  }
}

function parseExecLocalResponse(stdout: string): ExecLocalResponse | null {
  const text = stdout.trim();
  if (!text) return null;
  // The forced command prints exactly one JSON object; a login banner or MOTD would prepend
  // lines, so the last non-empty line is the envelope.
  const line = text.split('\n').filter((l) => l.trim().length > 0).pop();
  if (!line) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null;
  const raw = parsed as Record<string, unknown>;
  if (raw.v !== 1) return null;
  const exitCode = raw.exitCode;
  if (exitCode !== null && !Number.isInteger(exitCode)) return null;
  return {
    v: 1,
    exitCode: exitCode as number | null,
    stdout: typeof raw.stdout === 'string' ? raw.stdout : '',
    stderr: typeof raw.stderr === 'string' ? raw.stderr : '',
    truncated: raw.truncated === true,
    durationMs: Number.isFinite(raw.durationMs) ? (raw.durationMs as number) : 0,
    ...(typeof raw.refusal === 'string' ? { refusal: raw.refusal as AdminRefusalReason } : {}),
    ...(typeof raw.message === 'string' ? { message: raw.message } : {}),
  };
}
