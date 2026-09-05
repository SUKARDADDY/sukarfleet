// SPDX-License-Identifier: AGPL-3.0-or-later
// Tests for the local GUI transport (src/uiserve.ts). Everything here exercises the real
// UiRoutes.handle against real Request objects and the real ui/ assets on disk; the only fakes are
// the injected ports, which is exactly the seam node.ts fills. What is being pinned:
//
//   - the null-iff-outside-the-prefixes contract other route families depend on,
//   - that the static allowlist cannot be walked out of,
//   - loopback gating (and the one route deliberately exempt from it),
//   - Host pinning, which is what stands between a rebound page and the mesh secret,
//   - rejectCrossSiteBrowser accepting the GUI's own shapes while refusing genuine cross-site ones,
//   - the body caps,
//   - and that no response body can carry the sudo password, including when the store below it
//     actively tries to hand one back.

import { beforeEach, describe, expect, test } from 'bun:test';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { UiRoutes, UI_ASSETS, elevatedInstallCommand, isLoopbackHostHeader, rejectCrossSiteBrowser } from '../src/uiserve';
import type { CredentialStatusView, LanePatch, UiRoutesDeps } from '../src/uiserve';
import { defaultConfig } from '../src/config';
import type { AdminRunRequest, AdminRunView, AuditEntry, FleetConfig, MinimalServer, UiState } from '../src/types';

const NODE_PORT = 7710;
const ORIGIN = `http://127.0.0.1:${NODE_PORT}`;
// The one string that must never appear in a response body.
const SENTINEL = 'correct-horse-battery-staple-8931';

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);

function server(address: string): MinimalServer {
  return { requestIP: () => ({ address }) };
}

function cfgFor(): FleetConfig {
  const cfg = defaultConfig('test-machine');
  cfg.nodePort = NODE_PORT;
  cfg.admin.uiEnabled = true;
  cfg.admin.acceptIncoming = true;
  return cfg;
}

interface Calls {
  buildState: number;
  mint: number;
  cancel: number;
  setPassword: string[];
  removeCredential: number;
  identity: unknown[];
  lane: LanePatch[];
  revoked: string[];
  runs: AdminRunRequest[];
  getRun: string[];
  listRuns: number[];
  auditLimit: number[];
  stage: string[];
  generate: number;
  restart: number;
  hello: number;
}

function sampleRunView(runId: string): AdminRunView {
  return {
    runId,
    machine: 'alpha',
    ok: true,
    exitCode: 0,
    stdout: 'active',
    stderr: '',
    transport: 'mesh',
    durationMs: 42,
    truncated: false,
    startedMs: 1000,
    finishedMs: 1042,
    running: false,
    argv: ['systemctl', 'is-active', 'easytier-fleet.service'],
    reason: 'p3 smoke',
  };
}

function sampleCredential(): CredentialStatusView {
  return {
    present: true,
    stale: false,
    sealed: 'tpm2',
    user: 'fleetuser',
    setAtMs: 1000,
    lastUsedMs: 2000,
    lastFailureMs: null,
  };
}

function makeHarness(over: Partial<UiRoutesDeps> = {}): {
  routes: UiRoutes;
  cfg: FleetConfig;
  calls: Calls;
} {
  const cfg = cfgFor();
  const calls: Calls = {
    buildState: 0,
    mint: 0,
    cancel: 0,
    setPassword: [],
    removeCredential: 0,
    identity: [],
    lane: [],
    revoked: [],
    runs: [],
    getRun: [],
    listRuns: [],
    auditLimit: [],
    stage: [],
    generate: 0,
    restart: 0,
    hello: 0,
  };

  const deps: UiRoutesDeps = {
    cfg,
    isLoopback: (srv, req) => LOOPBACK.has(srv.requestIP(req)?.address ?? ''),
    buildState: async () => {
      calls.buildState += 1;
      return { v: 1, nowMs: 1, self: { machine: 'test-machine' } } as unknown as UiState;
    },
    secrets: {
      status: async () => sampleCredential(),
      set: async (pw: string) => {
        calls.setPassword.push(pw);
        return { ok: true };
      },
      remove: async () => {
        calls.removeCredential += 1;
      },
      sealAvailable: async () => ({ ok: true }),
    },
    sshAdmin: {
      startRun: async (req) => {
        calls.runs.push(req);
        return { runId: 'run-abc' };
      },
      getRun: (runId) => {
        calls.getRun.push(runId);
        return runId === 'run-abc' ? sampleRunView(runId) : null;
      },
      listRuns: (limit) => {
        calls.listRuns.push(limit);
        return [sampleRunView('run-abc')];
      },
      status: async () => [],
      trust: async () => ({
        sshPublicKey: 'ssh-ed25519 AAAA fleet',
        sshKeyFingerprint: 'SHA256:abc',
        hostKeys: ['ssh-ed25519 AAAA host'],
        hostKeyFingerprints: ['SHA256:def'],
      }),
      revokePeer: async (machine) => {
        calls.revoked.push(machine);
      },
    },
    pairing: {
      mintCode: () => {
        calls.mint += 1;
        return { display: 'K7QP-4M2X', expiresMs: 300000 };
      },
      cancelCode: () => {
        calls.cancel += 1;
      },
      codeState: () => ({ active: calls.mint > calls.cancel, display: 'K7QP-4M2X', expiresMs: 300000 }),
      redeem: async () => ({ ok: false, reason: 'bad-code', message: 'That code is not valid.' }),
      handleHello: async () => {
        calls.hello += 1;
        return new Response(JSON.stringify({ paired: true }), { status: 200 });
      },
    },
    tailAudit: async (limit) => {
      calls.auditLimit.push(limit);
      return [{ v: 1, seq: 1, kind: 'admin-run-requested' } as unknown as AuditEntry];
    },
    patchIdentity: async (patch) => {
      calls.identity.push(patch);
      return { ok: true };
    },
    networkSecret: {
      reveal: async () => 'mesh-secret-value',
      stage: async (s) => {
        calls.stage.push(s);
      },
      generate: async () => {
        calls.generate += 1;
        return 'generated-mesh-secret';
      },
      state: async () => 'pending',
    },
    setLane: async (patch) => {
      calls.lane.push({ ...patch });
      // node.ts applies the patch to the live cfg as well as to disk; the routes report from cfg,
      // so the fake has to do the same or the response assertions prove nothing.
      if (patch.enabled !== undefined) cfg.admin.enabled = patch.enabled;
      if (patch.acceptIncoming !== undefined) cfg.admin.acceptIncoming = patch.acceptIncoming;
    },
    restartDaemon: async () => {
      calls.restart += 1;
    },
    ...over,
  };

  return { routes: new UiRoutes(deps), cfg, calls };
}

