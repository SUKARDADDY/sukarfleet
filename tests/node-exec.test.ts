// SPDX-License-Identifier: AGPL-3.0-or-later
// Pure decision points extracted from node.ts's loops, pinned here without spinning up the daemon
// (the import.meta.main guard on node.ts is what makes importing it for these functions safe).

import { describe, expect, test } from 'bun:test';
import {
  anchorDaemonOnlineFromGossip,
  buildAdminLaneView,
  chooseBindHost,
  classifyBindError,
  meshBindFallbackWarning,
  nextAnchorDownStreak,
  nextWatchdogGrace,
  pushAllowedForRepo,
  shouldPushThisTick,
  TAKEOVER_STREAK,
  watchdogShouldPing,
} from '../src/node';
import { clockDriftMs } from '../src/util';
import { SUSPEND_JUMP_MS } from '../src/transport';
import { defaultConfig } from '../src/config';
import { networkInterfaces } from 'node:os';

describe('shouldPushThisTick (P3 single-pusher policy, Class A: gossip-keyed takeover)', () => {
  test('anchor always pushes, regardless of anchorDaemonOnline or streak', () => {
    for (const online of [true, false, null] as const) {
      for (const streak of [0, 1, TAKEOVER_STREAK]) {
        expect(shouldPushThisTick('anchor', online, streak)).toBe(true);
      }
    }
  });

  test('roamer with no configured peers (anchorDaemonOnline=null) always pushes -- restores pre-P3 solo behavior', () => {
    for (const streak of [0, 1, TAKEOVER_STREAK]) {
      expect(shouldPushThisTick('roamer', null, streak)).toBe(true);
    }
  });

  test('roamer with the anchor daemon online never pushes, regardless of streak', () => {
    for (const streak of [0, 1, TAKEOVER_STREAK]) {
      expect(shouldPushThisTick('roamer', true, streak)).toBe(false);
    }
  });

  test('roamer with the anchor daemon offline pushes only once streak reaches TAKEOVER_STREAK', () => {
    expect(shouldPushThisTick('roamer', false, 0)).toBe(false);
    expect(shouldPushThisTick('roamer', false, 1)).toBe(false);
    expect(shouldPushThisTick('roamer', false, TAKEOVER_STREAK - 1)).toBe(false);
    expect(shouldPushThisTick('roamer', false, TAKEOVER_STREAK)).toBe(true);
    expect(shouldPushThisTick('roamer', false, TAKEOVER_STREAK + 1)).toBe(true);
  });

  // Full role x online x streak table, so every combination the brief calls out is pinned in one
  // place, not just the hand-picked cases above.
  const cases: Array<{ role: 'anchor' | 'roamer'; online: boolean | null; streak: number; want: boolean }> = [];
  for (const role of ['anchor', 'roamer'] as const) {
    for (const online of [true, false, null] as const) {
      for (const streak of [0, 1, TAKEOVER_STREAK]) {
        let want: boolean;
        if (role === 'anchor') want = true;
        else if (online === null) want = true;
        else want = online === false && streak >= TAKEOVER_STREAK;
        cases.push({ role, online, streak, want });
      }
    }
  }
  for (const { role, online, streak, want } of cases) {
    test(`role=${role} anchorDaemonOnline=${online} streak=${streak} -> ${want}`, () => {
      expect(shouldPushThisTick(role, online, streak)).toBe(want);
    });
  }
});

