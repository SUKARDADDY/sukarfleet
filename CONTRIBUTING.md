# Contributing

## Sign-off (DCO), not a CLA

Every commit must carry a `Signed-off-by:` trailer:

```
Signed-off-by: Your Name <your.email@example.com>
```

`git commit -s` adds it for you. The trailer certifies the
[Developer Certificate of Origin 1.1](#developer-certificate-of-origin-11)
reproduced below — that you wrote the patch, or otherwise have the right to
submit it under the repository's licence.

There is no Contributor Licence Agreement and there will not be one. A CLA
exists so a project can relicense later without asking contributors; this
project is not reserving that option, so asking you to sign one would be
taking something for nothing.

Which licence your change falls under is decided by the path it touches — see
[`LICENSING.md`](LICENSING.md). Match the `SPDX-License-Identifier:` header
already present in the file you are editing; if you add a file, add the header
that its directory implies.

## What a good change looks like

- **The protocol is frozen.** `tests/freeze/` holds golden files pinning the
  wire formats — gossip envelopes, the auth header, the pairing bundle, the
  exec-local payload, and the canonical-JSON encoder that feeds every
  signature. A change that alters those bytes breaks running fleets mid-upgrade
  and will not be merged as a patch; it needs a version negotiation. If a freeze
  test fails, that is the test doing its job, not a stale fixture to update.
- **Platform backends prove themselves.** Anything claiming to seal a
  credential must pass a live round-trip self-test — seal a throwaway value,
  unseal it, compare. Capability queries ("does this box have a TPM?") are not
  acceptable evidence: they have already produced confidently wrong answers on
  real hardware.
- **Failures are honest.** A backend that cannot work on a platform should
  refuse with a clear message. Sync must keep working when the admin lane
  cannot.
- **No personal data.** No machine names, mesh addresses, hostnames, or network
  layout in committed files — including fixtures. Use the synthetic identities
  the freeze fixtures already establish.

## Running the tests

```bash
bun test
```

The freeze fixtures run as part of that. `bunx tsc --noEmit` type-checks.

---

## Developer Certificate of Origin 1.1

```
Developer Certificate of Origin
Version 1.1

Copyright (C) 2004, 2006 The Linux Foundation and its contributors.

Everyone is permitted to copy and distribute verbatim copies of this
license document, but changing it is not allowed.


Developer's Certificate of Origin 1.1

By making a contribution to this project, I certify that:

(a) The contribution was created in whole or in part by me and I
    have the right to submit it under the open source license
    indicated in the file; or

(b) The contribution is based upon previous work that, to the best
    of my knowledge, is covered under an appropriate open source
    license and I have the right under that license to submit that
    work with modifications, whether created in whole or in part
    by me, under the same open source license (unless I am
    permitted to submit under a different license), as indicated
    in the file; or

(c) The contribution was provided directly to me by some other
    person who certified (a), (b) or (c) and I have not modified
    it.

(d) I understand and agree that this project and the contribution
    are public and that a record of the contribution (including all
    personal information I submit with it, including my sign-off) is
    maintained indefinitely and may be redistributed consistent with
    this project or the open source license(s) involved.
```
