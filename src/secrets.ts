// SPDX-License-Identifier: AGPL-3.0-or-later
// Sudo credential store for the SSH admin lane (p3-ssh-admin). This is the ONE module in the
// codebase that materializes a sudo password, and withSudoPassword is the only function in it
// that does.
//
// The invariants this file exists to hold, all load-bearing:
//   - Plaintext lives only on the stack frame of withSudoPassword and on a pipe to a child's
//     stdin. It is never returned, logged, audited, put in argv, put in the environment, or
//     written anywhere except the sealed store below. Nothing here may be changed in a way that
//     lets it reach a log line, an Error message, an Error stack, or a callback's result.
//   - At rest it is sealed by the platform credential store (platform.ts). Scope choice is forced
//     by what actually works unprivileged, measured on real hardware:
//       * `--with-key=tpm2` (system scope) FAILS as an unprivileged uid -- one machine returns
//         "Failed to encrypt: io.systemd.System", another the blunter
//         "io.systemd.InteractiveAuthenticationRequired". System-scope encryption needs
//         /var/lib/systemd/credential.secret, which is 0400 root:root. It is not an option
//         without either root or an interactive polkit prompt, and this lane has neither.
//       * `--user` encrypt+decrypt round-trips as uid 1000 with no root, no TTY, no polkit and
//         an empty environment (verified under `setsid env -i`, i.e. the daemon's own context).
//     What --user sealing buys, stated exactly: the blob is bound to this uid on this host and
//     is inert anywhere else, so a credential that leaks through a synced repo, a backup, or a
//     copied directory is useless to the reader. What it does NOT buy: protection from another
//     process running as this same uid (that process can simply ask systemd to decrypt it), and
//     -- when the host key lives on an unencrypted disk -- protection from whole-disk theft.
//     No doc in this repo may claim more than this.
//     If a future machine can seal to a TPM unprivileged, sealAvailable() upgrades to it
//     automatically; the stored `sealed` field records which was actually used.
//   - setSudoPassword authenticates exactly ONCE and never retries. A retry loop against a wrong
//     password is the one behavior here that can lock the operator out of their own machine.
//
// Measured against sudo-rs 0.2.13 rather than GNU sudo: `-S` reads one line from stdin, `-p ''`
// suppresses the prompt on both streams, `-k` forces a genuine re-authentication, and stdin must
// be CLOSED after that single line (a second read attempt fails with "Authentication required but
// not attempted"). A pty wrapper (script -qec) hangs and must never be reintroduced.

import { chmod, mkdir, realpath, stat, unlink } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { userInfo } from 'node:os';
import { join } from 'node:path';
import type { FleetConfig } from './types';
import { log, nowMs, readJsonFile, run, runBytes } from './util';
import { writeSecretFile } from './keys';
import { secretsDir } from './config';
import { credentialBackendFor, storePrivacyProbeFor } from './platform';
import type { SealScope } from './platform';

const CRED_NAME = 'sukarfleet-sudo';
const PROBE_NAME = 'sukarfleet-seal-probe';

// Sealing scopes come from the platform credential backend, strongest first. The BACKEND supplies
// argv only -- it never sees a plaintext password. This file keeps ownership of the pipe, so the
// invariant that plaintext exists on exactly one stack frame stays local to this module rather
// than being spread across three platform implementations.
export type { SealScope } from './platform';
const CRED_FILE = 'sudo.cred';
const META_FILE = 'sudo.meta.json';
const STORE_MODE = 0o700;
// One authentication attempt against a local PAM stack; 15 s covers a slow pam module without
// leaving the target leg of an admin call parked.
const VERIFY_TIMEOUT_MS = 15000;
// TPM2 seal/unseal is ~1 s on this hardware; the cap only exists so a wedged tpm2 device cannot
// hold a request open forever.
const SEAL_TIMEOUT_MS = 15000;
// Capability PROBING is not the same operation as sealing a real credential and must not inherit
// its patience: on some hardware the tpm2 scope does not refuse, it hangs, so an unbounded-ish probe
// puts that latency in front of the credential screen. A scope that cannot answer in 3 s is not a
// scope this lane can use for an interactive flow.
const SEAL_PROBE_TIMEOUT_MS = 3000;
const SEAL_PROBE_TTL_OK_MS = 10 * 60 * 1000;
const SEAL_PROBE_TTL_FAIL_MS = 30 * 1000;
let sealProbeCache: { result: { ok: boolean; scope?: SealScope; reason?: string }; expiresMs: number } | null = null;

