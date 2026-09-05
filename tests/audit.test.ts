// SPDX-License-Identifier: AGPL-3.0-or-later
// Tests for the audit lane. Exercises src/audit.ts against the shared layer (types.ts/util.ts/
// config.ts) and the trust kernel (src/trust.ts) only.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadOrCreateMachineKey } from '../src/keys';
import type { AuditEntry, MachineKey } from '../src/types';
import { signAuditEntry } from '../src/trust';
import { canonicalJson } from '../src/util';
import {
  AUDIT_KIND_JOB_EXECUTED,
  AUDIT_KIND_JOB_EXPIRED,
  AUDIT_KIND_JOB_ISSUED,
  AuditLog,
  GENESIS_PREV,
  crossCheckAuditLog,
  flushLocalToUnion,
  loadForkBaseline,
  regenerateUnionLog,
  writeForkBaseline,
} from '../src/audit';

let keyDir: string;
let stateRoot: string;

beforeEach(async () => {
  keyDir = await mkdtemp(join(tmpdir(), 'sukarfleet-audit-keys-'));
  stateRoot = await mkdtemp(join(tmpdir(), 'sukarfleet-audit-state-'));
  process.env.SUKARFLEET_STATE = stateRoot;
});

afterEach(async () => {
  delete process.env.SUKARFLEET_STATE;
  await rm(keyDir, { recursive: true, force: true });
  await rm(stateRoot, { recursive: true, force: true });
});

async function freshKey(machine: string): Promise<MachineKey> {
  return loadOrCreateMachineKey(machine, { keyPath: join(keyDir, `${machine}-${Math.random()}.json`) });
}

// Builds a signed AuditEntry directly (bypassing AuditLog's local-file/seq bookkeeping), for
// tests that need full control over machine/seq/kind/detail/tsMs combinations.
async function makeEntry(
  machine: string,
  key: MachineKey,
  seq: number,
  kind: string,
  detail: Record<string, unknown>,
  tsMs = 1_000_000,
  prev?: string,
): Promise<AuditEntry> {
  const unsigned: Omit<AuditEntry, 'sigB64'> = { v: 1, machine, seq, tsMs, kind, detail, ...(prev ? { prev } : {}) };
  return signAuditEntry(unsigned, key);
}

// The link an entry's successor must carry: sha256 over the canonicalJson of the FULL signed line.
// Spelled out here rather than imported, so a change to how audit.ts computes it has to be made
// twice on purpose.
function digestOf(entry: AuditEntry): string {
  return createHash('sha256').update(canonicalJson(entry)).digest('hex');
}

describe('AuditLog.append / readAll', () => {
  test('mints strictly increasing per-machine seq and every entry verifies', async () => {
    const key = await freshKey('alpha');
    const alog = new AuditLog('alpha', key);

    const e1 = await alog.append(AUDIT_KIND_JOB_ISSUED, { jobId: 'job-1', targetMachine: 'beta' });
    const e2 = await alog.append(AUDIT_KIND_JOB_EXECUTED, { jobId: 'job-1', originMachine: 'alpha' });

    expect(e1.seq).toBe(1);
    expect(e2.seq).toBe(2);
    expect(e1.machine).toBe('alpha');
    expect(e1.v).toBe(1);

    const all = await alog.readAll();
    expect(all).toHaveLength(2);
    expect(all[0]!.seq).toBe(1);
    expect(all[1]!.seq).toBe(2);
  });

  test('seq survives a fresh AuditLog instance over the same state dir (restart)', async () => {
    const key = await freshKey('alpha');
    const first = new AuditLog('alpha', key);
    await first.append(AUDIT_KIND_JOB_ISSUED, { jobId: 'job-1', targetMachine: 'beta' });
    await first.append(AUDIT_KIND_JOB_ISSUED, { jobId: 'job-2', targetMachine: 'beta' });

    const second = new AuditLog('alpha', key);
    const e3 = await second.append(AUDIT_KIND_JOB_ISSUED, { jobId: 'job-3', targetMachine: 'beta' });
    expect(e3.seq).toBe(3);

    const all = await second.readAll();
    expect(all.map((e) => e.seq)).toEqual([1, 2, 3]);
  });

  test('two machines (each its own process/state-dir) mint independent seq streams', async () => {
    // AuditLog's local seq file is process/state-dir scoped, matching gossip.ts's identical
    // pattern -- one running daemon process is always exactly one machine's identity. Two
    // machines are modeled here as two separate state dirs, swapping SUKARFLEET_STATE between
    // them the same way beforeEach/afterEach do for the whole file.
    const laptopState = await mkdtemp(join(tmpdir(), 'sukarfleet-audit-state-laptop-'));
    try {
      const popKey = await freshKey('alpha');
      const popLog = new AuditLog('alpha', popKey);
      const p1 = await popLog.append(AUDIT_KIND_JOB_ISSUED, { jobId: 'job-1', targetMachine: 'beta' });

      process.env.SUKARFLEET_STATE = laptopState;
      const laptopKey = await freshKey('beta');
      const laptopLog = new AuditLog('beta', laptopKey);
      const l1 = await laptopLog.append(AUDIT_KIND_JOB_EXECUTED, { jobId: 'job-1', originMachine: 'alpha' });

      expect(p1.machine).toBe('alpha');
      expect(p1.seq).toBe(1);
      expect(l1.machine).toBe('beta');
      expect(l1.seq).toBe(1);
    } finally {
      process.env.SUKARFLEET_STATE = stateRoot;
      await rm(laptopState, { recursive: true, force: true });
    }
  });

  // Two AuditLog instances over ONE state dir model the real deployment: the daemon holds one for
  // its whole lifetime while cli.ts's SSH forced command builds another in a short-lived process
  // every time this machine is an admin-run target. The counter used to be cached in memory, so
  // the daemon re-minted a seq the forced command had already taken and the pair surfaced as a
  // same-(machine,seq) fork -- the signature of a stolen key. 33 of them reached the live fleet.
  test('a second process minting in between does not make the first re-use a seq (audit-seq-fork)', async () => {
    const key = await freshKey('alpha');
    const daemon = new AuditLog('alpha', key);
    const forcedCommand = new AuditLog('alpha', key);

    const a = await daemon.append('admin-run-requested', { runId: 'r1' });
    const b = await forcedCommand.append('admin-run-completed', { runId: 'r1' });
    const c = await daemon.append('admin-run-requested', { runId: 'r2' });

    expect([a.seq, b.seq, c.seq]).toEqual([1, 2, 3]);
    const seqs = (await daemon.readAll()).map((e) => e.seq);
    expect(new Set(seqs).size).toBe(seqs.length);
  });

  test('concurrent mints across instances are all distinct and contiguous', async () => {
    const key = await freshKey('alpha');
    const logs = [new AuditLog('alpha', key), new AuditLog('alpha', key), new AuditLog('alpha', key)];
    const minted = await Promise.all(
      Array.from({ length: 12 }, (_, i) => logs[i % logs.length]!.append('probe', { i })),
    );
    const seqs = minted.map((e) => e.seq).sort((x, y) => x - y);
    expect(seqs).toEqual(Array.from({ length: 12 }, (_, i) => i + 1));

    // And the chain survives the contention, which is the whole reason the seq lock now covers
    // sign-and-append and not just the mint: with only the mint inside it, two writers could take
    // n and n+1 and then append in the other order, leaving n+1's prev naming an entry that was
    // not yet its parent.
    const all = (await logs[0]!.readAll()).sort((a, b) => a.seq - b.seq);
    for (let i = 1; i < all.length; i++) expect(all[i]!.prev).toBe(digestOf(all[i - 1]!));
    const report = await crossCheckAuditLog(all, {
      nowMs: 2_000_000,
      publicKeyJwkByMachine: { alpha: key.publicKeyJwk },
    });
    expect(report.flags).toEqual([]);
  });
});

