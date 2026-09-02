import type { ImageWorldFact } from "@vesper/image-core";
import { AFFORDANCE_UNIT_ONE } from "../affordances/core";
import { attributeRegistry, formatAttribute, type AttributeDefinition, type AttributeValue } from "../attributes";
import { isIntimateAttributeCategory } from "../body/locations";
import type { RegionExposure } from "../items/visibility";
import type { RealizedBody } from "../species";

/**
 * The subject body REVEAL — which of a character's `imageReveal`-tagged and
 * intimate attributes an image may state, given the garment coverage readout.
 *
 * PURE: the rule and its tables, with no prompt wording. One consumer reads
 * them — the typed projection below, which a compiled scene program carries on
 * a route permitting intimate anatomy. The rule stays a function of its own
 * because it is what a bare torso lets a prompt say, and that answer is a
 * property of the coverage readout rather than of the prompt built from it.
 *
 * ## Why a projection exists beside the digest
 *
 * The visual-state image selection keeps its consent gate SHUT in every lane —
 * the chat lane has no consent owner, and "no owner" is not "allowed" — so a
 * committed cut never carries intimate anatomy, whatever the wardrobe exposes.
 * A scene's uncensored reference-edit rungs still have to state it: the
 * reference is a waist-up portrait, and a bare body it underspecifies is drawn
 * from nothing. The permission is the ROUTE's, decided per rung, which is why
 * this is a projection the route runs over the cut's own resolved attributes
 * rather than a fact the selection could have recorded once.
 */

/**
 * Which exposure region uncovers each intimate attribute category. An intimate
 * category with NO entry here never renders in an image — deliberate for the
 * universal `anus` / `perineum` categories: image inclusion is a placeholder
 * pending image-prompt re-evaluation (owner ruling 2026-07-23). Every render
 * views the character from the front, where anal/perineal detail cannot show
 * and would only confuse the model, so those categories stay omitted (they
 * remain fully exposure-gated for chat/prose). Add `anus`/`perineum → "pelvis"`
 * when rear/exposure framing lands.
 */
export const INTIMATE_CATEGORY_EXPOSURE: Readonly<Record<string, keyof RegionExposure>> = {
  breasts: "torso",
  vulva: "pelvis",
  penis: "pelvis",
  testicles: "pelvis",
};

/**
 * Which exposure axis uncovers a `skin`-tier attribute, keyed by category. A
 * superset of {@link INTIMATE_CATEGORY_EXPOSURE} that also covers the everyday
 * lower body (legs/feet), so the same exposure state drives both the intimate
 * and the SFW reveal.
 */
export const REVEAL_EXPOSURE_REGION: Readonly<Record<string, keyof RegionExposure>> = {
  chest: "torso",
  breasts: "torso",
  hips: "pelvis",
  vulva: "pelvis",
  penis: "pelvis",
  testicles: "pelvis",
  legs: "legs",
  feet: "feet",
};

/**
 * Whether an intimate-anatomy attribute should surface in an IMAGE prompt: its
 * region must read exposed (bare/sheer, not covered by a garment) and sensory
 * scent/taste attributes never render visually. The rule the untagged intimate
 * attributes take — the one place image paths gate intimate anatomy, after the
 * avatar path was made intimate-free by rule
 * (docs/images/pipelines/avatars.md §Intimate-anatomy gating).
 */
export function intimateAttrRendersExposed(def: AttributeDefinition, exposure: RegionExposure): boolean {
  if (def.kind === "sensory") return false;
  const axis = INTIMATE_CATEGORY_EXPOSURE[def.category];
  return axis !== undefined && exposure[axis] !== "covered";
}

/**
 * Whether an `imageReveal`-tagged attribute surfaces in a scene render given the
 * coverage state: `shape` reads through clothing (always), `skin` only when its
 * region is uncovered. Untagged intimate attributes keep the exposure-only rule
 * ({@link intimateAttrRendersExposed}); untagged non-intimate attributes are not
 * part of the reveal at all.
 */
export function revealSurfaces(def: AttributeDefinition, exposure: RegionExposure, intimate: boolean): boolean {
  if (def.kind === "sensory") return false;
  if (def.imageReveal === "shape") return true;
  if (def.imageReveal === "skin") {
    const axis = REVEAL_EXPOSURE_REGION[def.category];
    return axis !== undefined && exposure[axis] !== "covered";
  }
  return intimate ? intimateAttrRendersExposed(def, exposure) : false;
}

/** The projection owner a typed reveal fact's source names. */
export const IMAGE_SUBJECT_REVEAL_OWNER = "images.subject_reveal";

/** The concept every typed intimate reveal fact carries. */
export const IMAGE_SUBJECT_INTIMATE_ANATOMY_CONCEPT = "subject.intimate_anatomy" as const;

/**
 * Optional, and pitched below the cut's own selected facts: a budget squeeze
 * gives up intimate detail before a morphology anchor or the coverage
 * statement — the order the prose builder's clamp took, kept.
 */
const REVEAL_PRIORITY = Math.round(AFFORDANCE_UNIT_ONE / 2);

export interface SubjectIntimateRevealInput {
  readonly subjectId: string;
  /** The subject's resolved attributes — the same list the cut was selected from. */
  readonly attributes: readonly AttributeValue[];
  /** The canonical garment coverage readout the cut carries. */
  readonly exposure: RegionExposure;
  /** Applicability: a body without the region states nothing about it. */
  readonly realizedBody: RealizedBody;
}

/**
 * The intimate half of the reveal as typed subject facts — one
 * `subject.intimate_anatomy` fact per intimate attribute the rule lets this
 * coverage state show: silhouette (`imageReveal: "shape"`) always, surface
 * detail (`"skin"`) when the region reads bare or sheer, untagged anatomy when
 * its region is exposed, sensory never.
 *
 * A projection a ROUTE runs, never the selection: the caller decides per rung
 * whether its route permits intimate anatomy at all and calls this only when it
 * does. Nothing here re-decides coverage — the readout is the wardrobe's answer,
 * taken as given. The value is the same `Label: value` form the prose reveal
 * wrote, lower-cased into a clause, so the two paths state one fact one way.
 */
export function subjectIntimateRevealFacts(input: SubjectIntimateRevealInput): ImageWorldFact[] {
  const ref = `subject.${input.subjectId}`;
  const facts: ImageWorldFact[] = [];
  for (const value of input.attributes) {
    const def = attributeRegistry.byId(value.id);
    if (def === undefined || def.excludeFromPrompts === true) continue;
    if (!isIntimateAttributeCategory(def.category)) continue;
    if (!input.realizedBody.isAttributeApplicable(def)) continue;
    if (!revealSurfaces(def, input.exposure, true)) continue;
    const formatted = formatAttribute(def, value.value);
    if (formatted.length === 0) continue;
    facts.push({
      key: `${ref}.reveal.${def.id}`,
      concept: IMAGE_SUBJECT_INTIMATE_ANATOMY_CONCEPT,
      value: formatted.charAt(0).toLowerCase() + formatted.slice(1),
      subjectRef: ref,
      ...(def.bodyLocationId === undefined ? {} : { locus: def.bodyLocationId }),
      semanticTags: [`reveal:${def.imageReveal ?? "exposure"}`],
      disposition: "optional_visual",
      priority: REVEAL_PRIORITY,
      source: { owner: IMAGE_SUBJECT_REVEAL_OWNER, key: def.id, entityId: input.subjectId },
      truthFingerprint: `${def.id}=${String(value.value)}`,
    });
  }
  return facts;
}
