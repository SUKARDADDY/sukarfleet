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

One command, on Debian or Ubuntu:

```bash
curl -fsSL https://raw.githubusercontent.com/SUKARDADDY/sukarfleet/v0.1.0/install/get.sh | sh
```

It clones this repository at that tag into `~/.local/share/sukarfleet/app` and runs
[`install/quickstart.sh`](install/quickstart.sh) from the checkout, so the thing that installs you
is a repository at a tag you can read first. Never `sudo curl ... | sh`: nothing in that stage needs
root.

The stage installs Bun if it is missing, writes a config, generates this machine's identity and SSH
key, installs a systemd user unit, starts the daemon, and opens the console. On a desktop the
console is a native tray window; headless, it prints `http://127.0.0.1:7710/ui/`. It is idempotent,
and re-running it with a newer tag is the upgrade path.

Then the console's setup screen takes your machine name and the mesh secret, and prints **one**
command that needs root. It is the only password moment in the whole install:

```bash
sudo ~/.local/share/sukarfleet/app/install/install-elevated.sh \
     --adopt-pending-secret --pending="$HOME/.local/state/sukarfleet/pending-easytier-secret"
```

Copy it from the console rather than from here: both paths are printed there already resolved, and
the daemon honours `SUKARFLEET_STATE`, so the second one is not always under `$HOME`.

That step adopts the staged mesh secret, installs a SHA256-pinned EasyTier, writes
`/etc/easytier/fleet.toml`, starts the mesh transport, opens the listener ports if a firewall is
already running, and grants the daemon permission to restart that one service. Nothing else.

To remove it: `./install/uninstall.sh`, then `sudo ./install/uninstall.sh --elevated` for the
root-owned half. It leaves your repositories, your config and your SSH keys alone.

Running it afterwards, including the restart discipline that keeps a repository from being
corrupted, is [`docs/OPERATIONS.md`](docs/OPERATIONS.md).

The whole flow, including every failure message and its exit code, is
[`docs/INSTALL-FLOW.md`](docs/INSTALL-FLOW.md). Other distros are refused by name with the manual
steps in its appendix.

On Windows, double-click [`install/windows/Add-To-Fleet.cmd`](install/windows/README.md) instead. It
does the same two stages in one file, behind one UAC prompt, and is specific about the two things a
Windows node cannot do.

## Pair two machines

Open the console on both (`http://127.0.0.1:7710/ui/`, or the tray window), click **Pair** on one, and type the code it
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

`~/.config/sukarfleet/config.json`, mode 0600. The console writes most of it. The parts you will touch:

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
- **No personal data, checked by a test rather than by memory.**
  `tests/no-personal-data.test.ts` walks the whole tree on every run and fails on machine names,
  mesh addresses, hostnames and home directories, in fixtures and comments too. It runs in CI as
  its own job.

Contributions are taken under the DCO with a `Signed-off-by` trailer; there is no CLA. See
[`CONTRIBUTING.md`](CONTRIBUTING.md), and [`CODE_OF_CONDUCT.md`](CODE_OF_CONDUCT.md) for how people
here are expected to treat each other. Released versions are listed in
[`CHANGELOG.md`](CHANGELOG.md).

## Licence

AGPL-3.0-or-later for the daemon; MIT for the client, SDK and MCP edges. The boundary is the
network service, and the reasoning is in [`LICENSING.md`](LICENSING.md).
[`THIRD-PARTY.md`](THIRD-PARTY.md) covers everything that is not ours: what is bundled, what the
installer fetches, and where each obligation lands.