export interface SudoCredentialStatus {
  present: boolean;
  stale: boolean;
  sealed: SealScope | 'plaintext' | null;
  user: string;
  setAtMs: number | null;
  lastUsedMs: number | null;
  lastFailureMs: number | null;
}

export type SudoCredentialUnavailableReason =
  | 'no-credential'
  | 'credential-stale'
  | 'unseal-failed'
  | 'not-private';

export class SudoCredentialUnavailable extends Error {
  readonly reason: SudoCredentialUnavailableReason;

  constructor(reason: SudoCredentialUnavailableReason, message: string) {
    super(`sukarfleet secrets: ${message}`);
    this.name = 'SudoCredentialUnavailable';
    this.reason = reason;
  }
}

// Persisted beside the sealed blob. Every field here is metadata ABOUT the credential; none of it
// is derived from the password itself (no hash, no length, no prefix) so this file staying
// readable at 0600 is a convenience, not a second secret.
interface CredentialMeta {
  user: string;
  setAtMs: number | null;
  lastUsedMs: number | null;
  lastFailureMs: number | null;
  stale: boolean;
  sealed: SealScope | 'plaintext';
}

// A stale mark that could not be persisted still has to bind this process: without it the next
// admin call would re-present a password sudo already rejected, which is exactly the loop that
// locks an account. Keyed by credential path so a test store and the real store never share it.
const staleLatch = new Set<string>();

function credPath(cfg: FleetConfig): string {
  return join(secretsDir(cfg), CRED_FILE);
}

function metaPath(cfg: FleetConfig): string {
  return join(secretsDir(cfg), META_FILE);
}

