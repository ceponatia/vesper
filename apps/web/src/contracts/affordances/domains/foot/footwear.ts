import { z } from "zod";
import { diag, type Diagnostic } from "../../../diagnostics";
import {
  composeContactMaterial,
  sortContactMaterialLayers,
  type ContactMaterialLayerRead,
  type ContactMaterialTransmissionRead,
} from "../../contact";
import {
  affordanceEvidence,
  multiplyUnits,
  unitIntervalSchema,
  AFFORDANCE_UNIT_ONE,
  AFFORDANCE_UNIT_ZERO,
  type AffordanceEvidence,
  type UnitInterval,
} from "../../core";
import { footSurfaceIds, footSurfaceSubtree, type FootSurfaceId } from "./topology";

/**
 * Footwear as a FILTER, never as a fact about the whole foot
 * (romantic-contact-affordances.spec.foot.md §"Footwear integration").
 *
 * The wardrobe supplies sparse semantic parts and this file maps them onto the
 * surfaces they contain. That mapping is the entire point: a peep-toe pump and a
 * sock are both "footwear", and treating either as covering "the foot" is how a
 * narrator ends up describing bare toes inside a shoe or a blocked sole through
 * an open sandal.
 *
 * Everything here is a READ. There is no function that opens a closure, removes
 * a layer, or changes what a part covers — those are committed wardrobe actions,
 * and the spec is explicit that the affordance domain keeps no memory of them.
 * A different answer requires a different payload.
 */

export const footwearKinds = ["sock", "hosiery", "shoe"] as const;
export const footwearKindSchema = z.enum(footwearKinds);
export type FootwearKind = z.infer<typeof footwearKindSchema>;

/** The wardrobe's sock/hosiery part vocabulary, verbatim from the spec. */
export const footwearSockPartIds = ["cuff", "leg_section", "heel_section", "sole_section", "toe_section"] as const;

/** The wardrobe's shoe part vocabulary, verbatim from the spec. */
export const footwearShoePartIds = [
  "upper",
  "toe_box",
  "tongue",
  "closure",
  "heel_counter",
  "insole",
  "outsole",
] as const;

export const footwearPartIds = [...footwearSockPartIds, ...footwearShoePartIds] as const;
export const footwearPartIdSchema = z.enum(footwearPartIds);
export type FootwearPartId = z.infer<typeof footwearPartIdSchema>;

/**
 * Which foot surfaces each part contains. Roots expand to their subtrees, so
 * `sole_section` reaches the arch and the ball without naming them.
 *
 * `outsole` maps to NOTHING on purpose: it is the outside of the shoe and
 * touches the ground, not the wearer. It stays in the vocabulary because the
 * wardrobe has one, and its empty row is what makes "footwear filters the
 * correct surfaces rather than the whole foot" a checkable claim.
 */
const FOOTWEAR_PART_ROOTS: Readonly<Record<FootwearPartId, readonly FootSurfaceId[]>> = {
  cuff: ["ankle_boundary"],
  leg_section: ["ankle_boundary"],
  heel_section: ["heel_pad"],
  sole_section: ["plantar_surface"],
  toe_section: ["toes"],
  upper: ["dorsal_surface", "inner_edge", "outer_edge"],
  toe_box: ["toes"],
  tongue: ["dorsal_surface"],
  closure: ["dorsal_surface", "ankle_boundary"],
  heel_counter: ["heel_pad", "ankle_boundary"],
  insole: ["plantar_surface"],
  outsole: [],
};

/** Every surface one part contains, subtrees expanded, in topology order. */
export function footwearPartSurfaces(partId: FootwearPartId): readonly FootSurfaceId[] {
  const reached = new Set(FOOTWEAR_PART_ROOTS[partId].flatMap((root) => footSurfaceSubtree(root)));
  return footSurfaceIds.filter((surfaceId) => reached.has(surfaceId));
}

/**
 * The material register a toucher meets through this layer. A closed set: the
 * texture phenomenon turns it into `<tag>_filtered`, and free text there would be
 * narrator prose arriving through a structured field.
 */
export const footwearFilterTags = [
  "ribbed_sock",
  "smooth_sock",
  "wool_sock",
  "stocking",
  "leather",
  "synthetic",
  "unknown",
] as const;
export const footwearFilterTagSchema = z.enum(footwearFilterTags);
export type FootwearFilterTag = z.infer<typeof footwearFilterTagSchema>;

/** Ordered loosest-first; `unknown` is not a position on that scale. */
export const footwearClosureStates = ["open", "loose", "secured", "unknown"] as const;
export const footwearClosureStateSchema = z.enum(footwearClosureStates);
export type FootwearClosureState = z.infer<typeof footwearClosureStateSchema>;

