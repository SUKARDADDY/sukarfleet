// SPDX-License-Identifier: AGPL-3.0-or-later
// Enrollment tokens: the credential a console-generated installer carries so a fresh machine can
// pair with nobody standing at it. Owns src/enroll.ts only.
//
// This is the SECOND credential /pair/hello accepts. The first is the twelve-character code a human
// reads off one screen and types into another (src/pairing.ts). The two differ in exactly one way
// that matters, and every other difference below follows from it:
//
//   THE TYPED CODE IS TYPED. It is 60 bits because that is the ceiling on what a person will copy
//   across a room, and it hides behind a 32 MiB scrypt because a captured /pair/hello is a complete
//   offline oracle against a code that small.
//
//   AN ENROLLMENT TOKEN IS NEVER TYPED. It is generated, written into a file, and read back by an
//   installer. So it is 256 bits, and at 256 bits a memory-hard KDF buys nothing: sweeping the
//   space is not slow, it is impossible. A plain SHA-256 derivation is the honest choice, and it
//   also keeps the one mesh-reachable route on this daemon from becoming a 32 MiB-per-request CPU
//   sink -- which the typed-code path avoids only by deriving at mint, a trick a token that must
//   survive a daemon restart cannot use.
//
// WHAT A TOKEN BUYS, HONESTLY:
//   - One machine, once. It is bound at mint to a machine name and the mesh address allocated for
//     it, single use, and it expires 24 hours later whether or not anyone redeems it.
//   - It authenticates the bootstrap and nothing after it. Once the peer is installed, what
//     constrains it is the authorized_keys option prefix the RECEIVING side builds from its own
//     config -- the same rule that governs a typed-code pairing, and for the same reason.
//
// WHAT IT DOES NOT BUY, AND WHAT THE OPERATOR MUST BE TOLD:
//   - The installer file that carries a token ALSO carries the fleet's mesh secret, because a
//     machine cannot join a coordinator-less overlay without it. That file is a bearer credential.
//     Anyone holding it can join the mesh network until the token expires, whether or not they ever
//     redeem it. Revoking the token closes pairing; it does NOT rotate the mesh secret.
//   - There is no attempt counter here, and its absence is deliberate rather than an oversight. The
//     typed code burns after five bad MACs because five guesses against 2^60 is a number worth
//     bounding. Against 2^256 an attempt budget bounds nothing, and a counter that can only ever be
//     tripped by a broken installer is a way to lock an operator out of their own enrollment.
//
// AT REST: the derived HMAC key is stored, never the token. The responder needs the key to verify a
// MAC, so something secret has to live on disk; storing the derivation rather than its input means
// a leaked state file cannot be turned back into the token string the installer file quotes.

import { createHash, timingSafeEqual } from 'node:crypto';
import { join } from 'node:path';
import { stateDir } from './config';
import { writeSecretFile } from './keys';
import { b64encode, log, nowMs, readJsonFile } from './util';

// ---------------------------------------------------------------------------
// Tunables. Local constants, matching pairing.ts's reasoning: a config-tunable TTL is a knob whose
// only use is loosening it.
// ---------------------------------------------------------------------------

export const ENROLL_TTL_MS = 24 * 60 * 60 * 1000; // 24 h -- long enough to walk a file to a machine.
const ENROLL_TOKEN_BYTES = 32; // 256 bits. Never typed, so entropy is free.
const ENROLL_ID_BYTES = 8;
const ENROLL_KEY_DOMAIN = 'sukarfleet-enroll-v1|';
const MAX_LIVE_ENROLLMENTS = 32;

// Expired records are kept this long past expiry so the console can still show "expired" rather
// than silently forgetting an installer the operator is holding in their hand.
const ENROLL_TOMBSTONE_MS = 7 * 24 * 60 * 60 * 1000;

export const ENROLL_ID_RE = /^[0-9a-f]{16}$/;
export const ENROLL_TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;