function req(path: string, init: RequestInit = {}): Request {
  return new Request(`http://127.0.0.1:${NODE_PORT}${path}`, init);
}

// A same-origin JSON POST exactly as the GUI's fetch wrapper issues it.
function guiPost(path: string, body: unknown, extra: Record<string, string> = {}): Request {
  return req(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: ORIGIN, 'sec-fetch-site': 'same-origin', ...extra },
    body: JSON.stringify(body),
  });
}

// Bun mirrors a served request's Host header into req.url, so a constructed Request carries the
// authority in the url only; these two set the header explicitly, which is what a rebound page
// cannot avoid doing.
function hostGet(path: string, host: string): Request {
  return req(path, { headers: { host } });
}

function hostPost(path: string, host: string, body: unknown): Request {
  return req(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: ORIGIN, 'sec-fetch-site': 'same-origin', host },
    body: JSON.stringify(body),
  });
}

// A body-less DELETE exactly as the GUI issues it: no content-type at all, because fetch sets none
// without a body.
function guiDelete(path: string): Request {
  return req(path, { method: 'DELETE', headers: { origin: ORIGIN, 'sec-fetch-site': 'same-origin' } });
}

let harness = makeHarness();

beforeEach(() => {
  harness = makeHarness();
});

async function local(request: Request): Promise<Response | null> {
  return harness.routes.handle(request, server('127.0.0.1'));
}

async function remote(request: Request): Promise<Response | null> {
  return harness.routes.handle(request, server('192.0.2.2'));
}

async function json(res: Response | null): Promise<Record<string, unknown>> {
  expect(res).not.toBeNull();
  return (await (res as Response).json()) as Record<string, unknown>;
}

// ---------------------------------------------------------------------------

describe('prefix contract', () => {
  const outside = ['/', '/health', '/status', '/gossip', '/exec/job', '/git/repo', '/uix', '/api/uix', '/api/ui', '/pairing'];
  for (const path of outside) {
    test(`returns null for ${path}`, async () => {
      expect(await local(req(path))).toBeNull();
    });
  }

  const inside = ['/ui', '/ui/', '/ui/app.js', '/ui/nope.txt', '/api/ui/state', '/api/ui/nope', '/pair/hello', '/pair/nope'];
  for (const path of inside) {
    test(`owns ${path}`, async () => {
      expect(await local(req(path))).not.toBeNull();
    });
  }

  test('unrecognized paths inside the prefixes get their own 404', async () => {
    expect((await local(req('/ui/nope.txt')))!.status).toBe(404);
    expect((await local(req('/api/ui/nope')))!.status).toBe(404);
    expect((await local(req('/pair/nope')))!.status).toBe(404);
  });
});

