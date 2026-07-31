import { z } from "zod";
import {
  affordanceEvidence,
  mergeAffordanceEvidence,
  type AffordanceEvidence,
  type AffordanceStoryTime,
} from "../core";
import { contactEntityId, contactEntityIdSchema, contactEvidenceSchema, type ContactEntityId } from "../contact";
import { sceneProvenanceSourceSchema, type SceneProvenanceSource } from "./vocabulary";

/**
 * Identity and the provenance law
 * (romantic-contact-affordances.spec.scene.md §"Provenance law").
 *
 * **Every authoritative scene fact carries where it came from, and every read
 * hands back the provenance of every fact it consulted.** Not as decoration: it
 * is the only way a downstream consumer — a contact resolver, a retake replay,
 * a debug pane — can tell an authored placement from a player's own movement
 * from a simulation decision, and it is what makes "narrator prose is not
 * physical authority" checkable rather than aspirational. There is no prose
 * source in the vocabulary, so a fact sourced from a sentence has nowhere to
 * land.
 *
 * A fact is `value + provenance`, never a bare value. The wrapper is
 * deliberately unavoidable: an optional provenance field would be omitted under
 * deadline exactly once, and after that the scene would carry claims nobody can
 * trace.
 */

const sceneTextSchema = z.string().trim().min(1).max(256);

/**
 * The lane's own id for the event or decision behind a fact. Opaque and carried
 * verbatim, for the reason the contact core takes a `ContactEventRef` rather
 * than the successor's branded `EventId`: legacy chat has message ids and
 * nothing else, and binding this module to either lane's id would fork it.
 */
export const sceneEventRefSchema = sceneTextSchema.brand<"SceneEventRef">();
export type SceneEventRef = z.infer<typeof sceneEventRefSchema>;

export function sceneEventRef(raw: string): SceneEventRef {
  return sceneEventRefSchema.parse(raw);
}

/**
 * A support surface's identity — furniture, the floor, a wall.
 *
 * This is the contact core's `ContactEntityId` and not a new id type, on
 * purpose. A contact whose target is `{ kind: "object", entityId }` and a scene
 * whose bed is a support surface are talking about the same object, and two id
 * spaces would mean a foot resting on the bed could not be recognized as
 * touching the thing it is resting on. Re-exported under a scene-side name so a
 * reader of this module does not have to know which file the brand lives in.
 */
export type SceneSupportId = ContactEntityId;
export const sceneSupportIdSchema = contactEntityIdSchema;
export const sceneSupportId = contactEntityId;

/** Where one fact came from, when, and on whose word. */
export interface SceneProvenance {
  readonly source: SceneProvenanceSource;
  readonly ref: SceneEventRef;
  readonly storyTime: AffordanceStoryTime;
  /** The affordance-layer provenance trail, for the debug surface. Never prose. */
  readonly evidence: readonly AffordanceEvidence[];
}

/** Strict throughout — a provenance that does not parse is not repaired into one that does. `contactEvidenceSchema` is reused rather than restated: one evidence definition, two consumers. */
export const sceneProvenanceSchema: z.ZodType<SceneProvenance> = z.object({
  source: sceneProvenanceSourceSchema,
  ref: sceneEventRefSchema,
  storyTime: z.number().int().min(0),
  evidence: z.array(contactEvidenceSchema).max(16).readonly(),
});

export function sceneProvenance(input: {
  source: SceneProvenanceSource;
  ref: SceneEventRef;
  storyTime: AffordanceStoryTime;
  evidence?: readonly AffordanceEvidence[];
}): SceneProvenance {
  return {
    source: input.source,
    ref: input.ref,
    storyTime: input.storyTime,
    evidence: input.evidence ?? [],
  };
}

/** One authoritative fact: a value that can never travel without its source. */
export interface SceneFact<TValue> {
  readonly value: TValue;
  readonly provenance: SceneProvenance;
}

export function sceneFact<TValue>(value: TValue, provenance: SceneProvenance): SceneFact<TValue> {
  return { value, provenance };
}

/** The boundary schema for a fact of some value type. */
export function sceneFactSchema<TValue>(value: z.ZodType<TValue>): z.ZodType<SceneFact<TValue>> {
  return z.object({ value, provenance: sceneProvenanceSchema });
}

/**
 * Project a read's provenance trail into affordance evidence.
 *
 * One entry per fact naming the event that produced it, plus whatever evidence
 * the fact already carried. This is how a scene answer keeps its trail when it
 * is handed to the contact core, whose reads speak `AffordanceEvidence` and
 * nothing else — the richer `SceneProvenance` stays available on the scene
 * answer itself for anyone who needs the source kind and the story time.
 */
export function sceneProvenanceEvidence(entries: readonly SceneProvenance[]): readonly AffordanceEvidence[] {
  return mergeAffordanceEvidence(
    entries.map((entry) => affordanceEvidence("state", entry.ref, entry.source)),
    ...entries.map((entry) => entry.evidence),
  );
}
