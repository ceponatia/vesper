import { clothingCategories, clothingCategoryById } from "./clothing-categories";
import { GARMENT_MATERIAL_UNKNOWN, type GarmentMaterialProfileId } from "./garment-material";
import {
  garmentBlueprintSchema,
  GARMENT_BLUEPRINT_VERSION,
  GARMENT_ROOT_PART_ID,
  type GarmentBehaviorBinding,
  type GarmentBlueprint,
  type GarmentEdge,
  type GarmentPartKind,
  type GarmentSide,
} from "./garment-blueprint";

/**
 * Category graph templates (slice-0 audit OQ1). Templates bind to the EXISTING
 * `clothingCategories` ids — every item definition already persists `category`
 * and the wardrobe editor buckets by it, so a parallel template vocabulary would
 * create two category truths and a mapping between them.
 *
 * Nine categories get a sparse part graph; the rest are root-only. "Sparse" is
 * the plan's rule literally applied: a node earns its place when it can be
 * independently manipulated, conditioned, exposed/hidden, or used to change a
 * coverage read. A shirt gets one placket with a fastener COUNT, not six button
 * nodes.
 *
 * **Coverage invariant (enforced by test):** the union of a template's node
 * coverage is exactly the category's own `coverage` template. Blueprints are a
 * richer TOPOLOGY over the same coverage, never a coverage change — which is
 * what makes slice 2's migration coverage-neutral by construction. Where the
 * category covers nothing a part physically touches (a bra strap on the
 * shoulders, a collar on the neck), the node exists with EMPTY coverage: it is
 * still addressable, conditionable and observable, it just cannot subtract what
 * the garment never covered.
 *
 * Every node defaults to the conservative `unknown` material; authoring (and
 * "Draft from description") fills real materials in later. A template is
 * therefore always safe to mint from — see `mintGarmentBlueprint` (R2).
 */

interface TemplatePart {
  id: string;
  kind: GarmentPartKind;
  side?: GarmentSide;
  aliases?: readonly string[];
  coverage?: readonly string[];
  layerOffset?: number;
}

interface CategoryTemplate {
  parts: readonly TemplatePart[];
  /** Extra typed edges beyond the `part_of` spine, which is generated. */
  edges?: readonly GarmentEdge[];
  behaviors?: readonly GarmentBehaviorBinding[];
  /** Coverage kept on the root — what no part manipulation can ever remove. */
  rootCoverage?: readonly string[];
}

const ROOT = GARMENT_ROOT_PART_ID;

/**
 * Sparse templates. Read each `behaviors` entry against
 * `GARMENT_BEHAVIOR_NODE_KINDS`: a closure/hem-lift behavior binds to the
 * COVERAGE-BEARING node (the front panel, the skirt panel), because OQ6's law
 * subtracts from the bound node's own baseline — a placket strip covers nothing
 * on its own and could never open a shirt.
 */
