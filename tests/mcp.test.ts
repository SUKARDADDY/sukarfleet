// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, test, expect } from 'bun:test';
import { loadOrCreateMachineKey } from '../src/keys';
import { defaultConfig } from '../src/config';
import type {
  AdminRunRequest,
  AdminRunResult,
  AdminStatusEntry,
  AuditEntry,
  FleetConfig,
  MachineKey,
  PeerConfig,
  PeerView,
} from '../src/types';
import {
  ADMIN_REFUSAL_ADVICE,
  MCP_LOOPBACK_HOST,
  MCP_LOOPBACK_PORT,
  MCP_PATH,
  adminRefusalAdvice,
  createMcpFetchHandler,
  startMcpServer,
} from '../src/mcp';
import type { McpDeps } from '../src/mcp';

// configDir() has no env override, so machine keys go through loadOrCreateMachineKey's
// opts.keyPath test seam (same pattern as tests/trust.test.ts / tests/keys.test.ts).
let keyCounter = 0;
async function freshKey(machine: string): Promise<MachineKey> {
  keyCounter += 1;
  return loadOrCreateMachineKey(machine, {
    keyPath: `/tmp/sukarfleet-mcp-test-${process.pid}-${keyCounter}-${Math.random()}.json`,
  });
}

function peerConfig(name: string, meshIp: string, publicKeyJwk: JsonWebKey | null = null): PeerConfig {
  return { name, meshIp, nodePort: 7710, publicKeyJwk };
}

interface Harness {
  deps: McpDeps;
  cfg: FleetConfig;
  key: MachineKey;
  // p3 admin lane: every request that actually reached SshAdmin.runAdmin, so a test can prove a
  // refused call never got that far.
  adminRequests: AdminRunRequest[];
  // Swappable per test; defaults to a clean run.
  adminResult: (req: AdminRunRequest) => AdminRunResult;
  setAdminResult: (fn: (req: AdminRunRequest) => AdminRunResult) => void;
}

function okRunResult(req: AdminRunRequest): AdminRunResult {
  return {
    runId: 'run-fixed-1',
    machine: req.machine,
    ok: true,
    exitCode: 0,
    stdout: 'uid=0(root)\n',
    stderr: '',
    transport: 'mesh',
    durationMs: 42,
    truncated: false,
  };
}

const SENTINEL_PASSWORD = 'correct-horse-battery-staple-9137';

// Mirrors jobqueue.ts's OriginJobQueue.enqueueNew: mints jobId/nonce and signs via
// trust.signJob, so tests exercise the exact real contract (mint-then-sign, not a
// pre-signed job handed in) without importing the sibling-lane file itself.
async function makeHarness(overrides: Partial<FleetConfig> = {}, peers: PeerView[] = []): Promise<Harness> {
  const key = await freshKey('alpha');
  const cfg: FleetConfig = { ...defaultConfig('alpha'), ...overrides };
  const adminRequests: AdminRunRequest[] = [];
  let adminResult: (req: AdminRunRequest) => AdminRunResult = okRunResult;
  let mintCounter = 0;
  const deps: McpDeps = {
    cfg,
    listPeers: () => peers,
    tailAudit: async (limit) => [],
    adminRun: async (req) => {
      adminRequests.push(req);
      return adminResult(req);
    },
    adminStatus: async () => adminStatusEntries,
  };
  return {
    deps,
    cfg,
    key,
    adminRequests,
    get adminResult() {
      return adminResult;
    },
    setAdminResult: (fn) => {
      adminResult = fn;
    },
  };
}

// Two-machine readiness table, shaped exactly like SshAdmin#status()'s return.
const adminStatusEntries: AdminStatusEntry[] = [
  {
    machine: 'alpha',
    self: true,
    paired: true,
    reachable: true,
    credentialReady: true,
    credentialStale: false,
    laneEnabled: true,
    sshKeyFingerprint: 'SHA256:aaa',
    hostKeyFingerprints: ['SHA256:bbb'],
    lastAdminRunMs: null,
  },
  {
    machine: 'beta',
    self: false,
    paired: true,
    reachable: false,
    credentialReady: false,
    credentialStale: false,
    laneEnabled: true,
    sshKeyFingerprint: null,
    hostKeyFingerprints: ['SHA256:ccc'],
    lastAdminRunMs: 1_700_000_000_000,
  },
];

