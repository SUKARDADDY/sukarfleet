// SPDX-License-Identifier: AGPL-3.0-or-later
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { updateMain } from '../src/derive';
import { run } from '../src/util';

// Fixed identity/date so branch commit shas are stable across machines running the suite.
const ENV = {
  GIT_AUTHOR_NAME: 'tester',
  GIT_AUTHOR_EMAIL: 'tester@example.com',
  GIT_COMMITTER_NAME: 'tester',
  GIT_COMMITTER_EMAIL: 'tester@example.com',
};

let root: string;

async function g(cwd: string, argv: string[], date?: string): Promise<string> {
  const env: Record<string, string> = { ...ENV };
  if (date) {
    env.GIT_AUTHOR_DATE = date;
    env.GIT_COMMITTER_DATE = date;
  }
  const r = await run(['git', ...argv], { cwd, env });
  if (r.code !== 0) throw new Error(`git ${argv.join(' ')}: ${r.stderr || r.stdout}`);
  return r.stdout.trim();
}

// Raw stdout (no trim) for exact file-content assertions.
async function show(cwd: string, spec: string): Promise<string> {
  const r = await run(['git', 'show', spec], { cwd, env: ENV });
  if (r.code !== 0) throw new Error(`git show ${spec}: ${r.stderr || r.stdout}`);
  return r.stdout;
}

async function writeFile(dir: string, rel: string, content: string): Promise<void> {
  await run(['mkdir', '-p', join(dir, rel, '..')]);
  await Bun.write(join(dir, rel), content);
}

// Build a repo with a shared base commit and two machine branches (aaa, bbb) with
// disjoint edits plus one conflicting file. Returns the repo path.
async function buildBaseRepo(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true });
  await g(dir, ['init', '-q', '-b', 'work']);
  await g(dir, ['config', 'core.autocrlf', 'false']);
  await writeFile(dir, 'shared.txt', 'shared\n');
  await writeFile(dir, 'conflict.txt', 'l1\nl2\nl3\n');
  await g(dir, ['add', '-A']);
  await g(dir, ['commit', '-qm', 'base'], '2020-01-01T00:00:00 +0000');
  await g(dir, ['branch', 'sync/aaa']);
  await g(dir, ['branch', 'sync/bbb']);

  await g(dir, ['switch', '-q', 'sync/aaa']);
  await writeFile(dir, 'only-aaa.txt', 'from-aaa\n');
  await writeFile(dir, 'conflict.txt', 'l1\nAAA\nl3\n');
  await g(dir, ['add', '-A']);
  await g(dir, ['commit', '-qm', 'aaa'], '2021-01-01T00:00:00 +0000');

  await g(dir, ['switch', '-q', 'sync/bbb']);
  await writeFile(dir, 'only-bbb.txt', 'from-bbb\n');
  await writeFile(dir, 'conflict.txt', 'l1\nBBB\nl3\n'); // conflicts with aaa, bbb is newer
  await g(dir, ['add', '-A']);
  await g(dir, ['commit', '-qm', 'bbb'], '2022-01-01T00:00:00 +0000');

  // Leave HEAD on a non-sync branch so working tree/HEAD are irrelevant to derive.
  await g(dir, ['switch', '-q', 'work']);
}

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'sukarfleet-derive-'));
});
afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

test('two disjoint machines: derived main contains both, conflict resolved newest-wins', async () => {
  const dir = join(root, 'two');
  await buildBaseRepo(dir);

  const res = await updateMain(dir);
  expect(res.sha).toBeTruthy();
  expect(res.skipped).toBeNull();
  expect(res.pushed).toBe(false); // no origin

  const sha = res.sha!;
  // parents sorted by machine name: aaa then bbb
  const parents = (await g(dir, ['show', '-s', '--format=%P', sha])).split(' ');
  const aaa = await g(dir, ['rev-parse', 'sync/aaa']);
  const bbb = await g(dir, ['rev-parse', 'sync/bbb']);
  expect(parents).toEqual([aaa, bbb]);

  // both disjoint files present
  const files = (await g(dir, ['ls-tree', '--name-only', '-r', sha])).split('\n').sort();
  expect(files).toContain('only-aaa.txt');
  expect(files).toContain('only-bbb.txt');
  expect(files).toContain('shared.txt');

  // conflict resolved to bbb (newer author timestamp), no conflict markers
  const conflict = await show(dir, `${sha}:conflict.txt`);
  expect(conflict).toBe('l1\nBBB\nl3\n');

  // message: header + one line per machine in name order
  const body = await g(dir, ['show', '-s', '--format=%B', sha]);
  const lines = body.split('\n').filter((l) => l.length > 0);
  expect(lines[0]).toBe('fleet: derived main');
  expect(lines[1]).toBe(`aaa ${aaa}`);
  expect(lines[2]).toBe(`bbb ${bbb}`);

  // derived local ref updated
  expect(await g(dir, ['rev-parse', 'refs/sukarfleet/derived-main'])).toBe(sha);

  // previous main is never a parent
  expect(parents).not.toContain(sha);
});

