// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Captures REAL signed artifacts from the machine this runs on, for live-check.ts.
//
// Output (tests/freeze/live-capture.json) contains real machine names, mesh addresses and public
// keys, so it is gitignored and must never be committed. This script itself is generic -- it reads
// only the standard config/state locations -- and carries no fleet data, so it is committed.
//
//   bun run tests/freeze/capture-live.ts

import { homedir } from 'node:os';
import { join } from 'node:path';
import { readFileSync, existsSync } from 'node:fs';

const CONFIG = process.env.SUKARFLEET_CONFIG ?? join(homedir(), '.config', 'sukarfleet', 'config.json');
const STATE = process.env.SUKARFLEET_STATE ?? join(homedir(), '.local', 'state', 'sukarfleet');
const KEYFILE = join(homedir(), '.config', 'sukarfleet', 'machine-key.json');

function readJson<T>(p: string): T | null {
  if (!existsSync(p)) return null;
  try {
    return JSON.parse(readFileSync(p, 'utf8')) as T;
  } catch {
    return null;
  }
}

interface PeerCfg {
  name: string;
  publicKeyJwk: JsonWebKey | null;
}
interface Cfg {
  machine: string;
  peers: PeerCfg[];
  repos: { name: string; path: string }[];
  unionPaths: string[];
}

const cfg = readJson<Cfg>(CONFIG);
if (!cfg) throw new Error(`no config at ${CONFIG}`);

// Public keys by machine: every peer's, plus this machine's own.
const publicKeys: Record<string, JsonWebKey> = {};
for (const p of cfg.peers) if (p.publicKeyJwk) publicKeys[p.name] = p.publicKeyJwk;
const ownKey = readJson<{ machine: string; publicKeyJwk: JsonWebKey }>(KEYFILE);
if (ownKey?.publicKeyJwk) publicKeys[ownKey.machine ?? cfg.machine] = ownKey.publicKeyJwk;

// --- real gossip envelopes, as received from peers ---------------------------
interface LastSeen {
  [machine: string]: { atMs: number; envelope: Record<string, unknown> };
}
const lastSeen = readJson<LastSeen>(join(STATE, 'last-seen.json')) ?? {};
const gossipEnvelopes = Object.values(lastSeen).map((e) => e.envelope);

// --- real audit entries, from the replicated union file ----------------------
const auditEntries: Record<string, unknown>[] = [];
const unionName = cfg.unionPaths.find((p) => p.includes('audit'));
if (unionName) {
  for (const repo of cfg.repos) {
    const p = join(repo.path, unionName);
    if (!existsSync(p)) continue;
    for (const line of readFileSync(p, 'utf8').split('\n')) {
      const t = line.trim();
      if (!t || t.startsWith('<<<') || t.startsWith('===') || t.startsWith('>>>')) continue;
      try {
        auditEntries.push(JSON.parse(t) as Record<string, unknown>);
      } catch {
        /* a conflicted union file can hold partial lines; skip them */
      }
    }
    break;
  }
}

const capture = {
  $comment:
    'REAL fleet data. Gitignored -- never commit. Regenerate with capture-live.ts. Public key ' +
    'material and signatures only; no private keys, no command output.',
  capturedOnMachine: cfg.machine,
  publicKeys,
  gossipEnvelopes,
  auditEntries,
};

const out = join(import.meta.dir, 'live-capture.json');
await Bun.write(out, JSON.stringify(capture, null, 2) + '\n');
console.log(`wrote ${out}`);
console.log(`  machines with public keys: ${Object.keys(publicKeys).join(', ')}`);
console.log(`  gossip envelopes: ${gossipEnvelopes.length}`);
console.log(`  audit entries: ${auditEntries.length}`);
