# Security & ownership hardening — 2026-07-25 review follow-ups

Status: **next** (promoted 2026-07-25 from
[deferred/security-authz.plan.md](deferred/CLAUDE.md) — parked and promoted the
same day on the owner's call; queued at the top of
[roadmap.md](roadmap.md) §Next)

Successor to the shipped 2026-06-23 sweep
([finished/security-hardening.plan.md](finished/security-hardening.plan.md)).
Source: an external static security review of main (auth, authorization,
cross-user access, public-library behavior, destructive ops), every finding
re-verified against the code at parking time. File:line refs below were
captured 2026-07-25 — **re-verify while building; the code moves.**

## The findings (S1–S7), evaluated

The review's headline matches the 2026-06-23 scan's: the ownership model is
disciplined — signed Better Auth sessions, `ownerId` in the same query as the
read/write, 404 over existence leaks. Seven findings survive verification.
None is exploitable under today's deployment facts (single owner,
`ALLOW_SIGNUP` off, chat creation rejects foreign character ids), but several
are one planned feature away from being live — public library sharing,
sign-up, multi-character chats, and successor worlds referencing library
entities each flip an assumption one of these leans on.

- **S1 — magic-link URLs written to production logs.** CONFIRMED
  (`src/server/auth/auth.ts:62-64`): `sendMagicLink` logs `{ email, url }`
  unconditionally — the documented v1 dev fallback (no email transport
  exists), but the `magicLink` plugin registers unconditionally, so on Fly a
  magic-link request writes a live sign-in URL (a temporary password) into
  log retention. **Highest priority and cheapest fix.**
- **S2 — public entities expose their complete DB row.** CONFIRMED:
  `findViewable` uses bare `.select()` for all four shareable kinds
  (`src/server/api/visibility.ts:33-63`) and the entity GET routes return the
  row verbatim to foreign viewers (`characters/[id]/route.ts:34`,
  `locations/[id]/route.ts:36`, `items/[id]/route.ts:37`,
  `social-cards/[id]/route.ts:34`). "Public" currently means "every persisted
  column is public" — any future column (author notes, moderation metadata,
  provider config) leaks automatically. The portraits sub-query is the
  concrete case today: full `images` rows go to foreign viewers, including
  `path` (storage layout) and `prompt` — and `deleteChat` scrubs image
  prompts precisely because prompts embed chat lines, so the codebase already
  treats that column as sensitive. (Personas are exempt: owner-strict, no
  `visibility` column.)
- **S3 — character deletion traverses chats without an owner condition.**
  CONFIRMED (`src/app/api/characters/[id]/route.ts:77-84`): the traversal
  matches `chatParticipants.characterId` only, then calls `deleteChat(chat)`
  with the *chat row's* `ownerId` — and `deleteChat` trusts its
  caller-supplied `{ id, ownerId }`
  (`src/server/engine/chat-pipeline.ts:1972`). Today the invariant "chat
  owner == character owner" holds, so this is defense-in-depth — but the
  route's own comment anticipates multi-character chats, and shared
  characters or an import path would turn this into deleting another user's
  transcript and memories.
- **S4 — ownership enforced only in application queries.** ACCURATE as an
  architectural observation: no owner-aware repository layer, no RLS — one
  missed predicate is a full IDOR. The 2026-06-23 route sweep came back
  clean, but the successor engine multiplies resources faster than
  route-by-route sweeps scale. The pragmatic middle is guardrail-shaped
  (slice 6), with RLS held as an open question, not a commitment.
- **S5 — public image access keyed on unverified polymorphic metadata.**
  CONFIRMED (`src/server/api/visibility.ts:72-83`): `isPublicEntityImage`
  checks only "the named entity exists and is public" — no ownership
  relationship between image owner and entity owner. Today
  `entityKind`/`entityId` are assigned server-side at creation, so
  exploitability is low, but the check is one metadata-writing path away from
  cross-owner exposure. One extra predicate closes it.
- **S6 — email/password policy needs production hardening.** VALID as a
  pre-public-signup checklist, not now-work: no email verification, no
  password policy, no admin MFA, no session-revocation-on-reset configured;
  the rate limiter is deliberately process-local
  (`src/server/api/rate-limit.ts` — recorded as a single-instance deferral in
  the 2026-06-23 plan). Fine while `ALLOW_SIGNUP` stays off and the app runs
  one instance; mandatory before either changes.
