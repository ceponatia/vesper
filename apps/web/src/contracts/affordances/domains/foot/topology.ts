import { z } from "zod";
import { bodyLocationRegistry } from "../../../body/locations";
import type { ContactSurfaceSide } from "../../contact";

/**
 * The foot's semantic surface topology — an interaction map, not a
 * biomechanical mesh.
 *
 * Two trees meet here and neither owns the other:
 *
 * - the **body-location registry** is shared vocabulary (wardrobe coverage,
 *   image prompts, perception exposure all address it), and it stops at the
 *   granularity a garment can carve — `feet → toes · top_of_foot · sole · heel`,
 *   plus the three contact loci this slice added (`foot_arch`, `ball_of_foot`,
 *   `toenails`);
 * - this file's **surface tree** is the finer interaction map the foot domain
 *   owns outright. Heel pads, medial/lateral arches, edges, toe pads and
 *   interdigital spaces are meaningful for touch and meaningless for clothing,
 *   so flooding the registry with them would give a coverage editor holes that
 *   cannot exist.
 *
 * Every surface therefore carries TWO registry pointers:
 *
 * - `bodyLocationId` — the exact locus it sits on;
 * - `coverageLocationId` — the nearest ancestor that is a wardrobe slot, which
 *   is what an observation reports. Perception exposure is built from coverage,
 *   so an observation keyed to a non-slot locus would read `unknown` and fail
 *   closed for every observer. The fine surface id rides the semantic tags and
 *   the repeat key instead, where it costs nothing and hides nothing.
 *
 * Side and digit identity ride `FootLocusRef` rather than being duplicated into
 * surface ids: a left arch and a right arch are the same surface at two places,
 * and spelling them as two ids would double every table in this domain.
 */

export const footSurfaceIds = [
  "plantar_surface",
  "heel_pad",
  "arch",
  "medial_arch",
  "lateral_arch",
  "ball",
  "inner_edge",
  "outer_edge",
  "dorsal_surface",
  "top_of_foot",
  "toes",
  "toe_tops",
  "toe_pads",
  "interdigital_spaces",
  "toenails",
  "ankle_boundary",
] as const;
export const footSurfaceIdSchema = z.enum(footSurfaceIds);
export type FootSurfaceId = z.infer<typeof footSurfaceIdSchema>;

/** Structural kind: skin inherits from its parent, keratin does not. */
export const footStructureKinds = ["skin", "keratin"] as const;
export type FootStructureKind = (typeof footStructureKinds)[number];

export interface FootSurfaceNode {
  readonly id: FootSurfaceId;
  readonly parentId?: FootSurfaceId;
  /** The exact `bodyLocationRegistry` locus this surface occupies. */
  readonly bodyLocationId: string;
  readonly structureKind: FootStructureKind;
}

/**
 * The tree. `ankle_boundary` is adjacent topology rather than a child of the
 * sole — it is where the foot stops, and a cuff that reaches it has not reached
 * the plantar surface.
 */
const FOOT_SURFACE_NODES: readonly FootSurfaceNode[] = [
  { id: "plantar_surface", bodyLocationId: "sole", structureKind: "skin" },
  { id: "heel_pad", parentId: "plantar_surface", bodyLocationId: "heel", structureKind: "skin" },
  { id: "arch", parentId: "plantar_surface", bodyLocationId: "foot_arch", structureKind: "skin" },
  { id: "medial_arch", parentId: "arch", bodyLocationId: "foot_arch", structureKind: "skin" },
  { id: "lateral_arch", parentId: "arch", bodyLocationId: "foot_arch", structureKind: "skin" },
  { id: "ball", parentId: "plantar_surface", bodyLocationId: "ball_of_foot", structureKind: "skin" },
  { id: "inner_edge", parentId: "plantar_surface", bodyLocationId: "sole", structureKind: "skin" },
  { id: "outer_edge", parentId: "plantar_surface", bodyLocationId: "sole", structureKind: "skin" },
  { id: "dorsal_surface", bodyLocationId: "top_of_foot", structureKind: "skin" },
  { id: "top_of_foot", parentId: "dorsal_surface", bodyLocationId: "top_of_foot", structureKind: "skin" },
  { id: "toes", bodyLocationId: "toes", structureKind: "skin" },
  { id: "toe_tops", parentId: "toes", bodyLocationId: "toes", structureKind: "skin" },
  { id: "toe_pads", parentId: "toes", bodyLocationId: "toes", structureKind: "skin" },
  { id: "interdigital_spaces", parentId: "toes", bodyLocationId: "toes", structureKind: "skin" },
  { id: "toenails", parentId: "toes", bodyLocationId: "toenails", structureKind: "keratin" },
  { id: "ankle_boundary", bodyLocationId: "ankles", structureKind: "skin" },
];

