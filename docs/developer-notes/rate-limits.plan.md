# Rate limits & cost controls — bounding compute, provider, and storage spend

Status: **shipped — 2026-07-26** (written and built the same day, from an owner ask)

**Completion note (2026-07-26):** all seven slices landed in one batch. Gates run
serially green (lint → lint:cycles → typecheck → test → jscpd) plus the full
`pnpm test:int` (539 passed / 0 failed). Migration `0088` adds `usage_counters`,
`images.bytes` (backfilled from the `meta.bytes` `writeWebpAtomic` already
recorded), and `jobs.owner_id`.

Beyond the slice text, two things surfaced while building:

1. **The limiter had to bound its own memory.** Keying partly on client IP means
   an attacker rotating addresses would grow the bucket map without limit — the
   rate limiter becoming the memory-DoS. Buckets are now LRU-evicted under a
   ceiling with a periodic sweep, and a test drives 25k distinct keys to prove it.
2. **A pre-existing break, found and fixed here (not caused by this work).** Six
   integration suites (`gallery`, `chat`, `library-routes`, `authz-matrix`,
   `public-dto`, `variants`) were red on `main`: the `images_path_canonical`
   CHECK constraint from `security-authz.plan.md` rejects fixtures that
   hand-write a readable filename (`images/<owner>/scene.webp`) instead of
   `images/<owner>/<id>.webp`. CI never caught it because `pnpm test:engine`
   does not include those files. Fixed with a shared
   `canonicalImageRow` fixture helper (`src/server/test-support`) that derives id
   and path together, so a suite cannot pick one without the other. **A separate
   gap remains open below.**

The authorization work (`security-authz.plan.md`, shipped 2026-07-26) closed
*who may touch what*. It deliberately left *how much* open: the pre-public-signup
checklist parks shared rate limiting behind the multi-instance decision, and the
process-local limiter in `src/server/api/rate-limit.ts` covers eight routes with
four hand-rolled buckets. Nothing bounds storage, nothing bounds daily provider
spend, nothing caps concurrent background work, and an unauthenticated caller
meets no limit at all before `getCurrentUser()` runs.

**Threat model.** Not cross-instance fairness — the app runs one Fly machine
(`fly.toml`: `min_machines_running = 1`, `auto_stop_machines = 'off'`), so
process-local windows remain the accepted shape for *burst* limits. What this
plan closes is **unbounded cost**: one account or IP driving unbounded model
calls, image renders, embedding work, disk, or queued jobs. Money and disk
survive a process restart, so the controls that bound them must be durable too.

## The split: burst limits are in-memory, cost controls are durable

This is the plan's central decision, and it is why there are two mechanisms
rather than one.

| Control | Where it lives | Why |
| --- | --- | --- |
| Per-IP + per-user burst windows | in-process sliding window | Seconds-scale; a restart losing them is harmless. Cross-instance sharing stays deferred (unchanged 2026-06-23 ruling). |
| Daily call/cost budgets | `usage_counters` table | Spans restarts. An in-memory budget is reset by crash-looping the process — which is exactly what an abuser would do. |
| Storage quota | `SUM(images.bytes)` | Derived, never a counter: deletes reclaim quota automatically and it cannot drift. |
| Concurrent job cap | `jobs` rows, conditional insert | Must survive restart, and the check has to be race-safe against parallel submits. |
| Provider / queue backpressure | in-process health + queue depth | Liveness signal, not an accounting fact. |

## Slices

### Slice 1 — the policy registry and 429 shape

Replace the four ad-hoc constants with a named registry (`ApiLimitName` →
`{limit, windowMs}`), tiered so ordinary reads are generous and provider-backed
writes are strict. `rateLimit` returns a **decision** (`allowed`, `limit`,
`remaining`, `resetAt`, `retryAfterSeconds`) instead of a bare boolean, and
`rateLimitResponse(decision)` renders the 429 with `Retry-After` and the
`RateLimit-*` headers plus retry fields in the error envelope.

Tiers (per minute unless noted): `read` 120 · `write` 60 · `chat` 30 ·
`clone` 20 · `upload` 20 · `image_generate` 12 · `forge` 10 · `embed` 10 ·
`heavy_write` 6 · `regenerate` 10. The invariant the tests pin: **every
provider-backed or storage-backed name is strictly below `read`.**

