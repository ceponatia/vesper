import { z } from "zod";
import { simulationHash } from "@vesper/simulation-core/hash";
import { garmentMaterialProfileIdSchema, GARMENT_MATERIAL_UNKNOWN } from "./garment-material";

/**
 * The garment BLUEPRINT graph (clothing-state-graph.plan.md §"Two graphs, not
 * one universal property graph"; slice-0 audit OQ1/OQ2).
 *
 * A blueprint describes stable construction: the parts that can independently be
 * manipulated, conditioned, hidden or used to change a coverage read — nothing
 * else. This is semantic topology, not CAD: a shirt has a placket with a
 * fastener COUNT, never ten button nodes.
 *
 * Blueprints are VALUES, not rows (OQ2). A chat stores a normalized,
 * content-hash-deduplicated snapshot per distinct construction and every
 * instance points at that hash, so a later library edit can never mutate an
 * established scene and a retake restores instances and their blueprint map
 * together.
 *
 * Structural rules (one root, acyclic `part_of` reaching every node, known
 * endpoints, registry-valid ids, legal behavior bindings) are enforced by
 * `validateGarmentBlueprint` in garment-blueprint-validation.ts — the schema
 * here is deliberately lenient so a malformed row degrades to a default rather
 * than failing a turn (docs/resilience.md §1).
 */

/** Bumped when the graph shape changes in a way a reader must branch on. */
export const GARMENT_BLUEPRINT_VERSION = 1;

/** Conventional id of the whole-garment handle every blueprint has. */
export const GARMENT_ROOT_PART_ID = "root";

export const GARMENT_MAX_PART_NODES = 24;
export const GARMENT_MAX_EDGES = 64;
export const GARMENT_MAX_BEHAVIORS = 16;
export const GARMENT_MAX_ALIASES = 4;
export const GARMENT_MAX_PART_COVERAGE = 16;
/** Bounds on a `fastener_series` closure's declared fastener count. */
export const GARMENT_FASTENER_COUNT_MIN = 1;
export const GARMENT_FASTENER_COUNT_MAX = 24;

// --- Part ids -----------------------------------------------------------------

/**
 * Part ids are opaque authoring slugs, never displayed. They are NOT trimmed or
 * case-folded (the `contracts/simulation/identity.ts` rule): normalizing an id
 * at a boundary can alias two parts.
 */
export const garmentPartIdSchema = z
  .string()
  .min(1)
  .max(64)
  .refine((value) => value.trim() === value, "Garment part ids cannot have surrounding whitespace")
  .refine((value) => !/\s/u.test(value), "Garment part ids cannot contain whitespace");
export type GarmentPartId = z.infer<typeof garmentPartIdSchema>;

// --- Nodes --------------------------------------------------------------------

export const garmentPartKinds = [
  "root",
  "panel",
  "collar",
  "sleeve",
  "cuff",
  "strap",
  "hem",
  "closure",
  "lining",
  "hardware",
] as const;
export const garmentPartKindSchema = z.enum(garmentPartKinds);
export type GarmentPartKind = z.infer<typeof garmentPartKindSchema>;

export const garmentSides = ["left", "right", "center"] as const;
export const garmentSideSchema = z.enum(garmentSides);
export type GarmentSide = z.infer<typeof garmentSideSchema>;

export const garmentPartNodeSchema = z.object({
  id: garmentPartIdSchema,
  kind: garmentPartKindSchema.catch("panel").default("panel"),
  /** Asymmetry is native — a left and a right sleeve are two nodes, not one. */
  side: garmentSideSchema.optional().catch(undefined),
  /** Handles the continuity extractor may be shown ("left sleeve"). Never prompt prose. */
  aliases: z
    .array(z.string().trim().min(1).max(40))
    .catch([])
    .default([])
    .transform((values) => [...new Set(values)].slice(0, GARMENT_MAX_ALIASES)),
  materialProfileId: garmentMaterialProfileIdSchema
    .catch(GARMENT_MATERIAL_UNKNOWN)
    .default(GARMENT_MATERIAL_UNKNOWN),
  /**
   * Body-location ids this part covers when nothing is displacing it. Behaviors
   * may only SUBTRACT from this set (OQ6) — nothing ever adds coverage.
   */
  baselineCoverage: z
    .array(z.string().trim().min(1).max(64))
    .catch([])
    .default([])
    .transform((values) => [...new Set(values)].slice(0, GARMENT_MAX_PART_COVERAGE)),
  /** Layer nudge relative to the garment's own layer (a lining sits inside). */
  layerOffset: z.number().int().min(-3).max(3).optional().catch(undefined),
});
export type GarmentPartNode = z.infer<typeof garmentPartNodeSchema>;

