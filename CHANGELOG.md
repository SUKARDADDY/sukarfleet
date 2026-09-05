# Changelog

Notable changes are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## Versioning

[Semantic Versioning](https://semver.org/spec/v2.0.0.html). While the version is `0.x`, the wire
protocol may still change: any change to the bytes two machines exchange is a **minor** bump, never
a patch, and it is called out in its entry. Two machines on the same minor version can talk to each
other. Anything else has to be read here first.

## [Unreleased]

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
