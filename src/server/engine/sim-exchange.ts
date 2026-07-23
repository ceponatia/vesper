import { characterProfileSchema, emptyCharacterProfile } from "@/contracts";
import type { CharacterProfile } from "@/contracts/world/profile";
import type { PublicFailurePresentation } from "@/contracts/simulation/narrative";
import { admitPlayerCommand, type AdmittedCommand } from "@/lib/simulation/input-admission";
import { decideAccompany } from "@/lib/simulation/accompany";
import { planDepartureChoreography, type SoloDeparture } from "@/lib/simulation/departure";
import { buildWorldDestinations, placeGoPhrase } from "@/lib/simulation/world-read";
import { simulationHash } from "@/lib/simulation/hash";
import { deriveEngagementId, isStandingCoPresentEngagement } from "@/lib/simulation/engagements";
import { humanizeId } from "@/lib/simulation/humanize";
import {
  buildSoloFallbackProse,
  buildSoloPlayerSide,
  buildSoloVignette,
  type SoloCutContext,
  type SoloVignette,
} from "@/lib/simulation/solo-cut";
import { newId } from "@/lib/ids";
import { parseOr } from "@/lib/parse";
import { z } from "zod";
import {
  characterChatMessages,
  characters,
  chatParticipants,
  db,
  simActionDefinitions,
  simCharacters,
  simItemHoldings,
  simItems,
  simZones,
} from "@/server/db";
import { and, asc, desc, eq } from "drizzle-orm";
import { embedText, embedTexts } from "@/server/ai";
import { resolveChatPersona } from "../players";
import { readChatEngineAuthority } from "./chat-authority";
import { isWorldBeatMeta, readBranchClock, writeWorldBeat, type SimChatClock } from "./sim-beats";
import type { CompositionFallbackCode, CompositionFallbackSite } from "@/contracts/turns/composition-fallback";
import { CompositionFallbackCollector } from "./composition-diagnostics";
import { emptyReplyTakes, persistAssistantReply, pushReplyTake, replyTakesSchema } from "./chat-pipeline";
import { enqueueChatSummary, loadChatSummary } from "./chat-summary";
import { log } from "../log";
import { narrationShapeId, type NarrationShapeId } from "./prompts/constants";
import { buildSimSoloRenderPrompt } from "./prompts/sim-solo-render";
import { buildLiveDeliberation, renderCommittedCut, renderSoloNarration } from "./sim-narrator";
import { readSimChatOutfit, readSimChatRelationship, zoneDisplayNoun, zoneLabelFromKind, type SimChatRelationship } from "./sim-surfaces";
import {
  advanceBranchStoryTime,
  drainMemoryIndexOutbox,
  hasActiveTimeJob,
  latestCutIdForEngagement,
  prepareEngagementTurn,
  queryMemoryDocuments,
  readDurableActivities,
  readDurableCommitments,
  readDurableEngagements,
  readDurableSpaceBranch,
  submitDurableEndEngagement,
  submitDurableMoveActor,
  submitDurableOpenEngagement,
  submitDurableStartActivity,
  submitDurableTransferItem,
  type MemoryEmbedder,
} from "./simulation";

/**
 * R3 admission wiring (engine.rollout.plan.md) — one player message becomes
 * one successor turn: the shared core behind BOTH the explicit
 * `/sim-turn` route and the ordinary chat send path (which routes here when
 * the chat's authority flag says so — the wiring R1 deferred "until a
 * successor leg exists to route to"; it does now). The legacy pipeline is
 * still never imported from here and vice versa — the lanes meet only at
 * the route fork.
 */

/**
 * The actor pair's ACTUAL standing scene: any open co-present engagement
 * holding both mapped actors, no matter which chat (or storyteller tool)
 * opened it. One body, one physical scene (engine.spec §11.3) means a
 * per-chat derived id cannot be trusted to find it — a second chat mapped
 * to the same pair would mint a NEW open command and be refused
 * `participant_already_engaged` forever (the R3 live-session bug). Returns
 * the branch head too, so a miss can mint a head-scoped open command:
 * stable under a same-head race, fresh after an end_scene.
 */
export async function findStandingEngagement(
  branchId: string,
  playerActorId: string,
  primaryActorId: string,
): Promise<{ engagementId: string | null; headSequence: number }> {
  const projection = await readDurableEngagements(branchId);
  const standing = projection.engagements.find((engagement) =>
    isStandingCoPresentEngagement(engagement, playerActorId, primaryActorId),
  );
  return { engagementId: standing?.id ?? null, headSequence: projection.headSequence };
}

/**
 * Find the pair's standing scene or open a fresh one. A refusal carries the
 * §14.4 public face (code + public reason), never a private cause.
 */
export async function findOrOpenStandingEngagement(input: {
  branchId: string;
  playerActorId: string;
  primaryActorId: string;
  userId: string;
  correlationId: string;
}): Promise<{ ok: true; engagementId: string } | { ok: false; code: string; publicReason: string }> {
  const { branchId, playerActorId, primaryActorId } = input;
  const found = await findStandingEngagement(branchId, playerActorId, primaryActorId);
  if (found.engagementId !== null) return { ok: true, engagementId: found.engagementId };

  const openCommandId = `sim-scene-open-${simulationHash({ branchId, playerActorId, primaryActorId })}-${found.headSequence}`;
  const opened = await submitDurableOpenEngagement(
    {
      id: openCommandId,
      branchId,
      expectedVersion: 0,
      idempotencyKey: openCommandId,
      principal: { kind: "player" as const, principalId: input.userId, controlledActorIds: [playerActorId] },
      submittedAtWallClock: new Date().toISOString(),
      correlationId: input.correlationId,
      type: "open_engagement",
      schemaVersion: 1,
      payload: { participantIds: [playerActorId, primaryActorId].sort(), channel: "co_present" },
    },
    { admitAtLockedVersion: true },
  );
  if (opened.status === "accepted" || (opened.status === "rejected" && opened.code === "duplicate_command_id")) {
    return { ok: true, engagementId: deriveEngagementId(branchId, openCommandId) };
  }
  if (opened.status === "rejected" && opened.code === "participant_already_engaged") {
    // Race: another window opened the pair's scene between our read and this
    // submit — the re-read finds what the claim law just protected.
    const refound = await findStandingEngagement(branchId, playerActorId, primaryActorId);
    if (refound.engagementId !== null) return { ok: true, engagementId: refound.engagementId };
  }
  return opened.status === "rejected"
    ? { ok: false, code: opened.code, publicReason: opened.publicReason }
    : { ok: false, code: "sim_conflict", publicReason: "The world moved; try again." };
}

/**
 * R3 slice 4 + R5 time domain (ruling 17) — the routed chat's world clock:
 * the linked branch's `storySecond` plus the world's calendar anchor, or null
 * for a legacy chat. The chat UI shows THIS clock for sim-routed chats
 * (parity throughout the system), never the legacy scenario clock; the client
 * derives the legible label via the shared story-clock seam. `readBranchClock`
 * (the underlying branch read) lives in `sim-beats` alongside the beat writer
 * that stamps against it.
 */
export async function readSimChatClock(chatId: string): Promise<SimChatClock | null> {
  const authority = await readChatEngineAuthority(chatId);
  if (
    !authority ||
    authority.authority === "legacy_chat" ||
    authority.authority === "successor_shadow" ||
    !authority.simBranchId
  ) {
    return null;
  }
  return readBranchClock(authority.simBranchId);
}

/** The live embedder adapter for the §24 index — pseudo in demo mode, real otherwise. */
const memoryEmbedder: MemoryEmbedder = async (texts) => {
  const embedded = await embedTexts(texts);
  return { model: embedded[0]?.embedder ?? "pseudo", vectors: embedded.map((entry) => entry.vector) };
};

/**
 * R5 knowledge/memory — §24 viewpoint recall for one utterance: drain the
 * branch-agnostic index outbox (bounded — recall is current for the scene
 * being played), embed the utterance, and query the viewpoint's documents.
 * Returns epistemic-labeled lines for the prompt; every failure degrades to
 * [] with a log line, never a failed turn.
 */
async function recallViewpointMemory(input: {
  chatId: string;
  branchId: string;
  viewpointActorId: string;
  message: string;
  atStorySecond: number;
}): Promise<string[]> {
  try {
    await drainMemoryIndexOutbox({ workerId: `sim-mem-${input.chatId}`, embed: memoryEmbedder, maxIterations: 25 });
    const embedded = await embedText(input.message);
    const recall = await queryMemoryDocuments({
      branchId: input.branchId,
      viewpointActorId: input.viewpointActorId,
      atStorySecond: input.atStorySecond,
      queryText: input.message,
      queryEmbedding: embedded.vector,
      queryEmbeddingModel: embedded.embedder,
      limit: 6,
    });
    return recall.results.map((result) => `[${result.epistemicLabel}] ${result.text}`);
  } catch (error) {
    log.warn("engine.sim", "viewpoint recall degraded to empty", {
      chatId: input.chatId,
      error: error instanceof Error ? error.message : String(error),
    });
    return [];
  }
}

