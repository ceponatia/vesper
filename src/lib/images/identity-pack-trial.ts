import {
  identityReferenceStrategies,
  type IdentityReferenceStrategy,
} from "@/contracts/images/identity-pack";
import {
  perTrialGradeDimension,
  TRIAL_MAX_CELLS,
  type ImageIdentityPackTrialGradeRequest,
  type ImageIdentityPackTrialRefusalCode,
  type TrialCellStatus,
  type TrialDimensionAggregate,
  type TrialPairGrade,
  type TrialStrategyComparison,
} from "@/contracts/images/identity-pack-trial";
import type { ImageProfileTask } from "@/contracts/images/image-model-profiles";

/**
 * Pure identity-pack trial logic
 * (docs/developer-notes/image-identity-packs.spec.trial.md): the checked-in
 * prompt fixtures, the cartesian cell planner, the deterministic pairing rule,
 * and the grade aggregation the summary surface reports.
 *
 * Everything here is plain data in and plain data out — no persistence, no
 * randomness, no clock. Determinism is a product property, not a style choice:
 * the same run configuration must plan the same cells, the same rendered cells
 * must produce the same pairs in the same order, and the same grades must
 * aggregate to the same numbers, or a rerun stops being evidence. The one
 * genuinely random ingredient — which side of a blinded pair the reviewer sees
 * on the left — belongs to the server, which persists its `leftIsA` choice and
 * hands it back to `unblindTrialPairGrade` here.
 */

/**
 * One fixed instruction prompt. Deliberately character-agnostic ("the subject"):
 * the identity has to come from the reference images under test, because a
 * prompt that names or describes the character would smuggle identity through
 * text and contaminate exactly the comparison the trial exists to make.
 */
export interface IdentityPackTrialPromptFixture {
  id: string;
  task: ImageProfileTask;
  prompt: string;
  negativePrompt: string | null;
}

/**
 * The checked-in fixture set: two per identity-critical task, spanning the
 * drift axes the review grades (wardrobe, pose, setting, framing, lighting).
 * Fixture ids are versioned (`_v1`) because the prompt text is part of a cell's
 * identity — rewording one is a NEW fixture, never an edit, or old and new
 * cells would claim to be the same comparison.
 */
export const IDENTITY_PACK_TRIAL_PROMPT_FIXTURES: readonly IdentityPackTrialPromptFixture[] = [
  {
    id: "variant_wardrobe_v1",
    task: "variant",
    prompt:
      "Change the subject's outfit to a charcoal three-piece suit with a crisp white dress shirt and no tie. Keep the face, hair, pose, framing, lighting, and background exactly as in the reference.",
    negativePrompt: null,
  },
  {
    id: "variant_pose_v1",
    task: "variant",
    prompt:
      "Turn the subject to a relaxed three-quarter stance with arms loosely crossed. Keep the outfit, framing, lighting, and background exactly as in the reference.",
    negativePrompt: null,
  },
  {
    id: "scene_cafe_waist_up_v1",
    task: "scene",
    prompt:
      "A waist-up shot of the subject seated at a small marble table in a sunlit corner cafe, holding a white ceramic cup. Soft morning light from a window to the left, with a blurred pastry counter in the background.",
    negativePrompt: null,
  },
  {
    id: "scene_park_full_body_v1",
    task: "scene",
    prompt:
      "A full-body shot of the subject standing on a gravel path in an autumn park, hands in coat pockets, fallen leaves at their feet. Overcast afternoon light, loose composition with the subject about half the frame height.",
    negativePrompt: null,
  },
  {
    id: "chat_look_close_portrait_v1",
    task: "chat_look",
    prompt:
      "A close head-and-shoulders portrait of the subject facing the camera directly with a neutral expression. Keep the lighting identical to the reference, against a plain dark backdrop.",
    negativePrompt: null,
  },
  {
    id: "chat_look_library_v1",
    task: "chat_look",
    prompt:
      "The subject standing between tall wooden shelves in a dim private library, lit warmly by a single green-shaded desk lamp. Keep the outfit and hair exactly as in the reference.",
    negativePrompt: null,
  },
];

