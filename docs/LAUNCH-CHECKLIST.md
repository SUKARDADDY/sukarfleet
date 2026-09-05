# Launch checklist

This project's release gate. Binary items, written down before they were judged. All green means the
release ships. Anything red means a concrete reassessment, not a vibe.

The point of fixing them in advance is that a checklist written at judging time is a checklist
written to pass.

| # | Item | State |
|---|------|-------|
| 1 | **Clean-box install under 5 minutes.** A machine that has never seen this reaches a running daemon and an open GUI, timed, from one command. | **done, measured 2026-09-05** on fresh Ubuntu 24.04 VMs: the one command to an active daemon with the console reachable in 4 s; through the Identity and Mesh cards and the one sudo prompt to a running mesh in 8 to 13 s (three machines, three runs each); the re-run says "already installed" in under a second. Headless VMs, so the console was the printed URL |
| 2 | **Two machines pair with no terminal.** Code shown on one, typed on the other, mutual trust established, GUI only. | **done, observed 2026-09-05**: two fresh VMs minted a code on one and redeemed it on the other through the console's own routes over the mesh, in seconds; both peer tables listed the other as online. The mesh peer the second machine needs is now a field on the Mesh card (it was a flag before) |
| 3 | **The wedge demonstrates.** An agent on machine B recalls something written on machine A, in under 30 seconds of screen time. | runs daily; not recorded |
| 4 | **Configurable synced directories work** for a directory that is not the workspace. | **done** — field-proven at cutover: the dotfiles and agent-memory directories survived as ordinary configured entries, no special-casing |
| 5 | **14 consecutive days on the extracted code** with no rollback. | **done** — both machines cut over 2026-08-04, day 14 passed 2026-08-18 with no rollback, and the fleet then took the converge, security and tray stages as rolling restarts without one |
| 6 | **Experimental platforms fail honestly.** On a platform with no working credential backend, the admin lane refuses with a clear message and sync is unaffected. Verified by forcing the failure. | **done, forced 2026-09-05** on a Windows 11 VM: the daemon runs (first Windows boot ever, three portability fixes on the way), and storing a sudo credential answers `{"ok":false,"reason":"not-private"}`, which the console renders as "The secrets directory is not private (0700 on a real filesystem). Nothing was stored."; health stayed ok before and after. Both installer stages complete under Windows PowerShell 5.1 and pwsh 7.6.5 |
| 7 | **Agent-origin admin is refused by default.** Enabling the lane grants the operator remote admin and nothing more. Verified by an agent-origin call being refused on a freshly enabled lane. | **done** — enforced, audited, and tested |
| 8 | **`SECURITY.md` published** with the real threat model, including the same-user limitation and the no-full-disk-encryption caveat stated plainly. | **done** |
| 9 | **Licences in place** — AGPL-3.0 daemon, MIT edges, DCO documented — from the first commit, not retrofitted. | **done** — first commit in the repository |
| 10 | **Adversarial self-review passed** over trust, keys, exec and sync, with surviving findings fixed. | **done** — five hostile passes on 2026-08-04; the two surviving reds (a 40-bit pairing code crackable offline, an unchained audit log) closed 2026-09-05: 12-character scrypt-stretched code, per-machine hash chain with a critical fault on a broken link. Smaller findings stay in the private register |
| 11 | **No personal data in the public repo** — no machine names, mesh addresses, hostnames or network layout. Checked by grep, not by memory. | **guard in place, CI with the public repo** — `tests/no-personal-data.test.ts` walks the whole tree on every test run (it caught eleven real leaks so far, the last five in the tray fold-in); it runs in CI from the first public commit, and the history is scrubbed before the flip |

## Notes on the ones most likely to be red

**Item 5 (the 14-day soak)** was the single longest pole and nothing shortened it. It could not
start until both machines were running this code, and it then had to run for fourteen consecutive
days without a rollback. The dates are in the row above.

**Item 6 (experimental platforms)** was forced on a Windows 11 VM on 2026-09-05; the refusal and the
health check are quoted in the table. macOS still has no hardware on this project: "experimental"
there genuinely means untried until a stranger tries it. See [`PLATFORMS.md`](PLATFORMS.md), which
says so in those words.

**Item 4** is proven by using it, not by asserting it: the dotfiles and task-board directories that
used to be blessed features become ordinary configured directories. If they survive cutover as plain
config, the feature works. If they need special-casing, it does not.

**Item 11 is automated on every test run** and has earned it — the check caught a real machine name in eight
test files, real mesh addresses in two, a hostname used as a fixture identity throughout, an absolute
path naming the author's mount point inside a source comment, and the fleet's real mesh address
shipped as a form placeholder in the GUI.
