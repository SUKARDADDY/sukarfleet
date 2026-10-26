// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, test } from 'bun:test';
import { defaultConfig } from '../src/config';
import type { RunOptions, RunResult } from '../src/util';
import {
  ANCHOR_MISS_POLLS,
  ClockSentinel,
  REANNOUNCE_MIN_INTERVAL_MS,
  REANNOUNCE_SUSPECT_POLLS,
  ROUTE_MISS_POLLS,
  ReannounceGate,
  Transport,
  diagnoseTransport,
  findUnroutedPeers,
  generateEasytierToml,
  oneWayRouteSuspects,
  parseConnectorJson,
  parsePeerCenterJson,
} from '../src/transport';

function fakeRunner(handler: (argv: string[], opts?: RunOptions) => RunResult | Promise<RunResult>) {
  return async (argv: string[], opts?: RunOptions): Promise<RunResult> => handler(argv, opts);
}

function peerJson(entries: Array<{ hostname: string; rx_bytes: number; tx_bytes: number }>): string {
  return JSON.stringify(entries);
}

describe('generateEasytierToml', () => {
  test('exact golden output', () => {
    const cfg = defaultConfig('alpha');
    const out = generateEasytierToml(cfg, {
      secret: 'topsecret',
      listeners: ['udp://0.0.0.0:11010', 'tcp://0.0.0.0:11010'],
      peerUris: ['tcp://192.0.2.10:11010', 'tcp://192.0.2.20:11010'],
      hostname: 'alpha',
      ipv4: '192.0.2.1',
    });
    const expected =
      '# rpc_portal is passed as a CLI flag (-r 127.0.0.1:15888) in the systemd unit, not in this file.\n' +
      'hostname = "alpha"\n' +
      'ipv4 = "192.0.2.1"\n' +
      'dhcp = false\n' +
      'listeners = ["udp://0.0.0.0:11010", "tcp://0.0.0.0:11010"]\n' +
      '\n' +
      '[network_identity]\n' +
      'network_name = "sukarfleet"\n' +
      'network_secret = "topsecret"\n' +
      '\n' +
      '[[peer]]\n' +
      'uri = "tcp://192.0.2.10:11010"\n' +
      '\n' +
      '[[peer]]\n' +
      'uri = "tcp://192.0.2.20:11010"\n' +
      '\n' +
      '[flags]\n' +
      'relay_network_whitelist = ""\n' +
      'enable_ipv6 = true\n';
    expect(out).toBe(expected);
  });

  test('escapes special characters in strings and honors configured rpcAddr', () => {
    const cfg = defaultConfig('alpha');
    cfg.easytier.rpcAddr = '127.0.0.1:19999';
    const out = generateEasytierToml(cfg, {
      secret: 'has "quotes" and \\backslash',
      listeners: [],
      peerUris: [],
      hostname: 'alpha',
      ipv4: '192.0.2.1',
    });
    expect(out).toContain('rpc_portal is passed as a CLI flag (-r 127.0.0.1:19999)');
    expect(out).toContain('network_secret = "has \\"quotes\\" and \\\\backslash"');
    expect(out).toContain('listeners = []');
    expect(out).not.toContain('[[peer]]');
  });
});

describe('Transport.pollOnce defensive parsing', () => {
  test('non-array JSON returns null and does not throw', async () => {
    const cfg = defaultConfig('alpha');
    const t = new Transport(cfg, { runner: fakeRunner(() => ({ code: 0, stdout: '{"oops":true}', stderr: '' })) });
    const result = await t.pollOnce(1000);
    expect(result).toBeNull();
  });

  test('malformed JSON returns null', async () => {
    const cfg = defaultConfig('alpha');
    const t = new Transport(cfg, { runner: fakeRunner(() => ({ code: 0, stdout: 'not json', stderr: '' })) });
    const result = await t.pollOnce(1000);
    expect(result).toBeNull();
  });

  test('nonzero exit returns null', async () => {
    const cfg = defaultConfig('alpha');
    const t = new Transport(cfg, { runner: fakeRunner(() => ({ code: 1, stdout: '', stderr: 'rpc unreachable' })) });
    const result = await t.pollOnce(1000);
    expect(result).toBeNull();
  });

  test('skips malformed entries but keeps well-formed ones', async () => {
    const cfg = defaultConfig('alpha');
    const stdout = JSON.stringify([{ no_hostname: true }, { hostname: 'beta', rx_bytes: 10, tx_bytes: 5 }]);
    const t = new Transport(cfg, { runner: fakeRunner(() => ({ code: 0, stdout, stderr: '' })) });
    const result = await t.pollOnce(1000);
    expect(result).toEqual([{ hostname: 'beta', rxBytes: 10, txBytes: 5 }]);
  });
});

