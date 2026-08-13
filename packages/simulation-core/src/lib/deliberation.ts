import {
  deliberationOutcomeSchema,
  deliberatorAdmissionSchema,
  deliberatorRequestSchema,
  deliberatorResponseSchema,
  type DeliberationCandidate,
  type DeliberationOutcome,
  type DeliberatorAdmission,
  type DeliberatorAdmissionInput,
  type DeliberatorRequest,
} from "../contracts/deliberation";

/**
 * E4.3 — the §19.3 deliberator admission seam. Deterministic policy stays the
 * default brain; a model is admitted only when every gate passes, may only
 * pick among the bounded legal candidates by opaque id, and always has a
 * deterministic fallback standing behind it. No live model call exists in
 * this slice — callers inject `deliberate`, tests inject stubs.
 */

function compareStableText(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

/** Highest deterministic score wins; ties break by candidate id. */
export function deterministicFallbackCandidate(
  candidates: readonly DeliberationCandidate[],
): DeliberationCandidate | undefined {
  return [...candidates].sort(
    (left, right) =>
      right.deterministicScoreFixedPoint - left.deterministicScoreFixedPoint ||
      compareStableText(left.id, right.id),
  )[0];
}

/** The §19.3 admission gates, checked in spec order; first failure names why. */
export function admitDeliberator(input: DeliberatorAdmissionInput): DeliberatorAdmission {
  const fallback = deterministicFallbackCandidate(input.candidates);
  const base = fallback === undefined ? {} : { fallbackCandidateId: fallback.id };
  const refuse = (reasonCode: DeliberatorAdmission["reasonCode"]): DeliberatorAdmission =>
    deliberatorAdmissionSchema.parse({ admitted: false, reasonCode, ...base });

  if (input.inferenceLod !== "deliberator" && input.inferenceLod !== "narrator") {
    return refuse("lod_too_low");
  }
  if (input.candidates.length < 2) return refuse("insufficient_candidates");
  const sorted = [...input.candidates].sort(
    (left, right) => right.deterministicScoreFixedPoint - left.deterministicScoreFixedPoint,
  );
  const top = sorted[0];
  const runnerUp = sorted[1];
  if (
    top !== undefined &&
    runnerUp !== undefined &&
    top.deterministicScoreFixedPoint - runnerUp.deterministicScoreFixedPoint >=
      input.scoreGapThresholdFixedPoint
  ) {
    return refuse("score_gap_decisive");
  }
  if (!input.consequential) return refuse("not_consequential");
  if (input.modelBudgetRemaining <= 0) return refuse("no_model_budget");
  if (!input.hasDeterministicFallback || fallback === undefined) {
    return refuse("no_deterministic_fallback");
  }
  return deliberatorAdmissionSchema.parse({ admitted: true, reasonCode: "admitted", ...base });
}

/** Build the bounded, opaque request the model sees — ids and evidence only. */
export function buildDeliberatorRequest(
  candidates: readonly DeliberationCandidate[],
  evidence: readonly string[],
): DeliberatorRequest {
  return deliberatorRequestSchema.parse({
    candidateIds: [...candidates].map((candidate) => candidate.id).sort(compareStableText),
    evidence: evidence.slice(0, 16),
  });
}

/**
 * Resolve the model's raw reply across the trust boundary. An unparseable
 * response, an id outside the legal candidates, a timeout, or a thrown error
 * all land on the deterministic fallback with a diagnostic — never an
 * exception, never a new action (§19.3: new action text is ignored).
 */
export function resolveDeliberationOutcome(
  admission: DeliberatorAdmission,
  candidates: readonly DeliberationCandidate[],
  rawResponse: unknown,
): DeliberationOutcome {
  const fallbackId = admission.fallbackCandidateId ?? deterministicFallbackCandidate(candidates)?.id;
  if (fallbackId === undefined) throw new Error("Deliberation resolved with no candidates at all");
  const fallbackOutcome = (diagnostic: string): DeliberationOutcome =>
    deliberationOutcomeSchema.parse({
      chosenCandidateId: fallbackId,
      usedFallback: true,
      admissionReasonCode: admission.reasonCode,
      diagnostics: [diagnostic],
    });

  if (!admission.admitted) return fallbackOutcome(`not_admitted:${admission.reasonCode}`);
  if (rawResponse === "timeout") return fallbackOutcome("deliberator_timeout");
  const parsed = deliberatorResponseSchema.safeParse(rawResponse);
  if (!parsed.success) return fallbackOutcome("deliberator_response_unparseable");
  if (!candidates.some((candidate) => candidate.id === parsed.data.chosenCandidateId)) {
    return fallbackOutcome("deliberator_chose_unknown_candidate");
  }
  return deliberationOutcomeSchema.parse({
    chosenCandidateId: parsed.data.chosenCandidateId,
    usedFallback: false,
    admissionReasonCode: admission.reasonCode,
    ...(parsed.data.rationaleSummary === undefined
      ? {}
      : { rationaleSummary: parsed.data.rationaleSummary }),
    diagnostics: [],
  });
}

export interface RunDeliberationInput {
  admissionInput: DeliberatorAdmissionInput;
  evidence: readonly string[];
  /** The injected model seam. Never called unless admission passes. */
  deliberate: (request: DeliberatorRequest) => Promise<unknown>;
  /**
   * A promise that settles when the caller's deadline passes. Injected so the
   * kernel stays clock-free; the durable layer supplies a real timer.
   */
  timeout?: Promise<unknown>;
}

/**
 * The full seam: admit, ask (bounded), resolve (trust boundary), fall back
 * deterministically on refusal, timeout, error, or nonsense.
 */
export async function runDeliberation(input: RunDeliberationInput): Promise<DeliberationOutcome> {
  const admission = admitDeliberator(input.admissionInput);
  const candidates = input.admissionInput.candidates;
  if (!admission.admitted) return resolveDeliberationOutcome(admission, candidates, undefined);
  const request = buildDeliberatorRequest(candidates, input.evidence);
  try {
    const race =
      input.timeout === undefined
        ? input.deliberate(request)
        : Promise.race([
            input.deliberate(request),
            input.timeout.then(() => "timeout" as const),
          ]);
    return resolveDeliberationOutcome(admission, candidates, await race);
  } catch {
    return resolveDeliberationOutcome(admission, candidates, "timeout");
  }
}
