import { and, asc, eq } from "drizzle-orm";
import { integrateMeterValue } from "@vesper/simulation-core/bodies";
import { meterViewOfItem } from "@vesper/simulation-core/material-condition";
import {
  degradedGarmentBlueprint,
  diag,
  DiagnosticCollector,
  garmentBlueprintHash,
  garmentBlueprintSchema,
  garmentRootNode,
  isDegradedGarmentBlueprint,
  parseSuccessorWornSlotKey,
  successorWornSlotCoverage,
  GARMENT_UNIT_ONE,
  type Diagnostic,
  type GarmentBlueprint,
  type GarmentInstanceState,
  type SuccessorWornSlot,
} from "@/contracts";
import { parseOrNull } from "@/lib/parse";
import { db, simBranches, simItemHoldings, simItems, type Db } from "@/server/db";
import { loadItemGarmentStateRows, neutralItemGarmentState } from "./garment-rows";
import { loadItemConditionViews } from "./item-condition-store";
import type { SimTx } from "./trigger-projector";

/**
 * The successor engine's GARMENT READ: an actor's worn items resolved to the
 * same blueprint, parts and effective-coverage inputs the character-chat
 * garment store carries, so narration and exposure can be structural rather
 * than a list of names.
 *
 * Four owners meet here and none of them is rewritten by this read:
 *
 * | Channel                                   | Owner                                        |
 * | ----------------------------------------- | -------------------------------------------- |
 * | identity + placement                      | `sim_items` / `sim_item_holdings`            |
 * | construction (parts, behaviors, coverage) | the `sim_items.garment_blueprint` static     |
 * | cleanliness + wear                        | `item-condition-v1` meters, integrated here  |
 * | presentation, wetness, crease, marks      | `sim_item_garment_state`                     |
 *
 * Effective coverage is DERIVED, never stored: the caller runs
 * `garmentEffectiveCoverage(instance, blueprint)` or `garmentReadout` over the
 * pair this read returns, which is the same call the chat lane makes.
 *
 * Nothing here writes. Integration is analytic and discarded, exactly as
 * `readSimChatMeters` does it, so reading a wardrobe can never age it.
 *
 * ## The degraded law
 *
 * A garment whose blueprint static is missing or unreadable is still RETURNED —
 * with its name, its slot, and the marked degraded blueprint — and flagged
 * `reliable: false`. It is never dropped and never silently read as covering
 * nothing: a covers-nothing graph that merely looks authored is how an
 * unreadable row turns into a nudity claim (docs/resilience.md,
 * `isDegradedGarmentBlueprint`). Consumers deriving exposure must treat an
 * unreliable garment as COVERED, using {@link SimGarmentRead.conservativeCoverage}
 * where the slot key supports a better guess than "something".
 */

/** Diagnostic codes this read emits. Stable: consumers and tests key on them. */
export const SIM_GARMENT_BLUEPRINT_MISSING = "sim_garment.blueprint_missing";
export const SIM_GARMENT_BLUEPRINT_UNREADABLE = "sim_garment.blueprint_unreadable";
export const SIM_GARMENT_SLOT_UNMAPPED = "sim_garment.slot_unmapped";

/** One worn item, resolved. */
export interface SimGarmentRead {
  /** The chat-lane instance shape, so `garmentReadout`/`garmentEffectiveCoverage` apply unchanged. */
  instance: GarmentInstanceState;
  /** The parsed construction, or the marked degraded sentinel. */
  blueprint: GarmentBlueprint;
  /** The worn slot key, parsed against the registries. */
  slot: SuccessorWornSlot;
  /** False when the blueprint static was missing or unreadable — coverage must degrade to COVERED. */
  reliable: boolean;
  /**
   * What the SLOT alone says this garment covers, for use only when `reliable`
   * is false. Empty means the slot says nothing — never that the garment covers
   * nothing (`successorWornSlotCoverage`).
   */
  conservativeCoverage: string[];
}

