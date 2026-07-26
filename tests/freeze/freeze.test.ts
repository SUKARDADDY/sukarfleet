// SPDX-License-Identifier: AGPL-3.0-or-later
//
// PROTOCOL FREEZE. The load-bearing test of the whole extraction.
//
// While one machine runs extracted code and the other runs the pre-extraction daemon, the bytes
// pinned in golden.json may not change. Rename anything internal; move any file; restructure any
// module. Do not change these bytes.
//
// A failure here is NOT a stale fixture to regenerate. It means the extracted code would break a
// running fleet mid-upgrade -- silently, because every failure mode here is a signature that stops
// verifying rather than an error that gets raised. Read tests/freeze/README.md before touching it.
//
// This file is the first thing written in the extraction and the last thing removed, after cutover
// completes and both machines share a codebase.

import { describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { canonicalJson } from '../../src/util';

const GOLDEN_PATH = join(import.meta.dir, 'golden.json');
const goldenRaw = readFileSync(GOLDEN_PATH, 'utf8');

// NaN and Infinity have no JSON representation. The recorder writes them as a sentinel so the
// "must reject non-finite" vectors survive the round trip -- written naively they arrive here as
// `null`, and the two vectors that matter most quietly stop asserting anything.
function reviveNonFinite(_key: string, value: unknown): unknown {
  if (value !== null && typeof value === 'object' && typeof (value as { $nonFinite?: unknown }).$nonFinite === 'string') {
    return Number((value as { $nonFinite: string }).$nonFinite);
  }
  return value;
}

const golden = JSON.parse(goldenRaw, reviveNonFinite) as Golden;

// Digest of the recorded file, so it cannot be quietly regenerated to make a failing test pass.
// See README.md for the (rare, deliberate) circumstances under which this may change.
const EXPECTED_GOLDEN_SHA256 = 'd96f5b46d3374114c4e2d4388699a7e00d02a94974bfb61728eca97f3524453e';

interface CanonicalCase {
  name: string;
  note: string;
  input: unknown;
  expected: string;
}

interface Golden {
  identity: { machine: string; publicKeyJwk: JsonWebKey; privateKeyJwk: JsonWebKey };
  canonicalJson: CanonicalCase[];
  gossip: { unsigned: unknown; signingInput: string; envelope: Record<string, unknown> };
  authHeader: {
    method: string;
    pathWithQuery: string;
    machine: string;
    tsMs: number;
    signingString: string;
    headerValue: string;
  };
  routes: { pinned: string[] };
  pairing: { bundle: unknown; bundleCanonical: string; helloRequestMacInput: string; helloResponseMacInput: string };
  execLocal: {
    request: unknown;
    requestCanonical: string;
    requestB64: string;
    response: unknown;
    responseCanonical: string;
  };
  endpointFile: { unsigned: unknown; canonical: string; sigB64: string };
  auditEntry: { unsigned: unknown; canonical: string; sigB64: string };
}

const ECDSA = { name: 'ECDSA', namedCurve: 'P-256' } as const;
const SIGN_ALG = { name: 'ECDSA', hash: 'SHA-256' } as const;

async function verifyRecorded(message: string, sigB64: string): Promise<boolean> {
  const key = await crypto.subtle.importKey('jwk', golden.identity.publicKeyJwk, ECDSA, false, ['verify']);
  const sig = Uint8Array.from(Buffer.from(sigB64, 'base64'));
  return crypto.subtle.verify(SIGN_ALG, key, sig, new TextEncoder().encode(message));
}

// ---------------------------------------------------------------------------
// 1. Canonical JSON -- the input to every signature in the system.
//
// This is not a wire format, which is exactly why it is dangerous: a one-character change to key
// ordering silently invalidates every signature the other machine produces. Nothing raises.
// ---------------------------------------------------------------------------

describe('canonical JSON is byte-identical to the recorded encoder', () => {
  for (const c of golden.canonicalJson) {
    const throws = typeof c.expected === 'string' && c.expected.startsWith('THROWS:');
    test(`${c.name}${c.note ? ` -- ${c.note.slice(0, 90)}` : ''}`, () => {
      if (throws) {
        expect(() => canonicalJson(c.input)).toThrow();
        return;
      }
      expect(canonicalJson(c.input)).toBe(c.expected);
    });
  }

  // Called out separately because it is the one case a reimplementation is most likely to get
  // wrong while passing every other vector here.
  test('astral-plane keys sort by CODE POINT, not by UTF-16 code unit', () => {
    const encoded = canonicalJson({ '\u{1F600}': 'emoji', '�': 'replacement', a: 'ascii' });
    const posReplacement = encoded.indexOf('�');
    const posEmoji = encoded.indexOf('\u{1F600}');
    expect(posReplacement).toBeGreaterThan(-1);
    expect(posEmoji).toBeGreaterThan(-1);
    // U+FFFD (65533) < U+1F600 (128512) by code point. A charCodeAt-based comparator sees the
    // leading surrogate 0xD83D (55357) instead and emits these in the opposite order.
    expect(posReplacement).toBeLessThan(posEmoji);
  });
});

// ---------------------------------------------------------------------------
// 2. Recorded signatures must still verify.
//
// Verification here deliberately uses plain WebCrypto rather than the project's own helpers, so
// this test cannot be satisfied by a matching bug on both sides of the comparison.
// ---------------------------------------------------------------------------

describe('recorded signatures verify against the recorded public key', () => {
  test('gossip envelope', async () => {
    expect(await verifyRecorded(golden.gossip.signingInput, golden.gossip.envelope.sigB64 as string)).toBe(true);
  });

  test('gossip signing input excludes sigB64 and is canonical', () => {
    const { sigB64: _drop, ...rest } = golden.gossip.envelope;
    expect(canonicalJson(rest)).toBe(golden.gossip.signingInput);
  });

  test('endpoint file', async () => {
    expect(await verifyRecorded(golden.endpointFile.canonical, golden.endpointFile.sigB64)).toBe(true);
  });

  test('audit entry', async () => {
    expect(await verifyRecorded(golden.auditEntry.canonical, golden.auditEntry.sigB64)).toBe(true);
  });

  test('a tampered message does NOT verify', async () => {
    expect(await verifyRecorded(golden.gossip.signingInput + ' ', golden.gossip.envelope.sigB64 as string)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 3. Envelope and payload shapes.
// ---------------------------------------------------------------------------

describe('envelope bytes are unchanged', () => {
  test('gossip envelope canonical form', () => {
    expect(canonicalJson(golden.gossip.unsigned)).toBe(golden.gossip.signingInput);
  });

  test('endpoint file canonical form', () => {
    expect(canonicalJson(golden.endpointFile.unsigned)).toBe(golden.endpointFile.canonical);
  });

  test('audit entry canonical form', () => {
    expect(canonicalJson(golden.auditEntry.unsigned)).toBe(golden.auditEntry.canonical);
  });

  test('pairing bundle canonical form', () => {
    expect(canonicalJson(golden.pairing.bundle)).toBe(golden.pairing.bundleCanonical);
  });

  test('exec-local request canonical form', () => {
    expect(canonicalJson(golden.execLocal.request)).toBe(golden.execLocal.requestCanonical);
  });

  test('exec-local response canonical form', () => {
    expect(canonicalJson(golden.execLocal.response)).toBe(golden.execLocal.responseCanonical);
  });

  // exec-local is easy to mistake for an internal call. It is not: during the canary window the
  // roamer's extracted CLI encodes it and the anchor's OLD CLI decodes it, across an SSH channel.
  test('exec-local base64 payload round-trips to the recorded canonical bytes', () => {
    expect(Buffer.from(golden.execLocal.requestB64, 'base64').toString('utf8')).toBe(
      golden.execLocal.requestCanonical,
    );
    expect(Buffer.from(golden.execLocal.requestCanonical, 'utf8').toString('base64')).toBe(
      golden.execLocal.requestB64,
    );
  });
});

// ---------------------------------------------------------------------------
// 4. The auth header.
// ---------------------------------------------------------------------------

describe('x-fleet-auth is unchanged', () => {
  test('signing string is method \\n pathWithQuery \\n tsMs \\n machine', () => {
    const h = golden.authHeader;
    expect(`${h.method}\n${h.pathWithQuery}\n${h.tsMs}\n${h.machine}`).toBe(h.signingString);
  });

  test('header value is "<machine>;<tsMs>;<sigB64>" with exactly three fields', () => {
    const parts = golden.authHeader.headerValue.split(';');
    expect(parts.length).toBe(3);
    expect(parts[0]).toBe(golden.authHeader.machine);
    expect(Number(parts[1])).toBe(golden.authHeader.tsMs);
  });

  test('recorded header signature verifies', async () => {
    const sigB64 = golden.authHeader.headerValue.split(';')[2]!;
    expect(await verifyRecorded(golden.authHeader.signingString, sigB64)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 5. The route surface.
// ---------------------------------------------------------------------------

describe('route surface is unchanged', () => {
  test('the pinned routes are exactly these five', () => {
    expect(golden.routes.pinned).toEqual([
      'POST /gossip',
      'GET /status',
      'GET /health',
      '/git/*',
      'POST /pair/hello',
    ]);
  });
});

// ---------------------------------------------------------------------------
// 6. The golden file itself.
//
// Pinned by digest so it cannot be quietly regenerated to make a failing test pass. Updating this
// digest is a deliberate act that shows up in review as exactly what it is.
// ---------------------------------------------------------------------------

describe('the golden file has not been regenerated', () => {
  test('golden.json digest matches the recorded value', () => {
    const digest = createHash('sha256').update(goldenRaw, 'utf8').digest('hex');
    expect(digest).toBe(EXPECTED_GOLDEN_SHA256);
  });
});