interface AdmissionOutcome {
  /** A one-line world-truth note for the narrator — set iff the command was ACCEPTED. */
  executed?: string;
  /** The §14.4 public face — set iff the admitted command was REFUSED. */
  failure?: PublicFailurePresentation;
}

/** One admitted command plus the branch zones (labels a move's destination beat without a re-read). */
interface AdmittedForChat {
  command: AdmittedCommand | null;
  zones: { zoneId: string; kind: string }[];
}

/** Why a drain stopped short of its target (A5 honesty; A6 adds the trigger reasons). */
export type DrainShortReason = "diverged" | "trigger_backoff" | "trigger_failed";

/** The honest result of a drain — how far time ACTUALLY moved, and why it stopped short. */
export interface DrainResult {
  /** True when the drain reached `target`; false when it stopped short. */
  converged: boolean;
  /** The story second the branch clock actually reached (the honest "how far time moved"). */
  reachedStorySecond: number;
  /** The requested target second. */
  target: number;
  /** Triggers resolved across the whole drain. */
  drained: number;
  /** Why it stopped short — absent on a clean converge. */
  shortReason?: DrainShortReason;
  /**
   * Triggers that went terminally `failed` during the drain (A6 poison sibling). A `converged`
   * drain can still carry these — a poison trigger does not stop the clock. A caller with chat
   * context records a `trigger_failed` diagnostic so the failure is never hidden.
   */
  terminalFailures: number;
}

/** Map a short-drain reason to its C15 fallback code (A5 honesty + A6 trigger reasons). */
export function drainShortCode(reason: DrainShortReason | undefined): CompositionFallbackCode {
  switch (reason) {
    case "diverged":
      return "drain_diverged";
    case "trigger_backoff":
      return "drain_backoff";
    case "trigger_failed":
      return "trigger_failed";
    case undefined:
      return "drain_short";
  }
}

/**
 * Record every C15 diagnostic a drain result implies, through a collector (A5 + A6): a
 * short-drain code when it fell short, and a `trigger_failed` code when a poison trigger
 * failed terminally during it (which can happen even on a converged drain). One shared seam so
 * the five drain sites don't each re-derive this.
 */
export function noteDrainDiagnostics(
  fallbacks: CompositionFallbackCollector | undefined,
  site: CompositionFallbackSite,
  drain: DrainResult,
): void {
  if (!drain.converged) {
    fallbacks?.note({
      site,
      code: drainShortCode(drain.shortReason),
      detail: `reached ${drain.reachedStorySecond}/${drain.target}`,
    });
  }
  if (drain.terminalFailures > 0) {
    fallbacks?.note({ site, code: "trigger_failed", detail: `${drain.terminalFailures} trigger(s) failed terminally` });
  }
}

/**
 * Drain the branch clock to `target` through the SAME bounded advance loop the
 * sim-command route uses (`catch_up_required` just means keep draining). Shared
 * by the route's skip-style composites and slice 4's departure choreography so
 * the two settle time identically — never duplicated (world-ui.plan.md slice 4).
 *
 * Returns an HONEST result (A5): the clock second actually reached and whether it fell short —
 * never a thrown error, so a caller can report "how far time moved" instead of a 500 after the
 * world already committed (docs/resilience.md).
 */
export async function drainBranchTo(branchId: string, target: number): Promise<DrainResult> {
  let drained = 0;
  let terminalFailures = 0;
  for (let calls = 0; ; calls += 1) {
    if (calls > 1_000) {
      // The runaway backstop: the clock advanced as far as it got (every advance persists it),
      // so read the real reached second rather than pretending we hit the target.
      const reached = (await readBranchClock(branchId))?.storySecond ?? target;
      return { converged: false, reachedStorySecond: reached, target, drained, shortReason: "diverged", terminalFailures };
    }
    const outcome = await advanceBranchStoryTime(branchId, target, { workerId: `sim-skip-${newId()}` });
    drained += outcome.drained;
    terminalFailures += outcome.terminalFailures ?? 0;
    if (outcome.status === "advanced") {
      return { converged: true, reachedStorySecond: outcome.storySecond, target, drained, terminalFailures };
    }
    // A6: a backed-off trigger parks the clock at its due second. STOP here (an honest short
    // drain) rather than re-looping — the next pass cannot see the trigger and would jump the
    // clock past it, mis-stamping its event. The clock stays parked, so when the backoff
    // elapses the trigger resolves at exactly the second it was due (§12.4 invariance).
    if (outcome.reason === "trigger_backoff") {
      return {
        converged: false,
        reachedStorySecond: outcome.storySecond,
        target,
        drained,
        shortReason: "trigger_backoff",
        terminalFailures,
      };
    }
    // trigger_budget / time_budget: more visible work remains — keep draining.
  }
}

/**
 * How far to drain after a committed move: the resulting journey's EXPECTED
 * arrival (§17), or the current clock when the move produced no journey. Shared
 * by the travel chip and the NL departure choreography (ruling 20 skip-style).
 *
 * A7: the drain target MUST equal the arrival trigger's due second, which §17 schedules at
 * `expectedArrivalAt`. Draining only to `earliestArrivalAt` (equal today, since uncertainty is
 * hardcoded 0) would, the moment travel uncertainty or a `journey_delayed` becomes nonzero,
 * stop the clock BEFORE the arrival trigger fires — leaving the traveller stranded in transit.
 * The two must be the same second; that second is `expectedArrivalAt`, whatever authored route
 * durations later write. (The post-drain check below is the net if they ever diverge.)
 */
export async function moveArrivalTarget(branchId: string, actorId: string): Promise<number> {
  const after = await readDurableSpaceBranch(branchId);
  const movedLocus = after.loci.find((locus) => locus.actorId === actorId);
  const journey =
    movedLocus?.kind === "in_transit"
      ? after.journeys.find((candidate) => candidate.id === movedLocus.journeyId)
      : undefined;
  return journey?.expectedArrivalAt ?? after.storySecond;
}

/**
 * A7 safety net (ruling 2): after a travel drain, verify each traveller actually left transit.
 * If one is still `in_transit`, record the `still_in_transit` C15 diagnostic and warn — the
 * arrival settles on a later beat (a subsequent turn's advance pushes the clock past the
 * trigger), never a stuck character or a dead turn (docs/resilience.md). This reuses the loci
 * a caller already read when it can, so the check is one shared line at each choreography site.
 *
 * The review upgrade — ESCALATE a still-in-transit actor to an A5 durable time job that resumes
 * until arrival — lands with A5 slice 2 (the job runner). Until then this is observability plus
 * the natural next-turn settle; the diagnostic is what makes a genuine strand visible.
 */
export function noteStillInTransit(
  fallbacks: CompositionFallbackCollector | undefined,
  site: CompositionFallbackSite,
  loci: readonly { actorId: string; kind: string }[],
  actorIds: readonly string[],
  chatId: string,
): void {
  const stranded = actorIds.filter((actorId) =>
    loci.some((locus) => locus.actorId === actorId && locus.kind === "in_transit"),
  );
  if (stranded.length === 0) return;
  log.warn("engine.sim.arrival", "actor still in transit after arrival drain; settles on a later beat", {
    chatId,
    stranded,
  });
  fallbacks?.note({ site, code: "still_in_transit", detail: `stranded: ${stranded.join(",")}` });
}

/**
 * R5 slice 2 — deterministic input admission, MATCH ONLY: read the world's legal
 * surface (held items, zones, actions) and pattern-match the player's prose to at
 * most one typed command. No submit here — the choreography branch in `runSimTurn`
 * decides how to enact it (a move drives the departure choreography; give/rest
 * submit into the co-present turn). Degrades to a null command on any read failure
 * — the exchange must never be worse off for having tried (docs/resilience.md).
 */
async function admitPlayerCommandForChat(input: {
  branchId: string;
  playerActorId: string;
  message: string;
}): Promise<AdmittedForChat> {
  try {
    const [held, zones, actions] = await Promise.all([
      db()
        .select({ itemId: simItemHoldings.itemId, name: simItems.name })
        .from(simItemHoldings)
        .innerJoin(
          simItems,
          and(eq(simItems.branchId, simItemHoldings.branchId), eq(simItems.itemId, simItemHoldings.itemId)),
        )
        .where(
          and(
            eq(simItemHoldings.branchId, input.branchId),
            eq(simItemHoldings.locusKind, "held"),
            eq(simItemHoldings.actorId, input.playerActorId),
          ),
        ),
      db()
        .select({ zoneId: simZones.zoneId, kind: simZones.kind })
        .from(simZones)
        .where(eq(simZones.branchId, input.branchId)),
      db()
        .select({ actionDefinitionId: simActionDefinitions.actionDefinitionId })
        .from(simActionDefinitions)
        .where(eq(simActionDefinitions.branchId, input.branchId)),
    ]);
    const command = admitPlayerCommand(input.message, {
      heldItems: held,
      zones,
      actionDefinitionIds: actions.map((row) => row.actionDefinitionId),
    });
    return { command, zones };
  } catch {
    return { command: null, zones: [] };
  }
}

