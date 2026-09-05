#!/usr/bin/env bun
// SPDX-License-Identifier: AGPL-3.0-or-later
// sukarfleet CLI. Dependency-free; talks to the local node's loopback HTTP API only.
//
// The exact JSON shape of GET /status beyond "self + PeerView[] + health/alarm state"
// (pinned contract) is owned by the node lane and not fully specified. Parsing below is
// defensive: unknown/missing fields degrade gracefully rather than throwing, so this CLI
// keeps working across reasonable variations in node.ts's actual response shape.

import { closeSync, openSync } from 'node:fs';
import { chmod, open, rename, stat } from 'node:fs/promises';
import { randomBytes, randomUUID } from 'node:crypto';
import { dirname, join } from 'node:path';
import { isatty, ReadStream as TtyReadStream } from 'node:tty';
import { AuditLog } from './audit';
import { defaultConfig, loadConfig, stateDir } from './config';
import { loadOrCreateMachineKey } from './keys';
import { SshAdmin } from './sshadmin';
import { generateEasytierToml } from './transport';
import type {
  AdminRunView,
  AdminStatusEntry,
  AuditEntry,
  ExecLocalResponse,
  FleetConfig,
  MachineKey,
  PeerView,
  PresenceRepoStat,
} from './types';
import { ensureDir, log, nowMs, readJsonFile } from './util';
// The admin lane's refusal copy lives in mcp.ts so the two agent-facing surfaces (MCP tools and
// this CLI) cannot drift apart on what an operator is told to go and fix. Importing it costs
// nothing at runtime: mcp.ts binds no port until startMcpServer is called.
import { adminRefusalAdvice } from './mcp';

const ANSI = {
  reset: '\x1b[0m',
  green: '\x1b[32m',
  gray: '\x1b[90m',
  yellow: '\x1b[33m',
} as const;

function colorize(enabled: boolean, code: string, text: string): string {
  return enabled ? `${code}${text}${ANSI.reset}` : text;
}

function isColorEnabled(): boolean {
  if (process.env.NO_COLOR) return false;
  return Boolean(process.stdout.isTTY);
}

export function humanizeAge(ms: number | null, nowMsVal: number): string {
  if (ms === null) return 'never';
  const deltaMs = nowMsVal - ms;
  if (deltaMs < 1000) return 'now';
  const sec = Math.floor(deltaMs / 1000);
  if (sec < 60) return `${sec}s`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m`;
  const hr = Math.floor(min / 60);
  const remMin = min % 60;
  if (hr < 24) return remMin > 0 ? `${hr}h ${remMin}m` : `${hr}h`;
  const days = Math.floor(hr / 24);
  return `${days}d`;
}

function indent(text: string, prefix: string): string {
  return text
    .split('\n')
    .map((l) => prefix + l)
    .join('\n');
}

function newestSyncOkMs(repos: Record<string, PresenceRepoStat> | undefined | null): number | null {
  if (!repos) return null;
  let max: number | null = null;
  for (const stat of Object.values(repos)) {
    if (stat && typeof stat.lastSyncOkMs === 'number') {
      if (max === null || stat.lastSyncOkMs > max) max = stat.lastSyncOkMs;
    }
  }
  return max;
}

// --- best-effort /status response shape (see header note) ---
//
// Mirrors node.ts's actual GET /status producer: machine/role/clockVetted/transport are
// top-level fields, `self` nests only {repos, githubPushOkMs}, and `health` is node.ts's
// (awaited) Health#getState() snapshot -- {faults, digestDate} -- not an `alarms` array.

interface RawSelfRepos {
  repos?: Record<string, PresenceRepoStat>;
  githubPushOkMs?: Record<string, number | null>;
  flags?: string[];
}

interface RawFault {
  key?: string;
  faultClass?: string;
  message?: string;
  urgency?: string;
  firstSeenMs?: number;
  lastNotifiedMs?: number;
}

interface RawHealth {
  faults?: RawFault[];
  digestDate?: string | null;
}

interface RawStatusResponse {
  machine?: string;
  role?: string;
  clockVetted?: boolean;
  transport?: unknown;
  self?: RawSelfRepos;
  peers?: PeerView[];
  health?: RawHealth;
}

// Flattened view combining the top-level self fields with the nested repo/push stats, so the
// pure render functions below don't need to know where node.ts happens to place each field.
interface SelfView {
  machine?: string;
  role?: string;
  clockVetted?: boolean;
  transport?: unknown;
  repos?: Record<string, PresenceRepoStat>;
  githubPushOkMs?: Record<string, number | null>;
  flags?: string[];
}

function buildSelfView(raw: RawStatusResponse): SelfView {
  return {
    machine: raw.machine,
    role: raw.role,
    clockVetted: raw.clockVetted,
    transport: raw.transport,
    repos: raw.self?.repos,
    githubPushOkMs: raw.self?.githubPushOkMs,
    flags: raw.self?.flags,
  };
}

function extractAlarms(raw: RawStatusResponse): RawFault[] {
  if (raw.health && Array.isArray(raw.health.faults)) return raw.health.faults;
  return [];
}

async function fetchStatus(nodePort: number): Promise<RawStatusResponse | null> {
  let res: Response;
  try {
    res = await fetch(`http://127.0.0.1:${nodePort}/status`);
  } catch {
    return null;
  }
  if (!res.ok) {
    throw new Error(`node returned HTTP ${res.status} for /status`);
  }
  return (await res.json()) as RawStatusResponse;
}

