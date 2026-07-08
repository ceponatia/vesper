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
| `auth.ts` | The `betterAuth(...)` instance — Drizzle adapter, email+password, env-gated OAuth + magic-link, `admin()` + `nextCookies()` plugins. **No `next/headers`** so scripts (the seed) can import it. |
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

## Default player character (`users.playerPersona`)

The account's **default player character** (a light name + short bio the player
is represented by in character chat — `docs/developer-notes/finished/player-character.plan.md`)
is a JSONB blob on the `users` row (`StoredPlayerPersona`, `src/contracts/players`),
edited via `PATCH /api/users/me` and the `/settings` page.

Every consumer reads it through **one resolver**, `resolvePlayerPersona(ownerId)`
(`src/server/players/`) — the user-level analog of the session's
`bundlePlayerName()` ([turn-engine.md](turn-engine.md)). It `parseOr`s the blob
and never throws: a missing/blank name falls back to the account name, so a chat
turn always has someone to address. The resolved `PlayerPersona.id` is `null`
today (an inline persona); if the persona later graduates to a real library
character, only the resolver changes — callers keep reading the same shape. The
character-chat prompt threads it in as the addressee (`src/server/engine/prompts/character-chat.ts`).

## Sign-in methods

| Method | v1 status |
| --- | --- |
| Email + password | Always on. |
| Magic link | Wired; **no email transport in v1** — the dev fallback logs the link (`auth.magic_link`). A real Resend/SMTP sender plugs into `auth.ts`'s `sendMagicLink`. |
| Social OAuth (Google/GitHub/Discord) | Env-gated: a provider is enabled only when **both** its `_CLIENT_ID` and `_CLIENT_SECRET` exist; absent ⇒ off (never a boot crash). |

`GET /api/auth-config` reports the enabled methods so the sign-in UI
(`/sign-in`, `src/components/auth/`) renders only buttons that work. The header
`AccountMenu` shows the user + sign-out, or a sign-in link.

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
| **Browse / preview** (read for copy) | `findViewable(kind, id, me)` = owner **OR** `visibility = 'public'`. |
| **Clone** to your library | read public source, deep-copy into a new owned row (`visibility='private'`, `clonedFromId=src`). |

- **Shareable** entities (`characters`, `locations`, `items`, `social_cards`)
  carry a `visibility` column (`private` default | `public`). **Worlds and
  sessions are always private** — they have no such column.
- The `GET /:kind/:id` routes use `findViewable`, then scope sub-resources
  (portraits, links) to the **entity owner** so a public preview shows the
  author's art/map — not the viewer's.
- **Three unrelated "visibility/access" concepts coexist** — don't confuse them:
  `<entity>.visibility` = cross-account **share scope** (this doc);
  `lore_chunks.visibility` (`public`/`secret`) = in-world lore secrecy;
  `world_links.access`/`session_links.access` = in-world traversal gating.
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
path (`isPublicEntityImage`); cache policy follows that split — `public` for
public-entity images, `private` for owner-only (security Cluster I3).

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
the optional `{GOOGLE,GITHUB,DISCORD}_CLIENT_{ID,SECRET}` pairs, and
`DEV_PASSWORD`. Full table in [getting-started.md](getting-started.md).

## Later (not v1)

Expansion is plugins, not rewrites: a public **browse/discovery** gallery (the
read rule already supports it — only the list query + UI are missing), the
"add public entity to a world" surface that pairs with it, user profiles,
an `unlisted` tier, selective update **propagation** to copies (deferred — see
the world-instances plan), and Better Auth plugins (organizations, 2FA, passkeys,
API keys, more OAuth). Tracked in [auth.plan.md](developer-notes/finished/auth.plan.md).
