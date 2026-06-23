# Auth & entity visibility — plan

Status: **shipped — 2026-06-23** — Better Auth + the entity-visibility seam are
live. Reference doc: [../auth.md](../../auth.md). Topic slug `auth`.

> **Completion note (2026-06-23).** Migration `0011_superb_greymalkin.sql`:
> `auth_sessions`/`accounts`/`verifications` tables, `users` extended
> (`email_verified`/`image`/`updated_at` + admin `banned`/`ban_reason`/`ban_expires`),
> `visibility` + `cloned_from_id` on characters/locations/items. `server/auth` now
> holds `auth.ts` (the Better Auth instance — email+password live; OAuth +
> magic-link env-gated; `admin()` + `nextCookies()`), `session.ts`
> (`getCurrentUser` → `Unauthenticated` → **401**; no auto-mint), and `dev.ts`
> (impersonation via the shared dev credential). Routes: `app/api/auth/[...all]`
> (`toNextJsHandler`), `/api/auth-config`, `/api/dev/impersonate` (replaces
> `switch-user`), trimmed `/api/dev/me`, `/:kind/:id/clone`. Authorization seam in
> `server/api/visibility.ts` (`findViewable`, `isPublicEntityImage`) + `clone.ts`
> (`cloneToLibrary`) + `images cloneEntityImages` (cross-owner file duplication).
> UI: `/sign-in` + header `AccountMenu` + per-editor `PublishToggle`. Seed
> provisions the Player + uxtest admin dev credentials. `pnpm verify` green (1351
> pure tests); visibility-matrix + clone-survives-source-delete int tests added.
> **Deviations:** (1) dev impersonation uses `signInEmail` with a seeded shared
> credential (fully typed, robust) rather than the admin plugin's `impersonateUser`
> (which needs a pre-existing admin caller) — works for any dev-credentialed user.
> (2) clone **always duplicates** images (self-contained), including same-owner
> clones, rather than the plan's same-owner "share" — strictly safer, negligible
> cost. (3) magic-link has no email transport yet (dev logs the link), per plan.
> **Leftovers (deferred → Slice 8 / "Later"):** the public **browse/discovery
> gallery**, the "add public entity to a world" UI, and the clone **UI entry
> point** all wait on the gallery (no in-product way to discover a public entity
> yet); the clone API primitive + image policy are done and tested.

---

## Original plan (below)

Status was: **next** — queued, design settled in the 2026-06-23 Q&A + design
discussion; promoted to **active** once
[world-instances.plan.md](world-instances.plan.md) was sequenced (this plan's
sharing model depends on the copy cascade). Topic slug `auth`.

This is the supplemental plan called for by
[security-hardening.plan.md](../security-hardening.plan.md) §"Auth migration". It
**implements** that section and **subsumes** Cluster A (the dev-auth boundary
fixes) — Cluster A's one-line `/api/dev/*` gate (A1) is still worth shipping
immediately as an interim stopgap, but this plan is the real fix and deletes the
dev-cookie model entirely.

Two things ship together because they share the same authorization seam:

