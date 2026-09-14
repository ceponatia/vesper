import { bodyLocationRegistry, type BodyLocationRegistry } from "../body/locations";
import { clothingCategoryById } from "./clothing-categories";
import { expandCoverage } from "./coverage";
import type { GarmentBlueprint } from "./garment-blueprint";
import { orderCoverageIds } from "./garment-coverage";
import { garmentBlueprintForSeed, inferGarmentMaterialProfile } from "./garment-store";

/**
 * How a successor world's worn garments map onto the SHARED garment model: the
 * slot-key vocabulary `sim_item_holdings` stores, and the blueprint mint a
 * world seed runs. Both halves exist so the successor lane answers structural
 * questions — which parts, what coverage — from the same construction the
 * character-chat garment store uses, instead of from a name list.
 *
 * Pure: the caller does the item IO and hands definitions in, exactly as
 * `garment-store.ts` does for the chat lane.
 *
 * ## The worn slot vocabulary
 *
 * `sim_item_holdings.slot_key` is free text at the contract level, so a slot
 * string is never a structural reference on its own: it is parsed here against
 * the real registries (`clothingCategories`, `bodyLocationRegistry`) and
 * anything that does not resolve reads `unknown`. Nothing downstream may treat
 * a raw slot string as an anatomical or garment reference.
 *
 * Two vocabularies exist, which is why this is a parse and not a lookup:
 *
 * - `<clothing-category-id>-<n>` — what a new world seed writes
 *   ({@link successorWornSlotKey}). The category is the garment's construction
 *   template, which is what the blueprint static is minted from.
 * - `<body-location-id>-<n>` — what earlier seeds wrote, taking the first entry
 *   of the definition's coverage list. It names a place on the body rather than
 *   a kind of garment, so it can only support a conservative covered read.
 *
 * The index suffix exists to make the key unique per actor (one holdings row
 * per item, but several garments may share a category), and carries no
 * ordering meaning beyond the order the seed wrote them in.
 */

/** A parsed slot key. `unknown` keeps the raw string so a diagnostic can name it. */
export type SuccessorWornSlot =
  | { kind: "category"; categoryId: string; index: number }
  | { kind: "location"; locationId: string; index: number }
  | { kind: "unknown"; raw: string };

/**
 * The head a slot key takes when the garment has no registered clothing
 * category. It is deliberately NOT a registry id: it parses back as `unknown`,
 * which is the honest read — the seed knew no construction for this garment.
 */
export const SUCCESSOR_WORN_SLOT_UNKNOWN_HEAD = "garment";

/** Matches the material contract's `wornSlotKeySchema` bound. */
export const SUCCESSOR_WORN_SLOT_MAX_CHARS = 64;

/**
 * Build the slot key for the `n`th garment a world seed puts on an actor.
 *
 * An unregistered or absent category falls back to
 * {@link SUCCESSOR_WORN_SLOT_UNKNOWN_HEAD} rather than being written through
 * verbatim: a key that looks like a registry id but is not one is worse than a
 * key that openly says "unknown", because the first invites a reader to trust it.
 */
export function successorWornSlotKey(categoryId: string | undefined, index: number): string {
  const head = (categoryId ? clothingCategoryById(categoryId)?.id : undefined) ?? SUCCESSOR_WORN_SLOT_UNKNOWN_HEAD;
  const position = Number.isFinite(index) ? Math.max(0, Math.trunc(index)) : 0;
  return `${head}-${position}`.slice(0, SUCCESSOR_WORN_SLOT_MAX_CHARS);
}

/**
 * Parse a stored slot key. Total — every string resolves, an unrecognized one
 * to `unknown`. The head is split at the LAST hyphen so a multi-word registry
 * id would survive the split even though none carries a hyphen today, and it
 * must match a registry entry exactly: category first (the current vocabulary),
 * then body location (the earlier one). The two id sets are disjoint, so the
 * precedence never actually decides anything — it is stated so that adding a
 * colliding id cannot silently change how existing keys read.
 */
