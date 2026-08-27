import { z } from "zod";

/**
 * E4.3 — the deliberator admission seam. An LLM deliberator may only
 * ever pick among candidates deterministic policy already ruled legal, and
 * only when admission passes every gate below. The seam ships fully typed and
 * stub-exercised — zero live model calls until a Gate 6 LOD controller
 * supplies a real deliberator.
 */

/** The inference-LOD vocabulary; admission requires the top tiers. */
export const inferenceLods = ["no_model", "small_model", "deliberator", "narrator"] as const;
export const inferenceLodSchema = z.enum(inferenceLods);
export type InferenceLod = z.infer<typeof inferenceLodSchema>;

/** Candidate ids are opaque to the model — it selects, it never authors. */
export const deliberationCandidateSchema = z
  .object({
    id: z.string().min(1).max(256),
    /** Deterministic utility, fixed-point — no float rounding in rules. */
    deterministicScoreFixedPoint: z.number().int().min(-1_000_000).max(1_000_000),
  })
  .strict();

export type DeliberationCandidate = z.infer<typeof deliberationCandidateSchema>;

export const deliberatorAdmissionInputSchema = z
  .object({
    /** Opaque like the candidates — the seam never resolves actor state. */
    actorId: z.string().min(1).max(256),
    inferenceLod: inferenceLodSchema,
    /** Bounded legal candidates — policy output, never free text. */
    candidates: z.array(deliberationCandidateSchema).max(8),
    /** Admit only while the deterministic scores are genuinely close. */
    scoreGapThresholdFixedPoint: z.number().int().nonnegative(),
    /** Narratively or materially consequential — a routine choice never admits. */
    consequential: z.boolean(),
    modelBudgetRemaining: z.number().int().nonnegative(),
    hasDeterministicFallback: z.boolean(),
  })
  .strict();

export type DeliberatorAdmissionInput = z.infer<typeof deliberatorAdmissionInputSchema>;

export const deliberationAdmissionReasonCodes = [
  "admitted",
  "lod_too_low",
  "insufficient_candidates",
  "score_gap_decisive",
  "not_consequential",
  "no_model_budget",
  "no_deterministic_fallback",
] as const;
export const deliberationAdmissionReasonCodeSchema = z.enum(deliberationAdmissionReasonCodes);
export type DeliberationAdmissionReasonCode = z.infer<typeof deliberationAdmissionReasonCodeSchema>;

export const deliberatorAdmissionSchema = z
  .object({
    admitted: z.boolean(),
    reasonCode: deliberationAdmissionReasonCodeSchema,
    /** Highest deterministic score, ties by id — always computed, always legal. */
    fallbackCandidateId: z.string().min(1).max(256).optional(),
  })
  .strict();

export type DeliberatorAdmission = z.infer<typeof deliberatorAdmissionSchema>;

/** What the model sees: opaque ids and bounded, caller-redacted evidence. */
export const deliberatorRequestSchema = z
  .object({
    candidateIds: z.array(z.string().min(1).max(256)).min(2).max(8),
    evidence: z.array(z.string().min(1).max(500)).max(16),
  })
  .strict();

export type DeliberatorRequest = z.infer<typeof deliberatorRequestSchema>;

/**
 * The model's reply crosses a trust boundary. Deliberately NOT `.strict()`:
 * any extra fields — new action text especially — are stripped and ignored,
 * never an error that fails the turn.
 */
export const deliberatorResponseSchema = z.object({
  chosenCandidateId: z.string().min(1).max(256),
  /** Short, user-invisible; recorded for audit, never rendered. */
  rationaleSummary: z.string().max(500).optional(),
});

export type DeliberatorResponse = z.infer<typeof deliberatorResponseSchema>;

export const deliberationOutcomeSchema = z
  .object({
    chosenCandidateId: z.string().min(1).max(256),
    usedFallback: z.boolean(),
    admissionReasonCode: deliberationAdmissionReasonCodeSchema,
    rationaleSummary: z.string().max(500).optional(),
    diagnostics: z.array(z.string().min(1)),
  })
  .strict();

export type DeliberationOutcome = z.infer<typeof deliberationOutcomeSchema>;
