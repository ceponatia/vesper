# Security hardening — plan

Status: **shipped — 2026-06-23**. Remediation of the 2026-06-23 full-surface
security scan (six parallel review agents over auth/API, all routes, AI/engine,
images, data layer, and config). Topic slug `security-hardening`.

**Completion note (2026-06-23):** all nine clusters landed. Cluster A + the auth
migration shipped earlier with [auth.plan.md](auth.plan.md); clusters
**B–I** shipped in this batch (eight file-disjoint agents, one consolidated
`pnpm verify` green — lint + typecheck + 1378 tests + jscpd). Per-cluster
"✅ DONE" notes inline below. **Leftovers / deliberate deferrals:**
- **E3 (origin/CSRF check)** — deferred to the auth surface; already covered by
  Better Auth's `trustedOrigins`/`baseURL` + `sameSite` cookies. Not a gap.
- **Rate limiter stays an in-process `Map`** (single-instance, by design); a
  shared store is out of scope until the app runs more than one instance.
- **`ENABLE_TURN_INSPECTOR`** (new env, off by default) added to `.env.example`;
  the inspector now needs both the flag **and** admin role.
- **CSP** ships permissive on `script-src` (`'unsafe-inline'`/`'unsafe-eval'`) so
  Next's runtime/HMR isn't broken; `connect-src` adds `ws:`/`wss:` in dev only.
  Tightening `script-src` with nonces is a future polish, not a blocker.

The scan's headline: **the codebase is disciplined** — the IDOR sweep came back
clean across all 40+ routes, and there's no SQL injection, no SSRF, no committed
secrets, and no client XSS sink. The real work is (1) shrinking the dev-auth
model's blast radius, (2) adding the resource limits that are currently absent
(image-decode DoS, unthrottled paid-model calls), and (3) standard HTTP
hardening (headers, cookie flags). Most findings only bite **beyond trusted
local dev** — but the dev-route gate (cluster A) is a genuine now-fix.

## Framing — what's urgent vs. latent

Vesper today runs on a single trusted local box with one user, so most findings
are *latent* (they matter the moment this is exposed to any untrusted client or
network). Prioritize accordingly:

- **Do now (cheap, reachable today):** cluster A (gate `/api/dev/*`), cluster B
  (sharp decode limits — already-triggerable OOM, see `machine-earlyoom` note).
- **Do before any non-local exposure:** clusters C–H.
- **Folds into the eventual real-auth migration (separate, larger effort):** the
  CSRF/origin posture and replacing cookie-as-identity. Tracked in §Auth
  migration below, not in the quick-win clusters.

## Concurrent workstreams (agent clusters)

Each cluster owns a **disjoint set of files** so they can run as parallel agents
with no merge conflicts. Ordering is largely free; the only soft dependency is
noted. Every cluster must end green on `pnpm verify` (lint + typecheck + test +
jscpd) and add/extend tests where noted (degradation tests assert fallback **and**
diagnostic code, per `docs/resilience.md`).

| Cluster | Theme | Severity | Files owned (disjoint) | Concurrency |
| --- | --- | --- | --- | --- |
| **A** | Auth boundary | 🔴 highest | `server/auth/index.ts`, `app/api/dev/me/route.ts`, `app/api/dev/switch-user/route.ts` | independent |
| **B** | Image-decode safety | 🔴/🟠 | `server/images/upload.ts`, `server/images/assets.ts` | independent |
| **C** | Rate limits & abuse caps | 🔴/🟡 | `server/api/rate-limit.ts` + the generation/heavy-write `route.ts` files (see below) | independent |
| **D** | HTTP hardening | 🟠 | `next.config.ts` (+ optional new `middleware.ts`) | independent |
| **E** | Request-body trust boundary | 🟡 | `server/api/respond.ts`, `contracts/world/drafts.ts` | independent |
| **F** | Prompt-injection hardening | 🟡 | `server/engine/prompts/*.ts` | independent |
| **G** | LLM-output bounds | 🟡 | `contracts/turns/agent-results.ts`, `contracts/turns/intent-brief.ts`, `server/engine/merge.ts` | independent |
| **H** | Infra & secrets | 🟡 | `docker-compose.yml`, `scripts/db-create.ts`, `scripts/db-migrate.ts`, `.env.example` | independent |
| **I** | Defense-in-depth (Lows) | 🟢 | `app/api/sessions/[id]/route.ts`, `app/api/gallery/route.ts`, `app/api/images/[id]/file/route.ts`, `app/api/sessions/[id]/turns/[turnId]/inspect/route.ts`, `server/api/worlds.ts`, `server/engine/jobs.ts`, `server/engine/recovery.ts` | independent |

