// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The machine-wide Windows service must not run a program a local account chose. Every local
// account can write the shared root, .git included, so a repository's own config is
// user-controlled. GIT_CONFIG_GLOBAL is the lowest config layer and loses to it; the
// GIT_CONFIG_COUNT / KEY_<n> / VALUE_<n> entries in the service xml rank with `git -c` and win.
//
// (a) reads the real install/windows/sukarfleet-node.xml and checks the entries. (b) builds an
// environment from those same entries and runs real git against a repository whose own config
// points at a program that writes a marker file. A control run without the entries must fire the
// marker, or the test proves nothing.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { REPO_ROOT } from './support/install-harness';

const XML_PATH = join(REPO_ROOT, 'install', 'windows', 'sukarfleet-node.xml');

/** Every <env name value/> outside XML comments, in file order. */
function xmlEnv(): Array<[string, string]> {
  const text = readFileSync(XML_PATH, 'utf8').replace(/<!--[\s\S]*?-->/g, '');
  return [...text.matchAll(/<env\s+name="([^"]*)"\s+value="([^"]*)"\s*\/>/g)].map((m) => [m[1]!, m[2]!]);
}

describe('sukarfleet-node.xml pins git settings above repository config', () => {
  const env = new Map(xmlEnv());

  test('GIT_CONFIG_COUNT matches consecutive KEY/VALUE pairs from 0', () => {
    const count = Number(env.get('GIT_CONFIG_COUNT'));
    expect(Number.isInteger(count)).toBe(true);
    expect(count).toBeGreaterThanOrEqual(2);
    for (let i = 0; i < count; i++) {
      expect(env.has(`GIT_CONFIG_KEY_${i}`)).toBe(true);
      expect(env.has(`GIT_CONFIG_VALUE_${i}`)).toBe(true);
    }
    // No stray pair past the count: git ignores it, and a reader would think it was in force.
    expect(env.has(`GIT_CONFIG_KEY_${count}`)).toBe(false);
    expect(env.has(`GIT_CONFIG_VALUE_${count}`)).toBe(false);
  });

  test('hooksPath and fsmonitor are pinned, hooksPath to the no-hooks directory', () => {
    const count = Number(env.get('GIT_CONFIG_COUNT'));
    const pins = new Map<string, string>();
    for (let i = 0; i < count; i++) pins.set(env.get(`GIT_CONFIG_KEY_${i}`)!, env.get(`GIT_CONFIG_VALUE_${i}`)!);
    expect(pins.get('core.hooksPath')).toBe('__NODE_DIR__\\no-hooks');
    expect(pins.get('core.fsmonitor')).toBe('false');
    expect(pins.get('commit.gpgsign')).toBe('false');
  });

  test('the installer substitutes __NODE_DIR__ and creates the no-hooks directory the pin names', () => {
    const installer = readFileSync(join(REPO_ROOT, 'install', 'windows', 'Install-MachineNode.ps1'), 'utf8');
    expect(installer).toContain("$NoHooksDir   = Join-Path $NodeDir 'no-hooks'");
    expect(installer).toContain("$xml.Replace('__NODE_DIR__'");
  });
});