describe('static assets', () => {
  test('serves index.html at both spellings with no-store and a CSP', async () => {
    for (const path of ['/ui', '/ui/', '/ui/index.html']) {
      const res = (await local(req(path)))!;
      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toBe('text/html; charset=utf-8');
      expect(res.headers.get('cache-control')).toBe('no-store');
      expect(res.headers.get('x-content-type-options')).toBe('nosniff');
      expect(res.headers.get('content-security-policy')).toContain("connect-src 'self'");
      expect(await res.text()).toContain('/ui/app.js');
    }
  });

  test('serves app.js and style.css with pinned content types', async () => {
    const js = (await local(req('/ui/app.js')))!;
    expect(js.status).toBe(200);
    expect(js.headers.get('content-type')).toBe('text/javascript; charset=utf-8');

    const css = (await local(req('/ui/style.css')))!;
    expect(css.status).toBe(200);
    expect(css.headers.get('content-type')).toBe('text/css; charset=utf-8');
  });

  test('assets are GET-only', async () => {
    const res = (await local(req('/ui/app.js', { method: 'POST' })))!;
    expect(res.status).toBe(405);
    expect(res.headers.get('allow')).toBe('GET');
  });

  test('every allowlist entry is a bare filename inside ui/ and exists on disk', async () => {
    for (const [path, [filename, contentType]] of UI_ASSETS) {
      expect(path.startsWith('/ui')).toBe(true);
      expect(filename).not.toContain('/');
      expect(filename).not.toContain('..');
      expect(contentType.length).toBeGreaterThan(0);
      const bytes = await readFile(join(import.meta.dir, '..', 'ui', filename));
      expect(bytes.length).toBeGreaterThan(0);
    }
  });

  test('traversal attempts never reach a file', async () => {
    // Percent-encoded dot-segments survive URL normalization, so these actually reach the lookup.
    const encoded = [
      '/ui/%2e%2e%2f%2e%2e%2fetc%2fpasswd',
      '/ui/..%2fsrc%2fsecrets.ts',
      '/ui/%2fetc%2fpasswd',
      '/ui//etc/passwd',
      '/ui/index.html%00.png',
    ];
    for (const path of encoded) {
      const res = (await local(req(path)))!;
      expect(res.status).toBe(404);
      expect(await res.text()).toBe(JSON.stringify({ error: 'not found' }));
    }

    // Dot-segments -- including the %2e spelling, which the URL parser also treats as a dot -- are
    // normalized away before this module ever sees them, which puts them outside the owned
    // prefixes entirely. node.ts then 404s them like any other unknown path.
    for (const path of ['/ui/../src/uiserve.ts', '/ui/../../etc/passwd', '/ui/%2e%2e/src/uiserve.ts']) {
      expect(await local(req(path))).toBeNull();
    }
  });
});

describe('loopback gating', () => {
  test('mesh callers get 403 on the GUI and its API, and no handler runs', async () => {
    const api = (await remote(req('/api/ui/state')))!;
    expect(api.status).toBe(403);
    expect(harness.calls.buildState).toBe(0);

    const ui = (await remote(req('/ui/')))!;
    expect(ui.status).toBe(403);
  });

  test('loopback callers reach the API', async () => {
    const res = (await local(req('/api/ui/state')))!;
    expect(res.status).toBe(200);
    expect(harness.calls.buildState).toBe(1);
  });

  test('/pair/hello is mesh-reachable and delegated verbatim', async () => {
    const res = (await remote(req('/pair/hello', { method: 'POST', body: '{}' })))!;
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ paired: true });
    expect(harness.calls.hello).toBe(1);
  });

  test('/pair/hello is POST-only', async () => {
    const res = (await remote(req('/pair/hello')))!;
    expect(res.status).toBe(405);
    expect(harness.calls.hello).toBe(0);
  });
});

describe('host pinning', () => {
  // The rebinding scenario: the operator's browser loads a page on the attacker's name, the name's
  // TTL expires and re-resolves to 127.0.0.1, and every later fetch is loopback and same-origin by
  // the browser's own reckoning. The Host header is the only thing that still says otherwise.
  const rebound = [
    'sukarfleet.attacker.test',
    'sukarfleet.attacker.test:7710',
    '127.0.0.1.attacker.test:7710',
    'localhost.attacker.test:7710',
    'rebind.internal:7711',
    '192.0.2.1:7710',
  ];

  test('a rebound page cannot read the mesh secret, the state or the audit log', async () => {
    for (const host of rebound) {
      for (const path of ['/api/ui/setup/network-secret', '/api/ui/state', '/api/ui/audit', '/api/ui/admin/runs']) {
        const res = (await local(hostGet(path, host)))!;
        expect(res.status).toBe(403);
        expect(await res.text()).not.toContain('mesh-secret-value');
      }
    }
    // No handler ran behind any of them.
    expect(harness.calls.buildState).toBe(0);
    expect(harness.calls.auditLimit).toEqual([]);
    expect(harness.calls.listRuns).toEqual([]);
  });

  test('a rebound page cannot reach a mutating route either', async () => {
    const res = (await local(hostPost('/api/ui/lane', 'evil.test:7710', { acceptIncoming: false })))!;
    expect(res.status).toBe(403);
    expect(harness.calls.lane).toEqual([]);
  });

  test('the GUI assets are pinned too, so the rebound tab cannot even load them', async () => {
    expect((await local(hostGet('/ui/', 'evil.test:7710')))!.status).toBe(403);
    expect((await local(hostGet('/ui/app.js', 'evil.test:7710')))!.status).toBe(403);
  });

  test('the documented port-forward and every loopback spelling still work', async () => {
    // RUNBOOK-P3.md: `ssh -N -L 7711:127.0.0.1:7710 <machine>` -- the tab's Host is the LOCAL port.
    for (const host of ['127.0.0.1:7711', '127.0.0.1:7710', '127.0.0.1', 'localhost:7710', 'LOCALHOST:7710', '[::1]:7710', '[::1]', '::1']) {
      const res = (await local(hostGet('/api/ui/state', host)))!;
      expect(res.status).toBe(200);
    }
    expect(harness.calls.buildState).toBe(8);
  });

  test('/pair/hello stays exempt: it is mesh-reachable by design', async () => {
    const res = (await remote(
      req('/pair/hello', { method: 'POST', headers: { host: 'alpha.mesh:7710' }, body: '{}' }),
    ))!;
    expect(res.status).toBe(200);
    expect(harness.calls.hello).toBe(1);
  });

  test('isLoopbackHostHeader refuses everything it cannot read one way', () => {
    for (const good of ['127.0.0.1', '127.0.0.1:7710', '127.0.0.1:1', 'localhost:65535', ' localhost ', '[::1]:7710', '::1']) {
      expect(isLoopbackHostHeader(good)).toBe(true);
    }
    for (const bad of [
      null,
      '',
      ':7710',
      '127.0.0.1:',
      '127.0.0.1:70000x',
      '127.0.0.1:port',
      '127.0.0.1@evil.test',
      'evil.test@127.0.0.1',
      '127.0.0.1/../evil.test',
      '[::1',
      '[::1]x',
      '[::1]:7710:7710',
      '::1:7710',
      '::ffff:127.0.0.1',
      '127.0.0.1.evil.test',
      'localhost.evil.test',
      'evil.test',
      '0.0.0.0:7710',
      '127.0.0.2:7710',
      'x'.repeat(300),
    ]) {
      expect(isLoopbackHostHeader(bad)).toBe(false);
    }
  });
});