const SPARSE_TEMPLATES: Readonly<Record<string, CategoryTemplate>> = {
  // shoulders stay on the root: an open shirt never bares a shoulder.
  top: {
    rootCoverage: ["shoulders"],
    parts: [
      { id: "front_panel", kind: "panel", aliases: ["front"], coverage: ["chest", "waist"] },
      { id: "back_panel", kind: "panel", aliases: ["back"], coverage: ["back", "waist"] },
      { id: "collar", kind: "collar", aliases: ["neckline"] },
      { id: "placket", kind: "closure", aliases: ["buttons", "button placket"] },
      { id: "sleeve_left", kind: "sleeve", side: "left", aliases: ["left sleeve"], coverage: ["upper_arms"] },
      { id: "sleeve_right", kind: "sleeve", side: "right", aliases: ["right sleeve"], coverage: ["upper_arms"] },
      { id: "cuff_left", kind: "cuff", side: "left", aliases: ["left cuff"] },
      { id: "cuff_right", kind: "cuff", side: "right", aliases: ["right cuff"] },
      { id: "hem", kind: "hem", aliases: ["shirttail"] },
    ],
    edges: [{ kind: "fastens", from: "placket", targets: ["front_panel"] }],
    behaviors: [
      { behavior: "linear_front_closure", partId: "front_panel", fastenerCount: 6 },
      { behavior: "rollable_sleeve", partId: "sleeve_left" },
      { behavior: "rollable_sleeve", partId: "sleeve_right" },
      { behavior: "tuckable_hem", partId: "hem" },
    ],
  },
  // Long sleeves reach the wrists, so a roll actually changes the read here.
  outerwear: {
    rootCoverage: ["shoulders"],
    parts: [
      { id: "front_panel", kind: "panel", aliases: ["front"], coverage: ["chest", "waist"] },
      { id: "back_panel", kind: "panel", aliases: ["back"], coverage: ["back", "waist"] },
      { id: "collar", kind: "collar", aliases: ["lapel", "hood"] },
      { id: "placket", kind: "closure", aliases: ["buttons", "zip", "front closure"] },
      { id: "lining", kind: "lining", aliases: ["inside"], layerOffset: -1 },
      {
        id: "sleeve_left",
        kind: "sleeve",
        side: "left",
        aliases: ["left sleeve"],
        coverage: ["upper_arms", "forearms", "wrists"],
      },
      {
        id: "sleeve_right",
        kind: "sleeve",
        side: "right",
        aliases: ["right sleeve"],
        coverage: ["upper_arms", "forearms", "wrists"],
      },
      { id: "cuff_left", kind: "cuff", side: "left", aliases: ["left cuff"] },
      { id: "cuff_right", kind: "cuff", side: "right", aliases: ["right cuff"] },
      { id: "hem", kind: "hem" },
    ],
    edges: [{ kind: "fastens", from: "placket", targets: ["front_panel"] }],
    behaviors: [
      { behavior: "linear_front_closure", partId: "front_panel", fastenerCount: 5 },
      { behavior: "rollable_sleeve", partId: "sleeve_left" },
      { behavior: "rollable_sleeve", partId: "sleeve_right" },
    ],
  },
  dress: {
    rootCoverage: ["shoulders"],
    parts: [
      { id: "bodice_front", kind: "panel", aliases: ["bodice", "front"], coverage: ["chest", "waist"] },
      { id: "bodice_back", kind: "panel", aliases: ["back"], coverage: ["back", "waist"] },
      { id: "collar", kind: "collar", aliases: ["neckline"] },
      { id: "back_closure", kind: "closure", aliases: ["zip", "zipper"] },
      { id: "sleeve_left", kind: "sleeve", side: "left", aliases: ["left sleeve"], coverage: ["upper_arms"] },
      { id: "sleeve_right", kind: "sleeve", side: "right", aliases: ["right sleeve"], coverage: ["upper_arms"] },
      { id: "skirt_panel", kind: "panel", aliases: ["skirt"], coverage: ["pelvis", "thighs", "calves"] },
      { id: "hem", kind: "hem" },
    ],
    edges: [{ kind: "fastens", from: "back_closure", targets: ["bodice_back"] }],
    behaviors: [
      // The zip law subtracts chest/waist from ITS node — on a back bodice that
      // reaches only `waist`, and never the back. A dress is not undone by a
      // half-open zip.
      { behavior: "zipper_closure", partId: "bodice_back" },
      { behavior: "rollable_sleeve", partId: "sleeve_left" },
      { behavior: "rollable_sleeve", partId: "sleeve_right" },
      { behavior: "liftable_hem", partId: "skirt_panel" },
    ],
  },
  pants: {
    parts: [
      { id: "waistband", kind: "panel", aliases: ["waist", "waistband"], coverage: ["pelvis"] },
      // An open fly is an OBSERVATION, never a coverage change: the closure law
      // targets chest/waist, so it can never bare the groin — a free-text flag
      // never decides intimate coverage.
      { id: "fly", kind: "closure", aliases: ["fly", "zip"] },
      { id: "leg_left", kind: "panel", side: "left", aliases: ["left leg"], coverage: ["thighs", "calves"] },
      { id: "leg_right", kind: "panel", side: "right", aliases: ["right leg"], coverage: ["thighs", "calves"] },
      { id: "cuff_left", kind: "cuff", side: "left", aliases: ["left cuff"], coverage: ["ankles"] },
      { id: "cuff_right", kind: "cuff", side: "right", aliases: ["right cuff"], coverage: ["ankles"] },
    ],
    edges: [{ kind: "fastens", from: "fly", targets: ["waistband"] }],
    behaviors: [
      { behavior: "zipper_closure", partId: "fly" },
      // Cuff rolls are presentation-only in v1: the roll law names arm
      // locations (wrists/forearms), which a trouser cuff does not carry.
      { behavior: "rollable_sleeve", partId: "cuff_left" },
      { behavior: "rollable_sleeve", partId: "cuff_right" },
    ],
  },
  shorts: {
    parts: [
      { id: "waistband", kind: "panel", aliases: ["waist", "waistband"], coverage: ["pelvis"] },
      { id: "leg_left", kind: "panel", side: "left", aliases: ["left leg"], coverage: ["thighs"] },
      { id: "leg_right", kind: "panel", side: "right", aliases: ["right leg"], coverage: ["thighs"] },
      { id: "hem", kind: "hem" },
    ],
  },
  skirt: {
    parts: [
      { id: "waistband", kind: "panel", aliases: ["waist", "waistband"] },
      { id: "panel", kind: "panel", aliases: ["skirt"], coverage: ["pelvis", "thighs"] },
      { id: "closure", kind: "closure", aliases: ["zip", "zipper"] },
      { id: "hem", kind: "hem" },
    ],
    edges: [{ kind: "fastens", from: "closure", targets: ["waistband"] }],
    behaviors: [
      { behavior: "zipper_closure", partId: "closure" },
      { behavior: "liftable_hem", partId: "panel" },
    ],
  },
  bra: {
    parts: [
      { id: "cup_left", kind: "panel", side: "left", aliases: ["left cup"], coverage: ["chest"] },
      { id: "cup_right", kind: "panel", side: "right", aliases: ["right cup"], coverage: ["chest"] },
      { id: "band", kind: "panel", aliases: ["band"] },
      { id: "strap_left", kind: "strap", side: "left", aliases: ["left strap"] },
      { id: "strap_right", kind: "strap", side: "right", aliases: ["right strap"] },
      { id: "back_closure", kind: "closure", aliases: ["clasp", "hooks"] },
    ],
    edges: [{ kind: "fastens", from: "back_closure", targets: ["band"] }],
    behaviors: [
      { behavior: "adjustable_strap", partId: "strap_left" },
      { behavior: "adjustable_strap", partId: "strap_right" },
      // `linear_front_closure` names the CHANNEL — an ordered series of
      // individually-openable fasteners — not the side of the garment. A bra's
      // hook-and-eye clasp is exactly that (the audit's `fastener_series`).
      { behavior: "linear_front_closure", partId: "back_closure", fastenerCount: 3 },
    ],
  },
  socks: {
    rootCoverage: ["feet"],
    parts: [{ id: "cuff", kind: "cuff", aliases: ["sock cuff", "top"], coverage: ["ankles"] }],
    behaviors: [{ behavior: "rollable_sleeve", partId: "cuff" }],
  },
  footwear: {
    parts: [
      { id: "upper", kind: "panel", aliases: ["upper"], coverage: ["feet"] },
      { id: "closure", kind: "closure", aliases: ["laces", "buckle"] },
    ],
    edges: [{ kind: "fastens", from: "closure", targets: ["upper"] }],
    behaviors: [{ behavior: "linear_front_closure", partId: "closure", fastenerCount: 5 }],
  },
};

