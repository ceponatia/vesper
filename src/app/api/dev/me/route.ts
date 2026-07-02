import { jsonError, jsonOk, withRoute, withUser } from "@/server/api";

/**
 * Dev identity check: the resolved current user only. Dev-only (**404 in
 * production**, security Cluster A1); the old `listUsers()` dump is gone
 * (Cluster A3). Admin-gated UI now reads Better Auth's session, not this route.
 *
 * The production 404 fires BEFORE user resolution (codebase-review B4), so an
 * unauthenticated probe can't distinguish this route from a missing one (the old
 * order answered 401 first) — matching dev/impersonate + dev/narration-shape.
 */
export const GET = withRoute(async (req, ctx) => {
  if (process.env.NODE_ENV === "production") return jsonError("not_found", "not found", 404);
  return withUser(async (user) => jsonOk({ user }))(req, ctx);
});
