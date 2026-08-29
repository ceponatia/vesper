import { affordanceSubjectId, type AffordanceSubjectId } from "../affordances/core";
import type { GustatoryObservation } from "./gustatory";
import type { SensoryBodyLocus } from "./locus";
import type { OlfactoryObservation } from "./olfactory";
import type { TactileObservation } from "./tactile";

/**
 * Probe fixtures for the sensory presentation owners, on the visual-state
 * `fixtures.ts` precedent: shared builders so every suite reads the same
 * baseline and the laws under test stand out as overrides.
 *
 * Nonvisual phenomena are fixture-only until a producer's complete source →
 * commitment → perception path exists, so these builders are also the honest
 * way to exercise the owners end to end.
 */

export const SENSORY_PROBE_OBSERVER = affordanceSubjectId("sensory_probe_observer");
export const SENSORY_PROBE_PARTNER = affordanceSubjectId("sensory_probe_partner");
export const SENSORY_PROBE_BYSTANDER = affordanceSubjectId("sensory_probe_bystander");

export function probeSensoryBodyLocus(subjectId: AffordanceSubjectId, locationId: string): SensoryBodyLocus {
  return { kind: "body", subjectId, locationId };
}

export function probeTactileObservation(overrides: Partial<TactileObservation> = {}): TactileObservation {
  return {
    sense: "tactile",
    phenomenonId: "probe.felt_pressure",
    participantIds: [SENSORY_PROBE_OBSERVER, SENSORY_PROBE_PARTNER],
    surface: probeSensoryBodyLocus(SENSORY_PROBE_PARTNER, "hands"),
    counterpart: probeSensoryBodyLocus(SENSORY_PROBE_OBSERVER, "shoulders"),
    intensityBand: "clear",
    semanticTags: ["pressed"],
    repeatFamily: "probe:felt_pressure",
    evidence: [],
    ...overrides,
  };
}

export function probeOlfactoryObservation(overrides: Partial<OlfactoryObservation> = {}): OlfactoryObservation {
  return {
    sense: "olfactory",
    phenomenonId: "probe.trace_scent",
    sourceSubjectIds: [SENSORY_PROBE_PARTNER],
    source: probeSensoryBodyLocus(SENSORY_PROBE_PARTNER, "neck"),
    intensityBand: "clear",
    semanticTags: ["warm"],
    repeatFamily: "probe:trace_scent",
    evidence: [],
    ...overrides,
  };
}

export function probeGustatoryObservation(overrides: Partial<GustatoryObservation> = {}): GustatoryObservation {
  return {
    sense: "gustatory",
    phenomenonId: "probe.trace_taste",
    participantIds: [SENSORY_PROBE_OBSERVER, SENSORY_PROBE_PARTNER],
    tastedSurface: probeSensoryBodyLocus(SENSORY_PROBE_PARTNER, "hands"),
    intensityBand: "clear",
    semanticTags: ["salt"],
    repeatFamily: "probe:trace_taste",
    evidence: [],
    ...overrides,
  };
}