describe('pushAllowedForRepo (P3 hardening: a takeover yields to a live pusher, and needs a fresh origin fetch)', () => {
  test('the anchor is never vetoed, whatever this cycle saw on origin', () => {
    for (const online of [true, false, null] as const) {
      for (const originFetchOk of [true, false, null] as const) {
        for (const moved of [true, false]) {
          expect(pushAllowedForRepo('anchor', true, online, originFetchOk, moved)).toBe(true);
        }
      }
    }
  });

  test('a roamer taking over pushes only for a repo whose origin fetch succeeded this cycle', () => {
    expect(pushAllowedForRepo('roamer', true, false, true, false)).toBe(true);
    expect(pushAllowedForRepo('roamer', true, false, false, false)).toBe(false);
    // No origin remote configured: nothing to fetch, nothing to push to, no reason to veto.
    expect(pushAllowedForRepo('roamer', true, false, null, false)).toBe(true);
  });

  test('a roamer taking over stands down for a repo whose main moved under another pusher', () => {
    // The veto that actually bounds two pushers: evidence beats the gossip-derived guess.
    expect(pushAllowedForRepo('roamer', true, false, true, true)).toBe(false);
    expect(pushAllowedForRepo('roamer', true, false, null, true)).toBe(false);
  });

  test('a solo roamer (no configured peers, anchorDaemonOnline=null) is never vetoed -- it took nothing over', () => {
    for (const originFetchOk of [true, false, null] as const) {
      for (const moved of [true, false]) {
        expect(pushAllowedForRepo('roamer', true, null, originFetchOk, moved)).toBe(true);
      }
    }
  });

  test('a roamer pushing while the anchor reads ONLINE is not a takeover, so neither veto applies', () => {
    for (const originFetchOk of [true, false, null] as const) {
      for (const moved of [true, false]) {
        expect(pushAllowedForRepo('roamer', true, true, originFetchOk, moved)).toBe(true);
      }
    }
  });

  test('a push decision of false stays false, so no veto can ever turn a push ON', () => {
    for (const role of ['anchor', 'roamer'] as const) {
      for (const online of [true, false, null] as const) {
        for (const originFetchOk of [true, false, null] as const) {
          for (const moved of [true, false]) {
            expect(pushAllowedForRepo(role, false, online, originFetchOk, moved)).toBe(false);
          }
        }
      }
    }
  });

  // The real composition: what the sync loop ends up doing for one repo, gate then veto.
  const composed: Array<{
    role: 'anchor' | 'roamer';
    online: boolean | null;
    streak: number;
    originFetchOk: boolean | null;
    moved: boolean;
    want: boolean;
  }> = [];
  for (const role of ['anchor', 'roamer'] as const) {
    for (const online of [true, false, null] as const) {
      for (const streak of [0, TAKEOVER_STREAK]) {
        for (const originFetchOk of [true, false, null] as const) {
          for (const moved of [true, false]) {
            const gate = shouldPushThisTick(role, online, streak);
            // Only a roamer that pushes BECAUSE the anchor read offline is a takeover; that is the
            // one cell either veto can touch.
            const takeover = gate && role === 'roamer' && online === false;
            const vetoed = takeover && (originFetchOk === false || moved);
            composed.push({ role, online, streak, originFetchOk, moved, want: gate && !vetoed });
          }
        }
      }
    }
  }
  for (const c of composed) {
    const name = `role=${c.role} online=${c.online} streak=${c.streak} originFetchOk=${c.originFetchOk} moved=${c.moved} -> ${c.want}`;
    test(name, () => {
      const gate = shouldPushThisTick(c.role, c.online, c.streak);
      expect(pushAllowedForRepo(c.role, gate, c.online, c.originFetchOk, c.moved)).toBe(c.want);
    });
  }
});

describe('anchorDaemonOnlineFromGossip (Class A: anchor liveness from gossip, not the mesh peer table)', () => {
  test('no configured peers -> null (nothing to distrust)', () => {
    expect(anchorDaemonOnlineFromGossip([])).toBeNull();
  });

  test('at least one configured peer online -> true', () => {
    expect(anchorDaemonOnlineFromGossip([{ online: false }, { online: true }])).toBe(true);
  });

  test('every configured peer offline -> false (no role marker on PeerConfig, so "all offline" is the anchor-down signal)', () => {
    expect(anchorDaemonOnlineFromGossip([{ online: false }])).toBe(false);
    expect(anchorDaemonOnlineFromGossip([{ online: false }, { online: false }])).toBe(false);
  });
});

