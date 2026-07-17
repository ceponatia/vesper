import {
  isMovementEvent,
  simulationBranchEventSchema,
  type SimulationBranchEvent,
} from "@/contracts/simulation/branching";
import {
  itemTransferProjectionSchema,
  type ItemTransferProjection,
} from "@/contracts/simulation/item-transfer";
import {
  deriveTriggerCommandId,
  deriveTriggerId,
  type TriggerScheduledEvent,
} from "@/contracts/simulation/scheduler";
import { applyItemTransferredEvent, sortItemTransferProjection } from "./item-transfer";

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
 * Reverse-derive item placements at a sequence boundary from current
 * placements and the events after it: undoing transfers newest-first leaves
 * each touched item where its earliest post-boundary transfer found it.
 * Items no event ever moved keep their current placement — that placement is
 * seed data the event stream cannot validate (plan R3).
 */
export function itemHoldingsAtSequence(
  currentHoldings: ReadonlyMap<string, string>,
  events: readonly SimulationBranchEvent[],
  throughSequence: number,
): Map<string, string> {
  const holdings = new Map(currentHoldings);
  const undone = events
    .filter((event) => event.type === "item_transferred" && event.sequence > throughSequence)
    .sort((left, right) => right.sequence - left.sequence);
  for (const event of undone) {
    if (event.type !== "item_transferred") continue;
    holdings.set(event.payload.itemId, event.payload.fromContainerId);
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
  projection: ItemTransferProjection;
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
  seed: ItemTransferProjection;
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
 * never re-runs decisions, so replaying is not a reroll.
 */
export function replayBranchHistory(input: BranchReplayInput): BranchReplayResult {
  const seed = sortItemTransferProjection(itemTransferProjectionSchema.parse(input.seed));
  const chainBranchIds = [...new Set(input.chainBranchIds)];
  const events = [...input.events]
    .sort((left, right) => left.sequence - right.sequence)
    .map((event) => simulationBranchEventSchema.parse(event));

  let projection = seed;
  const commandIds = new Set<string>();
  const triggers: ReplayedTriggerLedgerEntry[] = [];
  const firingIndex = new Map<string, ReplayedTriggerLedgerEntry>();
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
      projection = itemTransferProjectionSchema.parse({ ...projection, headSequence: event.sequence });
    } else if (isMovementEvent(event)) {
      // Movement events belong to the space projection (replaySpaceHistory).
      // Here they advance the item boundary and — for a scheduler-dispatched
      // arrival — mark the arrival trigger as already fired.
      const fired = event.commandId ? firingIndex.get(event.commandId) : undefined;
      if (fired) fired.firedByCommandId = event.commandId ?? null;
      projection = itemTransferProjectionSchema.parse({ ...projection, headSequence: event.sequence });
    } else {
      const fired = event.commandId ? firingIndex.get(event.commandId) : undefined;
      if (fired) fired.firedByCommandId = event.commandId ?? null;
      projection = applyItemTransferredEvent(projection, event, { acceptBranchIds: chainBranchIds });
    }
    lastSequence = event.sequence;
  }

  // Version counts accepted commands, not events; each command's events are
  // atomic around any seed boundary, so distinct replayed command IDs add
  // exactly the commands the seed had not counted yet.
  const finalProjection = itemTransferProjectionSchema.parse({
    ...projection,
    headSequence: lastSequence,
    version: seed.version + commandIds.size,
  });
  return { projection: finalProjection, triggers, replayedEventCount: events.length };
}
