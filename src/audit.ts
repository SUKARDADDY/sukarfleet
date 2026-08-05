// SPDX-License-Identifier: AGPL-3.0-or-later
// Append-only, per-machine-sequenced signed audit log (p2-exec-audit). Owns:
//
//  - AuditLog: local append. State-dir-persisted (mirrors gossip.ts's seq-file pattern), a
//    strictly monotonic per-machine `seq` minted before every entry, every entry signed via
//    trust.ts's signAuditEntry (house pattern #2 -- nobody reimplements JSON signing here).
//
//  - regenerateUnionLog: the canonical regenerator. syncer.ts's postMerge / derive.ts's
//    postMerge-in-worktree machinery (see both files' `postMerge: string[][]` contract) is
//    expected to run a small script that calls into this after every merge touching the audit
//    unionPath file. It sorts+dedups by (machine,seq) and rewrites byte-deterministically, so
//    two machines that independently appended entries and then git-merged (raw line-union via
//    `git merge-file --union`, which can leave duplicate/out-of-order lines but never silently
//    drops one side) converge on identical bytes -- the same byte-identity contract derive.ts
//    already guarantees for the rest of a repo's union paths.
//
//  - flushLocalToUnion: copies this machine's not-yet-flushed local entries into a unionPath
//    file living inside a synced repo, then regenerates it. Idempotent (regenerateUnionLog
//    dedups by (machine,seq)), so it is safe to call every sync tick with no separate
//    "already flushed up to here" cursor to keep consistent.
//
//  - crossCheckAuditLog: a pure reader over an assembled entry set (local + every peer's synced
//    entries) that flags: (a) an execution/expiry entry claiming a job whose issuer never
//    recorded issuing it (a lying/compromised target), (b) an issuance with no matching
//    execution/expiry entry once its TTL has passed ("silence"), (c) per-machine seq gaps, and
//    (d) signature tampering against caller-supplied trusted public keys. Both directions of
//    (a)/(b) are covered, matching the plan's "bidirectional issuance<->execution cross-check".
//
// File format: JSONL -- one canonicalJson(AuditEntry) per line, trailing newline on every line
// including the last. JSONL (not a JSON array) is what lets git's line-based union merge
// concatenate two machines' appends without a conflict on the common case; regenerateUnionLog
// is what turns whatever raw soup that produces back into a canonical file.

