import {
  appearanceFeatureKey,
  bodyLocusKey,
  HUMANOID_HAND_DETAIL_SCHEMA_ID,
  type BodyLocusRef,
  type ProjectedFeatureTruth,
} from "../../appearance-features";
import { affordancePerceptionView, toUnitInterval, AFFORDANCE_UNIT_ZERO, type AffordanceExposure } from "../core";
import type { RecognitionObserverContext } from "./candidates";
import type { VisualFeatureMemory, VisualMemoryState } from "./visual-memory";

/**
 * Recognition fixtures — the worked cases the calibration was tuned against
 * (body-attribute-affordances.spec.recognizable-features.md §Purpose; the
 * memory doc's acceptance list).
 *
 * These live WITH the layer for the same reason the hair fixtures do: they are
 * calibration evidence, not test scaffolding. The crooked nose is the attribute
 * case, the forearm scar is the common-but-important located-fact case that
 * must be able to outrank a rare irrelevant mark, and the missing left ring
 * finger is the acquired-anatomy case the whole fine-locus design exists for.
 *
 * They build plain `ProjectedFeatureTruth` records rather than calling the
 * appearance-features registries: the seam this layer consumes is the projected
 * shape, and a fixture that reached through it would couple recognition tests
 * to an upstream registry they do not test.
 */

export const RECOGNITION_FIXTURE_SUBJECT_ID = "subject_recognition_fixture";

/** Locations the default observer can see; enough for every fixture below. */
export const RECOGNITION_FIXTURE_VISIBLE_LOCATION_IDS = [
  "face",
  "nose",
  "eyes",
  "shoulders",
  "chest",
  "arms",
  "forearms",
  "hands",
  "fingers",
] as const;

const CROOKED_NOSE_LOCUS: BodyLocusRef = { bodyLocationId: "nose", side: "center" };
const SCAR_LOCUS: BodyLocusRef = { bodyLocationId: "forearms", side: "right" };
const MISSING_FINGER_LOCUS: BodyLocusRef = {
  bodyLocationId: "fingers",
  side: "left",
  detail: { schemaId: HUMANOID_HAND_DETAIL_SCHEMA_ID, path: ["ring_finger"] },
};

function projectedTruth(
  aspect: string,
  base: Omit<ProjectedFeatureTruth, "key" | "subjectId" | "locus">,
  overrides: Partial<ProjectedFeatureTruth>,
): ProjectedFeatureTruth {
  const subjectId = overrides.subjectId ?? RECOGNITION_FIXTURE_SUBJECT_ID;
  const locus = overrides.locus ?? CROOKED_NOSE_LOCUS;
  return { key: appearanceFeatureKey(subjectId, locus, aspect), subjectId, locus, ...base, ...overrides };
}

/**
 * The default case: a crooked nose. An ordinary single-valued ATTRIBUTE — the
 * spec's "projects without a duplicate located fact" example. Distinctive but
 * unremarkable, so it sits comfortably above the notice threshold and well
 * below the emotional-callback bar.
 */
export function recognitionProjectedTruthFixture(
  overrides: Partial<ProjectedFeatureTruth> = {},
): ProjectedFeatureTruth {
  return projectedTruth(
    "alignment",
    {
      sourceRef: { kind: "attribute", attributeId: "nose.alignment" },
      truthFingerprint: "crooked",
      semanticTags: ["nose", "crooked", "asymmetric"],
      stability: "inherent",
      priors: {
        baseUniqueness: 6_000,
        baseImportance: 4_000,
        minimumDetailTier: 2,
        repeatFamily: "face_geometry",
      },
    },
    { locus: CROOKED_NOSE_LOCUS, ...overrides },
  );
}

/**
 * The calibration case the ruling turns on: a COMMON mark (uniqueness 0.30)
 * carrying heavy shared-event weight (importance 0.80). At equal visibility it
 * must outrank a rare irrelevant mark — that is the whole reason uniqueness and
 * importance are stored separately.
 */
export function recognitionScarTruthFixture(overrides: Partial<ProjectedFeatureTruth> = {}): ProjectedFeatureTruth {
  return projectedTruth(
    "scar",
    {
      sourceRef: { kind: "located_fact", factId: "fact_forearm_scar" },
      truthFingerprint: "three_parallel",
      semanticTags: ["scar", "parallel", "old"],
      stability: "persistent",
      priors: {
        baseUniqueness: 3_000,
        baseImportance: 8_000,
        minimumDetailTier: 2,
        repeatFamily: "scar",
      },
    },
    { locus: SCAR_LOCUS, ...overrides },
  );
}