/**
 * Submit an admitted command in the CO-PRESENT context (the primary is here to
 * react) and return its §14.4 outcome. A committed move — only reached as the
 * departure choreography's interrupt FALLBACK (world-ui.plan.md slice 4) — leaves
 * the same (non-parting) "You walk to …" beat slices 1–2 wrote. Best-effort: a
 * failed submit/beat degrades to no admission (docs/resilience.md).
 */
async function admitIntoCoPresentTurn(
  input: {
    chatId: string;
    userId: string;
    branchId: string;
    playerActorId: string;
    primaryActorId: string;
    playerName: string;
    primaryName: string;
  },
  command: Exclude<AdmittedCommand, { kind: "accompany" }>,
  zones: { zoneId: string; kind: string }[],
): Promise<AdmissionOutcome> {
  try {
    const outcome = await submitAdmittedCommand(input, command);
    if (command.kind === "move" && outcome.executed !== undefined) {
      const kind = zones.find((zone) => zone.zoneId === command.toZoneId)?.kind ?? "";
      await writeWorldBeat({
        chatId: input.chatId,
        branchId: input.branchId,
        kind: "traveled",
        destinationLabel: zoneLabelFromKind(command.toZoneId, kind),
      });
    }
    return outcome;
  } catch {
    return {};
  }
}

async function submitAdmittedCommand(
  input: { chatId: string; userId: string; branchId: string; playerActorId: string; primaryActorId: string; playerName: string; primaryName: string },
  command: Exclude<AdmittedCommand, { kind: "accompany" }>,
): Promise<AdmissionOutcome> {
  const envelope = {
    id: newId(),
    branchId: input.branchId,
    expectedVersion: 0,
    idempotencyKey: newId(),
    principal: { kind: "player" as const, principalId: input.userId, controlledActorIds: [input.playerActorId] },
    submittedAtWallClock: new Date().toISOString(),
    correlationId: `sim-admission-${input.chatId}`,
    schemaVersion: 1,
  };
  const outcome =
    command.kind === "give_item"
      ? await submitDurableTransferItem(
          {
            ...envelope,
            type: "transfer_item",
            schemaVersion: 2,
            payload: {
              actorId: input.playerActorId,
              itemId: command.itemId,
              fromLocus: { kind: "held", actorId: input.playerActorId },
              toLocus: { kind: "held", actorId: input.primaryActorId },
            },
          },
          { admitAtLockedVersion: true },
        )
      : command.kind === "move"
        ? await submitDurableMoveActor(
            {
              ...envelope,
              type: "move_actor",
              payload: { actorId: input.playerActorId, destinationZoneId: command.toZoneId, travelMode: "walk" },
            },
            { admitAtLockedVersion: true },
          )
        : await submitDurableStartActivity(
            {
              ...envelope,
              type: "start_activity",
              payload: { actorId: input.playerActorId, actionDefinitionId: command.actionDefinitionId },
            },
            { admitAtLockedVersion: true },
          );
  if (outcome.status === "accepted") {
    const executed =
      command.kind === "give_item"
        ? `${input.playerName} handed ${command.itemName} to ${input.primaryName}.`
        : command.kind === "move"
          ? `${input.playerName} set off walking toward the ${command.placeWord}.`
          : `${input.playerName} settled in to ${command.verb}.`;
    return { executed };
  }
  if (outcome.status === "rejected") {
    return {
      failure: {
        code: outcome.code,
        publicReason: outcome.publicReason,
        publicEvidence: [],
        legalAlternatives: [...(outcome.legalAlternativeCommandTypes ?? [])].map(String).slice(0, 16),
      },
    };
  }
  // A version conflict is neither an outcome nor a refusal — stay silent.
  return {};
}

export type SimChatExchangeResult =
  | {
      ok: true;
      messageId: string;
      prose: string;
      cutId: string;
      modelId: string;
      attempts: number;
      degraded: boolean;
      diagnostics: string[];
    }
  | {
      ok: false;
      code: "not_sim_enabled" | "sim_open_failed" | "render_withheld" | "nothing_to_retake" | "world_catching_up";
      message: string;
      status: number;
    };

/**
 * The successor exchange modes (presentation-charter.plan.md §4): a player-driven
 * turn, an utterance-free turn that still advances the span (continue/open,
 * ruling 19), or a same-cut re-render (retake = regenerate/rerun, ruling 18).
 */
export type SimChatExchangeMode = "send" | "continue" | "open" | "retake";

/** A chat authority proven routed to the successor engine (branch + actors mapped). */
type RoutedAuthority = NonNullable<Awaited<ReturnType<typeof readChatEngineAuthority>>> & {
  simBranchId: string;
  simPlayerActorId: string;
  simPrimaryActorId: string;
};

/**
 * Is this chat routed to the successor engine? The ONE predicate every sim path
 * shares — an authority past the view threshold, branch-linked, and actor-mapped.
 * A type guard so the route can use it as a boolean (GET affordance flag + POST
 * fork) while the exchange core reuses it AND gets the narrowed branch/actor ids.
 */
export function isSimRoutedAuthority(
  authority: Awaited<ReturnType<typeof readChatEngineAuthority>>,
): authority is RoutedAuthority {
  return (
    authority !== null &&
    authority.authority !== "legacy_chat" &&
    authority.authority !== "successor_shadow" &&
    authority.simBranchId !== null &&
    authority.simPlayerActorId !== null &&
    authority.simPrimaryActorId !== null
  );
}

/** Just the reply-meta field the retake path reads back — the committed cut id. */
const simReplyMetaSchema = z.object({ cutId: z.string().min(1).optional() }).catch({});

interface ResolvedSimExchange {
  branchId: string;
  playerActorId: string;
  primaryActorId: string;
  /** World-truth display names by actor id — ids never read well in prose. */
  actorNames: Record<string, string>;
  playerName: string;
  ragEligibility: boolean;
}

/**
 * The shared gate + world-truth names for one exchange: resolve authority, refuse
 * a non-sim chat, and load the branch's actor display names. Every mode starts
 * here so the gate lives in exactly one place.
 */
async function resolveSimExchange(
  chatId: string,
): Promise<{ ok: true; ctx: ResolvedSimExchange } | { ok: false; result: SimChatExchangeResult }> {
  const authority = await readChatEngineAuthority(chatId);
  if (!isSimRoutedAuthority(authority)) {
    return {
      ok: false,
      result: {
        ok: false,
        code: "not_sim_enabled",
        message: "this chat is not routed to the successor engine (authority + branch + actor mapping required)",
        status: 409,
      },
    };
  }
  const branchId = authority.simBranchId;
  const playerActorId = authority.simPlayerActorId;
  const nameRows = await db()
    .select({ characterId: simCharacters.characterId, name: simCharacters.name })
    .from(simCharacters)
    .where(eq(simCharacters.branchId, branchId));
  const actorNames = Object.fromEntries(nameRows.map((row) => [row.characterId, row.name]));
  return {
    ok: true,
    ctx: {
      branchId,
      playerActorId,
      primaryActorId: authority.simPrimaryActorId,
      actorNames,
      playerName: actorNames[playerActorId] ?? "the player",
      ragEligibility: authority.ragEligibility,
    },
  };
}

/**
 * The rolling dialogue tail the narrator responds to (oldest first). Assistant
 * lines are labeled NARRATION (previous), never a character — earlier replies may
 * have wrongly voiced the player's character and must read as narration output.
 * `excludeMessageId` drops one row (the reply a retake is re-rendering — it must
 * never read itself back). World-beat rows (slice 2 travel/skip/scene traces) are
 * skipped — they are a UI trace, never narration the model produced or should echo.
 * 30 lines (~15 exchanges) — the charter's history depth
 * (presentation-charter.plan.md §2 F11), on top of the R5 memory arc.
 */
async function loadSimDialogueTail(
  chatId: string,
  playerName: string,
  excludeMessageId?: string,
): Promise<{ speaker: string; text: string }[]> {
  const tailRows = await db()
    .select({
      id: characterChatMessages.id,
      role: characterChatMessages.role,
      content: characterChatMessages.content,
      meta: characterChatMessages.meta,
    })
    .from(characterChatMessages)
    .where(eq(characterChatMessages.chatId, chatId))
    .orderBy(desc(characterChatMessages.createdAt), desc(characterChatMessages.id))
    .limit(excludeMessageId ? 41 : 40);
  return tailRows
    .filter((row) => row.id !== excludeMessageId && !isWorldBeatMeta(row.meta))
    .slice(0, 30)
    .reverse()
    .map((row) => ({
      speaker: row.role === "user" ? `PLAYER (as ${playerName})` : "NARRATION (previous)",
      text: row.content,
    }));
}