import { join } from 'node:path';
import { open, rm, stat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import type { AuditEntry, MachineKey } from './types';
import { atomicWrite, canonicalJson, ensureDir, log, nowMs, sleep } from './util';
import { stateDir } from './config';
import { signAuditEntry, verifyAuditEntry } from './trust';

// Conventional AuditEntry.kind values used by the cross-check reader below. `kind` stays a
// plain string on the wire (types.ts's AuditEntry deliberately does not close the union so other
// lanes can add kinds without editing shared files) -- these are exported so jobqueue.ts /
// executor.ts / membership.ts / policy.ts can share the same literal instead of hand-typing it.
export const AUDIT_KIND_JOB_ISSUED = 'job-issued';
export const AUDIT_KIND_JOB_EXECUTED = 'job-executed';
export const AUDIT_KIND_JOB_EXPIRED = 'job-expired';
export const AUDIT_KIND_MEMBERSHIP_UPDATE = 'membership-update';
export const AUDIT_KIND_POLICY_REFUSAL = 'policy-refusal';
export const AUDIT_KIND_WITNESS_CONFIRM = 'witness-confirm';

// SSH admin lane (p3-ssh-admin). Split across the two machines on purpose: the origin appends
// admin-run-requested before dialling and admin-run-completed after, the target appends its own
// admin-run-completed, so a leg that never happened shows up in the synced union file as an
// unmatched entry rather than as silence.
export const AUDIT_KIND_ADMIN_RUN_REQUESTED = 'admin-run-requested';
export const AUDIT_KIND_ADMIN_RUN_COMPLETED = 'admin-run-completed';
export const AUDIT_KIND_ADMIN_RUN_REFUSED = 'admin-run-refused';
export const AUDIT_KIND_PAIR_ACCEPTED = 'pair-accepted';
export const AUDIT_KIND_CREDENTIAL_SET = 'credential-set';
export const AUDIT_KIND_CREDENTIAL_REMOVED = 'credential-removed';
export const AUDIT_KIND_CREDENTIAL_STALE = 'credential-stale';

// admin-* detail contract, binding on every producer:
//   admin-run-requested: { runId, targetMachine, argv: string[], reason, requestedBy, timeoutSec }
//   admin-run-completed: { runId, originMachine|targetMachine, argv, exitCode, durationMs,
//                          transport, stdoutBytes, stderrBytes, truncated }
//   admin-run-refused:   { runId, targetMachine, argv, reason, refusal: AdminRefusalReason }
//   pair-accepted:       { peerMachine, sshKeyFingerprint, mode }
//   credential-*:        { user } -- and nothing else
//
// Two content rules, and this file is the last place they can be enforced by convention before
// the entries are signed and git-synced to every machine:
//   1. Record the FULL argv. A truncated argv makes the log unusable as forensics, and argv is
//      not secret -- the credential broker never puts a password in one.
//   2. NEVER record stdout/stderr CONTENT, only byte counts. The union file is replicated to
//      every machine and pushed to GitHub; command output is exactly the sink a captured secret
//      would leak through. Likewise never record a password, its hash, or its length.

// job-issued detail convention (origin side): { jobId: string, targetMachine: string, ttlSec?: number }
// job-executed / job-expired detail convention (target/receipt side): { jobId: string, originMachine: string }
// crossCheckAuditLog reads exactly these fields out of `detail`; entries from lanes that don't
// populate them are simply invisible to the job-matching checks (seq-gap and signature checks
// still apply to every entry regardless of kind).

function localLogPath(): string {
  return join(stateDir(), 'audit-log.jsonl');
}

function seqPath(): string {
  return join(stateDir(), 'audit-seq.json');
}

function seqLockPath(): string {
  return join(stateDir(), 'audit-seq.lock');
}

async function readSeqFile(): Promise<number> {
  const file = Bun.file(seqPath());
  if (!(await file.exists())) return 0;
  try {
    const data = JSON.parse(await file.text()) as { seq?: unknown };
    return Number.isInteger(data.seq) && (data.seq as number) >= 0 ? (data.seq as number) : 0;
  } catch {
    return 0;
  }
}

const SEQ_LOCK_WAIT_MS = 5_000;
const SEQ_LOCK_STALE_MS = 30_000;

// A lock FILE, not an in-process mutex: the two writers are separate processes (daemon and SSH
// forced command), so an in-memory guard cannot see the other side. O_EXCL create is the
// primitive both agree on without a dependency.
//
// A lock older than SEQ_LOCK_STALE_MS is treated as a crashed holder and broken. That is the
// deliberate trade: a killed process must never permanently wedge minting, because a run this
// machine cannot record is a run it does not perform (cli.ts) -- an audit lane that deadlocks
// takes the admin lane down with it.
async function withSeqLock<T>(fn: () => Promise<T>): Promise<T> {
  const lock = seqLockPath();
  await ensureDir(stateDir());
  const deadline = nowMs() + SEQ_LOCK_WAIT_MS;
  for (;;) {
    try {
      const fh = await open(lock, 'wx');
      await fh.close();
      break;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
      let brokeStale = false;
      try {
        const st = await stat(lock);
        if (nowMs() - st.mtimeMs > SEQ_LOCK_STALE_MS) {
          await rm(lock, { force: true });
          brokeStale = true;
        }
      } catch {
        // Vanished between EEXIST and stat: the holder just released it, so retry immediately.
        continue;
      }
      if (brokeStale) continue;
      if (nowMs() > deadline) {
        throw new Error(`audit: timed out waiting for the seq lock at ${lock}`);
      }
      await sleep(20);
    }
  }
  try {
    return await fn();
  } finally {
    await rm(lock, { force: true });
  }
}

// C-locale/codepoint order, never locale-dependent -- this is the sort that feeds the
// regenerator's output bytes. Duplicated locally rather than imported: syncer.ts and derive.ts
// each keep their own copy of this exact helper too (util.ts intentionally keeps it private).
function codepointCompare(a: string, b: string): number {
  const ai = Array.from(a);
  const bi = Array.from(b);
  const len = Math.min(ai.length, bi.length);
  for (let i = 0; i < len; i++) {
    const ac = ai[i]!.codePointAt(0)!;
    const bc = bi[i]!.codePointAt(0)!;
    if (ac !== bc) return ac - bc;
  }
  return ai.length - bi.length;
}

function isAuditEntryShape(v: unknown): v is AuditEntry {
  if (typeof v !== 'object' || v === null) return false;
  const o = v as Record<string, unknown>;
  return (
    o.v === 1 &&
    typeof o.machine === 'string' &&
    o.machine.length > 0 &&
    Number.isInteger(o.seq) &&
    (o.seq as number) >= 0 &&
    typeof o.tsMs === 'number' &&
    Number.isFinite(o.tsMs) &&
    typeof o.kind === 'string' &&
    o.kind.length > 0 &&
    typeof o.detail === 'object' &&
    o.detail !== null &&
    !Array.isArray(o.detail) &&
    typeof o.sigB64 === 'string'
  );
}

function parseJsonlLines(raw: string): { entries: AuditEntry[]; malformed: number } {
  const entries: AuditEntry[] = [];
  let malformed = 0;
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    try {
      const value: unknown = JSON.parse(trimmed);
      if (isAuditEntryShape(value)) {
        entries.push(value);
      } else {
        malformed++;
      }
    } catch {
      malformed++;
    }
  }
  return { entries, malformed };
}

