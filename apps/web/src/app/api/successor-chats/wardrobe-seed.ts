export interface SuccessorWardrobeSeedLoad {
  wardrobe: readonly { name: string; coverage: readonly string[] }[];
  failed?: boolean;
  coverageUnreliableIds?: readonly string[];
}

export type SuccessorWardrobeSeed =
  | { ok: true; garments: { name: string; slotKey: string }[] }
  | { ok: false; reason: "load_failed" | "coverage_unreliable"; itemIds: string[] };

/**
 * Turn a character-library wardrobe load into the durable starter-world garment seed.
 *
 * This is a MINT boundary, so the resilience rule is stricter than a display read:
 * transiently unknown coverage may not be converted into an empty/partial wardrobe and
 * persisted forever. A failed load or any unreadable coverage row refuses the seed; the
 * provisioning request remains retryable and a healthy retry can mint the real outfit.
 */
export function successorWardrobeSeed(load: SuccessorWardrobeSeedLoad): SuccessorWardrobeSeed {
  if (load.failed === true) return { ok: false, reason: "load_failed", itemIds: [] };
  const unreliable = [...(load.coverageUnreliableIds ?? [])];
  if (unreliable.length > 0) return { ok: false, reason: "coverage_unreliable", itemIds: unreliable };
  return {
    ok: true,
    garments: load.wardrobe.map((item, index) => ({
      name: item.name,
      slotKey: `${item.coverage[0] ?? "garment"}-${index}`,
    })),
  };
}
