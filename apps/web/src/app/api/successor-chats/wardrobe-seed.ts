import {
  successorGarmentBlueprint,
  successorWornSlotKey,
  type SuccessorGarmentDefinition,
} from "@/contracts";

/** One loaded wardrobe definition, as the chat wardrobe loader returns it. */
export type SuccessorWardrobeSeedItem = SuccessorGarmentDefinition;

export interface SuccessorWardrobeSeedLoad {
  wardrobe: readonly SuccessorWardrobeSeedItem[];
  failed?: boolean;
  coverageUnreliableIds?: readonly string[];
}

/** One worn item as the starter world seeds it: identity, slot, and construction. */
export interface SuccessorWardrobeSeedGarment {
  name: string;
  slotKey: string;
  /**
   * The garment blueprint static, opaque at the seed boundary — the durable
   * `sim_items.garment_blueprint` value the read adapter parses back.
   */
  blueprint: Record<string, unknown>;
}

export type SuccessorWardrobeSeed =
  | { ok: true; garments: SuccessorWardrobeSeedGarment[] }
  | { ok: false; reason: "load_failed" | "coverage_unreliable"; itemIds: string[] };

/**
 * Turn a character-library wardrobe load into the durable starter-world garment seed.
 *
 * This is a MINT boundary, so the resilience rule is stricter than a display read:
 * transiently unknown coverage may not be converted into an empty/partial wardrobe and
 * persisted forever. A failed load or any unreadable coverage row refuses the seed; the
 * provisioning request remains retryable and a healthy retry can mint the real outfit.
 *
 * That strictness is also what makes the blueprint safe to snapshot: coverage
 * is the input the mint rescopes the category template onto, so seeding an
 * unreadable row would freeze a covers-nothing construction into world truth.
 */
export function successorWardrobeSeed(load: SuccessorWardrobeSeedLoad): SuccessorWardrobeSeed {
  if (load.failed === true) return { ok: false, reason: "load_failed", itemIds: [] };
  const unreliable = [...(load.coverageUnreliableIds ?? [])];
  if (unreliable.length > 0) return { ok: false, reason: "coverage_unreliable", itemIds: unreliable };
  return {
    ok: true,
    garments: load.wardrobe.map((item, index) => ({
      name: item.name,
      slotKey: successorWornSlotKey(item.category, index),
      blueprint: successorGarmentBlueprint(item),
    })),
  };
}
