// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Signing kernel. Everything that signs or verifies a JSON envelope goes through here -- nobody
// reimplements JSON signing. Canonicalization is util's canonicalJson (via keys.ts's
// signCanonical/verifyCanonical, which already wrap it); the ECDSA-P256/WebCrypto machinery lives
// in keys.ts and is reused here, not duplicated.
//
// Every verify function below NEVER throws. Malformed input, a wrong envelope version, or a
// canonicalJson encoding failure (a non-finite number smuggled into a signed field) all resolve to
// `false`, never a rejected promise -- callers can treat every verify call as "trusted iff true"
// without a surrounding try/catch of their own.
//
// This file used to sign five more envelope types for the signed-job ceremony. Those envelopes and
// their helpers are gone; the audit entry is the one that survived, because the audit log is not
// part of that ceremony -- it records what the admin lane did.

import type { AuditEntry, MachineKey } from './types';
import { signCanonical, verifyCanonical } from './keys';

// ---------------------------------------------------------------------------
// AuditEntry
// ---------------------------------------------------------------------------

export async function signAuditEntry(entry: Omit<AuditEntry, 'sigB64'>, key: MachineKey): Promise<AuditEntry> {
  const sigB64 = await signCanonical(entry, key);
  return { ...entry, sigB64 };
}

export async function verifyAuditEntry(entry: AuditEntry, publicKeyJwk: JsonWebKey): Promise<boolean> {
  try {
    if (entry.v !== 1) return false;
    const { sigB64, ...rest } = entry;
    return await verifyCanonical(rest, sigB64, publicKeyJwk);
  } catch {
    return false;
  }
}
