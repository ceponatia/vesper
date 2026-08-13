import { desc, eq } from "drizzle-orm";
import { analyzeShadowParity } from "@/lib/simulation/shadow-parity";
import { jsonOk } from "@/server/api";
import { db, simShadowDivergences } from "@/server/db";
import { withSelfOwnedSimChat } from "../../../owned";

type Params = { chatId: string };

/** Rows the analysis reads at most — far above any one corpus run's output. */
const ANALYSIS_LIMIT = 2_000;

/** Compute parity findings only for an owner-admin's own chat. */
export const GET = withSelfOwnedSimChat<Params>(async (_user, owned) => {
  const chatId = owned.chat.id;
  const rows = await db()
    .select()
    .from(simShadowDivergences)
    .where(eq(simShadowDivergences.chatId, chatId))
    .orderBy(desc(simShadowDivergences.createdAt), desc(simShadowDivergences.id))
    .limit(ANALYSIS_LIMIT);
  return jsonOk({ chatId, report: analyzeShadowParity(rows) });
});
