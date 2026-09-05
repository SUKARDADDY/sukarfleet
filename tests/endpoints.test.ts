// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, test, expect } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { atomicWrite, canonicalJson, readJsonFile } from '../src/util';
import { defaultConfig } from '../src/config';
import type { FleetConfig, EndpointFile, MachineKey, PeerConfig } from '../src/types';
import {
  buildEndpointFile,
  publishEndpointFile,
  readPeerEndpoint,
  probeWanIp,
  lanIp,
  parseLanIpFromIpAddrJson,
  probeUpnpIgd,
  planPeerDial,
  selectLanIpFromInterfaces,
} from '../src/endpoints';
import type { NetworkInterfaceView } from '../src/endpoints';

async function withTmpDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), 'sukarfleet-endpoints-test-'));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function makeKeyPair(machine: string): Promise<MachineKey> {
  const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  const publicKeyJwk = await crypto.subtle.exportKey('jwk', pair.publicKey);
  const privateKeyJwk = await crypto.subtle.exportKey('jwk', pair.privateKey);
  return { machine, publicKeyJwk, privateKeyJwk };
}

function makePeer(key: MachineKey, meshIp: string, nodePort = 7710): PeerConfig {
  return { name: key.machine, meshIp, nodePort, publicKeyJwk: key.publicKeyJwk };
}

function configWith(fleetRepoPath: string, machine: string, peers: PeerConfig[] = []): FleetConfig {
  const cfg = defaultConfig(machine);
  cfg.fleetRepoPath = fleetRepoPath;
  cfg.meshIp = '198.51.100.2';
  cfg.peers = peers;
  return cfg;
}

describe('buildEndpointFile / readPeerEndpoint round trip', () => {
  test('signs and verifies a valid endpoint file', async () => {
    await withTmpDir(async (dir) => {
      const keyA = await makeKeyPair('machine-a');
      const cfgA = configWith(dir, 'machine-a');
      const file = await buildEndpointFile(cfgA, keyA, '203.0.113.9', '192.0.2.20', 1_000_000);

      expect(file.v).toBe(1);
      expect(file.machine).toBe('machine-a');
      expect(file.wanIp).toBe('203.0.113.9');
      expect(file.lanIp).toBe('192.0.2.20');
      expect(file.meshIp).toBe('198.51.100.2');
      expect(file.ports).toEqual({ udp: cfgA.wan.udpPort, tcp: cfgA.wan.tcpPort });
      expect(file.tsMs).toBe(1_000_000);
      expect(typeof file.sigB64).toBe('string');

      // Write it where a peer reading machine-a's endpoint would look.
      const path = join(dir, 'endpoints', 'machine-a.json');
      await atomicWrite(path, canonicalJson(file) + '\n');

      // A separate machine, configured with machine-a's public key, reads it back.
      const cfgReader = configWith(dir, 'machine-b', [makePeer(keyA, '198.51.100.2')]);
      const read = await readPeerEndpoint(cfgReader, 'machine-a');
      expect(read).toEqual(file);
    });
  });

  test('returns null for unknown peer or peer without a configured public key', async () => {
    await withTmpDir(async (dir) => {
      const cfg = configWith(dir, 'machine-b', []);
      expect(await readPeerEndpoint(cfg, 'machine-a')).toBeNull();

      const cfgNoKey = configWith(dir, 'machine-b', [
        { name: 'machine-a', meshIp: '198.51.100.2', nodePort: 7710, publicKeyJwk: null },
      ]);
      expect(await readPeerEndpoint(cfgNoKey, 'machine-a')).toBeNull();
    });
  });

  test('returns null when the endpoint file is missing', async () => {
    await withTmpDir(async (dir) => {
      const keyA = await makeKeyPair('machine-a');
      const cfg = configWith(dir, 'machine-b', [makePeer(keyA, '198.51.100.2')]);
      expect(await readPeerEndpoint(cfg, 'machine-a')).toBeNull();
    });
  });
});

