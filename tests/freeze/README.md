# The protocol freeze

`golden.json` pins the bytes that two machines exchange. `freeze.test.ts` asserts the code in this
repository still produces them.

## Why this exists

During the extraction, one machine runs this code while the other still runs the pre-extraction
daemon. That mixed state is *supported*, and this fixture is what makes it supportable. Rename
anything internal, move any file, restructure any module — but these bytes stay put until both
machines share a codebase.

## Why a failing test here is never "a stale fixture"

Every failure mode this catches is silent in production. A changed key order in the canonical-JSON
encoder does not raise an error; it produces a signature the peer computes differently and
therefore rejects, and the fleet degrades into "peer offline" with nothing in the logs explaining
why. The test failing is the *only* loud moment in that entire chain.

So: if a freeze test fails, the change is wrong, not the fixture.

## What is pinned

| Item | Why it is here |
|------|----------------|
| `canonicalJson` vectors | Not a wire format — the *input* to every signature. The least obvious and most dangerous item. |
| Gossip envelope | `{v,machine,tsMs,seq,payload}`, signature excludes `sigB64`. |
| `x-fleet-auth` header | `"<machine>;<tsMs>;<sigB64>"`, signed over `method \n pathWithQuery \n tsMs \n machine`. |
| Route surface | `POST /gossip`, `GET /status`, `GET /health`, `/git/*`, `POST /pair/hello`. |
| Pairing bundle + hello MAC inputs | The `req|` / `res|` prefixes are part of the signed bytes. |
| exec-local request/response | Easy to mistake for an internal call. It is not — see below. |
| Endpoint file | Signed and cross-verified like a gossip envelope. |
| Audit entry | Replicated to every machine; a changed encoding forks the union log. |

### The two least obvious entries

**Canonical JSON.** The comparator sorts by Unicode *code point*, via `Array.from`. A
`charCodeAt`-based comparator passes almost every vector here and still breaks: for an
astral-plane key like `U+1F600`, it compares the leading surrogate `0xD83D` (55357) instead of
128512, ordering it before `U+FFFD` (65533) — the opposite of code-point order. There is a test
dedicated to exactly this case.

**exec-local.** It looks like a local function call. During the canary window it is not: the
roamer's extracted CLI encodes the payload and the anchor's *old* CLI decodes it, on the far side
of an SSH channel. It is as much a wire format as gossip.

## The identities in here are synthetic

Machine names are `alpha`/`beta`, addresses are from the documentation ranges (RFC 5737 / RFC 3849),
and the keypair is generated for the fixture. `identity.privateKeyJwk` is a **throwaway fixture
key** — it signs nothing real and grants nothing. It is committed so the vectors can be re-recorded
deterministically.

No real machine name, mesh address, hostname, or network layout appears in this directory. That is
a launch-checklist item, and it is checked by grep rather than by memory.

## The live-fleet check

`golden.json` proves the *format* is unchanged. It does not prove *your* fleet's recorded traffic
still verifies. That is a separate, local-only check against real captured envelopes:

```bash
bun run tests/freeze/live-check.ts
```

It reads `live-capture.json` — real envelopes, real machine names, real public keys — which is
gitignored and must never be committed. Run it before every cutover.

## Changing the golden file

`golden.json` is pinned by SHA-256 inside `freeze.test.ts`, so it cannot be quietly regenerated to
make a failing test pass. Updating that digest is a deliberate act that shows up in review as
exactly what it is.

The freeze lifts when both machines run the same codebase — not before. Until then, if you find a
wart you want to fix, write it down instead of fixing it.