describe('rejectCrossSiteBrowser', () => {
  test('the GUI own same-origin POST passes', async () => {
    const res = (await local(guiPost('/api/ui/pair/code', {})))!;
    expect(res.status).toBe(200);
    expect(harness.calls.mint).toBe(1);
  });

  test('a genuine cross-origin POST is refused before any handler runs', async () => {
    const res = (await local(
      req('/api/ui/pair/code', {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin: 'http://evil.test', 'sec-fetch-site': 'cross-site' },
        body: '{}',
      }),
    ))!;
    expect(res.status).toBe(403);
    expect(harness.calls.mint).toBe(0);
  });

  test('a cross-site sec-fetch-site is refused even without an origin', async () => {
    const res = (await local(
      req('/api/ui/pair/code', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'sec-fetch-site': 'cross-site' },
        body: '{}',
      }),
    ))!;
    expect(res.status).toBe(403);
    expect(harness.calls.mint).toBe(0);
  });

  test('a non-JSON content type is 415 even with no body', async () => {
    const res = (await local(
      req('/api/ui/pair/code', { method: 'POST', headers: { 'content-type': 'text/plain', origin: ORIGIN } }),
    ))!;
    expect(res.status).toBe(415);
    expect(harness.calls.mint).toBe(0);
  });

  test('a body with no content type at all is 415', async () => {
    const res = (await local(
      req('/api/ui/pair/code', { method: 'POST', headers: { origin: ORIGIN }, body: new Blob(['{}']) }),
    ))!;
    expect(res.status).toBe(415);
    expect(harness.calls.mint).toBe(0);
  });

  test("the GUI's body-less DELETEs pass (no content-type is sent for them)", async () => {
    expect((await local(guiDelete('/api/ui/pair/code')))!.status).toBe(200);
    expect(harness.calls.cancel).toBe(1);
    expect((await local(guiDelete('/api/ui/credentials/sudo')))!.status).toBe(200);
    expect(harness.calls.removeCredential).toBe(1);
  });

  test('a port-forwarded tab on another loopback port still drives this machine', async () => {
    const res = (await local(
      req('/api/ui/pair/code', {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin: 'http://127.0.0.1:7711', 'sec-fetch-site': 'same-origin' },
        body: '{}',
      }),
    ))!;
    expect(res.status).toBe(200);
  });

  test('non-loopback origins are refused whatever the scheme', () => {
    for (const origin of ['https://evil.test', 'http://192.0.2.1:7710', 'null', 'http://127.0.0.1.evil.test']) {
      const res = rejectCrossSiteBrowser(
        new Request(ORIGIN + '/api/ui/pair/code', { method: 'POST', headers: { origin, 'content-type': 'application/json' } }),
        NODE_PORT,
      );
      expect(res?.status).toBe(403);
    }
  });

  test('read-only methods are never touched by the guard', () => {
    expect(rejectCrossSiteBrowser(new Request(ORIGIN + '/api/ui/state', { headers: { origin: 'http://evil.test' } }), NODE_PORT)).toBeNull();
  });
});

describe('body caps', () => {
  test('an oversized API body is 413 and never parsed', async () => {
    const huge = JSON.stringify({ machine: 'x', argv: ['a'.repeat(200_000)], reason: 'r' });
    const res = (await local(guiPost('/api/ui/admin/run', JSON.parse(huge))))!;
    expect(res.status).toBe(413);
    expect(harness.calls.runs.length).toBe(0);
  });

  test('the credential route has its own tighter cap', async () => {
    const res = (await local(guiPost('/api/ui/credentials/sudo', { password: 'p'.repeat(8000) })))!;
    expect(res.status).toBe(413);
    expect(harness.calls.setPassword.length).toBe(0);
  });

  test('invalid JSON is a 400', async () => {
    const res = (await local(
      req('/api/ui/admin/run', {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin: ORIGIN },
        body: '{not json',
      }),
    ))!;
    expect(res.status).toBe(400);
    expect(harness.calls.runs.length).toBe(0);
  });
});

