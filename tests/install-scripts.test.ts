// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The install scripts, exercised rather than grepped.
//
// Every test here runs a real script under SUKARFLEET_DRY_RUN=1 with a HOME and
// a state directory in the OS temp directory and a PATH stub in front, so
// nothing reaches a real systemd session, a real firewall or a real /etc. What
// that buys is the class of bug this file exists for: the elevated stage and
// `src/cli.ts` disagreeing about how a flag is spelled, a value from an
// unprivileged user's config.json reaching a command, and a guard that blocks
// instead of refusing. All three shipped; all three were invisible to a test
// that read the scripts as text.
//
// Every address here is from 192.0.2.0/24 (TEST-NET-1), reserved for
// documentation.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseEasytierTomlArgs } from '../src/cli';
import {
  REPO_ROOT,
  easytierTomlArgv,
  makeInstallHarness,
  runInstallScript,
  type Harness,
} from './support/install-harness';

const STAGED = {
  secret: 'a-fixture-mesh-secret',
  meshIp: '192.0.2.3',
  hostname: 'alpha',
  networkName: 'test-fleet',
  listeners: ['tcp://0.0.0.0:11010', 'udp://0.0.0.0:11010'],
};

let h: Harness;
let pending: string;

beforeEach(() => {
  h = makeInstallHarness();
  pending = join(h.state, 'pending-easytier-secret');
  writeFileSync(pending, `${JSON.stringify({ ...STAGED, networkSecret: STAGED.secret })}\n`, { mode: 0o600 });
  h.putFile(
    '.config/sukarfleet/config.json',
    `${JSON.stringify({ machine: 'harness-box', meshIp: '192.0.2.9', networkName: 'sukarfleet', nodePort: 7710 })}\n`,
  );
});
afterEach(() => h.cleanup());

/** The elevated stage, dry, against the harness's staged file and home. */
function elevated(extraArgs: string[] = [], env: Record<string, string> = {}, timeoutMs = 30_000) {
  return runInstallScript(
    h,
    'install-elevated.sh',
    ['--adopt-pending-secret', `--pending=${pending}`, `--user=${process.env.USER ?? 'nobody'}`, ...extraArgs],
    {
      SUKARFLEET_TARGET_HOME: h.home,
      SUKARFLEET_EASYTIER_DIR: join(h.dir, 'opt', 'easytier'),
      ...env,
    },
    { timeoutMs },
  );
}

// ---------------------------------------------------------------------------
// The argv the shell builds, fed to the parser that has to read it
// ---------------------------------------------------------------------------
//
// This is the one that shipped broken. install-elevated.sh built
// `--mesh-ip 192.0.2.3`; parseEasytierTomlArgs read only `--mesh-ip=...`; every
// real elevated run died at exit 5 with EasyTier already installed and the TOML
// never written. Reading either file alone showed nothing wrong. So the tokens
// come out of a real run of the script and go into the real parser.

describe('the elevated stage and the easytier-toml parser cannot drift apart', () => {
  test('the argv the script prints is the argv the CLI parses', async () => {
    const run = await elevated();
    expect(run.code).toBe(0);

    const argv = easytierTomlArgv(run.output);
    expect(argv.length).toBeGreaterThan(5);

    const parsed = parseEasytierTomlArgs(argv);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value.meshIp).toBe(STAGED.meshIp);
    expect(parsed.value.hostname).toBe(STAGED.hostname);
    expect(parsed.value.networkName).toBe(STAGED.networkName);
    expect(parsed.value.listeners).toEqual(STAGED.listeners);
    expect(parsed.value.secretFile).toContain('staged-secret');
  });

  test('a peer passed on the command line reaches the same argv', async () => {
    const run = await elevated(['--peer=tcp://192.0.2.4:11010']);
    const parsed = parseEasytierTomlArgs(easytierTomlArgv(run.output));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value.peers).toEqual(['tcp://192.0.2.4:11010']);
  });
});

// ---------------------------------------------------------------------------
// The staged-file guard
// ---------------------------------------------------------------------------

