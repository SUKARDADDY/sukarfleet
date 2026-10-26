// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The Windows installer must never put an answer it collected on a command line. It used to start
// the install scripts as  cmd.exe /C "powershell.exe ... -PeerUri "<field>" ... > "<log>" 2>&1",
// so a field holding  " & <command> & rem "  ran <command> through cmd.exe under the elevated
// token. The fix: every answer travels in a JSON settings file written into a directory the
// installer has restricted, powershell.exe is started directly with fixed switches and two paths
// the installer built, and the scripts read, check and log for themselves.
//
// No test here can run Inno Setup, so (a) reads install/windows/sukarfleet.iss as Pascal and checks
// its structure: no cmd.exe at all, an exact list of Exec calls, and no wizard or command-line
// answer reachable from anything that builds a command line. (b) reads the two install scripts and
// checks they take -SettingsFile, read every key the installer writes, and start their own
// elevated stage the same way. (c) runs the real scripts under pwsh, when pwsh is installed, with
// settings files full of shell syntax, and checks the values arrive as literal data, are refused
// by the scripts' own checks, and run nothing.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { REPO_ROOT } from './support/install-harness';

const WIN_DIR = join(REPO_ROOT, 'install', 'windows');
const ISS_PATH = join(WIN_DIR, 'sukarfleet.iss');
const MACHINE_PS1 = join(WIN_DIR, 'Install-MachineNode.ps1');
const USER_PS1 = join(WIN_DIR, 'Install-Sukarfleet.ps1');

// ---------------------------------------------------------------------------
// A small Pascal reader: enough of Inno Setup's [Code] dialect to find routines, calls and
// string literals, with comments removed and strings kept whole.
// ---------------------------------------------------------------------------

type Tok = { k: 'id' | 'str' | 'num' | 'chr' | 'sym'; v: string };

function tokenizePascal(src: string): Tok[] {
  const out: Tok[] = [];
  let i = 0;
  const at = (j: number) => src[j] ?? '';
  while (i < src.length) {
    const c = at(i);
    if (/\s/.test(c)) { i++; continue; }
    if (c === '/' && at(i + 1) === '/') { while (i < src.length && at(i) !== '\n') i++; continue; }
    if (c === '{') { const j = src.indexOf('}', i); i = j < 0 ? src.length : j + 1; continue; }
    if (c === '(' && at(i + 1) === '*') { const j = src.indexOf('*)', i + 2); i = j < 0 ? src.length : j + 2; continue; }
    if (c === "'") {
      let v = '';
      i++;
      while (i < src.length) {
        if (at(i) === "'") {
          if (at(i + 1) === "'") { v += "'"; i += 2; continue; }
          i++;
          break;
        }
        v += at(i++);
      }
      out.push({ k: 'str', v });
      continue;
    }
    if (c === '#') {
      let j = i + 1;
      if (at(j) === '$') j++;
      while (/[0-9A-Fa-f]/.test(at(j))) j++;
      out.push({ k: 'chr', v: src.slice(i, j) });
      i = j;
      continue;
    }
    if (/[A-Za-z_]/.test(c)) {
      let j = i;
      while (/[A-Za-z0-9_]/.test(at(j))) j++;
      out.push({ k: 'id', v: src.slice(i, j) });
      i = j;
      continue;
    }
    if (/[0-9$]/.test(c)) {
      let j = i + 1;
      while (/[0-9A-Fa-f]/.test(at(j))) j++;
      out.push({ k: 'num', v: src.slice(i, j) });
      i = j;
      continue;
    }
    const two = src.slice(i, i + 2);
    if ([':=', '<>', '<=', '>='].includes(two)) { out.push({ k: 'sym', v: two }); i += 2; continue; }
    out.push({ k: 'sym', v: c });
    i++;
  }
  return out;
}

const isId = (t: Tok | undefined, name: string) => t?.k === 'id' && t.v.toLowerCase() === name.toLowerCase();
const show = (toks: Tok[]) => toks.map((t) => (t.k === 'str' ? `'${t.v}'` : t.v)).join(' ');

interface Routine { name: string; body: Tok[] }

