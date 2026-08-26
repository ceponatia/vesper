import {
  identityReferenceStrategies,
  type IdentityReferenceRole,
  type IdentityReferenceStrategy,
} from "./identity-pack";
import {
  perTrialGradeDimension,
  TRIAL_MAX_CELLS,
  trialPackVariantKey,
  type ImageIdentityPackTrialGradeRequest,
  type ImageIdentityPackTrialRefusalCode,
  type TrialCellStatus,
  type TrialDimensionAggregate,
  type TrialPackVariantSelector,
  type TrialPairGrade,
  type TrialStrategyComparison,
} from "./identity-pack-trial";
import type { ImageProfileTask } from "../models/image-model-profiles";

/**
 * Pure identity-pack trial logic: the checked-in prompt fixtures, the
 * cartesian cell planner, the deterministic pairing rule, and the grade
 * aggregation the summary surface reports.
 *
 * Everything here is plain data in and plain data out — no persistence, no
 * randomness, no clock. Determinism is a product property, not a style choice:
 * the same run configuration must plan the same cells, the same rendered cells
 * must produce the same pairs in the same order, and the same grades must
 * aggregate to the same numbers, or a rerun stops being evidence. The one
 * genuinely random ingredient — which side of a blinded pair the reviewer sees
 * on the left — belongs to the server, which persists its `leftIsA` choice and
 * hands it back to `unblindTrialPairGrade` here.
 *
 * A run varies TWO identity-reference axes: the reference strategy and the pack
 * variant ({@link TrialCellPlan}). Everything downstream — pairing, canonical
 * A/B, aggregation buckets — treats the two as one "arm", and refuses to compare
 * arms that differ in both, because a grade on such a pair cannot be attributed
 * to either change.
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
  /** Omitted means one `current` variant — the pre-variant behavior exactly. */
  packVariants?: readonly TrialPackVariantSelector[];
}

/** One planned comparison cell, before any pack/profile resolution has run. */
export interface TrialCellPlan {
  /** Deterministic identity within a run — the unique-key the cells table enforces. */
  cellKey: string;
  characterId: string;
  profileId: string;
  /** Null on the no-pack baseline: zero references means no order to choose. */
  identityStrategy: IdentityReferenceStrategy | null;
  promptFixtureId: string;
  packVariantKey: string;
  packVariant: TrialPackVariantSelector;
}

export type BuildTrialCellPlansResult =
  | { ok: true; plans: TrialCellPlan[] }
  | {
      ok: false;
      code: Extract<ImageIdentityPackTrialRefusalCode, "too_many_cells">;
      requestedCells: number;
      maximumCells: number;
    };

/** The one variant list a plan expands over, when the caller named none. */
const DEFAULT_PACK_VARIANTS: readonly TrialPackVariantSelector[] = [{ source: "current" }];

/**
 * THE EXECUTION ORDER CONTRACT. A cell key is
 * `character : profile : fixture : strategy : variant`, and the FIRST THREE
 * SEGMENTS are the comparison group — the axes a pair must hold constant.
 *
 * That layout is not cosmetic. Cells are picked for execution in plain ascending
 * `cellKey` order, so a shared three-segment prefix makes every arm of one
 * comparison group execute CONSECUTIVELY. Nothing in the trial seeds a provider,
 * so two renders of the same subject drift with whatever the model was doing
 * between them; running a group's arms back-to-back is the only lever the
 * harness has to keep that drift shared rather than becoming the difference
 * being measured. The old layout put the strategy third, which interleaved
 * groups and spread one comparison across an entire pass.
 *
 * The variant key goes LAST because it is the only segment that may itself
 * contain colons (`rev:<characterId>:<revision>`).
 *
 * Changing this layout changes which renders are temporally adjacent, which
 * changes what the grid measures. It is a comparison-identity change, not a
 * formatting one.
 */
export function trialCellKey(parts: {
  characterId: string;
  profileId: string;
  promptFixtureId: string;
  identityStrategy: IdentityReferenceStrategy | null;
  packVariantKey: string;
}): string {
  const strategy = parts.identityStrategy ?? "none";
  return `${parts.characterId}:${parts.profileId}:${parts.promptFixtureId}:${strategy}:${parts.packVariantKey}`;
}

/** Plain lexicographic cell-key order — the order cells execute and the grid
 * reads, spelled once so a caller sorting in memory and the database's
 * `ORDER BY cell_key` cannot disagree. See {@link trialCellKey}. */
export function compareTrialCellKeys(a: string, b: string): number {
  return compareStrings(a, b);
}

