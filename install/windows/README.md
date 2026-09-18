# Adding a Windows machine

There are three ways in. Pick the first one unless you have a reason not to.

1. **The installer**, `sukarfleet-setup-windows-x86_64.exe`. One file, two scopes: this account,
   or the whole machine.
2. **A generated installer** from the console, which carries its own answers and pairs itself.
3. **The PowerShell script by hand**, which is what the other two run.

## 1. The installer

Download `sukarfleet-setup-windows-x86_64.exe` from this project's release, or from the
`installer-windows` workflow's artifact if you are installing a build that has no tag yet.
Check it against the `sukarfleet-setup-windows-` line in `install/easytier-pins.txt`:

```powershell
Get-FileHash .\sukarfleet-setup-windows-x86_64.exe -Algorithm SHA256
```

### Windows will warn you about it

The EXE is not code-signed yet, so SmartScreen says "Windows protected your PC" and hides the
Run button behind **More info**. That warning is accurate: nobody has paid for a certificate
that vouches for this file. The SHA256 above is the trust anchor until one exists. Nothing in
the installer tries to suppress the warning, because an installer that teaches you to click
through SmartScreen has taught you the wrong habit.

### Which scope

The first page of the wizard asks. `/CURRENTUSER` and `/ALLUSERS` choose it on a command line.

**Per-user** is the install this project has always had, now with a wizard in front of it. The
node belongs to your account and a scheduled task starts it when you log on. It writes:

| Path | What |
| --- | --- |
| `%LOCALAPPDATA%\sukarfleet\app` | the source the node runs from |
| `%USERPROFILE%\.config\sukarfleet` | config, machine key, credential store |
| `%USERPROFILE%\.local\state\sukarfleet` | state, known hosts, audit log |
| `%USERPROFILE%\.ssh\id_sukarfleet_ed25519` | this machine's fleet key |
| `%LOCALAPPDATA%\Programs\sukarfleet` | the tray console |
| scheduled task `sukarfleet` | what starts the node |

**Machine-wide** installs a Windows service. The node is answering after a reboot with nobody
logged in, every account on the machine can operate it, and the repositories it syncs live
somewhere every account can reach. It writes:

| Path | What |
| --- | --- |
| `C:\Program Files\sukarfleet\app` | the source the service runs from |
| `C:\Program Files\sukarfleet\bun` | Bun, fetched against its pin |
| `C:\Program Files\sukarfleet\sukarfleet-node.exe` | WinSW, fetched against its pin, plus its `.xml` |
| `C:\Program Files\sukarfleet\sukarfleet-tray.exe` | the tray console |
| `C:\ProgramData\sukarfleet\node` | config, machine key, secrets, state, logs, console token |
| `C:\AI_Agent` | the shared root, where synced repositories live |
| service `sukarfleet-node` | what starts the node, automatically, at boot |
| `HKLM\...\Run\sukarfleet-tray` | starts the tray for whoever signs in |
| `C:\ProgramData\Git\config` | one `safe.directory` line for the shared root |

The service runs as `NT SERVICE\sukarfleet-node`, a virtual account that exists only for this
service. It is not SYSTEM. On a machine that refuses to grant that account the right to log on
as a service, the installer falls back to `NT AUTHORITY\LocalService` and says so in its banner;
`LocalService` is shared with other services, which is why it is the fallback and not the
default.

The service depends on `easytier-fleet`, so it waits for the mesh transport at boot. On a
machine installed with `/SKIPMESH` and no mesh service, it declares no dependency, because a
dependency on a service that does not exist stops a service from ever starting.

### What the wizard asks