describe('AuditLog: the per-machine hash chain', () => {
  test('the first entry declares genesis and every later one links to its predecessor', async () => {
    const key = await freshKey('alpha');
    const alog = new AuditLog('alpha', key);

    const e1 = await alog.append('probe', { i: 1 });
    const e2 = await alog.append('probe', { i: 2 });
    const e3 = await alog.append('probe', { i: 3 });

    expect(e1.prev).toBe(GENESIS_PREV);
    expect(e2.prev).toBe(digestOf(e1));
    expect(e3.prev).toBe(digestOf(e2));

    const report = await crossCheckAuditLog(await alog.readAll(), {
      nowMs: 2_000_000,
      publicKeyJwkByMachine: { alpha: key.publicKeyJwk },
    });
    expect(report.flags).toEqual([]);
  });

  test('the first chained entry over unchained history links back into it, not to genesis', async () => {
    // The real upgrade shape: this machine already has entries from before the chain existed.
    const key = await freshKey('alpha');
    const old1 = await makeEntry('alpha', key, 1, 'probe', { i: 1 });
    const old2 = await makeEntry('alpha', key, 2, 'probe', { i: 2 });
    await Bun.write(join(stateRoot, 'audit-log.jsonl'), `${canonicalJson(old1)}\n${canonicalJson(old2)}\n`);
    await Bun.write(join(stateRoot, 'audit-seq.json'), canonicalJson({ seq: 2 }));

    const e3 = await new AuditLog('alpha', key).append('probe', { i: 3 });
    expect(e3.seq).toBe(3);
    expect(e3.prev).toBe(digestOf(old2));

    // Genesis is seq 3, so the two unchained entries below it are not chain-checked and the whole
    // run reads clean -- an upgrade must not turn every pre-chain entry into an alarm.
    const report = await crossCheckAuditLog([old1, old2, e3], {
      nowMs: 2_000_000,
      publicKeyJwkByMachine: { alpha: key.publicKeyJwk },
    });
    expect(report.flags).toEqual([]);
  });
});

