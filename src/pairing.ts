// SPDX-License-Identifier: AGPL-3.0-or-later
// Mesh pairing for the SSH admin lane (p3-ssh-admin). Owns src/pairing.ts only.
//
// One round trip. The operator mints a 40-bit one-shot code on machine A's GUI and types it into
// machine B's GUI; B POSTs /pair/hello to A carrying B's bundle (mesh pubkey + SSH client pubkey +
// SSH host keys) MAC'd under a key derived from the code, and A answers with its own bundle MAC'd
// under the same key with the request's sha256 bound in. Both sides install each other from the
// exchange, so one wizard step replaces the hand-edited peer entries and hand-copied keys of P1/P2.
//
// WHAT THE CODE BUYS, HONESTLY:
//   - It authenticates the BOOTSTRAP, and only that. /pair/hello is the one route on this daemon
//     with no x-fleet-auth gate, because the whole point is that the caller is not yet a configured
//     peer -- there is no prior key to check it against. The code is the entire authentication for
//     that single exchange: it proves the party on the other end is the human standing at the other
//     machine's screen, and its MAC covers both bundles, so a mesh-local attacker cannot substitute
//     its own SSH key into a legitimate exchange without knowing the code.
//   - Against an on-mesh guesser it is 40 bits with a 5-attempt burn and a 300 s TTL: ~2^-37.7 per
//     code minted. That is the number this design actually rests on.
//
// WHAT IT DOES NOT BUY:
//   - It is NOT the security boundary for the admin lane. Once a peer is installed, what constrains
//     it is the authorized_keys option prefix -- restrict,from=...,command="... admin exec-local" --
//     which the RECEIVING side always builds locally from its own config and NEVER takes from the
//     bundle. A peer that lies about its option prefix, its host keys, or its mesh IP gets those
//     fields dropped or rebuilt here; it cannot widen its own grant. That rule, not the code, is
//     what keeps a compromised peer from turning a pairing into unrestricted shell.
//   - Re-pairing two machines that are ALREADY mutually authenticated on the mesh adds no
//     cryptographic assurance over the existing signed channel; there it is UX confirmation of
//     operator intent (and the transport for the SSH half of the identity), nothing more.
//   - It is a one-round-trip protocol, so a response lost in flight leaves the responder paired and
//     the initiator not ('half-paired'). The code is burned either way; the operator re-mints. We
//     accept that over a second round trip because a stuck half-pair is visible and repairable and
//     a second wizard step is not free.
//
// Fail-closed posture: wrong code, expired code, burned code and a stale timestamp all return the
// byte-identical 401 with a 15 ms timing floor, so
// nothing distinguishes them to a caller. Every shape/validation failure returns one identical 400,
// so a probe cannot learn WHICH field it got wrong.

import { createHash, timingSafeEqual } from 'node:crypto';
import type { AuditEntry, FleetConfig, PairBundle, PairHelloResponse } from './types';
import { b64decode, b64encode, canonicalJson, log, nowMs, sleep } from './util';
import { readCappedBody } from './http';
import { AUDIT_KIND_PAIR_ACCEPTED } from './audit';

// ---------------------------------------------------------------------------
// Tunables. Local constants rather than FleetConfig.admin fields: none of these is a per-machine
// fact, and a config-tunable attempt budget or TTL is a knob whose only use is loosening them.
// ---------------------------------------------------------------------------

const PAIR_CODE_TTL_MS = 300_000; // 300 s -- covers walking between rooms, nothing more.
const PAIR_CODE_MAX_ATTEMPTS = 5; // burned on the 5th bad MAC, and on the 1st good one.
// Same window keys.ts's verifyAuthHeader applies to x-fleet-auth. Both payloads carry tsMs and both
// are checked, so a captured exchange cannot be replayed at leisure even before the code is burned.
const PAIR_FRESHNESS_WINDOW_MS = 120_000;
const PAIR_MAX_BODY_BYTES = 65536;
const PAIR_BODY_READ_TIMEOUT_MS = 10_000;
const PAIR_AUTH_FAILURE_MIN_MS = 15;
const REDEEM_TIMEOUT_MS = 10_000;

