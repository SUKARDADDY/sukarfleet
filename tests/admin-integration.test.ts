// SPDX-License-Identifier: AGPL-3.0-or-later
// End-to-end tests for the SSH admin lane: two complete nodes, one process, real HTTP between them.
//
// Each node is wired the way src/node.ts wires it -- AuditLog, SshAdmin, Pairing and UiRoutes behind
// a real Bun.serve -- and the two pair each other through the GUI API before any admin call is made.
// Everything a test box can actually have is real: real ed25519 fleet and host keys from ssh-keygen,
// real authorized_keys/known_hosts/config.json writes through the real patchConfig, real HMAC pairing
// over a real socket, real hash-chained audit entries verified by the real crossCheckAuditLog.
//
// Four things a test box cannot have, each substituted at a declared seam and nowhere else:
//
//   ssh          deps.runner. The origin's runner recognizes an `ssh` argv, takes the base64 payload
//                off the end of it and hands it to the TARGET node's execLocal. The wire format,
//                both sets of gates and both audit legs are the real code; only the socket between
//                them becomes a function call. (This is also the contract L7's `cli.ts admin
//                exec-local` has to honour: one JSON line of the ExecLocalResponse on stdout.)
//   sudo         deps.runner again, on the target. No test may type a real sudo password, so the
//                sudo process is scripted -- but what it OBSERVES (argv, one password line on stdin)
//                is asserted, because that is the part that has to be right.
//   TPM sealing  exercised for real when systemd-creds can seal on this box, skipped loudly when it
//                cannot. The unsealed-store path is exercised unconditionally, so the real
//                withSudoPassword (including its output scrubber) is covered either way.
//   real peers   never contacted. Nothing here opens a socket off 127.0.0.1.
//
// The property every test in this file exists to protect: the sudo password reaches exactly two
// places -- the credential store on disk and sudo's stdin -- and nowhere else. The last describe
// sweeps every sink the whole scenario produced (both audit logs, every HTTP response body, every
// log line, the run registry, every exec-local payload that crossed the simulated wire, and every
// file either node wrote) and asserts the credential store is the only hit.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { AuditLog, crossCheckAuditLog } from '../src/audit';
import { defaultConfig, patchConfig } from '../src/config';
import { loadOrCreateMachineKey, writeSecretFile } from '../src/keys';
import { Pairing } from '../src/pairing';
import * as secrets from '../src/secrets';
import type { SealScope } from '../src/secrets';
import { SshAdmin } from '../src/sshadmin';
import type { SudoBroker } from '../src/sshadmin';
import { UiRoutes } from '../src/uiserve';
import type { UiRoutesDeps } from '../src/uiserve';
import type {
  AdminRunRequest,
  AdminRunResult,
  AuditEntry,
  FleetConfig,
  MachineKey,
  MinimalServer,
  PairBundle,
  PeerView,
  UiState,
} from '../src/types';
import type { RunOptions, RunResult } from '../src/util';
import { nowMs, run } from '../src/util';

// The one value that must never appear in a sink. Used as the sudo password everywhere in this
// file, so a single sweep at the end covers every path any test drove.
const SENTINEL_PASSWORD = 'correct-horse-battery-staple-integration-4417';
// Distinctive command output. Present in the run result the operator sees, and the audit log is
// asserted NOT to contain it -- byte counts only is a content rule, not a nicety.
const STDOUT_MARKER = 'uid=0(root) gid=0(root) INTEGRATION-STDOUT-9f3c';

// systemd-creds credential name, duplicated from src/secrets.ts. The TPM test has to seal a blob the
// real withSudoPassword will later unseal, and secrets.setSudoPassword -- the function that would
// normally write it -- authenticates against a live sudo first, which a test may never do.
const CRED_NAME = 'sukarfleet-sudo';

const ANCHOR = 'alpha';
const ROAMER = 'beta';
// TEST-NET-2, deliberately a DIFFERENT reserved range from the 192.0.2.x blackhole this file uses
// to simulate a peer that no longer routes. Sharing one range collapses the two into the same
// address and quietly turns the unreachable-peer test into a test of nothing.
const ANCHOR_MESH_IP = '198.51.100.1';
const ROAMER_MESH_IP = '198.51.100.2';

// ---------------------------------------------------------------------------
// Loud skips
// ---------------------------------------------------------------------------

// A silently skipped security test is worse than an absent one: it reads as coverage. Every
// capability this file cannot exercise on the box it is running on is announced on stderr, once,
// with the reason, in addition to bun's own skip marker.
const skipNotices: string[] = [];
function announceSkip(what: string, why: string): void {
  skipNotices.push(`${what} -- ${why}`);
}

// Probed at module load, matching tests/secrets.test.ts: `test.skipIf` is evaluated while the
// describe bodies run, which is before any hook, so this cannot live in beforeAll. The cheap
// `Bun.which` gate comes first because a real seal round trip costs several seconds of TPM time.
const HAS_SYSTEMD_CREDS = Bun.which('systemd-creds') !== null;
const SEAL = HAS_SYSTEMD_CREDS ? await secrets.sealAvailable() : { ok: false, reason: 'systemd-creds is not installed' };
if (!SEAL.ok) announceSkip('TPM2-sealed credential store', SEAL.reason ?? 'systemd-creds cannot seal on this machine');
announceSkip('live sudo authentication', 'no test may type a real sudo password; sudo is scripted at deps.runner');
announceSkip('real ssh to a peer', 'the ssh hop is delivered in-process to the peer node execLocal');

// A TPM2 seal plus the unseal the target leg performs is several seconds of hardware time on the
// fleet machines; the default 5 s per-test budget is not enough for the one test that does both.
const TPM_TEST_TIMEOUT_MS = 60_000;

// ---------------------------------------------------------------------------
// Log capture
// ---------------------------------------------------------------------------
//
// util.log writes through console.log, so this is the only place a log line can be intercepted.
// Captured rather than forwarded: the leak sweep reads these, and a passing run should be quiet.
// (Trade-off, stated: a failing test in this file loses its daemon log lines. `logLines` is dumped
// on the sweep's failure path so the interesting ones survive where they matter.)
const logLines: string[] = [];
const realConsoleLog = console.log;

// ---------------------------------------------------------------------------
// Node harness
// ---------------------------------------------------------------------------

interface CapturedResponse {
  node: string;
  method: string;
  path: string;
  status: number;
  body: string;
}

interface RunCall {
  argv: string[];
  opts: RunOptions;
}

type SudoScript = (argv: string[], opts: RunOptions) => RunResult;

interface NodeCtx {
  machine: string;
  dir: string;
  stateDir: string;
  configPath: string;
  cfg: FleetConfig;
  key: MachineKey;
  audit: AuditLog;
  sshAdmin: SshAdmin;
  pairing: Pairing;
  ui: UiRoutes;
  server: ReturnType<typeof Bun.serve>;
  port: number;
  origin: string;
  // Test-controlled seams.
  claimedAddress: string | null; // non-null => requests are reported as arriving from this address
  brokerMode: 'fake' | 'real'; // which credential broker SshAdmin's target leg reaches
  sudo: SudoScript;
  // Recorders, all read by the leak sweep.
  runCalls: RunCall[];
  sshPayloads: string[];
  credentialPostsReceived: string[];
}

const fleet = new Map<string, NodeCtx>();