describe('crossCheckAuditLog: the hash chain from genesis forward', () => {
  const NOW = 2_000_000;

  async function chainedRun(machine: string, key: MachineKey, length: number): Promise<AuditEntry[]> {
    const alog = new AuditLog(machine, key);
    const out: AuditEntry[] = [];
    for (let i = 1; i <= length; i++) out.push(await alog.append('probe', { i }));
    return out;
  }

  test('an interior entry swapped for another the same key signed is caught as chain-broken', async () => {
    // The attack seq alone cannot see: a stolen key re-signs entry 2 at the SAME seq and the
    // original line is removed, so the run stays contiguous and every signature verifies. Only
    // entry 3's link, which still names the entry that was there before, disagrees.
    const key = await freshKey('alpha');
    const [e1, e2, e3] = await chainedRun('alpha', key, 3);
    const forged = await makeEntry('alpha', key, 2, 'probe', { i: 'rewritten' }, e2!.tsMs, e2!.prev);

    const report = await crossCheckAuditLog([e1!, forged, e3!], {
      nowMs: NOW,
      publicKeyJwkByMachine: { alpha: key.publicKeyJwk },
    });

    expect(report.flags.filter((f) => f.kind === 'signature-invalid')).toEqual([]);
    expect(report.flags.filter((f) => f.kind === 'seq-gap')).toEqual([]);
    const broken = report.flags.filter((f) => f.kind === 'chain-broken');
    expect(broken).toHaveLength(1);
    expect(broken[0]!.entry!.seq).toBe(3);
    expect(broken[0]!.machine).toBe('alpha');
  });

  test('an entry appended after genesis with no prev at all is caught', async () => {
    const key = await freshKey('alpha');
    const [e1, e2] = await chainedRun('alpha', key, 2);
    const unlinked = await makeEntry('alpha', key, 3, 'probe', { i: 3 });

    const report = await crossCheckAuditLog([e1!, e2!, unlinked], {
      nowMs: NOW,
      publicKeyJwkByMachine: { alpha: key.publicKeyJwk },
    });
    const broken = report.flags.filter((f) => f.kind === 'chain-broken');
    expect(broken).toHaveLength(1);
    expect(broken[0]!.entry!.seq).toBe(3);
    expect(broken[0]!.detail).toContain('no prev');
  });

  test('a clean run is silent, and reordering it does not change the verdict', async () => {
    const key = await freshKey('alpha');
    const run = await chainedRun('alpha', key, 4);
    const shuffled = [run[2]!, run[0]!, run[3]!, run[1]!];
    const report = await crossCheckAuditLog(shuffled, {
      nowMs: NOW,
      publicKeyJwkByMachine: { alpha: key.publicKeyJwk },
    });
    expect(report.flags).toEqual([]);
  });

  test('history below genesis is never chain-checked, accepted forks and all', async () => {
    // The live fleet's shape: 33 same-seq forks from the old seq-minting race, signed and
    // therefore impossible to renumber, sitting under entries that DO carry a link.
    const key = await freshKey('alpha');
    const old1 = await makeEntry('alpha', key, 1, 'probe', { i: 1 });
    const forkA = await makeEntry('alpha', key, 2, 'probe', { i: '2a' });
    const forkB = await makeEntry('alpha', key, 2, 'probe', { i: '2b' });
    // Chained from here on, linking to whichever side of the fork this machine actually appended
    // after. Either side must be accepted: the appender saw one of them, and neither can be
    // withdrawn.
    const e3 = await makeEntry('alpha', key, 3, 'probe', { i: 3 }, 1_000_000, digestOf(forkB));
    const e4 = await makeEntry('alpha', key, 4, 'probe', { i: 4 }, 1_000_000, digestOf(e3));

    const dir = await mkdtemp(join(tmpdir(), 'sukarfleet-audit-chainfork-'));
    const path = join(dir, 'union.jsonl');
    await Bun.write(path, `${canonicalJson(forkA)}\n${canonicalJson(forkB)}\n`);
    const fingerprints = (await regenerateUnionLog(path)).forks.map((f) => f.fingerprint);
    await rm(dir, { recursive: true, force: true });

    const report = await crossCheckAuditLog([old1, forkA, forkB, e3, e4], {
      nowMs: NOW,
      publicKeyJwkByMachine: { alpha: key.publicKeyJwk },
      acceptedForkFingerprints: new Set(fingerprints),
    });
    expect(report.flags).toEqual([]);

    // The genesis entry itself (seq 3 here) is not link-checked -- what it points at may predate
    // anything the caller was handed -- but its successor is: point seq 4 somewhere else and the
    // break shows up even though every signature still verifies.
    const forged = await makeEntry('alpha', key, 4, 'probe', { i: 4 }, 1_000_000, digestOf(old1));
    const bad = await crossCheckAuditLog([old1, forkA, forkB, e3, forged], {
      nowMs: NOW,
      publicKeyJwkByMachine: { alpha: key.publicKeyJwk },
      acceptedForkFingerprints: new Set(fingerprints),
    });
    expect(bad.flags.filter((f) => f.kind === 'chain-broken')).toHaveLength(1);
    expect(bad.flags.filter((f) => f.kind === 'signature-invalid')).toEqual([]);
  });

  test('after genesis, a successor of a same-seq fork may link to EITHER side of it', async () => {
    // A fork that happened after the chain existed: both variants carry a link, so both are
    // legitimate parents as far as the reader can tell, and whichever one the appender saw must
    // be accepted. Rejecting one side would turn a permanent, already-accepted fork into a
    // permanent chain alarm.
    const key = await freshKey('alpha');
    const e1 = await makeEntry('alpha', key, 1, 'probe', { i: 1 }, 1_000_000, GENESIS_PREV);
    const forkA = await makeEntry('alpha', key, 2, 'probe', { i: '2a' }, 1_000_000, digestOf(e1));
    const forkB = await makeEntry('alpha', key, 2, 'probe', { i: '2b' }, 1_000_000, digestOf(e1));

    const dir = await mkdtemp(join(tmpdir(), 'sukarfleet-audit-chainfork2-'));
    const path = join(dir, 'union.jsonl');
    await Bun.write(path, `${canonicalJson(forkA)}\n${canonicalJson(forkB)}\n`);
    const accepted = new Set((await regenerateUnionLog(path)).forks.map((f) => f.fingerprint));
    await rm(dir, { recursive: true, force: true });

    for (const parent of [forkA, forkB]) {
      const e3 = await makeEntry('alpha', key, 3, 'probe', { i: 3 }, 1_000_000, digestOf(parent));
      const report = await crossCheckAuditLog([e1, forkA, forkB, e3], {
        nowMs: NOW,
        publicKeyJwkByMachine: { alpha: key.publicKeyJwk },
        acceptedForkFingerprints: accepted,
      });
      expect(report.flags).toEqual([]);
    }

    // A third parent that is neither side is still a break.
    const orphan = await makeEntry('alpha', key, 3, 'probe', { i: 3 }, 1_000_000, digestOf(e1));
    const bad = await crossCheckAuditLog([e1, forkA, forkB, orphan], {
      nowMs: NOW,
      publicKeyJwkByMachine: { alpha: key.publicKeyJwk },
      acceptedForkFingerprints: accepted,
    });
    expect(bad.flags.filter((f) => f.kind === 'chain-broken')).toHaveLength(1);
  });

  // DENIAL OF FORENSICS, and the reason the chain pass runs over verified entries only. The union
  // file is git-synced, so anyone who can write the shared repo can append a line to it -- they
  // just cannot sign one. Before the fix, an UNSIGNED line at seq 0 carrying prev:'genesis' set
  // this machine's genesis to 0, and every honest pre-chain entry above it was then "missing" the
  // link it was never supposed to have: six alarms from one injected line, with the single true
  // finding buried among them. Six is not a magic number; it is however many entries the machine
  // happens to have, so the flood scales with the honest log.
  test('an unsigned entry injected below genesis cannot flood the pre-chain run with alarms', async () => {
    const key = await freshKey('alpha');
    const run: AuditEntry[] = [];
    for (let i = 1; i <= 6; i++) run.push(await makeEntry('alpha', key, i, 'probe', { i }));

    // Not signed, and it does not need to be: the whole point is that an attacker who can only
    // append cannot produce a signature this machine's enrolled key would verify.
    const injected: AuditEntry = {
      v: 1,
      machine: 'alpha',
      seq: 0,
      tsMs: 1_000_000,
      kind: 'probe',
      detail: { i: 0 },
      prev: GENESIS_PREV,
      sigB64: '',
    };

    const report = await crossCheckAuditLog([injected, ...run], {
      nowMs: NOW,
      publicKeyJwkByMachine: { alpha: key.publicKeyJwk },
    });

    expect(report.flags.filter((f) => f.kind === 'chain-broken')).toEqual([]);
    const invalid = report.flags.filter((f) => f.kind === 'signature-invalid');
    expect(invalid).toHaveLength(1);
    expect(invalid[0]!.entry!.seq).toBe(0);
    // And nothing else: the one line that was tampered with is the whole verdict.
    expect(report.flags).toHaveLength(1);
  });

  test('an unsigned entry cannot stand in as somebody\'s parent either', async () => {
    // The same rule on the link side. Replace a chained entry with an unsigned line at its seq:
    // the signature check names it, and its successor is NOT additionally flagged for linking to
    // the entry that was really there. One tamper, one finding. A forgery signed by a STOLEN key
    // still verifies and is still caught as chain-broken -- that is the test above.
    const key = await freshKey('alpha');
    const [e1, e2, e3] = await chainedRun('alpha', key, 3);
    const unsigned: AuditEntry = { ...e2!, detail: { i: 'rewritten' }, sigB64: '' };

    const report = await crossCheckAuditLog([e1!, unsigned, e3!], {
      nowMs: NOW,
      publicKeyJwkByMachine: { alpha: key.publicKeyJwk },
    });
    expect(report.flags.filter((f) => f.kind === 'chain-broken')).toEqual([]);
    expect(report.flags.filter((f) => f.kind === 'signature-invalid')).toHaveLength(1);
  });

  // THE HONEST LIMIT, and it is not small. A chain links each entry to the one before it, so it
  // proves nothing about where the chain ENDS: lop the newest entries off a machine's run and what
  // remains is internally perfect. Detecting that needs a per-machine high-water mark the checker
  // is given from outside (see crossCheckAuditLog's (c)), which this pure reader does not have.
  // What the chain adds over seq alone is the interior edit -- an entry replaced by another the
  // same key signed at the same seq -- from genesis forward, and nothing about the tail.
  test('trailing truncation is STILL undetectable -- the chain does not close that hole', async () => {
    const key = await freshKey('alpha');
    const run = await chainedRun('alpha', key, 4);
    const truncated = run.slice(0, 2);
    const report = await crossCheckAuditLog(truncated, {
      nowMs: NOW,
      publicKeyJwkByMachine: { alpha: key.publicKeyJwk },
    });
    expect(report.flags).toEqual([]);
  });
});

