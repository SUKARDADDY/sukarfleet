// SPDX-License-Identifier: AGPL-3.0-or-later
// Rendering the one-click enrollment installer. Owns src/installer.ts only.
//
// The file this module writes is the whole product of the "Add a machine" card: one double-clickable
// .cmd that carries everything a fresh Windows machine needs to join this fleet, so that nobody has
// to type a mesh address, a network secret or a pairing code on the other end.
//
// TWO RULES SHAPE THE OUTPUT.
//
//   1. NO LOGIC IN THE GENERATED FILE. Everything it does beyond "download the release and start
//      the installer" lives in install/windows/Install-Sukarfleet.ps1, which is in the repository,
//      reviewable, and covered by tests. A generated file is the worst possible place to put
//      behaviour: it is written by a daemon, read by nobody, and there is one copy per machine, so
//      a bug in it is a bug you fix once per installer you ever generated.
//
//   2. THE TOP OF THE FILE EXPLAINS THE BOTTOM. The payload is base64 and there is no way around
//      that, so the comments above it say what is in it, what it is worth to somebody who steals
//      it, and how to decode and read it. A file that says "trust me" is a file that trains people
//      to double-click anything.
//
// The payload travels to PowerShell in an ENVIRONMENT VARIABLE rather than on the command line. It
// carries the mesh secret, and a command line is readable by every process on the box; an
// environment block is at least a smaller audience. Neither is a real defence -- the secret is also
// sitting in the file on disk -- but there is no reason to choose the worse one.

import { join } from 'node:path';
import type { EnrollmentView } from './enroll';
import { writeSecretFile } from './keys';
import { allocateMeshIp, isIpv4, subnetOf } from './meshalloc';
import type { FleetConfig } from './types';
import { ensureDir, log, nowMs } from './util';

export interface InstallerPayload {
  v: 1;
  // Fleet identity
  networkName: string;
  meshSecret: string;
  seeds: string[];
  // This machine's identity, decided at mint
  machine: string;
  role: 'anchor' | 'roamer';
  meshIp: string;
  nodePort: number;
  listenPort: number;
  // Where the code comes from
  ref: string;
  zipUrl: string;
  releaseBase: string;
  // The credential and where to spend it
  enrollId: string;
  token: string;
  pairHost: string;
  pairPort: number;
  // Provenance, for the person holding the file
  mintedBy: string;
  mintedMs: number;
  expiresMs: number;
}

export interface RenderInput {
  payload: InstallerPayload;
  view: EnrollmentView;
}

// Where a generated installer downloads its code from, unless SUKARFLEET_REPO_URL says otherwise.
// The same repository install/get.sh clones, spelled the same way.
export const DEFAULT_REPO_URL = 'https://github.com/SUKARDADDY/sukarfleet';

// Built from the repository URL rather than an owner/name pair, matching install/get.sh's
// SUKARFLEET_GIT_URL seam: one string to override, and the same string a person can paste into a
// browser to see what they are about to download.
export function archiveUrlFor(repoUrl: string, ref: string): string {
  return `${repoUrl.replace(/\/+$/, '')}/archive/refs/tags/${ref}.zip`;
}

export function releaseBaseFor(repoUrl: string, ref: string): string {
  return `${repoUrl.replace(/\/+$/, '')}/releases/download/${ref}`;
}

// A batch file cannot carry a newline inside a `set` value and cmd's line limit is 8191 characters,
// so the payload has to fit on one line. It comfortably does: the JSON is a few hundred bytes.
const MAX_PAYLOAD_CHARS = 6000;

// Windows batch reads CRLF. A .cmd written with bare LF still runs, but every editor on the target
// machine shows it as one long line, which defeats the point of the comment block.
function crlf(s: string): string {
  return s.replace(/\r?\n/g, '\r\n');
}

// The machine name reaches a filename and nothing else, but "nothing else" is the sort of claim that
// stops being true later, so it is constrained here rather than trusted.
export function installerFileName(machine: string): string {
  const safe = machine.replace(/[^A-Za-z0-9._-]/g, '-').slice(0, 48) || 'machine';
  return `Add-${safe}-To-Fleet.cmd`;
}

function fmtUtc(ms: number): string {
  return new Date(ms).toISOString().replace('T', ' ').replace(/\.\d+Z$/, ' UTC');
}

export type RenderResult = { ok: true; content: string; bytes: number } | { ok: false; error: string };

