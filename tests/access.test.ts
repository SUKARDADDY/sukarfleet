// SPDX-License-Identifier: AGPL-3.0-or-later
import { afterEach, expect, test } from 'bun:test';
import { mkdtemp, writeFile, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AccessOnly, accessSshArgv, REMOTE_RUNNER } from '../src/access';
import { defaultConfig, loadConfig, patchConfig } from '../src/config';
import type { AccessTargetConfig, AuditEntry } from '../src/types';
import { runBytes } from '../src/util';
import { createMcpFetchHandler } from '../src/mcp';

const dirs: string[] = [];
afterEach(async () => { for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true }); });
const decode = (r: any) => JSON.parse(r.content.find((c: any) => c.type === 'text').text);

async function harness() {
  const dir = await mkdtemp(join(tmpdir(), 'fleet-access-')); dirs.push(dir);
  const cfg = defaultConfig('alpha');
  cfg.admin.enabled = true; cfg.admin.agentOrigin = 'allow';
  const target: AccessTargetConfig = { name: 'beta', host: '192.0.2.4', port: 22, user: 'operator',
    identityFile: join(dir, 'identity'), knownHostsFile: join(dir, 'known_hosts'), platform: 'macos' };
  await writeFile(target.identityFile, 'fake-private-fixture', { mode: 0o600 });
  await writeFile(target.knownHostsFile, 'fake-hostkey-fixture', { mode: 0o600 });
  const configPath = join(dir, 'config.json');
  cfg.accessTargets = [target];
  await writeFile(configPath, JSON.stringify(cfg));
  const calls: { argv: string[]; opts: any }[] = [];
  const audit: { kind: string; detail: any }[] = [];
  let pinCode = 0, runCode = 0, failAudit = '', bytes: Uint8Array = Buffer.from('ok'), truncated = false;
  const auditAppend = async (kind: string, detail: any): Promise<AuditEntry> => {
    if (kind === failAudit) throw new Error('audit unavailable');
    audit.push({ kind, detail }); return {} as AuditEntry;
  };
  const access = new AccessOnly({ cfg, auditAppend,
    persist: (mutate) => patchConfig(mutate, configPath),
    runner: async (argv, opts) => {
      calls.push({ argv, opts });
      return { code: argv[0] === 'ssh-keygen' ? pinCode : runCode, stdout: bytes, stderr: '', truncated };
    },
  });
  return { cfg, target, access, calls, audit, configPath, dir, auditAppend,
    pinFailure: () => { pinCode = 1; }, code: (n: number) => { runCode = n; },
    bytes: (b: Buffer, cut = false) => { bytes = b; truncated = cut; }, failAudit: (s: string) => { failAudit = s; } };
}
const request = { machine: 'beta', argv: ['/usr/bin/printf', '%s', `spaces 'quotes' $HOME ; touch /bad`], reason: 'verify native access' };

test('legacy config and access registration preserve peers, repositories and unknown keys', async () => {
  const h = await harness();
  const raw = JSON.parse(await readFile(h.configPath, 'utf8')); delete raw.accessTargets; raw.futureField = 'keep';
  await writeFile(h.configPath, JSON.stringify(raw));
  const result = await h.access.call('fleet.access_register', { machine: h.target.name, ...h.target, reason: 'register' });
  expect(result.isError).toBeUndefined();
  const saved = JSON.parse(await readFile(h.configPath, 'utf8'));
  expect(saved.accessTargets).toEqual([h.target]); expect(saved.futureField).toBe('keep');
  expect(saved.peers).toEqual(raw.peers); expect(saved.repos).toEqual(raw.repos);
  expect(h.calls.every((c) => c.argv[0] === 'ssh-keygen')).toBe(true);
});

test('registration cannot silently replace trust and is idempotent for the same target', async () => {
  const h = await harness();
  const args = { machine: h.target.name, ...h.target, reason: 'register' };
  expect((await h.access.call('fleet.access_register', args)).isError).toBeUndefined();
  expect((await h.access.call('fleet.access_register', { ...args, user: 'another' })).isError).toBe(true);
  expect((await loadConfig(h.configPath)).accessTargets?.[0]?.user).toBe('operator');
  expect((await h.access.call('fleet.access_register', { ...args, user: 'another', replace: true })).isError).toBeUndefined();
});

test('a native broker command is persisted explicitly without changing sync configuration', async () => {
  const h = await harness();
  const screenshotCommand = ['/opt/native-capture', '--output', '{output}'];
  const result = await h.access.call('fleet.access_register', { machine: h.target.name, ...h.target,
    screenshotCommand, replace: true, reason: 'use a native desktop permission broker' });
  expect(result.isError).toBeUndefined();
  expect((await loadConfig(h.configPath)).accessTargets?.[0]?.screenshotCommand).toEqual(screenshotCommand);
  expect(h.cfg.peers).toEqual([]); expect(h.cfg.repos).toEqual([]);
});

