# Install flow

The stranger's first five minutes on Linux, written before the installer exists, so S7 has something
to build against and S8 something to time. Everything describing current behaviour cites the file
and line it comes from; everything that does not exist yet is marked **new in S7**. The gap between
the two categories is the work.

## 0. The decisions this spec is built on

Reproduced from the launch plan (revision 3, 2026-09-05) and the decision notes behind it. This list
is not a file in this repository, so a reader who wants to argue with one of these argues with the
plan, not with a line of code. Everything below cites them by number.

1. One command: `curl -fsSL https://raw.githubusercontent.com/SUKARDADDY/sukarfleet/<tag>/install/get.sh | sh`
   (GitHub raw, pinned to a release tag; a domain may redirect to it later, one docs line changes).
2. Exactly ONE sudo moment in the whole journey: the mesh-secret adoption, the EasyTier service
   install and the firewall rule, presented the way the console's setup screen presents it.
3. Idempotent: a second run is a safe no-op that says so.
4. Uninstaller from day one: `install/uninstall.sh` removes the units, the sudoers drop-in, the
   credential, the EasyTier service and the config it installed, leaves the user's synced repos
   alone, and says what it left. Its root half is a second password moment, accepted for uninstall
   only.
5. Preflight checks with plain-language failures: no systemd user session, port 7710 busy, no
   linger, missing webkit/ayatana runtime for the console, no curl or git, unsupported distro.
6. Desktop install = daemon plus the native tray console by default; headless = daemon only plus the
   printed web-console URL. Ubuntu/Debian family first; other distros get an honest "not yet" with
   the manual steps. The tray ships as a prebuilt, SHA256-pinned, user-local binary, never a `.deb`,
   so decision 2 holds.
7. EasyTier is fetched from upstream releases, SHA256-pinned, by one function `fetch_easytier`;
   `--no-easytier` prints the manual install line instead. Whether fetching counts as redistribution
   is with a lawyer; the default may flip later, so the fetch stays isolated.
8. Pairing between two fresh machines is GUI-only: the console's Pair screen mints a 12-character
   code on one machine and takes it, plus address and port, on the other.
9. No AI, no telemetry, and no third-party calls beyond bun.sh, GitHub (clone and releases), the
   EasyTier release download, and the WAN-address discovery the daemon already documents.

## 1. The promise

One command installs sukarfleet on a fresh Linux machine and asks for a password exactly once
(decisions 1 and 2). When it finishes a daemon is running under systemd and a console is open, as a
native window on a desktop or a printed loopback URL on a headless box. From `curl` to a console you
can click in, under five minutes.

## 2. The journey

This is not the order the scripts are written in today, and the difference is the point: the user
stage cannot stage a mesh secret, because the secret comes from a human typing into the console and
the console does not exist until the daemon runs. So install everything that needs no password, open
the console, take identity and the mesh secret there, print the one sudo line, run it, and only then
pair.

### 2.1 The one command

```
curl -fsSL https://raw.githubusercontent.com/SUKARDADDY/sukarfleet/v0.1.0/install/get.sh | sh
```

That is the whole entry point (decision 1). The ref is a release tag, not `main`: a stranger who runs
this twice a week apart runs the same bytes twice, and a bad commit on `main` is not immediately
everybody's install. S9 cuts the first tag; `README.md:33`, which today says the three-command
`git clone <repo-url> sukarfleet && cd sukarfleet && ./install/quickstart.sh`, gets the tagged
one-liner instead (**new in S7** for the copy, S9 for the tag). Three things stated rather than left
to a reader's judgement. Never `sudo curl ... | sh`: nothing in the first stage needs root, and the
one root command is printed for you to read and run yourself (decision 2).
The pipe target is thin on purpose: `get.sh` has no install logic, it clones the same tag to
`~/.local/share/sukarfleet/app`, prints the commit it checked out, and executes
`install/quickstart.sh` from that checkout (**new in S7**), so the thing that installs is the
repository at a tag. And auditing it first is `git clone --branch v0.1.0 <repo-url>` and reading
`install/quickstart.sh` there. Two `README.md` sentences go when this lands: `README.md:29-30`,
which requires "a mesh network between your machines (the daemon does not create one)" and decision
7 reverses, and `README.md:46`, which already claims `install-elevated.sh` "installs the mesh
transport" when it does not (`install/install-elevated.sh:5-9`).

### 2.2 What the user stage prints

The preflight block, the `t+NNs` checkpoints and the tray lines are new; the `[quickstart] ` prefix
is already there (`quickstart.sh:39-41`).

```
[quickstart] t+0s   preflight: Ubuntu 24.04 (apt family), systemd user session live, port 7710 free
[quickstart] t+2s   installing bun (not found on PATH or at ~/.bun/bin/bun)
[quickstart] t+27s  bun install --frozen-lockfile (2 packages)
[quickstart] t+32s  scaffolding ~/.config/sukarfleet/config.json (machine=box role=anchor)
[quickstart] t+35s  credential sealing works (user scope); a stored sudo password is sealed at rest
[quickstart] t+36s  installed ~/.config/systemd/user/sukarfleet.service (bun=~/.bun/bin/bun)
[quickstart] t+41s  daemon healthy on 127.0.0.1:7710
[quickstart] t+55s  installed ~/.local/bin/sukarfleet-tray (SHA256 pinned), autostart on
[quickstart] done in 56s
```

Every line carries `t+NNs` from the stage's start and the last is `[quickstart] done in NNs`, so S8
reads that line rather than holding a stopwatch here; section 7 lists what it does time by hand. The
`bun` line is new: today `quickstart.sh:84-85` refuses outright with `ERROR: bun not found at
~/.bun/bin/bun or on PATH`. A one-command install cannot end there, so the user stage bootstraps Bun
the way the Windows installer already does (`Install-Sukarfleet.ps1:495-507`) (**new in S7**).

### 2.3 The console opens

