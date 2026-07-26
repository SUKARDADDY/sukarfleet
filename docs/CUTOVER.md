# Cutover runbook

Moving a running fleet onto the extracted code, without an outage.

The constraint that shapes everything here: **a mixed fleet is a supported state.** One machine runs
this code while the other still runs the pre-extraction daemon, and they keep talking. That is what
the protocol freeze exists to guarantee, and it is why cutover can happen one machine at a time.

## Before you touch anything

```bash
./scripts/fleet-guard.sh            # must print FLEET HEALTHY
bun test                            # must be green, freeze fixtures included
bun run tests/freeze/capture-live.ts
bun run tests/freeze/live-check.ts  # must print "Safe: ..."
```

`live-check` is the gate that matters. It takes signatures produced by the **other** machine's
running daemon and re-encodes them with this codebase's canonical-JSON encoder. If they still
verify, this code cannot silently break the peer. If they do not, **stop** — that failure in
production looks like a peer that went offline, with nothing in the logs saying why.

## The path swap

The extracted repository takes over the **same on-disk path** the daemon already runs from. This is
deliberate and it removes three failure modes by construction rather than by handling them:

- the systemd unit's `WorkingDirectory` does not change
- the synced repo's `postMerge` hook path does not change
- every `authorized_keys` forced-command grant keeps pointing at a file that exists

```bash
OLD=<path the daemon runs from today>
NEW=<path the extracted checkout is at>

systemctl --user stop sukarfleet
mv "$OLD" "${OLD}.personal"     # rollback lives here; do not delete it
mv "$NEW" "$OLD"
systemctl --user start sukarfleet
```

Rollback is the same two moves in reverse plus a restart. Keep `.personal` on disk for the whole
canary window.

## Restart discipline

Restarting mid-sync is what corrupted repositories on this fleet before. It is cheap to avoid:

1. `git fsck` every synced repo — **before**
2. `systemctl --user stop sukarfleet` — graceful, wait for it
3. `git fsck` again — **after the stop**, before starting anything
4. start
5. verify (below)

If step 3 finds zero-byte objects or refs pointing at them, that is a daemon killed mid-git. Repair
before starting: `./scripts/fleet-guard.sh --repair`.

## Order: the roamer canaries

**The laptop moves first.** The always-on machine holds state for an absent peer and is the one you
cannot afford to lose; it stays on the personal repo until the roamer has run clean.

## Entry check — all four, live, before declaring a machine cut over

```bash
./scripts/fleet-guard.sh            # 10/10, including sync propagation
```

Plus, by hand:

- an admin command in **both** directions
- the GUI serving on both machines
- a marker file written on one machine appearing on the other
- `git fsck` clean on every synced repo, on both machines

## What changes on first boot

The config loader migrates two fields out of the dropped `exec` block and writes them into their new
homes. The legacy block is left in the file untouched, so a rollback finds its config exactly as it
left it.

| Was | Becomes | Why it matters |
|---|---|---|
| `exec.auditRepo` | `admin.auditRepo` | Gates the audit union flush. Losing it does not raise — the audit log just silently stops reaching the synced file. |
| `exec.mcpPort` | `mcpPort` | The loopback MCP port: the agent's whole way in. |

**One behavioural change to be deliberate about.** A config carrying the legacy block predates the
agent-origin switch, and on that deployment an agent could already drive the admin lane. The
migration therefore writes `admin.agentOrigin: "allow"` **explicitly** and warns, rather than
defaulting to `refuse` and breaking working automation mid-cutover.

If you want the product default instead — a human drives the lane, an agent cannot — set it after
the fleet is stable, not during the canary window:

```jsonc
"admin": { "agentOrigin": "refuse" }
```

## After both machines are across

- Run the fleet for 14 consecutive days with no rollback before calling it done.
- Then, and only then, the protocol freeze lifts. Work through
  [`FROZEN-WARTS.md`](FROZEN-WARTS.md); each entry says what to do once it is safe.
- Delete `.personal` last, after the freeze lifts — not before.