/** Every function and procedure in [Code], with the tokens between its outer begin and end. */
function routinesOf(toks: Tok[]): Map<string, Routine> {
  const out = new Map<string, Routine>();
  for (let i = 0; i < toks.length; i++) {
    if (!(isId(toks[i], 'function') || isId(toks[i], 'procedure')) || toks[i + 1]?.k !== 'id') continue;
    const name = toks[i + 1]!.v;
    let j = i + 2;
    while (j < toks.length && !isId(toks[j], 'begin')) j++;
    let depth = 0;
    const start = j + 1;
    for (; j < toks.length; j++) {
      if (isId(toks[j], 'begin') || isId(toks[j], 'try') || isId(toks[j], 'case')) depth++;
      else if (isId(toks[j], 'end')) {
        depth--;
        if (depth === 0) break;
      }
    }
    out.set(name.toLowerCase(), { name, body: toks.slice(start, j) });
    i = j;
  }
  return out;
}

interface Call { routine: string; args: Tok[][] }

/** Every call of `callee(...)`, its enclosing routine and its top-level arguments. */
function callsOf(routines: Map<string, Routine>, callee: string): Call[] {
  const out: Call[] = [];
  for (const r of routines.values()) {
    const b = r.body;
    for (let i = 0; i < b.length; i++) {
      if (!isId(b[i], callee) || b[i + 1]?.v !== '(') continue;
      const args: Tok[][] = [[]];
      let depth = 0;
      for (let j = i + 1; j < b.length; j++) {
        const t = b[j]!;
        if (t.v === '(' && t.k === 'sym') { depth++; if (depth === 1) continue; }
        if (t.v === ')' && t.k === 'sym') { depth--; if (depth === 0) break; }
        if (t.v === ',' && t.k === 'sym' && depth === 1) { args.push([]); continue; }
        args[args.length - 1]!.push(t);
      }
      out.push({ routine: r.name, args });
    }
  }
  return out;
}

const ISS = readFileSync(ISS_PATH, 'utf8');
const CODE = ISS.slice(ISS.indexOf('\n[Code]') + 1);
const TOKS = tokenizePascal(CODE);
const ROUTINES = routinesOf(TOKS);

function routine(name: string): Routine {
  const r = ROUTINES.get(name.toLowerCase());
  if (!r) throw new Error(`sukarfleet.iss has no routine named ${name}`);
  return r;
}

// Everything that holds an answer from the wizard or from Setup's command line. SecretFilePath is
// on the list because it is the operator's own /MESHSECRETFILE path when one was given.
const FIELD_SOURCES = [
  'ParamValue', 'ParamStr', 'ParamCount', 'Pick', 'GetMachineName', 'GetMeshIp', 'GetPeers', 'GetRole',
  'GetSharedRoot', 'NamedSecretFile', 'SecretFilePath', 'PageIdentity', 'PageRole', 'PageSecret',
  'PageShared', 'PageAdopt', 'WizardForm', 'GetPreviousData',
].map((s) => s.toLowerCase());