/**
 * The presentation context both a fresh turn and a retake feed the narrator: §24
 * viewpoint recall (rag-gated, and only against a real utterance) plus the rolling
 * conversation summary. Both degrade to absent — a failed recall narrows context,
 * never fails the turn (docs/resilience.md).
 */
async function loadSimConversationContext(input: {
  chatId: string;
  branchId: string;
  viewpointActorId: string;
  message: string;
  ragEligibility: boolean;
  atStorySecond: number;
}): Promise<{ memory: string[]; conversationSummary: string }> {
  const memory =
    input.ragEligibility && input.message.trim().length > 0
      ? await recallViewpointMemory({
          chatId: input.chatId,
          branchId: input.branchId,
          viewpointActorId: input.viewpointActorId,
          message: input.message,
          atStorySecond: input.atStorySecond,
        })
      : [];
  const conversationSummary = await loadChatSummary(input.chatId)
    .then((row) => row?.summary ?? "")
    .catch(() => "");
  return { memory, conversationSummary };
}

/**
 * The rich charter context both a fresh turn and a retake feed the successor
 * narrator (presentation-charter.plan.md §2): the primary character's authored
 * profile, the player's persona, the sim wardrobe + §21 relationship projections,
 * and zone display names — plus the active narration shape. EVERY field is
 * best-effort — any single load failure degrades to that field being absent with a
 * log.warn, never a failed turn (docs/resilience.md). The player name always
 * carries (world-truth, no load); the narration shape is a pure lookup.
 */
interface SimPresentationInputs {
  primary?: { name: string; profile: CharacterProfile };
  player: { name: string; persona?: string; voice?: string; intimacy?: string };
  outfitLine?: string;
  relationship?: SimChatRelationship;
  zoneNames?: Record<string, string>;
  narrationShape: NarrationShapeId;
}

/** One `log.warn` shape for a degraded presentation load (never a thrown turn). */
function simLoadWarn(chatId: string, what: string, error: unknown): void {
  log.warn("engine.sim", what, { chatId, error: error instanceof Error ? error.message : String(error) });
}

/**
 * The primary's authored `CharacterProfile` from the chat's primary participant
 * (sort 0) — the AUTHORED CANON block's source, parsed with the degraded empty
 * default. A query failure narrows the prompt (no canon block), never fails it.
 */
async function loadSimPrimaryProfile(
  chatId: string,
  primaryName: string | undefined,
): Promise<{ name: string; profile: CharacterProfile } | undefined> {
  try {
    const [row] = await db()
      .select({ name: characters.name, profile: characters.profile })
      .from(chatParticipants)
      .innerJoin(characters, eq(characters.id, chatParticipants.characterId))
      .where(eq(chatParticipants.chatId, chatId))
      .orderBy(asc(chatParticipants.sort))
      .limit(1);
    if (!row) return undefined;
    const profile = parseOr(characterProfileSchema, row.profile ?? {}, emptyCharacterProfile(), undefined, "characters.profile");
    return { name: primaryName ?? row.name, profile };
  } catch (error) {
    simLoadWarn(chatId, "primary profile load degraded to absent", error);
    return undefined;
  }
}

/** The player persona's charter fields (persona/voice/intimacy); {} degrades to name-only. */
async function loadSimPlayerPersonaFields(
  userId: string,
  chatId: string,
): Promise<{ persona?: string; voice?: string; intimacy?: string }> {
  try {
    const persona = await resolveChatPersona({ ownerId: userId, chatId });
    return {
      ...(persona.persona?.trim() ? { persona: persona.persona } : {}),
      ...(persona.profile?.voice?.trim() ? { voice: persona.profile.voice } : {}),
      ...(persona.profile?.intimacy?.trim() ? { intimacy: persona.profile.intimacy } : {}),
    };
  } catch (error) {
    simLoadWarn(chatId, "player persona load degraded to name only", error);
    return {};
  }
}

/**
 * Zone display names by id for the branch — the humanized kind (`zoneDisplayNoun`,
 * the shared sim-surfaces map), so raw zone ids never reach the prose surface.
 * Unknown kinds are omitted (the render humanizes their id); absent on any failure.
 */
async function loadSimZoneNames(branchId: string, chatId: string): Promise<Record<string, string> | undefined> {
  try {
    const rows = await db()
      .select({ zoneId: simZones.zoneId, kind: simZones.kind })
      .from(simZones)
      .where(eq(simZones.branchId, branchId));
    const names: Record<string, string> = {};
    for (const row of rows) {
      const label = zoneDisplayNoun(row.kind);
      if (label) names[row.zoneId] = label;
    }
    return Object.keys(names).length > 0 ? names : undefined;
  } catch (error) {
    simLoadWarn(chatId, "zone display names degraded to absent", error);
    return undefined;
  }
}

/** Load the charter context once per exchange — all fields concurrent, each degrading alone. */
async function loadSimPresentationInputs(input: {
  chatId: string;
  userId: string;
  branchId: string;
  primaryActorId: string;
  actorNames: Record<string, string>;
  playerName: string;
}): Promise<SimPresentationInputs> {
  const [primary, personaFields, outfit, relationship, zoneNames] = await Promise.all([
    loadSimPrimaryProfile(input.chatId, input.actorNames[input.primaryActorId]),
    loadSimPlayerPersonaFields(input.userId, input.chatId),
    readSimChatOutfit(input.chatId).catch((error: unknown) => {
      simLoadWarn(input.chatId, "outfit projection degraded to absent", error);
      return null;
    }),
    readSimChatRelationship(input.chatId).catch((error: unknown) => {
      simLoadWarn(input.chatId, "relationship projection degraded to absent", error);
      return null;
    }),
    loadSimZoneNames(input.branchId, input.chatId),
  ]);
  const outfitLine = outfit?.trim();
  return {
    ...(primary ? { primary } : {}),
    player: { name: input.playerName, ...personaFields },
    ...(outfitLine ? { outfitLine } : {}),
    ...(relationship ? { relationship } : {}),
    ...(zoneNames ? { zoneNames } : {}),
    narrationShape: narrationShapeId("chat"),
  };
}

/**
 * Run one successor exchange for an OWNERSHIP-CHECKED chat (routing parity,
 * presentation-charter.plan.md §4). The `mode` picks the semantics; the authority
 * gate, world-truth names, dialogue tail, clock, memory/summary, render, and
 * persist are one shared path with mode-conditional steps:
 *
 * - **send** — land the player line, run input admission, advance the span, render
 *   a FRESH cut, persist a new assistant reply (existing behavior).
 * - **continue / open** — a real turn with NO player utterance (ruling 19): no
 *   user row, no admission, the span still advances (time moves), the render omits
 *   the player-turn block. `open` records `simOpening` on the reply meta.
 * - **retake** — re-render the SAME committed cut (regenerate/rerun, ruling 18):
 *   no user row, no admission, NO `prepareEngagementTurn` (time does not advance),
 *   the last assistant row replaced in place (mirroring legacy regenerate: content
 *   + browsable takes + meta on the same id).
 *
 * A withheld render leaves the transcript untouched (ruling 8). For send, the
 * player line persists BEFORE the scene gate: a refusal explains itself via
 * lastReplyFailure and never deletes what the player typed.
 */
export async function runSimChatExchange(input: {
  chatId: string;
  userId: string;
  speakerCharacterId: string;
  /** The primary character's display name — labels the dialogue tail. */
  speakerName?: string;
  /** Defaults to "send". */
  mode?: SimChatExchangeMode;
  /** The player's line — required for "send", ignored for the utterance-free modes. */
  message?: string;
  /**
   * The composer's Narrator input mode (`meta.inputMode`): a "narrator" send is
   * storyteller steering, not the player-character acting — it skips input
   * admission and reframes the player-turn block (parity with the legacy lane).
   */
  inputMode?: "player" | "narrator";
}): Promise<SimChatExchangeResult> {
  const resolved = await resolveSimExchange(input.chatId);
  if (!resolved.ok) return resolved.result;
  const mode = input.mode ?? "send";
  if (mode === "retake") {
    // A retake re-renders a committed cut — it mutates nothing and advances no time, so it is
    // allowed even while the world is catching up (the guard below is for real turns only).
    return runSimRetake({ chatId: input.chatId, userId: input.userId, ctx: resolved.ctx });
  }
  // A5 slice 4: a real turn advances the span and writes — turn it away while a durable time job
  // is catching this branch's world up. The in-process reply lock does not outlive the request
  // that started the job, so the durable job state is the guard (shared by the send + sim-turn
  // routes, since both funnel through here).
  if (await hasActiveTimeJob(resolved.ctx.branchId)) {
    return {
      ok: false,
      code: "world_catching_up",
      message: "the world is still catching up on this chat; try again in a moment",
      status: 409,
    };
  }
  return runSimTurn({
    chatId: input.chatId,
    userId: input.userId,
    speakerCharacterId: input.speakerCharacterId,
    mode,
    message: input.message,
    ...(input.inputMode === undefined ? {} : { inputMode: input.inputMode }),
    ctx: resolved.ctx,
  });
}