describe('the credential path never returns a value', () => {
  test('the password reaches the store and nothing comes back', async () => {
    const res = (await local(guiPost('/api/ui/credentials/sudo', { password: SENTINEL })))!;
    const text = await res.text();
    expect(res.status).toBe(200);
    expect(text).toBe(JSON.stringify({ ok: true }));
    expect(text).not.toContain(SENTINEL);
    expect(harness.calls.setPassword).toEqual([SENTINEL]);
  });

  test('a store that hands the password back in its own message cannot leak it', async () => {
    const h = makeHarness({
      secrets: {
        status: async () => sampleCredential(),
        set: async () => ({ ok: false, reason: 'verify-failed', message: `wrong password: ${SENTINEL}` }),
        remove: async () => {},
        sealAvailable: async () => ({ ok: true }),
      },
    });
    const res = (await h.routes.handle(guiPost('/api/ui/credentials/sudo', { password: SENTINEL }), server('127.0.0.1')))!;
    const text = await res.text();
    expect(res.status).toBe(200);
    expect(JSON.parse(text)).toEqual({ ok: false, reason: 'verify-failed' });
    expect(text).not.toContain(SENTINEL);
  });

  test('an unknown store reason collapses to "unknown"', async () => {
    const h = makeHarness({
      secrets: {
        status: async () => sampleCredential(),
        set: async () => ({ ok: false, reason: `pam said ${SENTINEL}` }),
        remove: async () => {},
        sealAvailable: async () => ({ ok: true }),
      },
    });
    const res = (await h.routes.handle(guiPost('/api/ui/credentials/sudo', { password: SENTINEL }), server('127.0.0.1')))!;
    const text = await res.text();
    expect(JSON.parse(text)).toEqual({ ok: false, reason: 'unknown' });
    expect(text).not.toContain(SENTINEL);
  });

  test('a store that throws with the password in the error is swallowed', async () => {
    const h = makeHarness({
      secrets: {
        status: async () => sampleCredential(),
        set: async () => {
          throw new Error(`seal failed for ${SENTINEL}`);
        },
        remove: async () => {},
        sealAvailable: async () => ({ ok: true }),
      },
    });
    const res = (await h.routes.handle(guiPost('/api/ui/credentials/sudo', { password: SENTINEL }), server('127.0.0.1')))!;
    const text = await res.text();
    expect(res.status).toBe(500);
    expect(JSON.parse(text)).toEqual({ ok: false, reason: 'internal' });
    expect(text).not.toContain(SENTINEL);
  });

  test('a missing or implausible password is rejected without reaching the store', async () => {
    for (const body of [{}, { password: '' }, { password: 42 }, { password: 'p'.repeat(1025) }]) {
      const res = (await local(guiPost('/api/ui/credentials/sudo', body)))!;
      expect(res.status).toBe(400);
    }
    expect(harness.calls.setPassword.length).toBe(0);
  });

  test('no read route echoes the password after it has been set', async () => {
    await local(guiPost('/api/ui/credentials/sudo', { password: SENTINEL }));
    for (const path of [
      '/api/ui/state',
      '/api/ui/credentials',
      '/api/ui/admin/status',
      '/api/ui/admin/runs',
      '/api/ui/admin/run/run-abc',
      '/api/ui/audit',
      '/api/ui/pair/code',
    ]) {
      const res = (await local(req(path)))!;
      expect(res.status).toBe(200);
      expect(await res.text()).not.toContain(SENTINEL);
    }
  });

  test('GET /api/ui/credentials reports status, trust and sealing only', async () => {
    const body = await json(await local(req('/api/ui/credentials')));
    expect(body.credential).toEqual(sampleCredential() as unknown as Record<string, unknown>);
    expect((body.trust as Record<string, unknown>).sshKeyFingerprint).toBe('SHA256:abc');
    expect(body.seal).toEqual({ ok: true });
    expect(String(body.path)).toContain('sudo.cred');
    expect(Object.keys(body)).toEqual(['credential', 'trust', 'seal', 'path']);
  });

  test('a machine with no ssh identity still renders the credentials screen', async () => {
    const h = makeHarness({
      sshAdmin: {
        startRun: async () => ({ runId: 'run-abc' }),
        getRun: () => null,
        listRuns: () => [],
        status: async () => [],
        trust: async () => {
          throw new Error('no ssh key yet');
        },
        revokePeer: async () => {},
      },
    });
    const res = (await h.routes.handle(req('/api/ui/credentials'), server('127.0.0.1')))!;
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, Record<string, unknown>>;
    expect(body.trust!.sshPublicKey).toBe('');
    expect(body.trust!.hostKeyFingerprints).toEqual([]);
  });
});

