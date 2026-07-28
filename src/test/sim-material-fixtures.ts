import type { z } from "zod";
import {
  bodyMeterDefinitionSchema,
  bodyMeterStateSchema,
  type BodyMeterDefinition,
  type BodyMeterState,
  type BodyModifier,
} from "@/contracts/simulation/bodies";
import { itemLocusSchema, type ItemLocus } from "@/contracts/simulation/materials";
import type { ConsumptionBodyView } from "@/lib/simulation/materials";

/**
 * Item-locus and body-meter fixtures shared by the materials/activities/
 * material-condition suites.
 *
 * Loci go through `itemLocusSchema` (like the per-file copies) so a plain-string
 * id is properly branded: a raw literal annotated as `ItemLocus` would demand
 * the caller already hold branded ids, which these tests deliberately don't
 * carry. The meter builders take `z.input` override shapes for the same reason.
 */

/** The actor the meter fixtures belong to unless a suite says otherwise. */
export const TEST_ACTOR_ID = "mara";

/** The registry stamp every meter-state fixture carries. */
export const TEST_BODY_REGISTRY_VERSION = "body-v1";

export const heldBy = (actorId: string): ItemLocus => itemLocusSchema.parse({ kind: "held", actorId });

export const wornBy = (actorId: string, slotKey: string): ItemLocus =>
  itemLocusSchema.parse({ kind: "worn", actorId, slotKey });

export const inContainer = (containerItemId: string): ItemLocus =>
  itemLocusSchema.parse({ kind: "container", containerItemId });

export const atZone = (zoneId: string): ItemLocus => itemLocusSchema.parse({ kind: "zone", zoneId });

/**
 * The linear rate meter the consumption fixtures use: hunger, draining 150
 * fixed-point per hour toward zero from a comfortable 9 000, no thresholds.
 * Override `thresholds` for a threshold-crossing case, or `class`/`driftLaw`
 * wholesale for a proportional-decay reserve.
 */
export function meterDefinition(
  overrides: Partial<z.input<typeof bodyMeterDefinitionSchema>> = {},
): BodyMeterDefinition {
  return bodyMeterDefinitionSchema.parse({
    key: "hunger",
    class: "rate",
    driftLaw: {
      kind: "linear",
      ratePerHourFixedPoint: 150,
      target: { kind: "fixed", valueFixedPoint: 0 },
    },
    initialFixedPoint: 9_000,
    baselineFixedPoint: 0,
    thresholds: [],
    ...overrides,
  });
}

/** A meter row sitting at its definition's initial value, integrated at story second 0. */
export function meterState(
  definition: BodyMeterDefinition,
  overrides: Partial<z.input<typeof bodyMeterStateSchema>> = {},
): BodyMeterState {
  return bodyMeterStateSchema.parse({
    actorId: TEST_ACTOR_ID,
    meterKey: definition.key,
    valueFixedPoint: definition.initialFixedPoint,
    baselineFixedPoint: definition.baselineFixedPoint,
    lastIntegratedAtStorySecond: 0,
    registryVersion: TEST_BODY_REGISTRY_VERSION,
    ...overrides,
  });
}

/**
 * An initialized body that knows exactly ONE meter — every other key reads
 * `undefined`, which is what proves a consumption effect against an unknown
 * meter degrades rather than throwing.
 */
export function singleMeterBodyView(
  definition: BodyMeterDefinition,
  options: { actorId?: string; storySecond?: number; modifiers?: readonly BodyModifier[] } = {},
): ConsumptionBodyView {
  const state = meterState(definition, {
    actorId: options.actorId ?? TEST_ACTOR_ID,
    lastIntegratedAtStorySecond: options.storySecond ?? 10_000,
  });
  const modifiers = options.modifiers ?? [];
  return {
    bodyInitialized: true,
    meterView: (meterKey) => (meterKey === definition.key ? { definition, state, modifiers } : undefined),
  };
}