/** The fixture behind an id, or null — an unknown id is the caller's
 * `fixture_unknown` refusal, not an exception. */
export function trialPromptFixtureById(id: string): IdentityPackTrialPromptFixture | null {
  return IDENTITY_PACK_TRIAL_PROMPT_FIXTURES.find((fixture) => fixture.id === id) ?? null;
}

export interface TrialCellPlanInput {
  characterIds: readonly string[];
  profileIds: readonly string[];
  strategies: readonly IdentityReferenceStrategy[];
  promptFixtureIds: readonly string[];
}

/** One planned comparison cell, before any pack/profile resolution has run. */
export interface TrialCellPlan {
  /** Deterministic identity within a run — the unique-key the cells table enforces. */
  cellKey: string;
  characterId: string;
  profileId: string;
  identityStrategy: IdentityReferenceStrategy;
  promptFixtureId: string;
}

export type BuildTrialCellPlansResult =
  | { ok: true; plans: TrialCellPlan[] }
  | {
      ok: false;
      code: Extract<ImageIdentityPackTrialRefusalCode, "too_many_cells">;
      requestedCells: number;
      maximumCells: number;
    };

/**
 * Expand a run configuration into its full cartesian cell set
 * (characters × profiles × strategies × fixtures).
 *
 * Duplicate entries on any axis are collapsed BEFORE the cap is checked, so a
 * pasted-twice character id neither doubles the spend nor refuses a run that
 * genuinely fits. Axes keep their first-seen order — the owner's ordering is
 * how the run reads back in the UI — which with the fixed loop nesting makes
 * the plan list deterministic for a given configuration.
 *
 * Over `TRIAL_MAX_CELLS` the answer is a typed refusal, never a trimmed plan: a
 * silently dropped corner of the product would leave the reviewer believing a
 * comparison ran that never existed.
 */
export function buildTrialCellPlans(input: TrialCellPlanInput): BuildTrialCellPlansResult {
  const characterIds = dedupe(input.characterIds);
  const profileIds = dedupe(input.profileIds);
  const strategies = dedupe(input.strategies);
  const promptFixtureIds = dedupe(input.promptFixtureIds);
  const requestedCells =
    characterIds.length * profileIds.length * strategies.length * promptFixtureIds.length;
  if (requestedCells > TRIAL_MAX_CELLS) {
    return { ok: false, code: "too_many_cells", requestedCells, maximumCells: TRIAL_MAX_CELLS };
  }
  const plans: TrialCellPlan[] = [];
  for (const characterId of characterIds) {
    for (const profileId of profileIds) {
      for (const identityStrategy of strategies) {
        for (const promptFixtureId of promptFixtureIds) {
          plans.push({
            cellKey: `${characterId}:${profileId}:${identityStrategy}:${promptFixtureId}`,
            characterId,
            profileId,
            identityStrategy,
            promptFixtureId,
          });
        }
      }
    }
  }
  return { ok: true, plans };
}

/** The slice of a stored cell the pairing rule reads — ids and grouping fields,
 * no result payloads. */
export interface TrialPairableCell {
  id: string;
  status: TrialCellStatus;
  characterId: string;
  profileId: string;
  promptFixtureId: string;
  task: ImageProfileTask;
  identityStrategy: IdentityReferenceStrategy;
}

/**
 * One reviewable pair. A and B are CANONICAL, not presentation: A is always the
 * strategy earlier in `identityReferenceStrategies` order, so every pair of the
 * same two strategies aggregates into the same comparison bucket instead of
 * splitting across (A vs B) and (B vs A). Which cell the reviewer sees on the
 * left is the server's separately-persisted blind mapping.
 */
export interface TrialCellPair {
  /** The two cell ids, lexicographically sorted and joined — stable whatever
   * order the cells arrived in. */
  pairId: string;
  characterId: string;
  profileId: string;
  promptFixtureId: string;
  task: ImageProfileTask;
  cellAId: string;
  cellBId: string;
  strategyA: IdentityReferenceStrategy;
  strategyB: IdentityReferenceStrategy;
}

