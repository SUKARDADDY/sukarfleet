// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Bounded HTTP body reading. Every route that accepts a body -- the pairing handshake, the local
// GUI, the daemon's loopback routes -- reads it through here, so no handler anywhere can be made
// to allocate without limit or hang forever on a slow sender.
//
// This helper previously lived in the exec-layer route module. It was never exec-specific: it is a
// generic transport-level guard that the exec routes happened to define first. Lifting it here is
// what lets that module drop without taking the pairing and GUI routes with it.

// 64 KiB. Every payload the daemon accepts on a bounded route is a small canonical-JSON envelope
// with no bulk content -- command output travels as byte counts or digests, never as raw bytes --
// so this is generous headroom rather than a tight fit.
export const DEFAULT_MAX_BODY_BYTES = 65536;

// How long to wait for a request body to finish arriving before cancelling the read. Mirrors the
// bounded-await discipline util.ts applies to subprocess pipes, applied to HTTP bodies instead:
// nothing here can be made to hang forever by a sender that stops writing.
export const BODY_READ_TIMEOUT_MS = 10000;

export type CappedBodyResult =
  | { ok: true; bytes: Uint8Array }
  | { ok: false; reason: 'too-large' | 'timeout' | 'error' };

// Rejects on Content-Length alone when it already exceeds the cap (fast path, no read at all);
// otherwise streams with a running total, so a lying or absent Content-Length cannot bypass the
// cap. Cancels the read if the wall-clock timeout elapses.
export async function readCappedBody(
  req: Request,
  capBytes: number,
  timeoutMs: number,
): Promise<CappedBodyResult> {
  const declared = req.headers.get('content-length');
  if (declared !== null) {
    const n = Number(declared);
    if (Number.isFinite(n) && n > capBytes) return { ok: false, reason: 'too-large' };
  }
  if (!req.body) return { ok: true, bytes: new Uint8Array(0) };

  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    reader.cancel().catch(() => {});
  }, timeoutMs);
  (timer as unknown as { unref?: () => void }).unref?.();

  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.length;
      if (total > capBytes) {
        reader.cancel().catch(() => {});
        clearTimeout(timer);
        return { ok: false, reason: 'too-large' };
      }
      chunks.push(value);
    }
  } catch {
    clearTimeout(timer);
    return { ok: false, reason: timedOut ? 'timeout' : 'error' };
  }
  clearTimeout(timer);
  if (timedOut) return { ok: false, reason: 'timeout' };

  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    out.set(c, off);
    off += c.length;
  }
  return { ok: true, bytes: out };
}
