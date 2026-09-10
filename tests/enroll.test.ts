// SPDX-License-Identifier: AGPL-3.0-or-later
// Tests for console-generated one-click enrollment: the token store (src/enroll.ts), the mesh
// address allocator (src/meshalloc.ts), the rendered installer (src/installer.ts), and the second
// credential /pair/hello now accepts (src/pairing.ts).
//
// Nothing here is mocked except the clock and the RNG. The store writes and re-reads a real file,
// the MACs are real WebCrypto, and the enrollment hello goes through the same handleHello a peer on
// the mesh would reach.
//
// The load-bearing assertions are the refusals: a token is single use, it is bound to the identity
// it was minted for, and every rejection is the same 401 as every other one.

import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  Enrollments,
  ENROLL_TTL_MS,
  deriveEnrollKey,
  deriveEnrollKeyBytes,
} from '../src/enroll';
import { EnrollmentIssuer, archiveUrlFor, installerFileName, renderWindowsInstaller } from '../src/installer';
import type { InstallerPayload } from '../src/installer';
import { allocateMeshIp, subnetOf } from '../src/meshalloc';
import { Pairing, macRequest } from '../src/pairing';
import type { PairingDeps } from '../src/pairing';
import { defaultConfig } from '../src/config';
import { canonicalJson } from '../src/util';
import type { AuditEntry, FleetConfig, PairBundle, PeerConfig } from '../src/types';

const START_MS = 1_700_000_000_000;