async function readJsonlFile(path: string): Promise<{ raw: string; entries: AuditEntry[]; malformed: number }> {
  const file = Bun.file(path);
  const raw = (await file.exists()) ? await file.text() : '';
  const { entries, malformed } = parseJsonlLines(raw);
  return { raw, entries, malformed };
}

// Appends one already-serialized JSONL line to `path`, creating it (and parent dirs, via
// util.atomicWrite) if absent. Read-modify-write + atomic rename, matching the rest of the
// codebase's no-partial-write house style (util.atomicWrite, health.ts's persist(), gossip.ts's
// nextSeq()) rather than a raw fs append, which can interleave with a crash mid-write.
async function appendLineAtomic(path: string, canonicalLine: string): Promise<void> {
  const file = Bun.file(path);
  const existing = (await file.exists()) ? await file.text() : '';
  const sep = existing.length > 0 && !existing.endsWith('\n') ? '\n' : '';
  await atomicWrite(path, existing + sep + canonicalLine + '\n');
}

// Local, per-machine append-only audit log. `machine`/`key` bind every minted entry to this
// machine's identity and signing key.
//
// NOT one instance per machine: cli.ts's defaultExecLocalAdmin (the SSH forced command) builds
// its own AuditLog in a short-lived PROCESS every time this machine is the target of an admin
// run, while the daemon holds one for its whole lifetime. Both mint from the same state dir, so
// seq minting has to be safe across processes -- see nextSeq.
export class AuditLog {
  private seqValue = 0;

  constructor(
    private readonly machine: string,
    private readonly key: MachineKey,
  ) {}

  // Re-reads the counter under an exclusive lock on EVERY mint. Caching it in memory was a
  // lost update: the daemon kept a stale value while the forced-command process advanced the
  // file, then re-minted a seq that was already taken. The two entries reached the union file
  // sharing one (machine, seq) -- indistinguishable from a stolen key signing a second entry,
  // which is precisely the condition regenerateUnionLog exists to alarm on. 33 such pairs
  // accumulated on the live fleet before anyone read the journal.
  private async nextSeq(): Promise<number> {
    return await withSeqLock(async () => {
      // The in-memory value is a floor, never the source of truth: it only defends against a
      // counter file truncated or rolled back underneath a running process.
      const next = Math.max(await readSeqFile(), this.seqValue) + 1;
      await atomicWrite(seqPath(), canonicalJson({ seq: next }));
      this.seqValue = next;
      return next;
    });
  }

  // Mints the next per-machine seq, signs, and durably appends a new AuditEntry. `tsMsArg` is an
  // injectable-clock test seam; production callers omit it and get nowMs().
  async append(kind: string, detail: Record<string, unknown>, tsMsArg?: number): Promise<AuditEntry> {
    const seq = await this.nextSeq();
    const unsigned: Omit<AuditEntry, 'sigB64'> = {
      v: 1,
      machine: this.machine,
      seq,
      tsMs: tsMsArg ?? nowMs(),
      kind,
      detail,
    };
    const entry = await signAuditEntry(unsigned, this.key);
    await appendLineAtomic(localLogPath(), canonicalJson(entry));
    return entry;
  }

  // Every entry this machine has locally appended, in seq order (a single machine's own log is
  // append-only in seq order already, so no re-sort is needed here).
  async readAll(): Promise<AuditEntry[]> {
    const { entries } = await readJsonlFile(localLogPath());
    return entries;
  }
}

