# Operating a fleet

Running sukarfleet on machines you care about. Three things are worth knowing before you need them:
how to restart a node without corrupting a repository, what happens when the machines are not all on
the same version, and how to repair a repository that was corrupted anyway.

## Restart discipline

**Restarting mid-sync is how repositories get corrupted.** A daemon killed while git is writing
leaves zero-byte objects and refs pointing at them, and every later sync on that machine aborts with
`fatal: bad object HEAD`. This is not hypothetical: it is the one failure mode this project has
actually suffered, and it is the reason `install/quickstart.sh` refuses to bounce a running daemon
that has repos configured unless you pass `--restart`.

The sequence, in order:

1. `git fsck` every synced repo -- **before** you touch anything.
2. `systemctl --user stop sukarfleet` -- graceful, and wait for it to finish.
3. `git fsck` again -- **after** the stop, before starting anything. This is the step people skip
   and the one that catches damage while it is still cheap.
4. Start: `systemctl --user start sukarfleet`.
5. Verify, below.

If step 3 finds zero-byte objects, or refs pointing at objects that are not there, that is a daemon
that was killed mid-git. Repair before starting -- see below -- rather than starting on top of it.

`./scripts/fleet-guard.sh` runs the whole check across both machines for you, including the fsck.
`--quick` skips the sync-propagation probe, which is the slow part.

## Verifying a node is actually working

A daemon that starts is not a fleet that syncs. Four live checks, and the point of each is that it
crosses the machine boundary:

- `./scripts/fleet-guard.sh` comes back healthy, sync propagation included.
- A marker file written on one machine appears on the other.
- The console serves on both machines.
- `git fsck` is clean on every synced repo, on **both** machines.

If the admin lane is enabled, add an admin command in both directions. A lane that works one way and
not the other is a grant that did not get written, not a network problem.

## Mixed versions are a supported state

**One machine can run a newer version than another and they keep talking.** That is what the wire
protocol freeze in `tests/freeze/` buys, and it is why you upgrade a fleet one machine at a time
rather than scheduling an outage.

Two consequences worth planning around:

- **Upgrade the machine you can afford to lose first.** A laptop that is not always on is a better
  canary than the desktop that holds state for an absent peer. Run the roamer on the new version,
  live, before the always-on machine follows.
- **Keep a rollback on disk until the fleet is boring again.** A version bump is two moves and a
  restart; so is undoing it, but only if the old checkout still exists. Delete it when you have run
  the new version for long enough to believe it, not on the day you upgrade.

The guarantee has a boundary, and it is the version number. While sukarfleet is `0.x`, a change to
the bytes two machines exchange is a minor bump. Machines on the same minor version talk to each
other; across a minor bump, read `CHANGELOG.md` before you split the fleet.

## Repairing a corrupted synced repo

```bash
./scripts/fleet-guard.sh --repair
```

It checks, fixes what is fixable, and re-checks. What it fixes is exactly the failure above: the
zero-byte objects and dangling refs a daemon killed mid-git leaves behind. It backs up what it
touches, and it never touches a working tree -- your uncommitted changes are not in its path.

Two things it needs from you:

- **The daemon must be stopped.** A live daemon races the repair and can re-corrupt what was just
  fixed. `--repair` stops it for you; do not start it again from another terminal while the repair
  runs.
- **A repo it reports as still broken needs a human.** That message means the damage is past what
  removing bad objects fixes. The usual recovery is to re-clone from the peer, which still has the
  history -- sync is git, so the other machine is a complete copy, not a mirror of your damage.

## A Windows node's host key, and re-pairing after an upgrade

A Windows node cannot read its own SSH host key. `%ProgramData%\ssh` is Administrator-only, and the
node runs unprivileged: it can list the directory and see `ssh_host_ed25519_key.pub` sitting there,
and it is refused when it opens it. The `.pub` files are locked down alongside the private ones.

It therefore learns its host keys by asking its own sshd over loopback, which is what an SSH server
hands to any client that connects. If nothing is listening, it falls back to minting a key under
the state dir, which keeps a node with no sshd pairable at all.

**A node that paired before this needs re-pairing.** The older behaviour advertised the minted key
even when sshd was running, so its peers pinned an identity sshd never presents and every approach
on the admin lane failed `hostkey-mismatch`, permanently. Changing what the node advertises does not
update a pin somebody else already took. Re-pair the two machines and the new pin carries the key
sshd actually serves.

