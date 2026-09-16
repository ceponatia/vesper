import { APIError, createAuthMiddleware, getSessionFromCtx, isAPIError } from "better-auth/api";
import { chargeCredentialAttempt, clearCredentialFailures, credentialSubject } from "./credential-guard";

/**
 * Where the durable per-account backoff attaches to Better Auth.
 *
 * `hooks.before` / `hooks.after` run for **every** auth endpoint — the library
 * gives the option a matcher of `() => true` — so {@link credentialSubjectSource}
 * is the whole filter, and it has to stay free. `/get-session` is refetched on
 * every window focus; reaching the database from this hook for it would turn a
 * security counter into a per-page-view write.
 *
 * The after hook is what makes "clear on success" possible at all: Better Auth
 * catches an endpoint's `APIError` into the dispatch result *before* running
 * after-hooks, so the hook sees a failed credential check as a **returned**
 * `APIError` rather than a thrown one, and a passed check as anything else.
 *
 * Typed by inference through `createAuthMiddleware`: the context type lives in
 * `@better-auth/core`, which this app does not declare as a dependency and must
 * not import past `better-auth`'s own exports.
 */

/**
 * Endpoints that verify a password, and where the account address comes from.
 *
 * `body` reads the address the caller submitted; `session` reads it from the
 * signed-in user. Deliberately not every credential path: `reset-password` and
 * `magic-link/verify` consume a token rather than a password, and a 32-byte
 * random has nothing to guess at — the per-IP window covers their flood shape,
 * and charging them here would let anyone holding a stale link delay the
 * account's real sign-in.
 */
const GUARDED_PATHS: Readonly<Record<string, "body" | "session">> = {
  "/sign-in/email": "body",
  "/verify-password": "session",
  "/change-password": "session",
};

/** Whether a path verifies a password, and how its account is identified. */
export function credentialSubjectSource(path: string): "body" | "session" | null {
  return GUARDED_PATHS[path] ?? null;
}

function submittedAddress(body: unknown): string | null {
  if (typeof body !== "object" || body === null) return null;
  const email: unknown = (body as { email?: unknown }).email;
  return typeof email === "string" && email.trim().length > 0 ? email : null;
}

/** The refusal. One shape for every reason, so it says nothing about the account. */
function tooManyAttempts(retryAfterSeconds: number): APIError {
  return new APIError(
    "TOO_MANY_REQUESTS",
    {
      code: "TOO_MANY_CREDENTIAL_ATTEMPTS",
      message: `Too many failed attempts for this account. Try again in ${retryAfterSeconds} seconds.`,
    },
    { "Retry-After": String(retryAfterSeconds) },
  );
}

/**
 * Charge the attempt before the password is checked.
 *
 * Charging up front rather than recording afterwards is what closes the
 * concurrency gap: simultaneous attempts each take their turn at the counter
 * instead of all reading "under the threshold" and all proceeding. The cost is
 * that an attempt abandoned mid-flight still counts, which a correct password
 * immediately erases.
 *
 * A `session` path with no session resolves to no subject, and that is not a
 * hole: those endpoints sit behind `sensitiveSessionMiddleware`, so the request
 * is refused before any password is checked. There is no guess to count.
 */
export const beforeCredentialAttempt = createAuthMiddleware(async (ctx) => {
  const source = credentialSubjectSource(ctx.path);
  if (source === null) return;

  let address: string | null;
  if (source === "body") {
    address = submittedAddress(ctx.body);
  } else {
    // Resolved once per request: this memoizes onto `ctx.context.session`, which
    // the endpoint's own session middleware then reuses.
    const session = await getSessionFromCtx(ctx);
    address = session?.user.email ?? null;
  }
  if (address === null) return;

  const decision = await chargeCredentialAttempt(credentialSubject(address));
  if (!decision.allowed) throw tooManyAttempts(decision.retryAfterSeconds);
});

/**
 * Forget the account's failures once a credential check has actually passed.
 *
 * "Passed" is read as "the endpoint did not end in an `APIError`". That is
 * deliberately strict: a right password followed by a refusal for some other
 * reason leaves the count standing, which errs toward keeping the defense on
 * rather than handing an attacker a way to clear it without knowing the
 * password.
 */
export const afterCredentialAttempt = createAuthMiddleware(async (ctx) => {
  const source = credentialSubjectSource(ctx.path);
  if (source === null) return;
  if (isAPIError(ctx.context.returned)) return;

  const address =
    source === "body" ? submittedAddress(ctx.body) : ((await getSessionFromCtx(ctx))?.user.email ?? null);
  if (address === null) return;

  await clearCredentialFailures(credentialSubject(address));
});
