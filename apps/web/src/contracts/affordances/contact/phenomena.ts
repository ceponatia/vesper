import { diag, type DiagnosticSink } from "../../diagnostics";
import type {
  AffordanceEvidence,
  AffordanceIntensityBand,
  AffordanceObservation,
  AffordancePhenomenonId,
  AffordanceSubjectId,
  AffordanceSuppression,
} from "../core";
import { CONTACT_CHANNEL_INVALID, CONTACT_CHANNEL_UNROUTED } from "./diagnostics";
import type { ContactBodySurfaceRef, ContactSurfaceRef } from "./surfaces";

/**
 * The channel-tagged phenomenon seam
 * (romantic-contact-affordances.spec.effects.md §3, §15 stage 3).
 *
 * Contact spans several senses, and the existing `AffordanceObservation` is
 * channel-neutral only because every producer so far was visual. The owner
 * ruling (effects spec §4) is that the shared contract does NOT grow a channel
 * field: each sense owns its own observation contract, and contact preserves the
 * channel in ITS OWN result type before the visual adapter boundary — a routing
 * envelope, not a generalization of visual state into every sense.
 *
 * The wall is the type system: `ContactPhenomenonObservation` is deliberately
 * not assignable to `AffordanceObservation` (no `kind` discriminant, its own
 * field names), so nothing can hand a tactile result to the visual-state
 * adapter by accident. `routeContactPhenomena` below is the ONLY conversion,
 * and it converts the visual channel alone.
 *
 * No producer registers phenomena yet — the effect slice is not live, and until
 * a domain's complete source → commitment → perception path exists its
 * phenomena stay fixture-only (spec §15 stage 9). The seam ships first so that
 * path has a contract to land on instead of widening the visual one.
 */

// ---------------------------------------------------------------------------
// Channels
// ---------------------------------------------------------------------------

/**
 * The senses a contact phenomenon can be perceived through. Auditory is part of
 * the wider sensory architecture (spec §4) but this vocabulary does not yet
 * emit it — a member joins when a phenomenon actually produces one.
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
 * mentioning (spec §1).
 *
 * Loci are the contact core's own surface refs rather than the spec sketch's
 * bare body locus: the same registry location ids, with the subject identity a
 * two-body phenomenon needs to stay unambiguous.
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
// Routing (spec §15 stage 4)
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
  /**
   * Every nonvisual candidate, reduced to a diagnostic-only suppression. The
   * payload is deliberately gone: tactile/olfactory/gustatory presentation
   * waits on sibling sensory owners (spec §11), and a withheld result that
   * still carried its observation would be one convenient cast away from a
   * narrator prompt.
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

/**
 * Split channel-tagged candidates at the presentation boundary: visual ones
 * adapt into the contract the visual-state observation adapter consumes,
 * everything else degrades to a suppression (effects spec §3's routing law).
 *
 * Fails CLOSED on the channel: only the literal `"visual"` routes, so a channel
 * this build does not know — a future member, a tampered stored value — is
 * withheld rather than presented, with an `error` diagnostic because an
 * out-of-vocabulary channel is a value nobody meant. Ordinary nonvisual
 * withholding is the designed permanent state until the sibling sensory owners
 * exist, so it reports one `info` diagnostic per routing rather than a warning
 * per candidate.
 */
export function routeContactPhenomena(
  observations: readonly ContactPhenomenonObservation[],
  sink?: DiagnosticSink,
): ContactPhenomenonRouting {
  const visual: RoutedVisualContactObservation[] = [];
  const withheld: AffordanceSuppression[] = [];
  const withheldByChannel = new Map<string, number>();

  for (const observation of observations) {
    if (observation.channel === "visual") {
      visual.push({ subjectIds: observation.subjectIds, observation: adaptVisualObservation(observation) });
      continue;
    }
    const known = (contactPerceptionChannels as readonly string[]).includes(observation.channel);
    if (!known) {
      sink?.push(
        diag("error", CONTACT_CHANNEL_INVALID, "a contact phenomenon carries a channel this build does not know", {
          context: { phenomenonId: observation.phenomenonId, channel: observation.channel },
        }),
      );
    }
    withheld.push({
      kind: "suppressed",
      phenomenonId: observation.phenomenonId,
      code: known ? CONTACT_CHANNEL_UNROUTED : CONTACT_CHANNEL_INVALID,
      detail: observation.channel,
    });
    withheldByChannel.set(observation.channel, (withheldByChannel.get(observation.channel) ?? 0) + 1);
  }

  if (withheld.length > 0) {
    sink?.push(
      diag("info", CONTACT_CHANNEL_UNROUTED, "nonvisual contact phenomena were withheld pending sensory owners", {
        context: { withheld: Object.fromEntries(withheldByChannel) },
      }),
    );
  }

  return { visual, withheld };
}
