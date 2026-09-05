// SPDX-License-Identifier: AGPL-3.0-or-later
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { chmod, mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  buildAuthHeader,
  enforcePrivateMode,
  loadOrCreateMachineKey,
  publicKeyFingerprint,
  signCanonical,
  signGossip,
  verifyAuthHeader,
  verifyCanonical,
  verifyGossip,
} from '../src/keys';
import type { RunSystemdCredsDecrypt } from '../src/keys';
import type { GossipEnvelope, MachineKey, PeerConfig, PresencePayload } from '../src/types';
import type { RunBytesResult } from '../src/util';

// configDir() has no env override (unlike stateDir()'s SUKARFLEET_STATE), and Bun's
// os.homedir() does not honor a runtime process.env.HOME override either. loadOrCreateMachineKey
// therefore accepts an additive `opts.keyPath` test seam (see src/keys.ts) so tests never touch
// the real machine's ~/.config/sukarfleet/machine-key.json.
let tempDir: string;

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), 'sukarfleet-keys-'));
});

afterEach(async () => {
  await rm(tempDir, { recursive: true, force: true });
});

function keyPathIn(dir: string): string {
  return join(dir, 'machine-key.json');
}

async function freshKey(machine: string, dir?: string): Promise<MachineKey> {
  return loadOrCreateMachineKey(machine, { keyPath: keyPathIn(dir ?? tempDir) });
}

function samplePayload(): PresencePayload {
  return {
    repos: { fleet: { lastSyncOkMs: 1000, lastCommit: 'abc123', syncError: null } },
    githubPushOkMs: { fleet: 900 },
    clockMs: 1000,
    flags: [],
  };
}

describe('loadOrCreateMachineKey', () => {
  test('creates a persisted key file with mode 0600', async () => {
    const key = await freshKey('alpha');
    expect(key.machine).toBe('alpha');
    expect(key.publicKeyJwk.kty).toBe('EC');
    expect(key.publicKeyJwk.crv).toBe('P-256');
    expect(key.privateKeyJwk.kty).toBe('EC');

    const st = await stat(keyPathIn(tempDir));
    expect(st.mode & 0o777).toBe(0o600);
  });

  test('loads the same key on a second call instead of regenerating', async () => {
    const first = await freshKey('alpha');
    const second = await freshKey('alpha');
    expect(second).toEqual(first);
  });

  test('warns but still returns the key when the stored machine name differs', async () => {
    const first = await freshKey('alpha');
    const second = await loadOrCreateMachineKey('beta', { keyPath: keyPathIn(tempDir) });
    expect(second).toEqual(first);
    expect(second.machine).toBe('alpha');
  });

  test('rejects a corrupted key file instead of silently regenerating', async () => {
    const path = keyPathIn(tempDir);
    await Bun.write(path, '{ not valid json');
    await expect(loadOrCreateMachineKey('alpha', { keyPath: path })).rejects.toThrow();
  });
});

