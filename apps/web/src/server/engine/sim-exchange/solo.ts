import type { SoloDeparture } from "@vesper/simulation-core/departure";
import { humanizeId } from "@vesper/simulation-core/humanize";
import {
  buildSoloFallbackProse,
  buildSoloPlayerSide,
  buildSoloVignette,
  type SoloCutContext,
  type SoloVignette,
} from "@vesper/simulation-core/solo-cut";
import { newId } from "@/lib/ids";
import { db, simItemHoldings, simItems } from "@/server/db";
import { and, asc, eq } from "drizzle-orm";
import { readBranchClock } from "../sim-beats";
import type { SpaceProjection } from "@vesper/simulation-core/contracts/space";
import type { CompositionFallbackCollector } from "../composition-diagnostics";
import { buildNarratorRunProvenance, persistAssistantReply } from "../chat-reply-store";
import { enqueueChatSummary } from "../chat-summary";
import {
  buildSimSoloRenderPrompt,
  buildSimSoloRenderPromptNodes,
  type SimSoloRenderContext,
} from "../prompts/sim-solo-render";
import { renderSoloNarration } from "../sim-narrator";
import { zoneDisplayNoun } from "../sim-surfaces";
import {
  advanceBranchStoryTime,
  readDurableActivities,
  readDurableCommitments,
  readDurableSpaceBranch,
} from "../simulation";
import {
  type ResolvedSimExchange,
  loadSimConversationContext,
  simLoadWarn,
  loadSimPresentationInputs,
} from "./context";
import type { SimChatExchangeResult } from "./types";

/** The player's held-item display names — the first inventory read the solo player-side needs. */
async function loadSimPlayerHeldItems(branchId: string, playerActorId: string): Promise<string[]> {
  const rows = await db()
    .select({ name: simItems.name, slotKey: simItemHoldings.slotKey })
    .from(simItemHoldings)
    .innerJoin(
      simItems,
      and(eq(simItems.branchId, simItemHoldings.branchId), eq(simItems.itemId, simItemHoldings.itemId)),
    )
    .where(
      and(
        eq(simItemHoldings.branchId, branchId),
        eq(simItemHoldings.locusKind, "held"),
        eq(simItemHoldings.actorId, playerActorId),
      ),
    )
    .orderBy(asc(simItemHoldings.slotKey));
  return rows.map((row) => row.name);
}

/**
 * Assemble the dual-block solo context from the sim projections,
 * each source degrading independently (docs/resilience.md):
 * - player-side (space + held items) is REQUIRED — a space-read failure returns
 *   `null` and the caller degrades to a minimal safe narration;
 * - the away vignette (activities + commitments) is OPTIONAL — its failure omits
 *   block (b), records a diagnostic, and block (a) renders alone.
 * Zone/actor ids are resolved to display labels here (charter law) so no raw id
 * ever reaches the pure shaper or the prompt.
 */
