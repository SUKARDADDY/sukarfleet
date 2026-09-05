// SPDX-License-Identifier: AGPL-3.0-or-later
import { test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Syncer, type SyncerDeps, type SyncerOptions } from '../src/syncer';
import { defaultConfig } from '../src/config';
import { run } from '../src/util';
import type { RunOptions, RunResult } from '../src/util';
import type { FleetConfig, RepoConfig, PresenceRepoStat, PeerConfig, MachineKey } from '../src/types';

// SyncerDeps.machineKey signs the x-fleet-auth header fetchAll attaches to fleet-<peer>
// fetches. Its content is irrelevant to these tests (remotes are local file:// dirs, never
// routed through gitserve's verifier), so one shared key suffices for every recorder().
async function makeTestMachineKey(): Promise<MachineKey> {
  const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  const publicKeyJwk = await crypto.subtle.exportKey('jwk', pair.publicKey);
  const privateKeyJwk = await crypto.subtle.exportKey('jwk', pair.privateKey);
  return { machine: 'test', publicKeyJwk, privateKeyJwk };
}

const TEST_MACHINE_KEY = await makeTestMachineKey();

let base: string;

beforeEach(async () => {
  base = await mkdtemp(join(tmpdir(), 'sukarfleet-sync-'));
});

afterEach(async () => {
  await rm(base, { recursive: true, force: true });
});

const FAST: SyncerOptions = { sleep: async () => {}, debounceMs: 0, pushBackoffMs: [1, 1, 1] };

async function git(cwd: string, args: string[], env?: Record<string, string>) {
  const r = await run(['git', ...args], { cwd, env });
  if (r.code !== 0) throw new Error(`git ${args.join(' ')} (in ${cwd}): ${r.stderr || r.stdout}`);
  return r;
}

async function configRepo(dir: string, name: string) {
  await git(dir, ['config', 'user.email', `${name}@test`]);
  await git(dir, ['config', 'user.name', name]);
  await git(dir, ['config', 'commit.gpgsign', 'false']);
  await git(dir, ['config', 'core.filemode', 'false']);
}

function peer(name: string): PeerConfig {
  return { name, meshIp: '127.0.0.1', nodePort: 7710, publicKeyJwk: null };
}

function makeConfig(machine: string, peers: PeerConfig[], repoPath: string, extra?: Partial<FleetConfig>): FleetConfig {
  const repo: RepoConfig = { name: 'r', path: repoPath, ...(extra?.repos?.[0] ?? {}) };
  return {
    ...defaultConfig(machine),
    machine,
    peers,
    repos: [repo],
    unionPaths: extra?.unionPaths ?? [],
  };
}

interface Recorder {
  deps: SyncerDeps;
  stats: PresenceRepoStat[];
  pushes: (number | null)[];
  conflicts: string[];
}

function recorder(vetted = true): Recorder {
  const stats: PresenceRepoStat[] = [];
  const pushes: (number | null)[] = [];
  const conflicts: string[] = [];
  return {
    stats,
    pushes,
    conflicts,
    deps: {
      isClockVetted: () => vetted,
      onRepoStat: (_r, s) => stats.push(s),
      onGithubPush: (_r, ms) => pushes.push(ms),
      onConflictArtifact: (_r, p) => conflicts.push(p),
      machineKey: TEST_MACHINE_KEY,
    },
  };
}

// Two machines sharing a base commit, each on its own sync branch, cross-wired as fleet remotes.
async function setupPair(baseFiles: Record<string, string> = {}, unionPaths: string[] = [], postMerge?: string[][]) {
  const dirA = join(base, 'alpha');
  const dirB = join(base, 'beta');
  await mkdir(dirA, { recursive: true });
  await git(dirA, ['init', '-q', '-b', 'main']);
  await configRepo(dirA, 'alpha');
  for (const [f, c] of Object.entries(baseFiles)) {
    await writeFile(join(dirA, f), c);
  }
  await git(dirA, ['add', '-A']);
  await git(dirA, ['commit', '-q', '-m', 'base']);
  await git(dirA, ['clone', '-q', dirA, dirB]);
  await configRepo(dirB, 'beta');
  await git(dirB, ['remote', 'remove', 'origin']);

  const recA = recorder();
  const recB = recorder();

  const extra: Partial<FleetConfig> = { unionPaths };
  const cfgA = makeConfig('alpha', [peer('beta')], dirA, extra);
  const cfgB = makeConfig('beta', [peer('alpha')], dirB, extra);
  if (postMerge) {
    cfgA.repos[0]!.postMerge = postMerge;
    cfgB.repos[0]!.postMerge = postMerge;
  }

  const syncA = new Syncer(cfgA, recA.deps, FAST);
  const syncB = new Syncer(cfgB, recB.deps, FAST);

  await syncA.adoptRepo(dirA, 'alpha');
  await syncB.adoptRepo(dirB, 'beta');

  await git(dirA, ['remote', 'add', 'fleet-beta', `file://${dirB}`]);
  await git(dirB, ['remote', 'add', 'fleet-alpha', `file://${dirA}`]);

  return { dirA, dirB, syncA, syncB, recA, recB, repoA: cfgA.repos[0]!, repoB: cfgB.repos[0]! };
}

