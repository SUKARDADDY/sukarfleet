# SPDX-License-Identifier: AGPL-3.0-or-later
<#
.SYNOPSIS
  Adds a Windows machine to a sukarfleet fleet.

.DESCRIPTION
  The Windows counterpart of install/quickstart.sh + install/install-elevated.sh, in one file
  because Windows has no clean way to hand a script back down from an elevated context.

  It runs in two stages and says which one it is in at every line of output:

    Elevated  One UAC prompt. Installs the EasyTier mesh transport, writes its config with an
              ACL only Administrators and SYSTEM can read, registers it as a Windows service,
              opens the firewall for it, and turns on NTFS long paths.

    User      No admin rights. Installs Bun, generates this machine's fleet SSH key, scaffolds
              ~/.config/sukarfleet/config.json, registers the node as a scheduled task, starts
              it, and waits for /health.

  Everything is idempotent. Re-running is the upgrade path (add -Restart to bounce the node).

  Nothing here hardcodes a machine name, an address or a peer. Identity comes from
  $env:COMPUTERNAME and from the arguments, and anything the script cannot know is left for
  the setup GUI to fill in. A fleet you cannot add a fourth machine to is not a fleet.

.NOTES
  Two things are true on Windows and are stated rather than papered over:

  1. The admin lane cannot elevate here. Its whole design is "pipe one password line to a tool
     that reads stdin", and Windows has no such tool. See docs/PLATFORMS.md. This installer
     writes admin.enabled = false and leaves it there. Sync is unaffected. Drive admin from a
     Linux machine.

  2. NTFS carries ACLs, not POSIX mode bits, so the daemon's store-privacy probe will report
     that mode is not enforced, and the credential store will refuse to hold a password. That
     is the honest answer, and it follows from (1) anyway.
#>