// AuditLog resolves stateDir() from SUKARFLEET_STATE at call time and takes no path override, so two
// nodes in one process have to point the env at whichever one is appending. Serialized through a
// single chain: two interleaved appends would write one machine's entry into the other's log.
let auditGate: Promise<unknown> = Promise.resolve();

async function withNodeState<T>(ctx: NodeCtx, fn: () => Promise<T>): Promise<T> {
  const previous = process.env.SUKARFLEET_STATE;
  process.env.SUKARFLEET_STATE = ctx.stateDir;
  try {
    return await fn();
  } finally {
    if (previous === undefined) delete process.env.SUKARFLEET_STATE;
    else process.env.SUKARFLEET_STATE = previous;
  }
}

function gated<T>(fn: () => Promise<T>): Promise<T> {
  const task = auditGate.then(fn, fn);
  auditGate = task.then(
    () => {},
    () => {},
  );
  return task;
}

function appendAs(ctx: NodeCtx, kind: string, detail: Record<string, unknown>): Promise<AuditEntry> {
  return gated(() => withNodeState(ctx, () => ctx.audit.append(kind, detail)));
}

function readAudit(ctx: NodeCtx): Promise<AuditEntry[]> {
  return gated(() => withNodeState(ctx, () => ctx.audit.readAll()));
}

// The credential broker SshAdmin's target leg reaches. `fake` hands the callback the sentinel with no
// store and no TPM (the default, so most tests do not depend on either); `real` is src/secrets.ts
// itself, unmodified, reading whatever the test put in this node's store.
function brokerFor(ctx: NodeCtx): SudoBroker {
  const fake: SudoBroker = {
    withSudoPassword: async (_cfg, fn) => fn(SENTINEL_PASSWORD),
    markStale: async () => {},
    status: async () => ({ present: true, stale: false }),
  };
  return {
    withSudoPassword: (cfg, fn) =>
      ctx.brokerMode === 'real' ? secrets.withSudoPassword(cfg, fn) : fake.withSudoPassword(cfg, fn),
    markStale: (cfg, atMs) => (ctx.brokerMode === 'real' ? secrets.markStale(cfg, atMs) : fake.markStale(cfg, atMs)),
    status: async (cfg) => {
      if (ctx.brokerMode !== 'real') return fake.status(cfg);
      const s = await secrets.status(cfg);
      return { present: s.present, stale: s.stale };
    },
  };
}

function defaultSudo(argv: string[]): RunResult {
  // `sudo -v` with no `--` is the credential probe; anything after `--` is the operator's command.
  if (!argv.includes('--')) return { code: 0, stdout: '', stderr: '' };
  return { code: 0, stdout: STDOUT_MARKER, stderr: '' };
}

// The simulated ssh hop. Everything about it except the socket is the production path: the payload is
// whatever buildSshArgv put on the argv, and the response is whatever the peer's execLocal produced.
async function deliverOverSsh(origin: NodeCtx, argv: string[]): Promise<RunResult> {
  const payload = argv[argv.length - 1]!;
  const host = argv[argv.length - 2]!;
  origin.sshPayloads.push(payload);

  const target = [...fleet.values()].find((n) => n.cfg.meshIp === host);
  if (!target) {
    // ssh's own connect failure: 255 with nothing on stdout, which is the only shape the origin is
    // allowed to treat as "nothing ran over there".
    return { code: 255, stdout: '', stderr: `ssh: connect to host ${host} port 22: No route to host` };
  }
  const response = await target.sshAdmin.execLocal(payload);
  // sshd relays exactly what the forced command printed. cli.ts's `admin exec-local` must print this
  // one JSON line and nothing else -- a banner ahead of it is tolerated (the parser takes the last
  // non-empty line), a second object is not.
  return { code: 0, stdout: `${JSON.stringify(response)}\n`, stderr: '' };
}

function makeRunner(ctx: NodeCtx): typeof run {
  return (async (argv: string[], opts: RunOptions = {}): Promise<RunResult> => {
    ctx.runCalls.push({ argv: [...argv], opts });
    if (argv[0] === 'ssh') return deliverOverSsh(ctx, argv);
    if (argv[0] === 'sudo') return ctx.sudo(argv, opts);
    // ssh-keygen and anything else the lane shells out to genuinely runs: the keys these tests pin
    // and fingerprint are real keys, not strings shaped like keys.
    return run(argv, opts);
  }) as typeof run;
}

async function makeNode(machine: string, role: 'anchor' | 'roamer', meshIp: string): Promise<NodeCtx> {
  const dir = await mkdtemp(join(tmpdir(), `sukarfleet-int-${machine}-`));
  const stateDir = join(dir, 'state');
  const etcSsh = join(dir, 'etc-ssh');
  await mkdir(stateDir, { recursive: true });
  await mkdir(etcSsh, { recursive: true });

  const hostKey = await run(
    ['ssh-keygen', '-t', 'ed25519', '-N', '', '-C', `host-${machine}`, '-f', join(etcSsh, 'ssh_host_ed25519_key')],
    { timeoutMs: 30000 },
  );
  if (hostKey.code !== 0) throw new Error(`ssh-keygen (host key) failed: ${hostKey.stderr}`);

  const key = await loadOrCreateMachineKey(machine, { keyPath: join(dir, 'machine-key.json') });

  const cfg = defaultConfig(machine);
  cfg.role = role;
  cfg.meshIp = meshIp;
  cfg.peers = [];
  cfg.admin = {
    ...cfg.admin,
    enabled: true,
    acceptIncoming: true,
    // Must satisfy pairing.ts's SSH_USER_RE, which is deliberately narrower than POSIX.
    sshUser: 'sukarfleet',
    keyPath: join(dir, 'id_sukarfleet_ed25519'),
    knownHostsPath: join(stateDir, 'known_hosts'),
    authorizedKeysPath: join(dir, 'authorized_keys'),
    secretsDir: join(dir, 'secrets'),
    uiEnabled: true,
    // This file drives the lane end to end with an agent-stamped request, and its subject is the
    // lane's behaviour -- transport, refusals, the audit trail, credential handling -- not who is
    // allowed to originate. Stated explicitly rather than inherited, so the agent-origin gate does
    // not turn every scenario here into the same refusal. That gate has its own tests.
    agentOrigin: 'allow',
    // The rate limiter is L2's unit test. Here it would only make the scenario order-dependent.
    ratePerMin: 200,
  };

  const ctx = {
    machine,
    dir,
    stateDir,
    configPath: join(dir, 'config.json'),
    cfg,
    key,
    audit: new AuditLog(machine, key),
    claimedAddress: null,
    brokerMode: 'fake',
    sudo: defaultSudo,
    runCalls: [],
    sshPayloads: [],
    credentialPostsReceived: [],
  } as unknown as NodeCtx;

  ctx.sshAdmin = new SshAdmin({
    cfg,
    auditAppend: (kind, detail) => appendAs(ctx, kind, detail),
    peerView: (name): PeerView | null =>
      cfg.peers.some((p) => p.name === name)
        ? { name, lastSeenMs: nowMs(), lastEnvelope: null, online: true, syncStale: false }
        : null,
    now: nowMs,
    runner: makeRunner(ctx),
    secrets: brokerFor(ctx),
    publicKeyJwk: key.publicKeyJwk,
    sshHostKeyDir: etcSsh,
  });

  await ctx.sshAdmin.ensureSshIdentity();
  await writeFile(ctx.configPath, `${JSON.stringify(cfg, null, 2)}\n`, { mode: 0o600 });

  ctx.pairing = new Pairing({
    cfg,
    auditAppend: (kind, detail) => appendAs(ctx, kind, detail),
    localBundle: () => ctx.sshAdmin.localBundle(),
    applyPeer: (bundle) => applyPeer(ctx, bundle),
    now: nowMs,
  });

  ctx.ui = new UiRoutes(uiDeps(ctx));

  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch: async (req, srv) => {
      // node.ts decides locality from server.requestIP and nothing else, so overriding exactly that
      // is how a test models a request that arrived over the mesh without leaving loopback.
      const minimal: MinimalServer = {
        requestIP: (r) => (ctx.claimedAddress ? { address: ctx.claimedAddress } : srv.requestIP(r)),
      };
      const res = (await ctx.ui.handle(req, minimal)) ?? new Response('not found', { status: 404 });
      await captureResponse(ctx, req, res);
      return res;
    },
  });
  ctx.server = server;
  if (typeof server.port !== 'number') throw new Error('Bun.serve did not report a port');
  ctx.port = server.port;
  ctx.origin = `http://127.0.0.1:${server.port}`;
  // The GUI's CSRF guard and every peer bundle read this at call time, so it has to be the port the
  // socket actually got.
  cfg.nodePort = server.port;

  fleet.set(machine, ctx);
  return ctx;
}