const tempDirs: string[] = [];
function scratch(): string {
  const dir = mkdtempSync(join(tmpdir(), 'sukarfleet-enroll-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tempDirs.length) {
    const dir = tempDirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

// A counter-based RNG: every mint gets distinct bytes, and the same test run gets the same ones
// twice, so a failure is reproducible rather than a one-in-a-billion story.
function seqRand(): (n: number) => Uint8Array {
  let seed = 1;
  return (n: number) => {
    const out = new Uint8Array(n);
    for (let i = 0; i < n; i++) out[i] = (seed * 31 + i * 7) & 0xff;
    seed++;
    return out;
  };
}

interface StoreHarness {
  enrollments: Enrollments;
  audits: { kind: string; detail: Record<string, unknown> }[];
  path: string;
  advance: (ms: number) => void;
  now: () => number;
}

function storeHarness(dir = scratch()): StoreHarness {
  const audits: { kind: string; detail: Record<string, unknown> }[] = [];
  let clock = START_MS;
  const path = join(dir, 'enrollments.json');
  return {
    path,
    audits,
    now: () => clock,
    advance: (ms) => {
      clock += ms;
    },
    enrollments: new Enrollments({
      auditAppend: async (kind, detail) => {
        audits.push({ kind, detail });
        return { ok: true };
      },
      path,
      now: () => clock,
      rand: seqRand(),
    }),
  };
}

function mintInput(machine = 'newbox', meshIp = '192.0.2.9') {
  return {
    machine,
    meshIp,
    nodePort: 7710,
    role: 'roamer' as const,
    platform: 'windows' as const,
    installerPath: `/tmp/Add-${machine}-To-Fleet.cmd`,
  };
}

// ---------------------------------------------------------------------------
// The token store
// ---------------------------------------------------------------------------

describe('enrollment tokens', () => {
  test('a minted token is 256 bits of base64url and is returned exactly once', async () => {
    const h = storeHarness();
    const minted = await h.enrollments.mint(mintInput());
    expect('error' in minted).toBe(false);
    if ('error' in minted) return;

    // 32 bytes, base64url, unpadded.
    expect(minted.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(minted.view.state).toBe('live');
    expect(minted.view.expiresMs).toBe(START_MS + ENROLL_TTL_MS);

    // The list is the only way back to an enrollment, and it never carries the token or the key.
    const listed = await h.enrollments.list();
    expect(listed).toHaveLength(1);
    expect(JSON.stringify(listed[0])).not.toContain(minted.token);
    expect(Object.keys(listed[0]!)).not.toContain('keyB64');
  });

  test('the token is never written to disk -- only the key derived from it', async () => {
    const h = storeHarness();
    const minted = await h.enrollments.mint(mintInput());
    if ('error' in minted) throw new Error('mint refused');

    const onDisk = await Bun.file(h.path).text();
    expect(onDisk).not.toContain(minted.token);
    // What IS there is the derivation, which is what a responder needs to check a MAC.
    expect(onDisk).toContain(Buffer.from(deriveEnrollKeyBytes(minted.token)).toString('base64'));
  });

  test('the state file is 0600', async () => {
    const h = storeHarness();
    await h.enrollments.mint(mintInput());
    expect(statSync(h.path).mode & 0o777).toBe(0o600);
  });

  test('lookup finds a live token and refuses a used, revoked or expired one', async () => {
    const h = storeHarness();
    const minted = await h.enrollments.mint(mintInput());
    if ('error' in minted) throw new Error('mint refused');
    const id = minted.view.id;

    expect(await h.enrollments.lookup(id)).not.toBeNull();

    expect(await h.enrollments.burn(id, 'newbox')).toBe(true);
    expect(await h.enrollments.lookup(id)).toBeNull();
    // The row survives as history rather than vanishing, so the console can say what happened.
    expect((await h.enrollments.list())[0]!.state).toBe('used');
    expect((await h.enrollments.list())[0]!.usedBy).toBe('newbox');
  });

  test('burn is a compare-and-set: two redeems of one token give one success', async () => {
    const h = storeHarness();
    const minted = await h.enrollments.mint(mintInput());
    if ('error' in minted) throw new Error('mint refused');

    const both = await Promise.all([
      h.enrollments.burn(minted.view.id, 'first'),
      h.enrollments.burn(minted.view.id, 'second'),
    ]);
    expect(both.filter(Boolean)).toHaveLength(1);
  });

  test('a token expires on its own, without anything running a timer', async () => {
    const h = storeHarness();
    const minted = await h.enrollments.mint(mintInput());
    if ('error' in minted) throw new Error('mint refused');

    h.advance(ENROLL_TTL_MS + 1);
    expect(await h.enrollments.lookup(minted.view.id)).toBeNull();
    expect((await h.enrollments.list())[0]!.state).toBe('expired');
    expect(await h.enrollments.burn(minted.view.id, 'newbox')).toBe(false);
  });

  test('revoke closes a live token and refuses one already spent', async () => {
    const h = storeHarness();
    const a = await h.enrollments.mint(mintInput('one', '192.0.2.11'));
    const b = await h.enrollments.mint(mintInput('two', '192.0.2.12'));
    if ('error' in a || 'error' in b) throw new Error('mint refused');

    expect(await h.enrollments.revoke(a.view.id)).toBe(true);
    expect(await h.enrollments.lookup(a.view.id)).toBeNull();
    expect(await h.enrollments.revoke(a.view.id)).toBe(false);

    await h.enrollments.burn(b.view.id, 'two');
    expect(await h.enrollments.revoke(b.view.id)).toBe(false);
  });

  test('one live installer per machine name', async () => {
    const h = storeHarness();
    await h.enrollments.mint(mintInput('newbox', '192.0.2.9'));
    const second = await h.enrollments.mint(mintInput('newbox', '192.0.2.10'));
    expect('error' in second).toBe(true);
    if ('error' in second) expect(second.error).toContain('already a live installer');

    // Revoking the first frees the name.
    const live = (await h.enrollments.list()).find((e) => e.state === 'live');
    await h.enrollments.revoke(live!.id);
    expect('error' in (await h.enrollments.mint(mintInput('newbox', '192.0.2.10')))).toBe(false);
  });

  test('a token survives a daemon restart', async () => {
    const dir = scratch();
    const first = storeHarness(dir);
    const minted = await first.enrollments.mint(mintInput());
    if ('error' in minted) throw new Error('mint refused');

    // A second Enrollments over the same file is what a restarted daemon is.
    const second = storeHarness(dir);
    const grant = await second.enrollments.lookup(minted.view.id);
    expect(grant).not.toBeNull();
    expect(grant!.machine).toBe('newbox');
  });

  test('mint, redeem and revoke are audited', async () => {
    const h = storeHarness();
    const minted = await h.enrollments.mint(mintInput());
    if ('error' in minted) throw new Error('mint refused');
    await h.enrollments.burn(minted.view.id, 'newbox');
    const other = await h.enrollments.mint(mintInput('other', '192.0.2.20'));
    if ('error' in other) throw new Error('mint refused');
    await h.enrollments.revoke(other.view.id);

    expect(h.audits.map((a) => a.kind)).toEqual([
      'enroll-minted',
      'enroll-redeemed',
      'enroll-minted',
      'enroll-revoked',
    ]);
    // The token must never reach the audit log; the id is public and is what makes the entry useful.
    expect(JSON.stringify(h.audits)).not.toContain(minted.token);
    expect(h.audits[0]!.detail.enrollId).toBe(minted.view.id);
  });

  test('a malformed id is refused without touching the store', async () => {
    const h = storeHarness();
    expect(await h.enrollments.lookup('not-an-id')).toBeNull();
    expect(await h.enrollments.lookup('')).toBeNull();
    expect(await h.enrollments.lookup('0123456789ABCDEF')).toBeNull(); // uppercase is not the shape
  });

  test('an unreadable state file leaves the daemon usable rather than throwing', async () => {
    const dir = scratch();
    const path = join(dir, 'enrollments.json');
    await Bun.write(path, 'this is not json');
    const h = storeHarness(dir);
    expect(await h.enrollments.list()).toEqual([]);
    expect('error' in (await h.enrollments.mint(mintInput()))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Mesh address allocation
// ---------------------------------------------------------------------------

function cfgWith(meshIp: string, peers: string[]): FleetConfig {
  const cfg = defaultConfig('alpha');
  cfg.meshIp = meshIp;
  cfg.peers = peers.map(
    (ip, i) => ({ name: `peer${i}`, meshIp: ip, nodePort: 7710, publicKeyJwk: null }) as PeerConfig,
  );
  return cfg;
}

describe('mesh address allocation', () => {
  test('picks the lowest free address in this machine\'s own /24', () => {
    const got = allocateMeshIp({ cfg: cfgWith('192.0.2.1', ['192.0.2.2', '192.0.2.3']) });
    expect(got).toEqual({ ok: true, meshIp: '192.0.2.4', from: '192.0.2.0/24', taken: 3 });
  });

  test('live enrollments reserve their address, so three mints give three addresses', () => {
    const cfg = cfgWith('192.0.2.1', []);
    const reserved: string[] = [];
    for (const expected of ['192.0.2.2', '192.0.2.3', '192.0.2.4']) {
      const got = allocateMeshIp({ cfg, reserved });
      expect(got.ok && got.meshIp).toBe(expected);
      if (got.ok) reserved.push(got.meshIp);
    }
  });

  test('addresses outside this fleet\'s range do not count as taken', () => {
    const got = allocateMeshIp({ cfg: cfgWith('192.0.2.1', ['198.51.100.2']) });
    expect(got.ok && got.meshIp).toBe('192.0.2.2');
  });

  test('a machine with no address of its own cannot allocate one', () => {
    const got = allocateMeshIp({ cfg: cfgWith('', []) });
    expect(got.ok).toBe(false);
    if (!got.ok) expect(got.reason).toBe('no-local-address');
  });

  test('a full range says so rather than handing out a duplicate', () => {
    const all: string[] = [];
    for (let i = 2; i <= 254; i++) all.push(`192.0.2.${i}`);
    const got = allocateMeshIp({ cfg: cfgWith('192.0.2.1', all) });
    expect(got.ok).toBe(false);
    if (!got.ok) expect(got.reason).toBe('range-full');
  });

  test('.0 and .255 are never handed out', () => {
    const all: string[] = [];
    for (let i = 1; i <= 253; i++) all.push(`192.0.2.${i}`);
    const got = allocateMeshIp({ cfg: cfgWith('192.0.2.1', all) });
    expect(got.ok && got.meshIp).toBe('192.0.2.254');
    expect(subnetOf('192.0.2.254')).toBe('192.0.2');
  });
});

// ---------------------------------------------------------------------------
// The rendered installer
// ---------------------------------------------------------------------------

function samplePayload(over: Partial<InstallerPayload> = {}): InstallerPayload {
  return {
    v: 1,
    networkName: 'testfleet',
    meshSecret: 'sekrit-mesh-secret',
    seeds: ['tcp://192.0.2.1:11010'],
    machine: 'newbox',
    role: 'roamer',
    meshIp: '192.0.2.9',
    nodePort: 7710,
    listenPort: 11010,
    ref: 'v0.1.0',
    zipUrl: archiveUrlFor('https://example.invalid/fleet', 'v0.1.0'),
    releaseBase: 'https://example.invalid/fleet/releases/download/v0.1.0',
    enrollId: '0123456789abcdef',
    token: 'A'.repeat(43),
    pairHost: '192.0.2.1',
    pairPort: 7710,
    mintedBy: 'alpha',
    mintedMs: START_MS,
    expiresMs: START_MS + ENROLL_TTL_MS,
    ...over,
  };
}

describe('the generated installer', () => {
  test('is a CRLF batch file whose payload decodes back to what went in', () => {
    const out = renderWindowsInstaller({ payload: samplePayload(), view: {} as never });
    expect(out.ok).toBe(true);
    if (!out.ok) return;

    expect(out.content.startsWith('@echo off\r\n')).toBe(true);
    expect(out.content).not.toMatch(/[^\r]\n/);

    const m = /set "SUKARFLEET_ENROLL_PAYLOAD=([A-Za-z0-9+/=]+)"/.exec(out.content);
    expect(m).not.toBeNull();
    const decoded = JSON.parse(Buffer.from(m![1]!, 'base64').toString('utf8')) as InstallerPayload;
    expect(decoded).toEqual(samplePayload());
  });

  test('says what the file is worth to somebody who steals it', () => {
    const out = renderWindowsInstaller({ payload: samplePayload(), view: {} as never });
    if (!out.ok) throw new Error('render failed');
    expect(out.content).toContain('TREAT THIS FILE LIKE A PASSWORD');
    expect(out.content).toContain('Revoking closes pairing. It does NOT rotate the mesh secret.');
    // The expiry belongs in the file, not only in the console that made it.
    expect(out.content).toContain('single use');
  });

  test('carries no logic of its own beyond downloading and starting the installer', () => {
    const out = renderWindowsInstaller({ payload: samplePayload(), view: {} as never });
    if (!out.ok) throw new Error('render failed');
    // -Source is the ZIP: without it the node's scheduled task would point into %TEMP%.
    expect(out.content).toContain('-Enroll -Source $z');
    // The one PowerShell invocation must have no double quotes inside cmd's own pair.
    const cmd = /powershell\.exe -NoProfile -ExecutionPolicy Bypass -Command "([^"]*)"/.exec(out.content);
    expect(cmd).not.toBeNull();
    expect(cmd![1]).not.toContain('"');
  });

  test('the payload never reaches the child on a command line', () => {
    const out = renderWindowsInstaller({ payload: samplePayload(), view: {} as never });
    if (!out.ok) throw new Error('render failed');
    expect(out.content).toContain('set "SUKARFLEET_ENROLL_PAYLOAD=');
    expect(out.content).not.toContain('-EnrollPayload ');
    // And it is cleared again rather than left in the environment of whatever this window starts.
    expect(out.content).toContain('set "SUKARFLEET_ENROLL_PAYLOAD="');
  });

  test('a payload too big for a batch line is refused rather than truncated', () => {
    const out = renderWindowsInstaller({
      payload: samplePayload({ seeds: Array.from({ length: 400 }, (_, i) => `tcp://192.0.2.${i % 250}:11010`) }),
      view: {} as never,
    });
    expect(out.ok).toBe(false);
  });

  test('a machine name cannot escape the filename', () => {
    // Every separator becomes a dash, so the result names a file and never a path. The dots
    // survive and are harmless once there is nothing left to separate them.
    expect(installerFileName('../../etc/passwd')).toBe('Add-..-..-etc-passwd-To-Fleet.cmd');
    expect(installerFileName('good-name')).toBe('Add-good-name-To-Fleet.cmd');
  });
});

// ---------------------------------------------------------------------------
// Issuing end to end
// ---------------------------------------------------------------------------

function issuer(opts: { secret?: string | null; meshIp?: string; peers?: string[] } = {}) {
  const dir = scratch();
  const h = storeHarness(dir);
  const cfg = cfgWith(opts.meshIp ?? '192.0.2.1', opts.peers ?? ['192.0.2.2']);
  cfg.networkName = 'testfleet';
  const issuerInst = new EnrollmentIssuer({
    cfg,
    enrollments: h.enrollments,
    revealMeshSecret: async () => (opts.secret === undefined ? 'sekrit' : opts.secret),
    outputDir: join(dir, 'installers'),
    repoUrl: 'https://example.invalid/fleet',
    ref: 'v0.1.0',
    listenPort: 11010,
    now: h.now,
  });
  return { issuer: issuerInst, store: h, cfg, dir };
}

describe('issuing an installer', () => {
  test('writes a 0600 file and records a live enrollment', async () => {
    const { issuer: iss, store, dir } = issuer();
    const out = await iss.issue({ machine: 'newbox' });
    expect(out.ok).toBe(true);
    if (!out.ok) return;

    const path = join(dir, 'installers', 'Add-newbox-To-Fleet.cmd');
    expect(out.view.installerPath).toBe(path);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(out.view.meshIp).toBe('192.0.2.3'); // .1 is us, .2 is the peer
    expect((await store.enrollments.list())[0]!.state).toBe('live');

    const text = await Bun.file(path).text();
    const m = /set "SUKARFLEET_ENROLL_PAYLOAD=([A-Za-z0-9+/=]+)"/.exec(text);
    const payload = JSON.parse(Buffer.from(m![1]!, 'base64').toString('utf8')) as InstallerPayload;
    expect(payload.meshSecret).toBe('sekrit');
    expect(payload.seeds).toEqual(['tcp://192.0.2.1:11010']);
    expect(payload.pairHost).toBe('192.0.2.1');
    expect(payload.networkName).toBe('testfleet');
  });

  test('refuses without a mesh secret, and says which card to finish', async () => {
    const { issuer: iss } = issuer({ secret: null });
    const out = await iss.issue({ machine: 'newbox' });
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.message).toContain('Mesh network card');
  });

  test('refuses a name this machine already answers to', async () => {
    const { issuer: iss } = issuer();
    const out = await iss.issue({ machine: 'alpha' });
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.message).toContain('already called alpha');
  });

  test('refuses a hand-typed address that is visibly taken, or out of range', async () => {
    const { issuer: iss } = issuer();
    const taken = await iss.issue({ machine: 'newbox', meshIp: '192.0.2.2' });
    expect(taken.ok).toBe(false);
    if (!taken.ok) expect(taken.message).toContain('already spoken for');

    const foreign = await iss.issue({ machine: 'newbox', meshIp: '198.51.100.5' });
    expect(foreign.ok).toBe(false);
    if (!foreign.ok) expect(foreign.message).toContain("fleet's range");
  });

  test('suggest names what is blocking it instead of offering a button that fails', async () => {
    const blocked = await issuer({ secret: null }).issuer.suggest();
    expect(blocked.canMint).toBe(false);
    expect(blocked.blocked).toContain('Mesh network card');

    const ready = await issuer().issuer.suggest();
    expect(ready.canMint).toBe(true);
    expect(ready.meshIp).toBe('192.0.2.3');
    expect(ready.seeds).toEqual(['tcp://192.0.2.1:11010']);
  });

  test('a roamer says its roster is not the fleet', async () => {
    const { issuer: iss, cfg } = issuer();
    cfg.role = 'roamer';
    const s = await iss.suggest();
    expect(s.rosterCaveat).toContain('roamer');

    cfg.role = 'anchor';
    expect((await iss.suggest()).rosterCaveat).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// The enrollment half of /pair/hello
// ---------------------------------------------------------------------------

function sshEd25519(fill: number, comment = 'fleetuser@test'): string {
  const type = new TextEncoder().encode('ssh-ed25519');
  const blob = new Uint8Array(4 + type.length + 4 + 32);
  const dv = new DataView(blob.buffer);
  dv.setUint32(0, type.length);
  blob.set(type, 4);
  dv.setUint32(4 + type.length, 32);
  blob.set(new Uint8Array(32).fill(fill), 8 + type.length);
  return `ssh-ed25519 ${Buffer.from(blob).toString('base64')}${comment ? ` ${comment}` : ''}`;
}

async function realJwk(): Promise<JsonWebKey> {
  const kp = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  return crypto.subtle.exportKey('jwk', kp.publicKey);
}

async function bundle(machine: string, meshIp: string, fill: number): Promise<PairBundle> {
  return {
    v: 1,
    machine,
    role: 'roamer',
    meshIp,
    nodePort: 7710,
    publicKeyJwk: await realJwk(),
    sshUser: 'fleetuser',
    sshPublicKey: sshEd25519(fill),
    sshHostKeys: [sshEd25519(fill + 1, '')],
  };
}

async function enrollHello(
  token: string,
  enrollId: string,
  from: unknown,
  tsMs: number,
): Promise<Request> {
  const key = await deriveEnrollKey(token);
  const payload = { v: 1 as const, from, tsMs, enrollId };
  const body = canonicalJson({ payload, mac: await macRequest(key, payload) });
  return new Request('http://192.0.2.1:7710/pair/hello', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body,
  });
}

async function responder(store: StoreHarness) {
  const cfg = defaultConfig('alpha');
  cfg.meshIp = '192.0.2.1';
  const applied: PairBundle[] = [];
  const local = await bundle('alpha', '192.0.2.1', 0x11);
  const deps: PairingDeps = {
    cfg,
    auditAppend: async (kind, detail): Promise<AuditEntry> => ({
      v: 1,
      machine: 'alpha',
      seq: 1,
      tsMs: store.now(),
      kind,
      detail,
      sigB64: 'test',
    }),
    localBundle: async () => local,
    applyPeer: async (p) => {
      applied.push(p);
    },
    now: store.now,
    enrollments: store.enrollments,
  };
  return { pairing: new Pairing(deps), applied };
}

describe('/pair/hello with an enrollment token', () => {
  test('a correct token pairs, and burns itself doing it', async () => {
    const store = storeHarness();
    const minted = await store.enrollments.mint(mintInput('newbox', '192.0.2.9'));
    if ('error' in minted) throw new Error('mint refused');
    const { pairing, applied } = await responder(store);

    const from = await bundle('newbox', '192.0.2.9', 0x22);
    const res = await pairing.handleHello(await enrollHello(minted.token, minted.view.id, from, store.now()));
    expect(res.status).toBe(200);
    expect(applied).toHaveLength(1);
    expect(applied[0]!.machine).toBe('newbox');

    // Single use, and the store is where that fact lives.
    expect((await store.enrollments.list())[0]!.state).toBe('used');
    const replay = await pairing.handleHello(
      await enrollHello(minted.token, minted.view.id, from, store.now()),
    );
    expect(replay.status).toBe(401);
  });

  test('a wrong token, an unknown id and a revoked one are the same 401', async () => {
    const store = storeHarness();
    const minted = await store.enrollments.mint(mintInput('newbox', '192.0.2.9'));
    if ('error' in minted) throw new Error('mint refused');
    const { pairing, applied } = await responder(store);
    const from = await bundle('newbox', '192.0.2.9', 0x22);

    const wrongToken = await pairing.handleHello(
      await enrollHello('B'.repeat(43), minted.view.id, from, store.now()),
    );
    const unknownId = await pairing.handleHello(
      await enrollHello(minted.token, 'ffffffffffffffff', from, store.now()),
    );

    await store.enrollments.revoke(minted.view.id);
    const revoked = await pairing.handleHello(
      await enrollHello(minted.token, minted.view.id, from, store.now()),
    );

    for (const res of [wrongToken, unknownId, revoked]) {
      expect(res.status).toBe(401);
      expect(await res.clone().text()).toBe(JSON.stringify({ error: 'unauthorized' }));
    }
    expect(applied).toHaveLength(0);
  });

  test('a token is bound to the machine name and mesh address it was minted for', async () => {
    const store = storeHarness();
    const minted = await store.enrollments.mint(mintInput('newbox', '192.0.2.9'));
    if ('error' in minted) throw new Error('mint refused');
    const { pairing, applied } = await responder(store);

    const wrongName = await bundle('impostor', '192.0.2.9', 0x22);
    expect((await pairing.handleHello(await enrollHello(minted.token, minted.view.id, wrongName, store.now()))).status).toBe(401);

    const wrongIp = await bundle('newbox', '192.0.2.99', 0x22);
    expect((await pairing.handleHello(await enrollHello(minted.token, minted.view.id, wrongIp, store.now()))).status).toBe(401);

    expect(applied).toHaveLength(0);
    // Neither attempt spent the token: a bad bundle is not a redeem.
    expect((await store.enrollments.list())[0]!.state).toBe('live');
  });

  test('an expired token is refused even though the MAC is right', async () => {
    const store = storeHarness();
    const minted = await store.enrollments.mint(mintInput('newbox', '192.0.2.9'));
    if ('error' in minted) throw new Error('mint refused');
    const { pairing } = await responder(store);

    store.advance(ENROLL_TTL_MS + 1);
    const from = await bundle('newbox', '192.0.2.9', 0x22);
    const res = await pairing.handleHello(await enrollHello(minted.token, minted.view.id, from, store.now()));
    expect(res.status).toBe(401);
  });

  test('a daemon with no enrollment store refuses rather than crashing', async () => {
    const store = storeHarness();
    const minted = await store.enrollments.mint(mintInput('newbox', '192.0.2.9'));
    if ('error' in minted) throw new Error('mint refused');

    const cfg = defaultConfig('alpha');
    cfg.meshIp = '192.0.2.1';
    const local = await bundle('alpha', '192.0.2.1', 0x11);
    const bare = new Pairing({
      cfg,
      auditAppend: async (kind, detail): Promise<AuditEntry> => ({
        v: 1, machine: 'alpha', seq: 1, tsMs: START_MS, kind, detail, sigB64: 'test',
      }),
      localBundle: async () => local,
      applyPeer: async () => {},
      now: store.now,
      // no enrollments port
    });

    const from = await bundle('newbox', '192.0.2.9', 0x22);
    const res = await bare.handleHello(await enrollHello(minted.token, minted.view.id, from, store.now()));
    expect(res.status).toBe(401);
  });

  test('a malformed enrollId is a 400, not a 401 that leaks the shape', async () => {
    const store = storeHarness();
    const { pairing } = await responder(store);
    const from = await bundle('newbox', '192.0.2.9', 0x22);
    const payload = { v: 1 as const, from, tsMs: store.now(), enrollId: 'nope' };
    const req = new Request('http://192.0.2.1:7710/pair/hello', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: canonicalJson({ payload, mac: 'x' }),
    });
    expect((await pairing.handleHello(req)).status).toBe(400);
  });

  test('an enrollment MAC does not verify as a pairing-code MAC, or the reverse', async () => {
    const store = storeHarness();
    const minted = await store.enrollments.mint(mintInput('newbox', '192.0.2.9'));
    if ('error' in minted) throw new Error('mint refused');
    const { pairing } = await responder(store);

    // A hello whose MAC is right but which claims no enrollId lands on the typed-code path, where
    // no code is minted: 401. Domain separation is what makes that true rather than luck.
    const from = await bundle('newbox', '192.0.2.9', 0x22);
    const key = await deriveEnrollKey(minted.token);
    const payload = { v: 1 as const, from, tsMs: store.now() };
    const req = new Request('http://192.0.2.1:7710/pair/hello', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: canonicalJson({ payload, mac: await macRequest(key, payload) }),
    });
    expect((await pairing.handleHello(req)).status).toBe(401);
  });
});
