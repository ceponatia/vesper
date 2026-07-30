import { z } from "zod";
import { committedContactReadSchema } from "../../contact";
import {
  adapterInputStatuses,
  adapterInvalid,
  adapterReadEvidence,
  adapterSupported,
  adapterUnavailable,
  isAdapterSupported,
  readAdapterInput,
  registerAffordanceDomain,
  type AdapterRead,
  type AffordanceDomainDefinition,
  type DomainInputs,
} from "../../core";
import { footRequiredAttributeIds } from "./attribute-maps";
import { footCoarseConditionSchema } from "./condition";
import {
  buildFootFrame,
  footContactFromCommitted,
  type FootAffordanceFrame,
  type FootAffordanceState,
  type FootContactRead,
  type FootResolutionContext,
} from "./frame";
import { compileFootwearContact, footwearItemSchema, type FootwearContactRead } from "./footwear";
import { deriveFootMechanics, type FootEffectiveMechanics } from "./mechanics";
import { footPhenomena } from "./phenomena";
import { compileFootProfile, type FootStructuralProfile } from "./profile";
import {
  footArticulationReadSchema,
  footSupportReadSchema,
  type FootArticulationRead,
  type FootSupportRead,
} from "./support";

/**
 * The foot domain — the romantic-contact plan's first proving domain
 * (romantic-contact-affordances.spec.foot.md).
 *
 * ```text
 * feet.arch / feet.nails / feet.toes            →  regional structural profile
 *                    + coarse surface condition →  regional effective mechanics
 *      + a COMMITTED contact, footwear, support,
 *        pose, and an asserted tactile channel  →  foot frame
 *                                               →  five phenomena
 * ```
 *
 * ## It is not registered in `domains.ts`, on purpose
 *
 * `affordanceDomains` is the declared LIVE set, and every phenomenon here needs
 * a committed contact from a lifecycle no lane owns yet (audit: the active
 * contact lifecycle is **absent** in both lanes). A domain in that tuple whose
 * every read is structurally guaranteed to suppress would be a declaration this
 * build cannot keep. Slice 3 wires the lane and adds the row in the same change
 * — see `foot.test.ts`, which pins both the absence and the reason.
 *
 * ## `readInputs` is the only untyped door
 *
 * Every input obeys the audit's adapter result law: `supported` with provenance,
 * `unavailable`, or `invalid`, and the two failures carry no value. Nothing here
 * invents a dry surface, a bare foot, a resting pose, or a touch nobody asserted.
 *
 * Nothing is structural: a payload that parses but answers nothing leaves every
 * phenomenon suppressed by the core, which is exactly what an unfed lane should
 * produce.
 */

export const FOOT_DOMAIN_ID = "foot";

/** The lane payload shape, documented as a type for adapters and fixtures. */
export interface FootLanePayload {
  readonly condition?: unknown;
  /** A `CommittedContactRead` — the ONLY thing that can license an observation. */
  readonly contact?: unknown;
  readonly footwear?: unknown;
  readonly support?: unknown;
  readonly articulation?: unknown;
  readonly tactile?: unknown;
}

const footPayloadSchema = z.object({
  condition: z.unknown().optional(),
  contact: z.unknown().optional(),
  footwear: z.unknown().optional(),
  support: z.unknown().optional(),
  articulation: z.unknown().optional(),
  tactile: z.unknown().optional(),
});

/**
 * The tactile channel, as the lane asserts it.
 *
 * A positive assertion is required, matching the core perception rule that *"a
 * lane that does not positively assert sight gets silence, not the benefit of
 * the doubt"*. `{ available: false }` is an ANSWER (the toucher cannot feel);
 * an absent key is a lane that has no channel model at all, which is today's
 * production reality in both lanes.
 */
const tactileReadSchema = z.object({ available: z.boolean() }).strict();

const footwearPayloadSchema = z.array(footwearItemSchema).max(8);

/** One entry per foot. A lane that poses one foot sends one entry. */
const footSupportPayloadSchema = z.array(footSupportReadSchema).max(4);
const footArticulationPayloadSchema = z.array(footArticulationReadSchema).max(4);

export const footDomainDefinition: AffordanceDomainDefinition<
  FootStructuralProfile,
  FootEffectiveMechanics,
  FootAffordanceState,
  FootResolutionContext,
  FootAffordanceFrame
