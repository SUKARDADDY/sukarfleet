# Licensing

This repository is deliberately split across two licences. The boundary is the
network service, not the language or the directory depth.

| Path | Licence | Why |
|------|---------|-----|
| `src/**` (the daemon), `ui/**`, `scripts/**`, `install/**`, `systemd/**` | **AGPL-3.0-or-later** | The daemon is the service, and everything here ships with it. AGPL's section 13 is the point: a modified daemon offered to others over a network has to offer its source back. |
| `sdk/**`, `mcp/**`, `clients/**` | **MIT** *(reserved — no such files yet)* | The edges are things other people embed. A copyleft edge would make the daemon unadoptable by the agents and tools it exists to serve. **Today the repository ships no MIT-licensed file:** the MCP server is part of the daemon and is AGPL like the rest of `src/**`. This row is the rule for edges when they are extracted, not a description of the current tree. |
| `tests/**` | Follows the code under test | A test is not separately distributable. |
| `LICENSES/**`, docs, fixtures | No licence claim beyond the repo default (AGPL-3.0-or-later) | |

Full texts: [`LICENSES/AGPL-3.0.txt`](LICENSES/AGPL-3.0.txt) and
[`LICENSES/MIT.txt`](LICENSES/MIT.txt). `LICENSE` at the repo root is the AGPL,
because the repo's default and its most-restrictive term should be the one a
reader hits first.

Every source file carries an `SPDX-License-Identifier:` header naming which of
the two applies to it. Where a file's header and this table disagree, the file
header wins — it travels with the code, this table does not.

## Contributing

See [`CONTRIBUTING.md`](CONTRIBUTING.md). Contributions are accepted under the
Developer Certificate of Origin (DCO) with a `Signed-off-by:` trailer. There is
no CLA, and there will not be one: a CLA asks contributors to hand over rights
so the project can later relicense, and this project is not reserving that
option.
