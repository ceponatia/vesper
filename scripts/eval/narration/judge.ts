import { z } from "zod";
import { generateChecked } from "../../../src/server/ai";
import type { EvalScenario } from "./fixtures";

/**
 * Judges for the narration eval harness (narrator-prompt-focus.plan.md §Behavioral
 * eval harness; results in narrator-prompt-focus.eval-results.md §Methodology
 * follow-ups). Two modes:
 *
 *  - **Absolute** (`judgeAbsolute`): the original per-cell 1–5 rubric. Cheap and
 *    stable, but run 1 showed it compresses to 4.4–5.0 — small deltas are noise.
 *  - **Pairwise / ranking** (`rankNarrations`): shows the judge 2–3 candidate
 *    narrations for the SAME scenario and forces a relative ordering + per-dimension
 *    winner. Relative judgments discriminate far better than absolute scores; this is
 *    the sharper-judge follow-up. Point `EVAL_JUDGE_MODEL` at a strong model (e.g.
 *    `google/gemini-3.5-pro`) so the judge out-classes the cast it scores.
 */

export const JUDGE_MODEL = process.env.EVAL_JUDGE_MODEL || "z-ai/glm-5.2";

export const JUDGE_DIMS = ["answeredFirst", "proportionate", "onBeat", "noUnrequestedLogistics", "voice"] as const;
export type JudgeDim = (typeof JUDGE_DIMS)[number];

const DIM_RUBRIC: Record<JudgeDim, string> = {
  answeredFirst: "does the opening directly address the player's input before any new business?",
  proportionate: "is the emotional reaction proportionate (not doting/over-rewarding ordinary input)?",
  onBeat: "does it stay on the player's beat without unrelated topic sprawl?",
  noUnrequestedLogistics: "free of unrequested errands/logistics/thread-reminder dumps?",
  voice: "distinct, in-character, vivid prose?",
};

function scenarioContext(scenario: EvalScenario): string[] {
  return [
    `Scenario: ${scenario.title}`,
    `Player input: ${scenario.playerInput}`,
    `What a good response does: ${scenario.expectation}`,
    scenario.authoredReaction
      ? `Authored reaction verdict (proportionality must match this, not exceed it):\n${scenario.authoredReaction}`
      : "",
  ].filter(Boolean);
}

// ---------------------------------------------------------------------------
// Absolute judge (1–5 per dimension) — the run-1 method.
// ---------------------------------------------------------------------------

export const judgeSchema = z.object({
  answeredFirst: z.number().int().min(1).max(5).catch(3),
  proportionate: z.number().int().min(1).max(5).catch(3),
  onBeat: z.number().int().min(1).max(5).catch(3),
  noUnrequestedLogistics: z.number().int().min(1).max(5).catch(3),
  voice: z.number().int().min(1).max(5).catch(3),
  note: z.string().catch(""),
});
export type Judgement = z.infer<typeof judgeSchema>;

export const judgeAvg = (j: Judgement): number => JUDGE_DIMS.reduce((s, d) => s + j[d], 0) / JUDGE_DIMS.length;

const JUDGE_SYSTEM =
  "You are a strict evaluator of interactive-fiction narration. Score the narration 1–5 on each rubric dimension (1 = fails badly, 5 = excellent). " +
  "Be harsh about over-rewarding/doting and topic sprawl. Output only the structured scores and a one-line note.";

function absolutePrompt(scenario: EvalScenario, narration: string): string {
  return [
    ...scenarioContext(scenario),
    "",
    "Rubric (1–5 each):",
    ...JUDGE_DIMS.map((d) => `- ${d}: ${DIM_RUBRIC[d]}`),
    "",
    "Narration to score:",
    narration,
  ].join("\n");
}

export async function judgeAbsolute(scenario: EvalScenario, narration: string): Promise<Judgement | null> {
  const r = await generateChecked<Judgement>({
    schema: judgeSchema,
    system: JUDGE_SYSTEM,
    prompt: absolutePrompt(scenario, narration),
    modelId: JUDGE_MODEL,
    temperature: 0,
    maxOutputTokens: 500,
    code: "eval.judge",
  });
  return r.value;
}

// ---------------------------------------------------------------------------
// Pairwise / ranking judge — the sharper method (relative, forced ordering).
// ---------------------------------------------------------------------------

/** Up to three candidates per comparison group (profile=2, reasoning≤3, focus=2). */
export const CANDIDATE_LABELS = ["A", "B", "C"] as const;
export type CandidateLabel = (typeof CANDIDATE_LABELS)[number];

export interface RankCandidate {
  label: CandidateLabel;
  narration: string;
}

const labelEnum = z.enum(CANDIDATE_LABELS);
const winnerEnum = z.enum(["A", "B", "C", "tie"]);
const TIE_DIMS = { answeredFirst: "tie", proportionate: "tie", onBeat: "tie", noUnrequestedLogistics: "tie", voice: "tie" } as const;

export const rankSchema = z.object({
  /** Candidate labels, best → worst. A full ordering (no ties). */
  overall: z.array(labelEnum).default([]),
  /** Per-dimension winner (or "tie" only when genuinely indistinguishable). */
  dimWinners: z
    .object({
      answeredFirst: winnerEnum.catch("tie"),
      proportionate: winnerEnum.catch("tie"),
      onBeat: winnerEnum.catch("tie"),
      noUnrequestedLogistics: winnerEnum.catch("tie"),
      voice: winnerEnum.catch("tie"),
    })
    .catch(() => ({ ...TIE_DIMS })),
  note: z.string().catch(""),
});
export type Ranking = z.infer<typeof rankSchema>;

const RANK_SYSTEM =
  "You are a strict, decisive evaluator of interactive-fiction narration. You will see 2–3 candidate responses " +
  "(A, B, C) to the SAME scenario and player input. The candidates differ only in subtle ways. Rank them best → " +
  "worst overall and pick a per-dimension winner. Be decisive: force a full overall ordering with NO ties, and " +
  "call a dimension a 'tie' only when the candidates are genuinely indistinguishable on it. Never reward length, " +
  "doting, or padding — brevity that fully answers the input beats a longer reply that sprawls or over-rewards.";

function rankPrompt(scenario: EvalScenario, candidates: RankCandidate[]): string {
  return [
    ...scenarioContext(scenario),
    "",
    "Rubric dimensions (use these to compare):",
    ...JUDGE_DIMS.map((d) => `- ${d}: ${DIM_RUBRIC[d]}`),
    "",
    "Candidates (each is a full response to the same input):",
    ...candidates.map((c) => `\n--- Candidate ${c.label} ---\n${c.narration}`),
    "",
    'Return: "overall" = the candidate labels ordered best→worst (a full ordering, no ties); ' +
      '"dimWinners" = the winning label per dimension (or "tie"); "note" = one line on what separated them.',
  ].join("\n");
}

export async function rankNarrations(scenario: EvalScenario, candidates: RankCandidate[]): Promise<Ranking | null> {
  const r = await generateChecked<Ranking>({
    schema: rankSchema,
    system: RANK_SYSTEM,
    prompt: rankPrompt(scenario, candidates),
    modelId: JUDGE_MODEL,
    temperature: 0,
    // Headroom: a strong judge is often a reasoning model — too small a budget gets
    // spent on reasoning tokens and returns empty text (→ degrade to schema defaults).
    maxOutputTokens: 1500,
    code: "eval.rankjudge",
  });
  return r.value;
}