describe('nextAnchorDownStreak (P3 roamer takeover debounce)', () => {
  test('increments on consecutive false reads', () => {
    let streak = 0;
    streak = nextAnchorDownStreak(streak, false);
    expect(streak).toBe(1);
    streak = nextAnchorDownStreak(streak, false);
    expect(streak).toBe(2);
    streak = nextAnchorDownStreak(streak, false);
    expect(streak).toBe(3);
  });

  test('resets to 0 the instant a tick sees true', () => {
    let streak = nextAnchorDownStreak(0, false);
    streak = nextAnchorDownStreak(streak, false);
    expect(streak).toBe(2);
    streak = nextAnchorDownStreak(streak, true);
    expect(streak).toBe(0);
  });

  test('resets to 0 on null too, not just recovery (true)', () => {
    let streak = nextAnchorDownStreak(0, false);
    streak = nextAnchorDownStreak(streak, false);
    expect(streak).toBe(2);
    streak = nextAnchorDownStreak(streak, null);
    expect(streak).toBe(0);
  });

  test('one lost poll is not enough to cross the takeover threshold, two is', () => {
    let streak = 0;
    streak = nextAnchorDownStreak(streak, false);
    expect(streak >= 2).toBe(false);
    streak = nextAnchorDownStreak(streak, false);
    expect(streak >= 2).toBe(true);
  });

  test('a sighting mid-streak restarts the count, not resumes it', () => {
    let streak = nextAnchorDownStreak(0, false);
    streak = nextAnchorDownStreak(streak, false);
    streak = nextAnchorDownStreak(streak, false);
    expect(streak).toBe(3);
    streak = nextAnchorDownStreak(streak, true);
    expect(streak).toBe(0);
    streak = nextAnchorDownStreak(streak, false);
    expect(streak >= 2).toBe(false); // restarted, does not carry over the prior 3
  });
});

describe('clockDriftMs (P4 watchdog suspend-awareness)', () => {
  test('ordinary elapsed time: mono and wall agree, drift ~0', () => {
    const baselineMonoNs = 0;
    const baselineWallMs = 1_000_000;
    // 20s of monotonic and 20s of wall time both elapsed -- a normal tick.
    const drift = clockDriftMs(baselineMonoNs, baselineWallMs, 20_000 * 1e6, 1_000_000 + 20_000);
    expect(drift).toBe(0);
  });

  test('synthetic 90-minute suspend: monotonic barely moves, wall jumps 90 minutes', () => {
    const baselineMonoNs = 0;
    const baselineWallMs = 1_000_000;
    const NINETY_MIN_MS = 90 * 60 * 1000;
    // Monotonic time is frozen (or nearly so) across a suspend; only a few ms of scheduler jitter
    // pass before the process is unfrozen and this tick runs.
    const nowMonoNs = 5 * 1e6; // 5ms of monotonic progress
    const nowWallMs = baselineWallMs + NINETY_MIN_MS;
    const drift = clockDriftMs(baselineMonoNs, baselineWallMs, nowMonoNs, nowWallMs);
    expect(drift).toBeCloseTo(NINETY_MIN_MS - 5, 0);
    expect(drift).toBeGreaterThan(SUSPEND_JUMP_MS);
  });

  test('a normal tick pair never crosses SUSPEND_JUMP_MS', () => {
    const baselineMonoNs = 123_456_789;
    const baselineWallMs = 2_000_000;
    // A watchdog tick a few seconds later: mono and wall elapse together.
    const elapsedMs = 5000;
    const drift = clockDriftMs(baselineMonoNs, baselineWallMs, baselineMonoNs + elapsedMs * 1e6, baselineWallMs + elapsedMs);
    expect(drift).toBeLessThan(SUSPEND_JUMP_MS);
  });

  test('is symmetric: a backward wall-clock step also reads as drift', () => {
    const baselineMonoNs = 0;
    const baselineWallMs = 1_000_000;
    // Monotonic keeps moving forward but wall time was stepped backward (NTP correction) --
    // the divergence still crosses the threshold and must not cancel out to a negative drift.
    const drift = clockDriftMs(baselineMonoNs, baselineWallMs, 10_000 * 1e6, baselineWallMs - 5 * 60 * 1000);
    expect(drift).toBeGreaterThan(SUSPEND_JUMP_MS);
  });
});

