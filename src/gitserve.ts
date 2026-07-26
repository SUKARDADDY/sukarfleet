// SPDX-License-Identifier: AGPL-3.0-or-later
// Authenticated read-only git smart-HTTP service.
// Owns: GET /git/<repoName>/info/refs?service=git-upload-pack
//       POST /git/<repoName>/git-upload-pack
// Upload-pack (read) only. Receive-pack is refused in every form.
//
// Auth: x-fleet-auth header, value "<machine>;<tsMs>;<sigB64>", ECDSA-P256 signature
// verified against cfg.peers[].publicKeyJwk. See AUTH NORMALIZATION note below for a
// deliberate, documented deviation from the pinned per-request method+path binding.

import type { FleetConfig } from './types';
import { b64decode, log, nowMs, runBytes } from './util';

const AUTH_MAX_SKEW_MS = 120_000;
const GIT_CHILD_TIMEOUT_MS = 5 * 60 * 1000;

// AUTH NORMALIZATION (contract-amendment, see final report):
// The pinned wire format signs "method + \n + pathWithQuery + \n + tsMs + \n + machine"
// per individual HTTP request. A real `git clone`/`git fetch` against this service makes
// at least two requests (GET .../info/refs?service=git-upload-pack, then one or more
// POST .../git-upload-pack) using a *single* static header supplied once via
// `-c http.extraHeader=...` for the whole git invocation — git has no mechanism to vary
// that header per request. A signature bound to the exact verb+path of one request cannot
// validate for both legs of one clone.
//
// gitserve therefore binds its signed message to a repo-scoped *session* instead of a
// single request: method is normalized to the constant "GIT" and the signed path is the
// repo prefix "/git/<repoName>" (no leaf segment, no query string). This still proves the
// caller's identity (ECDSA-P256), still expires (120s skew, matching the pinned window),
// still scopes to one repo, and still cannot be used to reach any other route (POST
// /gossip, GET /status keep the literal per-request method+full-path binding described in
// the pinned contract — this normalization is local to gitserve.ts only).
const AUTH_METHOD_TOKEN = 'GIT';

function authPathForRepo(repoName: string): string {
  return `/git/${repoName}`;
}

interface AuthResult {
  ok: boolean;
  machine?: string;
  reason?: string;
}

async function verifyGitSessionAuth(
  headerValue: string | null,
  repoName: string,
  cfg: FleetConfig,
): Promise<AuthResult> {
  if (!headerValue) return { ok: false, reason: 'missing x-fleet-auth header' };
  const parts = headerValue.split(';');
  if (parts.length !== 3) return { ok: false, reason: 'malformed x-fleet-auth header' };
  const [machine, tsMsRaw, sigB64] = parts as [string, string, string];
  const tsMs = Number(tsMsRaw);
  if (!machine || !sigB64 || !Number.isFinite(tsMs)) {
    return { ok: false, reason: 'malformed x-fleet-auth header' };
  }
  if (Math.abs(nowMs() - tsMs) > AUTH_MAX_SKEW_MS) {
    return { ok: false, reason: 'timestamp outside allowed skew' };
  }

  const peer = cfg.peers.find((p) => p.name === machine);
  if (!peer || !peer.publicKeyJwk) return { ok: false, reason: 'unknown machine' };

  const message = `${AUTH_METHOD_TOKEN}\n${authPathForRepo(repoName)}\n${tsMsRaw}\n${machine}`;
  try {
    const key = await crypto.subtle.importKey(
      'jwk',
      peer.publicKeyJwk,
      { name: 'ECDSA', namedCurve: 'P-256' },
      false,
      ['verify'],
    );
    let sig: Uint8Array;
    try {
      sig = b64decode(sigB64);
    } catch {
      return { ok: false, reason: 'malformed signature encoding' };
    }
    // TS 5.7's lib.dom.d.ts made Uint8Array generic over its backing buffer; bare
    // `Uint8Array` (what b64decode()/TextEncoder().encode() return) widens to
    // Uint8Array<ArrayBufferLike>, which SubtleCrypto's BufferSource rejects at the type
    // level even though it is always a plain-ArrayBuffer-backed view at runtime here.
    // Same boundary cast as keys.ts/endpoints.ts.
    const ok = await crypto.subtle.verify(
      { name: 'ECDSA', hash: 'SHA-256' },
      key,
      sig as BufferSource,
      new TextEncoder().encode(message) as BufferSource,
    );
    if (!ok) return { ok: false, reason: 'bad signature' };
    return { ok: true, machine };
  } catch (err) {
    return { ok: false, reason: `signature verification error: ${String(err)}` };
  }
}

// Test-only export: lets tests/gitserve.test.ts sign requests with the exact scheme this
// module verifies against, without duplicating the AUTH NORMALIZATION logic above.
export function _authMessageForRepo(repoName: string, tsMsRaw: string, machine: string): string {
  return `${AUTH_METHOD_TOKEN}\n${authPathForRepo(repoName)}\n${tsMsRaw}\n${machine}`;
}

interface GitBinaryResult {
  code: number;
  stdout: Uint8Array;
  stderr: string;
}