- **S7 — no adversarial two-user authorization test matrix.** VALID coverage
  gap. Individual cross-user cases exist (`social-cards.int.test.ts` around
  `findViewable`), but there's no reusable owner/other matrix, so
  authorization regressions surface only if someone thinks to write the case.

## Build order — slices

Ordered by risk-closed-per-effort. 1–3 are small and independent; 4 is the
bulk of the work; 5 locks it all in as regression coverage; 6–7 are
guardrail/docs tails. Each slice lands with its tests and passes the full
gate (lint → lint:cycles → typecheck → test → jscpd, separately).

### Slice 1 — S1: no magic-link URLs in production output

- In `src/server/auth/auth.ts`, register the `magicLink` plugin
  **conditionally**: always in dev; in production only when a real transport
  is configured (no transport exists yet, so production simply drops the
  plugin — matching how OAuth providers already spread in only when their
  env creds exist).
- `sendMagicLink` logs the URL only when `NODE_ENV !== "production"`; the
  production branch (unreachable until a transport lands) logs a
  no-token/no-URL event (`auth.magic_link`, email only) and hands off to the
  transport. Never log token, callback URL, or query string in production.
- Tests: unit-test the plugin-enablement predicate and the two logging
  branches (prod path asserts the log payload contains **no** `url`).
- Docs: update `docs/auth.md` + `docs/getting-started.md` (both describe the
  log-the-link dev fallback).

### Slice 2 — S3: owner-scoped deletion, ownership verified inside `deleteChat`

- `src/app/api/characters/[id]/route.ts` DELETE: add
  `eq(characterChats.ownerId, user.id)` to the traversal's `where`, so an
  anomalous cross-owner participant row can never route another user's chat
  into deletion. (The character row delete that follows is already
  owner-scoped; a skipped foreign chat simply survives, correctly.)
- Change `deleteChat(chat: { id, ownerId })` →
  `deleteChat(chatId: string, ownerId: string)` where the function
  **re-reads** the chat with `WHERE id = :chatId AND owner_id = :ownerId`
  and no-ops (with a `warn` diagnostic, per docs/resilience.md) when nothing
  matches — destructive services stop trusting route-supplied ownership
  facts. Callers: `characters/[id]/route.ts:83`,
  `chats/[chatId]/route.ts:472`.
- Int test: seed user A's character participating in user B's chat
  (violating today's invariant by construction), delete A's character,
  assert B's chat + transcript + memory rows survive and A's character is
  gone.

### Slice 3 — S5: bind public-image access to matching ownership

- `isPublicEntityImage(entityKind, entityId)` →
  `isPublicEntityImage(entityKind, entityId, imageOwnerId)`; the SQL gains
  `and owner_id = ${imageOwnerId}` beside `visibility = 'public'`. Sole
  caller: `src/app/api/images/[id]/file/route.ts:22` (passes `row.ownerId`).
- Int test: image row whose `entityKind`/`entityId` point at another user's
  public character → foreign fetch 404s; the entity owner's own image on the
  same public character → foreign fetch 200 with `Cache-Control: public`.

### Slice 4 — S2: allow-listed public DTOs for foreign public reads

The principle: **"public" means the approved public representation, not the
persisted row.** Owner reads keep returning full rows (the edit surfaces need
them); the sanitized shape applies when `row.ownerId !== user.id`.

- Add per-kind public projections beside `findViewable` in
  `src/server/api/visibility.ts` (e.g. `toPublicCharacter(row)`,
  `toPublicLocation`, `toPublicItem`, `toPublicSocialCard`) — explicit
  allow-lists: id, name, tags, visibility, createdAt, plus each kind's
  display fields (character `profile` + `avatarImageId`; location
  description/ambient/scale/area/affordances; item display fields;
  social-card display fields). **Never** `ownerId` (the client only needs
  `mine`, already computed server-side), `searchEmbedding`, or any future
  column by default.
- Portraits in the character GET: replace full `images` rows with an
  allow-listed shape — `{ id, kind, entityKind, entityId, createdAt }` (what
  the strip needs to render via `/api/images/[id]/file`). **No `path`, no
  `prompt`, no provider/status internals.** Owner view may keep the full
  rows if the editor needs them — split at the same `mine` seam.
- Apply at the four entity GET routes; audit the other public-scope read
  paths for the same leak: the library browse/search hydration
  (`src/server/api/library.ts` — its search returns ids; whatever hydrates
  those ids for `scope: "public"`/`"all"` must project, not `select()`), and
  any preview/summary endpoint returning foreign rows. `cloneToLibrary` is
  server-side and copies explicit fields — fine as-is (but see OQ2).
- **The review's best idea, adopted:** per-kind int tests that enumerate the
  **exact key set** of a foreign public entity response
  (`expect(Object.keys(body.character).sort()).toEqual([...])`), so adding a
  column can never silently widen the public surface. Same for the portrait
  shape.
- Client sweep: the preview surfaces consume `character`/`location`/… from
  these routes; typecheck catches removed-field usage (fix consumers to the
  public shape or gate on `mine`).

### Slice 5 — S7: the two-user authorization matrix, as a permanent fixture

- A reusable `test:int` harness (e.g. `src/server/api/authz-matrix.int.test.ts`):
  seed users A and B once, then run a table-driven matrix over every owned
  resource — characters, locations, items, social cards, personas, images,
  chats (+ messages), successor chats/worlds/branches:
  - read private: owner 200 / other 404
  - read public: owner 200 full / other 200 **allow-listed keys** (slice 4's
    enumeration folded in here)
  - update / delete: owner 200 / other 404 (and other's write leaves the row
    unchanged)
  - child resources (portraits under a character, messages under a chat):
    other 404; valid child id under the wrong parent 404
- The review's named cases become explicit rows: B requests A's chat by
  UUID; B supplies A's character id at chat creation; B supplies a foreign
  image id with their own character id; B issues commands against A's
  successor branch id; polymorphic image metadata cannot expose a private
  entity's image (slice 3's case, kept here as regression).
