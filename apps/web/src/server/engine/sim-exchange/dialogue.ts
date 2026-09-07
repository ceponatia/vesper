import { newId } from "@/lib/ids";
import { readBranchClock } from "../sim-beats";
import type { CompositionFallbackCollector } from "../composition-diagnostics";
import { persistAssistantReply } from "../chat-reply-store";
import { enqueueChatSummary } from "../chat-summary";
import { buildLiveDeliberation, renderCommittedCut } from "../sim-narrator";
import { runSimVisualStateShadow } from "../sim-visual-state";
import { prepareEngagementTurn } from "../simulation";
import { type ResolvedSimExchange, loadSimConversationContext, loadSimPresentationInputs } from "./context";
import type { AdmissionOutcome } from "./admission";
import type { SimChatExchangeResult } from "./types";

/**
 * The co-present turn body (the primary is here to react): prepare the engagement
 * cut, load context, render, and persist. Both the ordinary turn and the
 * departure choreography's interrupt fallback reuse this renderer.
 */
export async function runCoPresentTurn(input: {
  chatId: string;
  userId: string;
  speakerCharacterId: string;
  mode: "send" | "continue" | "open";
  message: string;
  narratorInput: boolean;
  ctx: ResolvedSimExchange;
  engagementId: string;
  admission: AdmissionOutcome | null;
  dialogueTail: { speaker: string; text: string }[];
  userMessageId: string | null;
  /** C15: composition-fallback collector threaded from the turn entry (may be absent). */
  fallbacks?: CompositionFallbackCollector;
}): Promise<SimChatExchangeResult> {
  const { chatId, ctx, admission } = input;
  const { branchId, playerActorId, primaryActorId, actorNames, playerName } = ctx;

  const turn = await prepareEngagementTurn({
    branchId,
    engagementId: input.engagementId,
    viewpointActorId: playerActorId,
    spanSeconds: 60,
    playerActorIds: [playerActorId],
    deliberation: buildLiveDeliberation(),
    workerId: `sim-turn-${chatId}`,
    ...(admission?.failure === undefined ? {} : { failurePresentations: [admission.failure] }),
  });
  const clock = await readBranchClock(branchId);
  const [{ memory, conversationSummary }, presentation] = await Promise.all([
    loadSimConversationContext({
      chatId,
      branchId,
      viewpointActorId: playerActorId,
      message: input.message,
      ragEligibility: ctx.ragEligibility,
      atStorySecond: clock?.storySecond ?? 0,
    }),
    loadSimPresentationInputs({ chatId, userId: input.userId, branchId, primaryActorId, actorNames, playerName }),
  ]);
  const rendered = await renderCommittedCut({
    branchId,
    engagementId: input.engagementId,
    cutId: turn.cut.id,
    conversation: {
      // The exchange's frozen instructions. Every retry inside `renderCommittedCut`
      // rebuilds the prompt from THIS object, so the revision cannot move mid-render.
      instructionSource: ctx.instructionSource,
      // No utterance ⇒ omit the player-turn block ("the scene breathes").
      ...(input.message === "" ? {} : { playerUtterance: input.message }),
      ...(input.narratorInput ? { narratorInput: true } : {}),
      dialogueTail: input.dialogueTail,
      viewpointIsPlayer: true,
      actorNames,
      calendarStart: clock?.calendarStart ?? null,
      ...(admission?.executed === undefined ? {} : { admittedAction: admission.executed }),
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
    return { ok: false, code: "render_withheld", message: "the narrator could not render this turn; try again", status: 503 };
  }

  const assistantMessageId = newId();
  await persistAssistantReply({
    id: assistantMessageId,
    chatId,
    speakerCharacterId: input.speakerCharacterId,
    promptMessageId: input.userMessageId,
    content: rendered.prose,
    meta: {
      simTurn: true,
      cutId: rendered.cutId,
      modelId: rendered.modelId,
      attempts: rendered.attempts,
      // The opening-directive flag the prompt build reads.
      ...(input.mode === "open" ? { simOpening: true } : {}),
      ...(rendered.confirmStatus === undefined ? {} : { confirmStatus: rendered.confirmStatus }),
      // Which prompt and model wrote what this row displays. Mirrors the
      // active take, and is what a later retake seeds the historical take's label from.
      ...(rendered.provenance === undefined ? {} : { narratorRun: rendered.provenance }),
      // C15 surface a: public-safe codes only — open a degraded beat and see why.
      ...(input.fallbacks && input.fallbacks.codes().length ? { compositionFallbacks: input.fallbacks.codes() } : {}),
    },
  });
  // Knowledge/memory: fold the conversation forward — self-dedupes below its trigger.
  void enqueueChatSummary({ chatId });
  // Visual-state shadow (`CHAT_VISUAL_STATE_SHADOW`,
  // default OFF): the lane-neutral projection built BESIDE the settled turn for
  // measurement. Fire-and-forget and fenced whole inside — it writes nothing,
  // feeds nothing, and can never cost the exchange.
  void runSimVisualStateShadow({
    chatId,
    branchId,
    playerActorId,
    primaryActorId,
    cutId: rendered.cutId,
    storySecond: clock?.storySecond ?? 0,
    primary: presentation.primary,
  });
  return {
    ok: true,
    messageId: assistantMessageId,
    prose: rendered.prose,
    cutId: rendered.cutId,
    modelId: rendered.modelId,
    attempts: rendered.attempts,
    degraded: rendered.degraded,
    diagnostics: [...ctx.instructionDiagnostics, ...rendered.diagnostics],
  };
}