/** The rare-but-irrelevant foil for the scar. Same locus family, opposite priors. */
export function recognitionRareMarkTruthFixture(overrides: Partial<ProjectedFeatureTruth> = {}): ProjectedFeatureTruth {
  return projectedTruth(
    "birthmark",
    {
      sourceRef: { kind: "located_fact", factId: "fact_shoulder_birthmark" },
      truthFingerprint: "crescent",
      semanticTags: ["birthmark", "crescent"],
      stability: "persistent",
      priors: {
        baseUniqueness: 9_000,
        baseImportance: 500,
        minimumDetailTier: 2,
        repeatFamily: "birthmark",
      },
    },
    { locus: { bodyLocationId: "shoulders" }, ...overrides },
  );
}

/**
 * The acquired case: a missing left ring finger. Truth comes from authoritative
 * ANATOMY state, addressed through the humanoid-hand detail schema — the
 * missing-finger flow the memory doc walks end to end.
 */
export function recognitionMissingFingerTruthFixture(
  overrides: Partial<ProjectedFeatureTruth> = {},
): ProjectedFeatureTruth {
  return projectedTruth(
    "presence",
    {
      sourceRef: { kind: "anatomy", locusKey: bodyLocusKey(MISSING_FINGER_LOCUS) },
      truthFingerprint: "absent",
      semanticTags: ["missing_digit", "left_hand", "ring_finger"],
      stability: "persistent",
      priors: {
        baseUniqueness: 9_000,
        baseImportance: 7_000,
        minimumDetailTier: 2,
        repeatFamily: "anatomy_presence",
      },
    },
    { locus: MISSING_FINGER_LOCUS, ...overrides },
  );
}

/**
 * An observer at ordinary conversational distance with clear sight of every
 * fixture location, no inspection focus, and no intimate allowance — the
 * baseline every acceptance case varies from.
 */
export function recognitionObserverFixture(
  overrides: Partial<RecognitionObserverContext> = {},
): RecognitionObserverContext {
  const exposure: Record<string, AffordanceExposure> = {};
  for (const locationId of RECOGNITION_FIXTURE_VISIBLE_LOCATION_IDS) exposure[locationId] = "visible";
  return {
    perception: affordancePerceptionView({ exposure, channels: { sight: "available" } }),
    baseDetailTier: 2,
    ...overrides,
  };
}

/** One memory row with sensible defaults; `featureKey` is the only thing worth naming. */
export function recognitionVisualMemoryRowFixture(
  overrides: Partial<VisualFeatureMemory> & { featureKey: string },
): VisualFeatureMemory {
  return {
    subjectId: RECOGNITION_FIXTURE_SUBJECT_ID,
    truthFingerprint: "crooked",
    firstNoticedAt: 0,
    lastNoticedAt: 0,
    noticeCount: 1,
    strongestDetailTier: 2,
    confidence: toUnitInterval(6_000),
    recognitionStrength: toUnitInterval(4_000),
    mentionCount: 0,
    ...overrides,
  };
}

/** A whole observer memory from a handful of rows, keyed the way the state expects. */
export function recognitionVisualMemoryFixture(
  rows: readonly (Partial<VisualFeatureMemory> & { featureKey: string })[],
): VisualMemoryState {
  const features: Record<string, VisualFeatureMemory> = {};
  for (const row of rows) features[row.featureKey] = recognitionVisualMemoryRowFixture(row);
  return { features };
}

/** A perception view that positively asserts nothing — the fail-closed observer. */
export function recognitionBlindObserverFixture(
  overrides: Partial<RecognitionObserverContext> = {},
): RecognitionObserverContext {
  return {
    perception: affordancePerceptionView({}),
    baseDetailTier: 2,
    ...overrides,
  };
}

/** The zero-visibility salience input, for asserting the hard gate directly. */
export const RECOGNITION_FIXTURE_INVISIBLE_SALIENCE_INPUT = {
  visibility: AFFORDANCE_UNIT_ZERO,
  uniqueness: toUnitInterval(10_000),
  importance: toUnitInterval(10_000),
} as const;
