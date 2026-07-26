# sukarfleet

**One AI agent across all your machines.**

Your agent has a memory, a workspace, and a set of notes. They live on one laptop. When you sit
down at a different machine, the agent starts from nothing — same model, same prompts, no idea what
it did yesterday.

sukarfleet is a small daemon that runs on each of your machines and keeps that state in sync, so the
agent picks up where it left off regardless of which keyboard you are sitting at.

```
  laptop ──────── mesh ──────── desktop
    │                              │
  agent writes a note          agent recalls it
```

It syncs git repositories, so history is preserved, conflicts are real merges rather than
last-write-wins, and nothing is locked inside a proprietary store.

## Status

Early. It runs the maintainers' own two-machine fleet every day, which is the only reason to
believe any of it works. Linux is the tested platform; macOS and Windows are implemented and
untried — see [`docs/PLATFORMS.md`](docs/PLATFORMS.md), which is specific about what that means.

## Install

Requires [Bun](https://bun.sh) and a mesh network between your machines (the daemon does not create
one; it uses one you have).

```bash
git clone <repo-url> sukarfleet && cd sukarfleet && ./install/quickstart.sh
```

That is the whole user-level install: it writes a config, generates this machine's identity and SSH
key, installs a systemd user unit, starts the daemon, and opens the setup GUI. It is idempotent —
re-running it is the upgrade path.

There is exactly **one** step that needs root, kept separate and optional:

```bash
sudo ./install/install-elevated.sh
```

It installs the mesh transport and grants the daemon permission to restart that one service. It
never installs a passwordless rule for anything else.

## Pair two machines

Open the GUI on both (`http://127.0.0.1:7710/ui/`), click **Pair** on one, and type the code it
shows into the other. Mutual trust is established in one round trip: mesh identity and SSH identity
are exchanged together. No terminal required.

## Give your agent access

The daemon exposes a loopback MCP server. Point your agent at it and it gets:

| Tool | Does |
|---|---|
| `fleet.peers` | Live peer table — who is online, what is stale |
| `fleet.tail` | Recent signed audit entries |
| `fleet.admin_status` | Whether the admin lane is usable, and why not if it isn't |
| `fleet.admin_run` | Run a privileged command on a paired machine |

The last one is off by default, and letting an *agent* use it is a second, separate switch. See
[`SECURITY.md`](SECURITY.md) — it is written to be useful rather than reassuring, and it states
plainly what the credential sealing does and does not protect you from.

## Configuration

`~/.config/sukarfleet/config.json`, mode 0600. The GUI writes most of it. The parts you will touch:

```jsonc
{
  "repos": [
    { "name": "memory", "path": "~/.agent/memory" },
    { "name": "workspace", "path": "~/work" }
  ],
  "unionPaths": ["shared-log.jsonl"],   // union-merged instead of newest-wins
  "admin": {
    "enabled": false,                    // the lane itself
    "agentOrigin": "refuse"              // whether an agent may drive it
  }
}
```

Any directory can be a synced repo. Sync moves whatever is in it — including secrets, if you put
them there.

## Development

```bash
bun test          # includes the protocol-freeze fixtures
bunx tsc --noEmit
```

Two things worth knowing before you change anything:

- **The wire protocol is frozen.** [`tests/freeze/`](tests/freeze/README.md) pins the bytes two
  machines exchange, including the canonical-JSON encoder that feeds every signature. A failure
  there is not a stale fixture — it means the change would break a running fleet silently, because
  a signature that stops verifying looks exactly like a peer that went offline.
- **Warts are written down, not fixed.** [`docs/FROZEN-WARTS.md`](docs/FROZEN-WARTS.md) records
  what the freeze is holding in place and what to do about each one once it lifts.

Contributions are taken under the DCO with a `Signed-off-by` trailer; there is no CLA. See
[`CONTRIBUTING.md`](CONTRIBUTING.md).

## Licence

AGPL-3.0-or-later for the daemon; MIT for the client, SDK and MCP edges. The boundary is the
network service, and the reasoning is in [`LICENSING.md`](LICENSING.md).
