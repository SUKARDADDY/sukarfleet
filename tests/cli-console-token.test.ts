// SPDX-License-Identifier: AGPL-3.0-or-later
//
// A machine-wide node refuses the operator routes without `Authorization: Bearer <token>`. The
// CLI loads the same config as the daemon, so when admin.consoleTokenFile is set and readable it
// must send that header on both of its HTTP paths: cmdAuditTail (its own fetch) and the shared
// adminApi client behind admin run / status / trust. These tests run the real commands against a
// server that gates with the real makeConsoleTokenCheck.

import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cmdAdminStatus, cmdAuditTail } from '../src/cli';
import { makeConsoleTokenCheck } from '../src/uiserve';

const TOKEN = 'Zt3q9-VnB1xK7mWc4RyL0hDfJ6sUaE2p';

describe('CLI console token', () => {
  let dir: string;
  let server: ReturnType<typeof Bun.serve>;
  let seen: Array<{ path: string; authorization: string | null }>;
  let saved: string | undefined;
  let out: string[];
  let err: string[];
  const restore: Array<() => void> = [];

  function writeConfig(admin: Record<string, unknown>): void {
    const cfgPath = join(dir, 'config.json');
    writeFileSync(cfgPath, JSON.stringify({ machine: 'alpha', nodePort: server.port, admin }));
    process.env.SUKARFLEET_CONFIG = cfgPath;
  }

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'sukarfleet-cli-token-'));
    writeFileSync(join(dir, 'console-token'), `${TOKEN}\n`);
    seen = [];
    const check = makeConsoleTokenCheck(join(dir, 'console-token'));
    server = Bun.serve({
      port: 0,
      hostname: '127.0.0.1',
      async fetch(req) {
        const path = new URL(req.url).pathname;
        seen.push({ path, authorization: req.headers.get('authorization') });
        if (!(await check(req))) {
          return Response.json({ error: 'console-token-required' }, { status: 401 });
        }
        if (path === '/exec/audit/tail') {
          return Response.json({
            entries: [{ v: 1, machine: 'alpha', seq: 1, tsMs: 1000, kind: 'admin.run', detail: {}, sigB64: 'sig' }],
          });
        }
        if (path === '/api/ui/admin/status') {
          return Response.json([
            {
              machine: 'alpha', self: true, laneEnabled: true, paired: true, reachable: true,
              credentialReady: true, credentialStale: false, lastAdminRunMs: null,
            },
          ]);
        }
        return Response.json({ error: 'not found' }, { status: 404 });
      },
    });
    saved = process.env.SUKARFLEET_CONFIG;
    out = [];
    err = [];
    const log = spyOn(console, 'log').mockImplementation((...a: unknown[]) => void out.push(a.join(' ')));
    const error = spyOn(console, 'error').mockImplementation((...a: unknown[]) => void err.push(a.join(' ')));
    restore.push(() => log.mockRestore(), () => error.mockRestore());
  });

  afterEach(() => {
    while (restore.length) restore.pop()!();
    void server.stop(true);
    if (saved === undefined) delete process.env.SUKARFLEET_CONFIG;
    else process.env.SUKARFLEET_CONFIG = saved;
    rmSync(dir, { recursive: true, force: true });
  });

  test('audit tail sends the bearer token named by admin.consoleTokenFile', async () => {
    writeConfig({ consoleTokenFile: join(dir, 'console-token') });
    expect(await cmdAuditTail([])).toBe(0);
    expect(seen.at(-1)).toEqual({ path: '/exec/audit/tail', authorization: `Bearer ${TOKEN}` });
    expect(out.join('\n')).toContain('alpha#1');
  });

  test('admin status sends the bearer token named by admin.consoleTokenFile', async () => {
    writeConfig({ consoleTokenFile: join(dir, 'console-token') });
    expect(await cmdAdminStatus()).toBe(0);
    expect(seen.at(-1)).toEqual({ path: '/api/ui/admin/status', authorization: `Bearer ${TOKEN}` });
    expect(out.join('\n')).toContain('alpha (self)');
  });

  test('with no consoleTokenFile neither command sends a header (a per-user node is unchanged)', async () => {
    writeConfig({});
    expect(await cmdAuditTail([])).toBe(1);
    expect(await cmdAdminStatus()).toBe(2);
    expect(seen.map((s) => s.authorization)).toEqual([null, null]);
  });

  test('an unreadable token file fails with its path and never makes the request', async () => {
    const missing = join(dir, 'no-such', 'console-token');
    writeConfig({ consoleTokenFile: missing });
    expect(await cmdAuditTail([])).toBe(2);
    expect(await cmdAdminStatus()).toBe(2);
    expect(seen).toEqual([]);
    const text = err.join('\n');
    expect(text).toContain(missing);
    expect(text).not.toContain(TOKEN);
  });
});
