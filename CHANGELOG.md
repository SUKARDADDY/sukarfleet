# Changelog

Notable changes are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## Versioning

[Semantic Versioning](https://semver.org/spec/v2.0.0.html). While the version is `0.x`, the wire
protocol may still change: any change to the bytes two machines exchange is a **minor** bump, never
a patch, and it is called out in its entry. Two machines on the same minor version can talk to each
other. Anything else has to be read here first.

## [Unreleased]

### Added

- **One-click enrollment, generated from the console.** The Fleet screen has an "Add a machine" card
  that writes a single double-clickable `.cmd` for a Windows machine that is not here yet. It
  carries the fleet's network name, its mesh secret, a mesh address allocated at mint, and a
  single-use enrollment token. Copy it to the machine, double-click it, accept one UAC prompt, and
  the machine installs itself and pairs with the one that generated it. Nothing is typed on the
  other end. New: [`src/enroll.ts`](src/enroll.ts) (the token store),
  [`src/meshalloc.ts`](src/meshalloc.ts) (the address allocator),
  [`src/installer.ts`](src/installer.ts) (rendering and issuing), and `/api/ui/enroll` on the
  console API. **Wire change:** `/pair/hello` accepts an optional `enrollId` in its payload, naming
  which credential the MAC is taken under. A hello without one canonicalises exactly as before, so
  a machine on an older version pairs with a machine on this one as it always did.
  - The token is 256 bits, single use, bound to one machine name and one mesh address, and expires
    after 24 hours. The daemon stores the key derived from it, never the token.
  - **The generated file is a bearer credential**: it carries the mesh secret, so anyone holding it
    can join the mesh until it expires. Revoking closes pairing and does not rotate the secret. The
    file says so at the top, in plain text, above the payload. See
    [`SECURITY.md`](SECURITY.md#trust-model).

- **A Windows installer that can install machine-wide.** One EXE,
  `sukarfleet-setup-windows-x86_64.exe`, built by
  [`.github/workflows/installer-windows.yml`](.github/workflows/installer-windows.yml) and asking
  which scope you want. **Per-user** is the install Windows has always had here: a scheduled task
  named `sukarfleet`, running as you, gone when you sign out. **Machine-wide** is new: a Windows
  service named `sukarfleet-node`, start type `Automatic`, running as the virtual account
  `NT SERVICE\sukarfleet-node` rather than as SYSTEM, up at boot with nobody signed in. It keeps one
  fleet identity for the PC in `C:\ProgramData\sukarfleet\node` and one shared checkout at
  `C:\AI_Agent`, and it can adopt an existing per-user install in place rather than pairing again.
  New: `install/windows/sukarfleet.iss`, `Install-MachineNode.ps1`, `Uninstall-MachineNode.ps1`,
  `Pins.ps1` and `sukarfleet-node.xml`. `Add-To-Fleet.cmd` is unchanged, and one-click
  enrollment still generates the `.cmd`. `Install-Sukarfleet.ps1` now reads the tray pin through
  the shared `Pins.ps1` instead of its own copy of the parser.
  - The EXE is **not signed**. SmartScreen warns, and the SHA256 the build prints is the check that
    is available until a certificate exists.
  - Uninstall removes the service, the program and the registry entries and keeps the node
    directory, the shared checkout and the mesh service, and says so.
  - The service pins `core.hooksPath`, `core.fsmonitor=false` and `commit.gpgsign=false` with
    `GIT_CONFIG_COUNT`, which ranks above a repository's own config. The shared root is writable
    by every local account, so a repository's config is not trusted; the global gitconfig alone
    lost to it. This needs git 2.31, and the installer refuses an older git. Filter and merge
    drivers have no such switch: [`SECURITY.md`](SECURITY.md) says to remove write access to the
    shared root for any account you exclude from the console token.
  - Adoption copies the key named by the adopted config's `admin.keyPath` (and its `.pub`), not
    only `~/.ssh/id_sukarfleet_ed25519`, and checks both copies before the old node is stopped. A
    configured key that cannot be read refuses the install with nothing changed.

- **A console token, for a node more than one account can reach.** A machine-wide node shares its
  loopback with every account on the PC, and loopback is not a caller identity, so `/api/ui/*` and
  `POST /mcp` now accept an optional bearer token. Set `admin.consoleTokenFile` and the node reads
  that file and compares in constant time; leave it absent and nothing changes, which is what a
  per-user install does. A refused request is `401` with `error: "console-token-required"`; the
  browser console asks for the token on exactly that, holds it in `sessionStorage`, and the tray
  takes `--token-file`. `sukarfleet-cli audit tail` and `admin run|status|trust` read the same
  `admin.consoleTokenFile` from their config and send the header themselves; a file that is set but
  unreadable stops them with a message naming the path. `POST /pair/hello`, `/health`, `/status` and the peer routes are untouched:
  a machine that is pairing does not have the token yet. **Who may read that file on a machine-wide
  install, and how to narrow it, is in [`SECURITY.md`](SECURITY.md).**

- **`SUKARFLEET_CONFIG_DIR`.** The directory holding the machine key, the sealed credential and the
  secrets directory can now be moved, which `SUKARFLEET_CONFIG` and `SUKARFLEET_STATE` could not do.
  Absent, it is `~/.config/sukarfleet` exactly as before. The Windows service is what needed it: a
  service account has no profile worth writing an identity into.

- **CI builds the Windows installer and installs with it.**
  `.github/workflows/installer-windows.yml` parses every `install/windows/*.ps1` under Windows
  PowerShell 5.1 and PowerShell 7, compiles the EXE, then runs it silently in both scopes on the
  runner and checks what it left behind: a scheduled task and a `/health` of 200 for per-user, a
  running service and a `401` that turns into a `200` with the token for machine-wide. `ci.yml`
  gains a `pwsh-parse` job so the same parse runs on every pull request. The scripts had no test
  cover of any kind before this.

- **The tray console on Windows.** A Windows machine gets the same tray icon and console window a
  Linux one gets, rather than a URL to paste into a browser.
  [`.github/workflows/tray.yml`](.github/workflows/tray.yml) builds the binary on a Windows runner,
  and `Install-Sukarfleet.ps1` fetches it, checks it against the SHA256 pinned in
  [`install/easytier-pins.txt`](install/easytier-pins.txt), puts it in the Start menu and registers
  it to start at sign-in. Nothing about it can fail an install: an unreleased, unpinned or
  undownloadable tray leaves the machine with the browser console and says which of those it was.
- The tray now follows the platform it runs on. Left click opens the console on Windows and the
  menu on Linux, which is each platform's own convention and, on Linux, the only option, since SNI
  trays deliver no click events. For a node that is not answering it copies the scheduled task's
  start command on Windows instead of systemd's.

### Fixed

- **A stale git lock wedged a repo's sync for twelve days.** The daemon exited over a running git on
  stop, systemd SIGKILLed the git, and the `index.lock` it left made every later `git add` fail.
  Shutdown now drains its children (wait up to 30 s, then SIGTERM, then SIGKILL with the orphaned
  locks removed). A git step the daemon has to SIGKILL no longer leaves its locks behind. Each cycle
  also removes a lock older than `thresholds.staleGitLockMin` (new, default 10 minutes) when no live
  process can still own it, and then carries on in the same tick. A lock someone still holds, such as
  a `git commit` waiting on its editor, is left alone. The rule is machine-wide: nothing is removed
  while anything has the lock open for writing (asked of the kernel with a lease on Linux) or any
  lock-capable git other than the daemon's own is running anywhere on the machine. A cycle
  blocked by a lock, or by a merge someone left open, is deferred instead of reported as a critical
  error, and a merge the daemon itself left half-done is aborted and redone, never committed. See
  [`docs/OPERATIONS.md`](docs/OPERATIONS.md#an-orphaned-git-lock-clears-itself).
- **A push rejected as non-fast-forward stayed rejected.** When origin holds commits on this
  machine's own sync branch that the local branch lost, the cycle now merges origin's copy back under
  the peer-merge conflict rules and retries the push. It never forces.
- **A Linux machine committed a file Windows cannot check out,** `_tmp/x/check:css.log`, and the
  Windows peer's merge failed every cycle after. The auto-commit now leaves out every path Windows
  refuses (`<>:"|?*\`, control characters, a trailing dot or space, reserved names like `CON`) and
  takes any already in the index out of it with `git rm --cached`, leaving the file on disk. The same
  check runs before every commit the daemon makes, merges and `postMerge` output included.
- **A single sync error was 226,000 characters long.** It carried the whole `git add -A -- <every
  path>` argv into `/status`, gossip and the MCP tools. Sync errors are now capped at 2,000
  characters and keep git's `fatal:` and `error:` lines.
- **A peer that drops off one node's routing table while staying on the mesh is now detected and
  healed without a restart.** EasyTier 2.6.4 can delete a peer's route metadata after a short
  outage on one node while that node's route-sync partner never sends it again (upstream
  [EasyTier #2597](https://github.com/EasyTier/EasyTier/issues/2597), fixed in 2.7.0). The peer's
  connection stays up and every other node still routes to it, but this node drops its traffic.
  The daemon now compares `peer-center` with `peer list` on every transport poll and raises a
  critical `peer-route-missing` alarm, named by hostname when it has seen one, after three
  consecutive polls. On the other side, a node that routes to a peer, sees it alive in the peer
  center, and still gets no gossip from it re-announces its own route info. That is the only fix
  for this fault short of a restart. 2.6.4 has no direct command for it, so the daemon creates
  and revokes a throwaway credential, the one runtime field its CLI can change. No connection
  drops. It runs at most once per 15 minutes. `sukarfleet-cli mesh reannounce` does the same by
  hand. See [`docs/OPERATIONS.md`](docs/OPERATIONS.md#a-peer-is-on-the-mesh-but-has-no-route-here).

- **A laptop that was simply asleep raised a critical alarm, then kept raising it.** `peer-offline`
  fired the moment gossip presence lapsed, at critical urgency, and repeated every
  `alarmRepeatMin` for as long as the machine stayed away. A roamer shut for the weekend was worth
  a hundred desktop notifications, none of which anyone could act on, which is how an operator
  learns to ignore the ones that matter. Presence and fault are now two different questions. A
  peer has to be out of contact for `thresholds.peerOfflineAlarmMin` (new, default 720 minutes)
  before its absence is a fault at all, that fault is `normal` rather than `critical`, and it
  notifies once per absence instead of on every repeat. It stays latched and visible in `/status`
  and the tray the whole time, and it still announces its own recovery. Set the threshold to `0`
  for a fleet where every machine is meant to be on, and offline is a fault the second presence
  lapses. An anchor going dark is untouched by any of this: that is `anchor-unreachable`, raised
  from the transport, still immediate and still critical.
- **A latched fault kept the severity it was born with.** `evaluate` refreshed an existing fault's
  message every tick but never its urgency, so a `peer-offline` latched as `critical` under the old
  rules went on reporting `critical` in `/status`, the tray and any monitor reading the fault list
  after the daemon had started calling it `normal`. Found on a live anchor minutes after the change
  above shipped. Urgency is now refreshed the same way the message is. Reclassifying is not an
  event: the latch keeps its `firstSeenMs` and notifies nobody.
- **One machine being off lit two alarms.** A peer that is not on the mesh cannot have a reachable
  SSH admin lane, so `admin-peer-unreachable` was restating `peer-offline` in different words. It
  is now suppressed for a peer presence already reports as offline, and says what it was for: a
  machine that is up and whose lane will not answer.
- **A Windows machine with a capitalised account name could not pair at all.** The installer wrote
  `admin.sshUser` straight from `%USERNAME%`, and `sanitizeBundle` validates every bundle's
  `sshUser` against `^[a-z_][a-z0-9_-]{0,31}$` — including the machine's own. So a box whose user
  was `Ariel` failed its own local validation and pairing died with "This machine has no usable SSH
  identity yet", which named the symptom and not the cause. The installer now folds the account name
  into a name that validator accepts. The value is inert on Windows anyway: the admin lane is off and
  nothing dials it.
- **The Windows installer opened the firewall for the mesh transport but not for the node's own
  port,** so a machine could join the mesh and answer nothing. It now adds an inbound rule for the
  node port scoped to the mesh subnet, which is what the Linux elevated stage has always done.
- **A fresh Windows machine held every commit as "clock unvetted"** because stock W32Time is not
  running. The elevated stage now starts the time service and asks it to resync. A failure is a
  warning: an unvetted clock costs commits, not the install.
- **`docs/PLATFORMS.md` and the installer banner still said pairing does not work on Windows.**
  `e6a2841` fixed that and validated it end to end on a real Windows 10 node; the prose never moved.

### Changed

- The Linux tray pin lookup asks for `sukarfleet-tray-linux-` rather than `sukarfleet-tray-`, which
  the Windows lines also match. Two pins for one version and architecture are refused, not guessed
  between, so leaving it would have cost Linux its tray the moment Windows got one.
- The Windows lane now fetches and bundles third-party code, which it did not before, so
  [`THIRD-PARTY.md`](THIRD-PARTY.md) says so: the Inno Setup loader is bundled inside the EXE this
  project publishes (licence text in [`LICENSES/InnoSetup.txt`](LICENSES/InnoSetup.txt)), and WinSW
  2.12.0 and Bun are fetched against SHA256 pins in
  [`install/easytier-pins.txt`](install/easytier-pins.txt), on the same terms as EasyTier. An
  unfilled pin is a refusal, not an unverified download.

## [0.1.0] - 2026-09-05

First public release. It has run the maintainers' own two-machine fleet daily since 2026-08-04.

### Added

- **The daemon.** A per-machine service that keeps configured git repositories in sync between
  paired machines over a mesh: real commits and real merges, no last-write-wins store. Gossip,
  pairing, health, a loopback console and a loopback MCP server for an agent to read the peer table
  and the audit log. AGPL-3.0-or-later.
- **The tray console.** A native tray application built on Tauri, showing fleet health, and running
  the pairing and setup screens without a terminal. Separate binary, MIT.
- **The Linux installer.** One command on Debian or Ubuntu clones the repository at a release tag
  and installs from the checkout you can read first. Exactly one step asks for a password, and it
  is the one that installs the mesh transport and opens the listener ports. Idempotent: re-running
  it with a newer tag is the upgrade path. Every failure message and its exit code are specified in
  [`docs/INSTALL-FLOW.md`](docs/INSTALL-FLOW.md).
- **The Windows installer, as beta.** `install/windows/Add-To-Fleet.cmd` does both stages behind one
  UAC prompt. Sync, gossip, pairing and the console are implemented and were run end to end on a
  Windows 11 VM on 2026-09-05. It is labelled beta because that VM is the whole of the evidence.
  The admin lane cannot elevate on Windows and says so by name rather than failing at the first
  real call.
- **Security.** The pairing code is 12 characters, stretched with scrypt, so a captured code is not
  crackable offline in the window it is valid for. The audit log is a per-machine hash chain: a
  broken link is a critical fault rather than a silent edit. The threat model, including what the
  credential sealing does not protect you from, is [`SECURITY.md`](SECURITY.md).
- **A frozen wire protocol.** `tests/freeze/` pins the bytes two machines exchange, including the
  canonical-JSON encoder that feeds every signature. A change there breaks a running fleet
  silently, because a signature that stops verifying looks exactly like a peer that went offline.
- **Licensing and contribution.** AGPL-3.0-or-later daemon, MIT edges, DCO sign-off, no CLA.
  [`LICENSING.md`](LICENSING.md), [`CONTRIBUTING.md`](CONTRIBUTING.md),
  [`THIRD-PARTY.md`](THIRD-PARTY.md).

### Known limits

- Linux is the only tested platform. macOS and Windows are implemented and thinly tried;
  [`docs/PLATFORMS.md`](docs/PLATFORMS.md) is specific about which seam is which.
- There is no aarch64 tray build, and the installer says so and prints the web console URL instead.

[Unreleased]: https://github.com/SUKARDADDY/sukarfleet/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/SUKARDADDY/sukarfleet/releases/tag/v0.1.0
