import { jsonError, jsonOk, withUser } from "@/server/api";

/**
 * Dev identity check: the resolved current user only. Dev-only (**404 in
 * production**, security Cluster A1); the old `listUsers()` dump is gone
 * (Cluster A3). Admin-gated UI now reads Better Auth's session, not this route.
 */
export const GET = withUser(async (user) => {
  if (process.env.NODE_ENV === "production") return jsonError("not_found", "not found", 404);
  return jsonOk({ user });
});