test('adoptRepo creates and checks out sync/<machine>', async () => {
  const dir = join(base, 'repo');
  await mkdir(dir, { recursive: true });
  await git(dir, ['init', '-q', '-b', 'main']);
  await configRepo(dir, 'alpha');
  await writeFile(join(dir, 'x.txt'), 'x');
  await git(dir, ['add', '-A']);
  await git(dir, ['commit', '-q', '-m', 'base']);

  const rec = recorder();
  const s = new Syncer(makeConfig('alpha', [], dir), rec.deps, FAST);
  await s.adoptRepo(dir, 'alpha');
  const head = await git(dir, ['symbolic-ref', '--short', 'HEAD']);
  expect(head.stdout.trim()).toBe('sync/alpha');
});

test('adoptRepo refuses with an unfinished merge in progress', async () => {
  const dir = join(base, 'repo');
  await mkdir(dir, { recursive: true });
  await git(dir, ['init', '-q', '-b', 'main']);
  await configRepo(dir, 'alpha');
  await writeFile(join(dir, 'x.txt'), 'x');
  await git(dir, ['add', '-A']);
  await git(dir, ['commit', '-q', '-m', 'base']);
  const head = (await git(dir, ['rev-parse', 'HEAD'])).stdout.trim();
  await writeFile(join(dir, '.git', 'MERGE_HEAD'), head + '\n');

  const rec = recorder();
  const s = new Syncer(makeConfig('alpha', [], dir), rec.deps, FAST);
  await expect(s.adoptRepo(dir, 'alpha')).rejects.toThrow(/MERGE_HEAD/);
});

test('ensureFleetRemotes sets fleet-<peer> URLs and is idempotent', async () => {
  const dir = join(base, 'repo');
  await mkdir(dir, { recursive: true });
  await git(dir, ['init', '-q', '-b', 'main']);
  await configRepo(dir, 'alpha');

  const cfg = makeConfig('alpha', [peer('beta')], dir);
  cfg.peers[0]!.meshIp = '203.0.113.2';
  cfg.repos[0]!.name = 'memory';
  const rec = recorder();
  const s = new Syncer(cfg, rec.deps, FAST);

  await s.ensureFleetRemotes(cfg.repos[0]!);
  let url = (await git(dir, ['remote', 'get-url', 'fleet-beta'])).stdout.trim();
  expect(url).toBe('http://203.0.113.2:7710/git/memory');

  // second run updates in place, no duplicate remote
  cfg.peers[0]!.nodePort = 8000;
  await s.ensureFleetRemotes(cfg.repos[0]!);
  url = (await git(dir, ['remote', 'get-url', 'fleet-beta'])).stdout.trim();
  expect(url).toBe('http://203.0.113.2:8000/git/memory');
  const remotes = (await git(dir, ['remote'])).stdout.split('\n').filter(Boolean);
  expect(remotes.filter((r) => r === 'fleet-beta').length).toBe(1);
});

test('refuses to sync when HEAD is not sync/<machine>', async () => {
  const dir = join(base, 'repo');
  await mkdir(dir, { recursive: true });
  await git(dir, ['init', '-q', '-b', 'main']);
  await configRepo(dir, 'alpha');
  await writeFile(join(dir, 'x.txt'), 'x');
  await git(dir, ['add', '-A']);
  await git(dir, ['commit', '-q', '-m', 'base']);

  const rec = recorder();
  const s = new Syncer(makeConfig('alpha', [], dir), rec.deps, FAST);
  await s.syncOnce({ name: 'r', path: dir }); // HEAD is main, not sync/alpha
  expect(rec.stats).toHaveLength(1);
  expect(rec.stats[0]!.syncError).toMatch(/expected 'sync\/alpha'/);
  expect(rec.stats[0]!.lastSyncOkMs).toBeNull();
});

test('first sync round-trips a file between two machines', async () => {
  const { dirA, dirB, syncA, syncB, recA, recB, repoA, repoB } = await setupPair({ 'seed.txt': 'seed\n' });

  await writeFile(join(dirA, 'foo.txt'), 'hello\n');
  await syncA.syncOnce(repoA); // alpha auto-commits foo on sync/alpha
  await syncB.syncOnce(repoB); // beta fetches + merges alpha -> gets foo

  expect(await readFile(join(dirB, 'foo.txt'), 'utf8')).toBe('hello\n');
  expect(recA.conflicts).toHaveLength(0);
  expect(recB.conflicts).toHaveLength(0);
  expect(recB.stats.at(-1)!.syncError).toBeNull();
  expect(recB.stats.at(-1)!.lastSyncOkMs).not.toBeNull();
});

test('hand-off: A edits, B merges, B edits on top -> no conflict artifact', async () => {
  const { dirA, dirB, syncA, syncB, recA, recB, repoA, repoB } = await setupPair({ 'foo.txt': 'base\n' });

  await writeFile(join(dirA, 'foo.txt'), 'a-edit\n');
  await syncA.syncOnce(repoA);
  await syncB.syncOnce(repoB); // beta now has a-edit
  expect(await readFile(join(dirB, 'foo.txt'), 'utf8')).toBe('a-edit\n');

  await writeFile(join(dirB, 'foo.txt'), 'a-edit-then-b\n');
  await syncB.syncOnce(repoB); // beta commits its edit on top of a-edit
  await syncA.syncOnce(repoA); // alpha merges beta -> fast, no conflict

  expect(await readFile(join(dirA, 'foo.txt'), 'utf8')).toBe('a-edit-then-b\n');
  expect(recA.conflicts).toHaveLength(0);
  expect(recB.conflicts).toHaveLength(0);
});

