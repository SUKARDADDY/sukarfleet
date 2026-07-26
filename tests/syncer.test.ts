// SPDX-License-Identifier: AGPL-3.0-or-later
import { test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Syncer, type SyncerDeps, type SyncerOptions } from '../src/syncer';
import { defaultConfig } from '../src/config';
import { run } from '../src/util';
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
