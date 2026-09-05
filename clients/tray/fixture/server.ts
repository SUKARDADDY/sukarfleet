// SPDX-License-Identifier: MIT
// Canned-daemon fixture: exercise the tray + console's full surface — faults,
// suspend, daemon-down, AND every mutating console flow — WITHOUT touching the
// real daemon (soak discipline). Synthetic data only.
//
//   bun fixture/server.ts [port]
//   curl -X POST 127.0.0.1:7799/scenario/critical   # green|degraded|critical|setup|restart|ui-off
//
// `restart` rewinds uptimeSec so the tray's resume-grace path fires.

const port = Number(process.argv[2] ?? 7799);
// --proxy http://127.0.0.1:7710 : forward /api/ui/* to a REAL daemon (server-side
// fetch sends no Origin, so it passes the daemon's CSRF gate exactly like the
// Rust bridge does). Console page still served from here (same-origin).
const proxyIx = process.argv.indexOf('--proxy');
const proxyBase = proxyIx > 0 ? process.argv[proxyIx + 1] : null;
let scenario = 'green';
let uptimeBase = Date.now() / 1000 - 3600; // fixture booted "an hour ago"

const SRC = new URL('../src/', import.meta.url).pathname;
const SHIM = `window.__TAURI__ = { core: { invoke: async (cmd, args) => {
  if (cmd === 'snapshot') return null;
  if (cmd !== 'api_call') throw new Error('shim: unknown command ' + cmd);
  const { method, path, body } = args;
  try {
    const res = await fetch(path, { method, headers: body !== undefined ? { 'content-type': 'application/json' } : {}, body: body !== undefined ? JSON.stringify(body) : undefined });
    let parsed = null; try { parsed = await res.json(); } catch {}
    return { status: res.status, body: parsed };
  } catch { return { status: 0, body: { message: 'The daemon did not answer.' } }; }
} }, event: { listen: () => Promise.resolve(() => {}) } };`;

// --- mutable console state ---
let identity = { machine: 'alpha', role: 'anchor', meshIp: '192.0.2.1', nodePort: port, networkName: 'examplenet' };
let meshSecret: { state: 'none' | 'pending' | 'installed'; secret?: string } = { state: 'installed' };
let credentialPresent = true;
let lane = { enabled: true, acceptIncoming: true };
let pairCode: { display: string; expiresMs: number; attemptsLeft: number } | null = null;
const runs: Record<string, any> = {};
let runSeq = 0;
const audit: any[] = [
  { kind: 'pair-accepted', machine: 'alpha', seq: 1, tsMs: Date.now() - 86_400_000, detail: { peer: 'beta' } },
];

function faults(now: number): unknown[] {
  if (scenario === 'degraded') {
    return [{
      key: 'github-push-stale:example-repo', faultClass: 'github-push-stale',
      message: 'example-repo GitHub push stale for 7h', urgency: 'normal', firstSeenMs: now - 7 * 3600_000,
    }];
  }
  if (scenario === 'critical') {
    return [
      { key: 'peer-offline:beta', faultClass: 'peer-offline', message: 'peer beta offline for 12m', urgency: 'critical', firstSeenMs: now - 12 * 60_000 },
      { key: 'self-sync-error:example-repo', faultClass: 'self-sync-error', message: 'example-repo sync error: merge wedge', urgency: 'critical', firstSeenMs: now - 5 * 60_000 },
      { key: 'github-push-stale:example-repo', faultClass: 'github-push-stale', message: 'example-repo GitHub push stale for 7h', urgency: 'normal', firstSeenMs: now - 7 * 3600_000 },
    ];
  }
  return [];
}

