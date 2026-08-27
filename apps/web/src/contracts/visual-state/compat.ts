import type { AppearanceSourceRef, AppearanceStability, ProjectedFeatureTruth } from "../appearance-features";
import { affordanceEvidence, type AffordanceEvidence } from "../affordances/core";
import { diag, type DiagnosticSink } from "../diagnostics";
import { VISUAL_STATE_SOURCE_UNAVAILABLE } from "./diagnostics";
import { validateVisualStateFeature, type VisualStateFeature } from "./feature";
import {
  VISUAL_STATE_APPEARANCE_ANATOMY_KIND_ID,
  VISUAL_STATE_APPEARANCE_ATTRIBUTE_KIND_ID,
  VISUAL_STATE_APPEARANCE_LOCATED_FACT_KIND_ID,
} from "./kinds";
import { visualStatePriorsFromAppearance } from "./priors";
import { visualStateKindRegistry } from "./registry";
import { visualStateSourceKey, type VisualStateSourceRef } from "./sources";
import type { VisualStateStability } from "./vocabulary";

/**
 * The compatibility adapter: truth-level appearance records read as visual-state
 * features.
 *
 * `ProjectedFeatureTruth` is a FROZEN SEAM — the interface the recognition layer
 * consumes, with two exhaustive `switch`es over its source union and observer
 * memory rows in live conversations keyed on its feature keys. Nothing here
 * renames, reshapes, or re-projects it. This module only READS it, one record at
 * a time, and every derived field is either copied verbatim or taken from a
 * registered kind.
 *
 * Three properties are load-bearing and asserted by the tests:
 *
 * - the adapted feature `key` is byte-identical to the record's;
 * - the adapted `truthFingerprint` is byte-identical to the record's, so change
 *   detection against stored memory keeps working;
 * - the record's authored priors survive, including its repeat family.
 */

/** The visual-state kind that carries each appearance source, or null when none does. */
function adaptedKindId(sourceRef: AppearanceSourceRef): string | null {
  switch (sourceRef.kind) {
    case "attribute":
      return VISUAL_STATE_APPEARANCE_ATTRIBUTE_KIND_ID;
    case "located_fact":
      return VISUAL_STATE_APPEARANCE_LOCATED_FACT_KIND_ID;
    case "anatomy":
      return VISUAL_STATE_APPEARANCE_ANATOMY_KIND_ID;
    // The appearance union declares these two for owners the projection does not
    // produce yet. Missing owners mean SILENCE, not a plausible guess: a
    // condition or a presentation item adapted through an appearance kind would
    // be filed under the identity layer, which is precisely the flattening this
    // plan exists to stop.
    case "condition":
    case "presentation":
      return null;
  }
}

/** Appearance stability carries over unchanged; `instantaneous` has no upstream source. */
function adaptedStability(stability: AppearanceStability): VisualStateStability {
  switch (stability) {
    case "inherent":
      return "inherent";
    case "persistent":
      return "persistent";
    case "presentation":
      return "presentation";
    case "transient":
      return "transient";
  }
}

/** Provenance, in the source's own vocabulary — debug output, never prompt text. */
function adaptedEvidence(sourceRef: VisualStateSourceRef, appearanceRef: AppearanceSourceRef): AffordanceEvidence[] {
  const adapter = affordanceEvidence("adapter", "visual_state.compat.appearance", appearanceRef.kind);
  if (appearanceRef.kind === "attribute") {
    return [adapter, affordanceEvidence("attribute", appearanceRef.attributeId)];
  }
  return [adapter, affordanceEvidence("state", visualStateSourceKey(sourceRef))];
}

/**
 * One projected appearance record as a visual-state feature, or `null` with a
 * diagnostic when no registered kind can carry it.
 */
export function adaptProjectedAppearanceFeature(
  record: ProjectedFeatureTruth,
  sink?: DiagnosticSink,
  path = "visual_state.compat.appearance",
): VisualStateFeature | null {
  const kindId = adaptedKindId(record.sourceRef);
  if (kindId === null) {
    sink?.push(
      diag("warn", VISUAL_STATE_SOURCE_UNAVAILABLE, `No visual state kind carries a ${record.sourceRef.kind} source`, {
        path,
        context: { key: record.key, sourceKind: record.sourceRef.kind },
      }),
    );
    return null;
  }

  const kind = visualStateKindRegistry.byId(kindId);
  if (!kind) {
    sink?.push(
      diag("warn", VISUAL_STATE_SOURCE_UNAVAILABLE, `Adapter kind ${kindId} is not registered`, {
        path,
        context: { key: record.key, kindId },
      }),
    );
    return null;
  }

  const sourceRef: VisualStateSourceRef = { kind: "appearance", ref: record.sourceRef };
  const candidate: VisualStateFeature = {
    version: 1,
    // Verbatim. A rebuilt key would be the same string today and a silent
    // memory-matching failure the first time either builder changed.
    key: record.key,
    subjectId: record.subjectId,
    kindId,
    layer: kind.layer,
    locus: { kind: "body", locus: record.locus },
    sourceRef,
    // The upstream projection keeps a canonical fingerprint, not the parsed
    // source value, so the fingerprint IS the value here.
    value: record.truthFingerprint,
    truthFingerprint: record.truthFingerprint,
    semanticTags: record.semanticTags,
    stability: adaptedStability(record.stability),
    // Composition is the next slice's work; an adapted record asserts no
    // relationships rather than inventing them.
    relationships: [],
    priors: {
      // Quantities and repeat family from the RECORD (its own appearance kind
      // authored them); mandatory flags from the KIND, because the appearance
      // record has no notion of one and a guess would be indistinguishable from
      // a fact downstream.
      ...visualStatePriorsFromAppearance(record.priors),
      mandatoryForIdentity: kind.priors.mandatoryForIdentity,
      mandatoryForContinuity: kind.priors.mandatoryForContinuity,
    },
    evidence: adaptedEvidence(sourceRef, record.sourceRef),
    // `changedAtMinutes` and `validUntilMinutes` are deliberately absent: the
    // truth-level projection does not carry them, and an invented stamp would
    // make an unchanged feature look like a change candidate.
  };

  return validateVisualStateFeature(candidate, sink, path);
}

/**
 * A whole projection as visual-state features, in the order the projection
 * produced them.
 *
 * Ordering is left alone here — `buildVisualStateSnapshot` owns the snapshot
 * sort, and this adapter's job is to preserve the upstream contribution order
 * (attributes, then located facts, then anatomy) that decides duplicates.
 */
export function adaptProjectedAppearanceTruth(
  records: readonly ProjectedFeatureTruth[],
  sink?: DiagnosticSink,
  path = "visual_state.compat.appearance",
): readonly VisualStateFeature[] {
  const adapted: VisualStateFeature[] = [];
  for (const record of records) {
    const feature = adaptProjectedAppearanceFeature(record, sink, path);
    if (feature !== null) adapted.push(feature);
  }
  return adapted;
}
