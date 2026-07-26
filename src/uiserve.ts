// SPDX-License-Identifier: AGPL-3.0-or-later
// Local GUI transport for the SSH admin lane. Owns src/uiserve.ts only.
//
// Prefixes owned, and nothing else -- handle() returns null outside them so node.ts's fetchHandler
// falls straight through to its own dispatch:
//
//   /ui, /ui/*     static GUI assets, loopback-only
//   /api/ui/*      the GUI's JSON API, loopback-only
//   /pair/*        /pair/hello only, MESH-reachable (authenticated by the MAC on its own payload,
//                  the same way /gossip is authenticated by x-fleet-auth rather than by locality)
//
// Anything unrecognized *inside* those prefixes gets this module's own 404, never a null: the
// prefixes are owned wholesale, so ordering against the other route families cannot matter.
//
// This file is transport only -- gating, body caps, shape checks, JSON shaping. Every decision that
// carries weight (does this password verify, is this peer paired, may this argv run) belongs to
// modules behind `deps`, and this file imports none of them: secrets.ts, sshadmin.ts and pairing.ts
// arrive as structural ports (UiSecretsPort / UiSshAdminPort / UiPairingPort). The route layer can
// therefore neither reach around them nor drag their disk and subprocess side effects into a route
// test, and the ports are structurally typed so a drift in the real signatures fails node.ts's
// construction at compile time.
//
// Four properties this file exists to hold:
//
//  1. STATIC ASSETS ARE AN ALLOWLIST, NOT A PATH JOIN. UI_ASSETS maps an exact request path to a
//     fixed (filename, content-type) pair resolved against import.meta.dir. No string derived from
//     a request ever reaches the filesystem, so traversal is structurally impossible rather than
//     filtered -- and import.meta.dir survives the daemon being started from any cwd (or none, as
//     under an SSH forced command).
//
//  2. NO ROUTE RETURNS A CREDENTIAL. The credential endpoints report presence / staleness /
//     sealing and nothing else. POST /api/ui/credentials/sudo hands the password straight to the
//     store and answers from a fixed reason vocabulary (SET_REASONS); that handler contains no
//     log() call at any level and never interpolates the request body into a string, so there is
//     no expression on that path capable of carrying the password anywhere. The one route that
//     does return a secret is GET /api/ui/setup/network-secret, deliberately: the EasyTier mesh
//     secret exists to be copied to the other machine, it is not the sudo password, and it is
//     loopback-gated like the rest of the API.
//
//  3. LOOPBACK IS A NETWORK BOUNDARY, NOT AN AUTHENTICATION ONE. Any local process -- including a
//     web page the operator is visiting -- can reach 127.0.0.1, so every mutating route also runs
//     rejectCrossSiteBrowser (see its own comment for why the existing rejectCrossSite in node.ts
//     cannot be reused here, and is deliberately left untouched). Every route except /pair/hello
//     additionally pins the Host header (see isLoopbackHostHeader): the loopback gate alone cannot
//     tell a rebound name from a genuine one, because the browser dials 127.0.0.1 either way.
//
//  4. NOTHING THROWS AT THE DAEMON. handle() wraps the whole dispatch: a feature-local failure
//     degrades to a logged 500, never to a rejected promise inside node.ts's fetch handler.

import { join } from 'node:path';
import type {
  AdminRunRequest,
  AdminRunView,
  AdminStatusEntry,
  AuditEntry,
  FleetConfig,
  IdentityPatch,
  MeshSecretState,
  MinimalServer,
  UiPairingState,
  UiState,
} from './types';
import { log } from './util';
import { expandHome, secretsDir } from './config';
import { readCappedBody, BODY_READ_TIMEOUT_MS } from './http';

// ---------------------------------------------------------------------------
// Static asset allowlist
// ---------------------------------------------------------------------------

const UI_DIR = join(import.meta.dir, '..', 'ui');

const HTML_TYPE = 'text/html; charset=utf-8';
const CSS_TYPE = 'text/css; charset=utf-8';
const JS_TYPE = 'text/javascript; charset=utf-8';

// The GUI must render with the machine offline and must never reach another origin -- app.js uses
// only relative paths so a port-forwarded tab drives the forwarded machine. This header makes that
// a browser-enforced property instead of a code-review one; form-action stays 'self' so a form
// whose submit handler ever fails to preventDefault() degrades to a harmless same-origin GET
// rather than a silently dead button.
const CSP =
  "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; " +
  "font-src 'self'; connect-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'";

// Exact request path -> [filename under ui/, pinned content-type]. Frozen tuples, fixed keys: this
// map is the only thing that decides which bytes on disk are reachable over HTTP.
// '/ui' is present alongside '/ui/' because index.html references its assets by absolute path
// (/ui/style.css, /ui/app.js), so both spellings render identically and an operator who types the
// URL without the trailing slash gets the GUI instead of a 404.
export const UI_ASSETS: ReadonlyMap<string, readonly [string, string]> = new Map<
  string,
  readonly [string, string]