describe('api routes', () => {
  test('state is passed through untouched', async () => {
    const body = await json(await local(req('/api/ui/state')));
    expect(body.v).toBe(1);
  });

  test('identity accepts only known, well-formed fields', async () => {
    const res = (await local(guiPost('/api/ui/setup/identity', { machine: 'laptop-2', junk: 'x' })))!;
    expect(res.status).toBe(200);
    expect(harness.calls.identity).toEqual([{ machine: 'laptop-2' }]);

    for (const bad of [
      { machine: 'has space' },
      { role: 'wizard' },
      { meshIp: 'not an ip' },
      { nodePort: 0 },
      { nodePort: 99999 },
      { networkName: 'bad/name' },
      {},
    ]) {
      const rej = (await local(guiPost('/api/ui/setup/identity', bad)))!;
      expect(rej.status).toBe(400);
    }
    expect(harness.calls.identity.length).toBe(1);
  });

  test('a rejected identity patch surfaces its message as a 400', async () => {
    const h = makeHarness({ patchIdentity: async () => ({ ok: false, message: 'meshIp is already taken' }) });
    const res = (await h.routes.handle(guiPost('/api/ui/setup/identity', { meshIp: '192.0.2.9' }), server('127.0.0.1')))!;
    expect(res.status).toBe(400);
    expect((await res.json()) as unknown).toEqual({ ok: false, message: 'meshIp is already taken' });
  });

  test('the mesh secret is readable on loopback and never echoed by the mutating route', async () => {
    const read = await json(await local(req('/api/ui/setup/network-secret')));
    expect(read).toEqual({ state: 'pending', secret: 'mesh-secret-value' });

    const gen = (await local(guiPost('/api/ui/setup/network-secret', { action: 'generate' })))!;
    const text = await gen.text();
    expect(JSON.parse(text)).toEqual({ ok: true });
    expect(text).not.toContain('generated-mesh-secret');
    expect(harness.calls.generate).toBe(1);

    expect((await local(guiPost('/api/ui/setup/network-secret', { action: 'stage', secret: '  s3cret  ' })))!.status).toBe(200);
    expect(harness.calls.stage).toEqual(['s3cret']);

    for (const bad of [{ action: 'nope' }, { action: 'stage' }, { action: 'stage', secret: '' }, { action: 'stage', secret: 'a\nb' }]) {
      expect((await local(guiPost('/api/ui/setup/network-secret', bad)))!.status).toBe(400);
    }
  });

  test('pair code mint/read/cancel all answer with the code state', async () => {
    expect(await json(await local(req('/api/ui/pair/code')))).toHaveProperty('display', 'K7QP-4M2X');
    expect((await local(guiPost('/api/ui/pair/code', {})))!.status).toBe(200);
    expect(harness.calls.mint).toBe(1);
    expect((await local(guiDelete('/api/ui/pair/code')))!.status).toBe(200);
    expect(harness.calls.cancel).toBe(1);
    expect((await local(req('/api/ui/pair/code', { method: 'PUT' })))!.status).toBe(405);
  });

  test('redeem validates its address and returns a refusal as a 200', async () => {
    for (const bad of [
      { code: 'K7QP4M2X', host: '192.0.2.1', port: 0 },
      { code: 'K7QP4M2X', host: '192.0.2.1', port: 70000 },
      { code: 'K7QP4M2X', host: 'bad host', port: 7710 },
      { code: '', host: '192.0.2.1', port: 7710 },
    ]) {
      expect((await local(guiPost('/api/ui/pair/redeem', bad)))!.status).toBe(400);
    }
    const ok = (await local(guiPost('/api/ui/pair/redeem', { code: 'K7QP4M2X', host: '192.0.2.1', port: 7710 })))!;
    expect(ok.status).toBe(200);
    expect((await ok.json()) as unknown).toEqual({ ok: false, reason: 'bad-code', message: 'That code is not valid.' });
  });

  test('both lane switches reach the config and report what the daemon believes', async () => {
    // defaultConfig ships admin.enabled:false -- the switch that turns the lane on is the whole
    // point of this route existing.
    expect(harness.cfg.admin.enabled).toBe(false);

    expect(await json(await local(guiPost('/api/ui/lane', { enabled: true })))).toEqual({
      ok: true,
      enabled: true,
      acceptIncoming: true,
    });
    expect(await json(await local(guiPost('/api/ui/lane', { acceptIncoming: false })))).toEqual({
      ok: true,
      enabled: true,
      acceptIncoming: false,
    });
    expect(await json(await local(guiPost('/api/ui/lane', { enabled: false, acceptIncoming: true })))).toEqual({
      ok: true,
      enabled: false,
      acceptIncoming: true,
    });
    expect(harness.calls.lane).toEqual([{ enabled: true }, { acceptIncoming: false }, { enabled: false, acceptIncoming: true }]);
  });

  test('the lane route takes booleans, at least one of them, and no other key', async () => {
    for (const bad of [
      {},
      { enabled: 'yes' },
      { acceptIncoming: 'no' },
      { enabled: null },
      { acceptIncoming: 1 },
      { enabled: true, acceptIncomming: false },
      { uiEnabled: true },
      { enabled: true, junk: 'x' },
    ]) {
      const res = (await local(guiPost('/api/ui/lane', bad)))!;
      expect(res.status).toBe(400);
    }
    expect(harness.calls.lane).toEqual([]);
    expect(harness.cfg.admin.enabled).toBe(false);
    expect((await local(req('/api/ui/lane')))!.status).toBe(405);
  });

  test('the older /api/ui/admin/lane spelling still lands on the same handler', async () => {
    const res = await json(await local(guiPost('/api/ui/admin/lane', { acceptIncoming: false })));
    expect(res).toEqual({ ok: true, enabled: false, acceptIncoming: false });
    expect(harness.calls.lane).toEqual([{ acceptIncoming: false }]);
  });

  test('revoke withdraws ssh trust for a named machine', async () => {
    const res = await json(await local(guiPost('/api/ui/pair/revoke', { machine: 'alpha' })));
    expect(res).toEqual({ ok: true, machine: 'alpha' });
    expect(harness.calls.revoked).toEqual(['alpha']);

    // A machine the config does not know is still revocable: a half-applied pair leaves an
    // authorized_keys line with no peer entry, and that is the state this control cleans up.
    expect((await local(guiPost('/api/ui/pair/revoke', { machine: 'never-paired' })))!.status).toBe(200);
    expect(harness.calls.revoked).toEqual(['alpha', 'never-paired']);
  });

  test('revoke refuses anything that is not a machine name, and is POST-only on loopback', async () => {
    for (const bad of [{}, { machine: '' }, { machine: 'has space' }, { machine: 42 }, { machine: '../../etc/passwd' }, { machine: 'x'.repeat(65) }]) {
      expect((await local(guiPost('/api/ui/pair/revoke', bad)))!.status).toBe(400);
    }
    expect(harness.calls.revoked).toEqual([]);

    expect((await local(req('/api/ui/pair/revoke')))!.status).toBe(405);
    expect((await remote(guiPost('/api/ui/pair/revoke', { machine: 'alpha' })))!.status).toBe(403);
    // Cross-site: the mutating guard runs ahead of the handler, as it does for every POST here.
    const crossSite = (await local(
      req('/api/ui/pair/revoke', {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin: 'http://evil.test' },
        body: JSON.stringify({ machine: 'alpha' }),
      }),
    ))!;
    expect(crossSite.status).toBe(403);
    expect(harness.calls.revoked).toEqual([]);
  });

  test('a run is stamped as operator-requested and its semantics are left to sshadmin', async () => {
    const res = await json(await local(guiPost('/api/ui/admin/run', { machine: 'alpha', argv: ['id'], reason: 'why', timeoutSec: 30 })));
    expect(res).toEqual({ runId: 'run-abc' });
    expect(harness.calls.runs[0]).toEqual({
      machine: 'alpha',
      argv: ['id'],
      reason: 'why',
      requestedBy: { kind: 'operator', client: 'ui' },
      timeoutSec: 30,
    });

    // An empty reason is an AUDITED refusal in sshadmin.ts, not a silent 400 here.
    await local(guiPost('/api/ui/admin/run', { machine: 'alpha', argv: ['id'] }));
    expect(harness.calls.runs[1]).toEqual({
      machine: 'alpha',
      argv: ['id'],
      reason: '',
      requestedBy: { kind: 'operator', client: 'ui' },
    });
  });

  test('run lookup rejects anything that is not a run id', async () => {
    expect((await local(req('/api/ui/admin/run/run-abc')))!.status).toBe(200);
    for (const bad of ['..%2f..%2fetc', 'a b', 'x'.repeat(65), '%zz']) {
      const res = (await local(req(`/api/ui/admin/run/${bad}`)))!;
      expect(res.status).toBe(404);
    }
    expect(harness.calls.getRun).toEqual(['run-abc']);
    expect((await local(req('/api/ui/admin/run/unknown')))!.status).toBe(404);
  });

  test('list limits are clamped', async () => {
    await local(req('/api/ui/admin/runs'));
    await local(req('/api/ui/admin/runs?limit=5000'));
    await local(req('/api/ui/admin/runs?limit=abc'));
    await local(req('/api/ui/admin/runs?limit=-3'));
    expect(harness.calls.listRuns).toEqual([20, 100, 20, 20]);

    await local(req('/api/ui/audit'));
    await local(req('/api/ui/audit?limit=9999'));
    expect(harness.calls.auditLimit).toEqual([40, 200]);
    expect(await json(await local(req('/api/ui/audit')))).toHaveProperty('entries');
  });

  test('restart answers before it restarts', async () => {
    const res = await json(await local(guiPost('/api/ui/restart', {})));
    expect(res).toEqual({ ok: true });
    expect(harness.calls.restart).toBe(0);
    await Bun.sleep(300);
    expect(harness.calls.restart).toBe(1);
  });

  test('methods are pinned per route', async () => {
    expect((await local(req('/api/ui/state', { method: 'POST', headers: { 'content-type': 'application/json', origin: ORIGIN } })))!.status).toBe(405);
    expect((await local(req('/api/ui/restart')))!.status).toBe(405);
    expect((await local(req('/api/ui/admin/status', { method: 'DELETE', headers: { origin: ORIGIN } })))!.status).toBe(405);
  });
});

