import { z } from "zod";
import {
  affordanceStoryTimeSchema,
  unitIntervalSchema,
  type AffordanceEvidence,
  type AffordanceResolutionContext,
  type AffordanceStateSnapshot,
  type DomainFrame,
  type UnitInterval,
} from "../../core";
import type { HairEffectiveMechanics, HairPresentationState } from "./mechanics";
import type { HairStructuralProfile } from "./profile";

/**
 * Stage 3 — one subject's hair view of one committed cut (hair spec
 * §"Domain frame").
 *
 * The live-input types are declared HERE, in the domain that consumes them, and
 * are deliberately tiny: a force is a magnitude, a contact is a pair of body
 * locations, an event is a kind and when it happened. Slice 4's lane adapter
 * normalizes authoritative chat state into these shapes; nothing in this file
 * knows where they came from, and hair code performs no persistence access.
 *
 * Absence is meaningful and is modelled as absence: no `wind` key means no wind
 * read, never still air; an empty `actualContacts` means the lane could answer
 * and the answer was "nothing is touching", which is a different claim from
 * "this lane has no contact owner" (that one suppresses the phenomenon in the
 * core, before a resolver can misread the empty list).
 */

/** The body location hair observations are sourced from. */
export const HAIR_LOCATION_ID = "hair";

// ---------------------------------------------------------------------------
// Live inputs
// ---------------------------------------------------------------------------

/** Current air movement over the subject. */
export const hairWindReadSchema = z.object({ force: unitIntervalSchema });
export type HairWindRead = z.infer<typeof hairWindReadSchema>;

/** Current subject movement (walking, turning, riding). */
export const hairMotionReadSchema = z.object({ force: unitIntervalSchema });
export type HairMotionRead = z.infer<typeof hairMotionReadSchema>;

/** Non-water residue at the hair location — mud, ash, blood. */
export const hairContaminationReadSchema = z.object({
  level: unitIntervalSchema,
  kind: z.string().trim().min(1).max(64).optional(),
});
export type HairContaminationRead = z.infer<typeof hairContaminationReadSchema>;

/** An ASSERTED contact. Structural reach can license one; only the lane may assert one. */
export const hairBodyContactSchema = z.object({
  sourceLocationId: z.string().trim().min(1).max(64),
  targetLocationId: z.string().trim().min(1).max(64),
});
export type HairBodyContact = z.infer<typeof hairBodyContactSchema>;

/** Committed causal events the hair phenomena may cite. */
export const hairEventKinds = [
  "rain_exposure",
  "immersion",
  "splash",
  "shake",
  "sudden_turn",
  "run",
  "impact",
  "gust",
] as const;
export type HairEventKind = (typeof hairEventKinds)[number];

/** Kinds that count as a committed IMPULSE — droplet shedding requires one of these. */
export const hairImpulseEventKinds = ["shake", "sudden_turn", "run", "impact", "gust"] as const;

/**
 * Kinds that WET the hair — the ones a wet read may name as its cause.
 *
 * Each kind names ITSELF and nothing else, which is the whole point: `immersion`
 * (a bath, a pool, a dunking) and `splash` are legitimate wetting events, and
 * narrating either as weather is a direct contradiction of the scene. Only
 * `rain_exposure` may ever say rain.
 *
 * Naming the non-rain causes at all is the round-R2 finding: a wet read that
 * stayed silent about a committed bath let the narrator reach for the storm it
 * could hear at the window — the cue arm misattributed wetness at twice the
 * control's rate. Silence about a KNOWN cause is not conservative; only silence
 * about an unknown one is, so an impulse kind (a shake, a gust) maps to nothing
 * and unknown provenance still says nothing at all.
 */
export const hairWettingEventKinds = ["rain_exposure", "immersion", "splash"] as const;
export type HairWettingEventKind = (typeof hairWettingEventKinds)[number];

export const hairCausalEventSchema = z.object({
  kind: z.enum(hairEventKinds),
  atStoryTime: affordanceStoryTimeSchema,
});
export type HairCausalEvent = z.infer<typeof hairCausalEventSchema>;

export function isHairImpulseEvent(event: HairCausalEvent): boolean {
  return (hairImpulseEventKinds as readonly HairEventKind[]).includes(event.kind);
}


// ---------------------------------------------------------------------------
// State, context, frame
// ---------------------------------------------------------------------------

/** What `deriveMechanics` needs: everything current that changes how hair behaves. */
export interface HairAffordanceState extends AffordanceStateSnapshot {
  readonly presentation: HairPresentationState;
  readonly wetness: UnitInterval;
}

/** What `buildFrame` needs: the same current state plus the causes phenomena check for. */
export interface HairResolutionContext extends AffordanceResolutionContext {
  readonly presentation: HairPresentationState;
  readonly wetness: UnitInterval;
  readonly contamination?: HairContaminationRead;
  readonly actualContacts: readonly HairBodyContact[];
  readonly wind?: HairWindRead;
  readonly motion?: HairMotionRead;
  readonly recentEvents: readonly HairCausalEvent[];
  readonly evidence: readonly AffordanceEvidence[];
}

export interface HairAffordanceFrame extends DomainFrame<HairStructuralProfile, HairEffectiveMechanics> {
  readonly presentation: HairPresentationState;
  readonly wetness: UnitInterval;
  readonly contamination?: HairContaminationRead;
  readonly actualContacts: readonly HairBodyContact[];
  readonly wind?: HairWindRead;
  readonly motion?: HairMotionRead;
  readonly recentEvents: readonly HairCausalEvent[];
}

export function buildHairFrame(
  profile: HairStructuralProfile,
  mechanics: HairEffectiveMechanics,
  context: HairResolutionContext,
): HairAffordanceFrame {
  return {
    subjectId: context.subjectId,
    storyTime: context.storyTime,
    profile,
    mechanics,
    evidence: context.evidence,
    presentation: context.presentation,
    wetness: context.wetness,
    ...(context.contamination === undefined ? {} : { contamination: context.contamination }),
    actualContacts: context.actualContacts,
    ...(context.wind === undefined ? {} : { wind: context.wind }),
    ...(context.motion === undefined ? {} : { motion: context.motion }),
    recentEvents: context.recentEvents,
  };
}
