# SPDX-License-Identifier: AGPL-3.0-or-later
<#
.SYNOPSIS
  Reads install/easytier-pins.txt and fetches a binary against the line it finds.

.DESCRIPTION
  Dot-sourced by Install-MachineNode.ps1 and Uninstall-MachineNode.ps1. Install-Sukarfleet.ps1
  keeps its own copy of Get-Pin, because this PR does not edit that script; the semantics here
  are the same semantics, and a change to one is a change owed to the other.

  Two functions:

    Get-Pin          the parser. One line per (version, arch, asset prefix); a second line for
                     one (version, arch) is a refusal rather than a coin toss; a filled pin
                     always beats an unfilled one whatever order the lines sit in; an unfilled
                     pin comes back flagged rather than swallowed, so the caller can tell
                     "no such build" from "not hashed yet" when it explains itself.

    Get-PinnedAsset  the download. Fetches to a temp file, checks the SHA256 against the pin,
                     and returns the path. It throws on every failure, including an unfilled
                     pin, so a caller that must have the file (Bun, WinSW) can let the throw
                     kill the install while a caller that can live without it (the tray) can
                     catch it and carry on with a reason to print.

.NOTES
  Windows PowerShell 5.1. No ternary, no null-coalescing, no PS7-only syntax.
#>

# The two tokens that mean "this is not a pin". TODO-S9 is "no such build exists";
# SHA256-FILLED-AT-RELEASE is "built from this tree, so its hash cannot exist until the tag
# does". Both are unverifiable, so both are refused here; the difference is only what they
# tell a reader of install/easytier-pins.txt.
$script:PinUnfilledTokens = @('TODO-S9', 'SHA256-FILLED-AT-RELEASE')

function Write-PinStep { param([string] $Message) Write-Host "[pins] $Message" }

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
      Unfilled = ($script:PinUnfilledTokens -contains $c[2])
    }
    if ($pin.Unfilled) { if (-not $unfilled) { $unfilled = $pin } }
    elseif (-not $filled) { $filled = $pin }
  }
  if ($filled) { return $filled }
  return $unfilled
}

# Fetches one pinned asset and returns the path to the verified temp file. The caller owns
# that file and deletes it.
#
# -UrlFormat is a .NET format string: {0} is the pin's version column, {1} is the asset name,
# which is the upstream release filename on every line of the pin file.
function Get-PinnedAsset {
  param(
    [Parameter(Mandatory)] [string] $PinsFile,
    [Parameter(Mandatory)] [string] $AssetPrefix,
    [Parameter(Mandatory)] [string] $Arch,
    [Parameter(Mandatory)] [string] $UrlFormat,
    [Parameter(Mandatory)] [string] $Label
  )

  $pin = Get-Pin -PinsFile $PinsFile -AssetPrefix $AssetPrefix -Arch $Arch
  if (-not $pin) {
    throw "install\easytier-pins.txt has no $Label pin for $Arch, so there is nothing to verify a download against."
  }
  if ($pin.Unfilled) {
    throw "the $Label pin in install\easytier-pins.txt is still $($pin.Sha), which is a placeholder and not a hash. Nothing is downloaded against it: an unverified download is worse than no download."
  }

  $asset = $pin.Asset
  $url = [string]::Format($UrlFormat, $pin.Version, $asset)
  $tmp = Join-Path $env:TEMP "sukarfleet-pin-$([Guid]::NewGuid().ToString('N'))-$asset"

  Write-PinStep "downloading $Label $($pin.Version) ($asset)"
  try { Invoke-WebRequest -Uri $url -OutFile $tmp -UseBasicParsing }
  catch {
    Remove-Item -LiteralPath $tmp -Force -ErrorAction SilentlyContinue
    throw "could not download $Label from $url : $($_.Exception.Message)"
  }

  $want = $pin.Sha.ToLower()
  $got = (Get-FileHash -LiteralPath $tmp -Algorithm SHA256).Hash.ToLower()
  if ($got -ne $want) {
    Remove-Item -LiteralPath $tmp -Force -ErrorAction SilentlyContinue
    throw "SHA256 mismatch for $asset against install\easytier-pins.txt: expected $want, got $got. Report a checksum mismatch rather than retrying it."
  }
  Write-PinStep "SHA256 verified against the pin for $Label $($pin.Version)/$Arch"
  return $tmp
}
