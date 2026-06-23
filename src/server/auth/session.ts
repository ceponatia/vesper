import { auth } from "./auth";

/**
 * The resolved-identity shape every route handler receives via `withUser`
 * (docs/streaming-api.md §Auth). Deliberately a narrow projection of Better
 * Auth's richer user — keeping it stable means the visibility/ownership seam
 * never has to change when auth internals do.
 */
export interface CurrentUser {
  id: string;
  email: string;
  name: string;
  role: "user" | "admin";
}

/**
 * Thrown by `getCurrentUser` when no valid session resolves. `withUser` maps
 * this to a **401** — distinct from a genuine resolution failure (DB down),
 * which surfaces as `auth_unavailable` 500. There is no auto-minted default
 * user anymore: unauthenticated requests are rejected, never fabricated.
 */
export class Unauthenticated extends Error {
  constructor() {
    super("unauthenticated");
    this.name = "Unauthenticated";
  }
}

/**
 * Resolve the signed Better Auth session into a `CurrentUser`, or throw
 * `Unauthenticated`. `next/headers` is imported lazily so this module's static
 * graph stays free of the Next request runtime (lets scripts import the barrel).
 */
export async function getCurrentUser(): Promise<CurrentUser> {
  const { headers } = await import("next/headers");
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session?.user) throw new Unauthenticated();
  const { id, email, name, role } = session.user;
  return { id, email, name, role: role === "admin" ? "admin" : "user" };
}
