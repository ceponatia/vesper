import { z } from "zod";
import {
  adapterInputStatuses,
  adapterInvalid,
  adapterReadEvidence,
  adapterSupported,
  adapterUnavailable,
  attributeEnumValue,
  isAdapterSupported,
  readAdapterInput,
  registerAffordanceDomain,
  unitIntervalSchema,
  type AdapterRead,
  type AffordanceDomainDefinition,
  type AffordanceDomainRequest,
  type DomainInputs,
  type ResolvedAttributeSnapshot,
} from "../../core";
import { compileHairProfile, type HairStructuralProfile } from "./profile";
import {
  deriveHairMechanics,
  hairArrangements,
  hairLengthBands,
  hairPresentationState,
  type HairArrangement,
  type HairEffectiveMechanics,
  type HairLengthBand,
} from "./mechanics";
import {
  buildHairFrame,
  hairBodyContactSchema,
  hairCausalEventSchema,
  hairContaminationReadSchema,
  hairMotionReadSchema,
  hairWindReadSchema,
  type HairAffordanceFrame,
  type HairAffordanceState,
  type HairCausalEvent,
  type HairEventKind,
  type HairResolutionContext,
} from "./frame";
import { hairPhenomena } from "./phenomena";
import { hairRequiredAttributeIds } from "./attribute-maps";

/**
 * The hair domain — the plan's first production proving domain.
 *
 * `readInputs` is the ONLY place hair code touches untyped data, and it obeys
 * the audit's adapter result law without exception: every input is `supported`
 * with provenance, `unavailable`, or `invalid`, and the two failures carry no
 * value. Nothing here invents a dry, uncovered, motionless, or in-contact
 * default when a lane cannot answer.
 *
 * Three inputs are STRUCTURAL to the mechanics and their absence fails the whole
 * domain rather than one phenomenon:
 *
 * - `wetness` — without it there is no water load, and "assume dry" is exactly
 *   the convenient default the law forbids;
 * - `coveredFraction` — unknown coverage fails closed (audit ruling), and
 *   guessing "uncovered" would let hidden hair move in the wind;
 * - `arrangement` — without it there are no bound/pinned fractions, and
 *   assuming `loose` would free hair that may well be braided.
 *
 * Everything else (wind, motion, contacts, events, contamination) is a
 * per-phenomenon dependency, so a lane that owns weather but not contact still
 * gets its wind read while adhesion stays correctly silent.
 */

export const HAIR_DOMAIN_ID = "hair";

/**
 * The lane payload shape, documented as a type for adapters and fixtures. The
 * runtime still narrows `unknown` — this is the contract, not the trust.
 */
export interface HairLanePayload {
  readonly wetness: number;
  readonly coveredFraction: number;
  readonly looseEndLengthBand?: HairLengthBand;
  readonly contamination?: { readonly level: number; readonly kind?: string };
  readonly contacts?: readonly { readonly sourceLocationId: string; readonly targetLocationId: string }[];
  readonly wind?: { readonly force: number };
  readonly motion?: { readonly force: number };
  readonly events?: readonly { readonly kind: HairEventKind; readonly atStoryTime: number }[];
}

const hairPayloadSchema = z.object({
  wetness: z.unknown().optional(),
  coveredFraction: z.unknown().optional(),
  looseEndLengthBand: z.unknown().optional(),
  contamination: z.unknown().optional(),
  contacts: z.unknown().optional(),
  wind: z.unknown().optional(),
  motion: z.unknown().optional(),
  events: z.unknown().optional(),
});

/** The attribute id arrangement is read from — one spelling, three readers. */
export const HAIR_ARRANGEMENT_ATTRIBUTE_ID = "hair.arrangement";

/**
 * The committed arrangement from a resolved snapshot, or `null` when it is unset or
 * not legal vocabulary.
 *
 * Exported because a lane also needs the plain answer: the narrator-guidance
 * detector compares a player's "your loose hair" against the committed style
 * (narrator-physical-guidance slice 2), and re-deriving it from the raw attribute
 * there would be a second place for the enum spelling to be wrong.
 */
export function hairArrangementOf(attributes: ResolvedAttributeSnapshot): HairArrangement | null {
  const parsed = z.enum(hairArrangements).safeParse(attributeEnumValue(attributes, HAIR_ARRANGEMENT_ATTRIBUTE_ID));
  return parsed.success ? parsed.data : null;
}

