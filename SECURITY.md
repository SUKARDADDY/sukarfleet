# Security

This document is written to be useful rather than reassuring. Where a protection is weaker than it
sounds, that is said here in the same words the code uses.

## Reporting a vulnerability

Open a private security advisory on the repository. Please do not open a public issue for anything
that would give an attacker a working recipe before there is a fix.

## What this software is

A daemon that runs on each of your machines and keeps a set of git repositories in sync between
them over a private mesh, so an agent working on one machine sees what it wrote on another. It also
ships an **admin lane**, off by default, which lets one machine run a privileged command on another.

The two halves have very different risk profiles and are documented separately below.

## Trust model

- **Machines are peers, and each machine trusts every machine it is paired with.** There is no
  central authority and no hierarchy. Pairing is mutual and explicit: a code shown on one machine,
  typed on the other. The code is 12 Crockford base32 characters, 60 bits, live for 300 seconds,
  and burned by five bad attempts or by one good one. Both sides stretch it with scrypt
  (N=2^15, r=8, p=1: 32 MiB and tens of milliseconds per guess) before it keys the handshake HMAC.
  That cost is the defence that matters, because `/pair/hello` is the one unauthenticated route on
  the daemon and a captured request is a complete offline oracle: an attacker who has it guesses on
  their own hardware, where the five-attempt burn cannot reach them. Online guessing is still
  bounded by the burn, at five tries against 2^60 codes per code minted.
- **Identity is an ECDSA P-256 keypair per machine**, generated locally and never transmitted. The
  private key lives at `~/.config/sukarfleet/machine-key.json`, mode 0600.
- **Every peer-to-peer message is signed** — gossip envelopes, endpoint files, audit entries — and
  verified against the peer's enrolled public key. HTTP requests between machines carry an
  `x-fleet-auth` header signed over the method, path, timestamp and machine, with a 120-second
  window.
- **The mesh is not the security boundary.** Signature verification is. A machine that joins the
  mesh without being paired can reach the ports and gets nothing.

## The admin lane

Off by default. Turning it on lets a paired machine run a command as root on this one.

### The invariant it is built around

**A sudo password never crosses the network.** Each machine stores only its own. The origin sends a
request with no credential field; the target unseals its own password locally, inside a single
function, and pipes it to `sudo` on stdin. That plaintext is never returned, logged, audited, put
in argv, put in the environment, or written anywhere except the sealed store. Errors raised inside
that frame are replaced with fixed strings before they can travel.

### What sealing the credential does and does not buy

The credential is sealed at rest by the platform's own store: `systemd-creds --user` on Linux, the
login Keychain on macOS, DPAPI at CurrentUser scope on Windows.

**What that buys:** the sealed blob is bound to this user on this host. A credential that leaks
through a synced repository, a backup, or a copied directory is inert to whoever reads it.

**What it does not buy, stated plainly:**

- **No protection from another process running as the same user.** Any process running as the
  daemon's user can ask the operating system to decrypt the credential, because that is exactly
  what the daemon does. If an attacker can execute code as you, they have the credential.
- **No protection from whole-disk theft when the disk is not encrypted.** The host key that the
  seal is bound to lives on the same disk. **This software does not enable full-disk encryption and
  cannot tell you whether you have it.** If you run the admin lane on a machine without FDE, treat
  a stolen disk as a disclosed sudo password.
- **TPM sealing is attempted first and usually loses.** System-scope TPM sealing requires
  privileges an unprivileged daemon does not have; on real hardware it fails or hangs. The scope
  actually used is recorded in the credential metadata, so what you get is never a guess.

### Who may drive the lane

Enabling the lane and letting an agent use it are **two separate switches**, because they are two
different risks.

| `admin.agentOrigin` | Behaviour |
|---|---|
| `refuse` *(default)* | Runs arriving over the MCP tool are refused and audited. Status stays readable. A human drives the GUI. |
| `allow` | Any origin may drive the lane. |

**What "agent origin" actually means, because the word promises more than the mechanism
delivers.** The origin label is chosen by *which local endpoint the request arrived on*, not by
any authentication. The MCP server stamps its callers `agent`; the GUI's own JSON API stamps its
callers `operator`, and that API is guarded by loopback, Host-pinning and cross-site checks — none
of which a non-browser process on your machine has to satisfy. So `refuse` stops your agent from
using the *tool built for it*; it does not stop a program running as you from posting to the GUI
endpoint and being labelled an operator. That is a mistake-preventer, in the same family as the
command patterns below, and it is bounded by the same-user limitation at the end of this file.

With `allow`, the honest sentence is: **an agent can become root on every paired machine,
unattended.** That may be exactly what you want on a machine you own and control. It should be a
decision you made, not a default you inherited.

A third mode, `confirm` — park the run and require an operator click within N seconds — is the
intended upgrade and is **not implemented**. It is deliberately absent from the config union rather
than present and inert, because a switch that reads as a restriction and behaves as none is worse
than a missing feature.

Upgrading a deployment that predates this switch writes `agentOrigin: "allow"` explicitly and logs
a warning, rather than silently tightening and breaking working automation. The value is then
visible in your config file, which is the point.

### Command restrictions are a tripwire, not a boundary

The lane matches submitted commands against a list of destructive patterns (`rm -rf`, `mkfs`,
`dd of=`, `shutdown`, …) and requires a typed confirmation. **`bash -c` defeats every one of them.**
They exist to catch mistakes, not attackers, which is why they drive a confirmation rather than a
refusal. Do not mistake this for sandboxing: an authorized origin has root.