// util.runBytes keeps stdout as raw bytes: git-upload-pack's stateless-rpc output is a
// binary packfile stream — decoding it as UTF-8 text corrupts any non-UTF-8 byte sequence
// (silently, since JS string decode is lossy). runBytes also bounds every internal await
// (SIGKILL escalation + pipe-drain cancel), so a wedged git child cannot hang a request
// handler forever the way the old Response(...).arrayBuffer() EOF wait could.
async function runGitBinary(argv: string[], stdin: Uint8Array | undefined): Promise<GitBinaryResult> {
  const r = await runBytes(argv, { stdin, timeoutMs: GIT_CHILD_TIMEOUT_MS });
  if (r.code !== 0) {
    log('error', 'gitserve: git child failed', { argv, code: r.code, stderr: r.stderr.slice(0, 2000) });
  }
  return r;
}

function pktLine(s: string): Uint8Array {
  const body = new TextEncoder().encode(s);
  const len = body.length + 4;
  if (len > 0xffff) throw new Error('pktLine: line too long');
  const hex = len.toString(16).padStart(4, '0');
  const head = new TextEncoder().encode(hex);
  const out = new Uint8Array(head.length + body.length);
  out.set(head, 0);
  out.set(body, head.length);
  return out;
}

const FLUSH_PKT = new TextEncoder().encode('0000');

function concatBytes(chunks: Uint8Array[]): Uint8Array {
  const total = chunks.reduce((n, c) => n + c.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.length;
  }
  return out;
}

function unauthorized(reason: string): Response {
  log('warn', 'gitserve: auth rejected', { reason });
  return new Response('unauthorized', { status: 401 });
}

const INFO_REFS_RE = /^\/git\/([^/]+)\/info\/refs$/;
const UPLOAD_PACK_RE = /^\/git\/([^/]+)\/git-upload-pack$/;
const RECEIVE_PACK_RE = /^\/git\/([^/]+)\/git-receive-pack$/;

export async function handleGitRequest(req: Request, cfg: FleetConfig, urlPath: string): Promise<Response> {
  const url = new URL(req.url);

  // Refuse receive-pack (write) in every form before anything else: wrong-method probes
  // and unauthenticated probes against the write path both get the same flat 403, no
  // auth or repo-existence information leaked either way.
  const receiveMatch = RECEIVE_PACK_RE.exec(urlPath);
  if (receiveMatch) {
    log('warn', 'gitserve: receive-pack refused', { path: urlPath });
    return new Response('receive-pack not served', { status: 403 });
  }

  const infoRefsMatch = INFO_REFS_RE.exec(urlPath);
  const uploadPackMatch = UPLOAD_PACK_RE.exec(urlPath);

  if (infoRefsMatch && req.method === 'GET') {
    const repoName = infoRefsMatch[1]!;
    const service = url.searchParams.get('service');
    if (service === 'git-receive-pack') {
      log('warn', 'gitserve: receive-pack service param refused', { repoName });
      return new Response('receive-pack not served', { status: 403 });
    }
    if (service !== 'git-upload-pack') {
      return new Response('bad request: unsupported service', { status: 400 });
    }

    const auth = await verifyGitSessionAuth(req.headers.get('x-fleet-auth'), repoName, cfg);
    if (!auth.ok) return unauthorized(auth.reason ?? 'auth failed');

    const repo = cfg.repos.find((r) => r.name === repoName);
    if (!repo) return new Response('not found', { status: 404 });

    const result = await runGitBinary(
      ['git', 'upload-pack', '--stateless-rpc', '--advertise-refs', repo.path],
      undefined,
    );
    if (result.code !== 0) return new Response('internal error', { status: 500 });

    const body = concatBytes([pktLine('# service=git-upload-pack\n'), FLUSH_PKT, result.stdout]);
    // Same Uint8Array<ArrayBufferLike> vs. lib.dom generic mismatch as above, at the
    // Response BodyInit boundary instead of BufferSource.
    return new Response(body as BodyInit, {
      status: 200,
      headers: {
        'Content-Type': 'application/x-git-upload-pack-advertisement',
        'Cache-Control': 'no-cache',
      },
    });
  }

  if (uploadPackMatch && req.method === 'POST') {
    const repoName = uploadPackMatch[1]!;

    const auth = await verifyGitSessionAuth(req.headers.get('x-fleet-auth'), repoName, cfg);
    if (!auth.ok) return unauthorized(auth.reason ?? 'auth failed');

    const repo = cfg.repos.find((r) => r.name === repoName);
    if (!repo) return new Response('not found', { status: 404 });

    let bodyBuf = new Uint8Array(await req.arrayBuffer());
    if (req.headers.get('content-encoding') === 'gzip') {
      try {
        bodyBuf = Bun.gunzipSync(bodyBuf);
      } catch (err) {
        log('warn', 'gitserve: gunzip failed', { repoName, error: String(err) });
        return new Response('bad request: invalid gzip body', { status: 400 });
      }
    }

    const result = await runGitBinary(['git', 'upload-pack', '--stateless-rpc', repo.path], bodyBuf);
    if (result.code !== 0) return new Response('internal error', { status: 500 });

    return new Response(result.stdout as BodyInit, {
      status: 200,
      headers: { 'Content-Type': 'application/x-git-upload-pack-result' },
    });
  }

  return new Response('not found', { status: 404 });
}
