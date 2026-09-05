# Third-party components and licensing

sukarfleet's own licensing is a deliberate split: an **AGPL-3.0-or-later** daemon (the network
service) and **MIT** client edges. [`LICENSING.md`](LICENSING.md) draws that line. This file is
about everything that is not ours: what the project depends on, which of it is bundled, which of it
is fetched at install time, and where each obligation lands.

Two words are used strictly below, because the licence question turns on them.

- **Bundled** means the bytes are in this repository, or in an artifact this project publishes.
  Redistribution terms apply.
- **Fetched** means the installer downloads it from its own upstream, verifies it against a
  checksum recorded here, and installs it on the user's machine. The bytes never pass through this
  project.
- **Invoked** means the program is already on the machine and sukarfleet runs it as a separate
  process.

## EasyTier: fetched, not bundled

The mesh transport is [EasyTier](https://github.com/EasyTier/EasyTier), **LGPL-3.0**. It is the one
dependency that needs its own section, because the earlier draft of this file said the installer
does not install it, and that is no longer true.

Both installers fetch it:

- **Linux.** `install/install-elevated.sh` downloads the release asset from EasyTier's own GitHub
  releases and refuses to install it unless its SHA256 matches the pin in
  [`install/easytier-pins.txt`](install/easytier-pins.txt). A pin that has not been computed is not
  a pin: the script exits rather than install something it cannot verify.
- **Windows.** `install/windows/Install-Sukarfleet.ps1` does the same from the same upstream, with
  its own copy of the hashes in a `$MeshHashes` table. The two pin lists are kept in step by hand.

Neither the repository nor any artifact this project publishes contains an EasyTier binary. The
release assets this project uploads are its own daemon and its own tray console.

**The project's position**, stated plainly so a reader can disagree with it: fetching an unmodified
upstream release at install time, verified against a recorded checksum, is not redistribution. The
user's machine obtains the binary from EasyTier, and the network location is written down in the
open. Nothing is relinked, repackaged or modified.

**That position has not been reviewed by a lawyer.** It is recorded as decision 060 in the
project's records, and it was taken on the reasoning above rather than on advice.

Two things follow from that, and both are already in the tree:

- `install-elevated.sh --no-easytier` installs everything else and leaves the mesh transport to
  you. Install EasyTier by hand, and sukarfleet uses it.
- If a review says the fetch is redistribution, the default flips to that flag's behaviour and the
  installer asks rather than fetches. The mechanism to flip is already written, which is the point
  of having the flag before the answer.

If anything ever does vendor the binary -- a one-click bundle, an AppImage, a distro package built
here -- LGPL-3.0 redistribution terms apply from that moment: ship the licence text, provide the
corresponding source or a written offer, and keep EasyTier separately replaceable. A distinct
binary already satisfies the last one. That has to be a decision somebody takes on purpose.

**Compatibility with the daemon's own licence.** LGPL-3.0 is GPLv3-family and permits use from any
licence even when linked. sukarfleet does not link: it runs `easytier-core` as a service and shells
out to `easytier-cli`. LGPL carries no network-service clause, so operating a mesh built on
unmodified EasyTier creates no source-disclosure duty for EasyTier itself.

## The daemon

The daemon is zero-runtime-dependency: it runs on the Bun standard library, with no npm packages at
run time. Its only development dependencies are TypeScript and Bun's type definitions.

| Component | Licence | How it is used |
|---|---|---|
| **Bun** | MIT | The runtime. Fetched by `install/quickstart.sh` from its own installer if the machine does not already have it. |
| **git** | GPL-2.0-only | Invoked. Sync is real git: commits, merges, remotes. |
| **OpenSSH** | BSD-style (permissive) | Invoked. The admin lane's transport, and the sync transport between paired machines. |
| **systemd** (`systemctl`, `systemd-creds`) | LGPL-2.1-or-later | Invoked. Service control on Linux, and credential sealing for the admin lane. |
| **glib / GDBus** (`gdbus`) | LGPL-2.1-or-later | Invoked. Desktop notifications on Linux. |
| **EasyTier** | LGPL-3.0 | Fetched and installed by the installer, run as a separate service. See above. |

Everything marked "invoked" is arm's-length process invocation over a documented command line. That
is not linking and does not make the daemon a derivative work of any of them.

## The tray console (MIT)

[`clients/tray/`](clients/tray/) is a separate binary that speaks to the daemon over its loopback
HTTP API. Its direct Rust dependencies, from
[`clients/tray/src-tauri/Cargo.toml`](clients/tray/src-tauri/Cargo.toml):

| Crate | Version | Licence |
|---|---|---|
| `tauri` (features `tray-icon`, `image-png`) | 2 | Apache-2.0 OR MIT |
| `tauri-build` (build dependency) | 2 | Apache-2.0 OR MIT |
| `tauri-plugin-notification` | 2 | Apache-2.0 OR MIT |
| `tauri-plugin-clipboard-manager` | 2 | Apache-2.0 OR MIT |
| `tauri-plugin-opener` | 2 | Apache-2.0 OR MIT |
| `tauri-plugin-autostart` | 2 | Apache-2.0 OR MIT |
| `serde` (feature `derive`) | 1 | MIT OR Apache-2.0 |
| `serde_json` | 1 | MIT OR Apache-2.0 |
| `reqwest` (features `json`, `rustls-tls`) | 0.12 | MIT OR Apache-2.0 |
| `tokio` (features `time`, `macros`, `sync`) | 1 | MIT |
| `dirs` | 6 | MIT OR Apache-2.0 |

`reqwest` is built with `default-features = false` and `rustls-tls`, so the TLS stack is
**rustls** (Apache-2.0 OR ISC OR MIT) rather than the system OpenSSL. The licences above were read
from each crate's registry metadata on 2026-09-05; `reqwest` and `dirs` were checked against the
registry API directly. The full transitive tree, with exact versions, is
[`clients/tray/src-tauri/Cargo.lock`](clients/tray/src-tauri/Cargo.lock), which is committed.

Every one of these is permissive. None of them imposes a copyleft obligation on the tray or on
anything that embeds it.

`@tauri-apps/cli` (Apache-2.0 OR MIT) is a build-time development dependency and ships in nothing.

**Linux desktop libraries.** On Linux, Tauri links dynamically against the system's
`webkit2gtk-4.1` and GTK stack (LGPL-2.1-or-later), and the tray icon needs
`libayatana-appindicator3` (LGPL-2.1-or-later / LGPL-3.0). These come from the distribution, are
not bundled, and are dynamically linked, which is the case LGPL section 4 exists for: the user can
replace the shared library. `install/quickstart.sh` probes for both and skips the tray with a
printed reason rather than installing a binary that cannot start.

## Bundled: the font

| Component | Licence | Where |
|---|---|---|
| **IBM Plex Sans** (two woff2 files) | SIL Open Font License 1.1 | `clients/tray/src/fonts/` |

This is the one third-party thing whose bytes are in this repository. OFL condition 2 requires the
licence text to travel with every copy, so it does:
[`LICENSES/OFL-1.1.txt`](LICENSES/OFL-1.1.txt) is the full text and
[`clients/tray/src/fonts/LICENSE.txt`](clients/tray/src/fonts/LICENSE.txt) is the notice sitting
beside the files. "Plex" is a Reserved Font Name under condition 3.

## The Windows lane

The Windows installer uses operating-system components that Microsoft ships with Windows. They are
not dependencies in the packaging sense: nothing is fetched, nothing is bundled, and there is no
licence obligation on this project for any of them.

| Component | What it does here |
|---|---|
| Windows PowerShell 5.1 and PowerShell 7 | The installer itself. It is written to run under both. |
| DPAPI (`ProtectedData`, CurrentUser scope) | The credential store backend, in place of `systemd-creds`. |
| Task Scheduler (`Register-ScheduledTask`) | Starts the daemon at logon, in place of a systemd user unit. |

The honest gap on that platform is in [`docs/PLATFORMS.md`](docs/PLATFORMS.md), not here: there is
no privilege-elevation tool that reads a password from stdin, so the admin lane refuses by name.

## Summary

One AGPL-3.0 daemon, MIT edges, one bundled font under OFL-1.1, and one LGPL-3.0 mesh transport
that is fetched from its upstream against a checksum and never shipped by this project. The only
open question in the stack is whether that fetch counts as redistribution, and this file says which
way the project has answered it and on what basis.