describe('admin.uiAssets (P6): split API vs HTML assets', () => {
  test('missing uiAssets (undefined) behaves as enabled -- the pre-P6 shape', async () => {
    const h = makeHarness();
    delete (h.cfg.admin as unknown as Record<string, unknown>).uiAssets;
    expect((await h.routes.handle(req('/ui/'), server('127.0.0.1')))!.status).toBe(200);
    expect((await h.routes.handle(req('/api/ui/state'), server('127.0.0.1')))!.status).toBe(200);
  });

  test('uiAssets:true (explicit) behaves exactly like uiAssets absent', async () => {
    const h = makeHarness();
    h.cfg.admin.uiAssets = true;
    expect((await h.routes.handle(req('/ui'), server('127.0.0.1')))!.status).toBe(200);
    expect((await h.routes.handle(req('/api/ui/state'), server('127.0.0.1')))!.status).toBe(200);
  });

  test('uiAssets:false 404s the HTML/asset routes while the API and pairing keep working', async () => {
    const h = makeHarness();
    h.cfg.admin.uiAssets = false;
    expect((await h.routes.handle(req('/ui'), server('127.0.0.1')))!.status).toBe(404);
    expect((await h.routes.handle(req('/ui/'), server('127.0.0.1')))!.status).toBe(404);
    expect((await h.routes.handle(req('/ui/index.html'), server('127.0.0.1')))!.status).toBe(404);
    expect((await h.routes.handle(req('/ui/app.js'), server('127.0.0.1')))!.status).toBe(404);
    expect((await h.routes.handle(req('/ui/style.css'), server('127.0.0.1')))!.status).toBe(404);

    const api = (await h.routes.handle(req('/api/ui/state'), server('127.0.0.1')))!;
    expect(api.status).toBe(200);
    expect(h.calls.buildState).toBe(1);

    const hello = (await h.routes.handle(
      req('/pair/hello', { method: 'POST', body: '{}' }),
      server('192.0.2.2'),
    ))!;
    expect(hello.status).toBe(200);
    expect(h.calls.hello).toBe(1);
  });

  test('uiEnabled:false still 404s the API too, regardless of uiAssets', async () => {
    const h = makeHarness();
    h.cfg.admin.uiEnabled = false;
    h.cfg.admin.uiAssets = true;
    expect((await h.routes.handle(req('/ui/'), server('127.0.0.1')))!.status).toBe(404);
    expect((await h.routes.handle(req('/api/ui/state'), server('127.0.0.1')))!.status).toBe(404);
    expect(h.calls.buildState).toBe(0);
  });
});

