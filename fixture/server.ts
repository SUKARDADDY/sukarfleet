// Canned-UiState fixture server: exercise the tray's fault/suspend/daemon-down
// paths WITHOUT touching the real daemon (soak discipline). Synthetic data only.
//
//   bun fixture/server.ts [port]
//   curl -X POST 127.0.0.1:7799/scenario/critical   # green|degraded|critical|setup|restart|ui-off
//
// `restart` rewinds uptimeSec so the tray's resume-grace path fires.

const port = Number(process.argv[2] ?? 7799);
let scenario = 'green';
let uptimeBase = 100_000;

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
    self: { machine: 'alpha', role: 'anchor', meshIp: '192.0.2.1', nodePort: port, uptimeSec: (now / 1000 - uptimeBase) | 0 },
    peers: [{ name: 'beta', meshIp: '192.0.2.2', nodePort: 7710, online: !bad, lastSeenMs: now - (bad ? 12 * 60_000 : 5_000), syncStale: bad, paired: true, sshHost: null, sshFallbackHost: null }],
    repos: [{ name: 'example-repo', path: '/data/example-repo', lastSyncOkMs: now - 30_000, lastCommit: '0000000000000000000000000000000000000000', syncError: scenario === 'critical' ? 'merge wedge' : null }],
    faults: faults(now),
    admin: { enabled: false, acceptIncoming: false, uiEnabled: true, configured: false, credentialPresent: false, credentialStale: false, credentialSealed: null, credentialSetAtMs: null, sshUser: 'example', sshKeyFingerprint: null, runTimeoutSec: 120, maxRunTimeoutSec: 900, ratePerMin: 20 },
    setup: { complete: scenario !== 'setup', identity: true, meshSecret: 'installed', credential: true, paired: true },
    pairing: { active: false },
  };
}

function status(): unknown {
  const now = Date.now();
  return {
    nowMs: now,
    self: {
      machine: 'alpha', role: 'anchor', clockVetted: true, transport: [],
      repos: { 'example-repo': { lastSyncOkMs: now - 30_000, lastCommit: '00000000', syncError: null } },
      githubPushOkMs: { 'example-repo': now - 45_000 }, flags: [],
    },
    peers: [], alarms: [], health: { faults: faults(now), digestDate: '2026-01-01' },
  };
}

Bun.serve({
  port,
  hostname: '127.0.0.1',
  fetch(req) {
    const url = new URL(req.url);
    if (url.pathname === '/health') return Response.json({ ok: true });
    if (url.pathname === '/api/ui/state') {
      if (scenario === 'ui-off') return new Response('not found', { status: 404 });
      return Response.json(uiState());
    }
    if (url.pathname === '/status') return Response.json(status());
    const m = url.pathname.match(/^\/scenario\/([a-z-]+)$/);
    if (m && req.method === 'POST') {
      scenario = m[1]!;
      if (scenario === 'restart') {
        uptimeBase = Date.now() / 1000 - 1; // uptime rewinds to ~1s
        scenario = 'green';
      }
      return Response.json({ scenario });
    }
    return new Response('not found', { status: 404 });
  },
});
console.log(`fixture daemon on http://127.0.0.1:${port} (scenario: ${scenario})`);
