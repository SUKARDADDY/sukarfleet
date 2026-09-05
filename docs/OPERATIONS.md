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

## When a peer looks offline but is not

A signature that stops verifying looks exactly like a peer that went offline: the envelope arrives,
fails its check, and is dropped. Nothing in the logs says "your two machines disagree about the
encoding".

So before concluding a peer is down, check that it is reachable on the mesh at all. If it is
reachable and still silent, and one of the machines recently changed version, suspect the protocol
rather than the network and read `CHANGELOG.md` for that version's entry.
