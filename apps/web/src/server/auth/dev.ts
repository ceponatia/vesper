import { and, eq } from "drizzle-orm";
import { auth } from "./auth";
import { accounts, db, users } from "../db";
import { log } from "@/server/log";

/**
 * Dev/QA session minting. The old `vesper_user` cookie =
 * raw-userId model is gone; the cookie is now a signed session token, so the
 * documented QA flow ("act as the uxtest admin") needs a real session. The seed
 * provisions a shared dev credential for the Player + uxtest admin; the
 * dev-gated `/api/dev/impersonate` endpoint signs in with it to mint that
 * session. All of this is dev-only — the endpoint 404s in production.
 */

/** Shared credential the seed sets on dev users; override via env. Never used in production. */
export const DEV_PASSWORD = process.env.DEV_PASSWORD ?? "vesper-dev-password";

const CREDENTIAL_PROVIDER = "credential";

/**
 * Mint a signed Better Auth session for `userId` by signing in with the shared
 * dev credential, returning the Set-Cookie `Response`. Returns null when the
 * user is unknown or has no dev credential (the caller maps that to a 404).
 */
export async function devImpersonate(userId: string): Promise<Response | null> {
  const [user] = await db().select().from(users).where(eq(users.id, userId)).limit(1);
  if (!user) return null;
  try {
    return await auth.api.signInEmail({
      body: { email: user.email, password: DEV_PASSWORD },
      asResponse: true,
    });
  } catch {
    // No credential / wrong password — degrade to "not found" at the caller.
    return null;
  }
}

/**
 * Provision (or refresh) the shared dev credential for a user so impersonation
 * can sign in as them. Goes through the Drizzle account row directly — the
 * uxtest admin's id is fixed (every Tsukikage Onsen `ownerId` references it), so
 * we can't recreate it via sign-up. Hashing uses Better Auth's own hasher so
 * `signInEmail` verifies it.
 *
 * Refuses in production unless `DEV_PASSWORD` is explicitly set (codebase-review
 * B1): the fallback password is committed to the repo and the credential is
 * reachable through the PUBLIC sign-in surface — the impersonate route's 404
 * doesn't protect it. Returns whether the credential was provisioned.
 */
export async function ensureDevCredential(userId: string): Promise<boolean> {
  if (process.env.NODE_ENV === "production" && !process.env.DEV_PASSWORD) {
    log.warn(
      "auth.dev",
      "refusing to provision the default dev credential in production — set DEV_PASSWORD explicitly if impersonation is really wanted here",
      { userId },
    );
    return false;
  }
  const ctx = await auth.$context;
  const hash = await ctx.password.hash(DEV_PASSWORD);
  const [existing] = await db()
    .select({ id: accounts.id })
    .from(accounts)
    .where(and(eq(accounts.userId, userId), eq(accounts.providerId, CREDENTIAL_PROVIDER)))
    .limit(1);
  if (existing) {
    await db().update(accounts).set({ password: hash }).where(eq(accounts.id, existing.id));
    return true;
  }
  await db()
    .insert(accounts)
    .values({ userId, accountId: userId, providerId: CREDENTIAL_PROVIDER, password: hash });
  return true;
}
