import { desc, eq } from "drizzle-orm";
import { analyzeShadowParity } from "@/lib/simulation";
import { jsonError, jsonOk, withUser } from "@/server/api";
import { db, simShadowDivergences } from "@/server/db";

type Params = { chatId: string };

/** Rows the analysis reads at most — far above any one corpus run's output. */
const ANALYSIS_LIMIT = 2_000;

/**
 * R4 slice 2 (engine.rollout.plan.md) — the computed shadow-parity report for
 * one chat: the pure scale-aware analysis over its recorded divergence rows.
 * Rows already ruled (`intentional`/`fixed`) drop out of the findings, so this
 * endpoint always shows what is STILL open — the exit is this list empty over
 * the agreed corpus.
 */
export const GET = withUser<Params>(async (user, _req, ctx) => {
  if (user.role !== "admin") return jsonError("not_found", "not found", 404);
  const { chatId } = await ctx.params;
  const rows = await db()
    .select()
    .from(simShadowDivergences)
    .where(eq(simShadowDivergences.chatId, chatId))
    .orderBy(desc(simShadowDivergences.createdAt), desc(simShadowDivergences.id))
    .limit(ANALYSIS_LIMIT);
  return jsonOk({ chatId, report: analyzeShadowParity(rows) });
});
