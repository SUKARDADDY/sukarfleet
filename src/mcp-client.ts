// SPDX-License-Identifier: AGPL-3.0-or-later
// Supported MCP transport for hosts whose tool catalog has not refreshed after an upgrade.
// Calls tools/call, so authentication, policy, validation and auditing stay on the server.
import { readFile } from 'node:fs/promises';
import { loadConfig } from './config';

export async function callFleetTool(name: string, args: Record<string, unknown>): Promise<unknown> {
  const cfg = await loadConfig();
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  const tokenFile = (cfg.admin as typeof cfg.admin & { consoleTokenFile?: string }).consoleTokenFile;
  if (tokenFile) headers.Authorization = `Bearer ${(await readFile(tokenFile, 'utf8')).trim()}`;
  let id = 0;
  async function rpc(method: string, params: unknown): Promise<any> {
    const response = await fetch(`http://127.0.0.1:${cfg.mcpPort}/mcp`, {
      method: 'POST', headers,
      body: JSON.stringify({ jsonrpc: '2.0', id: ++id, method, params }),
      signal: AbortSignal.timeout((cfg.admin.maxRunTimeoutSec + cfg.admin.connectTimeoutSec + 30) * 1000),
    });
    if (!response.ok) throw new Error(`fleet MCP returned HTTP ${response.status}`);
    const body = await response.json() as any;
    if (body.error) throw new Error(`fleet MCP: ${body.error.message}`);
    return body.result;
  }
  await rpc('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'sukarfleet-mcp-client', version: '1' } });
  return rpc('tools/call', { name, arguments: args });
}

if (import.meta.main) {
  try {
    const name = process.argv[2];
    if (!name) throw new Error('usage: bun run src/mcp-client.ts <tool> [JSON | @arguments.json]');
    const raw = process.argv[3] ?? '{}';
    const args = JSON.parse(raw.startsWith('@') ? await readFile(raw.slice(1), 'utf8') : raw);
    const result = await callFleetTool(name, args) as { isError?: boolean };
    console.log(JSON.stringify(result));
    if (result.isError) process.exitCode = 1;
  } catch (error) {
    console.error(String(error));
    process.exitCode = 1;
  }
}
