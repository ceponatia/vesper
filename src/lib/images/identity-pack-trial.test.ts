import { describe, expect, it } from "vitest";
import {
  perTrialGradeDimension,
  TRIAL_MAX_CELLS,
  trialGradeDimensions,
  trialPairGradesSchema,
  type TrialPairGrade,
  type TrialPairGrades,
} from "@/contracts/images/identity-pack-trial";
import { imageIdentityCriticalTasks } from "@/contracts/images/image-model-profiles";
import {
  aggregateTrialGrades,
  buildTrialCellPlans,
  IDENTITY_PACK_TRIAL_PROMPT_FIXTURES,
  pairTrialCells,
  trialPromptFixtureById,
  unblindTrialPairGrade,
  type TrialCellPlanInput,
  type TrialGradeRecord,
  type TrialPairableCell,
} from "./identity-pack-trial";

function planInput(overrides: Partial<TrialCellPlanInput> = {}): TrialCellPlanInput {
  return {
    characterIds: ["char_1"],
    profileIds: ["profile_1"],
    strategies: ["canonical_only"],
    promptFixtureIds: ["variant_wardrobe_v1"],
    ...overrides,
  };
}

function cell(id: string, overrides: Partial<TrialPairableCell> = {}): TrialPairableCell {
  return {
    id,
    status: "rendered",
    characterId: "char_1",
    profileId: "profile_1",
    promptFixtureId: "variant_wardrobe_v1",
    task: "variant",
    identityStrategy: "canonical_only",
    ...overrides,
  };
}

function gradesFixture(overrides: Partial<TrialPairGrades> = {}): TrialPairGrades {
  return { ...perTrialGradeDimension(() => 0), ...overrides };
}

function gradeRecord(
  pairId: string,
  overrides: Partial<TrialPairGrades>,
  extra: Partial<Omit<TrialPairGrade, "grades">> = {},
): TrialGradeRecord {
  return {
    pairId,
    grade: {
      grades: gradesFixture(overrides),
      catastrophicA: [],
      catastrophicB: [],
      notes: null,
      ...extra,
    },
  };
}

