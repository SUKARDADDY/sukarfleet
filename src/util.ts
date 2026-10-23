// SPDX-License-Identifier: AGPL-3.0-or-later
// Shared utilities for sukarfleet. Source of truth alongside types.ts / config.ts.

import { mkdir, rename, unlink } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { dirname, join } from 'node:path';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

// Leads a PresenceRepoStat.syncError that is a note, not an error: the sync cycle is waiting on
// something a person is in the middle of (a held lock, an unfinished merge) and has been for a
// while. syncer.ts writes it; health.ts shows the text and raises no fault for it. Lives here
// because both import util and neither should import the other.
export const SYNC_DEFERRED_PREFIX = 'deferred: ';

export function log(level: LogLevel, msg: string, extra?: object): void {
  const line = canonicalJson({ ts: new Date().toISOString(), level, msg, ...(extra ?? {}) });
  // eslint-disable-next-line no-console
  console.log(line);
}

export interface RunOptions {
  cwd?: string;
  timeoutMs?: number;
  env?: Record<string, string>;
  stdin?: string | Uint8Array;
  // SIGTERM -> SIGKILL escalation delay after timeoutMs. Exposed for tests.
  killGraceMs?: number;
  // Per-stream capture cap in bytes; omitted means unlimited (the historical behavior, byte for
  // byte). Past the cap the runner stops ACCUMULATING but keeps DRAINING the pipe -- see
  // collectBytes: cancelling the reader early is what the pipe-wedge guards below exist to avoid.
  // A value <= 0 captures nothing rather than falling back to unlimited (fail closed).
  maxCaptureBytes?: number;
  // Called after THIS runner killed the child with SIGKILL and it died of it, before the result is
  // returned -- either the timeout escalation below or drainChildren's last resort. SIGKILL is the
  // one signal a child cannot clean up after: git removes its own .lock files on SIGTERM, and on
  // SIGKILL leaves them for every later git call to trip over. The hook is how a caller that knows
  // which repository the child was working in (syncer.ts) clears what it orphaned. `startedAtMs` is
  // the wall clock read immediately before the spawn, so nothing the child created can predate it.
  // A throw is logged and swallowed: cleanup must never turn a result into an exception.
  afterKill?: (info: { startedAtMs: number }) => Promise<void>;
  // Spawn even while drainChildren is refusing new children. Only for the probes the drain's own
  // cleanup needs (gitlocks.ts asks lsof/tasklist whether a lock is still held); everything else is
  // new work, and new work is exactly what a shutting-down daemon must stop starting.
  evenWhileDraining?: boolean;
}

export interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
  // Present only when maxCaptureBytes was set; true when either stream hit the cap.
  truncated?: boolean;
}

export interface RunBytesResult {
  code: number;
  stdout: Uint8Array;
  stderr: string;
  truncated?: boolean;
  // A local deadline or signal supplies no exit status from a remote transport.
  timedOut?: boolean;
  signalCode?: string;
}

const DEFAULT_RUN_TIMEOUT_MS = 60000;
const DEFAULT_KILL_GRACE_MS = 5000;
// After the direct child has exited, how long to wait for pipe EOF before
// force-cancelling our readers. EOF requires every holder of the write end to
// close it — an orphaned grandchild (git-remote-http) can hold it forever.
const PIPE_DRAIN_GRACE_MS = 2000;

function unrefTimer(t: ReturnType<typeof setTimeout>): void {
  (t as unknown as { unref?: () => void }).unref?.();
}

interface CollectedBytes {
  bytes: Uint8Array;
  truncated: boolean;
}

// Incremental stream collector whose pending read can be cancelled. Unlike
// `new Response(stream).text()`, cancel() resolves the collector immediately
// with whatever bytes arrived so far — nothing here can await forever.
//
// With maxBytes set, accumulation stops at the cap but the read loop keeps
// running to EOF: the child must never be left writing into a pipe nobody
// reads, and cancelling here would reintroduce the wedge documented on
// runBytes below.
function collectBytes(
  stream: ReadableStream<Uint8Array>,
  maxBytes?: number,
): {
  done: Promise<CollectedBytes>;
  cancel: () => void;
} {
  const reader = stream.getReader();
  const done = (async (): Promise<CollectedBytes> => {
    const chunks: Uint8Array[] = [];
    let kept = 0;
    let truncated = false;
    try {
      for (;;) {
        const { value, done: eof } = await reader.read();
        if (eof) break;
        if (!value) continue;
        if (maxBytes === undefined) {
          chunks.push(value);
          continue;
        }
        const room = maxBytes - kept;
        if (room <= 0) {
          truncated = true;
          continue;
        }
        if (value.length <= room) {
          chunks.push(value);
          kept += value.length;
          continue;
        }
        chunks.push(value.subarray(0, room));
        kept = maxBytes;
        truncated = true;
      }
    } catch {
      // Stream errored: return the partial output collected so far.
    }
    let total = 0;
    for (const c of chunks) total += c.length;
    const out = new Uint8Array(total);
    let off = 0;
    for (const c of chunks) {
      out.set(c, off);
      off += c.length;
    }
    return { bytes: out, truncated };
  })();
  return {
    done,
    cancel: () => {
      reader.cancel().catch(() => {});
    },
  };
}

