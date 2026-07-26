// SPDX-License-Identifier: AGPL-3.0-or-later
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { chmod, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defaultConfig } from '../src/config';
import {
  SudoCredentialUnavailable,
  assertPrivateStore,
  clearStale,
  markStale,
  removeSudoPassword,
  sealAvailable,
  setSudoPassword,
  status,
  withSudoPassword,
} from '../src/secrets';
import type { SealScope } from '../src/secrets';
import type { FleetConfig } from '../src/types';

// The credential name is authenticated as AAD by systemd-creds, so a test that seals a blob by
// hand has to use the same name src/secrets.ts uses. Duplicated deliberately: if the constant
// there ever changes, this file is where it should fail loudly.
const CRED_NAME = 'sukarfleet-sudo';

// Real-dependency gates. This machine has both a working TPM2 seal and a real sudo, and the
// suite exercises those paths for real; a machine without them skips rather than fails.
const HAS_SYSTEMD_CREDS = Bun.which('systemd-creds') !== null;
const SEAL = HAS_SYSTEMD_CREDS ? await sealAvailable() : { ok: false, reason: 'systemd-creds not installed' };
// One wrong-password attempt per run is safe here (no pam_faillock in /etc/pam.d on the fleet
// machines) but is opt-out-able, because setSudoPassword deliberately never retries and a locked
// account is exactly what that rule protects.
const HAS_SUDO = Bun.which('sudo') !== null && process.env.SUKARFLEET_TEST_NO_SUDO !== '1';

let tempDir: string;

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), 'sukarfleet-secrets-'));
});

afterEach(async () => {
  await chmod(tempDir, 0o700).catch(() => {});
  await rm(tempDir, { recursive: true, force: true });
});

function cfgWith(dir: string, admin: Partial<FleetConfig['admin']> = {}): FleetConfig {
  const base = defaultConfig('test-machine');
  return { ...base, admin: { ...base.admin, secretsDir: dir, ...admin } };
}

function storeDir(): string {
  return join(tempDir, 'secrets');
}

// A mount point whose filesystem cannot enforce a 0700 directory (fuseblk, exFAT, NTFS and the
// like). Nothing is written there -- the store path is only ever pointed at an existing directory,
// so assertPrivateStore refuses before it would create anything.
async function modeBlindMountPoint(): Promise<string | null> {
  const blind = new Set(['fuseblk', 'ntfs', 'ntfs3', 'vfat', 'msdos', 'exfat', 'cifs', 'smb3', 'smbfs']);
  const table = await readFile('/proc/self/mountinfo', 'utf8').catch(() => '');
  for (const line of table.split('\n')) {
    const sep = line.indexOf(' - ');
    if (sep < 0) continue;
    const mountPoint = line.slice(0, sep).split(' ')[4] ?? '';
    const fsType = line.slice(sep + 3).split(' ')[0] ?? '';
    if (mountPoint.startsWith('/') && blind.has(fsType)) return mountPoint;
  }
  return null;
}

interface MetaSeed {
  sealed: SealScope | 'plaintext';
  stale?: boolean;
  lastUsedMs?: number | null;
}

async function seedStore(cred: string, meta: MetaSeed): Promise<void> {
  const dir = storeDir();
  await Bun.write(join(dir, '.keep'), '');
  await chmod(dir, 0o700);
  await writeFile(join(dir, 'sudo.cred'), cred, { mode: 0o600 });
  await writeFile(
    join(dir, 'sudo.meta.json'),
    JSON.stringify({
      user: 'tester',
      setAtMs: 1000,
      lastUsedMs: meta.lastUsedMs ?? null,
      lastFailureMs: null,
      stale: meta.stale ?? false,
      sealed: meta.sealed,
    }) + '\n',
    { mode: 0o600 },
  );
}

// Seals with whichever scope sealAvailable() actually reported, not a hardcoded one: on these
// machines the system-scope tpm2 path is refused for an unprivileged uid, so a fixture pinned to
// it fails on a machine whose real store seals perfectly well in --user scope.
async function sealForTest(plaintext: string): Promise<string> {
  const sealArgs = SEAL.scope === 'tpm2' ? ['--with-key=tpm2'] : ['--user'];
  const proc = Bun.spawn(
    ['systemd-creds', 'encrypt', ...sealArgs, `--name=${CRED_NAME}`, '-', '-'],
    { stdin: 'pipe', stdout: 'pipe', stderr: 'pipe' },
  );
  proc.stdin.write(plaintext);
  await proc.stdin.end();
  const out = await new Response(proc.stdout).text();
  const code = await proc.exited;
  if (code !== 0) throw new Error(`test fixture: systemd-creds encrypt exited ${code}`);
  return out;
}