test('disabled lane, agent refusal, missing reason, malformed argv and unknown targets never connect', async () => {
  const h = await harness();
  h.cfg.admin.enabled = false; expect((await h.access.call('fleet.run', request)).isError).toBe(true);
  h.cfg.admin.enabled = true; h.cfg.admin.agentOrigin = 'refuse'; expect((await h.access.call('fleet.run', request)).isError).toBe(true);
  h.cfg.admin.agentOrigin = 'allow';
  for (const args of [{ ...request, reason: '' }, { ...request, argv: ['echo', '\0'] },
    { ...request, machine: 'unknown' }, { ...request, timeoutSec: 1.5 }, { ...request, asRoot: 'yes' }]) {
    expect((await h.access.call('fleet.run', args)).isError).toBe(true);
  }
  expect(h.calls).toHaveLength(0);
  expect(decode(await h.access.call('fleet.access_list', {})).machines[0].sync).toBe(false);
});

test('missing pin and unsafe private-key permissions prevent SSH', async () => {
  const h = await harness(); h.pinFailure();
  expect((await h.access.call('fleet.run', request)).isError).toBe(true);
  expect(h.calls.some((c) => c.argv[0] === 'ssh')).toBe(false);
  await writeFile(h.target.identityFile, 'key');
  await import('node:fs/promises').then((fs) => fs.chmod(h.target.identityFile, 0o644));
  expect((await h.access.call('fleet.run', request)).isError).toBe(true);
});

test('run pins the host, ignores ambient SSH configuration, audits requests, bounds output and quotes argv', async () => {
  const h = await harness();
  const result = decode(await h.access.call('fleet.run', request)); expect(result.stdout).toBe('ok');
  const call = h.calls.find((c) => c.argv[0] === 'ssh')!;
  expect(call.argv).toContain('StrictHostKeyChecking=yes'); expect(call.argv).toContain('IdentityAgent=none');
  expect(call.argv.slice(0, 3)).toEqual(['ssh', '-F', 'none']);
  expect(call.opts.maxCaptureBytes).toBe(h.cfg.admin.maxOutputBytes);
  expect(h.audit.map((a) => a.kind)).toEqual(['access-run-requested', 'access-run-completed']);
  expect(h.audit[0].detail.clientLabel).toBe('mcp');
  // Execute the actual remote argv encoding locally. Injection-looking text must remain data.
  const encoded = accessSshArgv(h.target, 2, request.argv, 1).at(-1)!;
  const local = await runBytes(['/bin/sh', '-c', encoded], { timeoutMs: 5000 });
  expect(local.code).toBe(0); expect(Buffer.from(local.stdout).toString()).toBe(request.argv[2]);
});

test('sudo is noninteractive; SSH loss reports unknown completion and never retries', async () => {
  const h = await harness(); h.code(255);
  const result = await h.access.call('fleet.run', { ...request, asRoot: true });
  expect(result.isError).toBe(true); expect(decode(result).exitCode).toBeNull();
  expect(h.calls.filter((c) => c.argv[0] === 'ssh')).toHaveLength(1);
  expect(h.calls.at(-1)!.argv.at(-1)).toContain("'sudo' '-n' '--'");
});

test('OpenSSH uses only the configured identity, including percent paths, without default fallback', async () => {
  const h = await harness();
  const path = join(h.dir, 'with%percent and spaces');
  await writeFile(path, 'fake-private-fixture', { mode: 0o600 });
  const argv = accessSshArgv({ ...h.target, identityFile: path }, 2, ['true'], 1);
  const config = await runBytes(['ssh', '-G', ...argv.slice(1)], { timeoutMs: 5000 });
  expect(config.code).toBe(0);
  expect(config.stderr).not.toContain('not accessible');
  const identities = Buffer.from(config.stdout).toString().split('\n').filter((s) => s.startsWith('identityfile '));
  expect(identities).toEqual(['identityfile none', `identityfile ${path.replace(/%/g, '%%')}`]);
  // Removing the key cannot cause default identities to enter the explicit configuration.
  await rm(path);
  const missing = await runBytes(['ssh', '-G', ...argv.slice(1)], { timeoutMs: 5000 });
  expect(Buffer.from(missing.stdout).toString().split('\n').filter((s) => s.startsWith('identityfile '))).toEqual(identities);
});