function buildTemplate(
  categoryId: string,
  coverage: readonly string[],
  materialProfileId: GarmentMaterialProfileId,
): GarmentBlueprint {
  const template = SPARSE_TEMPLATES[categoryId];
  if (!template) {
    // Root-only: the whole category coverage sits on one addressable handle.
    return garmentBlueprintSchema.parse({
      version: GARMENT_BLUEPRINT_VERSION,
      rootNodeId: ROOT,
      nodes: [{ id: ROOT, kind: "root", aliases: [], materialProfileId, baselineCoverage: [...coverage] }],
      edges: [],
      behaviors: [],
    });
  }
  const nodes = [
    {
      id: ROOT,
      kind: "root",
      aliases: [],
      materialProfileId,
      baselineCoverage: [...(template.rootCoverage ?? [])],
    },
    ...template.parts.map((part) => ({
      id: part.id,
      kind: part.kind,
      ...(part.side === undefined ? {} : { side: part.side }),
      aliases: [...(part.aliases ?? [])],
      materialProfileId,
      baselineCoverage: [...(part.coverage ?? [])],
      ...(part.layerOffset === undefined ? {} : { layerOffset: part.layerOffset }),
    })),
  ];
  const edges: GarmentEdge[] = [
    ...template.parts.map((part): GarmentEdge => ({ kind: "part_of", from: part.id, to: ROOT })),
    ...(template.edges ?? []),
  ];
  return garmentBlueprintSchema.parse({
    version: GARMENT_BLUEPRINT_VERSION,
    rootNodeId: ROOT,
    nodes,
    edges,
    behaviors: [...(template.behaviors ?? [])],
  });
}

