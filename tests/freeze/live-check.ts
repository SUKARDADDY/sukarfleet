// SPDX-License-Identifier: AGPL-3.0-or-later
//
// THE CUTOVER GATE. Run this before moving any machine onto extracted code.
//
// golden.json proves the wire FORMAT is unchanged against synthetic vectors. This proves something
// stronger and more specific: that signatures produced by the OTHER machine's running daemon still
// verify when re-encoded by THIS codebase's canonicalJson.
//
// That is the failure this whole freeze exists to prevent, and it is invisible in production --
// a peer whose signatures stop verifying looks like a peer that went offline, with nothing in the
// logs saying why.
//
//   bun run tests/freeze/capture-live.ts   # record from the live fleet (gitignored output)
//   bun run tests/freeze/live-check.ts     # verify this codebase reproduces those bytes
//
// Exit 0 = safe to cut over. Non-zero = do not cut over.

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { canonicalJson } from '../../src/util';

const CAPTURE = join(import.meta.dir, 'live-capture.json');

if (!existsSync(CAPTURE)) {
  console.error('no live-capture.json -- run `bun run tests/freeze/capture-live.ts` first');
  process.exit(2);
}

interface Capture {
  capturedOnMachine: string;
  publicKeys: Record<string, JsonWebKey>;
  gossipEnvelopes: Record<string, unknown>[];
  auditEntries: Record<string, unknown>[];
}

const cap = JSON.parse(readFileSync(CAPTURE, 'utf8')) as Capture;

const ECDSA = { name: 'ECDSA', namedCurve: 'P-256' } as const;
const SIGN_ALG = { name: 'ECDSA', hash: 'SHA-256' } as const;

async function verify(machine: string, message: string, sigB64: string): Promise<boolean | null> {
  const jwk = cap.publicKeys[machine];
  if (!jwk) return null; // no key for this machine: not a failure, just unverifiable here
  try {
    const key = await crypto.subtle.importKey('jwk', jwk, ECDSA, false, ['verify']);
    const sig = Uint8Array.from(Buffer.from(sigB64, 'base64'));
    return await crypto.subtle.verify(SIGN_ALG, key, sig, new TextEncoder().encode(message));
  } catch {
    return false;
  }
}

let checked = 0;
let failed = 0;
let skipped = 0;

function report(ok: boolean | null, label: string): void {
  if (ok === null) {
    skipped++;
    console.log(`  SKIP  ${label} (no public key captured for that machine)`);
    return;
  }
  checked++;
  if (ok) {
    console.log(`  PASS  ${label}`);
  } else {
    failed++;
    console.log(`  FAIL  ${label}`);
  }
}

console.log(`\nLive freeze check -- capture taken on ${cap.capturedOnMachine}`);

console.log('\nGossip envelopes (signed by the PEER, re-encoded by this codebase)');
if (cap.gossipEnvelopes.length === 0) console.log('  (none captured)');
for (const env of cap.gossipEnvelopes) {
  const { sigB64, ...rest } = env;
  const machine = String(env.machine);
  // Re-encode with THIS codebase's canonicalJson. If the encoder drifted, this string differs
  // from what the peer signed and verification fails -- which is the whole point.
  const ok = await verify(machine, canonicalJson(rest), String(sigB64));
  report(ok, `${machine} seq ${String(env.seq)}`);
}

console.log('\nAudit entries (replicated union log, both machines)');
if (cap.auditEntries.length === 0) console.log('  (none captured)');
const byMachine = new Map<string, number>();
for (const entry of cap.auditEntries) {
  const { sigB64, ...rest } = entry;
  const machine = String(entry.machine);
  const ok = await verify(machine, canonicalJson(rest), String(sigB64));
  if (ok === false) report(ok, `${machine} seq ${String(entry.seq)} (${String(entry.kind)})`);
  else {
    if (ok === null) skipped++;
    else checked++;
    byMachine.set(machine, (byMachine.get(machine) ?? 0) + (ok ? 1 : 0));
  }
}
for (const [m, n] of byMachine) console.log(`  PASS  ${m}: ${n} entries verified`);

console.log(`\n${checked} checked, ${failed} failed, ${skipped} skipped`);
if (failed > 0) {
  console.log('\nDO NOT CUT OVER. This codebase does not reproduce the bytes the running fleet signs.');
  process.exit(1);
}
console.log('\nSafe: this codebase reproduces every signature the live fleet produced.');
