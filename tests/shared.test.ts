// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, test, expect } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { canonicalJson, atomicWrite, readJsonFile, run, nowMs, b64encode, b64decode, sleep, TransitionGate } from '../src/util';
import {
  loadConfig,
  defaultConfig,
  configDir,
  stateDir,
  expandHome,
  secretsDir,
  patchConfig,
} from '../src/config';

async function withTmpDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), 'sukarfleet-test-'));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

describe('canonicalJson', () => {
  test('sorts object keys recursively by codepoint', () => {
    const v = { b: 1, a: { d: 2, c: 3 }, aa: 0 };
    expect(canonicalJson(v)).toBe('{"a":{"c":3,"d":2},"aa":0,"b":1}');
  });

  test('keeps array order, recurses into elements', () => {
    const v = { list: [{ b: 1, a: 2 }, 3, 'x'] };
    expect(canonicalJson(v)).toBe('{"list":[{"a":2,"b":1},3,"x"]}');
  });

  test('produces no whitespace', () => {
    expect(canonicalJson({ a: 1, b: [1, 2] })).not.toMatch(/\s/);
  });

  test('sorts unicode keys by codepoint, not locale collation', () => {
    // 'Z' (U+005A) < 'a' (U+0061) < 'ä' (U+00E4) in codepoint order,
    // but locale-aware collation would typically interleave case-insensitively.
    const v: Record<string, number> = { ä: 1, a: 2, Z: 3 };
    expect(canonicalJson(v)).toBe('{"Z":3,"a":2,"ä":1}');
  });

  test('null and undefined encode as null; undefined object props are dropped', () => {
    expect(canonicalJson(null)).toBe('null');
    expect(canonicalJson({ a: undefined, b: 1 })).toBe('{"b":1}');
    expect(canonicalJson([1, undefined, 2])).toBe('[1,null,2]');
  });

  test('same object, different key insertion order, same output', () => {
    const v1 = { x: 1, y: 2, z: 3 };
    const v2 = { z: 3, x: 1, y: 2 };
    expect(canonicalJson(v1)).toBe(canonicalJson(v2));
  });
});

describe('atomicWrite / readJsonFile', () => {
  test('round trips JSON through a temp dir, creating parents', async () => {
    await withTmpDir(async (dir) => {
      const p = join(dir, 'nested', 'sub', 'file.json');
      const data = { hello: 'world', n: 42, arr: [1, 2, 3] };
      await atomicWrite(p, JSON.stringify(data));
      const read = await readJsonFile<typeof data>(p);
      expect(read).toEqual(data);
    });
  });

  test('readJsonFile returns null for missing file', async () => {
    await withTmpDir(async (dir) => {
      const read = await readJsonFile(join(dir, 'nope.json'));
      expect(read).toBeNull();
    });
  });

  test('readJsonFile returns null for malformed JSON', async () => {
    await withTmpDir(async (dir) => {
      const p = join(dir, 'bad.json');
      await atomicWrite(p, 'not json{');
      const read = await readJsonFile(p);
      expect(read).toBeNull();
    });
  });

  test('atomicWrite leaves no tmp files behind on success', async () => {
    await withTmpDir(async (dir) => {
      await atomicWrite(join(dir, 'f.json'), '{}');
      const glob = new Bun.Glob('.tmp-*');
      const leftovers: string[] = [];
      for await (const f of glob.scan({ cwd: dir })) leftovers.push(f);
      expect(leftovers).toEqual([]);
    });
  });
});

