import { diag } from "@/contracts/diagnostics";
import type { SessionRuntime } from "@/contracts/state/session-runtime";
import type { ContinuityResult, SimulantResult } from "@/contracts/turns/agent-results";
import { minuteOfDay, resolveGameTime } from "@/lib/clock";
import type { BundlePlace } from "../bundle";
import { FALLBACK_MINUTES_ADVANCED, PENDING_COMMS_CAP } from "../constants";
import { effectiveMeterDefinitions } from "../scene";
import { pickBest, resolveItemByName, resolveSessionLocation, type ItemAction } from "./grounding";
import type { MergeMode, MergePlan, Phase, PhaseContext, PlanInput } from "./types";
import { WorkingState, type WorkingItem } from "./working-state";
import { phaseActivities } from "./phases/activities";
import { phaseAffinity, phaseAffinityDecay, phaseThresholdHints } from "./phases/affinity";
import { phaseAttributes } from "./phases/attributes";
import { phaseBrief } from "./phases/brief";
import { phaseClockAndMeters } from "./phases/meters";
import { phaseComms } from "./phases/comms";
import { phaseConditions } from "./phases/conditions";
import { phaseFactsEpisode, phaseLore } from "./phases/facts";
import { phaseItemEvents } from "./phases/items";
import { phaseMovements } from "./phases/movement";
import { phaseReactions } from "./phases/reactions";
import { phaseScheduleTick } from "./phases/schedule";
import { phaseThreads } from "./phases/threads";
import { phaseWitness } from "./phases/witness";

/**
 * The merge reducer's deterministic planning half (docs/turn-engine.md §Merge
 * reducer): build the WorkingState ADT from the bundle, run the ordered phase
 * pipeline over it, then package the MergePlan. The DB-write half lives in
 * apply.ts. See merge-decomposition.spec.md §3.3 for the phase contract.
 */

const SIMULANT_FALLBACK: SimulantResult = {
  minutesAdvanced: FALLBACK_MINUTES_ADVANCED,
  movements: [],
  itemEvents: [],
  meterAdjustments: [],
  conditionEvents: [],
  attributeChanges: [],
  activityUpdates: [],
  affinityAdjustments: [],
  commsEvents: [],
};

const CONTINUITY_FALLBACK: ContinuityResult = { violations: [], cardBreaches: [], driftNotes: [] };

function createPhaseContext(input: PlanInput, state: WorkingState): PhaseContext {
  const { bundle, sink } = input;
  const mode: MergeMode = input.mode ?? "post_turn";

  const simulant = input.results.simulant ?? SIMULANT_FALLBACK;
  if (!input.results.simulant) {
    sink.push(diag("warn", "merge.simulant.degraded", "simulant failed — no state changes; clock advances by fallback"));
  }
  const continuity = input.results.continuity ?? CONTINUITY_FALLBACK;

  const resolveLocation = async (name: string): Promise<BundlePlace | null> => {
    const direct = resolveSessionLocation(name, bundle.locations);
    if (direct) return direct;
    if (!input.deps?.resolveLibraryLocation) return null;
    try {
      const match = await input.deps.resolveLibraryLocation(name);
      if (!match) return null;
      return bundle.locations.find((l) => l.locationId === match.id) ?? null;
    } catch {
      return null;
    }
  };

  const resolveItem = async (
    name: string,
    action: ItemAction,
    actor: { id: string; locationId: string | null } | null,
  ): Promise<WorkingItem | null> => {
    const direct = resolveItemByName(name, action, state.items, actor);
    if (direct) return direct;
    if (!input.deps?.resolveLibraryItem) return null;
    try {
      const match = await input.deps.resolveLibraryItem(name);
      if (!match) return null;
      return pickBest(state.items.filter((i) => i.itemId === match.id), action, actor);
    } catch {
      return null;
    }
  };

  return {
    bundle,
    turn: input.turn,
    results: input.results,
    simulant,
    continuity,
    mode,
    reconcile: mode === "reconcile",
    sink,
    deps: input.deps,
    logMissesForSessionId: input.logMissesForSessionId,
    defs: effectiveMeterDefinitions(bundle.style),
    turnStartMinute: minuteOfDay(resolveGameTime(bundle.clockMinutes, bundle.style.calendarStart)),
    resolveLocation,
    resolveItem,
    playerTravelMinutes: 0,
    minutes: 0,
    minutesCause: "reconcile",
    clockMinutes: bundle.clockMinutes,
    moodAtTurnStart: new Map(),
    hintsBefore: new Map(),
    reactionResult: null,
    stagedIntents: bundle.runtime.stagedIntents,
    factDrafts: [],
    episodeSummary: "",
    syntheticEpisode: false,
    threads: bundle.runtime.storyThreads,
    touchedThreadIds: [],
    newlyUnlocked: [],
    witnessedBy: [],
    interacted: new Set(),
    visitedLocationIds: [],
    encounteredParticipantIds: [],
    lastInteractedTurn: {},
    comms: { links: bundle.runtime.commsLinks, changes: [] },
    affinityDecay: null,
    thresholdHints: [],
    breachResult: { updates: [], ownedEdgeKeys: new Set<string>(), directives: [] },
    affinityUpdates: [],
    brief: bundle.brief,
  };
}