describe('degradation', () => {
  test('uiEnabled:false hides the whole GUI surface but not pairing', async () => {
    const h = makeHarness();
    h.cfg.admin.uiEnabled = false;
    expect((await h.routes.handle(req('/ui/'), server('127.0.0.1')))!.status).toBe(404);
    expect((await h.routes.handle(req('/api/ui/state'), server('127.0.0.1')))!.status).toBe(404);
    const hello = (await h.routes.handle(req('/pair/hello', { method: 'POST', body: '{}' }), server('192.0.2.2')))!;
    expect(hello.status).toBe(200);
  });

  test('a throwing dependency degrades to a 500 instead of rejecting', async () => {
    const h = makeHarness({
      buildState: async () => {
        throw new Error('health loop wedged');
      },
    });
    const res = (await h.routes.handle(req('/api/ui/state'), server('127.0.0.1')))!;
    expect(res.status).toBe(500);
    expect((await res.json()) as unknown).toEqual({ error: 'internal error' });
  });

  test('an unparseable url is not this module of business', async () => {
    expect(await local(req('/api/ui/state?x=%%%'))).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// The one root step
// ---------------------------------------------------------------------------
//
// Three surfaces print this command -- the web console's Mesh card, the tray
// console's Mesh card and install/quickstart.sh's closing banner -- and a
// stranger copies whichever they read first. Both consoles used to hardcode
// `sudo ~/sukarfleet/install/install-elevated.sh --adopt-pending-secret`, which
// names a directory get.sh never creates and omits the flag the script needs, so
// copying it produced a refusal. What is pinned here is the shape, and that the
// bash the banner builds agrees with it.

describe('elevatedInstallCommand', () => {
  const COMMAND = elevatedInstallCommand('/opt/sukarfleet/app', '/var/lib/sukarfleet');

  test('names the checkout, the flag and the real staged path', () => {
    expect(COMMAND).toBe(
      'sudo /opt/sukarfleet/app/install/install-elevated.sh --adopt-pending-secret --pending=/var/lib/sukarfleet/pending-easytier-secret',
    );
  });

  test('honours a state directory that is not under the app directory', () => {
    // stateDir() reads SUKARFLEET_STATE, so the two paths vary independently and
    // the staged file is never assumed to sit beside the checkout.
    expect(elevatedInstallCommand('/a/app', '/b/state')).toContain('--pending=/b/state/pending-easytier-secret');
  });

  test('install/quickstart.sh builds the same string in bash', async () => {
    const script = await readFile(join(import.meta.dir, '..', 'install', 'quickstart.sh'), 'utf8');
    // The banner's ROOT_STEP assignment, spelled in the script's own variables.
    expect(script).toContain('ROOT_STEP="sudo $ELEVATED --adopt-pending-secret --pending=$PENDING_SECRET"');
    expect(script).toContain('ELEVATED="$REPO_ROOT/install/install-elevated.sh"');
    expect(script).toContain('PENDING_SECRET="$STATE_DIR/pending-easytier-secret"');
  });

  test('both consoles have somewhere to put it, and neither hardcodes the old path', async () => {
    for (const page of [
      join(import.meta.dir, '..', 'ui', 'index.html'),
      join(import.meta.dir, '..', 'clients', 'tray', 'src', 'index.html'),
    ]) {
      const html = await readFile(page, 'utf8');
      expect(html).toContain('id="mesh-command"');
      expect(html).not.toContain('~/sukarfleet/install/install-elevated.sh');
    }
  });
});
