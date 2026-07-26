// SPDX-License-Identifier: AGPL-3.0-or-later
// Stateless Streamable-HTTP MCP server. This is the wedge: the surface an agent reaches the
// fleet through.
//
// Loopback-only. "Stateless" means no session/connection state is kept between requests -- every
// POST is parsed, dispatched, and answered independently, so a fresh JSON-RPC handling pass
// happens per call rather than a long-lived MCP session object.
//
// This implements the minimal JSON-RPC 2.0 / MCP subset needed directly rather than taking an SDK
// dependency: initialize, notifications/initialized, tools/list, tools/call. Only POST is served;
// there is no server-initiated push, so GET (SSE stream open) is refused rather than
// half-implemented.
//
// Tools: fleet.peers (live peer table), fleet.tail (recent audit entries), and the admin lane's
// fleet.admin_run / fleet.admin_status.
//
// No tool accepts, prompts for, returns, or names a password value: the sudo credential never
// leaves the machine that owns it (see sshadmin.ts's header), so there is nothing for this surface
// to carry even by accident. The refusal copy below is the one place an agent is told how to FIX a
// credential problem, which is why it names the blocking machine and how to reach its console.
//
// This module imports no sibling lane directly -- it depends on the shared layer plus its own
// declared `McpDeps` seam, and leaves wiring the real implementations to node.ts.

import type {
  AdminRefusalReason,
  AdminRunRequest,
  AdminRunResult,
  AdminStatusEntry,
  AuditEntry,
  FleetConfig,
  PeerView,
} from './types';
import { log } from './util';

export const MCP_LOOPBACK_HOST = '127.0.0.1';
export const MCP_LOOPBACK_PORT = 7719;
export const MCP_PATH = '/mcp';

const SERVER_NAME = 'sukarfleet';
const SERVER_VERSION = '0.1.0';
// MCP protocol version this server speaks. Pinned, not negotiated -- a stateless
// per-request server has no session in which to remember a client's negotiated
// version anyway.
const PROTOCOL_VERSION = '2024-11-05';

const DEFAULT_TAIL_LIMIT = 20;
const MAX_TAIL_LIMIT = 200;

// Stamped on every fleet.admin_run's audit entry. Fixed rather than caller-supplied: admin_run's
// schema is additionalProperties:false, and an origin label an agent can choose is not a label.
const MCP_CLIENT_LABEL = 'mcp';

// ---------------------------------------------------------------------------
// Dependency seam
// ---------------------------------------------------------------------------

export interface McpDeps {
  cfg: FleetConfig;
  // Live peer table accessor -- e.g. `() => gossip.getPeerViews(nowMs())` from
  // src/gossip.ts's Gossip.getPeerViews(). Read fresh on every fleet.peers call
  // (no caching here, matching "fresh state per request").
  listPeers: () => PeerView[];
  // Most-recent-first slice of the signed audit log, at most `limit` entries.
  // Real implementation: src/audit.ts.
  tailAudit: (limit: number) => Promise<AuditEntry[]>;
  // p3 admin lane. Synchronous by design (plan C8): an agent reasons far better
  // about a real exit code than about a receipt it then has to poll for.
  // Real implementations: SshAdmin#runAdmin / SshAdmin#status (src/sshadmin.ts).
  // Required, not optional: a daemon that forgets to wire these must fail to
  // compile rather than serve an agent surface that silently does nothing.
  adminRun: (req: AdminRunRequest) => Promise<AdminRunResult>;
  adminStatus: () => Promise<AdminStatusEntry[]>;
}

// ---------------------------------------------------------------------------
// Refusal copy
//
// Every string here names the machine that has to change, what to change, and how
// to reach that machine's console. `ssh -N -L 7711:127.0.0.1:7710 <machine>` is
// the documented remote-console flow (ui/app.js's REMOTE_CONSOLE, uiserve.ts's
// rejectCrossSiteBrowser comment): the GUI is loopback-only on every machine, so
// fixing a credential on the far side means forwarding its port, not opening a
// remote URL. Deliberately mirrors ui/app.js's COPY.refusal so an agent and the
// operator staring at the same failure are told the same thing.
// ---------------------------------------------------------------------------

const REMOTE_CONSOLE = (m: string): string =>
  `Forward it with \`ssh -N -L 7711:127.0.0.1:7710 ${m}\` and open http://127.0.0.1:7711/ui/.`;

