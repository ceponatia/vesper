import { z } from "zod";
import {
  branchSequenceSchema,
  composeSimulationId,
  derivationVersionSchema,
  eventIdSchema,
  observationIdSchema,
  storySecondSchema,
  worldBranchIdSchema,
  worldCharacterIdSchema,
} from "./identity";

/**
 * E4.1 — typed perception. An Observation records that one committed event
 * produced evidence for one witness, through one channel, at one confidence
 * and detail tier. Observations are DERIVED — a pure function of the event
 * stream — so replay reproduces every row bit-for-bit and a rebuilt branch
 * cannot disagree with the live one about who saw what.
 *
 * Only material observations persist (§20): rows that can affect belief,
 * memory, action choice, relationships, or narration continuity. Bookkeeping
 * events (trigger scheduling, commitment ledger changes, pressure) derive no
 * observations at all — knowledge of an obligation rides an `observed`
 * knowledge source pointing at a genuinely perceptible event instead.
 */

/**
 * How the evidence reached the witness. `embodied` is first-person
 * participation in a physical event; `device` is a remote channel (text,
 * voice, video); `social` is knowledge arriving through another person —
 * E4.2 disclosures grade their listeners with it. `touch`/`smell` remain
 * legal vocabulary ahead of their first deriver, so adding them later is a
 * rule change, not a contract change.
 */
export const observationChannels = [
  "embodied",
  "sight",
  "sound",
  "touch",
  "smell",
  "device",
  "social",
] as const;
export const observationChannelSchema = z.enum(observationChannels);
export type ObservationChannel = z.infer<typeof observationChannelSchema>;

/**
 * What kind of evidence the witness holds. `direct` = party to the event;
 * `sensory` = perceived it happening; `reported` = received as testimony —
 * the E4.2 belief fold forms beliefs from exactly this class; `inferred`
 * stays reserved ahead of its first deriver.
 */
export const observationEvidenceClasses = ["direct", "sensory", "reported", "inferred"] as const;
export const observationEvidenceClassSchema = z.enum(observationEvidenceClasses);
export type ObservationEvidenceClass = z.infer<typeof observationEvidenceClassSchema>;

/** Fixed-point confidence: 10_000 = certainty (spec §6.1 — no float rounding in rules). */
export const observationConfidenceSchema = z.number().int().min(0).max(10_000);

/** 3 = full first-person detail · 2 = clear witness · 1 = degraded (muffled, glimpsed). */
export const observationDetailTierSchema = z.number().int().min(1).max(3);

export const observationSchema = z
  .object({
    id: observationIdSchema,
    branchId: worldBranchIdSchema,
    sourceEventId: eventIdSchema,
    /** Denormalized from the source event so interval reads never join the log. */
    sourceEventSequence: branchSequenceSchema,
    witnessActorId: worldCharacterIdSchema,
    storySecond: storySecondSchema,
    channel: observationChannelSchema,
    evidenceClass: observationEvidenceClassSchema,
    confidenceFixedPoint: observationConfidenceSchema,
    detailTier: observationDetailTierSchema,
    derivationVersion: derivationVersionSchema,
  })
  .strict();

export type Observation = z.infer<typeof observationSchema>;

/**
 * Observation identity is derived from (source event, witness) — at most one
 * row per pair, and replay mints the identical id. Event ids run long (they
 * embed branch and command identity), which is why observation ids use the
 * wide id class rather than the compact one.
 */
export function deriveObservationId(sourceEventId: string, witnessActorId: string): string {
  return composeSimulationId("obs", [sourceEventId, witnessActorId]);
}