test('genuine concurrent edit -> newest-wins + artifact + committed merge', async () => {
  const { dirA, dirB, syncA, recA, repoA } = await setupPair({ 'foo.txt': 'base\n' });

  const early = { GIT_AUTHOR_DATE: '2026-01-01T00:00:00+00:00', GIT_COMMITTER_DATE: '2026-01-01T00:00:00+00:00' };
  const late = { GIT_AUTHOR_DATE: '2026-06-01T00:00:00+00:00', GIT_COMMITTER_DATE: '2026-06-01T00:00:00+00:00' };

  await writeFile(join(dirA, 'foo.txt'), 'alpha-version\n');
  await git(dirA, ['commit', '-q', '-am', 'edit A'], early);
  await writeFile(join(dirB, 'foo.txt'), 'beta-version\n');
  await git(dirB, ['commit', '-q', '-am', 'edit B'], late);

  await syncA.syncOnce(repoA); // alpha fetches beta, conflict on foo, newest-wins -> beta

  expect(await readFile(join(dirA, 'foo.txt'), 'utf8')).toBe('beta-version\n');
  expect(recA.conflicts).toHaveLength(1);
  expect(recA.conflicts[0]).toMatch(/^\.sync-conflicts\/.*-alpha\/foo\.txt$/);

  // losing side (alpha) preserved as committed artifact
  const conflictRoot = join(dirA, '.sync-conflicts');
  const dirs = await readdir(conflictRoot);
  expect(dirs).toHaveLength(1);
  const artifact = await readFile(join(conflictRoot, dirs[0]!, 'foo.txt'), 'utf8');
  expect(artifact).toBe('alpha-version\n');

  // HEAD is a merge commit (two parents) and the tree is clean
  const parents = (await git(dirA, ['rev-list', '--parents', '-n', '1', 'HEAD'])).stdout.trim().split(' ');
  expect(parents).toHaveLength(3);
  const status = (await git(dirA, ['status', '--porcelain'])).stdout.trim();
  expect(status).toBe('');
  expect(recA.stats.at(-1)!.syncError).toBeNull();
});

test('tied author timestamps -> machine name ascending by codepoint wins', async () => {
  const { dirA, dirB, syncA, recA, repoA } = await setupPair({ 'foo.txt': 'base\n' });

  // Same instant on both sides: forces the codepointCompare(machine, peerName) tie-break
  // path (syncer.ts:245) rather than the oursAt/theirsAt branches (syncer.ts:243-244).
  const tied = { GIT_AUTHOR_DATE: '2026-03-01T00:00:00+00:00', GIT_COMMITTER_DATE: '2026-03-01T00:00:00+00:00' };

  await writeFile(join(dirA, 'foo.txt'), 'alpha-version\n');
  await git(dirA, ['commit', '-q', '-am', 'edit A'], tied);
  await writeFile(join(dirB, 'foo.txt'), 'beta-version\n');
  await git(dirB, ['commit', '-q', '-am', 'edit B'], tied);

  await syncA.syncOnce(repoA); // tie: 'alpha' < 'beta' by codepoint -> alpha (ours) wins

  expect(await readFile(join(dirA, 'foo.txt'), 'utf8')).toBe('alpha-version\n');
  expect(recA.conflicts).toHaveLength(1);
  expect(recA.conflicts[0]).toMatch(/^\.sync-conflicts\/.*-beta\/foo\.txt$/);

  // losing side (beta) preserved as committed artifact
  const conflictRoot = join(dirA, '.sync-conflicts');
  const dirs = await readdir(conflictRoot);
  expect(dirs).toHaveLength(1);
  const artifact = await readFile(join(conflictRoot, dirs[0]!, 'foo.txt'), 'utf8');
  expect(artifact).toBe('beta-version\n');

  const status = (await git(dirA, ['status', '--porcelain'])).stdout.trim();
  expect(status).toBe('');
  expect(recA.stats.at(-1)!.syncError).toBeNull();
});

test('union path is regenerated by postMerge, not newest-wins clobbered', async () => {
  const regen = ['bash', '-c', 'printf "REGEN\\n" > manifest.txt'];
  const { dirA, dirB, syncA, recA, repoA } = await setupPair({ 'manifest.txt': 'base\n' }, ['manifest.txt'], [regen]);

  const early = { GIT_AUTHOR_DATE: '2026-01-01T00:00:00+00:00', GIT_COMMITTER_DATE: '2026-01-01T00:00:00+00:00' };
  const late = { GIT_AUTHOR_DATE: '2026-06-01T00:00:00+00:00', GIT_COMMITTER_DATE: '2026-06-01T00:00:00+00:00' };

  await writeFile(join(dirA, 'manifest.txt'), 'alpha-manifest\n');
  await git(dirA, ['commit', '-q', '-am', 'edit A'], early);
  await writeFile(join(dirB, 'manifest.txt'), 'beta-manifest\n');
  await git(dirB, ['commit', '-q', '-am', 'edit B'], late);

  await syncA.syncOnce(repoA);

  expect(await readFile(join(dirA, 'manifest.txt'), 'utf8')).toBe('REGEN\n');
  expect(recA.conflicts).toHaveLength(0); // union paths never produce newest-wins artifacts

  const log = (await git(dirA, ['log', '--format=%s', '-n', '3'])).stdout;
  expect(log).toMatch(/postmerge: alpha/);
  const status = (await git(dirA, ['status', '--porcelain'])).stdout.trim();
  expect(status).toBe('');
});