/**
 * Arrangement is an ATTRIBUTE, not a payload field (Slice 0 ruling): the
 * archivist's `attributeChanges` lane keeps `hair.arrangement` current, so the
 * resolved snapshot is its authoritative producer.
 */
function readArrangement(request: AffordanceDomainRequest): AdapterRead<HairArrangement> {
  const raw = attributeEnumValue(request.attributes, HAIR_ARRANGEMENT_ATTRIBUTE_ID);
  return readAdapterInput(z.enum(hairArrangements), raw, "attribute", HAIR_ARRANGEMENT_ATTRIBUTE_ID);
}

const looseEndBandSchema = z.enum(hairLengthBands);

export const hairDomainDefinition: AffordanceDomainDefinition<
  HairStructuralProfile,
  HairEffectiveMechanics,
  HairAffordanceState,
  HairResolutionContext,
  HairAffordanceFrame
> = {
  id: HAIR_DOMAIN_ID,
  requiredAttributeIds: hairRequiredAttributeIds,

  // Hair's structure IS the character, so this domain reads only the attribute
  // half of the request — the garment domain is the one that compiles from
  // wardrobe truth instead (core `compileProfile`).
  compileProfile: (request) => compileHairProfile(request.attributes),

  readInputs: (request): AdapterRead<DomainInputs<HairAffordanceState, HairResolutionContext>> => {
    if (request.payload === undefined) return adapterUnavailable;
    const payload = hairPayloadSchema.safeParse(request.payload);
    if (!payload.success) return adapterInvalid;
    const raw = payload.data;

    const reads = {
      wetness: readAdapterInput(unitIntervalSchema, raw.wetness, "state", "wetness"),
      coveredFraction: readAdapterInput(unitIntervalSchema, raw.coveredFraction, "coverage", "coveredFraction"),
      arrangement: readArrangement(request),
      wind: readAdapterInput(hairWindReadSchema, raw.wind, "environment", "wind"),
      motion: readAdapterInput(hairMotionReadSchema, raw.motion, "state", "motion"),
      contamination: readAdapterInput(hairContaminationReadSchema, raw.contamination, "state", "contamination"),
      contacts: readAdapterInput(z.array(hairBodyContactSchema).max(64), raw.contacts, "contact", "contacts"),
      events: readAdapterInput(z.array(hairCausalEventSchema).max(64), raw.events, "event", "events"),
    };

    const structural = [reads.wetness, reads.coveredFraction, reads.arrangement];
    if (structural.some((read) => read.status === "invalid")) return adapterInvalid;
    if (
      !isAdapterSupported(reads.wetness) ||
      !isAdapterSupported(reads.coveredFraction) ||
      !isAdapterSupported(reads.arrangement)
    ) {
      return adapterUnavailable;
    }

    // A malformed optional descriptor is simply omitted: it can only ever ADD a
    // tag, so dropping it is the conservative reading.
    const parsedBand = looseEndBandSchema.safeParse(raw.looseEndLengthBand);
    const presentation = hairPresentationState({
      arrangement: reads.arrangement.value,
      coveredFraction: reads.coveredFraction.value,
      ...(parsedBand.success ? { looseEndLengthBand: parsedBand.data } : {}),
    });
    const wetness = reads.wetness.value;
    const evidence = adapterReadEvidence(reads);
    const contacts = isAdapterSupported(reads.contacts) ? reads.contacts.value : [];
    const events: readonly HairCausalEvent[] = isAdapterSupported(reads.events) ? reads.events.value : [];

    return adapterSupported({
      state: {
        subjectId: request.subjectId,
        storyTime: request.storyTime,
        inputs: adapterInputStatuses(reads),
        evidence,
        presentation,
        wetness,
      },
      context: {
        subjectId: request.subjectId,
        storyTime: request.storyTime,
        presentation,
        wetness,
        ...(isAdapterSupported(reads.contamination) ? { contamination: reads.contamination.value } : {}),
        actualContacts: contacts,
        ...(isAdapterSupported(reads.wind) ? { wind: reads.wind.value } : {}),
        ...(isAdapterSupported(reads.motion) ? { motion: reads.motion.value } : {}),
        recentEvents: events,
        evidence,
      },
    });
  },

  deriveMechanics: (profile, state) => ({
    mechanics: deriveHairMechanics({ profile, presentation: state.presentation, wetness: state.wetness }),
    evidence: [],
    diagnostics: [],
  }),

  buildFrame: buildHairFrame,

  phenomena: hairPhenomena,
};

export const hairAffordanceDomain = registerAffordanceDomain(hairDomainDefinition);