describe('run', () => {
  test('captures stdout, stderr, and exit code', async () => {
    const res = await run(['bash', '-c', 'echo out; echo err 1>&2; exit 3']);
    expect(res.code).toBe(3);
    expect(res.stdout).toBe('out\n');
    expect(res.stderr).toBe('err\n');
  });

  test('pipes stdin through', async () => {
    const res = await run(['cat'], { stdin: 'hello stdin' });
    expect(res.stdout).toBe('hello stdin');
    expect(res.code).toBe(0);
  });

  test('kills the process and returns on timeout', async () => {
    const start = nowMs();
    const res = await run(['sleep', '10'], { timeoutMs: 200 });
    const elapsed = nowMs() - start;
    expect(res.code).toBe(124);
    expect(elapsed).toBeLessThan(5000);
  });

  // Regression: the 2026-07-22 sync-loop wedge. A grandchild (git-remote-http)
  // inherits the stdout/stderr pipe write ends; if it hangs after the direct
  // child exits, awaiting pipe EOF blocks forever. run() must return shortly
  // after the direct child exits, not when the last fd holder goes away.
  test('returns after the child exits even if a grandchild holds the pipes open', async () => {
    const start = nowMs();
    const res = await run(['bash', '-c', 'echo before; sleep 30 & echo after; exit 0']);
    const elapsed = nowMs() - start;
    expect(res.code).toBe(0);
    expect(res.stdout).toContain('before');
    expect(res.stdout).toContain('after');
    expect(elapsed).toBeLessThan(10000); // pipe-drain grace, not the grandchild's 30s
  });

  // Regression: proc.kill() sends SIGTERM, which a child can trap or ignore;
  // the old run() then waited on it forever. Timeout must escalate to SIGKILL.
  test('escalates to SIGKILL when the child ignores SIGTERM', async () => {
    const start = nowMs();
    const res = await run(['bash', '-c', 'trap "" TERM; sleep 30'], {
      timeoutMs: 200,
      killGraceMs: 500,
    });
    const elapsed = nowMs() - start;
    expect(res.code).toBe(124);
    expect(elapsed).toBeLessThan(10000);
  });
});

describe('b64encode / b64decode', () => {
  test('round trips bytes', () => {
    const bytes = new Uint8Array([0, 1, 2, 250, 251, 252, 253, 254, 255]);
    const encoded = b64encode(bytes);
    expect(typeof encoded).toBe('string');
    expect(b64decode(encoded)).toEqual(bytes);
  });
});

describe('sleep', () => {
  test('resolves after roughly the requested delay', async () => {
    const start = nowMs();
    await sleep(50);
    expect(nowMs() - start).toBeGreaterThanOrEqual(40);
  });
});

describe('TransitionGate', () => {
  test('an unseen key reported ok is still-ok', () => {
    const gate = new TransitionGate();
    expect(gate.observe('a', false)).toBe('still-ok');
  });

  test('first bad observation enters, repeats stay still-bad', () => {
    const gate = new TransitionGate();
    expect(gate.observe('a', true)).toBe('entered');
    expect(gate.observe('a', true)).toBe('still-bad');
    expect(gate.observe('a', true)).toBe('still-bad');
  });

  test('going ok after bad recovers once, then stays still-ok', () => {
    const gate = new TransitionGate();
    gate.observe('a', true);
    expect(gate.observe('a', false)).toBe('recovered');
    expect(gate.observe('a', false)).toBe('still-ok');
  });

  test('re-entering bad after a recovery reports entered again', () => {
    const gate = new TransitionGate();
    gate.observe('a', true);
    gate.observe('a', false); // recovered
    expect(gate.observe('a', true)).toBe('entered');
  });

  test('keys are independent of each other', () => {
    const gate = new TransitionGate();
    expect(gate.observe('a', true)).toBe('entered');
    expect(gate.observe('b', true)).toBe('entered');
    expect(gate.observe('a', true)).toBe('still-bad');
    expect(gate.observe('b', false)).toBe('recovered');
  });

  test('forget() resets a key as though it were never observed', () => {
    const gate = new TransitionGate();
    gate.observe('a', true);
    gate.forget('a');
    expect(gate.observe('a', true)).toBe('entered');
  });

  test('forget() on an unknown key is a harmless no-op', () => {
    const gate = new TransitionGate();
    expect(() => gate.forget('nope')).not.toThrow();
  });
});