/**
 * The open-engagement rejection codes that mean the primary is genuinely NOT
 * co-present with the player — the trigger for the dual-block SOLO cut (ruling
 * 21). Every OTHER rejection (branch_mismatch, participant_not_found, …) is a
 * real fault and still surfaces the 409. `participant_unavailable` /
 * `participant_already_engaged` (primary present but busy / engaged elsewhere)
 * stay 409 in v1 — the solo vignette's "not here with you" framing would misread
 * a same-zone primary (world-ui.plan.md slice 0).
 */
const SOLO_CUT_OPEN_CODES = new Set(["participants_not_co_located", "participant_in_transit"]);

/** send / continue / open — a real turn that advances the span and renders a fresh cut. */
async function runSimTurn(input: {
  chatId: string;
  userId: string;
  speakerCharacterId: string;
  mode: "send" | "continue" | "open";
  message?: string;
  inputMode?: "player" | "narrator";
  ctx: ResolvedSimExchange;
}): Promise<SimChatExchangeResult> {
  const { chatId, ctx } = input;
  const { branchId, playerActorId, primaryActorId, actorNames, playerName } = ctx;
  // C15: one collector per turn, threaded through the choreography. Each degradation site
  // notes it (durable events row now + a public-safe code for the reply meta at persist).
  const fallbacks = new CompositionFallbackCollector(chatId);
  // continue/open carry no utterance (ruling 19) — only a send speaks.
  const message = input.mode === "send" ? (input.message ?? "").trim() : "";
  // A "narrator" send is storyteller steering (not the player-character acting):
  // it skips input admission and reframes the player-turn block (legacy parity).
  const narratorInput = input.mode === "send" && input.inputMode === "narrator";

  // The tail is read BEFORE any insert this turn (a fresh reply doesn't exist yet).
  const dialogueTail = await loadSimDialogueTail(chatId, playerName);

  // send: land the player line first (a later refusal never deletes it). The
  // utterance-free modes insert no user row (ruling 19).
  let userMessageId: string | null = null;
  if (input.mode === "send") {
    userMessageId = newId();
    await db().insert(characterChatMessages).values({
      id: userMessageId,
      chatId,
      speakerCharacterId: null,
      role: "user",
      content: message,
      meta: { simTurn: true, ...(narratorInput ? { inputMode: "narrator" } : {}) },
    });
  }

  const scene = await findOrOpenStandingEngagement({
    branchId,
    playerActorId,
    primaryActorId,
    userId: input.userId,
    correlationId: `sim-turn-${chatId}`,
  });
  // A genuine open fault (not "simply not co-present") still 409s. Otherwise the
  // turn runs — co-present (scene.ok) or the dual-block solo cut (ruling 21).
  if (!scene.ok && !SOLO_CUT_OPEN_CODES.has(scene.code)) {
    return { ok: false, code: "sim_open_failed", message: `the scene could not open: ${scene.publicReason}`, status: 409 };
  }

  // R5 input admission (send only, never in narrator mode): the player's own
  // words may BE a legal command. Pattern-match now (no submit) so the branches
  // below can route it before the scene resolves (a MOVE → the departure
  // choreography; an ACCOMPANY → walk-with-me).
  const admitted =
    input.mode === "send" && !narratorInput && message.length > 0
      ? await admitPlayerCommandForChat({ branchId, playerActorId, message })
      : { command: null, zones: [] };
  const command = admitted.command;

  // Walk-with-me (world-ui.plan.md slice 5): an admitted ACCOMPANY while the
  // primary is co-present runs the acceptance policy + shared choreography, then
  // renders at the destination (co-presence restored ⇒ the co-present renderer).
  if (command?.kind === "accompany" && scene.ok) {
    return runSimAccompanyTurn({
      chatId,
      userId: input.userId,
      speakerCharacterId: input.speakerCharacterId,
      mode: input.mode,
      message,
      ctx,
      command,
      zones: admitted.zones,
      sceneEngagementId: scene.engagementId,
      dialogueTail,
      userMessageId,
      fallbacks,
    });
  }

  // A chosen DEPARTURE (world-ui.plan.md slice 4): an admitted MOVE, or an
  // accompany with the partner ABSENT — inviting an absent partner is future work
  // (the §14.2 remote-invite family), so it degrades to a plain solo move.
  const departureMove: Extract<AdmittedCommand, { kind: "move" }> | null =
    command?.kind === "move"
      ? command
      : command?.kind === "accompany"
        ? { kind: "move", toZoneId: command.toZoneId, placeWord: command.placeWord }
        : null;
  if (departureMove) {
    return runSimDepartureTurn({
      chatId,
      userId: input.userId,
      speakerCharacterId: input.speakerCharacterId,
      mode: input.mode,
      message,
      ctx,
      command: departureMove,
      zones: admitted.zones,
      plan: planDepartureChoreography({ admittedKind: "move", sceneStands: scene.ok }),
      sceneEngagementId: scene.ok ? scene.engagementId : null,
      dialogueTail,
      userMessageId,
      fallbacks,
    });
  }

  // Not a departure. The primary is NOT co-present ⇒ the dual-block solo cut;
  // give/rest admissions keep today's flow (never submitted from the solo path).
  if (!scene.ok) {
    return runSimSoloTurn({
      chatId,
      userId: input.userId,
      speakerCharacterId: input.speakerCharacterId,
      mode: input.mode,
      message,
      narratorInput,
      ctx,
      userMessageId,
      dialogueTail,
      fallbacks,
    });
  }

  // The primary is co-present. Submit an admitted give/rest (its §14.4 outcome
  // reaches the narrator), then render the shared co-present turn.
  const coPresentCommand =
    command?.kind === "give_item" || command?.kind === "start_activity" ? command : null;
  const admission =
    coPresentCommand !== null
      ? await admitIntoCoPresentTurn(
          {
            chatId,
            userId: input.userId,
            branchId,
            playerActorId,
            primaryActorId,
            playerName,
            primaryName: actorNames[primaryActorId] ?? "them",
          },
          coPresentCommand,
          admitted.zones,
        )
      : null;
  return runCoPresentTurn({
    chatId,
    userId: input.userId,
    speakerCharacterId: input.speakerCharacterId,
    mode: input.mode,
    message,
    narratorInput,
    ctx,
    engagementId: scene.engagementId,
    admission,
    dialogueTail,
    userMessageId,
    fallbacks,
  });
}

/**
 * The co-present turn body (the primary is here to react): prepare the engagement
 * cut, load context, render, and persist. Split out of `runSimTurn` so the
 * departure choreography's interrupt fallback (slice 4) can reuse it verbatim.
 */
async function runCoPresentTurn(input: {
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
      // The opening-directive flag a later prompt slice reads (§4).
      ...(input.mode === "open" ? { simOpening: true } : {}),
      ...(rendered.confirmStatus === undefined ? {} : { confirmStatus: rendered.confirmStatus }),
      // C15 surface a: public-safe codes only (ruling 2) — open a degraded beat and see why.
      ...(input.fallbacks && input.fallbacks.codes().length ? { compositionFallbacks: input.fallbacks.codes() } : {}),
    },
  });
  // R5 knowledge/memory: fold the conversation forward — self-dedupes below its trigger.
  void enqueueChatSummary({ chatId });
  return {
    ok: true,
    messageId: assistantMessageId,
    prose: rendered.prose,
    cutId: rendered.cutId,
    modelId: rendered.modelId,
    attempts: rendered.attempts,
    degraded: rendered.degraded,
    diagnostics: rendered.diagnostics,
  };
}

/**
 * world-ui.plan.md slice 4 — the graceful-departure choreography behind an
 * admitted natural-language MOVE (the NL twin of the travel chip; closes ruling
 * 20's parity clause and the R5 "scene-exit choreography for language-driven
 * departures" leftover). The player CHOSE to leave, so:
 *
 * 1. END the standing scene as a CHOICE (`participant_choice`) — the same lawful
 *    two-step `advance_time` performs. An ended scene holds no claim (spec §18.2),
 *    so the move that follows fires NO hard interrupt: a parting, not a rupture.
 * 2. submit the move; 3. drain the clock to the journey's earliest arrival (ruling
 *    20); 4. leave ONE traveled beat phrased with the parting; 5. render the
 *    goodbye + walk + arrival through the SOLO renderer with a departure context.
 *
 * Degrades per docs/resilience.md — never a dead turn:
 * - the end-engagement step failing unexpectedly falls back to today's interrupt
 *   path (the still-standing scene is interrupted by the accepted move, the
 *   co-present cut renders "set off walking");
 * - a refused/undone move keeps today's behavior (no world change; a plain solo
 *   turn renders — the player is where they were).
 */