// A bare ed25519 key line is ~80 bytes with a comment; 512 is generous headroom and still far too
// small to smuggle a payload. Host keys allow RSA, hence the larger cap.
const MAX_SSH_KEY_BYTES = 512;
const MAX_SSH_HOST_KEY_BYTES = 1024;
const MAX_SSH_HOST_KEYS = 8;
const MAX_MACHINE_NAME_LEN = 64;

// The SSH client key is the one field that ends up inside an authorized_keys line, so only the one
// algorithm the fleet actually issues is accepted. Host keys are whatever sshd already serves.
const SSH_CLIENT_KEY_TYPES = ['ssh-ed25519'] as const;
const SSH_HOST_KEY_TYPES = [
  'ssh-ed25519',
  'ssh-rsa',
  'rsa-sha2-256',
  'rsa-sha2-512',
  'ecdsa-sha2-nistp256',
  'ecdsa-sha2-nistp384',
  'ecdsa-sha2-nistp521',
] as const;

// Domain separation for the code-derived key: a different protocol version must not be able to
// reuse a live code, and 'req|'/'res|' below stop a request MAC from being replayed as a response.
const PAIR_KEY_DOMAIN = 'sukarfleet-pair-v1|';

// Crockford base32: no I, L, O or U, so the alphabet has no character pair a human can confuse on
// a screen or a phone photo. 8 characters x 5 bits = exactly 40 bits, no padding, no truncation.
const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const CODE_LEN = 8;

const BAD_REQUEST_BODY = JSON.stringify({ error: 'bad request' });
const UNAUTHORIZED_BODY = JSON.stringify({ error: 'unauthorized' });

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

// One body for every shape/validation failure, so a prober cannot map the validator by diffing
// error strings. The specific reason is logged locally instead.
function badRequestResponse(): Response {
  return new Response(BAD_REQUEST_BODY, { status: 400, headers: { 'content-type': 'application/json' } });
}

// ---------------------------------------------------------------------------
// Code minting, formatting, and the MAC key derived from it.
// ---------------------------------------------------------------------------

// 40 bits from the caller-supplied RNG (crypto.getRandomValues by default), big-endian into 8
// Crockford digits. 2^40 - 1 is well inside the exact-integer range, so plain integer math is safe.
export function generateCode(rand?: (n: number) => Uint8Array): string {
  const bytes = rand ? rand(5) : crypto.getRandomValues(new Uint8Array(5));
  if (bytes.length < 5) throw new Error('pairing: rand() returned fewer than 5 bytes');
  let v = 0;
  for (let i = 0; i < 5; i++) v = v * 256 + bytes[i]!;
  let out = '';
  for (let i = CODE_LEN - 1; i >= 0; i--) {
    out += CROCKFORD[Math.floor(v / 32 ** i) % 32];
  }
  return out;
}

// Display form only. Never fed back into deriveCodeKey without normalizeCode first.
export function formatCode(code: string): string {
  return code.length === CODE_LEN ? `${code.slice(0, 4)}-${code.slice(4)}` : code;
}

// Accepts what a human actually types: any spacing, any dashes, any case. O/I/L are folded to the
// digits they are mistaken for -- none of the three is in the encode alphabet, so the fold can
// never collide with a legitimately generated character.
export function normalizeCode(input: string): string {
  return input
    .replace(/[\s-]/g, '')
    .toUpperCase()
    .replace(/O/g, '0')
    .replace(/[IL]/g, '1');
}

function isWellFormedCode(code: string): boolean {
  if (code.length !== CODE_LEN) return false;
  for (const ch of code) {
    if (!CROCKFORD.includes(ch)) return false;
  }
  return true;
}

