// SPDX-License-Identifier: AGPL-3.0-or-later
// Machine identity: ECDSA P-256 keypair, canonical signing, gossip envelopes, auth headers.
// Owns: key generation/persistence (0600 JWK file), sign/verify helpers, x-fleet-auth header.

import { chmod, open, rename, stat } from 'node:fs/promises';
import { createHash, randomBytes } from 'node:crypto';
import { dirname, join } from 'node:path';
import type { GossipEnvelope, MachineKey, PeerConfig } from './types';
import { b64decode, b64encode, canonicalJson, ensureDir, log, nowMs, runBytes } from './util';
import type { RunBytesResult } from './util';
import { configDir } from './config';

const CURVE_ALG = { name: 'ECDSA', namedCurve: 'P-256' } as const;
const SIGN_ALG = { name: 'ECDSA', hash: 'SHA-256' } as const;
const AUTH_WINDOW_MS = 120000;
const SECRET_FILE_MODE = 0o600;

function machineKeyPath(): string {
  return join(configDir(), 'machine-key.json');
}

// Decrypt-at-load seam (P1 RUNBOOK section 7's listed TPM-sealing upgrade). A sealed credential
// blob living beside the plain key file (<keypath>.cred) takes precedence: if present, its
// plaintext MachineKey JSON is recovered via `systemd-creds decrypt` (through the bounded runner
// in util.ts -- house pattern #1, never a raw unbounded Bun.spawn) instead of reading the plain
// file. No `.cred` file means behavior is byte-identical to the pre-existing plain-file path.
function machineKeyCredPath(keyPath: string): string {
  return `${keyPath}.cred`;
}

// Injectable so tests can exercise the sealed path without a real TPM/systemd-creds binary in CI.
export type RunSystemdCredsDecrypt = (credPath: string) => Promise<RunBytesResult>;

async function defaultDecryptCred(credPath: string): Promise<RunBytesResult> {
  return runBytes(['systemd-creds', 'decrypt', credPath, '-']);
}

// Returns null (falls through to the plain-file path) only when no sealed blob exists beside
// `keyPath`. Once a `.cred` file is present, sealing is the machine's stated intent: a failed
// decrypt, non-JSON plaintext, or malformed shape all throw (fail closed) rather than silently
// falling back to an unsealed key.
async function trySealedMachineKey(
  keyPath: string,
  decryptCred: RunSystemdCredsDecrypt,
): Promise<MachineKey | null> {
  const credPath = machineKeyCredPath(keyPath);
  const credFile = Bun.file(credPath);
  if (!(await credFile.exists())) return null;

  const result = await decryptCred(credPath);
  if (result.code !== 0) {
    throw new Error(
      `sukarfleet keys: systemd-creds decrypt failed for sealed machine key at ${credPath} (exit ${result.code}): ${result.stderr}`,
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(result.stdout));
  } catch (err) {
    throw new Error(
      `sukarfleet keys: decrypted sealed machine key at ${credPath} is not valid JSON: ${String(err)}`,
    );
  }
  if (!isMachineKey(parsed)) {
    throw new Error(`sukarfleet keys: decrypted sealed machine key at ${credPath} has an invalid shape`);
  }
  return parsed;
}

function warnIfNameMismatch(existing: MachineKey, machine: string, path: string): void {
  if (existing.machine !== machine) {
    log('warn', 'keys: stored machine key belongs to a different machine name', {
      stored: existing.machine,
      requested: machine,
      path,
    });
  }
}

// Writes with the final permission bits from the moment the inode is created, so there is
// no window where the secret is world/group readable (unlike write-then-chmod). Exported for
// secrets.ts's credential store, which has the same no-readable-window requirement.
export async function writeSecretFile(path: string, data: string): Promise<void> {
  const dir = dirname(path);
  await ensureDir(dir);
  const tmp = join(dir, `.tmp-key-${randomBytes(8).toString('hex')}`);
  const fh = await open(tmp, 'w', SECRET_FILE_MODE);
  try {
    await fh.writeFile(data, 'utf8');
  } finally {
    await fh.close();
  }
  try {
    await rename(tmp, path);
  } catch (err) {
    await chmod(tmp, SECRET_FILE_MODE).catch(() => {});
    throw err;
  }
}

function isJwk(v: unknown): v is JsonWebKey {
  return typeof v === 'object' && v !== null;
}

function isMachineKey(v: unknown): v is MachineKey {
  if (typeof v !== 'object' || v === null) return false;
  const obj = v as Record<string, unknown>;
  return (
    typeof obj.machine === 'string' &&
    obj.machine.length > 0 &&
    isJwk(obj.publicKeyJwk) &&
    isJwk(obj.privateKeyJwk)
  );
}

