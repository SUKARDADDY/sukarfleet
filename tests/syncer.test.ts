// SPDX-License-Identifier: AGPL-3.0-or-later
import { test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm, chmod, stat, utimes, readlink, symlink, rename } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  Syncer,
  boundErrorText,
  isCorruptIndexError,
  isEmptyObjectError,
  isGitLockBusyError,
  isNonFastForwardRejection,
  isPortablePath,
  SYNC_ERROR_MAX_CHARS,
  type OwnBranchMerge,
  type SyncerDeps,
  type SyncerOptions,
} from '../src/syncer';
import type { LockRepair } from '../src/gitlocks';
import { testScopedLockHolderCheck } from './support/proc-scope';
import { defaultConfig } from '../src/config';
import { allowChildSpawns, drainChildren, run, SYNC_DEFERRED_PREFIX } from '../src/util';
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

// testScopedLockHolderCheck: the production holder check, looking only at this test's own process
// tree, so a git that some other program runs on the machine mid-test cannot flip a verdict.
const FAST: SyncerOptions = {
  sleep: async () => {},
  debounceMs: 0,
  pushBackoffMs: [1, 1, 1],
  lockHolderCheck: testScopedLockHolderCheck,
};

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
  notApplicable: string[];
  repairs: { repo: string; quarantinedTo: string }[];
  objectRepairs: { repo: string; quarantinedTo: string; recoveredFrom: string }[];
  lockRepairs: { repo: string; repair: LockRepair }[];
  ownMerges: { repo: string; detail: OwnBranchMerge }[];
  unportable: { repo: string; paths: string[] }[];
}

