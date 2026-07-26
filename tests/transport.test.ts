// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, test } from 'bun:test';
import { defaultConfig } from '../src/config';
import type { RunOptions, RunResult } from '../src/util';
import { ANCHOR_MISS_POLLS, ClockSentinel, Transport, generateEasytierToml } from '../src/transport';

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
function fleetRunner(opts: { peers: () => string; statsTotal: () => number | null }) {
  const cfg = defaultConfig('alpha');
  const base = [cfg.easytier.cliPath, '-p', cfg.easytier.rpcAddr, '-o', 'json'];
  return fakeRunner((argv) => {
    // Pin the exact CLI vectors: the production outage was a wrong interface
    // (`peer --output-format json`), so a loose match here guards nothing.
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