// Dispatching fake for the real two-command poll: `peer list` for presence,
// `stats` for the raw aggregate counters.
function fleetRunner(opts: {
  peers: () => string;
  statsTotal: () => number | null;
  // Polled only when the peer table holds nobody but this machine; an empty
  // list is the honest default for a fixture that does not care.
  connectors?: () => string;
}) {
  const cfg = defaultConfig('alpha');
  const base = [cfg.easytier.cliPath, '-p', cfg.easytier.rpcAddr, '-o', 'json'];
  return fakeRunner((argv) => {
    // Pin the exact CLI vectors: the production outage was a wrong interface
    // (`peer --output-format json`), so a loose match here guards nothing.
    if (argv.includes('connector')) {
      expect(argv).toEqual([...base, 'connector', 'list']);
      return { code: 0, stdout: opts.connectors?.() ?? '[]', stderr: '' };
    }
    if (argv.includes('peer-center')) {
      expect(argv).toEqual([...base, 'peer-center']);
      return { code: 0, stdout: '[]', stderr: '' };
    }
    if (argv.includes('peer')) {
      expect(argv).toEqual([...base, 'peer', 'list']);
      return { code: 0, stdout: opts.peers(), stderr: '' };
    }
    if (argv.includes('stats')) {
      expect(argv).toEqual([...base, 'stats']);
      const total = opts.statsTotal();
      if (total === null) return { code: 1, stdout: '', stderr: 'stats unavailable' };
      return {
        code: 0,
        stdout: JSON.stringify([
          { name: 'traffic_bytes_rx', value: total, labels: {} },
          { name: 'traffic_bytes_tx', value: 0, labels: {} },
        ]),
        stderr: '',
      };
    }
    throw new Error(`unexpected argv: ${argv.join(' ')}`);
  });
}

describe('Transport wedge detection', () => {
  test('wedged when the last wedgePolls polls all show a peer present with zero counter delta', async () => {
    const cfg = defaultConfig('alpha');
    cfg.thresholds.wedgePolls = 3;
    const peers = () => peerJson([{ hostname: 'beta', rx_bytes: 0, tx_bytes: 0 }]);
    const t = new Transport(cfg, { runner: fleetRunner({ peers, statsTotal: () => 1500 }) });

    expect(await t.pollOnce(1000)).not.toBeNull();
    expect(t.wedged(1000)).toBe(false); // not enough history yet
    await t.pollOnce(2000);
    expect(t.wedged(2000)).toBe(false);
    await t.pollOnce(3000);
    expect(t.wedged(3000)).toBe(true);
  });

  test('no peer present never wedges', async () => {
    const cfg = defaultConfig('alpha');
    cfg.thresholds.wedgePolls = 2;
    const t = new Transport(cfg, { runner: fleetRunner({ peers: () => '[]', statsTotal: () => 1500 }) });
    await t.pollOnce(1000);
    await t.pollOnce(2000);
    expect(t.wedged(2000)).toBe(false);
  });

  test('no wedge when the aggregate counters keep moving', async () => {
    const cfg = defaultConfig('alpha');
    cfg.thresholds.wedgePolls = 3;
    let total = 1000;
    const peers = () => peerJson([{ hostname: 'beta', rx_bytes: 0, tx_bytes: 0 }]);
    const t = new Transport(cfg, { runner: fleetRunner({ peers, statsTotal: () => (total += 200) }) });
    await t.pollOnce(1000);
    await t.pollOnce(2000);
    await t.pollOnce(3000);
    expect(t.wedged(3000)).toBe(false);
  });

  test('a wedge streak broken by movement clears', async () => {
    const cfg = defaultConfig('alpha');
    cfg.thresholds.wedgePolls = 2;
    let total = 1000;
    let moving = false;
    const peers = () => peerJson([{ hostname: 'beta', rx_bytes: 0, tx_bytes: 0 }]);
    const t = new Transport(cfg, { runner: fleetRunner({ peers, statsTotal: () => (moving ? (total += 50) : total) }) });
    await t.pollOnce(1000);
    await t.pollOnce(2000);
    expect(t.wedged(2000)).toBe(true);
    moving = true;
    await t.pollOnce(3000);
    expect(t.wedged(3000)).toBe(false);
  });

  test('a failed stats read is a blind spot, never wedge evidence', async () => {
    const cfg = defaultConfig('alpha');
    cfg.thresholds.wedgePolls = 2;
    const peers = () => peerJson([{ hostname: 'beta', rx_bytes: 0, tx_bytes: 0 }]);
    const t = new Transport(cfg, { runner: fleetRunner({ peers, statsTotal: () => null }) });
    expect(await t.pollOnce(1000)).not.toBeNull(); // presence still reported
    await t.pollOnce(2000);
    expect(t.wedged(2000)).toBe(false);
  });
});

describe('Transport.restartTransport', () => {
  test('success path returns true', async () => {
    const cfg = defaultConfig('alpha');
    const t = new Transport(cfg, {
      runner: fakeRunner((argv) => {
        expect(argv).toEqual(['sudo', '-n', 'systemctl', 'restart', cfg.easytier.serviceName]);
        return { code: 0, stdout: '', stderr: '' };
      }),
    });
    expect(await t.restartTransport()).toBe(true);
  });

  test('sudo refusal returns false without throwing', async () => {
    const cfg = defaultConfig('alpha');
    const t = new Transport(cfg, { runner: fakeRunner(() => ({ code: 1, stdout: '', stderr: 'sudo: a password is required' })) });
    expect(await t.restartTransport()).toBe(false);
  });
});

describe('ClockSentinel resume detection', () => {
  test('a >60s wall-vs-monotonic drift signals resume and un-vets', async () => {
    const cfg = defaultConfig('alpha');
    let mono = 0;
    const monotonicNs = () => mono;
    const now = () => 1_000_000;
    let resumeCalls = 0;
    const sentinel = new ClockSentinel(cfg, {
      monotonicNs,
      now,
      onResume: () => {
        resumeCalls++;
      },
    });

    // Small monotonic progress (simulating a paused process) vs a 5-minute
    // wall-clock jump: this is exactly the suspend/resume signature.
    mono = 1000; // 1 microsecond of monotonic time
    const jumped = await sentinel.check(1_000_000 + 5 * 60 * 1000);
    expect(jumped).toBe(true);
    expect(resumeCalls).toBe(1);
    expect(sentinel.isClockVetted()).toBe(false);
  });

  test('ordinary elapsed time does not signal resume', async () => {
    const cfg = defaultConfig('alpha');
    let mono = 0;
    const monotonicNs = () => mono;
    const sentinel = new ClockSentinel(cfg, { monotonicNs, now: () => 1_000_000 });
    mono = 20_000 * 1e6; // 20s monotonic
    const jumped = await sentinel.check(1_000_000 + 20_000); // 20s wall
    expect(jumped).toBe(false);
  });
});