**Desktop.** `quickstart.sh:393-395` already calls `xdg-open` when `$DISPLAY` or `$WAYLAND_DISPLAY`
is set. Decision 6 makes the native tray the default there, so the desktop path installs the tray
binary and starts it, and the tray opens **its own console window**, not a browser and not `/ui/`:
the window is built from the tray's bundled `index.html`
(`clients/tray/src-tauri/src/window.rs:11-21`) and every request goes through an allowlisted Rust
bridge, because the webview cannot reach the daemon directly, which serves no CORS headers by design
(`clients/tray/src-tauri/src/api.rs:2-6`). That bridge is not read-only: the allowlist carries `POST
/api/ui/setup/identity`, `POST /api/ui/setup/network-secret`, `POST /api/ui/pair/code`, `POST
/api/ui/pair/redeem`, `POST /api/ui/pair/revoke`, `POST /api/ui/credentials/sudo`, `POST
/api/ui/admin/run` and `DELETE /api/ui/pair/code` among others
(`clients/tray/src-tauri/src/api.rs:16-35`), and the console ships the same five screens the web one
has, setup included (`clients/tray/src/console.js:393`), so every step in 2.4 through 2.6 happens in
that window. The tray menu has one item that opens it (`clients/tray/src-tauri/src/tray.rs:126`) and
one that toggles autostart (`:129-135`).

The tray is **not** a `.deb`. `clients/tray/src-tauri/tauri.conf.json:16-18` still says `"targets":
["deb"]` and that has to change (**new in S7**), because installing a `.deb` needs root and decision
2 allows exactly one root moment. v1 ships one prebuilt Linux x86_64 Tauri binary in the GitHub
Release, SHA256-pinned in the same pin file as EasyTier (Stage 2), downloaded by the **user** stage
to `~/.local/bin/sukarfleet-tray`, with an XDG autostart entry at
`~/.config/autostart/sukarfleet-tray.desktop` and an immediate `systemd-run --user
--unit=sukarfleet-tray ~/.local/bin/sukarfleet-tray` so nobody has to log out to see it. Its runtime
needs two shared libraries a stock Ubuntu desktop already has, `libwebkit2gtk-4.1.so.0` and
`libayatana-appindicator3.so.1` (`clients/tray/README.md:20-21` lists their `-dev` counterparts);
preflight probes both with `ldconfig -p`, and if either is absent the tray is skipped and the web
console URL printed instead, never an `apt install`, because that needs root. On an aarch64 desktop
there is no tray build yet, and the message says exactly that.

**Headless.** No `$DISPLAY`, no `$WAYLAND_DISPLAY`, no tray. The URL is the deliverable, plus the
tunnel line the banner already carries (`quickstart.sh:358-360`): `ssh -N -L 7711:127.0.0.1:7710
you@box`, then `http://127.0.0.1:7711/ui/` over there. Every `/api/ui/*` route and every `/ui/`
asset is loopback-gated, with the `Host` header pinned ahead of the peer check so a DNS-rebound page
cannot reach them either (`src/uiserve.ts:454-477`), which makes the tunnel the supported remote
path rather than a workaround. The daemon runs two listeners on `cfg.nodePort`: one bound to the
mesh IP for peers, and a second bound to 127.0.0.1 so the CLI keeps working without widening the
peer surface (`src/node.ts:1204-1218`). One constraint on S7: **never print `/ui/` as the answer on
a machine whose console is the tray.** `admin.uiAssets:false` 404s the HTML and asset routes while
leaving `/api/ui/*` reachable, exactly the handover an operator makes when the native console
replaces the browser one (`src/uiserve.ts:478-483`, default true at `src/types.ts:217-223`). The
installer never writes `uiAssets:false`, so the fallback URL is right on every machine it installs;
where an operator turned assets off, preflight reads the key and prints the tray path instead of a
URL that will 404.

### 2.4 Identity and the mesh secret, in the console

A fresh machine lands on the setup takeover, not the fleet screen (`ui/index.html:49-50`,
`ui/app.js:336-339`): "Set up this machine. Four steps, all from this page. Only the mesh secret
needs a terminal, and only once." (`ui/index.html:51`).

1. **Identity.** Machine name, role, mesh IP, node port, network name, written to
   `~/.config/sukarfleet/config.json` (`ui/index.html:53-85`). Saving writes that file and nothing
   else: the daemon binds `cfg.nodePort` and signs gossip as `cfg.machine` once, at boot
   (`src/node.ts:864-869`), so the save answers `restartRequired` and the card says `Saved. Restart
   the daemon to apply.` with the restart button beside it. The restart happens here, on this card
   (**new in S7**); until it does, `/api/ui/state` keeps reporting `setup.identity: false` while the
   value on disk is already the new one.
2. **Mesh network.** "Generate a new secret" on the first machine of a fleet, or "I already have
   one" on the second (`ui/index.html:87-101`). Either way the details are staged to a 0600 file
   under the state directory and the card shows the one root step (`ui/index.html:87-111`,
   `src/node.ts:820-823`).
3. **Admin credential.** Optional, off by default. Skipping it costs the admin lane and nothing
   else.
4. **Pair.** Section 2.6, after the mesh is up.

"Skip for now and open the console" is present and stays (`ui/index.html:128`, `ui/app.js:774-778`).
`setup.complete` is deliberately not the signal for any of this: it requires `paired`
(`src/node.ts:1009`), and a single-machine fleet is never paired at all, which the console's own
comment says out loud (`ui/app.js:332-335`). The observable that matters is the Mesh card's state
string, which is what the rest of this document uses.

### 2.5 The one sudo moment, and mesh up

The banner is already written (`quickstart.sh:352-391`) and ends in one of two branches: if
`easytier-fleet.service` is active it says so and asks for nothing (`quickstart.sh:371-376`);
otherwise it prints this.

```
────────────────────────────────────────────────────────────────────────
  sukarfleet is installed on box. The console window is open (tray icon >
  Open fleet console).

  Mesh: not running yet. ONE root step, the only one in this install:

      sudo $HOME/.local/share/sukarfleet/app/install/install-elevated.sh \
           --adopt-pending-secret \
           --pending=$HOME/.local/state/sukarfleet/pending-easytier-secret

  It will do exactly five things, and nothing else:
    1. read the staged mesh details, refusing the file unless it is a
       regular file you own at mode 0600
    2. write /etc/easytier/fleet.toml (0600 root), shred the staged copy
    3. fetch EasyTier, check it against a SHA256 pinned here, install it
    4. if a firewall is running, open the mesh listener ports, and 7710
       from the mesh subnet only
    5. restart your own sukarfleet daemon, so it listens on the mesh address
       instead of on every interface

  Do the console's "Mesh network" card first. Until you do, this command
  refuses and writes nothing: it has no secret to adopt.
────────────────────────────────────────────────────────────────────────
```

