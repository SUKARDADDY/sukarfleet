**What this changes, and why.**

**How it was verified.** Not "tests pass" -- what you ran, and what it printed.

Before asking for a review:

- [ ] Every commit carries a `Signed-off-by:` trailer. `git commit -s` adds it. There is no CLA;
      the DCO text is in [CONTRIBUTING.md](../CONTRIBUTING.md).
- [ ] No personal data: no machine names, mesh addresses, hostnames or network layout, including in
      fixtures and comments. `bun test tests/no-personal-data.test.ts` is the check, and it runs in
      CI as its own job named `guard`.
- [ ] `bun test` and `bunx tsc --noEmit` are green locally.
- [ ] If `tests/freeze/` fails, that is the test doing its job. Do not update the golden files to
      make it pass.
- [ ] New files carry the `SPDX-License-Identifier:` header their directory implies
      ([LICENSING.md](../LICENSING.md)).
