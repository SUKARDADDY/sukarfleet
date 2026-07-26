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
} from '../src/endpoints';

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

  test('lanIp() returns null and logs a warning when the command fails', async () => {
    const runFn = async () => ({ code: 1, stdout: '', stderr: 'ip: command not found' });
    expect(await lanIp(runFn)).toBeNull();
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