test('push retry on a broken origin records failure without throwing', async () => {
  const { dirA, syncA, recA, repoA } = await setupPair({ 'foo.txt': 'base\n' });
  await git(dirA, ['remote', 'add', 'origin', 'file:///nonexistent/nope.git']);

  await writeFile(join(dirA, 'foo.txt'), 'edited\n');
  await syncA.syncOnce(repoA); // commits, then push fails all retries

  expect(recA.pushes).toEqual([null]);
  // push failure is a separate GitHub signal; the sync cycle itself still succeeds
  expect(recA.stats.at(-1)!.syncError).toBeNull();
  expect(recA.stats.at(-1)!.lastSyncOkMs).not.toBeNull();
});

test('syncOnce reports whether origin was reachable this cycle (P3 takeover gate input)', async () => {
  // null: no origin remote at all. setupPair leaves dirA without one.
  const { dirA, syncA, repoA } = await setupPair({ 'foo.txt': 'base\n' });
  expect((await syncA.syncOnce(repoA)).originFetchOk).toBeNull();

  // false: origin configured but unreachable. The cycle itself still succeeds -- only the answer
  // to "did we see origin" changes, which is what P3's per-repo veto reads.
  await git(dirA, ['remote', 'add', 'origin', 'file:///nonexistent/nope.git']);
  const broken = await syncA.syncOnce(repoA);
  expect(broken.originFetchOk).toBe(false);

  // true: a real bare origin.
  const bare = join(base, 'reachable-origin.git');
  await git(base, ['init', '-q', '--bare', bare]);
  await git(dirA, ['remote', 'set-url', 'origin', `file://${bare}`]);
  expect((await syncA.syncOnce(repoA)).originFetchOk).toBe(true);
});

test('a cycle that fails before fetchAll reports originFetchOk false, never a stale true', async () => {
  // Single-writer guard trips on the wrong HEAD, so fetchAll never runs. A takeover must not be
  // allowed on a cycle that never looked at origin.
  const dir = join(base, 'origin-fetch-early-throw');
  await initRepo(dir, 'alpha'); // HEAD is 'main', not sync/alpha: syncOnce throws immediately
  await git(dir, ['remote', 'add', 'origin', 'file:///nonexistent/nope.git']);
  const rec = recorder();
  const s = new Syncer(makeConfig('alpha', [], dir), rec.deps, FAST);

  const res = await s.syncOnce({ name: 'r', path: dir });
  expect(res.originFetchOk).toBe(false);
  expect(rec.stats.at(-1)!.syncError).toContain('refusing sync');
});

test('push to a healthy bare origin reports a timestamp', async () => {
  const { dirA, syncA, recA, repoA } = await setupPair({ 'foo.txt': 'base\n' });
  const bare = join(base, 'origin.git');
  await git(base, ['init', '-q', '--bare', bare]);
  await git(dirA, ['remote', 'add', 'origin', `file://${bare}`]);

  await writeFile(join(dirA, 'foo.txt'), 'edited\n');
  await syncA.syncOnce(repoA);

  expect(recA.pushes).toHaveLength(1);
  expect(typeof recA.pushes[0]).toBe('number');
  const branches = (await git(bare, ['branch', '--list', 'sync/alpha'])).stdout.trim();
  expect(branches).toContain('sync/alpha');
});

test('holds newest-wins resolution when the clock is unvetted', async () => {
  const { dirA, dirB, repoA } = await setupPair({ 'foo.txt': 'base\n' });

  // rebuild alpha's syncer with an unvetted clock
  const rec = recorder(false);
  const cfg = makeConfig('alpha', [peer('beta')], dirA);
  const syncA = new Syncer(cfg, rec.deps, FAST);

  const early = { GIT_AUTHOR_DATE: '2026-01-01T00:00:00+00:00', GIT_COMMITTER_DATE: '2026-01-01T00:00:00+00:00' };
  const late = { GIT_AUTHOR_DATE: '2026-06-01T00:00:00+00:00', GIT_COMMITTER_DATE: '2026-06-01T00:00:00+00:00' };
  await writeFile(join(dirA, 'foo.txt'), 'alpha-version\n');
  await git(dirA, ['commit', '-q', '-am', 'edit A'], early);
  await writeFile(join(dirB, 'foo.txt'), 'beta-version\n');
  await git(dirB, ['commit', '-q', '-am', 'edit B'], late);

  await syncA.syncOnce(repoA); // conflict would arise, but resolution is deferred

  // alpha keeps its own version; no conflict artifact minted; tree clean (merge aborted)
  expect(await readFile(join(dirA, 'foo.txt'), 'utf8')).toBe('alpha-version\n');
  expect(rec.conflicts).toHaveLength(0);
  const status = (await git(dirA, ['status', '--porcelain'])).stdout.trim();
  expect(status).toBe('');
});