function recorder(vetted = true): Recorder {
  const stats: PresenceRepoStat[] = [];
  const pushes: (number | null)[] = [];
  const conflicts: string[] = [];
  const notApplicable: string[] = [];
  const repairs: { repo: string; quarantinedTo: string }[] = [];
  const objectRepairs: { repo: string; quarantinedTo: string; recoveredFrom: string }[] = [];
  const lockRepairs: { repo: string; repair: LockRepair }[] = [];
  const ownMerges: { repo: string; detail: OwnBranchMerge }[] = [];
  const unportable: { repo: string; paths: string[] }[] = [];
  return {
    stats,
    pushes,
    conflicts,
    notApplicable,
    repairs,
    objectRepairs,
    lockRepairs,
    ownMerges,
    unportable,
    deps: {
      isClockVetted: () => vetted,
      onRepoStat: (_r, s) => stats.push(s),
      onGithubPush: (_r, ms) => pushes.push(ms),
      onGithubPushNotApplicable: (r) => notApplicable.push(r),
      onConflictArtifact: (_r, p) => conflicts.push(p),
      onIndexRepaired: (r, quarantinedTo) => repairs.push({ repo: r, quarantinedTo }),
      onObjectsRepaired: (r, quarantinedTo, recoveredFrom) => objectRepairs.push({ repo: r, quarantinedTo, recoveredFrom }),
      onLockRepaired: (r, repair) => {
        lockRepairs.push({ repo: r, repair });
      },
      onOwnBranchMerged: (r, detail) => {
        ownMerges.push({ repo: r, detail });
      },
      onUnportableUntracked: (r, paths) => {
        unportable.push({ repo: r, paths });
      },
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

test('a repo with no origin reports GitHub push not-applicable, never a null push', async () => {
  // setupPair strips beta's origin, which is exactly a machine kept off GitHub. Before this,
  // pushOrigin returned silently and left node.ts's boot-time null in githubPushOkMs, which
  // health.ts reads as "overdue by forever" -- a permanent github-push-stale alarm on a repo
  // that is syncing perfectly, and it drags the peer's syncStale with it.
  const { dirA, syncA, syncB, recA, recB, repoA, repoB } = await setupPair({ 'seed.txt': 'seed\n' });

  await writeFile(join(dirA, 'foo.txt'), 'hello\n');
  await syncA.syncOnce(repoA);
  await syncB.syncOnce(repoB);

  // beta: no origin -> not-applicable, and nothing recorded in the push table at all.
  expect(recB.notApplicable).toContain(repoB.name);
  expect(recB.pushes).toHaveLength(0);
  // beta still synced fine; the absence of a GitHub remote is not a sync fault.
  expect(recB.stats.at(-1)!.syncError).toBeNull();
  // setupPair gives neither machine an origin, so alpha reports the same thing for the same
  // reason. The origin-present path stays covered by the pushOrigin tests below, which assert a
  // push IS recorded -- they would fail if this branch swallowed them.
  expect(recA.notApplicable).toContain(repoA.name);
  expect(recA.pushes).toHaveLength(0);
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


// --- corrupt index self-repair -------------------------------------------
// The bytes below are not invented. They reproduce, byte for byte, what a synced repo held on a
// live node after an unclean shutdown: a v3 index whose one entry claims an extended flag word git
// does not understand, which git rejects as `fatal: unknown index entry format 0xe2760000`.
// `git status` is the first thing autoCommit runs, so before this repair that repo stopped syncing
// entirely and stayed stopped until a human noticed, two days later.
async function corruptIndex(repoDir: string, name: string): Promise<void> {
  const nameBytes = new TextEncoder().encode(name);
  const entry: number[] = [];
  for (let i = 0; i < 16; i++) entry.push(0); // ctime + mtime
  const push32 = (v: number) => entry.push((v >>> 24) & 255, (v >>> 16) & 255, (v >>> 8) & 255, v & 255);
  const push16 = (v: number) => entry.push((v >>> 8) & 255, v & 255);
  push32(1); // dev
  push32(1); // ino
  push32(0o100644); // mode
  push32(1000); // uid
  push32(1000); // gid
  push32(3); // size
  for (let i = 0; i < 20; i++) entry.push(0x11); // object id
  push16(0x4000 | nameBytes.length); // name length + the "extended flags follow" bit
  push16(0xe276); // the extended flag word git rejects
  for (const b of nameBytes) entry.push(b);
  entry.push(0);
  while (entry.length % 8 !== 0) entry.push(0);

  const header = [0x44, 0x49, 0x52, 0x43, 0, 0, 0, 3, 0, 0, 0, 1]; // "DIRC", version 3, 1 entry
  const body = new Uint8Array([...header, ...entry]);
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-1', body));
  const out = new Uint8Array(body.length + digest.length);
  out.set(body, 0);
  out.set(digest, body.length);
  await writeFile(join(repoDir, '.git', 'index'), out);
}

test('isCorruptIndexError matches git\'s corruption wording and not a held lock', () => {
  expect(isCorruptIndexError('git status --porcelain -z failed (code 128): fatal: unknown index entry format 0xe2760000')).toBe(true);
  expect(isCorruptIndexError('fatal: bad index file sha1 signature')).toBe(true);
  expect(isCorruptIndexError('fatal: index file smaller than expected')).toBe(true);
  // A lock is another process, not damage. Rebuilding would race it instead of waiting for it.
  expect(isCorruptIndexError('fatal: Unable to create \'/r/.git/index.lock\': File exists.')).toBe(false);
  // An unmerged index is a conflict a human has to finish, and a rebuild would silently drop it.
  expect(isCorruptIndexError('error: you need to resolve your current index first')).toBe(false);
  expect(isCorruptIndexError('fatal: could not read Username for https://github.com')).toBe(false);
});

test('a corrupt index is quarantined, rebuilt from HEAD, and the cycle completes', async () => {
  const { dirA, syncA, recA, repoA } = await setupPair({ 'a.txt': 'one' });

  // Work that was waiting to be committed when the index died. It must survive the repair and be
  // committed by the retried cycle, which is the whole point: the worktree was never damaged.
  await writeFile(join(dirA, 'a.txt'), 'two');
  await corruptIndex(dirA, 'a.txt');

  const before = (await git(dirA, ['rev-parse', 'HEAD'])).stdout.trim();
  await syncA.syncOnce(repoA);

  expect(recA.repairs.length).toBe(1);
  expect(recA.repairs[0]!.repo).toBe('r');

  // The corrupt bytes are kept, not deleted: a machine that ate its own index is evidence.
  const quarantined = await readFile(recA.repairs[0]!.quarantinedTo);
  expect(quarantined.subarray(0, 4).toString()).toBe('DIRC');
  expect(quarantined[7]).toBe(3);

  // The retried cycle actually worked: it committed the pending edit and reported a clean stat.
  const after = (await git(dirA, ['rev-parse', 'HEAD'])).stdout.trim();
  expect(after).not.toBe(before);
  expect((await git(dirA, ['show', 'HEAD:a.txt'])).stdout).toBe('two');
  expect(recA.stats.at(-1)!.syncError).toBeNull();
  expect((await git(dirA, ['status', '--porcelain'])).stdout.trim()).toBe('');
});

test('a sync failure that is not index corruption is never repaired or retried', async () => {
  const { dirA, syncA, recA, repoA } = await setupPair({ 'a.txt': 'one' });
  // Single-writer violation: HEAD is not sync/<machine>. A real fault, and not one a rebuilt
  // index could fix -- repairing here would destroy an index while solving nothing.
  await git(dirA, ['checkout', '-q', '-b', 'somebody-elses-branch']);

  await syncA.syncOnce(repoA);

  expect(recA.repairs.length).toBe(0);
  expect(recA.stats.length).toBe(1); // one attempt, not two
  expect(recA.stats[0]!.syncError).toContain('refusing sync');
  const entries = await readdir(join(dirA, '.git'));
  expect(entries.filter((e) => e.startsWith('index.corrupt-')).length).toBe(0);
});


// --- empty loose object self-repair ----------------------------------------
// What a lost page cache did to two synced repos on a live node: the files under the sync branch's
// tip commit (and a few others) came back zero bytes long. `git status` then fails with
// `object file ... is empty` / `bad object HEAD` before autoCommit can do anything, and the repo
// stopped syncing for three days until a human refetched the objects by hand.
async function emptyObject(repoDir: string, oid: string): Promise<void> {
  const p = join(repoDir, '.git', 'objects', oid.slice(0, 2), oid.slice(2));
  await chmod(p, 0o644);
  await writeFile(p, '');
}

test('isEmptyObjectError matches git\'s zero-byte object wording and nothing broader', () => {
  expect(
    isEmptyObjectError(
      'git status --porcelain -z failed (code 128): error: object file .git/objects/f7/bbed1ace04371241abadebeb7a919e0ed7d1ee is empty\nfatal: bad object HEAD',
    ),
  ).toBe(true);
  // A missing object is not necessarily crash damage: a ref can name something never fetched.
  expect(isEmptyObjectError('fatal: bad object HEAD')).toBe(false);
  expect(isEmptyObjectError('fatal: missing object 3e24a370be8d3fb70af76c058bd91a404757b88a for refs/heads/sync/x')).toBe(false);
  expect(isEmptyObjectError('fatal: unknown index entry format 0xe2760000')).toBe(false);
});

test('empty loose objects are quarantined, refetched from a peer, and the cycle completes', async () => {
  const { dirA, dirB, syncA, syncB, recA, repoA, repoB } = await setupPair({ 'a.txt': 'one' });

  // A commits, B pulls it: the peer now holds every object A is about to lose.
  await writeFile(join(dirA, 'a.txt'), 'two');
  await syncA.syncOnce(repoA);
  await syncB.syncOnce(repoB);
  const tip = (await git(dirA, ['rev-parse', 'HEAD'])).stdout.trim();
  const tree = (await git(dirA, ['rev-parse', 'HEAD^{tree}'])).stdout.trim();
  expect((await git(dirB, ['cat-file', '-t', tip])).stdout.trim()).toBe('commit');

  // Pending work, then the crash.
  await writeFile(join(dirA, 'a.txt'), 'three');
  await emptyObject(dirA, tip);
  await emptyObject(dirA, tree);
  expect((await run(['git', 'status', '--porcelain'], { cwd: dirA })).code).not.toBe(0);

  await syncA.syncOnce(repoA);

  expect(recA.objectRepairs.length).toBe(1);
  expect(recA.objectRepairs[0]!.recoveredFrom).toBe('fleet-beta');
  // Both dead files are kept under their object ids, still zero bytes.
  const kept = (await readdir(recA.objectRepairs[0]!.quarantinedTo)).sort();
  expect(kept).toEqual([tip, tree].sort());
  expect((await stat(join(recA.objectRepairs[0]!.quarantinedTo, tip))).size).toBe(0);

  // The retried cycle committed the pending edit on top of the recovered tip (and may have merged
  // the peer's branch after it, so ancestry rather than HEAD^).
  expect((await run(['git', 'merge-base', '--is-ancestor', tip, 'HEAD'], { cwd: dirA })).code).toBe(0);
  expect((await run(['git', 'fsck', '--connectivity-only', '--no-dangling'], { cwd: dirA })).code).toBe(0);
  expect((await git(dirA, ['show', 'HEAD:a.txt'])).stdout).toBe('three');
  expect(recA.stats.at(-1)!.syncError).toBeNull();
  expect(recA.repairs.length).toBe(0);
});

test('an empty object no remote holds is reported, not papered over, and never retried', async () => {
  const { dirA, syncA, recA, repoA } = await setupPair({ 'a.txt': 'one' });

  // A commit that never left this machine: no peer can hand it back.
  await writeFile(join(dirA, 'a.txt'), 'local only');
  await git(dirA, ['commit', '-q', '-am', 'never synced']);
  const tip = (await git(dirA, ['rev-parse', 'HEAD'])).stdout.trim();
  await emptyObject(dirA, tip);

  const before = recA.stats.length;
  await syncA.syncOnce(repoA);

  expect(recA.objectRepairs.length).toBe(0);
  expect(recA.stats.length - before).toBe(1); // one attempt, not two
  expect(recA.stats.at(-1)!.syncError).toContain('is empty');
  // The dead file was still moved aside, so the next cycle reports the missing object plainly
  // and does not match isEmptyObjectError again.
  const quarantines = (await readdir(join(dirA, '.git'))).filter((e) => e.startsWith('objects.empty-'));
  expect(quarantines.length).toBe(1);
  expect(await readdir(join(dirA, '.git', quarantines[0]!))).toEqual([tip]);
  await syncA.syncOnce(repoA);
  expect(recA.stats.at(-1)!.syncError).not.toContain('is empty');
  expect((await readdir(join(dirA, '.git'))).filter((e) => e.startsWith('objects.empty-')).length).toBe(1);
});

test('an empty object while every remote is down is put back, and repaired once one answers', async () => {
  const { dirA, dirB, syncA, syncB, recA, repoA, repoB } = await setupPair({ 'a.txt': 'one' });
  await writeFile(join(dirA, 'a.txt'), 'two');
  await syncA.syncOnce(repoA);
  await syncB.syncOnce(repoB);
  const tip = (await git(dirA, ['rev-parse', 'HEAD'])).stdout.trim();
  await emptyObject(dirA, tip);

  // The reboot that caused the damage: the mesh is not up yet.
  await git(dirA, ['remote', 'set-url', 'fleet-beta', `file://${join(dirB, 'not-there')}`]);
  await syncA.syncOnce(repoA);
  expect(recA.objectRepairs.length).toBe(0);
  // Put back under its own name, so the next cycle fails the same way instead of going quiet.
  expect((await stat(join(dirA, '.git', 'objects', tip.slice(0, 2), tip.slice(2)))).size).toBe(0);
  expect(recA.stats.at(-1)!.syncError).toContain('is empty');

  await git(dirA, ['remote', 'set-url', 'fleet-beta', `file://${dirB}`]);
  await syncA.syncOnce(repoA);
  expect(recA.objectRepairs.length).toBe(1);
  expect(recA.objectRepairs[0]!.recoveredFrom).toBe('fleet-beta');
  expect(recA.stats.at(-1)!.syncError).toBeNull();
});

test('a lost blob that was only staged is dropped from the index and re-staged from the worktree', async () => {
  const { dirA, dirB, syncA, syncB, recA, repoA, repoB } = await setupPair({ 'a.txt': 'one' });
  await writeFile(join(dirA, 'a.txt'), 'two');
  await syncA.syncOnce(repoA);
  await syncB.syncOnce(repoB);
  const tip = (await git(dirA, ['rev-parse', 'HEAD'])).stdout.trim();

  // Staged when the machine died: the blob is on no remote, only in the worktree.
  await writeFile(join(dirA, 'b.txt'), 'staged only');
  await git(dirA, ['add', 'b.txt']);
  const blob = (await git(dirA, ['rev-parse', ':b.txt'])).stdout.trim();
  await emptyObject(dirA, blob);
  await emptyObject(dirA, tip);

  await syncA.syncOnce(repoA);

  expect(recA.objectRepairs.length).toBe(1);
  expect(recA.stats.at(-1)!.syncError).toBeNull();
  expect((await git(dirA, ['show', 'HEAD:b.txt'])).stdout).toBe('staged only');
  expect((await run(['git', 'fsck', '--connectivity-only', '--no-dangling'], { cwd: dirA })).code).toBe(0);
});

// --- stale git lock self-repair ---------------------------------------------
// What wedged a live repo for twelve days: an empty .git/index.lock left by a git the daemon's
// own shutdown SIGKILLed. Every cycle died at `git add` with "Unable to create ... index.lock: File
// exists", so nothing after step (1) ever ran. These pin the repair and, as importantly, every case
// in which the lock must be left exactly where it is.
const OLD_LOCK_MS = 11 * 60_000; // past the default thresholds.staleGitLockMin of 10

async function exists(p: string): Promise<boolean> {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

async function ageFile(p: string, ageMs: number): Promise<void> {
  const t = (Date.now() - ageMs) / 1000;
  await utimes(p, t, t);
}

async function waitFor(cond: () => Promise<boolean>, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await cond()) return;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error('condition not met in time');
}

test('a stale empty index.lock nobody holds is removed, and the same cycle commits', async () => {
  const { dirA, syncA, recA, repoA } = await setupPair({ 'a.txt': 'one' });
  await writeFile(join(dirA, 'a.txt'), 'two');
  const lock = join(dirA, '.git', 'index.lock');
  await writeFile(lock, '');
  await ageFile(lock, OLD_LOCK_MS);
  const before = (await git(dirA, ['rev-parse', 'HEAD'])).stdout.trim();

  await syncA.syncOnce(repoA);

  expect(await exists(lock)).toBe(false);
  expect(recA.lockRepairs).toHaveLength(1);
  expect(recA.lockRepairs[0]!.repo).toBe('r');
  expect(recA.lockRepairs[0]!.repair).toMatchObject({
    lock: join('.git', 'index.lock'),
    reason: 'stale',
    action: 'removed',
    sizeBytes: 0,
  });
  // One tick: the cycle that cleared the lock also committed the pending edit and reported clean.
  expect(recA.stats).toHaveLength(1);
  expect(recA.stats[0]!.syncError).toBeNull();
  expect((await git(dirA, ['rev-parse', 'HEAD'])).stdout.trim()).not.toBe(before);
  expect((await git(dirA, ['show', 'HEAD:a.txt'])).stdout).toBe('two');
});

test('a stale ref lock on the sync branch is removed and the commit goes through', async () => {
  const { dirA, syncA, recA, repoA } = await setupPair({ 'a.txt': 'one' });
  await writeFile(join(dirA, 'a.txt'), 'two');
  const lock = join(dirA, '.git', 'refs', 'heads', 'sync', 'alpha.lock');
  await writeFile(lock, '');
  await ageFile(lock, OLD_LOCK_MS);

  await syncA.syncOnce(repoA);

  expect(await exists(lock)).toBe(false);
  expect(recA.lockRepairs.map((r) => r.repair.lock)).toEqual([join('.git', 'refs', 'heads', 'sync', 'alpha.lock')]);
  expect((await git(dirA, ['show', 'HEAD:a.txt'])).stdout).toBe('two');
  expect(recA.stats.at(-1)!.syncError).toBeNull();
});

test('a stale non-empty lock is moved aside with its bytes, not deleted', async () => {
  const { dirA, syncA, recA, repoA } = await setupPair({ 'a.txt': 'one' });
  const lock = join(dirA, '.git', 'index.lock');
  await writeFile(lock, 'half-written index');
  await ageFile(lock, OLD_LOCK_MS);

  await syncA.syncOnce(repoA);

  expect(await exists(lock)).toBe(false);
  const repair = recA.lockRepairs[0]!.repair;
  expect(repair.action).toBe('quarantined');
  expect(repair.sizeBytes).toBe('half-written index'.length);
  expect(await readFile(repair.quarantinedTo!, 'utf8')).toBe('half-written index');
  // Kept outside refs/ and away from the index, where git never reads it.
  expect(repair.quarantinedTo!.startsWith(join(dirA, '.git', 'sukarfleet-stale-locks'))).toBe(true);
  expect(recA.stats.at(-1)!.syncError).toBeNull();
});

test('a fresh lock is left alone, and the cycle defers quietly instead of reporting an error', async () => {
  const { dirA, syncA, recA, repoA } = await setupPair({ 'a.txt': 'one' });
  await syncA.syncOnce(repoA); // a first good cycle, so there is a last success to keep
  const okMs = recA.stats.at(-1)!.lastSyncOkMs;
  expect(okMs).not.toBeNull();

  await writeFile(join(dirA, 'a.txt'), 'two');
  const lock = join(dirA, '.git', 'index.lock');
  await writeFile(lock, '');
  const before = (await git(dirA, ['rev-parse', 'HEAD'])).stdout.trim();

  const { lines, restore } = captureLogs();
  try {
    await syncA.syncOnce(repoA);
  } finally {
    restore();
  }

  expect(await exists(lock)).toBe(true);
  expect(recA.lockRepairs).toHaveLength(0);
  expect((await git(dirA, ['rev-parse', 'HEAD'])).stdout.trim()).toBe(before);
  // Not a fault: no syncError, and the last real success is kept rather than nulled.
  expect(recA.stats.at(-1)!.syncError).toBeNull();
  expect(recA.stats.at(-1)!.lastSyncOkMs).toBe(okMs);
  expect(lines.some((l) => l.msg === 'sync deferred; retrying next cycle')).toBe(true);
  expect(lines.some((l) => l.level === 'error')).toBe(false);
});

test.skipIf(process.platform !== 'linux')('an old lock a live process holds open is left alone', async () => {
  const { dirA, syncA, recA, repoA } = await setupPair({ 'a.txt': 'one' });
  const lock = join(dirA, '.git', 'index.lock');
  await writeFile(lock, '');
  await ageFile(lock, OLD_LOCK_MS);
  // Not git, and not working in the repo: only the descriptor, open for writing as git opens every
  // lock, marks it as the holder.
  const holder = Bun.spawn(['sh', '-c', 'exec 3<>"$1"; exec sleep 30', 'sh', lock], { cwd: base, stdio: ['ignore', 'ignore', 'ignore'] });
  try {
    await waitFor(async () => {
      try {
        return (await readlink(`/proc/${holder.pid}/fd/3`)) === lock;
      } catch {
        return false;
      }
    });
    await writeFile(join(dirA, 'a.txt'), 'two');
    await syncA.syncOnce(repoA);

    expect(await exists(lock)).toBe(true);
    expect(recA.lockRepairs).toHaveLength(0);
    expect(recA.stats.at(-1)!.syncError).toBeNull();
  } finally {
    holder.kill('SIGKILL');
    await holder.exited;
  }
});

// The case an open-descriptor check alone gets wrong. `git commit -a` writes the new index into
// index.lock, closes it, and holds it -- with no descriptor open -- for as long as the editor is up.
// A person composing a commit message for twenty minutes must not have it pulled out from under them.
test.skipIf(process.platform !== 'linux')('a human commit waiting on its editor keeps its index.lock however old', async () => {
  const { dirA, syncA, recA, repoA } = await setupPair({ 'a.txt': 'one' });
  await writeFile(join(dirA, 'a.txt'), 'human edit');
  const lock = join(dirA, '.git', 'index.lock');
  const human = Bun.spawn(['git', 'commit', '-a'], {
    cwd: dirA,
    env: { ...process.env, GIT_EDITOR: 'sleep 15; true' },
    stdio: ['ignore', 'ignore', 'ignore'],
  });
  try {
    await waitFor(() => exists(lock));
    await ageFile(lock, 60 * 60_000);

    await syncA.syncOnce(repoA);

    expect(await exists(lock)).toBe(true);
    expect(recA.lockRepairs).toHaveLength(0);
    expect(recA.stats.at(-1)!.syncError).toBeNull();
  } finally {
    // SIGTERM, as a person's Ctrl-C would: git removes its own lock on the way out.
    human.kill('SIGTERM');
    await human.exited;
  }
  expect(await exists(lock)).toBe(false);
});

test('when the holder check cannot answer, the lock stays and nothing alarms', async () => {
  const { dirA, recA, repoA } = await setupPair({ 'a.txt': 'one' });
  const cfg = makeConfig('alpha', [peer('beta')], dirA);
  const s = new Syncer(cfg, recA.deps, { ...FAST, lockHolderCheck: async () => 'unknown' });
  await writeFile(join(dirA, 'a.txt'), 'two');
  const lock = join(dirA, '.git', 'index.lock');
  await writeFile(lock, '');
  await ageFile(lock, OLD_LOCK_MS);

  await s.syncOnce(repoA);

  expect(await exists(lock)).toBe(true);
  expect(recA.lockRepairs).toHaveLength(0);
  expect(recA.stats.at(-1)!.syncError).toBeNull();
});

test('thresholds.staleGitLockMin decides how old is old enough', async () => {
  const { dirA, recA, repoA } = await setupPair({ 'a.txt': 'one' });
  const cfg = makeConfig('alpha', [peer('beta')], dirA);
  cfg.thresholds.staleGitLockMin = 60;
  const s = new Syncer(cfg, recA.deps, FAST);
  const lock = join(dirA, '.git', 'index.lock');
  await writeFile(lock, '');
  await ageFile(lock, OLD_LOCK_MS); // 11 minutes: stale by the default, fresh by this config

  await s.syncOnce(repoA);
  expect(await exists(lock)).toBe(true);

  await ageFile(lock, 61 * 60_000);
  await s.syncOnce(repoA);
  expect(await exists(lock)).toBe(false);
  expect(recA.lockRepairs).toHaveLength(1);
});

test('isGitLockBusyError matches git\'s lock-held wording and nothing else', () => {
  expect(isGitLockBusyError("git add -A -- a.txt failed (code 128): fatal: Unable to create '/r/.git/index.lock': File exists.")).toBe(true);
  expect(
    isGitLockBusyError("error: cannot lock ref 'refs/heads/sync/alpha': Unable to create '/r/.git/refs/heads/sync/alpha.lock': File exists."),
  ).toBe(true);
  expect(isGitLockBusyError('error: could not lock config file .git/config: File exists')).toBe(true);
  expect(isGitLockBusyError("error: cannot lock ref 'refs/heads/x': is at 1234 but expected 5678")).toBe(false);
  expect(isGitLockBusyError('fatal: unknown index entry format 0xe2760000')).toBe(false);
});

// --- the daemon's own SIGKILL ------------------------------------------------
// util.run escalates a step that ignores SIGTERM to SIGKILL, and a git killed that way leaves its
// lock behind. The step's afterKill hook clears it at once rather than waiting out staleGitLockMin.
test.skipIf(process.platform === 'win32')('a git step the daemon had to SIGKILL does not leave its lock behind', async () => {
  const { dirA, recA, repoA } = await setupPair({ 'a.txt': 'one' });
  await writeFile(join(dirA, 'a.txt'), 'two');
  const lock = join(dirA, '.git', 'index.lock');
  let wedged = false;
  // The `git add` step, swapped for one that takes the index lock and will not die of SIGTERM.
  const gitRunner = (async (argv: string[], opts: RunOptions = {}): Promise<RunResult> => {
    if (!wedged && argv[1] === 'add' && argv[2] === '-A' && argv[3] === '--') {
      wedged = true;
      return run(['sh', '-c', 'trap "" TERM; : > .git/index.lock; exec sleep 30'], { ...opts, timeoutMs: 300, killGraceMs: 200 });
    }
    return run(argv, opts);
  }) as typeof run;
  const s = new Syncer(makeConfig('alpha', [peer('beta')], dirA), recA.deps, { ...FAST, gitRunner });

  await s.syncOnce(repoA);

  expect(wedged).toBe(true);
  expect(await exists(lock)).toBe(false);
  expect(recA.lockRepairs).toHaveLength(1);
  expect(recA.lockRepairs[0]!.repair).toMatchObject({ lock: join('.git', 'index.lock'), reason: 'orphaned-by-kill', action: 'removed' });
  // The killed step itself is still a failed cycle (it timed out); the next one goes straight through.
  expect(recA.stats.at(-1)!.syncError).toContain('code 124');
  await s.syncOnce(repoA);
  expect(recA.stats.at(-1)!.syncError).toBeNull();
  expect((await git(dirA, ['show', 'HEAD:a.txt'])).stdout).toBe('two');
});

// --- own-branch non-fast-forward ---------------------------------------------
// What stalled two repos' pushes for five days: after a crash, origin held a merge commit on
// sync/<machine> that the local branch had lost, and every push was rejected as non-fast-forward
// until a human merged origin's copy back in.
async function setupWithOrigin(baseFiles: Record<string, string>, vetted = true) {
  const pair = await setupPair(baseFiles);
  const bare = join(base, 'origin.git');
  await git(base, ['init', '-q', '--bare', bare]);
  await git(pair.dirA, ['remote', 'add', 'origin', `file://${bare}`]);
  await pair.syncA.syncOnce(pair.repoA); // publishes sync/alpha
  expect(typeof pair.recA.pushes.at(-1)).toBe('number');

  // A second checkout of origin standing in for the copy of alpha that pushed and then lost it.
  const ghost = join(base, 'ghost');
  await git(base, ['clone', '-q', '-b', 'sync/alpha', bare, ghost]);
  await configRepo(ghost, 'alpha');

  const rec = vetted ? pair.recA : recorder(false);
  const syncA = vetted ? pair.syncA : new Syncer(makeConfig('alpha', [peer('beta')], pair.dirA), rec.deps, FAST);
  return { ...pair, bare, ghost, syncA, recA: rec };
}

test('isNonFastForwardRejection reads git push\'s verdict', () => {
  expect(isNonFastForwardRejection(' ! [rejected]        sync/alpha -> sync/alpha (non-fast-forward)\nerror: failed to push')).toBe(true);
  expect(isNonFastForwardRejection(' ! [rejected]        sync/alpha -> sync/alpha (fetch first)')).toBe(true);
  expect(isNonFastForwardRejection(' ! [remote rejected] sync/alpha -> sync/alpha (pre-receive hook declined)')).toBe(false);
  expect(isNonFastForwardRejection('fatal: could not read Username')).toBe(false);
});

test('origin holding a merge commit the local branch lost: merged back, and the push goes through', async () => {
  const { dirA, bare, ghost, syncA, recA, repoA } = await setupWithOrigin({ 'foo.txt': 'base\n' });
  // An origin-only merge commit that changes no files.
  await git(ghost, ['checkout', '-q', '-b', 'side']);
  await git(ghost, ['commit', '-q', '--allow-empty', '-m', 'side']);
  await git(ghost, ['checkout', '-q', 'sync/alpha']);
  await git(ghost, ['merge', '-q', '--no-ff', '-m', 'merge side', 'side']);
  await git(ghost, ['push', '-q', 'origin', 'sync/alpha']);
  const originOnly = (await git(ghost, ['rev-parse', 'HEAD'])).stdout.trim();

  await writeFile(join(dirA, 'foo.txt'), 'edited\n');
  await syncA.syncOnce(repoA);

  expect(typeof recA.pushes.at(-1)).toBe('number');
  const localHead = (await git(dirA, ['rev-parse', 'HEAD'])).stdout.trim();
  expect((await git(bare, ['rev-parse', 'refs/heads/sync/alpha'])).stdout.trim()).toBe(localHead);
  await git(dirA, ['merge-base', '--is-ancestor', originOnly, 'HEAD']);
  expect(await readFile(join(dirA, 'foo.txt'), 'utf8')).toBe('edited\n');
  expect(recA.ownMerges).toHaveLength(1);
  expect(recA.ownMerges[0]!.detail).toMatchObject({ branch: 'sync/alpha', originTip: originOnly, localTipAfter: localHead, conflicts: 0 });
  expect(recA.stats.at(-1)!.syncError).toBeNull();
  expect((await git(dirA, ['status', '--porcelain'])).stdout.trim()).toBe('');
});

test('a conflicting origin-only commit is settled by the ordinary newest-wins rule, loser preserved', async () => {
  const { dirA, bare, ghost, syncA, recA, repoA } = await setupWithOrigin({ 'foo.txt': 'base\n' });
  const early = { GIT_AUTHOR_DATE: '2026-01-01T00:00:00+00:00', GIT_COMMITTER_DATE: '2026-01-01T00:00:00+00:00' };
  const late = { GIT_AUTHOR_DATE: '2026-06-01T00:00:00+00:00', GIT_COMMITTER_DATE: '2026-06-01T00:00:00+00:00' };
  await writeFile(join(ghost, 'foo.txt'), 'origin-version\n');
  await git(ghost, ['commit', '-q', '-am', 'origin edit'], late);
  await git(ghost, ['push', '-q', 'origin', 'sync/alpha']);
  await writeFile(join(dirA, 'foo.txt'), 'local-version\n');
  await git(dirA, ['commit', '-q', '-am', 'local edit'], early);

  await syncA.syncOnce(repoA);

  expect(await readFile(join(dirA, 'foo.txt'), 'utf8')).toBe('origin-version\n');
  expect(recA.conflicts).toHaveLength(1);
  expect(recA.conflicts[0]!).toMatch(/^\.sync-conflicts\/[^/]+-alpha\/foo\.txt$/);
  expect(await readFile(join(dirA, recA.conflicts[0]!), 'utf8')).toBe('local-version\n');
  expect(recA.ownMerges[0]!.detail.conflicts).toBe(1);
  expect(typeof recA.pushes.at(-1)).toBe('number');
  expect((await git(bare, ['rev-parse', 'refs/heads/sync/alpha'])).stdout.trim()).toBe(
    (await git(dirA, ['rev-parse', 'HEAD'])).stdout.trim(),
  );
});

test('an origin-only conflict on an unvetted clock is left for a later cycle, never forced', async () => {
  const { dirA, bare, ghost, syncA, recA, repoA } = await setupWithOrigin({ 'foo.txt': 'base\n' }, false);
  await writeFile(join(ghost, 'foo.txt'), 'origin-version\n');
  await git(ghost, ['commit', '-q', '-am', 'origin edit']);
  await git(ghost, ['push', '-q', 'origin', 'sync/alpha']);
  const originTip = (await git(ghost, ['rev-parse', 'HEAD'])).stdout.trim();
  await writeFile(join(dirA, 'foo.txt'), 'local-version\n');
  await git(dirA, ['commit', '-q', '-am', 'local edit']);
  const localTip = (await git(dirA, ['rev-parse', 'HEAD'])).stdout.trim();

  await syncA.syncOnce(repoA);

  expect(recA.pushes.at(-1)).toBeNull();
  expect(recA.ownMerges).toHaveLength(0);
  expect(recA.stats.at(-1)!.syncError).toBeNull();
  // Neither side rewritten: origin keeps its commit, the local branch keeps its own, tree clean.
  expect((await git(bare, ['rev-parse', 'refs/heads/sync/alpha'])).stdout.trim()).toBe(originTip);
  expect((await git(dirA, ['rev-parse', 'HEAD'])).stdout.trim()).toBe(localTip);
  expect((await git(dirA, ['status', '--porcelain'])).stdout.trim()).toBe('');
});

// --- bounded error text --------------------------------------------------------
test('boundErrorText keeps what failed and git\'s verdict, and drops the argv bulk', () => {
  expect(boundErrorText('fatal: short')).toBe('fatal: short');
  const paths = Array.from({ length: 20000 }, (_, i) => `notes/some-directory/file-${i}.md`);
  const huge =
    `git add -A -- ${paths.join(' ')} failed (code 128): fatal: Unable to create '/r/.git/index.lock': File exists.\n\n` +
    'Another git process seems to be running in this repository, e.g.\nan editor opened by \'git commit\'.';
  expect(huge.length).toBeGreaterThan(200_000);
  const bounded = boundErrorText(huge);
  expect(bounded.length).toBeLessThanOrEqual(SYNC_ERROR_MAX_CHARS);
  expect(bounded.startsWith('git add -A -- notes/')).toBe(true);
  expect(bounded).toContain("fatal: Unable to create '/r/.git/index.lock': File exists.");
});

test('a cycle that fails on a long argv and long stderr reports a bounded syncError', async () => {
  const dir = join(base, 'long-error');
  await initRepo(dir, 'alpha');
  const rec = recorder();
  const gitRunner = interceptingRunner(makeClock(), [
    {
      match: (argv) => argv[1] === 'add' && argv[2] === '-A' && argv[3] === '--',
      result: { code: 128, stdout: '', stderr: `${'hint: noise\n'.repeat(1000)}fatal: something specific broke` },
    },
  ]);
  const s = new Syncer(makeConfig('alpha', [], dir), rec.deps, { ...FAST, gitRunner });
  await s.adoptRepo(dir, 'alpha');
  for (let i = 0; i < 300; i++) await writeFile(join(dir, `changed-file-number-${i}.txt`), 'x');

  await s.syncOnce({ name: 'r', path: dir });

  const err = rec.stats.at(-1)!.syncError!;
  expect(err.length).toBeLessThanOrEqual(SYNC_ERROR_MAX_CHARS);
  expect(err).toContain('git add -A -- <300 paths> failed (code 128)');
  expect(err).toContain('fatal: something specific broke');
});

// --- holder check: the same repository under another name ----------------------
// Review reproduced all three against real git with the path-string check this replaced: each
// deleted a live lock. A lock is backdated well past staleGitLockMin, and in none of these cases
// does the holder keep a descriptor open on it, so only the identity check can see the owner.
const bwrapWorks = (() => {
  try {
    return Bun.spawnSync(['bwrap', '--dev-bind', '/', '/', 'true']).exitCode === 0;
  } catch {
    return false;
  }
})();

// Skipped where it cannot run: it needs Linux and a bwrap that can create a mount namespace
// unprivileged (`unshare -Ur` is refused on hosts that restrict user namespaces; bwrap usually is not).
test.skipIf(process.platform !== 'linux' || !bwrapWorks)(
  'a git in another mount namespace, on a bind mount of the repo, keeps its lock [needs Linux + bwrap]',
  async () => {
    const { dirA, syncA, recA, repoA } = await setupPair({ 'a.txt': 'one' });
    await writeFile(join(dirA, 'a.txt'), 'sandboxed edit');
    const alt = join(base, 'mounted-elsewhere');
    await mkdir(alt);
    const lock = join(dirA, '.git', 'index.lock');
    const sandboxed = Bun.spawn(
      ['bwrap', '--dev-bind', '/', '/', '--bind', dirA, alt, '--chdir', alt, '--die-with-parent', 'git', 'commit', '-a'],
      { env: { ...process.env, GIT_EDITOR: 'sleep 15; true' }, stdio: ['ignore', 'ignore', 'ignore'] },
    );
    try {
      await waitFor(() => exists(lock));
      await ageFile(lock, 20 * 60_000);
      await syncA.syncOnce(repoA);
      expect(await exists(lock)).toBe(true);
      expect(recA.lockRepairs).toHaveLength(0);
    } finally {
      sandboxed.kill('SIGKILL');
      await sandboxed.exited;
    }
  },
);

// A ref transaction held open by `update-ref --stdin`: prepared (the lock written and closed), not
// yet committed. That is the shape of every ref lock git holds mid-transaction.
function holdRefTransaction(argv: string[], cwd: string, sha: string, env?: Record<string, string>) {
  const p = Bun.spawn(argv, { cwd, stdin: 'pipe', stdout: 'ignore', stderr: 'ignore', env: { ...process.env, ...env } });
  p.stdin.write(`start\nupdate refs/heads/held ${sha}\nprepare\n`);
  p.stdin.flush();
  return {
    proc: p,
    async release() {
      p.stdin.write('abort\n');
      p.stdin.end();
      await p.exited;
    },
  };
}

test.skipIf(process.platform !== 'linux')('a git naming the repo through a symlink, from outside it, keeps its ref lock', async () => {
  const { dirA, syncA, recA, repoA } = await setupPair({ 'a.txt': 'one' });
  const link = join(base, 'link-to-alpha');
  await symlink(dirA, link);
  const sha = (await git(dirA, ['rev-parse', 'HEAD'])).stdout.trim();
  const lock = join(dirA, '.git', 'refs', 'heads', 'held.lock');
  const viaArgv = holdRefTransaction(['git', `--git-dir=${link}/.git`, 'update-ref', '--stdin'], base, sha);
  try {
    await waitFor(() => exists(lock));
    await ageFile(lock, 20 * 60_000);
    await syncA.syncOnce(repoA);
    expect(await exists(lock)).toBe(true);
  } finally {
    await viaArgv.release();
  }

  // The same through GIT_DIR in the environment rather than argv.
  const viaEnv = holdRefTransaction(['git', 'update-ref', '--stdin'], base, sha, { GIT_DIR: `${link}/.git` });
  try {
    await waitFor(() => exists(lock));
    await ageFile(lock, 20 * 60_000);
    await syncA.syncOnce(repoA);
    expect(await exists(lock)).toBe(true);
  } finally {
    await viaEnv.release();
  }
  expect(recA.lockRepairs).toHaveLength(0);
});

test.skipIf(process.platform !== 'linux')('a git in a linked worktree keeps the shared ref lock it holds', async () => {
  const { dirA, syncA, recA, repoA } = await setupPair({ 'a.txt': 'one' });
  const wt = join(base, 'alpha-worktree');
  await git(dirA, ['worktree', 'add', '-q', '-b', 'side', wt]);
  const sha = (await git(dirA, ['rev-parse', 'HEAD'])).stdout.trim();
  const lock = join(dirA, '.git', 'refs', 'heads', 'held.lock');
  const holder = holdRefTransaction(['git', 'update-ref', '--stdin'], wt, sha);
  try {
    await waitFor(() => exists(lock));
    await ageFile(lock, 20 * 60_000);
    await syncA.syncOnce(repoA);
    expect(await exists(lock)).toBe(true);
    expect(recA.lockRepairs).toHaveLength(0);
  } finally {
    await holder.release();
  }
});

// --- merges a shutdown or a crash left half-done ----------------------------------
async function concurrentEdit(dirA: string, dirB: string): Promise<void> {
  const early = { GIT_AUTHOR_DATE: '2026-01-01T00:00:00+00:00', GIT_COMMITTER_DATE: '2026-01-01T00:00:00+00:00' };
  const late = { GIT_AUTHOR_DATE: '2026-06-01T00:00:00+00:00', GIT_COMMITTER_DATE: '2026-06-01T00:00:00+00:00' };
  await writeFile(join(dirA, 'foo.txt'), 'alpha-version\n');
  await git(dirA, ['commit', '-q', '-am', 'edit A'], early);
  await writeFile(join(dirB, 'foo.txt'), 'beta-version\n');
  await git(dirB, ['commit', '-q', '-am', 'edit B'], late);
}

test('a shutdown that starts refusing children mid-merge still aborts the merge', async () => {
  const { dirA, dirB, recA, repoA } = await setupPair({ 'foo.txt': 'base\n' });
  await concurrentEdit(dirA, dirB);
  const before = (await git(dirA, ['rev-parse', 'HEAD'])).stdout.trim();
  let s: Syncer | null = null;
  // Right after `git merge` leaves its conflicts, the drain's bound expires: from here on every
  // ordinary spawn is refused, exactly as in a shutdown that ran out of patience.
  const gitRunner = (async (argv: string[], opts: RunOptions = {}): Promise<RunResult> => {
    const r = await run(argv, opts);
    if (argv[1] === 'merge' && argv[2] === '--no-ff') {
      s!.stop();
      await drainChildren({ settleMs: 0, termGraceMs: 0, killWaitMs: 0 });
    }
    return r;
  }) as typeof run;
  s = new Syncer(makeConfig('alpha', [peer('beta')], dirA), recA.deps, { ...FAST, gitRunner });
  try {
    await s.syncOnce(repoA);
  } finally {
    allowChildSpawns();
  }

  expect(await exists(join(dirA, '.git', 'MERGE_HEAD'))).toBe(false);
  expect((await git(dirA, ['rev-parse', 'HEAD'])).stdout.trim()).toBe(before);
  expect((await git(dirA, ['status', '--porcelain'])).stdout.trim()).toBe('');
  expect(await readFile(join(dirA, 'foo.txt'), 'utf8')).toBe('alpha-version\n');
  expect(recA.stats.every((st) => st.syncError === null)).toBe(true);
});

test('a merge the daemon left unfinished is aborted and redone; its markers are never committed', async () => {
  const { dirA, dirB, recA, repoA } = await setupPair({ 'foo.txt': 'base\n' });
  await concurrentEdit(dirA, dirB);
  // What a process that died between `git merge` and resolving it leaves behind.
  await git(dirA, ['fetch', '-q', 'fleet-beta']);
  const betaTip = (await git(dirA, ['rev-parse', 'refs/remotes/fleet-beta/sync/beta'])).stdout.trim();
  await writeFile(join(dirA, '.git', 'sukarfleet-merge'), `${betaTip}\n`);
  const m = await run(['git', 'merge', '--no-ff', '--no-edit', betaTip], { cwd: dirA });
  expect(m.code).not.toBe(0);
  expect(await readFile(join(dirA, 'foo.txt'), 'utf8')).toContain('<<<<<<<');

  const s = new Syncer(makeConfig('alpha', [peer('beta')], dirA), recA.deps, FAST);
  await s.syncOnce(repoA);

  expect(await exists(join(dirA, '.git', 'MERGE_HEAD'))).toBe(false);
  expect(await exists(join(dirA, '.git', 'sukarfleet-merge'))).toBe(false);
  // Redone under newest-wins: beta's later edit wins, alpha's is kept as an artifact.
  expect(await readFile(join(dirA, 'foo.txt'), 'utf8')).toBe('beta-version\n');
  expect(recA.conflicts).toHaveLength(1);
  expect((await run(['git', 'grep', '-q', '<<<<<<<', 'HEAD'], { cwd: dirA })).code).toBe(1);
  expect(recA.stats.at(-1)!.syncError).toBeNull();
});

test('a merge a person left unfinished is waited on, never committed or aborted', async () => {
  const { dirA, dirB, recA, repoA } = await setupPair({ 'foo.txt': 'base\n' });
  await concurrentEdit(dirA, dirB);
  await git(dirA, ['fetch', '-q', 'fleet-beta']);
  await run(['git', 'merge', '--no-ff', '--no-edit', 'refs/remotes/fleet-beta/sync/beta'], { cwd: dirA });
  const before = (await git(dirA, ['rev-parse', 'HEAD'])).stdout.trim();

  const s = new Syncer(makeConfig('alpha', [peer('beta')], dirA), recA.deps, FAST);
  await s.syncOnce(repoA);

  expect(await exists(join(dirA, '.git', 'MERGE_HEAD'))).toBe(true);
  expect((await git(dirA, ['rev-parse', 'HEAD'])).stdout.trim()).toBe(before);
  expect(await readFile(join(dirA, 'foo.txt'), 'utf8')).toContain('<<<<<<<');
  expect(recA.stats.at(-1)!.syncError).toBeNull();
});

// --- restart, stop and the deferral note --------------------------------------------
test('a deferral right after a restart reports boot time, not "never synced"', async () => {
  const { dirA, recA, repoA } = await setupPair({ 'a.txt': 'one' });
  await writeFile(join(dirA, '.git', 'index.lock'), '');
  await writeFile(join(dirA, 'a.txt'), 'two');
  const bootAt = Date.now();
  const restarted = new Syncer(makeConfig('alpha', [peer('beta')], dirA), recA.deps, FAST);

  await restarted.syncOnce(repoA);

  const st = recA.stats.at(-1)!;
  expect(st.syncError).toBeNull();
  expect(st.lastSyncOkMs).not.toBeNull();
  expect(st.lastSyncOkMs!).toBeGreaterThanOrEqual(bootAt);
});

test('a deferral that outlasts staleGitLockMin says why in syncError, as a note', async () => {
  const { dirA, recA, repoA } = await setupPair({ 'a.txt': 'one' });
  await writeFile(join(dirA, '.git', 'index.lock'), '');
  await writeFile(join(dirA, 'a.txt'), 'two');
  const clock = makeClock(Date.now());
  const s = new Syncer(makeConfig('alpha', [peer('beta')], dirA), recA.deps, {
    ...FAST,
    now: clock.now,
    lockHolderCheck: async () => 'held',
  });

  await s.syncOnce(repoA);
  expect(recA.stats.at(-1)!.syncError).toBeNull();
  clock.advance(11 * 60_000);
  await s.syncOnce(repoA);
  const note = recA.stats.at(-1)!.syncError!;
  expect(note.startsWith(SYNC_DEFERRED_PREFIX)).toBe(true);
  expect(note).toContain('index.lock');

  await rm(join(dirA, '.git', 'index.lock'));
  await s.syncOnce(repoA);
  expect(recA.stats.at(-1)!.syncError).toBeNull();
});

test('a stop during the write-quiet debounce commits nothing', async () => {
  const { dirA, recA, repoA } = await setupPair({ 'a.txt': 'one' });
  await writeFile(join(dirA, 'a.txt'), 'possibly half-written');
  const before = (await git(dirA, ['rev-parse', 'HEAD'])).stdout.trim();
  let s: Syncer | null = null;
  s = new Syncer(makeConfig('alpha', [peer('beta')], dirA), recA.deps, {
    ...FAST,
    debounceMs: 5,
    sleep: async () => {
      s!.stop();
    },
  });

  await s.syncOnce(repoA);

  expect((await git(dirA, ['rev-parse', 'HEAD'])).stdout.trim()).toBe(before);
});

// --- paths a Windows checkout cannot hold -------------------------------------------
// Live: a Linux node auto-committed `_tmp/x/check:css.log`, and the Windows peer's merge failed
// with "invalid path" every cycle after.
test('isPortablePath refuses what Windows refuses', () => {
  for (const ok of ['a.txt', 'dir/sub/file.md', '.hidden', 'console.log', 'auxiliary.txt', 'com10', 'a b/c d.txt', 'x.lock']) {
    expect(isPortablePath(ok)).toBe(true);
  }
  for (const bad of [
    '_tmp/x/check:css.log',
    'a<b',
    'a>b',
    'q"uote',
    'pi|pe',
    'what?.md',
    'star*.md',
    'back\\slash',
    'ctrl\u0001char',
    'ends-with-dot.',
    'dir./file',
    'ends-with-space ',
    'CON',
    'con.txt',
    'Aux.tar.gz',
    'nul',
    'dir/COM1',
    'lpt9.log',
    'PRN  .txt',
  ]) {
    expect(isPortablePath(bad)).toBe(false);
  }
});

test('an unportable untracked file is never committed; portable ones in the same cycle are', async () => {
  const { dirA, syncA, recA, repoA } = await setupPair({ 'a.txt': 'one' });
  await mkdir(join(dirA, '_tmp', 'x'), { recursive: true });
  await writeFile(join(dirA, '_tmp', 'x', 'check:css.log'), 'log');
  await writeFile(join(dirA, '_tmp', 'x', 'fine.log'), 'log');
  await writeFile(join(dirA, 'CON.txt'), 'x');
  await writeFile(join(dirA, 'a.txt'), 'two');

  await syncA.syncOnce(repoA);

  const tracked = (await git(dirA, ['ls-files'])).stdout.split('\n').filter(Boolean).sort();
  expect(tracked).toEqual(['_tmp/x/fine.log', 'a.txt']);
  expect((await git(dirA, ['show', 'HEAD:a.txt'])).stdout).toBe('two');
  expect(await exists(join(dirA, '_tmp', 'x', 'check:css.log'))).toBe(true);
  expect(recA.unportable).toHaveLength(0);
  expect(recA.stats.at(-1)!.syncError).toBeNull();

  // Left alone every cycle after, quietly: no commit, no error.
  const head = (await git(dirA, ['rev-parse', 'HEAD'])).stdout.trim();
  await syncA.syncOnce(repoA);
  expect((await git(dirA, ['rev-parse', 'HEAD'])).stdout.trim()).toBe(head);
  expect(recA.stats.at(-1)!.syncError).toBeNull();
});

test('an unportable path already tracked is untracked, recorded once, and the file stays on disk', async () => {
  const { dirA, syncA, recA, repoA } = await setupPair({ 'a.txt': 'one' });
  await writeFile(join(dirA, 'check:css.log'), 'log');
  await writeFile(join(dirA, 'what?.md'), 'q');
  await git(dirA, ['add', '-A']);
  await git(dirA, ['commit', '-q', '-m', 'an older machine committed these']);

  await syncA.syncOnce(repoA);

  expect((await git(dirA, ['ls-files'])).stdout.split('\n').filter(Boolean)).toEqual(['a.txt']);
  expect((await git(dirA, ['ls-tree', '--name-only', 'HEAD'])).stdout.split('\n').filter(Boolean)).toEqual(['a.txt']);
  expect(await readFile(join(dirA, 'check:css.log'), 'utf8')).toBe('log');
  expect(recA.unportable).toEqual([{ repo: 'r', paths: ['check:css.log', 'what?.md'] }]);

  await syncA.syncOnce(repoA);
  expect(recA.unportable).toHaveLength(1);
});

test('a rename to an unportable name: the new name stays out, the old one goes', async () => {
  const { dirA, syncA, repoA } = await setupPair({ 'good.txt': 'g', 'moved.txt': 'm' });
  // One staged with git mv, one renamed behind git's back.
  await git(dirA, ['mv', 'good.txt', 'bad:name.txt']);
  await rename(join(dirA, 'moved.txt'), join(dirA, 'moved|too.txt'));

  await syncA.syncOnce(repoA);

  expect((await git(dirA, ['ls-tree', '--name-only', 'HEAD'])).stdout.trim()).toBe('');
  expect(await readFile(join(dirA, 'bad:name.txt'), 'utf8')).toBe('g');
  expect(await readFile(join(dirA, 'moved|too.txt'), 'utf8')).toBe('m');
  expect((await git(dirA, ['status', '--porcelain'])).stdout.split('\n').filter((l) => !l.startsWith('??')).filter(Boolean)).toEqual([]);
});

// --- round 2: the holder check is machine-wide -----------------------------------------------
// The third review round in a row found a git holding this repo's lock under a name the path match
// did not recognise. The rule now: no lock-capable git running anywhere (bar the daemon's own
// children), or nothing is reaped. These pin the cases that broke, and what the rule costs.

test.skipIf(process.platform !== 'linux')('a single-component relative --git-dir through a symlink keeps its ref lock', async () => {
  const { dirA, syncA, recA, repoA } = await setupPair({ 'a.txt': 'one' });
  // `--git-dir=meta`, cwd outside the worktree: no slash in the value, nothing that looks like a path.
  const outside = join(base, 'outside');
  await mkdir(outside);
  await symlink(join(dirA, '.git'), join(outside, 'meta'));
  const sha = (await git(dirA, ['rev-parse', 'HEAD'])).stdout.trim();
  const lock = join(dirA, '.git', 'refs', 'heads', 'held.lock');
  const holder = holdRefTransaction(['git', '--git-dir=meta', 'update-ref', '--stdin'], outside, sha);
  try {
    await waitFor(() => exists(lock));
    await ageFile(lock, 20 * 60_000);
    await syncA.syncOnce(repoA);
    expect(await exists(lock)).toBe(true);
    expect(recA.lockRepairs).toHaveLength(0);
  } finally {
    await holder.release();
  }
});

test.skipIf(process.platform !== 'linux')('a lock-capable git in an unrelated repo holds off every repair until it exits (the accepted cost)', async () => {
  const { dirA, syncA, recA, repoA } = await setupPair({ 'a.txt': 'one' });
  const elsewhere = join(base, 'elsewhere');
  await git(base, ['clone', '-q', dirA, elsewhere]);
  const lock = join(dirA, '.git', 'index.lock');
  await writeFile(lock, '');
  await ageFile(lock, 20 * 60_000);
  const sha = (await git(dirA, ['rev-parse', 'HEAD'])).stdout.trim();
  const unrelated = holdRefTransaction(['git', 'update-ref', '--stdin'], elsewhere, sha);
  try {
    await waitFor(() => exists(join(elsewhere, '.git', 'refs', 'heads', 'held.lock')));
    await syncA.syncOnce(repoA);
    expect(await exists(lock)).toBe(true);
  } finally {
    await unrelated.release();
  }
  // Once it is gone, the next cycle repairs.
  await syncA.syncOnce(repoA);
  expect(await exists(lock)).toBe(false);
  expect(recA.lockRepairs).toHaveLength(1);
});

test('the daemon\'s own git children do not hold off a repair', async () => {
  const { dirA, syncA, recA, repoA } = await setupPair({ 'a.txt': 'one' });
  const elsewhere = join(base, 'elsewhere');
  await mkdir(elsewhere);
  await git(elsewhere, ['init', '-q']);
  await configRepo(elsewhere, 'x');
  await writeFile(join(elsewhere, 'f'), 'f');
  await git(elsewhere, ['add', 'f']);
  await git(elsewhere, ['commit', '-q', '-m', 'f']);
  await writeFile(join(elsewhere, 'f'), 'g');
  const lock = join(dirA, '.git', 'index.lock');
  await writeFile(lock, '');
  await ageFile(lock, 20 * 60_000);
  // A long-running git started through util.run, i.e. tracked as one of this daemon's children.
  // `commit -a` holds index.lock for as long as its editor runs.
  const own = run(['git', 'commit', '-a'], { cwd: elsewhere, timeoutMs: 60_000, env: { GIT_EDITOR: 'sleep 3; echo m >' } });
  await waitFor(() => exists(join(elsewhere, '.git', 'index.lock')));

  await syncA.syncOnce(repoA);

  expect(await exists(lock)).toBe(false);
  expect(recA.lockRepairs).toHaveLength(1);
  await own;
});

// --- unportable paths through every commit, and an abort that cannot finish ------------------
test('an unportable path staged and then edited (AM) is untracked anyway, and the edit survives on disk', async () => {
  const { dirA, syncA, recA, repoA } = await setupPair({ 'a.txt': 'one' });
  await writeFile(join(dirA, 'check:css.log'), 'staged');
  await git(dirA, ['add', '--', 'check:css.log']);
  await writeFile(join(dirA, 'check:css.log'), 'edited after staging');

  await syncA.syncOnce(repoA);

  expect(recA.stats.at(-1)!.syncError).toBeNull();
  expect((await git(dirA, ['ls-files'])).stdout.split('\n').filter(Boolean)).toEqual(['a.txt']);
  expect(await readFile(join(dirA, 'check:css.log'), 'utf8')).toBe('edited after staging');
  // Only staged, never committed: nothing left the repo, so nothing is audited.
  expect(recA.unportable).toEqual([]);
});

test('no daemon commit records an unportable path: not a postMerge regeneration, not a merge of an older peer', async () => {
  // The regenerator writes an unportable file; commitAll stages with `add -A`.
  const { dirA, dirB, syncA, recA, repoA } = await setupPair({ 'a.txt': 'one' }, [], [['sh', '-c', 'echo regenerated > "gen:out.log"']]);
  // An older peer committed an unportable path by hand; the merge brings it in.
  await writeFile(join(dirB, 'peer:bad.txt'), 'from an older version');
  await writeFile(join(dirB, 'a.txt'), 'two');
  await git(dirB, ['add', '-A']);
  await git(dirB, ['commit', '-q', '-m', 'older peer']);

  await syncA.syncOnce(repoA);

  const everCommitted = (await git(dirA, ['log', '--all', '--format=', '--name-only', 'sync/alpha'])).stdout;
  const ours = (await git(dirA, ['ls-tree', '-r', '--name-only', 'HEAD'])).stdout.split('\n').filter(Boolean).sort();
  expect(ours).toEqual(['a.txt']);
  expect(await exists(join(dirA, 'gen:out.log'))).toBe(true);
  // No commit alpha authored adds one. The merge commit records beta's tree as beta committed it
  // (a plain `git merge`, so hooks run as they always did); the follow-up commit in the same step
  // takes the path out, and the tip that gets pushed is portable.
  const alphaCommits = (await git(dirA, ['log', '--no-merges', '--format=%H', '--author=alpha', 'sync/alpha'])).stdout.split('\n').filter(Boolean);
  for (const c of alphaCommits) {
    const added = (await git(dirA, ['show', '--format=', '--name-only', '--diff-filter=AM', c])).stdout;
    expect(added).not.toContain('gen:out.log');
    expect(added).not.toContain('peer:bad.txt');
  }
  expect(everCommitted).toContain('a.txt');
  expect(recA.stats.at(-1)!.syncError).toBeNull();
});

test('a daemon merge that cannot be aborted is never committed: the repo defers instead', async () => {
  const { dirA, dirB, recA, repoA } = await setupPair({ 'foo.txt': 'base\n' });
  await concurrentEdit(dirA, dirB);
  await git(dirA, ['fetch', '-q', 'fleet-beta']);
  const betaTip = (await git(dirA, ['rev-parse', 'refs/remotes/fleet-beta/sync/beta'])).stdout.trim();
  await writeFile(join(dirA, '.git', 'sukarfleet-merge'), `${betaTip}\n`);
  await run(['git', 'merge', '--no-ff', '--no-edit', betaTip], { cwd: dirA });
  // Markers staged, then the file edited again: `merge --abort` and `reset --merge` both refuse.
  await git(dirA, ['add', 'foo.txt']);
  await writeFile(join(dirA, 'foo.txt'), `${await readFile(join(dirA, 'foo.txt'), 'utf8')}later edit\n`);
  const before = (await git(dirA, ['rev-parse', 'HEAD'])).stdout.trim();

  const s = new Syncer(makeConfig('alpha', [peer('beta')], dirA), recA.deps, FAST);
  await s.syncOnce(repoA);
  await s.syncOnce(repoA);

  expect((await git(dirA, ['rev-parse', 'HEAD'])).stdout.trim()).toBe(before);
  expect(await exists(join(dirA, '.git', 'MERGE_HEAD'))).toBe(true);
  expect((await run(['git', 'grep', '-q', '<<<<<<<', 'HEAD'], { cwd: dirA })).code).toBe(1);
  expect(recA.stats.at(-1)!.syncError).toBeNull();
});

// --- round 3 ----------------------------------------------------------------------------
test('an untracked unportable file left on disk is not re-staged, re-untracked and re-audited every merge cycle', async () => {
  const { dirA, dirB, syncA, syncB, recA, repoA, repoB } = await setupPair({ 'a.txt': 'one' }, [], [['sh', '-c', 'echo regenerated > "gen:out.log"']]);
  await writeFile(join(dirB, 'peer:bad.txt'), 'from an older version');
  await git(dirB, ['add', '-A']);
  await git(dirB, ['commit', '-q', '-m', 'older peer']);
  // Three merge cycles: each time beta has something new, so alpha merges, runs postMerge and commits.
  const { lines, restore } = captureLogs();
  try {
    for (let i = 0; i < 3; i++) {
      await writeFile(join(dirB, `b${i}.txt`), String(i));
      await git(dirB, ['add', '-A']);
      await git(dirB, ['commit', '-q', '-m', `b${i}`]);
      await syncA.syncOnce(repoA);
    }
  } finally {
    restore();
  }
  // Nothing unportable was ever staged by the daemon's own adds, so nothing had to be unstaged.
  expect(lines.filter((l) => l.msg === 'auto-commit: unstaged paths a Windows checkout cannot hold')).toEqual([]);
  void syncB;
  void repoB;
  // peer:bad.txt was in a tree alpha merged: reported once. gen:out.log was never in any tree.
  expect(recA.unportable.flatMap((u) => u.paths)).toEqual(['peer:bad.txt']);
  expect(recA.stats.at(-1)!.syncError).toBeNull();
  expect(await exists(join(dirA, 'gen:out.log'))).toBe(true);
});

async function installHook(repoDir: string, name: string, body: string): Promise<void> {
  const p = join(repoDir, '.git', 'hooks', name);
  await writeFile(p, `#!/bin/sh\n${body}\n`);
  await chmod(p, 0o755);
}

test('a clean merge runs the hooks a plain git merge runs: pre-merge-commit, not pre-commit', async () => {
  const { dirA, dirB, syncA, recA, repoA } = await setupPair({ 'a.txt': 'one' });
  await installHook(dirA, 'pre-commit', 'exit 1');
  await installHook(dirA, 'pre-merge-commit', `touch "${join(base, 'pre-merge-commit-ran')}"`);
  await writeFile(join(dirB, 'a.txt'), 'two');
  await git(dirB, ['commit', '-q', '-am', 'beta edit']);

  await syncA.syncOnce(repoA);

  expect((await git(dirA, ['show', 'HEAD:a.txt'])).stdout).toBe('two');
  expect(await exists(join(base, 'pre-merge-commit-ran'))).toBe(true);
  expect(recA.stats.at(-1)!.syncError).toBeNull();
});

test('a hook that refuses the daemon\'s commit defers the repo, with the hook\'s reason, instead of failing', async () => {
  const { dirA, recA, repoA } = await setupPair({ 'a.txt': 'one' });
  await installHook(dirA, 'pre-commit', 'echo "error: transcrypt is not configured" >&2; exit 1');
  await writeFile(join(dirA, 'a.txt'), 'two');
  const clock = makeClock(Date.now());
  const s = new Syncer(makeConfig('alpha', [peer('beta')], dirA), recA.deps, { ...FAST, now: clock.now });

  await s.syncOnce(repoA);
  expect(recA.stats.at(-1)!.syncError).toBeNull();
  clock.advance(11 * 60_000);
  await s.syncOnce(repoA);
  const note = recA.stats.at(-1)!.syncError!;
  expect(note.startsWith(SYNC_DEFERRED_PREFIX)).toBe(true);
  expect(note).toContain('transcrypt is not configured');
});

test('a merge hook that refuses a clean merge defers, and leaves no merge open', async () => {
  const { dirA, dirB, recA, repoA } = await setupPair({ 'a.txt': 'one' });
  await installHook(dirA, 'pre-merge-commit', 'exit 1');
  await writeFile(join(dirB, 'a.txt'), 'two');
  await git(dirB, ['commit', '-q', '-am', 'beta edit']);
  const before = (await git(dirA, ['rev-parse', 'HEAD'])).stdout.trim();
  const s = new Syncer(makeConfig('alpha', [peer('beta')], dirA), recA.deps, FAST);

  const { lines, restore } = captureLogs();
  try {
    await s.syncOnce(repoA);
  } finally {
    restore();
  }

  expect(recA.stats.at(-1)!.syncError).toBeNull();
  expect((await git(dirA, ['rev-parse', 'HEAD'])).stdout.trim()).toBe(before);
  expect(await exists(join(dirA, '.git', 'MERGE_HEAD'))).toBe(false);
  expect(lines.some((l) => l.msg === 'sync deferred; retrying next cycle' && String(l.reason).includes('merge hook'))).toBe(true);
});

test('an unfinished own merge blocked by a held index.lock says so, not "needs a person"', async () => {
  const { dirA, dirB, recA, repoA } = await setupPair({ 'foo.txt': 'base\n' });
  await concurrentEdit(dirA, dirB);
  await git(dirA, ['fetch', '-q', 'fleet-beta']);
  const betaTip = (await git(dirA, ['rev-parse', 'refs/remotes/fleet-beta/sync/beta'])).stdout.trim();
  await writeFile(join(dirA, '.git', 'sukarfleet-merge'), `${betaTip}\n`);
  await run(['git', 'merge', '--no-ff', '--no-edit', betaTip], { cwd: dirA });
  await writeFile(join(dirA, '.git', 'index.lock'), ''); // fresh: somebody holds it right now
  const s = new Syncer(makeConfig('alpha', [peer('beta')], dirA), recA.deps, FAST);

  const { lines, restore } = captureLogs();
  try {
    await s.syncOnce(repoA);
  } finally {
    restore();
  }

  const deferral = lines.find((l) => l.msg === 'sync deferred; retrying next cycle');
  expect(String(deferral?.reason)).toContain('index.lock');
  expect(String(deferral?.reason)).not.toContain('by hand');
  expect(await exists(join(dirA, '.git', 'MERGE_HEAD'))).toBe(true);
});

test.skipIf(process.platform !== 'linux')('a git whose argv[0] was renamed (exec -a) still counts as a holder', async () => {
  const { dirA, syncA, recA, repoA } = await setupPair({ 'a.txt': 'one' });
  await writeFile(join(dirA, 'a.txt'), 'edit');
  const lock = join(dirA, '.git', 'index.lock');
  const renamed = Bun.spawn(['bash', '-c', 'exec -a my-committer git commit -a'], {
    cwd: dirA,
    env: { ...process.env, GIT_EDITOR: 'sleep 15; true' },
    stdio: ['ignore', 'ignore', 'ignore'],
  });
  try {
    await waitFor(() => exists(lock));
    await ageFile(lock, 20 * 60_000);
    await syncA.syncOnce(repoA);
    expect(await exists(lock)).toBe(true);
    expect(recA.lockRepairs).toHaveLength(0);
  } finally {
    renamed.kill('SIGTERM');
    await renamed.exited;
  }
});

// --- round 4 ----------------------------------------------------------------------------
test.skipIf(process.platform === 'win32')('a dangling symlink a postMerge regenerator writes is committed, not dropped as vanished', async () => {
  const { dirA, dirB, syncA, recA, repoA } = await setupPair({ 'a.txt': 'one' }, [], [['ln', '-sf', 'future-target', 'generated-link']]);
  await writeFile(join(dirB, 'a.txt'), 'two');
  await git(dirB, ['commit', '-q', '-am', 'beta edit']);

  await syncA.syncOnce(repoA);

  expect((await git(dirA, ['ls-tree', '--name-only', 'HEAD'])).stdout.split('\n').filter(Boolean).sort()).toEqual(['a.txt', 'generated-link']);
  expect((await git(dirA, ['status', '--porcelain'])).stdout.trim()).toBe('');
  expect(recA.stats.at(-1)!.syncError).toBeNull();
});

test.skipIf(process.platform === 'win32')('a dangling symlink created in the worktree is auto-committed like any file', async () => {
  const { dirA, syncA, repoA } = await setupPair({ 'a.txt': 'one' });
  await symlink('not-there-yet', join(dirA, 'link'));

  await syncA.syncOnce(repoA);

  expect((await git(dirA, ['ls-tree', '--name-only', 'HEAD'])).stdout).toContain('link');
  expect((await git(dirA, ['status', '--porcelain'])).stdout.trim()).toBe('');
});

test('a commit git itself refuses (empty author name) stays a syncError even with a passing hook installed', async () => {
  const { dirA, syncA, recA, repoA } = await setupPair({ 'a.txt': 'one' });
  await installHook(dirA, 'pre-commit', 'exit 0');
  await git(dirA, ['config', 'user.name', '']);
  await writeFile(join(dirA, 'a.txt'), 'two');

  await syncA.syncOnce(repoA);

  const err = recA.stats.at(-1)!.syncError;
  expect(err).not.toBeNull();
  expect(err!.startsWith(SYNC_DEFERRED_PREFIX)).toBe(false);
  expect(err).toContain('empty ident name');
});
