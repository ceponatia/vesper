import type { CurrentUser } from "@/server/auth";

/**
 * The shared `vi.mock("@/server/auth")` factory for route-handler suites, which
 * invoke handlers directly instead of going through Better Auth.
 *
 * Every suite used to hand-write the factory, and the copies drifted: most still
 * stub `USER_COOKIE` / `ensureDefaultUser` / `listUsers` — exports the auth
 * barrel has not had since the Better Auth cutover — while omitting
 * `Unauthenticated`, which `withUser` matches with `instanceof` to answer 401.
 * A mock missing it turns any auth-resolution failure into a 500 instead.
 *
 * **The identity object is the suite's, not this module's.** Vitest hoists
 * `vi.mock` factories above every import, so a factory can reference only
 * `vi.hoisted` values — and `vi.hoisted` callbacks run before imports too, so
 * they cannot call anything exported from here either. The seed is therefore a
 * plain object literal the suite writes itself, and this module only supplies
 * the module shape around it:
 *
 * ```ts
 * const authState = vi.hoisted(() => ({
 *   user: { id: "", email: "", name: "Chat Int", role: "admin" as const },
 * }));
 * vi.mock("@/server/auth", async () => (await import("@/server/test-support")).routeAuthModule(authState));
 * ```
 *
 * The dynamic `import()` inside the factory is required: a top-level import of
 * this module would be hoisted below the factory and be undefined when it runs.
 */

/**
 * The mutable identity a mocked suite drives. Exactly `CurrentUser` — mirroring
 * the real resolved-session projection rather than restating its fields keeps a
 * future `CurrentUser` change from silently diverging here.
 */
export interface TestAuthState {
  user: CurrentUser;
}

/**
 * The no-session sentinel, declared at module scope so every `routeAuthModule`
 * call in one worker returns the SAME class reference — `withUser`'s
 * `err instanceof Unauthenticated` compares identity, and a per-call class would
 * make that check fail for anything the suite throws itself.
 */
class Unauthenticated extends Error {
  constructor() {
    super("unauthenticated");
    this.name = "Unauthenticated";
  }
}

/**
 * The mocked `@/server/auth` module: a `getCurrentUser` that reads `state.user`
 * at CALL time (so a mid-test rebind or role swap takes effect on the next
 * request) plus the real `Unauthenticated` class.
 *
 * Nothing else is provided. `respond.ts` is the only runtime consumer the route
 * suites reach — `authz.ts` and `limits.ts` import `CurrentUser` as a type only,
 * and no handler under test imports `auth` / `devImpersonate` /
 * `enabledSocialProviders` / `magicLinkPluginEnabled`. The return is asserted to
 * the full module type so the factory type-checks; the flip side is that a suite
 * which later pulls in a route needing one of those exports gets `undefined` at
 * runtime with no type error. Add it by spreading:
 * `{ ...routeAuthModule(state), magicLinkPluginEnabled: () => false }`.
 */
export function routeAuthModule(state: TestAuthState): typeof import("@/server/auth") {
  return {
    getCurrentUser: async () => state.user,
    Unauthenticated,
  } as unknown as typeof import("@/server/auth");
}

/**
 * Rebind the mocked identity to a freshly seeded row, preserving `name`/`role`
 * from the suite's literal. The `beforeAll` line every suite writes by hand.
 */
export function bindAuthUser(state: TestAuthState, row: { id: string; email: string }): void {
  state.user = { ...state.user, id: row.id, email: row.email };
}

/**
 * Run `fn` under a patched identity, restoring the previous one in `finally`.
 *
 * The hand-rolled role/owner swaps restore on the happy path only, so a failed
 * expectation inside the swap leaks a non-admin (or foreign) identity into every
 * later test in the file and cascades unrelated failures. `finally` is the whole
 * point of this helper — prefer it over assigning `state.user` directly.
 */
export async function withAuthUser<T>(
  state: TestAuthState,
  patch: Partial<CurrentUser>,
  fn: () => Promise<T>,
): Promise<T> {
  const previous = state.user;
  state.user = { ...previous, ...patch };
  try {
    return await fn();
  } finally {
    state.user = previous;
  }
}