// Decrypt-at-load seam (P1 RUNBOOK section 7's listed TPM-sealing upgrade). `opts.decryptCred`
// is the injectable systemd-creds runner (src/keys.ts), so these tests never shell out to a real
// systemd-creds binary or touch a real TPM.
describe('loadOrCreateMachineKey (sealed .cred blob)', () => {
  function credPathIn(dir: string): string {
    return `${keyPathIn(dir)}.cred`;
  }

  function sampleSealedKey(machine = 'alpha'): MachineKey {
    return {
      machine,
      publicKeyJwk: { kty: 'EC', crv: 'P-256', x: 'sample-x', y: 'sample-y' },
      privateKeyJwk: { kty: 'EC', crv: 'P-256', x: 'sample-x', y: 'sample-y', d: 'sample-d' },
    };
  }

  function mockDecryptReturning(key: MachineKey): RunSystemdCredsDecrypt {
    return async (): Promise<RunBytesResult> => ({
      code: 0,
      stdout: new TextEncoder().encode(JSON.stringify(key)),
      stderr: '',
    });
  }

  test('decrypts a sealed blob via the injected systemd-creds runner and returns its plaintext key', async () => {
    const sealedKey = sampleSealedKey();
    await Bun.write(credPathIn(tempDir), 'opaque-encrypted-bytes');

    const result = await loadOrCreateMachineKey('alpha', {
      keyPath: keyPathIn(tempDir),
      decryptCred: mockDecryptReturning(sealedKey),
    });

    expect(result).toEqual(sealedKey);
  });

  test('does not create a plain key file when a sealed blob is present', async () => {
    await Bun.write(credPathIn(tempDir), 'opaque-encrypted-bytes');

    await loadOrCreateMachineKey('alpha', {
      keyPath: keyPathIn(tempDir),
      decryptCred: mockDecryptReturning(sampleSealedKey()),
    });

    expect(await Bun.file(keyPathIn(tempDir)).exists()).toBe(false);
  });

  test('sealed blob takes precedence over a plain key file already at the same path', async () => {
    await freshKey('alpha'); // writes a plain machine-key.json first
    const sealedKey = sampleSealedKey('alpha-sealed-identity');
    await Bun.write(credPathIn(tempDir), 'opaque-encrypted-bytes');

    const result = await loadOrCreateMachineKey('alpha', {
      keyPath: keyPathIn(tempDir),
      decryptCred: mockDecryptReturning(sealedKey),
    });

    expect(result).toEqual(sealedKey);
  });

  test('warns but still returns the sealed key when its machine name differs from the requested one', async () => {
    const sealedKey = sampleSealedKey('alpha');
    await Bun.write(credPathIn(tempDir), 'opaque-encrypted-bytes');

    const result = await loadOrCreateMachineKey('beta', {
      keyPath: keyPathIn(tempDir),
      decryptCred: mockDecryptReturning(sealedKey),
    });

    expect(result).toEqual(sealedKey);
    expect(result.machine).toBe('alpha');
  });

  test('falls through to the plain-file path (and never invokes decryptCred) when no .cred blob exists', async () => {
    // If this were invoked despite no sealed blob existing, the returned shape would fail
    // isMachineKey validation and the call below would reject instead of returning a fresh key.
    const decryptCred: RunSystemdCredsDecrypt = async () => ({
      code: 0,
      stdout: new TextEncoder().encode('{}'),
      stderr: '',
    });

    const key = await loadOrCreateMachineKey('alpha', { keyPath: keyPathIn(tempDir), decryptCred });
    expect(key.machine).toBe('alpha');
    expect(key.publicKeyJwk.kty).toBe('EC');
  });

  test('passes the .cred path (not the plain key path) to the decrypt runner', async () => {
    await Bun.write(credPathIn(tempDir), 'opaque-encrypted-bytes');
    let receivedPath = '';
    const decryptCred: RunSystemdCredsDecrypt = async (credPath) => {
      receivedPath = credPath;
      return { code: 0, stdout: new TextEncoder().encode(JSON.stringify(sampleSealedKey())), stderr: '' };
    };

    await loadOrCreateMachineKey('alpha', { keyPath: keyPathIn(tempDir), decryptCred });
    expect(receivedPath).toBe(credPathIn(tempDir));
  });

  test('rejects (fail closed) when systemd-creds decrypt exits non-zero', async () => {
    await Bun.write(credPathIn(tempDir), 'opaque-encrypted-bytes');
    const decryptCred: RunSystemdCredsDecrypt = async () => ({
      code: 1,
      stdout: new Uint8Array(),
      stderr: 'TPM sealing key not available',
    });

    await expect(
      loadOrCreateMachineKey('alpha', { keyPath: keyPathIn(tempDir), decryptCred }),
    ).rejects.toThrow();
  });

  test('rejects (fail closed) when the decrypted plaintext is not valid JSON', async () => {
    await Bun.write(credPathIn(tempDir), 'opaque-encrypted-bytes');
    const decryptCred: RunSystemdCredsDecrypt = async () => ({
      code: 0,
      stdout: new TextEncoder().encode('{ not valid json'),
      stderr: '',
    });

    await expect(
      loadOrCreateMachineKey('alpha', { keyPath: keyPathIn(tempDir), decryptCred }),
    ).rejects.toThrow();
  });

  test('rejects (fail closed) when the decrypted plaintext has an invalid MachineKey shape', async () => {
    await Bun.write(credPathIn(tempDir), 'opaque-encrypted-bytes');
    const decryptCred: RunSystemdCredsDecrypt = async () => ({
      code: 0,
      stdout: new TextEncoder().encode(JSON.stringify({ machine: 'alpha' })),
      stderr: '',
    });

    await expect(
      loadOrCreateMachineKey('alpha', { keyPath: keyPathIn(tempDir), decryptCred }),
    ).rejects.toThrow();
  });
});

