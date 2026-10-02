import { DiagnosticCollector } from "@/contracts/diagnostics";
import {
  mergeChatMessageMeta,
  parseChatMessageMeta,
  serializeChatMessageMeta,
} from "@/contracts/turns/chat-message-meta";
import { parseOr } from "@/lib/parse";
import { characterChatMessages, db } from "@/server/db";
import { and, desc, eq } from "drizzle-orm";
import type { ExchangeTrace } from "../chat-exchange-trace";
import { readBranchClock } from "../sim-beats";
import { emptyReplyTakes, pushReplyTake, replyTakesSchema } from "../chat-reply-store";
import { renderCommittedCut } from "../sim-narrator";
import { latestCutIdForEngagement } from "../simulation";
import { classifyNarratorRender } from "./dialogue";
import { findStandingEngagement } from "./engagements";
import {
  type ResolvedSimExchange,
  loadSimDialogueTail,
  loadSimConversationContext,
  loadSimPresentationInputs,
  simContextCoverage,
} from "./context";
import type { SimChatExchangeResult } from "./types";

/**
 * retake (regenerate/rerun, ruling 18) — re-render the SAME committed cut: same
 * events, fresh prose. NO time advance, NO admission, NO new transcript rows; the
 * last assistant reply is replaced in place (content + browsable takes + meta),
 * exactly the row semantics the legacy regenerate gives the client.
 */
