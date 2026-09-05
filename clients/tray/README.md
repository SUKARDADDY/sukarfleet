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