/**
 * Definition-time proof, run at module load and throwing on a violation — the
 * same contract `buildBodyLocationRegistry` and `registerAffordanceDomain` keep.
 * A topology whose registry pointers have drifted cannot be recovered from at
 * runtime and must not be discovered as silent nothing in production.
 */
function buildFootTopology(): {
  readonly byId: ReadonlyMap<FootSurfaceId, FootSurfaceNode>;
  readonly children: ReadonlyMap<FootSurfaceId, readonly FootSurfaceId[]>;
  readonly coverage: ReadonlyMap<FootSurfaceId, string>;
} {
  const byId = new Map<FootSurfaceId, FootSurfaceNode>();
  for (const node of FOOT_SURFACE_NODES) {
    if (byId.has(node.id)) throw new Error(`Duplicate foot surface id: ${node.id}`);
    if (!bodyLocationRegistry.byId(node.bodyLocationId)) {
      throw new Error(`Foot surface ${node.id} names unknown body location ${node.bodyLocationId}`);
    }
    byId.set(node.id, node);
  }
  const children = new Map<FootSurfaceId, FootSurfaceId[]>();
  for (const node of FOOT_SURFACE_NODES) {
    if (node.parentId === undefined) continue;
    if (!byId.has(node.parentId)) throw new Error(`Foot surface ${node.id} has unknown parent ${node.parentId}`);
    const list = children.get(node.parentId) ?? [];
    list.push(node.id);
    children.set(node.parentId, list);
  }
  const coverage = new Map<FootSurfaceId, string>();
  for (const node of FOOT_SURFACE_NODES) {
    let locationId: string | undefined = node.bodyLocationId;
    while (locationId !== undefined && bodyLocationRegistry.byId(locationId)?.coverageRelevant === false) {
      locationId = bodyLocationRegistry.byId(locationId)?.parentId;
    }
    if (locationId === undefined) throw new Error(`Foot surface ${node.id} has no coverage-relevant ancestor`);
    coverage.set(node.id, locationId);
  }
  return { byId, children, coverage };
}

const TOPOLOGY = buildFootTopology();

/** Every surface, in declaration order (parents before their children). */
export const footSurfaceTopology: readonly FootSurfaceNode[] = FOOT_SURFACE_NODES;

export function footSurfaceNode(id: string): FootSurfaceNode | undefined {
  const parsed = footSurfaceIdSchema.safeParse(id);
  return parsed.success ? TOPOLOGY.byId.get(parsed.data) : undefined;
}

export function footSurfaceChildren(id: FootSurfaceId): readonly FootSurfaceId[] {
  return TOPOLOGY.children.get(id) ?? [];
}

/** `id` plus every descendant, depth-first in declaration order. */
export function footSurfaceSubtree(id: FootSurfaceId): readonly FootSurfaceId[] {
  return [id, ...footSurfaceChildren(id).flatMap((child) => footSurfaceSubtree(child))];
}

/** The parent chain, nearest first. */
export function footSurfaceAncestors(id: FootSurfaceId): readonly FootSurfaceId[] {
  const chain: FootSurfaceId[] = [];
  let current = TOPOLOGY.byId.get(id)?.parentId;
  while (current !== undefined) {
    chain.push(current);
    current = TOPOLOGY.byId.get(current)?.parentId;
  }
  return chain;
}

/** The wardrobe-slot locus an observation about this surface reports. */
export function footSurfaceCoverageLocationId(id: FootSurfaceId): string {
  return TOPOLOGY.coverage.get(id) ?? "feet";
}

/**
 * The surface a contact's opaque `detail` token names, or `undefined`.
 *
 * The contact core stores `detail` verbatim and never parses one; this is the
 * one place the token is given meaning, and an unrecognised token resolves to
 * nothing rather than to a neighbouring surface.
 */
export function footSurfaceForDetail(detail: string | undefined): FootSurfaceId | undefined {
  if (detail === undefined) return undefined;
  const parsed = footSurfaceIdSchema.safeParse(detail);
  return parsed.success ? parsed.data : undefined;
}