function forkBaselinePath(): string {
  return join(stateDir(), 'audit-fork-baseline.json');
}

// Identifies the SET of distinct lines under one (machine, seq). Accepting a fork accepts
// exactly the variants present when the baseline was taken: if a THIRD line later joins that
// key, the fingerprint changes and it alarms again. Keyed by content, not by position, so it
// survives regeneration and says nothing about line order.
function forkFingerprint(key: string, variantBytes: string[]): string {
  const h = createHash('sha256');
  h.update(key);
  for (const bytes of [...variantBytes].sort()) {
    h.update('\0');
    h.update(bytes);
  }
  return h.digest('hex');
}

// Forks this machine has been told are known-benign. MACHINE-LOCAL on purpose, never a synced
// path: an attacker who can write the shared repo can plant forked lines, and must not also be
// able to ship the file that declares them acceptable.
export async function loadForkBaseline(): Promise<Set<string>> {
  const file = Bun.file(forkBaselinePath());
  if (!(await file.exists())) return new Set();
  try {
    const data = JSON.parse(await file.text()) as { fingerprints?: unknown };
    if (!Array.isArray(data.fingerprints)) return new Set();
    return new Set(data.fingerprints.filter((f): f is string => typeof f === 'string'));
  } catch {
    // An unreadable baseline accepts NOTHING. Failing open would silence the alarm exactly when
    // the file guarding it has been corrupted.
    return new Set();
  }
}

export async function writeForkBaseline(fingerprints: readonly string[]): Promise<void> {
  await atomicWrite(forkBaselinePath(), canonicalJson({ v: 1, fingerprints: [...fingerprints].sort() }));
}

export interface RegenerateResult {
  entries: AuditEntry[]; // final canonical entries, sorted by (machine, seq)
  changed: boolean; // whether the on-disk bytes were rewritten
  droppedDuplicates: number; // (machine,seq) keys that had more than one line
  droppedMalformed: number; // lines that were not valid JSON or not AuditEntry-shaped
  // (machine,seq) keys where the duplicate lines were NOT byte-identical -- i.e. two distinct
  // signed entries claim the same seq (a forked/compromised key, since an honest appender only
  // ever mints a given seq once, together with the entry). A "duplicate" with no fork is just the
  // same line appearing twice (e.g. from a repeated flushLocalToUnion); a fork is a real conflict.
  // The tie-break (keep lexicographically smallest canonicalJson bytes) still applies so the
  // regenerator stays a pure, byte-deterministic function of the line *set*, but a fork is
  // surfaced here (and via a `seq-fork` crossCheckAuditLog flag) rather than silently resolved.
  conflictingForks: number;
  // Every fork found, with the fingerprint the baseline matches on. Callers that want to accept
  // the current state (audit-baseline.ts) write exactly these.
  forks: ForkRecord[];
  // Forks NOT in this machine's baseline -- the count that actually warns.
  unacceptedForks: number;
}

export interface ForkRecord {
  key: string; // "<machine> <seq>"
  fingerprint: string;
}