interface CliDefaults {
  nodePort: number;
  syncStaleMin: number;
}

async function loadCliConfig(): Promise<CliDefaults> {
  try {
    const cfg = await loadConfig();
    return { nodePort: cfg.nodePort, syncStaleMin: cfg.thresholds.syncStaleMin };
  } catch {
    return { nodePort: 7710, syncStaleMin: 30 };
  }
}

// --- pure rendering ---

interface FleetRow {
  machine: string;
  online: boolean;
  warn: boolean;
  syncedText: string;
  lastSeenText: string;
}

export function buildSelfRow(self: SelfView, nowMsVal: number, syncStaleMs: number): FleetRow {
  const machine = typeof self.machine === 'string' && self.machine ? self.machine : 'self';
  const newest = newestSyncOkMs(self.repos);
  const ageMs = newest === null ? null : nowMsVal - newest;
  const stale = newest === null || (ageMs !== null && ageMs > syncStaleMs);
  return {
    machine,
    online: true,
    warn: stale,
    syncedText: humanizeAge(newest, nowMsVal) + (stale ? ' (stale)' : ''),
    lastSeenText: 'now',
  };
}

export function buildPeerRow(p: PeerView, nowMsVal: number): FleetRow {
  const repos = p.lastEnvelope?.payload?.repos;
  const newest = newestSyncOkMs(repos);
  return {
    machine: p.name,
    online: p.online,
    warn: p.online && p.syncStale,
    syncedText: humanizeAge(newest, nowMsVal) + (p.syncStale ? ' (stale)' : ''),
    lastSeenText: humanizeAge(p.lastSeenMs, nowMsVal),
  };
}

function rowStatusText(r: FleetRow): string {
  return r.online ? 'online' : 'offline';
}

function rowStatusColor(r: FleetRow): string {
  if (!r.online) return ANSI.gray;
  return r.warn ? ANSI.yellow : ANSI.green;
}

export function renderTable(rows: FleetRow[], colorEnabled: boolean): string {
  const headers = ['MACHINE', 'STATUS', 'SYNCED', 'LAST SEEN'];
  const statusTexts = rows.map(rowStatusText);
  const widths = [
    Math.max(headers[0]!.length, ...rows.map((r) => r.machine.length)),
    Math.max(headers[1]!.length, ...statusTexts.map((s) => s.length)),
    Math.max(headers[2]!.length, ...rows.map((r) => r.syncedText.length)),
    Math.max(headers[3]!.length, ...rows.map((r) => r.lastSeenText.length)),
  ];
  const lines: string[] = [headers.map((h, i) => h.padEnd(widths[i]!)).join('  ')];
  rows.forEach((r, idx) => {
    const statusCell = colorize(colorEnabled, rowStatusColor(r), statusTexts[idx]!.padEnd(widths[1]!));
    lines.push(
      [
        r.machine.padEnd(widths[0]!),
        statusCell,
        r.syncedText.padEnd(widths[2]!),
        r.lastSeenText.padEnd(widths[3]!),
      ].join('  '),
    );
  });
  return lines.join('\n');
}

// `alarms` here are health.getState().faults (see RawFault) -- each fault's message already
// names the affected repo/peer, so there is no separate machine field to prefix.
export function buildAlarmLines(alarms: RawFault[], nowMsVal: number, colorEnabled: boolean): string[] {
  if (alarms.length === 0) {
    return [colorize(colorEnabled, ANSI.green, 'No active alarms.')];
  }
  return alarms.map((a) => {
    const msg = typeof a.message === 'string' && a.message ? a.message : JSON.stringify(a);
    const since = typeof a.firstSeenMs === 'number' ? ` (since ${humanizeAge(a.firstSeenMs, nowMsVal)})` : '';
    return colorize(colorEnabled, ANSI.yellow, `- ${msg}${since}`);
  });
}

export function buildSelfReport(self: SelfView, nowMsVal: number): string[] {
  const lines: string[] = [];
  lines.push(`Machine: ${self.machine ?? 'unknown'}`);
  if (typeof self.role === 'string') lines.push(`Role: ${self.role}`);
  lines.push(`Clock vetted: ${self.clockVetted === undefined ? 'unknown' : self.clockVetted ? 'yes' : 'no'}`);
  lines.push('Transport:');
  lines.push(self.transport === undefined ? '  unknown' : indent(JSON.stringify(self.transport, null, 2), '  '));
  lines.push('Repos:');
  const repos = self.repos ?? {};
  const names = Object.keys(repos).sort();
  if (names.length === 0) {
    lines.push('  (none configured)');
  }
  for (const name of names) {
    const stat = repos[name]!;
    lines.push(`  ${name}`);
    lines.push(`    last sync ok: ${humanizeAge(stat.lastSyncOkMs, nowMsVal)}`);
    lines.push(`    last commit: ${stat.lastCommit ?? 'none'}`);
    lines.push(`    error: ${stat.syncError ?? 'none'}`);
    const ghMs = self.githubPushOkMs?.[name];
    lines.push(`    github push ok: ${ghMs === undefined ? 'unknown' : humanizeAge(ghMs, nowMsVal)}`);
  }
  if (Array.isArray(self.flags) && self.flags.length > 0) {
    lines.push(`Flags: ${self.flags.join(', ')}`);
  }
  return lines;
}