describe('the staged file is refused unless it is what it claims to be', () => {
  test('a fifo is refused, and refused promptly', async () => {
    const fifo = join(h.state, 'fifo');
    Bun.spawnSync(['mkfifo', '-m', '600', fifo]);
    expect(existsSync(fifo)).toBe(true);
    pending = fifo;

    // The timeout is the assertion: open(O_RDONLY|O_NOFOLLOW) on a fifo with no
    // writer blocks forever, and S_ISREG is only checked after the open, so
    // without O_NONBLOCK this hangs a ROOT process rather than refusing.
    const run = await elevated([], {}, 20_000);
    expect(run.code).toBe(3);
    expect(run.output).toContain('it is not a regular file (expected a regular file owned by you at mode 0600)');
  });

  test('a symlink is refused, and the target is not read', async () => {
    const link = join(h.state, 'link');
    symlinkSync('/etc/hostname', link);
    pending = link;
    const run = await elevated();
    expect(run.code).toBe(3);
    expect(run.output).toContain('it is a symbolic link (expected a regular file owned by you at mode 0600)');
  });

  test('a mode that is not 0600 is refused', async () => {
    Bun.spawnSync(['chmod', '0644', pending]);
    const run = await elevated();
    expect(run.code).toBe(3);
    expect(run.output).toContain('its mode is 0644, not 0600');
  });

  test('the shred names the file the guard identified, not the path', async () => {
    const run = await elevated();
    // dev/inode, printed by the dry run, are what the real shred re-checks
    // through a fresh fd before it writes a single zero.
    expect(run.output).toMatch(/overwrite .*pending-easytier-secret through the fd the guard verified \(dev \d+, inode \d+\)/);
  });
});

// ---------------------------------------------------------------------------
// Values out of the user's own files
// ---------------------------------------------------------------------------
//
// nodePort landed unquoted inside `eval "$r"` when the firewall rules were
// built, so a crafted config.json ran arbitrary commands as root. There is no
// eval left, and the value is checked before it reaches an argv either way --
// both halves are pinned here, because either one alone is one edit from being
// the only thing standing between a user's file and a root shell.

describe('nothing from config.json or the staged file reaches a command unchecked', () => {
  test('a nodePort carrying a shell command is refused, and never runs', async () => {
    const canary = join(h.dir, 'canary');
    h.putFile(
      '.config/sukarfleet/config.json',
      `${JSON.stringify({
        machine: 'harness-box',
        meshIp: '192.0.2.9',
        nodePort: `7710 comment x; touch ${canary}`,
      })}\n`,
    );
    const run = await elevated();
    expect(run.code).toBe(3);
    expect(run.output).toContain('it must be a whole number between 1 and 65535');
    expect(existsSync(canary)).toBe(false);
  });

  test('a staged network name that would break out of the TOML is refused', async () => {
    writeFileSync(
      pending,
      `${JSON.stringify({ ...STAGED, networkName: 'fleet" evil = "1', networkSecret: STAGED.secret })}\n`,
      { mode: 0o600 },
    );
    const run = await elevated();
    expect(run.code).toBe(3);
    expect(run.output).toContain('refusing the network name');
  });

  test('a staged mesh IP that is not one is refused', async () => {
    writeFileSync(pending, `${JSON.stringify({ ...STAGED, meshIp: '192.0.2.3 x', networkSecret: STAGED.secret })}\n`, {
      mode: 0o600,
    });
    const run = await elevated();
    expect(run.code).toBe(3);
    expect(run.output).toContain('refusing the mesh IP');
  });

  test('a staged listener that is not proto://host:port is refused', async () => {
    writeFileSync(
      pending,
      `${JSON.stringify({ ...STAGED, listeners: ['tcp://0.0.0.0:11010', 'rm -rf /'], networkSecret: STAGED.secret })}\n`,
      { mode: 0o600 },
    );
    const run = await elevated();
    expect(run.code).toBe(3);
    expect(run.output).toContain('refusing the staged listener');
  });

  test('firewall rules are built as an argv, not as a string a shell reparses', async () => {
    h.putStub('ufw', 'if [ "$1" = status ]; then echo "Status: active"; fi\nexit 0\n');
    const run = await elevated();
    expect(run.code).toBe(0);
    // printf %q: the spaces inside the comment are escaped, which is what a
    // single argument looks like when it is printed for a human. A string built
    // for `eval` would show the shell quotes it was assembled with instead.
    expect(run.output).toContain('firewall: ufw allow 11010/tcp comment sukarfleet\\ mesh\\ listener');
    expect(run.output).toContain('firewall: ufw allow from 192.0.2.0/24 to any port 7710 proto tcp');
    expect(run.output).not.toContain("comment 'sukarfleet");
  });

  test('no script in install/ evals anything', () => {
    for (const script of ['get.sh', 'quickstart.sh', 'install-elevated.sh', 'uninstall.sh']) {
      const text = readFileSync(join(REPO_ROOT, 'install', script), 'utf8');
      const evals = text.split('\n').filter((l) => /(^|[^\w-])eval\s/.test(l) && !l.trimStart().startsWith('#'));
      expect(evals).toEqual([]);
    }
  });
});

// ---------------------------------------------------------------------------
// The pin file
// ---------------------------------------------------------------------------