describe('regenerateUnionLog: canonical regenerator', () => {
  test('sorts by (machine,seq) and dedups exact-duplicate lines', async () => {
    const popKey = await freshKey('alpha');
    const laptopKey = await freshKey('beta');
    const p1 = await makeEntry('alpha', popKey, 1, AUDIT_KIND_JOB_ISSUED, { jobId: 'j1' });
    const p2 = await makeEntry('alpha', popKey, 2, AUDIT_KIND_JOB_ISSUED, { jobId: 'j2' });
    const l1 = await makeEntry('beta', laptopKey, 1, AUDIT_KIND_JOB_EXECUTED, { jobId: 'j1', originMachine: 'alpha' });

    const dir = await mkdtemp(join(tmpdir(), 'sukarfleet-audit-union-'));
    const path = join(dir, 'audit-log.jsonl');
    // Simulate a raw git line-union merge: out of order, with an exact-duplicate line (both
    // sides of the merge already had p1 from a prior sync round).
    const raw = [canonicalJson(l1), canonicalJson(p2), canonicalJson(p1), canonicalJson(p1)].join('\n') + '\n';
    await Bun.write(path, raw);

    const res = await regenerateUnionLog(path);
    expect(res.droppedDuplicates).toBe(1);
    expect(res.droppedMalformed).toBe(0);
    expect(res.conflictingForks).toBe(0);
    expect(res.changed).toBe(true);
    expect(res.entries.map((e) => `${e.machine}:${e.seq}`)).toEqual(['alpha:1', 'alpha:2', 'beta:1']);

    const content = await Bun.file(path).text();
    const lines = content.split('\n').filter((l) => l.length > 0);
    expect(lines).toEqual([canonicalJson(p1), canonicalJson(p2), canonicalJson(l1)]);
    expect(content.endsWith('\n')).toBe(true);

    await rm(dir, { recursive: true, force: true });
  });

  test('PRESERVES both sides of a same-(machine,seq) fork rather than silently evicting one (audit-fork-eviction)', async () => {
    const key = await freshKey('beta');
    const forkA = await makeEntry('beta', key, 1, AUDIT_KIND_JOB_EXECUTED, { jobId: 'job-a', originMachine: 'alpha' });
    const forkB = await makeEntry('beta', key, 1, AUDIT_KIND_JOB_EXECUTED, { jobId: 'job-b', originMachine: 'alpha' });
    expect(canonicalJson(forkA)).not.toBe(canonicalJson(forkB));

    const dir = await mkdtemp(join(tmpdir(), 'sukarfleet-audit-union-'));
    const path = join(dir, 'audit-log.jsonl');
    await Bun.write(path, [canonicalJson(forkA), canonicalJson(forkB)].join('\n') + '\n');

    const res = await regenerateUnionLog(path);
    expect(res.conflictingForks).toBe(1);
    // A fork is NOT a duplicate: nothing was dropped. The old lexicographic tie-break kept only
    // the smaller-bytes line, so anyone with write access to the shared repo could evict a
    // genuine signed entry by appending a same-key line that sorts below it (an unsigned entry
    // with sigB64:"" sorts below almost anything). Both sides must survive into the file so
    // crossCheckAuditLog's seq-fork detection can flag the tamper.
    expect(res.droppedDuplicates).toBe(0);
    expect(res.entries).toHaveLength(2);
    expect(res.entries.map((e) => (e.detail as { jobId: string }).jobId).sort()).toEqual(['job-a', 'job-b']);

    // Re-running is still idempotent even though the input was a real fork, not a plain duplicate.
    const again = await regenerateUnionLog(path);
    expect(again.changed).toBe(false);
    expect(again.entries.map((e) => canonicalJson(e))).toEqual(res.entries.map((e) => canonicalJson(e)));

    await rm(dir, { recursive: true, force: true });
  });

  // Entries are signed over their seq, so a fork already written can never be renumbered away:
  // the historical ones are permanent. Without a baseline the warning fires forever and stops
  // being read, which is exactly how a real forked key would slip past.
  test('an accepted fork stops warning; a new variant under the same key alarms again (audit-fork-baseline)', async () => {
    const key = await freshKey('beta');
    const forkA = await makeEntry('beta', key, 1, AUDIT_KIND_JOB_EXECUTED, { jobId: 'job-a', originMachine: 'alpha' });
    const forkB = await makeEntry('beta', key, 1, AUDIT_KIND_JOB_EXECUTED, { jobId: 'job-b', originMachine: 'alpha' });

    const dir = await mkdtemp(join(tmpdir(), 'sukarfleet-audit-baseline-'));
    const path = join(dir, 'audit-log.jsonl');
    await Bun.write(path, [canonicalJson(forkA), canonicalJson(forkB)].join('\n') + '\n');

    const before = await regenerateUnionLog(path);
    expect(before.conflictingForks).toBe(1);
    expect(before.unacceptedForks).toBe(1);

    await writeForkBaseline(before.forks.map((f) => f.fingerprint));
    expect((await loadForkBaseline()).size).toBe(1);

    const after = await regenerateUnionLog(path);
    // Still reported as a fork -- accepting it does not erase it, only silences the alarm.
    expect(after.conflictingForks).toBe(1);
    expect(after.unacceptedForks).toBe(0);
    expect(after.entries).toHaveLength(2);

    // A THIRD line under the accepted key changes the variant set, so the fingerprint no longer
    // matches and it is a fresh, unaccepted fork.
    const forkC = await makeEntry('beta', key, 1, AUDIT_KIND_JOB_EXECUTED, { jobId: 'job-c', originMachine: 'alpha' });
    await Bun.write(path, (await Bun.file(path).text()) + canonicalJson(forkC) + '\n');
    const third = await regenerateUnionLog(path);
    expect(third.conflictingForks).toBe(1);
    expect(third.unacceptedForks).toBe(1);

    await rm(dir, { recursive: true, force: true });
  });

  test('re-running over its own output is a no-op (idempotent, changed:false)', async () => {
    const key = await freshKey('alpha');
    const e1 = await makeEntry('alpha', key, 1, AUDIT_KIND_JOB_ISSUED, { jobId: 'j1' });
    const dir = await mkdtemp(join(tmpdir(), 'sukarfleet-audit-union-'));
    const path = join(dir, 'audit-log.jsonl');
    await Bun.write(path, canonicalJson(e1) + '\n');

    const first = await regenerateUnionLog(path);
    expect(first.changed).toBe(false); // already canonical

    const second = await regenerateUnionLog(path);
    expect(second.changed).toBe(false);
    expect(second.entries).toHaveLength(1);

    await rm(dir, { recursive: true, force: true });
  });

  test('skips malformed / non-AuditEntry-shaped lines without throwing', async () => {
    const key = await freshKey('alpha');
    const e1 = await makeEntry('alpha', key, 1, AUDIT_KIND_JOB_ISSUED, { jobId: 'j1' });
    const dir = await mkdtemp(join(tmpdir(), 'sukarfleet-audit-union-'));
    const path = join(dir, 'audit-log.jsonl');
    const raw = ['not json at all', JSON.stringify({ v: 1, machine: 'x' }), canonicalJson(e1), ''].join('\n');
    await Bun.write(path, raw);

    const res = await regenerateUnionLog(path);
    expect(res.droppedMalformed).toBe(2);
    expect(res.entries).toHaveLength(1);
    expect(res.entries[0]!.machine).toBe('alpha');

    await rm(dir, { recursive: true, force: true });
  });

  test('missing file regenerates to empty content without throwing', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'sukarfleet-audit-union-'));
    const path = join(dir, 'does-not-exist.jsonl');
    const res = await regenerateUnionLog(path);
    expect(res.entries).toHaveLength(0);
    expect(res.changed).toBe(false);
    await rm(dir, { recursive: true, force: true });
  });

  test('two independent appenders converge byte-identical regardless of merge order', async () => {
    const popKey = await freshKey('alpha');
    const laptopKey = await freshKey('beta');
    const p1 = await makeEntry('alpha', popKey, 1, AUDIT_KIND_JOB_ISSUED, { jobId: 'j1', targetMachine: 'beta' });
    const p2 = await makeEntry('alpha', popKey, 2, AUDIT_KIND_JOB_ISSUED, { jobId: 'j2', targetMachine: 'beta' });
    const l1 = await makeEntry('beta', laptopKey, 1, AUDIT_KIND_JOB_EXECUTED, { jobId: 'j1', originMachine: 'alpha' });

    const dir = await mkdtemp(join(tmpdir(), 'sukarfleet-audit-union-'));
    // Side A merged with alpha's own entries first, then beta's.
    const pathA = join(dir, 'a.jsonl');
    await Bun.write(pathA, [canonicalJson(p1), canonicalJson(p2), canonicalJson(l1)].join('\n') + '\n');
    // Side B merged with beta's entry first, plus a duplicate line git's union merge left
    // behind, in a different order entirely.
    const pathB = join(dir, 'b.jsonl');
    await Bun.write(pathB, [canonicalJson(l1), canonicalJson(p2), canonicalJson(p1), canonicalJson(l1)].join('\n') + '\n');

    const resA = await regenerateUnionLog(pathA);
    const resB = await regenerateUnionLog(pathB);

    const contentA = await Bun.file(pathA).text();
    const contentB = await Bun.file(pathB).text();
    expect(contentA).toBe(contentB);
    expect(resA.entries.map((e) => canonicalJson(e))).toEqual(resB.entries.map((e) => canonicalJson(e)));

    await rm(dir, { recursive: true, force: true });
  });
});

