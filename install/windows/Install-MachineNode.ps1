# SPDX-License-Identifier: AGPL-3.0-or-later
<#
.SYNOPSIS
  Installs sukarfleet machine-wide: one node per PC, running as a Windows service.

.DESCRIPTION
  The machine-wide half of install/windows/sukarfleet.iss. Install-Sukarfleet.ps1 installs a node
  that belongs to one account and starts when that account logs on; this installs a node that
  belongs to the machine and is answering before anyone has logged on at all.

  What that costs, stated rather than discovered later:

    - One identity per PC. A machine that already has a per-user node is refused unless you pass
      -Adopt, which moves that node's identity, config, state and repos over so the machine keeps
      its place in the fleet rather than joining it twice.

    - Every local account can operate the node. The console token is readable by BUILTIN\Users,
      because on a shared machine every account is an operator. SECURITY.md has the one icacls
      line that narrows it to a group.

    - The admin lane stays off, for the same reasons Install-Sukarfleet.ps1 states.

  This script never edits Install-Sukarfleet.ps1. It calls it, once, for the mesh transport, so
  there is one implementation of EasyTier on Windows and not two.

.NOTES
  Windows PowerShell 5.1 only: no ternary, no null-coalescing, no PS7-only syntax. The smoke
  target is a Windows 10 Pro machine with 5.1 and no pwsh at all.
#>