export async function deriveCodeKey(code: string): Promise<CryptoKey> {
  const material = createHash('sha256').update(PAIR_KEY_DOMAIN + code).digest();
  return crypto.subtle.importKey(
    'raw',
    new Uint8Array(material) as BufferSource,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
}

async function mac(key: CryptoKey, prefix: string, payload: unknown): Promise<string> {
  const data = new TextEncoder().encode(prefix + canonicalJson(payload));
  const sig = await crypto.subtle.sign('HMAC', key, data as BufferSource);
  return b64encode(new Uint8Array(sig));
}

export async function macRequest(key: CryptoKey, payload: unknown): Promise<string> {
  return mac(key, 'req|', payload);
}

export async function macResponse(key: CryptoKey, payload: unknown): Promise<string> {
  return mac(key, 'res|', payload);
}

// Length is not secret (every MAC here is a fixed-width base64 SHA-256 digest); what must not
// short-circuit is the byte comparison, which is why it goes through timingSafeEqual.
export function constantTimeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a, 'utf8');
  const bb = Buffer.from(b, 'utf8');
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

function sha256B64(s: string): string {
  return createHash('sha256').update(s).digest('base64');
}

// ---------------------------------------------------------------------------
// Bundle validation. Everything below rebuilds the peer's fields from validated components rather
// than passing the peer's strings through: what reaches applyPeer is constructed here, so a field
// this validator does not understand cannot survive into authorized_keys, known_hosts, config.json
// or an ssh argv.
// ---------------------------------------------------------------------------

const B64URL_RE = /^[A-Za-z0-9_-]+$/;
const B64_RE = /^[A-Za-z0-9+/]+={0,2}$/;
const MACHINE_NAME_RE = /^[A-Za-z0-9._-]+$/;
// Must match the POSIX-ish account names sshd will accept, and must not be able to start with '-'
// (it lands in `ssh -l <user>`, where a leading dash would be parsed as an option).
const SSH_USER_RE = /^[a-z_][a-z0-9_-]{0,31}$/;
const SSH_COMMENT_RE = /^[A-Za-z0-9._@+-]{1,128}$/;

function isIpv4(s: string): boolean {
  const parts = s.split('.');
  if (parts.length !== 4) return false;
  return parts.every((p) => /^(0|[1-9][0-9]{0,2})$/.test(p) && Number(p) <= 255);
}

// Reads one SSH wire string (4-byte big-endian length + bytes) at `off`; null if it does not fit.
function readSshString(blob: Uint8Array, off: number): { bytes: Uint8Array; next: number } | null {
  if (off + 4 > blob.length) return null;
  const len = (blob[off]! << 24) | (blob[off + 1]! << 16) | (blob[off + 2]! << 8) | blob[off + 3]!;
  if (len < 0 || off + 4 + len > blob.length) return null;
  return { bytes: blob.subarray(off + 4, off + 4 + len), next: off + 4 + len };
}