>([
  ['/ui', Object.freeze(['index.html', HTML_TYPE]) as readonly [string, string]],
  ['/ui/', Object.freeze(['index.html', HTML_TYPE]) as readonly [string, string]],
  ['/ui/index.html', Object.freeze(['index.html', HTML_TYPE]) as readonly [string, string]],
  ['/ui/app.js', Object.freeze(['app.js', JS_TYPE]) as readonly [string, string]],
  ['/ui/style.css', Object.freeze(['style.css', CSS_TYPE]) as readonly [string, string]],
]);

// ---------------------------------------------------------------------------
// Tunables
// ---------------------------------------------------------------------------

// Every GUI request body is a small JSON object; the biggest realistic one is an admin argv.
const MAX_UI_BODY_BYTES = 65536;
// The credential POST carries one short string and nothing else, so it gets its own tighter cap.
const MAX_CREDENTIAL_BODY_BYTES = 4096;
const MAX_PASSWORD_CHARS = 1024;
const MAX_MESH_SECRET_CHARS = 512;
const MAX_HOST_CHARS = 255;

const DEFAULT_RUNS_LIMIT = 20;
const MAX_RUNS_LIMIT = 100;
const DEFAULT_AUDIT_LIMIT = 40;
const MAX_AUDIT_LIMIT = 200;

// Long enough for the 200 to be written to the socket before systemd tears the process down.
const RESTART_DELAY_MS = 150;

// sshadmin.ts mints run ids as base64url(9 random bytes); the charset check exists so a lookup key
// can never be anything but an opaque token.
const RUN_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const MACHINE_NAME_RE = /^[A-Za-z0-9._-]{1,64}$/;
const MESH_IP_RE = /^[0-9A-Fa-f.:]{1,45}$/;
const NETWORK_NAME_RE = /^[A-Za-z0-9._-]{1,64}$/;
const HOST_RE = /^[A-Za-z0-9._:\[\]-]{1,255}$/;

// The only reasons secrets.setSudoPassword can report, restated here as a closed vocabulary. The
// response is built from THIS map, never from the store's own strings, so no value that passed
// through the credential path can reach a response body even if a future refactor puts one in an
// error message.
const SET_REASONS = new Map<string, string>([
  ['verify-failed', 'verify-failed'],
  ['seal-unavailable', 'seal-unavailable'],
  ['not-private', 'not-private'],
]);

// ---------------------------------------------------------------------------
// Ports. Structural mirrors of secrets.ts / sshadmin.ts / pairing.ts, declared here so this module
// imports none of them (the GUI layer is a consumer of those seams, never a peer of them).
// ---------------------------------------------------------------------------

export interface CredentialStatusView {
  present: boolean;
  stale: boolean;
  sealed: 'tpm2' | 'user' | 'plaintext' | null;
  user: string;
  setAtMs: number | null;
  lastUsedMs: number | null;
  lastFailureMs: number | null;
}

export interface UiSecretsPort {
  status: () => Promise<CredentialStatusView>;
  // Takes the plaintext and returns a verdict. Whatever else it returns, only `ok` and a reason
  // drawn from SET_REASONS ever reaches the wire.
  set: (pw: string) => Promise<{ ok: boolean; reason?: string; message?: string }>;
  remove: () => Promise<void>;
  sealAvailable: () => Promise<{ ok: boolean; reason?: string }>;
}

export interface UiSshTrust {
  sshPublicKey: string;
  sshKeyFingerprint: string;
  hostKeys: string[];
  hostKeyFingerprints: string[];
}

export interface UiSshAdminPort {
  startRun: (req: AdminRunRequest) => Promise<{ runId: string }>;
  getRun: (runId: string) => AdminRunView | null;
  listRuns: (limit: number) => AdminRunView[];
  status: () => Promise<AdminStatusEntry[]>;
  trust: () => Promise<UiSshTrust>;
  // Backs POST /api/ui/pair/revoke. Withdraws this machine's SSH trust in the peer and nothing
  // else: the peer's config entry and mesh key belong to node.ts, P2 membership to `sukarfleet
  // revoke`.
  revokePeer: (machine: string) => Promise<void>;
}

export interface UiPairingPort {
  mintCode: () => { display: string; expiresMs: number };
  cancelCode: () => void;
  codeState: () => UiPairingState;
  redeem: (input: { code: string; host: string; port: number }) => Promise<{
    ok: boolean;
    peer?: string;
    reason?: string;
    message?: string;
  }>;
  handleHello: (req: Request) => Promise<Response>;
}

export interface UiNetworkSecretPort {
  // Returns the staged mesh secret so the operator can copy it to the other machine; null when
  // nothing is staged. Loopback-only, like every other /api/ui route.
  reveal: () => Promise<string | null>;
  stage: (s: string) => Promise<void>;
  generate: () => Promise<string>;
  state: () => Promise<MeshSecretState>;
}

