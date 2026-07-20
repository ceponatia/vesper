import {
  simulationBranchEventSchema,
  type SimulationBranchEvent,
} from "@/contracts/simulation/branching";
import {
  materialsProjectionSchema,
  type ItemLocus,
  type MaterialsProjection,
} from "@/contracts/simulation/materials";
import {
  deriveTriggerCommandId,
  deriveTriggerId,
  type TriggerScheduledEvent,
} from "@/contracts/simulation/scheduler";
import { applyMaterialEvent, sortMaterialsProjection } from "./materials";

export interface BranchAncestryNode {
  branchId: string;
  /** Null for a root; otherwise the last ancestor sequence this branch inherits. */
  forkSequence: number | null;
}

export interface BranchEventRange {
  branchId: string;
  /** Rows owned by this branch are visible up to and including this sequence. */
  maxSequence: number;
}

/**
 * R4 ancestry math. Walking up from a branch, each ancestor's own rows are
 * visible only up to the tightest fork bound crossed so far — so an ancestor
 * that was itself forked below this line contributes nothing, and a sibling's
 * post-fork events can never leak in. The chain runs child-first and must end
 * at the root.
 */
export function composeAncestryEventBounds(
  chain: readonly BranchAncestryNode[],
): BranchEventRange[] {
  if (chain.length === 0) throw new Error("Branch ancestry chain is empty");
  const ranges: BranchEventRange[] = [];
  let bound = Number.MAX_SAFE_INTEGER;
  for (const [index, node] of chain.entries()) {
    const isLast = index === chain.length - 1;
    if (isLast && node.forkSequence !== null) {
      throw new Error("Branch ancestry chain does not end at a root branch");
    }
    if (!isLast && node.forkSequence === null) {
      throw new Error("Branch ancestry chain has a root before its end");
    }
    ranges.push({ branchId: node.branchId, maxSequence: bound });
    if (node.forkSequence !== null) bound = Math.min(bound, node.forkSequence);
  }
  return ranges;
}

/**
 * Reverse-derive item loci at a sequence boundary from current loci and the
 * events after it: undoing each material move newest-first returns a touched
 * item to the `fromLocus` its earliest post-boundary event captured — a
 * transfer's source or a destruction's pre-gone locus. Items no event moved
 * keep their current locus; that placement is seed data the event stream
 * cannot validate (plan R3).
 */
export function itemHoldingsAtSequence(
  currentHoldings: ReadonlyMap<string, ItemLocus>,
  events: readonly SimulationBranchEvent[],
  throughSequence: number,
): Map<string, ItemLocus> {
  const holdings = new Map(currentHoldings);
  const undone = events
    .filter(
      (event) =>
        (event.type === "item_transferred" ||
          event.type === "item_destroyed" ||
          event.type === "item_consumed") &&
        event.sequence > throughSequence,
    )
    .sort((left, right) => right.sequence - left.sequence);
  for (const event of undone) {
    if (
      event.type !== "item_transferred" &&
      event.type !== "item_destroyed" &&
      event.type !== "item_consumed"
    ) {
      continue;
    }
    holdings.set(event.payload.itemId, event.payload.fromLocus);
  }
  return holdings;
}

export interface ReplayedTriggerLedgerEntry {
  uniquenessKey: string;
  stableOrder: number;
  scheduledByEventId: string;
  intent: TriggerScheduledEvent["payload"];
  /** Set when a later replayed event shows this trigger already fired. */
  firedByCommandId: string | null;
}

export interface BranchReplayResult {
  projection: MaterialsProjection;
  /** Meaningful only when replaying from the branch origin (how forks use it). */
  triggers: ReplayedTriggerLedgerEntry[];
  replayedEventCount: number;
}

export interface BranchReplayInput {
  /**
   * The projection state just before the first replayed event. For a
   * from-zero replay this is the (unvalidatable, plan R3) seed; for a resumed
   * replay it is a snapshot payload.
   */
  seed: MaterialsProjection;
  /** The contiguous event stream after the seed boundary, any ancestry mix. */
  events: readonly SimulationBranchEvent[];
  /**
   * Every branch a replayed event may have been recorded on — the ancestry
   * chain. Also the branches on which a replayed trigger could have been
   * dispatched, which is how an already-fired alarm is recognized instead of
   * re-armed.
   */
  chainBranchIds: readonly string[];
}