/** One worn item as the wardrobe reports it. */
export const footwearItemSchema = z
  .object({
    layerId: z.string().trim().min(1).max(160),
    kind: footwearKindSchema,
    /** 0 is nearest the skin. Ties break on `layerId`, so the stack is total. */
    order: z.number().int().min(-100).max(100),
    parts: z.array(footwearPartIdSchema).max(16).readonly(),
    filterTag: footwearFilterTagSchema,
    compression: unitIntervalSchema,
    rigidity: unitIntervalSchema,
    toeBoxVolume: unitIntervalSchema,
    ankleRestriction: unitIntervalSchema,
    effectiveFriction: unitIntervalSchema,
    permeability: unitIntervalSchema,
    closureState: footwearClosureStateSchema,
    tactileTransmission: unitIntervalSchema,
    shapeTransmission: unitIntervalSchema,
    visibleThrough: z.boolean(),
  })
  .strict();
export type FootwearItemRead = z.infer<typeof footwearItemSchema>;

/**
 * What the wardrobe read got wrong. Reported rather than silently repaired.
 *
 * One member today, because a constant nobody pushes is a promise the surface
 * cannot keep. It is a list of codes rather than a boolean so a second anomaly
 * (an unknown part, a stack the compile had to truncate) joins it without every
 * consumer changing shape.
 */
export const footwearAnomalyCodes = ["duplicate_layer_id"] as const;
export const footwearAnomalyCodeSchema = z.enum(footwearAnomalyCodes);
export type FootwearAnomalyCode = z.infer<typeof footwearAnomalyCodeSchema>;

export interface FootwearAnomalyRead {
  readonly code: FootwearAnomalyCode;
  /** The wardrobe's own id the anomaly is about. */
  readonly layerId: string;
  /** How many rows were canonicalized into the one layer. Always ≥ 2. */
  readonly rows: number;
}

/** Diagnostic code: the compile canonicalized a malformed wardrobe read. `warn`. */
export const FOOT_FOOTWEAR_ANOMALY = "foot.footwear.anomaly";

export interface FootwearContactRead {
  /** Every worn item as a contact-core layer, source-first. One per `layerId`. */
  readonly coveringLayers: readonly ContactMaterialLayerRead[];
  /** Every foot surface at least one item contains, in topology order. */
  readonly containedSurfaces: readonly FootSurfaceId[];
  readonly compression: UnitInterval;
  readonly rigidity: UnitInterval;
  readonly toeBoxVolume: UnitInterval;
  readonly ankleRestriction: UnitInterval;
  readonly effectiveFriction: UnitInterval;
  readonly permeability: UnitInterval;
  readonly closureState: FootwearClosureState;
  /** `layerId` → the surfaces that one layer contains. */
  readonly surfacesByLayer: Readonly<Record<string, readonly FootSurfaceId[]>>;
  /** `layerId` → the material register a toucher meets through it. */
  readonly filterTagByLayer: Readonly<Record<string, FootwearFilterTag>>;
  /** What the compile had to repair to produce this read. Empty is the ordinary case. */
  readonly anomalies: readonly FootwearAnomalyRead[];
  readonly evidence: readonly AffordanceEvidence[];
}

/**
 * The anomalies as diagnostics, for the domain stage that owns a diagnostics
 * channel.
 *
 * `compileFootwearContact` stays pure and sinkless — it is called from
 * `readInputs`, which by the adapter result law returns a value and not a log —
 * so the anomaly rides the read and `deriveMechanics` (which returns
 * `DomainMechanicsResult.diagnostics`) files it. Same shape the profile stage
 * already uses for a provisional axis.
 */
export function footwearAnomalyDiagnostics(read: FootwearContactRead | undefined): readonly Diagnostic[] {
  return (read?.anomalies ?? []).map((anomaly) =>
    diag("warn", FOOT_FOOTWEAR_ANOMALY, `footwear layer "${anomaly.layerId}" was reported ${anomaly.rows} times`, {
      path: "foot.footwear",
      context: { code: anomaly.code, layerId: anomaly.layerId, rows: anomaly.rows },
    }),
  );
}

