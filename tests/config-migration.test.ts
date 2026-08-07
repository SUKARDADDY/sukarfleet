// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The exec block drops with the signed-job ceremony, and two fields that surviving code reads used
// to live inside it. Neither failure is loud:
//
//   admin.auditRepo  gates the audit union flush. Lose it and the audit log simply stops reaching
//                    the synced union file. Nothing raises; the file just stops growing.
//   mcpPort          the loopback MCP listen port -- the agent's whole way in.
//
// These tests run against the SHAPE of a real deployed config (values sanitized), because that is
// the shape the migration actually has to survive on cutover day.

import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig, persistLegacyMigration } from '../src/config';

const dirs: string[] = [];

function writeConfig(obj: unknown): string {
  const dir = mkdtempSync(join(tmpdir(), 'sukarfleet-cfg-'));
  dirs.push(dir);
  const p = join(dir, 'config.json');
  writeFileSync(p, JSON.stringify(obj, null, 2) + '\n');
  return p;
}

afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

// The shape of a real deployed config, values sanitized. Note what it carries: a full legacy exec
// block with enabled:true, and an admin block that does NOT mention auditRepo.
function deployedShape(): Record<string, unknown> {
  return {
    machine: 'alpha',
    role: 'anchor',
    meshIp: '192.0.2.1',
    nodePort: 7710,
    networkName: 'sukarfleet',
    peers: [
      {
        name: 'beta',
        meshIp: '192.0.2.2',
        nodePort: 7710,
        publicKeyJwk: { kty: 'EC', crv: 'P-256', x: 'AAAA', y: 'BBBB' },
        sshUser: 'fleet',
        sshPublicKey: 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
      },
    ],
    repos: [
      { name: 'workspace', path: '/tmp/workspace', postMerge: [['/usr/bin/true']] },
      { name: 'memory', path: '/tmp/memory' },
    ],
    unionPaths: ['sukarfleet-audit.jsonl'],
    easytier: { rpcAddr: '127.0.0.1:15888', serviceName: 'mesh.service', cliPath: '/opt/mesh/cli' },
    wan: { udpPort: 11010, tcpPort: 44310 },
    exec: { enabled: true, helperSudo: true, auditRepo: 'workspace' },
    admin: { sshUser: 'fleet', uiEnabled: true, enabled: true },
  };
}

describe('a config from the pre-extraction daemon still loads', () => {
  test('the legacy exec block does not fail validation', async () => {
    const cfg = await loadConfig(writeConfig(deployedShape()));
    expect(cfg.machine).toBe('alpha');
    expect(cfg.admin.enabled).toBe(true);
  });

  test('exec.auditRepo is migrated to admin.auditRepo', async () => {
    const cfg = await loadConfig(writeConfig(deployedShape()));
    // Without this, the audit union flush silently stops.
    expect(cfg.admin.auditRepo).toBe('workspace');
  });

  test('mcpPort falls back to its default when the legacy block never set one', async () => {
    const cfg = await loadConfig(writeConfig(deployedShape()));
    expect(cfg.mcpPort).toBe(7719);
  });

  test('exec.mcpPort is migrated to the top level when present', async () => {
    const raw = deployedShape();
    (raw.exec as Record<string, unknown>).mcpPort = 7801;
    const cfg = await loadConfig(writeConfig(raw));
    expect(cfg.mcpPort).toBe(7801);
  });

  test('the extracted daemon reads no field from the exec block itself', async () => {
    const raw = deployedShape();
    delete raw.exec;
    const cfg = await loadConfig(writeConfig(raw));
    expect(cfg.mcpPort).toBe(7719);
    expect(cfg.admin.auditRepo ?? null).toBeNull();
  });
});

describe('the new locations are authoritative', () => {
  test('admin.auditRepo wins over legacy exec.auditRepo', async () => {
    const raw = deployedShape();
    (raw.admin as Record<string, unknown>).auditRepo = 'memory';
    const cfg = await loadConfig(writeConfig(raw));
    expect(cfg.admin.auditRepo).toBe('memory');
  });

  test('top-level mcpPort wins over legacy exec.mcpPort', async () => {
    const raw = deployedShape();
    raw.mcpPort = 7900;
    (raw.exec as Record<string, unknown>).mcpPort = 7801;
    const cfg = await loadConfig(writeConfig(raw));
    expect(cfg.mcpPort).toBe(7900);
  });

  test('an explicit admin.auditRepo of null is honoured, not treated as absent', async () => {
    const raw = deployedShape();
    (raw.admin as Record<string, unknown>).auditRepo = null;
    const cfg = await loadConfig(writeConfig(raw));
    // Explicitly opting out must not silently fall back to the legacy value.
    expect(cfg.admin.auditRepo).toBeNull();
  });
});

describe('notifications.os (P5): default true, explicit false round-trips', () => {
  test('a config with no notifications key defaults os to true', async () => {
    const cfg = await loadConfig(writeConfig({ machine: 'alpha' }));
    expect(cfg.notifications.os).toBe(true);
  });

  test('an explicit notifications.os:false round-trips through loadConfig', async () => {
    const cfg = await loadConfig(writeConfig({ machine: 'alpha', notifications: { os: false } }));
    expect(cfg.notifications.os).toBe(false);
  });

  test('a real deployed-shape config (no notifications block) still defaults to true', async () => {
    const cfg = await loadConfig(writeConfig(deployedShape()));
    expect(cfg.notifications.os).toBe(true);
  });
});

describe('unknown top-level blocks survive', () => {
  test('a block the running build has never heard of does not fail the load', async () => {
    const raw = deployedShape();
    raw.somethingFromAFutureVersion = { nested: { deeply: true } };
    const cfg = await loadConfig(writeConfig(raw));
    expect(cfg.machine).toBe('alpha');
  });
});

describe('persisting the migration', () => {
  test('writes the new locations and LEAVES the legacy block in place', async () => {
    const p = writeConfig(deployedShape());
    const changed = await persistLegacyMigration(p);
    expect(changed).toBe(true);

    const after = JSON.parse(readFileSync(p, 'utf8')) as Record<string, unknown>;
    expect((after.admin as Record<string, unknown>).auditRepo).toBe('workspace');
    // Deliberately NOT deleted: an inert unknown block costs nothing, and leaving it means a
    // rollback to the pre-extraction daemon finds its config exactly as it left it.
    expect(after.exec).toBeDefined();
    expect((after.exec as Record<string, unknown>).auditRepo).toBe('workspace');
  });

  test('is idempotent -- a second run reports nothing to do', async () => {
    const p = writeConfig(deployedShape());
    expect(await persistLegacyMigration(p)).toBe(true);
    expect(await persistLegacyMigration(p)).toBe(false);
  });

  test('a config with no legacy block is left alone', async () => {
    const raw = deployedShape();
    delete raw.exec;
    const p = writeConfig(raw);
    const before = readFileSync(p, 'utf8');
    expect(await persistLegacyMigration(p)).toBe(false);
    expect(readFileSync(p, 'utf8')).toBe(before);
  });

  test('the migrated file still loads and validates', async () => {
    const p = writeConfig(deployedShape());
    await persistLegacyMigration(p);
    const cfg = await loadConfig(p);
    expect(cfg.admin.auditRepo).toBe('workspace');
    expect(cfg.mcpPort).toBe(7719);
  });
});