async function runSimDepartureTurn(input: {
  chatId: string;
  userId: string;
  speakerCharacterId: string;
  mode: "send" | "continue" | "open";
  message: string;
  ctx: ResolvedSimExchange;
  command: Extract<AdmittedCommand, { kind: "move" }>;
  zones: { zoneId: string; kind: string }[];
  plan: ReturnType<typeof planDepartureChoreography>;
  sceneEngagementId: string | null;
  dialogueTail: { speaker: string; text: string }[];
  userMessageId: string | null;
  fallbacks?: CompositionFallbackCollector;
}): Promise<SimChatExchangeResult> {
  const { chatId, ctx, command, plan } = input;
  const { branchId, playerActorId, primaryActorId, actorNames, playerName } = ctx;
  const primaryName = actorNames[primaryActorId] ?? "them";
  const zoneKindOf = (zoneId: string): string => input.zones.find((zone) => zone.zoneId === zoneId)?.kind ?? "";
  const toLabel = zoneLabelFromKind(command.toZoneId, zoneKindOf(command.toZoneId));

  const soloArgs = {
    chatId,
    userId: input.userId,
    speakerCharacterId: input.speakerCharacterId,
    mode: input.mode,
    message: input.message,
    narratorInput: false,
    ctx,
    userMessageId: input.userMessageId,
    dialogueTail: input.dialogueTail,
    ...(input.fallbacks ? { fallbacks: input.fallbacks } : {}),
  };

  // The zone the player is leaving (for the departure context). Read once here;
  // runSimSoloTurn re-reads the settled space to place the player at the arrival.
  let fromLabel = "";
  try {
    const preMove = await readDurableSpaceBranch(branchId);
    const fromLocus = preMove.loci.find((locus) => locus.actorId === playerActorId);
    if (fromLocus?.kind === "at") fromLabel = zoneLabelFromKind(fromLocus.zoneId, zoneKindOf(fromLocus.zoneId));
  } catch (error) {
    simLoadWarn(chatId, "departure from-zone read degraded", error);
  }

  const envelopeBase = {
    branchId,
    expectedVersion: 0,
    principal: { kind: "player" as const, principalId: input.userId, controlledActorIds: [playerActorId] },
    submittedAtWallClock: new Date().toISOString(),
    correlationId: `sim-departure-${chatId}`,
    schemaVersion: 1,
  };

  // 1) End the standing scene as a CHOICE. An unexpected failure degrades to
  //    today's interrupt path: the accepted move interrupts the scene and the
  //    co-present cut renders — no farewell framing, no parted beat.
  if (plan.endSceneFirst && input.sceneEngagementId !== null) {
    const endId = newId();
    let ended: Awaited<ReturnType<typeof submitDurableEndEngagement>> | undefined;
    try {
      ended = await submitDurableEndEngagement(
        {
          ...envelopeBase,
          id: endId,
          idempotencyKey: endId,
          type: "end_engagement",
          payload: { engagementId: input.sceneEngagementId, reason: "participant_choice" },
        },
        { admitAtLockedVersion: true },
      );
    } catch (error) {
      simLoadWarn(chatId, "departure end-engagement threw — interrupt fallback", error);
    }
    if (ended?.status !== "accepted") {
      log.warn("engine.sim.departure", "end-engagement not accepted; interrupt fallback", {
        chatId,
        status: ended?.status ?? "threw",
      });
      input.fallbacks?.note({
        site: "departure",
        code: "end_engagement_fallback",
        detail: `end-engagement ${ended?.status ?? "threw"}`,
      });
      const admission = await admitIntoCoPresentTurn(
        { chatId, userId: input.userId, branchId, playerActorId, primaryActorId, playerName, primaryName },
        command,
        input.zones,
      );
      return runCoPresentTurn({
        chatId,
        userId: input.userId,
        speakerCharacterId: input.speakerCharacterId,
        mode: input.mode,
        message: input.message,
        narratorInput: false,
        ctx,
        engagementId: input.sceneEngagementId,
        admission,
        dialogueTail: input.dialogueTail,
        userMessageId: input.userMessageId,
        ...(input.fallbacks ? { fallbacks: input.fallbacks } : {}),
      });
    }
  }

  // 2) Submit the move. A refusal / conflict keeps today's behavior (no world
  //    change) — render a plain solo turn (never a dead turn).
  const moveId = newId();
  let move: Awaited<ReturnType<typeof submitDurableMoveActor>> | undefined;
  try {
    move = await submitDurableMoveActor(
      {
        ...envelopeBase,
        id: moveId,
        idempotencyKey: moveId,
        type: "move_actor",
        payload: { actorId: playerActorId, destinationZoneId: command.toZoneId, travelMode: "walk" },
      },
      { admitAtLockedVersion: true },
    );
  } catch (error) {
    simLoadWarn(chatId, "departure move threw — plain solo render", error);
  }
  if (move?.status !== "accepted") {
    if (move?.status === "rejected") {
      // Unreachable in the starter world when a scene had already been ended
      // above (a standing scene rules out the body claim a walk could refuse, and
      // the two zones are adjacent); render a plain solo turn regardless.
      log.warn("engine.sim.departure", "move not accepted; plain solo render", { chatId, code: move.code });
    }
    input.fallbacks?.note({
      site: "departure",
      code: "move_rejected_solo_render",
      detail: `move ${move?.status ?? "threw"}${move?.status === "rejected" ? ` code=${move.code}` : ""}`,
    });
    return runSimSoloTurn(soloArgs);
  }

  // 3) Walk the player there: drain the clock to the journey's expected arrival
  //    (ruling 20, A7). A divergent drain degrades to the current clock — the arrival
  //    trigger simply settles on a later turn (never a dead turn).
  const target = await moveArrivalTarget(branchId, playerActorId);
  const drain = await drainBranchTo(branchId, target);
  if (!drain.converged) {
    log.warn("engine.sim.departure", "arrival drain did not converge", { chatId, reason: drain.shortReason });
  }
  noteDrainDiagnostics(input.fallbacks, "departure", drain);
  // A7 arrival check: if the player never left transit, record it and let a later beat settle it.
  const departureSettled = await readDurableSpaceBranch(branchId);
  noteStillInTransit(input.fallbacks, "departure", departureSettled.loci, [playerActorId], chatId);

  // 4) ONE traveled beat, phrased with the parting when a scene was ended.
  await writeWorldBeat({ chatId, branchId, kind: "traveled", destinationLabel: toLabel, parted: plan.parted });

  // 5) Render the arrival through the solo cut with the departure arc.
  const departure: SoloDeparture = {
    ...(plan.farewell ? { farewellFrom: primaryName } : {}),
    fromLabel,
    toLabel,
  };
  return runSimSoloTurn({ ...soloArgs, departure });
}

/**
 * world-ui.plan.md slice 5 — the WALK-WITH-ME choreography (world writes only;
 * the two entry points render differently). When the player and the co-present
 * primary set off together, this composes ONE interaction (§39 ruling 20):
 *
 * 1. NPC AGENCY via the bounded deterministic policy (`decideAccompany`, no model
 *    call, no consent-ledger touch): accept unless a body claim occupies the
 *    primary or a firm/hard commitment falls due before arrival + a buffer. A
 *    decline returns an honest §14.4 PUBLIC face (no private cause).
 * 2. On acceptance: END the standing scene as a CHOICE (grace, §18.2), submit the
 *    PLAYER's move (player principal), then the PRIMARY's move under an
 *    `npc_policy` principal controlling the primary — the NPC's OWN controller
 *    acting on the accepted invite (§14.2 — the player principal is NEVER
 *    authorized to move an NPC; `resolveMoveActor` rejects `unauthorized_actor`).
 * 3. Drain to the LATER of the two journeys' earliest arrivals (§17), then leave
 *    ONE `together` world beat. Co-presence is restored at the destination.
 *
 * Degradation (docs/resilience.md), never a dead turn:
 * - the NPC move failing AFTER the player's move committed is a divergence — the
 *   player still travels (their move stands), the beat is the PLAIN traveled beat,
 *   a diagnostic logs, and the caller falls to the solo render (`traveled_alone`);
 * - an unexpected end-engagement failure degrades to the interrupt path (the
 *   accepted moves still lawfully interrupt the standing scene);
 * - a refused player move keeps today's behavior (no travel) and returns `rejected`.
 */