describe('watchdogShouldPing (P4 watchdog suspend-awareness)', () => {
  test('fresh marks always ping, grace or not', () => {
    expect(watchdogShouldPing(true, true, 1000, 0)).toBe(true);
    expect(watchdogShouldPing(true, true, 1000, 2000)).toBe(true);
  });

  test('stale marks ping while inside the grace window', () => {
    expect(watchdogShouldPing(false, true, 1000, 2000)).toBe(true); // gossip stale, in grace
    expect(watchdogShouldPing(true, false, 1000, 2000)).toBe(true); // sync stale, in grace
    expect(watchdogShouldPing(false, false, 1000, 2000)).toBe(true); // both stale, in grace
  });

  test('stale marks withhold once nowMs reaches or passes graceUntilMs', () => {
    expect(watchdogShouldPing(false, true, 2000, 2000)).toBe(false); // exactly at expiry
    expect(watchdogShouldPing(false, true, 2001, 2000)).toBe(false); // past expiry
  });

  test('graceUntilMs of 0 (never granted, the pre-jump default) never satisfies the grace check', () => {
    expect(watchdogShouldPing(false, false, 0, 0)).toBe(false);
    expect(watchdogShouldPing(false, false, 1_700_000_000_000, 0)).toBe(false);
  });

  test('mixed freshness (only one loop stale) withholds outside grace, exactly like today', () => {
    expect(watchdogShouldPing(false, true, 1000, 0)).toBe(false);
    expect(watchdogShouldPing(true, false, 1000, 0)).toBe(false);
  });
});

describe('nextWatchdogGrace (P4 watchdog, Class B: pure grace-window arithmetic)', () => {
  const WINDOW_MS = 300_000;

  test('fresh, no jump: 0 stays 0', () => {
    expect(nextWatchdogGrace(0, 0, 1000, WINDOW_MS)).toBe(0);
  });

  test('a genuine jump with no open window grants now+windowMs', () => {
    const now = 1000;
    expect(nextWatchdogGrace(0, SUSPEND_JUMP_MS + 1, now, WINDOW_MS)).toBe(now + WINDOW_MS);
  });

  test('a merely-stale tick during an open window never renews it, unchanged', () => {
    const prevGrace = 500_000;
    // now (10_000) is well before prevGrace (500_000): the window is still open.
    expect(nextWatchdogGrace(prevGrace, 0, 10_000, WINDOW_MS)).toBe(prevGrace);
  });

  test('a second jump DURING an already-open window is refused, not extended', () => {
    const prevGrace = 500_000;
    const now = 10_000; // still well inside the open window
    expect(nextWatchdogGrace(prevGrace, SUSPEND_JUMP_MS + 1, now, WINDOW_MS)).toBe(prevGrace);
  });

  test('a jump after the previous window has expired grants a fresh one', () => {
    const prevGrace = 5_000;
    const now = 10_000; // past prevGrace -- the old window is closed
    expect(nextWatchdogGrace(prevGrace, SUSPEND_JUMP_MS + 1, now, WINDOW_MS)).toBe(now + WINDOW_MS);
  });

  test('boundary: driftMs === SUSPEND_JUMP_MS exactly never grants (strictly greater-than only)', () => {
    expect(nextWatchdogGrace(0, SUSPEND_JUMP_MS, 1000, WINDOW_MS)).toBe(0);
    // Also true with a closed prior window, to isolate the driftMs boundary from the window check.
    expect(nextWatchdogGrace(500, SUSPEND_JUMP_MS, 1000, WINDOW_MS)).toBe(500);
  });

  test('boundary: nowMs === prevGraceUntilMs counts as expired (window closes AT its own boundary)', () => {
    const prevGrace = 1000;
    expect(nextWatchdogGrace(prevGrace, SUSPEND_JUMP_MS + 1, prevGrace, WINDOW_MS)).toBe(prevGrace + WINDOW_MS);
  });
});

