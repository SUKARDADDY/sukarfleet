// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The agent-origin switch: what survived of the signed-job ceremony.
//
// That machinery existed to answer one question -- can an agent reach root without a human present?
// -- and the admin lane never asked it. `requestedBy.kind` was stamped on every call by both the
// MCP surface and the GUI, written into the audit log, and then ignored: sshadmin treated the two
// identically and both reached root.
//
// These tests are the enforcement. They are the difference between a SECURITY.md that has to say
// "when the admin lane is on, the agent can become root on every paired machine, unattended" and
// one that says "the agent cannot use the admin lane unless you separately allow it".

import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defaultConfig, loadConfig, persistLegacyMigration } from '../src/config';
import { SshAdmin } from '../src/sshadmin';
import type { AdminRunRequest, AuditEntry, FleetConfig } from '../src/types';

const dirs: string[] = [];
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), 'sukarfleet-origin-'));
  dirs.push(d);
  return d;
}

function cfgWith(agentOrigin: 'refuse' | 'allow'): FleetConfig {
  const dir = tmp();
  const base = defaultConfig('alpha');
  return {
    ...base,
    machine: 'alpha',
    meshIp: '198.51.100.1',
    admin: {
      ...base.admin,
      enabled: true,
      agentOrigin,
      sshUser: 'fleetuser',
      keyPath: join(dir, 'key'),
      knownHostsPath: join(dir, 'known_hosts'),
      authorizedKeysPath: join(dir, 'authorized_keys'),
      secretsDir: join(dir, 'secrets'),
    },
  };
}

function harness(cfg: FleetConfig): { admin: SshAdmin; audits: { kind: string; detail: Record<string, unknown> }[] } {
  const audits: { kind: string; detail: Record<string, unknown> }[] = [];
  const admin = new SshAdmin({
    cfg,
    auditAppend: async (kind, detail) => {
      audits.push({ kind, detail });
      return { v: 1, machine: cfg.machine, seq: audits.length, tsMs: 0, kind, detail, sigB64: '' } as AuditEntry;
    },
    peerView: () => null,
    now: () => 1_700_000_000_000,
    // Any dial reaching this runner means the gate let the request through.
    runner: async () => {
      throw new Error('the gate let an agent-origin request reach the transport');
    },
  });
  return { admin, audits };
}

function req(kind: 'agent' | 'operator'): AdminRunRequest {
  return { machine: 'alpha', argv: ['id'], reason: 'origin gate test', requestedBy: { kind } };
}

describe('agentOrigin: refuse', () => {
  test('an agent-origin run is refused and never reaches the transport', async () => {
    const { admin } = harness(cfgWith('refuse'));
    const res = await admin.runAdmin(req('agent'));
    expect(res.refusal).toBe('agent-origin-refused');
    expect(res.exitCode).toBeNull();
    expect(res.ok).toBe(false);
  });

  test('the refusal is AUDITED -- an agent reaching for root is the event worth keeping', async () => {
    const { admin, audits } = harness(cfgWith('refuse'));
    await admin.runAdmin(req('agent'));
    const refusals = audits.filter((a) => a.detail.refusal === 'agent-origin-refused');
    expect(refusals).toHaveLength(1);
    // The full argv is recorded: a truncated argv makes the log useless as forensics.
    expect(refusals[0]!.detail.argv).toEqual(['id']);
    expect(refusals[0]!.detail.requestedBy).toEqual({ kind: 'agent' });
  });

  test('an operator-origin run is NOT refused by this gate', async () => {
    const { admin } = harness(cfgWith('refuse'));
    const res = await admin.runAdmin(req('operator'));
    // It fails for an unrelated reason (there is no real transport here), but it must not be
    // turned away by the origin gate.
    expect(res.refusal).not.toBe('agent-origin-refused');
  });

  test('refusing costs the caller no rate-limit budget', async () => {
    const cfg = cfgWith('refuse');
    cfg.admin.ratePerMin = 2;
    const { admin } = harness(cfg);
    for (let i = 0; i < 5; i++) {
      const res = await admin.runAdmin(req('agent'));
      // Never 'rate-limited': a call that was never going to run must not consume the budget an
      // operator would otherwise have.
      expect(res.refusal).toBe('agent-origin-refused');
    }
  });
});

describe('agentOrigin: allow', () => {
  test('an agent-origin run passes the gate', async () => {
    const { admin } = harness(cfgWith('allow'));
    const res = await admin.runAdmin(req('agent'));
    expect(res.refusal).not.toBe('agent-origin-refused');
  });
});

describe('the default is fail-closed for a fresh install', () => {
  test('defaultConfig refuses agent-origin runs', () => {
    expect(defaultConfig('alpha').admin.agentOrigin).toBe('refuse');
  });

  test('an unknown value is rejected at load rather than silently coerced', async () => {
    const dir = tmp();
    const p = join(dir, 'config.json');
    writeFileSync(
      p,
      JSON.stringify({ machine: 'alpha', admin: { agentOrigin: 'confirm' } }, null, 2),
    );
    // 'confirm' is the planned upgrade and is deliberately not implemented. Accepting it here
    // would give an operator a switch that reads as a restriction and behaves as none.
    await expect(loadConfig(p)).rejects.toThrow(/agentOrigin/);
  });
});

describe('upgrading an existing deployment does not silently change behaviour', () => {
  test('a config carrying the legacy exec block is migrated to an EXPLICIT allow', async () => {
    const dir = tmp();
    const p = join(dir, 'config.json');
    writeFileSync(
      p,
      JSON.stringify(
        {
          machine: 'alpha',
          role: 'anchor',
          meshIp: '198.51.100.1',
          nodePort: 7710,
          networkName: 'sukarfleet',
          peers: [],
          repos: [],
          unionPaths: [],
          easytier: { rpcAddr: '127.0.0.1:15888', serviceName: 'mesh.service', cliPath: '/opt/mesh/cli' },
          wan: { udpPort: null, tcpPort: null },
          exec: { enabled: true, auditRepo: null },
          admin: { enabled: true, sshUser: 'fleetuser' },
        },
        null,
        2,
      ),
    );
    await persistLegacyMigration(p);
    const cfg = await loadConfig(p);
    // On that deployment an agent could already drive the lane. Flipping it to 'refuse' on upgrade
    // would break working automation mid-cutover; the value is written into the file explicitly so
    // it is visible rather than implied.
    expect(cfg.admin.agentOrigin).toBe('allow');
  });

  test('a fresh config (no legacy block) keeps the fail-closed default', async () => {
    const dir = tmp();
    const p = join(dir, 'config.json');
    writeFileSync(p, JSON.stringify({ machine: 'alpha', admin: { enabled: true } }, null, 2));
    await persistLegacyMigration(p);
    expect((await loadConfig(p)).admin.agentOrigin).toBe('refuse');
  });
});