describe('ClockSentinel.vet', () => {
  test('parses timedatectl NTPSynchronized=yes as vetted', async () => {
    const cfg = defaultConfig('alpha');
    const sentinel = new ClockSentinel(cfg, {
      runner: fakeRunner((argv) => {
        expect(argv).toEqual(['timedatectl', 'show', '-p', 'NTPSynchronized', '--value']);
        return { code: 0, stdout: 'yes\n', stderr: '' };
      }),
    });
    expect(await sentinel.vet()).toBe(true);
    expect(sentinel.isClockVetted()).toBe(true);
  });

  test('parses NTPSynchronized=no as not vetted', async () => {
    const cfg = defaultConfig('alpha');
    const sentinel = new ClockSentinel(cfg, {
      runner: fakeRunner(() => ({ code: 0, stdout: 'no\n', stderr: '' })),
    });
    expect(await sentinel.vet()).toBe(false);
    expect(sentinel.isClockVetted()).toBe(false);
  });

  test('nonzero exit is treated as not vetted', async () => {
    const cfg = defaultConfig('alpha');
    const sentinel = new ClockSentinel(cfg, {
      runner: fakeRunner(() => ({ code: 1, stdout: '', stderr: 'no timedatectl' })),
    });
    expect(await sentinel.vet()).toBe(false);
  });
});

// The daemon vets its clock before it will auto-commit, and it used to do that by spawning
// timedatectl unconditionally. On Windows that binary does not exist, Bun.spawn raised ENOENT, and
// the whole node failed to start. Vetting now runs through platform.ts's seam: it degrades, and
// the daemon keeps running and says why it is holding commits.
describe('ClockSentinel.vet across platforms', () => {
  const w32tmSynced = [
    'Leap Indicator: 0(no warning)',
    'Stratum: 3 (secondary reference - syncd by (S)NTP)',
    'ReferenceId: 0x51E1F1EF (source IP:  81.225.241.239)',
    'Source: time.windows.com,0x8',
    '',
  ].join('\r\n');

  const w32tmUnsynced = [
    'Leap Indicator: 3(not synchronized)',
    'Stratum: 0 (unspecified)',
    'Source: Local CMOS Clock',
    '',
  ].join('\r\n');

  test('windows vets through w32tm', async () => {
    const cfg = defaultConfig('alpha');
    const calls: string[][] = [];
    const sentinel = new ClockSentinel(cfg, {
      platform: 'windows',
      runner: fakeRunner((argv) => {
        calls.push(argv);
        return { code: 0, stdout: w32tmSynced, stderr: '' };
      }),
    });
    expect(await sentinel.vet()).toBe(true);
    expect(sentinel.isClockVetted()).toBe(true);
    expect(sentinel.clockSyncState()).toBe('synced');
    expect(calls[0]).toEqual(['w32tm', '/query', '/status']);
  });

  test('an unsynchronised Windows clock stays unvetted', async () => {
    const cfg = defaultConfig('alpha');
    const sentinel = new ClockSentinel(cfg, {
      platform: 'windows',
      runner: fakeRunner(() => ({ code: 0, stdout: w32tmUnsynced, stderr: '' })),
    });
    expect(await sentinel.vet()).toBe(false);
    expect(sentinel.clockSyncState()).toBe('unsynced');
  });

  test('a spawn that throws does NOT escape vet() -- it lands as unknown and unvetted', async () => {
    const cfg = defaultConfig('alpha');
    for (const platform of ['linux', 'windows'] as const) {
      const sentinel = new ClockSentinel(cfg, {
        platform,
        runner: async (argv) => {
          throw new Error(`ENOENT: no such file or directory, uv_spawn '${argv[0]}'`);
        },
      });
      expect(await sentinel.vet()).toBe(false);
      expect(sentinel.isClockVetted()).toBe(false);
      expect(sentinel.clockSyncState()).toBe('unknown');
    }
  });

  test('macos reports unknown without spawning anything', async () => {
    const cfg = defaultConfig('alpha');
    let spawned = 0;
    const sentinel = new ClockSentinel(cfg, {
      platform: 'macos',
      runner: fakeRunner(() => {
        spawned++;
        return { code: 0, stdout: '', stderr: '' };
      }),
    });
    expect(await sentinel.vet()).toBe(false);
    expect(spawned).toBe(0);
  });

  test('the startup vet+resume path completes on a machine with no time client', async () => {
    const cfg = defaultConfig('alpha');
    const steps: string[] = [];
    const sentinel = new ClockSentinel(cfg, {
      platform: 'windows',
      runner: async (argv) => {
        throw new Error(`ENOENT: no such file or directory, uv_spawn '${argv[0]}'`);
      },
      pollTransport: async () => {
        steps.push('poll');
      },
      onEndpointRepublish: async () => {
        steps.push('republish');
      },
      isWedged: () => false,
    });
    await sentinel.vet();
    await sentinel.resumeSequence(1000);
    expect(steps).toEqual(['poll', 'republish']);
    expect(sentinel.isClockVetted()).toBe(false);
  });
});