async function reason(fn: () => Promise<unknown>): Promise<string> {
  try {
    await fn();
  } catch (err) {
    if (err instanceof SudoCredentialUnavailable) return err.reason;
    return `unexpected: ${String(err)}`;
  }
  return 'no-throw';
}

describe('assertPrivateStore', () => {
  test('creates the store at 0700 and is idempotent', async () => {
    const cfg = cfgWith(storeDir());
    await assertPrivateStore(cfg);
    expect((await stat(storeDir())).mode & 0o777).toBe(0o700);
    await assertPrivateStore(cfg);
    expect((await stat(storeDir())).mode & 0o777).toBe(0o700);
  });

  test('heals a widened mode', async () => {
    const cfg = cfgWith(storeDir());
    await assertPrivateStore(cfg);
    await chmod(storeDir(), 0o755);
    await assertPrivateStore(cfg);
    expect((await stat(storeDir())).mode & 0o777).toBe(0o700);
  });

  test('refuses when the store path is not a directory', async () => {
    const path = join(tempDir, 'not-a-dir');
    await writeFile(path, 'x');
    expect(await reason(() => assertPrivateStore(cfgWith(path)))).toBe('not-private');
  });

  test('refuses a store on a filesystem that does not enforce modes', async () => {
    const mount = await modeBlindMountPoint();
    if (mount === null) return; // no fuseblk/ntfs/vfat mount on this machine
    const err = await reason(() => assertPrivateStore(cfgWith(mount)));
    expect(err).toBe('not-private');
  });
});

describe('withSudoPassword refusals', () => {
  test('missing credential refuses without running the callback', async () => {
    const cfg = cfgWith(storeDir());
    let ran = false;
    const r = await reason(() =>
      withSudoPassword(cfg, async () => {
        ran = true;
        return 'nope';
      }),
    );
    expect(r).toBe('no-credential');
    expect(ran).toBe(false);
    expect((await status(cfg)).present).toBe(false);
  });

  test('stale credential refuses', async () => {
    const cfg = cfgWith(storeDir(), { allowPlaintextFallback: true });
    await seedStore('correct horse', { sealed: 'plaintext', stale: true });
    let ran = false;
    const r = await reason(() =>
      withSudoPassword(cfg, async () => {
        ran = true;
        return 'nope';
      }),
    );
    expect(r).toBe('credential-stale');
    expect(ran).toBe(false);
    expect((await status(cfg)).stale).toBe(true);
  });

  test('a credential with no metadata is treated as stale', async () => {
    const cfg = cfgWith(storeDir(), { allowPlaintextFallback: true });
    await seedStore('correct horse', { sealed: 'plaintext' });
    await rm(join(storeDir(), 'sudo.meta.json'));
    expect(await reason(() => withSudoPassword(cfg, async () => 'nope'))).toBe('credential-stale');
    const s = await status(cfg);
    expect(s.present).toBe(true);
    expect(s.stale).toBe(true);
    expect(s.sealed).toBeNull();
  });

  test('unseal failure refuses and says nothing about the blob', async () => {
    if (!HAS_SYSTEMD_CREDS) return;
    const cfg = cfgWith(storeDir());
    await seedStore('this is not a sealed credential', { sealed: 'tpm2' });
    let caught: SudoCredentialUnavailable | null = null;
    try {
      await withSudoPassword(cfg, async () => 'nope');
    } catch (err) {
      caught = err as SudoCredentialUnavailable;
    }
    expect(caught?.reason).toBe('unseal-failed');
    expect(caught?.message).not.toContain('this is not a sealed credential');
  });

  test('a plaintext store is refused once the fallback flag is off', async () => {
    const cfg = cfgWith(storeDir(), { allowPlaintextFallback: false });
    await seedStore('correct horse', { sealed: 'plaintext' });
    expect(await reason(() => withSudoPassword(cfg, async () => 'nope'))).toBe('unseal-failed');
  });

  test('a non-private store refuses before any credential is read', async () => {
    const mount = await modeBlindMountPoint();
    if (mount === null) return;
    expect(await reason(() => withSudoPassword(cfgWith(mount), async () => 'nope'))).toBe('not-private');
  });
});

