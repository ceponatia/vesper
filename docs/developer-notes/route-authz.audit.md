# Resource-ID route authorization — audit

Status: reference (audit run 2026-08-12)

A snapshot of the code as it stood on the date above. It records findings; it
does not plan the fixes. A finding worth acting on becomes a plan or an entry in
[deferred.plan.md](deferred.plan.md) — link that destination from the finding.

## Scope

The audit examined the 30 `apps/web/src/app/api/**/[param]/**/route.ts` files
that matched the existing `scripts/check-route-authz.ts` failure shape on
2026-08-12: the file used bare `withUser` and mentioned none of the route-level
authorization wrappers accepted by that gate.

Each route was classified as:

- **(a) owner-scoped by another mechanism** — the handler proves ownership with
  a row lookup, an inline owner predicate, or an owned parent before touching
  the requested resource;
- **(b) intentionally not owner-strict** — the route deliberately permits a
  wider operation such as viewing or cloning a public library entity, through a
  visibility seam that still hides private foreign resources; or
- **(c) IDOR gap** — a caller can use another account's resource identifier
  without an ownership or intentional visibility gate.

The audit also examined the helper inventory in
`scripts/ownership-guardrail.test.ts`, the visibility and clone seams used by the
widened library routes, and the two-user authorization matrix in
`apps/web/src/server/api/authz-matrix.int.test.ts`.

The audit did not re-review unrelated API routes that did not match the stated
30-route census, provider authorization outside the route layer, or the
correctness of Better Auth session establishment itself.

## Method

Each of the 30 route files was read in full. For every HTTP handler, the audit
followed the path parameter from the route boundary to the first authorization
check and then through any child-resource query or mutation.

A route counted as class (a) only when ownership evidence was load-bearing. A
helper name or import alone did not count: the helper had to receive the current
session user and the relevant route resource, and the handler had to branch on
its result before proceeding. Inline Drizzle access counted only when the query
or mutation bound the resource to the session owner, or when an already-owned
parent constrained a child identifier.

Class (b) was reserved for explicit product behavior. The clone routes were
traced through `cloneToLibrary` to `findViewable`, and widened GET routes were
traced directly through `findViewable`. That seam allows the caller's own row or
a public row and hides a private foreign row.

The source review was cross-checked against the two-user matrix:

- owned character, location, item, social-card, persona, image, and chat rows;
- public versus private shareable reads;
- child resources under owned and wrong parents;
- foreign chat identifiers;
- foreign image identifiers; and
- successor branches reached through `requireSimChat` and the owned chat anchor.

## Findings

### None of the 30 routes has an IDOR gap

- **What** — 24 routes are class (a), six are class (b), and zero are class (c).
  Every owner-strict operation either proves ownership directly or is reached
  only after an owned-parent gate. The six widened routes use the deliberate
  owner-or-public library visibility contract rather than an unrestricted ID
  lookup.
- **Impact** — the 30-route census does not require an urgent route rewrite.
  Replacing these checks with wrappers solely to satisfy the old lint heuristic
  would add churn without strengthening the authorization model.
- **Where it goes** — no route-level follow-up. The accompanying guardrail
  correction teaches the existing tripwire to recognize the mechanisms found
  by this audit.

#### Class (a) — owner-scoped by another mechanism

- `apps/web/src/app/api/characters/[id]/attributes/from-portrait/route.ts` —
  `findOwnedCharacter(id, user.id)` gates the canonical portrait read.
- `apps/web/src/app/api/characters/[id]/avatar/upload/route.ts` —
  `findOwnedCharacter(id, user.id)` gates the upload.
- `apps/web/src/app/api/characters/[id]/relationships/route.ts` — the local
  `ownedCharacter` lookup binds the source character to `user.id`; submitted
  target characters are also fetched under the same owner.
- `apps/web/src/app/api/chat-presets/[presetId]/route.ts` — DELETE matches both
  `presetId` and `chatScenarioPresets.ownerId = user.id`.
- `apps/web/src/app/api/chats/[chatId]/attachments/route.ts` — `loadOwnedChat`
  gates the upload before any chat attachment is created.
- `apps/web/src/app/api/chats/[chatId]/export/route.ts` — `loadOwnedChat` gates
  transcript, summary, scenario, and optional memory reads.
- `apps/web/src/app/api/chats/[chatId]/messages/[messageId]/take/route.ts` —
  `loadOwnedChat` proves the parent chat; the take operation receives that
  `chatId` together with the child message id.
- `apps/web/src/app/api/chats/[chatId]/milestones/route.ts` — `loadOwnedChat`
  proves the parent; the message lookup additionally matches `messageId` and
  `chatId` together.
- `apps/web/src/app/api/chats/[chatId]/participants/[characterId]/route.ts` —
  `loadOwnedChat` proves the parent and the child must exist in the owned roster
  before update or removal.
- `apps/web/src/app/api/chats/[chatId]/participants/route.ts` — `loadOwnedChat`
  proves the parent; a joining character is separately matched by id and
  `characters.ownerId = user.id`.
- `apps/web/src/app/api/chats/[chatId]/relationship/route.ts` —
  `loadOwnedChat(chatId, user.id)` gates the relationship panel read.