The numbered lines and `--pending=` are new (**new in S7**), and they are the point of decision 2:
the user reads what the password buys before typing it. The path is hardcoded nowhere; the daemon
derives it from `stateDir()`, which honours `SUKARFLEET_STATE` (`src/config.ts:18-20`), and the
banner and console print that same real path. Both consoles print a wrong one today:
`ui/index.html:108` and `clients/tray/src/index.html:116` hardcode `sudo
~/sukarfleet/install/install-elevated.sh --adopt-pending-secret`, which is neither where `get.sh`
puts the checkout nor a flag the script accepts (`install-elevated.sh:50-59` rejects it as an
unknown argument). Both print what the banner prints (**new in S7**). `quickstart.sh:343-345`
already greps the script for the flag before appending it, so today it is never appended at all. The
prompt is `sudo`'s own: sukarfleet never draws a password box, and the console never asks for a sudo
password to run the installer. The Credentials screen does take one, but that is the admin lane, off
on a fresh install (`install-elevated.sh:16-17`). The stage ends by asking the service manager
whether `easytier-fleet.service` is actually running rather than trusting an exit code, the lesson
the Windows path already paid for (`Install-Sukarfleet.ps1:443-450`), and prints `[install-elevated]
done in NNs`. The Mesh card flips from `pending` to `installed` within a poll or two, because a
staged file outranks a running service and the shred is what removes it (`src/node.ts:831-841`).

Then the stage restarts the node itself (**new in S7**), which is what step 5 of the banner is. The
order matters and it is the reason this step exists at all. The Identity card writes `meshIp` and
the console restarts the daemon one step earlier, while EasyTier is still not installed, so the
mesh address is on no interface and the daemon cannot bind it. It listens on `0.0.0.0` instead and
says so (`chooseBindHost` in `src/node.ts`); before S7 it died at boot on `EADDRNOTAVAIL` and
systemd restarted it every 3 seconds, which took the console down with it and deadlocked the
journey on every fresh machine. The mesh only comes up here, at the end of this stage, so this is
the first moment a restart can take the address. The line is `runuser -u <user> -- env
XDG_RUNTIME_DIR=/run/user/<uid> systemctl --user restart sukarfleet.service`, run as the target
user because sukarfleet is a systemd **user** unit and root's `systemctl --user` talks to root's
own manager. It logs `[install-elevated] restarted the node so it listens on the mesh address`. If
that user has no runtime directory, the script warns and prints `systemctl --user restart
sukarfleet.service` for them to run instead of failing an install that is otherwise complete. It
does not run on the exit-5 path where the mesh service failed to start: the address still does not
exist there, so a restart would only put the node back where it already is.

### 2.6 Pairing machine A and machine B

Decision 8: pairing is console-only. Both machines need their mesh up first, which is why this is
last.

**On A, the machine already in the fleet.** Pair screen, "Show a code on this machine", button
**Show pairing code** (`ui/index.html:175-184`). A twelve-character Crockford base32 code appears,
grouped for reading, for example `K3M9-TQ7X-2VBH` (`src/pairing.ts:94-95`, `:141`), under a line
reading `Active · expires in 4m 58s · 5 attempts left` (`ui/app.js:75`). It is single use and lives
300 seconds (`src/pairing.ts:55-56`, `ui/index.html:177`).

**On B, the fresh machine.** Same screen, "Enter the other machine's code": the code, A's
**address** (its mesh IP), and A's **port**, defaulted to 7710 (`ui/index.html:186-205`). B types
the code, presses the button, and sees `Pairing…` then `Paired with alpha. Verified in both
directions.` (`ui/app.js:78-79`). One round trip exchanges mesh public keys, SSH public keys and SSH
host keys in both directions, so there is nothing left to paste by hand (`ui/index.html:173`,
`quickstart.sh:168-170`). A updates to `Last paired with beta.` on its next poll (`ui/app.js:77`).

The four refusals are already written and specific, one per failure mode (bad code, unreachable
address, unexpected answer, half-paired); section 6 quotes the two a stranger hits most
(`ui/app.js:80-85`).

## 3. Under the hood, stage by stage

### Stage 0: `install/get.sh` (**new in S7**)

**Preconditions:** `sh`, `curl` and `git`. **Writes:** the checkout at
`~/.local/share/sukarfleet/app` (`SUKARFLEET_APP_DIR` moves it, which is how the tests clone into a
throwaway directory), at the tag in the URL, nothing else. **Then:** prints the resolved commit,
prints `[get] checkout stage done in NNs`, and `exec`s `install/quickstart.sh "$@"` out of it. If
that directory already exists and is a sukarfleet git repository, `get.sh` fetches and checks out
the requested tag rather than cloning, which is what makes the upgrade path a re-run of the same
command with a newer tag. That fetch is `--depth 1` and does **not** pass `--tags`: the checkout
uses `FETCH_HEAD`, so every other tag's objects are bytes nobody reads on the one path a person sits
and waits on. If it exists and is not a sukarfleet repository, it refuses and names the path.

The duration line is there because the next stage starts its own clock. A re-run of the one command
that takes twenty seconds of wall clock and ends in `[quickstart] done in 4s` is not lying: the rest
was this stage, and until it printed its own number that time belonged to nobody (**new in S7**).

### Stage 1: user stage, `install/quickstart.sh`

**Preconditions,** all checked before anything is written (**new in S7**; today there is no
preflight block and each missing tool is found at the point of use, for example `ssh-keygen` at
`quickstart.sh:208` and `systemctl` at `:303`). A failure here stops the install: `curl` and `git`
on PATH; an apt-family distro read from `/etc/os-release` `ID` and `ID_LIKE`; a live systemd user
session (`systemctl --user is-system-running` answers at all); TCP 7710 free, or already held by a
sukarfleet daemon answering `/health`.