export const ADMIN_REFUSAL_ADVICE: Record<AdminRefusalReason, (target: string, local: string) => string> = {
  'lane-disabled-local': (_t, l) =>
    `The admin lane is switched off on ${l}, the machine this call was made from. Turn on the "Admin lane" ` +
    `switch on the Credentials screen of ${l}'s own console at http://127.0.0.1:7710/ui/, then run the ` +
    'command again.',
  'lane-disabled-target': (t) =>
    `${t} is not accepting admin commands from the fleet. Switch it on under Credentials in ${t}'s own ` +
    `console. ${REMOTE_CONSOLE(t)}`,
  'not-paired': (t, l) =>
    `${l} is not paired with ${t}. Open Pair on one machine, show the code, and enter it on the other.`,
  unreachable: (t) =>
    `${t} did not answer. Check that it is awake and that easytier-fleet.service is running there.`,
  'no-credential': (t) =>
    `${t} has no sudo password stored, so it cannot run anything as root. Save one in ${t}'s own console; ` +
    `the password never leaves that machine and no agent can read it back. ${REMOTE_CONSOLE(t)}`,
  'credential-stale': (t) =>
    `${t} rejected its own stored sudo password, so the command was not run. It was probably changed. ` +
    `Save the current one in ${t}'s own console. ${REMOTE_CONSOLE(t)}`,
  'missing-reason': () =>
    'Every admin run needs a reason. It is the only thing that makes the audit log readable months from now.',
  'bad-argv': () =>
    'That command could not be turned into arguments. Pass argv as an array of separate tokens, with no shell quoting.',
  'rate-limited': (t) => `Too many admin runs against ${t} in the last minute. Wait, then try again.`,
  'refused-argv': (t) =>
    `${t} refused this command: it touches the credential store or the sealing tool. The refusal is recorded ` +
    'in the audit log.',
  timeout: (t) =>
    `The command was still running when the timeout expired on ${t}. Nothing was rolled back; check the ` +
    'machine before retrying.',
  'hostkey-mismatch': (t) =>
    `The SSH host key ${t} presented does not match the pinned one. Nothing was sent. Investigate before ` +
    'retrying, then re-pair the machines.',
  'not-configured': (t, l) =>
    `The admin lane is not configured: either the fleet SSH key or known_hosts is missing on ${l} (re-run ` +
    `install/quickstart.sh there), or ${t}'s credential store is not a private directory. ${REMOTE_CONSOLE(t)}`,
};

// Undefined for a run that was not refused -- there is nothing to advise about a command that ran.
export function adminRefusalAdvice(
  refusal: AdminRefusalReason | undefined,
  target: string,
  local: string,
): string | undefined {
  if (!refusal) return undefined;
  const copy = ADMIN_REFUSAL_ADVICE[refusal];
  return copy ? copy(target || 'the target machine', local || 'this machine') : undefined;
}

// ---------------------------------------------------------------------------
// Tool catalog
// ---------------------------------------------------------------------------