[CmdletBinding()]
param(
  [ValidateSet('Auto', 'Elevated', 'User')]
  [string] $Stage = 'Auto',

  # --- identity (only used when scaffolding a NEW config.json) ---
  [string] $MachineName = $env:COMPUTERNAME,
  [ValidateSet('anchor', 'roamer')]
  [string] $Role = 'roamer',
  [string] $MeshIp = '',
  [int]    $NodePort = 7710,
  [string] $NetworkName = 'sukarfleet',

  # --- mesh ---
  # Address(es) of a machine already in the fleet, e.g. tcp://198.51.100.7:11010.
  # A roamer needs at least one to find its way in.
  [string[]] $PeerUri = @(),
  [int]      $ListenPort = 11010,
  [string]   $RpcAddr = '127.0.0.1:15888',
  [string]   $MeshServiceName = 'easytier-fleet',
  # Path to a file holding the network secret, one line. Never pass the secret itself as an
  # argument: argv is visible to every process on the box and lands in your shell history.
  [string]   $MeshSecretFile = '',
  [string]   $EasyTierVersion = '2.6.4',
  [switch]   $SkipMesh,
  [switch]   $ForceMeshReinstall,

  # --- layout ---
  # Where the sukarfleet source is. Defaults to the checkout this script is sitting in.
  [string] $Source = '',
  # Where the node runs from. Only used when -Source is a zip or a foreign directory.
  [string] $InstallRoot = "$env:LOCALAPPDATA\sukarfleet\app",
  # Repos to sync, as name=path. Deliberately empty by default: a repo path is machine-local
  # and a wrong one here syncs the wrong tree.
  [string[]] $Repo = @(),

  # --- the native tray console ---
  # A desktop machine gets a tray icon and a console window; without it the console is
  # the daemon's web GUI in a browser. Skipping it costs nothing but the icon.
  [switch] $SkipTray,
  # Where the tray binary is fetched from. The Linux path gets this from install/get.sh,
  # which bakes in the tag it cloned; Windows has no get.sh, so it is built from the
  # version column of the pin in install/easytier-pins.txt. $env:SUKARFLEET_RELEASE_BASE
  # overrides it, which is how a test fleet serves its own build.
  [string] $TrayReleaseBase = '',

  # --- behaviour ---
  # The Bun this tree's bun.lock was resolved against, matching BUN_VERSION in
  # install/quickstart.sh. Pinned rather than 'latest' so a fresh Windows machine and a fresh
  # Linux machine end up on the same Bun. Pass 'latest' if you want whatever bun.sh ships today.
  [string] $BunVersion = '1.3.14',
  [switch] $Restart,
  [switch] $NoOpen,

  # --- internal, passed to the elevated child ---
  [string] $UserProfileDir = ''
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version 2.0
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

# powershell.exe -File hands every argument to the script as a literal string and never
# evaluates array syntax, so a [string[]] parameter arrives from the elevated relaunch as a
# single comma-joined element instead of as a list. A peer URI cannot contain a comma, so
# splitting on one is unambiguous, and it means a human can also type
# -PeerUri "tcp://host:11010,udp://host:11010" and get what they expect.
$PeerUri = @($PeerUri |
  ForEach-Object { $_ -split ',' } |
  ForEach-Object { $_.Trim() } |
  Where-Object { $_ })

# ---------------------------------------------------------------------------
# Output
# ---------------------------------------------------------------------------

$script:Tag = if ($Stage -eq 'Elevated') { 'elevated' } else { 'quickstart' }
# StrictMode 2.0 throws on a read of a variable that was never assigned, so this is declared
# here rather than the first time Invoke-Preflight looks at it.
$script:PreflightDone = $false

function Write-Step { param([string] $m) Write-Host "[$script:Tag] $m" }
function Write-Note { param([string] $m) Write-Host "[$script:Tag] $m" -ForegroundColor DarkGray }
function Write-Warn { param([string] $m) Write-Host "[$script:Tag] WARNING: $m" -ForegroundColor Yellow }
function Write-Die  { param([string] $m) Write-Host "[$script:Tag] ERROR: $m" -ForegroundColor Red; exit 1 }

# StrictMode 2.0 throws on a reference to a property an object does not have, and most of what
# this script reads is optional: a registry value that may never have been set, a config key
# written by an older version. Every optional read goes through here.
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

# Reads one key from config.json without caring whether the file, the JSON or the key is there.
function Get-ConfigValue {
  param([Parameter(Mandatory)] [string] $Name, $Default = $null)
  if (-not (Test-Path -LiteralPath $ConfigFile)) { return $Default }
  try { $cfg = Get-Content -LiteralPath $ConfigFile -Raw | ConvertFrom-Json }
  catch { return $Default }
  return (Get-Prop -Object $cfg -Name $Name -Default $Default)
}

# Windows PowerShell 5.1 turns every stderr line of a native command into an ErrorRecord once
# stderr is merged with 2>&1, and $ErrorActionPreference = 'Stop' makes the first one terminating.
# Plenty of well-behaved tools write progress to stderr, so a redirect that only means "capture
# everything" would abort the install on a stock Windows box while working fine under pwsh 7.
# The exit code is the signal here. stderr is just text.
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

# The two things this installer will not install for you. It runs before anything is
# downloaded, unpacked or registered, so a machine that is going to be refused is refused while
# it is still untouched. Deliberately NOT called from the elevated stage: that stage needs
# neither tool, and an administrator's PATH is not the logged-in user's PATH, so checking there
# would refuse a machine that is in fact fine.
function Invoke-Preflight {
  if ($script:PreflightDone) { return }
  foreach ($tool in @('git', 'ssh-keygen')) {
    if (-not (Get-Command $tool -ErrorAction SilentlyContinue)) {
      if ($tool -eq 'git') { Write-Die 'git is not on PATH. Install Git for Windows (winget install --id Git.Git), open a new terminal, then re-run. Nothing was installed.' }
      Write-Die 'ssh-keygen is not on PATH. Add the OpenSSH Client optional feature (Settings > System > Optional features), then re-run. Nothing was installed.'
    }
  }
  $script:PreflightDone = $true
}

# ---------------------------------------------------------------------------
# Paths. These must match src/config.ts, which uses os.homedir() + '.config' and
# '.local/state' on every platform. They are not Windows conventions; they are what
# the daemon actually reads.
# ---------------------------------------------------------------------------

# A trailing backslash would escape the closing quote when this is handed to the elevated child.
$UserHome   = $env:USERPROFILE
if ($UserProfileDir) { $UserHome = $UserProfileDir }
$UserHome   = $UserHome.TrimEnd('\')
$ConfigDir  = Join-Path $UserHome '.config\sukarfleet'
$ConfigFile = Join-Path $ConfigDir 'config.json'
$SecretsDir = Join-Path $ConfigDir 'secrets'
$StateDir   = if ($env:SUKARFLEET_STATE) { $env:SUKARFLEET_STATE } else { Join-Path $UserHome '.local\state\sukarfleet' }
$SshDir     = Join-Path $UserHome '.ssh'
$SshKey     = Join-Path $SshDir 'id_sukarfleet_ed25519'
$PendingSecret = Join-Path $StateDir 'pending-easytier-secret'

$MeshDir   = Join-Path $env:ProgramFiles 'EasyTier'
$MeshConfDir = Join-Path $env:ProgramData 'sukarfleet\easytier'
$MeshToml  = Join-Path $MeshConfDir 'fleet.toml'
$MeshCore  = Join-Path $MeshDir 'easytier-core.exe'
$MeshCli   = Join-Path $MeshDir 'easytier-cli.exe'

$TaskName = 'sukarfleet'

# The native tray console. Per-user, like everything else this installer owns: it needs no
# administrator rights, so asking for them to place a 12 MB binary would be a second UAC
# prompt for nothing. LOCALAPPDATA\Programs is where a per-user install belongs on Windows.
$TrayDir      = Join-Path $env:LOCALAPPDATA 'Programs\sukarfleet'
$TrayExe      = Join-Path $TrayDir 'sukarfleet-tray.exe'
$TrayShortcut = Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs\sukarfleet console.lnk'
$RunKey       = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run'
# Must match the tray's own product name: its "Start at login" checkbox reads and writes
# this exact value, and a second spelling would give the operator two switches for one
# behaviour, one of which silently loses.
$RunValueName = 'sukarfleet-tray'

# EasyTier release zips, pinned by content. The fleet's wire compatibility is the version, so
# a silent bump is a silent fleet split.
$MeshHashes = @{
  '2.6.4-x86_64' = '27AF91E270E554709B048BD32327FEFD2DFCE5062AE1E8701AF7550C6F525F84'
  '2.6.4-arm64'  = '37023F8A3451C9234B17EE2089A03DC344CE90D803B5B359CB6C46682B0549B4'
}

# ---------------------------------------------------------------------------
# ACL helper. The POSIX installer says chmod 700 and then checks that 700 stuck. The NTFS
# equivalent is: break inheritance, drop every inherited entry, grant exactly one identity.
# ---------------------------------------------------------------------------

# Two writes, not one, and the order matters. Set-Acl persists the sections the ACL object was
# asked to change, so an object carrying both a new DACL and a new owner goes in one
# all-or-nothing call: refuse the owner and the access rules are refused with it, leaving the
# file with the inherited, everyone-in-the-box ACL this function exists to remove. Ownership is
# the half that gets refused. Launched from a scheduled task under an elevated account the file
# is often already owned by BUILTIN\Administrators, and handing it back to the user is a
# privileged write that the task's token need not carry.
#
# So the access rules go first and stand on their own, and the owner is a second, best-effort
# call. Ownership is worth having, since an owner can re-open a file whatever the DACL says, but
# it is not the security property here: "nobody else can read this" is, and that is the DACL.
function Set-PrivateAcl {
  param([Parameter(Mandatory)] [string] $Path,
        [string[]] $Identities = @())

  if (-not $Identities -or $Identities.Count -eq 0) {
    $Identities = @([Security.Principal.WindowsIdentity]::GetCurrent().User.Value)
  }
  # Inheritance flags say what a CHILD of this object inherits, so they are meaningless on a
  # leaf file and Windows is entitled to reject an ACE that carries them there. This function is
  # called on three directories and on one file, the SSH private key, and the key is the one
  # whose ACL step was failing, so it asks what it is looking at rather than assuming.
  $inherit = if ([IO.Directory]::Exists($Path)) { 'ContainerInherit,ObjectInherit' } else { 'None' }

  $acl = Get-Acl -LiteralPath $Path
  $acl.SetAccessRuleProtection($true, $false)   # protect from inheritance, copy nothing down
  foreach ($rule in @($acl.Access)) { [void] $acl.RemoveAccessRule($rule) }
  foreach ($ident in $Identities) {
    $sid = New-Object Security.Principal.SecurityIdentifier($ident)
    $acl.AddAccessRule((New-Object Security.AccessControl.FileSystemAccessRule(
      $sid, 'FullControl', $inherit, 'None', 'Allow')))
  }
  Set-Acl -LiteralPath $Path -AclObject $acl

  $me = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
  try {
    $owned = Get-Acl -LiteralPath $Path
    if ($owned.GetOwner([Security.Principal.SecurityIdentifier]).Value -ne $me) {
      $owned.SetOwner((New-Object Security.Principal.SecurityIdentifier($me)))
      Set-Acl -LiteralPath $Path -AclObject $owned
    }
  } catch {
    # Only on the failure path, and only for the message: a raw S-1-5-32-544 tells the operator
    # nothing about what did get restricted.
    $who = @($Identities | ForEach-Object {
      try { (New-Object Security.Principal.SecurityIdentifier($_)).Translate([Security.Principal.NTAccount]).Value }
      catch { $_ }
    }) -join ', '
    Write-Warn "$Path is now open to $who and to nobody else, which is the part that matters, but its owner could not be changed to this account: $($_.Exception.Message). Access is restricted; ownership is not. Take it by hand if you want it: takeown /f `"$Path`""
  }
}

function New-PrivateDir {
  param([Parameter(Mandatory)] [string] $Path, [string] $Label)
  if (-not (Test-Path -LiteralPath $Path)) { [void] (New-Item -ItemType Directory -Force -Path $Path) }
  try { Set-PrivateAcl -Path $Path }
  catch { Write-Warn "could not restrict the ACL on $Label ($Path): $($_.Exception.Message)" }
}

# Writes a file only the current user can read, without ever putting the content on a command line.
#
# [AllowEmptyString()] because Mandatory implies the opposite: PowerShell rejects '' for a
# mandatory [string] with "Cannot bind argument to parameter 'Content' because it is an empty
# string", and this function's whole job for authorized_keys and known_hosts is to create them
# empty with the right ACL. Mandatory is still what is wanted here - the caller must say what
# goes in the file, and "nothing" is a thing to say.
function Write-PrivateFile {
  param([Parameter(Mandatory)] [string] $Path,
        [Parameter(Mandatory)] [AllowEmptyString()] [string] $Content)
  $dir = Split-Path -Parent $Path
  if (-not (Test-Path -LiteralPath $dir)) { [void] (New-Item -ItemType Directory -Force -Path $dir) }
  $utf8 = New-Object Text.UTF8Encoding($false)
  [IO.File]::WriteAllText($Path, $Content, $utf8)
  try {
    $acl = Get-Acl -LiteralPath $Path
    $acl.SetAccessRuleProtection($true, $false)
    foreach ($rule in @($acl.Access)) { [void] $acl.RemoveAccessRule($rule) }
    $sid = New-Object Security.Principal.SecurityIdentifier(
      [Security.Principal.WindowsIdentity]::GetCurrent().User.Value)
    $acl.AddAccessRule((New-Object Security.AccessControl.FileSystemAccessRule(
      $sid, 'FullControl', 'None', 'None', 'Allow')))
    Set-Acl -LiteralPath $Path -AclObject $acl
  } catch { Write-Warn "could not restrict the ACL on $Path : $($_.Exception.Message)" }
}

# Overwrite before delete. Not a guarantee on a copy-on-write filesystem or an SSD with
# wear levelling, and saying otherwise would be the confidently wrong answer this project
# refuses to give. It does keep the secret out of a trivially undeleted file.
function Remove-SecretFile {
  param([Parameter(Mandatory)] [string] $Path)
  if (-not (Test-Path -LiteralPath $Path)) { return }
  try {
    $len = (Get-Item -LiteralPath $Path).Length
    if ($len -gt 0) { [IO.File]::WriteAllBytes($Path, (New-Object byte[] $len)) }
  } catch { }
  Remove-Item -LiteralPath $Path -Force -ErrorAction SilentlyContinue
}

# Two spellings of the same file compare unequal as strings: a trailing slash, a quoted
# argument, mixed case, a relative path. Normalise both sides before deciding to delete
# something. A path that will not normalise is returned as typed, which can only make the
# comparison below fail, and failing means "leave the file alone".
function ConvertTo-ComparablePath {
  param([string] $Path = '')
  if (-not $Path) { return '' }
  # Windows accepts both separators, and SUKARFLEET_STATE could be set with either, so fold
  # them here rather than trusting GetFullPath to have done it.
  $p = $Path.Trim().Trim('"').Replace('/', '\')
  if (-not $p) { return '' }
  try { $p = [IO.Path]::GetFullPath($p) } catch { }
  return $p.TrimEnd('\')
}

# Is this the secret file the installer staged for itself, or one the operator wrote by hand?
# Only the first gets shredded once it has been consumed. Deleting a file the operator created
# and named is not tidiness, it is destroying someone else's data on a guess, so anything that
# is not demonstrably ours is left where it is and reported.
function Test-StagedSecretPath {
  param([string] $Path = '')
  if (-not $Path) { return $false }
  $full = ConvertTo-ComparablePath -Path $Path
  if (-not $full) { return $false }
  if ($full -eq (ConvertTo-ComparablePath -Path $PendingSecret)) { return $true }
  # Anything inside the installer's own state directory is the installer's to clean up.
  $stateFull = ConvertTo-ComparablePath -Path $StateDir
  if ($stateFull -and $full.StartsWith(($stateFull + '\'), [StringComparison]::OrdinalIgnoreCase)) { return $true }
  return $false
}

function ConvertTo-TomlString { param([string] $s) return (ConvertTo-Json -InputObject $s -Compress) }

# ---------------------------------------------------------------------------
# TOML, mirroring generateEasytierToml() in src/transport.ts key for key. If you change one,
# change the other; tests/ pins the Linux side.
# ---------------------------------------------------------------------------

function New-EasytierToml {
  param([string] $Hostname, [string] $Ipv4, [string] $Secret,
        [string[]] $Listeners, [string[]] $Peers, [string] $Network, [string] $Rpc)

  # List[string].Add() returns void. An ArrayList's returns the new index, which would land in
  # this function's output and put a column of integers through the middle of the TOML.
  $lines = New-Object Collections.Generic.List[string]
  $lines.Add("# rpc_portal is passed as a CLI flag (-r $Rpc) at service registration, not in this file.")
  $lines.Add("hostname = $(ConvertTo-TomlString $Hostname)")
  $lines.Add("ipv4 = $(ConvertTo-TomlString $Ipv4)")
  $lines.Add('dhcp = false')
  $lines.Add("listeners = [$(($Listeners | ForEach-Object { ConvertTo-TomlString $_ }) -join ', ')]")
  $lines.Add('')
  $lines.Add('[network_identity]')
  $lines.Add("network_name = $(ConvertTo-TomlString $Network)")
  $lines.Add("network_secret = $(ConvertTo-TomlString $Secret)")
  foreach ($p in $Peers) {
    $lines.Add('')
    $lines.Add('[[peer]]')
    $lines.Add("uri = $(ConvertTo-TomlString $p)")
  }
  $lines.Add('')
  $lines.Add('[flags]')
  $lines.Add('relay_network_whitelist = ""')
  $lines.Add('enable_ipv6 = true')
  return ($lines -join "`r`n") + "`r`n"
}

# ===========================================================================
# STAGE: Elevated
# ===========================================================================

function Invoke-ElevatedStage {
  if (-not (Test-Elevated)) { Write-Die 'the elevated stage needs administrator rights.' }

  Write-Step 'this stage installs the mesh transport and nothing else. It does not touch your home directory, create a user, or install a privileged helper.'

  # --- NTFS long paths. node_modules under a synced workspace goes past 260 characters and
  #     git fails with a confusing "Filename too long" that looks like repo corruption.
  $fsKey = 'HKLM:\SYSTEM\CurrentControlSet\Control\FileSystem'
  try {
    $cur = Get-Prop -Object (Get-ItemProperty -Path $fsKey -ErrorAction SilentlyContinue) -Name 'LongPathsEnabled'
    if ($cur -ne 1) {
      Set-ItemProperty -Path $fsKey -Name LongPathsEnabled -Value 1 -Type DWord
      Write-Step 'enabled NTFS long paths (takes effect for processes started from now on)'
    } else { Write-Note 'NTFS long paths already enabled' }
  } catch { Write-Warn "could not enable NTFS long paths: $($_.Exception.Message)" }

  if ($SkipMesh) { Write-Step 'skipping the mesh transport (-SkipMesh)'; return }

  # --- mesh address ---------------------------------------------------------
  # Asked BEFORE the secret on purpose. Pasting a secret usually drags a trailing newline in
  # with it, which submits the secret and then instantly satisfies whatever prompt comes next
  # with an empty line. Whatever follows the secret prompt has to be able to survive that, so
  # nothing follows it, and this loop re-asks rather than aborting a half-finished install.
  $ip = $MeshIp
  if (-not $ip) { $ip = Get-ConfigValue -Name 'meshIp' -Default '' }   # a re-run knows its own address
  for ($try = 0; $try -lt 5 -and $ip -notmatch '^\d{1,3}(\.\d{1,3}){3}$'; $try++) {
    if ($ip) { Write-Warn "'$ip' is not an IPv4 address." }
    $ip = (Read-Host '  this machine''s mesh address (e.g. 192.0.2.3)').Trim()
  }
  if ($ip -notmatch '^\d{1,3}(\.\d{1,3}){3}$') {
    Write-Die "no usable mesh address after 5 tries. Re-run with -MeshIp 192.0.2.3 (pick one free on your fleet's mesh subnet) and it will not ask."
  }


  # --- the network secret ---------------------------------------------------
  $secret = $null
  $secretSource = ''
  $secretFile = ''   # empty when the secret was typed, so there is nothing on disk to clean up
  if ($MeshSecretFile) {
    if (-not (Test-Path -LiteralPath $MeshSecretFile)) { Write-Die "no such file: $MeshSecretFile" }
    $secret = (Get-Content -LiteralPath $MeshSecretFile -Raw).Trim()
    $secretFile = $MeshSecretFile
    $secretSource = $MeshSecretFile
  } elseif (Test-Path -LiteralPath $PendingSecret) {
    $secret = (Get-Content -LiteralPath $PendingSecret -Raw).Trim()
    $secretFile = $PendingSecret
    $secretSource = $PendingSecret
  }
  if (-not $secret) {
    Write-Host ''
    Write-Host '  The mesh network secret. Every machine in one fleet shares it.'
    Write-Host '  On a Linux fleet machine it is the network_secret line in /etc/easytier/fleet.toml,'
    Write-Host '  readable as root. It is not echoed here and is not stored outside the config below.'
    $sec = Read-Host -Prompt '  network secret' -AsSecureString
    $bstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($sec)
    try { $secret = [Runtime.InteropServices.Marshal]::PtrToStringAuto($bstr).Trim() }
    finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr) }
    $secretSource = '(typed)'
  }
  if (-not $secret) { Write-Die 'the network secret is empty; nothing was installed.' }
  # A masked prompt cannot show you that a paste dropped a character, and a secret one short
  # produces a mesh that runs perfectly and never connects. The length is not the secret, so
  # printing it gives nothing away and catches the mistake here instead of an hour later.
  Write-Step ("network secret accepted: $($secret.Length) characters. Check that against the source; a short paste is silent otherwise.")

  $peers = $PeerUri
  if ($peers.Count -eq 0 -and $Role -eq 'roamer') {
    Write-Warn "no -PeerUri given. A roamer with no peer to dial will sit alone on the mesh. Add one to $MeshToml under [[peer]] and restart the $MeshServiceName service."
  }

  # --- binaries -------------------------------------------------------------
  $arch = switch ($env:PROCESSOR_ARCHITECTURE) {
    'AMD64' { 'x86_64' }
    'ARM64' { 'arm64' }
    default { Write-Die "unsupported processor architecture '$env:PROCESSOR_ARCHITECTURE'. EasyTier ships x86_64 and arm64 builds for Windows." }
  }

  if ((Test-Path -LiteralPath $MeshCore) -and -not $ForceMeshReinstall) {
    Write-Note "EasyTier already at $MeshDir (pass -ForceMeshReinstall to replace it)"
  } else {
    $asset = "easytier-windows-$arch-v$EasyTierVersion.zip"
    $url = "https://github.com/EasyTier/EasyTier/releases/download/v$EasyTierVersion/$asset"
    $tmp = Join-Path $env:TEMP $asset
    Write-Step "downloading $asset"
    try { Invoke-WebRequest -Uri $url -OutFile $tmp -UseBasicParsing }
    catch { Write-Die "download failed: $($_.Exception.Message)`n  $url" }

    $want = $MeshHashes["$EasyTierVersion-$arch"]
    $got = (Get-FileHash -LiteralPath $tmp -Algorithm SHA256).Hash
    if ($want) {
      if ($got -ne $want) {
        Remove-Item -LiteralPath $tmp -Force -ErrorAction SilentlyContinue
        Write-Die "SHA256 mismatch for $asset.`n  expected $want`n  got      $got`nNothing was installed."
      }
      Write-Step "SHA256 verified against the pin for $EasyTierVersion/$arch"
    } else {
      Write-Warn "no pinned SHA256 for EasyTier $EasyTierVersion/$arch, so nothing verified this download. Its hash is $got. Check it against the release page before you trust this mesh."
    }

    $unzip = Join-Path $env:TEMP "easytier-unpack-$([Guid]::NewGuid().ToString('N'))"
    Expand-Archive -LiteralPath $tmp -DestinationPath $unzip -Force
    $srcDir = Join-Path $unzip "easytier-windows-$arch"
    if (-not (Test-Path -LiteralPath $srcDir)) {
      $first = @(Get-ChildItem -LiteralPath $unzip -Directory) | Select-Object -First 1
      if (-not $first) { Write-Die "$asset unpacked to nothing recognisable. Nothing was installed." }
      $srcDir = $first.FullName
    }
    [void] (New-Item -ItemType Directory -Force -Path $MeshDir)
    # Stop the service first: a running easytier-core.exe holds its own image open.
    $svc = Get-Service -Name $MeshServiceName -ErrorAction SilentlyContinue
    if ($svc -and $svc.Status -eq 'Running') { Stop-Service -Name $MeshServiceName -Force; Start-Sleep -Seconds 2 }
    Copy-Item -Path (Join-Path $srcDir '*') -Destination $MeshDir -Recurse -Force
    Remove-Item -LiteralPath $unzip -Recurse -Force -ErrorAction SilentlyContinue
    Remove-Item -LiteralPath $tmp -Force -ErrorAction SilentlyContinue
    Write-Step "installed EasyTier $EasyTierVersion ($arch) to $MeshDir"
  }
  if (-not (Test-Path -LiteralPath $MeshCli)) { Write-Die "easytier-cli.exe is missing from $MeshDir." }

  # --- config ---------------------------------------------------------------
  [void] (New-Item -ItemType Directory -Force -Path $MeshConfDir)
  # Administrators + SYSTEM only. The service runs as SYSTEM and must read it; the logged-in
  # user must not, because it holds the network secret in plaintext.
  Set-PrivateAcl -Path $MeshConfDir -Identities @('S-1-5-32-544', 'S-1-5-18')

  $listeners = @("tcp://0.0.0.0:$ListenPort", "udp://0.0.0.0:$ListenPort")
  $toml = New-EasytierToml -Hostname $MachineName -Ipv4 $ip -Secret $secret `
                           -Listeners $listeners -Peers $peers -Network $NetworkName -Rpc $RpcAddr
  $utf8 = New-Object Text.UTF8Encoding($false)
  [IO.File]::WriteAllText($MeshToml, $toml, $utf8)
  $secret = $null
  Write-Step "wrote $MeshToml (Administrators and SYSTEM only; secret from $secretSource)"
  # The secret is now in the TOML, so the staged copy has served its purpose and goes here,
  # before service registration. Everything below this line can fail, and none of those
  # failures should leave the plaintext secret sitting in the user's profile. This runs on the
  # explicit -Stage Elevated path too, not only when the unelevated stage staged the file: the
  # child never knew which of the two launched it, and the file is consumed either way.
  if ($secretFile) {
    if (Test-StagedSecretPath -Path $secretFile) {
      Remove-SecretFile -Path $secretFile
      Write-Step 'adopted and shredded the staged secret'
    } else {
      Write-Step "left $secretFile in place: it is not the installer's staged file. Delete it yourself when the mesh is up."
    }
  }

  # --- service --------------------------------------------------------------
  $existing = Get-Service -Name $MeshServiceName -ErrorAction SilentlyContinue
  if ($existing -and -not $ForceMeshReinstall) {
    Write-Note "service '$MeshServiceName' already registered; restarting it onto the new config"
    Restart-Service -Name $MeshServiceName -Force
  } else {
    if ($existing) {
      [void] (Invoke-Native -Exe $MeshCli -Arguments @('service', '--name', $MeshServiceName, 'uninstall'))
      Start-Sleep -Seconds 2
    }
    Write-Step "registering the '$MeshServiceName' service"
    # Everything after '--' is handed to easytier-core verbatim. rpc_portal stays a flag rather
    # than a TOML key, matching the Linux unit's ExecStart.
    # --name is an option of `service`, NOT of `install`, and the ordering is not cosmetic.
    # `install` declares [CORE_ARGS]... as a trailing var-arg, so the first token clap does not
    # recognise turns into a positional and every flag after it is swallowed as a core argument.
    # Passing `--name` after `install` therefore registers a service under the DEFAULT name,
    # running easytier-core with `--name`, `--core-path` and `--display-name` as its own argv,
    # which it rejects. easytier-cli exits 0 the whole time. Verified on Windows 2026-08-29.
    $r = Invoke-Native -Exe $MeshCli -Arguments @(
      'service', '--name', $MeshServiceName, 'install',
      '--display-name', 'EasyTier mesh transport (sukarfleet)',
      '--core-path', $MeshCore,
      '--service-work-dir', $MeshDir,
      '--', '-c', $MeshToml, '-r', $RpcAddr)
    if ($r.ExitCode -ne 0) {
      Write-Host ($r.Output | Out-String)
      Write-Die "easytier-cli service install failed (exit $($r.ExitCode)). Run it by hand from $MeshDir to see why."
    }
    # Exit 0 is not evidence. easytier-cli has been observed returning 0 while registering
    # nothing, which surfaces three steps later as "service is not running" and sends you
    # hunting through event logs for a service that was never created. Ask the service manager.
    Start-Sleep -Seconds 1
    if (-not (Get-Service -Name $MeshServiceName -ErrorAction SilentlyContinue)) {
      Write-Host ($r.Output | Out-String)
      Write-Die "easytier-cli service install returned 0 but no '$MeshServiceName' service exists. Its output is above. Register it by hand from $MeshDir, then re-run with -SkipMesh."
    }
    Write-Step "service '$MeshServiceName' registered"

    $startRes = Invoke-Native -Exe $MeshCli -Arguments @('service', '--name', $MeshServiceName, 'start')
    if ($startRes.ExitCode -ne 0) {
      Write-Warn "service start reported exit $($startRes.ExitCode): $(($startRes.Output | Out-String).Trim())"
    }
  }

  # --- firewall -------------------------------------------------------------
  # Scoped to the one binary and the one port. No blanket allow.
  foreach ($proto in @('TCP', 'UDP')) {
    $ruleName = "sukarfleet mesh ($proto $ListenPort)"
    if (-not (Get-NetFirewallRule -DisplayName $ruleName -ErrorAction SilentlyContinue)) {
      try {
        [void] (New-NetFirewallRule -DisplayName $ruleName -Direction Inbound -Action Allow `
          -Program $MeshCore -Protocol $proto -LocalPort $ListenPort -Profile Any)
        Write-Step "firewall: allowed inbound $proto/$ListenPort for easytier-core.exe"
      } catch { Write-Warn "could not add the $proto firewall rule: $($_.Exception.Message)" }
    } else { Write-Note "firewall rule already present: $ruleName" }
  }

  Start-Sleep -Seconds 2
  $svc = Get-Service -Name $MeshServiceName -ErrorAction SilentlyContinue
  if ($svc -and $svc.Status -eq 'Running') { Write-Step "mesh transport is running as service '$MeshServiceName'" }
  else { Write-Warn "service '$MeshServiceName' is not running. Check: Get-Service $MeshServiceName ; Get-EventLog -LogName Application -Newest 20" }

  Write-Step 'done. Nothing else on this machine needs administrator rights.'
}