describe('config', () => {
  test('defaultConfig produces a valid, fully-populated config', () => {
    const cfg = defaultConfig('testmachine');
    expect(cfg.machine).toBe('testmachine');
    expect(cfg.role).toBe('anchor');
    expect(cfg.nodePort).toBe(7710);
    expect(cfg.easytier.rpcAddr).toBe('127.0.0.1:15888');
    expect(cfg.easytier.serviceName).toBe('easytier-fleet.service');
    expect(cfg.intervals).toEqual({
      gossipSec: 20,
      syncSec: 120,
      watchdogSec: 120,
      transportPollSec: 30,
    });
    expect(cfg.thresholds).toEqual({
      syncStaleMin: 30,
      alarmRepeatMin: 30,
      peerOfflineFactor: 3,
      clockSkewMaxMs: 5000,
      wedgePolls: 3,
    });
    expect(cfg.peers).toEqual([]);
    expect(cfg.repos).toEqual([]);
    expect(cfg.unionPaths).toEqual([]);
  });

  test('configDir and stateDir respect SUKARFLEET_STATE / fall back to home', () => {
    expect(configDir()).toMatch(/\.config\/sukarfleet$/);
    const prev = process.env.SUKARFLEET_STATE;
    try {
      delete process.env.SUKARFLEET_STATE;
      expect(stateDir()).toMatch(/\.local\/state\/sukarfleet$/);
      process.env.SUKARFLEET_STATE = '/custom/state/dir';
      expect(stateDir()).toBe('/custom/state/dir');
    } finally {
      if (prev === undefined) delete process.env.SUKARFLEET_STATE;
      else process.env.SUKARFLEET_STATE = prev;
    }
  });

  test('loadConfig reads a minimal file and fills in defaults', async () => {
    await withTmpDir(async (dir) => {
      const p = join(dir, 'config.json');
      await atomicWrite(p, JSON.stringify({ machine: 'alpha' }));
      const cfg = await loadConfig(p);
      expect(cfg.machine).toBe('alpha');
      expect(cfg.nodePort).toBe(7710);
      expect(cfg.role).toBe('anchor');
      expect(cfg.easytier.cliPath).toBe('/opt/easytier/easytier-cli');
    });
  });

  test('loadConfig honors SUKARFLEET_CONFIG env var when no path is given', async () => {
    await withTmpDir(async (dir) => {
      const p = join(dir, 'config.json');
      await atomicWrite(p, JSON.stringify({ machine: 'beta', role: 'roamer' }));
      const prev = process.env.SUKARFLEET_CONFIG;
      process.env.SUKARFLEET_CONFIG = p;
      try {
        const cfg = await loadConfig();
        expect(cfg.machine).toBe('beta');
        expect(cfg.role).toBe('roamer');
      } finally {
        if (prev === undefined) delete process.env.SUKARFLEET_CONFIG;
        else process.env.SUKARFLEET_CONFIG = prev;
      }
    });
  });

  test('loadConfig merges nested overrides without dropping other defaults', async () => {
    await withTmpDir(async (dir) => {
      const p = join(dir, 'config.json');
      await atomicWrite(p, JSON.stringify({ machine: 'alpha', intervals: { gossipSec: 5 } }));
      const cfg = await loadConfig(p);
      expect(cfg.intervals.gossipSec).toBe(5);
      expect(cfg.intervals.syncSec).toBe(120); // default preserved
    });
  });

  test('loadConfig throws a clear error when machine is missing', async () => {
    await withTmpDir(async (dir) => {
      const p = join(dir, 'config.json');
      await atomicWrite(p, JSON.stringify({ role: 'anchor' }));
      await expect(loadConfig(p)).rejects.toThrow(/machine/);
    });
  });

  test('loadConfig throws a clear error on invalid role', async () => {
    await withTmpDir(async (dir) => {
      const p = join(dir, 'config.json');
      await atomicWrite(p, JSON.stringify({ machine: 'alpha', role: 'bogus' }));
      await expect(loadConfig(p)).rejects.toThrow(/role/);
    });
  });

  test('loadConfig throws a clear error for a missing file', async () => {
    await withTmpDir(async (dir) => {
      await expect(loadConfig(join(dir, 'missing.json'))).rejects.toThrow();
    });
  });

  test('loadConfig validates malformed peer entries', async () => {
    await withTmpDir(async (dir) => {
      const p = join(dir, 'config.json');
      await atomicWrite(
        p,
        JSON.stringify({ machine: 'alpha', peers: [{ name: 'beta', meshIp: '203.0.113.2' }] }),
      );
      await expect(loadConfig(p)).rejects.toThrow(/peers\[0\]\.nodePort/);
    });
  });

  // A config written before the admin lane existed must keep booting the daemon untouched.
  test('a config file with no admin key still loads, with admin defaults filled in', async () => {
    await withTmpDir(async (dir) => {
      const p = join(dir, 'config.json');
      await atomicWrite(p, JSON.stringify({ machine: 'alpha' }));
      const cfg = await loadConfig(p);
      expect(cfg.admin.enabled).toBe(false);
      expect(cfg.admin.credentialMode).toBe('stored-password');
      expect(cfg.admin.maxOutputBytes).toBe(262144);
    });
  });
});