// Regression: one gitignored path in the changed set used to abort the entire repo's sync
// cycle. `git add -A -- <paths>` exits 1 when an explicitly-named path is ignored and
// untracked, and status reports exactly that shape after `git rm --cached` of a now-ignored
// machine-local secret whose working copy stays on disk (beta, ai-agent, 2026-07-24).
test('auto-commit skips ignored paths instead of failing the cycle', async () => {
  const { dirA, syncA, recA, repoA } = await setupPair({
    'foo.txt': 'base\n',
    'secret.json': 'apiKey: real\n',
  });

  // The half-done state: rule added, secret untracked, working copy still present.
  await writeFile(join(dirA, '.gitignore'), 'secret.json\n');
  await git(dirA, ['rm', '--cached', '-q', 'secret.json']);
  await writeFile(join(dirA, 'secret.json'), 'apiKey: rotated\n');
  await writeFile(join(dirA, 'foo.txt'), 'edited\n');

  await syncA.syncOnce(repoA);

  expect(recA.stats.at(-1)?.syncError).toBeNull();

  // The legitimate edits committed...
  const head = await git(dirA, ['show', '--stat', '--format=%s', 'HEAD']);
  expect(head.stdout).toContain('sync: alpha');
  const tracked = (await git(dirA, ['ls-tree', '-r', '--name-only', 'HEAD'])).stdout.split('\n');
  expect(tracked).toContain('foo.txt');
  expect(tracked).toContain('.gitignore');
  // ...the secret did not, and its staged removal did.
  expect(tracked).not.toContain('secret.json');
  // Working copy untouched on disk.
  expect(await readFile(join(dirA, 'secret.json'), 'utf8')).toBe('apiKey: rotated\n');
  // Nothing left staged: the cycle actually converged.
  expect((await git(dirA, ['status', '--porcelain', '--untracked-files=no'])).stdout.trim()).toBe('');
});

test('auto-commit survives a staged rename and a staged delete', async () => {
  const { dirA, syncA, recA, repoA } = await setupPair({
    'foo.txt': 'base\n',
    'gone.txt': 'bye\n',
    'kept.txt': 'kept\n',
  });

  // Both name a path that exists in neither the worktree nor the index: `git mv` reports the
  // rename source, `git rm` the staged deletion. Either one used to fail `git add -A -- <paths>`
  // with exit 128 and wedge every subsequent cycle for the whole repo.
  await git(dirA, ['mv', 'foo.txt', 'moved.txt']);
  await git(dirA, ['rm', '-q', 'gone.txt']);
  await writeFile(join(dirA, 'kept.txt'), 'edited\n');
  await writeFile(join(dirA, 'fresh.txt'), 'new\n');

  await syncA.syncOnce(repoA);

  expect(recA.stats.at(-1)?.syncError).toBeNull();

  const head = await git(dirA, ['show', '--stat', '--format=%s', 'HEAD']);
  expect(head.stdout).toContain('sync: alpha');

  const tracked = (await git(dirA, ['ls-tree', '-r', '--name-only', 'HEAD'])).stdout.split('\n');
  // The rename landed on both ends, the delete landed, and unrelated work rode along.
  expect(tracked).toContain('moved.txt');
  expect(tracked).not.toContain('foo.txt');
  expect(tracked).not.toContain('gone.txt');
  expect(tracked).toContain('fresh.txt');
  expect(await readFile(join(dirA, 'kept.txt'), 'utf8')).toBe('edited\n');

  // Nothing left staged: the cycle actually converged.
  expect((await git(dirA, ['status', '--porcelain', '--untracked-files=no'])).stdout.trim()).toBe('');
});

// ---------------------------------------------------------------------------
// P2: timeout-vs-real-error disambiguation (fetchAll, pushOrigin).
//
// A real subprocess only reports code 124 once it has actually waited out timeoutMs, which would
// make these tests slow and flaky if driven honestly. The injectable gitRunner test seam
// (SyncerOptions.gitRunner, defaulting to util.run) exists exactly so these can be driven with a
// scripted runner instead -- real git for everything the test does not care about, a canned
// {code:124} result plus a matching clock advance for the calls under test. Mirrors
// tests/sshadmin.test.ts's scriptRunner/clock convention.
// ---------------------------------------------------------------------------

interface LogLine {
  level: string;
  msg: string;
  [k: string]: unknown;
}

function captureLogs(): { lines: LogLine[]; restore: () => void } {
  const lines: LogLine[] = [];
  const real = console.log;
  console.log = (...args: unknown[]): void => {
    try {
      lines.push(JSON.parse(args.map(String).join(' ')));
    } catch {
      // non-JSON console output, not a log() line -- ignore
    }
  };
  return {
    lines,
    restore: () => {
      console.log = real;
    },
  };
}

function makeClock(start = 1_700_000_000_000): { now: () => number; advance: (ms: number) => void } {
  let t = start;
  return { now: () => t, advance: (ms: number) => { t += ms; } };
}