export type EnrollPlatform = 'windows';

export type EnrollState = 'live' | 'used' | 'revoked' | 'expired';

// The public half. Nothing secret is in here, which is what makes it safe to hand to the console.
export interface EnrollmentView {
  id: string;
  machine: string;
  meshIp: string;
  nodePort: number;
  role: 'anchor' | 'roamer';
  platform: EnrollPlatform;
  state: EnrollState;
  createdMs: number;
  expiresMs: number;
  usedMs: number | null;
  usedBy: string | null;
  revokedMs: number | null;
  installerPath: string;
}

// The stored half. `keyB64` is the secret and the only one.
interface EnrollmentRecord extends Omit<EnrollmentView, 'state'> {
  keyB64: string;
}

interface EnrollStore {
  v: 1;
  enrollments: EnrollmentRecord[];
}

// What handleHello gets back from a lookup: the key to check the MAC with, and the two fields the
// presented bundle has to agree with.
export interface EnrollmentGrant {
  id: string;
  key: CryptoKey;
  machine: string;
  meshIp: string;
}

// The slice of this service src/pairing.ts depends on. Narrow on purpose: pairing.ts must not be
// able to mint, list or revoke, only to check one token and burn it.
export interface EnrollmentPort {
  lookup(id: string): Promise<EnrollmentGrant | null>;
  // Compare-and-set. Returns false when the record was already used, revoked or expired between
  // the lookup and here, which is what makes two simultaneous redeems of one token resolve to one
  // success and one identical 401.
  burn(id: string, peerMachine: string): Promise<boolean>;
}

// ---------------------------------------------------------------------------
// Token and key material
// ---------------------------------------------------------------------------