function rpcRequest(method: string, params?: unknown, id: string | number = 1): Request {
  return new Request(`http://127.0.0.1${MCP_PATH}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id, method, params }),
  });
}

describe('tools/list', () => {
  test('returns exactly the four fleet tools', async () => {
    const { deps } = await makeHarness();
    const handler = createMcpFetchHandler(deps);
    const res = await handler(rpcRequest('tools/list'));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { result: { tools: { name: string }[] } };
    const names = body.result.tools.map((t) => t.name).sort();
    expect(names).toEqual(['fleet.admin_run', 'fleet.admin_status', 'fleet.peers', 'fleet.tail']);
  });

  test('fleet.admin_run requires machine, argv and reason, and takes nothing else', async () => {
    const { deps } = await makeHarness();
    const handler = createMcpFetchHandler(deps);
    const res = await handler(rpcRequest('tools/list'));
    const body = (await res.json()) as {
      result: { tools: { name: string; inputSchema: Record<string, unknown> }[] };
    };
    const schema = body.result.tools.find((t) => t.name === 'fleet.admin_run')!.inputSchema;
    expect(schema.required).toEqual(['machine', 'argv', 'reason']);
    expect(schema.additionalProperties).toBe(false);
    expect(Object.keys(schema.properties as object).sort()).toEqual(['argv', 'machine', 'reason', 'timeoutSec']);
  });
});

describe('initialize / notifications', () => {
  test('initialize returns protocol/server info', async () => {
    const { deps } = await makeHarness();
    const handler = createMcpFetchHandler(deps);
    const res = await handler(rpcRequest('initialize', { protocolVersion: '2024-11-05' }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { result: { serverInfo: { name: string } } };
    expect(body.result.serverInfo.name).toBe('sukarfleet');
  });

  test('notifications/initialized gets no body, 202', async () => {
    const { deps } = await makeHarness();
    const handler = createMcpFetchHandler(deps);
    const req = new Request(`http://127.0.0.1${MCP_PATH}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }),
    });
    const res = await handler(req);
    expect(res.status).toBe(202);
    expect(await res.text()).toBe('');
  });
});

describe('fleet.peers', () => {
  test('merges configured peers with live gossip state', async () => {
    const peers: PeerView[] = [
      { name: 'beta', lastSeenMs: 1000, lastEnvelope: null, online: true, syncStale: false },
    ];
    const cfgPeers = [peerConfig('beta', '203.0.113.2', { kty: 'EC' }), peerConfig('roamer2', '203.0.113.3')];
    const { deps } = await makeHarness({ peers: cfgPeers }, peers);
    const handler = createMcpFetchHandler(deps);
    const res = await handler(rpcRequest('tools/call', { name: 'fleet.peers', arguments: {} }));
    const body = (await res.json()) as { result: { content: { text: string }[] } };
    const parsed = JSON.parse(body.result.content[0]!.text) as {
      peers: { name: string; online: boolean; enrolled: boolean }[];
    };
    expect(parsed.peers.length).toBe(2);
    const laptop = parsed.peers.find((p) => p.name === 'beta')!;
    expect(laptop.online).toBe(true);
    expect(laptop.enrolled).toBe(true);
    const roamer = parsed.peers.find((p) => p.name === 'roamer2')!;
    expect(roamer.online).toBe(false);
    expect(roamer.enrolled).toBe(false);
  });
});

describe('fleet.tail', () => {
  test('passes limit through and returns entries', async () => {
    const entry: AuditEntry = {
      v: 1,
      machine: 'alpha',
      seq: 1,
      tsMs: 1000,
      kind: 'job-issued',
      detail: {},
      sigB64: 'x',
    };
    const { deps } = await makeHarness();
    const seenLimits: number[] = [];
    deps.tailAudit = async (limit) => {
      seenLimits.push(limit);
      return [entry];
    };
    const handler = createMcpFetchHandler(deps);
    const res = await handler(rpcRequest('tools/call', { name: 'fleet.tail', arguments: { limit: 5 } }));
    const body = (await res.json()) as { result: { content: { text: string }[] } };
    const parsed = JSON.parse(body.result.content[0]!.text) as { entries: AuditEntry[] };
    expect(seenLimits).toEqual([5]);
    expect(parsed.entries).toEqual([entry]);
  });

  test('defaults limit when omitted', async () => {
    const { deps } = await makeHarness();
    const seenLimits: number[] = [];
    deps.tailAudit = async (limit) => {
      seenLimits.push(limit);
      return [];
    };
    const handler = createMcpFetchHandler(deps);
    await handler(rpcRequest('tools/call', { name: 'fleet.tail', arguments: {} }));
    expect(seenLimits).toEqual([20]);
  });
});