// The canonical regenerator (house pattern #10-equivalent for the audit unionPath, mirroring
// derive.ts's byte-identity contract): reads whatever raw JSONL is currently at `path`
// (typically the result of git's line-union merge across two or more machines' appends, which
// can contain duplicate and out-of-order lines but never drops a line outright), and rewrites it
// as one line per distinct (machine,seq), sorted by machine (codepoint) then seq (numeric).
//
// Duplicate (machine,seq) keys are deduped by keeping the lexicographically smallest
// canonicalJson encoding. Honest appenders never produce two different entries for the same
// (machine,seq) -- seq is minted once, at mint time, together with the entry -- so in practice a
// "duplicate" is always byte-identical and this tie-break never fires. It exists so the function
// stays a pure function of the *set* of lines present (not of the order two machines happened to
// merge them in): two independent appenders that end up with the same raw line set, in whatever
// order, always regenerate to identical bytes, which is the acceptance bar for this file.
export async function regenerateUnionLog(path: string): Promise<RegenerateResult> {
  const { raw, entries: parsed, malformed } = await readJsonlFile(path);

  const groups = new Map<string, Array<{ entry: AuditEntry; bytes: string }>>();
  for (const entry of parsed) {
    const key = `${entry.machine} ${entry.seq}`;
    const bytes = canonicalJson(entry);
    const list = groups.get(key);
    if (list) list.push({ entry, bytes });
    else groups.set(key, [{ entry, bytes }]);
  }

  // Dedupe only BYTE-IDENTICAL lines. Two different entries sharing a (machine, seq) key are a
  // FORK, not a duplicate: keeping one and silently dropping the other let anyone with write
  // access to the shared repo evict a genuine signed entry by appending a line with the same key
  // and lexicographically smaller bytes (an unsigned entry with sigB64:"" sorts below almost
  // anything, and isAuditEntryShape accepts an empty signature). Preserving every distinct line
  // keeps the evidence in the file, where crossCheckAuditLog's seq-fork detection can flag it --
  // erasing one side made the tamper invisible in the very artifact meant to record it.
  const kept: { entry: AuditEntry; bytes: string }[] = [];
  let duplicates = 0;
  const forks: ForkRecord[] = [];
  for (const [key, list] of groups) {
    const distinct = new Map<string, { entry: AuditEntry; bytes: string }>();
    for (const x of list) if (!distinct.has(x.bytes)) distinct.set(x.bytes, x);
    duplicates += list.length - distinct.size;
    if (distinct.size > 1) forks.push({ key, fingerprint: forkFingerprint(key, [...distinct.keys()]) });
    for (const x of distinct.values()) kept.push(x);
  }
  const conflictingForks = forks.length;

  const sorted = kept.sort((a, b) => {
    const mc = codepointCompare(a.entry.machine, b.entry.machine);
    if (mc !== 0) return mc;
    if (a.entry.seq !== b.entry.seq) return a.entry.seq - b.entry.seq;
    // Deterministic order among the retained sides of a fork, so every machine regenerates
    // byte-identical output (the union file's whole convergence property).
    return codepointCompare(a.bytes, b.bytes);
  });

  const finalContent = sorted.length > 0 ? sorted.map((s) => s.bytes).join('\n') + '\n' : '';
  const changed = finalContent !== raw;
  if (changed) await atomicWrite(path, finalContent);

  if (malformed > 0) {
    log('warn', 'audit: regenerator dropped malformed line(s)', { path, malformed });
  }
  // Only forks this machine has NOT accepted are worth waking someone for. A permanently-firing
  // alarm is a disabled alarm: the live fleet carried 33 benign forks (a since-fixed seq-minting
  // race, see nextSeq) and they drowned the signal that a genuinely forked key would raise.
  const accepted = await loadForkBaseline();
  const unacceptedForks = forks.filter((f) => !accepted.has(f.fingerprint));
  if (unacceptedForks.length > 0) {
    log('warn', 'audit: regenerator found conflicting same-(machine,seq) entries (possible key compromise/fork)', {
      path,
      conflictingForks: unacceptedForks.length,
      acceptedForks: conflictingForks - unacceptedForks.length,
      keys: unacceptedForks.map((f) => f.key).slice(0, 10),
    });
  }

  return {
    entries: sorted.map((s) => s.entry),
    changed,
    droppedDuplicates: duplicates,
    droppedMalformed: malformed,
    conflictingForks,
    forks,
    unacceptedForks: unacceptedForks.length,
  };
}

// Copies every entry from this machine's local append-only log into the unionPath file at
// `unionPath` (created if absent), then regenerates it canonically. Safe to call every sync
// tick: regenerateUnionLog's dedup-by-(machine,seq) makes re-appending already-present entries a
// no-op, so no separate "flushed up to seq N" cursor is needed. Call this before syncer.ts's
// autoCommit step so the union file's update rides the same commit as everything else that
// cycle (wiring left to node.ts, which owns the sync-loop/postMerge argv).
export async function flushLocalToUnion(unionPath: string): Promise<RegenerateResult> {
  const local = await readJsonlFile(localLogPath());
  if (local.entries.length > 0) {
    const lines = local.entries.map((e) => canonicalJson(e)).join('\n');
    const existing = await Bun.file(unionPath).exists() ? await Bun.file(unionPath).text() : '';
    const sep = existing.length > 0 && !existing.endsWith('\n') ? '\n' : '';
    await atomicWrite(unionPath, existing + sep + lines + '\n');
  }
  return regenerateUnionLog(unionPath);
}

export type CrossCheckFlagKind =
  | 'signature-invalid'
  | 'unverifiable-signer'
  | 'seq-gap'
  | 'seq-fork'
  | 'issuance-silent'
  | 'execution-unissued';