// THE dangerous input of this module. An authorized_keys line is `[options] <type> <b64> [comment]`,
// so a peer that gets its own text into the options position -- or gets a newline through and starts
// a whole second line -- writes its own grant. Three defences, in order:
//   1. Any \n, \r, NUL or tab rejects the line outright (no escaping, no quoting: rejection).
//   2. The line must BEGIN with an accepted key type, which is exactly what an option prefix cannot
//      do; a bundle carrying `restrict,command="..." ssh-ed25519 AAAA...` dies here.
//   3. The returned line is REBUILT from the decoded blob, so base64 malleability and any comment we
//      do not recognise are dropped rather than forwarded.
function parseSshPublicKey(
  line: unknown,
  allowedTypes: readonly string[],
  maxBytes: number,
): { canonical: string; blob: Uint8Array; type: string } | null {
  if (typeof line !== 'string') return null;
  if (line.length === 0 || line.length > maxBytes) return null;
  if (/[\n\r\0\t]/.test(line)) return null;
  if (line !== line.trim()) return null;

  const sp1 = line.indexOf(' ');
  if (sp1 <= 0) return null;
  const type = line.slice(0, sp1);
  if (!allowedTypes.includes(type)) return null;

  const rest = line.slice(sp1 + 1);
  const sp2 = rest.indexOf(' ');
  const b64 = sp2 === -1 ? rest : rest.slice(0, sp2);
  const rawComment = sp2 === -1 ? '' : rest.slice(sp2 + 1);
  if (b64.length === 0 || !B64_RE.test(b64)) return null;

  const blob = b64decode(b64);
  const declared = readSshString(blob, 0);
  if (!declared) return null;
  // The type is asserted twice on the wire (plaintext prefix and inside the blob); sshd trusts the
  // blob, so a disagreement between the two is a malformed key, not a cosmetic mismatch.
  if (new TextDecoder().decode(declared.bytes) !== type) return null;

  if (type === 'ssh-ed25519') {
    const pub = readSshString(blob, declared.next);
    if (!pub || pub.bytes.length !== 32 || pub.next !== blob.length) return null;
  }

  // A comment we cannot vouch for is dropped, not rejected: it is cosmetic, and failing an
  // otherwise-valid pairing over a stray character in a key comment is a foot-gun, not a defence.
  const comment = SSH_COMMENT_RE.test(rawComment) ? rawComment : '';
  const canonical = `${type} ${b64encode(blob)}${comment ? ` ${comment}` : ''}`;
  return { canonical, blob, type };
}

// OpenSSH's SHA256 fingerprint: base64 of the sha256 over the raw key blob, unpadded.
function sshKeyFingerprint(blob: Uint8Array): string {
  return `SHA256:${createHash('sha256').update(blob).digest('base64').replace(/=+$/, '')}`;
}

// Rebuilt to exactly {kty,crv,x,y}: `key_ops`/`ext` from a foreign WebCrypto export can make our own
// importKey refuse the key later, and a `d` member would be private key material we must never
// store. Both classes of member are dropped by construction rather than checked for.
function sanitizePublicJwk(v: unknown): JsonWebKey | null {
  if (typeof v !== 'object' || v === null) return null;
  const j = v as Record<string, unknown>;
  if (j.kty !== 'EC' || j.crv !== 'P-256') return null;
  if (typeof j.x !== 'string' || typeof j.y !== 'string') return null;
  if (!B64URL_RE.test(j.x) || !B64URL_RE.test(j.y)) return null;
  if (j.d !== undefined) return null;
  return { kty: 'EC', crv: 'P-256', x: j.x, y: j.y };
}

interface SanitizedBundle {
  bundle: PairBundle;
  sshKeyFingerprint: string;
}