export interface UiRoutesDeps {
  // Read through a getter on every request: node.ts mutates cfg in place after a pair, and the
  // GUI must report what the daemon currently believes rather than what it booted with.
  cfg: FleetConfig;
  isLoopback: (srv: MinimalServer, req: Request) => boolean;
  buildState: () => Promise<UiState>;
  secrets: UiSecretsPort;
  sshAdmin: UiSshAdminPort;
  pairing: UiPairingPort;
  // Newest-first, at most `limit` entries -- the same shape node.ts:996 already serves on
  // /exec/audit/tail. Ordering lives with the caller so there is exactly one place to change it.
  tailAudit: (limit: number) => Promise<AuditEntry[]>;
  patchIdentity: (id: IdentityPatch) => Promise<{ ok: boolean; message?: string }>;
  networkSecret: UiNetworkSecretPort;
  // Patches admin.enabled (does this machine originate admin runs) and/or admin.acceptIncoming
  // (does it answer them). Both are persisted AND applied to the live cfg by node.ts, so a switch
  // takes effect without the Restart button.
  setLane: (patch: LanePatch) => Promise<void>;
  restartDaemon: () => Promise<void>;
}

export interface LanePatch {
  enabled?: boolean;
  acceptIncoming?: boolean;
}

// ---------------------------------------------------------------------------
// Response helpers
// ---------------------------------------------------------------------------

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
  });
}

function notFound(): Response {
  return jsonResponse({ error: 'not found' }, 404);
}

function forbidden(message: string): Response {
  return jsonResponse({ error: 'forbidden', message }, 403);
}

function badRequest(message: string): Response {
  return jsonResponse({ error: 'bad request', message }, 400);
}

function methodNotAllowed(allow: string): Response {
  return new Response(JSON.stringify({ error: 'method not allowed' }), {
    status: 405,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store', allow },
  });
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

// A control character in a value the operator typed means either a paste accident or an injection
// attempt against a file this value is destined for (fleet.toml, config.json). Neither is a value
// we want to store.
const CONTROL_CHARS_RE = /[\u0000-\u001f\u007f]/;

function isCleanText(s: string, max: number): boolean {
  return s.length > 0 && s.length <= max && !CONTROL_CHARS_RE.test(s);
}

function clampLimit(raw: string | null, fallback: number, max: number): number {
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.min(Math.floor(n), max);
}

// ---------------------------------------------------------------------------
// Host pinning (DNS rebinding)
// ---------------------------------------------------------------------------

const LOOPBACK_HOST_NAMES = new Set(['127.0.0.1', 'localhost', '::1']);

function isPortSuffix(s: string): boolean {
  return /^:[0-9]{1,5}$/.test(s);
}

// True when the Host header names this machine's loopback interface.
//
// The HOSTNAME is pinned and the port deliberately is not: RUNBOOK-P3.md §2 reaches a peer's GUI
// over `ssh -N -L 7711:127.0.0.1:7710`, so the operator's own tab sends `Host: 127.0.0.1:7711`.
// Pinning the port would break the documented remote-admin flow while adding nothing -- a rebinding
// attacker picks the name, never the port the browser was told to connect to.
//
// Everything else is refused rather than guessed at. A Host that carries userinfo, an unterminated
// bracket, a non-numeric port or a name that merely ends in a loopback label (`127.0.0.1.evil.test`)
// is a parser-confusion attempt, not a caller: the only spellings a browser or curl actually emits
// for this machine are the ones in the set above, bracketed or not.
export function isLoopbackHostHeader(raw: string | null): boolean {
  if (raw === null) return false;
  const value = raw.trim();
  if (value.length === 0 || value.length > MAX_HOST_CHARS) return false;
  // A Host header has no userinfo component; anything spelling one is trying to be read two ways.
  if (value.includes('@') || value.includes('/')) return false;

  let hostname: string;
  if (value.startsWith('[')) {
    const end = value.indexOf(']');
    if (end < 0) return false;
    const rest = value.slice(end + 1);
    if (rest.length > 0 && !isPortSuffix(rest)) return false;
    hostname = value.slice(1, end);
  } else {
    const colon = value.indexOf(':');
    if (colon < 0) {
      hostname = value;
    } else if (value.indexOf(':', colon + 1) >= 0) {
      // Two or more colons and no brackets: a bare IPv6 literal, which is not legal in a Host
      // header but which hand-written clients emit. There is no port to strip, so the whole value
      // has to match the allowlist ('::1' does; '::1:7710' does not, and stays refused).
      hostname = value;
    } else {
      if (!isPortSuffix(value.slice(colon))) return false;
      hostname = value.slice(0, colon);
    }
  }
  return LOOPBACK_HOST_NAMES.has(hostname.toLowerCase());
}

// ---------------------------------------------------------------------------
// Browser CSRF guard for the GUI's own API
// ---------------------------------------------------------------------------

const LOOPBACK_ORIGIN_HOSTS = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);