export interface CrossCheckFlag {
  kind: CrossCheckFlagKind;
  machine: string; // machine the flag concerns
  detail: string; // human-readable explanation, suitable for cli.ts's `audit tail`/operator surfaces
  entry?: AuditEntry; // the offending entry, when the flag is about one specific entry
  jobId?: string; // populated for issuance-silent / execution-unissued
  seqRange?: { fromExclusive: number; toExclusive: number }; // populated for seq-gap
}

export interface CrossCheckReport {
  flags: CrossCheckFlag[];
}

export interface CrossCheckOptions {
  // Caller-supplied clock (typically util.nowMs()) -- crossCheckAuditLog never reads the wall
  // clock itself so callers/tests can pin "now" exactly.
  nowMs: number;
  // Public keys for signature verification, keyed by machine name. audit.ts does not own
  // membership.ts, so it cannot resolve a machine's trusted key itself; callers pass
  // MembershipList.members' publicKeyJwk here. A machine absent from this map is NOT trusted:
  // fail CLOSED (house pattern #4) -- its entries are flagged `unverifiable-signer` and excluded
  // from the issuance<->execution matching passes below, since nothing vouches for what an
  // unenrolled identity claims (see the `unverifiable-signer` doc below for the exact laundering
  // attack this closes).
  publicKeyJwkByMachine: Record<string, JsonWebKey>;
  // Fallback TTL (seconds) for a job-issued entry whose detail.ttlSec is missing/invalid.
  // Callers normally pass cfg.exec.thresholds.jobTtlSec (pinned default 3600).
  defaultTtlSec?: number;
  // Fork fingerprints this machine has already been told are benign -- loadForkBaseline(). Without
  // this, the reader re-raises every historical fork on every pass: the live fleet carried 33 from
  // a since-fixed seq-minting race (see nextSeq), and an alarm that always fires is an alarm
  // nobody reads. Matched exactly the way regenerateUnionLog matches them, so "accepted" means the
  // same thing on both paths -- and a fork that gains a THIRD variant changes fingerprint and
  // alarms again, which is the property that makes accepting one safe.
  acceptedForkFingerprints?: ReadonlySet<string>;
  // Caller-owned cache of canonical-bytes digests already known to verify. READ AND UPDATED IN
  // PLACE. Entries are immutable once signed, so a digest that verified once verifies forever;
  // anything whose bytes differ is a different entry and gets checked. Without it every pass
  // re-verifies the whole log (~0.12ms/entry -- fine at 243 entries, over a second at ten
  // thousand, and this file only grows). Failures are never cached: a bad entry is re-flagged
  // every pass until it is gone.
  verifiedDigests?: Set<string>;
}

function entryDigest(canonicalBytes: string): string {
  return createHash('sha256').update(canonicalBytes).digest('hex');
}