// Returns null for every failure, with no indication of which one: the caller turns null into the
// single uniform 400/'bad-response', so the validator cannot be mapped field by field.
function sanitizeBundle(v: unknown, selfMachine: string): SanitizedBundle | null {
  if (typeof v !== 'object' || v === null) return null;
  const b = v as Record<string, unknown>;
  if (b.v !== 1) return null;

  // The machine name becomes a config peer name AND the `# sukarfleet:<machine>` marker that
  // sshadmin.ts replaces authorized_keys lines by, so anything outside this charset could either
  // forge another peer's marker or terminate the line.
  if (typeof b.machine !== 'string' || b.machine.length === 0 || b.machine.length > MAX_MACHINE_NAME_LEN) return null;
  if (!MACHINE_NAME_RE.test(b.machine)) return null;
  // A bundle claiming to be us would overwrite our own identity in config.peers.
  if (b.machine === selfMachine) return null;

  if (b.role !== 'anchor' && b.role !== 'roamer') return null;

  // meshIp lands inside the quoted from="..." of an authorized_keys option prefix and inside an ssh
  // destination argv. Strict dotted-quad only -- the mesh addresses are IPv4, and accepting
  // anything looser here is accepting a quote or a comma into that option list.
  if (typeof b.meshIp !== 'string' || !isIpv4(b.meshIp)) return null;

  if (typeof b.nodePort !== 'number' || !Number.isInteger(b.nodePort) || b.nodePort < 1 || b.nodePort > 65535) {
    return null;
  }

  const publicKeyJwk = sanitizePublicJwk(b.publicKeyJwk);
  if (!publicKeyJwk) return null;

  if (typeof b.sshUser !== 'string' || !SSH_USER_RE.test(b.sshUser)) return null;

  const clientKey = parseSshPublicKey(b.sshPublicKey, SSH_CLIENT_KEY_TYPES, MAX_SSH_KEY_BYTES);
  if (!clientKey) return null;

  if (!Array.isArray(b.sshHostKeys) || b.sshHostKeys.length === 0 || b.sshHostKeys.length > MAX_SSH_HOST_KEYS) {
    return null;
  }
  const sshHostKeys: string[] = [];
  for (const hk of b.sshHostKeys) {
    const parsed = parseSshPublicKey(hk, SSH_HOST_KEY_TYPES, MAX_SSH_HOST_KEY_BYTES);
    if (!parsed) return null;
    sshHostKeys.push(parsed.canonical);
  }

  return {
    bundle: {
      v: 1,
      machine: b.machine,
      role: b.role,
      meshIp: b.meshIp,
      nodePort: b.nodePort,
      publicKeyJwk,
      sshUser: b.sshUser,
      sshPublicKey: clientKey.canonical,
      sshHostKeys,
    },
    sshKeyFingerprint: sshKeyFingerprint(clientKey.blob),
  };
}

interface HelloPayload {
  v: 1;
  from: unknown;
  tsMs: number;
}

function parseHelloRequest(v: unknown): { payload: HelloPayload; mac: string } | null {
  if (typeof v !== 'object' || v === null) return null;
  const r = v as Record<string, unknown>;
  if (typeof r.mac !== 'string' || r.mac.length === 0 || r.mac.length > 128) return null;
  if (typeof r.payload !== 'object' || r.payload === null) return null;
  const p = r.payload as Record<string, unknown>;
  if (p.v !== 1) return null;
  if (typeof p.tsMs !== 'number' || !Number.isFinite(p.tsMs)) return null;
  if (typeof p.from !== 'object' || p.from === null) return null;
  // `from` is carried through as the parsed object (the MAC covers canonicalJson of it verbatim,
  // and sanitizeBundle rebuilds it later). Any UNKNOWN top-level payload member is dropped here,
  // which makes the recomputed MAC disagree -- fail closed, by construction rather than by check.
  return { payload: { v: 1, from: p.from, tsMs: p.tsMs }, mac: r.mac };
}

function parseHelloResponse(v: unknown): { payload: HelloPayload & { reqSha256: string }; mac: string } | null {
  const base = parseHelloRequest(v);
  if (!base) return null;
  const p = (v as Record<string, unknown>).payload as Record<string, unknown>;
  if (typeof p.reqSha256 !== 'string' || p.reqSha256.length === 0 || p.reqSha256.length > 128) return null;
  return { payload: { ...base.payload, reqSha256: p.reqSha256 }, mac: base.mac };
}

// ---------------------------------------------------------------------------
// The pairing state machine.
// ---------------------------------------------------------------------------

export interface PairingDeps {
  cfg: FleetConfig;
  auditAppend: (kind: string, detail: Record<string, unknown>) => Promise<AuditEntry>;
  localBundle: () => Promise<PairBundle>;
  // Installs the peer: config.peers entry, authorized_keys line (option prefix built locally),
  // pinned host keys, git remotes. Supplied by node.ts (L6); pairing.ts never touches those files.
  applyPeer: (peer: PairBundle) => Promise<void>;
  now?: () => number;
  rand?: (n: number) => Uint8Array;
}

interface ActiveCode {
  code: string;
  display: string;
  expiresMs: number;
  attemptsLeft: number;
}