test('byte-identical sha computed from an independent clone (either machine agrees)', async () => {
  const dirA = join(root, 'two'); // reuse the repo built above
  const shaA = await g(dirA, ['rev-parse', 'refs/sukarfleet/derived-main']);

  // Second repo: same two branch commits, but seen as remote-tracking refs
  // (simulating a peer that fetched them) rather than local heads.
  const dirB = join(root, 'cloneB');
  await g(dirB.replace(/cloneB$/, ''), ['clone', '-q', '--bare', dirA, dirB]);
  // Move the two sync branches into a remote namespace to mimic a fetched peer view,
  // and drop the local heads so only fetched refs remain.
  const aaa = await g(dirA, ['rev-parse', 'sync/aaa']);
  const bbb = await g(dirA, ['rev-parse', 'sync/bbb']);
  await g(dirB, ['update-ref', 'refs/remotes/peer/sync/aaa', aaa]);
  await g(dirB, ['update-ref', 'refs/remotes/peer/sync/bbb', bbb]);
  await g(dirB, ['update-ref', '-d', 'refs/heads/sync/aaa']);
  await g(dirB, ['update-ref', '-d', 'refs/heads/sync/bbb']);
  // bare clone has an origin remote pointing at dirA; remove so derive does not push.
  await g(dirB, ['remote', 'remove', 'origin']);

  const resB = await updateMain(dirB);
  expect(resB.sha).toBe(shaA); // byte-identical across the two independent computations
});

test('re-run with unchanged inputs skips without minting', async () => {
  const dir = join(root, 'idem');
  await buildBaseRepo(dir);

  const first = await updateMain(dir);
  expect(first.skipped).toBeNull();
  const second = await updateMain(dir);
  expect(second.skipped).toBe('unchanged-inputs');
  expect(second.sha).toBe(first.sha);
});

test('a new commit on one branch re-derives a different main', async () => {
  const dir = join(root, 'redrive');
  await buildBaseRepo(dir);
  const first = await updateMain(dir);

  await g(dir, ['switch', '-q', 'sync/aaa']);
  await writeFile(dir, 'only-aaa.txt', 'from-aaa-updated\n');
  await g(dir, ['add', '-A']);
  await g(dir, ['commit', '-qm', 'aaa2'], '2023-06-01T00:00:00 +0000');
  await g(dir, ['switch', '-q', 'work']);

  const second = await updateMain(dir);
  expect(second.skipped).toBeNull();
  expect(second.sha).not.toBe(first.sha);

  // still exactly the two machine tips as parents, sorted, never the previous main
  const parents = (await g(dir, ['show', '-s', '--format=%P', second.sha!])).split(' ');
  const aaa = await g(dir, ['rev-parse', 'sync/aaa']);
  const bbb = await g(dir, ['rev-parse', 'sync/bbb']);
  expect(parents).toEqual([aaa, bbb]);
  expect(parents).not.toContain(first.sha);
  expect(parents).not.toContain(second.sha);

  // the updated file content flows through
  expect(await show(dir, `${second.sha!}:only-aaa.txt`)).toBe('from-aaa-updated\n');
});