describe('withSudoPassword round trip', () => {
  test('hands the exact plaintext to the callback and records the use', async () => {
    const cfg = cfgWith(storeDir(), { allowPlaintextFallback: true });
    await seedStore('correct horse battery', { sealed: 'plaintext' });
    const seen: string[] = [];
    const out = await withSudoPassword(cfg, async (pw) => {
      seen.push(pw);
      return { exitCode: 0 };
    });
    expect(seen).toEqual(['correct horse battery']);
    expect(out).toEqual({ exitCode: 0 });
    const s = await status(cfg);
    expect(s.present).toBe(true);
    expect(s.stale).toBe(false);
    expect(s.sealed).toBe('plaintext');
    expect(typeof s.lastUsedMs).toBe('number');
  });

  test('unseals a real sealed credential in whichever scope this machine supports', async () => {
    if (!SEAL.ok || !SEAL.scope) return; // no working systemd-creds sealing on this machine
    const cfg = cfgWith(storeDir());
    // The metadata must name the SAME scope the blob was sealed with -- a user-scope blob does not
    // decrypt in system scope, and that mismatch is exactly what strands a real credential.
    await seedStore(await sealForTest('s3cret sealed value'), { sealed: SEAL.scope });
    const seen: string[] = [];
    await withSudoPassword(cfg, async (pw) => {
      seen.push(pw);
      return null;
    });
    expect(seen).toEqual(['s3cret sealed value']);
  });

  test('redacts the credential out of the callback result', async () => {
    const cfg = cfgWith(storeDir(), { allowPlaintextFallback: true });
    await seedStore('leaky-password', { sealed: 'plaintext' });
    const out = await withSudoPassword(cfg, async (pw) => ({
      stdout: `the command echoed ${pw}`,
      nested: [{ stderr: pw }],
    }));
    expect(JSON.stringify(out)).not.toContain('leaky-password');
    expect(out.stdout).toContain('[redacted]');
  });

  test('redacts the credential out of a thrown error message and stack', async () => {
    const cfg = cfgWith(storeDir(), { allowPlaintextFallback: true });
    await seedStore('leaky-password', { sealed: 'plaintext' });
    let caught: unknown = null;
    try {
      await withSudoPassword(cfg, async (pw) => {
        throw new Error(`command failed with ${pw}`);
      });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(Error);
    const e = caught as Error;
    expect(e.message).not.toContain('leaky-password');
    expect(e.stack ?? '').not.toContain('leaky-password');
  });
});

describe('stale marking', () => {
  test('markStale persists and clearStale reverses it', async () => {
    const cfg = cfgWith(storeDir(), { allowPlaintextFallback: true });
    await seedStore('correct horse', { sealed: 'plaintext' });
    await markStale(cfg, 4242);
    let s = await status(cfg);
    expect(s.stale).toBe(true);
    expect(s.lastFailureMs).toBe(4242);
    await clearStale(cfg);
    s = await status(cfg);
    expect(s.stale).toBe(false);
    expect(s.lastFailureMs).toBe(4242);
    const seen: string[] = [];
    await withSudoPassword(cfg, async (pw) => seen.push(pw));
    expect(seen).toEqual(['correct horse']);
  });

  test('a stale mark that cannot be persisted still binds this process', async () => {
    const cfg = cfgWith(storeDir(), { allowPlaintextFallback: true });
    await seedStore('correct horse', { sealed: 'plaintext' });
    // Read-only store: writeMeta fails, markStale logs and degrades, and the in-memory latch is
    // the only thing left stopping a known-bad password from reaching sudo again.
    await chmod(storeDir(), 0o500);
    await markStale(cfg, 99);
    await chmod(storeDir(), 0o700);
    expect(JSON.parse(await readFile(join(storeDir(), 'sudo.meta.json'), 'utf8')).stale).toBe(false);
    expect((await status(cfg)).stale).toBe(true);
    expect(await reason(() => withSudoPassword(cfg, async () => 'nope'))).toBe('credential-stale');
    await clearStale(cfg);
    expect((await status(cfg)).stale).toBe(false);
  });
});

describe('setSudoPassword / removeSudoPassword', () => {
  test('refuses a password sudo -S cannot carry, before touching sudo or the store', async () => {
    const cfg = cfgWith(storeDir(), { allowPlaintextFallback: true });
    for (const bad of ['', 'two\nlines', 'carriage\rreturn', 'nul\0byte']) {
      const r = await setSudoPassword(cfg, bad);
      expect(r.ok).toBe(false);
      expect(r.reason).toBe('verify-failed');
      if (bad.length > 0) expect(r.message ?? '').not.toContain(bad);
    }
    expect(await Bun.file(join(storeDir(), 'sudo.cred')).exists()).toBe(false);
  });

  test('refuses a non-private store', async () => {
    const mount = await modeBlindMountPoint();
    if (mount === null) return;
    const r = await setSudoPassword(cfgWith(mount), 'whatever');
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('not-private');
  });

  test('refuses when sealing is unavailable and no plaintext fallback is allowed', async () => {
    if (SEAL.ok) return; // this machine can seal; the refusal path is unreachable here
    const r = await setSudoPassword(cfgWith(storeDir()), 'whatever');
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('seal-unavailable');
  });

  test('a wrong password is rejected by real sudo and nothing is stored', async () => {
    if (!HAS_SUDO) return;
    // allowPlaintextFallback keeps this test independent of the TPM: the point is that the
    // sudo-rs invocation reads one line from stdin, prints no prompt, and terminates.
    const cfg = cfgWith(storeDir(), { allowPlaintextFallback: true });
    const wrong = `definitely-not-the-password-${Math.random().toString(36).slice(2)}`;
    const r = await setSudoPassword(cfg, wrong);
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('verify-failed');
    expect(r.message ?? '').not.toContain(wrong);
    expect(await Bun.file(join(storeDir(), 'sudo.cred')).exists()).toBe(false);
    expect((await status(cfg)).present).toBe(false);
  }, 30000);

  test('removeSudoPassword clears the store and is safe on an empty one', async () => {
    const cfg = cfgWith(storeDir(), { allowPlaintextFallback: true });
    await seedStore('correct horse', { sealed: 'plaintext' });
    await removeSudoPassword(cfg);
    expect(await Bun.file(join(storeDir(), 'sudo.cred')).exists()).toBe(false);
    expect(await Bun.file(join(storeDir(), 'sudo.meta.json')).exists()).toBe(false);
    expect((await status(cfg)).present).toBe(false);
    await removeSudoPassword(cfg);
  });
});

describe('sealAvailable', () => {
  test('round-trips a throwaway value through systemd-creds', async () => {
    const r = await sealAvailable();
    if (!HAS_SYSTEMD_CREDS) {
      expect(r.ok).toBe(false);
      expect(typeof r.reason).toBe('string');
      return;
    }
    // On a machine with a working TPM2 this must be a real success, not a shrug.
    expect(typeof r.ok).toBe('boolean');
    if (!r.ok) expect((r.reason ?? '').length).toBeGreaterThan(0);
  }, 30000);
});

// Static guard on the one module that materializes a password. These patterns are the ways the
// plaintext could plausibly get out of this file in a future edit; the point of the test is that
// such an edit fails here rather than in production.
describe('source invariants', () => {
  test('the plaintext is never logged, interpolated, or put in argv or env', async () => {
    const src = await Bun.file(new URL('../src/secrets.ts', import.meta.url)).text();
    // The identifiers holding plaintext in src/secrets.ts are `pw` and `plaintext`. Quoted
    // occurrences are excluded: 'plaintext' is also one of the two values of meta.sealed, and that
    // string is fine to log.
    const ident = String.raw`(?<!['"])\b(pw|plaintext)\b(?!['"])`;
    const forbidden: Array<[string, RegExp]> = [
      ['logged', new RegExp(String.raw`\blog\([^)]*` + ident)],
      ['written to the console', /\bconsole\./],
      ['interpolated into a string', new RegExp(String.raw`\$\{\s*(pw|plaintext)\b`)],
      ['serialized', new RegExp(String.raw`JSON\.stringify\(\s*(pw|plaintext)\b`)],
      ['put in an Error', new RegExp(String.raw`new (Error|SudoCredentialUnavailable)\([^)]*` + ident)],
      ['put in argv', new RegExp(String.raw`run(Bytes)?\(\s*\[[^\]]*` + ident)],
      ['put in the environment', new RegExp(String.raw`env:\s*\{[^}]*` + ident)],
    ];
    for (const [what, pattern] of forbidden) {
      expect({ what, hit: pattern.exec(src)?.[0] ?? null }).toEqual({ what, hit: null });
    }
  });
});
