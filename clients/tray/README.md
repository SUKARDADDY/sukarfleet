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

Port discovery: `~/.config/sukarfleet/config.json` `.nodePort` (or
`SUKARFLEET_CONFIG`), fallback 7710. `--endpoint` overrides everything.