test('single machine: main is that tip tree with one parent', async () => {
  const dir = join(root, 'single');
  await mkdir(dir, { recursive: true });
  await g(dir, ['init', '-q', '-b', 'work']);
  await g(dir, ['config', 'core.autocrlf', 'false']);
  await writeFile(dir, 'a.txt', 'a\n');
  await g(dir, ['add', '-A']);
  await g(dir, ['commit', '-qm', 'base'], '2020-01-01T00:00:00 +0000');
  await g(dir, ['branch', 'sync/solo']);
  await g(dir, ['switch', '-q', 'sync/solo']);
  await writeFile(dir, 'b.txt', 'b\n');
  await g(dir, ['add', '-A']);
  await g(dir, ['commit', '-qm', 'solo'], '2021-01-01T00:00:00 +0000');
  await g(dir, ['switch', '-q', 'work']);

  const res = await updateMain(dir);
  const solo = await g(dir, ['rev-parse', 'sync/solo']);
  const soloTree = await g(dir, ['rev-parse', 'sync/solo^{tree}']);
  const mainTree = await g(dir, ['rev-parse', `${res.sha!}^{tree}`]);
  expect(mainTree).toBe(soloTree);
  const parents = (await g(dir, ['show', '-s', '--format=%P', res.sha!])).split(' ');
  expect(parents).toEqual([solo]);
});

test('three machines fold in name order; disjoint + conflict all land', async () => {
  const dir = join(root, 'three');
  await buildBaseRepo(dir);
  // add a third machine branch off base, disjoint file, newest of all
  const base = await g(dir, ['rev-parse', 'work']);
  await g(dir, ['branch', 'sync/ccc', base]);
  await g(dir, ['switch', '-q', 'sync/ccc']);
  await writeFile(dir, 'only-ccc.txt', 'from-ccc\n');
  await g(dir, ['add', '-A']);
  await g(dir, ['commit', '-qm', 'ccc'], '2024-01-01T00:00:00 +0000');
  await g(dir, ['switch', '-q', 'work']);

  const res = await updateMain(dir);
  const files = (await g(dir, ['ls-tree', '--name-only', '-r', res.sha!])).split('\n');
  expect(files).toContain('only-aaa.txt');
  expect(files).toContain('only-bbb.txt');
  expect(files).toContain('only-ccc.txt');
  // conflict still resolves to bbb (newer than aaa; ccc never touched conflict.txt)
  expect(await show(dir, `${res.sha!}:conflict.txt`)).toBe('l1\nBBB\nl3\n');

  const parents = (await g(dir, ['show', '-s', '--format=%P', res.sha!])).split(' ');
  const aaa = await g(dir, ['rev-parse', 'sync/aaa']);
  const bbb = await g(dir, ['rev-parse', 'sync/bbb']);
  const ccc = await g(dir, ['rev-parse', 'sync/ccc']);
  expect(parents).toEqual([aaa, bbb, ccc]); // sorted by machine name
});

test('force-pushes main to origin when origin exists', async () => {
  const dir = join(root, 'push');
  await buildBaseRepo(dir);
  // create a bare origin and point the repo at it
  const originDir = join(root, 'origin.git');
  await g(root, ['init', '-q', '--bare', 'origin.git']);
  await g(dir, ['remote', 'add', 'origin', originDir]);

  const res = await updateMain(dir);
  expect(res.pushed).toBe(true);
  expect(await g(originDir, ['rev-parse', 'refs/heads/main'])).toBe(res.sha!);

  // idempotent re-run: unchanged inputs -> skip, no push
  const again = await updateMain(dir);
  expect(again.skipped).toBe('unchanged-inputs');
  expect(again.pushed).toBe(false);
});

test('delete-vs-modify conflict: newest side wins the deletion', async () => {
  const dir = join(root, 'delmod');
  await mkdir(dir, { recursive: true });
  await g(dir, ['init', '-q', '-b', 'work']);
  await g(dir, ['config', 'core.autocrlf', 'false']);
  await writeFile(dir, 'doomed.txt', 'v1\n');
  await g(dir, ['add', '-A']);
  await g(dir, ['commit', '-qm', 'base'], '2020-01-01T00:00:00 +0000');
  await g(dir, ['branch', 'sync/mmm']);
  await g(dir, ['branch', 'sync/nnn']);

  // mmm modifies doomed.txt (older)
  await g(dir, ['switch', '-q', 'sync/mmm']);
  await writeFile(dir, 'doomed.txt', 'v2-modified\n');
  await g(dir, ['add', '-A']);
  await g(dir, ['commit', '-qm', 'mmm'], '2021-01-01T00:00:00 +0000');

  // nnn deletes doomed.txt (newer -> deletion wins)
  await g(dir, ['switch', '-q', 'sync/nnn']);
  await run(['git', 'rm', '-q', 'doomed.txt'], { cwd: dir, env: ENV });
  await g(dir, ['commit', '-qm', 'nnn'], '2022-01-01T00:00:00 +0000');
  await g(dir, ['switch', '-q', 'work']);

  const res = await updateMain(dir);
  const files = (await g(dir, ['ls-tree', '--name-only', '-r', res.sha!])).split('\n').filter((l) => l);
  expect(files).not.toContain('doomed.txt'); // deletion by the newer machine wins
});