// --- Edges --------------------------------------------------------------------

/**
 * `part_of` points CHILD → PARENT (`from` is the part, `to` is the whole) and is
 * the single ownership relation: exactly one per non-root node, acyclic, every
 * node reachable from the root. The other typed edges may cross the tree freely
 * but never change ownership.
 */
export const garmentEdgeSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("part_of"), from: garmentPartIdSchema, to: garmentPartIdSchema }).strict(),
  z
    .object({
      kind: z.literal("fastens"),
      from: garmentPartIdSchema,
      targets: z
        .array(garmentPartIdSchema)
        .default([])
        .transform((values) => [...new Set(values)].slice(0, GARMENT_MAX_PART_NODES)),
    })
    .strict(),
  z.object({ kind: z.literal("mirrors"), from: garmentPartIdSchema, to: garmentPartIdSchema }).strict(),
  z.object({ kind: z.literal("constrains"), from: garmentPartIdSchema, to: garmentPartIdSchema }).strict(),
]);
export type GarmentEdge = z.infer<typeof garmentEdgeSchema>;
export type GarmentEdgeKind = GarmentEdge["kind"];

// --- Behaviors ----------------------------------------------------------------

/**
 * The narrow behavior registry (plan §"GarmentBehaviorBinding"; OQ6). Six
 * behaviors, no rules DSL: each one names a presentation channel and a fixed,
 * subtraction-only coverage law (garment-coverage.ts).
 *
 * `zipper_closure` is the audit's `zipper`; `liftable_hem` is its `hem_lift`.
 */
export const garmentBehaviors = [
  "linear_front_closure",
  "zipper_closure",
  "rollable_sleeve",
  "adjustable_strap",
  "tuckable_hem",
  "liftable_hem",
] as const;
export const garmentBehaviorSchema = z.enum(garmentBehaviors);
export type GarmentBehavior = z.infer<typeof garmentBehaviorSchema>;

/**
 * Node kinds each behavior may legally bind to. The closure and hem-lift
 * behaviors also accept `panel` because the law subtracts from the BOUND node's
 * own baseline coverage — so the binding has to sit on the coverage-bearing
 * panel (a placket/hem strip covers nothing on its own). The audit's "legal on"
 * column sanctions exactly this ("placket / front panel").
 */
export const GARMENT_BEHAVIOR_NODE_KINDS: Readonly<Record<GarmentBehavior, readonly GarmentPartKind[]>> = {
  linear_front_closure: ["closure", "panel"],
  zipper_closure: ["closure", "panel"],
  rollable_sleeve: ["sleeve", "cuff"],
  adjustable_strap: ["strap"],
  tuckable_hem: ["hem"],
  liftable_hem: ["hem", "panel"],
};

/** Behaviors whose channel is a bounded series of individually-openable fasteners. */
export const GARMENT_FASTENER_SERIES_BEHAVIORS: readonly GarmentBehavior[] = ["linear_front_closure"];

export const garmentBehaviorBindingSchema = z
  .object({
    behavior: garmentBehaviorSchema,
    partId: garmentPartIdSchema,
    /**
     * `fastener_series` behaviors only: how many fasteners the closure has, so
     * individual buttons change without becoming graph nodes. Required for
     * `linear_front_closure`, forbidden elsewhere (validator-enforced).
     */
    fastenerCount: z.number().int().min(GARMENT_FASTENER_COUNT_MIN).max(GARMENT_FASTENER_COUNT_MAX).optional(),
  })
  .strict();
export type GarmentBehaviorBinding = z.infer<typeof garmentBehaviorBindingSchema>;

// --- Blueprint ----------------------------------------------------------------