export interface ActorGarmentRead {
  /** Worn instances in slot order — the `ChatGarmentStore.instances` shape. */
  instances: GarmentInstanceState[];
  /** Content-hash map — the `ChatGarmentStore.blueprints` shape, so `garmentBlueprintFor` works. */
  blueprints: Record<string, GarmentBlueprint>;
  /** Per-garment detail, same order as `instances`. */
  garments: SimGarmentRead[];
  diagnostics: Diagnostic[];
  /** True only when EVERY garment resolved a trustworthy blueprint. */
  reliable: boolean;
}

/** The empty read: this actor wears nothing the branch knows about. */
export function emptyActorGarmentRead(): ActorGarmentRead {
  return { instances: [], blueprints: {}, garments: [], diagnostics: [], reliable: true };
}

/**
 * Parse one stored `garment_blueprint` column.
 *
 * The root check is the reason this is not a bare `parseOr`: a column holding
 * `{}` parses CLEANLY into a graph with no parts, which would then read as a
 * garment authored to cover nothing. A blueprint whose declared root node is
 * absent cannot have come from the mint (`garmentBlueprintForSeed` always
 * carries its template's root, and the degraded sentinel carries its own), so
 * it is corruption and is reported as such. That is a STRUCTURAL check, never a
 * heuristic on empty coverage — jewelry legitimately covers nothing.
 */
function resolveStoredBlueprint(
  raw: unknown,
): { blueprint: GarmentBlueprint; reliable: boolean; code?: string; detail?: string } {
  if (raw === null || raw === undefined) {
    return {
      blueprint: degradedGarmentBlueprint(),
      reliable: false,
      code: SIM_GARMENT_BLUEPRINT_MISSING,
      detail: "carries no garment blueprint",
    };
  }
  const parsed = parseOrNull(garmentBlueprintSchema, raw);
  if (parsed === null || garmentRootNode(parsed) === undefined) {
    return {
      blueprint: degradedGarmentBlueprint(),
      reliable: false,
      code: SIM_GARMENT_BLUEPRINT_UNREADABLE,
      detail: "stores a garment blueprint that is not a readable part graph",
    };
  }
  if (isDegradedGarmentBlueprint(parsed)) {
    // Parsed, but it lost coverage-bearing construction on the way — the same
    // state the chat lane's `resolveGarmentBlueprint` reports unreliable.
    return {
      blueprint: parsed,
      reliable: false,
      code: SIM_GARMENT_BLUEPRINT_UNREADABLE,
      detail: "stores a garment blueprint that lost coverage-bearing parts",
    };
  }
  return { blueprint: parsed, reliable: true };
}

/** Clamp an integrated meter into the shared 0..1 fixed-point garment unit. */
function garmentUnit(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(GARMENT_UNIT_ONE, Math.round(value)));
}

/**
 * Resolve an actor's worn garments inside a caller's transaction.
 *
 * Ordered by slot key, matching `readSimChatOutfit`, so the two successor
 * surfaces enumerate one outfit in one order.
 */
