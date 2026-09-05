# Adding a Windows machine

Double-click `Add-To-Fleet.cmd`. That is the install.

Run it normally, not as administrator. It asks for elevation itself, once, for the only part
that needs it, and it needs everything else to run as you: your config, your SSH key, your
scheduled task. A node whose config is owned by an administrator account is a nuisance to
unpick later.

## Before you start

Have three things in hand. The installer will ask for all of them and cannot guess any.

The **network secret**, shared by every machine in the fleet. On a Linux fleet machine it is
the `network_secret` line in `/etc/easytier/fleet.toml`, readable only as root. The setup GUI
will not show it to you: it can reveal a secret it staged for an installer, and on a machine
that finished installing there is nothing staged. Read it off the anchor.

A **free address on the fleet's mesh subnet**. Look at `meshIp` in any existing machine's
`~/.config/sukarfleet/config.json` and pick one nobody has.

The **address of a machine already in the fleet**, reachable from this one before any mesh
exists. That means a LAN or WAN address and the EasyTier listener port, not a mesh address.
Written as `tcp://198.51.100.7:11010`.

You also need Git for Windows on PATH (`winget install --id Git.Git`) and the OpenSSH client,
which Windows 10 and 11 ship as an optional feature. Both are checked before anything is
downloaded or installed, so a machine that is missing one is refused while it is still
untouched. Bun is installed for you if it is missing, pinned to the version this tree's
`bun.lock` was resolved against, the same one `install/quickstart.sh` gives a Linux machine.

## What it does

Two stages, and every line of output says which one it is in.

**Elevated**, behind one UAC prompt. Downloads EasyTier, checks it against a SHA256 pinned in
the script, and installs it to `C:\Program Files\EasyTier`. Writes the mesh config to
`C:\ProgramData\sukarfleet\easytier\fleet.toml` with an ACL that admits only Administrators
and SYSTEM, because it holds the network secret in plaintext. Registers the mesh as a Windows
service, opens the firewall for that one binary on that one port, and turns on NTFS long paths.

**User**, with no special rights. Installs Bun, runs `bun install`, generates this machine's
fleet SSH key, scaffolds `~/.config/sukarfleet/config.json`, registers the node as a scheduled
task, starts it, and waits for `/health`.

The secret never appears in an argument. You type it in the unelevated stage, it goes to a file
only you can read, the elevated stage consumes that file and overwrites it. Same reason the
Linux GUI stages a secret for `install-elevated.sh` instead of passing it on a command line.

Re-running is safe and is the upgrade path. Add `-Restart` to bounce the node.

## What it deliberately leaves undone

The config lands with `repos: []` and `peers: []`.

Peers arrive through GUI pairing, which exchanges the mesh key, the SSH key and the SSH host
keys in both directions. There is nothing to paste by hand.

Repos are empty because a repo path is machine-local and a wrong one here syncs the wrong tree.
Clone what you want synced, then add it in the GUI, or pass `-Repo name=C:\path\to\repo` and
the installer will set the Windows-hostile git defaults for you: `core.autocrlf false`,
`core.longpaths true`, `core.filemode false`, `core.symlinks true`. The daemon syncs
repositories. It does not clone them.

One thing to check before you sync a repo that Linux machines also write to. If it tracks
symlinks and Developer Mode is off, git checks them out as text files holding the target path.
Status stays clean, so you will not notice, right up until something rewrites one and every
machine in the fleet gets a real file where a symlink used to be. The installer counts the
symlinks in any repo you pass and says so.

## What this machine will not be able to do

The admin lane cannot elevate on Windows. Its design is to pipe one password line to a tool
that reads stdin, and Windows has no such tool. UAC is a different mechanism with a different
threat model, and pretending otherwise would produce the kind of confidently wrong answer this
project refuses to give. The installer writes `admin.enabled: false` and leaves it there.
Sync, gossip, pairing, the GUI and MCP are unaffected. Drive admin from a Linux machine.

NTFS carries ACLs rather than POSIX mode bits, so the daemon's store-privacy probe reports
that mode is not enforced and the credential store refuses to hold a password. That is the
honest answer, and it follows from the paragraph above anyway.

`docs/PLATFORMS.md` is specific about the rest.

## After it finishes

In this order, because each step needs the one before it.

1. Ping the mesh address of a machine already in the fleet. No mesh, no pairing.
2. Open `http://127.0.0.1:7710/ui/` and add the repos you want synced.
3. Pair. Click Pair on a machine already in the fleet and type its code in here.

## Checking on it

```powershell
Get-ScheduledTaskInfo -TaskName sukarfleet     # last run, last result, next run
Get-Service easytier-fleet                     # the mesh transport
Invoke-WebRequest http://127.0.0.1:7710/health -UseBasicParsing
```

To watch the node in the foreground, stop the task and run it by hand:

```powershell
Stop-ScheduledTask -TaskName sukarfleet
cd <checkout> ; & "$env:USERPROFILE\.bun\bin\bun.exe" run src\node.ts
```

## Options worth knowing

```
-MachineName <name>     default: %COMPUTERNAME%
-Role anchor|roamer     default: roamer
-MeshIp <a.b.c.d>       this machine's mesh address
-PeerUri <uri>          repeatable; a machine already in the fleet
-MeshSecretFile <path>  a file holding the secret, instead of typing it
-Repo name=<path>       a cloned repo to sync; repeatable
-Source <dir-or-zip>    where the sukarfleet source is; defaults to this checkout
-SkipMesh               this machine already has the mesh transport
-Restart                bounce the node after installing
```

Never pass the secret as an argument. There is no flag for it, on purpose: argv is readable by
every process on the machine and lands in your shell history.

## Removing it

```powershell
Stop-ScheduledTask -TaskName sukarfleet
Unregister-ScheduledTask -TaskName sukarfleet -Confirm:$false
& "C:\Program Files\EasyTier\easytier-cli.exe" service uninstall --name easytier-fleet   # as admin
Remove-NetFirewallRule -DisplayName "sukarfleet mesh (TCP 11010)"                        # as admin
Remove-NetFirewallRule -DisplayName "sukarfleet mesh (UDP 11010)"                        # as admin
```

That leaves `~/.config/sukarfleet`, `~/.local/state/sukarfleet`, the SSH key and
`C:\ProgramData\sukarfleet` in place. Delete them if you mean it. Remember to drop this
machine from the other machines' `peers[]`, or they will keep calling a number that no longer
answers.