/** Category ids that get a sparse part graph rather than a bare root. */
export const garmentSparseTemplateCategoryIds: readonly string[] = Object.keys(SPARSE_TEMPLATES);

/** Every category's blueprint template, keyed by `clothingCategories` id. */
export const garmentCategoryTemplates: Readonly<Record<string, GarmentBlueprint>> = Object.fromEntries(
  clothingCategories.map((category) => [
    category.id,
    buildTemplate(category.id, category.coverage, GARMENT_MATERIAL_UNKNOWN),
  ]),
);

/**
 * The blueprint template for a clothing category, with an optional material
 * stamped onto every node. Returns `undefined` for an unknown category so
 * authoring surfaces can say so; `mintGarmentBlueprint` is the never-fails path.
 */
export function garmentTemplateForCategory(
  categoryId: string,
  materialProfileId: GarmentMaterialProfileId = GARMENT_MATERIAL_UNKNOWN,
): GarmentBlueprint | undefined {
  const category = clothingCategoryById(categoryId);
  if (!category) return undefined;
  return buildTemplate(category.id, category.coverage, materialProfileId);
}

/**
 * R2's ad-hoc minting path — what continuity calls (slice 5) when the fiction
 * introduces an unowned garment ("a borrowed hoodie"). ALWAYS returns a valid
 * blueprint: a known category yields its sparse/root template, an unknown one a
 * bare root that covers nothing and can do nothing.
 *
 * Safe by construction in the direction that matters: a mint can only ADD
 * coverage (a category template's own locations), never subtract, so a minted
 * garment can never decide intimate coverage on its own.
 */
export function mintGarmentBlueprint(input: {
  categoryId?: string;
  materialProfileId?: GarmentMaterialProfileId;
}): GarmentBlueprint {
  const material = input.materialProfileId ?? GARMENT_MATERIAL_UNKNOWN;
  const template = input.categoryId ? garmentTemplateForCategory(input.categoryId, material) : undefined;
  if (template) return template;
  return garmentBlueprintSchema.parse({
    version: GARMENT_BLUEPRINT_VERSION,
    rootNodeId: ROOT,
    nodes: [{ id: ROOT, kind: "root", aliases: [], materialProfileId: material, baselineCoverage: [] }],
    edges: [],
    behaviors: [],
  });
}
