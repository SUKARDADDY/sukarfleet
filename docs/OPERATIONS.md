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

This repair is safe because the index is derived state. It cannot lose a commit, cannot touch a file
you edited, and cannot resolve a conflict on your behalf. An unmerged index (a real conflict, waiting
for a human) is left alone. So is any lock another process may still hold, which the next section
covers.

## An orphaned git lock clears itself

git takes a lock file (`index.lock`, `refs/heads/<branch>.lock`, and a few others) before it writes,
and deletes it when it is done or when it is told to stop. A git that is SIGKILLed, or that dies in a
crash, leaves the lock behind, and git never times one out. One repo stopped syncing for twelve days
this way: every cycle failed at `git add` with `Unable to create '.../index.lock': File exists`.

Three things now stop that from happening or clear it up.

- `systemctl --user stop` no longer exits over a running git. The daemon waits up to 30 seconds for
  git steps in flight, then sends SIGTERM, which git answers by deleting its own lock. SIGKILL comes
  only after that, and the daemon removes whatever lock that kill orphaned. The whole thing takes at
  most 40 seconds, under systemd's 90 second stop timeout. A merge the daemon was in the middle of
  is still aborted after the 30 seconds run out, and if the process dies before it can be, the next
  cycle aborts and redoes it. Conflict markers are never committed.
- When the daemon has to SIGKILL a git step that hung, it removes the locks that step created.
- At the start of every sync cycle, a lock last written more than `thresholds.staleGitLockMin` ago
  (default 10 minutes) is removed if no live process can still own it. The cycle then carries on in
  the same tick.

"No live process can own it" is a machine-wide rule, and a blunt one. A lock is removed only when no
process of yours that the daemon can see into has the lock file open, and no git that can take
locks is running anywhere on the machine, apart from the daemon's own git steps. A git is recognised
by its command name even if it renamed its `argv[0]`, and then counts as able to take locks. Read-only commands like `log`, `diff` and `show`, remote and credential helpers,
`upload-pack`, `fsmonitor--daemon` and `cat-file --batch` don't count, so a pager left open doesn't
block the repair. `status` does count.

"Nobody has it open" alone would not be enough. `git commit -a` closes `index.lock` before it
starts your editor and keeps the lock until the editor exits, with no file descriptor open on it.
And working out which repository a running git is using, from its paths, turned out to be
guesswork: review found a symlinked or relative `--git-dir`, `GIT_DIR` in the environment, a linked
worktree, a bind mount in a sandbox and a path with spaces, and each one fooled it into deleting a
live lock. So the daemon no longer guesses.

There is one accepted gap. Some processes hide their open files even from their own user: `(sd-pam)`
under every `systemd --user`, `ssh-agent`, most Electron apps. Treating them as holders meant a Linux
desktop never repaired a lock at all, so they are ignored. The gap is a process like that, which is
not git, holding a git lock file open for longer than `staleGitLockMin`. Only git implementations open
`.git/*.lock`, and library ones such as libgit2 and JGit hold a lock for a moment, so a lock untouched
that long whose only holder is such a process has a hung holder. Any git is still caught by name,
whether its open files can be read or not.

The cost is time. A long-lived git anywhere on the machine, such as a commit in some other repo
waiting on its editor, holds off every repair until it exits. IDE `git status` loops are short, so
there are gaps between them, and each sync cycle asks again.

On Linux the daemon reads all of this from `/proc`, using `readlink` on open files so a dead network
mount can't hang the check. On macOS it uses `lsof` and `ps`. Because `ps` joins arguments with
spaces, it only trusts a git's subcommand when the command line starts with exactly the git it ran
(plain `git`, or the full path an IDE uses) followed by the subcommand. Any other git counts as a
holder. On Windows it waits until no `git.exe` other
than its own is running, and a lock Windows refuses to rename counts as in use. That can't tell a
resident `git fsmonitor--daemon` from a real holder, so a Windows machine running fsmonitor will not
clear a stale lock on its own. If the check cannot answer, the lock stays and the next cycle asks
again.

An empty lock is deleted. A lock with bytes in it is a write that never finished, and git never reads
it, but it is moved to `.git/sukarfleet-stale-locks/<timestamp>/` rather than deleted, as evidence.
Every removal is logged as `git lock repair: retired an orphaned lock` and recorded as a signed
`sync-lock-repaired` audit entry. None of this raises a fault or a notification.

While a lock is held, a cycle that needs it is deferred rather than failed. A merge you left
unfinished on the sync branch, or unmerged paths from a cherry-pick or stash pop, defer it the same
way. The daemon never commits or aborts those for you. A merge the daemon started itself is
aborted and redone, and if git refuses to abort it (conflict markers staged, then the file edited
again) the repo is deferred until you finish or abort that merge by hand. Its markers are never
committed. If the abort failed because another git holds `index.lock`, the note says that instead,
and the next cycle tries again.