/** Assemble the persisted runtime from the bundle + the camera-following pieces. */
function buildRuntime(ctx: PhaseContext, state: WorkingState): SessionRuntime {
  const { bundle, reconcile } = ctx;
  return {
    ...bundle.runtime,
    storyThreads: ctx.threads,
    visitedLocationIds: ctx.visitedLocationIds,
    encounteredParticipantIds: ctx.encounteredParticipantIds,
    unlockedLoreIds: [...new Set([...bundle.runtime.unlockedLoreIds, ...ctx.newlyUnlocked])],
    lastInteractedTurn: ctx.lastInteractedTurn,
    commsLinks: ctx.comms.links,
    // Surface-once: pending messages were rendered in this turn's pre-turn
    // context already, so they clear here; only beats fired THIS merge ride to
    // the next turn (reconcile leaves the queue untouched). Capped as a guard.
    pendingComms: reconcile ? bundle.runtime.pendingComms : state.firedComms.slice(-PENDING_COMMS_CAP),
    stagedIntents: ctx.stagedIntents,
    ...(ctx.affinityDecay ? { lastAffinityDecayAt: ctx.affinityDecay.lastAffinityDecayAt } : {}),
  };
}

/** Package the per-turn world copy + accumulators into the MergePlan. */
function buildMergePlan(ctx: PhaseContext, state: WorkingState): MergePlan {
  return {
    minutes: ctx.minutes,
    minutesCause: ctx.minutesCause,
    clockMinutes: ctx.clockMinutes,
    affinityUpdates: ctx.affinityUpdates,
    affinityDecay: ctx.affinityDecay?.edges ?? [],
    witnessedBy: ctx.witnessedBy,
    commsChanges: ctx.comms.changes,
    participants: [...state.participants],
    items: [...state.items],
    touchedItemIds: [...state.touchedItemIds],
    factDrafts: ctx.factDrafts,
    episodeSummary: ctx.episodeSummary,
    syntheticEpisode: ctx.syntheticEpisode,
    touchedThreadIds: ctx.touchedThreadIds,
    runtime: buildRuntime(ctx, state),
    brief: ctx.brief,
    droppedEvents: [...state.droppedEvents],
    // The turn's one-shot avatar reaction beat (avatar-3d) — apply.ts writes it onto
    // agentResults; absent when the player made no resolvable act this turn.
    ...(ctx.reactionResult?.beat ? { reactionBeat: ctx.reactionResult.beat } : {}),
  };
}

/**
 * The phase pipeline, in load-bearing order. The ordering invariants that were
 * formerly enforced only by line position + prose comments are stated here once:
 * drift (clock-and-meters) precedes the reaction mood-nudge; the reaction's owned
 * edges precede the affinity combine; the staged-intent tick precedes the schedule
 * tick (inside schedule-tick). `brief` is last — it reads everything.
 */
const PHASES: readonly Phase[] = [
  phaseMovements,
  phaseItemEvents,
  phaseClockAndMeters,
  phaseReactions,
  phaseConditions,
  phaseAttributes,
  phaseActivities,
  phaseScheduleTick,
  phaseFactsEpisode,
  phaseThreads,
  phaseLore,
  phaseWitness,
  phaseComms,
  phaseAffinityDecay,
  phaseThresholdHints,
  phaseAffinity,
  phaseBrief,
];

export async function planTurnEffects(input: PlanInput): Promise<MergePlan> {
  // The reducer's working state: the mutable per-turn copy of participants and
  // items plus the per-turn accumulators, with dirty-tracking owned internally
  // (merge-decomposition.spec.md §3.1). Mutation flows exclusively through the
  // ADT's methods; everything else threads through the PhaseContext.
  const state = WorkingState.fromBundle(input.bundle);
  const ctx = createPhaseContext(input, state);
  for (const phase of PHASES) await phase(ctx, state);
  return buildMergePlan(ctx, state);
}
