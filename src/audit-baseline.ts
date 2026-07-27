#!/usr/bin/env bun
// SPDX-License-Identifier: AGPL-3.0-or-later
// Accepts the same-(machine,seq) forks currently present in a union audit file as known-benign,
// so regenerateUnionLog stops warning about them and warns only about NEW ones.
//
// Usage (per machine -- the baseline is machine-local state, never synced):
//   bun run /path/to/src/audit-baseline.ts /path/to/sukarfleet-audit.jsonl
//   bun run /path/to/src/audit-baseline.ts /path/to/sukarfleet-audit.jsonl --dry-run
//
// Why this exists at all: entries are signed OVER their seq, so a fork that has already been
// recorded cannot be renumbered away without invalidating the signatures. The historical forks
// are permanent. Either the alarm learns to ignore exactly those, or it fires forever and stops
// being read -- which is how a real forked key would have gone unnoticed.
//
// Accepting is deliberately explicit and per-machine: nothing here runs automatically, and the
// baseline is keyed to the exact set of variants seen now, so a third line appearing under an
// accepted (machine,seq) alarms again.

import { isAbsolute, join } from 'node:path';
import { loadForkBaseline, regenerateUnionLog, writeForkBaseline } from './audit';
import { log } from './util';

async function main(): Promise<number> {
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');
  const rel = args.find((a) => !a.startsWith('--'));
  if (!rel) {
    console.error('usage: audit-baseline.ts <union-file-path> [--dry-run]');
    return 2;
  }
  const path = isAbsolute(rel) ? rel : join(process.cwd(), rel);

  try {
    const res = await regenerateUnionLog(path);
    const already = await loadForkBaseline();
    const fresh = res.forks.filter((f) => !already.has(f.fingerprint));

    log('info', 'audit-baseline: forks in the union file', {
      path,
      entries: res.entries.length,
      forks: res.forks.length,
      alreadyAccepted: res.forks.length - fresh.length,
      newlyAccepted: dryRun ? 0 : fresh.length,
      dryRun,
      keys: fresh.map((f) => f.key).slice(0, 40),
    });

    if (dryRun || fresh.length === 0) return 0;

    // Union with what is already accepted: re-running this must never narrow the baseline just
    // because a peer's entries have not synced into this copy of the file yet.
    await writeForkBaseline([...already, ...fresh.map((f) => f.fingerprint)]);
    log('info', 'audit-baseline: baseline written', { accepted: already.size + fresh.length });
    return 0;
  } catch (err) {
    log('error', 'audit-baseline: failed', { path, error: String(err) });
    return 1;
  }
}

process.exit(await main());