describe('signCanonical / verifyCanonical', () => {
  test('round-trips a signature over an arbitrary object', async () => {
    const key = await freshKey('alpha');
    const obj = { b: 2, a: 1, nested: { z: 'z', y: 'y' } };
    const sig = await signCanonical(obj, key);
    const ok = await verifyCanonical(obj, sig, key.publicKeyJwk);
    expect(ok).toBe(true);
  });

  test('rejects a tampered payload', async () => {
    const key = await freshKey('alpha');
    const sig = await signCanonical({ a: 1 }, key);
    const ok = await verifyCanonical({ a: 2 }, sig, key.publicKeyJwk);
    expect(ok).toBe(false);
  });

  test('rejects a tampered signature', async () => {
    const key = await freshKey('alpha');
    const sig = await signCanonical({ a: 1 }, key);
    const tampered = sig.slice(0, -4) + (sig.slice(-4) === 'AAAA' ? 'BBBB' : 'AAAA');
    const ok = await verifyCanonical({ a: 1 }, tampered, key.publicKeyJwk);
    expect(ok).toBe(false);
  });

  test('rejects verification against an unrelated public key', async () => {
    const key = await freshKey('alpha');
    const otherDir = await mkdtemp(join(tmpdir(), 'sukarfleet-keys-other-'));
    const otherKey = await freshKey('other-machine', otherDir);
    await rm(otherDir, { recursive: true, force: true });

    const sig = await signCanonical({ a: 1 }, key);
    const ok = await verifyCanonical({ a: 1 }, sig, otherKey.publicKeyJwk);
    expect(ok).toBe(false);
  });
});

describe('signGossip / verifyGossip', () => {
  test('round-trips a full gossip envelope', async () => {
    const key = await freshKey('alpha');
    const unsigned: Omit<GossipEnvelope, 'sigB64'> = {
      v: 1,
      machine: 'alpha',
      tsMs: 123456,
      seq: 7,
      payload: samplePayload(),
    };
    const envelope = await signGossip(unsigned, key);
    expect(envelope.sigB64.length).toBeGreaterThan(0);
    const ok = await verifyGossip(envelope, key.publicKeyJwk);
    expect(ok).toBe(true);
  });

  test('rejects a gossip envelope whose payload was tampered after signing', async () => {
    const key = await freshKey('alpha');
    const unsigned: Omit<GossipEnvelope, 'sigB64'> = {
      v: 1,
      machine: 'alpha',
      tsMs: 123456,
      seq: 7,
      payload: samplePayload(),
    };
    const envelope = await signGossip(unsigned, key);
    const tampered: GossipEnvelope = { ...envelope, seq: 8 };
    const ok = await verifyGossip(tampered, key.publicKeyJwk);
    expect(ok).toBe(false);
  });
});