/** The field sources a routine can reach, through every routine it calls. */
function fieldSourcesReachedFrom(name: string, seen = new Set<string>()): string[] {
  const key = name.toLowerCase();
  if (seen.has(key)) return [];
  seen.add(key);
  const found: string[] = [];
  for (const t of routine(name).body) {
    if (t.k === 'str' && /\{(param|code|reg):/i.test(t.v)) found.push(`${name}: '${t.v}'`);
    if (t.k !== 'id') continue;
    const id = t.v.toLowerCase();
    if (FIELD_SOURCES.includes(id)) found.push(`${name} -> ${t.v}`);
    else if (ROUTINES.has(id)) found.push(...fieldSourcesReachedFrom(t.v, seen));
  }
  return found;
}

describe('(a) sukarfleet.iss puts no answer on a command line', () => {
  test('cmd.exe is not used anywhere, in [Code] or in any section', () => {
    for (const t of TOKS) {
      if (t.k !== 'str') continue;
      expect(t.v.toLowerCase()).not.toContain('{cmd}');
      expect(t.v.toLowerCase()).not.toContain('cmd.exe');
    }
    const sectionLines = ISS.slice(0, ISS.indexOf('\n[Code]')).split('\n').filter((l) => !l.trimStart().startsWith(';'));
    for (const line of sectionLines) {
      expect(line.toLowerCase()).not.toContain('{cmd}');
      expect(line.toLowerCase()).not.toContain('cmd.exe');
    }
  });

  test('every Exec is one of three, and none of them is handed a string built from an answer', () => {
    const sites = callsOf(ROUTINES, 'Exec').map((c) => `${c.routine}: ${show(c.args[0]!)} | ${show(c.args[1]!)}`);
    expect(sites.sort()).toEqual([
      'EnsureStagingDir: IcaclsExe ( ) | StagingAclArgs ( Dir )',
      'RunPowerShell: PowerShellExe ( ) | PowerShellArgs ( ScriptPath , SettingsPath )',
      "ScheduledTaskExists: 'schtasks.exe' | '/Query /TN sukarfleet'",
    ]);
  });

  test('the PowerShell command line is fixed switches plus the script and the settings file', () => {
    const allowed = new Set(['result', ':=', '+', ';', 'quotearg', '(', ')', 'scriptpath', 'settingspath']);
    const body = routine('PowerShellArgs').body;
    for (const t of body) {
      if (t.k === 'str') continue;
      expect(allowed.has(t.v.toLowerCase())).toBe(true);
    }
    const text = body.filter((t) => t.k === 'str').map((t) => t.v).join('');
    expect(text).toContain('-File ');
    expect(text).toContain(' -SettingsFile ');
    expect(text).toContain('-NonInteractive');
    expect(show(routine('PowerShellExe').body)).toBe("Result := ExpandConstant ( '{sys}\\WindowsPowerShell\\v1.0\\powershell.exe' ) ;");
    // RunPowerShell is the one thing that builds that command line.
    expect(callsOf(ROUTINES, 'PowerShellArgs').map((c) => c.routine)).toEqual(['RunPowerShell']);
  });

  test('the icacls command line is fixed apart from the directory the installer created', () => {
    const allowed = new Set(['result', ':=', '+', ';', 'quotearg', '(', ')', 'dir', 'if', 'not', 'isadmininstallmode', 'then']);
    for (const t of routine('StagingAclArgs').body) {
      if (t.k === 'str') continue;
      expect(allowed.has(t.v.toLowerCase())).toBe(true);
    }
    const text = routine('StagingAclArgs').body.filter((t) => t.k === 'str').map((t) => t.v).join(' ');
    expect(text).toContain('/inheritance:r');
    expect(text).toContain('*S-1-5-18:(OI)(CI)(F)');
    expect(text).toContain('*S-1-5-32-544:(OI)(CI)(F)');
  });

  test('scripts are started by fixed path, with a settings file the installer wrote and named', () => {
    const calls = callsOf(ROUTINES, 'RunPowerShell');
    expect(calls.length).toBe(3);
    for (const c of calls) {
      expect(['MachineScript ( )', 'UserScript ( )', 'PreflightScript ( )']).toContain(show(c.args[0]!));
      // The settings path is a local assigned only from WriteStagedFile with a literal file name.
      expect(c.args[1]!.length).toBe(1);
      const local = c.args[1]![0]!.v;
      const body = routine(c.routine).body;
      const assignments: string[] = [];
      for (let i = 0; i < body.length; i++) {
        if (isId(body[i], local) && body[i + 1]?.v === ':=') {
          const rhs: Tok[] = [];
          for (let j = i + 2; j < body.length && body[j]!.v !== ';'; j++) rhs.push(body[j]!);
          assignments.push(show(rhs));
        }
      }
      const fromWrite = assignments.filter((a) => /^WriteStagedFile \( '[a-z-]+\.json' , \w+ \)$/.test(a));
      expect(fromWrite.length).toBeGreaterThan(0);
      for (const a of assignments) expect(a === "''" || fromWrite.includes(a)).toBe(true);
    }
    expect(show(routine('MachineScript').body)).toBe("Result := ExpandConstant ( '{app}\\install\\windows\\Install-MachineNode.ps1' ) ;");
    expect(show(routine('UserScript').body)).toBe("Result := ExpandConstant ( '{app}\\install\\windows\\Install-Sukarfleet.ps1' ) ;");
    expect(show(routine('PreflightScript').body)).toBe("Result := ExpandConstant ( '{tmp}\\Install-MachineNode.ps1' ) ;");
  });

  test('nothing that builds a command line or a path on one can reach a wizard or command-line answer', () => {
    for (const name of ['PowerShellExe', 'IcaclsExe', 'MachineScript', 'UserScript', 'PreflightScript', 'QuoteArg',
      'PowerShellArgs', 'RunPowerShell', 'StagingParent', 'StagingAclArgs', 'EnsureStagingDir', 'WriteStagedFile']) {
      expect({ name, reached: fieldSourcesReachedFrom(name) }).toEqual({ name, reached: [] });
    }
    // WriteStagedFile's path is the restricted directory plus the literal name it was handed.
    expect(show(routine('WriteStagedFile').body)).toContain("Path := StagingDir + '\\' + Leaf ;");
    expect(show(routine('WriteStagedFile').body)).toContain('Result := Path ;');
  });

  test('the answers go into JSON through one escaping function', () => {
    const esc = show(routine('EscapeJson').body);
    // Quote, backslash, everything below space and everything above tilde.
    for (const n of ['34', '92', '32', '126']) expect(esc).toContain(n);
    expect(esc).toContain("'\\u'");
    expect(show(routine('JsonString').body)).toBe("Result := '\"' + EscapeJson ( S ) + '\"' ;");
    // A bare double quote is written in two places only: JsonString, and QuoteArg for the two
    // installer-built paths on the PowerShell command line.
    const quoting = [...ROUTINES.values()].filter((r) => r.body.some((t) => t.k === 'str' && t.v === '"')).map((r) => r.name);
    expect(quoting.sort()).toEqual(['JsonString', 'QuoteArg']);
  });

  test('the secret is written only after its directory is restricted, and a failed restriction stops the install', () => {
    const ensure = show(routine('EnsureStagingDir').body);
    expect(ensure).toContain('DelTree ( Dir , True , True , True )');
    expect(ensure.indexOf('Exec (')).toBeLessThan(ensure.indexOf('StagingDir := Dir'));
    const write = show(routine('WriteStagedFile').body);
    expect(write.indexOf('EnsureStagingDir ( )')).toBeLessThan(write.indexOf('SaveStringToFile'));
    expect(write).toContain('IsReparsePoint ( Path )');
    const stage = show(routine('StageMeshSecret').body);
    expect(stage).toContain("WriteStagedFile ( 'mesh-secret'");
    expect(stage).toContain('RaiseException');
    expect(stage).not.toContain('icacls');
    // The old staging wrote first, ran icacls after and only logged a failure.
    expect(ISS).not.toContain('the file keeps the inherited ACL');
  });

  test('[Run] and [UninstallRun] command lines carry no answers', () => {
    const lines = ISS.slice(0, ISS.indexOf('\n[Code]')).split('\n');
    let section = '';
    for (const line of lines) {
      const m = /^\[(\w+)\]/.exec(line);
      if (m) { section = m[1]!; continue; }
      if (!['Run', 'UninstallRun'].includes(section) || line.trimStart().startsWith(';') || !line.trim()) continue;
      const params = /Parameters:\s*"((?:[^"]|"")*)"/.exec(line)?.[1] ?? '';
      expect(params).not.toMatch(/\{(code|param|reg):/i);
    }
  });
});