describe('flushLocalToUnion', () => {
  test('copies local entries into the union file and regenerates it', async () => {
    const key = await freshKey('alpha');
    const alog = new AuditLog('alpha', key);
    await alog.append(AUDIT_KIND_JOB_ISSUED, { jobId: 'j1', targetMachine: 'beta' });
    await alog.append(AUDIT_KIND_JOB_ISSUED, { jobId: 'j2', targetMachine: 'beta' });

    const dir = await mkdtemp(join(tmpdir(), 'sukarfleet-audit-union-'));
    const unionPath = join(dir, 'nested', 'audit-log.jsonl'); // parent dir must be created for us

    const res = await flushLocalToUnion(unionPath);
    expect(res.entries).toHaveLength(2);
    expect(res.entries.map((e) => e.seq)).toEqual([1, 2]);

    // Re-flushing re-appends the same local lines (flushLocalToUnion keeps no "already
    // flushed" cursor by design) -- the file is rewritten (changed:true, since the
    // just-appended raw copy briefly had 4 lines), but the regenerator dedups back down to
    // the same two canonical entries either way.
    const again = await flushLocalToUnion(unionPath);
    expect(again.entries).toHaveLength(2);
    expect(again.droppedDuplicates).toBe(2);
    expect(again.entries.map((e) => canonicalJson(e))).toEqual(res.entries.map((e) => canonicalJson(e)));

    await rm(dir, { recursive: true, force: true });
  });

  test('merges with entries already present from another machine', async () => {
    const popKey = await freshKey('alpha');
    const laptopKey = await freshKey('beta');

    const dir = await mkdtemp(join(tmpdir(), 'sukarfleet-audit-union-'));
    const unionPath = join(dir, 'audit-log.jsonl');
    const laptopEntry = await makeEntry('beta', laptopKey, 1, AUDIT_KIND_JOB_EXECUTED, {
      jobId: 'j1',
      originMachine: 'alpha',
    });
    await Bun.write(unionPath, canonicalJson(laptopEntry) + '\n');

    const popLog = new AuditLog('alpha', popKey);
    await popLog.append(AUDIT_KIND_JOB_ISSUED, { jobId: 'j1', targetMachine: 'beta' });

    const res = await flushLocalToUnion(unionPath);
    expect(res.entries.map((e) => e.machine).sort()).toEqual(['alpha', 'beta']);

    await rm(dir, { recursive: true, force: true });
  });
});