async function buildSoloCutContext(input: {
  chatId: string;
  branchId: string;
  playerActorId: string;
  primaryActorId: string;
  playerName: string;
  primaryName: string;
  actorNames: Record<string, string>;
  atStorySecond: number;
  /**
   * A projection the caller already settled THIS turn (a departure/accompany
   * choreography drained to the arrival and won't advance again) — reused in
   * place of a re-read so the composed loop materializes space once. Absent on
   * an ordinary solo turn, which reads it fresh after its own span advance.
   */
  settledSpace?: SpaceProjection;
}): Promise<{ context: SoloCutContext | null; diagnostics: string[] }> {
  const diagnostics: string[] = [];
  const actorNameOf = (actorId: string): string => input.actorNames[actorId] ?? humanizeId(actorId);

  let space: SpaceProjection;
  if (input.settledSpace !== undefined) {
    space = input.settledSpace;
  } else {
    try {
      space = await readDurableSpaceBranch(input.branchId);
    } catch (error) {
      simLoadWarn(input.chatId, "solo space read failed — minimal narration", error);
      return { context: null, diagnostics: ["engine.sim.solo.space_read_failed"] };
    }
  }

  // Zone display labels come from the space projection's own zone KINDS (the
  // schema has no zone-name column — the same humane source `sim-render` uses),
  // so no raw zone id reaches the shaper or the prompt (charter law).
  const kindByZone = new Map<string, string>(space.zones.map((zone) => [zone.id, zone.kind]));
  const zoneLabelOf = (zoneId: string): string => {
    const noun = zoneDisplayNoun(kindByZone.get(zoneId) ?? "");
    return noun.length > 0 ? noun : humanizeId(zoneId);
  };

  let heldItems: string[] = [];
  try {
    heldItems = await loadSimPlayerHeldItems(input.branchId, input.playerActorId);
  } catch (error) {
    simLoadWarn(input.chatId, "solo held-items read degraded to empty", error);
    diagnostics.push("engine.sim.solo.held_read_degraded");
  }

  const playerSide = buildSoloPlayerSide({
    playerActorId: input.playerActorId,
    primaryActorId: input.primaryActorId,
    loci: space.loci,
    journeys: space.journeys,
    activities: [],
    heldItems,
    zoneLabelOf,
    actorNameOf,
    atStorySecond: input.atStorySecond,
  });

  // The away vignette — activities + commitments. A failure here degrades to
  // block (a) alone (ruling 21), never a failed turn.
  let vignette: SoloVignette | undefined;
  try {
    const [activities, commitments] = await Promise.all([
      readDurableActivities(input.branchId),
      readDurableCommitments(input.branchId),
    ]);
    // Co-present NPC activities enrich block (a) too, now that activities loaded.
    const enrichedPlayerSide = buildSoloPlayerSide({
      playerActorId: input.playerActorId,
      primaryActorId: input.primaryActorId,
      loci: space.loci,
      journeys: space.journeys,
      activities: activities.activities,
      heldItems,
      zoneLabelOf,
      actorNameOf,
      atStorySecond: input.atStorySecond,
    });
    vignette = buildSoloVignette({
      primaryActorId: input.primaryActorId,
      primaryName: input.primaryName,
      loci: space.loci,
      journeys: space.journeys,
      activities: activities.activities,
      commitments: commitments.commitments,
      zoneLabelOf,
      atStorySecond: input.atStorySecond,
    });
    return {
      context: { playerName: input.playerName, primaryName: input.primaryName, playerSide: enrichedPlayerSide, vignette },
      diagnostics,
    };
  } catch (error) {
    simLoadWarn(input.chatId, "solo vignette build degraded — block (a) alone", error);
    diagnostics.push("engine.sim.solo.vignette_degraded");
    return { context: { playerName: input.playerName, primaryName: input.primaryName, playerSide }, diagnostics };
  }
}

/**
 * The SOLO cut: a turn that runs when the
 * primary is NOT co-present. Time still moves — the branch clock advances the
 * ordinary 60s span and drains due triggers (that is how an in-transit player
 * eventually arrives; time is the medium) — and the render is
 * dual-block: the player's own moment plus an away vignette of the primary's
 * routine. The user row (for a send) is already persisted by the caller. This
 * path NEVER dead-ends: every context source degrades and the narrator falls
 * back to a deterministic minimal narration.
 */