/**
 * Every strategy-vs-strategy pair the rendered cells support: cells grouped by
 * (character, fixture, profile) — the axes a comparison must hold constant —
 * then all unordered pairs of DIFFERENT strategies within each group.
 *
 * Only `rendered` cells pair: a failed or refused cell has no image to review,
 * and pairing it would put a hole in the blinded queue. Two cells carrying the
 * same strategy (impossible under the unique cell key, but not this function's
 * invariant to assume) are skipped rather than compared to themselves. The
 * output order is fully sorted, so shuffling the input cannot move a pair.
 */
export function pairTrialCells(cells: readonly TrialPairableCell[]): TrialCellPair[] {
  const groups = new Map<string, TrialPairableCell[]>();
  for (const cell of cells) {
    if (cell.status !== "rendered") continue;
    const groupKey = `${cell.characterId}:${cell.promptFixtureId}:${cell.profileId}`;
    const group = groups.get(groupKey);
    if (group) group.push(cell);
    else groups.set(groupKey, [cell]);
  }
  const pairs: TrialCellPair[] = [];
  for (const group of groups.values()) {
    const ordered = [...group].sort(compareCellsByStrategyThenId);
    for (let first = 0; first < ordered.length; first += 1) {
      for (let second = first + 1; second < ordered.length; second += 1) {
        const cellA = ordered[first];
        const cellB = ordered[second];
        if (!cellA || !cellB) continue;
        if (cellA.identityStrategy === cellB.identityStrategy) continue;
        pairs.push({
          pairId: [cellA.id, cellB.id].sort().join(":"),
          characterId: cellA.characterId,
          profileId: cellA.profileId,
          promptFixtureId: cellA.promptFixtureId,
          task: cellA.task,
          cellAId: cellA.id,
          cellBId: cellB.id,
          strategyA: cellA.identityStrategy,
          strategyB: cellB.identityStrategy,
        });
      }
    }
  }
  return pairs.sort(compareTrialPairs);
}

/**
 * Flip a blinded LEFT/RIGHT submission into canonical A/B space using the
 * server's persisted mapping. When the left image was A the submission already
 * IS A/B; otherwise every ordinal sign flips and the catastrophic lists swap.
 * The lists are copied so the stored grade never aliases the request body.
 */
export function unblindTrialPairGrade(
  submission: Omit<ImageIdentityPackTrialGradeRequest, "pairId">,
  leftIsA: boolean,
): TrialPairGrade {
  return {
    grades: perTrialGradeDimension((dimension) =>
      leftIsA ? submission.grades[dimension] : flipPreference(submission.grades[dimension]),
    ),
    catastrophicA: [...(leftIsA ? submission.catastrophicLeft : submission.catastrophicRight)],
    catastrophicB: [...(leftIsA ? submission.catastrophicRight : submission.catastrophicLeft)],
    notes: submission.notes,
  };
}

/** One stored grade, already unblinded into the A/B space its pair defines. */
export interface TrialGradeRecord {
  pairId: string;
  grade: TrialPairGrade;
}

/**
 * Aggregate unblinded grades per (profile, strategy A, strategy B).
 *
 * Every pair contributes to its bucket's `totalPairs` whether graded or not, so
 * the summary can show "2 of 6 graded" instead of a mean floating free of its
 * sample size. Means are rounded to two decimals and null when nothing was
 * graded; wins, ties, and losses come from the sign of `overall_preference`;
 * catastrophic counts are total recorded defect labels per side. A grade whose
 * pair is not in `pairs` has nothing to aggregate under and is ignored; a
 * duplicate grade for one pair keeps the first record (the persistence layer's
 * unique key makes this unreachable, but a pure function still answers
 * deterministically).
 */