const capturedResponses: CapturedResponse[] = [];

async function captureResponse(ctx: NodeCtx, req: Request, res: Response): Promise<void> {
  let body = '';
  try {
    body = await res.clone().text();
  } catch {
    body = '<unreadable>';
  }
  capturedResponses.push({
    node: ctx.machine,
    method: req.method,
    path: new URL(req.url).pathname,
    status: res.status,
    body,
  });
}

// Mirrors node.ts's applyPeer step for step: config.json through patchConfig (which validates before
// it writes), then the in-memory cfg.peers array every other consumer reads at call time, then the
// two SSH trust files. The one omitted step is syncer.ensureFleetRemotes, which needs adopted git
// repos this scenario has none of.
async function applyPeer(ctx: NodeCtx, bundle: PairBundle): Promise<void> {
  const merged = await patchConfig((raw) => {
    const peers = Array.isArray(raw.peers) ? [...(raw.peers as unknown[])] : [];
    const fields: Record<string, unknown> = {
      name: bundle.machine,
      meshIp: bundle.meshIp,
      nodePort: bundle.nodePort,
      publicKeyJwk: bundle.publicKeyJwk,
    };
    const at = peers.findIndex(
      (p) => typeof p === 'object' && p !== null && (p as Record<string, unknown>).name === bundle.machine,
    );
    if (at >= 0) peers[at] = { ...(peers[at] as Record<string, unknown>), ...fields };
    else peers.push(fields);
    raw.peers = peers;
  }, ctx.configPath);

  ctx.cfg.peers.length = 0;
  ctx.cfg.peers.push(...merged.peers);

  await ctx.sshAdmin.writeAuthorizedKey(bundle);
  await ctx.sshAdmin.pinHostKeys(bundle);
}

function uiDeps(ctx: NodeCtx): UiRoutesDeps {
  const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);
  return {
    cfg: ctx.cfg,
    isLoopback: (srv, req) => LOOPBACK.has(srv.requestIP(req)?.address ?? ''),
    buildState: async (): Promise<UiState> => {
      const status = await ctx.sshAdmin.status();
      const self = status.find((s) => s.self)!;
      return {
        v: 1,
        nowMs: nowMs(),
        self: {
          machine: ctx.cfg.machine,
          role: ctx.cfg.role,
          meshIp: ctx.cfg.meshIp,
          nodePort: ctx.cfg.nodePort,
          uptimeSec: 1,
        },
        peers: ctx.cfg.peers.map((p) => ({
          name: p.name,
          meshIp: p.meshIp,
          nodePort: p.nodePort,
          online: true,
          lastSeenMs: nowMs(),
          syncStale: false,
          paired: p.publicKeyJwk !== null,
          sshHost: p.sshHost ?? null,
          sshFallbackHost: p.sshFallbackHost ?? null,
        })),
        repos: [],
        faults: [],
        admin: {
          enabled: ctx.cfg.admin.enabled,
          acceptIncoming: ctx.cfg.admin.acceptIncoming,
          uiEnabled: ctx.cfg.admin.uiEnabled,
          configured: true,
          credentialPresent: self.credentialReady,
          credentialStale: self.credentialStale,
          credentialSealed: null,
          credentialSetAtMs: null,
          sshUser: ctx.cfg.admin.sshUser,
          sshKeyFingerprint: self.sshKeyFingerprint,
          runTimeoutSec: ctx.cfg.admin.runTimeoutSec,
          maxRunTimeoutSec: ctx.cfg.admin.maxRunTimeoutSec,
          ratePerMin: ctx.cfg.admin.ratePerMin,
          uiAssets: ctx.cfg.admin.uiAssets ?? true,
        },
        setup: {
          complete: ctx.cfg.peers.length > 0,
          identity: true,
          meshSecret: 'installed',
          credential: false,
          paired: ctx.cfg.peers.length > 0,
        },
        pairing: ctx.pairing.codeState(),
      };
    },
    secrets: {
      status: () => secrets.status(ctx.cfg),
      // Recording stub: the real setSudoPassword authenticates against a live sudo first, which no
      // test may do. What matters here is that the route HANDS the password on and reports a verdict
      // from the closed vocabulary -- the sweep proves nothing else happened to it.
      set: async (pw: string) => {
        ctx.credentialPostsReceived.push(pw);
        return { ok: false, reason: 'verify-failed', message: 'sudo rejected the credential' };
      },
      remove: () => secrets.removeSudoPassword(ctx.cfg),
      sealAvailable: () => secrets.sealAvailable(),
    },
    sshAdmin: ctx.sshAdmin,
    pairing: ctx.pairing,
    tailAudit: async (limit) => (await readAudit(ctx)).slice(-limit).reverse(),
    patchIdentity: async () => ({ ok: false, message: 'identity edits are not exercised here' }),
    networkSecret: {
      reveal: async () => null,
      stage: async () => {},
      generate: async () => 'not-exercised',
      state: async () => 'installed',
    },
    setLane: async (patch: { enabled?: boolean; acceptIncoming?: boolean }) => {
      if (patch.enabled !== undefined) ctx.cfg.admin.enabled = patch.enabled;
      if (patch.acceptIncoming !== undefined) ctx.cfg.admin.acceptIncoming = patch.acceptIncoming;
    },
    restartDaemon: async () => {
      throw new Error('restartDaemon must never be called from a test');
    },
  };
}

// ---------------------------------------------------------------------------
// HTTP helpers -- every call goes through the real routes, headers and all.
// ---------------------------------------------------------------------------

function guiPost(ctx: NodeCtx, path: string, body: unknown): Promise<Response> {
  return fetch(`${ctx.origin}${path}`, {
    method: 'POST',
    headers: {
      // Exactly what a browser attaches to a same-origin fetch, which is what rejectCrossSiteBrowser
      // exists to let through.
      origin: ctx.origin,
      'content-type': 'application/json',
      'sec-fetch-site': 'same-origin',
    },
    body: JSON.stringify(body),
  });
}

