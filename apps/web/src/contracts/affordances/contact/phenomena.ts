import { diag, type DiagnosticSink } from "../../diagnostics";
import type {
  AffordanceEvidence,
  AffordanceIntensityBand,
  AffordanceObservation,
  AffordancePhenomenonId,
  AffordanceSubjectId,
  AffordanceSuppression,
} from "../core";
import type {
  GustatoryObservation,
  OlfactoryObservation,
  SensoryBodyLocus,
  SensoryLocus,
  TactileObservation,
} from "../../sensory";
import { CONTACT_CHANNEL_INVALID } from "./diagnostics";
import type { ContactBodySurfaceRef, ContactSurfaceRef } from "./surfaces";

/**
 * The channel-tagged phenomenon seam.
 *
 * Contact spans several senses, and the existing `AffordanceObservation` is
 * channel-neutral only because every producer so far was visual. The owner
 * ruling is that the shared contract does NOT grow a channel
 * field: each sense owns its own observation contract, and contact preserves the
 * channel in ITS OWN result type before the visual adapter boundary — a routing
 * envelope, not a generalization of visual state into every sense.
 *
 * The wall is the type system: `ContactPhenomenonObservation` is deliberately
 * not assignable to `AffordanceObservation` (no `kind` discriminant, its own
 * field names), so nothing can hand a tactile result to the visual-state
 * adapter by accident. `routeContactPhenomena` below is the ONLY conversion:
 * each channel adapts into the contract its OWN presentation owner consumes —
 * visual into the channel-less core observation, tactile/olfactory/gustatory
 * into the sibling sense contracts under `contracts/sensory` — and the visual
 * adaptation stays the only door into visual state.
 *
 * No producer registers phenomena yet — the effect slice is not live, and until
 * a domain's complete source → commitment → perception path exists its
 * phenomena stay fixture-only. The seam ships first so that path has a contract
 * to land on instead of widening the visual one.
 */

// ---------------------------------------------------------------------------
// Channels
// ---------------------------------------------------------------------------

/**
 * The senses a contact phenomenon can be perceived through. Auditory is part of
 * the wider sensory architecture but this vocabulary does not yet emit it — a
 * member joins when a phenomenon actually produces one.
 */
export const contactPerceptionChannels = ["visual", "tactile", "olfactory", "gustatory"] as const;
export type ContactPerceptionChannel = (typeof contactPerceptionChannels)[number];

// ---------------------------------------------------------------------------
// The observation candidate
// ---------------------------------------------------------------------------

/**
 * One structured physical consequence of already committed contact and current
 * owner reads, tagged with the sensory channel it could be perceived through.
 * Structured data, never prose — and never automatically presented: a candidate
 * says something IS true, not that anyone can perceive it or that it is worth
 * mentioning.
 *
 * Loci are the contact core's own surface refs rather than a bare body locus:
 * the same registry location ids, with the subject identity a two-body
 * phenomenon needs to stay unambiguous.
 */
export interface ContactPhenomenonObservation {
  readonly phenomenonId: AffordancePhenomenonId;
  readonly channel: ContactPerceptionChannel;
  /** Every character the phenomenon is about, source-first. */
  readonly subjectIds: readonly AffordanceSubjectId[];
  readonly locus: ContactBodySurfaceRef;
  readonly targetLocus?: ContactSurfaceRef;
  readonly intensityBand: AffordanceIntensityBand;
  /** Structured descriptors, the shared observation vocabulary. Never prose. */
  readonly semanticTags: readonly string[];
  /** Anti-repeat identity without the band — the band is the thing that changes. */
  readonly repeatFamily: string;
  readonly evidence: readonly AffordanceEvidence[];
}

// ---------------------------------------------------------------------------
// Routing
// ---------------------------------------------------------------------------

/**
 * One visual candidate, adapted for the existing visual-state observation path
 * with the subjects it is about carried alongside: `AffordanceObservation` is
 * subject-free because the generic adapter projects per subject, so the lane
 * needs the pairing to file the observation under the right snapshot subjects.
 */
export interface RoutedVisualContactObservation {
  readonly subjectIds: readonly AffordanceSubjectId[];
  readonly observation: AffordanceObservation;
}

export interface ContactPhenomenonRouting {
  /** Visual candidates only — the one channel the visual-state adapter may consume. */
  readonly visual: readonly RoutedVisualContactObservation[];
  /** Tactile candidates, adapted into the tactile presentation owner's own contract. */
  readonly tactile: readonly TactileObservation[];
  /** Olfactory candidates, adapted into the olfactory presentation owner's own contract. */
  readonly olfactory: readonly OlfactoryObservation[];
  /** Gustatory candidates, adapted into the gustatory presentation owner's own contract. */
  readonly gustatory: readonly GustatoryObservation[];
  /**
   * Candidates no owner may consume — an out-of-vocabulary channel, reduced to
   * a diagnostic-only suppression. The payload is deliberately gone: a
   * withheld result that still carried its observation would be one convenient
   * cast away from a narrator prompt.
   */
  readonly withheld: readonly AffordanceSuppression[];
}