// True only when the request is actually framed as carrying a body. Content-Length is authoritative
// when present (a browser sends `Content-Length: 0` on a body-less fetch), then chunked framing,
// then the stream itself as a last resort for callers that set neither.
function hasRequestBody(req: Request): boolean {
  const declared = req.headers.get('content-length');
  if (declared !== null) {
    const n = Number(declared);
    return Number.isFinite(n) && n > 0;
  }
  if ((req.headers.get('transfer-encoding') ?? '').toLowerCase().includes('chunked')) return true;
  return req.body !== null;
}

function isLocalOrigin(origin: string, nodePort: number): boolean {
  // Fast path: this daemon's own two spellings.
  if (origin === `http://127.0.0.1:${nodePort}` || origin === `http://localhost:${nodePort}`) return true;
  let parsed: URL;
  try {
    parsed = new URL(origin);
  } catch {
    return false; // includes the literal "null" origin of a sandboxed frame
  }
  if (parsed.protocol !== 'http:') return false;
  return LOOPBACK_ORIGIN_HOSTS.has(parsed.hostname);
}

// node.ts's rejectCrossSite() 403s a request that carries ANY Origin header. That is correct for
// the CLI-facing /exec/* operator routes (no browser is meant to reach them) and it is deliberately
// left alone -- but a browser attaches Origin to every same-origin fetch() POST, so reusing it here
// would 403 the GUI's own first click. This is the sibling guard: same intent, browser-aware.
//
//   - Origin, when present, must be an http: loopback origin. A page on any other origin -- which
//     is every genuine CSRF attempt, since a remote page cannot forge Origin -- is refused.
//     ANY loopback port is accepted, not just this daemon's: the documented remote-admin flow is
//     `ssh -N -L 7711:127.0.0.1:7710 <machine>`, and a tab on 127.0.0.1:7711 must be able to drive
//     the forwarded machine. That widening is safe because the content-type rule below still forces
//     a preflight (which this daemon never answers) on any genuinely cross-origin JSON request.
//   - Sec-Fetch-Site, when present, must be same-origin or none.
//   - Content-Type, when present, must be application/json -- application/json is not a CORS-simple
//     type, so a cross-origin attempt is preflighted and dies before it arrives. When absent, the
//     request must also be body-less: that is the shape of the GUI's bodyless DELETEs (fetch sets
//     no Content-Type without a body), and a body-less mutating request cannot smuggle a payload.
//
// A non-browser local client (curl, the CLI) sends no Origin and no Sec-Fetch-Site and is
// unaffected, exactly as with rejectCrossSite.
export function rejectCrossSiteBrowser(req: Request, nodePort: number): Response | null {
  if (req.method !== 'POST' && req.method !== 'PUT' && req.method !== 'DELETE') return null;

  const origin = req.headers.get('origin');
  if (origin !== null && !isLocalOrigin(origin, nodePort)) {
    return jsonResponse({ error: 'cross-origin requests are not accepted on the local GUI API' }, 403);
  }

  const site = req.headers.get('sec-fetch-site');
  if (site !== null && site !== 'same-origin' && site !== 'none') {
    return jsonResponse({ error: 'cross-site requests are not accepted on the local GUI API' }, 403);
  }

  const declared = req.headers.get('content-type');
  if (declared !== null) {
    const ctype = declared.split(';')[0]!.trim().toLowerCase();
    if (ctype !== 'application/json') {
      return jsonResponse({ error: 'content-type must be application/json' }, 415);
    }
  } else if (hasRequestBody(req)) {
    return jsonResponse({ error: 'content-type must be application/json' }, 415);
  }

  return null;
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

type BodyResult = { ok: true; value: Record<string, unknown> } | { ok: false; res: Response };

export class UiRoutes {
  constructor(private readonly deps: UiRoutesDeps) {}

  private get cfg(): FleetConfig {
    return this.deps.cfg;
  }

  // Returns null ONLY for a path outside the owned prefixes, so node.ts's fetchHandler can fall
  // through to its own dispatch; every path inside them resolves here, 404 included.
  async handle(req: Request, srv: MinimalServer): Promise<Response | null> {
    let url: URL;
    try {
      url = new URL(req.url);
    } catch {
      return null;
    }
    const path = url.pathname;
    const owned =
      path === '/ui' || path.startsWith('/ui/') || path.startsWith('/api/ui/') || path.startsWith('/pair/');
    if (!owned) return null;

    try {
      return await this.route(req, srv, url, path);
    } catch (err) {
      // A feature-local failure degrades to a 500; it never rejects into node.ts's fetch handler.
      log('error', 'uiserve: route failed', { path, error: String(err) });
      return jsonResponse({ error: 'internal error' }, 500);
    }
  }

  private async route(req: Request, srv: MinimalServer, url: URL, path: string): Promise<Response> {
    // The one mesh-reachable route in this module: pairing.ts authenticates it by the MAC on its
    // own payload, so a loopback gate here would make pairing impossible by construction.
    if (path === '/pair/hello') {
      if (req.method !== 'POST') return methodNotAllowed('POST');
      return this.deps.pairing.handleHello(req);
    }
    if (path.startsWith('/pair/')) return notFound();

    // DNS rebinding. isLoopback below proves the TCP peer is this machine, which a rebound page
    // also is: the browser resolves the attacker's name to 127.0.0.1 and connects on its behalf,
    // and every Origin / Sec-Fetch-Site signal then reads same-origin, so rejectCrossSiteBrowser
    // carries no information on this path (and never runs at all for a GET). The Host header is
    // the one field still holding the name the page was served under. Checked here, ahead of the
    // loopback gate, so it covers the assets and every read route -- the mesh secret, the audit
    // log's full argv and a root run's stdout are all GETs.
    //
    // req.url's authority is the Host header on a served request (Bun mirrors it), and is the only
    // authority present when a caller constructs a Request directly, as the route tests do. A
    // request that reaches the wire with no Host at all has a path-only url, which handle() has
    // already turned into a null.
    if (!isLoopbackHostHeader(req.headers.get('host') ?? url.host)) {
      return forbidden('the local GUI answers only to a loopback Host header');
    }

    if (!this.deps.isLoopback(srv, req)) return forbidden('the local GUI is reachable from this machine only');
    // uiEnabled:false means the surface does not exist on this machine -- a 404, not a 403, and it
    // is checked before any handler so nothing behind it can be probed.
    if (!this.cfg.admin.uiEnabled) return notFound();

    if (path.startsWith('/api/ui/')) return this.apiRoute(req, url, path);
    return this.assetRoute(req, path);
  }

  // Allowlist lookup by exact path. Nothing derived from `path` is ever joined onto a filesystem
  // path, so '/ui/../../etc/passwd' (in any encoding that survives URL normalization) simply is
  // not a key in the map.
  private async assetRoute(req: Request, path: string): Promise<Response> {
    const entry = UI_ASSETS.get(path);
    if (!entry) return notFound();
    if (req.method !== 'GET') return methodNotAllowed('GET');

    const [filename, contentType] = entry;
    const file = Bun.file(join(UI_DIR, filename));
    if (!(await file.exists())) {
      log('error', 'uiserve: ui asset missing on disk', { filename, dir: UI_DIR });
      return jsonResponse({ error: 'ui asset missing' }, 500);
    }

    const headers: Record<string, string> = {
      'content-type': contentType,
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
      'referrer-policy': 'no-referrer',
    };
    if (contentType === HTML_TYPE) {
      headers['content-security-policy'] = CSP;
      headers['x-frame-options'] = 'DENY';
    }
    return new Response(file, { headers });
  }

  private async apiRoute(req: Request, url: URL, path: string): Promise<Response> {
    const method = req.method;
    if (method === 'POST' || method === 'PUT' || method === 'DELETE') {
      const rejected = rejectCrossSiteBrowser(req, this.cfg.nodePort);
      if (rejected) return rejected;
    }

    switch (path) {
      case '/api/ui/state':
        if (method !== 'GET') return methodNotAllowed('GET');
        return jsonResponse(await this.deps.buildState());

      case '/api/ui/setup/identity':
        if (method !== 'POST') return methodNotAllowed('POST');
        return this.postIdentity(req);

      case '/api/ui/setup/network-secret':
        if (method === 'GET') return this.getNetworkSecret();
        if (method === 'POST') return this.postNetworkSecret(req);
        return methodNotAllowed('GET, POST');

      case '/api/ui/pair/code':
        if (method === 'GET') return jsonResponse(this.deps.pairing.codeState());
        if (method === 'POST') {
          this.deps.pairing.mintCode();
          return jsonResponse(this.deps.pairing.codeState());
        }
        if (method === 'DELETE') {
          this.deps.pairing.cancelCode();
          return jsonResponse(this.deps.pairing.codeState());
        }
        return methodNotAllowed('GET, POST, DELETE');

      case '/api/ui/pair/redeem':
        if (method !== 'POST') return methodNotAllowed('POST');
        return this.postRedeem(req);

      case '/api/ui/pair/revoke':
        if (method !== 'POST') return methodNotAllowed('POST');
        return this.postRevoke(req);

      case '/api/ui/credentials':
        if (method !== 'GET') return methodNotAllowed('GET');
        return this.getCredentials();

      case '/api/ui/credentials/sudo':
        if (method === 'POST') return this.postSudoCredential(req);
        if (method === 'DELETE') {
          await this.deps.secrets.remove();
          return jsonResponse({ ok: true });
        }
        return methodNotAllowed('POST, DELETE');

      // Two spellings of one handler: /api/ui/lane is the path the GUI uses, /api/ui/admin/lane is
      // the spelling this route shipped under and is kept so an already-written caller keeps
      // working. Both land on the same validation.
      case '/api/ui/lane':
      case '/api/ui/admin/lane':
        if (method !== 'POST') return methodNotAllowed('POST');
        return this.postLane(req);

      case '/api/ui/admin/run':
        if (method !== 'POST') return methodNotAllowed('POST');
        return this.postRun(req);

      case '/api/ui/admin/runs': {
        if (method !== 'GET') return methodNotAllowed('GET');
        const limit = clampLimit(url.searchParams.get('limit'), DEFAULT_RUNS_LIMIT, MAX_RUNS_LIMIT);
        return jsonResponse(this.deps.sshAdmin.listRuns(limit));
      }

      case '/api/ui/admin/status':
        if (method !== 'GET') return methodNotAllowed('GET');
        return jsonResponse(await this.deps.sshAdmin.status());

      case '/api/ui/audit': {
        if (method !== 'GET') return methodNotAllowed('GET');
        const limit = clampLimit(url.searchParams.get('limit'), DEFAULT_AUDIT_LIMIT, MAX_AUDIT_LIMIT);
        return jsonResponse({ entries: await this.deps.tailAudit(limit) });
      }

      case '/api/ui/restart':
        if (method !== 'POST') return methodNotAllowed('POST');
        return this.postRestart();
    }

    if (path.startsWith('/api/ui/admin/run/')) {
      if (method !== 'GET') return methodNotAllowed('GET');
      return this.getRun(path.slice('/api/ui/admin/run/'.length));
    }

    return notFound();
  }

  // -------------------------------------------------------------------------
  // Bodies
  // -------------------------------------------------------------------------

  private async readJsonObject(req: Request, cap = MAX_UI_BODY_BYTES): Promise<BodyResult> {
    const body = await readCappedBody(req, cap, BODY_READ_TIMEOUT_MS);
    if (!body.ok) {
      return {
        ok: false,
        res:
          body.reason === 'too-large'
            ? jsonResponse({ error: 'payload too large' }, 413)
            : badRequest('the request body could not be read'),
      };
    }
    if (body.bytes.length === 0) return { ok: true, value: {} };
    let parsed: unknown;
    try {
      parsed = JSON.parse(new TextDecoder().decode(body.bytes));
    } catch {
      return { ok: false, res: badRequest('the request body is not valid JSON') };
    }
    if (!isPlainObject(parsed)) return { ok: false, res: badRequest('the request body must be a JSON object') };
    return { ok: true, value: parsed };
  }

  // -------------------------------------------------------------------------
  // Setup
  // -------------------------------------------------------------------------

  private async postIdentity(req: Request): Promise<Response> {
    const body = await this.readJsonObject(req);
    if (!body.ok) return body.res;

    const raw = body.value;
    const patch: IdentityPatch = {};
    if (raw.machine !== undefined) {
      if (typeof raw.machine !== 'string' || !MACHINE_NAME_RE.test(raw.machine)) {
        return badRequest('machine must be 1-64 characters of letters, digits, dot, dash or underscore');
      }
      patch.machine = raw.machine;
    }
    if (raw.role !== undefined) {
      if (raw.role !== 'anchor' && raw.role !== 'roamer') return badRequest('role must be anchor or roamer');
      patch.role = raw.role;
    }
    if (raw.meshIp !== undefined) {
      if (typeof raw.meshIp !== 'string' || !MESH_IP_RE.test(raw.meshIp)) return badRequest('meshIp is not an IP address');
      patch.meshIp = raw.meshIp;
    }
    if (raw.nodePort !== undefined) {
      if (!Number.isInteger(raw.nodePort) || (raw.nodePort as number) < 1 || (raw.nodePort as number) > 65535) {
        return badRequest('nodePort must be a port number');
      }
      patch.nodePort = raw.nodePort as number;
    }
    if (raw.networkName !== undefined) {
      if (typeof raw.networkName !== 'string' || !NETWORK_NAME_RE.test(raw.networkName)) {
        return badRequest('networkName must be 1-64 characters of letters, digits, dot, dash or underscore');
      }
      patch.networkName = raw.networkName;
    }
    if (Object.keys(patch).length === 0) return badRequest('nothing to change');

    const result = await this.deps.patchIdentity(patch);
    if (!result.ok) return jsonResponse({ ok: false, message: result.message ?? 'the change was rejected' }, 400);
    return jsonResponse({ ok: true });
  }

  private async getNetworkSecret(): Promise<Response> {
    const state = await this.deps.networkSecret.state();
    const secret = await this.deps.networkSecret.reveal();
    return jsonResponse(secret ? { state, secret } : { state });
  }

  private async postNetworkSecret(req: Request): Promise<Response> {
    const body = await this.readJsonObject(req);
    if (!body.ok) return body.res;
    const action = body.value.action;

    if (action === 'generate') {
      // The generated secret is deliberately dropped here: the GUI re-reads it through the GET
      // route, so a mutating response never carries it.
      await this.deps.networkSecret.generate();
      return jsonResponse({ ok: true });
    }
    if (action === 'stage') {
      const secret = body.value.secret;
      if (typeof secret !== 'string' || !isCleanText(secret.trim(), MAX_MESH_SECRET_CHARS)) {
        return badRequest('that does not look like a mesh secret');
      }
      await this.deps.networkSecret.stage(secret.trim());
      return jsonResponse({ ok: true });
    }
    return badRequest('action must be generate or stage');
  }

  // -------------------------------------------------------------------------
  // Pairing (loopback half; /pair/hello is handled in route())
  // -------------------------------------------------------------------------

  private async postRedeem(req: Request): Promise<Response> {
    const body = await this.readJsonObject(req);
    if (!body.ok) return body.res;
    const { code, host, port } = body.value;

    if (typeof code !== 'string' || !isCleanText(code, 64)) return badRequest('that code is not valid');
    if (typeof host !== 'string' || !isCleanText(host, MAX_HOST_CHARS) || !HOST_RE.test(host)) {
      return badRequest('that address is not valid');
    }
    if (!Number.isInteger(port) || (port as number) < 1 || (port as number) > 65535) {
      return badRequest('that port is not valid');
    }

    // A refused redeem is a 200 with ok:false: the GUI renders fixed copy per reason, and an HTTP
    // error status would throw that reason away.
    return jsonResponse(await this.deps.pairing.redeem({ code, host, port: port as number }));
  }

  // -------------------------------------------------------------------------
  // Credentials
  // -------------------------------------------------------------------------

  // Status only. SudoCredentialStatus has no field that can carry the password, and the ssh trust
  // block is public-key material by definition.
  private async getCredentials(): Promise<Response> {
    const credential = await this.deps.secrets.status();
    // A machine with no ssh identity yet must still render the screen that tells it so.
    const trust = await this.deps.sshAdmin.trust().catch((err: unknown) => {
      log('warn', 'uiserve: ssh trust unavailable', { error: String(err) });
      return { sshPublicKey: '', sshKeyFingerprint: '', hostKeys: [], hostKeyFingerprints: [] } satisfies UiSshTrust;
    });
    const seal = await this.deps.secrets.sealAvailable().catch(() => ({ ok: false, reason: 'unavailable' }));
    return jsonResponse({
      credential,
      trust,
      seal,
      path: join(expandHome(secretsDir(this.cfg)), 'sudo.cred'),
    });
  }

  // THE sensitive handler. Rules it holds, all of them checkable by reading it:
  //   - no log() call at any level, so no formatter can ever see the password;
  //   - the parsed body never lands in a variable that outlives readPassword();
  //   - the response is assembled from SET_REASONS, never from the store's own strings;
  //   - the catch is silent and returns a fixed body, because the only failure detail in scope
  //     could have been derived from the password.
  private async postSudoCredential(req: Request): Promise<Response> {
    const body = await readCappedBody(req, MAX_CREDENTIAL_BODY_BYTES, BODY_READ_TIMEOUT_MS);
    if (!body.ok) {
      return body.reason === 'too-large'
        ? jsonResponse({ ok: false, reason: 'bad-request', message: 'that password is implausibly long' }, 413)
        : jsonResponse({ ok: false, reason: 'bad-request', message: 'the request body could not be read' }, 400);
    }

    let outcome: { ok: boolean; reason?: string };
    try {
      const password = readPassword(body.bytes);
      if (password === null) {
        return jsonResponse({ ok: false, reason: 'bad-request', message: 'no password in the request' }, 400);
      }
      outcome = await this.deps.secrets.set(password);
    } catch {
      return jsonResponse({ ok: false, reason: 'internal' }, 500);
    }

    const reason = typeof outcome.reason === 'string' ? SET_REASONS.get(outcome.reason) : undefined;
    if (outcome.ok === true) return jsonResponse({ ok: true });
    return jsonResponse({ ok: false, reason: reason ?? 'unknown' });
  }

  // -------------------------------------------------------------------------
  // Admin lane
  // -------------------------------------------------------------------------

  // The two switches on the Credentials screen: `enabled` (does this machine originate admin runs)
  // and `acceptIncoming` (does it answer them). Either or both per request.
  //
  // An unknown key is a 400 rather than the ignore postIdentity grants: a body like
  // {enabled:true, acceptIncomming:false} would otherwise half-apply and report a lane state the
  // operator did not ask for. For a privileged toggle, a refused request is the safe half.
  private async postLane(req: Request): Promise<Response> {
    const body = await this.readJsonObject(req);
    if (!body.ok) return body.res;
    const raw = body.value;

    const patch: LanePatch = {};
    for (const key of Object.keys(raw)) {
      if (key !== 'enabled' && key !== 'acceptIncoming') return badRequest(`${key} is not a lane setting`);
    }
    if (raw.enabled !== undefined) {
      if (typeof raw.enabled !== 'boolean') return badRequest('enabled must be true or false');
      patch.enabled = raw.enabled;
    }
    if (raw.acceptIncoming !== undefined) {
      if (typeof raw.acceptIncoming !== 'boolean') return badRequest('acceptIncoming must be true or false');
      patch.acceptIncoming = raw.acceptIncoming;
    }
    if (patch.enabled === undefined && patch.acceptIncoming === undefined) {
      return badRequest('send enabled, acceptIncoming, or both');
    }

    await this.deps.setLane(patch);
    // Reported from cfg rather than from the request: the switches show what the daemon believes,
    // which is also what the next /api/ui/state poll will render.
    return jsonResponse({
      ok: true,
      enabled: this.cfg.admin.enabled,
      acceptIncoming: this.cfg.admin.acceptIncoming,
    });
  }

  // The Revoke control RUNBOOK-P3.md documents. sshAdmin.revokePeer withdraws this machine's SSH
  // trust in the peer -- its authorized_keys line and its pinned host keys -- which is what closes
  // the admin lane to a machine that has left the fleet or been stolen. It is deliberately the
  // whole of what this route does: the peer's config entry and mesh key are node.ts's to remove,
  // and P2 membership is `sukarfleet revoke`.
  //
  // A machine that is not in cfg.peers is still accepted. The state this control exists to clean up
  // is exactly the one where the SSH files hold a peer the config does not -- a pair that died
  // half-applied -- so refusing an unknown name would refuse the case that needs it most.
  private async postRevoke(req: Request): Promise<Response> {
    const body = await this.readJsonObject(req);
    if (!body.ok) return body.res;
    const machine = body.value.machine;
    if (typeof machine !== 'string' || !MACHINE_NAME_RE.test(machine)) {
      return badRequest('machine must be 1-64 characters of letters, digits, dot, dash or underscore');
    }

    await this.deps.sshAdmin.revokePeer(machine);
    // sshadmin.ts audits runs, not trust edits, so the journal is where an operator reconstructs
    // when trust was withdrawn and from which machine.
    log('warn', 'uiserve: ssh admin trust revoked for peer', { machine });
    return jsonResponse({ ok: true, machine });
  }

  // Shape checking stops at "is this JSON of the right kind". Every semantic turndown -- empty
  // reason, unknown machine, oversized argv, rate limit -- belongs to sshadmin.ts, which refuses
  // it AND writes the admin-run-refused audit entry. A 400 here would lose that record.
  private async postRun(req: Request): Promise<Response> {
    const body = await this.readJsonObject(req);
    if (!body.ok) return body.res;
    const raw = body.value;

    const request: AdminRunRequest = {
      machine: typeof raw.machine === 'string' ? raw.machine : '',
      argv: (Array.isArray(raw.argv) ? raw.argv : []) as string[],
      reason: typeof raw.reason === 'string' ? raw.reason : '',
      requestedBy: { kind: 'operator', client: 'ui' },
    };
    if (typeof raw.timeoutSec === 'number') request.timeoutSec = raw.timeoutSec;

    const { runId } = await this.deps.sshAdmin.startRun(request);
    return jsonResponse({ runId });
  }

  private getRun(rawId: string): Response {
    let runId: string;
    try {
      runId = decodeURIComponent(rawId);
    } catch {
      return notFound();
    }
    if (!RUN_ID_RE.test(runId)) return notFound();
    const view = this.deps.sshAdmin.getRun(runId);
    if (!view) return notFound();
    return jsonResponse(view);
  }

  private postRestart(): Response {
    // Answer first: the restart tears this process down, so a response written after it would
    // never reach the page that asked for it.
    const timer = setTimeout(() => {
      void this.deps.restartDaemon().catch((err: unknown) => {
        log('error', 'uiserve: restart failed', { error: String(err) });
      });
    }, RESTART_DELAY_MS);
    (timer as unknown as { unref?: () => void }).unref?.();
    return jsonResponse({ ok: true });
  }
}

// Parses the credential body and returns ONLY the password string, so the object that contained it
// is unreachable the moment this returns. Null covers every rejection (bad JSON, wrong shape, empty
// or implausible length) with no detail, because no detail here is safe to describe.
function readPassword(bytes: Uint8Array): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    return null;
  }
  if (!isPlainObject(parsed)) return null;
  const value = parsed.password;
  if (typeof value !== 'string') return null;
  if (value.length === 0 || value.length > MAX_PASSWORD_CHARS) return null;
  return value;
}