interface Intercept {
  match: (argv: string[]) => boolean;
  result: RunResult;
  advanceMs?: number;
}

// Real `run` for every call that doesn't match an intercept, so setup commands (init, remote add,
// commit, etc.) behave exactly as the honest tests above rely on.
function interceptingRunner(clock: { advance: (ms: number) => void }, intercepts: Intercept[]): typeof run {
  return (async (argv: string[], opts: RunOptions = {}): Promise<RunResult> => {
    for (const it of intercepts) {
      if (it.match(argv)) {
        clock.advance(it.advanceMs ?? 0);
        return it.result;
      }
    }
    return run(argv, opts);
  }) as typeof run;
}

async function initRepo(dir: string, machine: string): Promise<void> {
  await mkdir(dir, { recursive: true });
  await git(dir, ['init', '-q', '-b', 'main']);
  await configRepo(dir, machine);
  await writeFile(join(dir, 'seed.txt'), 'seed\n');
  await git(dir, ['add', '-A']);
  await git(dir, ['commit', '-q', '-m', 'base']);
}

test('fleet-* fetch timeout: first is info, repeats debounce to debug', async () => {
  const dir = join(base, 'fetch-timeout');
  await initRepo(dir, 'alpha');

  const clock = makeClock();
  const cfg = makeConfig('alpha', [peer('beta')], dir);
  const fleetFetchTimeoutMs = 10000; // fleet-* path is min(fetchTimeoutMs, 10000)
  const gitRunner = interceptingRunner(clock, [
    {
      match: (argv) => argv.includes('fetch') && argv.includes('fleet-beta'),
      result: { code: 124, stdout: '', stderr: '' },
      advanceMs: fleetFetchTimeoutMs,
    },
  ]);
  const rec = recorder();
  const s = new Syncer(cfg, rec.deps, { ...FAST, now: clock.now, gitRunner });
  await s.adoptRepo(dir, 'alpha');
  await git(dir, ['remote', 'add', 'fleet-beta', 'http://127.0.0.1:1/git/r']);

  const { lines, restore } = captureLogs();
  try {
    await s.syncOnce({ name: 'r', path: dir });
    await s.syncOnce({ name: 'r', path: dir });
  } finally {
    restore();
  }

  const timedOut = lines.filter((l) => l.msg === 'fetch timed out; continuing');
  expect(timedOut).toHaveLength(2);
  expect(timedOut[0]!.level).toBe('info');
  expect(timedOut[1]!.level).toBe('debug');
  // The gate only ever sees timeouts here -- a real "fetch failed" warn would mean the
  // classification misfired.
  expect(lines.filter((l) => l.msg === 'fetch failed; continuing')).toHaveLength(0);
});

test('fleet-* fetch real (non-timeout) error always warns, never debounced', async () => {
  const dir = join(base, 'fetch-real-error');
  await initRepo(dir, 'alpha');

  const clock = makeClock();
  const cfg = makeConfig('alpha', [peer('beta')], dir);
  const gitRunner = interceptingRunner(clock, [
    {
      match: (argv) => argv.includes('fetch') && argv.includes('fleet-beta'),
      result: { code: 128, stdout: '', stderr: 'fatal: could not read from remote repository' },
    },
  ]);
  const rec = recorder();
  const s = new Syncer(cfg, rec.deps, { ...FAST, now: clock.now, gitRunner });
  await s.adoptRepo(dir, 'alpha');
  await git(dir, ['remote', 'add', 'fleet-beta', 'http://127.0.0.1:1/git/r']);

  const { lines, restore } = captureLogs();
  try {
    await s.syncOnce({ name: 'r', path: dir });
    await s.syncOnce({ name: 'r', path: dir });
  } finally {
    restore();
  }

  const warned = lines.filter((l) => l.msg === 'fetch failed; continuing');
  expect(warned).toHaveLength(2);
  expect(warned.every((l) => l.level === 'warn')).toBe(true);
  expect(lines.filter((l) => l.msg === 'fetch timed out; continuing')).toHaveLength(0);
});