All nine are mutually file-disjoint and can run **fully concurrently**. Suggested
agent dispatch: A + B + C + D + E + F + G + H + I in one fan-out. If you'd rather
stage it: **wave 1** = A, B, C, D (the high-severity, reachable-now set); **wave
2** = E, F, G, H, I.

---

### Cluster A — Auth boundary 🔴 — ✅ DONE (auth.plan.md, shipped 2026-06-23)

**Implemented by [auth.plan.md](auth.plan.md).** The dev-cookie model is gone:
Better Auth signed sessions replace it, `getCurrentUser` 401s on no session (no
auto-mint), `/api/dev/*` 404 in production, `switch-user` is deleted (replaced by
dev-gated `impersonate`), `/api/dev/me` returns only the current user, and the
default dev user is no longer force-`admin`. A1–A4 are all subsumed. Original
analysis kept below for the record.

The dev-cookie model (`vesper_user` = raw userId; absent/invalid → a default
**admin** user created on demand) is documented dev scaffolding and is the single
load-bearing assumption under every (correct) ownership check.

- **A1 — Gate `/api/dev/*` behind `NODE_ENV !== "production"`** (return 404), the
  same guard already used by `teleport`/`clothing`/`inspect`. `POST
  /api/dev/switch-user` is otherwise an unauthenticated "become anyone" primitive
  and `GET /api/dev/me` enumerates all users + emails. **This is the one true
  now-fix — one line of guard, blocks the worst case.**
- **A2 — `Secure` cookie flag.** `switch-user/route.ts:18` sets `httpOnly +
  sameSite:lax` but no `secure`. Add `secure: process.env.NODE_ENV ===
  "production"`. (LAN dev-origins config anticipates phones over plaintext HTTP.)
- **A3 — Reduce `/api/dev/me` disclosure** to the current user only (drop the
  full `listUsers()` dump); keep the switch UI behind the dev gate.
- **A4 — Don't auto-mint admins.** `ensureDefaultUser` creates the default user
  as `role:"admin"` (`auth/index.ts:35`). The schema already defaults `role` to
  `"user"` — make the default dev user a `user`, reserve `admin` for the explicit
  UX/QA account, so admin-gated routes aren't reachable by the zero-config
  identity. (The `uxtestmain…` account stays admin — see `CLAUDE.md`.)
- Tests: assert `/api/dev/*` 404s when `NODE_ENV=production`.

### Cluster B — Image-decode safety 🔴/🟠 — ✅ DONE (2026-06-23)

