import { describe, expect, it } from "vitest";
import type { IdentityReferenceRole, IdentityReferenceStrategy } from "@/contracts/images/identity-pack";
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
  compareTrialCellKeys,
  IDENTITY_PACK_TRIAL_PROMPT_FIXTURES,
  pairTrialCells,
  trialPromptFixtureById,
  unblindTrialPairGrade,
  type TrialCellPlanInput,
  type TrialGradeRecord,
  type TrialPairableCell,
} from "./identity-pack-trial";

/** The variant key a `{ source: "revision" }` selector for char_1 rev 2 derives. */
const REV_KEY = "rev:char_1:2";

function planInput(overrides: Partial<TrialCellPlanInput> = {}): TrialCellPlanInput {
  return {
    characterIds: ["char_1"],
    profileIds: ["profile_1"],
    strategies: ["canonical_only"],
    promptFixtureIds: ["variant_wardrobe_v1"],
    ...overrides,
  };
}

/** The source hash every pack cell shares by default — the pack-variant axis
 * compares CROPS of one photograph, so two arms only differ here when a case is
 * deliberately about two different sources. */
const SOURCE_HASH = "a".repeat(64);

/**
 * What each strategy sends when the pack can supply every role it names,
 * mirroring `identityRolePlan` in `src/server/images/identity-pack-references.ts`
 * (restated because that module is server-side and these are pure tests).
 *
 * The fixture derives roles from the strategy so a case that varies the strategy
 * gets a genuinely different render by default — which is what the arms it is
 * asserting about are supposed to be. A case about a DEGENERATE arm overrides
 * the roles explicitly, and that override is the whole point of it.
 */
const ROLES_BY_STRATEGY: Record<IdentityReferenceStrategy, IdentityReferenceRole[]> = {
  canonical_only: ["canonical_identity"],
  face_detail_only: ["face_detail"],
  canonical_then_face_detail: ["canonical_identity", "face_detail"],
  face_detail_then_canonical: ["face_detail", "canonical_identity"],
};

function cell(id: string, overrides: Partial<TrialPairableCell> = {}): TrialPairableCell {
  const identityStrategy = overrides.identityStrategy === undefined ? "canonical_only" : overrides.identityStrategy;
  return {
    id,
    status: "rendered",
    characterId: "char_1",
    profileId: "profile_1",
    promptFixtureId: "variant_wardrobe_v1",
    task: "variant",
    identityStrategy,
    packVariantKey: "current",
    referenceSource: "pack",
    orderedReferenceRoles: identityStrategy === null ? [] : ROLES_BY_STRATEGY[identityStrategy],
    sourceContentHash: SOURCE_HASH,
    ...overrides,
  };
}