> = {
  id: FOOT_DOMAIN_ID,
  requiredAttributeIds: footRequiredAttributeIds,

  // The foot's structure IS the character, so this domain reads only the
  // attribute half of the request.
  compileProfile: (request) => compileFootProfile(request.attributes),

  readInputs: (request): AdapterRead<DomainInputs<FootAffordanceState, FootResolutionContext>> => {
    if (request.payload === undefined) return adapterUnavailable;
    const payload = footPayloadSchema.safeParse(request.payload);
    if (!payload.success) return adapterInvalid;
    const raw = payload.data;

    const reads = {
      condition: readAdapterInput(footCoarseConditionSchema, raw.condition, "state", "condition"),
      contact: readAdapterInput(committedContactReadSchema, raw.contact, "contact", "contact"),
      footwear: readAdapterInput(footwearPayloadSchema, raw.footwear, "coverage", "footwear"),
      support: readAdapterInput(footSupportPayloadSchema, raw.support, "state", "support"),
      articulation: readAdapterInput(footArticulationPayloadSchema, raw.articulation, "state", "articulation"),
      tactile: readAdapterInput(tactileReadSchema, raw.tactile, "adapter", "tactile"),
    };

    const footwear: FootwearContactRead | undefined = isAdapterSupported(reads.footwear)
      ? compileFootwearContact(reads.footwear.value)
      : undefined;

    // A contact that does not touch THIS subject's foot is not this domain's
    // contact. It degrades to "no contact" rather than to an unplaced one, so a
    // hand on a shoulder can never light up a foot phenomenon.
    const contact: FootContactRead | undefined = isAdapterSupported(reads.contact)
      ? (footContactFromCommitted({ contact: reads.contact.value, subjectId: request.subjectId }) ?? undefined)
      : undefined;

    // Both are PER FOOT. An empty list is the lane answering "no foot is posed";
    // an unavailable input is the lane having no pose owner at all, and the core
    // tells those two apart before a resolver can.
    const supportRead = reads.support;
    const supports: readonly FootSupportRead[] = isAdapterSupported(supportRead)
      ? supportRead.value.map((entry) => ({ ...entry, evidence: supportRead.evidence }))
      : [];
    const articulationRead = reads.articulation;
    const articulations: readonly FootArticulationRead[] = isAdapterSupported(articulationRead)
      ? articulationRead.value.map((entry) => ({ ...entry, evidence: articulationRead.evidence }))
      : [];

    const evidence = adapterReadEvidence(reads);
    // A committed contact that was for somebody else's body downgrades this
    // domain's `contact` key to `unavailable`, so the phenomena that require one
    // are suppressed by the core rather than left to notice an absent field.
    //
    // The override applies ONLY to a read that was `supported` and projected to
    // nothing. A blanket `contact === undefined` override also swallowed
    // `invalid`, so a corrupt stored contact reported "no owner answered" when
    // the truth was "an owner answered with something unreadable" — the two
    // halves of the adapter result law that must never be confused.
    const projectedAway = isAdapterSupported(reads.contact) && contact === undefined;
    const inputs = {
      ...adapterInputStatuses(reads),
      ...(projectedAway ? { contact: "unavailable" as const } : {}),
    };

    return adapterSupported({
      state: {
        subjectId: request.subjectId,
        storyTime: request.storyTime,
        inputs,
        evidence,
        ...(isAdapterSupported(reads.condition) ? { coarse: reads.condition.value } : {}),
        ...(footwear === undefined ? {} : { footwear }),
        articulations,
      },
      context: {
        subjectId: request.subjectId,
        storyTime: request.storyTime,
        ...(footwear === undefined ? {} : { footwear }),
        ...(contact === undefined ? {} : { contact }),
        supports,
        articulations,
        tactile: isAdapterSupported(reads.tactile) && reads.tactile.value.available,
        evidence,
      },
    });
  },

  deriveMechanics: (profile, state) => ({
    mechanics: deriveFootMechanics({
      profile,
      ...(state.coarse === undefined ? {} : { coarse: state.coarse }),
      ...(state.footwear === undefined ? {} : { footwear: state.footwear }),
      articulations: state.articulations,
    }),
    evidence: [],
    diagnostics: [],
  }),

  buildFrame: buildFootFrame,

  phenomena: footPhenomena,
};

export const footAffordanceDomain = registerAffordanceDomain(footDomainDefinition);