/**
 * Deterministic replay of one branch's logical history through the same pure
 * projectors that produced it live (plan R1). Re-applies recorded events; it
 * never re-runs decisions, so replaying is not a reroll. The materials
 * projection folds through `applyMaterialEvent` (which mutates the material
 * events and passes every other family through as a boundary advance), while
 * the trigger ledger tracks scheduling, firing, and retirement in parallel.
 */
export function replayBranchHistory(input: BranchReplayInput): BranchReplayResult {
  const seed = sortMaterialsProjection(materialsProjectionSchema.parse(input.seed));
  const chainBranchIds = [...new Set(input.chainBranchIds)];
  const events = [...input.events]
    .sort((left, right) => left.sequence - right.sequence)
    .map((event) => simulationBranchEventSchema.parse(event));

  let projection = seed;
  const commandIds = new Set<string>();
  const triggers: ReplayedTriggerLedgerEntry[] = [];
  const firingIndex = new Map<string, ReplayedTriggerLedgerEntry>();
  /**
   * Triggers retired by a domain event other than their own firing — a
   * cancelled activity retires its completion trigger, an abandoned journey
   * its arrival trigger — keyed by kind:target so replay recognizes the
   * retirement exactly as the live store recorded it.
   */
  const retirementIndex = new Map<string, ReplayedTriggerLedgerEntry>();
  const retire = (key: string, commandId: string | undefined): void => {
    const entry = retirementIndex.get(key);
    if (entry && entry.firedByCommandId === null && commandId) entry.firedByCommandId = commandId;
  };
  let lastSequence = seed.headSequence;

  for (const event of events) {
    if (event.sequence !== lastSequence + 1) {
      throw new Error(`Replay sequence gap: expected ${lastSequence + 1}, received ${event.sequence}`);
    }
    if (!chainBranchIds.includes(event.branchId)) {
      throw new Error("Replay event belongs to a branch outside the ancestry chain");
    }
    if (event.worldId !== seed.worldId) {
      throw new Error("Replay event belongs to another world");
    }
    if (event.commandId) commandIds.add(event.commandId);

    if (event.type === "trigger_scheduled") {
      const entry: ReplayedTriggerLedgerEntry = {
        uniquenessKey: event.payload.uniquenessKey,
        stableOrder: triggers.length + 1,
        scheduledByEventId: event.id,
        intent: event.payload,
        firedByCommandId: null,
      };
      triggers.push(entry);
      // A trigger fires under a command identity derived from its row's own
      // branch, which along a fork chain may be any ancestor. Registering
      // every candidate keeps recognition exact without parsing IDs.
      for (const branchId of chainBranchIds) {
        firingIndex.set(deriveTriggerCommandId(deriveTriggerId(branchId, entry.uniquenessKey)), entry);
      }
      if (event.payload.kind === "journey_arrival_due") {
        retirementIndex.set(`journey_arrival_due:${event.payload.command.payload.journeyId}`, entry);
      } else if (event.payload.kind === "activity_completion_due") {
        retirementIndex.set(
          `activity_completion_due:${event.payload.command.payload.activityInstanceId}`,
          entry,
        );
      } else if (event.payload.kind === "body_threshold_due") {
        // Re-arms overwrite: the newest alarm for a meter is the live one.
        retirementIndex.set(
          `body_threshold_due:${event.payload.command.payload.actorId}:${event.payload.command.payload.meterKey}`,
          entry,
        );
      } else if (event.payload.kind === "body_condition_expiry_due") {
        retirementIndex.set(
          `body_condition_expiry_due:${event.payload.command.payload.conditionId}`,
          entry,
        );
      } else if (event.payload.kind === "body_collapse_due") {
        retirementIndex.set(`body_collapse_due:${event.payload.command.payload.actorId}`, entry);
      } else if (event.payload.kind === "item_condition_threshold_due") {
        // Re-arms overwrite: the newest alarm for an item meter is the live one.
        retirementIndex.set(
          `item_condition_threshold_due:${event.payload.command.payload.itemId}:${event.payload.command.payload.meterKey}`,
          entry,
        );
      } else if (event.payload.kind === "household_restock_due") {
        // Re-arms overwrite: the newest alarm for a household+kind is the live one.
        retirementIndex.set(
          `household_restock_due:${event.payload.command.payload.householdId}:${event.payload.command.payload.materialKindKey}`,
          entry,
        );
      }
    } else {
      // Every non-scheduling event may be a scheduler-dispatched firing (an
      // arrival, a completion, a scheduled transfer). Recognizing it here marks
      // the dispatching trigger fired instead of re-arming it on the fork child.
      const fired = event.commandId ? firingIndex.get(event.commandId) : undefined;
      if (fired) fired.firedByCommandId = event.commandId ?? null;
      if (
        event.type === "activity_cancelled" ||
        event.type === "activity_failed" ||
        event.type === "activity_interrupted"
      ) {
        // Interruption retires the pending completion too (E5.2): a resumed
        // activity re-arms under an attempt-versioned key.
        retire(`activity_completion_due:${event.payload.activityInstanceId}`, event.commandId);
      } else if (event.type === "journey_abandoned") {
        retire(`journey_arrival_due:${event.payload.journeyId}`, event.commandId);
      } else if (
        event.type === "body_source_applied" ||
        event.type === "body_modifier_applied" ||
        event.type === "body_threshold_crossed"
      ) {
        // Any material change to a meter's trajectory retires its pending
        // alarm; the same command's re-arm (if any) follows as a fresh
        // trigger_scheduled with a sequence-versioned uniqueness key. Energy
        // material events also retire the actor's collapse alarm (E5.2).
        retire(`body_threshold_due:${event.payload.actorId}:${event.payload.meterKey}`, event.commandId);
        if (event.payload.meterKey === "energy") {
          retire(`body_collapse_due:${event.payload.actorId}`, event.commandId);
        }
      } else if (event.type === "body_collapsed") {
        retire(`body_threshold_due:${event.payload.actorId}:energy`, event.commandId);
        retire(`body_collapse_due:${event.payload.actorId}`, event.commandId);
      } else if (
        event.type === "item_condition_source_applied" ||
        event.type === "item_condition_threshold_crossed"
      ) {
        // Mirrors the body-meter retirement above: any material write to an
        // item meter's trajectory retires its pending alarm; a re-arm (if
        // any) follows as a fresh trigger_scheduled with a versioned key.
        retire(
          `item_condition_threshold_due:${event.payload.itemId}:${event.payload.meterKey}`,
          event.commandId,
        );
      } else if (event.type === "item_condition_modifier_applied") {
        // A worn-window modifier changes the drift trajectory just as much
        // as a source write does — retire the meter's pending alarm too.
        retire(
          `item_condition_threshold_due:${event.payload.itemId}:${event.payload.modifier.meterKey}`,
          event.commandId,
        );
      } else if (event.type === "body_condition_ended") {
        // A condition application never retires (its owned modifiers ride
        // their own body_modifier_applied events); its ending retires the
        // expiry alarm and each owned modifier's meter alarm.
        retire(`body_condition_expiry_due:${event.payload.conditionId}`, event.commandId);
        for (const retired of event.payload.retiredModifiers) {
          retire(`body_threshold_due:${event.payload.actorId}:${retired.meterKey}`, event.commandId);
          if (retired.meterKey === "energy") {
            retire(`body_collapse_due:${event.payload.actorId}`, event.commandId);
          }
        }
      } else if (
        event.type === "household_restock_fulfilled" ||
        event.type === "household_restock_deferred"
      ) {
        // Regardless of outcome, run_household_restock always re-arms the
        // next cycle as its own fresh trigger_scheduled — recognized by the
        // branch above, which re-registers this same retirement key.
        retire(`household_restock_due:${event.payload.householdId}:${event.payload.materialKindKey}`, event.commandId);
      } else if (event.type === "household_restock_routine_configured") {
        // Reconfiguring unconditionally retires any stale pending alarm
        // (§5.6's store-layer idiom mirrored here for replay parity) — a
        // reconfigure that also re-arms emits its OWN fresh trigger_scheduled,
        // recognized by the branch above.
        retire(
          `household_restock_due:${event.payload.householdId}:${event.payload.materialKindKey}`,
          event.commandId,
        );
      }
    }

    // Materials fold every event: item events mutate placement, all others
    // (trigger_scheduled included) advance the boundary without touching items.
    projection = applyMaterialEvent(projection, event, { acceptBranchIds: chainBranchIds });
    lastSequence = event.sequence;
  }

  // Version counts accepted commands, not events; each command's events are
  // atomic around any seed boundary, so distinct replayed command IDs add
  // exactly the commands the seed had not counted yet.
  const finalProjection = materialsProjectionSchema.parse({
    ...projection,
    headSequence: lastSequence,
    version: seed.version + commandIds.size,
  });
  return { projection: finalProjection, triggers, replayedEventCount: events.length };
}
