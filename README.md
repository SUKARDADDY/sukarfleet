# sukarfleet-tray

Native tray-first companion app for the sukarfleet daemon (Tauri v2, Rust core).
The tray icon IS the fleet health signal; the menu is the primary readout
(Linux SNI trays carry no click events — the popover window opens from a menu item).

- Read-only v1: talks to the daemon over loopback HTTP (`GET /api/ui/state`,
  `GET /status`, `GET /health`) from the Rust side only. The webview never
  reaches the daemon (no CORS headers there, by design — do not add them).
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