interface McpToolDef {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

const TOOLS: McpToolDef[] = [
  {
    name: 'fleet.peers',
    description: 'List the live fleet peer table (gossip presence merged with configured peers).',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'fleet.admin_run',
    description:
      'Run a command as root on a fleet machine over the SSH admin lane, and wait for it. Returns the ' +
      'real exit code, stdout and stderr. The target machine unseals its OWN sudo password locally; no ' +
      'credential crosses the network and none is readable from here. "reason" is required and is written ' +
      'to the signed audit log with the full argv.',
    inputSchema: {
      type: 'object',
      properties: {
        machine: { type: 'string', description: 'Target machine name (a configured peer, or this machine).' },
        argv: {
          type: 'array',
          items: { type: 'string' },
          description: 'Argv tokens, already split. Not a shell string: use ["bash","-c","..."] if you need a shell.',
        },
        reason: { type: 'string', description: 'Why this is being run. Required; recorded in the audit log.' },
        timeoutSec: { type: 'number', description: 'Per-run timeout; clamped down to admin.maxRunTimeoutSec.' },
      },
      required: ['machine', 'argv', 'reason'],
      additionalProperties: false,
    },
  },
  {
    name: 'fleet.admin_status',
    description:
      'Per-machine readiness of the SSH admin lane: paired, reachable, lane enabled, and whether a sudo ' +
      'credential is stored and usable. Call this first when fleet.admin_run is refused.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'fleet.tail',
    description: 'Return the most recent signed audit log entries, newest first.',
    inputSchema: {
      type: 'object',
      properties: { limit: { type: 'number', description: `Max entries to return (default ${DEFAULT_TAIL_LIMIT}).` } },
      additionalProperties: false,
    },
  },
];

// ---------------------------------------------------------------------------
// Tool implementations
// ---------------------------------------------------------------------------

interface ToolTextContent {
  type: 'text';
  text: string;
}

interface ToolCallResult {
  content: ToolTextContent[];
  isError?: boolean;
}

// `isError` is set for a result the agent must not read as success while still needing its
// structure (an admin refusal: a JSON body plus the flag, rather than errorResult's bare string).
function textResult(value: unknown, isError = false): ToolCallResult {
  return { content: [{ type: 'text', text: JSON.stringify(value) }], ...(isError ? { isError: true } : {}) };
}

function errorResult(message: string): ToolCallResult {
  return { content: [{ type: 'text', text: message }], isError: true };
}

function buildPeerTable(deps: McpDeps): unknown[] {
  const live = deps.listPeers();
  const byName = new Map(live.map((p) => [p.name, p]));
  return deps.cfg.peers.map((peer) => {
    const view = byName.get(peer.name) ?? null;
    return {
      name: peer.name,
      meshIp: peer.meshIp,
      nodePort: peer.nodePort,
      enrolled: peer.publicKeyJwk !== null,
      online: view?.online ?? false,
      syncStale: view?.syncStale ?? true,
      lastSeenMs: view?.lastSeenMs ?? null,
    };
  });
}

function isStringArray(v: unknown): v is string[] {
  return Array.isArray(v) && v.length > 0 && v.every((x) => typeof x === 'string' && x.length > 0);
}

// The agent-facing admin path. Every semantic turndown -- unknown machine, oversized argv, rate
// limit, target-side refusal -- belongs to sshadmin.ts, which refuses it AND writes the audit
// entry; validating any of that a second time here would only let the two drift. The one check
// this function makes itself is `reason`, because an absent reason is refused before a runId is
// minted and there is nothing for the daemon to record either way.
//
// Nothing in this function can name a password: the request struct has no credential field, and
// the response is either the target's own command output or a fixed refusal string.
async function runAdminCommand(args: Record<string, unknown>, deps: McpDeps): Promise<ToolCallResult> {
  const machine = typeof args.machine === 'string' ? args.machine : '';
  const reason = typeof args.reason === 'string' ? args.reason : '';

  if (reason.trim().length === 0) {
    return textResult(
      {
        runId: null,
        machine,
        ok: false,
        exitCode: null,
        refusal: 'missing-reason' satisfies AdminRefusalReason,
        message: 'every admin run needs a reason; it is the audit log',
        advice: adminRefusalAdvice('missing-reason', machine, deps.cfg.machine),
      },
      true,
    );
  }

  const request: AdminRunRequest = {
    machine,
    argv: (Array.isArray(args.argv) ? args.argv : []) as string[],
    reason,
    // MCP is the agent surface by definition; there is no operator at this end to co-sign for.
    requestedBy: { kind: 'agent', client: MCP_CLIENT_LABEL },
  };
  if (typeof args.timeoutSec === 'number') request.timeoutSec = args.timeoutSec;

  let result: AdminRunResult;
  try {
    result = await deps.adminRun(request);
  } catch (err) {
    // runAdmin already swallows its own failures into a result; this only catches a wiring fault,
    // and it degrades rather than throwing into the JSON-RPC layer.
    log('error', 'mcp: fleet.admin_run failed', { targetMachine: machine, error: String(err) });
    return errorResult('fleet.admin_run: the admin lane is not available on this daemon');
  }

  const advice = adminRefusalAdvice(result.refusal, result.machine || machine, deps.cfg.machine);
  // A refused run is a tool error (nothing executed). A command that ran and exited non-zero is
  // NOT: that exit code is the answer the agent asked for.
  return textResult(advice ? { ...result, advice } : result, result.refusal !== undefined);
}

async function callTool(name: string, args: Record<string, unknown>, deps: McpDeps): Promise<ToolCallResult> {
  if (name === 'fleet.peers') {
    return textResult({ peers: buildPeerTable(deps) });
  }

  if (name === 'fleet.admin_run') {
    return runAdminCommand(args, deps);
  }

  if (name === 'fleet.admin_status') {
    try {
      // Not gated on cfg.admin.enabled: a disabled lane is exactly what this tool exists to
      // report, and every entry carries its own laneEnabled flag.
      return textResult({ machines: await deps.adminStatus() });
    } catch (err) {
      log('error', 'mcp: fleet.admin_status failed', { error: String(err) });
      return errorResult('fleet.admin_status: the admin lane is not available on this daemon');
    }
  }

  if (name === 'fleet.tail') {
    const limitRaw = args.limit;
    const limit =
      typeof limitRaw === 'number' && Number.isFinite(limitRaw) && limitRaw > 0
        ? Math.min(Math.floor(limitRaw), MAX_TAIL_LIMIT)
        : DEFAULT_TAIL_LIMIT;
    const entries = await deps.tailAudit(limit);
    return textResult({ entries });
  }

  return errorResult(`unknown tool: ${name}`);
}

// ---------------------------------------------------------------------------
// JSON-RPC 2.0 / MCP message handling
// ---------------------------------------------------------------------------

type JsonRpcId = string | number | null;

interface JsonRpcRequest {
  jsonrpc: '2.0';
  id?: JsonRpcId;
  method: string;
  params?: unknown;
}

interface JsonRpcSuccess {
  jsonrpc: '2.0';
  id: JsonRpcId;
  result: unknown;
}

interface JsonRpcErrorBody {
  jsonrpc: '2.0';
  id: JsonRpcId;
  error: { code: number; message: string };
}

function ok(id: JsonRpcId, result: unknown): JsonRpcSuccess {
  return { jsonrpc: '2.0', id, result };
}

function rpcError(id: JsonRpcId, code: number, message: string): JsonRpcErrorBody {
  return { jsonrpc: '2.0', id, error: { code, message } };
}

function isJsonRpcRequest(v: unknown): v is JsonRpcRequest {
  if (typeof v !== 'object' || v === null) return false;
  const obj = v as Record<string, unknown>;
  return obj.jsonrpc === '2.0' && typeof obj.method === 'string';
}

// Returns null for a JSON-RPC *notification* (no `id`): per spec, notifications
// never get a response -- includes notifications/initialized, the only one this
// stateless server needs to accept (and ignore; there is no session to mark
// "initialized" in).
async function handleMessage(msg: JsonRpcRequest, deps: McpDeps): Promise<JsonRpcSuccess | JsonRpcErrorBody | null> {
  const hasId = msg.id !== undefined;
  const id: JsonRpcId = msg.id ?? null;

  if (msg.method.startsWith('notifications/')) return null;

  if (msg.method === 'initialize') {
    return ok(id, {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: { tools: {} },
      serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
    });
  }

  if (msg.method === 'tools/list') {
    return ok(id, { tools: TOOLS });
  }

  if (msg.method === 'tools/call') {
    const params = (msg.params ?? {}) as { name?: unknown; arguments?: unknown };
    const name = params.name;
    if (typeof name !== 'string') return rpcError(id, -32602, 'tools/call: "name" must be a string');
    if (!TOOLS.some((t) => t.name === name)) return rpcError(id, -32601, `unknown tool: ${name}`);
    const args = (params.arguments && typeof params.arguments === 'object' ? params.arguments : {}) as Record<
      string,
      unknown
    >;
    try {
      const result = await callTool(name, args, deps);
      return ok(id, result);
    } catch (err) {
      log('error', 'mcp: tool call threw', { name, error: String(err) });
      return rpcError(id, -32000, `tool call failed: ${String(err)}`);
    }
  }

  // A request (has an id) for an unknown method gets a JSON-RPC error reply; a
  // notification-shaped unknown method (no id, doesn't match notifications/*
  // above) is dropped rather than answered, matching spec semantics for id-less
  // messages.
  if (!hasId) return null;
  return rpcError(id, -32601, `method not found: ${msg.method}`);
}

async function safeHandleOne(item: unknown, deps: McpDeps): Promise<JsonRpcSuccess | JsonRpcErrorBody | null> {
  if (!isJsonRpcRequest(item)) {
    const maybeId =
      typeof item === 'object' && item !== null && 'id' in (item as Record<string, unknown>)
        ? ((item as Record<string, unknown>).id as JsonRpcId)
        : null;
    return rpcError(maybeId, -32600, 'invalid request');
  }
  return handleMessage(item, deps);
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

// ---------------------------------------------------------------------------
// HTTP surface
// ---------------------------------------------------------------------------

// Builds the request handler for POST /mcp. Every call handles exactly one
// HTTP request's JSON-RPC payload (single message or batch array) and returns
// -- no state survives between calls, so "fresh server per request" is
// trivially true of a plain function too; a real McpServer/session object from
// an SDK would buy nothing here.
export function createMcpFetchHandler(deps: McpDeps): (req: Request) => Promise<Response> {
  return async (req: Request): Promise<Response> => {
    const url = new URL(req.url);
    if (url.pathname !== MCP_PATH) return new Response('not found', { status: 404 });

    if (req.method !== 'POST') {
      // No server-initiated notifications exist in this design, so the
      // Streamable-HTTP GET (SSE stream open) has nothing to serve.
      return new Response('method not allowed', { status: 405, headers: { Allow: 'POST' } });
    }

    // This server binds loopback and authenticates nothing beyond that. Loopback is a network
    // boundary, not a caller identity: a page in a browser on this machine can POST here, and
    // with a text/plain body that is a CORS-"simple" request needing no preflight -- so a visited
    // web page could drive the admin lane on this machine's behalf. Rejecting any
    // Origin/cross-site marker and demanding application/json forces a preflight this handler
    // never answers. Local non-browser clients (the CLI, curl, an MCP client) send neither header
    // and already use application/json.
    if (req.headers.get('origin') !== null) {
      return jsonResponse(rpcError(null, -32600, 'cross-origin requests are not accepted'), 403);
    }
    const fetchSite = req.headers.get('sec-fetch-site');
    if (fetchSite !== null && fetchSite !== 'same-origin' && fetchSite !== 'none') {
      return jsonResponse(rpcError(null, -32600, 'cross-site requests are not accepted'), 403);
    }
    const contentType = (req.headers.get('content-type') ?? '').split(';')[0]!.trim().toLowerCase();
    if (contentType !== 'application/json') {
      return jsonResponse(rpcError(null, -32600, 'content-type must be application/json'), 415);
    }

    let body: unknown;
    try {
      body = await req.json();
    } catch {
      return jsonResponse(rpcError(null, -32700, 'parse error'), 400);
    }

    if (Array.isArray(body)) {
      if (body.length === 0) return jsonResponse(rpcError(null, -32600, 'invalid request: empty batch'), 400);
      const responses: (JsonRpcSuccess | JsonRpcErrorBody)[] = [];
      for (const item of body) {
        const res = await safeHandleOne(item, deps);
        if (res) responses.push(res);
      }
      if (responses.length === 0) return new Response(null, { status: 202 });
      return jsonResponse(responses);
    }

    const res = await safeHandleOne(body, deps);
    if (res === null) return new Response(null, { status: 202 }); // notification: no reply body
    return jsonResponse(res);
  };
}

export interface McpServerHandle {
  stop(): void;
  hostname: string;
  port: number;
}

// Binds strictly to 127.0.0.1 (house pattern #5: MCP + operator surfaces are
// loopback-only; mesh routes are the only ones that authenticate peers).
// Refuses to start on any other hostname rather than silently narrowing it,
// so a misconfigured caller fails loudly at startup instead of leaking an
// unauthenticated agent-exec surface onto the mesh or the world.
export function startMcpServer(deps: McpDeps, opts: { hostname?: string; port?: number } = {}): McpServerHandle {
  const hostname = opts.hostname ?? MCP_LOOPBACK_HOST;
  if (hostname !== MCP_LOOPBACK_HOST) {
    throw new Error(
      `sukarfleet mcp: refusing non-loopback bind host ${JSON.stringify(hostname)} (must be ${JSON.stringify(MCP_LOOPBACK_HOST)})`,
    );
  }
  const port = opts.port ?? MCP_LOOPBACK_PORT;
  const fetchHandler = createMcpFetchHandler(deps);
  const server = Bun.serve({ hostname, port, idleTimeout: 0, fetch: fetchHandler });
  const boundPort = server.port ?? port;
  log('info', 'mcp: loopback MCP server listening', { hostname, port: boundPort });
  return {
    stop: () => server.stop(),
    hostname,
    port: boundPort,
  };
}
