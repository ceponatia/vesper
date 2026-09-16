/**
 * Auth module barrel. `auth` is the Better Auth instance (owns
 * the whole /api/auth surface); `getCurrentUser` resolves the signed session
 * for our own route handlers; `Unauthenticated` is the no-session sentinel that
 * `withUser` turns into a 401. Dev-only session minting lives in `dev.ts`;
 * `magicLinkPluginEnabled` reports whether magic-link sign-in is actually
 * available here (dev, or a production with a resolved transport).
 *
 * `credential-guard.ts` is the durable per-account backoff on failed password
 * checks — reached through Better Auth's hooks in normal operation, and exported
 * here for the retention pass that reaps its spent rows.
 */
export { auth, enabledSocialProviders } from "./auth";
export { magicLinkPluginEnabled } from "./magic-link";
export {
  chargeCredentialAttempt,
  clearCredentialFailures,
  credentialSubject,
  decayCutoff,
  readCredentialFailures,
  type CredentialDecision,
} from "./credential-guard";
export { getCurrentUser, Unauthenticated, type CurrentUser } from "./session";
export { devImpersonate, ensureDevCredential, DEV_PASSWORD } from "./dev";
