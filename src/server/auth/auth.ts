import { betterAuth, type BetterAuthOptions } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { admin, magicLink } from "better-auth/plugins";
import { nextCookies } from "better-auth/next-js";
import { log } from "@/server/log";
import { accounts, authSessions, db, users, verifications } from "../db";

/**
 * The Better Auth instance (auth.plan.md). Self-hosted, owns its tables in our
 * Postgres via the Drizzle adapter — `session` maps to `auth_sessions` to avoid
 * the collision with the game `sessions` table. Email+password is always on;
 * social OAuth and magic-link delivery are **env-gated** (degrade quietly when
 * their secrets are absent, per docs/resilience.md) so a missing provider never
 * crashes boot. This module is free of `next/headers` so scripts (the seed) can
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

/**
 * Deliver a magic-link sign-in URL. v1 has no email transport, so the dev
 * fallback is to **log the link** (docs/getting-started.md) — a real transport
 * (Resend/SMTP) plugs in here later behind its own env gate. Always logs so the
 * link is recoverable from server output during local testing.
 */
async function sendMagicLink({ email, url }: { email: string; url: string }): Promise<void> {
  log.info("auth.magic_link", "magic-link sign-in requested", { email, url });
}

export const auth = betterAuth({
  database: drizzleAdapter(db(), {
    provider: "pg",
    schema: { user: users, session: authSessions, account: accounts, verification: verifications },
  }),
  secret: process.env.BETTER_AUTH_SECRET,
  baseURL: process.env.BETTER_AUTH_URL,
  trustedOrigins: configuredTrustedOrigins(),
  emailAndPassword: { enabled: true },
  socialProviders: configuredSocialProviders(),
  plugins: [
    magicLink({ sendMagicLink }),
    admin(),
    // nextCookies must be last so it can flush Set-Cookie on server-action responses.
    nextCookies(),
  ],
});
