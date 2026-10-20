// SPDX-License-Identifier: AGPL-3.0-or-later
import { afterEach, expect, test } from 'bun:test';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { SyncSetup } from '../src/syncsetup';
import { Syncer } from '../src/syncer';
import { defaultConfig, loadConfig, patchConfig } from '../src/config';
import { run } from '../src/util';
import { createMcpFetchHandler } from '../src/mcp';

const dirs: string[] = [];
afterEach(async () => { for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true }); });

async function harness() {
  const dir = await mkdtemp(join(tmpdir(), 'fleet-sync-setup-')); dirs.push(dir);
  const git = async (...args: string[]) => {
    const result = await run(['git', '-C', dir, ...args]);
    if (result.code !== 0) throw new Error(result.stderr);
    return result.stdout.trim();
  };
  await git('init', '-q', '-b', 'main');
  await git('config', 'user.name', 'fixture'); await git('config', 'user.email', 'fixture@example.invalid');
  await git('config', 'commit.gpgsign', 'false');
  await writeFile(join(dir, 'lesson.md'), 'original\n');
  await git('add', '.'); await git('commit', '-qm', 'base');
  const cfg = defaultConfig('alpha'); cfg.admin.enabled = true; cfg.admin.agentOrigin = 'allow';
  const configPath = join(dir, '.git', 'node-config.json'); await writeFile(configPath, JSON.stringify({ ...cfg, futureField: 'preserve' }));
  const audit: any[] = [];
  const syncer = new Syncer(cfg, { machineKey: {} as any, isClockVetted: () => false, onRepoStat: () => {}, onGithubPush: () => {}, onConflictArtifact: () => {} });
  const setup = new SyncSetup({ cfg, syncer, pairing: { mintCode: () => ({ display: '1234-5678-9ABC', expiresMs: 123 }), redeem: async () => ({ ok: true, peer: 'beta' }) as any },
    auditAppend: async (kind, detail) => { audit.push({ kind, detail }); },
    activateRepo: (repo) => { cfg.repos.push(repo); }, status: () => ({ repos: cfg.repos }),
    persist: (mutate) => patchConfig(mutate, configPath) });
  return { dir, cfg, setup, git, configPath, audit };
}

test('registration preserves dirty tracked and untracked files, raw config and upstream; no restart needed', async () => {
  const h = await harness();
  await writeFile(join(h.dir, 'lesson.md'), 'my progress\n'); await writeFile(join(h.dir, 'exercise.js'), 'const answer = 42;\n');
  await h.git('remote', 'add', 'origin', 'https://example.invalid/official.git');
  const result = await h.setup.call('fleet.repo_add', { name: 'curriculum', path: h.dir, reason: 'enable peer sync' });
  expect(result.restartRequired).toBe(false);
  expect(await h.git('branch', '--show-current')).toBe('sync/alpha');
  expect(await readFile(join(h.dir, 'lesson.md'), 'utf8')).toBe('my progress\n');
  expect(await readFile(join(h.dir, 'exercise.js'), 'utf8')).toContain('42');
  expect(await h.git('remote', 'get-url', 'origin')).toBe('https://example.invalid/official.git');
  expect((await loadConfig(h.configPath)).repos).toEqual([{ name: 'curriculum', path: h.dir, peerOnly: true }]);
  expect(JSON.parse(await readFile(h.configPath, 'utf8')).futureField).toBe('preserve');
  expect(h.cfg.repos.length).toBe(1);
  expect((await h.setup.call('fleet.repo_add', { name: 'curriculum', path: h.dir, reason: 'repeat' })).alreadyRegistered).toBe(true);
});

test('setup rejects unauthorized calls, traversal names and a nested path without changing config', async () => {
  const h = await harness(); const original = await readFile(h.configPath, 'utf8');
  h.cfg.admin.agentOrigin = 'refuse';
  await expect(h.setup.call('fleet.repo_add', { name: 'r', path: h.dir, reason: 'test' })).rejects.toThrow('agent-origin');
  h.cfg.admin.agentOrigin = 'allow';
  await expect(h.setup.call('fleet.repo_add', { name: '..', path: h.dir, reason: 'test' })).rejects.toThrow('name');
  await expect(h.setup.call('fleet.repo_add', { name: 'r', path: join(h.dir, '.git'), reason: 'test' })).rejects.toThrow();
  expect(await readFile(h.configPath, 'utf8')).toBe(original);
  expect(await h.git('branch', '--show-current')).toBe('main');
});

test('an existing sync branch at a different commit is never checked out', async () => {
  const h = await harness(); await h.git('branch', 'sync/alpha');
  await writeFile(join(h.dir, 'lesson.md'), 'new commit'); await h.git('commit', '-qam', 'another');
  await expect(h.setup.call('fleet.repo_add', { name: 'r', path: h.dir, reason: 'test' })).rejects.toThrow('differs');
  expect(await h.git('branch', '--show-current')).toBe('main');
});

test('pairing code does not enter the setup audit log', async () => {
  const h = await harness();
  const code = await h.setup.call('fleet.pair_code', { reason: 'pair Mac' });
  await h.setup.call('fleet.pair_redeem', { code: code.display, host: '192.0.2.1', port: 7710, reason: 'join fleet' });
  expect(JSON.stringify(h.audit)).not.toContain(code.display);
});

test('MCP dispatch routes management errors as tool errors and bootstrap is unavailable on a running node', async () => {
  const h = await harness();
  const handler = createMcpFetchHandler({ cfg: h.cfg, listPeers: () => [], tailAudit: async () => [], adminStatus: async () => [], adminRun: async () => { throw new Error(); }, syncSetup: h.setup });
  const call = async (name: string, args: any = {}) => {
    const response = await handler(new Request('http://127.0.0.1/mcp', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }) }));
    return (await response.json() as any).result;
  };
  expect((await call('fleet.node_init')).isError).toBe(true);
  expect((await call('fleet.repo_add', { name: 'bad/name', path: h.dir, reason: 'test' })).isError).toBe(true);
  expect((await call('fleet.sync_status')).isError).toBeUndefined();
});

test('SSH access can coexist with a full peer only when its address matches', async () => {
  const h = await harness();
  const target = { name: 'beta', host: '192.0.2.4', port: 22, user: 'operator', identityFile: '/tmp/key', knownHostsFile: '/tmp/pin', platform: 'macos' };
  await patchConfig((raw) => { raw.accessTargets = [target]; raw.peers = [{ name: 'beta', meshIp: '192.0.2.4', nodePort: 7710, publicKeyJwk: null }]; }, h.configPath);
  expect((await loadConfig(h.configPath)).accessTargets?.[0]?.name).toBe('beta');
  const before = await readFile(h.configPath, 'utf8');
  await expect(patchConfig((raw) => { (raw.peers as any[])[0].meshIp = '192.0.2.5'; }, h.configPath)).rejects.toThrow('same address');
  expect(await readFile(h.configPath, 'utf8')).toBe(before);
});