### What is recorded

Every admin call, refusal and pairing is appended to a signed audit log, replicated to every
machine. Each entry is signed individually and carries a per-machine monotonic sequence number.

**What checking happens, and what it cannot see:**

- **Signatures are verified on every sync tick.** The daemon cross-checks the replicated file it
  just regenerated: an entry whose signature does not verify against the signer's enrolled key, or
  that claims a machine with no enrolled key at all, raises a fault the same way a sync error does.
  Two signed entries claiming one sequence number, and gaps in a machine's sequence, are reported
  too. The check reads and never repairs — deleting a bad line would propagate that deletion to
  every machine, and a tampered log that is loudly flagged is worth more than a quietly fixed one.
- **Entries are chained per machine, from that machine's genesis forward.** Each entry carries
  `prev`, the SHA-256 of the previous entry that machine appended, inside the signed body. A
  machine's genesis is the lowest sequence number it ever signed a `prev` into, so it is readable
  out of the log itself; entries below it predate the chain, can never be rewritten to add a link,
  and are checked by signature and sequence only. From genesis forward the chain catches the one
  thing sequence numbers alone cannot: an interior entry swapped for another that the same key
  signed at the same number, which leaves the run contiguous and every signature verifying. A
  removed interior entry is caught too, but by the sequence gap rather than by the link. Line order
  in the file is not an attack surface either way — the regenerator sorts every entry by machine,
  sequence and bytes before any check runs. A broken link is checked over verified entries only, so
  an unsigned line cannot move a machine's genesis, and it raises a critical health fault of its
  own, separate from the signature one.
- **Truncating the newest entries of a machine's run still leaves no evidence.** A chain proves
  each entry follows the one before it. It says nothing about where the chain is supposed to end,
  so lopping off the tail leaves a remainder that verifies perfectly. **Do not read this log as
  tamper-evident for its tail.** Closing that needs a per-machine high-water mark kept outside the
  log, which does not exist yet.

Two content rules are enforced by convention and by review:

1. The **full argv** is recorded. A truncated argv makes the log useless as forensics.
2. **Command output is never recorded** — only byte counts. The audit file reaches every machine
   and may be pushed to a remote, so command output is precisely the sink through which a captured
   secret would leak.

## The sync lane

- Repositories are synced over the mesh with signed HTTP. A conflict resolves by union merge for
  configured union paths and newest-wins otherwise.
- **Sync moves whatever is in the directories you configure.** If you sync a directory containing
  secrets, those secrets reach every machine in the fleet, and any remote you have configured. This
  software has no opinion about your file contents.
- The daemon runs unprivileged and never needs root to sync.
- **A `postMerge` hook turns sync into remote code execution, by design and worth saying out
  loud.** The hook's argv comes from your own config and no peer can rewrite it. But the argv
  commonly *names a script that lives inside the synced tree* — a regenerator, a `chezmoi apply`
  over a dotfiles source — and the tree is exactly what a peer can write. A paired machine that
  commits a modified script gets it executed as your user, on every machine, after the next clean
  merge. No conflict is needed. This follows from flat peer trust, but the amplification is worth
  a decision: keep hook targets outside the directories you sync, or accept that pairing a machine
  grants it code execution on the rest of the fleet.
- **Newest-wins is decided by the git author timestamp, which the author controls.** A peer that
  stamps a future date wins every non-union conflict. The losing side is preserved under
  `.sync-conflicts/`, so this demotes content rather than destroying it.

## Known limitations

- **Same-user processes are trusted.** This is the big one; see above.
- **No FDE detection.** See above.
- **`confirm` mode does not exist yet.** See above.
- **Non-Linux platforms are experimental.** Every platform-specific seam is gated by a live
  round-trip self-test rather than a capability query, so an untested backend fails closed rather
  than dangerously. But "experimental" means the maintainers have not run it. See
  [`docs/PLATFORMS.md`](docs/PLATFORMS.md).
- **Loopback is not a caller identity.** Local HTTP surfaces reject cross-origin and cross-site
  requests, because a web page in a browser on your machine can reach `127.0.0.1`. If you run
  untrusted local code, it can reach these surfaces.
- **Clock skew matters.** Signed requests carry a timestamp with a 120-second window. A badly wrong
  clock breaks sync rather than weakening it. A paired peer that reports a wildly wrong clock can
  push a small fleet's median past the threshold and stall its own peers' syncing.
- **Request signatures do not cover the request body,** and there is no replay cache inside the
  120-second window. On the read-only git routes this grants a replayer nothing the captured
  header already granted.
- **The audit log is chained, but not at its tail.** An entry edited or replaced after a machine's
  genesis is detected; a machine truncating its own most recent entries still leaves nothing to
  detect. See "What is recorded" above.
- **WAN address discovery calls third parties.** Endpoint publication asks `api.ipify.org` and
  `icanhazip.com` for this machine's public address. That module is inert unless you configure a
  fleet-repo remote, but the calls are outbound traffic you did not explicitly ask for.

## Cryptography

No custom cryptography. ECDSA P-256 with SHA-256 via WebCrypto for signatures; HMAC-SHA-256 for
the pairing handshake, over a key stretched from the one-shot code with scrypt (N=2^15, r=8, p=1);
SHA-256 for digests and for the audit log's per-machine chain. Signatures are computed over a
canonical JSON encoding whose byte-exactness is pinned by
[`tests/freeze/`](tests/freeze/README.md) — a change to that encoder silently invalidates every
signature a peer produces, which is why it is treated as a wire format.