function b64url(bytes: Uint8Array): string {
  return b64encode(bytes).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function b64urlDecode(s: string): Uint8Array {
  const padded = s.replace(/-/g, '+').replace(/_/g, '/');
  return new Uint8Array(Buffer.from(padded, 'base64'));
}

// SHA-256 over the domain constant and the token bytes. Domain-separated from the pairing code's
// scrypt so a v1 enrollment token and a v2 pairing code provably derive different keys even in the
// impossible case that one is a prefix of the other: a machine on one scheme and a machine on the
// other fail to pair rather than half-agreeing on a weaker key.
export function deriveEnrollKeyBytes(token: string): Uint8Array {
  const h = createHash('sha256');
  h.update(ENROLL_KEY_DOMAIN);
  h.update(b64urlDecode(token));
  return new Uint8Array(h.digest());
}

export async function importEnrollKey(keyBytes: Uint8Array): Promise<CryptoKey> {
  return crypto.subtle.importKey('raw', keyBytes as BufferSource, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
}

// The initiator's side: the installer holds the token, and derives the same key the responder
// stored at mint. Cheap by design; see the header.
export async function deriveEnrollKey(token: string): Promise<CryptoKey> {
  return importEnrollKey(deriveEnrollKeyBytes(token));
}

function constantTimeEqualB64(a: string, b: string): boolean {
  const ab = Buffer.from(a, 'utf8');
  const bb = Buffer.from(b, 'utf8');
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

// ---------------------------------------------------------------------------
// The service
// ---------------------------------------------------------------------------

export interface EnrollmentsDeps {
  auditAppend: (kind: string, detail: Record<string, unknown>) => Promise<unknown>;
  path?: string;
  now?: () => number;
  rand?: (n: number) => Uint8Array;
}

export const AUDIT_KIND_ENROLL_MINTED = 'enroll-minted';
export const AUDIT_KIND_ENROLL_REDEEMED = 'enroll-redeemed';
export const AUDIT_KIND_ENROLL_REVOKED = 'enroll-revoked';

export class Enrollments implements EnrollmentPort {
  private readonly deps: EnrollmentsDeps;
  private readonly path: string;
  private readonly now: () => number;
  private readonly rand: (n: number) => Uint8Array;
  private records: EnrollmentRecord[] | null = null;
  // Every mutation serialises through this. Two console calls and a hello can all land in one tick,
  // and the file is read-modify-written: without the chain the last writer silently wins and a
  // burned token comes back to life.
  private chain: Promise<unknown> = Promise.resolve();

  constructor(deps: EnrollmentsDeps) {
    this.deps = deps;
    this.path = deps.path ?? join(stateDir(), 'enrollments.json');
    this.now = deps.now ?? nowMs;
    this.rand = deps.rand ?? ((n: number) => crypto.getRandomValues(new Uint8Array(n)));
  }

  private async load(): Promise<EnrollmentRecord[]> {
    if (this.records) return this.records;
    const raw = await readJsonFile<EnrollStore>(this.path).catch(() => null);
    this.records = Array.isArray(raw?.enrollments) ? raw.enrollments.filter(isRecord) : [];
    return this.records;
  }

  // Tombstones outlive expiry so the console can say "expired" instead of losing the row; anything
  // older than that is genuinely gone.
  private prune(records: EnrollmentRecord[]): EnrollmentRecord[] {
    const cutoff = this.now() - ENROLL_TOMBSTONE_MS;
    return records.filter((r) => r.expiresMs > cutoff);
  }

  private async persist(records: EnrollmentRecord[]): Promise<void> {
    this.records = this.prune(records);
    const store: EnrollStore = { v: 1, enrollments: this.records };
    // 0600 through the same helper the machine key and the mesh secret use: this file holds live
    // HMAC keys, and it is exactly as sensitive as they are.
    await writeSecretFile(this.path, JSON.stringify(store, null, 2) + '\n');
  }

  // Serialises a read-modify-write against the store. Failures do not poison the chain.
  private serialise<T>(work: () => Promise<T>): Promise<T> {
    const next = this.chain.then(work, work);
    this.chain = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }

  private stateOf(r: EnrollmentRecord): EnrollState {
    if (r.revokedMs !== null) return 'revoked';
    if (r.usedMs !== null) return 'used';
    if (this.now() > r.expiresMs) return 'expired';
    return 'live';
  }

  private view(r: EnrollmentRecord): EnrollmentView {
    const { keyB64: _keyB64, ...rest } = r;
    return { ...rest, state: this.stateOf(r) };
  }

  async list(): Promise<EnrollmentView[]> {
    const records = await this.load();
    return records.map((r) => this.view(r)).sort((a, b) => b.createdMs - a.createdMs);
  }

  // The token is returned ONCE, here, and never again: it is not stored, and no route can read it
  // back. An operator who loses the generated file mints a new one.
  async mint(input: {
    machine: string;
    meshIp: string;
    nodePort: number;
    role: 'anchor' | 'roamer';
    platform: EnrollPlatform;
    installerPath: string;
  }): Promise<{ view: EnrollmentView; token: string } | { error: string }> {
    return this.serialise(async () => {
      const records = await this.load();
      const live = records.filter((r) => this.stateOf(r) === 'live');
      if (live.length >= MAX_LIVE_ENROLLMENTS) {
        return { error: `there are already ${MAX_LIVE_ENROLLMENTS} live enrollments; revoke one first` };
      }
      // One live enrollment per machine name. A second installer for a name that already has one is
      // almost always a forgotten first attempt, and two live tokens for one box is two bearer
      // credentials to keep track of instead of one.
      const clash = live.find((r) => r.machine === input.machine);
      if (clash) {
        return { error: `there is already a live installer for ${input.machine}; revoke it first` };
      }

      const token = b64url(this.rand(ENROLL_TOKEN_BYTES));
      const id = Buffer.from(this.rand(ENROLL_ID_BYTES)).toString('hex');
      const createdMs = this.now();
      const record: EnrollmentRecord = {
        id,
        machine: input.machine,
        meshIp: input.meshIp,
        nodePort: input.nodePort,
        role: input.role,
        platform: input.platform,
        createdMs,
        expiresMs: createdMs + ENROLL_TTL_MS,
        usedMs: null,
        usedBy: null,
        revokedMs: null,
        installerPath: input.installerPath,
        keyB64: b64encode(deriveEnrollKeyBytes(token)),
      };

      await this.persist([...records, record]);
      log('info', 'enroll: token minted', { id, machine: input.machine, expiresMs: record.expiresMs });
      await this.audit(AUDIT_KIND_ENROLL_MINTED, {
        enrollId: id,
        machine: input.machine,
        meshIp: input.meshIp,
        expiresMs: record.expiresMs,
      });
      return { view: this.view(record), token };
    });
  }

  async revoke(id: string): Promise<boolean> {
    return this.serialise(async () => {
      const records = await this.load();
      const found = records.find((r) => r.id === id);
      if (!found || found.revokedMs !== null || found.usedMs !== null) return false;
      found.revokedMs = this.now();
      await this.persist(records);
      log('info', 'enroll: token revoked', { id, machine: found.machine });
      await this.audit(AUDIT_KIND_ENROLL_REVOKED, { enrollId: id, machine: found.machine });
      return true;
    });
  }

  // ---- EnrollmentPort ------------------------------------------------------

  async lookup(id: string): Promise<EnrollmentGrant | null> {
    if (!ENROLL_ID_RE.test(id)) return null;
    const records = await this.load();
    // Constant-time on the id comparison is pointless -- the id is public, it travels in the clear
    // in the hello payload -- so this is a plain find.
    const found = records.find((r) => r.id === id);
    if (!found || this.stateOf(found) !== 'live') return null;
    let key: CryptoKey;
    try {
      key = await importEnrollKey(new Uint8Array(Buffer.from(found.keyB64, 'base64')));
    } catch (err) {
      log('error', 'enroll: stored key is unusable', { id, error: String(err) });
      return null;
    }
    return { id: found.id, key, machine: found.machine, meshIp: found.meshIp };
  }

  async burn(id: string, peerMachine: string): Promise<boolean> {
    return this.serialise(async () => {
      const records = await this.load();
      const found = records.find((r) => r.id === id);
      // Re-checked inside the serialised section, not trusted from the caller's earlier lookup:
      // that gap is exactly where a second simultaneous redeem lives.
      if (!found || this.stateOf(found) !== 'live') return false;
      found.usedMs = this.now();
      found.usedBy = peerMachine;
      await this.persist(records);
      log('info', 'enroll: token redeemed', { id, machine: found.machine, peerMachine });
      await this.audit(AUDIT_KIND_ENROLL_REDEEMED, { enrollId: id, machine: found.machine, peerMachine });
      return true;
    });
  }

  // Audit is the record, not the gate: a failing append never unwinds a mint or a burn, exactly as
  // pairing.ts treats pair-accepted.
  private async audit(kind: string, detail: Record<string, unknown>): Promise<void> {
    try {
      await this.deps.auditAppend(kind, detail);
    } catch (err) {
      log('warn', 'enroll: could not append audit entry', { kind, error: String(err) });
    }
  }
}

// Anything the file cannot be trusted to hold is dropped on load rather than throwing: a state file
// that lost a field must not stop the daemon booting.
function isRecord(v: unknown): v is EnrollmentRecord {
  if (typeof v !== 'object' || v === null) return false;
  const r = v as Record<string, unknown>;
  return (
    typeof r.id === 'string' &&
    ENROLL_ID_RE.test(r.id) &&
    typeof r.machine === 'string' &&
    typeof r.meshIp === 'string' &&
    typeof r.nodePort === 'number' &&
    typeof r.keyB64 === 'string' &&
    typeof r.createdMs === 'number' &&
    typeof r.expiresMs === 'number'
  );
}

export { constantTimeEqualB64 };