**Probes,** which report and continue, and are **not** preconditions. Linger: `loginctl
enable-linger $USER` already warns and continues on failure (`quickstart.sh:307-310`). The tray
runtime, via `ldconfig -p`, on a desktop only: absent means no tray, not no install. Credential
sealing, a real encrypt/decrypt round trip that already exists and already only warns
(`quickstart.sh:239-251`). And 0700 actually reading back as 0700: on a mode-blind mount (fuseblk,
exFAT, NTFS) `chmod` is inert, and the code **warns and continues** rather than refusing
(`quickstart.sh:98-100`), because the credential store is what fails closed there.

**Writes:** `~/.config/sukarfleet/`, `~/.config/sukarfleet/secrets/` and
`~/.local/state/sukarfleet/`, each 0700 (`quickstart.sh:103-105`); `~/.ssh/id_sukarfleet_ed25519` at
0600, one dedicated key per machine, never copied anywhere (`quickstart.sh:201-213`);
`~/.ssh/authorized_keys` and `~/.local/state/sukarfleet/known_hosts`, created empty at 0600 if
absent, because sshd ignores an authorized_keys that is group or world writable
(`quickstart.sh:215-221`); `~/.local/share/applications/org.sukarfleet.node.desktop`, a hidden entry
so GTK notifications deliver at all (`quickstart.sh:271-288`); `~/.local/bin/sukarfleet`, a PATH
wrapper for the CLI; and on a desktop `~/.local/bin/sukarfleet-tray` plus
`~/.config/autostart/sukarfleet-tray.desktop` (the last two **new in S7**). Two of them need
changes:

- `~/.config/sukarfleet/config.json`, 0600, scaffolded only if absent (`quickstart.sh:174-195`), is
  written with `admin.enabled: true` and `admin.acceptIncoming: true` (`quickstart.sh:184-189`)
  while `defaultConfig()` fails closed with `enabled: false` (`src/config.ts:75-77`) and section 8
  says the lane is off on install. The scaffold is the one that is wrong (**new in S7**: scaffold it
  off).
- `~/.config/systemd/user/sukarfleet.service` is templated from `systemd/sukarfleet.service` with
  the checkout path substituted in (`quickstart.sh:253-257`), and needs a second substitution:
  `ExecStart` hardcodes `%h/.bun/bin/bun` (`systemd/sukarfleet.service:33`) while the script accepts
  a bun found anywhere on PATH (`quickstart.sh:80-83`), so a machine with bun at
  `/usr/local/bin/bun` passes preflight and gets a unit that cannot start. The unit is written with
  the resolved path (**new in S7**).

**Runs:** `bun install --frozen-lockfile` in the checkout (**new in S7**). `bun.lock` is committed,
so the flag turns lockfile drift into a refusal, not a silent resolve. It is cheap: `package.json`
declares no `dependencies`, only `typescript` and `bun-types` under `devDependencies`, which is the
zero-runtime-deps claim showing up as two packages and five seconds. `--production` is deliberately
not passed: it would install nothing, and those two packages are what make `bun run typecheck` work
on a re-run. **Fetches and verifies:** Bun, from `https://bun.sh/install`, only when absent, and the
tray binary from this project's own GitHub release, SHA256-pinned in `install/easytier-pins.txt`
alongside EasyTier (both **new in S7**).

**Then:** `systemctl --user daemon-reload`, `enable`, `start`, poll `/health` for 20 s
(`quickstart.sh:312-336`), print the banner, never call `sudo` (`quickstart.sh:338-341`).

### Stage 2: the elevated stage, `install/install-elevated.sh`

Invoked as `sudo install/install-elevated.sh --adopt-pending-secret --pending=<path>`. This is the
largest gap between spec and code: today it writes one sudoers drop-in and optionally enables a
service something else was expected to have installed (`install-elevated.sh:5-9`), and its own header
says it deliberately does not download anything (`install-elevated.sh:11-12`). Decision 2 makes this
stage responsible for the secret, the EasyTier install and the firewall, so all three are **new in
S7**, and that header sentence goes with them. **Preconditions:** running as root
(`install-elevated.sh:61-64`), with `systemctl`, `visudo` and `install` present (`:66-68`), plus, new,
a staged file at `--pending=` that survives the guard below, unless `--no-easytier` was passed. A
firewall tool is **not** a precondition.

**Writes:** `/etc/sudoers.d/sukarfleet-transport`, 0440 root:root, validated with `visudo -cf`
before it is put in place because a malformed drop-in can lock every user out of sudo
(`install-elevated.sh:100-119`); `/etc/easytier/` at 0700 root and `/etc/easytier/fleet.toml` at
0600 root, holding the network secret in plaintext (**new in S7**); `/opt/easytier/easytier-core`
and `/opt/easytier/easytier-cli`, at exactly the paths the unit and the default config already
assume (`systemd/easytier-fleet.service:10`, `src/config.ts:51`) (**new in S7**);
`/etc/systemd/system/easytier-fleet.service`, copied from `systemd/easytier-fleet.service`, which
nothing installs today (**new in S7**); and firewall rules, if and only if a firewall is already
running (**new in S7**). That directory mode is load-bearing: the daemon reads mesh state from the
service rather than from the file precisely because an unprivileged `stat` there must always answer
"absent" (`src/node.ts:831-833`).

**Restarts:** the invoking user's own `sukarfleet.service`, last, and only when
`easytier-fleet.service` came up (**new in S7**). Nothing else re-binds the node: `cfg.meshIp` is
set one console step before the address exists, so between the Identity card and this stage the
daemon is listening on `0.0.0.0` with a warning in the log, and it stays there until something
restarts it. `restart_node()` in `install-elevated.sh` is that something. It never fails the
install: no `runuser`, or no `/run/user/<uid>`, both warn and name the command by hand.

The sudoers grant is the only passwordless rule this project installs, and it is one command with a
fixed argument list (`install-elevated.sh:102-111`): `you ALL=(root) NOPASSWD: /usr/bin/systemctl
restart easytier-fleet.service`. Both interpolated values are charset-constrained first, so neither
can introduce a second command (`install-elevated.sh:89-96`). The admin lane does not use this
grant; it authenticates with a stored password of its own (`install-elevated.sh:16-17`,
`SECURITY.md:43-49`).

#### The pin file