test('conflict tie-break: equal author timestamps resolve by machine name ascending (codepoint)', async () => {
  const dir = join(root, 'tie');
  await mkdir(dir, { recursive: true });
  await g(dir, ['init', '-q', '-b', 'work']);
  await g(dir, ['config', 'core.autocrlf', 'false']);
  await writeFile(dir, 'conflict.txt', 'l1\nl2\nl3\n');
  await g(dir, ['add', '-A']);
  await g(dir, ['commit', '-qm', 'base'], '2020-01-01T00:00:00 +0000');
  // Create bbb's branch first, then aaa's, so branch-creation order can't be
  // mistaken for the source of the tie-break (only the machine name should matter).
  await g(dir, ['branch', 'sync/bbb']);
  await g(dir, ['branch', 'sync/aaa']);

  const tieDate = '2021-06-01T00:00:00 +0000';

  // bbb commits its conflicting edit first, at the same author timestamp as aaa's
  // later commit below -- commit order must not matter, only the tie-break rule.
  await g(dir, ['switch', '-q', 'sync/bbb']);
  await writeFile(dir, 'conflict.txt', 'l1\nBBB\nl3\n');
  await g(dir, ['add', '-A']);
  await g(dir, ['commit', '-qm', 'bbb'], tieDate);

  await g(dir, ['switch', '-q', 'sync/aaa']);
  await writeFile(dir, 'conflict.txt', 'l1\nAAA\nl3\n');
  await g(dir, ['add', '-A']);
  await g(dir, ['commit', '-qm', 'aaa'], tieDate);

  await g(dir, ['switch', '-q', 'work']);

  const res = await updateMain(dir);
  expect(res.sha).toBeTruthy();

  // Equal author timestamps on both sides of the conflict -> tie broken by machine
  // name ascending (codepoint order): 'aaa' < 'bbb', so aaa's content wins.
  const conflict = await show(dir, `${res.sha!}:conflict.txt`);
  expect(conflict).toBe('l1\nAAA\nl3\n');
});

test('union path: conflict is resolved by union merge, not newest-wins clobber', async () => {
  const dir = join(root, 'union');
  await mkdir(dir, { recursive: true });
  await g(dir, ['init', '-q', '-b', 'work']);
  await g(dir, ['config', 'core.autocrlf', 'false']);
  await writeFile(dir, 'manifest.txt', 'l1\nl2\nl3\n');
  await g(dir, ['add', '-A']);
  await g(dir, ['commit', '-qm', 'base'], '2020-01-01T00:00:00 +0000');
  await g(dir, ['branch', 'sync/aaa']);
  await g(dir, ['branch', 'sync/bbb']);

  await g(dir, ['switch', '-q', 'sync/aaa']);
  await writeFile(dir, 'manifest.txt', 'l1\nAAA\nl3\n');
  await g(dir, ['add', '-A']);
  await g(dir, ['commit', '-qm', 'aaa'], '2021-01-01T00:00:00 +0000');

  await g(dir, ['switch', '-q', 'sync/bbb']);
  await writeFile(dir, 'manifest.txt', 'l1\nBBB\nl3\n'); // conflicts with aaa, bbb is newer
  await g(dir, ['add', '-A']);
  await g(dir, ['commit', '-qm', 'bbb'], '2022-01-01T00:00:00 +0000');
  await g(dir, ['switch', '-q', 'work']);

  const res = await updateMain(dir, { unionPaths: ['manifest.txt'] });
  expect(res.skipped).toBeNull();
  // Both sides' content survives (neither newest-wins clobbered nor conflict markers left).
  const content = await show(dir, `${res.sha!}:manifest.txt`);
  expect(content).toContain('AAA');
  expect(content).toContain('BBB');
  expect(content).not.toContain('<<<<<<<');
});