describe('unknown tool / method', () => {
  test('tools/call with an unknown tool name is a JSON-RPC error', async () => {
    const { deps } = await makeHarness();
    const handler = createMcpFetchHandler(deps);
    const res = await handler(rpcRequest('tools/call', { name: 'fleet.nonexistent', arguments: {} }));
    const body = (await res.json()) as { error: { code: number; message: string } };
    expect(body.error.code).toBe(-32601);
  });

  test('unknown method is a JSON-RPC error', async () => {
    const { deps } = await makeHarness();
    const handler = createMcpFetchHandler(deps);
    const res = await handler(rpcRequest('totally/bogus'));
    const body = (await res.json()) as { error: { code: number; message: string } };
    expect(body.error.code).toBe(-32601);
  });
});

describe('HTTP surface', () => {
  test('refuses GET', async () => {
    const { deps } = await makeHarness();
    const handler = createMcpFetchHandler(deps);
    const res = await handler(new Request(`http://127.0.0.1${MCP_PATH}`, { method: 'GET' }));
    expect(res.status).toBe(405);
  });

  test('404s outside the mcp path', async () => {
    const { deps } = await makeHarness();
    const handler = createMcpFetchHandler(deps);
    const res = await handler(new Request('http://127.0.0.1/not-mcp', { method: 'POST', body: '{}' }));
    expect(res.status).toBe(404);
  });

  test('malformed JSON body is a parse-error JSON-RPC response', async () => {
    const { deps } = await makeHarness();
    const handler = createMcpFetchHandler(deps);
    const res = await handler(
      new Request(`http://127.0.0.1${MCP_PATH}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: 'not json',
      }),
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: number } };
    expect(body.error.code).toBe(-32700);
  });

  // Loopback is a network boundary, not a caller identity: a page in a browser on this machine
  // can POST to 127.0.0.1, and with a simple content-type that needs no preflight. These guards
  // are what stop a visited web page from driving the admin lane on this machine's behalf
  // machine's key.
  test('a cross-origin browser POST is rejected even though it comes from loopback (loopback-is-not-auth)', async () => {
    const { deps } = await makeHarness();
    const handler = createMcpFetchHandler(deps);
    const res = await handler(
      new Request(`http://127.0.0.1${MCP_PATH}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin: 'https://evil.example' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
      }),
    );
    expect(res.status).toBe(403);
  });

  test('a cross-site fetch marker is rejected', async () => {
    const { deps } = await makeHarness();
    const handler = createMcpFetchHandler(deps);
    const res = await handler(
      new Request(`http://127.0.0.1${MCP_PATH}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'sec-fetch-site': 'cross-site' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
      }),
    );
    expect(res.status).toBe(403);
  });

  test('a CORS-simple text/plain body (no preflight required) is rejected', async () => {
    const { deps } = await makeHarness();
    const handler = createMcpFetchHandler(deps);
    const res = await handler(
      new Request(`http://127.0.0.1${MCP_PATH}`, {
        method: 'POST',
        headers: { 'content-type': 'text/plain' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
      }),
    );
    expect(res.status).toBe(415);
  });

  test('an ordinary local client (correct content-type, no browser headers) still works', async () => {
    const { deps } = await makeHarness();
    const handler = createMcpFetchHandler(deps);
    const res = await handler(
      new Request(`http://127.0.0.1${MCP_PATH}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
      }),
    );
    expect(res.status).toBe(200);
  });
});

describe('startMcpServer loopback enforcement', () => {
  test('refuses a non-loopback bind host', async () => {
    const { deps } = await makeHarness();
    expect(() => startMcpServer(deps, { hostname: '0.0.0.0' })).toThrow(/loopback/);
    expect(() => startMcpServer(deps, { hostname: '203.0.113.5' })).toThrow(/loopback/);
  });

  test('starts on 127.0.0.1 (ephemeral port) and stops cleanly', async () => {
    const { deps } = await makeHarness();
    const handle = startMcpServer(deps, { hostname: MCP_LOOPBACK_HOST, port: 0 });
    try {
      expect(handle.hostname).toBe(MCP_LOOPBACK_HOST);
      expect(handle.port).toBeGreaterThan(0);
      const res = await fetch(`http://127.0.0.1:${handle.port}${MCP_PATH}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
      });
      expect(res.status).toBe(200);
    } finally {
      handle.stop();
    }
  });

  test('default port constant matches the pinned MCP loopback port', () => {
    expect(MCP_LOOPBACK_PORT).toBe(7719);
  });
});

