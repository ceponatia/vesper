import { and, desc, eq } from "drizzle-orm";
import { z } from "zod";
import { jsonError, jsonOk, readBody, withUser } from "@/server/api";
import { db, simShadowDivergences } from "@/server/db";

type Params = { chatId: string };

/**
 * R4 (engine.rollout.plan.md) — the shadow-divergence triage surface, in the
 * 404-hidden admin sim family: GET lists a chat's recorded divergences newest
 * first (the parity report's raw material), PATCH rules one row's verdict —
 * "intentional" is a durable ruling, not a doc footnote.
 */

const PAGE_LIMIT = 200;

const verdictBodySchema = z
  .object({ id: z.string().min(1).max(120), verdict: z.enum(["open", "intentional", "fixed"]) })
  .strict();

export const GET = withUser<Params>(async (user, req, ctx) => {
  if (user.role !== "admin") return jsonError("not_found", "not found", 404);
  const { chatId } = await ctx.params;
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

export const PATCH = withUser<Params>(async (user, req, ctx) => {
  if (user.role !== "admin") return jsonError("not_found", "not found", 404);
  const { chatId } = await ctx.params;
  const body = await readBody(req, verdictBodySchema);
  if (!body.ok) return body.response;
  const updated = await db()
    .update(simShadowDivergences)
    .set({ verdict: body.value.verdict })
    .where(and(eq(simShadowDivergences.id, body.value.id), eq(simShadowDivergences.chatId, chatId)))
    .returning({ id: simShadowDivergences.id });
  if (updated.length === 0) return jsonError("not_found", "no such divergence row for this chat", 404);
  return jsonOk({ id: body.value.id, verdict: body.value.verdict });
});
