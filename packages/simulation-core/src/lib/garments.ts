import type { SimulationBranchEvent } from "../contracts/branching";
import {
  itemGarmentStateProjectionSchema,
  type ItemGarmentStateEntry,
  type ItemGarmentStateProjection,
} from "../contracts/garments";
import { compareStableText } from "./hash";

/**
 * #296 — the pure garment-state fold.
 *
 * The whole kernel is one rule: a `garment_operation_applied` event SETS the
 * named item's presentation and condition to the `after` it recorded, and every
 * other event advances the boundary and touches nothing. That is what makes the
 * projection rebuildable without any wardrobe knowledge in this package: the
 * reducer that DECIDED the result lives in the application beside the
 * character-chat lane that shares it, and replay never asks it again.
 *
 * The alternative — re-running the reducer during replay — is the defect this
 * design exists to prevent. A garment's next state is a function of the
 * blueprint static, the material coefficients, the story minute integrated to,
 * and the reducer's own rules; re-deriving would tie every historical outcome
 * to today's copy of all four, so editing a material profile would silently
 * re-dress every fork of every world that ever carried that garment. Recording
 * the result once and re-applying it forever is the same law
 * `item_condition_source_applied` follows with `valueAfterFixedPoint`.
 *
 * Nothing here writes; the durable row layer (`garment-rows.ts`) and the fork
 * materialization (`branch-store.ts`) are the only writers, and both write
 * exactly the value this fold produces.
 */

/** Items sorted by id, so two folds of one stream are byte-identical. */
export function sortItemGarmentStateProjection(
  projection: ItemGarmentStateProjection,
): ItemGarmentStateProjection {
  return itemGarmentStateProjectionSchema.parse({
    ...projection,
    items: [...projection.items].sort((left, right) => compareStableText(left.itemId, right.itemId)),
  });
}

/**
 * Pure synchronous projector for the garment family.
 *
 * Exhaustive over the whole branch-event union on purpose: a new event type
 * cannot ship without a ruling here, and "this family does not touch garment
 * state" is a ruling someone wrote down rather than a default a `default:` arm
 * would have hidden.
 */
export function applyItemGarmentStateEvent(
  projection: ItemGarmentStateProjection,
  event: SimulationBranchEvent,
): ItemGarmentStateProjection {
  const bumped = { ...projection, headSequence: event.sequence, storySecond: event.storySecond };
  switch (event.type) {
    case "garment_operation_applied": {
      // A SET, never a merge: the event carries the garment's whole post-state
      // for both channels, so replay cannot end up with a presentation from one
      // event and a condition from another.
      const entry: ItemGarmentStateEntry = {
        itemId: event.payload.itemId,
        presentation: event.payload.after.presentation,
        condition: event.payload.after.condition,
      };
      const known = projection.items.some((item) => item.itemId === entry.itemId);
      const items = known
        ? projection.items.map((item) => (item.itemId === entry.itemId ? entry : item))
        : [...projection.items, entry];
      return sortItemGarmentStateProjection({ ...bumped, items });
    }
    case "item_condition_initialized":
    case "item_condition_source_applied":
    case "item_condition_modifier_applied":
    case "item_condition_modifier_ended":
    case "item_condition_threshold_crossed":
    case "item_transferred":
    case "item_destroyed":
    case "item_consumed":
    case "item_ownership_set":
    case "trigger_scheduled":
    case "journey_planned":
    case "actor_departed":
    case "journey_delayed":
    case "journey_interrupted":
    case "actor_arrived":
    case "journey_abandoned":
    case "activity_started":
    case "activity_completed":
    case "activity_cancelled":
    case "activity_failed":
    case "activity_interrupted":
    case "activity_resumed":
    case "commitment_created":
    case "pressure_raised":
    case "commitment_kept":
    case "commitment_late":
    case "commitment_missed":
    case "engagement_opened":
    case "engagement_ended":
    case "engagement_interrupted":
    case "engagement_winding_down":
    case "zone_entered":
    case "storyteller_relocation":
    case "speech_act_delivered":
    case "disclosure_made":
    case "soft_canon_recorded":
    case "soft_canon_promoted":
    case "soft_canon_demoted":
    case "body_initialized":
    case "body_source_applied":
    case "body_modifier_applied":
    case "body_condition_applied":
    case "body_condition_ended":
    case "body_threshold_crossed":
    case "body_collapsed":
    case "household_created":
    case "household_membership_set":
    case "material_lot_initialized":
    case "material_lot_adjusted":
    case "material_lot_transferred":
    case "means_band_set":
    case "household_restock_routine_configured":
    case "item_instantiated_from_promotion":
    case "household_restock_fulfilled":
    case "household_restock_deferred":
    case "relationship_entry_authored":
    case "relationship_change_recorded":
    case "consent_escalation_resolved":
    case "pressure_acknowledged":
    case "actor_lod_assigned":
    case "routine_policy_resolved":
    case "cohort_created":
    case "cohort_adjusted":
    case "actor_materialized_from_aggregate":
      // Non-garment families advance the boundary without touching this projection.
      // An item MOVING is deliberately included: a doff or a hand-off changes
      // where a garment is (`sim_item_holdings`), never how it is arranged or
      // what has happened to its material, so a transfer must leave this
      // projection alone or re-donning a jacket would forget it was unbuttoned.
      return itemGarmentStateProjectionSchema.parse(bumped);
  }
}

export interface ItemGarmentStateReplayInput {
  /** Garment state is fully evented: a branch-origin seed holds none (R3). */
  seed: ItemGarmentStateProjection;
  events: readonly SimulationBranchEvent[];
}

/** Fold one branch's full logical stream into its garment-state projection. */
export function replayItemGarmentStateHistory(
  input: ItemGarmentStateReplayInput,
): ItemGarmentStateProjection {
  const seed = sortItemGarmentStateProjection(itemGarmentStateProjectionSchema.parse(input.seed));
  const events = [...input.events].sort((left, right) => left.sequence - right.sequence);
  let projection = seed;
  const commandIds = new Set<string>();
  let lastSequence = seed.headSequence;
  for (const event of events) {
    if (event.sequence !== lastSequence + 1) {
      throw new Error(
        `Item garment state replay sequence gap: expected ${lastSequence + 1}, received ${event.sequence}`,
      );
    }
    if (event.commandId) commandIds.add(event.commandId);
    projection = applyItemGarmentStateEvent(projection, event);
    lastSequence = event.sequence;
  }
  return itemGarmentStateProjectionSchema.parse({
    ...projection,
    version: seed.version + commandIds.size,
  });
}

/** The empty branch-origin garment-state seed. */
export function emptyItemGarmentStateSeed(
  branchId: string,
  originStorySecond: number,
): ItemGarmentStateProjection {
  return itemGarmentStateProjectionSchema.parse({
    branchId,
    headSequence: 0,
    version: 0,
    storySecond: originStorySecond,
    items: [],
  });
}