`install/easytier-pins.txt` (**new in S7**), read by the bash installer and mirrored by the
PowerShell installer's `$MeshHashes` table (`Install-Sukarfleet.ps1:178-181`). One line per
artefact, four whitespace-separated columns, `#` comments and blanks ignored: **version** (upstream
string, no leading `v`), **arch** (the `uname -m` token this line is for), **sha256** (lowercase
hex, 64 characters), **asset** (the exact release asset filename). The asset name disambiguates the
two consumers: `fetch_easytier` reads the lines whose asset starts with `easytier-linux-`, the tray
fetch the ones starting `sukarfleet-tray-`. The URL shape is
`https://github.com/EasyTier/EasyTier/releases/download/v<version>/<asset>`
(`Install-Sukarfleet.ps1:361-362`). The asset names were checked against the real v2.6.4 release on
2026-09-05: `easytier-linux-x86_64-v2.6.4.zip` and `easytier-linux-aarch64-v2.6.4.zip`. The arch
token differs from the Windows one, `arm64` (`Install-Sukarfleet.ps1:355`, `:361`); on Linux it is
`aarch64`. So `uname -m` = `x86_64` maps to `x86_64`, `aarch64` or `arm64` maps to `aarch64`, and
anything else is refused by name with a pointer at the appendix. The two Linux SHA256 values are in
no file here today (only the Windows zips are pinned); S7 computes them against the pinned release
and commits them with the file.

#### `fetch_easytier`

One function (decision 7), so the licence question about fetching versus bundling has exactly one
place to change if the answer flips. It resolves the arch, looks the line up in the pin file,
downloads, computes SHA256, compares, and on a mismatch deletes the download and installs nothing,
mirroring `Install-Sukarfleet.ps1:368-378`. `--no-easytier` skips this function **and** the TOML,
and is an elevated-stage flag only: the user stage never fetches EasyTier, so passing it there means
nothing. With it, no `/etc/easytier` is created, no secret is adopted, no staged file is shredded,
and the manual install line is printed instead. A TOML with no secret would be worse than no TOML:
the unit would start, join nothing, and look installed.

#### `fleet.toml` is generated by the daemon, not by bash

The elevated stage does not re-implement the TOML layout. It calls the daemon's own generator:

```
"$BUN" run src/cli.ts easytier-toml --secret-file "$PENDING" --mesh-ip "$MESH_IP" --hostname "$MACHINE" --network-name "$NETWORK" --listeners "$LISTENERS"
```

`src/cli.ts easytier-toml` is **new in S7**: a thin CLI over `generateEasytierToml`
(`src/transport.ts:37-62`), already the single source of the key layout and of the two constraints
that make hand-writing it dangerous: every top-level key must precede the first table header, and
`rpc_portal` is a unit CLI flag, not a file key (`src/transport.ts:34-47`). It writes to stdout; the
elevated stage captures that into a temp file inside the already-0700 `/etc/easytier`, then `install
-m 0600 -o root -g root` into place. `$BUN` is passed explicitly, because root's PATH does not
contain the invoking user's `~/.bun/bin`; the user stage resolved a bun path already
(`quickstart.sh:80-86`) and the banner carries it through.

#### The staged file