describe('readPeerEndpoint rejects tampering', () => {
  test('a mutated field breaks signature verification', async () => {
    await withTmpDir(async (dir) => {
      const keyA = await makeKeyPair('machine-a');
      const cfgA = configWith(dir, 'machine-a');
      const file = await buildEndpointFile(cfgA, keyA, '203.0.113.9', '192.0.2.20', 1_000_000);
      const path = join(dir, 'endpoints', 'machine-a.json');
      await atomicWrite(path, canonicalJson(file) + '\n');

      // Tamper: attacker rewrites the wanIp but keeps the old signature.
      const tampered: EndpointFile = { ...file, wanIp: '198.51.100.1' };
      await atomicWrite(path, canonicalJson(tampered) + '\n');

      const cfgReader = configWith(dir, 'machine-b', [makePeer(keyA, '198.51.100.2')]);
      expect(await readPeerEndpoint(cfgReader, 'machine-a')).toBeNull();
    });
  });

  test('a signature signed by the wrong key is rejected', async () => {
    await withTmpDir(async (dir) => {
      const keyA = await makeKeyPair('machine-a');
      const impostorKey = await makeKeyPair('machine-a');
      const cfgA = configWith(dir, 'machine-a');
      // Signed by impostor's private key but claims to be machine-a.
      const file = await buildEndpointFile(cfgA, impostorKey, '203.0.113.9', '192.0.2.20', 1_000_000);
      const path = join(dir, 'endpoints', 'machine-a.json');
      await atomicWrite(path, canonicalJson(file) + '\n');

      // Reader trusts keyA's public key for machine-a, not the impostor's.
      const cfgReader = configWith(dir, 'machine-b', [makePeer(keyA, '198.51.100.2')]);
      expect(await readPeerEndpoint(cfgReader, 'machine-a')).toBeNull();
    });
  });
});

describe('publishEndpointFile', () => {
  test('writes only when stable content changes; tsMs alone does not trigger a rewrite', async () => {
    await withTmpDir(async (dir) => {
      const key = await makeKeyPair('machine-a');
      const cfg = configWith(dir, 'machine-a');

      const first = await publishEndpointFile(cfg, key, {
        wanIp: '203.0.113.9',
        lanIp: '192.0.2.20',
        nowMs: 1_000_000,
      });
      expect(first.published).toBe(true);
      expect(first.file.tsMs).toBe(1_000_000);

      // Same wanIp/lanIp/meshIp/ports, only nowMs differs -> must not rewrite.
      const second = await publishEndpointFile(cfg, key, {
        wanIp: '203.0.113.9',
        lanIp: '192.0.2.20',
        nowMs: 2_000_000,
      });
      expect(second.published).toBe(false);
      expect(second.file.tsMs).toBe(1_000_000); // untouched, still the first file

      const onDisk = await readJsonFile<EndpointFile>(join(dir, 'endpoints', 'machine-a.json'));
      expect(onDisk?.tsMs).toBe(1_000_000);

      // A real content change (wanIp) must trigger a rewrite.
      const third = await publishEndpointFile(cfg, key, {
        wanIp: '203.0.113.10',
        lanIp: '192.0.2.20',
        nowMs: 3_000_000,
      });
      expect(third.published).toBe(true);
      expect(third.file.wanIp).toBe('203.0.113.10');
      expect(third.file.tsMs).toBe(3_000_000);
    });
  });

  test('published file round-trips through readPeerEndpoint for a peer', async () => {
    await withTmpDir(async (dir) => {
      const key = await makeKeyPair('machine-a');
      const cfg = configWith(dir, 'machine-a');
      await publishEndpointFile(cfg, key, { wanIp: '203.0.113.9', lanIp: '192.0.2.20', nowMs: 1_000_000 });

      const cfgReader = configWith(dir, 'machine-b', [makePeer(key, cfg.meshIp)]);
      const read = await readPeerEndpoint(cfgReader, 'machine-a');
      expect(read?.wanIp).toBe('203.0.113.9');
    });
  });

  test('tolerates a git failure (no repo/origin present) without throwing', async () => {
    await withTmpDir(async (dir) => {
      const key = await makeKeyPair('machine-a');
      const cfg = configWith(dir, 'machine-a');
      // dir is not a git repo at all; publishEndpointFile must not throw.
      const result = await publishEndpointFile(cfg, key, {
        wanIp: '203.0.113.9',
        lanIp: '192.0.2.20',
        nowMs: 1_000_000,
      });
      expect(result.published).toBe(true);
    });
  });
});