// Every child runBytes has spawned and not yet finished with, so a shutting-down daemon can wait for
// them instead of exiting over them (see drainChildren). An entry leaves the set only after its
// afterKill hook has run, which is what lets the drain's last step wait for that cleanup too.
interface LiveChild {
  terminate(): void;
  forceKill(): void;
}

const liveChildren = new Set<LiveChild>();
const idleWaiters = new Set<() => void>();
let refusingSpawns = false;

// What a runBytes call reports when drainChildren refused to start it. Not 124 (that is a timeout,
// and callers classify timeouts) and not 127 (absent binary): nothing ran, and the stderr says why.
export const RUN_REFUSED_SHUTTING_DOWN = 125;

function settleChild(child: LiveChild): void {
  liveChildren.delete(child);
  if (liveChildren.size > 0) return;
  for (const wake of idleWaiters) wake();
  idleWaiters.clear();
}

function whenNoChildren(): Promise<void> {
  if (liveChildren.size === 0) return Promise.resolve();
  return new Promise((resolve) => idleWaiters.add(resolve));
}

// Bounded subprocess runner: every await in here has a hard upper bound.
// History: the sync loop once wedged for 8.5h inside the old run() — the git
// parent was SIGTERMed on timeout, but `new Response(proc.stdout).text()`
// waits for pipe EOF, and a hung git-remote-http grandchild (dead mesh TCP
// connection) inherited the pipe's write end and never exited. Three guards:
// (1) SIGTERM at timeoutMs, (2) SIGKILL at timeoutMs + killGraceMs (SIGTERM
// can be ignored/blocked), (3) after the child exits, readers are cancelled
// once a short drain grace passes, so grandchildren can't hold us on EOF.
// A child that guard (2) kills gets opts.afterKill run over it before the result returns.
export async function runBytes(argv: string[], opts: RunOptions = {}): Promise<RunBytesResult> {
  if (argv.length === 0) throw new Error('run: argv must not be empty');
  if (refusingSpawns && !opts.evenWhileDraining) {
    return {
      code: RUN_REFUSED_SHUTTING_DOWN,
      stdout: new Uint8Array(0),
      stderr: `run: not started, the daemon is shutting down: ${argv[0]}`,
    };
  }
  const timeoutMs = opts.timeoutMs ?? DEFAULT_RUN_TIMEOUT_MS;
  const killGraceMs = opts.killGraceMs ?? DEFAULT_KILL_GRACE_MS;

  const startedAtMs = Date.now();
  const proc = Bun.spawn(argv, {
    cwd: opts.cwd,
    env: opts.env ? { ...process.env, ...opts.env } : process.env,
    stdin: opts.stdin !== undefined ? 'pipe' : 'ignore',
    stdout: 'pipe',
    stderr: 'pipe',
  });

  let sentKill = false;
  const child: LiveChild = {
    terminate: () => {
      try {
        proc.kill('SIGTERM');
      } catch {
        // already gone
      }
    },
    forceKill: () => {
      sentKill = true;
      try {
        proc.kill('SIGKILL');
      } catch {
        // already gone
      }
    },
  };
  liveChildren.add(child);

  try {
    const stdin = proc.stdin;
    if (opts.stdin !== undefined && stdin) {
      stdin.write(opts.stdin);
      await stdin.end();
    }

    const out = collectBytes(proc.stdout, opts.maxCaptureBytes);
    const err = collectBytes(proc.stderr, opts.maxCaptureBytes);

    let timedOut = false;
    const termTimer = setTimeout(() => {
      timedOut = true;
      proc.kill();
    }, timeoutMs);
    unrefTimer(termTimer);
    const killTimer = setTimeout(() => {
      timedOut = true;
      child.forceKill();
    }, timeoutMs + killGraceMs);
    unrefTimer(killTimer);

    const exitCode = await proc.exited;
    clearTimeout(termTimer);
    clearTimeout(killTimer);

    const drainTimer = setTimeout(() => {
      out.cancel();
      err.cancel();
    }, PIPE_DRAIN_GRACE_MS);
    unrefTimer(drainTimer);
    const [stdoutRes, stderrRes] = await Promise.all([out.done, err.done]);
    clearTimeout(drainTimer);

    // Both conditions, not just the first: a child that exited on its own (or of the SIGTERM) in
    // the instant before our SIGKILL landed released its own locks, and anything that now looks
    // orphaned is somebody else's.
    if (sentKill && proc.signalCode === 'SIGKILL' && opts.afterKill) {
      try {
        await opts.afterKill({ startedAtMs });
      } catch (hookErr) {
        log('error', 'run: cleanup after a SIGKILL failed', { argv0: argv[0], error: String(hookErr) });
      }
    }

    const result: RunBytesResult = {
      code: timedOut ? 124 : exitCode,
      stdout: stdoutRes.bytes,
      stderr: new TextDecoder().decode(stderrRes.bytes),
    };
    if (timedOut) result.timedOut = true;
    if (proc.signalCode) result.signalCode = proc.signalCode;
    // Left absent (not `false`) with no cap, so the uncapped result object keeps its historical shape.
    if (opts.maxCaptureBytes !== undefined) result.truncated = stdoutRes.truncated || stderrRes.truncated;
    return result;
  } finally {
    settleChild(child);
  }
}

