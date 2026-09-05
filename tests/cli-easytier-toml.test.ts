// SPDX-License-Identifier: AGPL-3.0-or-later
//
// `sukarfleet-cli easytier-toml` is the seam install/install-elevated.sh uses so
// the elevated stage does not re-implement the EasyTier TOML layout in bash. The
// one thing worth pinning is therefore not the bytes -- transport.test.ts owns
// those -- but that the CLI produces EXACTLY what the generator produces. A CLI
// that quietly diverged (a dropped listener, a network name taken from the wrong
// place) would write a TOML that starts a mesh joining nothing, which looks
// installed and is not.
//
// Every address here is from 192.0.2.0/24 (TEST-NET-1), which is reserved for
// documentation.

import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cmdEasytierToml, parseEasytierTomlArgs, renderEasytierToml } from '../src/cli';
import { defaultConfig } from '../src/config';
import { generateEasytierToml } from '../src/transport';

const FIXTURE = {
  secret: 'a-fixture-mesh-secret',
  meshIp: '192.0.2.3',
  hostname: 'alpha',
  networkName: 'sukarfleet',
  listeners: ['tcp://0.0.0.0:11010', 'udp://0.0.0.0:11010'],
  peers: ['tcp://192.0.2.4:11010'],
  rpcAddr: '127.0.0.1:15888',
};

function argv(): string[] {
  return [
    `--secret-file=/dev/null`,
    `--mesh-ip=${FIXTURE.meshIp}`,
    `--hostname=${FIXTURE.hostname}`,
    `--network-name=${FIXTURE.networkName}`,
    ...FIXTURE.listeners.map((l) => `--listener=${l}`),
    ...FIXTURE.peers.map((p) => `--peer=${p}`),
    `--rpc-addr=${FIXTURE.rpcAddr}`,
  ];
}

describe('easytier-toml argument parsing', () => {
  test('every flag lands where it belongs, and repeats accumulate', () => {
    const parsed = parseEasytierTomlArgs(argv());
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value.meshIp).toBe(FIXTURE.meshIp);
    expect(parsed.value.hostname).toBe(FIXTURE.hostname);
    expect(parsed.value.networkName).toBe(FIXTURE.networkName);
    expect(parsed.value.listeners).toEqual(FIXTURE.listeners);
    expect(parsed.value.peers).toEqual(FIXTURE.peers);
    expect(parsed.value.rpcAddr).toBe(FIXTURE.rpcAddr);
  });

  test('listeners default to the pair the installers build', () => {
    const parsed = parseEasytierTomlArgs(['--secret-file=/x', '--mesh-ip=192.0.2.3', '--hostname=alpha']);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value.listeners).toEqual(['tcp://0.0.0.0:11010', 'udp://0.0.0.0:11010']);
  });

  test.each([
    [['--mesh-ip=192.0.2.3', '--hostname=alpha'], '--secret-file is required'],
    [['--secret-file=/x', '--hostname=alpha'], '--mesh-ip is required'],
    [['--secret-file=/x', '--mesh-ip=192.0.2.3'], '--hostname is required'],
    [['--secret-file=/x', '--mesh-ip=192.0.2.3', '--hostname=alpha', '--nope=1'], 'unknown argument --nope'],
    // A typo'd flag with no '=' would otherwise be swallowed as a positional.
    [['--secret-file=/x', '--mesh-ip=192.0.2.3', '--hostname=alpha', '--listener'], '--listener needs a value'],
  ])('refuses %p', (args, message) => {
    const parsed = parseEasytierTomlArgs(args as string[]);
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.message).toContain(message);
  });
});

describe('easytier-toml output', () => {
  test('is byte-identical to generateEasytierToml for the same inputs', () => {
    const parsed = parseEasytierTomlArgs(argv());
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;

    const cfg = defaultConfig(FIXTURE.hostname);
    cfg.networkName = FIXTURE.networkName;
    cfg.easytier.rpcAddr = FIXTURE.rpcAddr;
    const direct = generateEasytierToml(cfg, {
      secret: FIXTURE.secret,
      listeners: FIXTURE.listeners,
      peerUris: FIXTURE.peers,
      hostname: FIXTURE.hostname,
      ipv4: FIXTURE.meshIp,
    });

    expect(renderEasytierToml(parsed.value, FIXTURE.secret)).toBe(direct);
  });

  test('the network name comes from --network-name, not from any config on disk', () => {
    const parsed = parseEasytierTomlArgs([
      '--secret-file=/x',
      '--mesh-ip=192.0.2.3',
      '--hostname=alpha',
      '--network-name=other-fleet',
    ]);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(renderEasytierToml(parsed.value, FIXTURE.secret)).toContain('network_name = "other-fleet"');
  });
});

describe('easytier-toml reads the secret from a file, never from argv', () => {
  test('a staged file is read, trimmed, and emitted into the TOML', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'sukarfleet-toml-'));
    const secretFile = join(dir, 'staged-secret');
    writeFileSync(secretFile, `${FIXTURE.secret}\n`, { mode: 0o600 });

    const chunks: string[] = [];
    const realWrite = process.stdout.write.bind(process.stdout);
    // Narrowed to the one call shape cmdEasytierToml uses: a single string.
    process.stdout.write = ((chunk: unknown) => {
      chunks.push(String(chunk));
      return true;
    }) as typeof process.stdout.write;
    let code: number;
    try {
      code = await cmdEasytierToml([
        `--secret-file=${secretFile}`,
        `--mesh-ip=${FIXTURE.meshIp}`,
        `--hostname=${FIXTURE.hostname}`,
      ]);
    } finally {
      process.stdout.write = realWrite;
      rmSync(dir, { recursive: true, force: true });
    }

    expect(code).toBe(0);
    const out = chunks.join('');
    expect(out).toContain(`network_secret = "${FIXTURE.secret}"`);
    expect(out).toContain(`ipv4 = "${FIXTURE.meshIp}"`);
    // rpc_portal is a unit CLI flag, not a file key. If it ever appears here the
    // service and the file would disagree about the port.
    expect(out).not.toContain('rpc_portal =');
  });

  test('an empty secret file is refused rather than written as an empty secret', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'sukarfleet-toml-'));
    const secretFile = join(dir, 'staged-secret');
    writeFileSync(secretFile, '   \n', { mode: 0o600 });
    try {
      expect(
        await cmdEasytierToml([`--secret-file=${secretFile}`, '--mesh-ip=192.0.2.3', '--hostname=alpha']),
      ).toBe(2);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('a missing secret file is refused', async () => {
    expect(
      await cmdEasytierToml(['--secret-file=/nonexistent/staged-secret', '--mesh-ip=192.0.2.3', '--hostname=alpha']),
    ).toBe(2);
  });
});
