// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Shared config loader. Source of truth alongside types.ts / util.ts.

import { open, rename, chmod } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import type { FleetConfig } from './types';
import { ensureDir, log, readJsonFile } from './util';

const CONFIG_FILE_MODE = 0o600;

export function configDir(): string {
  return join(homedir(), '.config', 'sukarfleet');
}

export function stateDir(): string {
  return process.env.SUKARFLEET_STATE ?? join(homedir(), '.local', 'state', 'sukarfleet');
}

// Resolves a leading '~' against the current user's home. Only the bare '~' form: '~otheruser' is
// returned untouched, because resolving another user's home is never what a machine-local path in
// this config means.
export function expandHome(p: string): string {
  if (p === '~') return homedir();
  if (p.startsWith('~/')) return join(homedir(), p.slice(2));
  return p;
}

// The admin-lane credential store. Takes the config when there is one so a scratch daemon under
// SUKARFLEET_CONFIG never writes into the real store; falls back to the default location for the
// pre-config paths (installer, CLI probes).
export function secretsDir(cfg?: FleetConfig): string {
  return expandHome(cfg?.admin.secretsDir ?? join(configDir(), 'secrets'));
}

export function defaultConfig(machine: string): FleetConfig {
  return {
    machine,
    role: 'anchor',
    meshIp: '',
    nodePort: 7710,
    networkName: 'sukarfleet',
    peers: [],
    repos: [],
    unionPaths: [],
    easytier: {
      rpcAddr: '127.0.0.1:15888',
      serviceName: 'easytier-fleet.service',
      cliPath: '/opt/easytier/easytier-cli',
    },
    wan: {
      udpPort: null,
      tcpPort: null,
    },
    notifications: {
      os: true,
    },
    fleetRepoPath: join(stateDir(), 'fleet-repo'),
    mcpPort: 7719,
    intervals: {
      gossipSec: 20,
      syncSec: 120,
      watchdogSec: 120,
      transportPollSec: 30,
    },
    thresholds: {
      syncStaleMin: 30,
      alarmRepeatMin: 30,
      peerOfflineFactor: 3,
      clockSkewMaxMs: 5000,
      wedgePolls: 3,
    },
    admin: {
      enabled: false,
      acceptIncoming: true,
      // Empty until the installer writes $USER. An empty sshUser is a valid config (the machine
      // simply cannot originate a call yet); it is the origin leg that refuses.
      sshUser: '',
      sshPort: 22,
      keyPath: '~/.ssh/id_sukarfleet_ed25519',
      knownHostsPath: join(stateDir(), 'known_hosts'),
      authorizedKeysPath: '~/.ssh/authorized_keys',
      secretsDir: join(configDir(), 'secrets'),
      auditRepo: null,
      // Fail closed for anyone installing this fresh. An existing deployment being migrated keeps
      // its current behaviour explicitly -- see persistLegacyMigration.
      agentOrigin: 'refuse',
      credentialMode: 'stored-password',
      allowPlaintextFallback: false,
      connectTimeoutSec: 8,
      runTimeoutSec: 120,
      maxRunTimeoutSec: 900,
      maxOutputBytes: 262144,
      ratePerMin: 20,
      uiEnabled: true,
      uiAssets: true,
    },
  };
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function fail(msg: string): never {
  throw new Error(`sukarfleet config: ${msg}`);
}

// ---------------------------------------------------------------------------
// Legacy `exec` block migration.
//
// Two fields that surviving code reads used to live inside the exec block, which no longer exists:
//
//   exec.auditRepo -> admin.auditRepo   gates the audit union flush. Losing it does not raise; it
//                                       silently stops the audit log ever reaching the synced
//                                       union file.
//   exec.mcpPort   -> mcpPort           the loopback MCP listen port.
//
// The block itself is deliberately NOT deleted from the file. Unknown top-level keys pass through
// untouched by design, an inert block costs nothing, and leaving it means a rollback to the
// pre-extraction daemon finds its config exactly as it left it. The new locations win when both
// are present.
// ---------------------------------------------------------------------------

let legacyExecWarned = false;

export function migrateLegacyExecBlock(raw: Record<string, unknown>, base: FleetConfig): {
  mcpPort: number;
  auditRepo: string | null | undefined;
  agentOrigin: 'refuse' | 'allow' | undefined;
  legacyFound: boolean;
} {
  const legacy = isPlainObject(raw.exec) ? raw.exec : undefined;
  const rawAdmin = isPlainObject(raw.admin) ? raw.admin : undefined;

  let mcpPort = typeof raw.mcpPort === 'number' ? raw.mcpPort : undefined;
  if (mcpPort === undefined && legacy && typeof legacy.mcpPort === 'number') mcpPort = legacy.mcpPort;

  let auditRepo = rawAdmin && 'auditRepo' in rawAdmin ? (rawAdmin.auditRepo as string | null) : undefined;
  if (auditRepo === undefined && legacy && 'auditRepo' in legacy) auditRepo = legacy.auditRepo as string | null;

  // A config carrying the legacy exec block predates the agent-origin switch, and on that
  // deployment an agent COULD already drive the admin lane. Defaulting it to 'refuse' here would
  // silently start refusing agent-origin runs the moment the daemon restarts -- a behaviour change
  // nobody asked for, delivered during a cutover, which is the worst possible moment.
  //
  // This is computed IN MEMORY rather than only on the persistence path, because the in-memory
  // value is what the daemon actually runs on. persistLegacyMigration writes the same answer into
  // the file so it is visible rather than implied, but the daemon must behave correctly even if
  // that write never happens.
  const rawAgentOrigin = rawAdmin && 'agentOrigin' in rawAdmin ? rawAdmin.agentOrigin : undefined;
  const agentOrigin: 'refuse' | 'allow' | undefined =
    rawAgentOrigin === undefined && legacy !== undefined ? 'allow' : undefined;

  const legacyFound = legacy !== undefined;
  if (legacyFound && !legacyExecWarned) {
    legacyExecWarned = true;
    log('info', 'config: legacy exec block present and ignored; its live fields were migrated', {
      migratedMcpPort: mcpPort !== undefined,
      migratedAuditRepo: auditRepo !== undefined,
    });
  }

  return { mcpPort: mcpPort ?? base.mcpPort, auditRepo, agentOrigin, legacyFound };
}

function mergeDefaults(raw: Record<string, unknown>, base: FleetConfig): FleetConfig {
  const wan = isPlainObject(raw.wan) ? { ...base.wan, ...raw.wan } : base.wan;
  const easytier = isPlainObject(raw.easytier) ? { ...base.easytier, ...raw.easytier } : base.easytier;
  const intervals = isPlainObject(raw.intervals) ? { ...base.intervals, ...raw.intervals } : base.intervals;
  const thresholds = isPlainObject(raw.thresholds) ? { ...base.thresholds, ...raw.thresholds } : base.thresholds;
  const notifications = isPlainObject(raw.notifications)
    ? { ...base.notifications, ...raw.notifications }
    : base.notifications;

  const migrated = migrateLegacyExecBlock(raw, base);

  // One level only: `admin` is flat by design (types.ts), so a partial admin object inherits every
  // default it omits and there is no nested object to merge separately.
  const admin = isPlainObject(raw.admin) ? { ...base.admin, ...raw.admin } : base.admin;
  if (migrated.auditRepo !== undefined) admin.auditRepo = migrated.auditRepo;
  if (migrated.agentOrigin !== undefined) admin.agentOrigin = migrated.agentOrigin;

  return {
    ...base,
    ...raw,
    wan: wan as FleetConfig['wan'],
    easytier: easytier as FleetConfig['easytier'],
    intervals: intervals as FleetConfig['intervals'],
    thresholds: thresholds as FleetConfig['thresholds'],
    notifications: notifications as FleetConfig['notifications'],
    mcpPort: migrated.mcpPort,
    admin: admin as FleetConfig['admin'],
  } as FleetConfig;
}

function validatePeer(p: unknown, i: number): void {
  if (!isPlainObject(p)) fail(`peers[${i}] must be an object`);
  const peer = p as Record<string, unknown>;
  if (typeof peer.name !== 'string' || !peer.name) fail(`peers[${i}].name must be a non-empty string`);
  if (typeof peer.meshIp !== 'string' || !peer.meshIp) fail(`peers[${i}].meshIp must be a non-empty string`);
  if (!Number.isInteger(peer.nodePort) || (peer.nodePort as number) <= 0) {
    fail(`peers[${i}].nodePort must be a positive integer`);
  }
  if (peer.publicKeyJwk !== null && !isPlainObject(peer.publicKeyJwk)) {
    fail(`peers[${i}].publicKeyJwk must be null or an object`);
  }
  // Admin-lane overrides: absent and null both mean "derive from the mesh identity", so only a
  // present non-null value is type-checked.
  for (const k of ['sshHost', 'sshFallbackHost', 'sshUser', 'sshPublicKey'] as const) {
    const val = (peer as Record<string, unknown>)[k];
    if (val !== undefined && val !== null && (typeof val !== 'string' || !val)) {
      fail(`peers[${i}].${k} must be null or a non-empty string`);
    }
  }
  // A stored grant key must be a single bare key line. Rejecting options/newlines here as well as
  // at pairing keeps a hand-edited config from injecting authorized_keys options when the grant is
  // rewritten on an acceptIncoming toggle.
  if (typeof peer.sshPublicKey === 'string' && /[\r\n]/.test(peer.sshPublicKey)) {
    fail(`peers[${i}].sshPublicKey must be a single line`);
  }
  if (peer.sshPort !== undefined && peer.sshPort !== null) {
    const port = peer.sshPort;
    if (!Number.isInteger(port) || (port as number) <= 0 || (port as number) > 65535) {
      fail(`peers[${i}].sshPort must be null or a port number`);
    }
  }
}

function validateRepo(r: unknown, i: number): void {
  if (!isPlainObject(r)) fail(`repos[${i}] must be an object`);
  const repo = r as Record<string, unknown>;
  if (typeof repo.name !== 'string' || !repo.name) fail(`repos[${i}].name must be a non-empty string`);
  if (typeof repo.path !== 'string' || !repo.path) fail(`repos[${i}].path must be a non-empty string`);
  if (repo.postMerge !== undefined) {
    const bad =
      !Array.isArray(repo.postMerge) ||
      repo.postMerge.some((argv: unknown) => !Array.isArray(argv) || argv.some((a) => typeof a !== 'string'));
    if (bad) fail(`repos[${i}].postMerge must be an array of string arrays`);
  }
}

function validate(cfg: FleetConfig): void {
  if (typeof cfg.machine !== 'string' || cfg.machine.length === 0) fail('machine must be a non-empty string');
  if (cfg.role !== 'anchor' && cfg.role !== 'roamer') {
    fail(`role must be "anchor" or "roamer", got ${JSON.stringify(cfg.role)}`);
  }
  if (typeof cfg.meshIp !== 'string') fail('meshIp must be a string');
  if (!Number.isInteger(cfg.nodePort) || cfg.nodePort <= 0) fail('nodePort must be a positive integer');
  if (typeof cfg.networkName !== 'string' || cfg.networkName.length === 0) {
    fail('networkName must be a non-empty string');
  }
  if (!Array.isArray(cfg.peers)) fail('peers must be an array');
  cfg.peers.forEach((p, i) => validatePeer(p, i));
  if (!Array.isArray(cfg.repos)) fail('repos must be an array');
  cfg.repos.forEach((r, i) => validateRepo(r, i));
  if (!Array.isArray(cfg.unionPaths) || cfg.unionPaths.some((p) => typeof p !== 'string')) {
    fail('unionPaths must be an array of strings');
  }
  if (!isPlainObject(cfg.easytier)) fail('easytier must be an object');
  if (typeof cfg.easytier.rpcAddr !== 'string' || !cfg.easytier.rpcAddr) {
    fail('easytier.rpcAddr must be a non-empty string');
  }
  if (typeof cfg.easytier.serviceName !== 'string' || !cfg.easytier.serviceName) {
    fail('easytier.serviceName must be a non-empty string');
  }
  if (typeof cfg.easytier.cliPath !== 'string' || !cfg.easytier.cliPath) {
    fail('easytier.cliPath must be a non-empty string');
  }
  if (typeof cfg.fleetRepoPath !== 'string' || !cfg.fleetRepoPath) fail('fleetRepoPath must be a non-empty string');
  if (!Number.isInteger(cfg.mcpPort) || cfg.mcpPort <= 0 || cfg.mcpPort > 65535) {
    fail('mcpPort must be a port number');
  }

  if (!isPlainObject(cfg.wan)) fail('wan must be an object');
  for (const k of ['udpPort', 'tcpPort'] as const) {
    const val = cfg.wan[k];
    if (val !== null && (!Number.isInteger(val) || (val as number) <= 0 || (val as number) > 65535)) {
      fail(`wan.${k} must be null or a port number`);
    }
  }

  if (!isPlainObject(cfg.notifications)) fail('notifications must be an object');
  if (typeof cfg.notifications.os !== 'boolean') fail('notifications.os must be a boolean');

  const iv = cfg.intervals as unknown;
  if (!isPlainObject(iv)) fail('intervals must be an object');
  for (const k of ['gossipSec', 'syncSec', 'watchdogSec', 'transportPollSec'] as const) {
    const val = (iv as Record<string, unknown>)[k];
    if (typeof val !== 'number' || !Number.isFinite(val) || val <= 0) {
      fail(`intervals.${k} must be a positive number`);
    }
  }

  const th = cfg.thresholds as unknown;
  if (!isPlainObject(th)) fail('thresholds must be an object');
  for (const k of ['syncStaleMin', 'alarmRepeatMin', 'peerOfflineFactor', 'clockSkewMaxMs', 'wedgePolls'] as const) {
    const val = (th as Record<string, unknown>)[k];
    if (typeof val !== 'number' || !Number.isFinite(val) || val <= 0) {
      fail(`thresholds.${k} must be a positive number`);
    }
  }

  validateAdmin(cfg.admin as unknown);
}

function validateAdmin(raw: unknown): void {
  if (!isPlainObject(raw)) fail('admin must be an object');
  const admin = raw as Record<string, unknown>;
  for (const k of ['enabled', 'acceptIncoming', 'allowPlaintextFallback', 'uiEnabled'] as const) {
    if (typeof admin[k] !== 'boolean') fail(`admin.${k} must be a boolean`);
  }
  // Optional (P6): absent means "default true", same as every other admin.* field mergeDefaults
  // fills in -- only a present-but-wrong-typed value is rejected.
  if (admin.uiAssets !== undefined && typeof admin.uiAssets !== 'boolean') {
    fail('admin.uiAssets must be a boolean');
  }
  // sshUser may legitimately be empty before the installer fills it in; the origin leg refuses
  // rather than the daemon failing to boot.
  if (typeof admin.sshUser !== 'string') fail('admin.sshUser must be a string');
  for (const k of ['keyPath', 'knownHostsPath', 'authorizedKeysPath', 'secretsDir'] as const) {
    const val = admin[k];
    if (typeof val !== 'string' || !val) fail(`admin.${k} must be a non-empty string`);
  }
  if (admin.auditRepo !== undefined && admin.auditRepo !== null && typeof admin.auditRepo !== 'string') {
    fail('admin.auditRepo must be null or a repo name');
  }
  if (admin.agentOrigin !== 'refuse' && admin.agentOrigin !== 'allow') {
    fail(`admin.agentOrigin must be "refuse" or "allow", got ${JSON.stringify(admin.agentOrigin)}`);
  }
  if (admin.credentialMode !== 'stored-password' && admin.credentialMode !== 'nopasswd') {
    fail(`admin.credentialMode must be "stored-password" or "nopasswd", got ${JSON.stringify(admin.credentialMode)}`);
  }
  if (!Number.isInteger(admin.sshPort) || (admin.sshPort as number) <= 0 || (admin.sshPort as number) > 65535) {
    fail('admin.sshPort must be a port number');
  }
  for (const k of ['connectTimeoutSec', 'runTimeoutSec', 'maxRunTimeoutSec', 'maxOutputBytes', 'ratePerMin'] as const) {
    const val = admin[k];
    if (!Number.isInteger(val) || (val as number) <= 0) fail(`admin.${k} must be a positive integer`);
  }
  // A ceiling below the default is a config that refuses every run it was asked to allow.
  if ((admin.maxRunTimeoutSec as number) < (admin.runTimeoutSec as number)) {
    fail('admin.maxRunTimeoutSec must be >= admin.runTimeoutSec');
  }
}

function resolveConfigPath(path?: string): string {
  return path ?? process.env.SUKARFLEET_CONFIG ?? join(configDir(), 'config.json');
}

// Writes with the final permission bits present from the moment the inode is created (mirrors
// keys.ts's writeSecretFile) -- duplicated rather than imported because keys.ts imports configDir
// from this file, and closing that cycle for one helper is not worth the module-init hazard.
async function writeConfigFile(path: string, data: string): Promise<void> {
  const dir = dirname(path);
  await ensureDir(dir);
  const tmp = join(dir, `.tmp-config-${randomBytes(8).toString('hex')}`);
  const fh = await open(tmp, 'w', CONFIG_FILE_MODE);
  try {
    await fh.writeFile(data, 'utf8');
  } finally {
    await fh.close();
  }
  try {
    await rename(tmp, path);
  } catch (err) {
    await chmod(tmp, CONFIG_FILE_MODE).catch(() => {});
    throw err;
  }
}

// Serializes patches against each other. Two concurrent read-mutate-write cycles on one file would
// otherwise let the second overwrite the first's peer entry with a stale snapshot.
let patchQueue: Promise<unknown> = Promise.resolve();

async function patchConfigLocked(
  mutate: (raw: Record<string, unknown>) => void,
  configPath: string,
): Promise<FleetConfig> {
  const raw = await readJsonFile<Record<string, unknown>>(configPath);
  if (raw === null) fail(`could not read or parse config file at ${configPath}`);
  if (!isPlainObject(raw)) fail(`config file at ${configPath} must contain a JSON object`);

  mutate(raw);

  if (typeof raw.machine !== 'string' || raw.machine.length === 0) {
    fail(`config file at ${configPath}: "machine" must be a non-empty string`);
  }
  // Validate BEFORE the write, never after: an invalid config.json takes the daemon down on its
  // next boot, so a rejected mutation must leave the file byte-identical.
  const merged = mergeDefaults(raw, defaultConfig(raw.machine));
  validate(merged);

  await writeConfigFile(configPath, JSON.stringify(raw, null, 2) + '\n');
  return merged;
}

// The one mutation path for config.json. `mutate` edits the RAW parsed file (so keys the running
// build does not know about survive untouched); the merged+validated result is what comes back.
export async function patchConfig(
  mutate: (raw: Record<string, unknown>) => void,
  path?: string,
): Promise<FleetConfig> {
  const configPath = resolveConfigPath(path);
  const run = (): Promise<FleetConfig> => patchConfigLocked(mutate, configPath);
  const task = patchQueue.then(run, run);
  patchQueue = task.catch(() => {});
  return task;
}

export async function loadConfig(path?: string): Promise<FleetConfig> {
  const configPath = resolveConfigPath(path);
  const raw = await readJsonFile<Record<string, unknown>>(configPath);
  if (raw === null) fail(`could not read or parse config file at ${configPath}`);
  if (!isPlainObject(raw)) fail(`config file at ${configPath} must contain a JSON object`);
  if (typeof raw.machine !== 'string' || raw.machine.length === 0) {
    fail(`config file at ${configPath}: "machine" must be a non-empty string`);
  }
  const merged = mergeDefaults(raw, defaultConfig(raw.machine));
  validate(merged);
  return merged;
}

// Persists the legacy-exec migration into config.json so the values appear in their new homes
// rather than being re-derived on every boot. Best effort by construction: the in-memory migration
// in mergeDefaults is what the daemon actually runs on, so a failure to write here costs nothing
// but a repeated log line. Call once at startup, after loadConfig.
//
// The legacy `exec` block is left in place on purpose -- see migrateLegacyExecBlock.
export async function persistLegacyMigration(path?: string): Promise<boolean> {
  const configPath = resolveConfigPath(path);
  try {
    const raw = await readJsonFile<Record<string, unknown>>(configPath);
    if (raw === null || !isPlainObject(raw)) return false;
    const legacy = isPlainObject(raw.exec) ? raw.exec : undefined;
    if (!legacy) return false;

    const rawAdmin = isPlainObject(raw.admin) ? raw.admin : undefined;
    const needsMcpPort = raw.mcpPort === undefined && typeof legacy.mcpPort === 'number';
    const needsAuditRepo = (!rawAdmin || !('auditRepo' in rawAdmin)) && 'auditRepo' in legacy;
    // A config carrying the legacy exec block predates the agent-origin switch, and on that
    // deployment an agent COULD already drive the lane. Defaulting it to 'refuse' would silently
    // break working automation during a cutover, so the existing behaviour is preserved -- but
    // written into the file explicitly, and logged, rather than left implied.
    const needsAgentOrigin = !rawAdmin || !('agentOrigin' in rawAdmin);
    if (!needsMcpPort && !needsAuditRepo && !needsAgentOrigin) return false;

    await patchConfig((r) => {
      const l = isPlainObject(r.exec) ? r.exec : {};
      if (needsMcpPort) r.mcpPort = l.mcpPort;
      if (needsAuditRepo) {
        const a = isPlainObject(r.admin) ? r.admin : {};
        a.auditRepo = l.auditRepo;
        r.admin = a;
      }
      if (needsAgentOrigin) {
        const a = isPlainObject(r.admin) ? r.admin : {};
        a.agentOrigin = 'allow';
        r.admin = a;
      }
    }, configPath);

    log('info', 'config: migrated legacy exec fields into their new locations', {
      mcpPort: needsMcpPort,
      auditRepo: needsAuditRepo,
      agentOrigin: needsAgentOrigin,
    });
    if (needsAgentOrigin) {
      log('warn', 'config: admin.agentOrigin was written as "allow" to preserve this deployment\'s existing behaviour', {
        hint: 'an agent can drive the admin lane on this machine. Set admin.agentOrigin to "refuse" to require a human.',
      });
    }
    return true;
  } catch (err) {
    log('warn', 'config: could not persist legacy exec migration (running on the in-memory value)', {
      error: String(err),
    });
    return false;
  }
}