// pollOnce and its two helpers all document that they never throw. An easytier-cli that is not
// installed used to break that promise, because Bun.spawn raises rather than returning an exit
// code -- ordinary on a machine that has the daemon but not the mesh yet.
describe('Transport polls degrade when easytier-cli is absent', () => {
  test('a spawn that throws is recorded as a failed poll, not an exception', async () => {
    const cfg = defaultConfig('alpha');
    const transport = new Transport(cfg, {
      runner: async (argv) => {
        throw new Error(`ENOENT: no such file or directory, uv_spawn '${argv[0]}'`);
      },
    });
    expect(await transport.pollOnce(1000)).toBeNull();
    expect(transport.diagnosis()).toBeNull();
    expect(transport.wedged(1000)).toBe(false);
  });
});

describe('ClockSentinel peer-skew demotion', () => {
  test('median peer clock offset beyond threshold demotes an already-vetted clock', async () => {
    const cfg = defaultConfig('alpha');
    cfg.thresholds.clockSkewMaxMs = 5000;
    const sentinel = new ClockSentinel(cfg, {
      runner: fakeRunner(() => ({ code: 0, stdout: 'yes\n', stderr: '' })),
    });
    expect(await sentinel.vet()).toBe(true);

    const localNow = 1_000_000;
    sentinel.offerPeerClock('beta', localNow + 9000, localNow);
    sentinel.offerPeerClock('anchor2', localNow + 8000, localNow);

    expect(sentinel.isClockVetted()).toBe(false);
  });

  test('peer clocks within threshold do not demote', async () => {
    const cfg = defaultConfig('alpha');
    cfg.thresholds.clockSkewMaxMs = 5000;
    const sentinel = new ClockSentinel(cfg, {
      runner: fakeRunner(() => ({ code: 0, stdout: 'yes\n', stderr: '' })),
    });
    expect(await sentinel.vet()).toBe(true);

    const localNow = 2_000_000;
    sentinel.offerPeerClock('beta', localNow + 500, localNow);
    sentinel.offerPeerClock('anchor2', localNow - 300, localNow);

    expect(sentinel.isClockVetted()).toBe(true);
  });
});

describe('ClockSentinel.resumeSequence', () => {
  test('re-polls transport, republishes endpoint, re-vets, and restarts if still wedged', async () => {
    const cfg = defaultConfig('alpha');
    const calls: string[] = [];
    const sentinel = new ClockSentinel(cfg, {
      runner: fakeRunner(() => ({ code: 0, stdout: 'yes\n', stderr: '' })),
      pollTransport: async (nowMs) => {
        calls.push(`poll:${nowMs}`);
      },
      onEndpointRepublish: async () => {
        calls.push('republish');
      },
      isWedged: () => true,
      restartTransport: async () => {
        calls.push('restart');
        return true;
      },
    });

    await sentinel.resumeSequence(5000);
    expect(calls).toEqual(['poll:5000', 'republish', 'restart']);
    expect(sentinel.isClockVetted()).toBe(true);
  });

  test('does not restart when the transport is not wedged after re-vetting', async () => {
    const cfg = defaultConfig('alpha');
    let restarted = false;
    const sentinel = new ClockSentinel(cfg, {
      runner: fakeRunner(() => ({ code: 0, stdout: 'yes\n', stderr: '' })),
      pollTransport: async () => {},
      onEndpointRepublish: async () => {},
      isWedged: () => false,
      restartTransport: async () => {
        restarted = true;
        return true;
      },
    });

    await sentinel.resumeSequence(5000);
    expect(restarted).toBe(false);
  });
});