export type AccompanyResult =
  | { status: "accompanied"; toStorySecond: number; arrived: boolean; fromLabel: string; toLabel: string }
  | { status: "traveled_alone"; toStorySecond: number; arrived: boolean; fromLabel: string; toLabel: string }
  | { status: "declined"; publicReason: string; legalAlternatives: string[] }
  | { status: "rejected"; code: string; publicReason: string; legalAlternatives: string[] }
  | { status: "not_copresent" };

export async function runAccompanyTogether(input: {
  chatId: string;
  userId: string;
  branchId: string;
  playerActorId: string;
  primaryActorId: string;
  primaryName: string;
  toZoneId: string;
  /** C15: collector for surface (b) events rows + the codes stamped on the beat this writes. */
  fallbacks?: CompositionFallbackCollector;
}): Promise<AccompanyResult> {
  const { chatId, userId, branchId, playerActorId, primaryActorId, primaryName, toZoneId } = input;

  // 0) Pre-move world truth: where both actors are, the walk estimate, and the
  //    primary's activities/commitments (the acceptance policy's inputs).
  const [space, activities, commitments] = await Promise.all([
    readDurableSpaceBranch(branchId),
    readDurableActivities(branchId),
    readDurableCommitments(branchId),
  ]);
  const kindByZone = new Map<string, string>(space.zones.map((zone) => [zone.id, zone.kind]));
  const zoneKindOf = (zoneId: string): string => kindByZone.get(zoneId) ?? "";
  const toLabel = zoneLabelFromKind(toZoneId, zoneKindOf(toZoneId));
  const playerLocus = space.loci.find((locus) => locus.actorId === playerActorId);
  const primaryLocus = space.loci.find((locus) => locus.actorId === primaryActorId);
  const fromLabel =
    playerLocus?.kind === "at" ? zoneLabelFromKind(playerLocus.zoneId, zoneKindOf(playerLocus.zoneId)) : "";

  // Both must be physically co-present to walk together (§14.2 — the invite is
  // only meaningful in each other's presence). Not co-present ⇒ the caller falls
  // back to a plain solo move (the remote-invite family is future work).
  if (
    !playerLocus ||
    playerLocus.kind !== "at" ||
    !primaryLocus ||
    primaryLocus.kind !== "at" ||
    primaryLocus.zoneId !== playerLocus.zoneId
  ) {
    return { status: "not_copresent" };
  }

  // The walk's earliest arrival estimate from the current zone's open link (the
  // SAME pure helper the world card's travel chip reads its "~N min" from), so the
  // commitment gate can judge what leaving now risks. No direct link ⇒ arrival
  // "now" (the most conservative gate — a multi-hop world is future work).
  const walkSeconds =
    buildWorldDestinations({ playerLocus, links: space.links, zoneLabelOf: () => "" }).find(
      (destination) => destination.zoneId === toZoneId,
    )?.travelSeconds ?? 0;
  const arrivalStorySecond = space.storySecond + walkSeconds;

  // 1) NPC agency — accept or an honest §14.4 decline (built from PUBLIC facts only).
  const decision = decideAccompany({
    primaryActorId,
    primaryName,
    activities: activities.activities,
    commitments: commitments.commitments,
    arrivalStorySecond,
  });
  if (!decision.accept) {
    return { status: "declined", publicReason: decision.publicReason, legalAlternatives: decision.legalAlternatives };
  }

  const playerPrincipal = { kind: "player" as const, principalId: userId, controlledActorIds: [playerActorId] };
  const envelopeBase = {
    branchId,
    expectedVersion: 0,
    submittedAtWallClock: new Date().toISOString(),
    correlationId: `sim-accompany-${chatId}`,
    schemaVersion: 1,
  };

  // 2) End the standing scene as a CHOICE (grace, §18.2 — an ended scene holds no
  //    claim, so the moves fire no hard interrupt). A miss degrades to the
  //    interrupt path (never blocks the walk).
  const standing = await findStandingEngagement(branchId, playerActorId, primaryActorId);
  if (standing.engagementId !== null) {
    const endId = newId();
    const ended = await submitDurableEndEngagement(
      {
        ...envelopeBase,
        id: endId,
        idempotencyKey: endId,
        principal: playerPrincipal,
        type: "end_engagement",
        payload: { engagementId: standing.engagementId, reason: "participant_choice" },
      },
      { admitAtLockedVersion: true },
    );
    if (ended.status !== "accepted") {
      log.warn("engine.sim.accompany", "end-engagement not accepted; interrupt fallback", { chatId, status: ended.status });
      input.fallbacks?.note({ site: "accompany", code: "end_engagement_fallback", detail: `end-engagement ${ended.status}` });
    }
  }

  // 3a) The PLAYER's move (player principal — never moves the NPC, §14.2).
  const playerMoveId = newId();
  const playerMove = await submitDurableMoveActor(
    {
      ...envelopeBase,
      id: playerMoveId,
      idempotencyKey: playerMoveId,
      principal: playerPrincipal,
      type: "move_actor",
      payload: { actorId: playerActorId, destinationZoneId: toZoneId, travelMode: "walk" },
    },
    { admitAtLockedVersion: true },
  );
  if (playerMove.status === "rejected") {
    return {
      status: "rejected",
      code: playerMove.code,
      publicReason: playerMove.publicReason,
      legalAlternatives: [...(playerMove.legalAlternativeCommandTypes ?? [])].map(String).slice(0, 16),
    };
  }
  if (playerMove.status !== "accepted") {
    return { status: "rejected", code: "sim_conflict", publicReason: "The world moved; try again.", legalAlternatives: [] };
  }

  // 3b) The PRIMARY's move (npc_policy principal controlling the primary — the
  //     NPC's own controller acting on the accepted invite, §14.2). A divergence
  //     here degrades honestly: the player still travels, ALONE (`traveled_alone`).
  const primaryMoveId = newId();
  let primaryMove: Awaited<ReturnType<typeof submitDurableMoveActor>> | undefined;
  try {
    primaryMove = await submitDurableMoveActor(
      {
        ...envelopeBase,
        id: primaryMoveId,
        idempotencyKey: primaryMoveId,
        principal: { kind: "npc_policy" as const, principalId: "sim-accompany", controlledActorIds: [primaryActorId] },
        type: "move_actor",
        payload: { actorId: primaryActorId, destinationZoneId: toZoneId, travelMode: "walk" },
      },
      { admitAtLockedVersion: true },
    );
  } catch (error) {
    simLoadWarn(chatId, "accompany primary move threw — player travels alone", error);
  }
  const together = primaryMove?.status === "accepted";
  if (!together) {
    log.warn("engine.sim.accompany", "primary move not accepted; player travels alone", {
      chatId,
      status: primaryMove?.status ?? "threw",
    });
    input.fallbacks?.note({ site: "accompany", code: "traveled_alone", detail: `primary move ${primaryMove?.status ?? "threw"}` });
  }

  // 4) Drain to the LATER of the two expected arrivals (both share the link, but
  //    compute each defensively; A7) — the §17 arrival trigger fires inside the drain.
  const playerTarget = await moveArrivalTarget(branchId, playerActorId);
  const primaryTarget = together ? await moveArrivalTarget(branchId, primaryActorId) : playerTarget;
  const target = Math.max(playerTarget, primaryTarget);
  const drain = await drainBranchTo(branchId, target);
  if (!drain.converged) {
    log.warn("engine.sim.accompany", "arrival drain did not converge", { chatId, reason: drain.shortReason });
  }
  noteDrainDiagnostics(input.fallbacks, "accompany", drain);

  // A7 arrival check (read settled ONCE, before the beat, so both actors' in-transit state and
  // `arrived` come from the same read and any still_in_transit code lands on the beat too).
  const settled = await readDurableSpaceBranch(branchId);
  noteStillInTransit(
    input.fallbacks,
    "accompany",
    settled.loci,
    together ? [playerActorId, primaryActorId] : [playerActorId],
    chatId,
  );

  // 5) ONE world beat — "together" on a real co-travel, else the plain traveled beat.
  //    C15: stamp any codes this choreography collected onto the beat's meta (surface a).
  await writeWorldBeat({
    chatId,
    branchId,
    kind: "traveled",
    destinationLabel: toLabel,
    ...(together ? { together: true } : {}),
    ...(input.fallbacks && input.fallbacks.codes().length ? { fallbacks: input.fallbacks.codes() } : {}),
  });

  const arrived = settled.loci.some(
    (locus) => locus.actorId === playerActorId && locus.kind === "at" && locus.zoneId === toZoneId,
  );
  return { status: together ? "accompanied" : "traveled_alone", toStorySecond: target, arrived, fromLabel, toLabel };
}