export interface DrainOptions {
  // Resolves once the work that spawns children has stopped on its own (node.ts passes every
  // loop's idle()). Optional; without it only the children themselves are waited for.
  settled?: Promise<unknown>;
  // The whole patient phase: how long work and children get to finish untouched.
  settleMs: number;
  // After SIGTERM, how long a child gets to clean up and exit before SIGKILL.
  termGraceMs: number;
  // After SIGKILL, how long to wait for the afterKill hooks to finish.
  killWaitMs: number;
}

export interface DrainResult {
  // Children still running when the patient phase ended.
  terminated: number;
  // Children that outlived SIGTERM as well.
  killed: number;
  // Children still registered when the drain gave up waiting altogether.
  abandoned: number;
}

// Stop a daemon's children without leaving their locks behind. Every await here is bounded by a
// timer, never by the work it waits for, so a wedged await anywhere (a sync step stuck on a dead
// socket, an HTTP fetch with no deadline) costs at most the bounds below and never hangs shutdown.
//
// Order matters. First patience: the in-flight work finishes the git step it is on and any steps
// it still needs to leave the repo consistent (a merge that conflicted gets resolved or aborted),
// with nothing killed. Only once that bound expires does the drain refuse to spawn anything new --
// refusing earlier would cut a cycle between `git merge` and its `merge --abort`. Then SIGTERM,
// which git answers by deleting its own lock files on the way out. SIGKILL is the last resort, and
// the afterKill hooks clear the locks it orphans.
//
// Refusal stays on when this returns: the caller is about to exit, and a child started between
// here and process.exit would be SIGKILLed by the service manager instead of drained.
export async function drainChildren(opts: DrainOptions): Promise<DrainResult> {
  const result: DrainResult = { terminated: 0, killed: 0, abandoned: 0 };
  const deadline = Date.now() + opts.settleMs;
  await raceTimeout(opts.settled ?? Promise.resolve(), opts.settleMs);
  await raceTimeout(whenNoChildren(), Math.max(0, deadline - Date.now()));
  refusingSpawns = true;
  if (liveChildren.size === 0) return result;

  result.terminated = liveChildren.size;
  for (const child of liveChildren) child.terminate();
  await raceTimeout(whenNoChildren(), opts.termGraceMs);
  if (liveChildren.size === 0) return result;

  result.killed = liveChildren.size;
  for (const child of liveChildren) child.forceKill();
  await raceTimeout(whenNoChildren(), opts.killWaitMs);
  result.abandoned = liveChildren.size;
  return result;
}

// drainChildren leaves new spawns refused, which is right for a daemon about to exit and wrong for
// anything that keeps running afterwards. The daemon never calls this; a test that drains does, so
// the rest of the suite can still spawn.
export function allowChildSpawns(): void {
  refusingSpawns = false;
}

// How many children are running right now. For tests and diagnostics.
export function liveChildCount(): number {
  return liveChildren.size;
}

async function raceTimeout(p: Promise<unknown>, ms: number): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      p.then(
        () => undefined,
        () => undefined,
      ),
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export async function run(argv: string[], opts: RunOptions = {}): Promise<RunResult> {
  const r = await runBytes(argv, opts);
  const result: RunResult = { code: r.code, stdout: new TextDecoder().decode(r.stdout), stderr: r.stderr };
  if (r.truncated !== undefined) result.truncated = r.truncated;
  return result;
}

export async function ensureDir(p: string): Promise<void> {
  await mkdir(p, { recursive: true });
}

export async function atomicWrite(path: string, data: string | Uint8Array): Promise<void> {
  const dir = dirname(path);
  await ensureDir(dir);
  const tmp = join(dir, `.tmp-${randomBytes(8).toString('hex')}`);
  await Bun.write(tmp, data);
  try {
    await rename(tmp, path);
  } catch (err) {
    await unlink(tmp).catch(() => {});
    throw err;
  }
}