describe('the pin file is read strictly', () => {
  test('two pins for the same version and arch are a refusal, not a coin toss', async () => {
    const pins = join(h.dir, 'pins-dup.txt');
    writeFileSync(
      pins,
      [
        '2.6.4 x86_64  1111111111111111111111111111111111111111111111111111111111111111 easytier-linux-x86_64-v2.6.4.zip',
        '2.6.4 x86_64  2222222222222222222222222222222222222222222222222222222222222222 easytier-linux-x86_64-v2.6.4.zip',
        '2.6.4 aarch64 3333333333333333333333333333333333333333333333333333333333333333 easytier-linux-aarch64-v2.6.4.zip',
      ].join('\n'),
    );
    const run = await elevated([], { SUKARFLEET_PINS_FILE: pins });
    expect(run.code).toBe(3);
    expect(run.output).toContain('more than one EasyTier pin');
  });

  test('a TODO-S9 line never shadows a real pin, whatever order they sit in', async () => {
    const pins = join(h.dir, 'pins-todo-first.txt');
    writeFileSync(
      pins,
      [
        '2.6.4 x86_64  TODO-S9 easytier-linux-x86_64-v2.6.4.zip',
        '2.6.4 aarch64 TODO-S9 easytier-linux-aarch64-v2.6.4.zip',
        '2.6.5 x86_64  4444444444444444444444444444444444444444444444444444444444444444 easytier-linux-x86_64-v2.6.5.zip',
        '2.6.5 aarch64 5555555555555555555555555555555555555555555555555555555555555555 easytier-linux-aarch64-v2.6.5.zip',
      ].join('\n'),
    );
    const run = await elevated([], { SUKARFLEET_PINS_FILE: pins });
    expect(run.code).toBe(0);
    expect(run.output).toMatch(/verify sha256 == (4444444444444444444444444444444444444444444444444444444444444444|5555555555555555555555555555555555555555555555555555555555555555)/);
    expect(run.output).not.toContain('TODO-S9');
  });

  test('the user stage refuses a contradictory tray pin too', async () => {
    // Both libraries present, so the tray path is actually walked rather than
    // skipped in preflight.
    h.putStub('ldconfig', 'echo "  libwebkit2gtk-4.1.so.0 (libc6,x86-64) => /usr/lib/libwebkit2gtk-4.1.so.0"\necho "  libayatana-appindicator3.so.1 (libc6,x86-64) => /usr/lib/libayatana-appindicator3.so.1"\nexit 0\n');
    const pins = join(h.dir, 'pins-tray-dup.txt');
    const rows: string[] = [];
    for (const arch of ['x86_64', 'aarch64']) {
      rows.push(`0.1.0 ${arch} 6666666666666666666666666666666666666666666666666666666666666666 sukarfleet-tray-linux-${arch}`);
      rows.push(`0.1.0 ${arch} 7777777777777777777777777777777777777777777777777777777777777777 sukarfleet-tray-linux-${arch}`);
    }
    writeFileSync(pins, rows.join('\n'));

    const run = await runInstallScript(
      h,
      'quickstart.sh',
      ['--no-open', '--machine=harness-box'],
      { DISPLAY: ':99', SUKARFLEET_PINS_FILE: pins },
    );
    expect(run.code).toBe(0);
    expect(run.output).toContain('more than one tray pin');
    expect(run.output).toContain('Skipping the tray.');
  });

  test('a pin file with nothing but TODO still refuses to install unverified', async () => {
    const pins = join(h.dir, 'pins-todo-only.txt');
    writeFileSync(
      pins,
      ['2.6.4 x86_64  TODO-S9 easytier-linux-x86_64-v2.6.4.zip', '2.6.4 aarch64 TODO-S9 easytier-linux-aarch64-v2.6.4.zip'].join('\n'),
    );
    const run = await elevated([], { SUKARFLEET_PINS_FILE: pins });
    expect(run.code).toBe(3);
    expect(run.output).toContain('is still TODO-S9');
  });
});

// ---------------------------------------------------------------------------
// The messages section 6 promises
// ---------------------------------------------------------------------------