**Shipped:** B1 — `{ limitInputPixels: 40_000_000, failOn: "error", animated:
false }` on both `sharp()` decode sites (`upload.ts` resize + `assets.ts`
`writeWebpAtomic`, which backstops every save path). B2 — `decodeDataUrl` mime
allow-list (`image/{png,jpeg,webp,avif}`; SVG and all else rejected). B3 —
pre-decode base64-length check before `Buffer.from`; `MAX_DECODED_BYTES` lowered
12 MB → **4 MB** (coordinated with C5's 3 MB route string cap). Pure test
(`upload.test.ts`) covers SVG reject / oversize-pre-decode reject / valid PNG.

Reachable today by any caller via avatar upload; already-triggerable OOM
(`machine-earlyoom-oom-tuning` memory records earlyoom killing the dev process).

- **B1 — Pixel & failure limits on every untrusted decode.** No `sharp(...)` call
  sets `limitInputPixels` or `failOn`. Pass `{ limitInputPixels: ~40_000_000,
  failOn: "error", animated: false }` at `upload.ts:60` and `assets.ts:78`
  (`writeWebpAtomic` rasterizes whatever buffer it's given). A ~1 MB
  decompression bomb currently expands to 100+ MP.
- **B2 — Raster-format allow-list.** `decodeDataUrl`'s regex accepts
  `image/svg+xml`; the claimed mime doesn't gate decoding (sharp reads the bytes),
  so attacker SVG reaches librsvg. Restrict to `image/{png,jpeg,webp,avif}` and
  reject SVG.
- **B3 — Pre-decode length check.** The 12 MB `MAX_DECODED_BYTES` check runs
  *after* `Buffer.from(payload,"base64")` materializes the whole buffer; validate
  the declared base64 length first (`upload.ts:31-38`). (Pairs with C's route-level
  string-cap reduction — coordinate the constant.)
- Tests: a tiny decompression-bomb fixture and an SVG payload both rejected with a
  diagnostic, not a crash.

### Cluster C — Rate limits & abuse caps 🔴/🟡 — ✅ DONE (2026-06-23)

**Shipped:** added `GENERATION_RATE_LIMIT` (20/min), `CHAT_RATE_LIMIT` (30/min),
`HEAVY_WRITE_RATE_LIMIT` (10/min) in `rate-limit.ts`. C1 — per-user/per-kind
`rateLimit()` on every generation route (avatar, avatar/upload, portraits, chat,
chat/scene, session scene, item/location single + batch image). C2 — heavy
writes `worlds/[id]/duplicate` + `worlds/[id]/sessions`. C3 — limiter moved
*after* ownership + body validation everywhere (incl. reordering inner-note +
forge routes). C4 — `duplicate` malformed body now 400 (`invalid_json`), not
silent-empty. C5 — avatar-upload data-URL cap 16 MB → **3 MB**. Plus `MAX_BATCH
= 100` fan-out cap on the generate-all image routes. In-process `Map` caveat
logged (single-instance by design).

Only `forge`/`from-draft`/`inner-note` were rate-limited before. Every other paid
model / heavy-write endpoint was unthrottled → financial / resource DoS.

- **C1 — Apply `rateLimit()` (per-user, per-kind keys) to all generation
  routes:** `characters/[id]/avatar`, `characters/[id]/avatar/upload`,
  `characters/[id]/portraits`, `characters/[id]/chat`, `characters/[id]/chat/scene`,
  `sessions/[id]/scene`, `items/[id]/image`, `items/images`, `locations/[id]/image`,
  `locations/images`.
- **C2 — Throttle heavy writes:** `worlds/[id]/duplicate` (deep multi-table copy)
  and `worlds/[id]/sessions` (full session materialization).
- **C3 — Order rate-limit *after* ownership+body validation** so 404/400 paths
  don't burn the legitimate owner's budget (`inner-note/route.ts:24-33`; apply the
  pattern to `forge` too).
- **C4 — Fold in the `worlds/[id]/duplicate` `safeJson` fix** (malformed body
  silently treated as empty → should 400, mirror the `sessions` route) since this
  cluster already owns that file.
- **C5 — Route-level body caps:** lower the avatar-upload data-URL string cap from
  16 MB toward the real output size (~2–3 MB for a 3:4 crop). Consider a per-user
  concurrent-job cap (global ceiling on in-flight generation jobs).
- Consider batch-size caps on `items/images` / `locations/images` (generate-all).
- Note: the limiter is an in-process `Map` (single-instance, by design); a shared
  store is out of scope until the app scales past one instance — log that caveat.

### Cluster D — HTTP hardening 🟠 — ✅ DONE (2026-06-23)

**Shipped (decision: `next.config.ts` `headers()`, not middleware — auth already
landed, so nothing favored middleware):** CSP + `X-Content-Type-Options:
nosniff` + `X-Frame-Options: DENY` + `Referrer-Policy:
strict-origin-when-cross-origin` + `Permissions-Policy` (camera/mic/geo off) on
all routes; HSTS **prod-only**. CSP keeps the high-value directives
(`object-src 'none'`, `base-uri 'self'`, `frame-ancestors 'none'`,
`form-action 'self'`) strict while allowing `script-src 'unsafe-inline'/'unsafe-eval'`
for Next's runtime; `connect-src` adds `ws:`/`wss:` in dev only for HMR.
D2 — `allowedDevOrigins` narrowed from `192.168.{0,1}.*` wildcards to the single
`192.168.1.64`. (Verified safe: app makes no client-side off-origin requests —
no Sentry/analytics/CDN; `next/font` self-hosts.)

- **D1 — Security headers.** Add a `headers()` block in `next.config.ts` (or a
  `middleware.ts`): CSP, `X-Content-Type-Options: nosniff`, `X-Frame-Options:
  DENY` / `frame-ancestors`, `Referrer-Policy: strict-origin-when-cross-origin`,
  and HSTS in prod. Especially relevant: the app renders attacker-influenceable
  LLM/world text and serves user images same-origin.
- **D2 — Narrow `allowedDevOrigins`.** Drop the `192.168.0.*` / `192.168.1.*`
  wildcards (`next.config.ts:11`) to the specific test IP already listed.

### Cluster E — Request-body trust boundary 🟡 — ✅ DONE (2026-06-23)

**Shipped:** E1 — `readBody` now reads `Content-Length` and 413s
(`payload_too_large`) over `DEFAULT_MAX_BODY_BYTES = 4 MB` (optional per-call
`{ maxBytes }` override; no caller change required; absent/chunked falls through
to `req.json()`, noted). E2 — `worldDraftSchema` arrays bounded: `locations`
.max(200), `loreChunks` .max(500), `castSuggestions` .max(200), `itemPlacements`
.max(500). E3 — intentionally deferred (Better Auth `trustedOrigins` already
covers CSRF). Tests added (`respond.test.ts` 413 paths, `drafts.test.ts` over-cap
reject). NB: the real file is `server/authoring/drafts.ts` (plan's
`contracts/world/drafts.ts` path was stale).

- **E1 — Max request-body size.** `readBody` calls `req.json()` with no guard
  (`respond.ts:65`); Next route handlers don't enforce the old Pages-API limit. Add
  a `Content-Length` / stream guard so a multi-hundred-MB body is rejected before
  parse.
- **E2 — Bound the world-draft arrays.** `worldDraftSchema` (`drafts.ts:114`) has
  unbounded `locations` / `loreChunks` / `castSuggestions` / `itemPlacements`; add
  `.max(N)`. (The forge *count* is capped at 5, but the parser ingests the whole
  array.)
- **E3 (optional, or defer to auth migration) — origin-check hook** in `withUser`
  for mutating methods. `sameSite:lax` mitigates CSRF today, so this is
  low-urgency; primarily a §Auth-migration item.

### Cluster F — Prompt-injection hardening 🟡 — ✅ DONE (2026-06-23)

**Shipped:** new pure helper `server/engine/prompts/untrusted.ts` —
`fenceUntrusted(label, text)` (opaque sentinel fence), `UNTRUSTED_DATA_NOTICE`
(authoritative "fenced text is data, not instructions" rule), and
`neutralizePlayerInput()` (F2 — escapes leading-`#` headings + softens `(OOC:`
markers so player input can't spoof `## Player input`/`## Turn context`; the
structured `ooc` flag stays trusted). F1 — untrusted author/lore/player spans
fenced + notice added across `narrative.ts`, `character-chat.ts`, `intake.ts`,
`inner-note.ts`, `chat-summary.ts`. `docs/prompts.md` documents the pattern.
Tests in `untrusted.test.ts` + `narrative.test.ts` + `intake.test.ts` (incl. a
heading/OOC breakout test). Registry-derived/structured blocks left unfenced
(low risk + protects prefix-cache byte-stability).

Blast radius is narrative-integrity (not privilege — agents emit *names*
re-validated server-side), but the framework's own headings are forgeable in-band.

- **F1 — Delimit untrusted spans.** Player input, world/character/lore text are
  concatenated into system prompts with markdown headings but no fencing
  (`prompts/narrative.ts:337,168-176`, `prompts/character-chat.ts:120-143`,
  `prompts/intake.ts`, `prompts/inner-note.ts`). Wrap untrusted content in opaque
  sentinel fences the model is told to treat as data.
- **F2 — Strip in-band heading patterns** (`^##`, `(OOC:`) from player input so it
  can't spoof the authoritative `## Turn context` / `## Player input` blocks. The
  structured `ooc` flag is already trusted correctly — keep it.

### Cluster G — LLM-output bounds 🟡 — ✅ DONE (2026-06-23)

**Shipped (graceful slice, not rejecting `.max()` — the schemas parse via
`generateChecked`, so a hard reject would drop the whole result to its degraded
default):** G1 — `MAX_*` slice caps (all 50) at every simulant-array consumption
point in `merge.ts` (`movements`, `itemEvents`, `meterAdjustments`,
`conditionEvents`, `attributeChanges`, `activityUpdates`, `affinityAdjustments`,
`commsEvents`); `intent-brief.ts` arrays bounded with a `capArray` transform
(slice-on-parse, caps 30). G2 — `dedupeThreadProposals` embedding batch capped to
`MAX_THREAD_PROPOSALS` (50); tail still title-deduped (no work dropped). G3 —
trust-basis comment on `threadSignals` IDs (matched against the session-local set,
no DB lookup; non-match → `merge.thread.unmatched` diagnostic). Pure cap test in
`intent-brief.test.ts`.

- **G1 — Cap model-output arrays.** Add `.max(N)` to `movements`, `itemEvents`,
  `meterAdjustments`, `affinityAdjustments`, `conditionEvents`, `activityUpdates`,
  `commsEvents` (`agent-results.ts`) and the `intent-brief.ts` arrays — or `.slice`
  in the merge loops, mirroring `INNER_NOTE_MAX_FACTS`. Today only
  `maxOutputTokens` implicitly bounds them; a token-cap bump would silently lift
  the ceiling. Each element drives a DB write inside the merge transaction.
- **G2 — Cap the `dedupeThreadProposals` embedding batch** (`merge.ts:1240`).
- **G3 (defense-in-depth) — director thread IDs.** `threadSignals.resolve/develop`
  etc. accept raw IDs from the model; they're contained (matched against the
  session-local set, no DB lookup), but prefer title-based matching or document the
  trust basis (`agent-results.ts:191-248`).

### Cluster H — Infra & secrets 🟡 — ✅ DONE (2026-06-23)

**Shipped:** H1 — `docker-compose.yml` port now `127.0.0.1:5435:5432` (no LAN
exposure). H2 — `db-create.ts`/`db-migrate.ts` throw `DATABASE_URL is required
outside development` when `NODE_ENV=production` without `DATABASE_URL`; dev
default preserved. H3 — `.env.example` documents `VENICE_SAFE_MODE="false"` as a
conscious choice not to be promoted to shared/prod.

- **H1 — Bind Postgres to localhost.** `docker-compose.yml` maps `5435:5432` on
  `0.0.0.0`; change to `127.0.0.1:5435:5432` to avoid LAN exposure.
- **H2 — Stronger / non-duplicated DB creds.** `vesper`/`vesper_dev_password` is a
  guessable default hardcoded as a fallback in `scripts/db-create.ts` /
  `db-migrate.ts`. Keep a dev default but make it fail loudly outside dev (require
  `DATABASE_URL`); never promote as-is to a shared env.
- **H3 — Confirm `VENICE_SAFE_MODE="false"`** is a conscious choice (disables the
  image provider's safety filter); document the decision in `.env.example`.

### Cluster I — Defense-in-depth (Lows) 🟢 — ✅ DONE (2026-06-23)

**Shipped:** I1 — `ownerId` added to the session `DELETE` `WHERE`. I2 — gallery
character-chat join owner-scoped on the `characters` side. I3 — already in place
(`Cache-Control: private` for owner-only images). I4 — turn inspector gated
behind `ENABLE_TURN_INSPECTOR === "true"` **and** admin role (404 when off; added
to `.env.example`). I5 — "unknown references" message no longer echoes
attacker-supplied IDs (count only; full list logged server-side). I6 —
`MAX_JOB_ATTEMPTS = 3` poison-job cap (`jobs.ts` abandons over-cap rows before the
handler; `recovery.ts` calls `abandonOverAttemptedJobs` so a poison job is never
re-kicked). Pure test in `jobs.test.ts`.

Small, independent correctness/hardening fixes:

- **I1** — Add `ownerId` to the session `DELETE` `WHERE` (`sessions/[id]/route.ts:27`,
  TOCTOU-only today behind the prior `findOwnedSession`).
- **I2** — Owner-scope the gallery character-chat join on the `characters` side
  (`gallery/route.ts:48`).
- **I3** — `Cache-Control: private` (not `public`) on owner-scoped image responses
  (`images/[id]/file/route.ts`) so a future shared CDN can't cross-serve.
- **I4** — Put the turn inspector behind an explicit `ENABLE_TURN_INSPECTOR` flag
  rather than relying solely on the `role` check
  (`sessions/[id]/turns/[turnId]/inspect/route.ts`).
- **I5** — Generalize the "unknown references: <id>, …" message to avoid echoing
  attacker-supplied IDs verbatim (`server/api/worlds.ts:205`).
- **I6** — Add a `MAX_JOB_ATTEMPTS` cap before the recovery sweep re-kicks a job, so
  a poison job can't loop forever (`engine/jobs.ts:155`, `recovery.ts:71`).

---

## Auth migration (separate, larger effort — not a quick-win cluster) — ✅ DONE (2026-06-23)

> **Implemented by [auth.plan.md](auth.plan.md)** (Better Auth + entity
> visibility), shipped 2026-06-23. Every requirement below is met: signed
> sessions, 401 on unresolved identity (no default/admin), `switch-user` deleted,
> `secure`+`sameSite` cookies (Better Auth defaults). Cluster A is subsumed; the
> `role`-gated routes now run under genuine authentication. The origin/CSRF check
> (E3) is Better Auth's built-in `baseURL`/`trustedOrigins` enforcement. See
> [../auth.md](../../auth.md). Requirements checklist retained below for the record.

The clusters above harden the *current* model; they do not replace it.
`server/auth/index.ts` is, by design, "the entire auth-migration surface." When
real auth lands:

- Unresolved identity → **401**, never a default user, never `admin`.
- Signed sessions (or a real IdP); drop cookie-as-identity and delete
  `dev/switch-user` entirely.
- Set the auth cookie `sameSite:strict` + `secure`; add the origin/CSRF check
  (E3) at that point.
- Re-evaluate the `role`-gated routes (`inspect`, `threads` DELETE, `clothing`)
  under genuine authorization.

Record the requirement in `docs/streaming-api.md §Auth` so the migration doesn't
drop these.

## Verified clean (no work — keep it that way)

For reviewers: the scan explicitly confirmed these, so don't "fix" non-issues.

- **IDOR sweep clean** across all routes incl. nested ids; child queries re-scope
  by owned parent id, engine helpers re-verify ownership.
- **No SQL injection** (Drizzle parameterized; raw `sql` uses values or
  whitelisted `sql.identifier`).
- **No SSRF** (no route fetches a user-supplied URL; outbound only to fixed
  Venice/OpenRouter endpoints).
- **No mass assignment** (`ownerId` always server-set; create schemas `.strict()`;
  draft refs re-scoped to owner).
- **No client XSS** (no `eval`/`innerHTML`/markdown-HTML; two
  `dangerouslySetInnerHTML` are static strings; no `NEXT_PUBLIC_*` secrets).
- **No committed secrets** (`.env` gitignored, absent from history).
- **LLM output parsed safely** (`generateChecked` zod+repair; keys server-only,
  never in responses/diagnostics; memory scoped by session/world/owner+embedder).
- **pnpm build-script allow-list** correctly minimal (`sharp`/`esbuild`/`unrs-resolver`).

## Open questions — all resolved (2026-06-23)

- **Headers location** — RESOLVED: `next.config.ts` `headers()`. The auth
  migration already landed, so nothing favored middleware; the origin/CSRF check
  (E3) is Better Auth's job, not a header concern. *(Cluster D.)*
- **Rate-limit values** — RESOLVED: per-kind constants off the FORGE baseline —
  generation 20/min, chat 30/min, heavy-write 10/min (forge/inner-note stay
  10/min). *(Cluster C.)*
- **Pixel-limit threshold** — RESOLVED: 40 MP. The legitimate path is a canvas
  JPEG re-fit to 768×1024 (well under 1 MP), so 40 MP clears every real image
  with vast headroom while killing decompression bombs. *(Cluster B.)*
- **Default-user role flip (A4)** — RESOLVED by the auth migration (moot: there
  is no longer an auto-minted default user).
