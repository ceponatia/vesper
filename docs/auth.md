# Auth & entity visibility

Vesper uses [Better Auth](https://better-auth.com) — self-hosted, MIT-licensed,
owning its tables in our own Postgres. Identity never leaves the box; it works
fully offline on the local dev machine. The whole surface lives in
`src/server/auth/` and the `/api/auth/*` route. Two things ship together because
they share one authorization seam: **real accounts** and **entity visibility**
(a `private`/`public` share scope on shareable entities).

See also: [streaming-api.md §Auth](streaming-api.md) (HTTP surface),
[architecture.md](architecture.md) (module boundaries), [database.md](database.md)
(the auth tables), [getting-started.md](getting-started.md) (env).

## The module (`src/server/auth/`)

| File | Role |
| --- | --- |
| `auth.ts` | The `betterAuth(...)` instance — Drizzle adapter, email+password, env-gated OAuth + magic-link, explicit session lifetime, `admin()` + `nextCookies()` plugins. **No `next/headers`** so scripts (the seed) can import it. |
| `magic-link.ts` | Magic-link delivery policy: the transport registry (empty in v1), whether the plugin registers at all, and what a delivery attempt is allowed to log. |
| `session.ts` | `getCurrentUser()` → `CurrentUser`, and the `Unauthenticated` sentinel. Lazily imports `next/headers`. |
| `dev.ts` | Dev-only session minting: `devImpersonate`, `ensureDevCredential`, `DEV_PASSWORD`. |
| `index.ts` | Barrel — the only thing the rest of the app imports. |

The route `src/app/api/auth/[...all]/route.ts` is just `toNextJsHandler(auth)`:
Better Auth owns sign-in/up/out, OAuth callbacks, magic-link, `get-session`, and
the admin endpoints. Our own handlers never write auth state — they only **read**
the session.

### Sign-up control (`ALLOW_SIGNUP`)

Self-service sign-up is **disabled by default** — only seeded/approved accounts
can sign in. `auth.ts` gates Better Auth's `disableSignUp` (email/password **and**
magic-link) on `process.env.ALLOW_SIGNUP !== "true"`. To register a new account:
set `ALLOW_SIGNUP=true` (local `.env`, or `fly secrets set ALLOW_SIGNUP=true -a
vesper`, then redeploy/restart), sign up, then set it back to `false`. OAuth
providers can also create accounts, but are only active when their
client-id/secret env vars are set (none in the Fly deployment), so they're inert.

### Before `ALLOW_SIGNUP=true`

Today's posture is safe **because** sign-up is off and the app runs a single
instance: the only accounts are seeded/approved ones. Opening self-service sign-up
changes who can reach these surfaces, so this list is the gate — every item is
done before `ALLOW_SIGNUP` flips to `true` for anything but a brief, supervised
window ([security-authz.plan.md](developer-notes/security-authz.plan.md)
slice 7 / finding S6).