/** Nothing worn. Distinct from "we could not read the wardrobe", which is an absent input. */
export function bareFootwearContact(): FootwearContactRead {
  return {
    coveringLayers: [],
    containedSurfaces: [],
    compression: AFFORDANCE_UNIT_ZERO,
    rigidity: AFFORDANCE_UNIT_ZERO,
    toeBoxVolume: AFFORDANCE_UNIT_ONE,
    ankleRestriction: AFFORDANCE_UNIT_ZERO,
    effectiveFriction: AFFORDANCE_UNIT_ZERO,
    permeability: AFFORDANCE_UNIT_ONE,
    closureState: "open",
    surfacesByLayer: {},
    filterTagByLayer: {},
    anomalies: [],
    evidence: [],
  };
}

/**
 * One item as a contact-core material layer.
 *
 * Permeability drives the moisture, scent, and thermal channels because it is
 * the one thing the wardrobe actually knows about a shoe's throughput; the
 * tactile and shape channels are authored separately because a stiff leather
 * upper and a sheer stocking can share a permeability and transmit nothing alike.
 */
function footwearLayer(item: FootwearItemRead): ContactMaterialLayerRead {
  return {
    layerId: item.layerId,
    order: item.order,
    tactileTransmission: item.tactileTransmission,
    shapeTransmission: item.shapeTransmission,
    thermalTransmission: item.permeability,
    moistureTransmission: item.permeability,
    scentTransmission: item.permeability,
    visibleThrough: item.visibleThrough,
    evidence: [affordanceEvidence("coverage", `footwear:${item.layerId}`, item.filterTag)],
  };
}

const CLOSURE_RANK: Readonly<Record<FootwearClosureState, number>> = { open: 0, loose: 1, secured: 2, unknown: 3 };

/**
 * The stack's closure state.
 *
 * `unknown` on ANY item wins: a stack containing a shoe whose closure nobody
 * could read is a stack that cannot be called loose, and heel slip is a claim
 * that needs a positive answer. Otherwise the loosest item decides, because an
 * unfastened outer boot is what a heel actually slips inside.
 */
function aggregateClosure(items: readonly FootwearItemRead[]): FootwearClosureState {
  if (items.length === 0) return "open";
  if (items.some((item) => item.closureState === "unknown")) return "unknown";
  return items.reduce<FootwearClosureState>(
    (loosest, item) => (CLOSURE_RANK[item.closureState] < CLOSURE_RANK[loosest] ? item.closureState : loosest),
    "secured",
  );
}

const highest = (values: readonly UnitInterval[]): UnitInterval =>
  values.reduce<UnitInterval>((best, value) => (value > best ? value : best), AFFORDANCE_UNIT_ZERO);

const lowest = (values: readonly UnitInterval[]): UnitInterval =>
  values.reduce<UnitInterval>((best, value) => (value < best ? value : best), AFFORDANCE_UNIT_ONE);

/**
 * Fold rows that share a `layerId` into ONE canonical item.
 *
 * `layerId` is the wardrobe's own instance id and this domain cannot make it
 * unique, so two rows carrying one is a malformed lane read. Silently unioning
 * them left the compile deciding by input order — an adapter that returned the
 * same cut twice in a different order produced two different filter registers —
 * and dropping the whole read would be worse still, because an unreadable
 * wardrobe that makes a shod foot read bare is the one direction this layer must
 * never fail in. So the rows are merged by a stated rule per field, and the
 * merge is REPORTED (see `anomalies`) rather than accepted in silence.
 *
 * Every rule is the conservative one, and the same rule the multi-item
 * composition below already uses where there is one:
 *
 * - restrictive terms (`compression`, `rigidity`, `ankleRestriction`) take the
 *   MAXIMUM, as they do across items;
 * - `toeBoxVolume` takes the minimum — the tightest claim wins;
 * - `permeability`, `tactileTransmission`, and `shapeTransmission` take the
 *   minimum: damping terms, and a merged row must not let through more than the
 *   least generous row said;
 * - `effectiveFriction` takes the maximum, because `slippery` is the positive
 *   claim and drag is the answer that refuses to make it;
 * - `visibleThrough` is an AND;
 * - `parts` union, so no surface loses its cover — the reason the original union
 *   existed;
 * - `filterTag` survives only if every row AGREES; disagreement collapses to
 *   `unknown`, exactly as an unreadable closure does, because "what does a
 *   toucher meet here" now has two answers and neither is evidence;
 * - `closureState` reuses `aggregateClosure`;
 * - `order` takes the minimum (the innermost position claimed) and `kind` the
 *   most enclosing (`sock` < `hosiery` < `shoe`), so both are a function of the
 *   rows rather than of their arrival order.
 */
