import { describe, expect, it } from "vitest";
import type { DeliberatorAdmissionInput } from "../contracts/deliberation";
import {
  admitDeliberator,
  buildDeliberatorRequest,
  resolveDeliberationOutcome,
  runDeliberation,
} from "./deliberation";

const CANDIDATES = [
  { id: "candidate-a", deterministicScoreFixedPoint: 500 },
  { id: "candidate-b", deterministicScoreFixedPoint: 450 },
];

function admissionInput(overrides: Partial<DeliberatorAdmissionInput> = {}): DeliberatorAdmissionInput {
  return {
    actorId: "mara",
    inferenceLod: "deliberator",
    candidates: CANDIDATES,
    scoreGapThresholdFixedPoint: 100,
    consequential: true,
    modelBudgetRemaining: 3,
    hasDeterministicFallback: true,
    ...overrides,
  };
}

describe("E4.3 admitDeliberator gates", () => {
  it("admits only when every gate passes, naming the first failure otherwise", () => {
    expect(admitDeliberator(admissionInput())).toMatchObject({
      admitted: true,
      reasonCode: "admitted",
      fallbackCandidateId: "candidate-a",
    });
    expect(admitDeliberator(admissionInput({ inferenceLod: "small_model" })).reasonCode).toBe("lod_too_low");
    expect(
      admitDeliberator(admissionInput({ candidates: CANDIDATES.slice(0, 1) })).reasonCode,
    ).toBe("insufficient_candidates");
    expect(
      admitDeliberator(admissionInput({ scoreGapThresholdFixedPoint: 50 })).reasonCode,
    ).toBe("score_gap_decisive");
    expect(admitDeliberator(admissionInput({ consequential: false })).reasonCode).toBe("not_consequential");
    expect(admitDeliberator(admissionInput({ modelBudgetRemaining: 0 })).reasonCode).toBe("no_model_budget");
    expect(
      admitDeliberator(admissionInput({ hasDeterministicFallback: false })).reasonCode,
    ).toBe("no_deterministic_fallback");
  });

  it("builds a bounded, opaque request — ids and evidence, nothing else", () => {
    const request = buildDeliberatorRequest(CANDIDATES, ["mara owes rent", "the shop closes soon"]);
    expect(request).toEqual({
      candidateIds: ["candidate-a", "candidate-b"],
      evidence: ["mara owes rent", "the shop closes soon"],
    });
  });
});

describe("E4.3 resolveDeliberationOutcome (trust boundary)", () => {
  const admission = admitDeliberator(admissionInput());

  it("accepts a legal pick, keeps the rationale, and ignores invented fields", () => {
    const outcome = resolveDeliberationOutcome(admission, CANDIDATES, {
      chosenCandidateId: "candidate-b",
      rationaleSummary: "the rent matters more",
      newAction: "mara robs the till",
    });
    expect(outcome).toMatchObject({
      chosenCandidateId: "candidate-b",
      usedFallback: false,
      rationaleSummary: "the rent matters more",
    });
    expect("newAction" in outcome).toBe(false);
  });

  it("falls back deterministically on refusal, timeout, nonsense, and unknown ids", () => {
    const refused = admitDeliberator(admissionInput({ consequential: false }));
    expect(resolveDeliberationOutcome(refused, CANDIDATES, undefined)).toMatchObject({
      chosenCandidateId: "candidate-a",
      usedFallback: true,
      diagnostics: ["not_admitted:not_consequential"],
    });
    expect(resolveDeliberationOutcome(admission, CANDIDATES, "timeout").diagnostics).toEqual([
      "deliberator_timeout",
    ]);
    expect(resolveDeliberationOutcome(admission, CANDIDATES, { nonsense: true }).diagnostics).toEqual([
      "deliberator_response_unparseable",
    ]);
    expect(
      resolveDeliberationOutcome(admission, CANDIDATES, { chosenCandidateId: "candidate-invented" })
        .diagnostics,
    ).toEqual(["deliberator_chose_unknown_candidate"]);
  });
});

describe("E4.3 runDeliberation (stubbed seam — zero live calls)", () => {
  it("asks the injected deliberator only when admitted, and uses its legal pick", async () => {
    let asked = 0;
    const outcome = await runDeliberation({
      admissionInput: admissionInput(),
      evidence: ["the rent is due"],
      deliberate: (request) => {
        asked += 1;
        expect(request.candidateIds).toEqual(["candidate-a", "candidate-b"]);
        return Promise.resolve({ chosenCandidateId: "candidate-b" });
      },
    });
    expect(asked).toBe(1);
    expect(outcome.chosenCandidateId).toBe("candidate-b");

    let askedWhenRefused = 0;
    const refused = await runDeliberation({
      admissionInput: admissionInput({ modelBudgetRemaining: 0 }),
      evidence: [],
      deliberate: () => {
        askedWhenRefused += 1;
        return Promise.resolve({ chosenCandidateId: "candidate-b" });
      },
    });
    expect(askedWhenRefused).toBe(0);
    expect(refused).toMatchObject({ chosenCandidateId: "candidate-a", usedFallback: true });
  });

  it("lands on the deterministic fallback when the model hangs or throws", async () => {
    const timedOut = await runDeliberation({
      admissionInput: admissionInput(),
      evidence: [],
      deliberate: () => new Promise(() => undefined),
      timeout: Promise.resolve("deadline"),
    });
    expect(timedOut).toMatchObject({
      chosenCandidateId: "candidate-a",
      usedFallback: true,
      diagnostics: ["deliberator_timeout"],
    });

    const threw = await runDeliberation({
      admissionInput: admissionInput(),
      evidence: [],
      deliberate: () => Promise.reject(new Error("model exploded")),
    });
    expect(threw).toMatchObject({ chosenCandidateId: "candidate-a", usedFallback: true });
  });
});
