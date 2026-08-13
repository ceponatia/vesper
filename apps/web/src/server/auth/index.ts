/**
 * Auth module barrel (auth.plan.md). `auth` is the Better Auth instance (owns
 * the whole /api/auth surface); `getCurrentUser` resolves the signed session
 * for our own route handlers; `Unauthenticated` is the no-session sentinel that
 * `withUser` turns into a 401. Dev-only session minting lives in `dev.ts`;
 * `magicLinkPluginEnabled` reports whether magic-link sign-in is actually
 * available here (dev, or a production with a resolved transport —
 * security-authz.plan.md slice 1).
 */
export { auth, enabledSocialProviders } from "./auth";
export { magicLinkPluginEnabled } from "./magic-link";
export { getCurrentUser, Unauthenticated, type CurrentUser } from "./session";
export { devImpersonate, ensureDevCredential, DEV_PASSWORD } from "./dev";