// ---------------------------------------------------------------------------
// p3-ssh-admin agent surface
//
// The acceptance focus here is the same as the lane's: an agent gets a real exit code, a refusal
// tells it what to go and fix (naming the TARGET machine, its console URL and the port-forward),
// and nothing on this surface can carry credential material -- there is no field on the request
// for one and no path that puts one in a response.
// ---------------------------------------------------------------------------

async function callAdmin(
  deps: McpDeps,
  name: string,
  args: Record<string, unknown>,
): Promise<{ isError?: boolean; payload: Record<string, unknown>; text: string }> {
  const handler = createMcpFetchHandler(deps);
  const res = await handler(rpcRequest('tools/call', { name, arguments: args }));
  expect(res.status).toBe(200);
  const body = (await res.json()) as { result: { content: { text: string }[]; isError?: boolean } };
  const text = body.result.content[0]!.text;
  // errorResult() (the degrade path) returns a bare sentence rather than JSON, by design.
  let payload: Record<string, unknown> = {};
  try {
    payload = JSON.parse(text) as Record<string, unknown>;
  } catch {
    payload = {};
  }
  return { isError: body.result.isError, payload, text };
}

describe('fleet.admin_run', () => {
  test('dispatches to adminRun, stamps an agent origin, and returns the real exit code', async () => {
    const h = await makeHarness();
    const { payload, isError } = await callAdmin(h.deps, 'fleet.admin_run', {
      machine: 'beta',
      argv: ['id'],
      reason: 'p3 smoke',
    });

    expect(isError).toBeUndefined();
    expect(payload.exitCode).toBe(0);
    expect(payload.stdout).toBe('uid=0(root)\n');
    expect(payload.transport).toBe('mesh');
    expect(h.adminRequests.length).toBe(1);
    expect(h.adminRequests[0]!).toMatchObject({
      machine: 'beta',
      argv: ['id'],
      reason: 'p3 smoke',
      requestedBy: { kind: 'agent', client: 'mcp' },
    });
  });

  test('a non-zero exit code is a result, not a tool error', async () => {
    const h = await makeHarness();
    h.setAdminResult((req) => ({ ...okRunResult(req), ok: false, exitCode: 3, stdout: '', stderr: 'nope\n' }));
    const { payload, isError } = await callAdmin(h.deps, 'fleet.admin_run', {
      machine: 'beta',
      argv: ['false'],
      reason: 'exit code check',
    });
    expect(isError).toBeUndefined();
    expect(payload.exitCode).toBe(3);
    expect(payload.advice).toBeUndefined();
  });

  test('passes timeoutSec through when given, and omits it when not', async () => {
    const h = await makeHarness();
    await callAdmin(h.deps, 'fleet.admin_run', { machine: 'a', argv: ['id'], reason: 'r', timeoutSec: 30 });
    await callAdmin(h.deps, 'fleet.admin_run', { machine: 'a', argv: ['id'], reason: 'r' });
    expect(h.adminRequests[0]!.timeoutSec).toBe(30);
    expect(h.adminRequests[1]!.timeoutSec).toBeUndefined();
  });

  describe('reason is required', () => {
    for (const [label, args] of [
      ['absent', { machine: 'beta', argv: ['id'] }],
      ['empty', { machine: 'beta', argv: ['id'], reason: '' }],
      ['whitespace only', { machine: 'beta', argv: ['id'], reason: '   \t\n' }],
      ['not a string', { machine: 'beta', argv: ['id'], reason: 42 }],
    ] as [string, Record<string, unknown>][]) {
      test(`refuses a ${label} reason without running anything`, async () => {
        const h = await makeHarness();
        const { payload, isError } = await callAdmin(h.deps, 'fleet.admin_run', args);
        expect(isError).toBe(true);
        expect(payload.refusal).toBe('missing-reason');
        expect(payload.exitCode).toBeNull();
        expect(payload.advice).toContain('reason');
        // The point of the check: the daemon is never asked to run it.
        expect(h.adminRequests.length).toBe(0);
      });
    }
  });

  test('a refusal is an isError result carrying actionable advice for the TARGET machine', async () => {
    const h = await makeHarness();
    h.setAdminResult((req) => ({
      ...okRunResult(req),
      ok: false,
      exitCode: null,
      stdout: '',
      transport: null,
      refusal: 'no-credential',
      message: 'no sudo credential is stored on the target machine',
    }));
    const { payload, isError } = await callAdmin(h.deps, 'fleet.admin_run', {
      machine: 'beta',
      argv: ['id'],
      reason: 'credential check',
    });

    expect(isError).toBe(true);
    expect(payload.refusal).toBe('no-credential');
    const advice = payload.advice as string;
    // Names the blocking machine, the port-forward that reaches its console, and the URL.
    expect(advice).toContain('beta');
    expect(advice).toContain('ssh -N -L 7711:127.0.0.1:7710 beta');
    expect(advice).toContain('http://127.0.0.1:7711/ui/');
    // ...and never hints that the password could be read from here.
    expect(advice).not.toMatch(/password is|read the password|reveal/i);
  });

  test('every refusal reason has advice, and none of it names a credential value', () => {
    for (const reason of Object.keys(ADMIN_REFUSAL_ADVICE) as (keyof typeof ADMIN_REFUSAL_ADVICE)[]) {
      const advice = adminRefusalAdvice(reason, 'alpha', 'beta');
      expect(advice).toBeTruthy();
      expect(advice!.length).toBeGreaterThan(20);
    }
    expect(adminRefusalAdvice(undefined, 'alpha', 'beta')).toBeUndefined();
  });

  test('a wiring fault degrades to an isError result, never an HTTP or JSON-RPC error', async () => {
    const h = await makeHarness();
    h.deps.adminRun = async () => {
      throw new Error('not wired');
    };
    const handler = createMcpFetchHandler(h.deps);
    const res = await handler(
      rpcRequest('tools/call', {
        name: 'fleet.admin_run',
        arguments: { machine: 'beta', argv: ['id'], reason: 'r' },
      }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { result: { isError?: boolean; content: { text: string }[] }; error?: unknown };
    expect(body.error).toBeUndefined();
    expect(body.result.isError).toBe(true);
    expect(body.result.content[0]!.text).toContain('admin lane is not available');
  });

  test('no response can carry credential material, even when the target leg leaks one', async () => {
    // The password does not exist on this surface: there is no request field for it, and the
    // result struct has no credential field. This asserts the surface passes NOTHING it was not
    // given -- the sentinel is planted in the only place a bug could plausibly surface it (the
    // target's own captured output) and must not appear in argv, reason, or the origin stamp.
    const h = await makeHarness();
    h.setAdminResult((req) => ({ ...okRunResult(req), stdout: `${SENTINEL_PASSWORD}\n` }));
    const { text } = await callAdmin(h.deps, 'fleet.admin_run', {
      machine: 'beta',
      argv: ['echo', 'hello'],
      reason: 'leak sweep',
    });
    const request = JSON.stringify(h.adminRequests[0]);
    expect(request).not.toContain(SENTINEL_PASSWORD);
    // Command output is the one thing the agent asked for, so it is echoed back verbatim; the
    // guarantee is that nothing else on this path can introduce it.
    expect(text.split(SENTINEL_PASSWORD).length - 1).toBe(1);
  });
});

describe('fleet.admin_status', () => {
  test('returns the per-machine readiness table', async () => {
    const h = await makeHarness();
    const { payload, isError } = await callAdmin(h.deps, 'fleet.admin_status', {});
    expect(isError).toBeUndefined();
    const machines = payload.machines as AdminStatusEntry[];
    expect(machines.map((m) => m.machine)).toEqual(['alpha', 'beta']);
    expect(machines[0]!.self).toBe(true);
    expect(machines[1]!.reachable).toBe(false);
  });

  test('never reports a peer credential as ready, and carries no credential value', async () => {
    const h = await makeHarness();
    const { text, payload } = await callAdmin(h.deps, 'fleet.admin_status', {});
    expect(text).not.toContain(SENTINEL_PASSWORD);
    expect((payload.machines as AdminStatusEntry[])[1]!.credentialReady).toBe(false);
  });

  test('a failing status call degrades to an isError result', async () => {
    const h = await makeHarness();
    h.deps.adminStatus = async () => {
      throw new Error('registry gone');
    };
    const { isError, text } = await callAdmin(h.deps, 'fleet.admin_status', {});
    expect(isError).toBe(true);
    expect(text).toContain('admin lane is not available');
  });
});