/**
 * Expand a run configuration into its full cell set: characters × profiles ×
 * fixtures, and within each of those groups every identity-reference arm — each
 * pack variant crossed with every strategy, plus the single no-pack baseline
 * cell if that variant was asked for.
 *
 * Three expansion rules are load-bearing:
 *
 * - A `revision` variant pins ONE character's pack, so it generates cells only
 *   for that character and simply produces none for the run's others. Silently
 *   applying it to every character would compare unrelated revisions.
 * - The `none` variant produces exactly ONE cell per (character, profile,
 *   fixture) with a null strategy. Crossing the baseline with strategies would
 *   plan four identical zero-reference renders and bill for all of them.
 * - Duplicate entries on any axis — variants deduped by DERIVED KEY, not by
 *   object identity — are collapsed BEFORE anything is counted, so a
 *   pasted-twice character id neither doubles the spend nor refuses a run that
 *   genuinely fits.
 *
 * Axes keep their first-seen order (the owner's ordering is how the run reads
 * back in the UI) and the loop nesting mirrors the key's segment order, so every
 * arm of one comparison group is planned consecutively — the same contiguity a
 * `cellKey ASC` read gives at execution time ({@link trialCellKey}).
 *
 * The cap is checked against the cells ACTUALLY GENERATED, not a cartesian
 * product computed from the axis lengths: a character-scoped revision variant
 * contributes to some characters and not others, and a product would refuse runs
 * that fit. Over `TRIAL_MAX_CELLS` the answer is a typed refusal, never a
 * trimmed plan — a silently dropped corner would leave the reviewer believing a
 * comparison ran that never existed.
 */
