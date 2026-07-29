import { z, type ZodType } from "zod";
import {
  adapterInputStatuses,
  adapterInvalid,
  adapterReadEvidence,
  adapterSupported,
  adapterUnavailable,
  affordanceEvidence,
  attributeEnumValue,
  isAdapterSupported,
  registerAffordanceDomain,
  unitIntervalSchema,
  type AdapterRead,
  type AffordanceDomainDefinition,
  type AffordanceDomainRequest,
  type AffordanceEvidenceKind,
  type DomainInputs,
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

/** One lane input under the adapter result law: absent ⇒ unavailable, unparsable ⇒ invalid. */
function readInput<TSchema extends ZodType>(
  schema: TSchema,
  raw: unknown,
  kind: AffordanceEvidenceKind,
  key: string,
): AdapterRead<z.output<TSchema>> {
  if (raw === undefined) return adapterUnavailable;
  const parsed = schema.safeParse(raw);
  return parsed.success ? adapterSupported(parsed.data, [affordanceEvidence(kind, key)]) : adapterInvalid;
}

/**
 * Arrangement is an ATTRIBUTE, not a payload field (Slice 0 ruling): the
 * archivist's `attributeChanges` lane keeps `hair.arrangement` current, so the
 * resolved snapshot is its authoritative producer.
 */
function readArrangement(request: AffordanceDomainRequest): AdapterRead<HairArrangement> {
  const raw = attributeEnumValue(request.attributes, "hair.arrangement");
  return readInput(z.enum(hairArrangements), raw, "attribute", "hair.arrangement");
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
      wetness: readInput(unitIntervalSchema, raw.wetness, "state", "wetness"),
      coveredFraction: readInput(unitIntervalSchema, raw.coveredFraction, "coverage", "coveredFraction"),
      arrangement: readArrangement(request),
      wind: readInput(hairWindReadSchema, raw.wind, "environment", "wind"),
      motion: readInput(hairMotionReadSchema, raw.motion, "state", "motion"),
      contamination: readInput(hairContaminationReadSchema, raw.contamination, "state", "contamination"),
      contacts: readInput(z.array(hairBodyContactSchema).max(64), raw.contacts, "contact", "contacts"),
      events: readInput(z.array(hairCausalEventSchema).max(64), raw.events, "event", "events"),
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