test('union path: postMerge regenerator re-runs over the unioned result', async () => {
  const dir = join(root, 'union-postmerge');
  await mkdir(dir, { recursive: true });
  await g(dir, ['init', '-q', '-b', 'work']);
  await g(dir, ['config', 'core.autocrlf', 'false']);
  await writeFile(dir, 'items.txt', 'l1\nl2\nl3\n');
  // Regenerator committed into the repo (like a real postMerge script would be) so it is
  // present in the tree checked out into the isolated worktree.
  await writeFile(dir, 'regen.sh', '#!/bin/sh\nsort -u items.txt > generated.txt\n');
  await g(dir, ['add', '-A']);
  await g(dir, ['commit', '-qm', 'base'], '2020-01-01T00:00:00 +0000');
  await g(dir, ['branch', 'sync/aaa']);
  await g(dir, ['branch', 'sync/bbb']);

  await g(dir, ['switch', '-q', 'sync/aaa']);
  await writeFile(dir, 'items.txt', 'l1\nAAA\nl3\n');
  await g(dir, ['add', '-A']);
  await g(dir, ['commit', '-qm', 'aaa'], '2021-01-01T00:00:00 +0000');

  await g(dir, ['switch', '-q', 'sync/bbb']);
  await writeFile(dir, 'items.txt', 'l1\nBBB\nl3\n');
  await g(dir, ['add', '-A']);
  await g(dir, ['commit', '-qm', 'bbb'], '2022-01-01T00:00:00 +0000');
  await g(dir, ['switch', '-q', 'work']);

  const res = await updateMain(dir, {
    unionPaths: ['items.txt'],
    postMerge: [['sh', 'regen.sh']],
  });
  expect(res.skipped).toBeNull();
  const items = await show(dir, `${res.sha!}:items.txt`);
  expect(items).toContain('AAA');
  expect(items).toContain('BBB');
  const generated = await show(dir, `${res.sha!}:generated.txt`);
  expect(generated).toContain('AAA');
  expect(generated).toContain('BBB');
});

test('push:false (P3 single-pusher) updates the local ref but never touches origin', async () => {
  const dir = join(root, 'push-false');
  await buildBaseRepo(dir);
  // Points at a path that cannot possibly exist -- proof the push leg is never even reached, not
  // merely that it failed silently.
  await g(dir, ['remote', 'add', 'origin', '/nonexistent/definitely-not-a-repo.git']);

  const res = await updateMain(dir, { push: false });
  expect(res.sha).toBeTruthy();
  expect(res.pushed).toBe(false);
  expect(res.skipped).toBe('push-suppressed-non-owner');
  expect(await g(dir, ['rev-parse', 'refs/sukarfleet/derived-main'])).toBe(res.sha!);
});

test('push:false skips a second time too, once inputs are unchanged', async () => {
  const dir = join(root, 'push-false-idem');
  await buildBaseRepo(dir);
  await g(dir, ['remote', 'add', 'origin', '/nonexistent/definitely-not-a-repo.git']);

  const first = await updateMain(dir, { push: false });
  expect(first.skipped).toBe('push-suppressed-non-owner');
  const second = await updateMain(dir, { push: false });
  // Idempotence check runs before the push gate, so an unchanged input set reports its own
  // reason -- 'push-suppressed-non-owner' would be misleading here since nothing was minted.
  expect(second.skipped).toBe('unchanged-inputs');
  expect(second.pushed).toBe(false);
});

test('push:true (explicit) is byte-identical to the default (push omitted) behavior', async () => {
  const dirDefault = join(root, 'push-default');
  const dirExplicit = join(root, 'push-explicit');
  await buildBaseRepo(dirDefault);
  await buildBaseRepo(dirExplicit);

  const resDefault = await updateMain(dirDefault);
  const resExplicit = await updateMain(dirExplicit, { push: true });
  expect(resExplicit.sha).toBe(resDefault.sha);
  expect(resExplicit.pushed).toBe(resDefault.pushed);
  expect(resExplicit.skipped).toBe(resDefault.skipped);
});

test('no sync branches: null sha, skipped', async () => {
  const dir = join(root, 'empty');
  await mkdir(dir, { recursive: true });
  await g(dir, ['init', '-q', '-b', 'work']);
  await writeFile(dir, 'x.txt', 'x\n');
  await g(dir, ['add', '-A']);
  await g(dir, ['commit', '-qm', 'base'], '2020-01-01T00:00:00 +0000');

  const res = await updateMain(dir);
  expect(res.sha).toBeNull();
  expect(res.skipped).toBe('no-sync-branches');
  expect(res.pushed).toBe(false);
});
