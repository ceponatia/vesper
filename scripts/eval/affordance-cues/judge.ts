import { z } from "zod";
import { generateChecked } from "@/server/ai";
import type { DiagnosticSink } from "@/contracts/diagnostics";

/**
 * The LLM judge for the slice-5 narrator trial.
 *
 * It scores a PAIR of transcripts of the same scripted scene — same character,
 * same player lines, same committed physical state — on the plan's four criteria,
 * with the committed state supplied per exchange as ground truth for the
 * contradiction count.
 *
 * **Blinding.** The arms are presented as A and B, assigned per scenario by a
 * deterministic hash (`run.ts`), and the ground-truth blocks deliberately exclude
 * the rendered cue lines: a judge that could see the cue block would know which
 * arm was which on sight. The silence scenarios — where both arms get a
 * byte-identical prompt — double as the judge's own null control: a systematic
 * A-over-B preference there is label bias, not signal.
 *
 * The rubric wording is anchored to the plan's own language ("never a physics
 * report", "static appearance is not repeated as a current effect", "concrete
 * grounded detail") rather than a generic quality scale.
 */

const quoteSchema = z.object({
  turn: z.number().int().min(1),
  quote: z.string().max(400),
  why: z.string().max(400),
});

const armVerdictSchema = z.object({
  contradictions: z.array(quoteSchema).max(20).default([]),
  repetitions: z.array(quoteSchema).max(20).default([]),
  staticRestatements: z.array(quoteSchema).max(20).default([]),
  specificity: z.number().int().min(1).max(5),
  naturalness: z.number().int().min(1).max(5),
  physicsReport: z.boolean().default(false),
  physicsReportWhy: z.string().max(400).default(""),
});
export type ArmVerdict = z.infer<typeof armVerdictSchema>;

export const judgeVerdictSchema = z.object({
  A: armVerdictSchema,
  B: armVerdictSchema,
  preferred: z.enum(["A", "B", "tie"]),
  preferredWhy: z.string().max(800).default(""),
});
export type JudgeVerdict = z.infer<typeof judgeVerdictSchema>;

const RUBRIC = `You are grading two transcripts of the SAME scripted scene, produced by two builds of the same
narrator system. Same character, same player lines, same committed physical state. Your job is to
count and score, not to rewrite.

For EACH transcript (A and B), report:

1. contradictions — every place the narration contradicts the committed physical state given for
   that exchange. Examples of a contradiction: describing hair as dry when the state says it is
   soaked; hair blowing, streaming, whipping or fanning out when the state says it is bound, pinned,
   hooded, water-logged or in still air; hair hanging loose when the state says it is braided, tied
   back or pinned up; rain when the state says the wetness came from a bath or a splash and there is
   no rain in the scene. Quote the offending phrase and name the fact it breaks. Only count what
   actually contradicts the listed facts — a detail the state is silent about is NOT a contradiction.
2. repetitions — the same physical detail about the character's hair re-stated across CONSECUTIVE
   exchanges without anything having changed. Quote the later instance and say what it repeats. A
   detail re-stated because the state genuinely changed is not a repetition.
3. staticRestatements — places where the narration recites stable appearance (hair colour, length,
   texture) as if it were news happening now, rather than describing a current effect.
4. specificity, 1-5 — how concrete and grounded the physical detail is.
   1 = generic filler ("her hair looked nice", no physical detail at all where the scene invites one).
   3 = plausible but unanchored detail.
   5 = concrete, specific and clearly anchored in this scene's actual physical situation
       ("damp auburn strands cling to her neck").
   Score the transcript as a whole. Silence where nothing physical is happening is NOT a low score;
   score 3 if there was simply nothing to be specific about.
5. naturalness, 1-5 — does it read as prose?
   1 = reads like a physics or status report; the physical detail displaces dialogue and action.
   3 = the detail sits in the prose but is inert or listy.
   5 = the physical detail is carried in action and voice and never announces itself.
6. physicsReport — true if ANY exchange reads like a state readout rather than narration.

Then pick the transcript you would rather read as a player ("preferred": "A", "B" or "tie") and say
why in one sentence. Judge on the four criteria above, not on length or flourish.

Be strict and literal about contradictions, and conservative about repetition: repeating a MOTIF
(the rain, the cold) is not the same as re-stating the same hair detail.`;

export interface JudgeExchange {
  readonly index: number;
  readonly player: string;
  readonly groundTruth: string;
  readonly a: string;
  readonly b: string;
}

export interface JudgeInput {
  readonly scenarioTitle: string;
  readonly premise: string;
  readonly characterName: string;
  readonly playerName: string;
  readonly exchanges: readonly JudgeExchange[];
  readonly modelId: string;
  readonly sink?: DiagnosticSink;
}

export interface JudgeResult {
  readonly verdict: JudgeVerdict | null;
  readonly degraded: boolean;
  readonly promptChars: number;
  readonly latencyMs?: number;
}

export function judgePrompt(input: JudgeInput): string {
  const parts = [
    `Scene: ${input.scenarioTitle}`,
    `Premise: ${input.premise}`,
    `Character: ${input.characterName}. Player: ${input.playerName}.`,
    "",
  ];
  for (const exchange of input.exchanges) {
    parts.push(
      `=== EXCHANGE ${exchange.index} ===`,
      "",
      "COMMITTED PHYSICAL STATE (ground truth for this exchange):",
      exchange.groundTruth,
      "",
      `PLAYER: ${exchange.player}`,
      "",
      `TRANSCRIPT A, exchange ${exchange.index}:`,
      exchange.a.trim(),
      "",
      `TRANSCRIPT B, exchange ${exchange.index}:`,
      exchange.b.trim(),
      "",
    );
  }
  return parts.join("\n");
}

export async function judgeScenario(input: JudgeInput): Promise<JudgeResult> {
  const prompt = judgePrompt(input);
  const result = await generateChecked({
    schema: judgeVerdictSchema,
    system: RUBRIC,
    prompt,
    modelId: input.modelId,
    temperature: 0,
    maxOutputTokens: 6_000,
    code: "eval.affordance_cues.judge",
    ...(input.sink === undefined ? {} : { sink: input.sink }),
  });
  return {
    verdict: result.value,
    degraded: result.degraded,
    promptChars: RUBRIC.length + prompt.length,
    ...(result.latencyMs === undefined ? {} : { latencyMs: result.latencyMs }),
  };
}
