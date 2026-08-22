import { betterAuth, type BetterAuthOptions } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { admin, magicLink } from "better-auth/plugins";
import { nextCookies } from "better-auth/next-js";
import { accounts, authSessions, db, users, verifications } from "../db";
import { magicLinkPluginEnabled, sendMagicLink } from "./magic-link";

/**
 * The Better Auth instance (auth.plan.md). Self-hosted, owns its tables in our
 * Postgres via the Drizzle adapter — `session` maps to `auth_sessions` to avoid
 * the collision with the game `sessions` table. Email+password is always on;
 * social OAuth is **env-gated** and magic-link is **transport-gated** (both
 * degrade quietly when their delivery isn't configured, per docs/resilience.md)
 * so a missing provider never crashes
 * boot — a method whose delivery isn't configured is absent, never half-working
 * (magic-link's gate and logging policy live in `magic-link.ts`, whose comments
 * explain why production must not log a link). This module is free of
 * `next/headers` so scripts (the seed) can
 * import it; request-bound resolution lives in `session.ts`.
 */

/** Each OAuth provider is spread in only when *both* of its env creds exist. */
function configuredSocialProviders(): BetterAuthOptions["socialProviders"] {
  const providers: NonNullable<BetterAuthOptions["socialProviders"]> = {};
  const { GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET } = process.env;
  if (GOOGLE_CLIENT_ID && GOOGLE_CLIENT_SECRET) {
    providers.google = { clientId: GOOGLE_CLIENT_ID, clientSecret: GOOGLE_CLIENT_SECRET };
  }
  const { GITHUB_CLIENT_ID, GITHUB_CLIENT_SECRET } = process.env;
  if (GITHUB_CLIENT_ID && GITHUB_CLIENT_SECRET) {
    providers.github = { clientId: GITHUB_CLIENT_ID, clientSecret: GITHUB_CLIENT_SECRET };
  }
  const { DISCORD_CLIENT_ID, DISCORD_CLIENT_SECRET } = process.env;
  if (DISCORD_CLIENT_ID && DISCORD_CLIENT_SECRET) {
    providers.discord = { clientId: DISCORD_CLIENT_ID, clientSecret: DISCORD_CLIENT_SECRET };
  }
  return providers;
}

/** Provider ids with both creds present — surfaced to the sign-in UI via /api/auth-config. */
export function enabledSocialProviders(): string[] {
  return Object.keys(configuredSocialProviders() ?? {});
}

/**
 * Origins Better Auth accepts sign-in requests from beyond `baseURL`
 * (comma-separated `BETTER_AUTH_TRUSTED_ORIGINS`). Needed for **LAN dev**: a
 * phone hitting `http://<lan-ip>:3200` sends that origin, and Better Auth rejects
 * any request whose Origin isn't trusted with "Invalid origin". List the dev
 * machine's `http://<lan-ip>:3200` (and keep `http://localhost:3200`) here. Empty
 * ⇒ only `baseURL` is trusted (the single-host default).
 */
function configuredTrustedOrigins(): string[] {
  return (process.env.BETTER_AUTH_TRUSTED_ORIGINS ?? "")
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean);
}

// Self-service sign-up is OFF by default — only seeded/approved accounts exist.
// Flip it on by setting ALLOW_SIGNUP=true (local .env, or `fly secrets set
// ALLOW_SIGNUP=true`), let the person register, then set it back to false.
// Gates email/password and magic-link sign-up; OAuth providers are only active
// when their client-id/secret env vars are set (none in this deployment).
const signupDisabled = process.env.ALLOW_SIGNUP !== "true";

/**
 * True while `next build` collects page data. The build runs with
 * NODE_ENV=production inside `docker build`, where the repository `.env` is
 * dockerignored and Fly secrets do not exist (they are runtime-only) — so every
 * auth env var is absent there, and so is it in CI's production-build job. The
 * BUILT server always sees the real environment: `next start` leaves NEXT_PHASE
 * unset, so nothing keyed off this flag can survive into a running deployment.
 */
function isNextBuildPhase(): boolean {
  return process.env.NEXT_PHASE === "phase-production-build";
}