function uiState(): unknown {
  const now = Date.now();
  const bad = scenario === 'critical';
  return {
    v: 1, nowMs: now,
    self: { machine: identity.machine, role: identity.role, meshIp: identity.meshIp, nodePort: port, uptimeSec: (now / 1000 - uptimeBase) | 0 },
    peers: [{ name: 'beta', meshIp: '192.0.2.2', nodePort: 7710, online: !bad, lastSeenMs: now - (bad ? 12 * 60_000 : 5_000), syncStale: bad, paired: true, sshHost: null, sshFallbackHost: null }],
    repos: [{ name: 'example-repo', path: '/data/example-repo', lastSyncOkMs: now - 30_000, lastCommit: '0000000000000000000000000000000000000000', syncError: scenario === 'critical' ? 'merge wedge' : null }],
    faults: faults(now),
    admin: { enabled: lane.enabled, acceptIncoming: lane.acceptIncoming, uiEnabled: true, configured: true, credentialPresent, credentialStale: false, credentialSealed: credentialPresent ? 'user' : null, credentialSetAtMs: credentialPresent ? now - 3600_000 : null, sshUser: 'example', sshKeyFingerprint: 'SHA256:EXAMPLEFINGERPRINTexamplefingerprint00000000', runTimeoutSec: 120, maxRunTimeoutSec: 900, ratePerMin: 20 },
    setup: { complete: scenario !== 'setup', identity: true, meshSecret: meshSecret.state, credential: credentialPresent, paired: true },
    pairing: pairState(),
  };
}

function pairState(): unknown {
  if (pairCode && pairCode.expiresMs > Date.now()) {
    return { active: true, display: pairCode.display, expiresMs: pairCode.expiresMs, attemptsLeft: pairCode.attemptsLeft };
  }
  pairCode = null;
  return { active: false };
}

function status(): unknown {
  const now = Date.now();
  return {
    nowMs: now,
    self: {
      machine: identity.machine, role: identity.role, clockVetted: true, transport: [],
      repos: { 'example-repo': { lastSyncOkMs: now - 30_000, lastCommit: '00000000', syncError: null } },
      githubPushOkMs: { 'example-repo': now - 45_000 }, flags: [],
    },
    peers: [], alarms: [], health: { faults: faults(now), digestDate: '2026-01-01' },
  };
}

function json(body: unknown, status = 200): Response {
  return Response.json(body as any, { status });
}

function finishRun(id: string): void {
  const r = runs[id];
  if (!r || !r.running) return;
  r.running = false;
  r.finishedMs = Date.now();
  r.ok = r.argv[0] !== 'false';
  r.exitCode = r.ok ? 0 : 1;
  r.stdout = r.ok ? 'fixture: ok\n' : '';
  r.stderr = r.ok ? '' : 'fixture: failed\n';
  r.transport = 'mesh';
  r.durationMs = r.finishedMs - r.startedMs;
  audit.unshift({ kind: 'admin-run-completed', machine: identity.machine, seq: audit.length + 1, tsMs: r.finishedMs, detail: { argv: r.argv, exitCode: r.exitCode, runId: r.runId } });
}