describe('Transport anchor reachability', () => {
  function roamerCfg() {
    const cfg = defaultConfig('beta');
    cfg.role = 'roamer';
    cfg.peers = [{ name: 'alpha', meshIp: '192.0.2.1', nodePort: 7710, publicKeyJwk: null }];
    return cfg;
  }
  const anchorPresent = () => peerJson([{ hostname: 'alpha', rx_bytes: 10, tx_bytes: 5 }]);
  const anchorAbsent = () => peerJson([{ hostname: 'beta', rx_bytes: 0, tx_bytes: 0 }]);

  test('null before any poll, true on first sighting', async () => {
    const t = new Transport(roamerCfg(), { runner: fleetRunner({ peers: anchorPresent, statsTotal: () => 100 }) });
    expect(t.anchorReachable()).toBeNull();
    await t.pollOnce(1000);
    expect(t.anchorReachable()).toBe(true);
  });

  test('always null on the anchor role', async () => {
    const cfg = defaultConfig('alpha');
    cfg.peers = [{ name: 'beta', meshIp: '192.0.2.2', nodePort: 7710, publicKeyJwk: null }];
    const t = new Transport(cfg, { runner: fleetRunner({ peers: () => '[]', statsTotal: () => 100 }) });
    for (let i = 1; i <= ANCHOR_MISS_POLLS + 1; i++) await t.pollOnce(i * 1000);
    expect(t.anchorReachable()).toBeNull();
  });

  test('flips false only after ANCHOR_MISS_POLLS consecutive misses', async () => {
    let peers = anchorPresent;
    const t = new Transport(roamerCfg(), { runner: fleetRunner({ peers: () => peers(), statsTotal: () => 100 }) });
    await t.pollOnce(1000);
    expect(t.anchorReachable()).toBe(true);
    peers = anchorAbsent;
    for (let i = 1; i < ANCHOR_MISS_POLLS; i++) {
      await t.pollOnce(1000 + i * 1000);
      expect(t.anchorReachable()).toBe(true); // hysteresis on the way down
    }
    await t.pollOnce(9000);
    expect(t.anchorReachable()).toBe(false);
  });

  test('a sighting mid-streak resets the miss count', async () => {
    let peers = anchorAbsent;
    const t = new Transport(roamerCfg(), { runner: fleetRunner({ peers: () => peers(), statsTotal: () => 100 }) });
    await t.pollOnce(1000);
    await t.pollOnce(2000);
    peers = anchorPresent;
    await t.pollOnce(3000);
    expect(t.anchorReachable()).toBe(true);
    peers = anchorAbsent;
    await t.pollOnce(4000);
    await t.pollOnce(5000);
    expect(t.anchorReachable()).toBe(true); // streak restarted, not resumed
  });

  test('failed polls carry no evidence: verdict and streak untouched', async () => {
    let mode: 'present' | 'error' | 'absent' = 'present';
    const t = new Transport(roamerCfg(), {
      runner: fakeRunner((argv) => {
        if (argv.includes('peer')) {
          if (mode === 'error') return { code: 1, stdout: '', stderr: 'rpc unreachable' };
          return { code: 0, stdout: mode === 'present' ? anchorPresent() : anchorAbsent(), stderr: '' };
        }
        return {
          code: 0,
          stdout: JSON.stringify([{ name: 'traffic_bytes_rx', value: 100, labels: {} }]),
          stderr: '',
        };
      }),
    });
    await t.pollOnce(1000);
    expect(t.anchorReachable()).toBe(true);
    mode = 'error';
    for (let i = 0; i <= ANCHOR_MISS_POLLS; i++) await t.pollOnce(2000 + i * 1000);
    expect(t.anchorReachable()).toBe(true);
    // Two misses, an error in between, then a third miss: errors must not
    // break the consecutive-miss streak either — misses accumulated 3 total.
    mode = 'absent';
    await t.pollOnce(9000);
    await t.pollOnce(10000);
    mode = 'error';
    await t.pollOnce(11000);
    mode = 'absent';
    await t.pollOnce(12000);
    expect(t.anchorReachable()).toBe(false);
  });

  test('recovery is instant on the next sighting', async () => {
    let peers = anchorAbsent;
    const t = new Transport(roamerCfg(), { runner: fleetRunner({ peers: () => peers(), statsTotal: () => 100 }) });
    for (let i = 1; i <= ANCHOR_MISS_POLLS; i++) await t.pollOnce(i * 1000);
    expect(t.anchorReachable()).toBe(false);
    peers = anchorPresent;
    await t.pollOnce(9000);
    expect(t.anchorReachable()).toBe(true);
  });

  test('a hostname outside cfg.peers is not the anchor', async () => {
    const stranger = () => peerJson([{ hostname: 'not-my-fleet', rx_bytes: 1, tx_bytes: 1 }]);
    const t = new Transport(roamerCfg(), { runner: fleetRunner({ peers: stranger, statsTotal: () => 100 }) });
    for (let i = 1; i <= ANCHOR_MISS_POLLS; i++) await t.pollOnce(i * 1000);
    expect(t.anchorReachable()).toBe(false);
  });
});

describe('parseConnectorJson', () => {
  test('reads the v2.6.4 ordinal shape', () => {
    const out = parseConnectorJson(
      JSON.stringify([
        { url: { url: 'udp://192.0.2.200:11010' }, status: 2 },
        { url: { url: 'tcp://198.51.100.10:44310' }, status: 0 },
      ]),
    );
    expect(out).toEqual([
      { uri: 'udp://192.0.2.200:11010', status: 'connecting' },
      { uri: 'tcp://198.51.100.10:44310', status: 'connected' },
    ]);
  });

  test('also accepts the rendered status names, and calls anything else unknown', () => {
    const out = parseConnectorJson(
      JSON.stringify([
        { url: { url: 'udp://192.0.2.1:11010' }, status: 'Connected' },
        { url: { url: 'udp://192.0.2.2:11010' }, status: 99 },
      ]),
    );
    expect(out).toEqual([
      { uri: 'udp://192.0.2.1:11010', status: 'connected' },
      { uri: 'udp://192.0.2.2:11010', status: 'unknown' },
    ]);
  });

  test('untrusted shapes return null or are skipped, never throw', () => {
    expect(parseConnectorJson('not json')).toBeNull();
    expect(parseConnectorJson('{"oops":true}')).toBeNull();
    expect(parseConnectorJson(JSON.stringify([{ url: null, status: 0 }, { status: 0 }, 7]))).toEqual([]);
  });
});

describe('diagnoseTransport', () => {
  const connected = { uri: 'udp://198.51.100.10:11010', status: 'connected' as const };
  const dialing = { uri: 'udp://192.0.2.200:11010', status: 'connecting' as const };

  test('a non-local peer is ok regardless of connector state', () => {
    expect(diagnoseTransport(1, [dialing]).fault).toBe('ok');
  });

  test('no connectors at all is its own fault', () => {
    expect(diagnoseTransport(0, []).fault).toBe('no-connectors');
  });

  test('every connector still dialling means no path exists', () => {
    const d = diagnoseTransport(0, [dialing]);
    expect(d.fault).toBe('all-connectors-down');
    expect(d.dialingUris).toEqual(['udp://192.0.2.200:11010']);
  });

  test('connected but peerless is the non-converging session, not an outage', () => {
    const d = diagnoseTransport(0, [dialing, connected]);
    expect(d.fault).toBe('connected-without-peer');
    expect(d.connectedUris).toEqual(['udp://198.51.100.10:11010']);
    expect(d.dialingUris).toEqual(['udp://192.0.2.200:11010']);
    expect(d.summary).toContain('not converging');
  });
});