function guiGet(ctx: NodeCtx, path: string): Promise<Response> {
  return fetch(`${ctx.origin}${path}`, { headers: { origin: ctx.origin, 'sec-fetch-site': 'same-origin' } });
}

async function adminRun(ctx: NodeCtx, over: Partial<AdminRunRequest> = {}): Promise<AdminRunResult> {
  const req: AdminRunRequest = {
    machine: ANCHOR,
    argv: ['systemctl', 'is-active', 'easytier-fleet.service'],
    reason: 'integration test',
    requestedBy: { kind: 'agent', client: 'admin-integration.test.ts' },
    ...over,
  };
  return ctx.sshAdmin.runAdmin(req);
}

function detailsOfKind(entries: AuditEntry[], kind: string): Record<string, unknown>[] {
  return entries.filter((e) => e.kind === kind).map((e) => e.detail);
}

// ---------------------------------------------------------------------------
// Scenario setup: two nodes, paired through the GUI, used by every describe below.
// ---------------------------------------------------------------------------

let anchor: NodeCtx;
let roamer: NodeCtx;
let pairResult: { ok: boolean; peer?: string; reason?: string; message?: string };

beforeAll(async () => {
  console.log = (...args: unknown[]) => {
    logLines.push(args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' '));
  };

  anchor = await makeNode(ANCHOR, 'anchor', ANCHOR_MESH_IP);
  roamer = await makeNode(ROAMER, 'roamer', ROAMER_MESH_IP);

  // The pairing wizard, exactly as the GUI drives it: mint on the anchor, redeem on the roamer.
  const minted = await guiPost(anchor, '/api/ui/pair/code', {});
  const code = ((await minted.json()) as { display: string }).display;
  // On the real fleet this address is the peer's mesh IP. In-process both daemons listen on
  // loopback, so the address is loopback and the mesh IP still travels inside the bundle.
  const redeemed = await guiPost(roamer, '/api/ui/pair/redeem', {
    code,
    host: '127.0.0.1',
    port: anchor.port,
  });
  pairResult = (await redeemed.json()) as typeof pairResult;
});

afterAll(async () => {
  for (const ctx of fleet.values()) {
    ctx.sshAdmin.stop();
    ctx.server.stop(true);
  }
  console.log = realConsoleLog;
  if (skipNotices.length > 0) {
    console.warn(
      `\n[admin-integration] NOT covered on this machine:\n  - ${skipNotices.join('\n  - ')}\n` +
        '  These are environment limits, not passes. The live smoke in docs/RUNBOOK-P3.md covers them.\n',
    );
  }
  for (const ctx of fleet.values()) await rm(ctx.dir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Pairing
// ---------------------------------------------------------------------------

describe('pairing, driven through the GUI API', () => {
  test('one round trip leaves both machines holding each other', async () => {
    expect(pairResult.ok).toBe(true);
    expect(pairResult.peer).toBe(ANCHOR);

    // Live in memory on both sides -- gossip/gitserve/syncer read cfg.peers at call time, so this is
    // what "no restart needed" means.
    expect(anchor.cfg.peers.map((p) => p.name)).toEqual([ROAMER]);
    expect(roamer.cfg.peers.map((p) => p.name)).toEqual([ANCHOR]);

    // And durably, through the real patchConfig, in both config.json files.
    for (const [ctx, peerName] of [
      [anchor, ROAMER],
      [roamer, ANCHOR],
    ] as const) {
      const raw = JSON.parse(await readFile(ctx.configPath, 'utf8')) as { peers: Record<string, unknown>[] };
      const entry = raw.peers.find((p) => p.name === peerName);
      expect(entry).toBeDefined();
      expect((entry!.publicKeyJwk as JsonWebKey | null)?.kty).toBe('EC');
    }
  });

  test('the code is one-shot: it is burned by the exchange that used it', async () => {
    const state = (await (await guiGet(anchor, '/api/ui/pair/code')).json()) as {
      active: boolean;
      pairedWith?: string;
    };
    expect(state.active).toBe(false);
    expect(state.pairedWith).toBe(ROAMER);
  });

  test('each side wrote the other an authorized_keys grant it built itself', async () => {
    const anchorKeys = await readFile(anchor.cfg.admin.authorizedKeysPath, 'utf8');
    const roamerKeys = await readFile(roamer.cfg.admin.authorizedKeysPath, 'utf8');

    for (const [text, peer] of [
      [anchorKeys, ROAMER],
      [roamerKeys, ANCHOR],
    ] as const) {
      const lines = text.split('\n').filter((l) => l.trim().length > 0);
      expect(lines).toHaveLength(1);
      const line = lines[0]!;
      // `restrict` is the load-bearing token, and the forced command is the whole grant.
      expect(line).toContain(',restrict,command="');
      expect(line).toContain('admin exec-local');
      expect(line.trimEnd().endsWith(`# sukarfleet:${peer}`)).toBe(true);
      // The peer's own key, and only its key material -- no option text survived from the bundle.
      expect(line).toContain('ssh-ed25519 ');
    }

    // The anchor terminates the Cloudflare tunnel on its own loopback, so its from= has to admit it;
    // a roamer never does, and its from= stays a single mesh address (runbook residual 4).
    expect(anchorKeys).toContain(`from="${ROAMER_MESH_IP},127.0.0.1"`);
    expect(roamerKeys).toContain(`from="${ANCHOR_MESH_IP}"`);
    expect(roamerKeys).not.toContain('127.0.0.1');
  });

  test('each side pinned the other host keys, so StrictHostKeyChecking has something to check', async () => {
    for (const [ctx, peer, peerMeshIp] of [
      [anchor, roamer, ROAMER_MESH_IP],
      [roamer, anchor, ANCHOR_MESH_IP],
    ] as const) {
      const pinned = await readFile(ctx.cfg.admin.knownHostsPath, 'utf8');
      const peerHostKey = (await readFile(join(peer.dir, 'etc-ssh', 'ssh_host_ed25519_key.pub'), 'utf8')).trim();
      const blob = peerHostKey.split(' ')[1]!;
      expect(pinned).toContain(peerMeshIp);
      expect(pinned).toContain(blob);
      expect(pinned).toContain(`# sukarfleet:${peer.machine}`);
    }
  });

  test('both machines recorded the pairing, from their own side of it', async () => {
    const anchorPairs = detailsOfKind(await readAudit(anchor), 'pair-accepted');
    const roamerPairs = detailsOfKind(await readAudit(roamer), 'pair-accepted');

    expect(anchorPairs).toHaveLength(1);
    expect(roamerPairs).toHaveLength(1);
    expect(anchorPairs[0]).toMatchObject({ peerMachine: ROAMER, mode: 'responder' });
    expect(roamerPairs[0]).toMatchObject({ peerMachine: ANCHOR, mode: 'initiator' });
    // The detail is the pinned three fields; nothing about the code that authenticated the exchange.
    expect(Object.keys(anchorPairs[0]!).sort()).toEqual(['mode', 'peerMachine', 'sshKeyFingerprint']);
    expect(String(anchorPairs[0]!.sshKeyFingerprint)).toStartWith('SHA256:');
  });

  test('/pair/hello is the one route reachable from the mesh; the GUI API is not', async () => {
    roamer.claimedAddress = ANCHOR_MESH_IP;
    try {
      const state = await guiGet(roamer, '/api/ui/state');
      expect(state.status).toBe(403);

      // Same non-loopback caller, pairing endpoint: it answers (with its uniform 401, since no code
      // is live) rather than refusing on locality.
      const hello = await fetch(`${roamer.origin}/pair/hello`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ payload: { v: 1, from: {}, tsMs: Date.now() }, mac: 'x' }),
      });
      expect(hello.status).not.toBe(403);
    } finally {
      roamer.claimedAddress = null;
    }
  });
});