describe('buildAuthHeader / verifyAuthHeader', () => {
  function peerFor(key: MachineKey): PeerConfig {
    return { name: key.machine, meshIp: '203.0.113.1', nodePort: 7710, publicKeyJwk: key.publicKeyJwk };
  }

  test('round-trips a valid header', async () => {
    const key = await freshKey('alpha');
    const peer = peerFor(key);
    const header = await buildAuthHeader('GET', '/status', key.machine, key);
    const result = await verifyAuthHeader(header, 'GET', '/status', [peer], Date.now());
    expect(result.ok).toBe(true);
    expect(result.machine).toBe('alpha');
  });

  test('rejects when the method or path differs from what was signed', async () => {
    const key = await freshKey('alpha');
    const peer = peerFor(key);
    const header = await buildAuthHeader('GET', '/status', key.machine, key);
    const result = await verifyAuthHeader(header, 'POST', '/status', [peer], Date.now());
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('bad signature');
  });

  test('rejects a header outside the 120s window', async () => {
    const key = await freshKey('alpha');
    const peer = peerFor(key);
    const header = await buildAuthHeader('GET', '/status', key.machine, key);
    const future = Date.now() + 200000;
    const result = await verifyAuthHeader(header, 'GET', '/status', [peer], future);
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('timestamp outside window');
  });

  test('rejects an unknown machine', async () => {
    const key = await freshKey('alpha');
    const header = await buildAuthHeader('GET', '/status', key.machine, key);
    const result = await verifyAuthHeader(header, 'GET', '/status', [], Date.now());
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('unknown machine');
  });

  test('rejects a peer with no public key configured', async () => {
    const key = await freshKey('alpha');
    const header = await buildAuthHeader('GET', '/status', key.machine, key);
    const peer: PeerConfig = { name: key.machine, meshIp: '203.0.113.1', nodePort: 7710, publicKeyJwk: null };
    const result = await verifyAuthHeader(header, 'GET', '/status', [peer], Date.now());
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('peer has no public key configured');
  });

  test('rejects a malformed header value', async () => {
    const result = await verifyAuthHeader('not-a-valid-header', 'GET', '/status', [], Date.now());
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('malformed header');
  });
});

describe('publicKeyFingerprint', () => {
  test('is deterministic for the same key and 16 chars long', async () => {
    const key = await freshKey('alpha');
    const fp1 = publicKeyFingerprint(key.publicKeyJwk);
    const fp2 = publicKeyFingerprint(key.publicKeyJwk);
    expect(fp1).toBe(fp2);
    expect(fp1.length).toBe(16);
  });

  test('differs across distinct keys', async () => {
    const key = await freshKey('alpha');
    const otherDir = await mkdtemp(join(tmpdir(), 'sukarfleet-keys-fp-'));
    const otherKey = await freshKey('other-machine', otherDir);
    await rm(otherDir, { recursive: true, force: true });

    expect(publicKeyFingerprint(key.publicKeyJwk)).not.toBe(publicKeyFingerprint(otherKey.publicKeyJwk));
  });
});