async function tryLoadMachineKey(path: string): Promise<MachineKey | null> {
  const file = Bun.file(path);
  if (!(await file.exists())) return null;

  try {
    const st = await stat(path);
    const mode = st.mode & 0o777;
    if (mode !== SECRET_FILE_MODE) {
      log('warn', 'keys: machine key file permissions are not 0600 -- correcting', {
        path,
        mode: mode.toString(8),
      });
      // must-keep #7: the machine key must be chmod 0600. A world/group-readable key (bad
      // restore, umask mishap, manual edit) is repaired in place rather than merely logged, and
      // re-verified before the private key material is ever read into memory. If the correction
      // itself fails (e.g. read-only filesystem), refuse to start rather than sign with a key
      // that may have leaked.
      try {
        await chmod(path, SECRET_FILE_MODE);
      } catch (chmodErr) {
        throw new Error(
          `sukarfleet keys: machine key file at ${path} has insecure permissions (${mode.toString(8)}) and could not be corrected to 0600: ${String(chmodErr)}`,
        );
      }
      const rechecked = await stat(path);
      const recheckedMode = rechecked.mode & 0o777;
      if (recheckedMode !== SECRET_FILE_MODE) {
        throw new Error(
          `sukarfleet keys: machine key file at ${path} still has insecure permissions (${recheckedMode.toString(8)}) after chmod 0600; refusing to load`,
        );
      }
      log('info', 'keys: corrected machine key file permissions to 0600', { path });
    }
  } catch (err) {
    if (err instanceof Error && err.message.startsWith('sukarfleet keys:')) throw err;
    log('warn', 'keys: could not stat machine key file', { path, error: String(err) });
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(await file.text());
  } catch (err) {
    throw new Error(`sukarfleet keys: machine key file at ${path} is not valid JSON: ${String(err)}`);
  }
  if (!isMachineKey(parsed)) {
    throw new Error(`sukarfleet keys: machine key file at ${path} has an invalid shape`);
  }
  return parsed;
}

async function generateMachineKey(machine: string): Promise<MachineKey> {
  const pair = await crypto.subtle.generateKey(CURVE_ALG, true, ['sign', 'verify']);
  const publicKeyJwk = await crypto.subtle.exportKey('jwk', pair.publicKey);
  const privateKeyJwk = await crypto.subtle.exportKey('jwk', pair.privateKey);
  return { machine, publicKeyJwk, privateKeyJwk };
}

// Loads the persisted machine keypair, creating and persisting a fresh one on first run.
// A key belonging to a different machine name is still returned as-is (identity is bound to
// the key material, not the config-supplied name); a mismatch is logged, not fixed silently.
//
// `opts.keyPath` is an additive, non-contract test seam: configDir() has no env override
// (unlike stateDir()), so tests need a way to avoid touching the real machine's
// ~/.config/sukarfleet/machine-key.json. Omit it for normal use.
//
// `opts.decryptCred` is likewise an additive test seam for the sealed-blob path (see
// trySealedMachineKey above) -- omit it for normal use, where the real `systemd-creds decrypt`
// binary is invoked via the bounded runner.
export async function loadOrCreateMachineKey(
  machine: string,
  opts: { keyPath?: string; decryptCred?: RunSystemdCredsDecrypt } = {},
): Promise<MachineKey> {
  const path = opts.keyPath ?? machineKeyPath();
  const decryptCred = opts.decryptCred ?? defaultDecryptCred;

  const sealed = await trySealedMachineKey(path, decryptCred);
  if (sealed) {
    warnIfNameMismatch(sealed, machine, path);
    return sealed;
  }

  const existing = await tryLoadMachineKey(path);
  if (existing) {
    warnIfNameMismatch(existing, machine, path);
    return existing;
  }
  const key = await generateMachineKey(machine);
  await writeSecretFile(path, JSON.stringify(key, null, 2) + '\n');
  log('info', 'keys: generated new machine key', { machine, path });
  return key;
}

async function importPrivateKey(jwk: JsonWebKey): Promise<CryptoKey> {
  return crypto.subtle.importKey('jwk', jwk, CURVE_ALG, false, ['sign']);
}

async function importPublicKey(jwk: JsonWebKey): Promise<CryptoKey> {
  return crypto.subtle.importKey('jwk', jwk, CURVE_ALG, false, ['verify']);
}

