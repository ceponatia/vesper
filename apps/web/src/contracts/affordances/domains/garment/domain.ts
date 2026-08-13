import { z } from "zod";
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
  type AffordanceDomainRequest,
  type DomainInputs,
} from "../../core";
import { compileGarmentProfile, parseGarmentRegions, type GarmentRegionInput, type GarmentStructuralProfile } from "./profile";
import { deriveGarmentMechanics, type GarmentEffectiveMechanics, type GarmentRegionStateRead } from "./mechanics";
import {
  buildGarmentFrame,
  closedGarmentFocus,
  garmentBodyContactSchema,
  garmentCausalEventSchema,
  garmentFocusReadSchema,
  garmentRegionStateSchema,
  type GarmentAffordanceFrame,
  type GarmentAffordanceState,
  type GarmentBodyContactRead,
  type GarmentCausalEvent,
  type GarmentResolutionContext,
} from "./frame";
import { garmentPhenomena } from "./phenomena";

/**
 * The GARMENT affordance domain — the plan's second proving domain (slice 6).
 *
 * Its whole reason for existing is architectural: it must reuse the shared
 * foundation without a single line of hair knowledge leaking into
 * `affordances/core`. Two things about it are genuinely unlike hair, and both
 * were absorbed by domain-neutral seams rather than by special-casing:
 *
 * - **its structure is not the character's.** A garment's material and
 *   construction belong to the wardrobe, so `compileProfile` reads the request's
 *   PAYLOAD rather than its attribute snapshot. The core's `compileProfile` now
 *   takes the whole request and cares about neither half — no `if (domain ===
 *   "garment")` anywhere;
 * - **it is inherently regional and plural.** A subject wears several garments,
 *   each with several parts. That is the architecture spec's existing "regional
 *   collections" pattern, instantiated rather than invented.
 *
 * `requiredAttributeIds` is EMPTY, and that is the second-domain proof in one
 * line: a domain can be about something the character is wearing and still ride
 * the same registry, the same staged runner, the same perception filter, and the
 * same cue cap.
 *
 * ## The adapter result law here
 *
 * | input | who owns it | status |
 * | --- | --- | --- |
 * | `regions` | wardrobe (instances + blueprints + presentation-aware coverage) | structural: absent ⇒ whole domain unavailable |
 * | `contacts` | the shared scene/body-relations owner, or fit (spec's establishment law) | per-phenomenon; absent ⇒ `garment.wet_cling` suppressed |
 * | `events` | committed wetting events | optional enrichment (a rain provenance tag) |
 * | `focus` | the lane's narrative-focus/consent state | optional; absent ⇒ the CLOSED default |
 *
 * `focus` failing closed is load-bearing: `closedGarmentFocus()` blocks every
 * intimate read, so a lane that has not thought about the policy gets the
 * policy's strictest answer rather than its most permissive one.
 */

export const GARMENT_DOMAIN_ID = "garment";

/**
 * The lane payload shape, documented as a type for adapters and fixtures. The
 * runtime still narrows `unknown` — this is the contract, not the trust.
 */
export interface GarmentLanePayload {
  /** Structural rows: one per worn garment PART that covers something. */
  readonly regions: readonly GarmentRegionInput[];
  /** Current wardrobe reading per region — saturation and the occlusion verdict. */
  readonly state: readonly { readonly regionId: string; readonly saturation: number; readonly visibility?: string }[];
  /** Asserted garment/body contacts. OMIT the key when the lane cannot establish any. */
  readonly contacts?: readonly GarmentBodyContactRead[];
  readonly events?: readonly { readonly kind: GarmentCausalEvent["kind"]; readonly atStoryTime: number }[];
  readonly focus?: { readonly intimateRelevant: boolean; readonly intimateAllowed: boolean };
}

const garmentPayloadSchema = z.object({
  regions: z.unknown().optional(),
  state: z.unknown().optional(),
  contacts: z.unknown().optional(),
  events: z.unknown().optional(),
  focus: z.unknown().optional(),
});

/** The structural rows, narrowed once for `compileProfile`. */
function payloadRegions(request: AffordanceDomainRequest): readonly GarmentRegionInput[] | null {
  const payload = garmentPayloadSchema.safeParse(request.payload);
  if (!payload.success || payload.data.regions === undefined) return null;
  return parseGarmentRegions(payload.data.regions);
}

export const garmentDomainDefinition: AffordanceDomainDefinition<
  GarmentStructuralProfile,
  GarmentEffectiveMechanics,
  GarmentAffordanceState,
  GarmentResolutionContext,
  GarmentAffordanceFrame
> = {
  id: GARMENT_DOMAIN_ID,
  // Nothing. A garment's structure is the wardrobe's, not the body's — which is
  // exactly what makes this domain the foundation's second, unlike proof.
  requiredAttributeIds: [],

  // Compiles from the PAYLOAD (see the core's `compileProfile` contract): an
  // unreadable or empty region list yields no profile, and the core suppresses
  // the domain. Silence for an unknown wardrobe, never a bare body.
  compileProfile: (request) => {
    const regions = payloadRegions(request);
    return regions === null ? { evidence: [], diagnostics: [] } : compileGarmentProfile(regions);
  },

  readInputs: (request): AdapterRead<DomainInputs<GarmentAffordanceState, GarmentResolutionContext>> => {
    if (request.payload === undefined) return adapterUnavailable;
    const payload = garmentPayloadSchema.safeParse(request.payload);
    if (!payload.success) return adapterInvalid;
    const raw = payload.data;

    const reads = {
      regions: readAdapterInput(z.array(garmentRegionStateSchema).max(96), raw.state, "state", "garment.state"),
      contacts: readAdapterInput(z.array(garmentBodyContactSchema).max(64), raw.contacts, "contact", "garment.contacts"),
      events: readAdapterInput(z.array(garmentCausalEventSchema).max(32), raw.events, "event", "garment.events"),
      focus: readAdapterInput(garmentFocusReadSchema, raw.focus, "state", "garment.focus"),
    };

    // `regions` is STRUCTURAL: without the current wardrobe reading there is no
    // saturation, and "assume dry" is exactly the convenient default the adapter
    // law forbids.
    if (reads.regions.status === "invalid") return adapterInvalid;
    if (!isAdapterSupported(reads.regions)) return adapterUnavailable;

    const regions: readonly GarmentRegionStateRead[] = reads.regions.value;
    const evidence = adapterReadEvidence(reads);
    const contacts: readonly GarmentBodyContactRead[] = isAdapterSupported(reads.contacts) ? reads.contacts.value : [];
    const events: readonly GarmentCausalEvent[] = isAdapterSupported(reads.events) ? reads.events.value : [];
    // Absent or malformed focus ⇒ the CLOSED default, so a lane that says nothing
    // about the intimate policy gets its strictest reading.
    const focus = isAdapterSupported(reads.focus) ? reads.focus.value : closedGarmentFocus();

    return adapterSupported({
      state: {
        subjectId: request.subjectId,
        storyTime: request.storyTime,
        inputs: adapterInputStatuses(reads),
        evidence,
        regions,
      },
      context: {
        subjectId: request.subjectId,
        storyTime: request.storyTime,
        regions,
        actualContacts: contacts,
        recentEvents: events,
        focus,
        evidence,
      },
    });
  },

  deriveMechanics: (profile, state) => ({
    mechanics: deriveGarmentMechanics({ profile, state: state.regions }),
    evidence: [],
    diagnostics: [],
  }),

  buildFrame: buildGarmentFrame,

  phenomena: garmentPhenomena,
};

export const garmentAffordanceDomain = registerAffordanceDomain(garmentDomainDefinition);