[CmdletBinding()]
param(
  # The sukarfleet tree the service runs from. Defaults to the checkout this script sits in.
  [string] $AppDir = '',

  # --- identity (only used when scaffolding a NEW config.json) ---
  [string] $MachineName = $env:COMPUTERNAME,
  [ValidateSet('anchor', 'roamer')]
  [string] $Role = 'roamer',
  [string] $MeshIp = '',
  [int]    $NodePort = 7710,
  [string] $NetworkName = 'sukarfleet',

  # --- mesh, handed to Install-Sukarfleet.ps1 -Stage Elevated ---
  # Comma separated, because powershell.exe -File hands a [string[]] over as one joined string
  # and a peer URI cannot contain a comma.
  [string] $PeerUri = '',
  [int]    $ListenPort = 11010,
  [string] $RpcAddr = '127.0.0.1:15888',
  [string] $MeshServiceName = 'easytier-fleet',
  # A file holding the network secret, one line. Never the secret itself: argv is readable by
  # every process on the machine.
  [string] $MeshSecretFile = '',
  # Set by the installer for the file IT staged, so that file is shredded once consumed. A file
  # you wrote and named yourself is left alone.
  [switch] $ShredSecretSource,
  [switch] $SkipMesh,

  # --- layout ---
  [string] $SharedRoot = 'C:\AI_Agent',

  # --- adoption of an existing per-user node ---
  [switch] $Adopt,
  # Whose profile to adopt from. Resolved from the scheduled task's principal when not given.
  [string] $UserProfileDir = '',

  # --- the service account ---
  # The virtual account is the intent: it exists only for this service and holds only the rights
  # granted below. LocalService is the documented fallback for a machine that refuses to grant
  # the virtual account "log on as a service".
  [string] $ServiceAccount = 'NT SERVICE\sukarfleet-node',

  # --- behaviour ---
  [switch] $SkipTray,
  [string] $TrayReleaseBase = '',
  [switch] $NoOpen
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version 2.0
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

# ---------------------------------------------------------------------------
# Output. Same shape as install/quickstart.sh's log(): a tag and elapsed seconds, so a log from
# a silent install reads the same way as one from a person watching.
# ---------------------------------------------------------------------------

$script:Started = Get-Date
$script:ServiceFallback = $false
$script:Transcribing = $false
# Repos adoption decided to leave where they are. Kept because the service account can change
# after they were granted access: the LocalService fallback in step 13 has to reach them again.
$script:KeptRepoPaths = @()

# Get-Sha256Hex is NOT defined here. It lives in install\windows\Pins.ps1, which this script
# dot-sources in step 2, well before the first hash is taken in step 7. One copy, because two
# copies of a hashing function is two places for a fix to land in only one of.

function Get-Elapsed { return [int] ((Get-Date) - $script:Started).TotalSeconds }
function Write-Step { param([string] $m) Write-Host ("[machine] {0,-6} {1}" -f "t+$(Get-Elapsed)s", $m) }
function Write-Note { param([string] $m) Write-Host ("[machine] {0,-6} {1}" -f "t+$(Get-Elapsed)s", $m) -ForegroundColor DarkGray }
function Write-Warn { param([string] $m) Write-Host ("[machine] {0,-6} WARNING: {1}" -f "t+$(Get-Elapsed)s", $m) -ForegroundColor Yellow }
function Write-Die  { param([string] $m) Write-Host ("[machine] {0,-6} ERROR: {1}" -f "t+$(Get-Elapsed)s", $m) -ForegroundColor Red; exit 1 }

# StrictMode 2.0 throws on a reference to a property an object does not have, and most of what
# this script reads is optional. Every optional read goes through here. Same function as
# Install-Sukarfleet.ps1's, deliberately: two scripts reading the same config should read it the
# same way.
function Get-Prop {
  param($Object, [Parameter(Mandatory)] [string] $Name, $Default = $null)
  if ($null -eq $Object) { return $Default }
  if ($Object -is [Collections.IDictionary]) {
    if ($Object.Contains($Name)) { return $Object[$Name] }
    return $Default
  }
  $prop = $Object.PSObject.Properties[$Name]
  if ($null -eq $prop -or $null -eq $prop.Value) { return $Default }
  return $prop.Value
}

# Windows PowerShell 5.1 turns every stderr line of a native command into an ErrorRecord once
# stderr is merged, and $ErrorActionPreference = 'Stop' makes the first one terminating. The exit
# code is the signal; stderr is just text.
function Invoke-Native {
  param([Parameter(Mandatory)] [string] $Exe, [string[]] $Arguments = @())
  $ErrorActionPreference = 'Continue'
  $output = & $Exe @Arguments 2>&1
  return [pscustomobject]@{ Output = @($output); ExitCode = $LASTEXITCODE }
}

function Test-Elevated {
  $id = [Security.Principal.WindowsIdentity]::GetCurrent()
  return (New-Object Security.Principal.WindowsPrincipal($id)).IsInRole(
    [Security.Principal.WindowsBuiltInRole]::Administrator)
}

# The safe.directory glob ends in *, and -like would read that * as a wildcard: "C:/AI_Agent/*"
# tested with -like matches "C:/AI_Agentsomethingelse/x" as happily as the real thing, so a
# neighbouring entry in someone's gitconfig could answer "already marked safe" for a path that is
# not. These checks always meant a literal substring, case-insensitively because Windows paths are.
function Test-ContainsText {
  param([Parameter(Mandatory)] [AllowEmptyString()] [string] $Haystack,
        [Parameter(Mandatory)] [string] $Needle)
  if (-not $Haystack) { return $false }
  return ($Haystack.IndexOf($Needle, [StringComparison]::OrdinalIgnoreCase) -ge 0)
}

# Set-Content -Encoding UTF8 writes a byte order mark on 5.1, and a BOM in front of a JSON
# config or a gitconfig is a parse error somewhere downstream. Everything this script writes
# goes through here.
function Write-Utf8File {
  param([Parameter(Mandatory)] [string] $Path,
        [Parameter(Mandatory)] [AllowEmptyString()] [string] $Content)
  $dir = Split-Path -Parent $Path
  if ($dir -and -not (Test-Path -LiteralPath $dir)) { [void] (New-Item -ItemType Directory -Force -Path $dir) }
  $utf8 = New-Object Text.UTF8Encoding($false)
  [IO.File]::WriteAllText($Path, $Content, $utf8)
}

function Invoke-Icacls {
  param([Parameter(Mandatory)] [string[]] $Arguments, [Parameter(Mandatory)] [string] $What)
  $r = Invoke-Native -Exe 'icacls.exe' -Arguments $Arguments
  if ($r.ExitCode -ne 0) {
    Write-Host ($r.Output | Out-String)
    Write-Die "icacls exited $($r.ExitCode) while $What. The output above says why. Nothing further was changed."
  }
}

# icacls looks every SID up before it writes it, and the virtual account's SID has no name until
# the service exists, which is after the directories it needs are made. Seen on a real machine:
# "No mapping between account names and security IDs was done", exit 1332. An access rule built
# from the raw SID goes into the DACL as bytes, so the grant works before the service is born.
# Only the DACL section is read and written; the owner is icacls' business elsewhere.
function Grant-SidAccess {
  param(
    [Parameter(Mandatory)] [string] $Path,
    [Parameter(Mandatory)] [string] $Sid,
    [Parameter(Mandatory)] [string] $Rights,
    [switch] $Inherit,
    [switch] $Soft,
    [Parameter(Mandatory)] [string] $What
  )
  try {
    $item = Get-Item -LiteralPath $Path -Force
    $sec = $item.GetAccessControl([Security.AccessControl.AccessControlSections]::Access)
    $id = New-Object Security.Principal.SecurityIdentifier($Sid)
    $flags = [Security.AccessControl.InheritanceFlags]::None
    if ($Inherit) { $flags = [Security.AccessControl.InheritanceFlags]'ContainerInherit, ObjectInherit' }
    $rule = New-Object Security.AccessControl.FileSystemAccessRule(
      $id, [Security.AccessControl.FileSystemRights] $Rights, $flags,
      [Security.AccessControl.PropagationFlags]::None, [Security.AccessControl.AccessControlType]::Allow)
    [void] $sec.AddAccessRule($rule)
    $item.SetAccessControl($sec)
  } catch {
    if ($Soft) { Write-Warn "could not grant $Rights on $Path to $Sid while $What : $($_.Exception.Message)"; return $false }
    Write-Die "could not grant $Rights on $Path to $Sid while $What : $($_.Exception.Message). Nothing further was changed."
  }
  return $true
}

# A Windows account name is not an SSH account name; src/pairing.ts validates the LOCAL bundle's
# sshUser against ^[a-z_][a-z0-9_-]{0,31}$ too. Same fold as Install-Sukarfleet.ps1's.
function ConvertTo-SshUserName {
  param([string] $Name)
  $s = ($Name -replace '[^A-Za-z0-9_-]', '-').ToLowerInvariant()
  if ($s -notmatch '^[a-z_]') { $s = 'u' + $s }
  if ($s.Length -gt 32) { $s = $s.Substring(0, 32) }
  if (-not $s) { $s = 'fleet' }
  return $s
}

function Remove-SecretFile {
  param([Parameter(Mandatory)] [string] $Path)
  if (-not (Test-Path -LiteralPath $Path)) { return }
  try {
    $len = (Get-Item -LiteralPath $Path).Length
    if ($len -gt 0) { [IO.File]::WriteAllBytes($Path, (New-Object byte[] $len)) }
  } catch { }
  Remove-Item -LiteralPath $Path -Force -ErrorAction SilentlyContinue
}

# ---------------------------------------------------------------------------
# Paths. Every one of them is machine-wide: nothing this script writes lives in a profile,
# because a profile is not mounted when the service starts at boot.
# ---------------------------------------------------------------------------

$ServiceId    = 'sukarfleet-node'
$TaskName     = 'sukarfleet'

$ProgramRoot  = Join-Path $env:ProgramFiles 'sukarfleet'
$BunDir       = Join-Path $ProgramRoot 'bun'
$BunExe       = Join-Path $BunDir 'bun.exe'
$WinSwExe     = Join-Path $ProgramRoot 'sukarfleet-node.exe'
$WinSwXml     = Join-Path $ProgramRoot 'sukarfleet-node.xml'
$TrayExe      = Join-Path $ProgramRoot 'sukarfleet-tray.exe'

$NodeDir      = Join-Path $env:ProgramData 'sukarfleet\node'
$StateDir     = Join-Path $NodeDir 'state'
$SecretsDir   = Join-Path $NodeDir 'secrets'
$LogDir       = Join-Path $NodeDir 'logs'
$TmpDir       = Join-Path $NodeDir 'tmp'
$NoHooksDir   = Join-Path $NodeDir 'no-hooks'
$ConfigFile   = Join-Path $NodeDir 'config.json'
$TokenFile    = Join-Path $NodeDir 'console-token'
$ServiceGitConfig = Join-Path $NodeDir 'gitconfig'
$NodeSshKey   = Join-Path $NodeDir 'id_sukarfleet_ed25519'
$NodeAuthKeys = Join-Path $NodeDir 'authorized_keys'
$NodeMachineKey = Join-Path $NodeDir 'machine-key.json'
$StagedSecret = Join-Path $StateDir 'pending-easytier-secret'
$TaskBackup   = Join-Path $NodeDir 'adopted-task-sukarfleet.xml'
# Where adoption stages the files it has to READ out of the profile rather than copy into place.
# Under the node directory, so it carries the node directory's ACL and not the profile's.
$AdoptStage   = Join-Path $TmpDir 'adopt'

$SystemGitConfig = Join-Path $env:ProgramData 'Git\config'
$HklmRunKey   = 'HKLM:\Software\Microsoft\Windows\CurrentVersion\Run'
$RunValueName = 'sukarfleet-tray'

$MeshCli      = Join-Path $env:ProgramFiles 'EasyTier\easytier-cli.exe'

# Well-known SIDs rather than names. BUILTIN\Users is "Utilisateurs" on a French Windows and
# icacls takes the local spelling, so a name here is a machine this refuses to install on.
$SidSystem    = 'S-1-5-18'
$SidAdmins    = 'S-1-5-32-544'
$SidUsers     = 'S-1-5-32-545'
$SidLocalSvc  = 'S-1-5-19'

$SafeDirectoryGlob = ($SharedRoot -replace '\\', '/') + '/*'

$PeerList = @($PeerUri -split ',' | ForEach-Object { $_.Trim() } | Where-Object { $_ })

# ---------------------------------------------------------------------------
# Source tree
# ---------------------------------------------------------------------------

function Resolve-AppDir {
  if ($AppDir) {
    if (-not (Test-Path -LiteralPath (Join-Path $AppDir 'src\node.ts'))) {
      Write-Die "-AppDir $AppDir does not look like a sukarfleet tree: there is no src\node.ts in it."
    }
    return (Resolve-Path -LiteralPath $AppDir).Path.TrimEnd('\')
  }
  $here = Split-Path -Parent $PSCommandPath
  $guess = (Resolve-Path (Join-Path $here '..\..')).Path.TrimEnd('\')
  if (Test-Path -LiteralPath (Join-Path $guess 'src\node.ts')) { return $guess }
  Write-Die 'cannot find the sukarfleet source. Pass -AppDir <dir>, or put this script back in the checkout''s install\windows folder.'
}

# ---------------------------------------------------------------------------
# Identities
# ---------------------------------------------------------------------------

# The virtual account's SID exists whether or not the service does -- Windows derives it from
# the service name -- and sc.exe will print it either way, which is the only way to get it
# before the service is registered.
function Get-ServiceAccountSid {
  param([Parameter(Mandatory)] [string] $Account)
  if ($Account -match '^(NT AUTHORITY\\)?LocalService$') { return $SidLocalSvc }
  if ($Account -match '^NT SERVICE\\(.+)$') {
    $name = $Matches[1]
    $r = Invoke-Native -Exe 'sc.exe' -Arguments @('showsid', $name)
    foreach ($line in $r.Output) {
      $s = [string] $line
      if ($s -match 'S-1-5-80-[0-9-]+') { return $Matches[0] }
    }
    Write-Die "could not work out the SID of the service account '$Account' (sc.exe showsid $name printed nothing usable). Re-run with -ServiceAccount LocalService."
  }
  try {
    return (New-Object Security.Principal.NTAccount($Account)).Translate(
      [Security.Principal.SecurityIdentifier]).Value
  } catch {
    Write-Die "'$Account' is not an account this machine knows: $($_.Exception.Message)"
  }
}

# ---------------------------------------------------------------------------
# Step 1-2: refusals
# ---------------------------------------------------------------------------

Write-Step "sukarfleet machine-wide install on $MachineName"

if (-not (Test-Elevated)) {
  Write-Die 'this installs a Windows service, writes under C:\ProgramData and C:\Program Files, and edits the system git config. It needs administrator rights. Nothing was installed.'
}

$existingTask = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
$doAdopt = [bool] $Adopt
if ($existingTask -and -not $doAdopt) {
  Write-Die "this machine already runs a per-user sukarfleet node: the scheduled task '$TaskName' is registered. One identity per PC, or the fleet sees this machine twice and the two halves fight over the same repos. Re-run with -Adopt (the installer's ""adopt the existing node"" checkbox) to move that node's identity, config, state and repos into the machine-wide install, or remove the task first if you want a fresh identity."
}
if ($doAdopt -and -not $existingTask) {
  Write-Warn "-Adopt was passed, but there is no scheduled task named '$TaskName' on this machine. There is nothing to adopt, so this carries on as a fresh machine-wide install."
  $doAdopt = $false
}

# A path that was passed is checked here whatever -SkipMesh says. The file is only READ at the
# mesh stage, minutes later, and a typo that is only noticed there is a typo noticed after the
# service account, the shared root and the system git config have all been changed.
if ($MeshSecretFile -and -not (Test-Path -LiteralPath $MeshSecretFile)) {
  Write-Die "no such file: $MeshSecretFile. That is the file that should hold the network secret, one line. Fix the path, or pass -SkipMesh if the mesh transport is already installed here. Nothing was installed."
}
if (-not $SkipMesh) {
  if (-not $MeshIp) {
    Write-Die 'no -MeshIp. The mesh stage would sit at a prompt nobody is watching. Pass this machine''s mesh address, or -SkipMesh if the mesh transport is already installed here.'
  }
  if (-not $MeshSecretFile) {
    Write-Die 'no -MeshSecretFile. The mesh stage would sit at a secret prompt nobody is watching. Pass a file holding the network secret, or -SkipMesh if the mesh transport is already installed here.'
  }
}

$AppDir = Resolve-AppDir
Write-Step "sukarfleet source at $AppDir"

$InstallSukarfleet = Join-Path $AppDir 'install\windows\Install-Sukarfleet.ps1'
$PinsFile = Join-Path $AppDir 'install\easytier-pins.txt'
$XmlTemplate = Join-Path $AppDir 'install\windows\sukarfleet-node.xml'
$PinsLib = Join-Path $AppDir 'install\windows\Pins.ps1'
foreach ($needed in @($InstallSukarfleet, $PinsFile, $XmlTemplate, $PinsLib)) {
  if (-not (Test-Path -LiteralPath $needed)) { Write-Die "$needed is missing from the source tree. Nothing was installed." }
}
. $PinsLib

$arch = ''
switch ($env:PROCESSOR_ARCHITECTURE) {
  'AMD64' { $arch = 'x86_64' }
  'ARM64' { $arch = 'arm64' }
  default { Write-Die "unsupported processor architecture '$env:PROCESSOR_ARCHITECTURE'." }
}

# One spelling, so the fallback below can tell "already LocalService" from "try LocalService".
if ($ServiceAccount -match '^(NT AUTHORITY\\)?LocalService$') { $ServiceAccount = 'NT AUTHORITY\LocalService' }
$ServiceSid = Get-ServiceAccountSid -Account $ServiceAccount

# ---------------------------------------------------------------------------
# Step 3: the node directory and its ACLs
# ---------------------------------------------------------------------------

function Set-NodeDirAcl {
  param([Parameter(Mandatory)] [string] $Sid)
  Invoke-Icacls -Arguments @($NodeDir, '/inheritance:r') -What "removing inherited access from $NodeDir"
  Invoke-Icacls -Arguments @(
    $NodeDir, '/grant:r',
    "*${SidSystem}:(OI)(CI)(F)",
    "*${SidAdmins}:(OI)(CI)(F)") -What "granting access to $NodeDir"
  [void] (Grant-SidAccess -Path $NodeDir -Sid $Sid -Rights 'Modify' -Inherit -What "granting the service account access to $NodeDir")
  Invoke-Icacls -Arguments @($NodeDir, '/setowner', "*$SidAdmins") -What "taking ownership of $NodeDir"
}

foreach ($d in @($NodeDir, $StateDir, $SecretsDir, $LogDir, $TmpDir, $NoHooksDir)) {
  if (-not (Test-Path -LiteralPath $d)) { [void] (New-Item -ItemType Directory -Force -Path $d) }
}
Set-NodeDirAcl -Sid $ServiceSid
Write-Step "node directory $NodeDir (SYSTEM and Administrators full, the service account modify, nothing inherited)"

# From here on everything is also written down. A machine-wide install is normally silent, run
# by an installer or a scheduled task, with no console anyone will ever read; without this the
# only record of why it failed is gone the moment the window closes.
$InstallLog = Join-Path $LogDir 'install.log'
try {
  [void] (Start-Transcript -LiteralPath $InstallLog -Append)
  $script:Transcribing = $true
} catch {
  $script:Transcribing = $false
  Write-Warn "could not open a transcript at $InstallLog : $($_.Exception.Message). The install carries on; its output is only on screen."
}

# ---------------------------------------------------------------------------
# Step 4: the console token
# ---------------------------------------------------------------------------

# 32 bytes from the OS CSPRNG, base64url so it survives a copy out of a terminal and a paste
# into a browser prompt, one trailing newline so `type` and `cat` both show it on its own line.
# The file is not rotated on a re-run: the tray and every operator who already pasted it would
# be locked out by an upgrade.
if (Test-Path -LiteralPath $TokenFile) {
  Write-Note "console token already at $TokenFile - left as it is, so anyone holding it keeps working"
} else {
  $bytes = New-Object byte[] 32
  $rng = New-Object Security.Cryptography.RNGCryptoServiceProvider
  try { $rng.GetBytes($bytes) } finally { $rng.Dispose() }
  $token = [Convert]::ToBase64String($bytes).Replace('+', '-').Replace('/', '_').TrimEnd('=')
  Write-Utf8File -Path $TokenFile -Content ($token + "`n")
  $token = $null
  Write-Step "wrote the console token to $TokenFile"
}
# Readable by every account on this machine, and that is the ruling, not an oversight: a
# machine-wide node is operated by whoever is sitting at the machine. SECURITY.md carries the
# one icacls line that narrows it to a group instead.
Invoke-Icacls -Arguments @($TokenFile, '/grant', "*${SidUsers}:(R)") -What "letting local accounts read $TokenFile"
Write-Note '  every local account can read that file, and so operate this node. Narrow it with the line in SECURITY.md if this machine is shared with someone who should not.'

# ---------------------------------------------------------------------------
# Step 5: git
# ---------------------------------------------------------------------------

# The service reads this one and nothing else: GIT_CONFIG_GLOBAL in the service xml points at
# it. Hooks off, because a repo that syncs in from another machine can carry them and the
# service account must not run what a peer wrote. autocrlf off, because the tree is shared with
# Linux machines. The shared root marked safe, because the tree is owned by Administrators and
# git refuses a tree it does not think is yours.
$serviceGit = @(
  '# Written by install\windows\Install-MachineNode.ps1. The sukarfleet service reads this file'
  '# and no other: GIT_CONFIG_GLOBAL in sukarfleet-node.xml points here.'
  '[core]'
  "`thooksPath = $($NoHooksDir -replace '\\', '/')"
  "`tautocrlf = false"
  "`tlongpaths = true"
  '[safe]'
  "`tdirectory = $SafeDirectoryGlob"
  '[user]'
  "`tname = sukarfleet"
  "`temail = fleet@sukarfleet.local"
  '[credential]'
  "`thelper ="
  ''
) -join "`r`n"
Write-Utf8File -Path $ServiceGitConfig -Content $serviceGit
Write-Step "wrote the service git config to $ServiceGitConfig (hooks off, autocrlf off, $SafeDirectoryGlob marked safe)"

# The system config is the one every INTERACTIVE account on this machine reads, and without it
# the second account's `git status` in the shared tree exits 128. Appended, never rewritten:
# this file is not ours, and something else may already be in it.
$gitOnPath = Get-Command git -ErrorAction SilentlyContinue
if (-not $gitOnPath) {
  Write-Die 'git is not on PATH. Install Git for Windows (winget install --id Git.Git), open a new terminal, then re-run. Nothing further was installed.'
}

$systemGitText = ''
if (Test-Path -LiteralPath $SystemGitConfig) { $systemGitText = Get-Content -LiteralPath $SystemGitConfig -Raw }
if ($null -eq $systemGitText) { $systemGitText = '' }
if (Test-ContainsText -Haystack $systemGitText -Needle $SafeDirectoryGlob) {
  Write-Note "$SystemGitConfig already marks $SafeDirectoryGlob safe"
} else {
  $addition = "[safe]`r`n`tdirectory = $SafeDirectoryGlob`r`n"
  if ($systemGitText -and -not $systemGitText.EndsWith("`n")) { $addition = "`r`n" + $addition }
  Write-Utf8File -Path $SystemGitConfig -Content ($systemGitText + $addition)
  Write-Step "marked $SafeDirectoryGlob safe in $SystemGitConfig"
}

# Exit 0 is not evidence, and neither is a file on disk: Git for Windows reads more than one
# machine-wide config and writing the wrong one fails silently until somebody's git dies in the
# shared tree. Ask git where it read the value from, and believe only an answer that names a
# machine-wide file.
function Test-SafeDirectoryVisible {
  $scoped = Invoke-Native -Exe 'git' -Arguments @('config', '--system', '--show-origin', '--get-all', 'safe.directory')
  if (Test-ContainsText -Haystack ($scoped.Output | Out-String) -Needle $SafeDirectoryGlob) { return $true }
  # Git for Windows reads C:\ProgramData\Git\config ahead of the system file and does not
  # always report it under --system. --list answers the wider question: does git read this
  # value at all, and out of which file. The origin has to be the file this script wrote, or a
  # safe.directory in the installing administrator's own global config would pass for it.
  $wanted = $SystemGitConfig -replace '\\', '/'
  $all = Invoke-Native -Exe 'git' -Arguments @('config', '--list', '--show-origin')
  foreach ($line in $all.Output) {
    $s = [string] $line
    if ((Test-ContainsText -Haystack $s -Needle "safe.directory=$SafeDirectoryGlob") -and
        (Test-ContainsText -Haystack $s -Needle $wanted)) { return $true }
  }
  return $false
}

if (-not (Test-SafeDirectoryVisible)) {
  # One more try, letting git pick its own file rather than this script picking it.
  $add = Invoke-Native -Exe 'git' -Arguments @('config', '--system', '--add', 'safe.directory', $SafeDirectoryGlob)
  if ($add.ExitCode -ne 0) { Write-Host ($add.Output | Out-String) }
}
if (-not (Test-SafeDirectoryVisible)) {
  $why = Invoke-Native -Exe 'git' -Arguments @('config', '--system', '--show-origin', '--get-all', 'safe.directory')
  Write-Host ($why.Output | Out-String)
  Write-Die "git does not read $SafeDirectoryGlob out of any machine-wide config, so every account on this machine except the service would still be refused by the shared tree. It was written to $SystemGitConfig; git's own answer is above. Add it by hand (git config --system --add safe.directory '$SafeDirectoryGlob') and re-run."
}
Write-Step "git reads safe.directory $SafeDirectoryGlob from a machine-wide config"

# ---------------------------------------------------------------------------
# Step 6: the shared root
# ---------------------------------------------------------------------------

function Set-SharedRootAcl {
  param([Parameter(Mandatory)] [string] $Sid)
  Invoke-Icacls -Arguments @($SharedRoot, '/inheritance:r') -What "removing inherited access from $SharedRoot"
  # Not CREATOR OWNER. A file an operator creates in this tree has to stay writable by the
  # daemon, or the first commit after someone edits a file by hand fails on a permission.
  Invoke-Icacls -Arguments @(
    $SharedRoot, '/grant:r',
    "*${SidAdmins}:(OI)(CI)(F)",
    "*${SidUsers}:(OI)(CI)(M)") -What "granting access to $SharedRoot"
  [void] (Grant-SidAccess -Path $SharedRoot -Sid $Sid -Rights 'Modify' -Inherit -What "granting the service account access to $SharedRoot")
  Invoke-Icacls -Arguments @($SharedRoot, '/setowner', "*$SidAdmins") -What "taking ownership of $SharedRoot"
}

if (-not (Test-Path -LiteralPath $SharedRoot)) { [void] (New-Item -ItemType Directory -Force -Path $SharedRoot) }
Set-SharedRootAcl -Sid $ServiceSid
Write-Step "shared root $SharedRoot (owned by Administrators; the service and every local account can write in it)"

# ---------------------------------------------------------------------------
# Step 7: Bun and WinSW, both against the pins
# ---------------------------------------------------------------------------

if (-not (Test-Path -LiteralPath $ProgramRoot)) { [void] (New-Item -ItemType Directory -Force -Path $ProgramRoot) }
# Read and execute, plus write-attributes. Bun opens the file it is asked to run with more than
# read access, and a principal holding only read-and-execute gets "EPERM reading src\node.ts"
# from it, seen on a real machine as both a service account and an ordinary user. Write-attributes
# is the smallest addition that satisfies it; write-data does not, and is not granted.
[void] (Grant-SidAccess -Path $ProgramRoot -Sid $ServiceSid -Rights 'ReadAndExecute, WriteAttributes' -Inherit -What "letting the service account read $ProgramRoot")

if (Test-Path -LiteralPath $BunExe) {
  Write-Note "Bun already at $BunExe - left untouched (delete that folder to force a re-fetch)"
} else {
  $bunZip = ''
  try {
    $bunZip = Get-PinnedAsset -PinsFile $PinsFile -AssetPrefix 'bun-windows-' -Arch $arch `
      -UrlFormat 'https://github.com/oven-sh/bun/releases/download/bun-v{0}/{1}' -Label 'Bun'
  } catch { Write-Die "$($_.Exception.Message)" }

  $unzip = Join-Path $env:TEMP "sukarfleet-bun-$([Guid]::NewGuid().ToString('N'))"
  try {
    Expand-Archive -LiteralPath $bunZip -DestinationPath $unzip -Force
    $found = @(Get-ChildItem -LiteralPath $unzip -Filter 'bun.exe' -Recurse -File) | Select-Object -First 1
    if (-not $found) { Write-Die 'the Bun archive unpacked to something with no bun.exe in it. Nothing further was installed.' }
    if (-not (Test-Path -LiteralPath $BunDir)) { [void] (New-Item -ItemType Directory -Force -Path $BunDir) }
    Copy-Item -LiteralPath $found.FullName -Destination $BunExe -Force
  } finally {
    Remove-Item -LiteralPath $unzip -Recurse -Force -ErrorAction SilentlyContinue
    Remove-Item -LiteralPath $bunZip -Force -ErrorAction SilentlyContinue
  }
  Write-Step "installed Bun to $BunExe"
}
$bunVersion = ''
$bunCheck = Invoke-Native -Exe $BunExe -Arguments @('--version')
if ($bunCheck.ExitCode -eq 0) { $bunVersion = (($bunCheck.Output | Out-String).Trim() -split "`n")[0] }
if ($bunVersion) { Write-Step "bun $bunVersion at $BunExe" }
else { Write-Warn "bun.exe is in place but would not report its version. The service may not start." }

# WinSW is renamed on the way in: it finds its configuration by its own filename, so the exe
# must be sukarfleet-node.exe for it to read sukarfleet-node.xml.
$winswPin = $null
try { $winswPin = Get-Pin -PinsFile $PinsFile -AssetPrefix 'WinSW-' -Arch $arch }
catch { Write-Die "$($_.Exception.Message)" }
$haveWinsw = $false
if ($winswPin -and -not $winswPin.Unfilled -and (Test-Path -LiteralPath $WinSwExe)) {
  $onDisk = (Get-Sha256Hex -Path $WinSwExe)
  if ($onDisk -eq $winswPin.Sha.ToLower()) {
    $haveWinsw = $true
    Write-Note "WinSW already at $WinSwExe and on its pin - left untouched"
  }
}
if (-not $haveWinsw) {
  $winswTmp = ''
  try {
    $winswTmp = Get-PinnedAsset -PinsFile $PinsFile -AssetPrefix 'WinSW-' -Arch $arch `
      -UrlFormat 'https://github.com/winsw/winsw/releases/download/v{0}/{1}' -Label 'WinSW'
  } catch { Write-Die "$($_.Exception.Message)" }
  # A running service holds its own image open, so it has to stop before it can be replaced.
  $svcNow = Get-Service -Name $ServiceId -ErrorAction SilentlyContinue
  if ($svcNow -and $svcNow.Status -ne 'Stopped') {
    Stop-Service -Name $ServiceId -Force -ErrorAction SilentlyContinue
    Start-Sleep -Seconds 2
  }
  Move-Item -LiteralPath $winswTmp -Destination $WinSwExe -Force
  # A file moved within a volume keeps the ACL of the directory it came from, so a binary that
  # arrived from a temp directory carries none of the entries Program Files would have given it
  # and the service controller answers "Access is denied" when it tries to start it. Seen on a
  # fresh hosted runner; a second run on a real machine had already re-propagated the grant and
  # hid it. A reset makes the file inherit from where it now lives.
  Invoke-Icacls -Arguments @($WinSwExe, '/reset', '/Q') -What "resetting the ACL on $WinSwExe"
  Write-Step "installed WinSW as $WinSwExe (SHA256 pinned)"
}

# ---------------------------------------------------------------------------
# Step 8: the service definition
# ---------------------------------------------------------------------------

# Every value substituted into the service xml is a path or an account name this script did not
# choose: -AppDir comes off a command line, ProgramFiles and ProgramData follow the machine's
# locale and its administrator's taste, and & < > " are all legal in a Windows path. Unescaped,
# one of them turns a working service definition into a file WinSW cannot parse, and the failure
# arrives as a service that will not start rather than as anything naming the character.
function ConvertTo-XmlText {
  param([Parameter(Mandatory)] [AllowEmptyString()] [string] $Value)
  if (-not $Value) { return '' }
  return [System.Security.SecurityElement]::Escape($Value)
}

function Write-NodeServiceXml {
  param([Parameter(Mandatory)] [string] $Account)
  $xml = Get-Content -LiteralPath $XmlTemplate -Raw
  # A dependency on a service that does not exist is not a soft edge: Windows refuses to start
  # the dependent service at all. On a machine installed with -SkipMesh there is no
  # easytier-fleet, so the element goes away rather than wedging the node.
  $depend = ''
  if (Get-Service -Name $MeshServiceName -ErrorAction SilentlyContinue) {
    $depend = "<depend>$(ConvertTo-XmlText -Value $MeshServiceName)</depend>"
  }
  $xml = $xml.Replace('__BUN_EXE__', (ConvertTo-XmlText -Value $BunExe))
  $xml = $xml.Replace('__APP_DIR__', (ConvertTo-XmlText -Value $AppDir))
  $xml = $xml.Replace('__SERVICE_ACCOUNT__', (ConvertTo-XmlText -Value $Account))
  $xml = $xml.Replace('__NODE_DIR__', (ConvertTo-XmlText -Value $NodeDir))
  $xml = $xml.Replace('__LOG_DIR__', (ConvertTo-XmlText -Value $LogDir))
  # Not escaped: this one is the element built two lines up, not a value.
  $xml = $xml.Replace('__DEPEND_BLOCK__', $depend)
  Write-Utf8File -Path $WinSwXml -Content $xml
  if ($depend) { Write-Note "  the service will wait for '$MeshServiceName' at boot" }
  else { Write-Note "  no '$MeshServiceName' service on this machine, so the node declares no dependency" }
}

# ---------------------------------------------------------------------------
# Step 9: dependencies
# ---------------------------------------------------------------------------

# package.json carries devDependencies only, so this is parity with the Linux install rather
# than something the node needs to boot. A machine installing offline should still get a node.
$savedTemp = $env:TEMP
$savedTmp = $env:TMP
Push-Location $AppDir
try {
  # The same temp directory the service will use, so a bun that works here works there too.
  $env:TEMP = $TmpDir
  $env:TMP = $TmpDir
  $install = Invoke-Native -Exe $BunExe -Arguments @('install')
  if ($install.ExitCode -eq 0) { Write-Step 'bun install' }
  else { Write-Warn "bun install exited $($install.ExitCode). The node runs from source and needs no runtime dependency, so this is not fatal; the dev tooling in this tree will not work until it succeeds." }
} finally {
  Pop-Location
  $env:TEMP = $savedTemp
  $env:TMP = $savedTmp
}

# ---------------------------------------------------------------------------
# Step 10: identity -- adopt the per-user node, or scaffold a fresh config
# ---------------------------------------------------------------------------

function Test-ConfigRoundTrip {
  param([Parameter(Mandatory)] [string] $OriginalJson, [Parameter(Mandatory)] [string] $NewJson)
  try {
    $before = $OriginalJson | ConvertFrom-Json
    $after = $NewJson | ConvertFrom-Json
  } catch {
    Write-Warn "the rewritten config does not parse: $($_.Exception.Message)"
    return $false
  }
  foreach ($k in $before.PSObject.Properties.Name) {
    if ($after.PSObject.Properties.Name -notcontains $k) { Write-Warn "the rewrite lost the top-level key '$k'"; return $false }
  }
  foreach ($k in @('peers', 'repos', 'unionPaths')) {
    $b = @(Get-Prop -Object $before -Name $k -Default @()).Count
    $a = @(Get-Prop -Object $after -Name $k -Default @()).Count
    if ($a -ne $b) { Write-Warn "the rewrite changed $k from $b entries to $a"; return $false }
  }
  return $true
}

function Set-MachineConfigPaths {
  param([Parameter(Mandatory)] $Cfg)
  if (-not (Get-Prop -Object $Cfg -Name 'admin')) {
    $Cfg | Add-Member -NotePropertyName admin -NotePropertyValue ([pscustomobject]@{}) -Force
  }
  $Cfg.admin | Add-Member -NotePropertyName keyPath -NotePropertyValue $NodeSshKey -Force
  $Cfg.admin | Add-Member -NotePropertyName knownHostsPath -NotePropertyValue (Join-Path $StateDir 'known_hosts') -Force
  $Cfg.admin | Add-Member -NotePropertyName authorizedKeysPath -NotePropertyValue $NodeAuthKeys -Force
  $Cfg.admin | Add-Member -NotePropertyName secretsDir -NotePropertyValue $SecretsDir -Force
  $Cfg.admin | Add-Member -NotePropertyName consoleTokenFile -NotePropertyValue $TokenFile -Force
  $Cfg.admin | Add-Member -NotePropertyName enabled -NotePropertyValue $false -Force
  if (-not (Get-Prop -Object $Cfg -Name 'notifications')) {
    $Cfg | Add-Member -NotePropertyName notifications -NotePropertyValue ([pscustomobject]@{}) -Force
  }
  # Session 0 has no desktop. A notification nobody can see is a notification that fails.
  $Cfg.notifications | Add-Member -NotePropertyName os -NotePropertyValue $false -Force
}

function Resolve-AdoptProfile {
  param($Task)
  if ($UserProfileDir) { return $UserProfileDir.TrimEnd('\') }
  $uid = ''
  if ($Task) { $uid = [string] (Get-Prop -Object $Task.Principal -Name 'UserId' -Default '') }
  if (-not $uid) {
    Write-Die "the '$TaskName' task does not say which account it runs as, so there is no profile to adopt from. Re-run with -UserProfileDir pointing at that account's profile folder."
  }
  $sid = ''
  if ($uid -match '^S-1-') { $sid = $uid }
  else {
    try { $sid = (New-Object Security.Principal.NTAccount($uid)).Translate([Security.Principal.SecurityIdentifier]).Value }
    catch { Write-Die "could not resolve '$uid', the account behind the '$TaskName' task, into a SID: $($_.Exception.Message). Re-run with -UserProfileDir." }
  }
  $profileKey = "HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion\ProfileList\$sid"
  $img = [string] (Get-Prop -Object (Get-ItemProperty -LiteralPath $profileKey -ErrorAction SilentlyContinue) -Name 'ProfileImagePath' -Default '')
  if (-not $img) {
    Write-Die "Windows has no profile folder recorded for $uid ($sid), so there is nothing to adopt. Re-run with -UserProfileDir."
  }
  return ([Environment]::ExpandEnvironmentVariables($img)).TrimEnd('\')
}

# Every read of the adopted profile goes through this function or Copy-FileBackup, and both run
# robocopy in backup mode (/B). That is not a precaution: a per-user config directory is ACL'd to
# its owner's SID alone, so an administrator reading it plainly is refused, and robocopy without
# /B walks away having copied a subdirectory and nothing else. /B turns on the backup privilege
# an administrator already holds, which is exactly the case it exists for.
#
# There is no Test-Path guard for the same reason: Test-Path answers "no" to a refused read, so a
# directory that is there would be reported as one that is not. robocopy's exit code answers
# instead -- 16 is "no such source directory", which is a normal profile without that directory,
# and 8 to 15 is a real failure.
#
# /COPY:DAT leaves the S flag out on purpose: the copy takes the destination's ACL by
# inheritance rather than carrying the profile owner's over.
function Copy-Tree {
  param([Parameter(Mandatory)] [string] $From, [Parameter(Mandatory)] [string] $To, [string[]] $ExcludeFiles = @())
  # Not $args: that is an automatic variable and writing to it is a trap waiting for the next
  # person to add a parameter to this function.
  $rcArgs = @($From, $To, '/E', '/B', '/COPY:DAT', '/R:1', '/W:1', '/NFL', '/NDL', '/NJH', '/NJS', '/NP')
  if ($ExcludeFiles.Count -gt 0) { $rcArgs += @('/XF') + $ExcludeFiles }
  $r = Invoke-Native -Exe 'robocopy.exe' -Arguments $rcArgs
  if ($r.ExitCode -ge 16) { return $false }
  if ($r.ExitCode -ge 8) {
    Write-Host ($r.Output | Out-String)
    Write-Die "robocopy failed (exit $($r.ExitCode)) copying $From to $To."
  }
  return $true
}

# One file out of a directory this administrator may not be able to read plainly. Same backup
# mode and the same reasoning as Copy-Tree. robocopy cannot rename, so the file keeps its name
# and the caller chooses the directory it lands in. The answer is a Test-Path against the
# DESTINATION, which is a question that can be asked honestly, because the destination is ours.
function Copy-FileBackup {
  param([Parameter(Mandatory)] [string] $From, [Parameter(Mandatory)] [string] $ToDir)
  $dir = Split-Path -Parent $From
  $leaf = Split-Path -Leaf $From
  if (-not (Test-Path -LiteralPath $ToDir)) { [void] (New-Item -ItemType Directory -Force -Path $ToDir) }
  $r = Invoke-Native -Exe 'robocopy.exe' -Arguments @(
    $dir, $ToDir, $leaf, '/B', '/COPY:DAT', '/R:1', '/W:1', '/NFL', '/NDL', '/NJH', '/NJS', '/NP')
  if ($r.ExitCode -ge 8 -and $r.ExitCode -lt 16) {
    Write-Host ($r.Output | Out-String)
    Write-Die "robocopy failed (exit $($r.ExitCode)) copying $From into $ToDir."
  }
  return (Test-Path -LiteralPath (Join-Path $ToDir $leaf))
}

# Appends one safe.directory line to a git config unless that exact line is already in it. A
# repeated [safe] section is legal git config, and rewriting either of these two files is not an
# option: neither of them is entirely ours.
function Add-SafeDirectory {
  param([Parameter(Mandatory)] [string] $ConfigPath, [Parameter(Mandatory)] [string] $GitPath)
  $text = ''
  if (Test-Path -LiteralPath $ConfigPath) { $text = Get-Content -LiteralPath $ConfigPath -Raw }
  if ($null -eq $text) { $text = '' }
  foreach ($line in @($text -split "`r?`n")) {
    if ($line.Trim() -eq "directory = $GitPath") { return $false }
  }
  $addition = "[safe]`r`n`tdirectory = $GitPath`r`n"
  if ($text -and -not $text.EndsWith("`n")) { $addition = "`r`n" + $addition }
  Write-Utf8File -Path $ConfigPath -Content ($text + $addition)
  return $true
}

# What adoption does with one repo, and the sentence that says why.
#
#   Move   the repo sits directly under the profile root, or under a subdirectory of it that is
#          not a dot-directory. A service account has no profile to reach into, so the repo goes
#          to the shared root and a junction stays where it was.
#   Keep   any part of the path under the profile is a dot-directory, or the repo is not under
#          that profile at all. A dot-directory belongs to the tool that made it -- an agent's
#          memory store, a dotfile source tree -- and that tool looks for it there and nowhere
#          else, so moving it would break the tool to tidy a path. It stays, and is made
#          reachable where it is instead.
#
# Grant is false only for a repo already under the shared root: steps 5 and 6 gave that tree the
# service account's ACE and its safe.directory entry already.
function Get-RepoAdoptionPlan {
  param([Parameter(Mandatory)] [string] $RepoPath, [Parameter(Mandatory)] [string] $ProfileDir)
  $full = $RepoPath.TrimEnd('\')
  $root = $ProfileDir.TrimEnd('\')
  $shared = $SharedRoot.TrimEnd('\')
  $cmp = [StringComparison]::OrdinalIgnoreCase
  if ($full.Equals($shared, $cmp) -or $full.StartsWith($shared + '\', $cmp)) {
    return @{ Move = $false; Grant = $false; Why = 'it is already under the shared root' }
  }
  if (-not $full.StartsWith($root + '\', $cmp)) {
    return @{ Move = $false; Grant = $true; Why = 'it is outside the profile being adopted' }
  }
  foreach ($seg in @($full.Substring($root.Length + 1) -split '\\')) {
    if ($seg.StartsWith('.')) {
      return @{ Move = $false; Grant = $true; Why = "it sits under '$seg', which belongs to one account rather than to this machine" }
    }
  }
  return @{ Move = $true; Grant = $false; Why = 'a service has no profile to reach into' }
}

# Resets the ACLs under a tree that has just been renamed into the shared root, so that what is
# in it inherits the shared root's access rather than keeping the profile owner's.
#
# NOT `icacls <root> /reset /T`. icacls walks reparse points: a symlink or a junction inside a
# repository points somewhere else on this machine, and /T follows it and resets whatever it
# finds on the other side. These trees are known to contain links -- robocopy refused them by
# name during adoption ("untrusted mount point") -- so the tree is walked here instead, a
# reparse point is counted and stepped over rather than entered, and every real item is reset on
# its own. The root is reset first, without /T, because that is what makes anything created
# under it later inherit from the shared root.
#
# One icacls per item is slower than one icacls per tree. That is the price of not resetting a
# directory that was never part of this install, and the count below is printed so a long pause
# reads as work rather than as a hang.
function Reset-MovedTreeAcl {
  param([Parameter(Mandatory)] [string] $Root)
  Invoke-Icacls -Arguments @($Root, '/reset', '/Q') -What "resetting the ACL on $Root"
  $reset = 0
  $skipped = 0
  $stack = New-Object System.Collections.Stack
  $stack.Push($Root)
  while ($stack.Count -gt 0) {
    $dir = [string] $stack.Pop()
    $children = @()
    try { $children = @(Get-ChildItem -LiteralPath $dir -Force -ErrorAction Stop) }
    catch {
      Write-Warn "could not list $dir while resetting ACLs: $($_.Exception.Message). What is in it keeps the access it had."
      continue
    }
    foreach ($child in $children) {
      if (($child.Attributes -band [IO.FileAttributes]::ReparsePoint) -eq [IO.FileAttributes]::ReparsePoint) {
        $skipped++
        continue
      }
      $r = Invoke-Native -Exe 'icacls.exe' -Arguments @($child.FullName, '/reset', '/Q')
      if ($r.ExitCode -eq 0) { $reset++ }
      else { Write-Warn "icacls exited $($r.ExitCode) resetting $($child.FullName); it keeps the access it had." }
      if ($child.PSIsContainer) { [void] $stack.Push($child.FullName) }
      if ((($reset + $skipped) % 2000) -eq 0) { Write-Note "  reset $reset item(s) so far under $Root" }
    }
  }
  Write-Note "  reset the ACL on $reset item(s) under $Root, and skipped $skipped reparse point(s), which lead out of this tree"
}

# A repo that stays where it is has to work for two accounts: the daemon, which runs as the
# service account and reads the service gitconfig, and the person at the keyboard, who reads the
# system one. So the service account gets Modify, inherited by what is already in the tree, and
# the exact path is marked safe in both configs. Inheritance is left alone and the owner is not
# changed: the directory belongs to the profile it sits in, not to this install.
function Grant-RepoInPlace {
  param([Parameter(Mandatory)] [string] $RepoPath)
  $granted = Grant-SidAccess -Path $RepoPath -Sid $ServiceSid -Rights 'Modify' -Inherit -Soft -What "giving the service account write access to $RepoPath"
  if (-not $granted) {
    Write-Warn "the node can read $RepoPath but not sync it until the service account has write access there."
  }
  # A repo under a profile sits below directories the service account cannot even pass through:
  # a profile root admits its owner, SYSTEM and Administrators, and SYSTEM only reached the repo
  # because it bypasses traverse checks. The service account does not, so every directory from
  # the profile root down to the repo gets a traverse-only entry for this folder alone, which
  # opens the path and nothing in it. Seen on a real machine as "not adopted" for exactly the two
  # repos kept in place, right after the service stopped being SYSTEM.
  $dir = Split-Path -Parent ($RepoPath.TrimEnd('\'))
  $root = [IO.Path]::GetPathRoot($RepoPath)
  while ($dir -and ($dir.Length -gt $root.Length)) {
    $rel = $dir.Substring($root.Length).Trim('\')
    if (($rel -split '\\').Count -lt 2) { break }
    [void] (Grant-SidAccess -Path $dir -Sid $ServiceSid -Rights 'Traverse' -Soft -What "letting the service account pass through $dir")
    $dir = Split-Path -Parent $dir
  }
  $gitPath = $RepoPath.TrimEnd('\') -replace '\\', '/'
  [void] (Add-SafeDirectory -ConfigPath $ServiceGitConfig -GitPath $gitPath)
  [void] (Add-SafeDirectory -ConfigPath $SystemGitConfig -GitPath $gitPath)
  Write-Note "  the service account can write there, and $gitPath is marked safe for the service and for every account on this machine"
}

function Invoke-Adoption {
  param([Parameter(Mandatory)] $Task)

  $profileDir = Resolve-AdoptProfile -Task $Task
  Write-Step "adopting the per-user node in $profileDir"

  $srcConfigDir = Join-Path $profileDir '.config\sukarfleet'
  $srcConfig    = Join-Path $srcConfigDir 'config.json'
  $srcState     = Join-Path $profileDir '.local\state\sukarfleet'
  $srcSsh       = Join-Path $profileDir '.ssh'
  # That config directory is ACL'd to its owner and to nobody else, so it is staged in backup
  # mode and read from the copy. A plain read here comes back as access denied, and a plain
  # Test-Path comes back as "no such file", which is the same answer a missing profile gives.
  if (Test-Path -LiteralPath $AdoptStage) { Remove-Item -LiteralPath $AdoptStage -Recurse -Force -ErrorAction SilentlyContinue }
  if (-not (Copy-FileBackup -From $srcConfig -ToDir $AdoptStage)) {
    Write-Die "there is no config.json at $srcConfig, so the '$TaskName' task's node cannot be adopted. Remove the task and install fresh, or pass -UserProfileDir for the right profile."
  }

  $raw = Get-Content -LiteralPath (Join-Path $AdoptStage 'config.json') -Raw
  if ([string]::IsNullOrWhiteSpace($raw)) { Write-Die "$srcConfig has no JSON in it." }
  $cfg = $null
  try { $cfg = $raw | ConvertFrom-Json }
  catch { Write-Die "could not read $srcConfig as JSON, so nothing was adopted and nothing was moved." }

  # --- the whole plan, BEFORE anything is stopped or moved -------------------
  # Every refusal that can be known from the config and the disk is taken here, in one pass, while
  # the old node is still registered and every repository is still where its owner left it. The
  # loop that moves things further down executes a plan that has already passed: a refusal raised
  # halfway through that loop would land after the scheduled task was unregistered and after some
  # repositories had already been renamed, which is the worst moment on this whole path to stop.
  $repos = @(Get-Prop -Object $cfg -Name 'repos' -Default @())
  $repoPlans = @()
  $claimedDests = @{}
  foreach ($repo in $repos) {
    $path = [string] (Get-Prop -Object $repo -Name 'path' -Default '')
    $name = [string] (Get-Prop -Object $repo -Name 'name' -Default '(unnamed)')
    if (-not $path) { continue }
    if (-not (Test-Path -LiteralPath (Join-Path $path '.git'))) {
      Write-Die "repo '$name' is listed at $path, which is not a git repository. Fix the config or remove the entry, then re-run. Nothing was stopped and nothing was moved."
    }
    # -c safe.directory=* for this one read-only command. The repo is owned by the account whose
    # node is being adopted and this script runs as an administrator, so git's dubious-ownership
    # check would refuse to answer and the refusal would look like a broken repo. An
    # administrator reading a tree it is about to move is exactly the case that check is not
    # about, and nothing is written to the repo here.
    $status = Invoke-Native -Exe 'git' -Arguments @('-c', 'safe.directory=*', '-C', $path, 'status', '--porcelain')
    if ($status.ExitCode -ne 0) {
      Write-Host ($status.Output | Out-String)
      Write-Die "git could not read the state of '$name' at $path. Nothing was stopped and nothing was moved."
    }
    $plan = Get-RepoAdoptionPlan -RepoPath $path -ProfileDir $profileDir
    $dirty = @($status.Output | ForEach-Object { ([string] $_).Trim() } | Where-Object { $_ })
    if ($dirty.Count -gt 0) {
      $show = ($dirty | Select-Object -First 10) -join "`n    "
      # The refusal covers both outcomes. A repo that stays where it is is not moved, but it is
      # handed to a daemon that will start syncing it, which is no kinder to uncommitted work.
      $what = 'this install is about to hand that directory to a daemon that syncs it'
      if ($plan.Move) { $what = 'this install would move that directory' }
      Write-Die "repo '$name' at $path has $($dirty.Count) uncommitted change(s), and $what. Commit or discard them first, then re-run. Nothing was stopped and nothing was moved.`n    $show"
    }
    $dest = ''
    if ($plan.Move) {
      $leaf = Split-Path -Leaf $path.TrimEnd('\')
      $dest = Join-Path $SharedRoot $leaf
      if ((Test-Path -LiteralPath $dest) -and @(Get-ChildItem -LiteralPath $dest -Force).Count -gt 0) {
        Write-Die "'$name' would move to $dest, and there is already something there. Move or remove it, then re-run. Nothing was stopped and nothing was moved."
      }
      $key = $dest.ToLowerInvariant()
      if ($claimedDests.ContainsKey($key)) {
        Write-Die "'$name' and '$($claimedDests[$key])' would both move to $dest, because they have the same folder name in different places. Rename one of them, or point its config entry somewhere else, then re-run. Nothing was stopped and nothing was moved."
      }
      $claimedDests[$key] = $name
      # A rename needs one volume; the move loop below uses [IO.Directory]::Move and nothing else.
      $srcRoot = [IO.Path]::GetPathRoot($path)
      $dstRoot = [IO.Path]::GetPathRoot($dest)
      if ($srcRoot -ne $dstRoot) {
        Write-Die "'$name' is on $srcRoot and the shared root is on $dstRoot. Adoption moves a repository by renaming it, which needs one volume. Pick a shared root on $srcRoot, or move the repository yourself and point the config at it, then re-run. Nothing was stopped and nothing was moved."
      }
    }
    $repoPlans += @{ Repo = $repo; Name = $name; Path = $path; Plan = $plan; Dest = $dest }
  }

  # --- the rollback copy, before the task stops existing ---------------------
  try {
    $taskXml = Export-ScheduledTask -TaskName $TaskName
    Write-Utf8File -Path $TaskBackup -Content ([string] $taskXml)
    Write-Step "exported the '$TaskName' task to $TaskBackup (re-register it with Register-ScheduledTask -Xml to undo this)"
  } catch {
    Write-Die "could not export the '$TaskName' task: $($_.Exception.Message). That export is the only way back, so nothing was changed."
  }

  # --- stop the old node ----------------------------------------------------
  try { Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue } catch { }
  Start-Sleep -Seconds 2
  Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
  Write-Step "unregistered the scheduled task '$TaskName'"
  $trayProcs = @(Get-Process -Name 'sukarfleet-tray' -ErrorAction SilentlyContinue)
  if ($trayProcs.Count -gt 0) {
    $trayProcs | Stop-Process -Force -ErrorAction SilentlyContinue
    Write-Note '  stopped the running tray; the machine-wide install starts its own at the next sign-in'
  }

  # --- identity -------------------------------------------------------------
  $srcKey = Join-Path $srcConfigDir 'machine-key.json'
  if (Copy-FileBackup -From $srcKey -ToDir (Split-Path -Parent $NodeMachineKey)) {
    Write-Step 'copied machine-key.json: this machine keeps its fleet identity and does not re-pair'
  } else {
    Write-Warn "no machine-key.json at $srcKey. The node will mint a new identity, and every peer will have to pair with this machine again."
  }
  # The sealed twin is deliberately NOT copied. DPAPI seals to the account that sealed it, and
  # the service runs as a different account, so the copy would be an undecryptable file that
  # looks like a working one. Said rather than tested for: a Test-Path in that directory answers
  # "no" whether the file is absent or the read was refused.
  Write-Note '  any DPAPI-sealed copy of that key stays behind: it is sealed to that account and the service cannot open it'

  # A profile with no secrets directory is an ordinary profile, so that one says nothing.
  [void] (Copy-Tree -From (Join-Path $srcConfigDir 'secrets') -To $SecretsDir)
  # The whole state directory: host key, known_hosts, the audit log and its siblings, the gossip
  # counters, the fleet repo. Enumerating them is how one gets forgotten. The staged mesh secret
  # is the one file that must not travel.
  if (Copy-Tree -From $srcState -To $StateDir -ExcludeFiles @('pending-easytier-secret')) {
    Write-Step 'copied secrets and state (host key, known hosts, audit log, gossip counters)'
  } else {
    Write-Warn "there is no state directory at $srcState. The node starts with a fresh host key and an empty audit log, and every peer that pinned the old host key will refuse it until they pair again."
  }

  foreach ($suffix in @('', '.pub')) {
    [void] (Copy-FileBackup -From ((Join-Path $srcSsh 'id_sukarfleet_ed25519') + $suffix) `
      -ToDir (Split-Path -Parent $NodeSshKey))
  }
  if (Test-Path -LiteralPath $NodeSshKey) { Write-Step 'copied the fleet SSH key' }

  # Only the lines this project wrote. A real authorized_keys carries keys for unrelated
  # services, and none of those belong to a service account.
  $srcAuth = Join-Path $srcSsh 'authorized_keys'
  if (Copy-FileBackup -From $srcAuth -ToDir $AdoptStage) {
    $marked = @(Get-Content -LiteralPath (Join-Path $AdoptStage 'authorized_keys') | Where-Object { $_ -like '*# sukarfleet:*' })
    Write-Utf8File -Path $NodeAuthKeys -Content (($marked -join "`r`n") + "`r`n")
    Write-Step "copied $($marked.Count) sukarfleet line(s) out of authorized_keys"
  } else {
    Write-Utf8File -Path $NodeAuthKeys -Content ''
  }

  # --- repos ----------------------------------------------------------------
  # Executes the plan built above and decides nothing: every refusal this could have raised was
  # raised before the task was unregistered. Two outcomes, one printed line each, and
  # Get-RepoAdoptionPlan holds the rule. What decides is where the repo sits: a working tree under
  # the profile moves into the shared root, and a repo inside a dot-directory of that profile
  # stays where the tool that owns it expects to find it.
  foreach ($entry in $repoPlans) {
    $repo = $entry.Repo
    $path = [string] $entry.Path
    $name = [string] $entry.Name
    $plan = $entry.Plan
    if (-not $plan.Move) {
      Write-Step "keeping '$name' where it is at $path : $($plan.Why)"
      if ($plan.Grant) {
        Grant-RepoInPlace -RepoPath $path
        $script:KeptRepoPaths += $path
      }
      continue
    }
    $dest = [string] $entry.Dest
    Write-Step "moving '$name' from $path to $dest : $($plan.Why)"
    # A rename, never a copy: one volume, one atomic call, links kept as links. robocopy /MOVE
    # deleted files out of the source as it copied them and then refused the tree's symlinks
    # ("the path cannot be traversed because it contains an untrusted mount point", error 448),
    # which left a real repository split across both paths. A rename either happens or does not.
    # The one-volume check is in the plan above, taken before anything was stopped.
    if (Test-Path -LiteralPath $dest) { Remove-Item -LiteralPath $dest -Force -ErrorAction SilentlyContinue }
    try { [IO.Directory]::Move($path, $dest) }
    catch { Write-Die "could not move '$name' from $path to $dest : $($_.Exception.Message). Nothing was moved." }
    Reset-MovedTreeAcl -Root $dest
    # A junction at the old path, so the account that owned this tree keeps its habits: its
    # shell, its editor and its agent sessions all still find it where it used to be.
    if (-not (Test-Path -LiteralPath $path)) {
      $link = Invoke-Native -Exe 'cmd.exe' -Arguments @('/c', 'mklink', '/J', $path, $dest)
      if ($link.ExitCode -eq 0) { Write-Note "  left a junction at $path" }
      else { Write-Warn "could not leave a junction at $path : $(($link.Output | Out-String).Trim()). The repo is at $dest." }
    } else {
      Write-Warn "$path still exists after the move, so no junction was made there. The repo is at $dest."
    }
    $repo | Add-Member -NotePropertyName path -NotePropertyValue $dest -Force
  }

  # --- rewrite the config ---------------------------------------------------
  Set-MachineConfigPaths -Cfg $cfg
  $newJson = (ConvertTo-Json $cfg -Depth 12) + "`r`n"
  if (-not (Test-ConfigRoundTrip -OriginalJson $raw -NewJson $newJson)) {
    Write-Die "rewriting the adopted config would have changed more than the paths, so it was not written. $srcConfig is still there; copy it to $ConfigFile by hand and fix the admin paths yourself."
  }
  Write-Utf8File -Path $ConfigFile -Content $newJson
  Write-Step "wrote $ConfigFile from the adopted config"
  # The staging copies have been read; the originals are still in the profile.
  Remove-Item -LiteralPath $AdoptStage -Recurse -Force -ErrorAction SilentlyContinue
  Write-Note "  the old profile keeps $srcConfigDir and $srcState. Nothing was deleted from it."
}

function New-MachineConfig {
  $easytier = [ordered]@{
    rpcAddr     = $RpcAddr
    serviceName = $MeshServiceName
    cliPath     = $MeshCli
  }
  $cfg = [ordered]@{
    machine       = $MachineName
    role          = $Role
    meshIp        = $MeshIp
    nodePort      = $NodePort
    networkName   = $NetworkName
    peers         = @()
    repos         = @()
    unionPaths    = @('workspace-manifest.json', 'workspace-removals.json')
    easytier      = $easytier
    notifications = [ordered]@{ os = $false }
    admin         = [ordered]@{
      enabled            = $false
      acceptIncoming     = $false
      sshUser            = (ConvertTo-SshUserName -Name $env:USERNAME)
      uiEnabled          = $true
      keyPath            = $NodeSshKey
      knownHostsPath     = (Join-Path $StateDir 'known_hosts')
      authorizedKeysPath = $NodeAuthKeys
      secretsDir         = $SecretsDir
      consoleTokenFile   = $TokenFile
    }
  }
  Write-Utf8File -Path $ConfigFile -Content ((ConvertTo-Json $cfg -Depth 8) + "`r`n")
  foreach ($f in @($NodeAuthKeys, (Join-Path $StateDir 'known_hosts'))) {
    if (-not (Test-Path -LiteralPath $f)) { Write-Utf8File -Path $f -Content '' }
  }
  $shownIp = $MeshIp
  if (-not $shownIp) { $shownIp = '<unset>' }
  Write-Step "wrote $ConfigFile (machine=$MachineName role=$Role meshIp=$shownIp)"
  Write-Note '  peers[] is empty by design; pair from the console. repos[] is empty until you add a repo under the shared root.'
}

if ($doAdopt) {
  Invoke-Adoption -Task $existingTask
} elseif (Test-Path -LiteralPath $ConfigFile) {
  Write-Note "config exists at $ConfigFile; left untouched."
} else {
  New-MachineConfig
}

# Every run, not only an adoption: a repo the config keeps outside the shared root needs the
# service account let in, and a re-install after the account changed (the LocalService fallback,
# or an upgrade of this script) has to reach those repos again. Idempotent: an access rule that
# is already there is merged, and safe.directory lines are added once.
try {
  $cfgNow = Get-Content -LiteralPath $ConfigFile -Raw | ConvertFrom-Json
  $sharedPrefix = $SharedRoot.TrimEnd('\') + '\'
  foreach ($repo in @(Get-Prop -Object $cfgNow -Name 'repos' -Default @())) {
    $rp = [string] (Get-Prop -Object $repo -Name 'path' -Default '')
    if (-not $rp) { continue }
    if ($rp.StartsWith($sharedPrefix, [StringComparison]::OrdinalIgnoreCase)) { continue }
    if (-not (Test-Path -LiteralPath $rp)) { Write-Warn "repo path $rp in the config does not exist; nothing to grant there."; continue }
    if ($script:KeptRepoPaths -notcontains $rp) {
      Write-Step "repo outside the shared root at $rp : letting the service account in"
      Grant-RepoInPlace -RepoPath $rp
      $script:KeptRepoPaths += $rp
    }
  }
} catch {
  Write-Warn "could not read the repos out of $ConfigFile to grant the service account access: $($_.Exception.Message)"
}

# Nothing copied in above carries an ACL of its own: every copy is robocopy with /COPY:DAT,
# which deliberately leaves the S (security) flag out, so the copies take this machine's ACL
# rather than the profile owner's. The node directory's ACE set reaches all of it by
# inheritance, and there is no recursive icacls pass here -- `icacls <dir> /reset` would replace
# the ACL this script just wrote on the node directory itself with the inherited one.

# ---------------------------------------------------------------------------
# Step 11: the mesh transport
# ---------------------------------------------------------------------------

# One implementation of EasyTier on Windows, and it lives in Install-Sukarfleet.ps1. The secret
# is staged inside the node's own state directory and SUKARFLEET_STATE points there, which is
# what makes that script's Test-StagedSecretPath recognise the file as the installer's and
# shred it once the TOML has it.
$meshRan = $false
if ($MeshSecretFile -and -not $SkipMesh) {
  Write-Utf8File -Path $StagedSecret -Content ((Get-Content -LiteralPath $MeshSecretFile -Raw).Trim() + "`n")
  Invoke-Icacls -Arguments @($StagedSecret, '/inheritance:r') -What "removing inherited access from the staged mesh secret"
  Invoke-Icacls -Arguments @($StagedSecret, '/grant:r', "*${SidSystem}:(F)", "*${SidAdmins}:(F)") -What "restricting the staged mesh secret"
} elseif ($MeshSecretFile) {
  # -SkipMesh: the transport the secret belongs to is not being installed here, so the secret is
  # never opened, never copied and never handed on. The finally block below still shreds a file
  # the installer staged, because a secret left lying on disk is worse than one that went unused.
  Write-Note '  -SkipMesh: the network secret file is not read'
}

$savedState = $env:SUKARFLEET_STATE
$env:SUKARFLEET_STATE = $StateDir
try {
  $meshArgs = @{
    Stage           = 'Elevated'
    MachineName     = $MachineName
    Role            = $Role
    NodePort        = $NodePort
    NetworkName     = $NetworkName
    ListenPort      = $ListenPort
    RpcAddr         = $RpcAddr
    MeshServiceName = $MeshServiceName
    UserProfileDir  = $NodeDir
  }
  if ($MeshIp) { $meshArgs['MeshIp'] = $MeshIp }
  if ($PeerList.Count -gt 0) { $meshArgs['PeerUri'] = $PeerList }
  if ((-not $SkipMesh) -and (Test-Path -LiteralPath $StagedSecret)) { $meshArgs['MeshSecretFile'] = $StagedSecret }
  if ($SkipMesh) { $meshArgs['SkipMesh'] = $true }

  if ($SkipMesh) { Write-Step 'mesh transport skipped (-SkipMesh); running the elevated stage for the machine-wide settings it also owns' }
  else { Write-Step 'installing the mesh transport through Install-Sukarfleet.ps1 -Stage Elevated' }
  # & does not throw for a child .ps1 that called `exit 1`: the catch below would never see it,
  # and $meshRan would say "the stage ran" for a stage that refused. $LASTEXITCODE is the only
  # thing that child leaves behind, so it is zeroed first -- a stale code from any native command
  # earlier in this script must not be read as this stage's answer.
  $global:LASTEXITCODE = 0
  & $InstallSukarfleet @meshArgs
  if ($LASTEXITCODE -ne 0) {
    Write-Warn "Install-Sukarfleet.ps1 -Stage Elevated exited $LASTEXITCODE. Its output is above."
  } else {
    $meshRan = $true
  }
} catch {
  Write-Warn "the mesh stage did not finish: $($_.Exception.Message)"
} finally {
  $env:SUKARFLEET_STATE = $savedState
  Remove-SecretFile -Path $StagedSecret
  if ($ShredSecretSource -and $MeshSecretFile) { Remove-SecretFile -Path $MeshSecretFile }
}

if (-not $SkipMesh) {
  $meshSvc = Get-Service -Name $MeshServiceName -ErrorAction SilentlyContinue
  if (-not $meshSvc) {
    Write-Die "the mesh stage left no '$MeshServiceName' service behind. Its output is above. Fix the mesh, then re-run with -SkipMesh to carry on from here."
  }
  Write-Step "mesh transport service '$MeshServiceName' is $($meshSvc.Status)"
}
if (-not $meshRan) { Write-Warn 'carrying on without a confirmed mesh stage.' }

# ---------------------------------------------------------------------------
# Step 12: wait for the mesh address to exist on an interface
# ---------------------------------------------------------------------------

# "The service is running" and "the overlay address is on an adapter" are two different moments,
# and the node binds to that address. Fifteen seconds, then carry on and say so: a node that
# binds late restarts itself, a node nobody installed does not.
if ($MeshIp) {
  $addrUp = $false
  for ($i = 0; $i -lt 30 -and -not $addrUp; $i++) {
    try {
      $addrUp = @(Get-NetIPAddress -AddressFamily IPv4 -ErrorAction SilentlyContinue |
        Where-Object { $_.IPAddress -eq $MeshIp }).Count -gt 0
    } catch { $addrUp = $false }
    if (-not $addrUp) { Start-Sleep -Milliseconds 500 }
  }
  if ($addrUp) { Write-Step "mesh address $MeshIp is up on an adapter" }
  else { Write-Warn "$MeshIp is not on any adapter after 15s. The node will start anyway and bind it when the mesh brings it up; if it never does, check Get-Service $MeshServiceName." }
}

# ---------------------------------------------------------------------------
# Step 13: the service
# ---------------------------------------------------------------------------

function Uninstall-NodeServiceIfPresent {
  $svc = Get-Service -Name $ServiceId -ErrorAction SilentlyContinue
  if (-not $svc) { return }
  if ($svc.Status -ne 'Stopped') {
    [void] (Invoke-Native -Exe $WinSwExe -Arguments @('stop'))
    Start-Sleep -Seconds 2
  }
  [void] (Invoke-Native -Exe $WinSwExe -Arguments @('uninstall'))
  Start-Sleep -Seconds 2
}

# Returns $true only when the service manager says the service is Running. Exit codes are not
# evidence here: WinSW can register a service it then cannot log on as, and the failure arrives
# as a stopped service rather than a non-zero exit.
function Install-NodeService {
  param([Parameter(Mandatory)] [string] $Account)
  Write-NodeServiceXml -Account $Account
  Uninstall-NodeServiceIfPresent

  $r = Invoke-Native -Exe $WinSwExe -Arguments @('install')
  if ($r.ExitCode -ne 0) {
    Write-Host ($r.Output | Out-String)
    return $false
  }
  Start-Sleep -Seconds 1
  if (-not (Get-Service -Name $ServiceId -ErrorAction SilentlyContinue)) {
    Write-Host ($r.Output | Out-String)
    return $false
  }
  # The account is set through the service controller, not the xml. WinSW 2.12 reads a v2
  # <serviceaccount> and quietly registered the service as LocalSystem on a real machine while
  # this script said otherwise. sc config takes a virtual account with no password, and sc qc
  # is then read back, because the account this service runs as is the whole point of it.
  $cfg = Invoke-Native -Exe 'sc.exe' -Arguments @('config', $ServiceId, 'obj=', $Account)
  if ($cfg.ExitCode -ne 0) {
    Write-Host ($cfg.Output | Out-String)
    return $false
  }
  $qc = Invoke-Native -Exe 'sc.exe' -Arguments @('qc', $ServiceId)
  $qcText = ($qc.Output | Out-String)
  if ($qcText -notmatch ('SERVICE_START_NAME\s*:\s*' + [regex]::Escape($Account))) {
    Write-Host $qcText
    Write-Warn "sc qc does not show $Account as the account of '$ServiceId'"
    return $false
  }
  $s = Invoke-Native -Exe $WinSwExe -Arguments @('start')
  if ($s.ExitCode -ne 0) { Write-Host ($s.Output | Out-String) }
  for ($i = 0; $i -lt 20; $i++) {
    $svc = Get-Service -Name $ServiceId -ErrorAction SilentlyContinue
    if ($svc -and $svc.Status -eq 'Running') { return $true }
    Start-Sleep -Seconds 1
  }
  return $false
}

$serviceUp = Install-NodeService -Account $ServiceAccount
if (-not $serviceUp -and $ServiceAccount -ne 'NT AUTHORITY\LocalService') {
  Write-Warn "the service would not run as $ServiceAccount. That is the virtual account, and some machines refuse to grant it ""log on as a service""; the output above says what Windows said. Falling back to NT AUTHORITY\LocalService, which is a shared account rather than one that exists only for this service."
  $ServiceAccount = 'NT AUTHORITY\LocalService'
  $ServiceSid = $SidLocalSvc
  # Inheritance is dynamic, so rewriting the two roots reaches everything under them.
  Set-NodeDirAcl -Sid $ServiceSid
  Set-SharedRootAcl -Sid $ServiceSid
  Invoke-Icacls -Arguments @($TokenFile, '/grant', "*${SidUsers}:(R)") -What "letting local accounts read $TokenFile"
  [void] (Grant-SidAccess -Path $ProgramRoot -Sid $ServiceSid -Rights 'ReadAndExecute, WriteAttributes' -Inherit -What "letting LocalService read $ProgramRoot")
  # A repo adoption left in place was granted to the account this install has just stopped using,
  # and nothing under a profile inherits from the two roots above.
  foreach ($kept in $script:KeptRepoPaths) { Grant-RepoInPlace -RepoPath $kept }
  $script:ServiceFallback = $true
  $serviceUp = Install-NodeService -Account $ServiceAccount
}
if (-not $serviceUp) {
  Write-Die "the '$ServiceId' service is registered but will not run. Read $LogDir\sukarfleet-node.wrapper.log and $LogDir\sukarfleet-node.err.log, then re-run. Everything else on this machine is installed."
}
Write-Step "service '$ServiceId' is running as $ServiceAccount"

# ---------------------------------------------------------------------------
# Step 14: /health
# ---------------------------------------------------------------------------

$port = $NodePort
try {
  $liveCfg = Get-Content -LiteralPath $ConfigFile -Raw | ConvertFrom-Json
  $p = [int] (Get-Prop -Object $liveCfg -Name 'nodePort' -Default 0)
  if ($p -gt 0) { $port = $p }
} catch { }

$healthy = $false
for ($i = 0; $i -lt 40; $i++) {
  try {
    $r = Invoke-WebRequest -Uri "http://127.0.0.1:$port/health" -UseBasicParsing -TimeoutSec 2
    if ($r.StatusCode -eq 200) { $healthy = $true; break }
  } catch { }
  Start-Sleep -Milliseconds 500
}
if ($healthy) { Write-Step "node healthy on 127.0.0.1:$port" }
else { Write-Warn "the node did not answer /health within 20s. Check Get-Service $ServiceId and $LogDir." }

# ---------------------------------------------------------------------------
# Step 15: the tray
# ---------------------------------------------------------------------------

# Nothing here can fail the install. A machine with a daemon and a browser is installed; a
# machine with half a binary in Program Files is not.
$tray = @{ Installed = $false; Reason = '' }
if ($SkipTray) {
  $tray.Reason = '-SkipTray was passed'
} else {
  $base = $TrayReleaseBase
  if (-not $base) { $base = $env:SUKARFLEET_RELEASE_BASE }
  $urlFormat = 'https://github.com/SUKARDADDY/sukarfleet/releases/download/v{0}/{1}'
  if ($base) { $urlFormat = $base.TrimEnd('/') + '/{1}' }
  try {
    $trayTmp = Get-PinnedAsset -PinsFile $PinsFile -AssetPrefix 'sukarfleet-tray-windows-' -Arch $arch `
      -UrlFormat $urlFormat -Label 'the Windows tray'
    $running = @(Get-Process -Name 'sukarfleet-tray' -ErrorAction SilentlyContinue)
    if ($running.Count -gt 0) {
      $running | Stop-Process -Force -ErrorAction SilentlyContinue
      Start-Sleep -Seconds 1
    }
    Move-Item -LiteralPath $trayTmp -Destination $TrayExe -Force
    # Same reason as the WinSW binary above: every account on the machine starts this tray.
    Invoke-Icacls -Arguments @($TrayExe, '/reset', '/Q') -What "resetting the ACL on $TrayExe"
    $tray.Installed = $true
    Write-Step "installed $TrayExe (SHA256 pinned)"
  } catch {
    $tray.Reason = $_.Exception.Message
  }
}

if ($tray.Installed) {
  # HKLM, not HKCU: one value, every account, started with the endpoint and the token file it
  # needs. The tray's own "Start at login" checkbox reads HKCU and is hidden in service mode, so
  # there is one switch for this behaviour and not two that disagree.
  try {
    if (-not (Test-Path -LiteralPath $HklmRunKey)) { [void] (New-Item -Path $HklmRunKey -Force) }
    $cmd = '"' + $TrayExe + '" --endpoint http://127.0.0.1:' + $port + ' --token-file "' + $TokenFile + '"'
    Set-ItemProperty -LiteralPath $HklmRunKey -Name $RunValueName -Value $cmd
    Write-Step "the tray starts for every account at sign-in (HKLM Run value '$RunValueName')"
  } catch {
    Write-Warn "could not register the tray to start at sign-in: $($_.Exception.Message)"
  }
} else {
  Write-Step "no tray on this machine: $($tray.Reason)"
  Write-Note '  the console is the browser GUI below, which works the same way.'
}

# ---------------------------------------------------------------------------
# Step 16: the banner
# ---------------------------------------------------------------------------

$uiUrl = "http://127.0.0.1:$port/ui/"
Write-Host ''
Write-Host '  ------------------------------------------------------------------------'
Write-Host "  sukarfleet is installed machine-wide on $MachineName."
Write-Host ''
Write-Host "  Service:      $ServiceId, running as $ServiceAccount"
if ($script:ServiceFallback) {
  Write-Host '                (the virtual account was refused, so this is the shared LocalService'
  Write-Host '                 account. Other services run as it too; see SECURITY.md.)'
}
Write-Host "                Get-Service $ServiceId"
Write-Host "  Logs:         $LogDir"
Write-Host "  Console:      $uiUrl"
Write-Host "  Token:        $TokenFile"
Write-Host '                The console asks for it once. Any account on this machine can read it.'
Write-Host "  Shared root:  $SharedRoot"
Write-Host '                Clone the repos you want synced in there, then add them in the console.'
Write-Host ''
Write-Host '  It is running now and it starts at boot, with nobody logged in.'
Write-Host ''
Write-Host '  Two things this machine still cannot do, so you are not surprised later:'
Write-Host '    - The admin lane is off. Windows has no sudo. Drive admin from a Linux machine.'
Write-Host '    - NTFS carries ACLs rather than mode bits, so the credential store refuses to'
Write-Host '      hold a password. See docs/PLATFORMS.md.'
Write-Host '  ------------------------------------------------------------------------'
Write-Host ''

# Session 0 has no desktop and a silent install has nobody watching, so this only ever opens a
# browser when a person ran the installer from a session with one.
if (-not $NoOpen -and -not $tray.Installed -and [Environment]::UserInteractive) {
  Start-Process $uiUrl -ErrorAction SilentlyContinue
}

if ($script:Transcribing) { try { [void] (Stop-Transcript) } catch { } }
exit 0