// --- commands ---

const NOT_RUNNING_HINT = 'node not running (systemctl --user status sukarfleet)';

async function cmdStatus(): Promise<number> {
  const { nodePort, syncStaleMin } = await loadCliConfig();
  const raw = await fetchStatus(nodePort);
  if (raw === null) {
    console.error(NOT_RUNNING_HINT);
    return 2;
  }
  const nowMsVal = nowMs();
  const syncStaleMs = syncStaleMin * 60000;
  const colorEnabled = isColorEnabled();

  const rows: FleetRow[] = [buildSelfRow(buildSelfView(raw), nowMsVal, syncStaleMs)];
  for (const p of raw.peers ?? []) rows.push(buildPeerRow(p, nowMsVal));
  const alarms = extractAlarms(raw);

  console.log(renderTable(rows, colorEnabled));
  console.log('');
  console.log('Alarms:');
  for (const line of buildAlarmLines(alarms, nowMsVal, colorEnabled)) console.log(line);

  const faultCount = rows.filter((r) => !r.online || r.warn).length + alarms.length;
  return faultCount > 0 ? 1 : 0;
}

async function cmdPeers(): Promise<number> {
  const { nodePort } = await loadCliConfig();
  const raw = await fetchStatus(nodePort);
  if (raw === null) {
    console.error(NOT_RUNNING_HINT);
    return 2;
  }
  console.log(JSON.stringify(raw.peers ?? [], null, 2));
  return 0;
}

async function cmdSelf(): Promise<number> {
  const { nodePort } = await loadCliConfig();
  const raw = await fetchStatus(nodePort);
  if (raw === null) {
    console.error(NOT_RUNNING_HINT);
    return 2;
  }
  for (const line of buildSelfReport(buildSelfView(raw), nowMs())) console.log(line);
  return 0;
}

async function cmdVersion(): Promise<number> {
  const pkgPath = join(import.meta.dir, '..', 'package.json');
  const pkg = (await Bun.file(pkgPath).json()) as { version?: string };
  console.log(pkg.version ?? 'unknown');
  return 0;
}

// Generic argv splitter. It lived inside the signed-job section before the extraction, but it is
// not part of that ceremony -- `audit tail` reads its positional through it, and `admin run` has
// its own parser (parseAdminRunArgs) because a `--` separator changes the rules.
//
// It reads no flag VALUE -- `audit tail` takes a positional limit and nothing else -- so the
// `--flag VALUE` / `--flag=VALUE` split that bit easytier-toml cannot bite here. Anything that
// starts reading values out of `flags` has to take the separated form too.
export function extractFlags(args: string[]): { flags: Record<string, string>; positional: string[] } {
  const flags: Record<string, string> = {};
  const positional: string[] = [];
  for (const a of args) {
    if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      if (eq === -1) flags[a.slice(2)] = 'true';
      else flags[a.slice(2, eq)] = a.slice(eq + 1);
    } else {
      positional.push(a);
    }
  }
  return { flags, positional };
}

// --- audit tail ---

export async function cmdAuditTail(rawArgs: string[]): Promise<number> {
  const { positional } = extractFlags(rawArgs);
  const limitArg = positional[0];
  const limitNum = limitArg !== undefined ? Number(limitArg) : NaN;
  const limit = Number.isFinite(limitNum) && limitNum > 0 ? Math.floor(limitNum) : 20;

  const { nodePort } = await loadCliConfig();
  let res: Response;
  try {
    res = await fetch(`http://127.0.0.1:${nodePort}/exec/audit/tail?limit=${limit}`);
  } catch {
    console.error(NOT_RUNNING_HINT);
    return 2;
  }
  if (!res.ok) {
    console.error(`audit tail: node returned HTTP ${res.status}`);
    return 1;
  }
  const body = (await res.json()) as { entries?: AuditEntry[] };
  const entries = Array.isArray(body.entries) ? body.entries : [];
  if (entries.length === 0) {
    console.log('(no audit entries)');
    return 0;
  }
  for (const e of entries) {
    console.log(`${e.machine}#${e.seq}  ${new Date(e.tsMs).toISOString()}  ${e.kind}  ${JSON.stringify(e.detail)}`);
  }
  return 0;
}

// --- p3-ssh-admin commands (admin run / status / trust / exec-local) ---
//
// `run`, `status` and `trust` are thin clients over the daemon's own loopback GUI API -- the same
// routes the browser uses (src/uiserve.ts), which is why the admin lane has exactly one
// implementation and this file holds no lane logic. A non-browser client sends no Origin and no
// Sec-Fetch-Site, so rejectCrossSiteBrowser lets it through unchanged; it does require
// content-type: application/json on every mutating call, which is why the POSTs below always set
// it (see uiserve.ts:319).
//
// `exec-local` is the odd one out and is NOT an HTTP client: it is the SSH forced command named in
// authorized_keys (sshadmin.ts's forcedCommand()), so it runs in a stripped environment with no
// TTY, no meaningful cwd, and stdout wired straight back to the origin machine as a structured
// channel. It is the only path in the codebase that reaches SshAdmin.execLocal, which is in turn
// the only caller of secrets.withSudoPassword. Nothing here ever sees, asks for, or prints a
// password: the credential is unsealed inside sshadmin.ts and never leaves that frame.