The machine name (defaults to this computer's name), the role, this machine's mesh address, a
machine already in the fleet to dial, and the fleet's network secret. Machine-wide also asks for
the shared root, and, when this machine already runs a per-user node, whether to adopt it.

The secret is never an argument. You type it, it goes to a file with inheritance broken and one
account on it, and the installer scripts consume that file and overwrite it. Same reason the
Linux GUI stages a secret for `install-elevated.sh`.

### Silent switches

```
/CURRENTUSER            per-user scope
/ALLUSERS               machine-wide scope
/MACHINE=<name>         this machine's name in the fleet
/ROLE=anchor|roamer     default roamer
/MESHIP=<a.b.c.d>       this machine's mesh address
/PEER=<uri>[,<uri>]     a machine already in the fleet, e.g. tcp://198.51.100.7:11010
/MESHSECRETFILE=<path>  a file holding the network secret, one line
/SHAREDROOT=<path>      machine-wide only; default C:\AI_Agent
/ADOPT=1                machine-wide only; adopt the existing per-user node
/SKIPMESH               the mesh transport is already installed here
/SKIPTRAY               no tray console; use the browser GUI
/NOOPEN                 do not open a browser when the install finishes
```

Inno Setup's own switches work too: `/VERYSILENT`, `/SUPPRESSMSGBOXES`, `/LOG=<path>`, `/DIR=`.
A file you name with `/MESHSECRETFILE` is yours, so the installer reads it and leaves it where
it is. Delete it once the mesh is up: it holds the fleet secret in plaintext.

A machine-wide silent install with no `/MESHIP` and no `/SKIPMESH` is refused rather than left
sitting at a prompt nobody is watching.

### The console token

A machine-wide node is reachable from any account on the PC, so it asks for a token before it
will answer the console. The installer writes it to:

```
C:\ProgramData\sukarfleet\node\console-token
```

Every local account can read that file, and every local account can therefore drive this node.
That is the ruling, not an oversight: on a machine-wide install, whoever is at the machine is an
operator. The console prompts for the token once and remembers it for the tab; the tray reads
the file itself and never asks. `SECURITY.md` carries the one `icacls` line that narrows the
file to a group instead.

A per-user install writes no token and asks for none. Nothing changes for it.

### The shared root

`C:\AI_Agent` by default. It is owned by Administrators, and the service account and every local
account can write in it. That combination is what lets the daemon commit a file you created by
hand, and lets you edit a file the daemon checked out.

The daemon syncs repositories. It does not clone them. Clone what you want synced into the
shared root, then add it in the console.

### Adopting an existing node

One identity per PC. If this machine already runs a per-user node, a machine-wide install is
refused unless you adopt it, because a fleet that sees this machine twice has two halves
fighting over the same repositories.

Adoption exports the scheduled task to `C:\ProgramData\sukarfleet\node\adopted-task-sukarfleet.xml`
(that export is the way back), unregisters the task, then copies the machine key, the config,
the credential store, the state directory, the fleet SSH key and the sukarfleet lines out of
`authorized_keys`. The machine keeps its place in the fleet and nothing re-pairs.

Most repositories the old node was syncing are renamed into the shared root -- a single
`Directory.Move`, which is atomic and keeps links as links. (`robocopy /MOVE` was tried first and
is not what runs: it deleted files out of the source as it copied them and then refused the tree's
symlinks, leaving one repository split across both paths.) Their ACLs are reset so they inherit
the shared root's access, with any symlink or junction inside skipped rather than followed out of
the tree, and a directory junction is left where each repository used to be, so that account's
shell, editor and scripts still find it at the old path. One kind stays put: a
repository inside a dot-directory of the profile, such as an agent's memory store or a dotfile
source tree. That directory belongs to the tool that made it, and the tool looks for it there
and nowhere else, so instead of moving it the installer grants the service account Modify on it
(inheritance untouched, owner unchanged) and marks that exact path safe in both the service and
the system git config, so the daemon and the person at the keyboard can each run git there. The
installer prints one line per repository saying which happened and why. A repository with
uncommitted changes stops the whole thing before anything is moved or stopped, either way, and
the installer says which one.

Everything read out of the old profile is copied with `robocopy /B`. A per-user config directory
is readable by its owner alone, and an administrator reading it without backup mode is refused
on every file while Windows reports the refusal as "not found".

The DPAPI-sealed copy of the machine key is deliberately not copied. It is sealed to the account
that sealed it, and the service runs as a different account, so copying it would produce a file
that looks like a working credential and is not.

Three things change for a repository that is kept in place, and they are worth knowing before you
adopt rather than after:

- **Its `postMerge` hook now runs as the service account.** That hook is the argv in your own
  config, not a git hook (git hooks are off for the service: its `GIT_CONFIG_GLOBAL` points
  `core.hooksPath` at an empty directory). The service account has no profile, no `HOME` and no
  interactive session, so a hook written for a person -- `chezmoi apply` is the obvious one --
  fails. The failure is logged and nothing else happens to it: the repository still fetches and
  still merges.
- **Every directory between the profile root and the repository gets a traverse-only entry** for
  the service account, because a profile admits its owner, SYSTEM and Administrators and nobody
  else. It opens the path and nothing in it, and the uninstaller leaves it.
- **The node's auto-commit needs a clock this machine has vetted**, as it did before: the commits
  it writes are stamped with the time this machine believes, and the elevated stage runs
  `w32tm /resync` for exactly that reason.

### Watching it

Both scopes print a step-by-step log with elapsed seconds. The machine-wide install also keeps
a transcript at `C:\ProgramData\sukarfleet\node\logs\install.log`, which is what to read after a
silent install. `/LOG=<path>` captures Setup's own log, which records the exit code of the
script it ran.

### When it refuses

A machine-wide install refused before anything is written, whether for a missing mesh address, a
missing git, a per-user node nobody asked to adopt or an adoption whose repositories have
uncommitted work in them, ends Setup with exit code 7 and the reason in the `/LOG` file, and
nothing at all was installed. A machine-wide install that failed after its files were in place,
such as a service that registers and then will not start, exits 0 with the reason in
`C:\ProgramData\sukarfleet\install-machine.log` and in a message box, and the software is on the
machine, so the uninstaller in Apps and features is the way back off it.

### Removing it

Uninstall from Apps and features, or run the uninstaller in the install directory.

A machine-wide uninstall removes the service, WinSW, Bun, the tray binary and the `HKLM` Run
value. It deliberately leaves three things and says so on the way out:

- `C:\ProgramData\sukarfleet\node`, which holds this machine's fleet identity, its config, its
  state, its audit log and its console token. A later install adopts all of it.
- the shared root, which holds every repository the node was syncing.
- the `easytier-fleet` service, which other machines may be routing through.

A per-user uninstall stops and unregisters the `sukarfleet` scheduled task, stops the tray and
removes its autostart value, then removes the installed source tree. It leaves the config, the
machine key, the SSH key and every synced repository, and prints where they are.

Whichever scope you removed, do one thing elsewhere: drop this machine from the other machines'
`peers[]`, or they keep calling a number that no longer answers.

## 2. Generate an installer from the console (nothing to type)

On a machine already in the fleet, open the console, go to **Fleet > Add a machine**, give the new
machine a name, and press **Generate installer**. The console writes a single file, tells you where
it put it, and shows it in a list with an expiry and a **revoke** button.

Copy that file to the new machine and double-click it. One UAC prompt, and nothing else: it carries
the network secret, a mesh address already allocated for it, the peer to dial and a one-shot
enrollment token, so it installs itself and pairs on its own. Watch the Peers table on the machine
that generated it. It installs the per-user scope; to end up machine-wide, run it first and then
run the EXE with `/ALLUSERS /ADOPT=1`.

**The generated file is a bearer credential.** It carries the fleet's mesh secret, because a machine
cannot join the overlay without one. Anyone holding the file can join the mesh until the token
expires, whether or not they ever run it. So: send it the way you would send a password, delete it
once the machine is in, and revoke it from the console if you change your mind. Revoking closes
pairing; it does not rotate the mesh secret, so a leaked file is a reason to rotate that separately.

The token is single use, expires 24 hours after it is generated, and is bound to the one machine
name and mesh address it was minted for. The file explains all of this in plain text above the
payload, along with how to decode and read the payload before running it.

## 3. Run the PowerShell installer by hand

Double-click `Add-To-Fleet.cmd`. That is the per-user install, without a wizard.

Run it normally, not as administrator. It asks for elevation itself, once, for the only part
that needs it, and it needs everything else to run as you: your config, your SSH key, your
scheduled task. A node whose config is owned by an administrator account is a nuisance to
unpick later.

The machine-wide equivalent is `Install-MachineNode.ps1`, run from an elevated PowerShell:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\Install-MachineNode.ps1 `
  -MachineName <name> -MeshIp 192.0.2.3 -PeerUri tcp://198.51.100.7:11010 `
  -MeshSecretFile C:\path\to\secret.txt -SharedRoot C:\AI_Agent
```

### Before you start

Have three things in hand. The installer will ask for all of them and cannot guess any. A generated
installer already carries all three, which is the point of it.

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

## What the install does

Two stages in the per-user scope, and every line of output says which one it is in.

**Elevated**, behind one UAC prompt. Downloads EasyTier, checks it against a SHA256 pinned in
the script, and installs it to `C:\Program Files\EasyTier`. Writes the mesh config to
`C:\ProgramData\sukarfleet\easytier\fleet.toml` with an ACL that admits only Administrators
and SYSTEM, because it holds the network secret in plaintext. Registers the mesh as a Windows
service, opens the firewall for that one binary on that one port, and turns on NTFS long paths.

**User**, with no special rights. Installs Bun, runs `bun install`, generates this machine's
fleet SSH key, scaffolds `~/.config/sukarfleet/config.json`, registers the node as a scheduled
task, starts it, waits for `/health`, and installs the tray console described below.

The machine-wide scope calls that same elevated stage for the mesh, so there is one
implementation of EasyTier on Windows and not two, and then does its own work: the node
directory and its ACLs, the console token, the two git configs, the shared root, Bun and WinSW
against their pins, the config, the service, `/health`, and the tray.

Re-running either is safe and is the upgrade path. The per-user script takes `-Restart` to
bounce the node; the machine-wide one restarts the service as part of re-registering it.

## The console

The console is a tray icon, the same one a Linux machine gets. Left click opens the window, right
click opens the menu, and the menu is the readout: faults, peers, repos, and the state of the node
itself. Setup and pairing happen in the window, so nothing here needs a terminal.

Per-user, it goes in `%LOCALAPPDATA%\Programs\sukarfleet`, gets a Start menu entry called
"sukarfleet console", and is registered to start when you sign in. That registration is the same
registry value the tray's own "Start at login" checkbox writes, so the two never disagree.

Machine-wide, it goes in `C:\Program Files\sukarfleet` and the `HKLM` Run value starts it for
whoever signs in, with the endpoint and the token file on its command line. The tray's own
"Start at login" checkbox is hidden in that mode, because the machine-wide value is not the
tray's to toggle.

The binary is downloaded from this project's release for the version pinned in
`install/easytier-pins.txt` and checked against the SHA256 on that line. A pin nobody has filled
in yet is not a pin, so nothing is downloaded against one: the installer says the tray has not been
released, prints the browser console URL and carries on. Same for a download that fails or a hash
that does not match. You end up with a working node either way, which is the point. `-SkipTray`
and `/SKIPTRAY` skip it outright.

The console **window** is a WebView2 host. Windows 11 ships that runtime; Windows 10 may not, and
without it the icon and the menu still work while the window silently never appears. The per-user
installer checks for it and says so in the banner rather than leaving you clicking. To fix it:
`winget install --id Microsoft.EdgeWebView2Runtime`.

One thing the tray cannot offer here. On Linux it can copy a `journalctl` line for a node that has
stopped answering. Windows has no journal. For a per-user node it copies `Get-ScheduledTaskInfo`
and calls it a check rather than a log; for a machine-wide one it copies `Get-Service`, and the
service's real output is in `C:\ProgramData\sukarfleet\node\logs`.

## What it deliberately leaves undone

The config lands with `repos: []` and `peers: []`.

Peers arrive through GUI pairing, which exchanges the mesh key, the SSH key and the SSH host
keys in both directions. There is nothing to paste by hand.

Repos are empty because a repo path is machine-local and a wrong one here syncs the wrong tree.
Clone what you want synced, then add it in the GUI, or, in the per-user scope, pass
`-Repo name=C:\path\to\repo` and the installer will set the Windows-hostile git defaults for
you: `core.autocrlf false`, `core.longpaths true`, `core.filemode false`, `core.symlinks true`.
The daemon syncs repositories. It does not clone them.

One thing to check before you sync a repo that Linux machines also write to. If it tracks
symlinks and Developer Mode is off, git checks them out as text files holding the target path.
Status stays clean, so you will not notice, right up until something rewrites one and every
machine in the fleet gets a real file where a symlink used to be. The installer counts the
symlinks in any repo you pass and says so.

## What this machine will not be able to do

Pairing refuses, so a Windows machine cannot join a fleet today without a change to the daemon.
The bundle a machine sends when it redeems a pairing code must carry at least one SSH host key;
Windows ships the OpenSSH client and not the server, so there are none to carry, and the daemon
looks for them in `/etc/ssh` on every platform anyway. Everything past that point does work: with
host keys present, a Windows node and a Linux node paired and synced a repository in both
directions on 2026-09-06. The second thing the bundle rejects is the SSH user name, which must
match `^[a-z_][a-z0-9_-]*$`; both installers fold the Windows account name into that shape.

The admin lane cannot elevate on Windows. Its design is to pipe one password line to a tool
that reads stdin, and Windows has no such tool. UAC is a different mechanism with a different
threat model, and pretending otherwise would produce the kind of confidently wrong answer this
project refuses to give. Both installers write `admin.enabled: false` and leave it there.
Sync, gossip, pairing, the GUI and MCP are unaffected. Drive admin from a Linux machine.

NTFS carries ACLs rather than POSIX mode bits, so the daemon's store-privacy probe reports
that mode is not enforced and the credential store refuses to hold a password. That is the
honest answer, and it follows from the paragraph above anyway.

`docs/PLATFORMS.md` is specific about the rest.

## After it finishes

In this order, because each step needs the one before it.

1. Ping the mesh address of a machine already in the fleet. No mesh, no pairing.
2. Open the console, from the tray icon or at `http://127.0.0.1:7710/ui/`, and add the repos you
   want synced. Machine-wide, the console asks for the token first.
3. Pair. Click Pair on a machine already in the fleet and type its code in here. **This
   refuses on Windows today** with "This machine has no usable SSH identity yet": a pairing
   bundle has to carry an SSH host key, and a machine with no SSH server has none.
   `docs/PLATFORMS.md` has the detail.

## Checking on it

Per-user:

```powershell
Get-ScheduledTaskInfo -TaskName sukarfleet     # last run, last result, next run
Get-Service easytier-fleet                     # the mesh transport
Get-Process sukarfleet-tray                    # the console
Invoke-WebRequest http://127.0.0.1:7710/health -UseBasicParsing
```

Machine-wide:

```powershell
Get-Service sukarfleet-node                    # the node
sc.exe qc sukarfleet-node                      # which account it runs as
Get-Service easytier-fleet                     # the mesh transport
Get-Content C:\ProgramData\sukarfleet\node\logs\sukarfleet-node.out.log -Tail 40
Invoke-WebRequest http://127.0.0.1:7710/health -UseBasicParsing
```

The console needs the token machine-wide:

```powershell
$t = (Get-Content C:\ProgramData\sukarfleet\node\console-token -Raw).Trim()
Invoke-WebRequest http://127.0.0.1:7710/api/ui/state -UseBasicParsing `
  -Headers @{ Authorization = "Bearer $t" }
```

To watch a per-user node in the foreground, stop the task and run it by hand:

```powershell
Stop-ScheduledTask -TaskName sukarfleet
cd <checkout> ; & "$env:USERPROFILE\.bun\bin\bun.exe" run src\node.ts
```

## Options worth knowing

`Install-Sukarfleet.ps1`, the per-user script:

```
-MachineName <name>     default: %COMPUTERNAME%
-Role anchor|roamer     default: roamer
-MeshIp <a.b.c.d>       this machine's mesh address
-PeerUri <uri>          repeatable; a machine already in the fleet
-MeshSecretFile <path>  a file holding the secret, instead of typing it
-Repo name=<path>       a cloned repo to sync; repeatable
-Source <dir-or-zip>    where the sukarfleet source is; defaults to this checkout
-SkipMesh               this machine already has the mesh transport
-SkipTray               no tray console; use the browser GUI
-TrayReleaseBase <url>  where to fetch the tray from, if not this project's release
-Restart                bounce the node after installing
```

`Install-MachineNode.ps1`, the machine-wide script, takes the same identity and mesh arguments
plus:

```
-AppDir <dir>           the tree the service runs from; defaults to this checkout
-SharedRoot <path>      default: C:\AI_Agent
-Adopt                  adopt the per-user node this machine already runs
-UserProfileDir <dir>   whose profile to adopt from, when the task does not say
-ServiceAccount <acct>  default: NT SERVICE\sukarfleet-node; or NT AUTHORITY\LocalService
-NodePort <n>           default: 7710
```

Never pass the secret as an argument. There is no flag for it, on purpose: argv is readable by
every process on the machine and lands in your shell history.

## Removing a per-user install by hand

```powershell
Stop-ScheduledTask -TaskName sukarfleet
Unregister-ScheduledTask -TaskName sukarfleet -Confirm:$false
Get-Process sukarfleet-tray -ErrorAction SilentlyContinue | Stop-Process
Remove-ItemProperty HKCU:\Software\Microsoft\Windows\CurrentVersion\Run sukarfleet-tray
Remove-Item "$env:APPDATA\Microsoft\Windows\Start Menu\Programs\sukarfleet console.lnk"
Remove-Item -Recurse "$env:LOCALAPPDATA\Programs\sukarfleet"
& "C:\Program Files\EasyTier\easytier-cli.exe" service --name easytier-fleet uninstall   # as admin
Remove-NetFirewallRule -DisplayName "sukarfleet mesh (TCP 11010)"                        # as admin
Remove-NetFirewallRule -DisplayName "sukarfleet mesh (UDP 11010)"                        # as admin
```

That leaves `~/.config/sukarfleet`, `~/.local/state/sukarfleet`, the SSH key and
`C:\ProgramData\sukarfleet` in place. Delete them if you mean it. Remember to drop this
machine from the other machines' `peers[]`, or they will keep calling a number that no longer
answers.