The console's Mesh card is to write JSON: `{ "networkName", "networkSecret", "meshIp",
"listeners" }`, for example `{"networkName":"sukarfleet","networkSecret":"...","meshIp":"192.0.2.3",
"listeners":["tcp://0.0.0.0:11010","udp://0.0.0.0:11010"]}`. **Deferred, not shipped in S7.** The
console still writes a bare secret and a newline (`src/node.ts:851-859`), and `POST
/api/ui/setup/network-secret` still accepts only `{action:"generate"}` or `{action:"stage", secret}`
(`src/uiserve.ts:683-703`). The elevated stage reads both shapes already -- JSON when it finds it,
a bare secret otherwise, filling the missing fields from the invoking user's `config.json` -- so
the staging change can land on its own later without touching the root stage. Moving the mesh IP
off the **Identity** card (`ui/index.html:68-71`) and next to the secret is deferred with it: the
two belong together because they are what the one root command consumes, and the Identity card is
where the mesh IP is typed today. What that costs until then is one failure mode, and section 6
carries it: the root line run before the Identity card was filled refuses with `no mesh IP` and
writes nothing. Listeners default to the pair the Windows installer builds
(`Install-Sukarfleet.ps1:405`) and are not exposed in the card in v1. Either way the file goes
through `writeSecretFile`, which creates it at 0600 via a temp file and a rename so it is never
briefly world readable (`src/keys.ts:84-100`, `SECRET_FILE_MODE` at `:16`), and the secret is never
an argument to anything, so it reaches no command line, no shell history and no `ps` output
(`src/node.ts:820-822`). Changing the mesh IP or the secret later is an edit in the console and a
re-run of the same sudo line: the stage is idempotent, rewrites the TOML from whatever is staged,
and restarts the unit.

#### Reading the staged file safely

`--pending=<path>` is treated as hostile until proven otherwise, because a root process reading a
path under an unprivileged user's home is the classic symlink-swap target:

1. `lstat` it. If it is a symlink, refuse: in bash, `[ -L "$p" ]` before `[ -f "$p" ]`, because `-f`
   follows. The read itself goes through `bun` or `python3` with `O_NOFOLLOW`, so the check and the
   open cannot be raced apart.
2. Refuse unless it is a regular file: not a fifo, not a device, not a directory.
3. Refuse unless its owner is the invoking user resolved from `SUDO_USER`
   (`install-elevated.sh:27`), compared by uid rather than by name, and its mode is exactly 0600.
4. Read, write the TOML, then overwrite the staged file with zeroes to its own length and unlink it.
   Same overwrite-before-delete as the Windows path, with the same honesty about what it buys: no
   guarantee on a copy-on-write filesystem or a wear-levelling SSD, but it does keep the secret out
   of a trivially undeleted file (`Install-Sukarfleet.ps1:234-245`).

A refusal exits 3, writes nothing, and leaves the file for the user to inspect: it does not delete a
file it has just decided it does not trust.

#### Firewall

Port-scoped, not binary-scoped: Linux firewall front ends have no equivalent of the `-Program
$MeshCore` scoping the Windows installer uses (`Install-Sukarfleet.ps1:460-470`), so the narrowing
comes from the ports and a source restriction. **ufw installed and active:** allow the EasyTier
listener ports, UDP and TCP, from the same `listeners` the TOML was given, and 7710/tcp **from the
mesh subnet only** (the /24 containing the staged mesh IP, unless the config names a mask); every
rule added is printed verbatim. **ufw installed and inactive:** do nothing, and print that no rule
was needed because no firewall is running. **firewalld active:** the equivalent `firewall-cmd
--permanent --add-port=<port>/udp`, `--add-port=<port>/tcp`, a rich rule for 7710/tcp from the mesh
subnet, then `--reload`. **Neither:** print the manual line for the ports involved and continue. The
installer never enables a firewall that is not already running.

**If the elevated stage never runs.** Nothing breaks and nothing is half-written. The daemon is up,
`/health` answers, the console serves, and sync to nowhere is a no-op because there are no peers.
The Mesh card keeps reporting `pending` and keeps showing the exact command to run
(`src/node.ts:834-841`, `ui/app.js:44`); the staged file sits at 0600 in the user's own state
directory until it is adopted or removed, and `uninstall.sh` shreds it.

## 4. Idempotence and re-run

A second run is a safe no-op that says so (decision 3). The script is already idempotent by
construction (`quickstart.sh:4-5`); what is missing is the summary that makes the no-op legible
(**new in S7**):

```
[get] updating the checkout at ~/.local/share/sukarfleet/app to v0.1.0
[get] checkout stage done in 4s
[quickstart] t+1s   config exists at ~/.config/sukarfleet/config.json -- left untouched.
[quickstart] t+2s   sukarfleet.service enabled and active; mesh secret installed
[quickstart] done in 3s in this stage (install/get.sh timed the checkout separately). This machine is already installed.
```

Two timers, because there are two stages and only one of them was ever measured. The stage-1 line
counts from the moment `quickstart.sh` starts, so on a re-run the network round trip in stage 0 is
the larger half and used to be invisible.

Config is never overwritten: only the admin lane's non-privileged fields are backfilled, and only
when missing, because switching a root-capable lane on mid-upgrade is the operator's call
(`quickstart.sh:124-163`). The SSH key is reused if present (`quickstart.sh:205-206`). The unit is
rewritten from the template every run, which is how a moved checkout gets a correct
`WorkingDirectory` (`quickstart.sh:256`). The tray binary is re-fetched only when missing or off its
pin. The elevated stage rewrites the same sudoers drop-in, revalidates it, rewrites the TOML from
whatever is staged, and leaves an already-installed EasyTier alone unless a reinstall is asked for;
re-running is the intended upgrade path (`install-elevated.sh:19-20`).

**An upgrade run** is the same command with a newer tag. Restart discipline here is not the
installer's to invent: `docs/CUTOVER.md` requires a graceful `systemctl --user stop` and a `git
fsck` on every synced repo, because restarting mid-sync is what corrupted repositories on this fleet
before. An upgrade run that finds configured repos prints that warning and asks for `--restart`
rather than bouncing the daemon under a sync.

## 5. Uninstall

`install/uninstall.sh` does not exist (**new in S7**). Decision 4 puts it in from day one.

It runs in two halves for the same reason the install does. The user half needs no password and
prints the root line at the end; the root half is `sudo install/uninstall.sh --elevated` (**new in
S7**), a second password moment. Stated plainly: the install promises one sudo moment in, and a
root-owned service and a sudoers drop-in cannot come out without root. **Removes,** user half:
`~/.config/systemd/user/sukarfleet.service` after `systemctl --user disable --now`;
`~/.local/share/applications/org.sukarfleet.node.desktop`;
`~/.local/share/dbus-1/services/org.gnome.Shell.Notifications.service`, only if this installer wrote
it (`quickstart.sh:293-300`); `~/.local/bin/sukarfleet`, `~/.local/bin/sukarfleet-tray` and
`~/.config/autostart/sukarfleet-tray.desktop`; the credential in `~/.config/sukarfleet/secrets/` and
the staged mesh secret under `~/.local/state/sukarfleet/`, both shredded. **Root half:**
`/etc/sudoers.d/sukarfleet-transport`, which the elevated script already knows how to do
(`install-elevated.sh:70-78`); `easytier-fleet.service`, `/etc/easytier/`, `/opt/easytier/` and the
firewall rules, but only the ones this installer created. **Deliberately leaves:** every synced
repository; `~/.config/sukarfleet/config.json`, so a reinstall recovers identity and peers;
`~/.ssh/id_sukarfleet_ed25519` and its public half; `~/.ssh/authorized_keys`, including marked peer
lines; `~/.local/state/sukarfleet/known_hosts`. The last three stay because deleting them silently
breaks the fleet's other machines.

```
[uninstall] stopped and removed sukarfleet.service, the tray, its autostart entry, the CLI wrapper
[uninstall] shredded the staged mesh secret and the stored credential
[uninstall] removed /etc/sudoers.d/sukarfleet-transport, easytier-fleet.service, /etc/easytier,
            /opt/easytier and the firewall rules it added
[uninstall] left in place: your repositories, config.json, the fleet SSH key, authorized_keys,
            known_hosts

  The other machines still list this one as a peer. Remove it from their Fleet
  screen, or they will keep calling a number that no longer answers.