describe('Transport diagnosis wiring', () => {
  function runnerFor(peers: string, connectors: string, seen: string[][]) {
    return fakeRunner((argv) => {
      seen.push(argv);
      if (argv.includes('connector')) return { code: 0, stdout: connectors, stderr: '' };
      if (argv.includes('peer')) return { code: 0, stdout: peers, stderr: '' };
      return { code: 0, stdout: JSON.stringify([{ name: 'traffic_bytes_rx', value: 1 }]), stderr: '' };
    });
  }

  test('an empty peer table with a connected connector is diagnosed, not just reported empty', async () => {
    const cfg = defaultConfig('alpha');
    const seen: string[][] = [];
    const t = new Transport(cfg, {
      runner: runnerFor(
        peerJson([{ hostname: 'alpha', rx_bytes: 0, tx_bytes: 0 }]),
        JSON.stringify([
          { url: { url: 'udp://192.0.2.200:11010' }, status: 2 },
          { url: { url: 'udp://198.51.100.10:11010' }, status: 0 },
        ]),
        seen,
      ),
    });
    await t.pollOnce(1000);
    expect(t.diagnosis()?.fault).toBe('connected-without-peer');
    expect(seen.some((argv) => argv.includes('connector'))).toBe(true);
  });

  test('a healthy mesh costs no extra connector round-trip', async () => {
    const cfg = defaultConfig('alpha');
    const seen: string[][] = [];
    const t = new Transport(cfg, {
      runner: runnerFor(
        peerJson([
          { hostname: 'alpha', rx_bytes: 0, tx_bytes: 0 },
          { hostname: 'beta', rx_bytes: 10, tx_bytes: 10 },
        ]),
        '[]',
        seen,
      ),
    });
    await t.pollOnce(1000);
    expect(t.diagnosis()?.fault).toBe('ok');
    expect(seen.some((argv) => argv.includes('connector'))).toBe(false);
  });

  test('an unreadable connector list leaves no opinion rather than a false all-clear', async () => {
    const cfg = defaultConfig('alpha');
    const t = new Transport(cfg, {
      runner: fakeRunner((argv) => {
        if (argv.includes('connector')) return { code: 1, stdout: '', stderr: 'rpc portal refused' };
        if (argv.includes('peer')) return { code: 0, stdout: peerJson([]), stderr: '' };
        return { code: 0, stdout: JSON.stringify([{ name: 'traffic_bytes_rx', value: 1 }]), stderr: '' };
      }),
    });
    await t.pollOnce(1000);
    expect(t.diagnosis()).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Route audit (upstream EasyTier #2597): one peer on the mesh, no route here
// ---------------------------------------------------------------------------

// Shapes copied from `easytier-cli -o json peer list` / `peer-center` on 2.6.4,
// with synthetic names and ids. The lost peer's row in the peer center has an
// empty hostname and IPv4: both come from the route that is missing.
function peerListJson(rows: Array<{ id: string; hostname: string; cost: string }>): string {
  return JSON.stringify(rows.map((r) => ({ ...r, cidr: '', ipv4: '', rx_bytes: '1 kB', tx_bytes: '1 kB' })));
}

function centerJson(rows: Array<{ id: string; hostname: string; direct: string[] }>): string {
  return JSON.stringify(
    rows.map((r) => ({
      node_id: r.id,
      hostname: r.hostname,
      ipv4: r.hostname === '' ? '' : '192.0.2.1/24',
      direct_peers: r.direct.map((d) => ({ node_id: d, hostname: '', ipv4: '', latency_ms: 5 })),
    })),
  );
}

const ALL_ROUTED = [
  { id: '100', hostname: 'alpha', cost: 'Local' },
  { id: '200', hostname: 'beta', cost: 'p2p' },
  { id: '300', hostname: 'gamma', cost: 'p2p' },
];
const GAMMA_LOST = ALL_ROUTED.slice(0, 2);
// alpha holds a live connection to gamma (300) while gamma's route is gone.
const CENTER_GAMMA_LOST = [
  { id: '100', hostname: 'alpha', direct: ['200', '300'] },
  { id: '200', hostname: 'beta', direct: ['100', '300'] },
  { id: '300', hostname: '', direct: ['100', '200'] },
];

describe('parsePeerCenterJson', () => {
  test('reads node ids and direct peers from the real 2.6.4 shape', () => {
    const rows = parsePeerCenterJson(centerJson(CENTER_GAMMA_LOST));
    expect(rows).toEqual([
      { nodeId: '100', hostname: 'alpha', directPeerIds: ['200', '300'] },
      { nodeId: '200', hostname: 'beta', directPeerIds: ['100', '300'] },
      { nodeId: '300', hostname: '', directPeerIds: ['100', '200'] },
    ]);
  });

  test('accepts numeric ids and skips entries without one', () => {
    const rows = parsePeerCenterJson(
      JSON.stringify([{ node_id: 7, hostname: 'x', direct_peers: [{ node_id: 8 }, { hostname: 'no id' }, null] }, { hostname: 'no id' }, 3]),
    );
    expect(rows).toEqual([{ nodeId: '7', hostname: 'x', directPeerIds: ['8'] }]);
  });

  test('null on anything it cannot trust', () => {
    expect(parsePeerCenterJson('not json')).toBeNull();
    expect(parsePeerCenterJson('{"node_id":"1"}')).toBeNull();
  });
});

describe('findUnroutedPeers', () => {
  const center = parsePeerCenterJson(centerJson(CENTER_GAMMA_LOST))!;

  test('the incident: a peer with a live connection here and no route is reported by id and remembered name', () => {
    const out = findUnroutedPeers('100', new Set(['100', '200']), center, new Map([['300', 'gamma']]));
    expect(out).toEqual([{ peerId: '300', hostname: 'gamma', evidence: 'direct-connection' }]);
  });

  test('a peer only other nodes report is flagged with weaker evidence', () => {
    const c = parsePeerCenterJson(
      centerJson([
        { id: '100', hostname: 'alpha', direct: ['200'] },
        { id: '200', hostname: 'beta', direct: ['100', '300'] },
      ]),
    )!;
    expect(findUnroutedPeers('100', new Set(['100', '200']), c)).toEqual([
      { peerId: '300', hostname: null, evidence: 'peer-center' },
    ]);
  });

  test('a healthy mesh reports nothing', () => {
    expect(findUnroutedPeers('100', new Set(['100', '200', '300']), center)).toEqual([]);
  });

  test('without its own id this node says nothing rather than reporting itself', () => {
    expect(findUnroutedPeers(null, new Set(['200', '300']), center)).toEqual([]);
  });
});

describe('Transport route audit', () => {
  function auditRunner(state: { peers: string; center: string | null }, seen: string[][] = []) {
    return fakeRunner((argv) => {
      seen.push(argv);
      if (argv.includes('peer-center')) {
        if (state.center === null) return { code: 1, stdout: '', stderr: 'rpc portal refused' };
        return { code: 0, stdout: state.center, stderr: '' };
      }
      if (argv.includes('peer')) return { code: 0, stdout: state.peers, stderr: '' };
      return { code: 0, stdout: JSON.stringify([{ name: 'traffic_bytes_rx', value: 1 }]), stderr: '' };
    });
  }

  test('asks the peer center with the exact 2.6.4 argv', async () => {
    const cfg = defaultConfig('alpha');
    const seen: string[][] = [];
    const t = new Transport(cfg, { runner: auditRunner({ peers: peerListJson(ALL_ROUTED), center: '[]' }, seen) });
    await t.pollOnce(1000);
    expect(seen).toContainEqual([cfg.easytier.cliPath, '-p', cfg.easytier.rpcAddr, '-o', 'json', 'peer-center']);
  });

  test('confirms a lost route only after ROUTE_MISS_POLLS polls, names it, and clears on the first routed poll', async () => {
    const state = { peers: peerListJson(ALL_ROUTED), center: centerJson(CENTER_GAMMA_LOST.map((r) => ({ ...r, hostname: r.hostname || 'gamma' }))) };
    const t = new Transport(defaultConfig('alpha'), { runner: auditRunner(state) });
    await t.pollOnce(1000); // healthy: learns that 300 is gamma
    expect(t.unroutedPeers()).toEqual([]);

    state.peers = peerListJson(GAMMA_LOST);
    state.center = centerJson(CENTER_GAMMA_LOST);
    for (let i = 1; i < ROUTE_MISS_POLLS; i++) {
      await t.pollOnce(1000 + i * 1000);
      expect(t.unroutedPeers()).toEqual([]);
    }
    await t.pollOnce(9000);
    expect(t.unroutedPeers()).toEqual([{ peerId: '300', hostname: 'gamma', evidence: 'direct-connection' }]);

    state.peers = peerListJson(ALL_ROUTED);
    await t.pollOnce(10000);
    expect(t.unroutedPeers()).toEqual([]);
  });

  test('an unreadable peer center neither resets nor advances the streak', async () => {
    const state: { peers: string; center: string | null } = { peers: peerListJson(GAMMA_LOST), center: centerJson(CENTER_GAMMA_LOST) };
    const t = new Transport(defaultConfig('alpha'), { runner: auditRunner(state) });
    await t.pollOnce(1000);
    await t.pollOnce(2000);
    state.center = null;
    await t.pollOnce(3000);
    expect(t.unroutedPeers()).toEqual([]);
    state.center = centerJson(CENTER_GAMMA_LOST);
    await t.pollOnce(4000);
    expect(t.unroutedPeers().map((u) => u.peerId)).toEqual(['300']);
    // And once confirmed, an unreadable center does not clear the alarm either.
    state.center = null;
    await t.pollOnce(5000);
    expect(t.unroutedPeers().map((u) => u.peerId)).toEqual(['300']);
  });

  test('a peer that comes back between polls breaks the streak', async () => {
    const state = { peers: peerListJson(GAMMA_LOST), center: centerJson(CENTER_GAMMA_LOST) };
    const t = new Transport(defaultConfig('alpha'), { runner: auditRunner(state) });
    await t.pollOnce(1000);
    await t.pollOnce(2000);
    state.peers = peerListJson(ALL_ROUTED);
    await t.pollOnce(3000);
    state.peers = peerListJson(GAMMA_LOST);
    await t.pollOnce(4000);
    await t.pollOnce(5000);
    expect(t.unroutedPeers()).toEqual([]);
  });

  test('oneWaySuspects reads the last poll: routed, alive in the peer center, and silent', async () => {
    const state = { peers: peerListJson(ALL_ROUTED), center: centerJson(CENTER_GAMMA_LOST.map((r) => ({ ...r, hostname: r.hostname || 'gamma' }))) };
    const t = new Transport(defaultConfig('alpha'), { runner: auditRunner(state) });
    expect(t.oneWaySuspects(['beta'])).toEqual([]); // no poll yet: no opinion
    await t.pollOnce(1000);
    expect(t.oneWaySuspects(['beta', 'delta'])).toEqual(['beta']);
  });
});

describe('oneWayRouteSuspects', () => {
  const center = parsePeerCenterJson(
    centerJson([
      { id: '100', hostname: 'alpha', direct: ['200'] },
      { id: '200', hostname: 'beta', direct: ['100'] },
      { id: '300', hostname: 'gamma', direct: [] },
    ]),
  );

  test('a silent peer that is routed and alive on the mesh is a suspect', () => {
    expect(oneWayRouteSuspects(['beta'], new Set(['beta', 'gamma']), center)).toEqual(['beta']);
  });

  test('a silent peer this node cannot route to is not: that is the other side of the fault', () => {
    expect(oneWayRouteSuspects(['beta'], new Set(['gamma']), center)).toEqual([]);
  });

  test('a peer with no live links in the peer center is just gone', () => {
    expect(oneWayRouteSuspects(['gamma'], new Set(['beta', 'gamma']), center)).toEqual([]);
  });

  test('no peer-center reading means no opinion', () => {
    expect(oneWayRouteSuspects(['beta'], new Set(['beta']), null)).toEqual([]);
  });
});

describe('ReannounceGate', () => {
  test('fires on the REANNOUNCE_SUSPECT_POLLS-th consecutive sighting, not before', () => {
    const g = new ReannounceGate();
    for (let i = 1; i < REANNOUNCE_SUSPECT_POLLS; i++) expect(g.observe(i * 1000, ['beta'])).toEqual([]);
    expect(g.observe(REANNOUNCE_SUSPECT_POLLS * 1000, ['beta'])).toEqual(['beta']);
  });

  test('a clean poll resets the streak', () => {
    const g = new ReannounceGate();
    for (let i = 1; i < REANNOUNCE_SUSPECT_POLLS; i++) g.observe(i * 1000, ['beta']);
    g.observe(50_000, []);
    expect(g.observe(60_000, ['beta'])).toEqual([]);
  });

  test('rate-limited to one re-announce per REANNOUNCE_MIN_INTERVAL_MS while the suspicion lasts', () => {
    const g = new ReannounceGate();
    let t = 0;
    for (let i = 0; i < REANNOUNCE_SUSPECT_POLLS; i++) g.observe((t += 30_000), ['beta']);
    const firedAt = t;
    expect(g.observe((t += 30_000), ['beta'])).toEqual([]);
    expect(g.observe(firedAt + REANNOUNCE_MIN_INTERVAL_MS - 1, ['beta'])).toEqual([]);
    expect(g.observe(firedAt + REANNOUNCE_MIN_INTERVAL_MS, ['beta'])).toEqual(['beta']);
  });
});

describe('Transport.reannounceSelf', () => {
  const SECRET = 'credential-secret-that-must-never-be-logged';

  function capture(): { lines: string[]; restore: () => void } {
    const lines: string[] = [];
    const orig = console.log;
    console.log = (...a: unknown[]) => {
      lines.push(a.map(String).join(' '));
    };
    return { lines, restore: () => (console.log = orig) };
  }

  test('creates a throwaway credential, waits for EasyTier to publish it, then revokes the same id', async () => {
    const cfg = defaultConfig('alpha');
    const seen: string[][] = [];
    const sleeps: number[] = [];
    const t = new Transport(cfg, {
      runner: fakeRunner((argv) => {
        seen.push(argv);
        return { code: 0, stdout: argv.includes('generate') ? `credential_secret: ${SECRET}` : 'ok', stderr: '' };
      }),
      sleep: async (ms) => {
        sleeps.push(ms);
      },
    });
    const out = capture();
    let ok: boolean;
    try {
      ok = await t.reannounceSelf(1234);
    } finally {
      out.restore();
    }
    expect(ok).toBe(true);
    const base = [cfg.easytier.cliPath, '-p', cfg.easytier.rpcAddr];
    expect(seen).toEqual([
      [...base, 'credential', 'generate', '--ttl', '60', '--credential-id', 'sukarfleet-reannounce-1234', '--reusable', 'false'],
      [...base, 'credential', 'revoke', 'sukarfleet-reannounce-1234'],
    ]);
    // Two changes on two different one-second publish ticks.
    expect(sleeps).toEqual([3000]);
    expect(out.lines.join('\n')).not.toContain(SECRET);
  });

  test('a refused generate reports failure and revokes nothing', async () => {
    const seen: string[][] = [];
    const t = new Transport(defaultConfig('alpha'), {
      runner: fakeRunner((argv) => {
        seen.push(argv);
        return { code: 1, stdout: '', stderr: 'only admin nodes (with network_secret) can generate credentials' };
      }),
      sleep: async () => {},
    });
    const out = capture();
    try {
      expect(await t.reannounceSelf(1)).toBe(false);
    } finally {
      out.restore();
    }
    expect(seen.length).toBe(1);
  });

  test('a failed revoke still counts: the route info was re-published, and the credential expires', async () => {
    const t = new Transport(defaultConfig('alpha'), {
      runner: fakeRunner((argv) =>
        argv.includes('revoke')
          ? { code: 1, stdout: '', stderr: 'rpc timeout' }
          : { code: 0, stdout: `credential_secret: ${SECRET}`, stderr: '' },
      ),
      sleep: async () => {},
    });
    const out = capture();
    try {
      expect(await t.reannounceSelf(1)).toBe(true);
    } finally {
      out.restore();
    }
    expect(out.lines.some((l) => l.includes('could not revoke'))).toBe(true);
    expect(out.lines.join('\n')).not.toContain(SECRET);
  });

  test('a missing easytier-cli is a failure, not a throw', async () => {
    const t = new Transport(defaultConfig('alpha'), {
      runner: async () => {
        throw new Error('ENOENT');
      },
      sleep: async () => {},
    });
    const out = capture();
    try {
      expect(await t.reannounceSelf(1)).toBe(false);
    } finally {
      out.restore();
    }
  });
});
