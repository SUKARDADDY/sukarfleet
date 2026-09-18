# SPDX-License-Identifier: AGPL-3.0-or-later
<#
.SYNOPSIS
  Removes the machine-wide sukarfleet service and the binaries it ran, and nothing else.

.DESCRIPTION
  Run by the uninstaller of install/windows/sukarfleet.iss in its machine-wide scope, and safe to
  run by hand.

  It takes away the moving parts, each named rather than swept: the service, the WinSW wrapper and
  its xml, the Bun it fetched, the tray binary and the registry value that started it. It does not
  remove the directory those sit in, because Inno's own uninstaller is running from a subdirectory
  of it. It leaves the data, on purpose, because an uninstall that deletes a fleet identity and a
  synced tree is not an uninstall, it is a loss:

    C:\ProgramData\sukarfleet\node   identity, config, state, audit log, console token
    the shared root                  every repo the node was syncing
    easytier-fleet                   the mesh transport, which other machines may route through
    C:\ProgramData\Git\config        the safe.directory line every account reads
    profile directories              the traverse entries that open the path to a repo adopted
                                     in place

  It says all of that at the end, and it says the thing people forget: every other machine in the
  fleet still lists this one in its peers[], and will keep calling a number that stops answering.

.NOTES
  Windows PowerShell 5.1 only: no ternary, no null-coalescing, no PS7-only syntax.
#>