describe('run maxCaptureBytes', () => {
  test('uncapped runs keep their historical result shape (no truncated field)', async () => {
    const res = await run(['bash', '-c', 'echo out']);
    expect(res.stdout).toBe('out\n');
    expect('truncated' in res).toBe(false);
  });

  test('caps each stream independently and reports truncation', async () => {
    const res = await run(['bash', '-c', 'printf "%0.sa" $(seq 1 5000); printf "%0.sb" $(seq 1 5000) 1>&2'], {
      maxCaptureBytes: 100,
    });
    expect(res.code).toBe(0);
    expect(res.stdout.length).toBe(100);
    expect(res.stderr.length).toBe(100);
    expect(res.truncated).toBe(true);
  });

  test('output under the cap is untruncated and complete', async () => {
    const res = await run(['bash', '-c', 'echo short'], { maxCaptureBytes: 4096 });
    expect(res.stdout).toBe('short\n');
    expect(res.truncated).toBe(false);
  });

  // Regression guard for the cap's implementation: past the cap the reader must keep draining to
  // EOF. Cancelling it instead leaves the writer blocked on a full pipe, which is the 8.5h
  // sync-loop wedge (see util.ts's runBytes header) reintroduced through a new door.
  test('a writer far exceeding the cap still exits, and its exit code survives', async () => {
    const start = nowMs();
    const res = await run(['bash', '-c', 'yes | head -c 4000000; exit 7'], { maxCaptureBytes: 1024 });
    expect(res.code).toBe(7);
    expect(res.stdout.length).toBe(1024);
    expect(res.truncated).toBe(true);
    expect(nowMs() - start).toBeLessThan(20000);
  });
});

describe('expandHome / secretsDir', () => {
  test("expands a leading '~' and leaves everything else alone", () => {
    expect(expandHome('~')).toBe(homedir());
    expect(expandHome('~/.ssh/id_sukarfleet_ed25519')).toBe(join(homedir(), '.ssh', 'id_sukarfleet_ed25519'));
    expect(expandHome('/absolute/path')).toBe('/absolute/path');
    expect(expandHome('~otheruser/x')).toBe('~otheruser/x');
  });

  test('secretsDir follows the config when given one, else the default store', () => {
    expect(secretsDir()).toBe(join(configDir(), 'secrets'));
    const cfg = defaultConfig('alpha');
    cfg.admin.secretsDir = '~/scratch-secrets';
    expect(secretsDir(cfg)).toBe(join(homedir(), 'scratch-secrets'));
  });
});

describe('patchConfig', () => {
  test('mutates the raw file, keeps unknown keys, returns the merged config, writes 0600', async () => {
    await withTmpDir(async (dir) => {
      const p = join(dir, 'config.json');
      await atomicWrite(p, JSON.stringify({ machine: 'alpha', futureKey: 'keep me' }, null, 2) + '\n');
      const merged = await patchConfig((raw) => {
        raw.peers = [{ name: 'beta', meshIp: '192.0.2.2', nodePort: 7710, publicKeyJwk: null }];
      }, p);
      expect(merged.peers).toHaveLength(1);
      expect(merged.admin.sshPort).toBe(22);
      const onDisk = await readJsonFile<Record<string, unknown>>(p);
      expect(onDisk?.futureKey).toBe('keep me');
      expect((onDisk?.peers as unknown[]).length).toBe(1);
      expect((await stat(p)).mode & 0o777).toBe(0o600);
    });
  });

  // A rejected mutation must not reach the file: an invalid config.json is a daemon that will not
  // boot, and there is no second chance to fix it from the GUI once that happens.
  test('a mutation that fails validation leaves the file byte-identical', async () => {
    await withTmpDir(async (dir) => {
      const p = join(dir, 'config.json');
      const original = JSON.stringify({ machine: 'alpha' }, null, 2) + '\n';
      await atomicWrite(p, original);
      await expect(
        patchConfig((raw) => {
          raw.admin = { runTimeoutSec: 600, maxRunTimeoutSec: 60 };
        }, p),
      ).rejects.toThrow(/maxRunTimeoutSec/);
      expect(await Bun.file(p).text()).toBe(original);
    });
  });

  test('serializes concurrent patches instead of losing one', async () => {
    await withTmpDir(async (dir) => {
      const p = join(dir, 'config.json');
      await atomicWrite(p, JSON.stringify({ machine: 'alpha', peers: [] }, null, 2) + '\n');
      const addPeer = (name: string, ip: string) => (raw: Record<string, unknown>) => {
        const peers = (raw.peers as unknown[]) ?? [];
        peers.push({ name, meshIp: ip, nodePort: 7710, publicKeyJwk: null });
        raw.peers = peers;
      };
      await Promise.all([
        patchConfig(addPeer('a', '192.0.2.2'), p),
        patchConfig(addPeer('b', '192.0.2.3'), p),
      ]);
      const cfg = await loadConfig(p);
      expect(cfg.peers.map((peer) => peer.name).sort()).toEqual(['a', 'b']);
    });
  });
});