const ADMIN_POLL_MS = 300;
// Slack on top of the run's own deadline before this client stops waiting. The daemon keeps the
// run in its registry either way, so giving up here loses nothing but the live output.
const ADMIN_POLL_GRACE_MS = 30000;
// A forced command with no payload on argv may be handed one on stdin (see cmdAdminExecLocal).
// Both bounds fail closed: past them the payload is truncated and decodeExecLocal refuses it.
const STDIN_READ_TIMEOUT_MS = 10000;
const MAX_STDIN_PAYLOAD_CHARS = 65536;

const ADMIN_RUN_USAGE =
  'usage: sukarfleet-cli admin run <machine> --reason "<why>" [--timeout=N] -- <argv...>';

export interface AdminRunArgs {
  machine: string;
  reason: string;
  timeoutSec?: number;
  argv: string[];
}

// A bare `--` is REQUIRED before the command. Without it there is no way to tell `--user` (a token
// of the command being run) from a flag of this CLI, and guessing wrong would either eat part of
// the operator's command or run a different one than they read.
export function parseAdminRunArgs(args: string[]): { ok: true; value: AdminRunArgs } | { ok: false; error: string } {
  const sep = args.indexOf('--');
  if (sep === -1) return { ok: false, error: 'the command must be separated from the flags by --' };
  const argv = args.slice(sep + 1);
  if (argv.length === 0) return { ok: false, error: 'no command given after --' };

  let machine = '';
  let reason = '';
  let timeoutSec: number | undefined;

  const head = args.slice(0, sep);
  for (let i = 0; i < head.length; i++) {
    const token = head[i]!;
    if (token === '--reason' || token === '--timeout') {
      // Both spellings are accepted here, as they are for easytier-toml -- but a
      // value that is itself a flag means the value was forgotten, and taking it
      // would silently drop the flag AND record a nonsense reason in the audit
      // log, which is the one thing this argument exists for.
      const value = head[i + 1];
      if (value === undefined || value.startsWith('--')) return { ok: false, error: `${token} needs a value` };
      i += 1;
      if (token === '--reason') reason = value;
      else timeoutSec = Number(value);
      continue;
    }
    if (token.startsWith('--reason=')) {
      reason = token.slice('--reason='.length);
      continue;
    }
    if (token.startsWith('--timeout=')) {
      timeoutSec = Number(token.slice('--timeout='.length));
      continue;
    }
    if (token.startsWith('-')) return { ok: false, error: `unknown flag ${token}` };
    if (machine) return { ok: false, error: `unexpected argument "${token}" (did you forget the -- separator?)` };
    machine = token;
  }

  if (!machine) return { ok: false, error: 'no target machine given' };
  if (reason.trim().length === 0) {
    return { ok: false, error: 'every admin run needs a --reason; it is the audit log' };
  }
  if (timeoutSec !== undefined && (!Number.isInteger(timeoutSec) || timeoutSec <= 0)) {
    return { ok: false, error: '--timeout must be a positive whole number of seconds' };
  }
  return { ok: true, value: { machine, reason, argv, ...(timeoutSec === undefined ? {} : { timeoutSec }) } };
}