// ---------------------------------------------------------------------------
// Admin runs across the pair
// ---------------------------------------------------------------------------

describe('an admin run across the pair', () => {
  test('reaches the peer, returns its exit code, and both machines audit the same runId', async () => {
    const before = { anchor: (await readAudit(anchor)).length, roamer: (await readAudit(roamer)).length };
    const result = await adminRun(roamer);

    expect(result.ok).toBe(true);
    expect(result.exitCode).toBe(0);
    expect(result.transport).toBe('mesh');
    expect(result.stdout).toContain(STDOUT_MARKER);
    expect(result.refusal).toBeUndefined();

    const originEntries = (await readAudit(roamer)).slice(before.roamer);
    const targetEntries = (await readAudit(anchor)).slice(before.anchor);

    // Origin: requested before the dial, completed after. Target: its own completed leg.
    expect(originEntries.map((e) => e.kind)).toEqual(['admin-run-requested', 'admin-run-completed']);
    expect(targetEntries.map((e) => e.kind)).toEqual(['admin-run-completed']);

    const ids = new Set([...originEntries, ...targetEntries].map((e) => String(e.detail.runId)));
    expect(ids).toEqual(new Set([result.runId]));
    // Each leg names the machine on the other end of it, so the union file reads as a pair.
    expect(originEntries[0]!.detail.targetMachine).toBe(ANCHOR);
    expect(targetEntries[0]!.detail.originMachine).toBe(ROAMER);
  });

  test('the target actually ran sudo with the verified flag form and exactly one password line', async () => {
    anchor.runCalls.length = 0;
    await adminRun(roamer, { argv: ['id'], reason: 'sudo argv shape' });

    const sudoCalls = anchor.runCalls.filter((c) => c.argv[0] === 'sudo');
    expect(sudoCalls).toHaveLength(2); // the -v probe, then the command: sudo-rs reads stdin once per process
    expect(sudoCalls[0]!.argv).toEqual(['sudo', '-S', '-k', '-p', '', '-v']);
    expect(sudoCalls[1]!.argv).toEqual(['sudo', '-S', '-k', '-p', '', '--', 'id']);
    for (const call of sudoCalls) {
      expect(call.opts.stdin).toBe(`${SENTINEL_PASSWORD}\n`);
      expect(String(call.opts.stdin).split('\n').filter((l) => l.length > 0)).toHaveLength(1);
    }

    // And the hop that crossed the wire carried no stdin at all: there is no credential to send.
    const sshCall = roamer.runCalls.find((c) => c.argv[0] === 'ssh');
    expect(sshCall).toBeDefined();
    expect(sshCall!.opts.stdin).toBeUndefined();
  });

  test('a nonzero exit code comes back as an exit code, never as a refusal', async () => {
    anchor.sudo = (argv) =>
      argv.includes('--') ? { code: 3, stdout: '', stderr: 'Unit not found.' } : { code: 0, stdout: '', stderr: '' };
    try {
      const result = await adminRun(roamer, { argv: ['systemctl', 'is-active', 'nope.service'] });
      expect(result.exitCode).toBe(3);
      expect(result.ok).toBe(false);
      expect(result.refusal).toBeUndefined();
      expect(result.stderr).toContain('Unit not found.');
    } finally {
      anchor.sudo = defaultSudo;
    }
  });

  test('the truncation flag survives the target leg, the envelope and the origin', async () => {
    anchor.sudo = (argv, opts) => {
      if (!argv.includes('--')) return { code: 0, stdout: '', stderr: '' };
      const cap = opts.maxCaptureBytes ?? Infinity;
      expect(cap).toBe(anchor.cfg.admin.maxOutputBytes); // the cap comes from config, not from the caller
      return { code: 0, stdout: 'x'.repeat(64), stderr: '', truncated: true };
    };
    try {
      const result = await adminRun(roamer, { argv: ['bash', '-c', 'yes | head -c 4000000'] });
      expect(result.truncated).toBe(true);
      expect(result.exitCode).toBe(0); // truncating output must not cost the exit code
      expect(roamer.sshAdmin.getRun(result.runId)?.truncated).toBe(true);
    } finally {
      anchor.sudo = defaultSudo;
    }
  });

  test('a run against this machine skips ssh but hits the same target-side gates', async () => {
    const result = await adminRun(roamer, { machine: ROAMER, argv: ['id'], reason: 'self run' });
    expect(result.transport).toBe('local');
    expect(result.exitCode).toBe(0);
    expect(roamer.runCalls.filter((c) => c.argv[0] === 'ssh' && c.argv.includes(ROAMER_MESH_IP))).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Refusals
// ---------------------------------------------------------------------------

describe('refusals surface with the reason that caused them', () => {
  test('no credential on the target refuses the run, and nothing executes', async () => {
    // The real credential module against an empty store: this is the refusal a machine gives before
    // anyone has been to the Credentials screen.
    anchor.brokerMode = 'real';
    anchor.runCalls.length = 0;
    const before = (await readAudit(anchor)).length;
    try {
      const result = await adminRun(roamer, { argv: ['id'], reason: 'no credential yet' });

      expect(result.refusal).toBe('no-credential');
      expect(result.exitCode).toBeNull();
      expect(result.ok).toBe(false);
      expect(anchor.runCalls.filter((c) => c.argv[0] === 'sudo')).toHaveLength(0);

      // Refused, not completed, on BOTH machines: nothing ran, so a completed leg would be a lie.
      const targetEntries = (await readAudit(anchor)).slice(before);
      expect(targetEntries.map((e) => e.kind)).toEqual(['admin-run-refused']);
      expect(targetEntries[0]!.detail.refusal).toBe('no-credential');
      const originEntries = await readAudit(roamer);
      expect(originEntries.at(-1)!.kind).toBe('admin-run-refused');
      expect(originEntries.at(-1)!.detail.refusal).toBe('no-credential');

      // The message names the state, never the store contents or an underlying error.
      expect(result.message).toBeString();
      expect(result.message).not.toContain(anchor.cfg.admin.secretsDir);
    } finally {
      anchor.brokerMode = 'fake';
    }
  });

  test('an empty reason is refused by the origin before anything is dialled', async () => {
    roamer.runCalls.length = 0;
    const result = await adminRun(roamer, { reason: '   ' });
    expect(result.refusal).toBe('missing-reason');
    expect(roamer.runCalls.filter((c) => c.argv[0] === 'ssh')).toHaveLength(0);
  });

  test('a machine nobody paired with is not-paired, not unreachable', async () => {
    const result = await adminRun(roamer, { machine: 'never-paired' });
    expect(result.refusal).toBe('not-paired');
    expect(result.exitCode).toBeNull();
  });

  test('malformed argv never reaches a subprocess on either machine', async () => {
    anchor.runCalls.length = 0;
    const result = await adminRun(roamer, { argv: [] });
    expect(result.refusal).toBe('bad-argv');
    expect(anchor.runCalls).toHaveLength(0);
  });

  test('the target credential-store tripwire refuses and records the attempt', async () => {
    const before = (await readAudit(anchor)).length;
    anchor.runCalls.length = 0;
    const result = await adminRun(roamer, {
      argv: ['systemd-creds', 'decrypt', '--name=sukarfleet-sudo', '-', '-'],
      reason: 'extraction attempt',
    });

    expect(result.refusal).toBe('refused-argv');
    expect(anchor.runCalls.filter((c) => c.argv[0] === 'sudo')).toHaveLength(0);

    const refused = (await readAudit(anchor)).slice(before);
    expect(refused.map((e) => e.kind)).toEqual(['admin-run-refused']);
    // The full argv is recorded: an extraction attempt is exactly the entry that has to be readable
    // six months later.
    expect(refused[0]!.detail.argv).toEqual(['systemd-creds', 'decrypt', '--name=sukarfleet-sudo', '-', '-']);
  });

  test('a target that is not accepting incoming runs says so, and runs nothing', async () => {
    // The switch the Credentials screen flips, through the real route.
    const res = await guiPost(anchor, '/api/ui/admin/lane', { acceptIncoming: false });
    expect(res.status).toBe(200);
    anchor.runCalls.length = 0;
    try {
      const result = await adminRun(roamer, { argv: ['id'], reason: 'lane closed' });
      expect(result.refusal).toBe('lane-disabled-target');
      expect(anchor.runCalls.filter((c) => c.argv[0] === 'sudo')).toHaveLength(0);
    } finally {
      await guiPost(anchor, '/api/ui/admin/lane', { acceptIncoming: true });
    }
    expect(anchor.cfg.admin.acceptIncoming).toBe(true);
  });

  test('a disabled origin lane refuses locally, and never dials', async () => {
    roamer.cfg.admin.enabled = false;
    roamer.runCalls.length = 0;
    const before = (await readAudit(roamer)).length;
    try {
      const result = await adminRun(roamer, { argv: ['id'], reason: 'origin lane off' });
      expect(result.refusal).toBe('lane-disabled-local');
      expect(roamer.runCalls.filter((c) => c.argv[0] === 'ssh')).toHaveLength(0);
      // Current behavior, pinned so a change is visible: a refusal raised BEFORE the dial is
      // recorded nowhere. See the todo below -- this is a gap, not the intended contract.
      expect((await readAudit(roamer)).slice(before)).toEqual([]);
    } finally {
      roamer.cfg.admin.enabled = true;
    }
  });

  test('an unreachable peer is a connect failure, never a silently retried command', async () => {
    // The peer's mesh address no longer routes to a node, which is the only shape the origin may
    // treat as "nothing ran over there".
    const peer = roamer.cfg.peers.find((p) => p.name === ANCHOR)!;
    peer.sshHost = '192.0.2.1';
    try {
      const result = await adminRun(roamer, { argv: ['id'], reason: 'blackholed peer' });
      expect(result.refusal).toBe('unreachable');
      expect(result.exitCode).toBeNull();
      expect(result.transport).toBeNull();
      // No fallback host is configured, so a connect failure is terminal: exactly one dial.
      const dials = roamer.runCalls.filter((c) => c.argv[0] === 'ssh' && c.argv.includes('192.0.2.1'));
      expect(dials).toHaveLength(1);
    } finally {
      peer.sshHost = null;
    }
  });

  test('the GUI run route hands every semantic turndown to the lane, not to a 400', async () => {
    const res = await guiPost(roamer, '/api/ui/admin/run', {
      machine: ANCHOR,
      argv: ['id'],
      reason: '', // uiserve.ts deliberately does not 400 this; the lane owns the turndown
    });
    expect(res.status).toBe(200);
    const { runId } = (await res.json()) as { runId: string };

    // The registry-backed path: the GUI polls the run it was given an id for.
    await Bun.sleep(50);
    const view = (await (await guiGet(roamer, `/api/ui/admin/run/${runId}`)).json()) as {
      refusal?: string;
      running: boolean;
    };
    expect(view.refusal).toBe('missing-reason');
    expect(view.running).toBe(false);
  });

  // FINDING, reported rather than fixed (this lane owns tests only). sshadmin.ts's executeInner
  // returns from `stopped`, validateRequest (bad-argv / missing-reason), `!admin.enabled` and the
  // rate limiter BEFORE it appends admin-run-requested, and the admin-run-refused append sits after
  // that point -- so an origin-side pre-dial refusal is signed into no log at all. That contradicts
  // refuse()'s own comment in sshadmin.ts ("that is what tells executeInner to append
  // admin-run-refused"), uiserve.ts's postRun comment ("sshadmin.ts ... refuses it AND writes the
  // admin-run-refused audit entry. A 400 here would lose that record"), and plan acceptance 1.7.
  // Refusals raised at or after the dial ARE audited on both machines -- the tests above cover them.
  // The body asserts the INTENDED contract, so the day sshadmin.ts closes the gap this todo starts
  // passing and bun says so -- which is the signal to promote it to a real test.
  test.todo('the origin audits its own pre-dial refusals', async () => {
    const before = (await readAudit(roamer)).length;
    await adminRun(roamer, { argv: [], reason: 'a bad-argv refusal is still a refusal' });
    expect((await readAudit(roamer)).slice(before).map((e) => e.kind)).toEqual(['admin-run-refused']);
  });
});

// ---------------------------------------------------------------------------
// The audit content contract
// ---------------------------------------------------------------------------

describe('what the audit log is allowed to contain', () => {
  test('every admin entry records the full argv and byte counts, never output content', async () => {
    const entries = [...(await readAudit(anchor)), ...(await readAudit(roamer))].filter((e) =>
      e.kind.startsWith('admin-run-'),
    );
    expect(entries.length).toBeGreaterThan(6);

    for (const entry of entries) {
      const detail = entry.detail as Record<string, unknown>;
      // Content rule 1: the argv is there, whole.
      expect(Array.isArray(detail.argv)).toBe(true);
      // Content rule 2: byte counts only. No key that could carry output, and no output in the blob.
      expect(detail).not.toHaveProperty('stdout');
      expect(detail).not.toHaveProperty('stderr');
      expect(detail).not.toHaveProperty('output');
      expect(JSON.stringify(detail)).not.toContain(STDOUT_MARKER);
      if (entry.kind === 'admin-run-completed') {
        expect(typeof detail.stdoutBytes).toBe('number');
        expect(typeof detail.stderrBytes).toBe('number');
      }
    }
  });

  test('the union of both logs cross-checks clean', async () => {
    // Everything both machines wrote, assembled the way the synced union file assembles it.
    const entries = [...(await readAudit(anchor)), ...(await readAudit(roamer))];
    const report = await crossCheckAuditLog(entries, {
      nowMs: nowMs(),
      publicKeyJwkByMachine: {
        [ANCHOR]: anchor.key.publicKeyJwk,
        [ROAMER]: roamer.key.publicKeyJwk,
      },
    });
    expect(report.flags).toEqual([]);
  });

  test('every completed run is matched by a requested leg on the origin', async () => {
    const all = [...(await readAudit(anchor)), ...(await readAudit(roamer))];
    const requested = new Set(
      all.filter((e) => e.kind === 'admin-run-requested').map((e) => String(e.detail.runId)),
    );
    const completed = all.filter((e) => e.kind === 'admin-run-completed');
    expect(completed.length).toBeGreaterThan(0);
    for (const entry of completed) {
      // A completed leg whose runId no origin ever asked for is the discrepancy this split exists to
      // make visible.
      expect(requested.has(String(entry.detail.runId))).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// The real credential store
// ---------------------------------------------------------------------------

// Writes a store the real withSudoPassword will read. secrets.setSudoPassword is the production
// writer and it authenticates against a live sudo first, which a test may never do -- so the two
// files it would have produced are written here directly, in its documented shape.
async function seedStore(ctx: NodeCtx, stored: string, sealed: SealScope | 'plaintext'): Promise<void> {
  await secrets.assertPrivateStore(ctx.cfg);
  await writeSecretFile(join(ctx.cfg.admin.secretsDir, 'sudo.cred'), stored);
  await writeSecretFile(
    join(ctx.cfg.admin.secretsDir, 'sudo.meta.json'),
    JSON.stringify({
      user: 'sukarfleet',
      setAtMs: Date.now(),
      lastUsedMs: null,
      lastFailureMs: null,
      stale: false,
      sealed,
    }),
  );
}

describe('the real credential broker on the target leg', () => {
  test('an unsealed store round-trips through withSudoPassword and the output is scrubbed', async () => {
    // allowPlaintextFallback exists so a machine with no working TPM fails loudly rather than
    // downgrading silently; flipping it here is what makes the real broker reachable with no TPM.
    anchor.cfg.admin.allowPlaintextFallback = true;
    anchor.brokerMode = 'real';
    await seedStore(anchor, SENTINEL_PASSWORD, 'plaintext');

    // A command that echoes its own stdin is the careless-operator path by which a credential would
    // otherwise reach an HTTP body. secrets.withSudoPassword redacts it at the boundary.
    anchor.sudo = (argv, opts) =>
      argv.includes('--')
        ? { code: 0, stdout: `echoed: ${String(opts.stdin ?? '')}`, stderr: '', truncated: false }
        : { code: 0, stdout: '', stderr: '' };

    try {
      const result = await adminRun(roamer, { argv: ['cat'], reason: 'unsealed store round trip' });

      expect(result.exitCode).toBe(0);
      // The real broker unsealed the store and fed sudo exactly one line of it.
      const sudoCalls = anchor.runCalls.filter((c) => c.argv[0] === 'sudo').slice(-2);
      expect(sudoCalls[1]!.opts.stdin).toBe(`${SENTINEL_PASSWORD}\n`);
      // And what came back the other way carries no trace of it.
      expect(result.stdout).toContain('echoed:');
      expect(result.stdout).not.toContain(SENTINEL_PASSWORD);
      expect(result.stdout).toContain('[redacted]');
    } finally {
      anchor.sudo = defaultSudo;
      anchor.brokerMode = 'fake';
      anchor.cfg.admin.allowPlaintextFallback = false;
    }
  });

  test('a store that unseals but whose password sudo rejects goes stale, and the command never runs', async () => {
    anchor.cfg.admin.allowPlaintextFallback = true;
    anchor.brokerMode = 'real';
    await seedStore(anchor, SENTINEL_PASSWORD, 'plaintext');

    const commands: string[][] = [];
    anchor.sudo = (argv) => {
      commands.push(argv);
      // The probe fails, which is what a rotated password looks like from here.
      return { code: 1, stdout: '', stderr: '' };
    };

    try {
      const result = await adminRun(roamer, { argv: ['id'], reason: 'rotated password' });
      expect(result.refusal).toBe('credential-stale');
      expect(result.exitCode).toBeNull();
      // Exactly one sudo process: the probe. The command itself was never reached.
      expect(commands).toHaveLength(1);
      expect(commands[0]).toEqual(['sudo', '-S', '-k', '-p', '', '-v']);

      // And the store is latched stale, so the next call refuses before touching sudo again -- this
      // is the loop that would otherwise lock the account.
      const status = await secrets.status(anchor.cfg);
      expect(status.stale).toBe(true);
      const second = await adminRun(roamer, { argv: ['id'], reason: 'second attempt after staleness' });
      expect(second.refusal).toBe('credential-stale');
      expect(commands).toHaveLength(1);
    } finally {
      anchor.sudo = defaultSudo;
      anchor.brokerMode = 'fake';
      anchor.cfg.admin.allowPlaintextFallback = false;
      await secrets.removeSudoPassword(anchor.cfg);
      await secrets.clearStale(anchor.cfg);
    }
  });

  // Real sealing, in whichever scope this machine actually supports (system-scope tpm2 is refused
  // for an unprivileged uid on the fleet machines; --user round-trips). Skipped, loudly, on a box
  // where systemd-creds cannot seal at all -- see the banner afterAll prints and the notice at the
  // top of this file.
  test.skipIf(!SEAL.ok)(
    'a sealed store unseals on the target and nothing else sees it',
    async () => {
      const sealArgs = SEAL.scope === 'tpm2' ? ['--with-key=tpm2'] : ['--user'];
      const sealed = Bun.spawn(['systemd-creds', 'encrypt', ...sealArgs, `--name=${CRED_NAME}`, '-', '-'], {
        stdin: new TextEncoder().encode(SENTINEL_PASSWORD),
        stdout: 'pipe',
        stderr: 'pipe',
      });
      const blob = await new Response(sealed.stdout).text();
      expect(await sealed.exited).toBe(0);
      expect(blob.length).toBeGreaterThan(0);
      // The sealed blob is not the password, and could not be mistaken for it.
      expect(blob).not.toContain(SENTINEL_PASSWORD);

      anchor.brokerMode = 'real';
      await seedStore(anchor, blob, SEAL.scope ?? 'user');
      try {
        const result = await adminRun(roamer, { argv: ['id'], reason: 'sealed store' });
        expect(result.exitCode).toBe(0);
        const sudoCalls = anchor.runCalls.filter((c) => c.argv[0] === 'sudo').slice(-2);
        // The unseal produced the original plaintext, and it went nowhere but sudo's stdin.
        expect(sudoCalls[1]!.opts.stdin).toBe(`${SENTINEL_PASSWORD}\n`);
        expect((await secrets.status(anchor.cfg)).sealed).toBe(SEAL.scope ?? 'user');
      } finally {
        anchor.brokerMode = 'fake';
        await secrets.removeSudoPassword(anchor.cfg);
      }
    },
    TPM_TEST_TIMEOUT_MS,
  );

  test('the credential POST route hands the password on and echoes nothing back', async () => {
    const res = await guiPost(anchor, '/api/ui/credentials/sudo', { password: SENTINEL_PASSWORD });
    const body = await res.text();

    expect(anchor.credentialPostsReceived.at(-1)).toBe(SENTINEL_PASSWORD);
    expect(res.status).toBe(200);
    // A verdict from the closed vocabulary, and nothing else. Not the password, not its length, not
    // the store's own message.
    expect(JSON.parse(body)).toEqual({ ok: false, reason: 'verify-failed' });
    expect(body).not.toContain(SENTINEL_PASSWORD);
    expect(body).not.toContain(String(SENTINEL_PASSWORD.length));
  });
});

// ---------------------------------------------------------------------------
// The leak sweep -- last, so it sees everything every test above produced.
// ---------------------------------------------------------------------------

interface Hit {
  sink: string;
  where: string;
}

async function filesUnder(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const name of await readdir(dir)) {
    const path = join(dir, name);
    const st = await stat(path);
    if (st.isDirectory()) out.push(...(await filesUnder(path)));
    else if (st.isFile()) out.push(path);
  }
  return out;
}

// ---------------------------------------------------------------------------
// The port-forwarded GUI
// ---------------------------------------------------------------------------

describe('the GUI drives the machine it was served from', () => {
  // The documented remote-admin flow is `ssh -N -L 7711:127.0.0.1:7710 <machine>`. In a tab on the
  // forwarded port, one absolute URL in app.js silently redirects that click to the LOCAL daemon --
  // the operator reads the remote machine's name in the header and roots the wrong box. This is the
  // worst failure this design can have, so it is pinned as a property of the shipped files.
  const uiDir = join(import.meta.dir, '..', 'ui');

  test('ui/app.js contains no absolute URL, in code or in a comment', async () => {
    const source = await readFile(join(uiDir, 'app.js'), 'utf8');
    const offenders = source
      .split('\n')
      .map((line, i) => [i + 1, line] as const)
      .filter(([, line]) => /https?:\/\//.test(line));
    // Comments are included deliberately: a commented-out absolute URL is the seed of the next one.
    expect(offenders).toEqual([]);
  });

  test('ui/index.html loads nothing off-box', async () => {
    const html = await readFile(join(uiDir, 'index.html'), 'utf8');
    expect(html).not.toMatch(/https?:\/\//);
    // Every src/href is either a root-relative path or an in-page fragment. A scheme-relative `//`
    // would inherit the page's scheme and leave the box, which is the same failure as an absolute
    // URL wearing a different hat.
    for (const attr of html.matchAll(/(?:src|href)="([^"]*)"/g)) {
      const value = attr[1]!;
      expect(value.startsWith('//')).toBe(false);
      expect(value.startsWith('/') || value.startsWith('#')).toBe(true);
    }
  });

  test('ui/style.css fetches no font and no remote asset', async () => {
    const css = await readFile(join(uiDir, 'style.css'), 'utf8');
    expect(css).not.toMatch(/https?:\/\//);
    expect(css).not.toContain('@import');
  });
});

describe('leak sweep', () => {
  test('the sentinel password appears in no sink the scenario produced', async () => {
    const hits: Hit[] = [];

    // 1. Every audit entry both machines wrote, and the raw JSONL bytes on disk.
    for (const ctx of fleet.values()) {
      for (const entry of await readAudit(ctx)) {
        if (JSON.stringify(entry).includes(SENTINEL_PASSWORD)) {
          hits.push({ sink: 'audit-entry', where: `${entry.machine}#${entry.seq} ${entry.kind}` });
        }
      }
    }

    // 2. Every HTTP response body either daemon produced, including the credential POST's.
    for (const res of capturedResponses) {
      if (res.body.includes(SENTINEL_PASSWORD)) {
        hits.push({ sink: 'http-response', where: `${res.node} ${res.method} ${res.path} -> ${res.status}` });
      }
    }

    // 3. Every log line either daemon emitted for the whole run.
    for (const [i, line] of logLines.entries()) {
      if (line.includes(SENTINEL_PASSWORD)) hits.push({ sink: 'log-line', where: `line ${i}` });
    }

    // 4. The in-memory run registry, which the GUI polls and which survives between runs.
    for (const ctx of fleet.values()) {
      for (const view of ctx.sshAdmin.listRuns(100)) {
        if (JSON.stringify(view).includes(SENTINEL_PASSWORD)) {
          hits.push({ sink: 'run-registry', where: `${ctx.machine} ${view.runId}` });
        }
      }
    }

    // 5. Every payload that crossed the simulated wire. Decoded, because base64 hides a substring.
    for (const ctx of fleet.values()) {
      for (const payload of ctx.sshPayloads) {
        const decoded = Buffer.from(payload, 'base64').toString('utf8');
        if (payload.includes(SENTINEL_PASSWORD) || decoded.includes(SENTINEL_PASSWORD)) {
          hits.push({ sink: 'exec-local-payload', where: `${ctx.machine} -> peer` });
        }
      }
    }

    // 6. Every file either node wrote: config.json, authorized_keys, known_hosts, the audit log, the
    //    seq file, the key files, and the credential store.
    for (const ctx of fleet.values()) {
      for (const path of await filesUnder(ctx.dir)) {
        const text = await readFile(path, 'utf8').catch(() => '');
        if (text.includes(SENTINEL_PASSWORD)) {
          hits.push({ sink: 'file', where: `${ctx.machine}:${relative(ctx.dir, path)}` });
        }
      }
    }

    if (hits.length > 0) {
      // The sweep is the acceptance gate for the whole lane, so a failure has to say exactly where.
      realConsoleLog(`leak sweep hits:\n${hits.map((h) => `  ${h.sink}: ${h.where}`).join('\n')}`);
      realConsoleLog(`captured log lines:\n${logLines.join('\n')}`);
    }
    expect(hits).toEqual([]);
  });

  test('the sweep can actually see the sinks it claims to cover', async () => {
    // A sweep over empty arrays passes for the wrong reason. This pins that the scenario really did
    // produce every sink, so the assertion above means something.
    expect(capturedResponses.length).toBeGreaterThan(10);
    expect(logLines.length).toBeGreaterThan(5);
    expect([...fleet.values()].some((c) => c.sshPayloads.length > 0)).toBe(true);
    expect(roamer.sshAdmin.listRuns(100).length).toBeGreaterThan(5);
    expect(anchor.credentialPostsReceived).toContain(SENTINEL_PASSWORD); // the password really was in play
    for (const ctx of fleet.values()) {
      expect((await readAudit(ctx)).length).toBeGreaterThan(2);
      expect((await filesUnder(ctx.dir)).length).toBeGreaterThan(4);
      // And the sweep would have caught a plant: same reader, a value that IS there.
      const files = await filesUnder(ctx.dir);
      const anyText = await Promise.all(files.map((f) => readFile(f, 'utf8').catch(() => '')));
      expect(anyText.some((t) => t.includes('sukarfleet'))).toBe(true);
    }
  });

  test('the credential store on disk is 0600 inside a 0700 directory', async () => {
    // Nothing is left in the store by the tests above, so this asserts the property the store had
    // while it existed: assertPrivateStore created the directory, and writeSecretFile the files.
    const dirStat = await stat(anchor.cfg.admin.secretsDir);
    expect(dirStat.mode & 0o777).toBe(0o700);

    await seedStore(anchor, 'throwaway-not-the-sentinel', 'plaintext');
    try {
      const credStat = await stat(join(anchor.cfg.admin.secretsDir, 'sudo.cred'));
      const metaStat = await stat(join(anchor.cfg.admin.secretsDir, 'sudo.meta.json'));
      expect(credStat.mode & 0o777).toBe(0o600);
      expect(metaStat.mode & 0o777).toBe(0o600);
    } finally {
      await secrets.removeSudoPassword(anchor.cfg);
    }
  });
});
