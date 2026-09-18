# SPDX-License-Identifier: AGPL-3.0-or-later
#
# Uninstall-UserNode.ps1 -- what the per-user uninstaller runs before it removes its files.
#
# Stops and unregisters the scheduled task that starts this account's node, stops the tray and
# removes its autostart value. Leaves the config, the machine key, the SSH key and the synced
# repositories where they are: deleting them silently breaks the fleet's other machines, which
# is not this script's call to make. Say what was left so nobody has to guess.
#
# Runs unelevated, as the account that installed. Nothing here needs more.

[CmdletBinding()]
param(
  [string] $TaskName = 'sukarfleet',
  [string] $RunValueName = 'sukarfleet-tray'
)

$ErrorActionPreference = 'Continue'

function Write-Line { param([string] $m) Write-Host ("[uninstall] {0}" -f $m) }

$task = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
if ($task) {
  # Stopping the task ends the node it started; Task Scheduler owns that process tree.
  try { Stop-ScheduledTask -TaskName $TaskName -ErrorAction Stop } catch { }
  try {
    Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false -ErrorAction Stop
    Write-Line "stopped and unregistered the scheduled task '$TaskName'"
  } catch {
    Write-Line "could not unregister the scheduled task '$TaskName': $($_.Exception.Message)"
  }
} else {
  Write-Line "no scheduled task '$TaskName' to remove"
}

# The node may outlive its task for a moment; give it a few seconds to let go of the port.
for ($i = 0; $i -lt 10; $i++) {
  $held = Get-NetTCPConnection -LocalPort 7710 -State Listen -ErrorAction SilentlyContinue
  if (-not $held) { break }
  Start-Sleep -Seconds 1
}

Get-Process -Name 'sukarfleet-tray' -ErrorAction SilentlyContinue | ForEach-Object {
  try { $_.Kill(); Write-Line 'stopped the tray' } catch { }
}
$runKey = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run'
if (Get-ItemProperty -Path $runKey -Name $RunValueName -ErrorAction SilentlyContinue) {
  Remove-ItemProperty -Path $runKey -Name $RunValueName -ErrorAction SilentlyContinue
  Write-Line "removed the tray autostart value '$RunValueName'"
}
$shortcut = Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs\sukarfleet console.lnk'
if (Test-Path -LiteralPath $shortcut) { Remove-Item -LiteralPath $shortcut -Force -ErrorAction SilentlyContinue }

$configDir = Join-Path $env:USERPROFILE '.config\sukarfleet'
$stateDir = Join-Path $env:USERPROFILE '.local\state\sukarfleet'
Write-Line "left in place: $configDir (identity and peers), $stateDir, the fleet SSH key under .ssh, and every synced repository."
Write-Line 'the other machines in the fleet still list this one as a peer until you remove it there.'
exit 0