```

The Windows removal notes already give that last warning (`install/windows/README.md:132-135`).

## 6. Failure modes

Every row is a failure the installer must have a sentence for. "Clean" means a re-run can finish
from here, no partial artefact to remove by hand. Exit codes are **new in S7**: today every failure
exits 1 through one `die()` (`quickstart.sh:41`). The scheme is 2 for a missing or unsupported
precondition, 3 for something present and wrong, 5 for a failed fetch or service in the elevated
stage, 0 for anything warned about and continued past. There is no exit 4: the case it used to
describe turns out to be sudo's, not ours.

| Trigger | Message | Exit | Exit path | Clean |
|---|---|---|---|---|
| `curl` or `git` missing | `[quickstart] ERROR: git is not installed. Run: sudo apt-get install -y git curl` | 2 | install the package, re-run the one command | yes, nothing written |
| Unsupported distro | `[quickstart] ERROR: this installer supports Debian and Ubuntu family distros only. Found ID=fedora. The manual steps are in docs/INSTALL-FLOW.md section 9; the daemon itself has no distro dependency.` | 2 | follow the appendix by hand, or wait | yes, nothing written |
| No systemd user session | `[quickstart] ERROR: no systemd user session. This daemon runs as a systemd user unit. On a container or a chroot, start one with: loginctl enable-linger $USER` | 2 | start a session, re-run | yes, nothing written |
| Linger probe fails | `[quickstart] WARNING: could not enable linger for you -- the node will stop when you log out. Fix with: sudo loginctl enable-linger you` (`quickstart.sh:307-310`) | 0 | install continues; fix later | yes, install completed |
| Mode-blind filesystem (0700 reads back as something else) | `[quickstart] WARNING: config dir (~/.config/sukarfleet) reads back mode 777 after chmod 700 -- this is not a real POSIX filesystem (fuseblk?). The credential store will refuse to operate there.` (`quickstart.sh:98-100`) | 0 | move the config dir onto a real filesystem, or accept no stored credential | yes, install completed, admin lane unavailable |
| Port 7710 busy, not by sukarfleet | `[quickstart] ERROR: port 7710 is already in use by another process. Free it, or install with --node-port=7711.` (`--node-port` does not exist today, `quickstart.sh:62-72`; **new in S7**) | 3 | free the port or pick another | yes, nothing written |
| Port 7710 busy, by a live sukarfleet | `[quickstart] sukarfleet is already running on 127.0.0.1:7710. Treating this as a re-run.` | 0 | nothing, this is the idempotent path | yes |
| Tray runtime libraries missing | `[quickstart] WARNING: the console window needs libwebkit2gtk-4.1.so.0 and libayatana-appindicator3.so.1, neither of which ldconfig can find. Skipping the tray. Open http://127.0.0.1:7710/ui/ in a browser instead.` | 0 | use the browser console, or install the two libraries and re-run | yes, daemon installed |
| Tray binary download or checksum fails | `[quickstart] WARNING: could not install sukarfleet-tray (SHA256 mismatch against install/easytier-pins.txt). Nothing was installed to ~/.local/bin. The daemon and the web console are unaffected: http://127.0.0.1:7710/ui/` | 0 | use the browser console; report a checksum mismatch rather than retrying it | yes, daemon installed, no partial binary |
| Desktop on aarch64 | `[quickstart] no tray build for aarch64 yet. The daemon is installed and running; use the web console at http://127.0.0.1:7710/ui/` | 0 | use the browser console | yes, daemon installed |
| Tray runs but GNOME shows no icon | `[quickstart] the tray is running but GNOME needs the AppIndicator extension (gnome-shell-extension-appindicator) to show it. Until it is installed, open the console at http://127.0.0.1:7710/ui/` (there is no `--console` flag to offer instead: `clients/tray/src-tauri/src/config.rs:22-33` parses only `--endpoint`) | 0 | install the extension and log back in, or use the browser console | yes, everything installed |
| Sudo line run before the console staged anything | `[install-elevated] ERROR: nothing is staged at $HOME/.local/state/sukarfleet/pending-easytier-secret. Do the console's "Mesh network" card first, then run this command again. Nothing was written.` | 3 | stage the secret in the console, re-run the line | yes, nothing under /etc |
| Staged file is a symlink, wrong owner, or wrong mode | `[install-elevated] ERROR: refusing $HOME/.local/state/sukarfleet/pending-easytier-secret: it is a symbolic link (expected a regular file owned by you at mode 0600). Nothing was written and the file was left alone.` | 3 | inspect the file, delete it, re-stage from the console | yes, nothing under /etc, file untouched |
| Sudo line run before the Identity card was filled | `[install-elevated] ERROR: no mesh IP: the staged file does not carry one and $HOME/.config/sukarfleet/config.json has meshIp empty. Set this machine's mesh address on the console's Identity card, then run this command again. Nothing was written.` | 3 | set the mesh IP on the Identity card, restart the daemon, re-run the line | yes, nothing under /etc, staged file untouched |
| sudo refuses, or the password is wrong | `sudo`'s own message and nothing else: the elevated script never starts, so it prints nothing and changes nothing | n/a, sudo's own exit code | run the line again | yes, staged file still 0600, nothing under /etc; the console keeps showing the Mesh card |
| EasyTier download fails | `[install-elevated] ERROR: could not download easytier-linux-x86_64-v2.6.4.zip. Nothing was installed. Check the network, or re-run with --no-easytier and install EasyTier yourself.` | 5 | retry, or `--no-easytier` | yes, nothing under /etc or /opt |
| SHA256 mismatch | `[install-elevated] ERROR: SHA256 mismatch for easytier-linux-x86_64-v2.6.4.zip. expected <pin>, got <actual>. Nothing was installed.` (mirrors `Install-Sukarfleet.ps1:371-373`) | 5 | report it; do not retry blindly | yes, download deleted |
| No `/dev/net/tun` | `[install-elevated] ERROR: easytier-fleet.service failed to start. journalctl says: "Failed to create TUN device: No such file or directory (os error 2)". This VM or container has no /dev/net/tun; the host has to pass it through. The sukarfleet daemon is still running and the console still works.` | 5 | give the container the TUN device, then `sudo systemctl start easytier-fleet.service` | yes, TOML written, daemon up, mesh down |
| `--no-easytier` chosen (elevated stage only) | `[install-elevated] skipping the mesh transport. Nothing was written to /etc/easytier and the staged secret was left alone. Install EasyTier yourself at /opt/easytier, then re-run this command without the flag.` | 0 | install EasyTier, re-run | yes, sudoers written, no TOML, staged secret intact |
| Mesh address configured but not up yet (between the Identity card and the sudo step) | The daemon logs `node: mesh address 192.0.2.5 is not on any interface yet -- listening on all interfaces until the mesh is up and the daemon restarts` and the Mesh card says `The mesh address is set but not up on this machine yet, so the node is listening on all interfaces. The root step below is what brings it up.` | 0 | finish the sudo step, which brings the mesh up and restarts the node onto the address | yes, daemon up, console reachable, mesh down |
| Secret adoption never completed | The Mesh card reports `A secret is staged and waiting for the one root step below.` (`ui/app.js:44`), fed by `meshSecretState()` returning `pending` (`src/node.ts:834-841`) | n/a | run the printed sudo command | yes, daemon runs, mesh down |
| B cannot reach A when pairing | `Could not reach that address. Check the mesh IP and port, and that the other daemon is running.` (`ui/app.js:82`) | n/a | check the mesh is up on both, and the address is A's mesh IP with port 7710 | yes, nothing paired |
| Pairing code expired or mistyped | `That code was not accepted. Codes are single use and last five minutes -- show a fresh one and try again.` (`ui/app.js:81`) | n/a | mint a fresh code on A | yes, code burns after 5 bad attempts (`src/pairing.ts:56`) |
| Re-run on a half-installed system | `[quickstart] resuming: config present, unit missing. Writing the unit and starting the daemon.` | 0 | nothing, the re-run finishes it | yes |
| Uninstall on a machine never installed | `[uninstall] nothing to remove: no sukarfleet.service, no /etc/sudoers.d/sukarfleet-transport, no easytier-fleet.service. Left everything alone.` | 0 | nothing | yes |

