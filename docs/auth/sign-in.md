# Sign-up and sign-in

## Sign-up control (`ALLOW_SIGNUP`)

Self-service sign-up is **disabled by default** — only seeded or approved accounts can sign in.
`auth.ts` gates Better Auth's `disableSignUp` (email/password **and** magic-link) on
`process.env.ALLOW_SIGNUP !== "true"`.

To register a new account: set `ALLOW_SIGNUP=true` (local `.env`, or
`fly secrets set ALLOW_SIGNUP=true -a vesper` followed by a redeploy or restart), sign up, then set
it back to `false`.

OAuth providers can also create accounts, but are only active when their client id and secret env
vars are set — none are set in the Fly deployment, so they are inert.

The posture is safe **because** sign-up is off and the app runs a single instance: the only
accounts are seeded or approved ones. Opening self-service sign-up changes who can reach these
surfaces, so it is a reviewed operation rather than a flag flip.

Two hardening decisions already stand:

- **Rate limiting is deliberately process-local.** `apps/web/src/server/api/rate-limit.ts` is
  per-process while Vesper runs a single instance. A second instance is what re-opens shared
  rate limiting, not sign-up.
- **Session lifetimes are explicit, not inherited**
  ([README.md](README.md) §Session lifetime), and **security events are logged without tokens** —
  `auth.magic_link` never carries a url or token in production, and any new auth event re-checks
  the same rule.

## Sign-in methods

- **Email + password** — always on.
- **Magic link** — registered in dev and **absent in production** until a transport exists (below).
- **Social OAuth (Google / GitHub / Discord)** — env-gated: a provider is enabled only when **both**
  its `_CLIENT_ID` and `_CLIENT_SECRET` exist; absent means off, never a boot crash.

`GET /api/auth-config` reports the enabled methods so the sign-in UI (`/sign-in`,
`apps/web/src/components/auth/`) renders only buttons that work — including `magicLink`, which
follows the plugin gate below. The header `AccountMenu` shows the user and sign-out, or a sign-in
link.

## Magic link

A magic link **is a temporary password**, so it must never reach log retention.
`apps/web/src/server/auth/magic-link.ts` owns the whole policy.

- **One fact gates everything: a resolved transport object**, never the presence of an env var.
  `configuredMagicLinkTransport(): MagicLinkTransport | null` walks a registry of transport
  factories, each reading its own env and returning `null` when unconfigured. That registry is
  **empty** — no sender is implemented — so production magic-link is off unconditionally. An env
  name proves a value was set, not that anything can send mail; gating on presence would enable the
  plugin and the config flag while delivering nothing.
- **Registration.** `magicLinkPluginEnabled()` — always in dev; in production only when a transport
  resolves. With none, the plugin is simply **absent** from the production `plugins` array, exactly
  as an OAuth provider without credentials is absent: the `/api/auth/sign-in/magic-link` endpoint
  does not exist there, and `/api/auth-config` reports `magicLink: false` from the same function, so
  the button is not rendered.
- **Delivery.** `sendMagicLink` awaits `transport.send(email, url)` when one resolves. A rejected
  send emits an `error` event and **rethrows** so Better Auth sees the failure — an undelivered link
  is never reported as sent ([../resilience.md](../resilience.md)).
- **Logging.** `sendMagicLink` emits one `auth.magic_link` event built by `magicLinkEvent()` /
  `magicLinkFailureEvent()`. In **dev** that is `info` with `{ email, url }` — the link is how a
  local sign-in completes, so grep the server console for it. In **production** it is `{ email }`
  only, never the url, token, or callback query string: `info` when the transport delivered it,
  `warn` on the no-transport branch, and `error` with `{ email, error }` on a failed send, where
  `error` is the exception's **class name** only, because a transport's message routinely quotes the
  request it failed on, which contains the link.
- **Adding a transport.** Implement the sender, add its factory to the registry in `magic-link.ts`
  (one entry: read its var, return the transport or `null`), and document the var in `.env.example`
  — production magic-link then turns itself on. `RESEND_API_KEY` and `SMTP_URL` are **reserved
  names for that sender and are inert**: no code reads them, and setting one enables nothing. Unit
  coverage is `magic-link.test.ts`, which asserts the production payload key sets and that the gate
  stays off with both vars set.

## Trusted origins (LAN dev)

Better Auth rejects any sign-in whose `Origin` is neither `baseURL` nor a listed trusted origin —
"**Invalid origin**". `BETTER_AUTH_URL` is trusted implicitly; `BETTER_AUTH_TRUSTED_ORIGINS`
(comma-separated, parsed in `auth.ts` → `trustedOrigins`) adds more.

To sign in from a **phone on the same Wi-Fi**, add the dev machine's `http://<lan-ip>:3200`
alongside `http://localhost:3200`. Magic-link and OAuth absolute URLs are built from `baseURL`, so
for those to work on the phone too, point `BETTER_AUTH_URL` at the LAN IP. DHCP can reassign the IP
— pin it with a router reservation or update `.env`.