/** The channel-less adaptation. Private on purpose — routing is the only door. */
function adaptVisualObservation(observation: ContactPhenomenonObservation): AffordanceObservation {
  return {
    kind: "observation",
    id: observation.phenomenonId,
    sourceLocationId: observation.locus.locationId,
    // An object target has no body location; the core observation then simply
    // reaches toward nothing rather than toward an opaque entity id.
    ...(observation.targetLocus?.kind === "body" ? { targetLocationId: observation.targetLocus.locationId } : {}),
    intensityBand: observation.intensityBand,
    semanticTags: observation.semanticTags,
    repeatKey: observation.repeatFamily,
  };
}

/** A contact body surface as the sensory package's own body locus, field by field. */
function adaptSensoryBodyLocus(ref: ContactBodySurfaceRef): SensoryBodyLocus {
  return {
    kind: "body",
    subjectId: ref.subjectId,
    locationId: ref.locationId,
    ...(ref.side === undefined ? {} : { side: ref.side }),
    ...(ref.detail === undefined ? {} : { detail: ref.detail }),
  };
}

/** Either end of a contact as a sensory locus. */
function adaptSensoryLocus(ref: ContactSurfaceRef): SensoryLocus {
  return ref.kind === "body"
    ? adaptSensoryBodyLocus(ref)
    : { kind: "object", entityId: ref.entityId, surfaceId: ref.surfaceId };
}

/** The counterpart spread every nonvisual adaptation shares — locus/path preserved. */
function adaptCounterpart(observation: ContactPhenomenonObservation): { counterpart?: SensoryLocus } {
  return observation.targetLocus === undefined ? {} : { counterpart: adaptSensoryLocus(observation.targetLocus) };
}

/**
 * Into the tactile owner's contract. `transmission` is deliberately NOT set:
 * the envelope does not carry it, and inventing "direct skin" here would be a
 * claim the producer never made — a producer that owns the read supplies it on
 * the tactile contract directly.
 */
function adaptTactileObservation(observation: ContactPhenomenonObservation): TactileObservation {
  return {
    sense: "tactile",
    phenomenonId: observation.phenomenonId,
    participantIds: observation.subjectIds,
    surface: adaptSensoryBodyLocus(observation.locus),
    ...adaptCounterpart(observation),
    intensityBand: observation.intensityBand,
    semanticTags: observation.semanticTags,
    repeatFamily: observation.repeatFamily,
    evidence: observation.evidence,
  };
}

/** Into the olfactory owner's contract: the phenomenon's locus is where the attested source stands. */
function adaptOlfactoryObservation(observation: ContactPhenomenonObservation): OlfactoryObservation {
  return {
    sense: "olfactory",
    phenomenonId: observation.phenomenonId,
    sourceSubjectIds: observation.subjectIds,
    source: adaptSensoryBodyLocus(observation.locus),
    ...adaptCounterpart(observation),
    intensityBand: observation.intensityBand,
    semanticTags: observation.semanticTags,
    repeatFamily: observation.repeatFamily,
    evidence: observation.evidence,
  };
}

/** Into the gustatory owner's contract: the phenomenon's locus is the qualifying tasted surface. */
function adaptGustatoryObservation(observation: ContactPhenomenonObservation): GustatoryObservation {
  return {
    sense: "gustatory",
    phenomenonId: observation.phenomenonId,
    participantIds: observation.subjectIds,
    tastedSurface: adaptSensoryBodyLocus(observation.locus),
    ...adaptCounterpart(observation),
    intensityBand: observation.intensityBand,
    semanticTags: observation.semanticTags,
    repeatFamily: observation.repeatFamily,
    evidence: observation.evidence,
  };
}

/**
 * Split channel-tagged candidates at the presentation boundary: every channel
 * adapts into the contract its own presentation owner consumes — visual into
 * the visual-state observation path, tactile/olfactory/gustatory into the
 * sibling sense owners under `contracts/sensory`. Delivery is not
 * presentation: a routed nonvisual candidate still faces its owner's access
 * law and selection, and reaches prose only through the narrator adapter
 * behind its default-off switch.
 *
 * Fails CLOSED on the channel: a channel this build does not know — a future
 * member, a tampered stored value — is withheld rather than presented, with an
 * `error` diagnostic because an out-of-vocabulary channel is a value nobody
 * meant.
 */
export function routeContactPhenomena(
  observations: readonly ContactPhenomenonObservation[],
  sink?: DiagnosticSink,
): ContactPhenomenonRouting {
  const visual: RoutedVisualContactObservation[] = [];
  const tactile: TactileObservation[] = [];
  const olfactory: OlfactoryObservation[] = [];
  const gustatory: GustatoryObservation[] = [];
  const withheld: AffordanceSuppression[] = [];

  for (const observation of observations) {
    switch (observation.channel) {
      case "visual":
        visual.push({ subjectIds: observation.subjectIds, observation: adaptVisualObservation(observation) });
        break;
      case "tactile":
        tactile.push(adaptTactileObservation(observation));
        break;
      case "olfactory":
        olfactory.push(adaptOlfactoryObservation(observation));
        break;
      case "gustatory":
        gustatory.push(adaptGustatoryObservation(observation));
        break;
      default: {
        sink?.push(
          diag("error", CONTACT_CHANNEL_INVALID, "a contact phenomenon carries a channel this build does not know", {
            context: { phenomenonId: observation.phenomenonId, channel: observation.channel },
          }),
        );
        withheld.push({
          kind: "suppressed",
          phenomenonId: observation.phenomenonId,
          code: CONTACT_CHANNEL_INVALID,
          detail: observation.channel,
        });
      }
    }
  }

  return { visual, tactile, olfactory, gustatory, withheld };
}