export function renderWindowsInstaller(input: RenderInput): RenderResult {
  const p = input.payload;
  const b64 = Buffer.from(JSON.stringify(p), 'utf8').toString('base64');
  if (b64.length > MAX_PAYLOAD_CHARS) {
    return { ok: false, error: `the enrollment payload is ${b64.length} characters, past what a .cmd line can hold` };
  }
  // Belt and braces against a field that somehow arrived with a quote or a percent sign in it: both
  // are cmd metacharacters, and base64 contains neither, so this can only fire if the encoding above
  // is ever changed.
  if (!/^[A-Za-z0-9+/=]+$/.test(b64)) {
    return { ok: false, error: 'the encoded payload contains characters a batch file cannot carry' };
  }

  // One long line, no double quotes inside: cmd consumes the outer pair and hands the rest to
  // PowerShell verbatim, so every string in here is single-quoted. `|` and `&` are literal inside
  // the quotes and need no escaping.
  const bootstrap = [
    `$ErrorActionPreference='Stop'`,
    `[Net.ServicePointManager]::SecurityProtocol=[Net.SecurityProtocolType]::Tls12`,
    `$d=Join-Path $env:TEMP ('sukarfleet-enroll-'+[guid]::NewGuid().ToString('N'))`,
    `New-Item -ItemType Directory -Force -Path $d | Out-Null`,
    `$z=Join-Path $d 'sukarfleet.zip'`,
    `Write-Host ('[enroll] downloading ' + $env:SF_ZIP_URL)`,
    `Invoke-WebRequest -UseBasicParsing -Uri $env:SF_ZIP_URL -OutFile $z`,
    `Expand-Archive -LiteralPath $z -DestinationPath $d -Force`,
    `$ps=@(Get-ChildItem -Path $d -Recurse -Filter 'Install-Sukarfleet.ps1')`,
    `if($ps.Count -eq 0){throw 'Install-Sukarfleet.ps1 is not in that archive'}`,
    // -Source is the ZIP, deliberately, not the directory the script is sitting in. Without it
    // Resolve-SourceDir would take the temp expansion as the checkout and the node's scheduled task
    // would point into %TEMP%, which Windows is free to delete underneath it.
    `& $ps[0].FullName -Enroll -Source $z`,
    `$rc=$LASTEXITCODE`,
    `if($null -eq $rc){$rc=0}`,
    `exit $rc`,
  ].join('; ');

  const body = `@echo off
rem SPDX-License-Identifier: AGPL-3.0-or-later
rem
rem   sukarfleet enrollment installer
rem
rem   Machine name it will take:  ${p.machine}
rem   Fleet it will join:         ${p.networkName}
rem   Mesh address reserved:      ${p.meshIp}
rem   Generated on:               ${p.mintedBy}, ${fmtUtc(p.mintedMs)}
rem   Valid until:                ${fmtUtc(p.expiresMs)}, single use
rem
rem ---------------------------------------------------------------------------
rem   TREAT THIS FILE LIKE A PASSWORD
rem
rem   The payload line below carries this fleet's mesh secret and a one-shot
rem   enrollment token. Anyone holding this file can join the mesh network until
rem   the date above, whether or not they ever run it. Send it the way you would
rem   send a password, delete it once the machine is in, and revoke it from the
rem   console that made it if you change your mind.
rem
rem   Revoking closes pairing. It does NOT rotate the mesh secret.
rem ---------------------------------------------------------------------------
rem
rem   WHAT IT DOES, IN ORDER
rem     1. downloads sukarfleet ${p.ref} from
rem        ${p.zipUrl}
rem     2. runs install\\windows\\Install-Sukarfleet.ps1 out of that download
rem     3. ONE UAC prompt: the EasyTier mesh service, its config, one firewall rule
rem     4. as you, no admin rights: Bun, this machine's fleet SSH key,
rem        config.json, the node's scheduled task
rem     5. pairs with ${p.pairHost} using the token, then shreds the secret
rem
rem   Do NOT right-click and "Run as administrator". Run it normally. It asks for
rem   elevation itself, for the one stage that needs it, and it needs the rest to
rem   run as you: your config, your SSH key, your scheduled task.
rem
rem   TO READ THE PAYLOAD BEFORE RUNNING IT, paste the long value below into:
rem     powershell -NoProfile -Command "[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('<paste>'))"
rem
rem   Everything this file does beyond downloading and starting the installer is
rem   in that repository, at the tag named above, not in here.
rem

setlocal
set "SUKARFLEET_ENROLL_PAYLOAD=${b64}"
set "SF_ZIP_URL=${p.zipUrl}"

where powershell.exe >nul 2>&1
if errorlevel 1 (
  echo.
  echo   Windows PowerShell was not found on PATH. This installer needs it.
  echo.
  pause
  exit /b 1
)

powershell.exe -NoProfile -ExecutionPolicy Bypass -Command "${bootstrap}"
set "RC=%ERRORLEVEL%"

rem The payload dies with this shell either way; cleared explicitly so it is not
rem sitting in the environment of anything this window goes on to start.
set "SUKARFLEET_ENROLL_PAYLOAD="

echo.
if not "%RC%"=="0" echo   Enrollment exited with code %RC%. The output above says why.
pause
exit /b %RC%
`;

  const content = crlf(body);
  return { ok: true, content, bytes: Buffer.byteLength(content, 'utf8') };
}