export const garmentBlueprintSchema = z.object({
  version: z
    .number()
    .int()
    .min(1)
    .catch(GARMENT_BLUEPRINT_VERSION)
    .default(GARMENT_BLUEPRINT_VERSION),
  rootNodeId: garmentPartIdSchema.catch(GARMENT_ROOT_PART_ID).default(GARMENT_ROOT_PART_ID),
  nodes: z
    .array(garmentPartNodeSchema)
    .catch([])
    .default([])
    .transform((nodes) => nodes.slice(0, GARMENT_MAX_PART_NODES)),
  edges: z
    .array(garmentEdgeSchema)
    .catch([])
    .default([])
    .transform((edges) => edges.slice(0, GARMENT_MAX_EDGES)),
  behaviors: z
    .array(garmentBehaviorBindingSchema)
    .catch([])
    .default([])
    .transform((behaviors) => behaviors.slice(0, GARMENT_MAX_BEHAVIORS)),
});
export type GarmentBlueprint = z.infer<typeof garmentBlueprintSchema>;

/**
 * The degraded default: a bare, VALID root-only garment that covers nothing and
 * can do nothing. Conservative in the direction that matters — a blueprint that
 * lost its parts contributes no coverage AND has no behavior able to strip any,
 * so a corrupt row can never bare a character (plan §"Never let a free-text flag
 * decide intimate coverage").
 */
export function degradedGarmentBlueprint(): GarmentBlueprint {
  return garmentBlueprintSchema.parse({
    rootNodeId: GARMENT_ROOT_PART_ID,
    nodes: [{ id: GARMENT_ROOT_PART_ID, kind: "root", aliases: [], baselineCoverage: [] }],
    edges: [],
    behaviors: [],
  });
}

/** The blueprint's root node, or `undefined` when the graph has lost it. */
export function garmentRootNode(blueprint: GarmentBlueprint): GarmentPartNode | undefined {
  return blueprint.nodes.find((node) => node.id === blueprint.rootNodeId);
}

/** Node lookup by id. */
export function garmentPartNode(blueprint: GarmentBlueprint, partId: string): GarmentPartNode | undefined {
  return blueprint.nodes.find((node) => node.id === partId);
}

/** The behavior binding on a part, if any (one behavior per part is enforced). */
export function garmentBehaviorBindingFor(
  blueprint: GarmentBlueprint,
  partId: string,
): GarmentBehaviorBinding | undefined {
  return blueprint.behaviors.find((binding) => binding.partId === partId);
}

// --- Normalization + content hash (OQ2) ---------------------------------------

function edgeSortKey(edge: GarmentEdge): string {
  return edge.kind === "fastens"
    ? `${edge.kind}|${edge.from}|${[...edge.targets].sort().join(",")}`
    : `${edge.kind}|${edge.from}|${edge.to}`;
}

/**
 * Canonical form: nodes/edges/behaviors and every id list inside them sorted, so
 * two structurally identical blueprints authored in different orders hash the
 * same. (`simulationHash` key-sorts objects but preserves array order, which is
 * why the arrays are sorted here.)
 */
export function normalizeGarmentBlueprint(blueprint: GarmentBlueprint): GarmentBlueprint {
  return {
    version: blueprint.version,
    rootNodeId: blueprint.rootNodeId,
    nodes: [...blueprint.nodes]
      .map((node) => ({
        ...node,
        aliases: [...node.aliases].sort(),
        baselineCoverage: [...node.baselineCoverage].sort(),
      }))
      .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)),
    edges: [...blueprint.edges]
      .map((edge) => (edge.kind === "fastens" ? { ...edge, targets: [...edge.targets].sort() } : edge))
      .sort((a, b) => {
        const left = edgeSortKey(a);
        const right = edgeSortKey(b);
        return left < right ? -1 : left > right ? 1 : 0;
      }),
    behaviors: [...blueprint.behaviors].sort((a, b) => {
      const left = `${a.partId}|${a.behavior}`;
      const right = `${b.partId}|${b.behavior}`;
      return left < right ? -1 : left > right ? 1 : 0;
    }),
  };
}

/**
 * Content hash of a blueprint — the chat store's dedup key (OQ2). Two identical
 * shirts, or six uniformed characters, cost exactly one stored blueprint.
 */
export function garmentBlueprintHash(blueprint: GarmentBlueprint): string {
  return simulationHash(normalizeGarmentBlueprint(blueprint));
}
