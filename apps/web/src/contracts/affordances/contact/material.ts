import { z } from "zod";
import {
  AFFORDANCE_UNIT_ONE,
  affordanceEvidenceKinds,
  mergeAffordanceEvidence,
  multiplyUnits,
  unitIntervalSchema,
  type AffordanceEvidence,
  type UnitInterval,
} from "../core";

/**
 * What lies between the two surfaces, and what it lets through
 * (romantic-contact-affordances.spec.contact-core.md §"Material-between
 * composition").
 *
 * The core knows about LAYERS, not clothes. A layer is anything an owner says is
 * interposed — a sock, a skirt, a blanket, a wet towel — reduced to what a
 * contact calculation actually needs: how much of each channel survives the
 * crossing. That reduction is the whole reason this file is domain-neutral
 * enough to sit in the shared core: the wardrobe keeps the garment, the graph,
 * the closures, and the displacement; the contact layer gets six numbers and a
 * provenance trail, and can never be tempted to keep a second catalog of them.
 *
 * Two laws the composition enforces:
 *
 * 1. **Blocking and transmission are different questions.** A layer may transmit
 *    touch fully and still block direct skin contact — that is the difference
 *    between feeling a foot through a stocking and feeling the foot. So
 *    `directSkinContact` is not derived from any transmission value: it is false
 *    whenever a layer is present, full stop.
 * 2. **Channels compose multiplicatively and can only ever damp.**
 *    `multiplyUnits` floors at every step, so adding a layer can never raise
 *    what reaches the other side, and no ordering of the layers changes the
 *    result. That is what makes an adapter's list order a presentation detail
 *    rather than a physical claim.
 */

/** One interposed layer, as the lane's wardrobe/material owner reports it. */
export interface ContactMaterialLayerRead {
  /** The owner's own instance/part id. Opaque; carried for evidence and identity. */
  readonly layerId: string;
  /** 0 is nearest the SOURCE surface. Ties break on `layerId`, so order is total. */
  readonly order: number;
  readonly tactileTransmission: UnitInterval;
  readonly shapeTransmission: UnitInterval;
  readonly thermalTransmission: UnitInterval;
  readonly moistureTransmission: UnitInterval;
  readonly scentTransmission: UnitInterval;
  readonly visibleThrough: boolean;
  readonly evidence: readonly AffordanceEvidence[];
}

/** The composed answer for the whole stack. */
export interface ContactMaterialTransmissionRead {
  /** True only when NOTHING is between the two surfaces. */
  readonly directSkinContact: boolean;
  /** Layer ids source→target. Order is identity: it must survive a retake. */
  readonly layerIds: readonly string[];
  readonly tactileTransmission: UnitInterval;
  readonly shapeTransmission: UnitInterval;
  readonly thermalTransmission: UnitInterval;
  readonly moistureTransmission: UnitInterval;
  readonly scentTransmission: UnitInterval;
  readonly visibleThrough: boolean;
  readonly evidence: readonly AffordanceEvidence[];
}

const evidenceSchema: z.ZodType<AffordanceEvidence> = z.object({
  kind: z.enum(affordanceEvidenceKinds),
  ref: z.string().min(1),
  detail: z.string().optional(),
});

/** Boundary schema for a layer read. Strict: a bad magnitude is not repaired. */
export const contactMaterialLayerReadSchema: z.ZodType<ContactMaterialLayerRead> = z.object({
  layerId: z.string().trim().min(1).max(256),
  order: z.number().int().min(-1_000).max(1_000),
  tactileTransmission: unitIntervalSchema,
  shapeTransmission: unitIntervalSchema,
  thermalTransmission: unitIntervalSchema,
  moistureTransmission: unitIntervalSchema,
  scentTransmission: unitIntervalSchema,
  visibleThrough: z.boolean(),
  evidence: z.array(evidenceSchema).readonly(),
});

/** The evidence schema, exported so the state parser reuses one definition. */
export { evidenceSchema as contactEvidenceSchema };

/**
 * Layers in a total, deterministic order: by `order`, then by `layerId`.
 *
 * The tie-break is not decoration. An adapter reading the same cut twice may
 * legitimately return two layers with the same offset in either order, and a
 * transmission read whose `layerIds` depended on that would break the retake
 * fingerprint while the physics stayed identical.
 */
export function sortContactMaterialLayers(
  layers: readonly ContactMaterialLayerRead[],
): readonly ContactMaterialLayerRead[] {
  return [...layers].sort((left, right) =>
    left.order === right.order ? left.layerId.localeCompare(right.layerId) : left.order - right.order,
  );
}

/** Nothing between the surfaces: every channel fully open, skin on skin. */
export function directContactTransmission(
  evidence: readonly AffordanceEvidence[] = [],
): ContactMaterialTransmissionRead {
  return {
    directSkinContact: true,
    layerIds: [],
    tactileTransmission: AFFORDANCE_UNIT_ONE,
    shapeTransmission: AFFORDANCE_UNIT_ONE,
    thermalTransmission: AFFORDANCE_UNIT_ONE,
    moistureTransmission: AFFORDANCE_UNIT_ONE,
    scentTransmission: AFFORDANCE_UNIT_ONE,
    visibleThrough: true,
    evidence,
  };
}

/**
 * Compose a stack into one transmission read.
 *
 * An empty stack is direct contact — the only way `directSkinContact` is ever
 * true. One fully-transparent layer is NOT the same answer: it transmits
 * everything and still means the surfaces are not touching each other.
 */
export function composeContactMaterial(
  layers: readonly ContactMaterialLayerRead[],
  extraEvidence: readonly AffordanceEvidence[] = [],
): ContactMaterialTransmissionRead {
  const ordered = sortContactMaterialLayers(layers);
  if (ordered.length === 0) return directContactTransmission(extraEvidence);

  let tactile = AFFORDANCE_UNIT_ONE;
  let shape = AFFORDANCE_UNIT_ONE;
  let thermal = AFFORDANCE_UNIT_ONE;
  let moisture = AFFORDANCE_UNIT_ONE;
  let scent = AFFORDANCE_UNIT_ONE;
  let visibleThrough = true;
  const evidence: (readonly AffordanceEvidence[])[] = [extraEvidence];

  for (const layer of ordered) {
    tactile = multiplyUnits(tactile, layer.tactileTransmission);
    shape = multiplyUnits(shape, layer.shapeTransmission);
    thermal = multiplyUnits(thermal, layer.thermalTransmission);
    moisture = multiplyUnits(moisture, layer.moistureTransmission);
    scent = multiplyUnits(scent, layer.scentTransmission);
    visibleThrough = visibleThrough && layer.visibleThrough;
    evidence.push(layer.evidence);
  }

  return {
    directSkinContact: false,
    layerIds: ordered.map((layer) => layer.layerId),
    tactileTransmission: tactile,
    shapeTransmission: shape,
    thermalTransmission: thermal,
    moistureTransmission: moisture,
    scentTransmission: scent,
    visibleThrough,
    evidence: mergeAffordanceEvidence(...evidence),
  };
}
