# Security hardening — plan

Status: **next** — queued. Remediation of the 2026-06-23 full-surface security
scan (six parallel review agents over auth/API, all routes, AI/engine, images,
data layer, and config). Topic slug `security-hardening`.

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

**Implemented by [auth.plan.md](finished/auth.plan.md).** The dev-cookie model is gone:
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

### Cluster B — Image-decode safety 🔴/🟠

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

### Cluster C — Rate limits & abuse caps 🔴/🟡

Only `forge`/`from-draft`/`inner-note` are rate-limited today. Every other paid
model / heavy-write endpoint is unthrottled → financial / resource DoS.

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

### Cluster D — HTTP hardening 🟠

- **D1 — Security headers.** Add a `headers()` block in `next.config.ts` (or a
  `middleware.ts`): CSP, `X-Content-Type-Options: nosniff`, `X-Frame-Options:
  DENY` / `frame-ancestors`, `Referrer-Policy: strict-origin-when-cross-origin`,
  and HSTS in prod. Especially relevant: the app renders attacker-influenceable
  LLM/world text and serves user images same-origin.
- **D2 — Narrow `allowedDevOrigins`.** Drop the `192.168.0.*` / `192.168.1.*`
  wildcards (`next.config.ts:11`) to the specific test IP already listed.

### Cluster E — Request-body trust boundary 🟡

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

### Cluster F — Prompt-injection hardening 🟡

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

### Cluster G — LLM-output bounds 🟡

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

### Cluster H — Infra & secrets 🟡

- **H1 — Bind Postgres to localhost.** `docker-compose.yml` maps `5435:5432` on
  `0.0.0.0`; change to `127.0.0.1:5435:5432` to avoid LAN exposure.
- **H2 — Stronger / non-duplicated DB creds.** `vesper`/`vesper_dev_password` is a
  guessable default hardcoded as a fallback in `scripts/db-create.ts` /
  `db-migrate.ts`. Keep a dev default but make it fail loudly outside dev (require
  `DATABASE_URL`); never promote as-is to a shared env.
- **H3 — Confirm `VENICE_SAFE_MODE="false"`** is a conscious choice (disables the
  image provider's safety filter); document the decision in `.env.example`.

### Cluster I — Defense-in-depth (Lows) 🟢

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

> **Implemented by [auth.plan.md](finished/auth.plan.md)** (Better Auth + entity
> visibility), shipped 2026-06-23. Every requirement below is met: signed
> sessions, 401 on unresolved identity (no default/admin), `switch-user` deleted,
> `secure`+`sameSite` cookies (Better Auth defaults). Cluster A is subsumed; the
> `role`-gated routes now run under genuine authentication. The origin/CSRF check
> (E3) is Better Auth's built-in `baseURL`/`trustedOrigins` enforcement. See
> [../auth.md](../auth.md). Requirements checklist retained below for the record.

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

## Open questions

- **Headers location** — `next.config.ts` `headers()` vs. a new `middleware.ts`?
  Middleware also gives a natural home for the future origin/CSRF check (E3) and a
  global auth gate. Lean middleware if the auth migration is near; else
  `next.config.ts` is simpler. *(Cluster D — decide before starting.)*
- **Rate-limit values** — pick per-kind limits/windows (generation vs. chat vs.
  heavy-write). Reuse `FORGE_RATE_LIMIT` (10/min) as the baseline? *(Cluster C.)*
- **Pixel-limit threshold** — 40 MP is a starting point; confirm it clears the
  largest legitimate avatar/scene reference image. *(Cluster B.)*
- **Default-user role flip (A4)** — does anything in dev rely on the zero-config
  user being `admin` (besides the explicit `uxtestmain…` account)? Check before
  flipping to `user`.