// Bidirectional issuance<->execution cross-check reader over an already-assembled entry set
// (the caller merges local + every peer's synced entries first -- audit.ts has no opinion on
// where entries came from). Never throws: signature checks reuse trust.ts's never-throw
// verifyAuditEntry, and every other check here is pure data inspection. Flags:
//   (a) execution-unissued -- a job-executed/job-expired entry claims an origin machine that
//       never recorded a matching, TRUSTED job-issued entry for that jobId (a lying/compromised
//       target, or an origin that dropped its own issuance record). An issuance from an
//       unenrolled machine never counts as a match (see `unverifiable-signer`) -- otherwise a
//       compromised target could launder an unauthorized execution by fabricating a matching
//       job-issued entry under a made-up, unenrolled machine name.
//   (b) issuance-silent -- a job-issued entry has no matching job-executed/job-expired entry
//       from its declared target machine (or a self-reported job-expired from the issuing/origin
//       machine itself -- see below), and its TTL has elapsed as of `opts.nowMs`.
//   (c) seq-gap -- a machine's observed seq numbers skip one or more values, INCLUDING missing
//       entries before the first observed seq (AuditLog.nextSeq always starts a machine's log at
//       1, so a lowest-observed seq >1 means the earliest entries are missing -- dropped in
//       transit/merge, or a compromised machine truncating its own history). Trailing truncation
//       (a machine silently dropping its most recent entries) is NOT detectable from the entry
//       set alone -- there is nothing here to compare against -- and is out of scope for this
//       pure reader; closing it needs a persisted per-machine high-water-mark the caller supplies,
//       which is a node.ts/caller-layer amendment, not something crossCheckAuditLog can infer.
//   (d) signature-invalid -- an entry's signature does not verify against the machine's known,
//       enrolled public key (tampering by a compromised key).
//   (e) unverifiable-signer -- an entry claims a machine with no known enrolled public key in
//       `opts.publicKeyJwkByMachine`. Nothing vouches for this identity, so the entry is flagged
//       and excluded from the (a)/(b) matching passes (fail closed) rather than silently trusted
//       the way an absent key used to be treated.
//   (f) seq-fork -- two or more entries from the same machine share the same seq but are NOT
//       byte-identical (a compromised/forked key signing conflicting history at a seq that an
//       honest appender only ever mints once).
export async function crossCheckAuditLog(entries: AuditEntry[], opts: CrossCheckOptions): Promise<CrossCheckReport> {
  const flags: CrossCheckFlag[] = [];
  const defaultTtlSec = opts.defaultTtlSec ?? 3600;

  // (d)/(e) signature verification + unknown-signer detection. Entries from a machine absent
  // from publicKeyJwkByMachine are untrusted outright (fail closed) and excluded from
  // `trustedForMatching` below. Entries from a KNOWN machine whose signature fails to verify are
  // still flagged, but -- to keep tamper evidence visible in the (a)/(b) passes too (a tampered
  // detail can itself produce a mismatched execution-unissued/issuance-silent flag, which is
  // useful corroborating signal, not noise) -- they remain in `trustedForMatching`, matching the
  // pre-existing behavior for known-but-tampered entries.
  // Canonical bytes are needed twice (verification cache key, and same-seq fork comparison), and
  // canonicalJson is not free -- encode each entry once.
  const bytesOf = new Map<AuditEntry, string>();
  for (const entry of entries) bytesOf.set(entry, canonicalJson(entry));

  const trustedForMatching = new Set<AuditEntry>();
  for (const entry of entries) {
    const pub = opts.publicKeyJwkByMachine[entry.machine];
    if (!pub) {
      flags.push({
        kind: 'unverifiable-signer',
        machine: entry.machine,
        entry,
        detail: `${entry.machine}#${entry.seq} (kind=${entry.kind}) claims a machine with no known enrolled public key -- excluded from issuance<->execution matching`,
      });
      continue;
    }
    const digest = entryDigest(bytesOf.get(entry)!);
    if (opts.verifiedDigests?.has(digest)) {
      trustedForMatching.add(entry);
      continue;
    }
    const ok = await verifyAuditEntry(entry, pub);
    if (ok) {
      opts.verifiedDigests?.add(digest);
    } else {
      flags.push({
        kind: 'signature-invalid',
        machine: entry.machine,
        entry,
        detail: `${entry.machine}#${entry.seq} (kind=${entry.kind}) failed signature verification`,
      });
    }
    trustedForMatching.add(entry);
  }

  // (c)/(f) seq gaps and same-seq forks, per machine.
  const byMachine = new Map<string, AuditEntry[]>();
  for (const entry of entries) {
    const list = byMachine.get(entry.machine);
    if (list) list.push(entry);
    else byMachine.set(entry.machine, [entry]);
  }
  for (const [machine, machineEntries] of byMachine) {
    const bySeq = new Map<number, AuditEntry[]>();
    for (const e of machineEntries) {
      const list = bySeq.get(e.seq);
      if (list) list.push(e);
      else bySeq.set(e.seq, [e]);
    }

    for (const [seq, group] of bySeq) {
      const distinctBytes = new Set(group.map((e) => bytesOf.get(e) ?? canonicalJson(e)));
      if (distinctBytes.size > 1) {
        const key = `${machine} ${seq}`;
        if (opts.acceptedForkFingerprints?.has(forkFingerprint(key, [...distinctBytes]))) continue;
        flags.push({
          kind: 'seq-fork',
          machine,
          entry: group[0],
          detail: `${machine}#${seq}: ${distinctBytes.size} conflicting signed entries share the same seq (possible key compromise/forked log)`,
        });
      }
    }

    const seqs = [...bySeq.keys()].sort((a, b) => a - b);
    if (seqs.length > 0 && seqs[0]! > 1) {
      const missingLeading = seqs[0]! - 1;
      flags.push({
        kind: 'seq-gap',
        machine,
        seqRange: { fromExclusive: 0, toExclusive: seqs[0]! },
        detail: `${machine}: audit log starts at seq ${seqs[0]} instead of 1 (missing ${missingLeading} earliest entr${missingLeading === 1 ? 'y' : 'ies'})`,
      });
    }
    for (let i = 1; i < seqs.length; i++) {
      const prev = seqs[i - 1]!;
      const cur = seqs[i]!;
      if (cur - prev > 1) {
        const missing = cur - prev - 1;
        flags.push({
          kind: 'seq-gap',
          machine,
          seqRange: { fromExclusive: prev, toExclusive: cur },
          detail: `${machine}: audit seq gap between ${prev} and ${cur} (missing ${missing} entr${missing === 1 ? 'y' : 'ies'})`,
        });
      }
    }
  }

  // Index job-issued (by jobId -> issuing entry) and job-executed/job-expired (by jobId -> list),
  // restricted to entries from enrolled/known machines (`trustedForMatching`) -- an entry from an
  // unenrolled machine never gets to vouch for, or stand in as, either side of a job.
  const issuedByJob = new Map<string, AuditEntry>();
  const settledByJob = new Map<string, AuditEntry[]>();
  for (const entry of entries) {
    if (!trustedForMatching.has(entry)) continue;
    if (entry.kind === AUDIT_KIND_JOB_ISSUED) {
      const jobId = typeof entry.detail.jobId === 'string' ? entry.detail.jobId : null;
      if (jobId) issuedByJob.set(jobId, entry);
    } else if (entry.kind === AUDIT_KIND_JOB_EXECUTED || entry.kind === AUDIT_KIND_JOB_EXPIRED) {
      const jobId = typeof entry.detail.jobId === 'string' ? entry.detail.jobId : null;
      if (jobId) {
        const list = settledByJob.get(jobId);
        if (list) list.push(entry);
        else settledByJob.set(jobId, [entry]);
      }
    }
  }

  // (a) target claims execution/expiry of a job whose origin never recorded issuing it.
  for (const settledList of settledByJob.values()) {
    for (const settled of settledList) {
      const jobId = settled.detail.jobId as string;
      const originMachine = typeof settled.detail.originMachine === 'string' ? settled.detail.originMachine : null;
      const issuance = issuedByJob.get(jobId);
      const matches = originMachine !== null && issuance !== undefined && issuance.machine === originMachine;
      if (!matches) {
        flags.push({
          kind: 'execution-unissued',
          machine: settled.machine,
          jobId,
          entry: settled,
          detail: `${settled.machine} recorded ${settled.kind} for job ${jobId} claiming origin ${originMachine ?? '(missing)'}, but no matching job-issued entry from that origin exists`,
        });
      }
    }
  }

  // (b) issuance with no execution/expiry from its declared target, past TTL. A job-expired entry
  // self-reported by the ISSUING/ORIGIN machine itself (e.g. an origin-side TTL sweep for a job
  // it never got a receipt back for -- the shape node.ts's dispatch loop actually produces) also
  // counts as an answer: only the origin can honestly know it gave up waiting, so requiring the
  // declared target to be the reporter would falsely flag every such origin-reported expiry as
  // silent even though it was correctly reported.
  for (const [jobId, issuance] of issuedByJob) {
    const targetMachine = typeof issuance.detail.targetMachine === 'string' ? issuance.detail.targetMachine : null;
    const settledList = settledByJob.get(jobId) ?? [];
    const matched =
      targetMachine !== null
        ? settledList.some(
            (s) => s.machine === targetMachine || (s.kind === AUDIT_KIND_JOB_EXPIRED && s.machine === issuance.machine),
          )
        : settledList.length > 0;
    if (matched) continue;

    const ttlSec =
      typeof issuance.detail.ttlSec === 'number' && issuance.detail.ttlSec > 0 ? issuance.detail.ttlSec : defaultTtlSec;
    const deadlineMs = issuance.tsMs + ttlSec * 1000;
    if (opts.nowMs > deadlineMs) {
      flags.push({
        kind: 'issuance-silent',
        machine: issuance.machine,
        jobId,
        entry: issuance,
        detail: `${issuance.machine} issued job ${jobId} for target ${targetMachine ?? '(missing)'} at ${new Date(issuance.tsMs).toISOString()} (ttl ${ttlSec}s) with no execution/expiry recorded past deadline`,
      });
    }
  }

  return { flags };
}
