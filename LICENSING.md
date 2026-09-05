# Licensing

This repository is deliberately split across two licences. The boundary is the
network service, not the language or the directory depth. Two things sit outside
both: a bundled font that is somebody else's, and the project's own marks.

| Path | Licence | Why |
|------|---------|-----|
| `src/**` (the daemon), `ui/**`, `scripts/**`, `install/**`, `systemd/**` | **AGPL-3.0-or-later** | The daemon is the service, and everything here ships with it. AGPL's section 13 is the point: a modified daemon offered to others over a network has to offer its source back. |
| `clients/**` (live today: `clients/tray/**`), `sdk/**`, `mcp/**` *(reserved)* | **MIT**, with the two carve-outs below | The edges are things other people embed. A copyleft edge would make the daemon unadoptable by the agents and tools it exists to serve. **The native tray is the first edge to land, and it is MIT today:** `clients/tray/**` is a separate binary that speaks to the daemon over the daemon's local HTTP API, so it is a client of the service rather than part of it. `sdk/**` and `mcp/**` remain reserved — no such files exist yet, and the MCP server is still part of the daemon and AGPL like the rest of `src/**`. For those two, this row is the rule for when they are extracted, not a description of the current tree. |
| `clients/tray/src/fonts/*.woff2` | **OFL-1.1** | Bundled IBM Plex Sans. Not ours: IBM's, under the SIL Open Font License 1.1, with Reserved Font Name "Plex". Full text in [`LICENSES/OFL-1.1.txt`](LICENSES/OFL-1.1.txt), notice in [`clients/tray/src/fonts/LICENSE.txt`](clients/tray/src/fonts/LICENSE.txt). OFL condition 2 means both travel with any copy of the font files. |
| `clients/tray/brand/**`, and the icons derived from it in `clients/tray/src-tauri/icons/**` and `clients/tray/src/assets/**` | **No licence granted** | These are the project's marks -- the sukarfleet symbol and wordmark. They are excluded from the MIT grant above: MIT covers the code, not the identity. You may use them to refer to sukarfleet, and not to imply the project endorses you or to brand other software. This is the conventional default for a project's own marks; loosening it is the owner's call to make later, in writing. |
| `tests/**` | Follows the code under test | A test is not separately distributable. |
| `LICENSES/**`, docs, fixtures | No licence claim beyond the repo default (AGPL-3.0-or-later) | |

Full texts: [`LICENSES/AGPL-3.0.txt`](LICENSES/AGPL-3.0.txt),
[`LICENSES/MIT.txt`](LICENSES/MIT.txt) and
[`LICENSES/OFL-1.1.txt`](LICENSES/OFL-1.1.txt). `LICENSE` at the repo root is the AGPL,
because the repo's default and its most-restrictive term should be the one a
reader hits first. [`clients/tray/LICENSE`](clients/tray/LICENSE) says the tray
is the exception, for anyone who reads that directory without reading this file.

Every source file carries an `SPDX-License-Identifier:` header naming which of
the two applies to it. Where a file's header and this table disagree, the file
header wins — it travels with the code, this table does not. The font files and
the brand assets carry no such header, because neither is under either licence;
the two carve-out rows above are the whole story for them.

## Contributing

See [`CONTRIBUTING.md`](CONTRIBUTING.md). Contributions are accepted under the
Developer Certificate of Origin (DCO) with a `Signed-off-by:` trailer. There is
no CLA, and there will not be one: a CLA asks contributors to hand over rights
so the project can later relicense, and this project is not reserving that
option.