describe('probeWanIp fallback order', () => {
  function fakeResponse(ok: boolean, text: string, status = 200) {
    return { ok, status, text: async () => text } as Response;
  }

  test('uses the first source when it succeeds and validates', async () => {
    const calls: string[] = [];
    const fetcher = async (url: string) => {
      calls.push(url);
      return fakeResponse(true, '203.0.113.5');
    };
    const ip = await probeWanIp(fetcher);
    expect(ip).toBe('203.0.113.5');
    expect(calls).toEqual(['https://api.ipify.org']);
  });

  test('falls back to the second source when the first errors', async () => {
    const calls: string[] = [];
    const fetcher = async (url: string) => {
      calls.push(url);
      if (url === 'https://api.ipify.org') throw new Error('network down');
      return fakeResponse(true, '198.51.100.7');
    };
    const ip = await probeWanIp(fetcher);
    expect(ip).toBe('198.51.100.7');
    expect(calls).toEqual(['https://api.ipify.org', 'https://icanhazip.com']);
  });

  test('falls back to the second source when the first returns a non-IPv4 shape', async () => {
    const fetcher = async (url: string) => {
      if (url === 'https://api.ipify.org') return fakeResponse(true, '<html>not an ip</html>');
      return fakeResponse(true, '198.51.100.8');
    };
    const ip = await probeWanIp(fetcher);
    expect(ip).toBe('198.51.100.8');
  });

  test('returns null when both sources fail', async () => {
    const fetcher = async () => fakeResponse(false, '', 503);
    const ip = await probeWanIp(fetcher);
    expect(ip).toBeNull();
  });
});

describe('parseLanIpFromIpAddrJson / lanIp', () => {
  const fixture = JSON.stringify([
    {
      ifname: 'lo',
      operstate: 'UNKNOWN',
      addr_info: [{ family: 'inet', local: '127.0.0.1', scope: 'host' }],
    },
    {
      ifname: 'wlan0',
      operstate: 'DOWN',
      addr_info: [{ family: 'inet', local: '192.0.2.99', scope: 'global' }],
    },
    {
      ifname: 'eth0',
      operstate: 'UP',
      addr_info: [
        { family: 'inet6', local: 'fe80::1', scope: 'link' },
        { family: 'inet', local: '192.0.2.42', scope: 'global' },
      ],
    },
  ]);

  test('picks the first UP, non-loopback, global-scope IPv4 address', () => {
    expect(parseLanIpFromIpAddrJson(fixture)).toBe('192.0.2.42');
  });

  test('returns null for malformed JSON', () => {
    expect(parseLanIpFromIpAddrJson('not json')).toBeNull();
  });

  test('returns null when no interface qualifies', () => {
    const onlyLo = JSON.stringify([
      { ifname: 'lo', addr_info: [{ family: 'inet', local: '127.0.0.1', scope: 'host' }] },
    ]);
    expect(parseLanIpFromIpAddrJson(onlyLo)).toBeNull();
  });

  test('lanIp() parses the output of an injected run function', async () => {
    const runFn = async () => ({ code: 0, stdout: fixture, stderr: '' });
    expect(await lanIp(runFn)).toBe('192.0.2.42');
  });

  test('lanIp() returns null and logs a warning when the command fails and nothing else answers', async () => {
    const runFn = async () => ({ code: 1, stdout: '', stderr: 'ip: command not found' });
    // The fallback reader is injected empty, so this still asserts what it always did: a failed
    // `ip` with no other source of an address yields null, never a guess.
    expect(await lanIp(runFn, { platform: 'linux', interfaces: () => ({}) })).toBeNull();
  });

  test('the ip path skips this machine own mesh address', () => {
    const withMesh = JSON.stringify([
      {
        ifname: 'easytier0',
        operstate: 'UP',
        addr_info: [{ family: 'inet', local: '203.0.113.4', scope: 'global' }],
      },
      {
        ifname: 'eth0',
        operstate: 'UP',
        addr_info: [{ family: 'inet', local: '192.0.2.42', scope: 'global' }],
      },
    ]);
    expect(parseLanIpFromIpAddrJson(withMesh)).toBe('203.0.113.4');
    expect(parseLanIpFromIpAddrJson(withMesh, '203.0.113.4')).toBe('192.0.2.42');
  });
});

