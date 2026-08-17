import { eq } from "drizzle-orm";
import { characterChats, db } from "../db";

/**
 * Is visual-state narration on for THIS conversation?
 * (visual-state.plan.md slice 7; owner ruling 2026-08-17.)
 *
 * A per-chat switch rather than a deploy-wide flag, because the paid round could
 * not measure the benefit: the trial's own induction gate refused a verdict, so
 * this ships as something the owner turns on for one conversation and reads,
 * rather than something enabled everywhere on a directional result.
 *
 * Its own tiny read for the same reason `agentReasoningProfile` has one: the
 * column is operational configuration, not story state, so it deliberately does
 * NOT ride `ChatScenario` and a retake never moves it. A missing row or a failed
 * read answers `false` — the conservative direction, and the one that leaves the
 * prompt byte-identical to today.
 */
export async function chatVisualStateNarrationOn(chatId: string): Promise<boolean> {
  const [row] = await db()
    .select({ enabled: characterChats.visualStateNarration })
    .from(characterChats)
    .where(eq(characterChats.id, chatId))
    .limit(1);
  return row?.enabled ?? false;
}