export async function readJsonFile<T>(p: string): Promise<T | null> {
  const file = Bun.file(p);
  if (!(await file.exists())) return null;
  try {
    const text = await file.text();
    return JSON.parse(text) as T;
  } catch {
    return null;
  }
}

// Recursively sorted-key JSON encoding, C-locale/codepoint key order, no whitespace.
// Arrays keep their given order. Object properties with value `undefined` are omitted
// (matching JSON.stringify semantics); array elements with value `undefined` encode as null.
export function canonicalJson(v: unknown): string {
  return encode(v);
}

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

function encode(v: unknown): string {
  if (v === null || v === undefined) return 'null';
  const t = typeof v;
  if (t === 'number') {
    if (!Number.isFinite(v as number)) throw new Error('canonicalJson: non-finite number');
    return JSON.stringify(v);
  }
  if (t === 'boolean' || t === 'string') return JSON.stringify(v);
  if (Array.isArray(v)) {
    return '[' + v.map((x) => encode(x)).join(',') + ']';
  }
  if (t === 'object') {
    const obj = v as Record<string, unknown>;
    const keys = Object.keys(obj)
      .filter((k) => obj[k] !== undefined)
      .sort(codepointCompare);
    const parts = keys.map((k) => JSON.stringify(k) + ':' + encode(obj[k]));
    return '{' + parts.join(',') + '}';
  }
  throw new Error(`canonicalJson: unsupported type ${t}`);
}

let sdNotifyWarned = false;

export function sdNotify(state: string): void {
  if (!process.env.NOTIFY_SOCKET) return;
  try {
    const proc = Bun.spawn(['systemd-notify', state], {
      stdout: 'ignore',
      stderr: 'ignore',
      stdin: 'ignore',
    });
    proc.exited.catch(() => {});
  } catch (err) {
    if (!sdNotifyWarned) {
      sdNotifyWarned = true;
      log('warn', 'sdNotify: systemd-notify unavailable, silently skipping', {
        error: String(err),
      });
    }
  }
}

export function nowMs(): number {
  return Date.now();
}

// Suspend/resume detector's core math, shared by transport.ts's ClockSentinel and node.ts's
// watchdogLoop (P4): the absolute divergence between monotonic-elapsed and wall-elapsed time since
// a baseline. Ordinary elapsed time keeps the two in lockstep; a sleep, hibernate or manual clock
// change does not, and shows up here as a large gap. Pure and baseline-injected so each caller can
// keep its own baseline and its own idea of "too much drift" (transport.ts's SUSPEND_JUMP_MS)
// without sharing state or a clock.
export function clockDriftMs(baselineMonoNs: number, baselineWallMs: number, nowMonoNs: number, nowWallMs: number): number {
  const monoElapsedMs = (nowMonoNs - baselineMonoNs) / 1e6;
  const wallElapsedMs = nowWallMs - baselineWallMs;
  return Math.abs(wallElapsedMs - monoElapsedMs);
}

export function b64encode(data: Uint8Array): string {
  return Buffer.from(data).toString('base64');
}

export function b64decode(s: string): Uint8Array {
  return new Uint8Array(Buffer.from(s, 'base64'));
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Per-key latch that turns repeated bad/ok observations into transition events, so a call site can
// log loud only when a key's state actually flips (first failure, first recovery) and quiet
// otherwise. Replaces the ad-hoc `warnedOnce` booleans scattered through the daemon with one
// reusable primitive. Not persisted across restarts: a fresh process starts every key unlatched,
// same as those booleans did.
export type TransitionResult = 'entered' | 'still-bad' | 'recovered' | 'still-ok';

export class TransitionGate {
  private readonly bad = new Set<string>();

  // Records one observation for `key` and reports which of the four transitions it represents:
  //   'entered'    -- key just went bad (was ok or unseen, now bad)
  //   'still-bad'  -- key was already bad, still bad
  //   'recovered'  -- key just went ok (was bad, now ok)
  //   'still-ok'   -- key was ok or unseen, still ok
  observe(key: string, isBad: boolean): TransitionResult {
    const wasBad = this.bad.has(key);
    if (isBad) {
      if (wasBad) return 'still-bad';
      this.bad.add(key);
      return 'entered';
    }
    if (wasBad) {
      this.bad.delete(key);
      return 'recovered';
    }
    return 'still-ok';
  }

  // Drops all latch state for `key`, so the next observe() call starts as though the key had
  // never been seen. For a caller retiring a key entirely (e.g. a peer removed from config).
  forget(key: string): void {
    this.bad.delete(key);
  }
}
