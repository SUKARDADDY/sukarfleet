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
  typed on the other.
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
| `refuse` *(default)* | Agent-origin runs are refused and audited. Status stays readable. A human drives the GUI. |
| `allow` | Any origin may drive the lane. |

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

Every admin call, refusal and pairing is appended to a hash-chained, signed audit log, replicated
to every machine. Two content rules are enforced by convention and by review:

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
  clock breaks sync rather than weakening it.

## Cryptography

No custom cryptography. ECDSA P-256 with SHA-256 via WebCrypto for signatures; HMAC over a
code-derived key for the pairing handshake; SHA-256 for digests. Signatures are computed over a
canonical JSON encoding whose byte-exactness is pinned by
[`tests/freeze/`](tests/freeze/README.md) — a change to that encoder silently invalidates every
signature a peer produces, which is why it is treated as a wire format.