describe('the user stage prints what the failure table says it prints', () => {
  test('both tray libraries missing reads as one sentence about two libraries', async () => {
    // A desktop, x86_64, with an ldconfig that finds neither library.
    const run = await runInstallScript(
      h,
      'quickstart.sh',
      ['--no-open', '--machine=harness-box'],
      { DISPLAY: ':99' },
    );
    expect(run.code).toBe(0);
    if (process.arch === 'x64') {
      expect(run.output).toContain(
        'the console window needs libwebkit2gtk-4.1.so.0 and libayatana-appindicator3.so.1, neither of which ldconfig can find. Skipping the tray.',
      );
    } else {
      expect(run.output).toContain('no tray build for');
    }
  });

  test('the checksum failure sentence is the one the spec table carries', () => {
    const script = readFileSync(join(REPO_ROOT, 'install', 'quickstart.sh'), 'utf8');
    const spec = readFileSync(join(REPO_ROOT, 'docs', 'INSTALL-FLOW.md'), 'utf8');
    expect(spec).toContain(
      'could not install sukarfleet-tray (SHA256 mismatch against install/easytier-pins.txt). Nothing was installed to ~/.local/bin.',
    );
    expect(script).toContain('could not install sukarfleet-tray (${TRAY_REASON}). Nothing was installed to ${BIN_DIR}.');
    expect(script).toContain('SHA256 mismatch against install/easytier-pins.txt');
  });

  test('the GNOME icon line is the spec\'s sentence, not a paraphrase', () => {
    const script = readFileSync(join(REPO_ROOT, 'install', 'quickstart.sh'), 'utf8');
    expect(script).toContain(
      'the tray is running but GNOME needs the AppIndicator extension (gnome-shell-extension-appindicator) to show it. Until it is installed, open the console at ${UI_URL}',
    );
  });

  test('a bad --machine or --mesh-ip is refused before anything is written', async () => {
    const bad = await runInstallScript(h, 'quickstart.sh', ['--no-open', '--machine=box; rm -rf /']);
    expect(bad.code).toBe(2);
    expect(bad.output).toContain('--machine must be 1-64 characters');

    const badIp = await runInstallScript(h, 'quickstart.sh', ['--no-open', '--mesh-ip=192.0.2.999']);
    expect(badIp.code).toBe(2);
    expect(badIp.output).toContain('--mesh-ip must be an IPv4 address');
  });

  test('the sudo line refused before the Identity card is filled is in the table', async () => {
    // A bare secret and a config.json with no meshIp: exactly the machine that
    // ran the sudo line before filling in the Identity card.
    writeFileSync(pending, 'a-fixture-mesh-secret\n', { mode: 0o600 });
    h.putFile('.config/sukarfleet/config.json', `${JSON.stringify({ machine: 'harness-box', nodePort: 7710 })}\n`);
    const run = await elevated();
    expect(run.code).toBe(3);
    expect(run.output).toContain("Set this machine's mesh address on the console's Identity card");

    const spec = readFileSync(join(REPO_ROOT, 'docs', 'INSTALL-FLOW.md'), 'utf8');
    expect(spec).toContain('Sudo line run before the Identity card was filled');
    expect(spec).toContain("Set this machine's mesh address on the console's Identity card");
  });
});

// ---------------------------------------------------------------------------
// Stage 0
// ---------------------------------------------------------------------------

describe('get.sh', () => {
  test('names its own seams, including where the checkout goes', () => {
    const script = readFileSync(join(REPO_ROOT, 'install', 'get.sh'), 'utf8');
    const seams = script.slice(script.indexOf('--- test seams'), script.indexOf('REF="${SUKARFLEET_REF'));
    for (const seam of [
      'SUKARFLEET_REF',
      'SUKARFLEET_GIT_URL',
      'SUKARFLEET_RELEASE_BASE',
      'SUKARFLEET_APP_DIR',
      'SUKARFLEET_DRY_RUN',
    ]) {
      expect(seams).toContain(seam);
    }
  });

  test('the re-run path fetches one commit and says how long the stage took', async () => {
    const appDir = join(h.dir, 'app');
    mkdirSync(join(appDir, '.git'), { recursive: true });
    const run = await runInstallScript(h, 'get.sh', [], { SUKARFLEET_APP_DIR: appDir }, { shell: 'sh' });
    expect(run.code).toBe(0);
    // No --tags, and depth 1: the checkout uses FETCH_HEAD, so every other tag's
    // objects are bytes nobody reads on the path a person waits on.
    expect(run.output).toContain('fetch --force --depth 1');
    expect(run.output).not.toContain('--tags');
    // The cost of this stage, printed on every path: it is the 17 seconds a
    // re-run spends before quickstart.sh's own clock starts.
    expect(run.output).toMatch(/checkout stage done in \d+s/);
  });
});

// ---------------------------------------------------------------------------
// Uninstall
// ---------------------------------------------------------------------------

describe('uninstall says what it actually took off', () => {
  test('credentials are counted rather than announced as one', async () => {
    h.putFile('.config/sukarfleet/secrets/sudo-a.cred', 'x');
    h.putFile('.config/sukarfleet/secrets/sudo-b.cred', 'y');
    const run = await runInstallScript(h, 'uninstall.sh', ['--yes']);
    expect(run.code).toBe(0);
    expect(run.output).toContain('shredded the staged mesh secret and 2 stored credentials');
  });

  test('the summary line is not printed when nothing came off', () => {
    // The dry run reports every branch, so this one is read from the script: the
    // log call is guarded by the count it summarises.
    const script = readFileSync(join(REPO_ROOT, 'install', 'uninstall.sh'), 'utf8');
    expect(script).toContain('if [ "${#REMOVED[@]}" -gt 0 ]; then\n  log "stopped and removed');
  });
});
