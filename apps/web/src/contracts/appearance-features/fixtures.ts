import type { AttributeValue } from "../attributes";
import type { AnatomyPartState } from "./anatomy-state";
import type { LocatedAppearanceFact } from "./facts";
import {
  APPEARANCE_BIRTHMARK_KIND_ID,
  APPEARANCE_FRECKLE_CLUSTER_KIND_ID,
  APPEARANCE_SCAR_KIND_ID,
  type AppearanceBirthmarkShape,
  type AppearanceFreckleDensity,
  type AppearanceFrecklePattern,
  type AppearanceMarkSize,
  type AppearanceScarShape,
} from "./kinds";
import { HUMANOID_HAND_DETAIL_SCHEMA_ID, type BodyLocusRef, type BodyLocusSide } from "./locus";
import { projectAppearanceTruth, type AppearanceProjectionInput, type ProjectedFeatureTruth } from "./projection";

/**
 * The spec's worked bodies, as reusable builders.
 *
 * Fixtures live WITH the contracts they exercise (the code-organization
 * ruling) because they are the spec's acceptance cases, not test scaffolding:
 * shoulder freckles (coverage fallback), a scar with event provenance and
 * supersedence, a crooked nose (attribute path), and a missing left ring
 * finger (topology). The recognition layer's tests build on these so both
 * halves are judged against the SAME body truth.
 *
 * Everything is deterministic — no clock, no randomness, no ids derived from
 * anything but the arguments.
 */

export const APPEARANCE_FIXTURE_SUBJECT_ID = "appearance_fixture_subject";

export interface FreckleClusterFactOptions {
  readonly id?: string;
  readonly subjectId?: string;
  readonly locus?: BodyLocusRef;
  readonly density?: AppearanceFreckleDensity;
  readonly pattern?: AppearanceFrecklePattern;
  readonly validFrom?: number;
  readonly validUntil?: number;
}

/** Dense freckling across the shoulders — the coverage-fallback case. */
export function freckleClusterFact(options: FreckleClusterFactOptions = {}): LocatedAppearanceFact {
  return {
    id: options.id ?? "fact_freckle_cluster",
    subjectId: options.subjectId ?? APPEARANCE_FIXTURE_SUBJECT_ID,
    kindId: APPEARANCE_FRECKLE_CLUSTER_KIND_ID,
    locus: options.locus ?? { bodyLocationId: "shoulders" },
    value: { density: options.density ?? "dense", pattern: options.pattern ?? "clustered" },
    source: "authored",
    validFrom: options.validFrom ?? 0,
    validUntil: options.validUntil,
  };
}

export interface BirthmarkFactOptions {
  readonly id?: string;
  readonly subjectId?: string;
  readonly locus?: BodyLocusRef;
  readonly shape?: AppearanceBirthmarkShape;
  readonly size?: AppearanceMarkSize;
  readonly validFrom?: number;
  readonly validUntil?: number;
}

/** A crescent birthmark below the left collarbone (the spec's example). */
export function birthmarkFact(options: BirthmarkFactOptions = {}): LocatedAppearanceFact {
  return {
    id: options.id ?? "fact_birthmark",
    subjectId: options.subjectId ?? APPEARANCE_FIXTURE_SUBJECT_ID,
    kindId: APPEARANCE_BIRTHMARK_KIND_ID,
    locus: options.locus ?? { bodyLocationId: "chest", side: "left" },
    value: { shape: options.shape ?? "crescent", size: options.size ?? "small" },
    source: "authored",
    validFrom: options.validFrom ?? 0,
    validUntil: options.validUntil,
  };
}

export interface ScarFactOptions {
  readonly id?: string;
  readonly subjectId?: string;
  readonly locus?: BodyLocusRef;
  readonly shape?: AppearanceScarShape;
  readonly size?: AppearanceMarkSize;
  readonly validFrom?: number;
  readonly validUntil?: number;
  readonly sourceEventId?: string;
  /** The wound-era row this scar replaces (the supersedence case). */
  readonly supersedesFactId?: string;
}

/** An acquired scar: event provenance, and able to supersede its wound row. */
export function scarFact(options: ScarFactOptions = {}): LocatedAppearanceFact {
  return {
    id: options.id ?? "fact_scar",
    subjectId: options.subjectId ?? APPEARANCE_FIXTURE_SUBJECT_ID,
    kindId: APPEARANCE_SCAR_KIND_ID,
    locus: options.locus ?? { bodyLocationId: "forearms", side: "right" },
    value: { shape: options.shape ?? "linear", size: options.size ?? "medium" },
    source: "event",
    sourceEventId: options.sourceEventId ?? "event_fixture_blade",
    validFrom: options.validFrom ?? 0,
    validUntil: options.validUntil,
    supersedesFactId: options.supersedesFactId,
  };
}

export interface MissingFingerStateOptions {
  readonly subjectId?: string;
  readonly side?: BodyLocusSide;
  readonly finger?: string;
  readonly effectiveFrom?: number;
  readonly sourceEventId?: string;
}

/** The missing left ring finger — topology, never a located fact. */
export function missingFingerState(options: MissingFingerStateOptions = {}): AnatomyPartState {
  return {
    subjectId: options.subjectId ?? APPEARANCE_FIXTURE_SUBJECT_ID,
    locus: {
      bodyLocationId: "fingers",
      side: options.side ?? "left",
      detail: { schemaId: HUMANOID_HAND_DETAIL_SCHEMA_ID, path: [options.finger ?? "ring_finger"] },
    },
    state: "absent",
    effectiveFrom: options.effectiveFrom ?? 0,
    sourceEventId: options.sourceEventId ?? "event_fixture_finger_loss",
  };
}

/** The canonical attribute example: a crooked nose (plus an ordinary neighbour). */
export function crookedNoseAttributes(): AttributeValue[] {
  return [
    { id: "nose.shape", value: "crooked", source: "creation" },
    { id: "nose.size", value: "medium", source: "creation" },
  ];
}

/** `projectAppearanceTruth` over the fixture subject, with sensible defaults. */
export function projectFixture(
  overrides: Partial<AppearanceProjectionInput> = {},
): readonly ProjectedFeatureTruth[] {
  return projectAppearanceTruth({
    subjectId: APPEARANCE_FIXTURE_SUBJECT_ID,
    attributes: [],
    atMinutes: 0,
    ...overrides,
  });
}