async function loadAdminConfig(label: string): Promise<FleetConfig | null> {
  try {
    return await loadConfig();
  } catch (err) {
    console.error(`${label}: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}

// Shared shape for the three HTTP-backed admin verbs. Returns null after printing an actionable
// line, so each caller is a straight-line function.
async function adminApi(
  label: string,
  nodePort: number,
  path: string,
  init?: RequestInit,
  notFoundMessage?: string,
): Promise<unknown | null> {
  let res: Response;
  try {
    res = await fetch(`http://127.0.0.1:${nodePort}${path}`, init);
  } catch {
    console.error(NOT_RUNNING_HINT);
    return null;
  }
  if (res.status === 404) {
    console.error(
      `${label}: ${notFoundMessage ?? 'the local GUI API is not served (admin.uiEnabled is false in config.json)'}`,
    );
    return null;
  }
  if (!res.ok) {
    console.error(`${label}: the daemon answered HTTP ${res.status}`);
    return null;
  }
  try {
    return await res.json();
  } catch {
    console.error(`${label}: the daemon's answer was not JSON`);
    return null;
  }
}

function exitCodeFor(view: AdminRunView): number {
  const code = view.exitCode;
  // Exit codes above a byte are not representable in a process exit status; report them as a
  // generic failure rather than silently wrapping to a different (possibly zero) number.
  if (!Number.isInteger(code) || (code as number) < 0 || (code as number) > 255) return 1;
  return code as number;
}

export async function cmdAdminRun(rawArgs: string[]): Promise<number> {
  const parsed = parseAdminRunArgs(rawArgs);
  if (!parsed.ok) {
    console.error(`admin run: ${parsed.error}`);
    console.error(ADMIN_RUN_USAGE);
    return 2;
  }
  const { machine, reason, argv, timeoutSec } = parsed.value;

  const cfg = await loadAdminConfig('admin run');
  if (!cfg) return 2;

  const started = await adminApi('admin run', cfg.nodePort, '/api/ui/admin/run', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ machine, argv, reason, ...(timeoutSec === undefined ? {} : { timeoutSec }) }),
  });
  if (started === null) return 2;
  const runId =
    started && typeof started === 'object' && typeof (started as Record<string, unknown>).runId === 'string'
      ? ((started as Record<string, unknown>).runId as string)
      : null;
  if (!runId) {
    console.error('admin run: the daemon did not return a run id');
    return 2;
  }

  // The GUI route is registry-backed (plan C8), so the synchronous CLI shape is built here by
  // polling. The daemon owns the real deadline; this only bounds how long we watch it.
  const effectiveTimeoutSec = timeoutSec ?? cfg.admin.runTimeoutSec;
  const deadline = nowMs() + (effectiveTimeoutSec + cfg.admin.connectTimeoutSec) * 1000 + ADMIN_POLL_GRACE_MS;
  let view: AdminRunView | null = null;
  for (;;) {
    const polled = (await adminApi(
      'admin run',
      cfg.nodePort,
      `/api/ui/admin/run/${encodeURIComponent(runId)}`,
      undefined,
      `run ${runId} is no longer in the daemon's registry (it keeps the last 20, and clears them on restart)`,
    )) as AdminRunView | null;
    if (polled === null) return 2;
    view = polled;
    if (!view.running) break;
    if (nowMs() > deadline) {
      console.error(`admin run: gave up watching ${runId} after its deadline; the run itself is bounded by the daemon`);
      console.error('admin run: check `sukarfleet-cli admin status` or the local GUI for the result');
      return 2;
    }
    await Bun.sleep(ADMIN_POLL_MS);
  }

  if (view.stdout) process.stdout.write(view.stdout.endsWith('\n') ? view.stdout : `${view.stdout}\n`);
  if (view.stderr) process.stderr.write(view.stderr.endsWith('\n') ? view.stderr : `${view.stderr}\n`);
  if (view.truncated) {
    console.error('admin run: output was longer than the capture limit and was truncated; the exit code is real');
  }

  if (view.refusal) {
    // The daemon's own message first (it knows which leg refused), then the fixed copy that says
    // what to go and do about it. Neither can contain credential material.
    console.error(`admin run: refused (${view.refusal}): ${view.message ?? 'no detail'}`);
    const advice = adminRefusalAdvice(view.refusal, view.machine || machine, cfg.machine);
    if (advice) console.error(`admin run: ${advice}`);
    return 2;
  }

  console.error(
    `admin run: ${view.machine} exit ${view.exitCode ?? 'none'} via ${view.transport ?? 'unknown'} in ${view.durationMs} ms`,
  );
  return exitCodeFor(view);
}

export function renderAdminStatus(entries: AdminStatusEntry[], nowMsVal: number): string {
  const headers = ['MACHINE', 'LANE', 'PAIRED', 'REACHABLE', 'CREDENTIAL', 'LAST RUN'];
  const rows = entries.map((e) => [
    e.self ? `${e.machine} (self)` : e.machine,
    e.laneEnabled ? 'on' : 'off',
    e.paired ? 'yes' : 'no',
    e.reachable === null ? 'unknown' : e.reachable ? 'yes' : 'no',
    // Peer credential state is never transmitted, by design: a peer's column reads "not visible"
    // rather than "missing", so nobody diagnoses a false absence (sshadmin.ts's status()).
    e.self ? (e.credentialStale ? 'stale' : e.credentialReady ? 'ready' : 'none') : 'not visible',
    humanizeAge(e.lastAdminRunMs, nowMsVal),
  ]);
  const widths = headers.map((h, i) => Math.max(h.length, ...rows.map((r) => r[i]!.length)));
  const lines = [headers.map((h, i) => h.padEnd(widths[i]!)).join('  ')];
  for (const row of rows) lines.push(row.map((cell, i) => cell.padEnd(widths[i]!)).join('  '));
  return lines.join('\n');
}

export async function cmdAdminStatus(): Promise<number> {
  const cfg = await loadAdminConfig('admin status');
  if (!cfg) return 2;
  const body = await adminApi('admin status', cfg.nodePort, '/api/ui/admin/status');
  if (body === null) return 2;
  const entries = Array.isArray(body) ? (body as AdminStatusEntry[]) : [];
  if (entries.length === 0) {
    console.log('(the admin lane reports no machines)');
    return 1;
  }
  console.log(renderAdminStatus(entries, nowMs()));
  const blocked = entries.filter((e) => !e.laneEnabled || (e.self && !e.credentialReady) || e.reachable === false);
  return blocked.length > 0 ? 1 : 0;
}