// ---------------------------------------------------------------------------
// Issuing: allocate, mint, render, write. One place, so uiserve stays a route table and node.ts
// stays a wiring file.
// ---------------------------------------------------------------------------

export interface IssuerEnrollments {
  list(): Promise<EnrollmentView[]>;
  mint(input: {
    machine: string;
    meshIp: string;
    nodePort: number;
    role: 'anchor' | 'roamer';
    platform: 'windows';
    installerPath: string;
  }): Promise<{ view: EnrollmentView; token: string } | { error: string }>;
  revoke(id: string): Promise<boolean>;
}

export interface IssuerDeps {
  cfg: FleetConfig;
  enrollments: IssuerEnrollments;
  // The fleet's mesh secret, or null when this machine does not have one yet. Reading it is the
  // whole reason minting is a loopback-only route.
  revealMeshSecret: () => Promise<string | null>;
  outputDir: string;
  repoUrl: string;
  ref: string;
  listenPort: number;
  now?: () => number;
  writeFile?: (path: string, content: string) => Promise<void>;
}

export interface SuggestResult {
  canMint: boolean;
  // Present when canMint; the console pre-fills the field with it and says where it came from.
  meshIp?: string;
  meshIpFrom?: string;
  nodePort: number;
  ref: string;
  seeds: string[];
  // Present when !canMint: one sentence naming the thing to fix.
  blocked?: string;
  // Always present when this machine is a roamer: the console repeats it, because a roamer's peer
  // list is not the fleet's peer list and the allocated address is only as good as that list.
  rosterCaveat?: string;
}

const MACHINE_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

export class EnrollmentIssuer {
  private readonly deps: IssuerDeps;
  private readonly now: () => number;

  constructor(deps: IssuerDeps) {
    this.deps = deps;
    this.now = deps.now ?? nowMs;
  }

  private get cfg(): FleetConfig {
    return this.deps.cfg;
  }

  // This machine's own mesh endpoint, which is what a fresh machine dials to find the network. A
  // list of one today: a second entry would need a second machine's listener port, and this machine
  // does not know the other machines' listener ports -- only their node ports.
  private seeds(): string[] {
    if (!this.cfg.meshIp) return [];
    return [`tcp://${this.cfg.meshIp}:${this.deps.listenPort}`];
  }

  async suggest(): Promise<SuggestResult> {
    const base = { nodePort: this.cfg.nodePort, ref: this.deps.ref, seeds: this.seeds() };
    const secret = await this.deps.revealMeshSecret().catch(() => null);
    if (!secret) {
      return {
        ...base,
        canMint: false,
        blocked:
          'This machine has no mesh secret yet, and an installer is mostly a copy of it. Finish the Mesh network card first.',
      };
    }
    if (!this.cfg.meshIp) {
      return {
        ...base,
        canMint: false,
        blocked:
          'This machine has no mesh address yet, so there is no range to allocate one from and nothing for the new machine to dial. Finish the Identity card first.',
      };
    }

    const reserved = (await this.deps.enrollments.list())
      .filter((e) => e.state === 'live')
      .map((e) => e.meshIp);
    const alloc = allocateMeshIp({ cfg: this.cfg, reserved });
    if (!alloc.ok) return { ...base, canMint: false, blocked: alloc.message };

    return {
      ...base,
      canMint: true,
      meshIp: alloc.meshIp,
      meshIpFrom: `${alloc.taken} address${alloc.taken === 1 ? '' : 'es'} already in use in ${alloc.from}`,
      ...(this.cfg.role === 'roamer'
        ? {
            rosterCaveat:
              'This machine is a roamer, so it lists only the peers it has paired with, not the whole fleet. Mint from the anchor when you can, or check the address against the other machines.',
          }
        : {}),
    };
  }

