import { and, desc, eq } from "drizzle-orm";
import { z } from "zod";
import { jsonError, jsonOk, readBody } from "@/server/api";
import { db, simShadowDivergences } from "@/server/db";
import { withSelfOwnedSimChat } from "../../owned";

type Params = { chatId: string };

const PAGE_LIMIT = 200;
const verdictBodySchema = z
  .object({ id: z.string().min(1).max(120), verdict: z.enum(["open", "intentional", "fixed"]) })
  .strict();

/** Read an owner-admin's own chat divergence rows only. */
export const GET = withSelfOwnedSimChat<Params>(async (_user, owned, req) => {
  const chatId = owned.chat.id;
  const domain = req.nextUrl.searchParams.get("domain");
  const rows = await db()
    .select()
    .from(simShadowDivergences)
    .where(
      and(
        eq(simShadowDivergences.chatId, chatId),
        domain === null ? undefined : eq(simShadowDivergences.domain, domain),
      ),
    )
    .orderBy(desc(simShadowDivergences.createdAt), desc(simShadowDivergences.id))
    .limit(PAGE_LIMIT);
  return jsonOk({ rows });
});

/** Rule one divergence row inside an owner-admin's own chat only. */
export const PATCH = withSelfOwnedSimChat<Params>(async (_user, owned, req) => {
  const body = await readBody(req, verdictBodySchema);
  if (!body.ok) return body.response;
  const updated = await db()
    .update(simShadowDivergences)
    .set({ verdict: body.value.verdict })
    .where(and(eq(simShadowDivergences.id, body.value.id), eq(simShadowDivergences.chatId, owned.chat.id)))
    .returning({ id: simShadowDivergences.id });
  if (updated.length === 0) return jsonError("not_found", "no such divergence row for this chat", 404);
  return jsonOk({ id: body.value.id, verdict: body.value.verdict });
});