export async function readActorGarmentInstances(
  tx: SimTx,
  branchId: string,
  actorId: string,
): Promise<ActorGarmentRead> {
  const [branch] = await tx
    .select({ storySecond: simBranches.storySecond })
    .from(simBranches)
    .where(eq(simBranches.id, branchId))
    .limit(1);
  if (!branch) return emptyActorGarmentRead();

  const rows = await tx
    .select({
      itemId: simItems.itemId,
      name: simItems.name,
      garmentBlueprint: simItems.garmentBlueprint,
      conditionTracked: simItems.conditionTracked,
      slotKey: simItemHoldings.slotKey,
    })
    .from(simItemHoldings)
    .innerJoin(
      simItems,
      and(eq(simItems.branchId, simItemHoldings.branchId), eq(simItems.itemId, simItemHoldings.itemId)),
    )
    .where(
      and(
        eq(simItemHoldings.branchId, branchId),
        eq(simItemHoldings.locusKind, "worn"),
        eq(simItemHoldings.actorId, actorId),
      ),
    )
    .orderBy(asc(simItemHoldings.slotKey));
  if (rows.length === 0) return emptyActorGarmentRead();

  const collector = new DiagnosticCollector();
  const itemIds = rows.map((row) => row.itemId);
  const [stateRows, conditionViews] = await Promise.all([
    loadItemGarmentStateRows(tx, branchId, itemIds, collector),
    loadItemConditionViews(
      tx,
      branchId,
      rows.filter((row) => row.conditionTracked).map((row) => row.itemId),
    ),
  ]);

  const blueprints: Record<string, GarmentBlueprint> = {};
  const garments: SimGarmentRead[] = [];
  for (const row of rows) {
    const resolved = resolveStoredBlueprint(row.garmentBlueprint);
    if (resolved.code) {
      collector.push(
        diag("warn", resolved.code, `worn item ${row.itemId} ${resolved.detail} — read as degraded and covered`, {
          path: "sim_garment.read",
          context: { itemId: row.itemId, branchId },
        }),
      );
    }
    const hash = garmentBlueprintHash(resolved.blueprint);
    blueprints[hash] = resolved.blueprint;

    const slot = parseSuccessorWornSlotKey(row.slotKey ?? "");
    if (slot.kind === "unknown") {
      collector.push(
        diag("info", SIM_GARMENT_SLOT_UNMAPPED, `worn slot "${slot.raw}" matches no clothing category or body location`, {
          path: "sim_garment.slot",
          context: { itemId: row.itemId, slotKey: slot.raw },
        }),
      );
    }

    const state = stateRows.get(row.itemId) ?? neutralItemGarmentState(row.itemId);
    // Cleanliness and wear are the item-condition meters' channels, not this
    // projection's: integrate them to the branch clock and copy them over the
    // stored base vector, so there is exactly one owner per channel. Units
    // match by construction — `GARMENT_UNIT_ONE === METER_FIXED_POINT_ONE`, and
    // both scales agree on direction (10 000 clean/fresh, 0 pristine wear).
    // An untracked item, or a tracked one whose meters have not lazily
    // initialized yet, keeps the chat defaults, which are the same values.
    const condition = conditionViews.get(row.itemId);
    const base = { ...state.condition.base };
    if (condition) {
      const cleanliness = meterViewOfItem(condition, "cleanliness");
      if (cleanliness) base.cleanliness = garmentUnit(integrateMeterValue(cleanliness, branch.storySecond));
      const wear = meterViewOfItem(condition, "wear");
      if (wear) base.wear = garmentUnit(integrateMeterValue(wear, branch.storySecond));
    }

    const instance: GarmentInstanceState = {
      id: row.itemId,
      blueprintHash: hash,
      // The instance's `name` is capped shorter than `sim_items.name`; slice
      // rather than let the schema's `.catch` blank a long name to "garment".
      name: row.name.trim().slice(0, 120) || "garment",
      locus: { kind: "worn", actorId },
      presentation: state.presentation,
      condition: { ...state.condition, base },
      // The chat instance's novelty stamp is a CHAT-clock minute, and the
      // successor branch keeps story SECONDS; there is no honest conversion, so
      // the read carries the neutral stamp rather than a converted one. A
      // consumer integrating condition passes its own `atMinutes` to
      // `garmentReadout` exactly as the chat lane does.
      lastChange: { kind: "mint", atMinutes: 0 },
    };
    garments.push({
      instance,
      blueprint: resolved.blueprint,
      slot,
      reliable: resolved.reliable,
      conservativeCoverage: resolved.reliable ? [] : successorWornSlotCoverage(slot),
    });
  }

  return {
    instances: garments.map((garment) => garment.instance),
    blueprints,
    garments,
    diagnostics: collector.items,
    reliable: garments.every((garment) => garment.reliable),
  };
}

/**
 * The standalone read: one repeatable-read snapshot so the branch clock and the
 * garment rows integrated against it come from the same instant, the same
 * discipline `readSimChatMeters` uses.
 */
export async function readDurableActorGarments(
  branchId: string,
  actorId: string,
  database: Db = db(),
): Promise<ActorGarmentRead> {
  return database.transaction(
    async (tx) => readActorGarmentInstances(tx, branchId, actorId),
    { isolationLevel: "repeatable read", accessMode: "read only" },
  );
}