  async issue(input: {
    machine: string;
    meshIp?: string;
    nodePort?: number;
    role?: 'anchor' | 'roamer';
  }): Promise<{ ok: true; view: EnrollmentView; bytes: number } | { ok: false; message: string }> {
    const machine = (input.machine ?? '').trim();
    if (!MACHINE_RE.test(machine)) {
      return { ok: false, message: 'A machine name is letters, digits, dot, dash or underscore, and starts with one of the first two.' };
    }
    if (machine === this.cfg.machine) {
      return { ok: false, message: `This machine is already called ${machine}. Give the new one a different name.` };
    }

    const secret = await this.deps.revealMeshSecret().catch(() => null);
    if (!secret) {
      return { ok: false, message: 'This machine has no mesh secret to put in an installer. Finish the Mesh network card first.' };
    }
    const seeds = this.seeds();
    if (seeds.length === 0) {
      return { ok: false, message: 'This machine has no mesh address, so a new machine would have nothing to dial.' };
    }

    const nodePort = input.nodePort ?? this.cfg.nodePort;
    if (!Number.isInteger(nodePort) || nodePort < 1 || nodePort > 65535) {
      return { ok: false, message: 'That node port is not valid.' };
    }
    const role = input.role ?? 'roamer';

    let meshIp = (input.meshIp ?? '').trim();
    if (meshIp) {
      if (!isIpv4(meshIp)) return { ok: false, message: 'That mesh address is not an IPv4 address.' };
      if (subnetOf(meshIp) !== subnetOf(this.cfg.meshIp)) {
        return { ok: false, message: `That address is not in this fleet's range, ${subnetOf(this.cfg.meshIp)}.0/24.` };
      }
      // An address this machine can see is taken is refused even when typed by hand. Overriding the
      // allocator is for addresses it CANNOT see, which is the case the caveat is about.
      const clash =
        meshIp === this.cfg.meshIp ||
        this.cfg.peers.some((p) => p.meshIp === meshIp) ||
        (await this.deps.enrollments.list()).some((e) => e.state === 'live' && e.meshIp === meshIp);
      if (clash) return { ok: false, message: `${meshIp} is already spoken for on this machine's roster.` };
    } else {
      const reserved = (await this.deps.enrollments.list()).filter((e) => e.state === 'live').map((e) => e.meshIp);
      const alloc = allocateMeshIp({ cfg: this.cfg, reserved });
      if (!alloc.ok) return { ok: false, message: alloc.message };
      meshIp = alloc.meshIp;
    }

    const installerPath = join(this.deps.outputDir, installerFileName(machine));
    const minted = await this.deps.enrollments.mint({
      machine,
      meshIp,
      nodePort,
      role,
      platform: 'windows',
      installerPath,
    });
    if ('error' in minted) return { ok: false, message: minted.error };

    const payload: InstallerPayload = {
      v: 1,
      networkName: this.cfg.networkName,
      meshSecret: secret,
      seeds,
      machine,
      role,
      meshIp,
      nodePort,
      listenPort: this.deps.listenPort,
      ref: this.deps.ref,
      zipUrl: archiveUrlFor(this.deps.repoUrl, this.deps.ref),
      releaseBase: releaseBaseFor(this.deps.repoUrl, this.deps.ref),
      enrollId: minted.view.id,
      token: minted.token,
      pairHost: this.cfg.meshIp,
      pairPort: this.cfg.nodePort,
      mintedBy: this.cfg.machine,
      mintedMs: this.now(),
      expiresMs: minted.view.expiresMs,
    };

    const rendered = renderWindowsInstaller({ payload, view: minted.view });
    if (!rendered.ok) {
      // The token exists and the file does not, which is the one state worth undoing: a live
      // enrollment nobody can spend still reserves an address and still shows on the card.
      await this.deps.enrollments.revoke(minted.view.id).catch(() => false);
      return { ok: false, message: rendered.error };
    }

    try {
      await ensureDir(this.deps.outputDir);
      const write = this.deps.writeFile ?? writeSecretFile;
      // 0600. The file holds the mesh secret; it is exactly as sensitive as the state file the
      // token lives in, and on a shared machine the default umask is not good enough.
      await write(installerPath, rendered.content);
    } catch (err) {
      await this.deps.enrollments.revoke(minted.view.id).catch(() => false);
      log('error', 'installer: could not write the generated installer', { installerPath, error: String(err) });
      return { ok: false, message: `Could not write ${installerPath}: ${String(err)}` };
    }

    log('info', 'installer: generated', { machine, meshIp, installerPath, bytes: rendered.bytes });
    return { ok: true, view: minted.view, bytes: rendered.bytes };
  }
}