describe("prompt fixtures", () => {
  it("has globally unique ids", () => {
    const ids = IDENTITY_PACK_TRIAL_PROMPT_FIXTURES.map((fixture) => fixture.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("covers each identity-critical task with exactly two non-empty fixtures", () => {
    const perTask = new Map<string, number>();
    for (const fixture of IDENTITY_PACK_TRIAL_PROMPT_FIXTURES) {
      expect(fixture.prompt.length).toBeGreaterThan(0);
      perTask.set(fixture.task, (perTask.get(fixture.task) ?? 0) + 1);
    }
    for (const task of imageIdentityCriticalTasks) expect(perTask.get(task)).toBe(2);
    expect(IDENTITY_PACK_TRIAL_PROMPT_FIXTURES).toHaveLength(2 * imageIdentityCriticalTasks.length);
  });

  it("resolves a fixture by id and answers null for an unknown id", () => {
    expect(trialPromptFixtureById("variant_wardrobe_v1")?.task).toBe("variant");
    expect(trialPromptFixtureById("no_such_fixture")).toBeNull();
  });
});

describe("grade dimensions", () => {
  it("keeps the dimension tuple and the grade schema keys in exact agreement", () => {
    expect(Object.keys(trialPairGradesSchema.shape).sort()).toEqual([...trialGradeDimensions].sort());
  });

  it("fails parse when any dimension is missing — an ungraded axis is not a tie", () => {
    const complete: Record<string, number> = { ...gradesFixture() };
    expect(trialPairGradesSchema.safeParse(complete).success).toBe(true);
    for (const dimension of trialGradeDimensions) {
      const partial = Object.fromEntries(
        Object.entries(complete).filter(([key]) => key !== dimension),
      );
      expect(trialPairGradesSchema.safeParse(partial).success).toBe(false);
    }
  });

  it("rejects out-of-scale and fractional values", () => {
    expect(trialPairGradesSchema.safeParse({ ...gradesFixture(), identity_likeness: 3 }).success).toBe(false);
    expect(trialPairGradesSchema.safeParse({ ...gradesFixture(), hair: 0.5 }).success).toBe(false);
  });
});

describe("cell planning", () => {
  const characters = (count: number): string[] =>
    Array.from({ length: count }, (_, index) => `char_${index}`);

  it("expands the full cartesian product in deterministic nesting order", () => {
    const result = buildTrialCellPlans(
      planInput({
        characterIds: ["char_1", "char_2"],
        strategies: ["canonical_only", "canonical_then_face_detail"],
        promptFixtureIds: ["fixture_a", "fixture_b"],
      }),
    );
    if (!result.ok) throw new Error("expected a plan");
    expect(result.plans.map((plan) => plan.cellKey)).toEqual([
      "char_1:profile_1:canonical_only:fixture_a",
      "char_1:profile_1:canonical_only:fixture_b",
      "char_1:profile_1:canonical_then_face_detail:fixture_a",
      "char_1:profile_1:canonical_then_face_detail:fixture_b",
      "char_2:profile_1:canonical_only:fixture_a",
      "char_2:profile_1:canonical_only:fixture_b",
      "char_2:profile_1:canonical_then_face_detail:fixture_a",
      "char_2:profile_1:canonical_then_face_detail:fixture_b",
    ]);
  });

  it("plans exactly the cap, and refuses one cell past it with a typed refusal", () => {
    const atCap = buildTrialCellPlans(planInput({ characterIds: characters(TRIAL_MAX_CELLS) }));
    if (!atCap.ok) throw new Error("expected the boundary run to plan");
    expect(atCap.plans).toHaveLength(TRIAL_MAX_CELLS);

    const overCap = buildTrialCellPlans(planInput({ characterIds: characters(TRIAL_MAX_CELLS + 1) }));
    if (overCap.ok) throw new Error("expected refusal");
    expect(overCap.code).toBe("too_many_cells");
    expect(overCap.requestedCells).toBe(TRIAL_MAX_CELLS + 1);
    expect(overCap.maximumCells).toBe(TRIAL_MAX_CELLS);
  });

  it("collapses duplicate axis entries into one cell each", () => {
    const result = buildTrialCellPlans({
      characterIds: ["char_1", "char_2", "char_1"],
      profileIds: ["profile_1", "profile_1"],
      strategies: ["canonical_only", "canonical_only"],
      promptFixtureIds: ["fixture_a", "fixture_b", "fixture_a"],
    });
    if (!result.ok) throw new Error("expected a plan");
    const keys = result.plans.map((plan) => plan.cellKey);
    expect(keys).toHaveLength(4);
    expect(new Set(keys).size).toBe(4);
  });

  it("checks the cap against the deduped product, so a pasted-twice id cannot refuse a fitting run", () => {
    const withDuplicate = [...characters(TRIAL_MAX_CELLS), "char_0"];
    const result = buildTrialCellPlans(planInput({ characterIds: withDuplicate }));
    if (!result.ok) throw new Error("expected a plan");
    expect(result.plans).toHaveLength(TRIAL_MAX_CELLS);
  });
});

describe("pairing", () => {
  it("pairs only rendered cells, within one (character, fixture, profile) group", () => {
    const pairs = pairTrialCells([
      cell("a_canon"),
      cell("a_both", { identityStrategy: "canonical_then_face_detail" }),
      cell("a_failed", { identityStrategy: "face_detail_only", status: "failed" }),
      cell("a_refused", { identityStrategy: "face_detail_then_canonical", status: "refused" }),
      cell("a_planned", { promptFixtureId: "variant_pose_v1", status: "planned" }),
      cell("b_alone", { characterId: "char_2" }),
      cell("p2_alone", { profileId: "profile_2", identityStrategy: "canonical_then_face_detail" }),
    ]);
    expect(pairs).toHaveLength(1);
    const pair = pairs[0];
    if (!pair) throw new Error("expected a pair");
    expect(pair.cellAId).toBe("a_canon");
    expect(pair.cellBId).toBe("a_both");
    expect(pair.strategyA).toBe("canonical_only");
    expect(pair.strategyB).toBe("canonical_then_face_detail");
  });

  it("assigns A/B by canonical strategy order, and the pair id by sorted cell ids", () => {
    const pairs = pairTrialCells([
      cell("z_late_id", { identityStrategy: "canonical_only" }),
      cell("a_early_id", { identityStrategy: "face_detail_only" }),
    ]);
    const pair = pairs[0];
    if (!pair) throw new Error("expected a pair");
    // A is the vocabulary-earlier strategy even though its cell id sorts later…
    expect(pair.cellAId).toBe("z_late_id");
    expect(pair.strategyA).toBe("canonical_only");
    expect(pair.cellBId).toBe("a_early_id");
    expect(pair.strategyB).toBe("face_detail_only");
    // …while the pair id stays the id-sorted join, stable either way round.
    expect(pair.pairId).toBe("a_early_id:z_late_id");
  });

  it("is order-independent: a shuffled input yields the identical sorted pair list", () => {
    const cells = [
      cell("a_canon"),
      cell("a_face", { identityStrategy: "face_detail_only" }),
      cell("a_both", { identityStrategy: "canonical_then_face_detail" }),
      cell("b_canon", { characterId: "char_2" }),
      cell("b_both", { characterId: "char_2", identityStrategy: "canonical_then_face_detail" }),
      cell("noise_failed", { characterId: "char_2", identityStrategy: "face_detail_only", status: "failed" }),
    ];
    const forward = pairTrialCells(cells);
    const reversed = pairTrialCells([...cells].reverse());
    expect(forward).toHaveLength(4);
    expect(reversed).toEqual(forward);
    expect(forward.map((pair) => pair.pairId)).toEqual([
      "a_canon:a_face",
      "a_both:a_canon",
      "a_both:a_face",
      "b_both:b_canon",
    ]);
    const pairedIds = new Set(forward.flatMap((pair) => [pair.cellAId, pair.cellBId]));
    expect(pairedIds.has("noise_failed")).toBe(false);
  });
});

describe("unblinding", () => {
  const submission = {
    grades: gradesFixture({ identity_likeness: 2, overall_preference: -1 }),
    catastrophicLeft: ["left defect"],
    catastrophicRight: ["right defect"],
    notes: "close call",
  };

  it("passes a left-is-A submission through, copying the defect lists", () => {
    const grade = unblindTrialPairGrade(submission, true);
    expect(grade.grades).toEqual(submission.grades);
    expect(grade.catastrophicA).toEqual(["left defect"]);
    expect(grade.catastrophicB).toEqual(["right defect"]);
    expect(grade.notes).toBe("close call");
    expect(grade.catastrophicA).not.toBe(submission.catastrophicLeft);
  });

  it("flips signs and swaps sides when the left image was B", () => {
    const grade = unblindTrialPairGrade(submission, false);
    expect(grade.grades.identity_likeness).toBe(-2);
    expect(grade.grades.overall_preference).toBe(1);
    // A tie stays exactly +0 through the flip, never -0.
    expect(Object.is(grade.grades.hair, 0)).toBe(true);
    expect(grade.catastrophicA).toEqual(["right defect"]);
    expect(grade.catastrophicB).toEqual(["left defect"]);
  });
});

describe("aggregation", () => {
  const comparisonCells = (): TrialPairableCell[] =>
    ["char_1", "char_2", "char_3", "char_4"].flatMap((characterId, index) => [
      cell(`c${index + 1}_canon`, { characterId }),
      cell(`c${index + 1}_both`, { characterId, identityStrategy: "canonical_then_face_detail" }),
    ]);

  it("matches a hand-computed example: means, counts, wins, and catastrophic totals", () => {
    const pairs = pairTrialCells(comparisonCells());
    expect(pairs).toHaveLength(4);
    const records: TrialGradeRecord[] = [
      gradeRecord("c1_both:c1_canon", { identity_likeness: 2, edit_fidelity: 1, overall_preference: 1 }),
      gradeRecord(
        "c2_both:c2_canon",
        { identity_likeness: 1, edit_fidelity: 1, overall_preference: -2 },
        { catastrophicB: ["changed outfit", "second person"] },
      ),
      gradeRecord("c3_both:c3_canon", { edit_fidelity: 2 }, { catastrophicA: ["extra limb"] }),
    ];
    const comparisons = aggregateTrialGrades(pairs, records);
    expect(comparisons).toHaveLength(1);
    const comparison = comparisons[0];
    if (!comparison) throw new Error("expected a comparison");
    expect(comparison.profileId).toBe("profile_1");
    expect(comparison.strategyA).toBe("canonical_only");
    expect(comparison.strategyB).toBe("canonical_then_face_detail");
    expect(comparison.totalPairs).toBe(4);
    expect(comparison.gradedPairs).toBe(3);
    // (2 + 1 + 0) / 3 = 1; (1 + 1 + 2) / 3 rounds to 1.33; (1 - 2 + 0) / 3 to -0.33.
    expect(comparison.dimensions.identity_likeness).toEqual({ mean: 1, count: 3 });
    expect(comparison.dimensions.edit_fidelity).toEqual({ mean: 1.33, count: 3 });
    expect(comparison.dimensions.overall_preference).toEqual({ mean: -0.33, count: 3 });
    expect(comparison.dimensions.hair).toEqual({ mean: 0, count: 3 });
    expect(comparison.overall).toEqual({ winsA: 1, ties: 1, winsB: 1 });
    expect(comparison.catastrophic).toEqual({ a: 1, b: 2 });
  });

  it("reports null means for an ungraded comparison, and ignores a grade with no pair", () => {
    const pairs = pairTrialCells([
      cell("x_canon"),
      cell("x_both", { identityStrategy: "canonical_then_face_detail" }),
    ]);
    const comparisons = aggregateTrialGrades(pairs, [
      gradeRecord("ghost:pair", { overall_preference: 2 }),
    ]);
    expect(comparisons).toHaveLength(1);
    const comparison = comparisons[0];
    if (!comparison) throw new Error("expected a comparison");
    expect(comparison.totalPairs).toBe(1);
    expect(comparison.gradedPairs).toBe(0);
    expect(comparison.dimensions.identity_likeness).toEqual({ mean: null, count: 0 });
    expect(comparison.overall).toEqual({ winsA: 0, ties: 0, winsB: 0 });
  });

  it("buckets by profile and canonical strategy pair, sorted deterministically", () => {
    const pairs = pairTrialCells([
      cell("p1_canon"),
      cell("p1_face", { identityStrategy: "face_detail_only" }),
      cell("p2_canon", { profileId: "profile_2" }),
      cell("p2_both", { profileId: "profile_2", identityStrategy: "canonical_then_face_detail" }),
    ]);
    const comparisons = aggregateTrialGrades(pairs, []);
    expect(
      comparisons.map((comparison) => [comparison.profileId, comparison.strategyA, comparison.strategyB]),
    ).toEqual([
      ["profile_1", "canonical_only", "face_detail_only"],
      ["profile_2", "canonical_only", "canonical_then_face_detail"],
    ]);
  });
});