export function buildTrialCellPlans(input: TrialCellPlanInput): BuildTrialCellPlansResult {
  const characterIds = dedupe(input.characterIds);
  const profileIds = dedupe(input.profileIds);
  const strategies = dedupe(input.strategies);
  const promptFixtureIds = dedupe(input.promptFixtureIds);
  const variants = dedupeVariants(input.packVariants ?? DEFAULT_PACK_VARIANTS);
  const packVariants = variants.filter((variant) => variant.selector.source !== "none");
  const baselineVariant = variants.find((variant) => variant.selector.source === "none");

  const plans: TrialCellPlan[] = [];
  for (const characterId of characterIds) {
    // A revision variant belongs to one character; every other pack variant
    // applies to all of them.
    const applicable = packVariants.filter(
      (variant) => variant.selector.source !== "revision" || variant.selector.characterId === characterId,
    );
    for (const profileId of profileIds) {
      for (const promptFixtureId of promptFixtureIds) {
        for (const identityStrategy of strategies) {
          for (const variant of applicable) {
            plans.push(trialCellPlanFor({ characterId, profileId, promptFixtureId, identityStrategy, variant }));
          }
        }
        // The baseline closes each group: one zero-reference cell, no strategy.
        if (baselineVariant) {
          plans.push(
            trialCellPlanFor({
              characterId,
              profileId,
              promptFixtureId,
              identityStrategy: null,
              variant: baselineVariant,
            }),
          );
        }
      }
    }
  }

  if (plans.length > TRIAL_MAX_CELLS) {
    return { ok: false, code: "too_many_cells", requestedCells: plans.length, maximumCells: TRIAL_MAX_CELLS };
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
  /** Null on the no-pack baseline. */
  identityStrategy: IdentityReferenceStrategy | null;
  packVariantKey: string;
  referenceSource: "pack" | "none";
  /**
   * The roles this cell ACTUALLY sent, in send order — the evaluation's answer,
   * not the strategy's wish. Two strategies can evaluate to the same list (a
   * pack whose face crop is unusable makes `canonical_then_face_detail` send
   * exactly what `canonical_only` sends), and a pair of those is two names for
   * one render. The planner refuses to create such a cell; this is what lets the
   * pairing rule refuse the rows that already exist.
   */
  orderedReferenceRoles: readonly IdentityReferenceRole[];
  /** The source photograph the pack was derived from; null on the baseline. */
  sourceContentHash: string | null;
}

/**
 * One reviewable pair. A and B are CANONICAL, not presentation: A is the arm
 * that sorts first (strategy in `identityReferenceStrategies` order with the
 * null baseline last, then variant), so every pair of the same two arms
 * aggregates into the same comparison bucket instead of splitting across
 * (A vs B) and (B vs A). Which cell the reviewer sees on the left is the
 * server's separately-persisted blind mapping.
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
  strategyA: IdentityReferenceStrategy | null;
  strategyB: IdentityReferenceStrategy | null;
  variantKeyA: string;
  variantKeyB: string;
}

/**
 * Whether two cells of one group form an INTERPRETABLE comparison: they must
 * differ in exactly one identity-reference variable, AND the difference must be
 * one that reached the provider.
 *
 * With two axes (strategy and pack variant), the naive "any two different cells"
 * rule produces pairs that differ in both — a grade on such a pair cannot be
 * attributed to either change, so it is a confound wearing the costume of
 * evidence. The parity test below reads as: same strategy XOR same variant.
 *
 * Two further guards exist because a cell's LABEL and the render it actually
 * made can come apart, and a pair that differs only in label is worse than no
 * evidence — it is noise reported as a strategy effect:
 *
 * - **Same variant, identical role list.** `canonical_then_face_detail` against
 *   a pack whose face crop is unusable evaluates to the canonical portrait
 *   alone, which is byte-for-byte what `canonical_only` sends. The planner now
 *   refuses to create that cell, so this guard is for rows planned before it —
 *   defence for stored data, not a second implementation of the rule.
 * - **Different variants, different source photographs.** The variant axis
 *   exists to compare CROPS of one photograph (heuristic vs manual, old revision
 *   vs new). Two revisions derived from different sources are two different
 *   subjects' images; grading them measures the photographs, not the derivation.
 *   Pack-source cells always carry the hash by contract
 *   (`imageIdentityPackTrialCellSpecSchema`'s cross-field rule), so this compares
 *   two real values rather than two absences.
 *
 * The no-pack baseline is the deliberate exception to all of it. It differs from
 * every pack cell in the only way it can (references vs no references), so it
 * pairs against all of them regardless of roles or source; two baselines are the
 * same arm and never pair.
 */
function comparableTrialCells(a: TrialPairableCell, b: TrialPairableCell): boolean {
  const baselineA = a.referenceSource === "none";
  const baselineB = b.referenceSource === "none";
  if (baselineA || baselineB) return baselineA !== baselineB;
  const sameStrategy = a.identityStrategy === b.identityStrategy;
  const sameVariant = a.packVariantKey === b.packVariantKey;
  if (sameStrategy === sameVariant) return false;
  if (sameVariant) return !sameRoleList(a.orderedReferenceRoles, b.orderedReferenceRoles);
  return a.sourceContentHash === b.sourceContentHash;
}

/** Role lists are ORDERED — `canonical_then_face_detail` and its reverse send
 * the same two roles and are genuinely different arms — so this compares
 * sequences, never sets. */
function sameRoleList(a: readonly IdentityReferenceRole[], b: readonly IdentityReferenceRole[]): boolean {
  return a.length === b.length && a.every((role, index) => role === b[index]);
}

/**
 * Every interpretable pair the rendered cells support: cells grouped by
 * (character, fixture, profile) — the axes a comparison must hold constant —
 * then every unordered pair within a group that {@link comparableTrialCells}
 * accepts.
 *
 * Only `rendered` cells pair: a planned, running, failed or refused cell has no
 * image to review, and pairing it would put a hole in the blinded queue. The
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
    const ordered = [...group].sort(compareCellsByArmThenId);
    for (let first = 0; first < ordered.length; first += 1) {
      for (let second = first + 1; second < ordered.length; second += 1) {
        const cellA = ordered[first];
        const cellB = ordered[second];
        if (!cellA || !cellB) continue;
        if (!comparableTrialCells(cellA, cellB)) continue;
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
          variantKeyA: cellA.packVariantKey,
          variantKeyB: cellB.packVariantKey,
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
 * Aggregate unblinded grades per (profile, arm A, arm B), where an arm is a
 * (strategy, pack variant) pair.
 *
 * The bucket key includes the variant keys, not just the strategies: the same
 * two strategies compared across two different pack revisions are two different
 * findings, and folding them together would average away the very effect the
 * variant axis was added to measure. It is a JSON array rather than a joined
 * string because a variant key may itself contain colons, and a delimiter a
 * value can contain is a bucket collision waiting to happen.
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
    strategyA: IdentityReferenceStrategy | null;
    strategyB: IdentityReferenceStrategy | null;
    variantKeyA: string;
    variantKeyB: string;
    totalPairs: number;
    grades: TrialPairGrade[];
  }
  const buckets = new Map<string, ComparisonAccumulator>();
  for (const pair of pairs) {
    const bucketKey = JSON.stringify([
      pair.profileId,
      pair.strategyA,
      pair.variantKeyA,
      pair.strategyB,
      pair.variantKeyB,
    ]);
    let bucket = buckets.get(bucketKey);
    if (!bucket) {
      bucket = {
        profileId: pair.profileId,
        strategyA: pair.strategyA,
        strategyB: pair.strategyB,
        variantKeyA: pair.variantKeyA,
        variantKeyB: pair.variantKeyB,
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
      variantKeyA: bucket.variantKeyA,
      variantKeyB: bucket.variantKeyB,
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

/** One deduped variant axis entry: the selector plus the key everything else
 * compares by. Deduped by DERIVED KEY (not object identity), so two spellings of
 * one variant collapse to a single arm instead of planning it twice. */
interface TrialPackVariantAxisEntry {
  key: string;
  selector: TrialPackVariantSelector;
}

function dedupeVariants(selectors: readonly TrialPackVariantSelector[]): TrialPackVariantAxisEntry[] {
  const byKey = new Map<string, TrialPackVariantSelector>();
  for (const selector of selectors) {
    const key = trialPackVariantKey(selector);
    if (!byKey.has(key)) byKey.set(key, selector);
  }
  return [...byKey].map(([key, selector]): TrialPackVariantAxisEntry => ({ key, selector }));
}

/** One cell of the grid, with its key derived rather than restated — the single
 * construction site both the strategy arms and the baseline arm go through, so
 * the two can never disagree about the key layout. */
function trialCellPlanFor(parts: {
  characterId: string;
  profileId: string;
  promptFixtureId: string;
  identityStrategy: IdentityReferenceStrategy | null;
  variant: TrialPackVariantAxisEntry;
}): TrialCellPlan {
  const { characterId, profileId, promptFixtureId, identityStrategy, variant } = parts;
  return {
    cellKey: trialCellKey({
      characterId,
      profileId,
      promptFixtureId,
      identityStrategy,
      packVariantKey: variant.key,
    }),
    characterId,
    profileId,
    identityStrategy,
    promptFixtureId,
    packVariantKey: variant.key,
    packVariant: variant.selector,
  };
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

/** The null baseline ranks after every real strategy, so canonical A/B never
 * puts "no references" on the A side of a pack cell. */
function rankOfStrategy(strategy: IdentityReferenceStrategy | null): number {
  if (strategy === null) return identityReferenceStrategies.length;
  return strategyRank.get(strategy) ?? identityReferenceStrategies.length;
}

/** Variant precedence for canonical A/B: the current pack first, a pinned
 * revision (or any future named variant) next, the no-pack baseline last —
 * so an A-favoring grade always reads as "the more canonical arm won". */
function rankOfVariant(variantKey: string): number {
  if (variantKey === "current") return 0;
  if (variantKey === "none") return 2;
  return 1;
}

function compareStrings(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function compareCellsByArmThenId(a: TrialPairableCell, b: TrialPairableCell): number {
  return (
    compareArms(a.identityStrategy, a.packVariantKey, b.identityStrategy, b.packVariantKey) ||
    compareStrings(a.id, b.id)
  );
}

function compareTrialPairs(a: TrialCellPair, b: TrialCellPair): number {
  return (
    compareStrings(a.characterId, b.characterId) ||
    compareStrings(a.profileId, b.profileId) ||
    compareStrings(a.promptFixtureId, b.promptFixtureId) ||
    compareArms(a.strategyA, a.variantKeyA, b.strategyA, b.variantKeyA) ||
    compareArms(a.strategyB, a.variantKeyB, b.strategyB, b.variantKeyB) ||
    compareStrings(a.pairId, b.pairId)
  );
}

function compareComparisons(a: TrialStrategyComparison, b: TrialStrategyComparison): number {
  return (
    compareStrings(a.profileId, b.profileId) ||
    compareArms(a.strategyA, a.variantKeyA, b.strategyA, b.variantKeyA) ||
    compareArms(a.strategyB, a.variantKeyB, b.strategyB, b.variantKeyB)
  );
}

/** The one arm ordering — strategy rank, then variant rank, then variant key —
 * shared by pair ordering and comparison ordering so a pair and the bucket it
 * lands in can never sort differently. */
function compareArms(
  strategyA: IdentityReferenceStrategy | null,
  variantKeyA: string,
  strategyB: IdentityReferenceStrategy | null,
  variantKeyB: string,
): number {
  return (
    rankOfStrategy(strategyA) - rankOfStrategy(strategyB) ||
    rankOfVariant(variantKeyA) - rankOfVariant(variantKeyB) ||
    compareStrings(variantKeyA, variantKeyB)
  );
}