// Public-key material only. The credential block of GET /api/ui/credentials is deliberately not
// printed: it carries no password, but the smallest surface that answers "is this machine's SSH
// trust set up" is the right one for a verb an agent may call.
export async function cmdAdminTrust(): Promise<number> {
  const cfg = await loadAdminConfig('admin trust');
  if (!cfg) return 2;
  const body = await adminApi('admin trust', cfg.nodePort, '/api/ui/credentials');
  if (body === null) return 2;

  const raw = (body ?? {}) as {
    trust?: { sshPublicKey?: string; sshKeyFingerprint?: string; hostKeyFingerprints?: string[] };
    seal?: { ok?: boolean; reason?: string };
  };
  const trust = raw.trust ?? {};
  console.log(`Machine: ${cfg.machine}`);
  console.log(`Fleet SSH key: ${trust.sshPublicKey || '(none: run install/quickstart.sh)'}`);
  console.log(`Fingerprint: ${trust.sshKeyFingerprint || 'none'}`);
  console.log('Host key fingerprints:');
  const fps = Array.isArray(trust.hostKeyFingerprints) ? trust.hostKeyFingerprints : [];
  if (fps.length === 0) console.log('  (none)');
  for (const fp of fps) console.log(`  ${fp}`);
  console.log(
    `TPM sealing: ${raw.seal?.ok === true ? 'available' : `unavailable${raw.seal?.reason ? ` (${raw.seal.reason})` : ''}`}`,
  );
  return trust.sshPublicKey ? 0 : 1;
}

// --- admin exec-local (the SSH forced command) ---

export interface AdminExecLocalDeps {
  env?: Record<string, string | undefined>;
  readStdin?: () => Promise<string>;
  writeOut?: (text: string) => void;
  writeErr?: (text: string) => void;
  // Injectable so tests can drive the stdin/stdout contract without a credential store, a TPM, or
  // a real sudo (mirrors JobRunDeps.loadMachineKey's seam). Production callers omit it.
  makeAdmin?: (cfg: FleetConfig) => Promise<{ execLocal: (payloadB64: string) => Promise<ExecLocalResponse> }>;
}

// Bounded on both time and size: an origin that opens the channel and never writes must not pin
// this process open, and a payload larger than the codec accepts is refused anyway.
async function readStdinPayload(): Promise<string> {
  const reader = Bun.stdin.stream().getReader();
  const decoder = new TextDecoder();
  const deadline = Date.now() + STDIN_READ_TIMEOUT_MS;
  let out = '';
  try {
    for (;;) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) break;
      const step = await Promise.race([
        reader.read(),
        new Promise<null>((resolve) => {
          const timer = setTimeout(() => resolve(null), remaining);
          (timer as unknown as { unref?: () => void }).unref?.();
        }),
      ]);
      if (step === null || step.done) break;
      out += decoder.decode(step.value, { stream: true });
      if (out.length > MAX_STDIN_PAYLOAD_CHARS) break;
    }
  } catch {
    // A closed or unreadable stdin is an empty payload, which the caller refuses.
  } finally {
    void reader.cancel().catch(() => {});
  }
  return out;
}

async function defaultExecLocalAdmin(
  cfg: FleetConfig,
): Promise<{ execLocal: (payloadB64: string) => Promise<ExecLocalResponse> }> {
  // A run this machine cannot record is a run it does not perform: the audit log is constructed
  // (and its failures surfaced) BEFORE any argv reaches the target leg.
  const key = await loadOrCreateMachineKey(cfg.machine);
  const auditLog = new AuditLog(cfg.machine, key);
  return new SshAdmin({
    cfg,
    auditAppend: (kind, detail) => auditLog.append(kind, detail),
    // Gossip lives in the daemon; this short-lived process has no peer table and needs none --
    // execLocal reads cfg.peers directly and never consults a PeerView.
    peerView: () => null,
    now: nowMs,
  });
}

function execLocalRefusal(message: string): ExecLocalResponse {
  // 'not-configured' rather than a credential-flavoured reason: everything that reaches here is a
  // local setup fault, and mislabelling it would send the operator to the wrong screen.
  return {
    v: 1,
    exitCode: null,
    stdout: '',
    stderr: '',
    truncated: false,
    durationMs: 0,
    refusal: 'not-configured',
    message,
  };
}