## 7. Timing budget

A fresh Ubuntu 24.04 VM, a normal home connection, one user at it. Wall clock from Enter on the
`curl` line to a paired machine. Three stages are measured by the installer, three stretches by a
human with a stopwatch: the split S8 records.

**Checkout stage, 10 s** (measured, `[get] checkout stage done in NNs`): clone or fetch at the tag
and hand over. On a re-run this is most of the wall clock, which is why it has its own number
(**new in S7**).

**User stage, 62 s** (measured, `[quickstart] done in NNs`): preflight 2 s; Bun install when absent
25 s; `bun install --frozen-lockfile` 5 s; config, SSH key, directories, credential probe 5 s; unit
install, enable, start, wait for `/health` 10 s (the poll allows 20 s, `quickstart.sh:325-331`);
tray fetch, checksum, autostart, launch 15 s.

**Human in the console, 45 s** (stopwatch, console open to a staged secret on the Mesh card):
identity, then generate or paste the mesh secret. **Human at the terminal, 30 s** (stopwatch, banner
on screen to the password entered): reading the four numbered lines and copying the command.

**Elevated stage, 58 s** (measured, `[install-elevated] done in NNs`): guard, read, TOML written and
staged file shredded 3 s; EasyTier fetch, checksum, unzip, install 45 s; unit, firewall, `enable
--now` and the confirmation from the service manager 10 s. **Mesh and pairing, 30 s** (stopwatch):
the mesh converges, then a code is shown on A and redeemed on B.

Total: 3 minutes 55 seconds, 65 seconds of headroom under five minutes. **The two most likely to
blow it** are the EasyTier fetch, a real download from a third-party release page where a slow
mirror turns 45 seconds into minutes, and the Bun install: the largest single artefact in the user
stage and, unlike EasyTier, not checksum-verified today (section 8). Both are why S8 records the two
measured stage durations separately, not one total.

## 8. Out of scope for v1

- **macOS and Windows.** Both are implemented and labelled experimental in `docs/PLATFORMS.md`,
  meaning not run by the maintainers; the Windows installer at `install/windows/` has never been run
  on Windows. This document is Linux only.
- **Non-apt distros.** The daemon has no distro dependency; the installer's dependency handling
  does. Fedora, Arch and the rest get an honest refusal naming the distro and pointing at section 9
  (decision 6).
- **Relay and roaming beyond the LAN.** The daemon probes a WAN address through `api.ipify.org` and
  `icanhazip.com` and publishes it in its endpoint file (`src/endpoints.ts:57`), preferring a LAN
  candidate when two machines share a WAN IP (`:328-397`). Making that work through arbitrary NAT,
  with a relay when it does not, is its own project.
- **The admin lane.** Off on install (see the config note in Stage 1, not yet true of the scaffold),
  and turning it on is a documented separate step. `SECURITY.md:51-70` states what sealing does and
  does not buy: no protection from another process running as the same user, none from a stolen
  unencrypted disk.
- **Anything AI, and any telemetry** (decision 9). The complete list of third-party calls is four.
  One, `bun.sh`, only when Bun is absent, and **not** checksum-verified today: the Windows path pipes
  the fetched script straight into a scriptblock (`Install-Sukarfleet.ps1:500`) and bash will do the
  equivalent, so S7 pins the Bun version; verifying the installer script itself is a follow-up this
  document names rather than papers over. Two, GitHub, to clone at a tag. Three, GitHub Releases, for
  the EasyTier zip and the tray binary, both SHA256-pinned. Four, the WAN probe the daemon already
  documents and runs after install.

One naming cleanup belongs with these: the scripts and the web console still print "GUI"
(`quickstart.sh:357`, `:365`, `:374`, `:383`, `README.md:37`), and every user-facing surface says
"console" after S7. One word for one thing.

## 9. Appendix: installing by hand on a non-apt distro

The daemon has no distro dependency. This is what the installer would have done, in order, for
someone the preflight refuses.

1. `curl -fsSL https://bun.sh/install | bash`
2. `git clone --branch v0.1.0 <repo-url> ~/.local/share/sukarfleet/app`
3. `cd ~/.local/share/sukarfleet/app && bun install --frozen-lockfile`
4. `SUKARFLEET_SKIP_DISTRO_CHECK=1 ./install/quickstart.sh` (**new in S7**: the escape hatch).
   Nothing in it is apt-specific once the check is past.
5. Open the printed console URL and do identity plus the mesh secret.
6. Install EasyTier from `https://github.com/EasyTier/EasyTier/releases` to
   `/opt/easytier/easytier-core` and `/opt/easytier/easytier-cli`.
7. `sudo ./install/install-elevated.sh --adopt-pending-secret --pending=<path>`, which writes the
   sudoers grant and the TOML against those binaries.
8. `sudo systemctl enable --now easytier-fleet.service`, then open your firewall's equivalent of the
   two listener ports and 7710 from the mesh subnet.

This skips what the installer exists to do: the checksum pin and the firewall rules. Naming that
cost beats pretending an untested best-effort path would have worked.
