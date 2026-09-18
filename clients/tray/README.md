# sukarfleet-tray

Native tray-first companion app for the sukarfleet daemon (Tauri v2, Rust core).
The tray icon IS the fleet health signal; the menu is the primary readout
(Linux SNI trays carry no click events — the popover window opens from a menu item).

- The console window is a full setup and pairing surface, not a read-only
  view. Every request goes through an allowlisted Rust bridge (`api_call` in
  `src-tauri/src/api.rs`): reads like `GET /api/ui/state`, and writes like
  `POST /api/ui/setup/identity`, `/api/ui/setup/network-secret`,
  `/api/ui/pair/code`, `/api/ui/pair/redeem`, `/api/ui/pair/revoke`,
  `/api/ui/credentials/sudo` and `/api/ui/admin/run`. The allowlist is what
  keeps the bridge from becoming a generic localhost proxy, and nothing on the
  credentials route is ever logged. The webview never reaches the daemon
  itself (no CORS headers there, by design — do not add them), and it loads
  the bundled `src/index.html`, not the daemon's `/ui/`.
- The daemon's zero-runtime-deps claim is about the Bun daemon process; this
  client is a separate binary with its own Cargo dependency tree.
- Notifications go through the same `org.freedesktop.Notifications` DBus
  interface the daemon uses. The tray's win is the persistent bus-independent
  icon plus coalesced, diffed notifications — not a bus workaround.
- GNOME needs the AppIndicator/StatusNotifier extension (`ubuntu-appindicators`)
  or the icon will not appear. KDE works natively.
- Platform differences live in `tray.rs` and are two: the primary click, and
  what the unreachable menu copies. Linux SNI trays deliver no click events, so
  the menu has to open on the primary click; Windows delivers them and expects
  left for the thing, right for the menu. And a node that is not answering is a
  systemd user unit on Linux and a scheduled task on Windows, so the commands
  offered for the clipboard differ. There is no log command on Windows: the
  installer's preferred task runs hidden and its output goes nowhere, and the
  fallback it uses on an account without the batch-logon right runs in a visible
  console window that nothing captures either. Naming a log file that does not
  exist would send someone looking for it.

## Building for Windows

`.github/workflows/tray.yml` builds it on a Windows runner and uploads
`sukarfleet-tray-windows-x86_64.exe` as an artifact, with the pin line for
`install/easytier-pins.txt` printed in the log. Nothing here cross-compiles: a
Windows binary produced on Linux is one nobody has run.

To build it by hand on a Windows machine, install rustup with the MSVC toolchain
and the Visual Studio C++ build tools, then:

```powershell
cd clients\tray\src-tauri
cargo build --release --locked
```

From the crate directory, not with `--manifest-path` from the repository root:
`.cargo/config.toml` there links the C runtime into the binary, and cargo finds
that file by walking up from the working directory. A build started elsewhere
produces a binary that needs the Visual C++ Redistributable installed and hangs
before `main` on a machine without it.

There is no frontend build step on any platform. `src/` is static files that
tauri-build embeds as they are. The executable's icon comes from
`src-tauri/icons/icon.ico`, which `bun run icons` generates with everything
else; a build without that file is fine and ships the generic icon.

## Dev

Requires: rustup stable, `libwebkit2gtk-4.1-dev libayatana-appindicator3-dev
librsvg2-dev libssl-dev build-essential pkg-config patchelf`, bun.

```
bun install
bun run icons        # regenerate tray/app PNGs
bun run dev          # against the real daemon on 127.0.0.1:<nodePort>
```

Fault paths are exercised against the fixture server, never by breaking the
real daemon:

```
bun run fixture      # canned UiState server on 127.0.0.1:7799
bun run dev -- -- --endpoint http://127.0.0.1:7799
```

A machine-wide node is exercised the same way, with the fixture demanding the
token the real daemon would:

```
SUKARFLEET_FIXTURE_TOKEN=fixture-token bun run fixture
printf 'fixture-token' > /tmp/sukarfleet-console-token
bun run dev -- -- --endpoint http://127.0.0.1:7799 --token-file /tmp/sukarfleet-console-token
```

Without the header the fixture answers 401 with `WWW-Authenticate: Bearer
realm="sukarfleet"` and the daemon's refusal body, so the paths that handle a
gated node are reachable without installing one. `/status` and `/health` stay
open there, as they are on the daemon.

## Flags and environment

- `--endpoint http://127.0.0.1:7710`, or `--endpoint=...`, overrides discovery.
- `--token-file <path>`, or `--token-file=<path>`, names the file holding this
  node's console token. `SUKARFLEET_TOKEN_FILE` does the same; the flag wins.
- `SUKARFLEET_CONFIG` locates the daemon config used for port discovery. A
  value ending in `.json` is the config file itself; anything else is the
  directory holding `config.json`. The daemon reads this variable as a file and
  the machine-wide Windows service sets it to one, so both shapes are accepted.
- Port discovery order: `--endpoint`, then `nodePort` from that config file,
  then 7710.

## Service mode

A configured token file is what this app means by service mode: it is what the
machine-wide Windows installer passes and what a per-user install never does.
That node's daemon answers `/api/ui/*` with 401 unless the request carries
`Authorization: Bearer <token>`, so in service mode:

- Every request to the daemon carries the header, on the background status poll
  and through the console bridge alike. The file is read per request and
  trimmed, so a rotated token takes effect without a restart.
- An unreadable or empty file is a sentence, never a panic. The tray header
  carries it, the bridge answers the console locally rather than sending a
  request that can only fail, and the node is not reported as unreachable: it
  may be perfectly healthy.
- The menu gains "Copy console token", which puts the trimmed file contents on
  the clipboard for a browser console or an `ssh -L` session.
- The "Start at login" checkbox is replaced by a disabled line naming its owner.
  Startup is the installer's HKLM Run value, which carries both the endpoint and
  the token file; a checkbox here would write an HKCU value with neither and
  start a second, token-less tray.
- The unreachable-node menu copies `Start-Service sukarfleet-node` and
  `Get-Service sukarfleet-node` rather than the scheduled-task commands. There
  is no machine-wide install outside Windows yet, so the systemd user unit
  commands still stand on Linux.
