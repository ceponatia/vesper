import { diag } from "@/contracts/diagnostics";
import type { ItemDefinition } from "@/contracts/items/item";
import type { SimulantResult } from "@/contracts/turns/agent-results";
import type { BundlePlace } from "../../bundle";
import { findParticipant } from "../grounding";
import type { PhaseContext } from "../types";
import type { ItemPlacement, WorkingItem, WorkingParticipant, WorkingState } from "../working-state";
import { MAX_ITEM_EVENTS } from "./caps";

function held(participantId: string, worn: boolean): ItemPlacement {
  return { holderParticipantId: participantId, worn, locationId: null, containerInstanceId: null };
}
function atLocation(locationId: string): ItemPlacement {
  return { holderParticipantId: null, worn: false, locationId, containerInstanceId: null };
}
function inContainer(containerInstanceId: string): ItemPlacement {
  return { holderParticipantId: null, worn: false, locationId: null, containerInstanceId };
}

/** Exactly-one-placement invariant, asserted before the DB CHECK constraint can. */
export function assertPlacementExclusive(placement: ItemPlacement): boolean {
  const set =
    (placement.holderParticipantId !== null ? 1 : 0) +
    (placement.locationId !== null ? 1 : 0) +
    (placement.containerInstanceId !== null ? 1 : 0);
  return set === 1 && (!placement.worn || placement.holderParticipantId !== null);
}

export interface ItemEventContext {
  item: WorkingItem;
  actor: WorkingParticipant | null;
  /** Grounded event.locationName, when given. */
  location: BundlePlace | null;
  /** Grounded event.containerName, when given. */
  container: WorkingItem | null;
  items: readonly WorkingItem[];
}

export type ItemEventPlanResult =
  | { ok: true; placement?: ItemPlacement; open?: boolean; note?: string }
  | { ok: false; code: string; message: string };

function isWearable(definition: ItemDefinition): boolean {
  return definition.kind === "clothing" || definition.fields["wearableContainer"] === true;
}

function containerChainContains(start: WorkingItem, targetId: string, items: readonly WorkingItem[]): boolean {
  let current: WorkingItem | undefined = start;
  const seen = new Set<string>();
  while (current) {
    if (current.id === targetId) return true;
    if (seen.has(current.id)) return false;
    seen.add(current.id);
    const parentId: string | null = current.containerInstanceId;
    current = parentId ? items.find((i) => i.id === parentId) : undefined;
  }
  return false;
}

/** Validate + place an item into a container (shared by `store_in` and a
 * container-destination `remove`, e.g. a garment tossed into the hamper). */
function planStoreInContainer(
  container: WorkingItem | null,
  item: WorkingItem,
  items: readonly WorkingItem[],
  note: string | undefined,
): ItemEventPlanResult {
  if (!container) {
    return { ok: false, code: "merge.item.no_container", message: `container for "${item.name}" not found` };
  }
  if (container.definition.kind !== "container") {
    return { ok: false, code: "merge.item.not_container", message: `"${container.name}" is not a container` };
  }
  if (container.id === item.id || containerChainContains(container, item.id, items)) {
    return { ok: false, code: "merge.item.container_cycle", message: `cannot store "${item.name}" inside itself` };
  }
  return { ok: true, placement: inContainer(container.id), note };
}

/**
 * One item event → a placement/state transition honoring the placement CHECK
 * constraint (setting one placement clears the others). Pure.
 */