describe('buildAdminLaneView (Class G: uiAssets exposed on UiState)', () => {
  function credential(overrides: Partial<Parameters<typeof buildAdminLaneView>[0]['credential']> = {}) {
    return { present: false, stale: false, sealed: null, setAtMs: null, ...overrides };
  }

  test('reflects cfg.admin.uiAssets when explicitly true', () => {
    const cfg = defaultConfig('alpha');
    cfg.admin.uiAssets = true;
    const view = buildAdminLaneView({ cfg, configured: true, credential: credential(), sshKeyFingerprint: null });
    expect(view.uiAssets).toBe(true);
  });

  test('reflects cfg.admin.uiAssets when explicitly false', () => {
    const cfg = defaultConfig('alpha');
    cfg.admin.uiAssets = false;
    const view = buildAdminLaneView({ cfg, configured: true, credential: credential(), sshKeyFingerprint: null });
    expect(view.uiAssets).toBe(false);
  });

  test('defaults to true when uiAssets is absent from cfg.admin (pre-P6 config shape)', () => {
    const cfg = defaultConfig('alpha');
    delete (cfg.admin as { uiAssets?: boolean }).uiAssets;
    const view = buildAdminLaneView({ cfg, configured: true, credential: credential(), sshKeyFingerprint: null });
    expect(view.uiAssets).toBe(true);
  });

  test('passes through the rest of the admin lane view unchanged', () => {
    const cfg = defaultConfig('alpha');
    cfg.admin.enabled = true;
    cfg.admin.acceptIncoming = false;
    cfg.admin.sshUser = 'ariel';
    const view = buildAdminLaneView({
      cfg,
      configured: false,
      credential: credential({ present: true, stale: true, sealed: 'tpm2', setAtMs: 12345 }),
      sshKeyFingerprint: 'SHA256:abc',
    });
    expect(view).toEqual({
      enabled: true,
      acceptIncoming: false,
      uiEnabled: cfg.admin.uiEnabled,
      configured: false,
      credentialPresent: true,
      credentialStale: true,
      credentialSealed: 'tpm2',
      credentialSetAtMs: 12345,
      sshUser: 'ariel',
      sshKeyFingerprint: 'SHA256:abc',
      runTimeoutSec: cfg.admin.runTimeoutSec,
      maxRunTimeoutSec: cfg.admin.maxRunTimeoutSec,
      ratePerMin: cfg.admin.ratePerMin,
      uiAssets: true,
    });
  });
});

// ---------------------------------------------------------------------------
// The peer-facing bind host (Class H: the fresh-machine deadlock)
// ---------------------------------------------------------------------------
//
// The journey that produced this: the Identity card writes meshIp, the console restarts the
// daemon, and the daemon comes back BEFORE the sudo step has installed EasyTier -- so the mesh
// address is on no interface, Bun.serve throws "Failed to start server. Is port 7710 in use?",
// systemd restarts the process every 3s, and the console the user needs in order to reach the
// sudo step is gone. Every fresh machine deadlocked there.
//
// Addresses below are from 192.0.2.0/24 (TEST-NET-1), reserved for documentation and on no
// interface of any machine that runs these tests.

const HOST_LIST = ['127.0.0.1', '::1', '192.0.2.5', 'FE80::1%eth0'];

