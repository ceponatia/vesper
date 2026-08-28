# Auth and entity visibility

Vesper uses [Better Auth](https://better-auth.com) — self-hosted, MIT-licensed, owning its tables
in our own Postgres. Identity never leaves the box; it works fully offline on the local dev
machine. The whole surface lives in `apps/web/src/server/auth/` and the `/api/auth/*` route.

Two things ship together because they share one authorization seam: **real accounts** and **entity
visibility**, a `private`/`public` share scope on shareable entities.

## Reading order

| Doc                                        | What it covers                                                                   |
| ------------------------------------------ | -------------------------------------------------------------------------------- |
| [sign-in.md](sign-in.md)                   | Sign-up control, the three sign-in methods, magic-link policy, trusted origins   |
| [player.md](player.md)                     | Who the player is: the persona pointer and the one resolver every consumer reads |
| [visibility.md](visibility.md)             | The read-widens/write-strict seam and the public representation per kind         |
| [sharing.md](sharing.md)                   | Copy-on-use cloning, image duplication, and the publish disclosure               |
| [simulation-authz.md](simulation-authz.md) | The successor lane's ownership anchor for durable commands                       |

See also: [../streaming-api.md](../streaming-api.md) §Auth (the HTTP surface),
[../architecture.md](../architecture.md) (module boundaries),
[../database/library.md](../database/library.md) (the auth tables), and
[../getting-started.md](../getting-started.md) (env).

## The module

| File            | Role                                                                                                                                                                                                                       |
| --------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `auth.ts`       | The `betterAuth(...)` instance — Drizzle adapter, email+password, env-gated OAuth + magic-link, explicit session lifetime, `admin()` + `nextCookies()` plugins. **No `next/headers`** so scripts (the seed) can import it. |
| `magic-link.ts` | Magic-link delivery policy: the transport registry, whether the plugin registers at all, and what a delivery attempt is allowed to log.                                                                                    |
| `session.ts`    | `getCurrentUser()` → `CurrentUser`, and the `Unauthenticated` sentinel. Lazily imports `next/headers`.                                                                                                                     |
| `dev.ts`        | Dev-only session minting: `devImpersonate`, `ensureDevCredential`, `DEV_PASSWORD`.                                                                                                                                         |
| `index.ts`      | Barrel — the only thing the rest of the app imports.                                                                                                                                                                       |

The route `apps/web/src/app/api/auth/[...all]/route.ts` is just `toNextJsHandler(auth)`: Better
Auth owns sign-in, sign-up, sign-out, OAuth callbacks, magic-link, `get-session`, and the admin
endpoints. Our own handlers never write auth state — they only **read** the session.

## Identity resolution

`getCurrentUser()` resolves the signed session via `auth.api.getSession(...)`:

- **valid session** → a `CurrentUser` (`id`, `email`, `name`, `role`);
- **no session** → throws `Unauthenticated` → `withUser` returns **401 `unauthenticated`**. There
  is **no auto-minted default user** — unauthenticated requests are rejected, never fabricated;
- **resolution failure** (DB down) → propagates → **500 `auth_unavailable`**.

The two failure codes are distinct so clients can redirect-to-sign-in versus retry
([../resilience.md](../resilience.md)).

## Session lifetime

`auth.ts` states the lifetime instead of inheriting it: `expiresIn` 7 days (the absolute life of a
session row and cookie) and `updateAge` 1 day (how often an active session is refreshed toward a
new 7-day window). The values match Better Auth's defaults — the point is that shortening them is
a visible, deliberate one-line decision rather than a framework default nobody chose.

## Tables

Better Auth's `session` / `account` / `verification` models map to distinctly-named tables to avoid
the collision with the game `sessions` table; the adapter's `schema` option does the model→table
indirection:

```ts
drizzleAdapter(db(), { provider: "pg", schema: {
  user: users, session: authSessions, account: accounts, verification: verifications,
} })
```

The adapter maps fields by Drizzle **property key**, so the schema's keys match Better Auth's field
names (`emailVerified`, `userId`, `expiresAt`, …) exactly while SQL column names stay snake_case.
`users` carries `emailVerified`, `image`, `updatedAt`, and the admin plugin's `banned` /
`banReason` / `banExpires`; text PKs and every `ownerId` FK are untouched, so seeded users keep
their ids ([../database/library.md](../database/library.md)).

## Dev and QA ergonomics

The signed-session cookie replaced the raw-id `vesper_user` cookie, so dev and QA need a real
session. `POST /api/dev/impersonate { userId }` (dev-only — **404 in production**) signs in with
the shared dev credential and returns the Set-Cookie.

The seed (`pnpm db:seed`) provisions that credential (`DEV_PASSWORD`, default
`vesper-dev-password`) on the Player and the `uxtest` admin — **except in production**, where
`ensureDevCredential` refuses unless `DEV_PASSWORD` is explicitly set, because the default is
committed to the repo and the credential is reachable through the public sign-in surface.
`GET /api/dev/me` (dev-only) returns the resolved user. The QA flow itself is in
[CLAUDE.md](../../CLAUDE.md).

## Env

Every variable is listed in [../getting-started.md](../getting-started.md) §Environment, which owns
the reference. Two auth-specific behaviors are stated here rather than there:

- **`BETTER_AUTH_SECRET` missing in production is a boot-time error**, since Better Auth would
  otherwise fall back to a forgeable built-in dev secret.
- **`next build` sees no variables at all**: the repository `.env` is dockerignored and Fly secrets
  are runtime-only. The auth instance therefore skips its production secret check during the build
  phase and substitutes an unresolvable `baseURL` placeholder, so an image build and CI's
  production-build job neither fail nor log a missing-base-URL warning. Both exemptions key off
  `NEXT_PHASE`, which `next start` leaves unset — a running server always enforces the real values.