// ---------------------------------------------------------------------------
// (b) The scripts read what the installer writes
// ---------------------------------------------------------------------------

const MACHINE_TEXT = readFileSync(MACHINE_PS1, 'utf8');
const USER_TEXT = readFileSync(USER_PS1, 'utf8');

function schemaOf(text: string): Map<string, string> {
  const m = /\$SettingsSchema = @\{\r?\n([\s\S]*?)\r?\n\}/.exec(text);
  if (!m) throw new Error('no $SettingsSchema');
  return new Map([...m[1]!.matchAll(/^\s*(\w+)\s*=\s*'([^']+)'/gm)].map((x) => [x[1]!, x[2]!]));
}

/** Keys an .iss routine writes, with the kind the JSON gives them. */
function keysWrittenBy(name: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const [fn, kind] of [['AddJsonString', 'string'], ['AddJsonBool', 'bool']] as const) {
    for (const c of callsOf(new Map([[name.toLowerCase(), routine(name)]]), fn)) {
      const key = c.args[1]!;
      expect(key.length).toBe(1);
      expect(key[0]!.k).toBe('str');
      out.set(key[0]!.v, kind);
    }
  }
  return out;
}

function sharedSection(text: string): string {
  const start = text.indexOf('# Answers read from a settings file');
  const end = text.indexOf('# End of the section kept identical in both install scripts.');
  expect(start).toBeGreaterThan(0);
  expect(end).toBeGreaterThan(start);
  return text.slice(start, end);
}

