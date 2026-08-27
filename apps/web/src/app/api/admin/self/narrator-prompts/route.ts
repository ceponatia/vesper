import type { NextRequest } from "next/server";
import { createNarratorPromptRequestSchema } from "@/contracts/narrator-prompts";
import { jsonOk, readBody, withOwnerAdmin } from "@/server/api";
import { createNarratorPromptTemplate, listNarratorPromptTemplates } from "@/server/narrator-prompts";
import { narratorPromptFailure } from "./failure";

/**
 * The Narrator Prompt Lab's collection surface.
 *
 * Owner-admin, and re-checked SERVER-SIDE here rather than by the page that
 * links to it: `withOwnerAdmin` fails closed with a hidden 404 for a non-admin
 * AND for any path outside `/api/admin/self`, so hiding the username-menu entry
 * is convenience, never authorization. The handlers live at the path the client
 * calls — the canonical-under-`/api/admin` plus one-line `/self/` twin shape is
 * the older idiom, and a handler placed there would 404 by construction
 * (`OWNER_ADMIN_API_PREFIX`).
 *
 * Owner SCOPING is a second, independent gate: the service puts `owner_id` in
 * every predicate, so an administrator sees their own experiments and nobody
 * else's.
 */

export const GET = withOwnerAdmin(async (user) =>
  jsonOk({ prompts: await listNarratorPromptTemplates(user.id) }),
);

export const POST = withOwnerAdmin(async (user, req: NextRequest) => {
  const body = await readBody(req, createNarratorPromptRequestSchema);
  if (!body.ok) return body.response;

  const result = await createNarratorPromptTemplate(user.id, body.value);
  if (!result.ok) return narratorPromptFailure(result);
  return jsonOk({ prompt: result.value }, 201);
});