# ===========================================================================
# STAGE: User
# ===========================================================================

# Returns a path or $null, and nothing else: every branch is a return, because the caller uses
# the return value as an executable. $env:BUN_INSTALL is where bun.sh's installer puts bun when
# it is set, and PATH is checked last because a bun installed in this same run is not on the
# PATH of a process that started before it existed.
function Resolve-Bun {
  $candidates = @(
    (Join-Path $UserHome '.bun\bin\bun.exe'),
    (Join-Path $env:USERPROFILE '.bun\bin\bun.exe')
  )
  if ($env:BUN_INSTALL) { $candidates += (Join-Path $env:BUN_INSTALL 'bin\bun.exe') }
  foreach ($c in $candidates) { if (Test-Path -LiteralPath $c) { return $c } }
  $onPath = Get-Command bun -ErrorAction SilentlyContinue
  if ($onPath) { return $onPath.Source }
  return $null
}

# bun.sh's install.ps1 is a script, not a library. It writes its whole progress log AND its
# success banner ("Bun 1.4.2 was installed successfully! The binary is located at ...", with
# ANSI colour in it) to the PIPELINE with Write-Output, and its failure paths `return 1`. Run
# inline with `& ([scriptblock]::Create(...))`, every one of those lines becomes part of THIS
# function's return value; the caller then treats an array of banner text as the path to
# bun.exe and the next line dies with CommandNotFoundException on a "command" that is the
# banner. Observed on Windows 11 Pro / Windows PowerShell 5.1, 2026-09-05.
#
# So it goes to a temp file and runs in a separate PowerShell process. A child process cannot
# put anything into this pipeline at all, whatever it prints still reaches the operator, it is
# not subject to this machine's execution policy, and it does not inherit Set-StrictMode 2.0 or
# our $ErrorActionPreference, neither of which bun's installer was written against.
function Install-Bun {
  $bun = Resolve-Bun
  if ($bun) { return $bun }
  Write-Step "Bun not found; installing Bun $BunVersion from bun.sh"

  $tmp = Join-Path $env:TEMP "bun-install-$([Guid]::NewGuid().ToString('N')).ps1"
  try {
    try {
      Invoke-WebRequest -Uri 'https://bun.sh/install.ps1' -OutFile $tmp -UseBasicParsing
      $psExe = Get-Prop -Object (Get-Process -Id $PID -ErrorAction SilentlyContinue) -Name 'Path' -Default 'powershell.exe'
      # Splatted from a variable, which is how the rest of this file calls a native command: an
      # array literal in the argument position is a different construct and its unrolling is
      # not something to take on trust across two PowerShell majors.
      # -Version is bun's own parameter and takes a bare 1.2.3. Out-Host, not a capture: the
      # operator watches the download live and not one line of it can reach a caller.
      $bunArgs = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $tmp, '-Version', $BunVersion)
      # Run in its own scope with the same stderr rule Invoke-Native documents: on Windows
      # PowerShell 5.1 a native command's stderr can reach the error stream, and
      # $ErrorActionPreference = 'Stop' would make bun's first progress line on stderr
      # terminating. Scoped, so the download above keeps its 'Stop' and still throws to catch.
      $code = & {
        $ErrorActionPreference = 'Continue'
        & $psExe @bunArgs | Out-Host
        $LASTEXITCODE
      }
    } catch {
      Write-Die "Bun install failed: $($_.Exception.Message)`nInstall it by hand from https://bun.sh, then re-run."
    }
    # bun's installer reports failure by printing and `return 1`, which still leaves the host
    # exiting 0, so a non-zero code is worth saying out loud but a zero one proves nothing.
    # Whether bun.exe is on disk is the verdict, and that is the check below.
    if ($code -ne 0) { Write-Warn "the Bun installer exited $code." }
  } finally {
    Remove-Item -LiteralPath $tmp -Force -ErrorAction SilentlyContinue
  }

  $bun = Resolve-Bun
  if (-not $bun) { Write-Die 'Bun still not found after installing. Install it by hand from https://bun.sh, then re-run.' }
  return $bun
}