function canonicalFootwearItem(rows: readonly FootwearItemRead[], first: FootwearItemRead): FootwearItemRead {
  if (rows.length === 1) return first;
  const parts = new Set(rows.flatMap((row) => row.parts));
  const tags = new Set(rows.map((row) => row.filterTag));
  const onlyTag = [...tags][0];
  return {
    layerId: first.layerId,
    kind: rows.reduce<FootwearKind>(
      (widest, row) => (footwearKinds.indexOf(row.kind) > footwearKinds.indexOf(widest) ? row.kind : widest),
      "sock",
    ),
    order: rows.reduce((innermost, row) => (row.order < innermost ? row.order : innermost), first.order),
    parts: footwearPartIds.filter((partId) => parts.has(partId)),
    filterTag: tags.size === 1 && onlyTag !== undefined ? onlyTag : "unknown",
    compression: highest(rows.map((row) => row.compression)),
    rigidity: highest(rows.map((row) => row.rigidity)),
    toeBoxVolume: lowest(rows.map((row) => row.toeBoxVolume)),
    ankleRestriction: highest(rows.map((row) => row.ankleRestriction)),
    effectiveFriction: highest(rows.map((row) => row.effectiveFriction)),
    permeability: lowest(rows.map((row) => row.permeability)),
    closureState: aggregateClosure(rows),
    tactileTransmission: lowest(rows.map((row) => row.tactileTransmission)),
    shapeTransmission: lowest(rows.map((row) => row.shapeTransmission)),
    visibleThrough: rows.every((row) => row.visibleThrough),
  };
}

/** One item per `layerId`, in stack order, plus what had to be repaired. */
function canonicalFootwearItems(ordered: readonly FootwearItemRead[]): {
  readonly items: readonly FootwearItemRead[];
  readonly anomalies: readonly FootwearAnomalyRead[];
} {
  const rowsByLayer = new Map<string, FootwearItemRead[]>();
  for (const item of ordered) {
    const rows = rowsByLayer.get(item.layerId);
    if (rows === undefined) rowsByLayer.set(item.layerId, [item]);
    else rows.push(item);
  }
  const items: FootwearItemRead[] = [];
  const anomalies: FootwearAnomalyRead[] = [];
  for (const [layerId, rows] of rowsByLayer) {
    const first = rows[0];
    if (first === undefined) continue;
    items.push(canonicalFootwearItem(rows, first));
    if (rows.length > 1) anomalies.push({ code: "duplicate_layer_id", layerId, rows: rows.length });
  }
  // The merge can move an item's `order`, so the stack is re-sorted rather than
  // trusted to have kept the pre-merge sequence.
  return { items: sortFootwearItems(items), anomalies };
}

function sortFootwearItems(items: readonly FootwearItemRead[]): readonly FootwearItemRead[] {
  return [...items].sort((left, right) =>
    left.order === right.order ? left.layerId.localeCompare(right.layerId) : left.order - right.order,
  );
}

/**
 * Compile the worn stack into one read.
 *
 * Restrictive terms take the MAXIMUM across items (a rigid boot over a soft sock
 * is a rigid foot) and permeability takes the product (every layer damps). Toe
 * box volume takes the minimum across items that actually contain toes, so a
 * roomy boot over a tight sock reads tight and an open-toed sandal contributes
 * nothing at all.
 *
 * Rows sharing a `layerId` are canonicalized into one item first, so everything
 * below sees a stack with one row per id.
 */