[CmdletBinding()]
param(
  # Only used to name the tree in the closing message; nothing under it is touched.
  [string] $AppDir = '',
  [string] $SharedRoot = 'C:\AI_Agent'
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version 2.0

$script:Started = Get-Date
function Get-Elapsed { return [int] ((Get-Date) - $script:Started).TotalSeconds }
function Write-Step { param([string] $m) Write-Host ("[machine] {0,-6} {1}" -f "t+$(Get-Elapsed)s", $m) }
function Write-Note { param([string] $m) Write-Host ("[machine] {0,-6} {1}" -f "t+$(Get-Elapsed)s", $m) -ForegroundColor DarkGray }
function Write-Warn { param([string] $m) Write-Host ("[machine] {0,-6} WARNING: {1}" -f "t+$(Get-Elapsed)s", $m) -ForegroundColor Yellow }
function Write-Die  { param([string] $m) Write-Host ("[machine] {0,-6} ERROR: {1}" -f "t+$(Get-Elapsed)s", $m) -ForegroundColor Red; exit 1 }

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

$ServiceId    = 'sukarfleet-node'
$MeshService  = 'easytier-fleet'
$ProgramRoot  = Join-Path $env:ProgramFiles 'sukarfleet'
$BunDir       = Join-Path $ProgramRoot 'bun'
$WinSwExe     = Join-Path $ProgramRoot 'sukarfleet-node.exe'
$WinSwXml     = Join-Path $ProgramRoot 'sukarfleet-node.xml'
$TrayExe      = Join-Path $ProgramRoot 'sukarfleet-tray.exe'
$NodeDir      = Join-Path $env:ProgramData 'sukarfleet\node'
$SystemGitConfig = Join-Path $env:ProgramData 'Git\config'
$HklmRunKey   = 'HKLM:\Software\Microsoft\Windows\CurrentVersion\Run'
$RunValueName = 'sukarfleet-tray'
$StartMenuLnk = Join-Path $env:ProgramData 'Microsoft\Windows\Start Menu\Programs\sukarfleet console.lnk'

if (-not (Test-Elevated)) {
  Write-Die 'removing a Windows service and writing under C:\Program Files needs administrator rights. Nothing was removed.'
}

# --- the service ------------------------------------------------------------
$svc = Get-Service -Name $ServiceId -ErrorAction SilentlyContinue
if ($svc) {
  if (Test-Path -LiteralPath $WinSwExe) {
    if ($svc.Status -ne 'Stopped') {
      [void] (Invoke-Native -Exe $WinSwExe -Arguments @('stop'))
      Start-Sleep -Seconds 3
    }
    $r = Invoke-Native -Exe $WinSwExe -Arguments @('uninstall')
    if ($r.ExitCode -ne 0) { Write-Warn "sukarfleet-node.exe uninstall exited $($r.ExitCode): $(($r.Output | Out-String).Trim())" }
  } else {
    # The wrapper is gone but the service registration is not. sc.exe is the fallback, because
    # leaving a registered service pointing at a deleted binary is worse than either state.
    Write-Warn "$WinSwExe is missing, so the service is being removed with sc.exe instead."
    [void] (Invoke-Native -Exe 'sc.exe' -Arguments @('stop', $ServiceId))
    Start-Sleep -Seconds 3
    [void] (Invoke-Native -Exe 'sc.exe' -Arguments @('delete', $ServiceId))
  }
  Start-Sleep -Seconds 2
  if (Get-Service -Name $ServiceId -ErrorAction SilentlyContinue) {
    Write-Warn "the '$ServiceId' service is still registered. Windows sometimes holds a service until every handle to it closes; it usually goes at the next reboot. Check with: Get-Service $ServiceId"
  } else {
    Write-Step "removed the '$ServiceId' service"
  }
} else {
  Write-Note "no '$ServiceId' service on this machine"
}

# --- the tray ---------------------------------------------------------------
$trayProcs = @(Get-Process -Name 'sukarfleet-tray' -ErrorAction SilentlyContinue)
if ($trayProcs.Count -gt 0) {
  $trayProcs | Stop-Process -Force -ErrorAction SilentlyContinue
  Start-Sleep -Seconds 1
  Write-Step 'stopped the running tray'
}

try {
  if (Get-ItemProperty -LiteralPath $HklmRunKey -Name $RunValueName -ErrorAction SilentlyContinue) {
    Remove-ItemProperty -LiteralPath $HklmRunKey -Name $RunValueName -Force
    Write-Step "removed the '$RunValueName' value from HKLM Run"
  }
} catch { Write-Warn "could not remove the HKLM Run value '$RunValueName': $($_.Exception.Message)" }

if (Test-Path -LiteralPath $StartMenuLnk) {
  Remove-Item -LiteralPath $StartMenuLnk -Force -ErrorAction SilentlyContinue
  Write-Step 'removed the Start menu entry'
}

# --- the binaries -----------------------------------------------------------
# By name, one at a time, and never the tree they sit in. Inno installs the application into
# {app}, which is a subdirectory of $ProgramRoot, and unins000.exe -- the process running this
# script -- lives in there with it. A recursive Remove-Item on $ProgramRoot deletes the
# uninstaller out from under itself mid-run and leaves an uninstall entry pointing at nothing.
# Inno removes {app} and the uninstaller once this script returns, and the [UninstallDelete]
# entry in sukarfleet.iss takes $ProgramRoot itself away after that, if it is empty by then.
$installedByUs = @(
  $BunDir,
  $WinSwExe,
  $WinSwXml,
  $TrayExe
)
$removed = @()
foreach ($item in $installedByUs) {
  if (-not (Test-Path -LiteralPath $item)) { continue }
  try {
    Remove-Item -LiteralPath $item -Recurse -Force
    $removed += (Split-Path -Leaf $item)
  } catch {
    Write-Warn "could not remove $item : $($_.Exception.Message). Something still has it open; delete it after a reboot."
  }
}
if ($removed.Count -gt 0) {
  Write-Step "removed $($removed -join ', ') from $ProgramRoot"
} else {
  Write-Note "nothing of the machine-wide install left to remove from $ProgramRoot"
}

# --- what is deliberately still here ----------------------------------------
$mesh = Get-Service -Name $MeshService -ErrorAction SilentlyContinue
$meshState = 'not installed'
if ($mesh) { $meshState = [string] $mesh.Status }

Write-Host ''
Write-Host '  ------------------------------------------------------------------------'
Write-Host '  The machine-wide sukarfleet node is removed. These were left alone,'
Write-Host '  because deleting them would be losing data rather than uninstalling software:'
Write-Host ''
Write-Host "    $NodeDir"
Write-Host '      This machine''s fleet identity, its config, its state, its audit log and its'
Write-Host '      console token. Re-installing adopts all of it and the fleet never notices.'
Write-Host ''
Write-Host "    $SharedRoot"
Write-Host '      Every repository the node was syncing. Nothing in it was touched.'
Write-Host ''
Write-Host "    the '$MeshService' service ($meshState)"
Write-Host '      The mesh transport. Other machines may be routing through this one.'
Write-Host ''
Write-Host "    the safe.directory line in $SystemGitConfig"
Write-Host '      It is what lets every account on this machine run git in the shared tree.'
Write-Host '      That file is not ours to rewrite, and the line is harmless on its own.'
Write-Host ''
Write-Host '    the traverse entries on the profile directories above any repository that was'
Write-Host '    adopted in place'
Write-Host '      One access entry per directory, for the service account, opening the path and'
Write-Host '      nothing in it. They are left because the repositories they lead to are left.'
Write-Host ''
Write-Host '  Delete them by hand if you mean it:'
Write-Host "    Remove-Item -Recurse `"$NodeDir`""
Write-Host "    & `"$($env:ProgramFiles)\EasyTier\easytier-cli.exe`" service --name $MeshService uninstall"
Write-Host ''
Write-Host '  One thing to do elsewhere. Every other machine in the fleet still lists this one'
Write-Host '  in its peers[], and will keep calling a number that no longer answers. Drop it'
Write-Host '  from their console, or their fault list will fill up with this machine.'
Write-Host '  ------------------------------------------------------------------------'
Write-Host ''

exit 0