- Convention going forward (record beside the harness): every new owned
  resource adds its matrix row in the same change that adds the route.

### Slice 6 — S4: route-layer ownership guardrail

- A cheap architectural tripwire, not a framework: a pure test (or lint
  rule, whichever proves precise enough) that scans `src/app/api/**/route.ts`
  for `.update(`/`.delete(` chains and fails unless the statement includes an
  ownership predicate (`ownerId`/`owner_id`) or calls an approved
  owner-asserting helper (allow-list for the genuine exceptions, e.g.
  admin-gated routes — each exception carries a justifying comment).
- Extract owner-aware helpers only where they fall out naturally while
  implementing slices 2–4 (e.g. `findOwnedCharacter` already exists — mirror
  that shape elsewhere); no big-bang repository layer.
- RLS: **not in this plan** — held as OQ1 below.

### Slice 7 — S6: the pre-public-signup checklist (docs + explicit config)

- New section in `docs/auth.md` — "Before `ALLOW_SIGNUP=true`": required
  email verification, password policy, shared (cross-instance) rate limiting
  on sign-in/reset/magic-link, admin MFA/WebAuthn, revoke-all-sessions on
  credential change, explicit idle/absolute session lifetimes, security
  events logged without tokens. Each item marked done/pending — the list is
  the gate.
- Now-code (small): set Better Auth's session `expiresIn`/`updateAge`
  explicitly rather than inheriting defaults, so lifetime is a deliberate,
  documented choice. Everything else in the checklist waits for the signup
  decision; the shared rate limiter stays deferred until multi-instance
  (unchanged 2026-06-23 ruling).

## Open questions

- **OQ1 — RLS (S4):** worth the migration + per-request `SET LOCAL`
  plumbing on Neon, or is the slice-6 tripwire + helper layer enough for a
  single-tenant-per-row app? Revisit when successor resources multiply or a
  second app instance appears. (The review itself calls RLS "more
  involved".)
- **OQ2 — what does "public character" reveal?** `profile` is currently
  copied whole by the duplicate CTA, so it is de facto fully public today.
  Needs an owner ruling: is the full profile (narrator-facing authoring
  detail included) the intended public surface, or should public preview +
  clone both narrow to a presentation subset? Slice 4 ships with profile
  included pending the ruling — flipping it later is a projection edit plus
  the key-enumeration test update.
- **OQ3 — transport before signup?** If a real email transport
  (Resend/SMTP) is scheduled before any `ALLOW_SIGNUP=true` window, S1's
  production path becomes "transport or plugin-off", never "log", and the
  slice-7 checklist gains its verification-email dependency for free.