export function parseSuccessorWornSlotKey(
  slotKey: string,
  registry: BodyLocationRegistry = bodyLocationRegistry,
): SuccessorWornSlot {
  const raw = slotKey.trim();
  const split = raw.lastIndexOf("-");
  if (split <= 0 || split === raw.length - 1) return { kind: "unknown", raw };
  const head = raw.slice(0, split);
  const tail = raw.slice(split + 1);
  if (!/^\d+$/u.test(tail)) return { kind: "unknown", raw };
  const index = Number.parseInt(tail, 10);
  if (!Number.isSafeInteger(index)) return { kind: "unknown", raw };
  const category = clothingCategoryById(head);
  // `clothingCategoryById` case-folds, so compare the RESOLVED id: a key that
  // reached the registry through folding still reads as the canonical category.
  if (category) return { kind: "category", categoryId: category.id, index };
  const location = registry.byId(head);
  if (location && location.coverageRelevant !== false) {
    return { kind: "location", locationId: location.id, index };
  }
  return { kind: "unknown", raw };
}

/**
 * The CONSERVATIVE covered read a slot supports on its own — what to treat as
 * covered when the garment's blueprint static is missing or unreadable and
 * there is no per-part coverage to derive.
 *
 * An empty result means "this slot says nothing", NEVER "this garment covers
 * nothing". The two are only distinguishable through the reliability flag the
 * read adapter carries, and a consumer that derives exposure must degrade an
 * unreliable garment to covered rather than reading an empty list as bare
 * (docs/resilience.md, `isDegradedGarmentBlueprint`).
 *
 * A category over-claims where a definition was edited down (a bandeau authored
 * from the `top` template), which is the safe direction: coverage that is too
 * generous conceals, coverage that is too sparse undresses.
 */
export function successorWornSlotCoverage(
  slot: SuccessorWornSlot,
  registry: BodyLocationRegistry = bodyLocationRegistry,
): string[] {
  const seed =
    slot.kind === "category"
      ? (clothingCategoryById(slot.categoryId)?.coverage ?? [])
      : slot.kind === "location"
        ? [slot.locationId]
        : [];
  if (seed.length === 0) return [];
  return orderCoverageIds(
    [...expandCoverage(seed, registry)].filter((id) => registry.byId(id)?.coverageRelevant !== false),
    registry,
  );
}

// --- The blueprint mint ------------------------------------------------------

/** What a world seed knows about one garment definition it is about to mint. */
export interface SuccessorGarmentDefinition {
  /** Library item-definition id, when the seed has one. Provenance only. */
  id?: string;
  name: string;
  /** The DEFINITION's own coverage, which the category template is rescoped onto. */
  coverage: readonly string[];
  /** `clothingCategories` id — picks the sparse part template. */
  category?: string;
  description?: string;
  appearance?: string;
  tags?: readonly string[];
}

/**
 * Mint the durable blueprint static for one seeded garment — the SAME call the
 * chat lane's `syncChatGarments` makes, so a successor world and a character
 * chat built from one wardrobe definition resolve to identical construction.
 *
 * A definition with no registered category still mints: `garmentBlueprintForSeed`
 * falls back to the root-only template carrying the definition's own coverage,
 * which is a real (if coarse) garment rather than a degraded one.
 *
 * The return type is widened to a plain record on purpose. The stored column is
 * opaque to `@vesper/simulation-core`, whose item contract accepts any JSON
 * object; `GarmentBlueprint` is an interface and so carries no implicit index
 * signature, and spreading it here is what makes the seed assignable without
 * pushing the app's wardrobe vocabulary into the package.
 */
export function successorGarmentBlueprint(definition: SuccessorGarmentDefinition): Record<string, unknown> {
  const blueprint: GarmentBlueprint = garmentBlueprintForSeed({
    // `garmentBlueprintForSeed` reads only category, coverage and material; the
    // successor lane has no chat instance to carry library provenance for.
    definitionId: definition.id ?? "",
    name: definition.name,
    ...(definition.category ? { categoryId: definition.category } : {}),
    coverage: definition.coverage,
    materialProfileId: inferGarmentMaterialProfile(
      [definition.name, definition.description ?? "", definition.appearance ?? "", ...(definition.tags ?? [])].join(" "),
    ),
  });
  return { ...blueprint };
}