How to tell you are looking at this rather than at something hostile: the fingerprint the lane
reports as "presented" will match what the machine has been serving all along, which you can check
against any `known_hosts` entry written when someone last connected by hand. A key that changed is a
different event and deserves the suspicion the refusal implies.

## A corrupt git index repairs itself

An unclean shutdown -- a power cut, a hard reset -- can leave `.git/index` as garbage while every
commit and every file in the working tree is fine. The index holds nothing that is not recoverable
from HEAD plus the worktree, but git refuses to run without a readable one, and `git status` is the
first thing the sync cycle does. Before this repair existed, one power cut stopped a repo syncing
and it stayed stopped for two days, reporting the same fault every half hour.

Now the daemon quarantines the bad file as `.git/index.corrupt-<timestamp>`, rebuilds the index
from HEAD, and retries the cycle once. You learn about it from a `sync: corrupt git index rebuilt
from HEAD` line and from the repo's sync fault clearing on its own. The corrupt bytes are kept
rather than deleted -- they cost 30 KB and they are the only evidence of what happened.

Nothing else in the sync cycle self-heals, and that is deliberate. This repair is safe because the
index is derived state; it cannot lose a commit, cannot touch a file you edited, and cannot resolve
a conflict on your behalf. A held `index.lock` (another process is mid-write) and an unmerged index
(a real conflict, waiting for a human) are both left alone.

## An audit gap that is never coming back

`N gap(s) in an audit sequence` means signed entries are missing from a machine's run. There is no
repair: entries are signed over their seq, so the missing ones cannot be re-minted or renumbered
away. The fault stays active and re-notifies every `thresholds.alarmRepeatMin` until you say
otherwise.

First find out what took them. An unclean shutdown is the common answer, and the entries lost are
the ones written in the minutes before it:

```bash
journalctl --list-boots        # a boot that ends with no shutdown sequence is a crash
```

If that explains it, accept the gaps that exist right now:

```bash
bun run src/audit-baseline.ts ~/AI_Agent/sukarfleet-audit.jsonl --gaps --dry-run   # look first
bun run src/audit-baseline.ts ~/AI_Agent/sukarfleet-audit.jsonl --gaps
```

The baseline is machine-local and never synced, for the same reason the fork baseline is not:
somebody who can write the shared repo must not also be able to ship the file that declares the
entries they removed acceptable. Each accepted gap is keyed by its edges, so if more entries later
vanish from the same run, the gap's edges move and it alarms again. Accepting one hole can never
bless a bigger one.

`--gaps` is opt-in and stays opt-in. Do not reach for it to quiet a noisy board. A gap is also what
a machine erasing its own history looks like, and the only thing that can tell that apart from a
power cut is a human who knows what happened.

## A machine that is asleep is not a fault

A roamer is shut, carried, and opened somewhere else. That whole arc is normal, so the daemon does
not alarm on it. `/status` shows the peer offline the moment presence lapses, as it always has, but
the `peer-offline` fault only appears once the peer has been out of contact for
`thresholds.peerOfflineAlarmMin` (default 720 minutes, half a day). By then the useful reading is
"that machine's copy of the work is drifting" rather than "somebody closed a lid".

When it does fire, it fires once. The fault stays latched in `/status` and the tray for as long as
the peer is away, and speaks again only to report the recovery. A peer the daemon has never heard
from has no absence to measure and is reported straight away.

Two knobs, for a fleet that is not built around roamers:

```jsonc
"thresholds": {
  "peerOfflineFactor": 3,      // presence: how many missed gossip rounds read as "not here"
  "peerOfflineAlarmMin": 0     // fault: 0 alarms the second presence lapses
}
```

An anchor going dark is a different fault and none of this applies to it. A roamer that cannot
reach the anchor raises `anchor-unreachable` from the transport, immediately, at critical urgency.

## When a peer looks offline but is not

A signature that stops verifying looks exactly like a peer that went offline: the envelope arrives,
fails its check, and is dropped. Nothing in the logs says "your two machines disagree about the
encoding".

So before concluding a peer is down, check that it is reachable on the mesh at all. If it is
reachable and still silent, and one of the machines recently changed version, suspect the protocol
rather than the network and read `CHANGELOG.md` for that version's entry.