/**
 * The surface a bare registry locus implies when a contact named no detail.
 *
 * `feet` is deliberately absent: a contact on the whole foot names no region,
 * and every regional observation this domain makes needs one. Guessing the sole
 * would be inventing the most narratable answer.
 */
const LOCATION_DEFAULT_SURFACE: Readonly<Record<string, FootSurfaceId>> = {
  sole: "plantar_surface",
  heel: "heel_pad",
  foot_arch: "arch",
  ball_of_foot: "ball",
  top_of_foot: "top_of_foot",
  toes: "toes",
  toenails: "toenails",
  ankles: "ankle_boundary",
};

export function footSurfaceForLocation(locationId: string): FootSurfaceId | undefined {
  return LOCATION_DEFAULT_SURFACE[locationId];
}

/** Registry loci a contact end must name for this domain to have anything to say. */
export const footContactLocationIds: ReadonlySet<string> = new Set([
  "feet",
  ...Object.keys(LOCATION_DEFAULT_SURFACE),
]);

// ---------------------------------------------------------------------------
// Locus references
// ---------------------------------------------------------------------------

/**
 * Which foot — the domain's own side vocabulary, deliberately narrower than the
 * contact core's.
 *
 * The shared `ContactSurfaceSide` carries `center` because plenty of surfaces
 * genuinely have a middle: a back, a chest, a mouth. A foot is not one of them.
 * So every FOOT-OWNED participant read — support, articulation, condition — is
 * keyed by this enum instead, and a payload naming a `center` foot FAILS its
 * schema rather than being tolerated: `invalid` at the trust boundary, no value
 * carried, the dependent phenomenon suppressed. That is the honest degradation,
 * because a third foot is not a foot somebody could not distinguish — it is an
 * answer nothing in this domain can hold, and one that could have counted as the
 * second distinct foot in the agreement rule (`footPoseClosureAt`, support.ts).
 *
 * An ABSENT side remains how "the owner did not tell the two feet apart" is
 * spelled; it is a first-class case everywhere and needs no member of its own.
 *
 * `satisfies` keeps this a strict subset of the shared vocabulary, so a locus
 * side and a foot side stay comparable without a cast.
 */
export const footSides = ["left", "right"] as const satisfies readonly ContactSurfaceSide[];
export const footSideSchema = z.enum(footSides);
export type FootSide = z.infer<typeof footSideSchema>;

/**
 * The foot a contact-core side names, or `undefined` when it names none.
 *
 * `FootLocusRef.side` keeps the SHARED vocabulary, because it is a projection of
 * a committed contact and the core is entitled to its own answer there. This is
 * the single narrowing between the two: a `center` side — like an absent one —
 * resolves to the undistinguished foot rather than to a foot, which is exactly
 * how the mechanics lookup and the pose rule already treat "no side given". One
 * function, so the two vocabularies can never drift into two answers.
 */
export function footSideOf(side: ContactSurfaceSide | undefined): FootSide | undefined {
  const parsed = footSideSchema.safeParse(side);
  return parsed.success ? parsed.data : undefined;
}

/**
 * Which toe. Ordinal names rather than "big toe"/"little toe" so the vocabulary
 * is stable across species and authoring registers; `hallux` keeps the one digit
 * with a real name.
 */
export const footDigits = ["hallux", "second_toe", "third_toe", "fourth_toe", "fifth_toe"] as const;
export const footDigitSchema = z.enum(footDigits);
export type FootDigit = z.infer<typeof footDigitSchema>;

/**
 * One place on one foot. `side` reuses the contact core's own vocabulary rather
 * than declaring a second one — the core already carries it on every surface ref
 * and two spellings of "left" would have to be reconciled later.
 */
export interface FootLocusRef {
  readonly surfaceId: FootSurfaceId;
  readonly side?: ContactSurfaceSide;
  readonly digit?: FootDigit;
}

export function footLocus(surfaceId: FootSurfaceId, side?: ContactSurfaceSide, digit?: FootDigit): FootLocusRef {
  return {
    surfaceId,
    ...(side === undefined ? {} : { side }),
    ...(digit === undefined ? {} : { digit }),
  };
}

/** Stable identity for one locus. Identity only — never shown to anyone. */
export function footLocusKey(ref: FootLocusRef): string {
  return [ref.surfaceId, ref.side ?? "", ref.digit ?? ""].join(":");
}

export function footLociEqual(left: FootLocusRef, right: FootLocusRef): boolean {
  return footLocusKey(left) === footLocusKey(right);
}