A git hook can also stop a cycle. If a `pre-commit`, `commit-msg` or `pre-merge-commit` hook refuses
one of the daemon's commits or merges (a misconfigured transcrypt is the usual one), the repo is
deferred with the hook's own message as the reason, instead of failing every cycle. Merges from
peers run as a plain `git merge`, so the hooks that run are the ones a plain merge runs. Deferring used to be a critical sync error
and a desktop notification any time you and the daemon touched the same repo at once.

A deferral keeps the time of the last successful cycle. Right after a restart, before any cycle has
succeeded, that is the time the daemon started, so a lock held across a restart doesn't count as
"never synced". Once a deferral has lasted `staleGitLockMin`, the repo's `syncError` in `/status`
reads `deferred: <reason>`, for example the lock git is waiting on. That note never raises a fault.
If the wait goes on past `syncStaleMin`, the ordinary stale-sync fault fires, and the note is there
to explain it.

## A sync branch origin has and this machine lost is merged back

After a crash, origin can hold a commit on `sync/<this machine>` that the local branch no longer has.
Every push is then rejected as non-fast-forward. That happened to two repos, for five days, until
someone merged origin's copy back by hand.

The daemon now does that merge itself, under the same rules as a merge from a peer, and retries the
push in the same cycle. Union paths go through the `postMerge` regenerator. Other conflicts are
newest-wins only on a vetted clock, and the losing side is kept under `.sync-conflicts/`. It never
force-pushes and never rebases. If the merge would not be safe this cycle, it leaves the repo as it
was and tries again next cycle. Each merge is recorded as a signed `sync-own-branch-merged` audit
entry.

The flip side is that you can't rewrite `sync/<this machine>` on origin while the daemon runs: it
would merge origin's old history straight back in before you got to force-push. Stop the daemon on
that machine first, rewrite and force-push both copies, then start it again.

## Files Windows can't check out stay out of the commit

The fleet is mixed, so every path the daemon commits has to be one Windows can hold. A Linux machine
once committed `_tmp/x/check:css.log`, and from then on every merge on the Windows peer failed with
`invalid path`. Now the auto-commit leaves out any file whose name has `< > : " | ? * \` or a
control character in it, ends in a dot or a space, or is a reserved device name like `CON`, `nul`,
`COM1` or `lpt9.txt`. The file stays on disk and is simply not synced. The daemon skips it silently
every cycle (a debug log line at most).

This applies to every commit the daemon makes, including what a `postMerge` regenerator writes and
the result of merging a peer. The daemon never stages such a file again once it has left it on disk.
A merge records the peer's tree as the peer committed it, and a commit straight after it takes the
path out, so what gets pushed is portable. A path like that which is already in the index, committed by an older
version or staged by hand, is taken out of the index with `git rm --cached`, even if it was edited
after it was staged. The file stays on disk, the removal goes out with the
next auto-commit, and it is recorded as a signed `sync-unportable-untracked` audit entry if a
commit had carried it. A path that was only ever staged leaves no audit entry. That
includes a file renamed to such a name: the old name is deleted from the repo and the new one stays
local.

Nothing else in the sync cycle repairs itself, and that is deliberate.

## The audit log itself is damaged

`this machine's audit log has N unreadable byte(s)` means bytes in `audit-log.jsonl` under the
state dir are no longer entries. The usual cause is the same unclean shutdown that corrupts a git
index: the filesystem kept the file's length but lost the data blocks, so a region comes back as
NULs. NUL is not a newline, so a region that held thousands of entries reads as a single
unreadable line. That is why the fault counts bytes and not just lines.

It is said once and then stays quiet. The damage is a fixed historical fact, the count never moves,
and repeating it every half hour would only train you to ignore it. It stays visible in `/status`
and the tray, and speaks again only to say it cleared.

**Nothing repairs it, on purpose.** Trimming the unreadable region would mean rewriting an audit log
to silence an alarm about a damaged audit log, which is indistinguishable from a machine trimming
its own history. What to do instead:

1. Find out what caused it. `journalctl --list-boots`; a boot that ends with no shutdown sequence
   is a crash, and the entries lost are the ones written in the minutes before it.
2. Check what was actually lost. Every entry already flushed lives on in the git-synced union file,
   which other machines also hold, so in the common case the damaged region is redundant and
   nothing is gone. `sukarfleet-cli audit tail` reads the union file, not this one.
3. If entries really are missing from the union file too, they show up separately as a seq gap
   (below). That is the fault that speaks to lost history; this one speaks to a damaged file.

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
