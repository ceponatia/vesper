import { z } from "zod";
import { devImpersonate } from "@/server/auth";
import { jsonError, readBody, withRoute } from "@/server/api";

const impersonateSchema = z.object({ userId: z.string().min(1) });

/**
 * Dev/QA session minting — replaces the old `vesper_user` cookie
 * switch. Mints a **real signed Better Auth session** for the target user via
 * the shared dev credential and returns the Set-Cookie response. Dev-only:
 * **404 in production** (security Cluster A1). The target must have been
 * provisioned with the dev credential (the seed does this for the Player + the
 * uxtest admin); anyone else resolves to 404.
 */
export const POST = withRoute(async (req) => {
  if (process.env.NODE_ENV === "production") return jsonError("not_found", "not found", 404);
  const body = await readBody(req, impersonateSchema);
  if (!body.ok) return body.response;
  const response = await devImpersonate(body.value.userId);
  if (!response) return jsonError("not_found", "user not found or has no dev credential", 404);
  return response;
});