function currentUser(): string {
  try {
    return userInfo().username;
  } catch {
    return process.env.USER ?? '';
  }
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function firstLine(s: string): string {
  return s.split('\n')[0]?.trim() ?? '';
}

function notPrivate(message: string): SudoCredentialUnavailable {
  return new SudoCredentialUnavailable('not-private', message);
}

async function readMeta(cfg: FleetConfig): Promise<CredentialMeta | null> {
  const raw = await readJsonFile<Record<string, unknown>>(metaPath(cfg));
  if (raw === null || typeof raw !== 'object') return null;
  if (raw.sealed !== 'tpm2' && raw.sealed !== 'user' && raw.sealed !== 'plaintext') return null;
  if (typeof raw.stale !== 'boolean') return null;
  const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
  return {
    user: typeof raw.user === 'string' ? raw.user : '',
    setAtMs: num(raw.setAtMs),
    lastUsedMs: num(raw.lastUsedMs),
    lastFailureMs: num(raw.lastFailureMs),
    stale: raw.stale,
    sealed: raw.sealed,
  };
}

async function writeMeta(cfg: FleetConfig, meta: CredentialMeta): Promise<void> {
  await writeSecretFile(metaPath(cfg), JSON.stringify(meta, null, 2) + '\n');
}

// Real encrypt -> decrypt round trip with a throwaway value. Nothing here infers availability from
// `systemd-analyze has-tpm2` or from group membership: the only claim worth making at the
// credential screen is that this exact command pair works for this exact uid, right now.
//
// Scopes are tried strongest-first. On both current fleet machines tpm2 loses immediately (see the
// file header) and `--user` wins, but the order is what makes a better-provisioned machine seal
// better without a code change. The winning scope is returned so the caller records what was
// actually used rather than what was hoped for.
export async function sealAvailable(): Promise<{ ok: boolean; scope?: SealScope; reason?: string }> {
  // Memoized: this is a property of the machine, not of the request, and the credential screen
  // polls it. Probing costs a process pair per scope, and on a machine where the tpm2 scope hangs
  // rather than refusing (real hardware does this) an unmemoized probe would put SEAL_PROBE_TIMEOUT_MS of
  // latency on every poll. A failed result is cached for a much shorter window so a machine that
  // gains the capability is picked up without a daemon restart.
  const now = nowMs();
  if (sealProbeCache && now < sealProbeCache.expiresMs) return sealProbeCache.result;

  const reasons: string[] = [];
  let result: { ok: boolean; scope?: SealScope; reason?: string } = {
    ok: false,
    reason: 'no sealing scope available',
  };
  for (const scope of credentialBackendFor().scopes) {
    const r = await trySealScope(scope);
    if (r.ok) {
      result = { ok: true, scope };
      break;
    }
    reasons.push(`${scope}: ${r.reason}`);
  }
  if (!result.ok) result = { ok: false, reason: reasons.join('; ') };

  const ttl = result.ok ? SEAL_PROBE_TTL_OK_MS : SEAL_PROBE_TTL_FAIL_MS;
  sealProbeCache = { result, expiresMs: now + ttl };
  return result;
}

// Exported for tests and for the credential screen's explicit "re-check" action: a machine that
// was just given a working TPM should not have to wait out the cache.
export function resetSealProbeCache(): void {
  sealProbeCache = null;
}

async function trySealScope(scope: SealScope): Promise<{ ok: boolean; reason?: string }> {
  const probe = randomBytes(16).toString('hex');
  try {
    const backend = credentialBackendFor();
    const sealed = await runBytes(backend.sealArgv(scope, PROBE_NAME), {
      stdin: probe,
      timeoutMs: SEAL_PROBE_TIMEOUT_MS,
    });
    if (sealed.code !== 0) {
      return { ok: false, reason: firstLine(sealed.stderr) || `encrypt exited ${sealed.code}` };
    }
    const back = await runBytes(backend.unsealArgv(scope, PROBE_NAME), {
      stdin: sealed.stdout,
      timeoutMs: SEAL_PROBE_TIMEOUT_MS,
    });
    if (back.code !== 0) {
      return { ok: false, reason: firstLine(back.stderr) || `decrypt exited ${back.code}` };
    }
    if (new TextDecoder().decode(back.stdout) !== probe) {
      return { ok: false, reason: 'round trip did not reproduce the probe value' };
    }
    return { ok: true };
  } catch (err) {
    // Bun.spawn throws when the binary is absent; a machine with no systemd-creds is simply not
    // able to seal, which is a reason string, not a crash.
    return { ok: false, reason: messageOf(err) };
  }
}

// Fails closed: the store must be a directory this uid owns, at 0700, on a filesystem that
// actually enforces that. Self-heals a widened mode, but only when the chmod verifiably sticks.
export async function assertPrivateStore(cfg: FleetConfig): Promise<void> {
  const dir = secretsDir(cfg);
  try {
    // Created at 0700 directly rather than through util.ensureDir + chmod: a recursive mkdir
    // under the ambient umask would leave a readable window on a directory about to hold the
    // sealed credential.
    await mkdir(dir, { recursive: true, mode: STORE_MODE });
  } catch (err) {
    throw notPrivate(`could not create the credential store at ${dir}: ${messageOf(err)}`);
  }

  let resolved: string;
  try {
    resolved = await realpath(dir);
  } catch (err) {
    throw notPrivate(`could not resolve the credential store at ${dir}: ${messageOf(err)}`);
  }

  // Fails closed. On Linux this reads the mount table to catch mode-blind filesystems; elsewhere
  // it is a real write-then-stat round trip. Either way the question asked is "did the mode
  // actually stick?", never "what filesystem is this and do I believe it enforces modes?".
  const privacy = await storePrivacyProbeFor().enforcesMode(resolved);
  if (!privacy.ok) throw notPrivate(privacy.detail);

  let st = await stat(resolved).catch((err: unknown) => {
    throw notPrivate(`could not stat the credential store at ${resolved}: ${messageOf(err)}`);
  });
  if (!st.isDirectory()) throw notPrivate(`${resolved} is not a directory`);

  if ((st.mode & 0o777) !== STORE_MODE) {
    try {
      await chmod(resolved, STORE_MODE);
    } catch (err) {
      throw notPrivate(`could not chmod 0700 the credential store at ${resolved}: ${messageOf(err)}`);
    }
    st = await stat(resolved);
    if ((st.mode & 0o777) !== STORE_MODE) {
      throw notPrivate(
        `chmod 0700 did not stick on ${resolved} (mode is still 0${(st.mode & 0o777).toString(8)})`,
      );
    }
  }

  const uid = process.getuid?.();
  if (uid !== undefined && st.uid !== uid) {
    throw notPrivate(`the credential store at ${resolved} is owned by uid ${st.uid}, not ${uid}`);
  }
}

// Never throws: this feeds the status screen and the health surface, where "unknown" has to render
// as a state rather than take a route down.
export async function status(cfg: FleetConfig): Promise<SudoCredentialStatus> {
  const path = credPath(cfg);
  const present = await Bun.file(path)
    .exists()
    .catch(() => false);
  const meta = await readMeta(cfg).catch(() => null);
  if (!present) {
    return {
      present: false,
      stale: false,
      sealed: null,
      user: meta?.user || currentUser(),
      setAtMs: null,
      lastUsedMs: null,
      lastFailureMs: null,
    };
  }
  if (meta === null) {
    // A credential whose metadata is missing or malformed has lost its stale flag with it, so it
    // is reported stale until it is set again -- the safe direction for a flag whose whole job is
    // to stop a known-bad password reaching sudo.
    return {
      present: true,
      stale: true,
      sealed: null,
      user: currentUser(),
      setAtMs: null,
      lastUsedMs: null,
      lastFailureMs: null,
    };
  }
  return {
    present: true,
    stale: meta.stale || staleLatch.has(path),
    sealed: meta.sealed,
    user: meta.user || currentUser(),
    setAtMs: meta.setAtMs,
    lastUsedMs: meta.lastUsedMs,
    lastFailureMs: meta.lastFailureMs,
  };
}

export async function setSudoPassword(
  cfg: FleetConfig,
  pw: string,
): Promise<{ ok: boolean; reason?: 'verify-failed' | 'seal-unavailable' | 'not-private'; message?: string }> {
  // `sudo -S` reads exactly one line: a password carrying a newline would silently authenticate
  // with its first line and feed the rest to the command. Refused before anything touches sudo or
  // the store, and the refusal names the shape, never the value.
  if (pw.length === 0 || pw.includes('\n') || pw.includes('\r') || pw.includes('\0')) {
    return {
      ok: false,
      reason: 'verify-failed',
      message: 'the password is empty or contains a newline or NUL byte, which `sudo -S` cannot carry',
    };
  }

  try {
    await assertPrivateStore(cfg);
  } catch (err) {
    return { ok: false, reason: 'not-private', message: messageOf(err) };
  }

  const seal = await sealAvailable();
  const sealScope: SealScope = seal.scope ?? 'user';
  // allowPlaintextFallback is false in every shipped config; it exists so a machine that can seal
  // in NO scope fails loudly here instead of silently downgrading the store.
  const plaintextStore = !seal.ok && cfg.admin.allowPlaintextFallback;
  if (!seal.ok && !plaintextStore) {
    return {
      ok: false,
      reason: 'seal-unavailable',
      message: seal.reason ?? 'systemd-creds could not seal a credential on this machine',
    };
  }

  // EXACTLY ONE authentication attempt, ever -- no retry, no second prompt, no fallback path that
  // tries again with a variation. -k defeats a cached sudo timestamp so a stored-but-wrong
  // password is caught here rather than at the first real admin call.
  const probe = await run(['sudo', '-k', '-S', '-p', '', '-v'], {
    stdin: pw + '\n',
    timeoutMs: VERIFY_TIMEOUT_MS,
  });
  if (probe.code !== 0) {
    // sudo's own stderr is deliberately not forwarded: it is not needed to act on this, and the
    // less of a failed authentication's output that travels to a UI, the fewer paths exist for
    // anything derived from the attempt to travel with it.
    return {
      ok: false,
      reason: 'verify-failed',
      message:
        probe.code === 124
          ? `sudo did not answer within ${VERIFY_TIMEOUT_MS / 1000}s`
          : 'sudo rejected the credential',
    };
  }

  let stored: string;
  if (plaintextStore) {
    stored = pw;
  } else {
    const sealed = await runBytes(
      credentialBackendFor().sealArgv(sealScope, CRED_NAME),
      { stdin: pw, timeoutMs: SEAL_TIMEOUT_MS },
    );
    if (sealed.code !== 0) {
      return {
        ok: false,
        reason: 'seal-unavailable',
        message: firstLine(sealed.stderr) || `systemd-creds encrypt exited ${sealed.code}`,
      };
    }
    // The store is only worth anything if it unseals. Proving the real blob round-trips now beats
    // discovering it during an admin call, when the credential screen is no longer in front of
    // anyone.
    const back = await runBytes(
      credentialBackendFor().unsealArgv(sealScope, CRED_NAME),
      { stdin: sealed.stdout, timeoutMs: SEAL_TIMEOUT_MS },
    );
    if (back.code !== 0 || new TextDecoder().decode(back.stdout) !== pw) {
      return {
        ok: false,
        reason: 'seal-unavailable',
        message: 'the sealed credential did not round-trip; nothing was stored',
      };
    }
    stored = new TextDecoder().decode(sealed.stdout);
  }

  // Credential first, metadata second: a crash between the two leaves a credential with no
  // metadata, which status() and withSudoPassword both read as stale. The reverse order would
  // leave metadata claiming a credential that is not there.
  await writeSecretFile(credPath(cfg), stored);
  await writeMeta(cfg, {
    user: currentUser(),
    setAtMs: nowMs(),
    lastUsedMs: null,
    lastFailureMs: null,
    stale: false,
    sealed: plaintextStore ? 'plaintext' : sealScope,
  });
  staleLatch.delete(credPath(cfg));
  log('info', 'secrets: sudo credential stored', { sealed: plaintextStore ? 'plaintext' : sealScope });
  return { ok: true };
}

export async function removeSudoPassword(cfg: FleetConfig): Promise<void> {
  staleLatch.delete(credPath(cfg));
  for (const path of [credPath(cfg), metaPath(cfg)]) {
    try {
      await unlink(path);
    } catch (err) {
      // Absent is the desired end state; anything else is a removal that did not remove and the
      // caller has to hear about it.
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    }
  }
  log('info', 'secrets: sudo credential removed', {});
}

// Records that sudo rejected the stored credential. Never throws: it is called from the target leg
// of a failing admin call, where a metadata write failure must not replace the real refusal.
export async function markStale(cfg: FleetConfig, atMs: number): Promise<void> {
  staleLatch.add(credPath(cfg));
  try {
    const meta = await readMeta(cfg);
    await writeMeta(cfg, {
      user: meta?.user ?? currentUser(),
      setAtMs: meta?.setAtMs ?? null,
      lastUsedMs: meta?.lastUsedMs ?? null,
      lastFailureMs: atMs,
      stale: true,
      sealed: meta?.sealed ?? 'tpm2',
    });
  } catch (err) {
    log('error', 'secrets: could not persist the stale mark on the sudo credential', {
      path: metaPath(cfg),
      error: messageOf(err),
    });
  }
}

export async function clearStale(cfg: FleetConfig): Promise<void> {
  staleLatch.delete(credPath(cfg));
  try {
    const meta = await readMeta(cfg);
    if (meta === null) return;
    await writeMeta(cfg, { ...meta, stale: false });
  } catch (err) {
    log('error', 'secrets: could not clear the stale mark on the sudo credential', {
      path: metaPath(cfg),
      error: messageOf(err),
    });
  }
}

const REDACTED = '[redacted]';

// The callback's result leaves this module and ends up in an ExecLocalResponse, an audit-adjacent
// log line and eventually an HTTP body. A command that echoes its own stdin, or a future caller
// bug, must not be the way the credential gets out, so anything carrying it is redacted at the
// boundary. Only strings, arrays and plain objects are rebuilt; a class instance is passed through
// untouched rather than silently reshaped. A very short password redacts aggressively -- that is
// the safe direction for this trade.
function scrubValue<T>(value: T, secret: string): T {
  return scrub(value, secret, 0) as T;
}

function scrub(v: unknown, secret: string, depth: number): unknown {
  if (depth > 8) return v;
  if (typeof v === 'string') return v.includes(secret) ? v.split(secret).join(REDACTED) : v;
  if (Array.isArray(v)) return v.map((item) => scrub(item, secret, depth + 1));
  if (v !== null && typeof v === 'object') {
    const proto = Object.getPrototypeOf(v);
    if (proto !== Object.prototype && proto !== null) return v;
    const out: Record<string, unknown> = {};
    for (const [k, item] of Object.entries(v as Record<string, unknown>)) {
      out[k] = scrub(item, secret, depth + 1);
    }
    return out;
  }
  return v;
}

// Rebuilt rather than patched: Error.stack is captured at construction, so rewriting .message
// alone would leave the plaintext sitting in the stack string.
function scrubError(err: unknown, secret: string): unknown {
  const text = err instanceof Error ? `${err.message}\n${err.stack ?? ''}` : String(err);
  if (!text.includes(secret)) return err;
  const replacement = new Error(
    'sukarfleet secrets: the callback threw an error carrying the sudo credential; details redacted',
  );
  if (err instanceof Error) replacement.name = err.name;
  return replacement;
}

// The only place a sudo password exists in plaintext in this process. It is handed to `fn` and to
// nothing else: not returned, not logged, not stringified into an error, never in argv or env.
// Callers pipe it to a child's stdin and let it go.
//
// (A JS string cannot be wiped after use -- the mitigation is that the value is short-lived and
// unreferenced once fn returns, not that memory is scrubbed. Documented rather than pretended.)
export async function withSudoPassword<T>(
  cfg: FleetConfig,
  fn: (pw: string) => Promise<T>,
): Promise<T> {
  await assertPrivateStore(cfg);

  const path = credPath(cfg);
  const file = Bun.file(path);
  if (!(await file.exists())) {
    throw new SudoCredentialUnavailable('no-credential', `no sudo credential stored in ${secretsDir(cfg)}`);
  }
  const meta = await readMeta(cfg);
  if (meta === null) {
    throw new SudoCredentialUnavailable(
      'credential-stale',
      'the stored sudo credential has no readable metadata; set it again from the credential screen',
    );
  }
  if (meta.stale || staleLatch.has(path)) {
    throw new SudoCredentialUnavailable(
      'credential-stale',
      'the stored sudo credential was rejected by sudo and must be set again',
    );
  }

  const stored = await file.text();
  let plaintext: string;
  if (meta.sealed === 'plaintext') {
    // An unsealed store is only readable while the machine is still configured to allow one;
    // flipping the flag back off must strand the credential rather than keep using it.
    if (!cfg.admin.allowPlaintextFallback) {
      throw new SudoCredentialUnavailable(
        'unseal-failed',
        'the stored credential is unsealed but admin.allowPlaintextFallback is false; set it again',
      );
    }
    plaintext = stored;
  } else {
    // Unsealed with the SAME scope it was sealed with, read from the metadata rather than probed:
    // a user-scope blob does not decrypt in system scope, so guessing here would strand a working
    // credential. Older metadata that predates the scope field reads as 'tpm2', which is what
    // system-scope decrypt expects.
    const unsealed = await runBytes(
      credentialBackendFor().unsealArgv(meta.sealed, CRED_NAME),
      { stdin: stored, timeoutMs: SEAL_TIMEOUT_MS },
    );
    // Only the exit code travels into the error. systemd-creds writes the plaintext to stdout and
    // nothing but diagnostics to stderr, but the exit code is the one field that cannot carry it
    // under any failure mode, so it is the only field used.
    if (unsealed.code !== 0) {
      throw new SudoCredentialUnavailable(
        'unseal-failed',
        `systemd-creds could not unseal the stored credential (exit ${unsealed.code})`,
      );
    }
    plaintext = new TextDecoder().decode(unsealed.stdout);
  }
  if (plaintext.length === 0) {
    throw new SudoCredentialUnavailable('unseal-failed', 'the unsealed credential is empty');
  }

  // Recorded before the callback runs: a command that hangs until the timeout still used the
  // credential, and the status screen has to show that.
  try {
    await writeMeta(cfg, { ...meta, lastUsedMs: nowMs() });
  } catch (err) {
    log('warn', 'secrets: could not record credential use', { path: metaPath(cfg), error: messageOf(err) });
  }

  try {
    return scrubValue(await fn(plaintext), plaintext);
  } catch (err) {
    throw scrubError(err, plaintext);
  }
}
