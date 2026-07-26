#!/usr/bin/env bun
// SPDX-License-Identifier: AGPL-3.0-or-later
// postMerge entry point for the audit union file.
//
// syncer.ts hard-requires a regenerator for ANY unionPaths conflict: on an add/add it leaves
// git's own 3-way result (conflict markers, both sides present) in the tree and expects the
// repo's postMerge to reconcile it. Without this script, audit.ts's regenerateUnionLog() had no
// production caller at all, so the first real conflict on sukarfleet-audit.jsonl would abort the
// merge and wedge that repo's sync loop, identically, every cycle.
//
// Usage (from a repo's postMerge, cwd = the repo working tree):
//   bun run /path/to/src/audit-regen.ts sukarfleet-audit.jsonl
//
// Idempotent: regenerateUnionLog dedupes byte-identical lines and emits a deterministic order,
// so every machine converges on the same file. Distinct entries sharing a (machine, seq) are a
// FORK and are deliberately all retained -- dropping one would erase the evidence of tampering
// from the very artifact meant to record it (crossCheckAuditLog flags it downstream).

import { isAbsolute, join } from 'node:path';
import { regenerateUnionLog } from './audit';
import { log } from './util';

async function main(): Promise<number> {
  const rel = process.argv[2];
  if (!rel) {
    console.error('usage: audit-regen.ts <union-file-path-relative-to-cwd>');
    return 2;
  }
  const path = isAbsolute(rel) ? rel : join(process.cwd(), rel);

  try {
    const res = await regenerateUnionLog(path);
    log('info', 'audit-regen: union file regenerated', {
      path,
      entries: res.entries.length,
      changed: res.changed,
      droppedDuplicates: res.droppedDuplicates,
      conflictingForks: res.conflictingForks,
    });
    // A fork is not fatal to the merge -- the file is now well-formed and every side is preserved
    // -- but it means two machines claimed the same (machine, seq), which is never honest.
    if (res.conflictingForks > 0) {
      log('warn', 'audit-regen: same-(machine,seq) fork(s) retained for investigation', {
        path,
        conflictingForks: res.conflictingForks,
      });
    }
    return 0;
  } catch (err) {
    // Non-zero would fail the whole postMerge and, with it, the sync cycle. A missing or
    // unreadable union file is not worth wedging sync over: report it and let the cycle proceed.
    log('error', 'audit-regen: regeneration failed', { path, error: String(err) });
    return 1;
  }
}

process.exit(await main());