// The target leg's entry point. Contract, in full:
//   in  -- the base64 payload on SSH_ORIGINAL_COMMAND (what sshd sets when a forced command
//          replaces the client's command), or on stdin when that variable is empty or exactly "-".
//   out -- exactly one JSON ExecLocalResponse line on stdout, and nothing else, ever.
//   rc  -- 0 whenever an envelope was emitted; 2 only when the invocation was refused outright.
//
// Why rc 0 on a refusal envelope: the origin classifies "non-zero exit with empty stdout" as a
// connect-level failure, and a connect-level failure is the ONE state that may be retried over a
// second transport (sshadmin.ts's classifySshOutcome). A refusal that already happened must never
// be re-dialled, so once an envelope exists this command reports success at the transport level
// and lets the envelope carry the verdict.
//
// Requiring SSH_ORIGINAL_COMMAND also means this cannot be used as a hand-run convenience wrapper
// for root: outside an ssh session with the forced command in place, it refuses.
export async function cmdAdminExecLocal(deps: AdminExecLocalDeps = {}): Promise<number> {
  const env = deps.env ?? process.env;
  const writeOut = deps.writeOut ?? ((text: string) => void process.stdout.write(text));
  const writeErr = deps.writeErr ?? ((text: string) => void process.stderr.write(text));

  // util.log() writes to console.log, i.e. to the very stream the response envelope travels on.
  // Anything the layers below log during this call goes to stderr instead, so stdout carries the
  // envelope and nothing else. Restored in the finally below.
  const realConsoleLog = console.log;
  console.log = (...args: unknown[]): void => {
    console.error(...args);
  };

  try {
    const original = env.SSH_ORIGINAL_COMMAND;
    if (typeof original !== 'string') {
      writeErr(
        'admin exec-local: this is the SSH forced command for the sukarfleet admin lane, not a manual verb.\n' +
          'It refuses to run without SSH_ORIGINAL_COMMAND. Use `sukarfleet-cli admin run` instead.\n',
      );
      return 2;
    }

    let payload = original.trim();
    if (payload === '' || payload === '-') payload = (await (deps.readStdin ?? readStdinPayload)()).trim();
    if (payload === '') {
      writeOut(`${JSON.stringify(execLocalRefusal('the admin lane received an empty request payload'))}\n`);
      return 0;
    }

    let cfg: FleetConfig;
    try {
      cfg = await loadConfig();
    } catch {
      // The error text names a path, not a secret, but a fixed string keeps this envelope's
      // contents independent of anything on the target machine's disk.
      writeOut(`${JSON.stringify(execLocalRefusal('the target machine has no usable sukarfleet config'))}\n`);
      return 0;
    }

    let admin: { execLocal: (payloadB64: string) => Promise<ExecLocalResponse> };
    try {
      admin = await (deps.makeAdmin ?? defaultExecLocalAdmin)(cfg);
    } catch (err) {
      // Reduced to the error's type, never its message. This runs on the machine that OWNS a
      // credential, so no string built here is reproduced verbatim (sshadmin.ts's sanitizedError).
      log('warn', 'cli: admin exec-local could not open the audit log', {
        error: err instanceof Error ? err.name : typeof err,
      });
      writeOut(
        `${JSON.stringify(execLocalRefusal('the target machine could not open its audit log; nothing was run'))}\n`,
      );
      return 0;
    }

    let response: ExecLocalResponse;
    try {
      response = await admin.execLocal(payload);
    } catch (err) {
      // execLocal is contractually total; this only guards a future edit. The thrown value is
      // reduced to its type -- an error raised anywhere near the credential frame is never
      // reproduced verbatim (sshadmin.ts's sanitizedError).
      log('warn', 'cli: admin exec-local failed', { error: err instanceof Error ? err.name : typeof err });
      writeOut(`${JSON.stringify(execLocalRefusal('the admin lane failed on the target machine'))}\n`);
      return 0;
    }

    writeOut(`${JSON.stringify(response)}\n`);
    return 0;
  } finally {
    console.log = realConsoleLog;
  }
}


// ---------------------------------------------------------------------------
// easytier-toml
//
// A thin CLI over generateEasytierToml, so install/install-elevated.sh does not
// re-implement the TOML layout in bash. src/transport.ts stays the single source
// of the key layout and of the two constraints that make hand-writing it
// dangerous: every top-level key must precede the first table header, and
// rpc_portal is a unit CLI flag rather than a file key.
//
// The secret arrives as a FILE, never as an argument: a secret on argv reaches
// ps output and, through the shell that built the command, shell history. The
// caller is the elevated stage, which has already copied it out of the staged
// file into a 0600 root-owned scratch file.
// ---------------------------------------------------------------------------

export const EASYTIER_TOML_USAGE =
  'usage: sukarfleet-cli easytier-toml --secret-file PATH --mesh-ip A.B.C.D [--hostname NAME]\n' +
  '                                    [--network-name NAME] [--listener URI]... [--peer URI]...\n' +
  '                                    [--rpc-addr HOST:PORT]';

export interface EasytierTomlArgs {
  secretFile: string;
  meshIp: string;
  hostname: string;
  networkName: string;
  listeners: string[];
  peers: string[];
  rpcAddr: string;
}

// Every flag takes a value, in either spelling: `--flag=VALUE` and `--flag VALUE`
// both parse. Accepting only one of them is not a style question -- the usage
// text above advertises the separated form, install/install-elevated.sh built
// it, and a parser that took only `=` turned every real elevated run into an
// exit 5 after EasyTier was already installed. Both spellings are now pinned by
// tests/install-scripts.test.ts, which feeds this parser the argv the shell
// actually builds.
const EASYTIER_TOML_FLAGS = new Set([
  '--secret-file',
  '--mesh-ip',
  '--hostname',
  '--network-name',
  '--rpc-addr',
  '--listener',
  '--peer',
]);