export function aggregateTrialGrades(
  pairs: readonly TrialCellPair[],
  grades: readonly TrialGradeRecord[],
): TrialStrategyComparison[] {
  const gradesByPairId = new Map<string, TrialPairGrade>();
  for (const record of grades) {
    if (!gradesByPairId.has(record.pairId)) gradesByPairId.set(record.pairId, record.grade);
  }

  interface ComparisonAccumulator {
    profileId: string;
    strategyA: IdentityReferenceStrategy;
    strategyB: IdentityReferenceStrategy;
    totalPairs: number;
    grades: TrialPairGrade[];
  }
  const buckets = new Map<string, ComparisonAccumulator>();
  for (const pair of pairs) {
    const bucketKey = `${pair.profileId}:${pair.strategyA}:${pair.strategyB}`;
    let bucket = buckets.get(bucketKey);
    if (!bucket) {
      bucket = {
        profileId: pair.profileId,
        strategyA: pair.strategyA,
        strategyB: pair.strategyB,
        totalPairs: 0,
        grades: [],
      };
      buckets.set(bucketKey, bucket);
    }
    bucket.totalPairs += 1;
    const grade = gradesByPairId.get(pair.pairId);
    if (grade) bucket.grades.push(grade);
  }

  const comparisons: TrialStrategyComparison[] = [];
  for (const bucket of buckets.values()) {
    let winsA = 0;
    let ties = 0;
    let winsB = 0;
    let catastrophicA = 0;
    let catastrophicB = 0;
    for (const grade of bucket.grades) {
      const overall = grade.grades.overall_preference;
      if (overall < 0) winsA += 1;
      else if (overall > 0) winsB += 1;
      else ties += 1;
      catastrophicA += grade.catastrophicA.length;
      catastrophicB += grade.catastrophicB.length;
    }
    comparisons.push({
      profileId: bucket.profileId,
      strategyA: bucket.strategyA,
      strategyB: bucket.strategyB,
      totalPairs: bucket.totalPairs,
      gradedPairs: bucket.grades.length,
      dimensions: perTrialGradeDimension((dimension) =>
        dimensionAggregate(bucket.grades.map((grade) => grade.grades[dimension])),
      ),
      overall: { winsA, ties, winsB },
      catastrophic: { a: catastrophicA, b: catastrophicB },
    });
  }
  return comparisons.sort(compareComparisons);
}

function dedupe<T>(values: readonly T[]): T[] {
  return [...new Set(values)];
}

/** -0 would survive a sign flip of 0 and read as a different value in strict
 * comparisons; a tie stays exactly 0. */
function flipPreference(value: number): number {
  return value === 0 ? 0 : -value;
}

function dimensionAggregate(values: readonly number[]): TrialDimensionAggregate {
  if (values.length === 0) return { mean: null, count: 0 };
  let total = 0;
  for (const value of values) total += value;
  const rounded = Math.round((total / values.length) * 100) / 100;
  return { mean: rounded === 0 ? 0 : rounded, count: values.length };
}

const strategyRank = new Map<IdentityReferenceStrategy, number>(
  identityReferenceStrategies.map((strategy, index): [IdentityReferenceStrategy, number] => [strategy, index]),
);

function rankOfStrategy(strategy: IdentityReferenceStrategy): number {
  return strategyRank.get(strategy) ?? identityReferenceStrategies.length;
}

function compareStrings(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function compareCellsByStrategyThenId(a: TrialPairableCell, b: TrialPairableCell): number {
  const byStrategy = rankOfStrategy(a.identityStrategy) - rankOfStrategy(b.identityStrategy);
  if (byStrategy !== 0) return byStrategy;
  return compareStrings(a.id, b.id);
}

function compareTrialPairs(a: TrialCellPair, b: TrialCellPair): number {
  return (
    compareStrings(a.characterId, b.characterId) ||
    compareStrings(a.profileId, b.profileId) ||
    compareStrings(a.promptFixtureId, b.promptFixtureId) ||
    rankOfStrategy(a.strategyA) - rankOfStrategy(b.strategyA) ||
    rankOfStrategy(a.strategyB) - rankOfStrategy(b.strategyB) ||
    compareStrings(a.pairId, b.pairId)
  );
}

function compareComparisons(a: TrialStrategyComparison, b: TrialStrategyComparison): number {
  return (
    compareStrings(a.profileId, b.profileId) ||
    rankOfStrategy(a.strategyA) - rankOfStrategy(b.strategyA) ||
    rankOfStrategy(a.strategyB) - rankOfStrategy(b.strategyB)
  );
}