1. **Real user accounts** — replace the dev-cookie identity (`vesper_user` = raw
   userId, absent ⇒ auto-minted admin) with [Better Auth](https://better-auth.com):
   signed sessions, sign-up/sign-in, and a hard **401 on unresolved identity**.
2. **Entity visibility** — a `private` / `public` layer on shareable entities
   (characters/locations/items; worlds & sessions are always private). Private ⇒
   owner-only. Public ⇒ **discoverable and copyable** by anyone. Because of the
   [world-instances](world-instances.plan.md) copy cascade, **using** a public
   entity *copies* it into your own world/library — there are no live cross-owner
   references, so the author can't break your copy and you own/edit it freely.

The ownership substrate already exists and the 2026-06-23 scan rated it
IDOR-clean: every entity carries `ownerId` and every query is owner-scoped
(`docs/architecture.md` boundary rules). The copy cascade **preserves** that —
reads widen to owner-or-public **only** on the browse/preview/copy path; every
stored reference stays owner-scoped, and **all writes stay owner-strict**.

---

## Decisions locked (2026-06-23)

| Question | Decision |
| --- | --- |
| Auth library | **Better Auth** — MIT, fully self-hosted, owns its tables in our Postgres via the Drizzle adapter. |
| Sign-in methods (v1) | **All three**: email + password (baseline), magic link (passwordless), social OAuth — the latter two **env-gated** (enabled only when their secrets are present; degrade quietly otherwise, per `docs/resilience.md`). |
| Public-entity model | **Copy-on-use** (via [world-instances](world-instances.plan.md)). A public entity is discoverable and copyable; **using** it (add to a world, or clone to your library) makes an **owned copy** — no live cross-owner reference. You can edit your copy freely; the source author can't push changes or break it. |
| Always-private | **Worlds and sessions** — no visibility column, never shareable. |
| Shareable | **Characters, locations, items** — `visibility` column, default `private`. |

> **Dependency:** the copy-on-use model is delivered by
> [world-instances.plan.md](world-instances.plan.md). That refactor (worlds hold
> instance copies, not live FKs) is what eliminates cross-owner references. Land it
> before — or together with — this plan's visibility seam. It is the reason this
> plan has **no** "lifecycle of a referenced public entity" section: there are no
> live cross-owner references to break.

## Why Better Auth (fit for this stack)

- **Self-hosted, owns its data in our Postgres** — no external IdP, identity never
  leaves the box. Works fully offline on the single local dev box.
- **Drizzle adapter** → its tables live in our `schema.ts` and flow through the
  normal `db:generate` → review → `db:migrate` workflow (no second migration
  source — see the workflow caveat below).
- **Text ids** by default — compatible with our `newId()` text PKs, so existing
  `users` rows (the `uxtestmain…` admin, any seeded users) keep their ids and all
  `ownerId` FKs stay valid.
- **Email+password built in**; magic-link, social OAuth, and the **admin plugin**
  (which reads a `role` column — we already have one) are config/plugins.
- **Signed, httpOnly, `secure` cookie sessions** — directly satisfies the
  security-hardening §Auth-migration requirements.
- **Expansion lanes are plugins, not rewrites** — organizations/teams, 2FA,
  passkeys, API keys, more OAuth providers. This is what makes the thin v1
  genuinely expandable.

## Scope — thin v1 vs. later

**v1 (this plan):**
- Better Auth wired: email+password live; magic-link + OAuth wired but env-gated.
- `getCurrentUser()` resolves a real session or **throws → 401**. No auto-mint, no
  default admin.
- `visibility` column on characters/locations/items (default `private`).
- Authorization seam: **write** = owner-only (unchanged); **browse/preview/copy
  read** = owner-or-public; **using** a public entity = copy it (owned) via the
  world-instances cascade; **clone** endpoint (public source → your library).
- Public-entity images viewable cross-owner on the preview/copy path.
- Dev ergonomics preserved: dev-gated **impersonation** endpoint replaces
  `switch-user`; seed creates the `uxtestmain…` admin with a known dev credential.

**Later (expansion, not now — parked unless promoted):**
- Public **browse/discovery** gallery (the read rule already supports it; only the
  list query + UI are missing).
- User profiles / usernames / public author pages.
- An `unlisted` (link-only) visibility tier, or a per-entity collaborator ACL.
- Selective update **propagation** to copies (deferred — speced in
  [world-instances.plan.md](world-instances.plan.md) §Future).
- Organizations/teams, 2FA, passkeys (Better Auth plugins).
- Favorites / ratings / "remix count" on public content.

---

## Data-model changes (`src/server/db/schema.ts`)

Follow the DB workflow in `CLAUDE.md`. **Do not** run Better Auth's own CLI
`migrate` — it bypasses drizzle-kit and would fork our single migration source of
truth. (Better Auth's CLI `generate` is fine as a *crib* for the exact column
list; the tables are authored by hand in `schema.ts` like everything else.)

### 1. Better Auth tables + `users` extension

Better Auth's core models are `user`, `session`, `account`, `verification`. Two
name collisions to design around:

- **`session` collides with our existing game-`sessions` table.** Map Better
  Auth's `session` model to a distinctly named table — `authSessions`
  (`auth_sessions`). Likewise `accounts`, `verifications`. The adapter's `schema`
  option does the model→table indirection:
  ```ts
  drizzleAdapter(db(), {
    provider: "pg",
    schema: { user: users, session: authSessions, account: accounts, verification: verifications },
  })
  ```
- **Extend our `users` table** — add `emailVerified boolean notNull default false`,
  `image text` (nullable), `updatedAt`. Keep `id` (text), `email`, `name`, `role`
  (enum `user|admin` — the admin plugin reads it), `createdAt`. Sign-up must supply
  `name` (default to the email local-part when omitted).

`authSessions`/`accounts`/`verifications` follow Better Auth's documented column set
(id text PK, `userId` FK `references(() => users.id, { onDelete: "cascade" })`,
token/expiry/provider columns, timestamps). Group them under `schema.ts`'s
`Identity & library` header as infrastructure.

### 2. `visibility` column on shareable entities

Add to `characters`, `locations`, `items`:

```ts
visibility: text("visibility", { enum: ["private", "public"] }).notNull().default("private"),
```

- **Default `private`** — publishing is an explicit opt-in (every existing row
  stays private; a safe no-op for current behavior).
- **Not** on `worlds` / `sessions` (always private — enforced by the column's absence).
- **Naming caution — three unrelated "visibility/access" concepts coexist;
  document each at its definition:**
  - `<entity>.visibility` (this column) = **cross-account share scope**.
  - `lore_chunks.visibility` (`public|secret`) = **in-world lore secrecy**.
  - `world_links.access` / `session_links.access` = **in-world traversal gating**.
- **Forward-compatible headroom**: positioned to gain an `unlisted` (link-only)
  tier later without a rename or data migration — v1 doesn't emit it.
- **Index:** by-id reads use the PK; add a `(visibility)` (or `(visibility,
  updated_at)`) index **when the public-browse query lands**, not before.

### 3. Clone provenance

The world-instances refactor already adds `source*Id` provenance to world/session
copies. For **library→library** clones (clone a public entity into *your* library),
add `clonedFromId text` (nullable, **soft** ref) to characters/locations/items —
records "this is a copy of X" for future remix-attribution. Include in v1.

---

## Auth module rewrite (`src/server/auth/`)

`server/auth` is "the entire auth-migration surface." Consumer audit confirms it:
only `withUser` (`server/api/respond.ts`), the two `/api/dev/*` routes, and the seed
script call into it. Keep the `CurrentUser` shape stable so nothing downstream
changes except the unauth behavior.

- **`auth.ts`** — the Better Auth instance:
  ```ts
  export const auth = betterAuth({
    database: drizzleAdapter(db(), { provider: "pg", schema: { user: users, session: authSessions, account: accounts, verification: verifications } }),
    emailAndPassword: { enabled: true },
    socialProviders: { /* google/github/discord — each spread in only when its env creds exist */ },
    plugins: [ magicLink({ sendMagicLink: /* email transport; dev: log link */ }), admin(), nextCookies() /* must be last */ ],
  });
  ```
  Secret = `BETTER_AUTH_SECRET`, base URL = `BETTER_AUTH_URL`. Build
  `socialProviders` and the magic-link sender conditionally so a missing provider
  secret means "that method is off," never a boot crash.
- **Route handler** — `src/app/api/auth/[...all]/route.ts` → `toNextJsHandler(auth)`.
- **`getCurrentUser()` rewrite** — resolve via `auth.api.getSession({ headers:
  await headers() })`; map a valid session to `CurrentUser`. **No session ⇒ throw
  an `Unauthenticated` sentinel.** Delete `ensureDefaultUser` and the default-admin
  behavior.
- **`withUser` 401 flip** (`respond.ts`) — catch `Unauthenticated` → `jsonError(
  "unauthenticated", …, 401)`. Keep the existing `auth_unavailable` **500** for
  genuine resolution failures (DB down); tests assert both. Unresolved identity is
  now a 401, never a fabricated user.
- **Dev impersonation** — the documented dev/QA flow (CLAUDE.md: `POST
  /api/dev/switch-user`, raw `Cookie: vesper_user=<id>`) no longer works (the cookie
  is now a *signed session token*). Replace `switch-user` with a **dev-only**
  (`NODE_ENV !== "production"` ⇒ 404, per Cluster A1) endpoint that mints a real
  session for the target user via the admin plugin's **`impersonateUser`**.
  `/api/dev/me` stays dev-gated and returns the current user (drop the
  `listUsers()` dump — Cluster A3). **CLAUDE.md's dev-auth paragraph must be
  rewritten when this ships** (see Docs to update).
- **Client identity** — `use-is-admin.ts` currently reads `/api/dev/me`. Point it at
  Better Auth's session so admin-gated affordances work under real auth and outside
  dev.

---

## Authorization rules (the heart of this plan)

One small module — `server/api/visibility.ts` (or folded into `library.ts`) — owns
these helpers so the rule lives in exactly one place.

| Operation | Rule |
| --- | --- |
| **Write** (PATCH / DELETE / mutating image-gen) | `ownerId = me` **only** — unchanged `findOwned` pattern |
| **List "my library"** (today's default) | `ownerId = me` (any visibility) |
| **Browse / preview** a public entity (read for copy) | `ownerId = me` **OR** `visibility = 'public'` → `findViewable(kind, id, me)` |
| **Use** a public entity in a world | read it (owner-or-public) then **copy** it into your world instance (world-instances cascade) — the stored row is owned by you |
| **Clone** to your library | read public source, **deep-copy** into a new owned row (`visibility='private'`, `clonedFromId=src`) |
| **List "browse public"** (deferred slice) | `visibility = 'public'` |

- **Write stays owner-strict — non-negotiable.** Editing/deleting a public entity
  you don't own returns 404 (treat as not-found, don't confirm existence). The only
  way to a writable copy is to **copy/clone** it (then it's yours).
- **No live cross-owner references.** "Using" a public entity always produces an
  owned copy via the [world-instances](world-instances.plan.md) cascade, so there's
  no widened reference-validation path and no cross-owner FK. (This replaces the
  earlier draft's `prefetchRefs` widening and lifecycle handling.)
- **Clone (library→library):** deep-copy the source row → new owned row
  (`visibility='private'`, `clonedFromId=src.id`, copy profile/definition/tags).
  **Images** are handled by the world-instances image policy: cross-owner copies
  duplicate the file into your ownership (self-contained); same-owner share with
  ref-aware cleanup via `image_sweep`.
- **Public-entity images** (`images/[id]/file`): on the preview/copy path, widen the
  read to "image owner is me **OR** the image's entity is public." Pairs with
  security Cluster I3: keep `Cache-Control: private` for owner-only images; public
  previews may use a cacheable policy.
- **Reference echo** (security Cluster I5): keep "unknown reference" responses from
  echoing attacker-supplied ids verbatim.

---

## Env & config (`.env.example`, `docs/getting-started.md`)

- `BETTER_AUTH_SECRET` (required), `BETTER_AUTH_URL` (e.g. `http://localhost:3200`).
- Social OAuth (each pair optional; absent ⇒ that provider off):
  `GOOGLE_CLIENT_ID/SECRET`, `GITHUB_CLIENT_ID/SECRET`, `DISCORD_CLIENT_ID/SECRET`.
- Email transport for magic-link (e.g. `RESEND_API_KEY` or SMTP). **Dev fallback:
  log the magic link to the console** when no transport is configured.

## Rollout (ordered slices — no `phase-N` filenames)

> **Depends on [world-instances.plan.md](world-instances.plan.md)** for the copy
> cascade. Slices 6–7 assume worlds already hold instance copies.

1. **Schema + migration** — Better Auth tables, `users` extension, `visibility` +
   `clonedFromId` columns. `db:generate` → review → `db:migrate`.
2. **Better Auth instance + route handler + env** — `auth.ts`,
   `app/api/auth/[...all]`, env wiring (email+pw live; OAuth/magic-link env-gated).
3. **`getCurrentUser` rewrite + `withUser` 401 flip** — delete auto-mint; map
   session → `CurrentUser`. Update `respond.test.ts` (401 on no-session, 500 on
   resolution failure).
4. **Dev ergonomics** — dev-gated impersonation endpoint (replaces `switch-user`),
   `/api/dev/me` trimmed, seed creates `uxtestmain…` admin with a dev credential.
5. **Auth UI** — minimal sign-in / sign-up / sign-out (email+pw + enabled OAuth
   buttons + magic-link request). Thin; expandable.
6. **Visibility seam** — `findViewable`, the publish/un-publish toggle on the entity
   editors, public-image read on the preview path.
7. **Copy/clone surface** — "add public entity to world" (uses the world-instances
   copy op) + "clone to my library" (library→library), incl. the image policy.
8. *(deferred slice)* **Public browse gallery** — `searchLibraryIds` public mode + a
   discovery surface.

## What this closes in security-hardening

- §Auth migration — **done** (401 on unresolved, signed sessions, drop
  cookie-as-identity, delete `switch-user`, `secure`+`sameSite` cookies).
- Cluster **A1–A4** — subsumed (dev routes gated + impersonation; no auto-mint
  admin; no default identity at all).
- Cluster **E3** (origin/CSRF) — revisit here with real auth.
- Cluster **I5** (don't echo attacker ids) — folded into the copy/reference path.

## Testing (`docs/testing.md`, `docs/resilience.md`)

- **No-session ⇒ 401**, valid-session ⇒ resolved user, DB-failure ⇒ 500
  (`withUser`). Distinct codes asserted.
- **Visibility matrix** (the asymmetry — highest-value tests): non-owner GET/preview
  of a public entity ⇒ 200; of a private entity ⇒ 404. Non-owner PATCH/DELETE of a
  *public* entity ⇒ 404 (write never crosses owner). Owner sees own entities at any
  visibility.
- **Copy/clone**: using/cloning a public entity produces an owned, private copy with
  copied (cross-owner) or shared (same-owner) images and provenance set; the source
  is unchanged; **deleting the source afterward leaves the copy intact** (the
  world-instances guarantee).
- **Dev gate**: `/api/dev/*` 404 when `NODE_ENV=production`.
- Integration suites (`pnpm test:int`) cover the cross-owner copy paths.

## Docs to update (same change)

- **`CLAUDE.md`** — rewrite the dev-auth paragraph: the `vesper_user` cookie /
  `switch-user` / raw-`Cookie` flow is replaced by the dev-gated impersonation
  endpoint + seeded `uxtestmain…` credential. (High-impact for agent UI/Playwright
  testing.)
- **`docs/streaming-api.md` §Auth** — replace the dev-cookie description with the
  Better Auth model (signed sessions, 401, visibility rules).
- **`docs/architecture.md`** — `server/auth` now wraps Better Auth; the
  owner-or-public read widening is confined to the browse/copy path.
- **New `docs/auth.md`** (reference doc) + a row in `docs/README.md` — once the
  surface settles. Keep under ~400 lines or split per the docs rules.
- **`security-hardening.plan.md`** — mark §Auth migration + Cluster A as
  "implemented by `auth.plan.md`".

## Open questions

- **Magic-link email transport** — which sender for dev/prod (Resend vs. SMTP)? Dev
  defaults to console-logging the link.
- **OAuth providers for v1** — Google + GitHub + Discord, or start with Discord only
  (best audience fit)? Each is just an env-gated entry.
- **Browse gallery** — in v1 or deferred? The read rule supports it; only the list
  query + UI are missing. → Rollout Slice 8.
- *(Resolved)* delete/un-publish lifecycle of referenced public entities — no longer
  an issue under the [world-instances](world-instances.plan.md) copy cascade.