export function planItemEvent(
  event: SimulantResult["itemEvents"][number],
  ctx: ItemEventContext,
): ItemEventPlanResult {
  const { item, actor } = ctx;
  const note = event.stateNote?.trim() || undefined;

  switch (event.action) {
    case "wear": {
      if (!actor) return { ok: false, code: "merge.item.no_actor", message: `no actor to wear "${item.name}"` };
      if (!isWearable(item.definition)) {
        return { ok: false, code: "merge.item.invalid_wear", message: `"${item.name}" is not wearable` };
      }
      return { ok: true, placement: held(actor.id, true), note };
    }
    case "remove": {
      if (!item.worn) return { ok: false, code: "merge.item.not_worn", message: `"${item.name}" is not being worn` };
      // A removed garment goes where the prose puts it. Destination wins over the
      // hand: stowed in a container (hamper/drawer), or dropped/left at a location
      // (the floor of the current room). The agent signals these via the event's
      // existing containerName / locationName; a bare `remove` (no destination)
      // defaults to held — she takes it off and keeps it. A `locationName` the
      // resolver couldn't ground still falls back to the actor's room, so "the
      // floor" lands the item in the open here rather than in her hand.
      if (event.containerName) {
        return planStoreInContainer(ctx.container, item, ctx.items, note);
      }
      if (event.locationName) {
        const locationId = ctx.location?.id ?? actor?.locationId ?? item.locationId;
        if (locationId) return { ok: true, placement: atLocation(locationId), note };
      }
      const taker = actor ?? (item.holderParticipantId ? { id: item.holderParticipantId } : null);
      if (!taker) return { ok: false, code: "merge.item.no_actor", message: `no one to remove "${item.name}"` };
      return { ok: true, placement: held(taker.id, false), note };
    }
    case "pick_up":
    case "take_from": {
      if (!actor) return { ok: false, code: "merge.item.no_actor", message: `no actor to take "${item.name}"` };
      if (item.holderParticipantId === actor.id && !item.worn) return { ok: true, note }; // already held
      return { ok: true, placement: held(actor.id, false), note };
    }
    case "drop": {
      const locationId = ctx.location?.id ?? actor?.locationId ?? item.locationId;
      if (!locationId) return { ok: false, code: "merge.item.no_location", message: `nowhere to drop "${item.name}"` };
      return { ok: true, placement: atLocation(locationId), note };
    }
    case "place": {
      const locationId = ctx.location?.id ?? actor?.locationId ?? item.locationId;
      if (!locationId) return { ok: false, code: "merge.item.no_location", message: `nowhere to place "${item.name}"` };
      return { ok: true, placement: atLocation(locationId), note };
    }
    case "store_in":
      return planStoreInContainer(ctx.container, item, ctx.items, note);
    case "open":
    case "close": {
      if (item.definition.kind !== "container") {
        return { ok: false, code: "merge.item.not_container", message: `"${item.name}" is not a container` };
      }
      return { ok: true, open: event.action === "open", note };
    }
    case "alter": {
      return { ok: true, note: note ?? "altered" };
    }
  }
}

// -- Step 3: item events ----------------------------------------------------
export async function phaseItemEvents(ctx: PhaseContext, state: WorkingState): Promise<void> {
  const { simulant, sink } = ctx;
  const player = state.player;
  for (const event of simulant.itemEvents.slice(0, MAX_ITEM_EVENTS)) {
    const actor = event.byName ? findParticipant(event.byName, state.participants) : player;
    if (event.byName && !actor) {
      sink.push(diag("warn", "merge.participant.unresolved", `item event actor "${event.byName}" not found`));
      state.recordDrop(`The ${event.action} of ${event.itemName} did not take effect (unknown character ${event.byName}).`);
      continue;
    }
    const actorRef = actor ? { id: actor.id, locationId: actor.locationId } : null;
    const item = await ctx.resolveItem(event.itemName, event.action, actorRef);
    if (!item) {
      sink.push(diag("warn", "merge.item.unresolved", `item "${event.itemName}" not found in this session`));
      state.recordDrop(`The ${event.action} of ${event.itemName} did not take effect (no such item).`);
      continue;
    }
    const location = event.locationName ? await ctx.resolveLocation(event.locationName) : null;
    const container = event.containerName
      ? await ctx.resolveItem(event.containerName, "open", actorRef)
      : null;
    const planned = planItemEvent(event, { item, actor, location, container, items: state.items });
    if (!planned.ok) {
      sink.push(diag("warn", planned.code, planned.message, { context: { action: event.action, itemName: event.itemName } }));
      state.recordDrop(`The ${event.action} of ${item.name} did not take effect (${planned.message}).`);
      continue;
    }
    if (planned.placement) {
      if (!assertPlacementExclusive(planned.placement)) {
        sink.push(diag("error", "merge.item.placement_invalid", `planned placement for "${item.name}" violates exclusivity`));
        continue;
      }
      const positionNote = event.action === "place" ? (event.stateNote?.trim() || null) : null;
      state.placeItem(item, planned.placement, positionNote);
    }
    if (planned.open !== undefined) {
      state.setItemOpen(item, planned.open);
    }
    if (planned.note && (event.action === "alter" || !planned.placement)) {
      state.addItemNote(item, planned.note);
    }
  }
}