Bun.serve({
  port,
  hostname: '127.0.0.1',
  async fetch(req) {
    const url = new URL(req.url);
    const p = url.pathname;
    const m = req.method;
    const body = m !== 'GET' ? await req.json().catch(() => ({})) : null;

    // --- console page under test (same-origin, __TAURI__ shim injected) ---
    if (p === '/' || p === '/index.html') {
      const html = (await Bun.file(SRC + 'index.html').text()).replace(
        '<script type="module" src="console.js"></script>',
        '<script src="shim.js"></script>\n<script type="module" src="console.js"></script>',
      );
      return new Response(html, { headers: { 'content-type': 'text/html' } });
    }
    if (p === '/shim.js') return new Response(SHIM, { headers: { 'content-type': 'text/javascript' } });
    for (const [route, file, type] of [
      ['/console.js', 'console.js', 'text/javascript'],
      ['/console.css', 'console.css', 'text/css'],
      ['/assets/icon-reduced.svg', 'assets/icon-reduced.svg', 'image/svg+xml'],
      ['/fonts/IBMPlexSans-Regular.woff2', 'fonts/IBMPlexSans-Regular.woff2', 'font/woff2'],
      ['/fonts/IBMPlexSans-Medium.woff2', 'fonts/IBMPlexSans-Medium.woff2', 'font/woff2'],
    ] as const) {
      if (p === route) return new Response(Bun.file(SRC + file), { headers: { 'content-type': type } });
    }

    if (proxyBase && p.startsWith('/api/ui/')) {
      const res = await fetch(proxyBase + p + url.search, {
        method: m,
        headers: body !== null ? { 'content-type': 'application/json' } : {},
        body: body !== null ? JSON.stringify(body) : undefined,
      });
      return new Response(await res.text(), { status: res.status, headers: { 'content-type': 'application/json' } });
    }

    if (p === '/health') return json({ ok: true });
    if (p === '/status') return json(status());
    if (p === '/api/ui/state') {
      if (scenario === 'ui-off') return json({ error: 'not found' }, 404);
      return json(uiState());
    }

    // --- setup ---
    if (p === '/api/ui/setup/identity' && m === 'POST') {
      if (!body || Object.keys(body).length === 0) return json({ error: 'bad request', message: 'nothing to change' }, 400);
      Object.assign(identity, body);
      return json({ ok: true });
    }
    if (p === '/api/ui/setup/network-secret') {
      if (m === 'GET') return json(meshSecret.state === 'pending' ? meshSecret : { state: meshSecret.state });
      if (m === 'POST') {
        if (body.action === 'generate') { meshSecret = { state: 'pending', secret: 'fixture-secret-' + Math.random().toString(36).slice(2) }; return json({ ok: true }); }
        if (body.action === 'stage') {
          if (!body.secret || /[\x00-\x1f\x7f]/.test(body.secret) || body.secret.length > 512) return json({ error: 'bad request', message: 'that does not look like a mesh secret' }, 400);
          meshSecret = { state: 'pending', secret: body.secret };
          return json({ ok: true });
        }
        return json({ error: 'bad request' }, 400);
      }
    }

    // --- pair ---
    if (p === '/api/ui/pair/code') {
      if (m === 'POST') {
        pairCode = { display: 'F1XT-C0DE-Z3R0', expiresMs: Date.now() + 300_000, attemptsLeft: 5 };
        return json(pairState());
      }
      if (m === 'DELETE') { pairCode = null; return json(pairState()); }
      if (m === 'GET') return json(pairState());
    }
    if (p === '/api/ui/pair/redeem' && m === 'POST') {
      const code = String(body.code ?? '').replace(/[-\s]/g, '').toUpperCase();
      if (code === 'FIXTCODE') return json({ ok: true, peer: 'gamma' });
      if (body.host === 'unreachable.test') return json({ ok: false, reason: 'unreachable' });
      return json({ ok: false, reason: 'bad-code' });
    }
    if (p === '/api/ui/pair/revoke' && m === 'POST') {
      if (!/^[A-Za-z0-9._-]{1,64}$/.test(body.machine ?? '')) return json({ error: 'bad request' }, 400);
      return json({ ok: true, machine: body.machine });
    }

    // --- credentials ---
    if (p === '/api/ui/credentials' && m === 'GET') {
      return json({
        credential: { present: credentialPresent, stale: false, sealed: credentialPresent ? 'user' : null, user: 'example', setAtMs: credentialPresent ? Date.now() - 3600_000 : null, lastUsedMs: null, lastFailureMs: null },
        trust: { sshPublicKey: 'ssh-ed25519 AAAAexample', sshKeyFingerprint: 'SHA256:EXAMPLEFINGERPRINT', hostKeys: [], hostKeyFingerprints: [] },
        seal: { ok: true },
        path: '/var/lib/sukarfleet/example/secrets/sudo.cred',
      });
    }
    if (p === '/api/ui/credentials/sudo') {
      if (m === 'POST') {
        if (typeof body.password !== 'string' || body.password.length === 0) return json({ ok: false, reason: 'bad-request' }, 400);
        if (body.password === 'wrong') return json({ ok: false, reason: 'verify-failed' });
        credentialPresent = true;
        return json({ ok: true });
      }
      if (m === 'DELETE') { credentialPresent = false; return json({ ok: true }); }
    }

    // --- lane (echo semantics: respond with live values, not the patch) ---
    if (p === '/api/ui/lane' && m === 'POST') {
      const keys = Object.keys(body);
      if (keys.length === 0) return json({ error: 'bad request', message: 'send enabled, acceptIncoming, or both' }, 400);
      for (const k of keys) {
        if (k !== 'enabled' && k !== 'acceptIncoming') return json({ error: 'bad request' }, 400);
        if (typeof body[k] !== 'boolean') return json({ error: 'bad request' }, 400);
        (lane as any)[k] = body[k];
      }
      return json({ ok: true, enabled: lane.enabled, acceptIncoming: lane.acceptIncoming });
    }

    // --- admin ---
    if (p === '/api/ui/admin/status' && m === 'GET') {
      return json([
        { machine: identity.machine, self: true, paired: true, reachable: true, credentialReady: credentialPresent, credentialStale: false, laneEnabled: lane.enabled, sshKeyFingerprint: 'SHA256:EXAMPLE', hostKeyFingerprints: [], lastAdminRunMs: null },
        { machine: 'beta', self: false, paired: true, reachable: scenario !== 'critical', credentialReady: true, credentialStale: false, laneEnabled: true, sshKeyFingerprint: 'SHA256:EXAMPLE2', hostKeyFingerprints: ['SHA256:HOST'], lastAdminRunMs: Date.now() - 7200_000 },
      ]);
    }
    if (p === '/api/ui/admin/runs' && m === 'GET') {
      const list = Object.values(runs).sort((a: any, b: any) => b.startedMs - a.startedMs).slice(0, 20);
      return json(list);
    }
    if (p === '/api/ui/audit' && m === 'GET') return json({ entries: audit.slice(0, 40) });
    if (p === '/api/ui/admin/run' && m === 'POST') {
      if (!body.reason) return json({ refusal: 'missing-reason' });
      if (!lane.enabled) return json({ refusal: 'lane-disabled-local' });
      if (body.argv?.[0] === 'refuseme') return json({ refusal: 'refused-argv' });
      const runId = 'fixt' + (++runSeq).toString(36).padStart(8, '0');
      runs[runId] = { runId, machine: body.machine, ok: false, exitCode: null, stdout: '', stderr: '', transport: null, durationMs: 0, truncated: false, startedMs: Date.now(), finishedMs: null, running: true, argv: body.argv, reason: body.reason, timeoutSec: body.timeoutSec };
      setTimeout(() => finishRun(runId), 2500);
      return json({ runId });
    }
    const runMatch = p.match(/^\/api\/ui\/admin\/run\/([A-Za-z0-9_-]{1,64})$/);
    if (runMatch && m === 'GET') {
      const r = runs[runMatch[1]!];
      return r ? json(r) : json({ error: 'not found' }, 404);
    }

    // --- restart ---
    if (p === '/api/ui/restart' && m === 'POST') {
      setTimeout(() => { uptimeBase = Date.now() / 1000 - 1; }, 800);
      return json({ ok: true });
    }

    // --- scenario control (fixture-only) ---
    const sc = p.match(/^\/scenario\/([a-z-]+)$/);
    if (sc && m === 'POST') {
      scenario = sc[1]!;
      if (scenario === 'restart') { uptimeBase = Date.now() / 1000 - 1; scenario = 'green'; }
      return json({ scenario });
    }
    return json({ error: 'not found' }, 404);
  },
});
console.log(`fixture daemon on http://127.0.0.1:${port} (scenario: ${scenario})`);