// The permission rule for the machine key file, on both sides of the platform boundary. The
// Windows half is the first real Windows run's defect: NTFS reports 0666 for every file and
// chmod is a no-op there, so the POSIX rule could only ever refuse and the daemon never started.
// The platform is injected through the opts seam rather than by mutating process.platform, so
// these run identically on any host.
describe('machine key file permissions', () => {
  function captureLogs(): { lines: Record<string, unknown>[]; restore: () => void } {
    const lines: Record<string, unknown>[] = [];
    const real = console.log;
    console.log = (...args: unknown[]): void => {
      try {
        lines.push(JSON.parse(args.map(String).join(' ')) as Record<string, unknown>);
      } catch {
        // non-JSON console output, not a log() line -- ignore
      }
    };
    return { lines, restore: () => { console.log = real; } };
  }

  async function writeKeyFileAt(mode: number): Promise<{ path: string; key: MachineKey }> {
    const key = await freshKey('alpha');
    const path = keyPathIn(tempDir);
    await chmod(path, mode);
    return { path, key };
  }

  test('POSIX: corrects a widened key file back to 0600 and loads it', async () => {
    const { path, key } = await writeKeyFileAt(0o644);
    const cap = captureLogs();
    let loaded: MachineKey;
    try {
      loaded = await loadOrCreateMachineKey('alpha', { keyPath: path, platform: 'linux' });
    } finally {
      cap.restore();
    }

    expect(loaded).toEqual(key);
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    expect(cap.lines.some((l) => String(l.msg).includes('permissions are not 0600'))).toBe(true);
    expect(cap.lines.some((l) => String(l.msg).includes('NTFS carries ACLs'))).toBe(false);
  });

  test('POSIX: refuses to load when the correction does not stick', async () => {
    const { path } = await writeKeyFileAt(0o644);
    // A chmod that reports success and changes nothing is exactly what a mode-blind filesystem
    // does, and is the only way to reach the refusal from a real ext4 temp dir.
    await expect(
      enforcePrivateMode(path, { platform: 'linux', chmodFile: async () => {} }),
    ).rejects.toThrow(/still has insecure permissions \(644\) after chmod 0600; refusing to load/);
    await chmod(path, 0o600);
  });

  test('POSIX: refuses to load when the correction itself fails', async () => {
    const { path } = await writeKeyFileAt(0o644);
    await expect(
      enforcePrivateMode(path, {
        platform: 'linux',
        chmodFile: async () => { throw new Error('EROFS: read-only file system'); },
      }),
    ).rejects.toThrow(/has insecure permissions \(644\) and could not be corrected to 0600/);
    await chmod(path, 0o600);
  });

  test('POSIX: reports the mode as enforced for a key file already at 0600', async () => {
    const { path } = await writeKeyFileAt(0o600);
    expect(await enforcePrivateMode(path, { platform: 'linux' })).toBe('enforced');
  });

  test('Windows: loads a key file whose mode is not 0600 instead of refusing', async () => {
    const { path, key } = await writeKeyFileAt(0o666); // what NTFS reports for every file
    const cap = captureLogs();
    let loaded: MachineKey;
    try {
      loaded = await loadOrCreateMachineKey('alpha', { keyPath: path, platform: 'windows' });
    } finally {
      cap.restore();
    }

    expect(loaded).toEqual(key);
    const acl = cap.lines.filter((l) => String(l.msg).includes('NTFS carries ACLs'));
    expect(acl.length).toBe(1);
    expect(String(acl[0]?.msg)).toBe(
      `keys: NTFS carries ACLs rather than mode bits; relying on the installer's ACL for ${path}`,
    );
    expect(acl[0]?.level).toBe('warn');
    expect(cap.lines.some((l) => String(l.msg).includes('permissions are not 0600'))).toBe(false);
    await chmod(path, 0o600);
  });

  test('Windows: the ACL notice is logged once per path, not once per load', async () => {
    const { path } = await writeKeyFileAt(0o666);
    const cap = captureLogs();
    try {
      await loadOrCreateMachineKey('alpha', { keyPath: path, platform: 'windows' });
      await loadOrCreateMachineKey('alpha', { keyPath: path, platform: 'windows' });
      await loadOrCreateMachineKey('alpha', { keyPath: path, platform: 'windows' });
    } finally {
      cap.restore();
    }

    expect(cap.lines.filter((l) => String(l.msg).includes('NTFS carries ACLs')).length).toBe(1);
    await chmod(path, 0o600);
  });

  test('Windows: reports the mode as not enforced and never chmods', async () => {
    const { path } = await writeKeyFileAt(0o666);
    let chmodCalls = 0;
    const outcome = await enforcePrivateMode(path, {
      platform: 'windows',
      chmodFile: async () => { chmodCalls += 1; },
    });
    expect(outcome).toBe('not-enforced');
    expect(chmodCalls).toBe(0);
    expect((await stat(path)).mode & 0o777).toBe(0o666);
    await chmod(path, 0o600);
  });
});