export async function runSimRetake(input: {
  chatId: string;
  userId: string;
  ctx: ResolvedSimExchange;
  /** The exchange trace (#637) `runSimChatExchange` started for this admitted exchange. */
  exchangeTrace: ExchangeTrace;
}): Promise<SimChatExchangeResult> {
  const { chatId, ctx, exchangeTrace } = input;
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
    exchangeTrace.record({ stage: "sim.cut", phase: "prepare", status: "failed", reason: "nothing_to_retake" });
    exchangeTrace.finish({ kind: "failed" });
    exchangeTrace.flush();
    return { ok: false, code: "nothing_to_retake", message: "there is no reply to regenerate yet", status: 409 };
  }
  exchangeTrace.annotate({ replyMessageId: target.id });

  // The pair's standing scene must exist to re-render its cut (read-only — a
  // retake never opens a scene or advances anything).
  const found = await findStandingEngagement(branchId, playerActorId, primaryActorId);
  if (found.engagementId === null) {
    exchangeTrace.record({ stage: "sim.cut", phase: "prepare", status: "failed", reason: "sim_open_failed" });
    exchangeTrace.finish({ kind: "failed" });
    exchangeTrace.flush();
    return { ok: false, code: "sim_open_failed", message: "there is no open scene to re-render", status: 409 };
  }
  const engagementId = found.engagementId;

  // The cut id: from the reply's meta (persistAssistantReply stored it), else the
  // engagement's newest persisted cut (ruling 18 fallback). The same read recovers
  // the run that produced the take this retake is about to displace.
  // The WHOLE bag: the retake rewrites this row in place, so everything it does not
  // itself re-derive — the beat marker, a `stopped` flag, the opening directive, and
  // any key a newer deploy wrote — has to survive the write below.
  // Collected rather than dropped: a field this row could not parse is a fact the
  // retake's own diagnostics should carry, since the write below rewrites the row.
  const metaDiagnostics = new DiagnosticCollector();
  const priorMeta = parseChatMessageMeta(target.meta, metaDiagnostics);
  const metaCutId = priorMeta.cutId;
  const cutId = metaCutId ?? (await latestCutIdForEngagement(db(), branchId, engagementId));
  if (!cutId) {
    exchangeTrace.record({ stage: "sim.cut", phase: "prepare", status: "failed", reason: "nothing_to_retake" });
    exchangeTrace.finish({ kind: "failed" });
    exchangeTrace.flush();
    return { ok: false, code: "nothing_to_retake", message: "there is no committed cut to re-render", status: 409 };
  }
  exchangeTrace.annotate({ sim: { cutId } });
  exchangeTrace.record({
    stage: "sim.cut",
    phase: "prepare",
    status: "success",
    reason: metaCutId ? "from_reply_meta" : "from_latest_engagement_cut",
  });

  // The tail excludes the reply being retaken (it must never read itself back);
  // the prompting utterance is its immediate predecessor, and only if that was a
  // player line (a retaken continue/open beat has none).
  const dialogueTail = await loadSimDialogueTail(chatId, playerName, target.id);
  const lastTailLine = dialogueTail.at(-1);
  const priorUtterance =
    lastTailLine && lastTailLine.speaker.startsWith("PLAYER") ? lastTailLine.text : "";
  const clock = await readBranchClock(branchId);
  const [{ memory, conversationSummary }, presentation] = await exchangeTrace.time("sim.context", "prepare", () =>
    Promise.all([
      loadSimConversationContext({
        chatId,
        branchId,
        viewpointActorId: playerActorId,
        message: priorUtterance,
        ragEligibility: ctx.ragEligibility,
        atStorySecond: clock?.storySecond ?? 0,
      }),
      loadSimPresentationInputs({ chatId, userId: input.userId, branchId, primaryActorId, actorNames, playerName }),
    ]),
  );
  for (const entry of simContextCoverage({
    dialogueTail,
    conversationSummary,
    memory,
    ragEligibility: ctx.ragEligibility,
    hadUtterance: priorUtterance.trim().length > 0,
    presentation,
    clock,
  })) {
    exchangeTrace.coverage(entry);
  }

  const rendered = await exchangeTrace.time(
    "sim.narrator",
    "narrator",
    () =>
      renderCommittedCut({
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
    return { ok: false, code: "render_withheld", message: "the narrator could not re-render this turn; try again", status: 503 };
  }
  // Narrowed here so the closure below (a separate function scope) keeps the
  // `string` type — `rendered.prose`'s narrowing does not carry into it.
  const prose = rendered.prose;
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

  // Replace the reply row in place: the prior text becomes a browsable take, the
  // fresh render is active (the same transcript semantics legacy gives).
  const priorTakes = parseOr(replyTakesSchema, target.takes, emptyReplyTakes(), undefined, "character_chat_messages.takes");
  const nextTakes = pushReplyTake(priorTakes, target.content, prose, new Date().toISOString(), {
    // The displaced take keeps the run that wrote it — that is what makes the two
    // takes comparable afterwards instead of both reading as this exchange's prompt.
    ...(priorMeta.narratorRun === undefined ? {} : { current: priorMeta.narratorRun }),
    ...(rendered.provenance === undefined ? {} : { fresh: rendered.provenance }),
  });
  await exchangeTrace.time("sim.persist", "settle", () =>
    db()
      .update(characterChatMessages)
      .set({
        content: prose,
        takes: nextTakes,
        // Merge, never replace: only the fields this re-render actually produced are
        // overwritten. `narratorRun` and `confirmStatus` are named unconditionally, so a
        // render that produced neither CLEARS the displaced take's values rather than
        // leaving them to describe prose that is no longer on the row.
        meta: serializeChatMessageMeta(
          mergeChatMessageMeta(priorMeta, {
            simTurn: true,
            cutId: rendered.cutId,
            modelId: rendered.modelId,
            attempts: rendered.attempts,
            narratorRun: rendered.provenance,
            confirmStatus: rendered.confirmStatus,
            // Row-TYPE markers the fresh render contradicts. Merging is right for
            // provenance and wrong for these: this row now holds narrated prose, so a
            // `worldBeat` marker left on it would keep rendering a muted system line
            // (and keep the narrator's dialogue tail skipping it), and a `stopped`
            // chip would label a complete render as cut short.
            worldBeat: undefined,
            stopped: undefined,
            // This retake is itself an admitted exchange with its own trace, so its id
            // supersedes whatever trace labeled the row before (present only when real).
            ...(exchangeTrace.traceId ? { traceId: exchangeTrace.traceId } : {}),
          }),
        ),
      })
      .where(and(eq(characterChatMessages.id, target.id), eq(characterChatMessages.chatId, chatId))),
  );

  exchangeTrace.finish({ kind: "ok" });
  exchangeTrace.flush();
  return {
    ok: true,
    messageId: target.id,
    prose,
    cutId: rendered.cutId,
    modelId: rendered.modelId,
    attempts: rendered.attempts,
    degraded: rendered.degraded,
    // Codes only: this field is `string[]` and is returned verbatim in the sim-turn
    // JSON, so it carries the stable code and never a diagnostic's message or context.
    diagnostics: [
      ...ctx.instructionDiagnostics,
      ...metaDiagnostics.items.map((d) => d.code),
      ...rendered.diagnostics,
    ],
  };
}