// The second source of the same answer. Windows has no iproute2 -- the first real Windows boot
// died on `uv_spawn 'ip'` -- so these fabricate what node:os hands back and assert the rule stays
// the one the `ip` path applies.
describe('selectLanIpFromInterfaces', () => {
  const ifaces = (): Record<string, NetworkInterfaceView[]> => ({
    'Loopback Pseudo-Interface 1': [
      { address: '127.0.0.1', family: 'IPv4', internal: true },
      { address: '::1', family: 'IPv6', internal: true },
    ],
    'Local Area Connection* 9': [{ address: '169.254.13.7', family: 'IPv4', internal: false }],
    easytier: [{ address: '198.51.100.4', family: 'IPv4', internal: false }],
    'Wi-Fi': [
      { address: 'fe80::1c2b:3d4e:5f60:7a8b', family: 'IPv6', internal: false },
      { address: '192.0.2.42', family: 'IPv4', internal: false },
    ],
  });

  test('picks the first non-internal, non-link-local IPv4 in enumeration order', () => {
    expect(selectLanIpFromInterfaces(ifaces())).toBe('198.51.100.4');
  });

  test('skips this machine own mesh address, so the LAN candidate is never the overlay', () => {
    expect(selectLanIpFromInterfaces(ifaces(), '198.51.100.4')).toBe('192.0.2.42');
  });

  test('accepts the numeric family shape node has also shipped', () => {
    expect(
      selectLanIpFromInterfaces({ eth0: [{ address: '192.0.2.7', family: 4, internal: false }] }),
    ).toBe('192.0.2.7');
  });

  test('returns null when only loopback and link-local addresses exist', () => {
    expect(
      selectLanIpFromInterfaces({
        lo: [{ address: '127.0.0.1', family: 'IPv4', internal: true }],
        eth0: [{ address: '169.254.1.2', family: 'IPv4', internal: false }],
      }),
    ).toBeNull();
  });
});

describe('lanIp platform fallback', () => {
  const winIfaces = (): Record<string, NetworkInterfaceView[]> => ({
    Ethernet: [{ address: '198.51.100.20', family: 'IPv4', internal: false }],
  });

  test('a spawn that throws ENOENT falls back to networkInterfaces() instead of propagating', async () => {
    let spawned = 0;
    const runFn = async (): Promise<never> => {
      spawned++;
      throw new Error("ENOENT: no such file or directory, uv_spawn 'ip'");
    };
    const ip = await lanIp(runFn, { platform: 'linux', interfaces: winIfaces });
    expect(ip).toBe('198.51.100.20');
    expect(spawned).toBe(1);
  });

  test('windows never spawns ip(8) at all', async () => {
    let spawned = 0;
    const runFn = async (): Promise<never> => {
      spawned++;
      throw new Error('should not be called');
    };
    expect(await lanIp(runFn, { platform: 'windows', interfaces: winIfaces })).toBe('198.51.100.20');
    expect(spawned).toBe(0);
  });

  test('linux still prefers the ip path when it works', async () => {
    const fixture = JSON.stringify([
      { ifname: 'eth0', operstate: 'UP', addr_info: [{ family: 'inet', local: '192.0.2.42', scope: 'global' }] },
    ]);
    const runFn = async () => ({ code: 0, stdout: fixture, stderr: '' });
    expect(await lanIp(runFn, { platform: 'linux', interfaces: winIfaces })).toBe('192.0.2.42');
  });
});

describe('probeUpnpIgd', () => {
  test('resolves to a boolean and respects the timeout when no IGD responds', async () => {
    const start = Date.now();
    const result = await probeUpnpIgd(150);
    const elapsed = Date.now() - start;
    expect(typeof result).toBe('boolean');
    expect(elapsed).toBeLessThan(5000);
  });
});