describe('chooseBindHost (which host the peer-facing server is offered)', () => {
  test('no mesh address configured means every interface, and is not a fallback', () => {
    expect(chooseBindHost('', HOST_LIST)).toEqual({ host: '0.0.0.0', fallback: false });
  });

  test('a mesh address that is on an interface is bound as asked', () => {
    expect(chooseBindHost('192.0.2.5', HOST_LIST)).toEqual({ host: '192.0.2.5', fallback: false });
    expect(chooseBindHost('127.0.0.1', HOST_LIST)).toEqual({ host: '127.0.0.1', fallback: false });
  });

  test('a mesh address that is on no interface falls back to every interface, and says so', () => {
    expect(chooseBindHost('192.0.2.6', HOST_LIST)).toEqual({ host: '0.0.0.0', fallback: true });
    expect(chooseBindHost('192.0.2.1', [])).toEqual({ host: '0.0.0.0', fallback: true });
  });

  test('case and the %zone suffix networkInterfaces() reports are not a difference', () => {
    expect(chooseBindHost('fe80::1', HOST_LIST)).toEqual({ host: 'fe80::1', fallback: false });
  });
});

describe('classifyBindError (a busy port and an absent address look identical to Bun)', () => {
  const inUse = { code: 'EADDRINUSE', errno: 0, syscall: 'listen' };

  test('a wildcard bind can only have failed on the port', () => {
    for (const host of ['0.0.0.0', '::', '']) {
      expect(classifyBindError(host, inUse, HOST_LIST)).toBe('in-use');
      expect(classifyBindError(host, new Error('whatever'), HOST_LIST)).toBe('in-use');
    }
  });

  test('an address this machine does not have is unavailable, whatever the code says', () => {
    expect(classifyBindError('192.0.2.1', inUse, HOST_LIST)).toBe('address-unavailable');
    expect(classifyBindError('192.0.2.1', { code: 'EADDRNOTAVAIL' }, HOST_LIST)).toBe('address-unavailable');
    expect(classifyBindError('192.0.2.1', new Error('no code at all'), HOST_LIST)).toBe('address-unavailable');
  });

  test('an address this machine does have, refused as EADDRINUSE, is a busy port', () => {
    expect(classifyBindError('192.0.2.5', inUse, HOST_LIST)).toBe('in-use');
  });

  test('an address this machine does have, refused for any other reason, is not a busy port', () => {
    expect(classifyBindError('192.0.2.5', { code: 'EACCES' }, HOST_LIST)).toBe('address-unavailable');
    expect(classifyBindError('192.0.2.5', new Error('unlabelled'), HOST_LIST)).toBe('address-unavailable');
  });
});

describe('the real Bun.serve failure this fix reads', () => {
  // The finding the classifier is built on, pinned against the runtime rather than assumed: Bun
  // (1.3.14) reports code EADDRINUSE, errno 0 and "Is port N in use?" for EADDRNOTAVAIL too, so a
  // fix that switched on the code alone would fall back on a genuinely busy port and refuse to
  // start on a fresh machine -- exactly backwards.
  test('binding an address that is on no interface throws, and the code lies', () => {
    const local = Object.values(networkInterfaces()).flatMap((addrs) => (addrs ?? []).map((a) => a.address));
    expect(local).not.toContain('192.0.2.1');

    let thrown: unknown = null;
    try {
      Bun.serve({ hostname: '192.0.2.1', port: 0, fetch: () => new Response('never') }).stop(true);
    } catch (err) {
      thrown = err;
    }
    expect(thrown).not.toBeNull();
    // The lie, in writing. If this ever starts reporting EADDRNOTAVAIL, the classifier still
    // answers correctly -- it consults the address list first.
    expect((thrown as { code?: string }).code).toBe('EADDRINUSE');

    expect(classifyBindError('192.0.2.1', thrown, local)).toBe('address-unavailable');
    expect(chooseBindHost('192.0.2.1', local)).toEqual({ host: '0.0.0.0', fallback: true });

    // And the host the fallback names is one this machine can actually bind.
    const server = Bun.serve({ hostname: '0.0.0.0', port: 0, fetch: () => new Response('ok') });
    expect(server.port).toBeGreaterThan(0);
    server.stop(true);
  });

  test('the warning names the address and the step that clears it', () => {
    expect(meshBindFallbackWarning('192.0.2.5')).toBe(
      'node: mesh address 192.0.2.5 is not on any interface yet -- listening on all interfaces until the mesh is up and the daemon restarts',
    );
  });
});