# Proves the private key opens without a passphrase, instead of trusting that the -N argument
# survived the shell. stdin comes from an empty file, so a passphrase prompt reads end-of-file
# and ssh-keygen gives up at once rather than hanging an installer nobody is watching.
#
# An empty FILE, not 'NUL'. Start-Process resolves -RedirectStandardInput as a path and opens it
# with the .NET file APIs, which do not honour the DOS device names, so 'NUL' fails the whole
# call with "This command cannot be run because either the parameter ... is not valid". That is
# the check failing, not the key: it warned on a key that was in fact fine. Observed on Windows
# 11, both Windows PowerShell 5.1 and pwsh 7.6.5, 2026-09-05.
function Test-KeyUnencrypted {
  param([Parameter(Mandatory)] [string] $KeyPath)
  # Two runs of this installer can overlap (a scheduled task and a console), and $PID alone gets
  # reused, so the three temp paths carry a GUID as well.
  $stem = Join-Path $env:TEMP "sukarfleet-keycheck-$PID-$([Guid]::NewGuid().ToString('N'))"
  $in   = "$stem.in"
  $out  = "$stem.out"
  $err  = "$stem.err"
  try {
    # WriteAllBytes on an empty array, not New-Item: it creates and truncates in one call and
    # says nothing on the pipeline.
    [IO.File]::WriteAllBytes($in, (New-Object byte[] 0))
    $p = Start-Process -FilePath 'ssh-keygen' -ArgumentList @('-y', '-f', "`"$KeyPath`"") `
      -NoNewWindow -Wait -PassThru `
      -RedirectStandardInput $in -RedirectStandardOutput $out -RedirectStandardError $err
    return ($p.ExitCode -eq 0)
  } catch {
    Write-Warn "could not verify that $KeyPath is passphrase-free: $($_.Exception.Message)"
    return $true   # do not delete a key over a failed check
  } finally {
    Remove-Item -LiteralPath $in, $out, $err -Force -ErrorAction SilentlyContinue
  }
}

function Resolve-SourceDir {
  if ($Source) {
    if (-not (Test-Path -LiteralPath $Source)) { Write-Die "no such -Source: $Source" }
    if ((Get-Item -LiteralPath $Source).PSIsContainer) { return (Resolve-Path -LiteralPath $Source).Path }
    # A zip: unpack it under InstallRoot and use that.
    Write-Step "unpacking $Source"
    if (Test-Path -LiteralPath $InstallRoot) { Remove-Item -LiteralPath $InstallRoot -Recurse -Force }
    [void] (New-Item -ItemType Directory -Force -Path $InstallRoot)
    Expand-Archive -LiteralPath $Source -DestinationPath $InstallRoot -Force
    $inner = @(Get-ChildItem -LiteralPath $InstallRoot -Directory)
    if ($inner.Count -eq 1 -and -not (Test-Path (Join-Path $InstallRoot 'src\node.ts'))) {
      return $inner[0].FullName
    }
    return $InstallRoot
  }
  # Default: the checkout this script lives in (install\windows\ -> repo root).
  $here = Split-Path -Parent $PSCommandPath
  $guess = (Resolve-Path (Join-Path $here '..\..')).Path
  if (Test-Path (Join-Path $guess 'src\node.ts')) { return $guess }
  Write-Die "cannot find the sukarfleet source. Put this script back in the checkout's install\windows\ folder, or pass -Source <dir-or-zip>."
}

function Invoke-UserStage {
  # First, before anything is fetched or written. Bun used to be installed and only then was
  # the machine told it had no git, which left a Bun behind on a box the installer refused.
  Invoke-Preflight

  if (Test-Elevated) {
    Write-Warn 'this stage is running as administrator. The node will then own its config and SSH key as an administrator, which is not what you want on a machine you log into normally. Close this and run the .cmd without "Run as administrator"; it asks for elevation only for the one stage that needs it.'
  }

  # --- 1. source + Bun ------------------------------------------------------
  $repoRoot = Resolve-SourceDir
  Write-Step "sukarfleet source at $repoRoot"
  $bun = Install-Bun
  Write-Step "bun $(& $bun --version) at $bun"

  Push-Location $repoRoot
  try {
    Write-Step 'bun install'
    $bunResult = Invoke-Native -Exe $bun -Arguments @('install')
    if ($bunResult.ExitCode -ne 0) {
      Write-Host ($bunResult.Output | Out-String)
      Write-Die "bun install failed (exit $($bunResult.ExitCode)) in $repoRoot"
    }
  } finally { Pop-Location }

  # --- 2. private directories ----------------------------------------------
  New-PrivateDir -Path $ConfigDir  -Label 'config dir'
  New-PrivateDir -Path $SecretsDir -Label 'credential store'
  New-PrivateDir -Path $StateDir   -Label 'state dir'
  if (-not (Test-Path -LiteralPath $SshDir)) { [void] (New-Item -ItemType Directory -Force -Path $SshDir) }

  # --- 3. config.json -------------------------------------------------------
  $repos = @()
  foreach ($r in $Repo) {
    $i = $r.IndexOf('=')
    if ($i -lt 1) { Write-Die "-Repo wants name=path, got '$r'" }
    $rname = $r.Substring(0, $i)
    $rpath = $r.Substring($i + 1)
    if (-not (Test-Path -LiteralPath (Join-Path $rpath '.git'))) {
      Write-Die "-Repo $rname points at $rpath, which is not a git repository. Clone it there first; the daemon syncs repos, it does not create them."
    }
    Initialize-SyncedRepo -Path $rpath
    $repos += [ordered]@{ name = $rname; path = $rpath }
  }

  if (Test-Path -LiteralPath $ConfigFile) {
    Update-ExistingConfig
  } else {
    if (-not $MeshIp) {
      Write-Warn "config.json is being written with an empty meshIp. Set it in the GUI before pairing, or the node has nothing to bind its mesh listener to."
    }
    # peers[] is empty on purpose: peers arrive through GUI pairing, which exchanges the mesh
    # public key, the SSH public key and the SSH host keys in both directions.
    $cfg = [ordered]@{
      machine     = $MachineName
      role        = $Role
      meshIp      = $MeshIp
      nodePort    = $NodePort
      networkName = $NetworkName
      peers       = @()
      repos       = $repos
      unionPaths  = @('workspace-manifest.json', 'workspace-removals.json')
      easytier    = [ordered]@{
        rpcAddr     = $RpcAddr
        serviceName = $MeshServiceName        # a Windows service name, no .service suffix
        cliPath     = $MeshCli
      }
      # The admin lane cannot elevate on Windows: there is no sudo, and the lane's design is
      # "pipe one password to a tool that reads stdin". docs/PLATFORMS.md says unsupported and
      # means it. Off, and off honestly, rather than on and refusing at the first real call.
      admin       = [ordered]@{
        enabled        = $false
        acceptIncoming = $false
        sshUser        = $env:USERNAME
        uiEnabled      = $true
      }
    }
    Write-PrivateFile -Path $ConfigFile -Content ((ConvertTo-Json $cfg -Depth 8) + "`r`n")
    Write-Step "wrote $ConfigFile (machine=$MachineName role=$Role meshIp=$(if ($MeshIp) { $MeshIp } else { '<unset>' }))"
    Write-Note '  peers[] is empty by design; pair from the GUI. repos[] holds only what you passed with -Repo.'
  }

  # --- 4. fleet SSH identity -----------------------------------------------
  # One dedicated key per machine, never copied anywhere. Pairing publishes only the public
  # half. A personal id_ed25519 is deliberately not reused.
  if (Test-Path -LiteralPath $SshKey) {
    Write-Note "fleet ssh key present: $SshKey"
  } else {
    # Windows PowerShell 5.1 drops an empty string argument to a native command, so the usual
    # workaround for "no passphrase" is the literal two-character string "". PowerShell 7 passes
    # '' through correctly and would take that workaround as an actual two-character passphrase.
    # Getting this backwards produces an encrypted key that looks fine until something tries to
    # use it unattended, so the result is checked below rather than assumed.
    $noPass = ''
    if ($PSVersionTable.PSVersion.Major -lt 6) { $noPass = '""' }
    & ssh-keygen -q -t ed25519 -N $noPass -C "sukarfleet:$MachineName" -f $SshKey
    if (-not (Test-Path -LiteralPath $SshKey)) { Write-Die 'ssh-keygen did not produce a key.' }
    if (-not (Test-KeyUnencrypted -KeyPath $SshKey)) {
      Remove-Item -LiteralPath $SshKey -Force -ErrorAction SilentlyContinue
      Remove-Item -LiteralPath "$SshKey.pub" -Force -ErrorAction SilentlyContinue
      Write-Die "the generated key came out passphrase-protected, so it was deleted rather than left for the daemon to fail on later. Generate it by hand and re-run:`n  ssh-keygen -t ed25519 -C `"sukarfleet:$MachineName`" -f `"$SshKey`""
    }
    Write-Step "generated $SshKey"
  }
  try { Set-PrivateAcl -Path $SshKey }
  catch { Write-Warn "could not restrict the ACL on $SshKey : $($_.Exception.Message). Anyone who can read that file can use this machine's fleet identity, so fix it before pairing: icacls `"$SshKey`" /inheritance:r /grant:r `"${env:USERNAME}:F`"" }

  $authorized = Join-Path $SshDir 'authorized_keys'
  if (-not (Test-Path -LiteralPath $authorized)) { Write-PrivateFile -Path $authorized -Content '' }
  $knownHosts = Join-Path $StateDir 'known_hosts'
  if (-not (Test-Path -LiteralPath $knownHosts)) { Write-PrivateFile -Path $knownHosts -Content '' }

  # --- 5. credential sealing probe -----------------------------------------
  # A real round trip, not a capability query. The project's own hardware has already produced
  # a confidently wrong answer to "can you seal?", which is why nothing here asks.
  $sealOk = $false
  try {
    $blob = ConvertFrom-SecureString -SecureString (ConvertTo-SecureString -String 'probe' -AsPlainText -Force)
    $back = ConvertTo-SecureString -String $blob
    $ptr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($back)
    try { $sealOk = ([Runtime.InteropServices.Marshal]::PtrToStringAuto($ptr) -eq 'probe') }
    finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($ptr) }
  } catch { $sealOk = $false }
  if ($sealOk) { Write-Step 'DPAPI round trip works (CurrentUser scope).' }
  else { Write-Warn 'DPAPI did not round-trip for this user. The credential store will refuse to hold anything, which is the fail-closed answer.' }

  # --- 6. scheduled task ----------------------------------------------------
  Register-NodeTask -Bun $bun -RepoRoot $repoRoot

  # --- 7. wait for /health --------------------------------------------------
  $port = Get-ConfigValue -Name 'nodePort' -Default $NodePort
  $uiUrl = "http://127.0.0.1:$port/ui/"
  $healthy = $false
  for ($i = 0; $i -lt 40; $i++) {
    try {
      $r = Invoke-WebRequest -Uri "http://127.0.0.1:$port/health" -UseBasicParsing -TimeoutSec 2
      if ($r.StatusCode -eq 200) { $healthy = $true; break }
    } catch { }
    Start-Sleep -Milliseconds 500
  }
  if ($healthy) { Write-Step "node healthy on 127.0.0.1:$port" }
  else { Write-Warn "the node did not answer /health within 20s. Check: Get-ScheduledTaskInfo -TaskName $TaskName , then run it in the foreground: cd `"$repoRoot`" ; & `"$bun`" run src\node.ts" }

  # --- 8. the native tray console -------------------------------------------
  $tray = Install-Tray -RepoRoot $repoRoot

  Show-Banner -UiUrl $uiUrl -RepoRoot $repoRoot -Bun $bun -SealOk $sealOk -Tray $tray
  # A machine whose console is the tray does not also want a browser tab: opening both
  # would be the installer saying it is not sure which console it just installed.
  if (-not $NoOpen -and -not $tray.Installed) { Start-Process $uiUrl -ErrorAction SilentlyContinue }
}

# Backfills only what a Windows node cannot run without, and never touches a lane switch:
# turning a lane on during an upgrade is the operator's call.
function Update-ExistingConfig {
  $raw = Get-Content -LiteralPath $ConfigFile -Raw
  # A config that is empty, or holds nothing but whitespace. The zero-byte case already lands in
  # the catch below: Get-Content -Raw returns $null on both runtimes and ConvertFrom-Json refuses
  # to bind it on both. Whitespace does not. PowerShell 7 takes a blank string, emits nothing and
  # leaves $cfg as $null, so the catch never fires and the first Add-Member a few lines down
  # throws an uncaught stack trace instead of a message an operator can act on; Windows
  # PowerShell 5.1 rejects it as an invalid JSON primitive and dies cleanly. Checked here so both
  # runtimes say the same thing whatever the file holds.
  if ([string]::IsNullOrWhiteSpace($raw)) { Write-Die "$ConfigFile has no JSON in it; it is empty or only whitespace. Fix it by hand, then re-run - or delete it and re-run, and this installer will scaffold a fresh one." }
  try { $cfg = $raw | ConvertFrom-Json }
  catch { Write-Die "could not read $ConfigFile as JSON. Fix it by hand, then re-run." }

  $changed = New-Object Collections.Generic.List[string]
  if (-not (Get-Prop -Object $cfg -Name 'easytier')) {
    $cfg | Add-Member -NotePropertyName easytier -NotePropertyValue ([pscustomobject]@{}) -Force
  }
  foreach ($pair in @(@('rpcAddr', $RpcAddr), @('serviceName', $MeshServiceName), @('cliPath', $MeshCli))) {
    $k = $pair[0]; $v = $pair[1]
    $cur = Get-Prop -Object $cfg.easytier -Name $k
    # A Linux value on a Windows machine is worse than a missing one: Restart-Service on
    # 'easytier-fleet.service' fails, and /opt/easytier/easytier-cli does not exist here.
    $isPosix = ($cur -is [string]) -and ($cur -match '^/|\.service$')
    if (-not $cur -or $isPosix) {
      $cfg.easytier | Add-Member -NotePropertyName $k -NotePropertyValue $v -Force
      $changed.Add("easytier.$k")
    }
  }
  if (-not (Get-Prop -Object $cfg -Name 'admin')) {
    $cfg | Add-Member -NotePropertyName admin -NotePropertyValue ([pscustomobject]@{}) -Force
  }
  if (-not (Get-Prop -Object $cfg.admin -Name 'sshUser')) {
    $cfg.admin | Add-Member -NotePropertyName sshUser -NotePropertyValue $env:USERNAME -Force; $changed.Add('admin.sshUser')
  }
  if ($null -eq (Get-Prop -Object $cfg.admin -Name 'uiEnabled')) {
    $cfg.admin | Add-Member -NotePropertyName uiEnabled -NotePropertyValue $true -Force; $changed.Add('admin.uiEnabled')
  }

  if ($changed.Count -eq 0) {
    Write-Step "config exists at $ConfigFile; left untouched."
    return
  }
  # Temp file plus rename, so a daemon reading the config concurrently never sees half of one.
  $tmp = "$ConfigFile.install.tmp"
  Write-PrivateFile -Path $tmp -Content ((ConvertTo-Json $cfg -Depth 12) + "`r`n")

  # Rewriting the whole file to change three fields means trusting PowerShell's JSON serialiser
  # with a config the fleet depends on, and the serialiser differs between Windows PowerShell
  # and PowerShell 7. So the rewrite is checked against the original before it replaces it: same
  # top-level keys, same number of peers, same number of repos. A backfill that quietly drops a
  # peer would look exactly like a peer that went offline.
  if (-not (Test-ConfigRoundTrip -OriginalJson $raw -NewPath $tmp)) {
    Remove-Item -LiteralPath $tmp -Force -ErrorAction SilentlyContinue
    Write-Die "rewriting $ConfigFile would have changed more than the backfill, so it was left alone. Set these by hand instead, then re-run: $($changed -join ', ')."
  }

  Move-Item -LiteralPath $tmp -Destination $ConfigFile -Force
  Write-Step "config exists at $ConfigFile; backfilled $($changed -join ', ') (lane switches untouched)."
}

# Compares the rewritten config against the original on the things whose loss would be silent.
function Test-ConfigRoundTrip {
  param([Parameter(Mandatory)] [string] $OriginalJson, [Parameter(Mandatory)] [string] $NewPath)
  try {
    $before = $OriginalJson | ConvertFrom-Json
    $after = Get-Content -LiteralPath $NewPath -Raw | ConvertFrom-Json
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

# Windows defaults that quietly corrupt a repo shared with Linux machines.
function Initialize-SyncedRepo {
  param([Parameter(Mandatory)] [string] $Path)
  # autocrlf rewrites every line ending in the working tree. On a tree the daemon commits from,
  # that is a whole-repo diff on the first sync and a fight with the other machines forever.
  & git -C $Path config core.autocrlf false
  & git -C $Path config core.filemode false
  & git -C $Path config core.longpaths true
  # Symlinks check out as text files holding the target path unless Developer Mode is on. Git
  # keeps mode 120000 in the index either way, so status stays clean, but anything that
  # rewrites the file turns a symlink into a real file on every machine in the fleet.
  & git -C $Path config core.symlinks true
  $links = & git -C $Path ls-files -s
  $linkCount = @($links | Where-Object { $_ -match '^120000' }).Count
  if ($linkCount -gt 0) {
    $dev = Get-Prop -Name 'AllowDevelopmentWithoutDevLicense' -Default 0 -Object (
      Get-ItemProperty -Path 'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\AppModelUnlock' -ErrorAction SilentlyContinue)
    if ($dev -ne 1) {
      Write-Warn "$Path tracks $linkCount symlink(s) and Developer Mode is off, so git checks them out as plain text files. Turn on Settings > System > For developers > Developer Mode and re-clone, or leave this repo off this machine."
    }
  }
  Write-Step "prepared $Path for sync (autocrlf off, long paths on)"
}

function Register-NodeTask {
  param([Parameter(Mandatory)] [string] $Bun, [Parameter(Mandatory)] [string] $RepoRoot)

  $action = New-ScheduledTaskAction -Execute $Bun -Argument 'run src\node.ts' -WorkingDirectory $RepoRoot
  $trigger = New-ScheduledTaskTrigger -AtLogOn -User "$env:USERDOMAIN\$env:USERNAME"
  $settings = New-ScheduledTaskSettingsSet `
    -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable `
    -MultipleInstances IgnoreNew `
    -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) `
    -ExecutionTimeLimit (New-TimeSpan -Seconds 0) `
    -Hidden

  # S4U is the Windows answer to `loginctl enable-linger`: the node keeps running after you log
  # out, and it runs without a console window. It needs the "log on as a batch job" right, which
  # an administrator account normally has and a standard one normally does not. Try it, and fall
  # back rather than guess, because the fallback is a visible console window and a node that
  # stops at logout, which the operator deserves to be told about.
  $registered = $false
  foreach ($logon in @('S4U', 'Interactive')) {
    try {
      $principal = New-ScheduledTaskPrincipal -UserId "$env:USERDOMAIN\$env:USERNAME" -LogonType $logon -RunLevel Limited
      $task = New-ScheduledTask -Action $action -Trigger $trigger -Settings $settings -Principal $principal
      [void] (Register-ScheduledTask -TaskName $TaskName -InputObject $task -Force)
      $registered = $true
      if ($logon -eq 'S4U') { Write-Step "registered scheduled task '$TaskName' (runs whether or not you are logged in)" }
      else {
        Write-Step "registered scheduled task '$TaskName' (interactive)"
        Write-Warn 'this account cannot run a scheduled task while logged out, so two things follow. The node stops when you log off and starts again when you log on, which on a laptop is usually fine. And it runs in a visible console window, because the alternative is a launcher that exits immediately and leaves the task with nothing to supervise. Grant the account "Log on as a batch job" and re-run to get the quiet version.'
      }
      break
    } catch {
      if ($logon -eq 'Interactive') { Write-Die "could not register the scheduled task: $($_.Exception.Message)" }
    }
  }
  if (-not $registered) { Write-Die 'could not register the scheduled task.' }

  $running = (Get-Prop -Object (Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue) -Name 'State') -eq 'Running'
  if ($running -and $Restart) { Stop-ScheduledTask -TaskName $TaskName; Start-Sleep -Seconds 2; $running = $false }
  if (-not $running) { Start-ScheduledTask -TaskName $TaskName; Write-Step "started '$TaskName'" }
  else { Write-Note "'$TaskName' already running" }
}

# ---------------------------------------------------------------------------
# The native tray console
# ---------------------------------------------------------------------------
# One pin file serves both installers. install/easytier-pins.txt holds four whitespace-
# separated columns -- version, arch, sha256, asset -- and the asset name is what tells its
# consumers apart: quickstart.sh reads the lines starting 'sukarfleet-tray-linux-', this
# reads the ones starting 'sukarfleet-tray-windows-'. Reading the same file rather than
# mirroring hashes into a table here means a release fills one line and both platforms
# follow it. (The EasyTier hashes above are the exception, and say so.)
#
# Returns $null when there is no line for this arch, and throws for a file that
# contradicts itself: two lines for one (version, arch) mean nobody knows which SHA256 to
# trust, and taking the first is how a stale pin outlives the line meant to replace it.
# A pin that is not a pin is returned with Unfilled = $true rather than swallowed, so the
# caller can tell "no such build" from "not hashed yet" when it explains itself.
$script:PinUnfilled = @('TODO-S9', 'SHA256-FILLED-AT-RELEASE')

function Get-Pin {
  param(
    [Parameter(Mandatory)] [string] $PinsFile,
    [Parameter(Mandatory)] [string] $AssetPrefix,
    [Parameter(Mandatory)] [string] $Arch
  )
  if (-not (Test-Path -LiteralPath $PinsFile)) { return $null }
  $seen = @{}
  $filled = $null
  $unfilled = $null
  foreach ($line in (Get-Content -LiteralPath $PinsFile)) {
    $t = $line.Trim()
    if (-not $t -or $t.StartsWith('#')) { continue }
    $c = @($t -split '\s+')
    if ($c.Count -lt 4) { continue }
    if ($c[1] -ne $Arch) { continue }
    if (-not $c[3].StartsWith($AssetPrefix)) { continue }
    $key = "$($c[0]) $($c[1])"
    if ($seen.ContainsKey($key)) {
      throw "install\easytier-pins.txt has more than one $AssetPrefix pin for $key, so there is no single SHA256 to trust."
    }
    $seen[$key] = $true
    $pin = @{
      Version  = $c[0]
      Arch     = $c[1]
      Sha      = $c[2]
      Asset    = $c[3]
      Unfilled = ($script:PinUnfilled -contains $c[2])
    }
    # The first VALID pin wins whatever order the lines sit in, so an unfilled line never
    # shadows a real one.
    if ($pin.Unfilled) { if (-not $unfilled) { $unfilled = $pin } }
    elseif (-not $filled) { $filled = $pin }
  }
  if ($filled) { return $filled }
  return $unfilled
}

# The console WINDOW is a WebView2 host. Windows 11 ships the Evergreen runtime and
# Windows 10 may not, and the failure mode without it is invisible: the icon appears, the
# menu works, and clicking "Open fleet console" does nothing at all. Detected here so the
# banner can say it once, in advance, instead of leaving someone clicking.
function Get-WebView2Version {
  $clsid = '{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}'
  foreach ($root in @(
      'HKLM:\SOFTWARE\WOW6432Node\Microsoft\EdgeUpdate\Clients',
      'HKLM:\SOFTWARE\Microsoft\EdgeUpdate\Clients',
      'HKCU:\SOFTWARE\Microsoft\EdgeUpdate\Clients')) {
    $item = Get-ItemProperty -LiteralPath "$root\$clsid" -ErrorAction SilentlyContinue
    $pv = Get-Prop -Object $item -Name 'pv'
    if ($pv) { return [string] $pv }
  }
  return ''
}

# Installs the tray, or explains why this machine is not getting one. Nothing in here can
# fail the install: every path returns a reason and the caller falls back to the browser
# console. A machine with a daemon and a browser is installed; a machine with half a
# binary in LOCALAPPDATA is not.
function Install-Tray {
  param([Parameter(Mandatory)] [string] $RepoRoot)

  $result = @{ Installed = $false; Reason = ''; Detail = ''; Started = $false; WebView2 = '' }

  if ($SkipTray) { $result.Reason = '-SkipTray was passed'; return $result }

  $arch = switch ($env:PROCESSOR_ARCHITECTURE) {
    'AMD64' { 'x86_64' }
    'ARM64' { 'arm64' }
    default { '' }
  }
  if (-not $arch) {
    $result.Reason = "no tray build for processor architecture '$env:PROCESSOR_ARCHITECTURE'"
    return $result
  }

  $pinsFile = Join-Path $RepoRoot 'install\easytier-pins.txt'
  $pin = $null
  try { $pin = Get-Pin -PinsFile $pinsFile -AssetPrefix 'sukarfleet-tray-windows-' -Arch $arch }
  catch { $result.Reason = $_.Exception.Message; return $result }

  if (-not $pin) {
    $result.Reason = "no Windows tray pin for $arch in install\easytier-pins.txt"
    return $result
  }
  if ($pin.Unfilled) {
    # The honest state of a tree checked out between a commit and its tag. A pin nobody has
    # computed is not a pin, and an unverified download is worse than no download.
    $result.Reason = "no Windows tray binary has been released yet (its pin in install\easytier-pins.txt is still $($pin.Sha))"
    return $result
  }

  $base = $TrayReleaseBase
  if (-not $base) { $base = $env:SUKARFLEET_RELEASE_BASE }
  if (-not $base) { $base = "https://github.com/SUKARDADDY/sukarfleet/releases/download/v$($pin.Version)" }
  $base = $base.TrimEnd('/')

  $want = $pin.Sha.ToLower()
  $have = ''
  if (Test-Path -LiteralPath $TrayExe) {
    $have = (Get-FileHash -LiteralPath $TrayExe -Algorithm SHA256).Hash.ToLower()
  }

  if ($have -eq $want) {
    Write-Note "tray already at $TrayExe and on its pin - left untouched"
  } else {
    $tmp = Join-Path $env:TEMP "$($pin.Asset).download"
    Write-Step "downloading $($pin.Asset)"
    try { Invoke-WebRequest -Uri "$base/$($pin.Asset)" -OutFile $tmp -UseBasicParsing }
    catch {
      Remove-Item -LiteralPath $tmp -Force -ErrorAction SilentlyContinue
      $result.Reason = "could not download $($pin.Asset) from $base"
      $result.Detail = $_.Exception.Message
      return $result
    }
    $got = (Get-FileHash -LiteralPath $tmp -Algorithm SHA256).Hash.ToLower()
    if ($got -ne $want) {
      Remove-Item -LiteralPath $tmp -Force -ErrorAction SilentlyContinue
      $result.Reason = 'SHA256 mismatch against install\easytier-pins.txt'
      $result.Detail = "expected $want, got $got for $($pin.Asset). Report a checksum mismatch rather than retrying it."
      return $result
    }
    # Windows holds a running executable's image open, so an upgrade cannot overwrite a
    # tray that is running. Stopping it is what re-running the installer means, and it is
    # started again a few lines down.
    $running = @(Get-Process -Name 'sukarfleet-tray' -ErrorAction SilentlyContinue)
    if ($running.Count -gt 0) {
      Write-Note 'stopping the running tray so its binary can be replaced'
      $running | Stop-Process -Force -ErrorAction SilentlyContinue
      Start-Sleep -Seconds 1
    }
    [void] (New-Item -ItemType Directory -Force -Path $TrayDir)
    try { Move-Item -LiteralPath $tmp -Destination $TrayExe -Force }
    catch {
      Remove-Item -LiteralPath $tmp -Force -ErrorAction SilentlyContinue
      $result.Reason = "could not write $TrayExe"
      $result.Detail = $_.Exception.Message
      return $result
    }
    Write-Step "installed $TrayExe (SHA256 pinned)"
  }
  $result.Installed = $true

  # A Start menu entry, so the console can be reopened after Quit without hunting for a
  # path. Best effort, both of these: an installed tray with no shortcut is still a tray.
  try {
    $shell = New-Object -ComObject WScript.Shell
    $lnk = $shell.CreateShortcut($TrayShortcut)
    $lnk.TargetPath = $TrayExe
    $lnk.WorkingDirectory = $TrayDir
    $lnk.Description = 'sukarfleet console'
    $lnk.Save()
  } catch { Write-Warn "could not create the Start menu shortcut: $($_.Exception.Message)" }

  # Autostart. This is the same registry value the tray's own "Start at login" checkbox
  # toggles, written in the form that checkbox writes, so the installer and the tray never
  # disagree about whether it is on.
  try {
    if (-not (Test-Path -LiteralPath $RunKey)) { [void] (New-Item -Path $RunKey -Force) }
    Set-ItemProperty -LiteralPath $RunKey -Name $RunValueName -Value ('"' + $TrayExe + '"')
  } catch { Write-Warn "could not register the tray to start at sign-in: $($_.Exception.Message)" }

  $result.WebView2 = Get-WebView2Version

  $already = @(Get-Process -Name 'sukarfleet-tray' -ErrorAction SilentlyContinue)
  if ($already.Count -gt 0) {
    $result.Started = $true
  } else {
    # Started now rather than at the next sign-in, so the console is open when this script
    # finishes rather than tomorrow morning.
    try {
      [void] (Start-Process -FilePath $TrayExe -WorkingDirectory $TrayDir)
      $result.Started = $true
    } catch {
      Write-Warn "the tray is installed but would not start now: $($_.Exception.Message). It starts at your next sign-in."
    }
  }
  return $result
}

function Show-Banner {
  param([string] $UiUrl, [string] $RepoRoot, [string] $Bun, [bool] $SealOk, [hashtable] $Tray)

  $mesh = Get-Service -Name $MeshServiceName -ErrorAction SilentlyContinue
  Write-Host ''
  Write-Host '  ------------------------------------------------------------------------'
  Write-Host "  sukarfleet is installed on $MachineName."
  Write-Host ''
  if ($Tray -and $Tray.Installed) {
    Write-Host "  Console:  the sukarfleet icon in the notification area. Left click opens it;"
    Write-Host "            right click is the menu. $TrayExe"
    if (-not $Tray.WebView2) {
      Write-Host '            Its WINDOW needs the WebView2 runtime, which this machine does not have:'
      Write-Host '            the icon and the menu work, the window will not open. Until you install'
      Write-Host '            it (winget install --id Microsoft.EdgeWebView2Runtime) use the GUI below.'
    }
  } else {
    $why = if ($Tray) { $Tray.Reason } else { 'the tray was not attempted' }
    Write-Host "  Console:  the browser GUI below. No tray on this machine: $why."
    if ($Tray -and $Tray.Detail) { Write-Host "            $($Tray.Detail)" }
  }
  Write-Host "  GUI:      $UiUrl"
  Write-Host "  Source:   $RepoRoot"
  Write-Host "  Config:   $ConfigFile"
  Write-Host "  Task:     $TaskName  (Get-ScheduledTaskInfo -TaskName $TaskName)"
  Write-Host "  Run it in the foreground to watch it:"
  Write-Host "            Stop-ScheduledTask -TaskName $TaskName ; cd `"$RepoRoot`" ; & `"$Bun`" run src\node.ts"
  Write-Host ''
  if ($mesh -and $mesh.Status -eq 'Running') {
    Write-Host "  Mesh:     service '$MeshServiceName' is running."
  } else {
    Write-Host "  Mesh:     NOT running. Re-run this installer and accept the UAC prompt, or check"
    Write-Host "            Get-Service $MeshServiceName."
  }
  Write-Host ''
  Write-Host '  Next, in this order:'
  Write-Host "    1. Confirm this machine can reach the fleet: ping the mesh address of a machine"
  Write-Host '       already in it. No mesh, no pairing.'
  Write-Host '    2. Open the console and add the repos you want synced. Clone each one first; the'
  Write-Host '       daemon syncs repositories, it does not create them.'
  Write-Host '    3. Pair. Click Pair on a machine already in the fleet and type its code in here.'
  Write-Host ''
  Write-Host '  Two things this machine cannot do, so you are not surprised later:'
  Write-Host '    - The admin lane is off and stays off. Windows has no sudo, and the lane pipes a'
  Write-Host '      password to a tool that reads stdin. Run admin from a Linux machine.'
  Write-Host '    - NTFS carries ACLs rather than mode bits, so the store-privacy probe reports'
  Write-Host '      that mode is not enforced and the credential store refuses to hold a password.'
  if (-not $SealOk) {
    Write-Host '    - DPAPI did not round-trip for this user either, so nothing would be sealed.'
  }
  Write-Host ''
  Write-Host '    - Pairing refuses on Windows today. A pairing bundle has to carry an SSH host'
  Write-Host '      key and this machine has none: Windows ships the SSH client, not the server.'
  Write-Host '      The message you get says "no usable SSH identity yet". docs/PLATFORMS.md.'
  Write-Host ''
  Write-Host '  Sync, gossip, the GUI and MCP all work. See docs/PLATFORMS.md.'
  Write-Host '  ------------------------------------------------------------------------'
  Write-Host ''
}

# ===========================================================================
# Dispatch
# ===========================================================================

switch ($Stage) {
  'Elevated' { Invoke-ElevatedStage; exit 0 }
  'User'     { Invoke-UserStage; exit 0 }
}

# --- Auto: elevated stage first, in a child process, then the user stage here -------------

# Before the UAC prompt, not after it: the elevated stage installs EasyTier, registers a service
# and opens a firewall port, and none of that should happen on a machine the user stage is going
# to refuse two minutes later.
Invoke-Preflight

if (Test-Elevated) {
  # A warning, not a refusal. This fires whenever there is no UAC split token, which includes
  # an admin account running the installer from a scheduled task, where there is nobody to
  # answer a prompt and Read-Host on a session with no console turns the warning itself into a
  # crash. What it costs is a nuisance, not a broken install, so say what it costs, say how to
  # avoid it, and carry on.
  Write-Warn 'this whole session is elevated, so the config, the SSH key and the scheduled task will end up owned by an administrator, which is a nuisance to unpick later. Continuing anyway. To get the intended layout instead: close this window and double-click install\windows\Add-To-Fleet.cmd normally, WITHOUT "Run as administrator" - it asks for elevation itself, once, for the only stage that needs it.'
  Write-Host ''
  # Auto in an already-elevated session does the mesh work inline, so the output has to say
  # so. Without this the elevated stage's messages arrive tagged [quickstart], which sends you
  # looking in the wrong half of the script.
  $script:Tag = 'elevated'
  Invoke-ElevatedStage
  $script:Tag = 'quickstart'
  Invoke-UserStage
  exit 0
}

$meshReady = $false
if ($SkipMesh) {
  $meshReady = $true
  Write-Step 'skipping the mesh transport (-SkipMesh)'
} else {
  $svc = Get-Service -Name $MeshServiceName -ErrorAction SilentlyContinue
  if ($svc -and -not $ForceMeshReinstall) {
    Write-Step "mesh service '$MeshServiceName' already registered; skipping the elevated stage."
    $meshReady = $true
  }
}

if (-not $meshReady) {
  # Stage the secret here, in the user's own context, so the elevated child receives a path and
  # never an argument. The same reason the Linux GUI stages it for install-elevated.sh.
  $secretPath = $MeshSecretFile
  if (-not $secretPath -and (Test-Path -LiteralPath $PendingSecret)) { $secretPath = $PendingSecret }
  if (-not $secretPath) {
    Write-Host ''
    Write-Host '  The mesh network secret. Every machine in one fleet shares it, and it is the only'
    Write-Host '  thing standing between your fleet and anyone who finds the port. On a Linux fleet'
    Write-Host '  machine it is the network_secret line in /etc/easytier/fleet.toml, readable as root.'
    Write-Host '  It is not echoed, and it is written to a file only you can read, which the elevated'
    Write-Host '  stage consumes and overwrites.'
    Write-Host ''
    $sec = Read-Host -Prompt '  network secret' -AsSecureString
    $bstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($sec)
    try { $plain = [Runtime.InteropServices.Marshal]::PtrToStringAuto($bstr).Trim() }
    finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr) }
    if (-not $plain) { Write-Die 'the network secret is empty; nothing was installed.' }
    New-PrivateDir -Path $StateDir -Label 'state dir'
    Write-PrivateFile -Path $PendingSecret -Content ($plain + "`n")
    $plain = $null
    $secretPath = $PendingSecret
  }
  # Whose file is it? Ours to shred if we staged it (or found our own leftover); the operator's
  # to keep if -MeshSecretFile named something else. The elevated child answers the same
  # question with the same function, so the two stages cannot disagree about it.
  $secretIsOurs = Test-StagedSecretPath -Path $secretPath

  $childArgs = @(
    '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', "`"$PSCommandPath`"",
    '-Stage', 'Elevated',
    '-MachineName', "`"$MachineName`"",
    '-Role', $Role,
    '-NodePort', $NodePort,
    '-NetworkName', "`"$NetworkName`"",
    '-ListenPort', $ListenPort,
    '-RpcAddr', "`"$RpcAddr`"",
    '-MeshServiceName', "`"$MeshServiceName`"",
    '-EasyTierVersion', "`"$EasyTierVersion`"",
    '-MeshSecretFile', "`"$secretPath`"",
    '-UserProfileDir', "`"$UserHome`""
  )
  if ($MeshIp) { $childArgs += @('-MeshIp', "`"$MeshIp`"") }
  if ($ForceMeshReinstall) { $childArgs += '-ForceMeshReinstall' }
  # Repeating -PeerUri on a command line binds only the last one. A [string[]] parameter takes
  # a comma-joined list instead, so every peer actually reaches the child.
  if ($PeerUri.Count -gt 0) {
    $childArgs += @('-PeerUri', (($PeerUri | ForEach-Object { '"' + $_ + '"' }) -join ','))
  }

  Write-Host ''
  Write-Step 'the next step needs administrator rights. It installs the mesh transport, writes its config, registers one service and opens one firewall port. Accept the UAC prompt.'
  try {
    $proc = Start-Process -FilePath 'powershell.exe' -ArgumentList $childArgs -Verb RunAs -Wait -PassThru
  } catch {
    if ($secretIsOurs) { Remove-SecretFile -Path $secretPath }
    $shredNote = if ($secretIsOurs) { 'The staged secret was shredded. ' } else { '' }
    Write-Die "elevation was refused or failed: $($_.Exception.Message)`n$($shredNote)Re-run when you can accept the prompt, or pass -SkipMesh if this machine already has the mesh."
  }
  # Start-Process -Verb RunAs goes through ShellExecute, which does not always populate
  # ExitCode. Rather than trust a field that may be null, ask the question the exit code was
  # standing in for: is the mesh service there now?
  $exit = Get-Prop -Object $proc -Name 'ExitCode'
  $svcNow = Get-Service -Name $MeshServiceName -ErrorAction SilentlyContinue
  if (-not $svcNow) {
    if ($secretIsOurs) { Remove-SecretFile -Path $secretPath }
    Write-Die "the elevated stage did not leave a '$MeshServiceName' service behind$(if ($null -ne $exit) { " (exit $exit)" }). Nothing user-level was changed. Scroll up in the elevated window for the reason."
  }
  if ($null -ne $exit -and $exit -ne 0) {
    Write-Warn "the elevated stage reported exit $exit, but the '$MeshServiceName' service does exist. Carrying on; check the mesh before you rely on it."
  }
  # Belt and braces. The elevated stage shreds the staged file the moment it has consumed it,
  # so by now this is normally a no-op; it still covers the runs that ended before that point.
  # Remove-SecretFile returns quietly when the file is already gone, which is the usual case,
  # so nothing here announces a shred that did not happen.
  if ($secretIsOurs) { Remove-SecretFile -Path $secretPath }
}

Invoke-UserStage