describe('(b) the install scripts take their answers from -SettingsFile', () => {
  test('both declare -SettingsFile and import it before anything else uses an answer', () => {
    for (const text of [MACHINE_TEXT, USER_TEXT]) {
      expect(text).toMatch(/\[string\] \$SettingsFile = ''/);
      expect(text).toContain('Import-InstallerSettings -Path $SettingsFile -Schema $SettingsSchema -BoundCount $PSBoundParameters.Count');
      expect(text).toContain('function Assert-InstallInput');
    }
    // Machine-wide: before the paths are derived from the answers. Per-user: before the peer
    // list is split and before the profile paths are worked out.
    expect(MACHINE_TEXT.indexOf('Import-InstallerSettings -Path')).toBeLessThan(MACHINE_TEXT.indexOf('$PeerList = @('));
    expect(USER_TEXT.indexOf('Import-InstallerSettings -Path')).toBeLessThan(USER_TEXT.indexOf('$PeerUri = @($PeerUri'));
    expect(USER_TEXT.indexOf('Import-InstallerSettings -Path')).toBeLessThan(USER_TEXT.indexOf('$UserHome   = $env:USERPROFILE'));
    // The checks run inside the refusals the preflight takes, and before the per-user dispatch.
    expect(MACHINE_TEXT).toMatch(/function Test-InstallRefusals \{\r?\n  param\(\[Parameter\(Mandatory\)\] \[string\] \$StageDir\)\r?\n\r?\n  Assert-InstallInput/);
    expect(USER_TEXT.indexOf('\nAssert-InstallInput\n')).toBeLessThan(USER_TEXT.indexOf('\nswitch ($Stage) {'));
  });

  test('the settings reader is the same code in both scripts', () => {
    expect(sharedSection(MACHINE_TEXT)).toBe(sharedSection(USER_TEXT));
  });

  test('every key the installer writes is one the target script reads, with the same kind', () => {
    const common = keysWrittenBy('AddNodeAnswers');
    const machineKeys = new Map([...keysWrittenBy('MachineSettings'), ...common]);
    const userKeys = new Map([...keysWrittenBy('UserSettings'), ...common]);
    const machineSchema = schemaOf(MACHINE_TEXT);
    const userSchema = schemaOf(USER_TEXT);
    for (const [schema, keys] of [[machineSchema, machineKeys], [userSchema, userKeys]] as const) {
      expect(keys.size).toBeGreaterThan(5);
      for (const [key, kind] of keys) {
        // A JSON string fits a 'string' or a 'string[]' setting; a JSON boolean fits 'bool' only.
        const accepts = kind === 'string' ? ['string', 'string[]'] : ['bool'];
        expect({ key, fits: accepts.includes(schema.get(key) ?? '') }).toEqual({ key, fits: true });
      }
    }
    for (const k of ['MachineName', 'MeshIp', 'PeerUri', 'Role', 'SharedRoot', 'MeshSecretFile', 'LogFile', 'Preflight', 'Adopt']) {
      expect(machineKeys.has(k)).toBe(true);
    }
    for (const k of ['MachineName', 'PeerUri', 'Source', 'LogFile']) expect(userKeys.has(k)).toBe(true);
  });

  test('the per-user script starts its elevated stage with a settings file, not a quoted argument list', () => {
    const m = /\$childArgs = @\(([\s\S]*?)\r?\n  \)/.exec(USER_TEXT);
    expect(m).not.toBeNull();
    const vars = new Set([...m![1]!.matchAll(/\$(\w+)/g)].map((x) => x[1]!));
    expect([...vars].sort()).toEqual(['PSCommandPath', 'childSettingsFile']);
    expect(m![1]).toContain("'-SettingsFile'");
    const settings = /\$childSettings = \[ordered\]@\{\r?\n([\s\S]*?)\r?\n  \}/.exec(USER_TEXT);
    expect(settings).not.toBeNull();
    const schema = schemaOf(USER_TEXT);
    for (const x of settings![1]!.matchAll(/^\s*(\w+)\s*=/gm)) expect(schema.has(x[1]!)).toBe(true);
    for (const x of USER_TEXT.matchAll(/\$childSettings\['(\w+)'\]/g)) expect(schema.has(x[1]!)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// (c) The real scripts, under pwsh, with hostile settings
// ---------------------------------------------------------------------------

const PWSH = Bun.which('pwsh');
const describePwsh = PWSH ? describe : describe.skip;

describePwsh('(c) hostile settings are data, and are refused without running anything', () => {
  let dir: string;
  let marker: string;

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'sukarfleet-settings-'));
    marker = join(dir, 'MARKER');
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  /** Every way a value could have been read as code, each aimed at the marker file. */
  function hostile(m: string): string[] {
    return [
      `x" & echo pwned > "${m}" & rem "`,
      `x' ; New-Item -ItemType File -Path '${m}' ; '`,
      `$(New-Item -ItemType File -Path '${m}')`,
      `\`$(New-Item -ItemType File -Path '${m}')`,
      `x | Out-File '${m}'`,
      `%COMSPEC% /c echo > ${m}`,
      `x\nNew-Item -ItemType File -Path '${m}'`,
    ];
  }

  async function pwsh(args: string[], env: Record<string, string> = {}) {
    const proc = Bun.spawn([PWSH!, '-NoProfile', '-NonInteractive', ...args], {
      env: { PATH: process.env.PATH ?? '', HOME: dir, ...env },
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const [stdout, stderr, code] = await Promise.all([
      new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited,
    ]);
    return { stdout, stderr, code };
  }

  // Loads Read-InstallerSettings and the script's own schema out of the real file and prints what
  // it read. Nothing else in the script runs.
  async function readSettings(script: string, settings: unknown) {
    const file = join(dir, `read-${crypto.randomUUID()}.json`);
    writeFileSync(file, typeof settings === 'string' ? settings : JSON.stringify(settings));
    const driver = join(dir, 'read-driver.ps1');
    writeFileSync(driver, [
      'param([string] $Script, [string] $File)',
      '$ErrorActionPreference = "Stop"',
      '$ast = [System.Management.Automation.Language.Parser]::ParseFile($Script, [ref]$null, [ref]$null)',
      '$want = @("Test-InstallerText", "Read-InstallerSettings")',
      '$fns = $ast.FindAll({ param($n) $n -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $want -contains $n.Name }, $true)',
      'foreach ($f in $fns) { . ([scriptblock]::Create($f.Extent.Text)) }',
      '$assign = $ast.Find({ param($n) $n -is [System.Management.Automation.Language.AssignmentStatementAst] -and $n.Left.Extent.Text -eq "`$SettingsSchema" }, $true)',
      '$schema = & ([scriptblock]::Create($assign.Right.Extent.Text))',
      '$r = Read-InstallerSettings -Path $File -Schema $schema',
      '[Console]::Out.Write((ConvertTo-Json -InputObject @{ values = $r.Answers; problems = @($r.Problems) } -Depth 5 -Compress))',
    ].join('\n'));
    const r = await pwsh(['-File', driver, '-Script', script, '-File', file]);
    expect(r.stderr).toBe('');
    expect(r.code).toBe(0);
    return JSON.parse(r.stdout) as { values: Record<string, unknown>; problems: string[] };
  }

  // The whole script, started the way the installer starts it, with the Windows directories it
  // derives its paths from pointed into the test directory.
  async function runScript(script: string, settings: Record<string, unknown>, extra: string[] = []) {
    const run = join(dir, crypto.randomUUID());
    for (const d of ['pf', 'pd', 'tmp', 'home', 'lad', 'ad']) mkdirSync(join(run, d), { recursive: true });
    const file = join(run, 'settings.json');
    const log = join(run, 'install.log');
    writeFileSync(file, JSON.stringify({ ...settings, LogFile: log }));
    const r = await pwsh(['-File', script, '-SettingsFile', file, ...extra], {
      ProgramFiles: join(run, 'pf'), ProgramData: join(run, 'pd'), TEMP: join(run, 'tmp'),
      USERPROFILE: join(run, 'home'), LOCALAPPDATA: join(run, 'lad'), APPDATA: join(run, 'ad'),
      COMPUTERNAME: 'probe',
    });
    const logText = existsSync(log) ? readFileSync(log, 'utf8') : '';
    return { ...r, log: logText };
  }

  test('values full of shell syntax that are legal in a path arrive exactly as written', async () => {
    const scary = `C:\\Tom & Jerry %PATH% $(whoami) \`whoami\` ; 'q' (x) {y} [z] ^ !`;
    for (const script of [MACHINE_PS1, USER_PS1]) {
      const r = await readSettings(script, { MachineName: 'alpha', MeshSecretFile: scary, SkipMesh: true });
      expect(r.problems).toEqual([]);
      expect(r.values.MeshSecretFile).toBe(scary);
      expect(r.values.MachineName).toBe('alpha');
      expect(r.values.SkipMesh).toBe(true);
    }
    expect(existsSync(marker)).toBe(false);
  }, 60_000);

  test('control characters, unknown keys, wrong types and non-objects are refused by the reader', async () => {
    let r = await readSettings(MACHINE_PS1, { MachineName: 'a\nb', PeerUri: 'tcp://x:1\r\n& calc' });
    expect(r.problems).toEqual(expect.arrayContaining(["'MachineName' holds a control character", "'PeerUri' holds a control character"]));
    r = await readSettings(MACHINE_PS1, { MachineName: 'a', Command: 'calc', SkipMesh: 'true' });
    expect(r.problems).toEqual(expect.arrayContaining(["'Command' is not a setting this script takes", "'SkipMesh' must be true or false"]));
    r = await readSettings(USER_PS1, { NodePort: '7710; calc', PeerUri: ['tcp://a:1', 7] });
    expect(r.problems).toEqual(expect.arrayContaining(["'NodePort' must be a whole number from 1 to 65535", "'PeerUri' must be a string or a list of strings, with no control characters"]));
    r = await readSettings(USER_PS1, '["MachineName"]');
    expect(r.problems.join(' ')).toContain('must hold one JSON object');
    expect(existsSync(marker)).toBe(false);
  }, 60_000);

  /** Runs the cases a few at a time: each is a fresh pwsh, and one after another is slow. */
  async function inBatches<T, R>(items: T[], size: number, fn: (item: T) => Promise<R>): Promise<R[]> {
    const out: R[] = [];
    for (let i = 0; i < items.length; i += size) out.push(...(await Promise.all(items.slice(i, i + size).map(fn))));
    return out;
  }

  test('the machine-wide preflight refuses each hostile answer, logs why, and runs none of it', async () => {
    const base = { Preflight: true, AppDir: 'C:\\Program Files\\sukarfleet\\app', SharedRoot: 'C:\\AI_Agent', MachineName: 'alpha', Role: 'roamer', MeshIp: '192.0.2.3', SkipMesh: false, SkipTray: true, NoOpen: true, Adopt: false };
    const cases: Array<{ field: string; value: string }> = [];
    for (const value of hostile(marker)) {
      for (const field of ['MachineName', 'MeshIp', 'PeerUri', 'SharedRoot', 'Role']) {
        if (field === 'SharedRoot' && !/["\n|<>*?]/.test(value)) continue; // the rest are legal path characters
        cases.push({ field, value });
      }
    }
    const results = await inBatches(cases, 6, async (c) => ({ ...c, r: await runScript(MACHINE_PS1, { ...base, [c.field]: c.value }) }));
    for (const { field, value, r } of results) {
      expect({ field, value, code: r.code }).toEqual({ field, value, code: 1 });
      expect(r.log).toContain('ERROR:');
      expect(r.log).toMatch(/refused|not a machine name|not an IPv4 address|not a peer address|does not allow in a path/);
    }
    expect(existsSync(marker)).toBe(false);
  }, 300_000);

  test('the per-user script refuses hostile answers the same way', async () => {
    const cases: Array<{ field: string; value: string }> = [];
    for (const value of hostile(marker)) {
      for (const field of ['MachineName', 'MeshIp', 'PeerUri', 'NetworkName']) cases.push({ field, value });
    }
    const results = await inBatches(cases, 6, async (c) => ({
      ...c, r: await runScript(USER_PS1, { MachineName: 'alpha', SkipMesh: true, SkipTray: true, NoOpen: true, [c.field]: c.value }),
    }));
    for (const { field, value, r } of results) {
      expect({ field, value, code: r.code }).toEqual({ field, value, code: 1 });
      expect(r.log).toContain('ERROR:');
    }
    expect(existsSync(marker)).toBe(false);
  }, 300_000);

  test('-SettingsFile is passed alone', async () => {
    const r = await runScript(MACHINE_PS1, { MachineName: 'alpha' }, ['-Adopt']);
    expect(r.code).toBe(1);
    // Refused before the file is even read, so on screen rather than in the log it names.
    expect(r.stdout).toContain('-SettingsFile carries every answer, so it is passed alone.');
  }, 60_000);
});
