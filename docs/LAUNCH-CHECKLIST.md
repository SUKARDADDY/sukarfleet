# Launch checklist

Binary items, decided in advance, judged at the end of the timebox. All green means launch. Anything
red means a concrete reassessment, not a vibe.

The point of fixing these now is that a checklist written at judging time is a checklist written to
pass.

| # | Item | State |
|---|------|-------|
| 1 | **Clean-box install under 5 minutes.** A machine that has never seen this reaches a running daemon and an open GUI, timed, from one command. | not yet measured |
| 2 | **Two machines pair with no terminal.** Code shown on one, typed on the other, mutual trust established, GUI only. | implemented, not timed on a clean box |
| 3 | **The wedge demonstrates.** An agent on machine B recalls something written on machine A, in under 30 seconds of screen time. | runs daily; not recorded |
| 4 | **Configurable synced directories work** for a directory that is not the workspace. | **done** — field-proven at cutover: the dotfiles and agent-memory directories survived as ordinary configured entries, no special-casing |
| 5 | **14 consecutive days on the extracted code** with no rollback. | **running** — both machines cut over; soak started 2026-08-04, day 14 falls on 2026-08-18 |
| 6 | **Experimental platforms fail honestly.** On a platform with no working credential backend, the admin lane refuses with a clear message and sync is unaffected. Verified by forcing the failure. | seams implemented and unit-tested; not yet forced on real non-Linux hardware |
| 7 | **Agent-origin admin is refused by default.** Enabling the lane grants the operator remote admin and nothing more. Verified by an agent-origin call being refused on a freshly enabled lane. | **done** — enforced, audited, and tested |
| 8 | **`SECURITY.md` published** with the real threat model, including the same-user limitation and the no-full-disk-encryption caveat stated plainly. | **done** |
| 9 | **Licences in place** — AGPL-3.0 daemon, MIT edges, DCO documented — from the first commit, not retrofitted. | **done** — first commit in the repository |
| 10 | **Adversarial self-review passed** over trust, keys, exec and sync, with surviving findings fixed. | **run 2026-08-04, one blocker left** — five independent hostile passes (trust/pairing, keys/signatures, admin lane, sync/transport, threat-model fidelity). Fixed: the documentation-honesty findings, the personal-data guard, an uncapped mesh-facing body read, and **audit-entry signature verification, which is now wired and running**. What remains is the pairing secret's entropy budget: a captured handshake is crackable offline, and fixing it changes the handshake bytes, so it waits for the freeze to lift. Item stays red until it lands. |
| 11 | **No personal data in the public repo** — no machine names, mesh addresses, hostnames or network layout. Checked by grep, not by memory. | **done** — enforced by `tests/no-personal-data.test.ts` in CI |

## Notes on the ones most likely to be red

**Item 5 (the 14-day soak)** cannot start until cutover does, and cutover cannot start until someone
runs the gate in [`CUTOVER.md`](CUTOVER.md). It is the single longest pole and nothing shortens it.

**Item 6 (experimental platforms)** needs hardware nobody on this project owns. The self-test gate
means an untested backend fails safe rather than dangerously, but "experimental" on macOS genuinely
means untried until a stranger tries it. See [`PLATFORMS.md`](PLATFORMS.md), which says so in those
words.

**Item 4** is proven by using it, not by asserting it: the dotfiles and task-board directories that
used to be blessed features become ordinary configured directories. If they survive cutover as plain
config, the feature works. If they need special-casing, it does not.

**Item 11 is already automated** and has earned it — the check caught a real machine name in eight
test files, real mesh addresses in two, a hostname used as a fixture identity throughout, an absolute
path naming the author's mount point inside a source comment, and the fleet's real mesh address
shipped as a form placeholder in the GUI.