/** The no-pack baseline arm: no strategy, no references, its own variant key. */
function baselineCell(id: string, overrides: Partial<TrialPairableCell> = {}): TrialPairableCell {
  return cell(id, {
    identityStrategy: null,
    packVariantKey: "none",
    referenceSource: "none",
    orderedReferenceRoles: [],
    sourceContentHash: null,
    ...overrides,
  });
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

/** The comparison-group identity a cell key leads with. */
function groupPrefix(cellKey: string): string {
  return cellKey.split(":").slice(0, 3).join(":");
}

/** The sequence of groups a key list visits, collapsing consecutive repeats.
 * A group appearing twice in this list means its arms were NOT contiguous. */
function groupRuns(cellKeys: readonly string[]): string[] {
  const runs: string[] = [];
  for (const key of cellKeys) {
    const prefix = groupPrefix(key);
    if (runs[runs.length - 1] !== prefix) runs.push(prefix);
  }
  return runs;
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
    // character : profile : fixture : strategy : variant — the group prefix
    // leads, so every arm of one comparison lands together.
    expect(result.plans.map((plan) => plan.cellKey)).toEqual([
      "char_1:profile_1:fixture_a:canonical_only:current",
      "char_1:profile_1:fixture_a:canonical_then_face_detail:current",
      "char_1:profile_1:fixture_b:canonical_only:current",
      "char_1:profile_1:fixture_b:canonical_then_face_detail:current",
      "char_2:profile_1:fixture_a:canonical_only:current",
      "char_2:profile_1:fixture_a:canonical_then_face_detail:current",
      "char_2:profile_1:fixture_b:canonical_only:current",
      "char_2:profile_1:fixture_b:canonical_then_face_detail:current",
    ]);
  });

  it("defaults to a single `current` pack variant when none is named", () => {
    const result = buildTrialCellPlans(planInput());
    if (!result.ok) throw new Error("expected a plan");
    expect(result.plans).toHaveLength(1);
    expect(result.plans[0]).toMatchObject({
      packVariantKey: "current",
      packVariant: { source: "current" },
      identityStrategy: "canonical_only",
    });
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

  it("collapses variants by DERIVED KEY, not by object identity", () => {
    const result = buildTrialCellPlans(
      planInput({
        packVariants: [
          { source: "current" },
          { source: "current" },
          { source: "revision", characterId: "char_1", revision: 2 },
          { source: "revision", characterId: "char_1", revision: 2 },
        ],
      }),
    );
    if (!result.ok) throw new Error("expected a plan");
    expect(result.plans.map((plan) => plan.packVariantKey)).toEqual(["current", REV_KEY]);
    expect(result.plans.map((plan) => plan.cellKey)).toEqual([
      "char_1:profile_1:variant_wardrobe_v1:canonical_only:current",
      `char_1:profile_1:variant_wardrobe_v1:canonical_only:${REV_KEY}`,
    ]);
  });

  it("scopes a revision variant to its own character and plans nothing for the others", () => {
    const result = buildTrialCellPlans(
      planInput({
        characterIds: ["char_1", "char_2"],
        packVariants: [{ source: "current" }, { source: "revision", characterId: "char_1", revision: 2 }],
      }),
    );
    if (!result.ok) throw new Error("expected a plan");
    const byCharacter = new Map<string, string[]>();
    for (const plan of result.plans) {
      byCharacter.set(plan.characterId, [...(byCharacter.get(plan.characterId) ?? []), plan.packVariantKey]);
    }
    expect(byCharacter.get("char_1")).toEqual(["current", REV_KEY]);
    // char_2 has nothing to do with char_1's revision 2 — it simply gets no cell.
    expect(byCharacter.get("char_2")).toEqual(["current"]);
  });

  it("plans exactly ONE no-pack baseline cell per group, with a null strategy", () => {
    const result = buildTrialCellPlans(
      planInput({
        strategies: ["canonical_only", "face_detail_only"],
        packVariants: [{ source: "current" }, { source: "none" }],
      }),
    );
    if (!result.ok) throw new Error("expected a plan");
    expect(result.plans.map((plan) => plan.cellKey)).toEqual([
      "char_1:profile_1:variant_wardrobe_v1:canonical_only:current",
      "char_1:profile_1:variant_wardrobe_v1:face_detail_only:current",
      "char_1:profile_1:variant_wardrobe_v1:none:none",
    ]);
    const baseline = result.plans.filter((plan) => plan.identityStrategy === null);
    expect(baseline).toHaveLength(1);
    expect(baseline[0]).toMatchObject({ packVariantKey: "none", packVariant: { source: "none" } });
  });

  it("counts the cells actually generated against the cap, not an axis product", () => {
    // 95 characters × 1 current variant + one character's extra pinned revision
    // = 96. A naive characters × variants product would have said 190 and refused.
    const scoped = buildTrialCellPlans(
      planInput({
        characterIds: characters(TRIAL_MAX_CELLS - 1),
        packVariants: [{ source: "current" }, { source: "revision", characterId: "char_0", revision: 2 }],
      }),
    );
    if (!scoped.ok) throw new Error("expected the scoped run to plan");
    expect(scoped.plans).toHaveLength(TRIAL_MAX_CELLS);

    // The baseline DOES apply to every character, so it doubles the count.
    const withBaseline = buildTrialCellPlans(
      planInput({
        characterIds: characters(TRIAL_MAX_CELLS / 2),
        packVariants: [{ source: "current" }, { source: "none" }],
      }),
    );
    if (!withBaseline.ok) throw new Error("expected the baseline run to plan");
    expect(withBaseline.plans).toHaveLength(TRIAL_MAX_CELLS);

    const overCap = buildTrialCellPlans(
      planInput({
        characterIds: characters(TRIAL_MAX_CELLS / 2 + 1),
        packVariants: [{ source: "current" }, { source: "none" }],
      }),
    );
    if (overCap.ok) throw new Error("expected refusal");
    expect(overCap.requestedCells).toBe(TRIAL_MAX_CELLS + 2);
  });

  it("keeps every comparison group's arms contiguous — in plan order AND in cellKey order", () => {
    const result = buildTrialCellPlans({
      characterIds: ["char_2", "char_1"],
      profileIds: ["profile_1", "profile_2"],
      strategies: ["face_detail_only", "canonical_only"],
      promptFixtureIds: ["fixture_b", "fixture_a"],
      packVariants: [
        { source: "current" },
        { source: "revision", characterId: "char_1", revision: 2 },
        { source: "none" },
      ],
    });
    if (!result.ok) throw new Error("expected a plan");
    const planned = result.plans.map((plan) => plan.cellKey);
    const executed = [...planned].sort(compareTrialCellKeys);

    // 2 characters × 2 profiles × 2 fixtures = 8 groups, each visited exactly
    // once in both orderings: no group is interleaved with another.
    for (const order of [planned, executed]) {
      const runs = groupRuns(order);
      expect(runs).toHaveLength(8);
      expect(new Set(runs).size).toBe(runs.length);
    }
    // char_1 carries three arms per group (2 strategies × 2 variants + baseline
    // is 5); char_2 has no revision variant, so it carries 3.
    expect(planned.filter((key) => key.startsWith("char_1:profile_1:fixture_a:"))).toHaveLength(5);
    expect(planned.filter((key) => key.startsWith("char_2:profile_1:fixture_a:"))).toHaveLength(3);
  });
});

