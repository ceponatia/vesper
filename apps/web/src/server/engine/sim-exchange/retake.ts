import { narratorRunProvenanceSchema } from "@/contracts/narrator-prompts";
import { parseOr } from "@/lib/parse";
import { z } from "zod";
import { characterChatMessages, db } from "@/server/db";
import { and, desc, eq } from "drizzle-orm";
import { readBranchClock } from "../sim-beats";
import { emptyReplyTakes, pushReplyTake, replyTakesSchema } from "../chat-reply-store";
import { renderCommittedCut } from "../sim-narrator";
import { latestCutIdForEngagement } from "../simulation";
import { findStandingEngagement } from "./engagements";
import {
  type ResolvedSimExchange,
  loadSimDialogueTail,
  loadSimConversationContext,
  loadSimPresentationInputs,
} from "./context";
import type { SimChatExchangeResult } from "./types";

/**
 * The reply-meta fields the retake path reads back: the committed cut id, and the
 * run that produced the content currently on the row — which the retake hands to
 * the historical take it seeds, so the displaced take keeps naming the prompt that
 * actually wrote it. A reply from before provenance existed carries neither;
 * absent is legal.
 */
const simReplyMetaSchema = z
  .object({
    cutId: z.string().min(1).optional(),
    narratorRun: narratorRunProvenanceSchema.optional().catch(undefined),
  })
  .catch({});

/**
 * retake (regenerate/rerun, ruling 18) — re-render the SAME committed cut: same
 * events, fresh prose. NO time advance, NO admission, NO new transcript rows; the
 * last assistant reply is replaced in place (content + browsable takes + meta),
 * exactly the row semantics the legacy regenerate gives the client.
 */
export async function runSimRetake(input: { chatId: string; userId: string; ctx: ResolvedSimExchange }): Promise<SimChatExchangeResult> {
  const { chatId, ctx } = input;
  const { branchId, playerActorId, primaryActorId, actorNames, playerName } = ctx;

  // The target is the last assistant reply (regenerate targets it directly; a
  // rerun of the latest exchange resolves to the same row).
  const [target] = await db()
    .select({
      id: characterChatMessages.id,
      content: characterChatMessages.content,
      takes: characterChatMessages.takes,
      meta: characterChatMessages.meta,
    })
    .from(characterChatMessages)
    .where(and(eq(characterChatMessages.chatId, chatId), eq(characterChatMessages.role, "assistant")))
    .orderBy(desc(characterChatMessages.createdAt), desc(characterChatMessages.id))
    .limit(1);
  if (!target) {
    return { ok: false, code: "nothing_to_retake", message: "there is no reply to regenerate yet", status: 409 };
  }

  // The pair's standing scene must exist to re-render its cut (read-only — a
  // retake never opens a scene or advances anything).
  const found = await findStandingEngagement(branchId, playerActorId, primaryActorId);
  if (found.engagementId === null) {
    return { ok: false, code: "sim_open_failed", message: "there is no open scene to re-render", status: 409 };
  }
  const engagementId = found.engagementId;

  // The cut id: from the reply's meta (persistAssistantReply stored it), else the
  // engagement's newest persisted cut (ruling 18 fallback). The same read recovers
  // the run that produced the take this retake is about to displace.
  const priorMeta = parseOr(simReplyMetaSchema, target.meta, {}, undefined, "character_chat_messages.meta");
  const metaCutId = priorMeta.cutId;
  const cutId = metaCutId ?? (await latestCutIdForEngagement(db(), branchId, engagementId));
  if (!cutId) {
    return { ok: false, code: "nothing_to_retake", message: "there is no committed cut to re-render", status: 409 };
  }

  // The tail excludes the reply being retaken (it must never read itself back);
  // the prompting utterance is its immediate predecessor, and only if that was a
  // player line (a retaken continue/open beat has none).
  const dialogueTail = await loadSimDialogueTail(chatId, playerName, target.id);
  const lastTailLine = dialogueTail.at(-1);
  const priorUtterance =
    lastTailLine && lastTailLine.speaker.startsWith("PLAYER") ? lastTailLine.text : "";
  const clock = await readBranchClock(branchId);
  const [{ memory, conversationSummary }, presentation] = await Promise.all([
    loadSimConversationContext({
      chatId,
      branchId,
      viewpointActorId: playerActorId,
      message: priorUtterance,
      ragEligibility: ctx.ragEligibility,
      atStorySecond: clock?.storySecond ?? 0,
    }),
    loadSimPresentationInputs({ chatId, userId: input.userId, branchId, primaryActorId, actorNames, playerName }),
  ]);

  const rendered = await renderCommittedCut({
    branchId,
    engagementId,
    cutId,
    conversation: {
      // The dispatcher resolved this retake's instruction source under the exchange
      // lock. This supports the A/B workflow: generate on
      // production, select a test template, ask for another take, and get the new
      // prompt while the previous take stays browsable under the old one.
      instructionSource: ctx.instructionSource,
      ...(priorUtterance.trim() === "" ? {} : { playerUtterance: priorUtterance }),
      dialogueTail,
      viewpointIsPlayer: true,
      actorNames,
      calendarStart: clock?.calendarStart ?? null,
      ...(conversationSummary === "" ? {} : { conversationSummary }),
      ...(memory.length === 0 ? {} : { memory }),
      ...(presentation.primary ? { primary: presentation.primary } : {}),
      player: presentation.player,
      ...(presentation.outfitLine ? { outfitLine: presentation.outfitLine } : {}),
      ...(presentation.relationship ? { relationship: presentation.relationship } : {}),
      ...(presentation.zoneNames ? { zoneNames: presentation.zoneNames } : {}),
      narrationShape: presentation.narrationShape,
    },
  });
  if (rendered.status !== "rendered" || rendered.prose === undefined) {
    return { ok: false, code: "render_withheld", message: "the narrator could not re-render this turn; try again", status: 503 };
  }

  // Replace the reply row in place: the prior text becomes a browsable take, the
  // fresh render is active (the same transcript semantics legacy gives).
  const priorTakes = parseOr(replyTakesSchema, target.takes, emptyReplyTakes(), undefined, "character_chat_messages.takes");
  const nextTakes = pushReplyTake(priorTakes, target.content, rendered.prose, new Date().toISOString(), {
    // The displaced take keeps the run that wrote it — that is what makes the two
    // takes comparable afterwards instead of both reading as this exchange's prompt.
    ...(priorMeta.narratorRun === undefined ? {} : { current: priorMeta.narratorRun }),
    ...(rendered.provenance === undefined ? {} : { fresh: rendered.provenance }),
  });
  await db()
    .update(characterChatMessages)
    .set({
      content: rendered.prose,
      takes: nextTakes,
      meta: {
        simTurn: true,
        cutId: rendered.cutId,
        modelId: rendered.modelId,
        attempts: rendered.attempts,
        ...(rendered.provenance === undefined ? {} : { narratorRun: rendered.provenance }),
        ...(rendered.confirmStatus === undefined ? {} : { confirmStatus: rendered.confirmStatus }),
      },
    })
    .where(and(eq(characterChatMessages.id, target.id), eq(characterChatMessages.chatId, chatId)));

  return {
    ok: true,
    messageId: target.id,
    prose: rendered.prose,
    cutId: rendered.cutId,
    modelId: rendered.modelId,
    attempts: rendered.attempts,
    degraded: rendered.degraded,
    diagnostics: [...ctx.instructionDiagnostics, ...rendered.diagnostics],
  };
}