export async function runSimSoloTurn(input: {
  chatId: string;
  userId: string;
  speakerCharacterId: string;
  mode: "send" | "continue" | "open";
  message: string;
  narratorInput: boolean;
  ctx: ResolvedSimExchange;
  userMessageId: string | null;
  dialogueTail: { speaker: string; text: string }[];
  /**
   * A chosen departure this turn (slice 4): the choreography already ended the
   * scene, moved the player, and drained the clock to the arrival — so this turn
   * SKIPS its own span advance and the solo prompt narrates the farewell/walk/
   * arrival arc.
   */
  departure?: SoloDeparture;
  /**
   * A settled projection the departure/accompany caller already read this turn.
   * ONLY sound alongside a `departure` (that path skips the span advance below, so
   * the state can't drift underneath it); on an ordinary solo turn the space is
   * re-read AFTER the advance, so a threaded value would be stale and is ignored.
   */
  settledSpace?: SpaceProjection;
  /** C15: composition-fallback collector threaded from the turn entry (may be absent). */
  fallbacks?: CompositionFallbackCollector;
}): Promise<SimChatExchangeResult> {
  const { chatId, ctx } = input;
  const { branchId, playerActorId, primaryActorId, actorNames, playerName } = ctx;
  const primaryName = actorNames[primaryActorId] ?? "them";

  // Time moves: advance the ordinary span and drain due triggers. A2-1: the
  // advance is tolerant (`at_least`), so a concurrent drain that overtook this
  // span is a legal race, not a degrade — the effective target clamps up to the
  // drained clock and the turn renders there. The broad catch stays for OTHER
  // failures (a genuine drain fault), but the overtaken-clock race no longer
  // throws, so `simLoadWarn` no longer fires for it. A departure turn already
  // drained to the arrival, so it does NOT advance again (that would over-count
  // the parting past the moment the player just arrived).
  const before = await readBranchClock(branchId);
  if (input.departure === undefined) {
    try {
      await advanceBranchStoryTime(branchId, (before?.storySecond ?? 0) + 60, {
        workerId: `sim-solo-${chatId}`,
        database: db(),
        targetMode: "at_least",
      });
    } catch (error) {
      simLoadWarn(chatId, "solo story-time advance degraded", error);
    }
  }
  const clock = (await readBranchClock(branchId)) ?? before;
  const atStorySecond = clock?.storySecond ?? 0;

  // A departure/accompany turn already settled the projection this request and
  // did NOT advance again (guarded above) — reuse it. An ordinary solo turn just
  // advanced, so any threaded snapshot is stale: ignore it and let the context
  // read fresh.
  const settledSpace = input.departure !== undefined ? input.settledSpace : undefined;

  const [{ memory, conversationSummary }, presentation, solo] = await Promise.all([
    loadSimConversationContext({
      chatId,
      branchId,
      viewpointActorId: playerActorId,
      message: input.message,
      ragEligibility: ctx.ragEligibility,
      atStorySecond,
    }),
    loadSimPresentationInputs({ chatId, userId: input.userId, branchId, primaryActorId, actorNames, playerName }),
    buildSoloCutContext({
      chatId,
      branchId,
      playerActorId,
      primaryActorId,
      playerName,
      primaryName,
      actorNames,
      atStorySecond,
      ...(settledSpace ? { settledSpace } : {}),
    }),
  ]);

  // buildSoloCutContext resolves zone labels from the space projection's zone
  // kinds itself (no raw ids), so nothing more is needed to ground the prompt.
  const soloContext =
    solo.context ??
    ({
      playerName,
      primaryName,
      playerSide: { zoneLabel: "", inTransit: false, coPresent: [], heldItems: [] },
    } satisfies SoloCutContext);

  const fallbackProse = buildSoloFallbackProse(soloContext);
  // Named so the provenance can weigh the SAME assembly the render used, rather
  // than a second context built from the same fields and hoped to match.
  const soloRenderContext: SimSoloRenderContext = {
    // Walking out of the primary's physical scene must not quietly restore the
    // production craft layer — the same frozen source feeds dialogue.ts.
    instructionSource: ctx.instructionSource,
    storySecond: atStorySecond,
    calendarStart: clock?.calendarStart ?? null,
    actorNames,
    solo: soloContext,
    ...(input.departure ? { departure: input.departure } : {}),
    ...(input.message === "" ? {} : { playerUtterance: input.message }),
    ...(input.narratorInput ? { narratorInput: true } : {}),
    dialogueTail: input.dialogueTail,
    viewpointIsPlayer: true,
    ...(conversationSummary === "" ? {} : { conversationSummary }),
    ...(memory.length === 0 ? {} : { memory }),
    ...(presentation.primary ? { primary: presentation.primary } : {}),
    player: presentation.player,
    ...(presentation.outfitLine ? { outfitLine: presentation.outfitLine } : {}),
    ...(presentation.relationship ? { relationship: presentation.relationship } : {}),
    narrationShape: presentation.narrationShape,
  };
  const { system, prompt } = buildSimSoloRenderPrompt(soloRenderContext);

  const rendered = await renderSoloNarration({ system, prompt, fallbackProse });
  if (rendered.status !== "rendered" || rendered.prose === undefined) {
    return { ok: false, code: "render_withheld", message: "the narrator could not render this turn; try again", status: 503 };
  }

  const narratorRun = buildNarratorRunProvenance({
    lane: "successor",
    modelId: rendered.modelId,
    source: ctx.instructionSource,
    nodes: buildSimSoloRenderPromptNodes(soloRenderContext),
    assembled: [system, prompt].join("\n\n"),
    attempts: rendered.attempts,
    ...(rendered.latencyMs === undefined ? {} : { latencyMs: rendered.latencyMs }),
  });
  const diagnostics = [...ctx.instructionDiagnostics, ...solo.diagnostics, ...rendered.diagnostics];
  const fallbackCodes = input.fallbacks?.codes() ?? [];
  const assistantMessageId = newId();
  await persistAssistantReply({
    id: assistantMessageId,
    chatId,
    speakerCharacterId: input.speakerCharacterId,
    promptMessageId: input.userMessageId,
    content: rendered.prose,
    meta: {
      simTurn: true,
      solo: true,
      modelId: rendered.modelId,
      attempts: rendered.attempts,
      narratorRun,
      ...(input.mode === "open" ? { simOpening: true } : {}),
      // C15 surface a: the composed-flow codes (public-safe), plus the solo render's own
      // stable diagnostic codes — both were previously returned then dropped at persist.
      ...(fallbackCodes.length ? { compositionFallbacks: fallbackCodes } : {}),
      ...(diagnostics.length ? { renderDiagnostics: diagnostics } : {}),
    },
  });
  void enqueueChatSummary({ chatId });
  return {
    ok: true,
    messageId: assistantMessageId,
    prose: rendered.prose,
    cutId: "",
    modelId: rendered.modelId,
    attempts: rendered.attempts,
    degraded: rendered.degraded,
    diagnostics,
  };
}