export function compileFootwearContact(items: readonly FootwearItemRead[]): FootwearContactRead {
  if (items.length === 0) return bareFootwearContact();

  const canonical = canonicalFootwearItems(sortFootwearItems(items));
  const ordered = canonical.items;

  const surfacesByLayer: Record<string, readonly FootSurfaceId[]> = {};
  const filterTagByLayer: Record<string, FootwearFilterTag> = {};
  const contained = new Set<FootSurfaceId>();
  for (const item of ordered) {
    const reached = new Set(item.parts.flatMap((partId) => footwearPartSurfaces(partId)));
    surfacesByLayer[item.layerId] = footSurfaceIds.filter((surfaceId) => reached.has(surfaceId));
    filterTagByLayer[item.layerId] = item.filterTag;
    for (const surfaceId of reached) contained.add(surfaceId);
  }

  const worst = (pick: (item: FootwearItemRead) => UnitInterval): UnitInterval =>
    ordered.reduce<UnitInterval>((highest, item) => {
      const value = pick(item);
      return value > highest ? value : highest;
    }, AFFORDANCE_UNIT_ZERO);

  const toeHolders = ordered.filter((item) => (surfacesByLayer[item.layerId] ?? []).includes("toes"));
  const toeBoxVolume = toeHolders.reduce<UnitInterval>(
    (tightest, item) => (item.toeBoxVolume < tightest ? item.toeBoxVolume : tightest),
    AFFORDANCE_UNIT_ONE,
  );

  const permeability = ordered.reduce<UnitInterval>(
    (open, item) => multiplyUnits(open, item.permeability),
    AFFORDANCE_UNIT_ONE,
  );

  const layers = sortContactMaterialLayers(ordered.map((item) => footwearLayer(item)));

  return {
    coveringLayers: layers,
    containedSurfaces: footSurfaceIds.filter((surfaceId) => contained.has(surfaceId)),
    compression: worst((item) => item.compression),
    rigidity: worst((item) => item.rigidity),
    toeBoxVolume,
    ankleRestriction: worst((item) => item.ankleRestriction),
    // The surface a toucher actually meets is the outermost one.
    effectiveFriction: ordered[ordered.length - 1]?.effectiveFriction ?? AFFORDANCE_UNIT_ZERO,
    permeability,
    closureState: aggregateClosure(ordered),
    surfacesByLayer,
    filterTagByLayer,
    anomalies: canonical.anomalies,
    evidence: ordered.map((item) => affordanceEvidence("coverage", `footwear:${item.layerId}`, item.kind)),
  };
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

export function footwearCovers(read: FootwearContactRead, surfaceId: FootSurfaceId): boolean {
  return read.containedSurfaces.includes(surfaceId);
}

/** The layers between a toucher and one surface, source-first. Empty ⇒ bare there. */
export function footwearLayersAt(
  read: FootwearContactRead,
  surfaceId: FootSurfaceId,
): readonly ContactMaterialLayerRead[] {
  return read.coveringLayers.filter((layer) => (read.surfacesByLayer[layer.layerId] ?? []).includes(surfaceId));
}

/**
 * What a toucher gets at one surface.
 *
 * `directSkinContact` comes from the contact core's own composition, so the
 * spec's first invariant — socks, hosiery and shoes block direct skin where
 * their parts cover — is the core's law rather than a rule this file restates.
 */
export function footwearTransmissionAt(
  read: FootwearContactRead,
  surfaceId: FootSurfaceId,
): ContactMaterialTransmissionRead {
  return composeContactMaterial(footwearLayersAt(read, surfaceId));
}

/** Rigidity at which a shoe holds its own shape rather than the foot's. */
export const FOOTWEAR_RIGID_MIN = 6_000;
/** Compression at which the stack grips hard enough to stop small movement. */
export const FOOTWEAR_TIGHT_MIN = 7_000;
/** Toe-box volume below which the toes have nowhere to go. */
export const FOOTWEAR_TIGHT_TOE_BOX = 3_000;
/** Shape transmission below which a movement inside is simply not readable outside. */
export const FOOTWEAR_SHAPE_VISIBLE_MIN = 2_500;

/** Tight or rigid footwear restricts articulation. */
export function footwearRestrictsArticulation(read: FootwearContactRead): boolean {
  return (
    read.rigidity >= FOOTWEAR_RIGID_MIN ||
    read.compression >= FOOTWEAR_TIGHT_MIN ||
    (footwearCovers(read, "toes") && read.toeBoxVolume <= FOOTWEAR_TIGHT_TOE_BOX)
  );
}

/**
 * Whether a movement inside the footwear could be seen or felt from outside.
 * Rigid footwear hides deformation even when its fabric would transmit — the
 * shell moves as one piece.
 */
export function footwearHidesDeformation(read: FootwearContactRead, surfaceId: FootSurfaceId): boolean {
  if (!footwearCovers(read, surfaceId)) return false;
  if (read.rigidity >= FOOTWEAR_RIGID_MIN) return true;
  return footwearTransmissionAt(read, surfaceId).shapeTransmission < FOOTWEAR_SHAPE_VISIBLE_MIN;
}

/**
 * A loose or unfastened shoe that still contains the toes lets the heel lift out
 * of it. `unknown` closure is not loose — it is unreadable, and a slip is a
 * positive claim.
 */
export function footwearPermitsHeelSlip(read: FootwearContactRead): boolean {
  if (!footwearCovers(read, "heel_pad") || !footwearCovers(read, "toes")) return false;
  return read.closureState === "loose" || read.closureState === "open";
}

/** The register of the outermost layer over this surface, when there is one. */
export function footwearFilterTagAt(
  read: FootwearContactRead,
  surfaceId: FootSurfaceId,
): FootwearFilterTag | undefined {
  const covering = footwearLayersAt(read, surfaceId);
  const outermost = covering[covering.length - 1];
  return outermost === undefined ? undefined : read.filterTagByLayer[outermost.layerId];
}