test('a real local transport timeout returns unknown completion, while a remote exit 124 stays an exit code', async () => {
  const h = await harness();
  const access = new AccessOnly({ cfg: h.cfg, auditAppend: h.auditAppend, runner: async (argv) => {
    if (argv[0] === 'ssh-keygen') return { code: 0, stdout: new Uint8Array(), stderr: '' };
    return runBytes(['/bin/sh', '-c', 'exec sleep 5'], { timeoutMs: 20, killGraceMs: 20 });
  } });
  const result = await access.call('fleet.run', request);
  expect(result.isError).toBe(true); expect(decode(result).exitCode).toBeNull();
  expect(decode(result).message).toContain('completion is unknown');
  expect(h.audit.at(-1)?.detail.exitCode).toBeNull();
  h.code(124);
  const remote = await h.access.call('fleet.run', request);
  expect(remote.isError).toBeUndefined(); expect(decode(remote).exitCode).toBe(124);
});

test('quote-expanded commands exceeding the subprocess bound are refused before any process or request record', async () => {
  const h = await harness();
  const argv = ['printf', '%s', "'".repeat(60000)];
  expect(Buffer.byteLength(JSON.stringify(argv))).toBeLessThan(65536);
  const result = await h.access.call('fleet.run', { ...request, argv });
  expect(result.isError).toBe(true); expect(decode(result).error).toContain('after shell quoting');
  expect(h.calls).toHaveLength(0);
  expect(h.audit.some((a) => a.kind === 'access-run-requested')).toBe(false);
});

test('rate limit is shared by access mutations and commands', async () => {
  const h = await harness(); h.cfg.admin.ratePerMin = 1;
  expect((await h.access.call('fleet.run', request)).isError).toBeUndefined();
  const before = h.calls.length;
  expect((await h.access.call('fleet.run', request)).isError).toBe(true);
  expect(h.calls.length).toBe(before);
});

test('audit failure before dispatch prevents execution; completion failure retains the actual result', async () => {
  const h = await harness(); h.failAudit('access-run-requested');
  expect((await h.access.call('fleet.run', request)).isError).toBe(true);
  expect(h.calls.some((c) => c.argv[0] === 'ssh')).toBe(false);
  h.failAudit('access-run-completed');
  const result = decode(await h.access.call('fleet.run', request));
  expect(result.exitCode).toBe(0); expect(result.auditRecorded).toBe(false);
});

test('screenshots return image content through the actual MCP handler; failed or truncated captures do not', async () => {
  const h = await harness();
  h.bytes(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aZbkAAAAASUVORK5CYII=', 'base64'));
  const handler = createMcpFetchHandler({ cfg: h.cfg, listPeers: () => [], tailAudit: async () => [],
    adminRun: async () => { throw new Error('unexpected admin call'); }, adminStatus: async () => [], access: h.access });
  const response = await handler(new Request('http://127.0.0.1:7719/mcp', { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: {
      name: 'fleet.screenshot', arguments: { machine: 'beta', reason: 'inspect desktop' } } }) }));
  const body = await response.json() as any;
  expect(body.result.content[1].type).toBe('image'); expect(body.result.content[1].mimeType).toBe('image/png');
  h.bytes(Buffer.from('not an image'));
  expect((await h.access.call('fleet.screenshot', { machine: 'beta', reason: 'inspect' })).isError).toBe(true);
  h.bytes(Buffer.from('89504e470d0a1a0a', 'hex'), true);
  expect((await h.access.call('fleet.screenshot', { machine: 'beta', reason: 'inspect' })).isError).toBe(true);
});

test('config rejects duplicate/full-node names and unsafe endpoint input before writing', async () => {
  const h = await harness(); const before = await readFile(h.configPath, 'utf8');
  for (const change of [{ host: '-oProxyCommand=bad' }, { user: 'x;bad' }, { name: 'alpha' }, { port: 65536 },
    { screenshotCommand: ['echo'] }, { screenshotCommand: ['echo', '{output}', '\0'] }]) {
    await expect(patchConfig((raw) => { raw.accessTargets = [{ ...h.target, ...change }]; }, h.configPath)).rejects.toThrow();
    expect(await readFile(h.configPath, 'utf8')).toBe(before);
  }
});

test('remote deadline kills descendants and preserves ordinary exit codes', async () => {
  const h = await harness(); const marker = join(h.dir, 'escaped');
  const result = await runBytes(['/usr/bin/perl', '-e', REMOTE_RUNNER, '--', '1', '/bin/sh', '-c',
    `(/bin/sleep 2; /usr/bin/touch '${marker}') & wait`], { timeoutMs: 5000 });
  expect(result.code).toBe(124);
  await Bun.sleep(1200); expect(await Bun.file(marker).exists()).toBe(false);
  const failure = await runBytes(['/usr/bin/perl', '-e', REMOTE_RUNNER, '--', '2', '/bin/sh', '-c', 'exit 7']);
  expect(failure.code).toBe(7);
});
