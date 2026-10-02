import { successorReplyMeta } from "@/contracts/turns/chat-message-meta";
import { newId } from "@/lib/ids";
import { readBranchClock } from "../sim-beats";
import type { ExchangeTrace } from "../chat-exchange-trace";
import type { CompositionFallbackCollector } from "../composition-diagnostics";
import { persistAssistantReply } from "../chat-reply-store";
import { enqueueChatSummary } from "../chat-summary";
import { buildLiveDeliberation, renderCommittedCut, type RenderedCut } from "../sim-narrator";
import { runSimVisualStateShadow } from "../sim-visual-state";
import { prepareEngagementTurn } from "../simulation";
import {
  type ResolvedSimExchange,
  loadSimConversationContext,
  loadSimPresentationInputs,
  simContextCoverage,
} from "./context";
import type { AdmissionOutcome } from "./admission";
import type { SimChatExchangeResult } from "./types";

/** `sim.narrator`'s stage classification, shared by the co-present and retake renderers:
 * `failed` when withheld, `degraded`/`retried` per the render's own signals, else `success`. */
export function classifyNarratorRender(rendered: RenderedCut): {
  status: "failed" | "degraded" | "retried" | "success";
  reason?: string;
  attempt: number;
  model: { modelId: string; provider?: string };
} {
  const status: "failed" | "degraded" | "retried" | "success" =
    rendered.status !== "rendered"
      ? "failed"
      : rendered.degraded
        ? "degraded"
        : rendered.attempts > 1
          ? "retried"
          : "success";
  const reason = status === "success" ? undefined : rendered.diagnostics.at(-1);
  return {
    status,
    ...(reason ? { reason } : {}),
    attempt: rendered.attempts,
    model: { modelId: rendered.modelId, ...(rendered.provider ? { provider: rendered.provider } : {}) },
  };
}

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
  /** The exchange trace (#637) threaded from the turn entry. */
  exchangeTrace: ExchangeTrace;
}): Promise<SimChatExchangeResult> {
  const { chatId, ctx, admission, exchangeTrace } = input;
  const { branchId, playerActorId, primaryActorId, actorNames, playerName } = ctx;

  const turn = await exchangeTrace.time("sim.turn", "prepare", () =>
    prepareEngagementTurn({
      branchId,
      engagementId: input.engagementId,
      viewpointActorId: playerActorId,
      spanSeconds: 60,
      playerActorIds: [playerActorId],
      deliberation: buildLiveDeliberation(),
      workerId: `sim-turn-${chatId}`,
      ...(admission?.failure === undefined ? {} : { failurePresentations: [admission.failure] }),
    }),
  );
  exchangeTrace.annotate({
    sim: {
      cutId: turn.cut.id,
      branchVersion: turn.cut.branchVersion,
      fromSequence: turn.cut.fromSequence,
      throughSequence: turn.cut.throughSequence,
    },
  });
  const sceneCount = turn.cut.mustEnact.length + turn.cut.currentActivities.length + turn.cut.currentLoci.length;
  exchangeTrace.coverage({ family: "scene", status: sceneCount > 0 ? "present" : "empty", count: sceneCount });

  const clock = await readBranchClock(branchId);
  const [{ memory, conversationSummary }, presentation] = await exchangeTrace.time("sim.context", "prepare", () =>
    Promise.all([
      loadSimConversationContext({
        chatId,
        branchId,
        viewpointActorId: playerActorId,
        message: input.message,
        ragEligibility: ctx.ragEligibility,
        atStorySecond: clock?.storySecond ?? 0,
      }),
      loadSimPresentationInputs({ chatId, userId: input.userId, branchId, primaryActorId, actorNames, playerName }),
    ]),
  );
  for (const entry of simContextCoverage({
    dialogueTail: input.dialogueTail,
    conversationSummary,
    memory,
    ragEligibility: ctx.ragEligibility,
    hadUtterance: input.message.length > 0,
    presentation,
    clock,
  })) {
    exchangeTrace.coverage(entry);
  }
  const directiveText = admission?.executed ?? admission?.failure?.publicReason;
  exchangeTrace.coverage({
    family: "directives",
    status: directiveText ? "present" : "empty",
    ...(directiveText ? { count: 1, chars: directiveText.length } : {}),
  });

  const rendered = await exchangeTrace.time(
    "sim.narrator",
    "narrator",
    () =>
      renderCommittedCut({
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
          ...(presentation.garments ? { garments: presentation.garments } : {}),
          ...(presentation.relationship ? { relationship: presentation.relationship } : {}),
          ...(presentation.zoneNames ? { zoneNames: presentation.zoneNames } : {}),
          narrationShape: presentation.narrationShape,
        },
      }),
    classifyNarratorRender,
  );
  if (rendered.status !== "rendered" || rendered.prose === undefined) {
    exchangeTrace.finish({ kind: "failed" });
    exchangeTrace.flush();
    return { ok: false, code: "render_withheld", message: "the narrator could not render this turn; try again", status: 503 };
  }
  exchangeTrace.annotate({
    sim: {
      cutId: rendered.cutId,
      ...(rendered.branchVersion === undefined ? {} : { branchVersion: rendered.branchVersion }),
      ...(rendered.fromSequence === undefined ? {} : { fromSequence: rendered.fromSequence }),
      ...(rendered.throughSequence === undefined ? {} : { throughSequence: rendered.throughSequence }),
    },
    narrator: {
      modelId: rendered.modelId,
      ...(rendered.provider ? { provider: rendered.provider } : {}),
      attempts: rendered.attempts,
      ...(rendered.provenance?.finishReason ? { finishReason: rendered.provenance.finishReason } : {}),
      ...(rendered.provenance?.inputTokens === undefined ? {} : { inputTokens: rendered.provenance.inputTokens }),
      ...(rendered.provenance?.outputTokens === undefined ? {} : { outputTokens: rendered.provenance.outputTokens }),
      ...(rendered.provenance?.instructionHash ? { instructionHash: rendered.provenance.instructionHash } : {}),
      ...(rendered.provenance?.assembledSystemHash
        ? { assembledSystemHash: rendered.provenance.assembledSystemHash }
        : {}),
    },
  });

  const assistantMessageId = newId();
  await exchangeTrace.time("sim.persist", "settle", () =>
    persistAssistantReply({
      id: assistantMessageId,
      chatId,
      speakerCharacterId: input.speakerCharacterId,
      promptMessageId: input.userMessageId,
      content: rendered.prose,
      meta: successorReplyMeta({
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
        ...(input.fallbacks === undefined ? {} : { compositionFallbacks: input.fallbacks.codes() }),
        traceId: exchangeTrace.traceId,
      }),
    }),
  );
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
    garments: presentation.garments,
  });
  exchangeTrace.finish({ kind: "ok" });
  exchangeTrace.flush();
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