describe('real git under the service environment', () => {
  let dir: string;
  let repo: string;
  let marker: string;

  const BASE_ENV: Record<string, string> = {
    PATH: process.env.PATH ?? '',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_AUTHOR_NAME: 't',
    GIT_AUTHOR_EMAIL: 't@example.invalid',
    GIT_COMMITTER_NAME: 't',
    GIT_COMMITTER_EMAIL: 't@example.invalid',
  };

  /** The service environment: the installer's global gitconfig plus every xml <env>, with the
   *  node directory placeholder pointed at a temp directory (forward slashes: this runs on Linux). */
  function serviceEnv(): Record<string, string> {
    const nodeDir = join(dir, 'node');
    mkdirSync(join(nodeDir, 'no-hooks'), { recursive: true });
    writeFileSync(join(nodeDir, 'gitconfig'), `[core]\n\thooksPath = ${join(nodeDir, 'no-hooks')}\n`);
    const out: Record<string, string> = { ...BASE_ENV, HOME: join(dir, 'home') };
    for (const [name, value] of xmlEnv()) {
      if (!name.startsWith('GIT_')) continue;
      out[name] = value.replaceAll('__NODE_DIR__', nodeDir).replaceAll('\\', '/');
    }
    return out;
  }

  async function git(args: string[], env: Record<string, string>, cwd = repo) {
    const p = Bun.spawn(['git', ...args], { cwd, env, stdout: 'pipe', stderr: 'pipe' });
    const [stdout, stderr, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
    return { stdout, stderr, code };
  }

  function script(name: string, body: string): string {
    const path = join(dir, name);
    writeFileSync(path, `#!/bin/sh\n${body}\n`);
    chmodSync(path, 0o755);
    return path;
  }

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'sf-svcgit-'));
    mkdirSync(join(dir, 'home'), { recursive: true });
    repo = join(dir, 'repo');
    mkdirSync(repo);
    marker = join(dir, 'marker');
    const plain = { ...BASE_ENV, HOME: join(dir, 'home') };
    expect((await git(['init', '-q', '-b', 'main'], plain)).code).toBe(0);
    writeFileSync(join(repo, 'a.txt'), 'one\n');
    expect((await git(['add', '-A'], plain)).code).toBe(0);
    expect((await git(['commit', '-q', '-m', 'seed'], plain)).code).toBe(0);
    writeFileSync(join(repo, 'a.txt'), 'two\n');
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  test('a repo-local core.hooksPath runs without the pins, and does not run with them', async () => {
    const hooks = join(dir, 'evil-hooks');
    mkdirSync(hooks);
    const hook = join(hooks, 'pre-commit');
    writeFileSync(hook, `#!/bin/sh\necho ran > "${marker}"\n`);
    chmodSync(hook, 0o755);
    const plain = { ...BASE_ENV, HOME: join(dir, 'home') };
    expect((await git(['config', 'core.hooksPath', hooks], plain)).code).toBe(0);

    // Control: only the global hooksPath restriction, as the installer shipped it before.
    const nodeDir = join(dir, 'node');
    mkdirSync(join(nodeDir, 'no-hooks'), { recursive: true });
    writeFileSync(join(nodeDir, 'gitconfig'), `[core]\n\thooksPath = ${join(nodeDir, 'no-hooks')}\n`);
    const globalOnly = { ...plain, GIT_CONFIG_GLOBAL: join(nodeDir, 'gitconfig') };
    const control = await git(['commit', '-q', '-a', '-m', 'control'], globalOnly);
    expect(control.code).toBe(0);
    expect(existsSync(marker)).toBe(true);

    rmSync(marker);
    writeFileSync(join(repo, 'a.txt'), 'three\n');
    const pinned = await git(['commit', '-q', '-a', '-m', 'pinned'], serviceEnv());
    expect(pinned.code).toBe(0);
    expect(existsSync(marker)).toBe(false);
  });

  test('a repo-local core.fsmonitor program runs without the pins, and does not run with them', async () => {
    const fsm = script('fsmonitor', `echo ran > "${marker}"\nprintf '\\0'`);
    const plain = { ...BASE_ENV, HOME: join(dir, 'home') };
    expect((await git(['config', 'core.fsmonitor', fsm], plain)).code).toBe(0);

    await git(['status', '--porcelain'], plain);
    expect(existsSync(marker)).toBe(true);

    rmSync(marker);
    const pinned = await git(['status', '--porcelain'], serviceEnv());
    expect(pinned.code).toBe(0);
    expect(existsSync(marker)).toBe(false);
  });

  test('a repo-local commit.gpgsign with its own gpg.program is stopped by the pins', async () => {
    const gpg = script('fake-gpg', `echo ran > "${marker}"\nexit 1`);
    const plain = { ...BASE_ENV, HOME: join(dir, 'home') };
    expect((await git(['config', 'commit.gpgsign', 'true'], plain)).code).toBe(0);
    expect((await git(['config', 'gpg.program', gpg], plain)).code).toBe(0);

    await git(['commit', '-q', '-a', '-m', 'control'], plain);
    expect(existsSync(marker)).toBe(true);

    rmSync(marker);
    const pinned = await git(['commit', '-q', '-a', '-m', 'pinned'], serviceEnv());
    expect(pinned.code).toBe(0);
    expect(existsSync(marker)).toBe(false);
  });
});
