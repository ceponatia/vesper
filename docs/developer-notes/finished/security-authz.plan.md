# Security & ownership hardening — 2026-07-25 review follow-ups

Status: **shipped — 2026-07-26** (promoted 2026-07-25 from
[deferred/security-authz.plan.md](../deferred/CLAUDE.md), built 2026-07-26)

**Completion note (2026-07-26):** all seven slices landed in one batch (five
parallel implementation agents; gates run serially green — lint, cycles,
typecheck, pure tests, jscpd — plus `pnpm test:int` against a local
Postgres). Beyond the slice text: `/api/auth-config` now reports the real
magic-link gate (it was hardcoded `true`, which would have rendered a dead
sign-in button once production drops the plugin).

**Follow-up hardening batch (2026-07-26, same day):** an external review of
the shipped batch drove eight corrections, all landed and gated (serial
gates green; **strict** integration run `pnpm test:int:strict` 519/519 with
zero skips):

1. **S1 corrected — no transport exists, and env vars no longer pretend one
   does.** The first cut treated `RESEND_API_KEY`/`SMTP_URL` *presence* as a
   working transport while `sendMagicLink` only logged. Now
   `configuredMagicLinkTransport()` resolves from a registry of *implemented*
   senders — empty today, so **production magic-link is disabled
   unconditionally** until a real sender is registered; the same resolved
   transport drives plugin registration, `/api/auth-config`, and delivery
   (send failures rethrow with a no-URL diagnostic). The env names are
   documented as reserved and inert.
2. **Follow-up 1 FIXED:** `authorizeSimulationCommand`
   (`simulation/command-authz.ts`) resolves branch → anchoring chat →
   `owner_id` inside all four durable shells, before any write (ledger,
   events, projections, outbox, scheduler, cached-result replay included);
   `player` principals must match the owner, admin/engine kinds pass by
   construction, two-owner anomalies fail closed; denials are
   not-found-shaped with a `sim.command_denied` warn. `requireSimChat` stays
   as route-level defense in depth. Noted leftover: `character_chats.
   sim_branch_id` has no index (seq scan on a small table, player-kind
   commands only) — add one via the normal db:generate flow when convenient.
3. **Follow-up 2 FIXED:** `promoteVariant(characterId, imageId, ownerId)`
   verifies character ownership, image ownership, and the image↔character
   metadata binding in its own queries (`images.promote.*` warn codes,
   denials indistinguishable from not-found).
4. **Follow-up 3 FIXED:** `searchLibraryIds` rejects non-owned scopes for
   visibility-less kinds at compile time (overload split on `ShareableKind`)
   and at runtime (`api.library.scope_unsupported` warn + `[]`, before any
   SQL composes).
5. **S4 census corrected + tripwire strengthened:** ownership tokens now
   count only inside the mutation's `.where(...)` span (rejected fixtures
   prove `.set({ownerId})`/`.returning({ownerId})`/comments no longer pass);
   helper guards must be invoked with `user.id`, above the write, result
   branched on. Corrected baseline: **31 sites / 14 where-owned / 13
   helper-guarded / 4 allow-listed under 3 entries** (11 sites are both).
   New simulation invariant: the four durable shells call
   `authorizeSimulationCommand` before their first write and all 48 other
   `submitDurable*` exports delegate to a shell. The scanner's header states
   it is a regression tripwire, not semantic proof.
6. **Strict integration mode:** `pnpm test:int:strict`
   (`REQUIRE_INTEGRATION_DB=true`) makes DB-probe failures fail suites
   loudly instead of skipping — the release form (docs/testing.md). Honored
   by the seven security suites via the shared `src/server/test-support`
   probe; legacy suites still self-skip (documented boundary). The matrix
   also stopped reproducing private route predicates: `findPortrait`/
   `listOwnedPortraits`/`findPersona`/`loadOwnedRoster` are extracted
   helpers called by both routes and matrix.
7. **OQ2 RESOLVED (ruling below).**
8. Portrait-delete route writes carry direct owner predicates (was
   helper-guard only).

**OQ2 ruling (2026-07-26): conservative private-by-default.** A public
character's profile surface is `toPublicCharacterProfile`
(`src/contracts/world/profile.ts`, colocated with the schema): `age`, `bio`,
`personality`, `speciesId`, and `attributes` narrowed to `identity.gender`
as `{id, value}` — exactly what the foreign preview and browse facets
render. Withheld: voice, microExemplars, voiceAnchors, drives, traits,
preferences, socialCards, playerRelationship, intimacy, intimateRegions,
bodyPlanId, bodyFeatures, outfits, schedule, aliases, disposition tags, all
other attributes. Ambiguous-and-excluded (promotable later): `heritageId`,
appearance attributes, `bodyFeatures`. **Clone deliberately stays wider**
(full profile copy — a clone is a full authored copy, not a preview;
recorded in `clone.ts`).

Remaining open: OQ1 (RLS) and OQ3 (transport-before-signup) below. Not
deployed — Fly deploys stay manual.

Successor to the shipped 2026-06-23 sweep
([finished/security-hardening.plan.md](../finished/security-hardening.plan.md)).
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

## Follow-ups (recorded at ship 2026-07-26 — ALL FIXED same day)

Surfaced by slice 5's adversarial sweep; all three closed by the follow-up
hardening batch (see the completion note for what shipped). Original findings
kept for the record:

1. **[FIXED] The durable simulation command layer is ownership-blind.**
   `submitDurable*`/`runSimulationCommand`
   (`src/server/engine/simulation/command-runner.ts`) lock the branch by id
   and record — but never validate — `principal.principalId` against the
   chat's owner; `requireSimChat` in the sim-command route is the *only*
   gate. Exactly the S3 shape: one new caller away. Fix when the command
   surface is next touched: validate the principal against the branch's
   owning chat inside the runner, or extend the slice-6 tripwire to
   `src/server/engine/simulation/`.
2. **[FIXED] `promoteVariant(characterId, imageId)` takes no ownerId**
   (`src/server/images/variants.ts`) — safe only because the route gates on
   `findOwnedCharacter` and the image must already point at that character.
   Same polymorphic-metadata trust S5 flagged; thread the owner id through
   when the variants module is next edited.
3. **[FIXED] Latent 500 in persona listing scope:** `searchLibraryIds` emits
   `visibility = 'public'` for non-owned scopes, but `personas` has no
   `visibility` column — safe only because the personas route hardcodes
   `scope: "owned"`. If persona listing ever accepts a scope param it throws
   rather than leaks; make `searchLibraryIds` reject non-shareable kinds for
   non-owned scopes instead.

## Open questions

- **OQ1 — RLS (S4):** worth the migration + per-request `SET LOCAL`
  plumbing on Neon, or is the slice-6 tripwire + helper layer enough for a
  single-tenant-per-row app? Revisit when successor resources multiply or a
  second app instance appears. (The review itself calls RLS "more
  involved".)
- ~~OQ2~~ — resolved 2026-07-26; ruling recorded in the completion note
  (conservative private-by-default `toPublicCharacterProfile`; clone stays
  deliberately wider).
- **OQ3 — transport before signup?** If a real email transport
  (Resend/SMTP) is scheduled before any `ALLOW_SIGNUP=true` window, S1's
  production path becomes "transport or plugin-off", never "log", and the
  slice-7 checklist gains its verification-email dependency for free.