describe("pairing", () => {
  it("pairs only rendered cells, within one (character, fixture, profile) group", () => {
    const pairs = pairTrialCells([
      cell("a_canon"),
      cell("a_both", { identityStrategy: "canonical_then_face_detail" }),
      cell("a_failed", { identityStrategy: "face_detail_only", status: "failed" }),
      cell("a_refused", { identityStrategy: "face_detail_then_canonical", status: "refused" }),
      cell("a_running", { identityStrategy: "face_detail_only", status: "running" }),
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
    expect(pair.variantKeyA).toBe("current");
    expect(pair.variantKeyB).toBe("current");
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

  it("never pairs two cells that differ in BOTH strategy and pack variant", () => {
    const pairs = pairTrialCells([
      cell("x_canon_current"),
      cell("x_canon_rev", { packVariantKey: REV_KEY }),
      cell("x_face_rev", { identityStrategy: "face_detail_only", packVariantKey: REV_KEY }),
    ]);
    // Three cells, three unordered combinations — but the confounded one
    // (canonical/current vs face-detail/revision) is not a measurement.
    expect(pairs).toHaveLength(2);
    expect(
      pairs.map((pair) => [pair.strategyA, pair.variantKeyA, pair.strategyB, pair.variantKeyB]),
    ).toEqual([
      ["canonical_only", "current", "canonical_only", REV_KEY],
      ["canonical_only", REV_KEY, "face_detail_only", REV_KEY],
    ]);
    const confounded = pairs.some(
      (pair) => pair.strategyA !== pair.strategyB && pair.variantKeyA !== pair.variantKeyB,
    );
    expect(confounded).toBe(false);
  });

  it("pairs the same strategy across two pack variants", () => {
    const pairs = pairTrialCells([cell("v_current"), cell("v_revision", { packVariantKey: REV_KEY })]);
    expect(pairs).toHaveLength(1);
    expect(pairs[0]).toMatchObject({
      cellAId: "v_current",
      cellBId: "v_revision",
      strategyA: "canonical_only",
      strategyB: "canonical_only",
      variantKeyA: "current",
      variantKeyB: REV_KEY,
    });
  });

  it("pairs the no-pack baseline against every pack cell, always as side B", () => {
    const pairs = pairTrialCells([
      cell("n_canon"),
      cell("n_face", { identityStrategy: "face_detail_only" }),
      baselineCell("n_base"),
    ]);
    expect(pairs).toHaveLength(3);
    expect(pairs.map((pair) => [pair.cellAId, pair.cellBId])).toEqual([
      ["n_canon", "n_face"],
      ["n_canon", "n_base"],
      ["n_face", "n_base"],
    ]);
    // The baseline ranks after every real strategy, so it never displaces a
    // pack arm onto the B side.
    for (const pair of pairs) expect(pair.strategyA).not.toBeNull();
    const baselinePairs = pairs.filter((pair) => pair.variantKeyB === "none");
    expect(baselinePairs).toHaveLength(2);
    for (const pair of baselinePairs) expect(pair.strategyB).toBeNull();
  });

  it("never pairs two baselines with each other — they are the same arm", () => {
    expect(pairTrialCells([baselineCell("base_1"), baselineCell("base_2")])).toEqual([]);
  });

  it("refuses two strategies of one variant that evaluated to the SAME role list", () => {
    // A pack whose face crop is unusable makes `canonical_then_face_detail` send
    // exactly what `canonical_only` sends. The planner refuses to create such a
    // cell now; this is the guard for rows that already exist. Grading the pair
    // would report provider noise between two identical requests as an effect of
    // reference ordering.
    const degenerate = pairTrialCells([
      cell("d_canon"),
      cell("d_both", {
        identityStrategy: "canonical_then_face_detail",
        orderedReferenceRoles: ["canonical_identity"],
      }),
    ]);
    expect(degenerate).toEqual([]);

    // Both list ORDERS, because the two ordering strategies are the case the
    // guard must not swallow: same roles, different order, genuinely different
    // renders — and they still pair.
    const ordered = pairTrialCells([
      cell("o_forward", { identityStrategy: "canonical_then_face_detail" }),
      cell("o_reverse", { identityStrategy: "face_detail_then_canonical" }),
    ]);
    expect(ordered).toHaveLength(1);
    expect(ordered[0]).toMatchObject({
      strategyA: "canonical_then_face_detail",
      strategyB: "face_detail_then_canonical",
    });
  });

  it("refuses two pack variants derived from DIFFERENT source photographs", () => {
    // The variant axis compares crops of ONE photograph (heuristic vs manual,
    // old revision vs new). Two revisions off different sources are two different
    // pictures, and a grade on them measures the photography, not the derivation.
    const crossSource = pairTrialCells([
      cell("s_current"),
      cell("s_revision", { packVariantKey: REV_KEY, sourceContentHash: "b".repeat(64) }),
    ]);
    expect(crossSource).toEqual([]);

    // Same source, different crops — the comparison the axis exists for.
    const sameSource = pairTrialCells([cell("c_current"), cell("c_revision", { packVariantKey: REV_KEY })]);
    expect(sameSource).toHaveLength(1);
    expect(sameSource[0]).toMatchObject({ variantKeyA: "current", variantKeyB: REV_KEY });

    // The baseline is exempt: it has no source at all, and "references vs no
    // references" is the one comparison it can make.
    const againstBaseline = pairTrialCells([cell("b_pack"), baselineCell("b_base")]);
    expect(againstBaseline).toHaveLength(1);
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
    expect(comparison.variantKeyA).toBe("current");
    expect(comparison.variantKeyB).toBe("current");
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

  it("keeps the same two strategies in SEPARATE buckets when the pack variant differs", () => {
    const pairs = pairTrialCells([
      cell("v_canon_cur"),
      cell("v_canon_rev", { packVariantKey: REV_KEY }),
      cell("v_face_cur", { identityStrategy: "face_detail_only" }),
      cell("v_face_rev", { identityStrategy: "face_detail_only", packVariantKey: REV_KEY }),
    ]);
    expect(pairs).toHaveLength(4);
    const comparisons = aggregateTrialGrades(pairs, []);
    expect(
      comparisons.map((comparison) => [
        comparison.strategyA,
        comparison.variantKeyA,
        comparison.strategyB,
        comparison.variantKeyB,
      ]),
    ).toEqual([
      ["canonical_only", "current", "canonical_only", REV_KEY],
      ["canonical_only", "current", "face_detail_only", "current"],
      ["canonical_only", REV_KEY, "face_detail_only", REV_KEY],
      ["face_detail_only", "current", "face_detail_only", REV_KEY],
    ]);
    // canonical-vs-face-detail appears twice — once per pack revision. Folding
    // them together would average away the effect the variant axis measures.
    for (const comparison of comparisons) expect(comparison.totalPairs).toBe(1);
  });

  it("buckets a no-pack baseline comparison under a null strategy B", () => {
    const pairs = pairTrialCells([cell("z_canon"), baselineCell("z_base")]);
    const comparisons = aggregateTrialGrades(pairs, [gradeRecord("z_base:z_canon", { overall_preference: -2 })]);
    expect(comparisons).toHaveLength(1);
    expect(comparisons[0]).toMatchObject({
      strategyA: "canonical_only",
      variantKeyA: "current",
      strategyB: null,
      variantKeyB: "none",
      totalPairs: 1,
      gradedPairs: 1,
      overall: { winsA: 1, ties: 0, winsB: 0 },
    });
  });
});
