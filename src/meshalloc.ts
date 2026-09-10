// SPDX-License-Identifier: AGPL-3.0-or-later
// Picking a mesh address for a machine that is not here yet. Owns src/meshalloc.ts only.
//
// Until now every mesh address in this fleet was typed by a person into the console's Identity
// card, and that was fine while a person was also there to read what the other machines already
// use. An installer generated on one machine and double-clicked on another has nobody to ask, so
// the address has to be chosen at mint, on the machine doing the minting, out of what it knows.
//
// WHAT IT KNOWS IS NOT THE WHOLE TRUTH, and this module is written around that. A roamer's config
// lists the peers it has paired with, not every machine in the fleet: two machines that have never
// paired with each other are invisible to one another here. So this allocator can hand out an
// address a third machine already holds. Three things keep that from being a silent collision:
//
//   1. Mint from the anchor when there is one. Its roster is the closest thing the fleet has to a
//      complete list, and the console says so on the card rather than leaving it to be discovered.
//   2. Live enrollments reserve their address. Minting three installers in a row hands out three
//      different addresses, not the same one three times.
//   3. The address is a suggestion the operator can overwrite in the card before generating.
//
// A duplicate address on an overlay is not silent for long -- EasyTier logs it and the second
// machine's traffic goes nowhere -- but it is confusing, so the honest fix is to say where the
// number came from.

import type { FleetConfig } from './types';

export interface AllocationInput {
  cfg: FleetConfig;
  // Addresses already promised to machines that have not arrived yet.
  reserved?: readonly string[];
}

export type AllocationResult =
  | { ok: true; meshIp: string; from: string; taken: number }
  | { ok: false; reason: 'no-local-address' | 'range-full'; message: string };

const OCTET_RE = /^(0|[1-9][0-9]{0,2})$/;

export function isIpv4(s: string): boolean {
  if (typeof s !== 'string') return false;
  const parts = s.split('.');
  if (parts.length !== 4) return false;
  return parts.every((p) => OCTET_RE.test(p) && Number(p) <= 255);
}

// The fleet's range is inferred from this machine's own address rather than configured, because a
// configured range is a second source of truth that can disagree with the interface the daemon is
// actually bound to. /24 is what the installers write into fleet.toml.
export function subnetOf(meshIp: string): string | null {
  if (!isIpv4(meshIp)) return null;
  const parts = meshIp.split('.');
  return `${parts[0]}.${parts[1]}.${parts[2]}`;
}

export function allocateMeshIp(input: AllocationInput): AllocationResult {
  const { cfg } = input;
  const prefix = subnetOf(cfg.meshIp);
  if (!prefix) {
    return {
      ok: false,
      reason: 'no-local-address',
      message:
        'This machine has no mesh address of its own yet, so there is no range to allocate from. Finish this machine’s own setup first.',
    };
  }

  const taken = new Set<string>();
  const consider = (ip: unknown): void => {
    if (typeof ip === 'string' && isIpv4(ip) && subnetOf(ip) === prefix) taken.add(ip);
  };
  consider(cfg.meshIp);
  for (const peer of cfg.peers) consider(peer.meshIp);
  for (const ip of input.reserved ?? []) consider(ip);

  // .0 and .255 are the network and broadcast addresses of the /24 and are skipped; everything else
  // is fair game, including .1, because nothing in this design is a gateway.
  for (let host = 1; host <= 254; host++) {
    const candidate = `${prefix}.${host}`;
    if (!taken.has(candidate)) {
      return { ok: true, meshIp: candidate, from: `${prefix}.0/24`, taken: taken.size };
    }
  }

  return {
    ok: false,
    reason: 'range-full',
    message: `Every address in ${prefix}.0/24 is spoken for. Revoke an unused installer, or free an address.`,
  };
}