// Class E: gate hygiene. A real (non-timeout) error must clear the timeout gate, not just warn
// unconditionally itself -- otherwise a LATER, genuinely fresh timeout outage silently opens at
// 'still-bad'/debug because the gate is still latched from an earlier, unrelated timeout streak.
test('fleet fetch: timeout -> real error -> timeout sequence re-enters at info, not debug', async () => {
  const dir = join(base, 'fetch-mixed-sequence');
  await initRepo(dir, 'alpha');

  const clock = makeClock();
  const cfg = makeConfig('alpha', [peer('beta')], dir);
  const fleetFetchTimeoutMs = 10000; // fleet-* path is min(fetchTimeoutMs, 10000)
  const sequence: RunResult[] = [
    { code: 124, stdout: '', stderr: '' }, // tick 1: timeout -> entered/info
    { code: 128, stdout: '', stderr: 'fatal: could not read from remote repository' }, // tick 2: real error -> warn, clears gate
    { code: 124, stdout: '', stderr: '' }, // tick 3: a FRESH timeout outage
  ];
  let call = 0;
  const gitRunner = (async (argv: string[], opts: RunOptions = {}): Promise<RunResult> => {
    if (argv.includes('fetch') && argv.includes('fleet-beta')) {
      const result = sequence[call]!;
      call += 1;
      if (result.code === 124) clock.advance(fleetFetchTimeoutMs);
      return result;
    }
    return run(argv, opts);
  }) as typeof run;
  const rec = recorder();
  const s = new Syncer(cfg, rec.deps, { ...FAST, now: clock.now, gitRunner });
  await s.adoptRepo(dir, 'alpha');
  await git(dir, ['remote', 'add', 'fleet-beta', 'http://127.0.0.1:1/git/r']);

  const { lines, restore } = captureLogs();
  try {
    await s.syncOnce({ name: 'r', path: dir });
    await s.syncOnce({ name: 'r', path: dir });
    await s.syncOnce({ name: 'r', path: dir });
  } finally {
    restore();
  }

  const timedOut = lines.filter((l) => l.msg === 'fetch timed out; continuing');
  expect(timedOut).toHaveLength(2);
  expect(timedOut[0]!.level).toBe('info'); // tick 1: entered
  expect(timedOut[1]!.level).toBe('info'); // tick 3: re-entered, NOT debounced to debug
  const realError = lines.filter((l) => l.msg === 'fetch failed; continuing');
  expect(realError).toHaveLength(1);
  expect(realError[0]!.level).toBe('warn');
});

test('origin fetch failure always warns, even when it is timeout-shaped', async () => {
  const dir = join(base, 'fetch-origin-timeout');
  await initRepo(dir, 'alpha');

  const clock = makeClock();
  const cfg = makeConfig('alpha', [], dir); // no peers -> remoteNames() is just ['origin']
  const gitRunner = interceptingRunner(clock, [
    {
      match: (argv) => argv.includes('fetch') && argv.includes('origin'),
      result: { code: 124, stdout: '', stderr: '' },
      advanceMs: 60000, // matches the default (unfleeted) fetchTimeoutMs -- looks like a timeout
    },
  ]);
  const rec = recorder();
  const s = new Syncer(cfg, rec.deps, { ...FAST, now: clock.now, gitRunner });
  await s.adoptRepo(dir, 'alpha');
  await git(dir, ['remote', 'add', 'origin', 'file:///nonexistent/nope.git']);

  const { lines, restore } = captureLogs();
  try {
    await s.syncOnce({ name: 'r', path: dir });
    await s.syncOnce({ name: 'r', path: dir });
  } finally {
    restore();
  }

  // Only fleet-* remotes are gate-eligible; origin always warns, on every cycle.
  const warned = lines.filter((l) => l.msg === 'fetch failed; continuing');
  expect(warned).toHaveLength(2);
  expect(warned.every((l) => l.level === 'warn')).toBe(true);
  expect(lines.filter((l) => l.msg === 'fetch timed out; continuing')).toHaveLength(0);
});

test('pushOrigin: intermediate attempts debug, final real-error attempt always warns', async () => {
  const { dirA, syncA, repoA } = await setupPair({ 'foo.txt': 'base\n' });
  await git(dirA, ['remote', 'add', 'origin', 'file:///nonexistent/nope.git']);
  await writeFile(join(dirA, 'foo.txt'), 'edited\n');

  const { lines, restore } = captureLogs();
  try {
    await syncA.syncOnce(repoA);
  } finally {
    restore();
  }

  const retrying = lines.filter((l) => l.msg === 'push to origin failed; retrying');
  const final = lines.filter((l) => l.msg === 'push to origin failed');
  expect(retrying).toHaveLength(3); // attempts 1-3 of 4 (FAST.pushBackoffMs has 3 entries)
  expect(retrying.every((l) => l.level === 'debug')).toBe(true);
  expect(final).toHaveLength(1);
  expect(final[0]!.level).toBe('warn');
  expect(final[0]!.attempt).toBe(4);
});

test('pushOrigin: final-attempt timeout warns once on entry, debounces to debug next cycle', async () => {
  const dir = join(base, 'push-timeout');
  await initRepo(dir, 'alpha');

  const clock = makeClock();
  const cfg = makeConfig('alpha', [], dir);
  const gitTimeoutMs = 60000; // Syncer's default gitTimeoutMs -- pushOrigin classifies against it
  const gitRunner = interceptingRunner(clock, [
    {
      match: (argv) => argv.includes('push'),
      result: { code: 124, stdout: '', stderr: '' },
      advanceMs: gitTimeoutMs,
    },
  ]);
  const rec = recorder();
  const s = new Syncer(cfg, rec.deps, { ...FAST, now: clock.now, gitRunner });
  await s.adoptRepo(dir, 'alpha');
  await git(dir, ['remote', 'add', 'origin', 'file:///nonexistent/nope.git']);

  const first = captureLogs();
  try {
    await s.syncOnce({ name: 'r', path: dir });
  } finally {
    first.restore();
  }
  const firstFinal = first.lines.filter((l) => l.msg === 'push to origin failed');
  expect(firstFinal).toHaveLength(1);
  expect(firstFinal[0]!.level).toBe('warn');

  const second = captureLogs();
  try {
    await s.syncOnce({ name: 'r', path: dir });
  } finally {
    second.restore();
  }
  const secondFinal = second.lines.filter((l) => l.msg === 'push to origin failed');
  expect(secondFinal).toHaveLength(1);
  expect(secondFinal[0]!.level).toBe('debug');
  expect(rec.pushes).toEqual([null, null]);
});