export type RedeemReason = 'bad-code' | 'unreachable' | 'bad-response' | 'half-paired';

export class Pairing {
  private readonly cfg: FleetConfig;
  private readonly deps: PairingDeps;
  private readonly now: () => number;
  private readonly rand: (n: number) => Uint8Array;
  private active: ActiveCode | null = null;
  private pairedWith: string | null = null;

  constructor(deps: PairingDeps) {
    this.cfg = deps.cfg;
    this.deps = deps;
    this.now = deps.now ?? nowMs;
    this.rand = deps.rand ?? ((n: number) => crypto.getRandomValues(new Uint8Array(n)));
  }

  // At most one code is live at a time: minting a second one invalidates the first, so an operator
  // who clicks twice cannot leave a forgotten code accepting connections for five minutes.
  mintCode(): { display: string; expiresMs: number } {
    const code = generateCode(this.rand);
    const expiresMs = this.now() + PAIR_CODE_TTL_MS;
    this.active = { code, display: formatCode(code), expiresMs, attemptsLeft: PAIR_CODE_MAX_ATTEMPTS };
    log('info', 'pairing: code minted', { expiresMs });
    return { display: this.active.display, expiresMs };
  }

  cancelCode(): void {
    if (this.active) log('info', 'pairing: code cancelled');
    this.active = null;
  }

  codeState(): { active: boolean; display?: string; expiresMs?: number; attemptsLeft?: number; pairedWith?: string } {
    const live = this.liveCode();
    const paired = this.pairedWith ?? undefined;
    if (!live) return { active: false, ...(paired ? { pairedWith: paired } : {}) };
    return {
      active: true,
      display: live.display,
      expiresMs: live.expiresMs,
      attemptsLeft: live.attemptsLeft,
      ...(paired ? { pairedWith: paired } : {}),
    };
  }

  // Expiry is evaluated on read rather than on a timer: a daemon that was asleep past the TTL must
  // not wake up with a live code, and there is no timer to leak.
  private liveCode(): ActiveCode | null {
    if (!this.active) return null;
    if (this.now() > this.active.expiresMs) {
      this.active = null;
      return null;
    }
    return this.active;
  }

  private fresh(tsMs: number): boolean {
    return Math.abs(this.now() - tsMs) <= PAIR_FRESHNESS_WINDOW_MS;
  }

  private async unauthorized(startMs: number): Promise<Response> {
    const remaining = PAIR_AUTH_FAILURE_MIN_MS - (this.now() - startMs);
    if (remaining > 0) await sleep(remaining);
    return new Response(UNAUTHORIZED_BODY, { status: 401, headers: { 'content-type': 'application/json' } });
  }