// TS 5.7's lib.dom.d.ts made Uint8Array generic over its backing buffer; bare `Uint8Array`
// (what TextEncoder().encode() and util.ts's b64decode() both return) widens to
// Uint8Array<ArrayBufferLike>, which SubtleCrypto's BufferSource (ArrayBufferView<ArrayBuffer>)
// rejects at the type level even though it is always a plain-ArrayBuffer-backed view at runtime
// here. Cast at the WebCrypto boundary only.
async function signBytes(data: Uint8Array, key: MachineKey): Promise<string> {
  const privateKey = await importPrivateKey(key.privateKeyJwk);
  const sig = await crypto.subtle.sign(SIGN_ALG, privateKey, data as BufferSource);
  return b64encode(new Uint8Array(sig));
}

async function verifyBytes(data: Uint8Array, sigB64: string, publicKeyJwk: JsonWebKey): Promise<boolean> {
  try {
    const publicKey = await importPublicKey(publicKeyJwk);
    const sig = b64decode(sigB64);
    return await crypto.subtle.verify(SIGN_ALG, publicKey, sig as BufferSource, data as BufferSource);
  } catch {
    return false;
  }
}

export async function signCanonical(obj: unknown, key: MachineKey): Promise<string> {
  const data = new TextEncoder().encode(canonicalJson(obj));
  return signBytes(data, key);
}

export async function verifyCanonical(
  obj: unknown,
  sigB64: string,
  publicKeyJwk: JsonWebKey,
): Promise<boolean> {
  const data = new TextEncoder().encode(canonicalJson(obj));
  return verifyBytes(data, sigB64, publicKeyJwk);
}

// Signs {v,machine,tsMs,seq,payload} per the pinned contract and returns the full envelope.
export async function signGossip(
  envelope: Omit<GossipEnvelope, 'sigB64'>,
  key: MachineKey,
): Promise<GossipEnvelope> {
  const sigB64 = await signCanonical(envelope, key);
  return { ...envelope, sigB64 };
}

export async function verifyGossip(envelope: GossipEnvelope, publicKeyJwk: JsonWebKey): Promise<boolean> {
  const { sigB64, ...rest } = envelope;
  return verifyCanonical(rest, sigB64, publicKeyJwk);
}

// x-fleet-auth value: "<machine>;<tsMs>;<sigB64>", signature over
// method + "\n" + pathWithQuery + "\n" + tsMs + "\n" + machine.
export async function buildAuthHeader(
  method: string,
  pathWithQuery: string,
  machine: string,
  key: MachineKey,
): Promise<string> {
  const tsMs = nowMs();
  const signingString = `${method}\n${pathWithQuery}\n${tsMs}\n${machine}`;
  const sigB64 = await signBytes(new TextEncoder().encode(signingString), key);
  return `${machine};${tsMs};${sigB64}`;
}

export async function verifyAuthHeader(
  headerValue: string,
  method: string,
  pathWithQuery: string,
  peers: PeerConfig[],
  nowMsVal: number,
): Promise<{ ok: boolean; machine?: string; reason?: string }> {
  const parts = headerValue.split(';');
  if (parts.length !== 3 || !parts[0] || !parts[1] || !parts[2]) {
    return { ok: false, reason: 'malformed header' };
  }
  const [machine, tsMsStr, sigB64] = parts as [string, string, string];

  const tsMs = Number(tsMsStr);
  if (!Number.isFinite(tsMs)) return { ok: false, machine, reason: 'malformed timestamp' };
  if (Math.abs(nowMsVal - tsMs) > AUTH_WINDOW_MS) {
    return { ok: false, machine, reason: 'timestamp outside window' };
  }

  const peer = peers.find((p) => p.name === machine);
  if (!peer) return { ok: false, reason: 'unknown machine' };
  if (!peer.publicKeyJwk) return { ok: false, machine, reason: 'peer has no public key configured' };

  const signingString = `${method}\n${pathWithQuery}\n${tsMs}\n${machine}`;
  const ok = await verifyBytes(new TextEncoder().encode(signingString), sigB64, peer.publicKeyJwk);
  if (!ok) return { ok: false, machine, reason: 'bad signature' };
  return { ok: true, machine };
}

// sha256 over canonicalJson(jwk), base64url, first 16 chars. Sync (Node crypto, not WebCrypto)
// because the pinned signature returns string, not Promise<string>.
export function publicKeyFingerprint(jwk: JsonWebKey): string {
  const digest = createHash('sha256').update(canonicalJson(jwk)).digest();
  return digest.toString('base64url').slice(0, 16);
}