/**
 * Hard-fail at init when the secret is missing in production (codebase-review B2):
 * Better Auth otherwise falls back to its built-in dev secret with only a console
 * warning, which would make every session cookie forgeable. Dev keeps the warning
 * (a fixed local secret is a non-issue and zero-config matters there).
 *
 * The `next build` phase is exempt (see `isNextBuildPhase`) — enforcing there
 * breaks every production image build. The guard still fires the moment the built
 * server actually starts, so no production process can ever run on the forgeable
 * fallback secret.
 */
function requiredSecret(): string | undefined {
  const secret = process.env.BETTER_AUTH_SECRET;
  if (!secret && !isNextBuildPhase() && process.env.NODE_ENV === "production") {
    throw new Error("BETTER_AUTH_SECRET is required in production — set it (e.g. `fly secrets set BETTER_AUTH_SECRET=…`)");
  }
  return secret;
}

/**
 * The deployment's canonical origin. OAuth callbacks, magic-link URLs and the
 * CSRF allow-list (`server/api/csrf.ts`) are all built from `BETTER_AUTH_URL`.
 *
 * The build phase gets an unresolvable placeholder for the same reason
 * `requiredSecret` skips its guard there: the variable is absent during
 * `next build`, and an absent baseURL makes Better Auth log "[better-auth] Base
 * URL is not set" on every image build and every CI production-build job. That
 * warning describes a request-time hazard the build phase cannot have — no
 * request is served and no prerendered output embeds an auth origin — so the
 * placeholder removes the noise without weakening the real check: a deployment
 * that actually lost BETTER_AUTH_URL still fails loudly, because an empty CSRF
 * allow-list rejects every cookie-bearing mutation.
 */
function configuredBaseURL(): string | undefined {
  const url = process.env.BETTER_AUTH_URL;
  if (url) return url;
  return isNextBuildPhase() ? "https://build.invalid" : undefined;
}

export const auth = betterAuth({
  database: drizzleAdapter(db(), {
    provider: "pg",
    schema: { user: users, session: authSessions, account: accounts, verification: verifications },
  }),
  secret: requiredSecret(),
  baseURL: configuredBaseURL(),
  trustedOrigins: configuredTrustedOrigins(),
  emailAndPassword: { enabled: true, disableSignUp: signupDisabled },
  socialProviders: configuredSocialProviders(),
  /**
   * Session lifetime is stated rather than inherited (security-authz.plan.md
   * slice 7): the "Before ALLOW_SIGNUP=true" checklist in docs/auth.md requires a
   * deliberate, documented lifetime. The values are Better Auth's own defaults —
   * a 7-day session, refreshed at most once a day — so this pins today's behavior
   * instead of changing it; shortening them is now a one-line decision.
   */
  session: { expiresIn: 60 * 60 * 24 * 7, updateAge: 60 * 60 * 24 },
  /**
   * Magic-link registers only where its link can actually be delivered — a
   * production without a resolved transport gets no plugin at all rather than a
   * sign-in URL in the logs (security-authz.plan.md slice 1), the same shape as
   * the env-gated social providers above.
   *
   * The hook is wrapped rather than passed by reference because Better Auth calls
   * it as `sendMagicLink(data, request)`, and that second argument would land in
   * `sendMagicLink`'s injectable `env` parameter — reading as non-production and
   * logging the URL. The wrapper pins the resolved environment instead.
   *
   * Written as two whole literals rather than a conditional spread because Better
   * Auth infers its `$Infer`/API types from the plugin **tuple**: a spread widens
   * the array and the admin plugin's added user fields (`role`) stop resolving in
   * `session.ts`. `nextCookies()` stays last in both arms so it can flush
   * Set-Cookie on server-action responses.
   */
  plugins: magicLinkPluginEnabled()
    ? [
        magicLink({
          sendMagicLink: (link) => sendMagicLink({ email: link.email, url: link.url }),
          disableSignUp: signupDisabled,
        }),
        admin(),
        nextCookies(),
      ]
    : [admin(), nextCookies()],
});