  // POST /pair/hello. The ONLY unauthenticated mutating route on this daemon, and reachable from the
  // mesh rather than loopback -- everything it accepts is treated accordingly.
  async handleHello(req: Request): Promise<Response> {
    const startMs = this.now();

    const body = await readCappedBody(req, PAIR_MAX_BODY_BYTES, PAIR_BODY_READ_TIMEOUT_MS);
    if (!body.ok) {
      return body.reason === 'too-large'
        ? new Response(BAD_REQUEST_BODY, { status: 413, headers: { 'content-type': 'application/json' } })
        : badRequestResponse();
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(new TextDecoder().decode(body.bytes));
    } catch {
      return badRequestResponse();
    }

    const hello = parseHelloRequest(parsed);
    if (!hello) {
      log('warn', 'pairing: hello rejected, malformed envelope');
      return badRequestResponse();
    }

    const peer = sanitizeBundle(hello.payload.from, this.cfg.machine);
    if (!peer) {
      log('warn', 'pairing: hello rejected, bundle failed validation');
      return badRequestResponse();
    }

    // From here down every rejection is the same 401 with the same timing floor: a caller must not
    // be able to tell "no code minted" from "wrong code" from "expired" from "already burned".
    if (!this.fresh(hello.payload.tsMs)) return this.unauthorized(startMs);

    const live = this.liveCode();
    if (!live) return this.unauthorized(startMs);

    const key = await deriveCodeKey(live.code);
    const expected = await macRequest(key, hello.payload);
    const ok = constantTimeEqual(expected, hello.mac);

    // Re-check identity AND liveness after the awaits above: a concurrent hello could have burned
    // or replaced this code while the HMAC was being computed, and a burned code must stay burned.
    if (this.active !== live) return this.unauthorized(startMs);
    if (this.now() > live.expiresMs) {
      this.active = null;
      return this.unauthorized(startMs);
    }

    if (!ok) {
      live.attemptsLeft -= 1;
      if (live.attemptsLeft <= 0) {
        this.active = null;
        log('warn', 'pairing: code burned after exhausting attempts');
      } else {
        log('warn', 'pairing: hello rejected, mac mismatch', { attemptsLeft: live.attemptsLeft });
      }
      return this.unauthorized(startMs);
    }

    // One-shot: burned synchronously, before any further await, so nothing can redeem it twice.
    this.active = null;

    let selfBundle: PairBundle;
    try {
      selfBundle = await this.deps.localBundle();
    } catch (err) {
      log('error', 'pairing: cannot assemble local bundle', { error: String(err) });
      return jsonResponse({ error: 'internal error' }, 500);
    }
    // Our own bundle goes through the same validator: a malformed local SSH identity must fail here
    // rather than be shipped to a peer that will write it into its own authorized_keys.
    if (!sanitizeBundle(selfBundle, peer.bundle.machine)) {
      log('error', 'pairing: local bundle failed its own validation, refusing to pair');
      return jsonResponse({ error: 'internal error' }, 500);
    }

    try {
      await this.deps.applyPeer(peer.bundle);
    } catch (err) {
      log('error', 'pairing: applyPeer failed, peer not installed', {
        peerMachine: peer.bundle.machine,
        error: String(err),
      });
      return jsonResponse({ error: 'internal error' }, 500);
    }

    const payload = {
      v: 1 as const,
      from: selfBundle,
      tsMs: this.now(),
      reqSha256: sha256B64(canonicalJson(hello.payload)),
    };
    const response: PairHelloResponse = { payload, mac: await macResponse(key, payload) };

    this.pairedWith = peer.bundle.machine;
    await this.recordPair(peer.bundle.machine, peer.sshKeyFingerprint, 'responder');
    return jsonResponse(response, 200);
  }