| # | Requirement | Status |
| --- | --- | --- |
| 1 | **Required email verification** — `emailAndPassword.requireEmailVerification` + a real transport, so an address can't be claimed without proving control of it | **pending** (needs the same transport as magic link — plan OQ3) |
| 2 | **Password policy** — minimum length/strength beyond Better Auth's default, and rejection of known-breached passwords | **pending** |
| 3 | **Shared (cross-instance) rate limiting** on sign-in, password reset, and magic-link requests | **deferred** — `src/server/api/rate-limit.ts` is deliberately process-local; the 2026-06-23 ruling ([finished/security-hardening.plan.md](developer-notes/finished/security-hardening.plan.md)) keeps it that way until Vesper runs more than one instance. Re-open with the second instance, not with sign-up. |
| 4 | **Admin MFA / WebAuthn** — a second factor on `role: "admin"` accounts (Better Auth `twoFactor` / `passkey` plugin) | **pending** |
| 5 | **Revoke all sessions on credential change** — password reset/change invalidates every other `auth_sessions` row | **pending** |
| 6 | **Explicit idle/absolute session lifetimes** | **done (2026-07-26)** — `auth.ts` sets `session.expiresIn` (7 days) and `session.updateAge` (1 day) rather than inheriting them; see below |
| 7 | **Security events logged without tokens** | **done (2026-07-26)** for magic link (`auth.magic_link` never carries a url/token in production — see [Magic link](#magic-link-dev-only-until-a-transport-exists)); any new auth event re-checks the same rule |

### Session lifetime

`auth.ts` states the lifetime instead of inheriting it: `expiresIn` 7 days (the
absolute life of a session row/cookie) and `updateAge` 1 day (how often an active
session is refreshed toward a new 7-day window). The values match Better Auth's
defaults — the point is that shortening them is a visible, deliberate one-line
decision rather than a framework default nobody chose.

### Tables (`server/db/schema.ts`, “Identity & library”)

Better Auth's `session`/`account`/`verification` models map to distinctly-named
tables to avoid the collision with the game `sessions` table — the adapter's
`schema` option does the model→table indirection:

```ts
drizzleAdapter(db(), { provider: "pg", schema: {
  user: users, session: authSessions, account: accounts, verification: verifications,
} })
```

The adapter maps fields by Drizzle **property key**, so the schema's keys match
Better Auth's field names (`emailVerified`, `userId`, `expiresAt`, …) exactly;
SQL column names stay snake_case. `users` gained `emailVerified`, `image`,
`updatedAt`, and the admin plugin's `banned`/`banReason`/`banExpires`; existing
text PKs and every `ownerId` FK are untouched, so seeded users keep their ids.

## Identity resolution

`getCurrentUser()` resolves the signed session via `auth.api.getSession(...)`:

- **valid session** → a `CurrentUser` (`id`, `email`, `name`, `role`).
- **no session** → throws `Unauthenticated` → `withUser` returns **401
  `unauthenticated`**. There is **no auto-minted default user** — unauthenticated
  requests are rejected, never fabricated.
- **resolution failure** (DB down) → propagates → **500 `auth_unavailable`**.

The two failure codes are distinct so clients can redirect-to-sign-in vs. retry
([resilience.md](resilience.md)).

## Who the player is (`users.default_persona_id` → `personas`)

The player is a **library entity** — a `personas` row with a body, a wardrobe and a
bio ([database.md](database.md), `persona-library.plan.md`). `users.default_persona_id`
is a soft pointer (no FK) naming which one new chats start as; `PATCH /api/users/me`
and the `/settings` page set it, and the persona editor authors the persona itself.

> The old `users.playerPersona` JSONB blob (a light name + bio, one per account —
> `finished/player-character.plan.md`) is **gone**: migration 0052 backfilled every
> non-empty blob into a real persona row and set `default_persona_id`; 0053 dropped
> the column. `StoredPlayerPersona` was deleted with it.

Every consumer reads through **one resolver**, `resolveChatPersona({ownerId, chatId})`
(`src/server/players/`). It is a three-rung ladder, each rung degrading
rather than throwing, so a chat turn always has someone to address
([resilience.md](resilience.md)):

1. the **chat's** own pick (`character_chats.player_state.personaId`);
2. the owner's **default** persona (`users.default_persona_id`);
3. the **account name** (then `FALLBACK_PLAYER_NAME`).

Every lookup is owner-strict, so a dangling or foreign id simply misses and falls
through — which is also why deleting a persona needs no write fan-out across chats.
`chatId` is optional: omit it for an account-level read (rungs 2–3 only), though every
caller in the codebase has a conversation in scope and passes it.

**The resolved `PlayerPersona` shape carries no `title`, and that is load-bearing.**
The persona's per-owner-unique library label is a database/UX concern that must never
reach a model; since every prompt consumer reads this one type, its absence there —
not a rule anyone has to remember — is what enforces that. The character-chat prompt
threads the rest in as the addressee (`src/server/engine/prompts/character-chat.ts`):
name, bio, what they're wearing, how their voice sounds, and what they respond to once
things turn intimate.

## Sign-in methods

| Method | v1 status |
| --- | --- |
| Email + password | Always on. |
| Magic link | **Dev-only in v1** — no email transport is implemented, so the plugin registers in dev (and logs the link) but is **absent in production**, regardless of env. See [Magic link](#magic-link-dev-only-until-a-transport-exists) below. |
| Social OAuth (Google/GitHub/Discord) | Env-gated: a provider is enabled only when **both** its `_CLIENT_ID` and `_CLIENT_SECRET` exist; absent ⇒ off (never a boot crash). |

`GET /api/auth-config` reports the enabled methods so the sign-in UI
(`/sign-in`, `src/components/auth/`) renders only buttons that work — including
`magicLink`, which follows the plugin gate below. The header `AccountMenu` shows
the user + sign-out, or a sign-in link.

### Magic link (dev-only until a transport exists)

A magic link **is a temporary password**, so it must never reach log retention
([security-authz.plan.md](developer-notes/security-authz.plan.md) slice 1).
`src/server/auth/magic-link.ts` owns the whole
policy:

- **One fact gates everything: a resolved transport object**, never the presence
  of an env var. `configuredMagicLinkTransport(): MagicLinkTransport | null` walks
  a registry of transport factories (each reads its own env, returns `null` when
  unconfigured). That registry is **empty in v1** — no sender is implemented — so
  production magic-link is off unconditionally. An env name proves a value was
  set, not that anything can send mail; gating on presence would enable the plugin
  and the config flag while delivering nothing.
- **Registration.** `magicLinkPluginEnabled()` — always in dev; in production only
  when a transport resolves. With none the plugin is simply **absent** from the
  production `plugins` array, exactly as an OAuth provider without creds is absent
  — the `/api/auth/sign-in/magic-link` endpoint doesn't exist there, and
  `/api/auth-config` reports `magicLink: false` (same function) so the button isn't
  rendered.
- **Delivery.** `sendMagicLink` awaits `transport.send(email, url)` when one
  resolves. A rejected send emits an `error` event and **rethrows** so Better Auth
  sees the failure — an undelivered link is never reported as sent
  ([resilience.md](resilience.md)).
- **Logging.** `sendMagicLink` emits one `auth.magic_link` event built by
  `magicLinkEvent()` / `magicLinkFailureEvent()`: in **dev** `info` with
  `{ email, url }` (the link is how a local sign-in completes — grep the server
  console for it); in **production** `{ email }` only — never the url, token, or
  callback query string — as `info` when the transport delivered it, `warn` on the
  (now unreachable) no-transport branch, and `error` with `{ email, error }` on a
  failed send, where `error` is the exception's **class name** only: a transport's
  message routinely quotes the request it failed on, which contains the link.
- **Adding a transport.** Implement the sender, add its factory to the registry in
  `magic-link.ts` (one entry: read its var, return the transport or `null`),
  document the var in `.env.example` — and production magic-link turns itself on.
  `RESEND_API_KEY` / `SMTP_URL` are **reserved names for that future sender and are
  inert today**. Unit coverage: `magic-link.test.ts` (asserts the production payload
  key sets and that the gate stays off with both vars set).

### Trusted origins (LAN dev)

Better Auth rejects any sign-in whose `Origin` isn't `baseURL` or a listed
trusted origin — "**Invalid origin**". `BETTER_AUTH_URL` is trusted implicitly;
`BETTER_AUTH_TRUSTED_ORIGINS` (comma-separated, parsed in `auth.ts` →
`trustedOrigins`) adds more. To sign in from a **phone on the same Wi-Fi**, add
the dev machine's `http://<lan-ip>:3200` (alongside `http://localhost:3200`).
Magic-link/OAuth absolute URLs are built from `baseURL`, so for those to work on
the phone too, point `BETTER_AUTH_URL` at the LAN IP. DHCP can reassign the IP —
pin it with a router reservation or update `.env`.

## The authorization seam (`server/api/visibility.ts`)

One module owns the asymmetry — **reads widen, writes stay strict**:

| Operation | Rule |
| --- | --- |
| **Write** (PATCH / DELETE / mutating image-gen) | `ownerId = me` **only** — a non-owner write returns 404, never confirming the row exists. |
| **List "my library"** | `ownerId = me` (any visibility). |
| **Browse / preview** (read for copy) | `findViewable(kind, id, me)` = owner **OR** `visibility = 'public'`; a **foreign** viewer receives the allow-listed public representation, not the row (below). |
| **Clone** to your library | read public source, deep-copy into a new owned row (`visibility='private'`, `clonedFromId=src`). |

- **Shareable** entities (`characters`, `locations`, `items`, `social_cards`)
  carry a `visibility` column (`private` default | `public`). **Personas and
  chats are always private** — they have no such column.
- The `GET /:kind/:id` routes use `findViewable`, then scope sub-resources
  (portraits) to the **entity owner** so a public preview shows the
  author's art — not the viewer's.
- **The discovery scope is typed to that split.** `searchLibraryIds`
  (`server/api/library.ts`) is overloaded: any `LibraryKind` may be searched at
  `owned`, but `public`/`all` are accepted only for a `ShareableKind`, so a
  visibility-less kind can't reach the `visibility = 'public'` predicate from a
  statically-known call site. `resolveLibraryScope` is the runtime backstop for
  dynamic kinds — an unsupported pair returns **no ids** plus an
  `api.library.scope_unsupported` warn diagnostic instead of emitting SQL
  against a column the table doesn't have (security-authz.plan.md §Follow-ups
  item 3; matrix in `library.test.ts`).

#### "Public" is a representation, not the row

A foreign viewer never receives the persisted row. `server/api/visibility.ts`
owns one **allow-list projection per kind** — `toPublicCharacter`,
`toPublicLocation`, `toPublicItem`, `toPublicSocialCard` — and the four detail
routes split on `mine` (`row.ownerId === user.id`): the owner keeps the full row
because the edit surfaces need every column; everyone else gets the projection
(security-authz.plan.md slice 4).

- **Always excluded**: `ownerId` (the response carries the computed `mine` flag
  instead — a viewer never needs another account's id), `searchEmbedding` /
  `embedder`, `clonedFromId`, and `updatedAt`. `createdAt` is the only timestamp.
- **Included**: id, name, tags, visibility, createdAt + the kind's display fields
  — character `profile` (**projected**, below) + `avatarImageId`; location
  description/ambient/scale/area/affordances/imageId; item
  kind/description/definition/imageId; social card description/definition.
- The character **`profile` jsonb is itself projected** — `toPublicCharacterProfile`
  in [`contracts/world/profile.ts`](../src/contracts/world/profile.ts), beside the
  field definitions so adding a profile field puts the reviewer next to the
  decision (security-authz.plan.md OQ2, ruled **conservative
  private-by-default**). A public preview shows **presentation only**: `bio`,
  `personality`, `age`, `speciesId`, and an allow-listed slice of `attributes`
  (today just `identity.gender`, which the browse route already publishes as a
  facet — each surviving row reduced to `{ id, value }`, no provenance). Withheld:
  narrator guidance (`voice`, `voiceAnchors`, `microExemplars`, `intimacy`,
  `traits`, `preferences`, `socialCards`, disposition `tags`), authored secrets
  (`drives` — they carry `guarded`/`secret` levels and reveal gates), hidden
  stance (`playerRelationship` — mask, shared history, premise note), and the
  operational fields (`heritageId`, `bodyPlanId`, `intimateRegions`,
  `bodyFeatures`, `aliases`, `outfits`, `schedule`). `row.profile` is untrusted
  jsonb, so it goes through `parseOr(characterProfileSchema, …)` before the
  projection — never a cast.
- **Clone is deliberately wider than preview**: `cloneToLibrary` copies the
  *whole* authored profile. Publishing a character offers it as a full authored
  starting point; the preview is the shop window, the clone is the goods (same
  OQ2 ruling).
- Portrait rows beside a public character project to
  `{ id, kind, entityKind, entityId, createdAt }` — no `path`, no `prompt`, no
  provider internals ([images.md](images.md)).
- The default is **closed**: a column added to one of these tables is private
  until someone adds it to the projection. `public-dto.int.test.ts` asserts the
  **exact key set** per kind, so widening the public surface is always a
  deliberate, reviewed edit — and, for the character profile, the exact key set
  of the projection **and** of its nested `attributes` rows (a pure twin lives in
  `contracts/world/profile.test.ts`).
- The **list/browse** routes were already projected (summary columns only) and
  stay that way — `searchLibraryIds` returns ids, and whatever hydrates them for
  a `public`/`all` scope must select an explicit column list.
- **`<entity>.visibility` is a cross-account share scope**, distinct from any
  in-world/in-fiction secrecy concept — don't confuse a public/private *share*
  scope with a character's authored secrets or a scenario's hidden premise.
- Headroom: `visibility` can gain an `unlisted` (link-only) tier later with no
  migration. A `(visibility)` index lands with the public-browse query, not before.

### Copy-on-use, not live references

Because of the [world-instances copy cascade](developer-notes/finished/world-instances.plan.md),
**using** a public entity *copies* it — there are **no live cross-owner
references**. `cloneToLibrary` (`server/api/clone.ts`) deep-copies a viewable
source into a new owned, private row. The source author can't push changes or
break your copy: deleting the source leaves the clone intact (verified in
`library-routes.int.test.ts`).

**Images** are duplicated, not shared: `cloneEntityImages` copies each ready
image file into the new owner's storage with a fresh row (`sourceImageId`
provenance), so a clone is fully self-contained. `images/:id/file` serves
owner-only by default but widens to a **public-entity** image on the preview
path (`isPublicEntityImage`) — and only when the image and the public entity it
names **share an owner**, since the entity linkage is polymorphic metadata with
no FK (security-authz.plan.md slice 3). Cache policy follows that split —
`public` for public-entity images, `private` for owner-only (security Cluster I3).

## Dev / QA ergonomics

The signed-session cookie replaced the raw-id `vesper_user` cookie, so dev/QA
needs a real session. `POST /api/dev/impersonate { userId }` (dev-only — **404 in
production**) signs in with the shared dev credential and returns the Set-Cookie.
The seed (`pnpm db:seed`) provisions that credential (`DEV_PASSWORD`, default
`vesper-dev-password`) on the Player and the `uxtest` admin — **except in
production**, where `ensureDevCredential` refuses unless `DEV_PASSWORD` is
explicitly set (the default is committed to the repo and the credential is
reachable through the public sign-in surface). `GET /api/dev/me` (dev-only)
returns the resolved user. See [CLAUDE.md](../CLAUDE.md) for the QA flow.

## Env

`BETTER_AUTH_SECRET` (required — signs sessions; **missing in production is a
boot-time error**, since Better Auth would otherwise fall back to a forgeable
built-in dev secret), `BETTER_AUTH_URL` (app origin, OAuth callbacks + CSRF),
the optional `{GOOGLE,GITHUB,DISCORD}_CLIENT_{ID,SECRET}` pairs, the magic-link
transport names `RESEND_API_KEY` / `SMTP_URL` (**reserved and inert** — no sender
reads them in v1, and setting one enables nothing), and `DEV_PASSWORD`.
Full table in [getting-started.md](getting-started.md).

## Later (not v1)

Expansion is plugins, not rewrites: a public **browse/discovery** gallery (the
read rule already supports it — only the list query + UI are missing), user
profiles, an `unlisted` tier, selective update **propagation** to copies, and
Better Auth plugins (organizations, 2FA, passkeys, API keys, more OAuth). Tracked
in [auth.plan.md](developer-notes/finished/auth.plan.md).