/**
 * world-ui.plan.md slice 5 — the natural-language twin of the walk-together chip.
 * An admitted ACCOMPANY while co-present runs the shared `runAccompanyTogether`
 * choreography and then RENDERS:
 * - ACCEPTED ⇒ co-presence is restored at the destination, so reopen the scene
 *   and render the CO-PRESENT turn with a travel-context line (you two just walked
 *   here together from X) — the scene continues in prose, not a jump-cut;
 * - DECLINED ⇒ the scene still stands; render the ordinary co-present turn with
 *   the decline as a §14.4 failure presentation (she answers in character);
 * - a divergence (`traveled_alone`) or an unexpected reopen failure ⇒ the player
 *   is where they arrived; render a plain solo turn (never a dead turn).
 */
async function runSimAccompanyTurn(input: {
  chatId: string;
  userId: string;
  speakerCharacterId: string;
  mode: "send" | "continue" | "open";
  message: string;
  ctx: ResolvedSimExchange;
  command: Extract<AdmittedCommand, { kind: "accompany" }>;
  zones: { zoneId: string; kind: string }[];
  sceneEngagementId: string;
  dialogueTail: { speaker: string; text: string }[];
  userMessageId: string | null;
  fallbacks?: CompositionFallbackCollector;
}): Promise<SimChatExchangeResult> {
  const { chatId, ctx, command } = input;
  const { branchId, playerActorId, primaryActorId, actorNames, playerName } = ctx;
  const primaryName = actorNames[primaryActorId] ?? "them";

  const outcome = await runAccompanyTogether({
    chatId,
    userId: input.userId,
    branchId,
    playerActorId,
    primaryActorId,
    primaryName,
    toZoneId: command.toZoneId,
    ...(input.fallbacks ? { fallbacks: input.fallbacks } : {}),
  });

  // A decline (or a rare player-move refusal): the scene still stands. Render the
  // co-present turn with the §14.4 face — the primary answers the invite in character.
  if (outcome.status === "declined" || outcome.status === "rejected") {
    const failure: PublicFailurePresentation = {
      code: outcome.status === "declined" ? "accompany_declined" : outcome.code,
      publicReason: outcome.publicReason,
      publicEvidence: [],
      legalAlternatives: outcome.legalAlternatives.slice(0, 16),
    };
    return runCoPresentTurn({
      chatId,
      userId: input.userId,
      speakerCharacterId: input.speakerCharacterId,
      mode: input.mode,
      message: input.message,
      narratorInput: false,
      ctx,
      engagementId: input.sceneEngagementId,
      admission: { failure },
      dialogueTail: input.dialogueTail,
      userMessageId: input.userMessageId,
      ...(input.fallbacks ? { fallbacks: input.fallbacks } : {}),
    });
  }

  const soloArgs = {
    chatId,
    userId: input.userId,
    speakerCharacterId: input.speakerCharacterId,
    mode: input.mode,
    message: input.message,
    narratorInput: false,
    ctx,
    userMessageId: input.userMessageId,
    dialogueTail: input.dialogueTail,
    ...(input.fallbacks ? { fallbacks: input.fallbacks } : {}),
  };

  // not_copresent shouldn't reach here (a standing scene implies co-presence), but
  // degrade to a plain solo turn if it does — never a dead turn.
  if (outcome.status === "not_copresent") return runSimSoloTurn(soloArgs);

  const departure: SoloDeparture = { fromLabel: outcome.fromLabel, toLabel: outcome.toLabel };

  // A divergence — the primary didn't come. The player arrived ALONE; render the
  // solo cut at the destination (co-presence NOT restored; the plain beat is written).
  if (outcome.status === "traveled_alone") return runSimSoloTurn({ ...soloArgs, departure });

  // Accepted: co-presence restored at the destination. Reopen the scene there and
  // render the CO-PRESENT turn with a travel-context line so it continues in prose.
  const scene = await findOrOpenStandingEngagement({
    branchId,
    playerActorId,
    primaryActorId,
    userId: input.userId,
    correlationId: `sim-accompany-${chatId}`,
  });
  if (!scene.ok) {
    log.warn("engine.sim.accompany", "co-present scene did not reopen after arrival; solo render", {
      chatId,
      code: scene.code,
    });
    input.fallbacks?.note({ site: "accompany", code: "scene_reopen_failed", detail: `reopen ${scene.code}` });
    return runSimSoloTurn({ ...soloArgs, departure });
  }
  const travelContext = outcome.fromLabel
    ? `${playerName} and ${primaryName} have just walked to ${placeGoPhrase(outcome.toLabel)} together from ${placeGoPhrase(outcome.fromLabel)}, and are here now.`
    : `${playerName} and ${primaryName} have just walked to ${placeGoPhrase(outcome.toLabel)} together, and are here now.`;
  return runCoPresentTurn({
    chatId,
    userId: input.userId,
    speakerCharacterId: input.speakerCharacterId,
    mode: input.mode,
    message: input.message,
    narratorInput: false,
    ctx,
    engagementId: scene.engagementId,
    admission: { executed: travelContext },
    dialogueTail: input.dialogueTail,
    userMessageId: input.userMessageId,
    ...(input.fallbacks ? { fallbacks: input.fallbacks } : {}),
  });
}

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
 * Assemble the dual-block solo context from the sim projections (ruling 21),
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
}): Promise<{ context: SoloCutContext | null; diagnostics: string[] }> {
  const diagnostics: string[] = [];
  const actorNameOf = (actorId: string): string => input.actorNames[actorId] ?? humanizeId(actorId);

  let space: Awaited<ReturnType<typeof readDurableSpaceBranch>>;
  try {
    space = await readDurableSpaceBranch(input.branchId);
  } catch (error) {
    simLoadWarn(input.chatId, "solo space read failed — minimal narration", error);
    return { context: null, diagnostics: ["engine.sim.solo.space_read_failed"] };
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
 * The SOLO cut (world-ui.plan.md slice 0, ruling 21): a turn that runs when the
 * primary is NOT co-present. Time still moves — the branch clock advances the
 * ordinary 60s span and drains due triggers (that is how an in-transit player
 * eventually arrives, ruling 19's "time is the medium") — and the render is
 * dual-block: the player's own moment plus an away vignette of the primary's
 * routine. The user row (for a send) is already persisted by the caller. This
 * path NEVER dead-ends: every context source degrades and the narrator falls
 * back to a deterministic minimal narration.
 */
async function runSimSoloTurn(input: {
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
  /** C15: composition-fallback collector threaded from the turn entry (may be absent). */
  fallbacks?: CompositionFallbackCollector;
}): Promise<SimChatExchangeResult> {
  const { chatId, ctx } = input;
  const { branchId, playerActorId, primaryActorId, actorNames, playerName } = ctx;
  const primaryName = actorNames[primaryActorId] ?? "them";

  // Time moves: advance the ordinary span and drain due triggers. A failure here
  // degrades to rendering at the current clock, never a failed turn. A departure
  // turn already drained to the arrival, so it does NOT advance again (that would
  // over-count the parting past the moment the player just arrived).
  const before = await readBranchClock(branchId);
  if (input.departure === undefined) {
    try {
      await advanceBranchStoryTime(branchId, (before?.storySecond ?? 0) + 60, {
        workerId: `sim-solo-${chatId}`,
        database: db(),
      });
    } catch (error) {
      simLoadWarn(chatId, "solo story-time advance degraded", error);
    }
  }
  const clock = (await readBranchClock(branchId)) ?? before;
  const atStorySecond = clock?.storySecond ?? 0;

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
  const { system, prompt } = buildSimSoloRenderPrompt({
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
  });

  const rendered = await renderSoloNarration({ system, prompt, fallbackProse });
  if (rendered.status !== "rendered" || rendered.prose === undefined) {
    return { ok: false, code: "render_withheld", message: "the narrator could not render this turn; try again", status: 503 };
  }

  const diagnostics = [...solo.diagnostics, ...rendered.diagnostics];
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

/**
 * retake (regenerate/rerun, ruling 18) — re-render the SAME committed cut: same
 * events, fresh prose. NO time advance, NO admission, NO new transcript rows; the
 * last assistant reply is replaced in place (content + browsable takes + meta),
 * exactly the row semantics the legacy regenerate gives the client.
 */
async function runSimRetake(input: { chatId: string; userId: string; ctx: ResolvedSimExchange }): Promise<SimChatExchangeResult> {
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
  // engagement's newest persisted cut (ruling 18 fallback).
  const metaCutId = parseOr(simReplyMetaSchema, target.meta, {}, undefined, "character_chat_messages.meta").cutId;
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
  // fresh render is active (spec §4.1 — the same transcript semantics legacy gives).
  const priorTakes = parseOr(replyTakesSchema, target.takes, emptyReplyTakes(), undefined, "character_chat_messages.takes");
  const nextTakes = pushReplyTake(priorTakes, target.content, rendered.prose, new Date().toISOString());
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
    diagnostics: rendered.diagnostics,
  };
}
