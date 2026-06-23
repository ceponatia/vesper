import { NextResponse, type NextRequest } from "next/server";
import { getSessionCookie } from "better-auth/cookies";

/**
 * Logged-out gate (auth.plan.md / auth.md). Sends users with no session cookie
 * to `/sign-in` *before* any protected page renders, so the dashboard's
 * owner-scoped fetches never run client-side and flash a "please sign in" error.
 *
 * Next 16 renamed the `middleware` file convention to `proxy` (same runtime, same
 * `config` matcher) — this is that file. It is an **optimistic** check — cookie
 * presence only, no DB call (the recommended Better Auth edge pattern). A
 * forged/expired cookie still gets a real 401 from `withUser`; this only stops
 * the never-logged-in flash. The matcher already excludes `/sign-in`, `/api/*`
 * (which return their own JSON 401), Next internals, and static files.
 */
export function proxy(request: NextRequest): NextResponse {
  const sessionCookie = getSessionCookie(request);
  if (!sessionCookie) {
    const signIn = new URL("/sign-in", request.url);
    return NextResponse.redirect(signIn);
  }
  return NextResponse.next();
}

export const config = {
  matcher: ["/((?!api|_next/static|_next/image|favicon.ico|icon.svg|sign-in|.*\\..*).*)"],
};
