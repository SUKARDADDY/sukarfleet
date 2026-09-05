// SPDX-License-Identifier: AGPL-3.0-or-later
// Shared utilities for sukarfleet. Source of truth alongside types.ts / config.ts.

import { mkdir, rename, unlink } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { dirname, join } from 'node:path';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

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

// Bounded subprocess runner: every await in here has a hard upper bound.
// History: the sync loop once wedged for 8.5h inside the old run() — the git
// parent was SIGTERMed on timeout, but `new Response(proc.stdout).text()`
// waits for pipe EOF, and a hung git-remote-http grandchild (dead mesh TCP
// connection) inherited the pipe's write end and never exited. Three guards:
// (1) SIGTERM at timeoutMs, (2) SIGKILL at timeoutMs + killGraceMs (SIGTERM
// can be ignored/blocked), (3) after the child exits, readers are cancelled
// once a short drain grace passes, so grandchildren can't hold us on EOF.
export async function runBytes(argv: string[], opts: RunOptions = {}): Promise<RunBytesResult> {
  if (argv.length === 0) throw new Error('run: argv must not be empty');
  const timeoutMs = opts.timeoutMs ?? DEFAULT_RUN_TIMEOUT_MS;
  const killGraceMs = opts.killGraceMs ?? DEFAULT_KILL_GRACE_MS;

  const proc = Bun.spawn(argv, {
    cwd: opts.cwd,
    env: opts.env ? { ...process.env, ...opts.env } : process.env,
    stdin: opts.stdin !== undefined ? 'pipe' : 'ignore',
    stdout: 'pipe',
    stderr: 'pipe',
  });

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
    try {
      proc.kill('SIGKILL');
    } catch {
      // already gone
    }
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

  const result: RunBytesResult = {
    code: timedOut ? 124 : exitCode,
    stdout: stdoutRes.bytes,
    stderr: new TextDecoder().decode(stderrRes.bytes),
  };
  // Left absent (not `false`) with no cap, so the uncapped result object keeps its historical shape.
  if (opts.maxCaptureBytes !== undefined) result.truncated = stdoutRes.truncated || stderrRes.truncated;
  return result;
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
