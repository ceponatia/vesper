import { APPEARANCE_FIXTURE_SUBJECT_ID } from "../appearance-features";
import { affordanceEvidence, toUnitInterval } from "../affordances/core";
import { visualStateFeatureKey, type VisualStateFeature } from "./feature";
import { VISUAL_STATE_APPEARANCE_ATTRIBUTE_KIND_ID } from "./kinds";
import type { VisualStateLocusRef } from "./locus";
import type { VisualStateAttentionPriors } from "./priors";
import type { VisualStateRelationship } from "./relationships";
import type { VisualStateSourceRef } from "./sources";
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