// A roamer that lands on a foreign network reusing the anchor's LAN range is the
// scenario these guard: the anchor's LAN address is then on-link but belongs to a
// different wire, and dialling it neither connects nor fails fast.
function peerEndpoint(overrides: Partial<EndpointFile> = {}): EndpointFile {
  return {
    v: 1,
    machine: 'anchor-machine',
    wanIp: '198.51.100.10',
    lanIp: '192.0.2.200',
    meshIp: '198.51.100.1',
    ports: { udp: 11010, tcp: 44310 },
    tsMs: 1_700_000_000_000,
    sigB64: 'not-checked-by-planPeerDial',
    ...overrides,
  };
}

describe('planPeerDial co-location gate', () => {
  test('same WAN IP proves co-location: the LAN candidate leads', () => {
    const plan = planPeerDial({ wanIp: '198.51.100.10', lanIp: '192.0.2.8' }, peerEndpoint(), {
      peerLanPort: 11010,
    });
    expect(plan.uris).toEqual([
      'udp://192.0.2.200:11010',
      'udp://198.51.100.10:11010',
      'tcp://198.51.100.10:44310',
    ]);
    expect(plan.lanSuppressed).toBeNull();
    expect(plan.coLocationUnknown).toBe(false);
  });

  test('different WAN IPs: the LAN candidate is a phantom and is not offered', () => {
    // Same /24 on both sides -- the collision that makes the address look on-link.
    const plan = planPeerDial({ wanIp: '203.0.113.5', lanIp: '192.0.2.8' }, peerEndpoint(), {
      peerLanPort: 11010,
    });
    expect(plan.uris).toEqual(['udp://198.51.100.10:11010', 'tcp://198.51.100.10:44310']);
    expect(plan.candidates.some((c) => c.via === 'lan')).toBe(false);
    expect(plan.lanSuppressed).toEqual({ uri: 'udp://192.0.2.200:11010', reason: 'peer-behind-different-wan' });
    expect(plan.coLocationUnknown).toBe(false);
  });

  test('unknown WAN IP on either side: LAN is ranked last, never suppressed', () => {
    const selfUnknown = planPeerDial({ wanIp: null, lanIp: '192.0.2.8' }, peerEndpoint(), { peerLanPort: 11010 });
    expect(selfUnknown.uris.at(-1)).toBe('udp://192.0.2.200:11010');
    expect(selfUnknown.lanSuppressed).toBeNull();
    expect(selfUnknown.coLocationUnknown).toBe(true);

    // Peer offline too: LAN is then the only candidate there is, and a
    // LAN-only fleet must not be left with an empty dial list.
    const bothUnknown = planPeerDial({ wanIp: null, lanIp: '192.0.2.8' }, peerEndpoint({ wanIp: null }), {
      peerLanPort: 11010,
    });
    expect(bothUnknown.uris).toEqual(['udp://192.0.2.200:11010']);
  });

  test('uses the peer LAN listener port, not the forwarded WAN port', () => {
    const plan = planPeerDial({ wanIp: '198.51.100.10', lanIp: '192.0.2.8' }, peerEndpoint(), {
      peerLanPort: 11011,
    });
    expect(plan.uris[0]).toBe('udp://192.0.2.200:11011');
  });

  test('missing lanIp or unforwarded ports simply drop those candidates', () => {
    const noLan = planPeerDial({ wanIp: '203.0.113.5', lanIp: '192.0.2.8' }, peerEndpoint({ lanIp: '' }), {
      peerLanPort: 11010,
    });
    expect(noLan.uris).toEqual(['udp://198.51.100.10:11010', 'tcp://198.51.100.10:44310']);
    expect(noLan.lanSuppressed).toBeNull();

    const noTcp = planPeerDial(
      { wanIp: '198.51.100.10', lanIp: '192.0.2.8' },
      peerEndpoint({ ports: { udp: 11010, tcp: null } }),
      { peerLanPort: 11010 },
    );
    expect(noTcp.uris).toEqual(['udp://192.0.2.200:11010', 'udp://198.51.100.10:11010']);
  });
});