### Slice 2 — per-IP limits before authentication

`withRoute` — which every route reaches, `withUser` included — applies a per-IP
window **before** `getCurrentUser()`. Client IP resolves through a trusted-proxy
chain (`fly-client-ip` → `x-real-ip` → leftmost `x-forwarded-for`), and an
unresolvable IP falls into one shared `unknown` bucket rather than a free pass,
so stripping the header sacrifices your own isolation instead of buying evasion.
Auth routes (`/api/auth/*`) get a stricter per-IP window than the app default.

### Slice 3 — durable daily budgets

New `usage_counters` table, keyed `(ownerId, kind, windowStart)`, incremented
through a single `INSERT … ON CONFLICT DO UPDATE SET amount = amount + excluded`
`RETURNING amount` so concurrent turns cannot lose an increment. Kinds:
`provider_text_day`, `provider_image_day`, `provider_embed_day`,
`upload_bytes_day`. `windowStart` is the UTC date, which makes the reset
boundary a fact about the key rather than a timer that has to fire.

### Slice 4 — storage quota

`images.bytes` becomes a real column (backfilled from the `meta.bytes` that
`writeWebpAtomic` already records), and the quota is `SUM(bytes)` per owner,
checked before a render is queued or an upload is accepted. Derived-not-counted
is the point: `deleteOwnedImage` already exists in several forms and none of
them would have remembered to decrement a counter.

### Slice 5 — concurrent job caps

`jobs.ownerId` becomes a column, and `startJob` inserts through a conditional
`INSERT … SELECT … WHERE (SELECT count(*) …) < cap` so the cap is enforced by
the database rather than by a read-then-write race. Only rows younger than a
staleness window count, so a job orphaned by a crash frees its slot instead of
permanently consuming one.

### Slice 6 — backpressure

An in-process health registry per provider lane (`text`, `image`, `embedding`)
fed by outcome reports; consecutive failures trip it to `unhealthy` and it
recovers on a probe interval. Unhealthy lane, or queue depth above a ceiling,
sheds *expensive* work with `503` + `Retry-After` — never reads, and never an
in-flight chat turn.

### Slice 7 — abuse signals without prompt content

Denials log through one `recordAbuseSignal` seam whose payload is an
allow-listed shape: route, policy name, scope, decision, owner id, and a
**salted-hashed** IP. There is no field a prompt could travel in, which is
enforced by construction rather than by remembering — the signal type has no
free-form content field at all.

## Open questions

- **OQ1 — cost in currency, or calls?** This plan counts *calls* per lane, not
  dollars: per-model pricing lives outside the app and would rot. If the owner
  wants a real dollar budget, the counter kind is already `micros`-shaped and
  only needs a price table. Recorded as a deliberate v1 scope cut.
- **OQ2 — do quotas need a UI?** A user who hits a storage quota currently sees
  a 429 with a reason. Surfacing remaining quota in the Gallery is a natural
  follow-up but is not in this slice.
- **OQ3 — CI does not run the whole integration suite.** Discovered while
  fixing the fixture break above. CI runs `pnpm test`, then `pnpm test:engine`,
  which globs the engine + rollout surface only — so `gallery`, `chat`,
  `library-routes`, `authz-matrix`, `public-dto`, and `variants` have no CI
  coverage at all, which is why a constraint that broke all six shipped green.
  `pnpm test:int` also needs `VESPER_ALLOW_LEGACY_ENGINE_TEST_PLAYER=1` (CI sets
  it for `test:engine` only). A flagless local run used to report ~120 spurious
  engine failures; since 2026-07-27 the player-principal suites fail fast at
  collection with a message naming the flag (see docs/testing.md §"Running the
  whole integration suite locally"), so the trap self-explains — but the flag is
  still required. **Owner call needed:** run the full `pnpm test:int` in CI with
  that flag, or keep a curated glob and accept the gap. Not fixed here — changing
  what gates every merge is a decision, not a cleanup.

## Verification

Pure tests cover the window mechanics, tier ordering, decision metadata, and the
abuse-signal shape. Integration tests cover the durable pieces — counter
atomicity, the date-keyed reset boundary, storage quota against real rows, and
the conditional job insert under parallel submits.
