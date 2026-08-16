import { APPEARANCE_FIXTURE_SUBJECT_ID } from "../appearance-features";
import { affordanceEvidence, toUnitInterval } from "../affordances/core";
import { clothingCategoryById } from "../items/clothing-categories";
import { garmentBlueprintForSeed } from "../items/garment-store";
import {
  emptyGarmentPresentationState,
  pristineGarmentConditionState,
  type GarmentInstanceState,
  type GarmentLocus,
} from "../items/garment-instance";
import { realizeBody, type RealizedBody } from "../species";
import { visualStateFeatureKey, type VisualStateFeature } from "./feature";
import { VISUAL_STATE_APPEARANCE_ATTRIBUTE_KIND_ID } from "./kinds";
import type { VisualStateLocusRef } from "./locus";
import { applyPresentationOperations, emptyCharacterPresentationState, type CharacterPresentationState, type PresentationOperation } from "./presentation";
import type { VisualStateAttentionPriors } from "./priors";
import type { VisualStateRelationship } from "./relationships";
import type { VisualStateSourceRef } from "./sources";
import type { VisualStateGarmentInput } from "./wardrobe";
import type { VisualStateLayer, VisualStateStability } from "./vocabulary";

/**
 * Feature builders for the contract's own tests.
 *
 * Fixtures live WITH the contracts they exercise (the code-organization ruling),
 * and this file deliberately builds only what the APPEARANCE fixtures cannot:
 * hand-shaped candidates for the validation and ordering paths. Real projected
 * bodies come from `appearance-features/fixtures.ts` — a crooked nose, shoulder
 * freckles, a missing left ring finger — so both halves of the seam are judged
 * against the same truth.
 */

export const VISUAL_STATE_FIXTURE_SUBJECT_ID = APPEARANCE_FIXTURE_SUBJECT_ID;

const FIXTURE_PRIORS: VisualStateAttentionPriors = {
  baseUniqueness: toUnitInterval(5_000),
  baseImportance: toUnitInterval(4_000),
  minimumDetailTier: 2,
  repeatFamily: "fixture",
};

export interface VisualStateFeatureFixtureOptions {
  readonly subjectId?: string;
  readonly kindId?: string;
  readonly layer?: VisualStateLayer;
  readonly locus?: VisualStateLocusRef;
  readonly aspect?: string;
  /** Overrides the derived key — for the "key disagrees with its locus" case. */
  readonly key?: string;
  readonly value?: unknown;
  readonly truthFingerprint?: string;
  readonly semanticTags?: readonly string[];
  readonly stability?: VisualStateStability;
  readonly relationships?: readonly VisualStateRelationship[];
  readonly priors?: VisualStateAttentionPriors;
  readonly sourceRef?: VisualStateSourceRef;
}

/**
 * One hand-built candidate. The key is derived from the subject and locus unless
 * the caller overrides it, so a fixture cannot accidentally test a mismatched
 * key while meaning to test something else.
 */
export function visualStateFeatureFixture(
  options: VisualStateFeatureFixtureOptions = {},
): VisualStateFeature {
  const subjectId = options.subjectId ?? VISUAL_STATE_FIXTURE_SUBJECT_ID;
  const locus: VisualStateLocusRef = options.locus ?? { kind: "body", locus: { bodyLocationId: "nose" } };
  const aspect = options.aspect ?? "shape";
  const fingerprint = options.truthFingerprint ?? '"crooked"';
  return {
    version: 1,
    key: options.key ?? visualStateFeatureKey(subjectId, locus, aspect),
    subjectId,
    kindId: options.kindId ?? VISUAL_STATE_APPEARANCE_ATTRIBUTE_KIND_ID,
    layer: options.layer ?? "identity",
    locus,
    sourceRef: options.sourceRef ?? { kind: "appearance", ref: { kind: "attribute", attributeId: "nose.shape" } },
    value: options.value ?? fingerprint,
    truthFingerprint: fingerprint,
    semanticTags: options.semanticTags ?? ["nose", "crooked"],
    stability: options.stability ?? "inherent",
    relationships: options.relationships ?? [],
    priors: options.priors ?? FIXTURE_PRIORS,
    evidence: [affordanceEvidence("adapter", "visual_state.fixture")],
  };
}

