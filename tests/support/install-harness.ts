// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Runs the install scripts the way the tests are allowed to run them: with
// SUKARFLEET_DRY_RUN=1, a HOME and a state directory under the OS temp
// directory, and a PATH whose FIRST entry is a stub directory. Nothing here can
// reach a real systemd session, a real firewall or a real checkout, and that is
// the point -- a machine running these tests is usually a machine with a live
// sukarfleet on it.
//
// Not a `.test.ts` file, so bun test does not run it as a suite; it is imported
// by the suites that need it.

import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

export const REPO_ROOT = join(import.meta.dir, '..', '..');

// Every external command the scripts probe for or would run, stubbed. `exit 0`
// is enough for the ones that are only ever `command -v`'d in a dry run; the
// two that are read for their OUTPUT get one line each.
//
//   ss        "nothing is listening", so the port preflight passes on a machine
//             whose real 7710 is held by its own daemon.
//   ldconfig  prints nothing, so the tray library probe finds neither library.
const DEFAULT_STUBS: Record<string, string> = {
  systemctl: 'exit 0\n',
  loginctl: 'exit 0\n',
  'systemd-run': 'exit 0\n',
  'systemd-creds': 'exit 1\n',
  visudo: 'exit 0\n',
  'ssh-keygen': 'exit 0\n',
  'xdg-open': 'exit 0\n',
  curl: 'exit 1\n',
  git: 'exit 0\n',
  ss: 'exit 0\n',
  ldconfig: 'exit 0\n',
};

export interface Harness {
  dir: string;
  home: string;
  state: string;
  stub: string;
  /** Writes an executable stub, replacing any default of the same name. */
  putStub(name: string, body: string): void;
  /** Writes a file under the harness home, creating parent directories. */
  putFile(relPath: string, contents: string, mode?: number): string;
  cleanup(): void;
}

export function makeInstallHarness(label = 'sukarfleet-install'): Harness {
  const dir = mkdtempSync(join(tmpdir(), `${label}-`));
  const home = join(dir, 'home');
  const state = join(dir, 'state');
  const stub = join(dir, 'stub');
  for (const d of [home, state, stub]) mkdirSync(d, { recursive: true });

  const putStub = (name: string, body: string): void => {
    const path = join(stub, name);
    writeFileSync(path, `#!/bin/sh\n${body}`);
    chmodSync(path, 0o755);
  };
  for (const [name, body] of Object.entries(DEFAULT_STUBS)) putStub(name, body);

  return {
    dir,
    home,
    state,
    stub,
    putStub,
    putFile(relPath: string, contents: string, mode = 0o600): string {
      const path = join(home, relPath);
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, contents);
      chmodSync(path, mode);
      return path;
    },
    cleanup(): void {
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

export interface ScriptResult {
  code: number;
  stdout: string;
  stderr: string;
  /** stdout and stderr in one string, for asserting on a message wherever it went. */
  output: string;
}

/**
 * Runs one of install/*.sh under the harness. `timeoutMs` is not a nicety: a
 * guard that opens a path without O_NONBLOCK blocks forever on a fifo, and a
 * test for that has to be able to fail rather than hang.
 */
export async function runInstallScript(
  h: Harness,
  script: string,
  args: string[],
  env: Record<string, string> = {},
  opts: { timeoutMs?: number; shell?: string } = {},
): Promise<ScriptResult> {
  const timeoutMs = opts.timeoutMs ?? 60_000;
  const path = [h.stub, dirname(process.execPath), process.env.PATH ?? '/usr/bin:/bin'].join(':');
  const proc = Bun.spawn([opts.shell ?? 'bash', join(REPO_ROOT, 'install', script), ...args], {
    cwd: REPO_ROOT,
    stdout: 'pipe',
    stderr: 'pipe',
    stdin: 'ignore',
    env: {
      PATH: path,
      HOME: h.home,
      SUKARFLEET_STATE: h.state,
      SUKARFLEET_DRY_RUN: '1',
      // Nothing below is apt-specific, and the tests must pass on whatever the
      // machine running them happens to be.
      SUKARFLEET_SKIP_DISTRO_CHECK: '1',
      // Headless by default: the tray path is opted into per test.
      DISPLAY: '',
      WAYLAND_DISPLAY: '',
      ...env,
    },
  });

  const timer = setTimeout(() => proc.kill(9), timeoutMs);
  try {
    const [stdout, stderr, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    return { code, stdout, stderr, output: `${stdout}${stderr}` };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * The line the dry run prints for the `easytier-toml` call, split back into the
 * argv the shell built. Every value the elevated stage passes is charset-checked
 * before it gets here (no spaces survive that), so splitting on whitespace
 * recovers the tokens exactly.
 */
export function easytierTomlArgv(output: string): string[] {
  const line = output.split('\n').find((l) => l.includes(' easytier-toml '));
  if (!line) throw new Error(`no easytier-toml command line in:\n${output}`);
  const tokens = line.trim().split(/\s+/);
  const start = tokens.indexOf('easytier-toml');
  const redirect = tokens.indexOf('>');
  return tokens.slice(start + 1, redirect === -1 ? undefined : redirect);
}
