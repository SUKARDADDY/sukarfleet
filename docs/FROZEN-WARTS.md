# Warts the freeze is holding in place

Extraction is exactly when you notice the things you want to fix, and the protocol freeze forbids
fixing them. This file is where they go instead, so the knowledge is not lost and the temptation
does not have to be re-argued each time someone finds one.

**None of these may be changed while one machine runs extracted code and the other runs the
pre-extraction daemon.** The freeze lifts when both machines share a codebase.

---

### `/exec/audit/tail` is named after a subsystem that no longer exists

The CLI's `audit tail` verb reaches the daemon on `/exec/audit/tail`, a loopback route named for
the signed-job exec layer that this extraction dropped. The audit log outlived that layer; the
route name did not get the memo.

**Why it was not renamed:** it is safe to rename in principle — loopback routes are machine-local
and are not part of the cross-machine frozen contract, since a CLI only ever talks to its own
daemon. But "safe in principle" is how a freeze erodes. The rename buys nothing operationally and
costs a class of "which machine am I actually talking to" reasoning during the canary window.

**Fix after cutover:** rename to `/api/audit/tail`, alongside the other loopback routes.

---

### `FleetConfig.fleetRepoPath` and the endpoint-file exchange are inert

`endpoints.ts` builds, signs, publishes and cross-verifies a per-machine endpoint file, and
`publishEndpointFile` only pushes when the fleet repo has an `origin` remote. In the deployment
this was extracted from there is no such remote, so endpoint files are written locally and never
reach the peer.

The format is nevertheless pinned in the freeze fixture, because it is signed and verified exactly
like a gossip envelope: the day someone configures that remote, a drifted encoder becomes a silent
verification failure.

**Fix after cutover:** either wire the rendezvous properly or remove the module. Leaving signed,
cross-verified code in a state where nobody exercises it is how encodings drift unnoticed.

---

### A literal NUL byte in the daemon's source

`node.ts` used a raw NUL as a composite map-key separator (`` `${machine}\0${class}` ``) written as
an actual NUL character rather than the `\0` escape. The consequence is out of proportion to the
cause: `file(1)` reports the source as `data`, and **plain `grep` silently reports zero matches for
every pattern**, which during this extraction made two live config fields look dead.

The offending line sat in dropped code, so the extracted tree is clean. It is recorded here because
the lesson is not: any source file may acquire one, and the failure mode is silence.

**Guard:** prefer `grep -a`, or check `file src/*.ts` when a search returns a suspiciously empty
result.

---

### `sshadmin.ts` builds `authorized_keys` grants around an absolute checkout path

Every SSH grant embeds `command="<bun> run <checkout>/src/cli.ts admin exec-local"`. Moving the
checkout invalidates every existing grant.

This is self-healing in practice — the startup door reconcile rewrites each grant from the stored
peer key using a freshly computed path — but only when `acceptIncoming` is on and
`peers[].sshPublicKey` is populated. It is listed here because "self-healing under two
preconditions" is worth stating out loud before a cutover rather than discovering during one.

**Mitigation in the cutover plan:** the extracted repo takes over the *same* on-disk path the
daemon already runs from, so no grant path changes at all.
