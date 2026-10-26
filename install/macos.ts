// SPDX-License-Identifier: AGPL-3.0-or-later
// Installs a user node over an already working mesh. No mesh or sudo setup is changed.
// All configuration creation is owned by fleet.node_init on a short-lived loopback MCP server.
import { open, mkdir, access, unlink } from 'node:fs/promises';
import { homedir, userInfo } from 'node:os';
import { join, resolve } from 'node:path';
import { isIP } from 'node:net';
import { configDir, defaultConfig, loadConfig } from '../src/config';
import { startMcpServer } from '../src/mcp';
import { run } from '../src/util';

const xml = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }[c]!));

export async function initializeMacNode(args: Record<string, unknown>): Promise<unknown> {
  if (process.platform !== 'darwin') throw new Error('this bootstrap supports macOS only');
  if (typeof args.machine !== 'string' || !/^[A-Za-z0-9._-]{1,64}$/.test(args.machine) ||
      typeof args.meshIp !== 'string' || isIP(args.meshIp) !== 4 || args.meshIp.startsWith('127.') || args.meshIp === '0.0.0.0' ||
      typeof args.reason !== 'string' || !args.reason.trim() || args.reason.length > 1024) throw new Error('invalid machine, mesh address or reason');
  const configPath = join(configDir(), 'config.json');
  try { await access(configPath); throw new Error('configuration already exists; refusing to replace it'); }
  catch (error: any) { if (error.code !== 'ENOENT') throw error; }
  // The mesh is already running when this bootstrap is used; it only needs to know how to reach
  // it. Both values describe that existing install, so both can be given, and the defaults are the
  // project's own names rather than any one deployment's.
  if (args.easytierCliPath !== undefined && (typeof args.easytierCliPath !== 'string' || !args.easytierCliPath.startsWith('/'))) {
    throw new Error('easytierCliPath must be an absolute path');
  }
  if (args.easytierServiceName !== undefined &&
      (typeof args.easytierServiceName !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9.-]{0,127}$/.test(args.easytierServiceName))) {
    throw new Error('easytierServiceName must be a launchd label');
  }
  const cli = (args.easytierCliPath as string | undefined) ?? '/usr/local/bin/easytier-cli';
  const meshService = (args.easytierServiceName as string | undefined) ?? 'org.sukarfleet.easytier';
  await access(cli);
  const cfg = defaultConfig(args.machine);
  cfg.meshIp = args.meshIp;
  cfg.role = 'roamer';
  cfg.admin.enabled = true;
  cfg.admin.agentOrigin = 'allow';
  cfg.admin.acceptIncoming = false;
  cfg.admin.sshUser = userInfo().username;
  cfg.admin.uiAssets = false;
  cfg.notifications.os = false;
  cfg.easytier.cliPath = cli;
  cfg.easytier.serviceName = meshService;
  const app = resolve(import.meta.dir, '..');
  const home = homedir();
  const logs = join(home, 'Library', 'Logs', 'sukarfleet');
  const plist = join(home, 'Library', 'LaunchAgents', 'org.sukarfleet.node.plist');
  await mkdir(configDir(), { recursive: true, mode: 0o700 });
  await mkdir(join(home, '.ssh'), { recursive: true, mode: 0o700 });
  const key = join(home, '.ssh', 'id_sukarfleet_ed25519');
  try { await access(key); }
  catch (error: any) {
    if (error.code !== 'ENOENT') throw error;
    const result = await run(['/usr/bin/ssh-keygen', '-t', 'ed25519', '-N', '', '-f', key], { timeoutMs: 10000 });
    if (result.code !== 0) throw new Error('could not create the node SSH identity');
  }
  await mkdir(logs, { recursive: true });
  await mkdir(join(home, 'Library', 'LaunchAgents'), { recursive: true });
  const plistHandle = await open(plist, 'wx', 0o600);
  try {
    await plistHandle.writeFile(`<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0"><dict>
<key>Label</key><string>org.sukarfleet.node</string>
<key>ProgramArguments</key><array><string>${xml(process.execPath)}</string><string>run</string><string>${xml(join(app, 'src', 'node.ts'))}</string></array>
<key>WorkingDirectory</key><string>${xml(app)}</string>
<key>EnvironmentVariables</key><dict><key>PATH</key><string>${xml(join(home, '.bun', 'bin'))}:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin</string></dict>
<key>RunAtLoad</key><true/><key>KeepAlive</key><true/>
<key>StandardOutPath</key><string>${xml(join(logs, 'node.log'))}</string>
<key>StandardErrorPath</key><string>${xml(join(logs, 'node.err.log'))}</string>
</dict></plist>\n`);
  } finally { await plistHandle.close(); }
  try {
    const file = await open(configPath, 'wx', 0o600);
    try { await file.writeFile(JSON.stringify(cfg, null, 2) + '\n'); } finally { await file.close(); }
    await loadConfig(configPath);
  } catch (error) { await unlink(plist); throw error; }
  return { installed: true, machine: cfg.machine, configPath, plist, repos: [], meshUnchanged: true };
}

if (import.meta.main) {
  const server = startMcpServer({ cfg: defaultConfig('bootstrap'), listPeers: () => [], tailAudit: async () => [],
    adminRun: async () => { throw new Error('bootstrap has no admin lane'); }, adminStatus: async () => [],
    initializeNode: initializeMacNode }, { port: 0 });
  try {
    const response = await fetch(`http://127.0.0.1:${server.port}/mcp`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'fleet.node_init', arguments: JSON.parse(process.argv[2] ?? '{}') } }) });
    const result: any = await response.json();
    console.log(JSON.stringify(result));
    if (result.error || result.result?.isError) process.exitCode = 1;
  } catch (error) { console.error(String(error)); process.exitCode = 1; }
  finally { server.stop(); }
}