- `apps/web/src/app/api/chats/[chatId]/relationships/route.ts` —
  `loadOwnedChat` gates the matrix and every submitted character id must be in
  the owned chat's roster.
- `apps/web/src/app/api/chats/[chatId]/remember/route.ts` — `loadOwnedChat`
  gates the memory scope before the player note is written.
- `apps/web/src/app/api/chats/[chatId]/sim-command/route.ts` —
  `requireSimChat(chatId, user.id)` is the successor authorization seam; the
  branch and world identifiers are derived only after it succeeds.
- `apps/web/src/app/api/chats/[chatId]/sim-turn/route.ts` — `loadOwnedChat`
  gates the successor turn before `runSimChatExchange` receives the chat id.
- `apps/web/src/app/api/chats/[chatId]/stop/route.ts` — `loadOwnedChat` runs
  before the in-flight reply is addressed by chat id.
- `apps/web/src/app/api/chats/[chatId]/summary/rebuild/route.ts` —
  `loadOwnedChat` gates the rebuild before the transcript is folded.
- `apps/web/src/app/api/chats/[chatId]/time-skip/route.ts` — `loadOwnedChat`
  gates all scenario, roster-state, wardrobe, and successor-shadow work.
- `apps/web/src/app/api/gallery/[id]/route.ts` — DELETE uses
  `deleteOwnedImage(id, user.id)`; PATCH matches image id, owner id, and an
  allowed gallery kind in its update predicate.
- `apps/web/src/app/api/items/[id]/image/route.ts` — the local `ownsItem` lookup
  matches item id and owner id; image reads also match the caller's owner id.
- `apps/web/src/app/api/items/[id]/usage/route.ts` — the item is first matched by
  id and owner id, and referenced characters are queried only under `user.id`.
- `apps/web/src/app/api/locations/[id]/image/route.ts` — the local
  `ownsLocation` lookup matches location id and owner id; image reads are also
  owner-scoped.
- `apps/web/src/app/api/personas/[id]/route.ts` — every verb gates through
  `findPersona(user.id, id)`; mutations additionally carry inline owner
  predicates.
- `apps/web/src/app/api/successor-chats/[chatId]/route.ts` — the handler first
  matches `characterChats.id = chatId` and `characterChats.ownerId = user.id`;
  the branch and world are then derived from that owned chat.

#### Class (b) — intentionally wider than owner-only

- `apps/web/src/app/api/characters/[id]/clone/route.ts` — `cloneToLibrary`
  deliberately accepts the caller's own character or a public character and
  returns not-found for a private foreign source.
- `apps/web/src/app/api/items/[id]/clone/route.ts` — the same intentional
  owner-or-public clone contract for items.
- `apps/web/src/app/api/locations/[id]/clone/route.ts` — the same intentional
  owner-or-public clone contract for locations.
- `apps/web/src/app/api/locations/[id]/route.ts` — GET deliberately widens
  through `findViewable`; PATCH and DELETE remain owner-strict through
  `findLocation` and inline owner predicates.
- `apps/web/src/app/api/social-cards/[id]/clone/route.ts` — the same intentional
  owner-or-public clone contract for social cards.
- `apps/web/src/app/api/social-cards/[id]/route.ts` — GET deliberately widens
  through `findViewable`; PATCH and DELETE remain owner-strict through
  `findCard` and inline owner predicates.

#### Class (c) — IDOR gaps

None.

### The changed-file lint heuristic was narrower than the authorization model

- **What** — `scripts/check-route-authz.ts` recognized only seven higher-order
  route wrappers. It did not recognize guarded owner-asserting row lookups,
  direct `(resource id, owner id)` predicates, owned-parent child access, or the
  intentional `findViewable` / `cloneToLibrary` visibility seams. Its lint path
  also examines only content changed from the comparison base, so old routes
  can predate the check indefinitely.
- **Impact** — a repository-wide backfill produces false positives for valid
  routes, while the normal changed-file invocation cannot itself prove that
  untouched resource routes have ever been reviewed.
- **Where it goes** — addressed in the accompanying guardrail change. The lint
  classifier recognizes guarded audited seams and inline owner predicates, and
  its unit test walks the whole route tree so pre-existing bare-`withUser`
  resource routes remain in the regression census.

### The two-user matrix supports the route classifications

- **What** — the matrix independently establishes owner-strict reads and writes
  for the principal owned tables, owner-or-public reads for shareable entities,
  parent/child isolation for portraits and chat messages, foreign-image
  rejection, and the `requireSimChat` successor boundary. The clone routes are
  not invoked as HTTP handlers by the matrix, but their authorization seam is
  `findViewable`, whose public/private behavior is exercised there and whose
  use by `cloneToLibrary` was verified in source.
- **Impact** — the audit does not rely only on naming conventions in route
  files; the major authorization seams also have an adversarial two-account
  regression layer.
- **Where it goes** — no action. The matrix remains the semantic authorization
  regression net; the static lint/test scanners remain structural tripwires.

## Nothing found

- No class (c) route among the 30 audited files.
- No owned mutation in the audited set that trusts a URL resource id without an
  owner gate or an already-owned parent.
- No audited chat child operation that can reach a child through a foreign
  parent chat.
- No successor-world route in the audited set that accepts a branch or world as
  an independent ownership anchor; ownership continues to originate at the
  chat row.