// ---------------------------------------------------------------------------
// VS-5 — a non-human body, through `realizeBody`
// ---------------------------------------------------------------------------

/**
 * The audit's non-human case. `succubus` is the one catalog species that
 * defaults to all three feature groups, so one fixture covers wings, horns and
 * a tail; overriding `bodyFeatures` is how a per-character body narrows it.
 *
 * Built through `realizeBody` rather than by hand on purpose — that composition
 * (body plan → species → heritage → per-character config) is the truth the
 * adapter must read, and a hand-built set would let the fixture drift from it.
 */
export function visualStateNonHumanBody(bodyFeatures?: readonly string[]): RealizedBody {
  return realizeBody({ speciesId: "succubus", ...(bodyFeatures === undefined ? {} : { bodyFeatures }) });
}

/** An ordinary human body: no feature groups at all. */
export function visualStateHumanBody(): RealizedBody {
  return realizeBody({});
}

// ---------------------------------------------------------------------------
// VS-6 / VS-8 — garments, worn and left behind
// ---------------------------------------------------------------------------

/** The actor handle the garment fixtures wear things on. */
export const VISUAL_STATE_FIXTURE_ACTOR = "c:visual_state_fixture";

export interface VisualStateGarmentFixtureOptions {
  readonly id?: string;
  readonly name?: string;
  readonly categoryId?: string;
  readonly subtypeId?: string;
  /** Defaults to the category's own coverage — the same fallback the mint path takes. */
  readonly coverage?: readonly string[];
  readonly locus?: GarmentLocus;
  readonly layer?: number;
  readonly atMinutes?: number;
}

/**
 * One garment as the wardrobe adapter takes it: an instance, its blueprint, and
 * the two facts the instance cannot carry (the library category and layer).
 *
 * The blueprint comes from the real template path, so the fixture's coverage is
 * whatever the category and definition actually produce rather than a set the
 * test asserted into existence.
 */
export function visualStateGarmentFixture(
  options: VisualStateGarmentFixtureOptions = {},
): VisualStateGarmentInput {
  const categoryId = options.categoryId ?? "top";
  const coverage = options.coverage ?? clothingCategoryById(categoryId)?.coverage ?? [];
  const definitionId = `def_${categoryId}`;
  const blueprint = garmentBlueprintForSeed({ definitionId, name: categoryId, categoryId, coverage });
  const instance: GarmentInstanceState = {
    id: options.id ?? `g_${categoryId}`,
    blueprintHash: `h_${categoryId}`,
    definitionId,
    name: options.name ?? categoryId,
    locus: options.locus ?? { kind: "worn", actorId: VISUAL_STATE_FIXTURE_ACTOR },
    presentation: emptyGarmentPresentationState(),
    condition: pristineGarmentConditionState(),
    lastChange: { kind: "mint", atMinutes: options.atMinutes ?? 0 },
  };
  return {
    instance,
    blueprint,
    categoryId,
    ...(options.subtypeId === undefined ? {} : { subtypeId: options.subtypeId }),
    ...(options.layer === undefined ? {} : { layer: options.layer }),
  };
}

// ---------------------------------------------------------------------------
// Non-item presentation
// ---------------------------------------------------------------------------

/**
 * A presentation state built the only way one can legitimately exist: by running
 * typed operations through the reducer. A hand-built state would be able to hold
 * an entry no operation could ever produce.
 */
export function visualStatePresentationFixture(
  operations: readonly PresentationOperation[],
): CharacterPresentationState {
  return applyPresentationOperations(emptyCharacterPresentationState(), operations);
}

/** The worked case: hair loosely worn, natural makeup on the face. */
export function visualStateGroomedPresentation(
  subjectId: string = VISUAL_STATE_FIXTURE_SUBJECT_ID,
): CharacterPresentationState {
  return visualStatePresentationFixture([
    {
      kind: "apply",
      entryId: "pres_hair",
      subjectId,
      kindId: "presentation.hairstyle",
      locus: { kind: "body", locus: { bodyLocationId: "hair" } },
      value: { arrangement: "loose" },
      atMinutes: 10,
    },
    {
      kind: "apply",
      entryId: "pres_makeup",
      subjectId,
      kindId: "presentation.makeup",
      locus: { kind: "body", locus: { bodyLocationId: "face" } },
      value: { style: "natural" },
      atMinutes: 10,
    },
  ]);
}