// The two options the daemon's sync-tick cross-check depends on. Without the first it would
// re-raise every historical fork on every tick (the live fleet carried 33); without the second it
// would re-verify the whole log every tick forever.
describe('crossCheckAuditLog: baseline-accepted forks and the verification cache', () => {
  // Builds a real fork (two validly-signed entries claiming one seq) and returns the fingerprint
  // the way production gets it: from the regenerator, which is what audit-baseline.ts writes.
  async function forkedPair(): Promise<{ entries: AuditEntry[]; fingerprint: string; key: MachineKey }> {
    const key = await freshKey('alpha');
    const a = await makeEntry('alpha', key, 7, AUDIT_KIND_JOB_ISSUED, { jobId: 'j1', targetMachine: 'beta' });
    const b = await makeEntry('alpha', key, 7, AUDIT_KIND_JOB_ISSUED, { jobId: 'j2', targetMachine: 'beta' });
    const dir = await mkdtemp(join(tmpdir(), 'sukarfleet-fork-'));
    const path = join(dir, 'union.jsonl');
    await Bun.write(path, `${canonicalJson(a)}\n${canonicalJson(b)}\n`);
    const result = await regenerateUnionLog(path);
    await rm(dir, { recursive: true, force: true });
    expect(result.forks).toHaveLength(1);
    return { entries: [a, b], fingerprint: result.forks[0]!.fingerprint, key };
  }

  test('a fork is flagged when no baseline is supplied', async () => {
    const { entries, key } = await forkedPair();
    const report = await crossCheckAuditLog(entries, {
      nowMs: entries[0]!.tsMs,
      publicKeyJwkByMachine: { alpha: key.publicKeyJwk },
    });
    expect(report.flags.filter((f) => f.kind === 'seq-fork')).toHaveLength(1);
  });

  test('the same fork is silent once its fingerprint is in the accepted set', async () => {
    const { entries, fingerprint, key } = await forkedPair();
    const report = await crossCheckAuditLog(entries, {
      nowMs: entries[0]!.tsMs,
      publicKeyJwkByMachine: { alpha: key.publicKeyJwk },
      acceptedForkFingerprints: new Set([fingerprint]),
    });
    expect(report.flags.filter((f) => f.kind === 'seq-fork')).toHaveLength(0);
  });

  test('accepting a fork does not accept a THIRD variant appearing later', async () => {
    const { entries, fingerprint, key } = await forkedPair();
    // The whole reason accepting a fork is safe: the fingerprint covers the SET of variants, so a
    // new line under the same seq changes it and the alarm returns.
    const third = await makeEntry('alpha', key, 7, AUDIT_KIND_JOB_ISSUED, { jobId: 'j3', targetMachine: 'beta' });
    const report = await crossCheckAuditLog([...entries, third], {
      nowMs: entries[0]!.tsMs,
      publicKeyJwkByMachine: { alpha: key.publicKeyJwk },
      acceptedForkFingerprints: new Set([fingerprint]),
    });
    expect(report.flags.filter((f) => f.kind === 'seq-fork')).toHaveLength(1);
  });

  test('a clean pass fills the cache, and a cached digest is not re-verified', async () => {
    const key = await freshKey('alpha');
    const entry = await makeEntry('alpha', key, 1, AUDIT_KIND_JOB_ISSUED, { jobId: 'j1', targetMachine: 'beta' });
    const cache = new Set<string>();
    const first = await crossCheckAuditLog([entry], {
      nowMs: entry.tsMs,
      publicKeyJwkByMachine: { alpha: key.publicKeyJwk },
      verifiedDigests: cache,
    });
    expect(first.flags).toHaveLength(0);
    expect(cache.size).toBe(1);

    // Proves the cache is actually consulted rather than merely populated: the SAME bytes are now
    // presented with a key that cannot verify them. Un-cached, this is signature-invalid.
    const otherKey = await freshKey('gamma');
    const second = await crossCheckAuditLog([entry], {
      nowMs: entry.tsMs,
      publicKeyJwkByMachine: { alpha: otherKey.publicKeyJwk },
      verifiedDigests: cache,
    });
    expect(second.flags.filter((f) => f.kind === 'signature-invalid')).toHaveLength(0);
  });

  test('a failed verification is never cached, so it is re-flagged every pass', async () => {
    const key = await freshKey('alpha');
    const entry = await makeEntry('alpha', key, 1, AUDIT_KIND_JOB_ISSUED, { jobId: 'j1', targetMachine: 'beta' });
    const tampered: AuditEntry = { ...entry, detail: { jobId: 'j1', targetMachine: 'attacker' } };
    const cache = new Set<string>();
    const opts = { nowMs: entry.tsMs, publicKeyJwkByMachine: { alpha: key.publicKeyJwk }, verifiedDigests: cache };

    const first = await crossCheckAuditLog([tampered], opts);
    const second = await crossCheckAuditLog([tampered], opts);

    expect(first.flags.filter((f) => f.kind === 'signature-invalid')).toHaveLength(1);
    expect(second.flags.filter((f) => f.kind === 'signature-invalid')).toHaveLength(1);
    expect(cache.size).toBe(0);
  });
});