  // Initiator side: the operator typed the peer's code here. `host`/`port` come from the GUI, not
  // from any peer-supplied field.
  async redeem(input: { code: string; host: string; port: number }): Promise<{
    ok: boolean;
    peer?: string;
    reason?: RedeemReason;
    message?: string;
  }> {
    const code = normalizeCode(input.code ?? '');
    if (!isWellFormedCode(code)) return { ok: false, reason: 'bad-code', message: 'That code is not valid.' };

    const url = helloUrl(input.host, input.port);
    if (!url) return { ok: false, reason: 'unreachable', message: 'That address is not valid.' };

    let selfBundle: PairBundle;
    try {
      selfBundle = await this.deps.localBundle();
    } catch (err) {
      log('error', 'pairing: cannot assemble local bundle', { error: String(err) });
      return { ok: false, reason: 'bad-response', message: 'This machine has no usable SSH identity yet.' };
    }
    if (!sanitizeBundle(selfBundle, '')) {
      log('error', 'pairing: local bundle failed its own validation, refusing to pair');
      return { ok: false, reason: 'bad-response', message: 'This machine has no usable SSH identity yet.' };
    }

    const key = await deriveCodeKey(code);
    const payload = { v: 1 as const, from: selfBundle, tsMs: this.now() };
    const reqBody = canonicalJson({ payload, mac: await macRequest(key, payload) });

    let res: Response;
    try {
      res = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: reqBody,
        signal: AbortSignal.timeout(REDEEM_TIMEOUT_MS),
      });
    } catch (err) {
      log('warn', 'pairing: redeem could not reach peer', { host: input.host, error: String(err) });
      return { ok: false, reason: 'unreachable', message: 'Could not reach that machine on the mesh.' };
    }

    if (res.status === 401) {
      return { ok: false, reason: 'bad-code', message: 'That code is wrong, expired, or already used.' };
    }
    if (!res.ok) {
      log('warn', 'pairing: redeem got a non-OK response', { status: res.status });
      return { ok: false, reason: 'bad-response', message: 'The other machine refused the pairing request.' };
    }

    let parsed: unknown;
    try {
      parsed = await res.json();
    } catch {
      return { ok: false, reason: 'bad-response', message: 'The other machine sent an unreadable reply.' };
    }

    const hello = parseHelloResponse(parsed);
    if (!hello) return { ok: false, reason: 'bad-response', message: 'The other machine sent an unreadable reply.' };
    if (!this.fresh(hello.payload.tsMs)) {
      return { ok: false, reason: 'bad-response', message: 'The other machine sent a stale reply.' };
    }
    // Transcript binding: without this check a MITM could pair us against a response captured from a
    // different exchange under the same code.
    if (!constantTimeEqual(sha256B64(canonicalJson(payload)), hello.payload.reqSha256)) {
      return { ok: false, reason: 'bad-response', message: 'The reply did not match this request.' };
    }
    const expected = await macResponse(key, hello.payload);
    if (!constantTimeEqual(expected, hello.mac)) {
      return { ok: false, reason: 'bad-response', message: 'The reply did not match this request.' };
    }

    const peer = sanitizeBundle(hello.payload.from, this.cfg.machine);
    if (!peer) {
      log('warn', 'pairing: redeem rejected, peer bundle failed validation');
      return { ok: false, reason: 'bad-response', message: 'The other machine sent an unusable identity.' };
    }

    try {
      await this.deps.applyPeer(peer.bundle);
    } catch (err) {
      // The responder already installed us and burned the code; only this side failed. Naming that
      // state is the point of 'half-paired' -- the operator must re-mint, not retry with the same code.
      log('error', 'pairing: applyPeer failed after a verified exchange', {
        peerMachine: peer.bundle.machine,
        error: String(err),
      });
      return {
        ok: false,
        reason: 'half-paired',
        message: 'The other machine accepted the pairing but this one could not finish it. Start over with a new code.',
      };
    }

    this.pairedWith = peer.bundle.machine;
    await this.recordPair(peer.bundle.machine, peer.sshKeyFingerprint, 'initiator');
    return { ok: true, peer: peer.bundle.machine };
  }

  // Audit is the record, not the gate: the peer is already installed by the time this runs, so a
  // failing audit append degrades to a warning rather than unwinding a successful pairing.
  private async recordPair(peerMachine: string, fingerprint: string, mode: 'initiator' | 'responder'): Promise<void> {
    try {
      await this.deps.auditAppend(AUDIT_KIND_PAIR_ACCEPTED, {
        peerMachine,
        sshKeyFingerprint: fingerprint,
        mode,
      });
    } catch (err) {
      log('warn', 'pairing: could not append pair-accepted audit entry', { peerMachine, error: String(err) });
    }
  }
}

// Built from the GUI-supplied host/port only. Rejects anything that is not a bare IPv4 address or a
// plain hostname, so no credentials, path or query can be smuggled through the address field.
function helloUrl(host: string, port: number): string | null {
  if (typeof host !== 'string' || host.length === 0 || host.length > 253) return null;
  if (!isIpv4(host) && !/^[A-Za-z0-9]([A-Za-z0-9.-]*[A-Za-z0-9])?$/.test(host)) return null;
  if (!Number.isInteger(port) || port < 1 || port > 65535) return null;
  try {
    return new URL(`http://${host}:${port}/pair/hello`).toString();
  } catch {
    return null;
  }
}