// Repeated flags accumulate; everything else is last-wins. Unknown flags are an
// error rather than a shrug, because a typo'd --listener would silently produce
// a TOML that listens nowhere.
export function parseEasytierTomlArgs(args: string[]): { ok: true; value: EasytierTomlArgs } | { ok: false; message: string } {
  const out: EasytierTomlArgs = {
    secretFile: '',
    meshIp: '',
    hostname: '',
    networkName: 'sukarfleet',
    listeners: [],
    peers: [],
    rpcAddr: '127.0.0.1:15888',
  };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    const eq = arg.indexOf('=');
    const flag = eq === -1 ? arg : arg.slice(0, eq);
    if (!EASYTIER_TOML_FLAGS.has(flag)) return { ok: false, message: `easytier-toml: unknown argument ${flag}` };
    let value: string;
    if (eq === -1) {
      // The next token is the value -- unless it is itself a flag, which means
      // the value was forgotten and swallowing the flag would silently drop it.
      const next = args[i + 1];
      const nextFlag = next === undefined ? '' : next.slice(0, next.indexOf('=') === -1 ? next.length : next.indexOf('='));
      if (next === undefined || EASYTIER_TOML_FLAGS.has(nextFlag)) {
        return { ok: false, message: `easytier-toml: ${flag} needs a value, as ${flag} VALUE or ${flag}=VALUE` };
      }
      value = next;
      i += 1;
    } else {
      value = arg.slice(eq + 1);
    }
    switch (flag) {
      case '--secret-file': out.secretFile = value; break;
      case '--mesh-ip': out.meshIp = value; break;
      case '--hostname': out.hostname = value; break;
      case '--network-name': out.networkName = value; break;
      case '--rpc-addr': out.rpcAddr = value; break;
      case '--listener': out.listeners.push(value); break;
      case '--peer': out.peers.push(value); break;
      default: return { ok: false, message: `easytier-toml: unknown argument ${flag}` };
    }
  }
  if (!out.secretFile) return { ok: false, message: 'easytier-toml: --secret-file is required' };
  if (!out.meshIp) return { ok: false, message: 'easytier-toml: --mesh-ip is required' };
  if (!out.hostname) return { ok: false, message: 'easytier-toml: --hostname is required' };
  if (out.listeners.length === 0) out.listeners = ['tcp://0.0.0.0:11010', 'udp://0.0.0.0:11010'];
  return { ok: true, value: out };
}

// Split from the IO so a test can prove the CLI's output equals the generator's
// for the same inputs without touching the filesystem.
export function renderEasytierToml(args: EasytierTomlArgs, secret: string): string {
  const cfg = defaultConfig(args.hostname);
  cfg.networkName = args.networkName;
  cfg.easytier.rpcAddr = args.rpcAddr;
  return generateEasytierToml(cfg, {
    secret,
    listeners: args.listeners,
    peerUris: args.peers,
    hostname: args.hostname,
    ipv4: args.meshIp,
  });
}

export async function cmdEasytierToml(args: string[]): Promise<number> {
  const parsed = parseEasytierTomlArgs(args);
  if (!parsed.ok) {
    console.error(parsed.message);
    console.error(EASYTIER_TOML_USAGE);
    return 2;
  }
  let secret: string;
  try {
    secret = (await Bun.file(parsed.value.secretFile).text()).trim();
  } catch {
    // The path, never the contents: this runs as root against a file the console
    // wrote, and an error message is the one thing here that gets printed.
    console.error(`easytier-toml: could not read the secret file at ${parsed.value.secretFile}`);
    return 2;
  }
  if (secret === '') {
    console.error(`easytier-toml: the secret file at ${parsed.value.secretFile} is empty; nothing was written`);
    return 2;
  }
  process.stdout.write(renderEasytierToml(parsed.value, secret));
  return 0;
}

function printUsage(): void {
  console.log('usage: sukarfleet-cli [status|peers|self|version]');
  console.log('       sukarfleet-cli audit tail [n]');
  console.log(`       ${ADMIN_RUN_USAGE.replace('usage: ', '')}`);
  console.log('       sukarfleet-cli admin status');
  console.log('       sukarfleet-cli admin trust');
  console.log('       sukarfleet-cli admin exec-local   (SSH forced command; refuses without SSH_ORIGINAL_COMMAND)');
  console.log(`       ${EASYTIER_TOML_USAGE.replace('usage: ', '')}`);
}

async function main(): Promise<number> {
  const args = Bun.argv.slice(2);
  const cmd = args[0] ?? 'status';
  switch (cmd) {
    case 'status':
      return cmdStatus();
    case 'peers':
      return cmdPeers();
    case 'self':
      return cmdSelf();
    case 'version':
      return cmdVersion();
    case 'easytier-toml':
      return cmdEasytierToml(args.slice(1));
    case 'audit':
      if (args[1] === 'tail') return cmdAuditTail(args.slice(2));
      console.error(`unknown audit subcommand: ${args[1] ?? '(none)'}`);
      printUsage();
      return 2;
    case 'admin':
      if (args[1] === 'run') return cmdAdminRun(args.slice(2));
      if (args[1] === 'status') return cmdAdminStatus();
      if (args[1] === 'trust') return cmdAdminTrust();
      if (args[1] === 'exec-local') return cmdAdminExecLocal();
      console.error(`unknown admin subcommand: ${args[1] ?? '(none)'}`);
      printUsage();
      return 2;
    case 'help':
    case '-h':
    case '--help':
      printUsage();
      return 0;
    default:
      console.error(`unknown command: ${cmd}`);
      printUsage();
      return 2;
  }
}

// Guarded so tests can import the command functions from this module
// without triggering a real run of main() -- Bun.argv at `bun test` time is not this CLI's argv,
// and an unguarded top-level call would have called process.exit() out from under the test
// runner (mirrors src/rootsign.ts's identical import.meta.main guard).
if (import.meta.main) {
  main()
    .then((code) => process.exit(code))
    .catch((err) => {
      console.error(`error: ${err instanceof Error ? err.message : String(err)}`);
      process.exit(1);
    });
}