describe('crossCheckAuditLog', () => {
  test('flags a tampered entry (detail changed after signing)', async () => {
    const key = await freshKey('alpha');
    const entry = await makeEntry('alpha', key, 1, AUDIT_KIND_JOB_ISSUED, { jobId: 'j1', targetMachine: 'beta' });
    const tampered: AuditEntry = { ...entry, detail: { jobId: 'j1', targetMachine: 'attacker' } };

    const report = await crossCheckAuditLog([tampered], {
      nowMs: entry.tsMs,
      publicKeyJwkByMachine: { 'alpha': key.publicKeyJwk },
    });

    expect(report.flags).toHaveLength(1);
    expect(report.flags[0]!.kind).toBe('signature-invalid');
    expect(report.flags[0]!.machine).toBe('alpha');
  });

  test('does not flag signature-invalid for a machine with no known public key supplied, but flags unverifiable-signer instead', async () => {
    const key = await freshKey('alpha');
    const entry = await makeEntry('alpha', key, 1, AUDIT_KIND_JOB_ISSUED, { jobId: 'j1', targetMachine: 'beta' });
    const report = await crossCheckAuditLog([entry], { nowMs: entry.tsMs, publicKeyJwkByMachine: {} });
    expect(report.flags.filter((f) => f.kind === 'signature-invalid')).toHaveLength(0);
    const unverifiable = report.flags.filter((f) => f.kind === 'unverifiable-signer');
    expect(unverifiable).toHaveLength(1);
    expect(unverifiable[0]!.machine).toBe('alpha');
  });

  test('a fabricated job-issued from an unenrolled machine cannot launder a compromised target execution (fail closed)', async () => {
    // Exact shape of the blind-review exploit: a compromised target self-signs a real
    // job-executed entry claiming origin 'ghost', and separately fabricates a job-issued entry
    // under the unenrolled name 'ghost'. Only the target's key is in the trusted map (as it
    // would be in production: 'ghost' was never enrolled). Before the fix, the ghost issuance
    // was silently skipped by the signature pass yet still satisfied the execution match, so the
    // fabricated execution produced zero flags. After the fix, the ghost issuance is excluded
    // from matching, and the execution is correctly flagged as unissued.
    const targetKey = await freshKey('beta');
    const ghostKey = await freshKey('ghost'); // stands in for an attacker-controlled, unenrolled identity
    const ghostIssuance = await makeEntry('ghost', ghostKey, 1, AUDIT_KIND_JOB_ISSUED, {
      jobId: 'laundered-job',
      targetMachine: 'beta',
    });
    const compromisedExec = await makeEntry('beta', targetKey, 1, AUDIT_KIND_JOB_EXECUTED, {
      jobId: 'laundered-job',
      originMachine: 'ghost',
    });

    const report = await crossCheckAuditLog([ghostIssuance, compromisedExec], {
      nowMs: compromisedExec.tsMs,
      publicKeyJwkByMachine: { beta: targetKey.publicKeyJwk }, // 'ghost' deliberately absent -- unenrolled
    });

    const unissued = report.flags.filter((f) => f.kind === 'execution-unissued');
    expect(unissued).toHaveLength(1);
    expect(unissued[0]!.jobId).toBe('laundered-job');
    expect(unissued[0]!.machine).toBe('beta');

    const unverifiable = report.flags.filter((f) => f.kind === 'unverifiable-signer');
    expect(unverifiable.some((f) => f.machine === 'ghost')).toBe(true);
  });

  test('flags a seq gap', async () => {
    const key = await freshKey('alpha');
    const e1 = await makeEntry('alpha', key, 1, AUDIT_KIND_JOB_ISSUED, { jobId: 'j1', targetMachine: 'beta' }, 1000);
    const e4 = await makeEntry('alpha', key, 4, AUDIT_KIND_JOB_ISSUED, { jobId: 'j2', targetMachine: 'beta' }, 2000);

    const report = await crossCheckAuditLog([e1, e4], {
      nowMs: 2000,
      publicKeyJwkByMachine: { 'alpha': key.publicKeyJwk },
    });

    const gaps = report.flags.filter((f) => f.kind === 'seq-gap');
    expect(gaps).toHaveLength(1);
    expect(gaps[0]!.seqRange).toEqual({ fromExclusive: 1, toExclusive: 4 });
  });

  test('does not flag a contiguous seq run', async () => {
    const key = await freshKey('alpha');
    const e1 = await makeEntry('alpha', key, 1, AUDIT_KIND_JOB_ISSUED, { jobId: 'j1', targetMachine: 'beta' });
    const e2 = await makeEntry('alpha', key, 2, AUDIT_KIND_JOB_ISSUED, { jobId: 'j2', targetMachine: 'beta' });
    const e3 = await makeEntry('alpha', key, 3, AUDIT_KIND_JOB_ISSUED, { jobId: 'j3', targetMachine: 'beta' });
    const report = await crossCheckAuditLog([e1, e2, e3], {
      nowMs: e1.tsMs,
      publicKeyJwkByMachine: { 'alpha': key.publicKeyJwk },
    });
    expect(report.flags.filter((f) => f.kind === 'seq-gap')).toHaveLength(0);
  });

  test('flags a target claiming execution of a job that was never issued', async () => {
    const laptopKey = await freshKey('beta');
    const execEntry = await makeEntry('beta', laptopKey, 1, AUDIT_KIND_JOB_EXECUTED, {
      jobId: 'ghost-job',
      originMachine: 'alpha',
    });

    const report = await crossCheckAuditLog([execEntry], {
      nowMs: execEntry.tsMs,
      publicKeyJwkByMachine: { beta: laptopKey.publicKeyJwk },
    });

    const flagged = report.flags.filter((f) => f.kind === 'execution-unissued');
    expect(flagged).toHaveLength(1);
    expect(flagged[0]!.jobId).toBe('ghost-job');
    expect(flagged[0]!.machine).toBe('beta');
  });

  test('does not flag a properly matched issue -> execute pair', async () => {
    const popKey = await freshKey('alpha');
    const laptopKey = await freshKey('beta');
    const issued = await makeEntry('alpha', popKey, 1, AUDIT_KIND_JOB_ISSUED, {
      jobId: 'job-1',
      targetMachine: 'beta',
      ttlSec: 3600,
    }, 1000);
    const executed = await makeEntry('beta', laptopKey, 1, AUDIT_KIND_JOB_EXECUTED, {
      jobId: 'job-1',
      originMachine: 'alpha',
    }, 1500);

    const report = await crossCheckAuditLog([issued, executed], {
      nowMs: 2000,
      publicKeyJwkByMachine: { 'alpha': popKey.publicKeyJwk, beta: laptopKey.publicKeyJwk },
    });

    expect(report.flags).toHaveLength(0);
  });

  test('flags a silent issuance only once its TTL has elapsed', async () => {
    const key = await freshKey('alpha');
    const issued = await makeEntry(
      'alpha',
      key,
      1,
      AUDIT_KIND_JOB_ISSUED,
      { jobId: 'job-1', targetMachine: 'beta', ttlSec: 3600 },
      1_000_000,
    );

    const beforeDeadline = await crossCheckAuditLog([issued], {
      nowMs: 1_000_000 + 3600 * 1000 - 1,
      publicKeyJwkByMachine: { 'alpha': key.publicKeyJwk },
    });
    expect(beforeDeadline.flags.filter((f) => f.kind === 'issuance-silent')).toHaveLength(0);

    const afterDeadline = await crossCheckAuditLog([issued], {
      nowMs: 1_000_000 + 3600 * 1000 + 1,
      publicKeyJwkByMachine: { 'alpha': key.publicKeyJwk },
    });
    const flagged = afterDeadline.flags.filter((f) => f.kind === 'issuance-silent');
    expect(flagged).toHaveLength(1);
    expect(flagged[0]!.jobId).toBe('job-1');
    expect(flagged[0]!.machine).toBe('alpha');
  });

  test('an expired-status receipt counts as an answer, not silence', async () => {
    const popKey = await freshKey('alpha');
    const laptopKey = await freshKey('beta');
    const issued = await makeEntry(
      'alpha',
      popKey,
      1,
      AUDIT_KIND_JOB_ISSUED,
      { jobId: 'job-1', targetMachine: 'beta', ttlSec: 60 },
      1000,
    );
    const expired = await makeEntry('beta', laptopKey, 1, AUDIT_KIND_JOB_EXPIRED, {
      jobId: 'job-1',
      originMachine: 'alpha',
    }, 65000);

    const report = await crossCheckAuditLog([issued, expired], {
      nowMs: 10_000_000,
      publicKeyJwkByMachine: { 'alpha': popKey.publicKeyJwk, beta: laptopKey.publicKeyJwk },
    });
    expect(report.flags.filter((f) => f.kind === 'issuance-silent')).toHaveLength(0);
  });

  test('falls back to defaultTtlSec when detail.ttlSec is absent', async () => {
    const key = await freshKey('alpha');
    const issued = await makeEntry('alpha', key, 1, AUDIT_KIND_JOB_ISSUED, { jobId: 'job-1', targetMachine: 'beta' }, 0);

    // alpha must be in the trusted key map -- an issuance from an unenrolled machine is now
    // excluded from the issuance-silent matching pass entirely (see the fail-closed
    // unverifiable-signer fix above), so this needs a realistic map to exercise the TTL logic.
    const withinDefault = await crossCheckAuditLog([issued], {
      nowMs: 100 * 1000,
      publicKeyJwkByMachine: { 'alpha': key.publicKeyJwk },
      defaultTtlSec: 3600,
    });
    expect(withinDefault.flags.filter((f) => f.kind === 'issuance-silent')).toHaveLength(0);

    const pastDefault = await crossCheckAuditLog([issued], {
      nowMs: 3601 * 1000,
      publicKeyJwkByMachine: { 'alpha': key.publicKeyJwk },
      defaultTtlSec: 3600,
    });
    expect(pastDefault.flags.filter((f) => f.kind === 'issuance-silent')).toHaveLength(1);
  });

  test('flags both directions at once: silence, lying target, gap, and tamper together', async () => {
    const popKey = await freshKey('alpha');
    const laptopKey = await freshKey('beta');

    // alpha issues job-1 (never answered, past TTL) and job-3 (leaving a seq gap at 2).
    const issued1 = await makeEntry(
      'alpha',
      popKey,
      1,
      AUDIT_KIND_JOB_ISSUED,
      { jobId: 'job-1', targetMachine: 'beta', ttlSec: 60 },
      0,
    );
    const issued3 = await makeEntry(
      'alpha',
      popKey,
      3,
      AUDIT_KIND_JOB_ISSUED,
      { jobId: 'job-3', targetMachine: 'beta', ttlSec: 60 },
      0,
    );
    // beta claims it executed a job alpha never issued.
    const ghostExec = await makeEntry('beta', laptopKey, 1, AUDIT_KIND_JOB_EXECUTED, {
      jobId: 'ghost-job',
      originMachine: 'alpha',
    });
    // A tampered entry from beta.
    const tamperedBase = await makeEntry('beta', laptopKey, 2, AUDIT_KIND_JOB_EXECUTED, {
      jobId: 'job-3',
      originMachine: 'alpha',
    });
    const tampered: AuditEntry = { ...tamperedBase, detail: { jobId: 'job-3', originMachine: 'someone-else' } };

    const report = await crossCheckAuditLog([issued1, issued3, ghostExec, tampered], {
      nowMs: 1_000_000,
      publicKeyJwkByMachine: { 'alpha': popKey.publicKeyJwk, beta: laptopKey.publicKeyJwk },
    });

    const kinds = report.flags.map((f) => f.kind).sort();
    expect(kinds).toEqual(['execution-unissued', 'execution-unissued', 'issuance-silent', 'seq-gap', 'signature-invalid']);
    // job-3's real receipt was tampered, so it no longer matches job-3's issuance either --
    // both the tamper AND job-3 now reading as unanswered are expected, not a bug.
    const silentJobIds = report.flags.filter((f) => f.kind === 'issuance-silent').map((f) => f.jobId);
    expect(silentJobIds).toEqual(['job-1']);
  });

  test('an origin-self-reported job-expired (no receipt ever came back) counts as an answer, not silence', async () => {
    // Mirrors node.ts's actual TTL-sweep wiring: the ORIGIN, not the target, emits job-expired
    // when it gave up waiting for a receipt (machine=origin, detail.originMachine=origin,
    // detail.targetMachine=target). audit.ts's own header convention describes job-expired as
    // target-emitted, so without this case a genuinely-reported expiry reads as false silence.
    const popKey = await freshKey('alpha');
    const issued = await makeEntry(
      'alpha',
      popKey,
      1,
      AUDIT_KIND_JOB_ISSUED,
      { jobId: 'job-1', targetMachine: 'beta', ttlSec: 60 },
      1000,
    );
    const originExpired = await makeEntry('alpha', popKey, 2, AUDIT_KIND_JOB_EXPIRED, {
      jobId: 'job-1',
      originMachine: 'alpha',
      targetMachine: 'beta',
    }, 65000);

    const report = await crossCheckAuditLog([issued, originExpired], {
      nowMs: 10_000_000,
      publicKeyJwkByMachine: { 'alpha': popKey.publicKeyJwk },
    });
    expect(report.flags.filter((f) => f.kind === 'issuance-silent')).toHaveLength(0);
  });

  test('flags missing entries before the first observed seq (leading truncation)', async () => {
    const key = await freshKey('alpha');
    // Machine's earliest observed entry starts at seq 4 -- seq 1-3 are missing, either dropped
    // in transit/merge or truncated by a compromised machine hiding its own early history.
    const e4 = await makeEntry('alpha', key, 4, AUDIT_KIND_JOB_ISSUED, { jobId: 'j4', targetMachine: 'beta' });
    const e5 = await makeEntry('alpha', key, 5, AUDIT_KIND_JOB_ISSUED, { jobId: 'j5', targetMachine: 'beta' });

    const report = await crossCheckAuditLog([e4, e5], {
      nowMs: e4.tsMs,
      publicKeyJwkByMachine: { 'alpha': key.publicKeyJwk },
    });

    const gaps = report.flags.filter((f) => f.kind === 'seq-gap');
    expect(gaps).toHaveLength(1);
    expect(gaps[0]!.seqRange).toEqual({ fromExclusive: 0, toExclusive: 4 });
  });

  test('flags a same-(machine,seq) fork -- two conflicting entries signed at one seq', async () => {
    const key = await freshKey('beta');
    const e1a = await makeEntry('beta', key, 1, AUDIT_KIND_JOB_EXECUTED, { jobId: 'job-1', originMachine: 'alpha' });
    // A conflicting second entry at the SAME seq, signed by the same (compromised) key, claiming
    // a different job entirely -- an honest appender never reuses a seq.
    const e1b = await makeEntry('beta', key, 1, AUDIT_KIND_JOB_EXECUTED, { jobId: 'job-2', originMachine: 'alpha' });

    const report = await crossCheckAuditLog([e1a, e1b], {
      nowMs: e1a.tsMs,
      publicKeyJwkByMachine: { beta: key.publicKeyJwk },
    });

    const forks = report.flags.filter((f) => f.kind === 'seq-fork');
    expect(forks).toHaveLength(1);
    expect(forks[0]!.machine).toBe('beta');
  });

  test('does not flag a fork for exact duplicate entries at the same seq', async () => {
    const key = await freshKey('alpha');
    const e1 = await makeEntry('alpha', key, 1, AUDIT_KIND_JOB_ISSUED, { jobId: 'j1', targetMachine: 'beta' });

    const report = await crossCheckAuditLog([e1, e1], {
      nowMs: e1.tsMs,
      publicKeyJwkByMachine: { 'alpha': key.publicKeyJwk },
    });
    expect(report.flags.filter((f) => f.kind === 'seq-fork')).toHaveLength(0);
  });
});