// Class E: gate hygiene, push side. A real (non-timeout) error on the final attempt already warns
// unconditionally every cycle (untouched by the gate) -- this pins that across TWO full syncOnce
// cycles it keeps warning both times, never debouncing the way a genuine timeout would.
test('pushOrigin: real error on the final attempt warns on every cycle, not just the first', async () => {
  const dir = join(base, 'push-real-error-repeat');
  await initRepo(dir, 'alpha');

  const clock = makeClock();
  const cfg = makeConfig('alpha', [], dir);
  const gitRunner = interceptingRunner(clock, [
    {
      match: (argv) => argv.includes('push'),
      result: { code: 128, stdout: '', stderr: 'fatal: authentication failed' },
    },
  ]);
  const rec = recorder();
  const s = new Syncer(cfg, rec.deps, { ...FAST, now: clock.now, gitRunner });
  await s.adoptRepo(dir, 'alpha');
  await git(dir, ['remote', 'add', 'origin', 'file:///nonexistent/nope.git']);

  const first = captureLogs();
  try {
    await s.syncOnce({ name: 'r', path: dir });
  } finally {
    first.restore();
  }
  const firstFinal = first.lines.filter((l) => l.msg === 'push to origin failed');
  expect(firstFinal).toHaveLength(1);
  expect(firstFinal[0]!.level).toBe('warn');

  const second = captureLogs();
  try {
    await s.syncOnce({ name: 'r', path: dir });
  } finally {
    second.restore();
  }
  const secondFinal = second.lines.filter((l) => l.msg === 'push to origin failed');
  expect(secondFinal).toHaveLength(1);
  expect(secondFinal[0]!.level).toBe('warn'); // real error: warns every cycle, never debounced
  expect(rec.pushes).toEqual([null, null]);
});

// Class E: TIMEOUT_SLACK_MS boundary. Two syncOnce cycles disambiguate the classification the same
// way the existing 'final-attempt timeout' test does: a timeout-classified outcome warns once then
// debounces to debug; a real-error-classified outcome warns on every cycle.
test('pushOrigin TIMEOUT_SLACK boundary: elapsed = timeoutMs-249 still classifies as a timeout', async () => {
  const dir = join(base, 'push-timeout-slack-in');
  await initRepo(dir, 'alpha');

  const clock = makeClock();
  const cfg = makeConfig('alpha', [], dir);
  const gitTimeoutMs = 60000; // Syncer's default gitTimeoutMs -- pushOrigin classifies against it
  const gitRunner = interceptingRunner(clock, [
    { match: (argv) => argv.includes('push'), result: { code: 124, stdout: '', stderr: '' }, advanceMs: gitTimeoutMs - 249 },
  ]);
  const rec = recorder();
  const s = new Syncer(cfg, rec.deps, { ...FAST, now: clock.now, gitRunner });
  await s.adoptRepo(dir, 'alpha');
  await git(dir, ['remote', 'add', 'origin', 'file:///nonexistent/nope.git']);

  const first = captureLogs();
  try {
    await s.syncOnce({ name: 'r', path: dir });
  } finally {
    first.restore();
  }
  expect(first.lines.filter((l) => l.msg === 'push to origin failed')[0]!.level).toBe('warn'); // entered

  const second = captureLogs();
  try {
    await s.syncOnce({ name: 'r', path: dir });
  } finally {
    second.restore();
  }
  // Debounces on the second cycle -- proof it was classified as a timeout, not a real error.
  expect(second.lines.filter((l) => l.msg === 'push to origin failed')[0]!.level).toBe('debug');
});

test('pushOrigin TIMEOUT_SLACK boundary: elapsed = timeoutMs-251 classifies as a real error, warns every cycle', async () => {
  const dir = join(base, 'push-timeout-slack-out');
  await initRepo(dir, 'alpha');

  const clock = makeClock();
  const cfg = makeConfig('alpha', [], dir);
  const gitTimeoutMs = 60000;
  const gitRunner = interceptingRunner(clock, [
    { match: (argv) => argv.includes('push'), result: { code: 124, stdout: '', stderr: '' }, advanceMs: gitTimeoutMs - 251 },
  ]);
  const rec = recorder();
  const s = new Syncer(cfg, rec.deps, { ...FAST, now: clock.now, gitRunner });
  await s.adoptRepo(dir, 'alpha');
  await git(dir, ['remote', 'add', 'origin', 'file:///nonexistent/nope.git']);

  const first = captureLogs();
  try {
    await s.syncOnce({ name: 'r', path: dir });
  } finally {
    first.restore();
  }
  expect(first.lines.filter((l) => l.msg === 'push to origin failed')[0]!.level).toBe('warn');

  const second = captureLogs();
  try {
    await s.syncOnce({ name: 'r', path: dir });
  } finally {
    second.restore();
  }
  // Still warns on the second cycle -- proof it was classified as a real error (code 124 but not
  // "close enough" to gitTimeoutMs), never debounced through the timeout gate at all.
  expect(second.lines.filter((l) => l.msg === 'push to origin failed')[0]!.level).toBe('warn');
});
