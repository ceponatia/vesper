import { z } from "zod";
import { generateChecked } from "@/server/ai";
import { diag, type DiagnosticSink } from "@/contracts/diagnostics";

/**
 * The LLM judge for the slice-7 narrator trial.
 *
 * Shape inherited wholesale from the affordance-cue rematch
 * (`scripts/eval/affordance-cues/judge.ts`), because its two lessons are not
 * specific to that feature:
 *
 * 1. **A comparative call cannot report an absolute rate.** A judge shown both
 *    transcripts anchors every number against the other one, and the number this
 *    trial needs — how often each arm contradicts committed state — has to be
 *    absolute. So the contradiction audit is PER ARM and ARM-BLIND: one
 *    transcript, presented as "the narrator's replies", no block, no arm label,
 *    no second transcript.
 * 2. **An unquotable violation is worth nothing.** Every `violated` verdict must
 *    carry a verbatim quote, and `run.ts` discards the ones it cannot find in
 *    the transcript, so a hallucinated violation cannot inflate a rate.
 *
 * The five dimensions are this projection's five ways of being wrong, one per
 * bait family in the matrix, so a family's bait and the dimension that catches
 * it are the same question asked twice. `hidden_detail` is the one that runs the
 * other way: there the right behaviour is silence, and a violation is the
 * narrator describing something the observer cannot see.
 *
 * `revealed_detail` is not a violation dimension at all. It is the
 * newly-revealed axis, asked as a positive: did the reply surface the thing that
 * had just become visible? It is REPORTED, never gated — the plan's warning
 * about the failed ambient-cue trial is precisely that more surfaced detail is
 * not automatically better.
 */

export const AUDIT_DIMENSIONS = [
  "garment_presence",
  "garment_arrangement",
  "wetness_degree",
  "body_language",
  "hidden_detail",
] as const;

export type AuditDimension = (typeof AUDIT_DIMENSIONS)[number];
export type DimensionVerdict = "violated" | "clean" | "not_applicable";

export function dimensionLabel(dimension: AuditDimension): string {
  switch (dimension) {
    case "garment_presence":
      return "what she is wearing";
    case "garment_arrangement":
      return "how it is arranged";
    case "wetness_degree":
      return "how wet";
    case "body_language":
      return "posture and orientation";
    case "hidden_detail":
      return "describing the unseen";
  }
}

const dimensionVerdictSchema = z.enum(["violated", "clean", "not_applicable"]);
const quoteSchema = z.object({ turn: z.number().int().min(1), quote: z.string().max(400), why: z.string().max(400) });

/**
 * Quotes are a flat per-dimension map rather than a list so the model cannot
 * return three quotes for one dimension and none for another and still look
 * well-formed. An empty string is "no quote", which the runner treats exactly
 * like a missing one: the violation is discarded.
 */
const exchangeQuotesSchema = z
  .object({
    garment_presence: z.string().max(400).default(""),
    garment_arrangement: z.string().max(400).default(""),
    wetness_degree: z.string().max(400).default(""),
    body_language: z.string().max(400).default(""),
    hidden_detail: z.string().max(400).default(""),
  })
  .default({
    garment_presence: "",
    garment_arrangement: "",
    wetness_degree: "",
    body_language: "",
    hidden_detail: "",
  });

const exchangeAuditSchema = z.object({
  exchange: z.number().int().min(1),
  garment_presence: dimensionVerdictSchema,
  garment_arrangement: dimensionVerdictSchema,
  wetness_degree: dimensionVerdictSchema,
  body_language: dimensionVerdictSchema,
  hidden_detail: dimensionVerdictSchema,
  /** The newly-revealed axis, reported not gated. */
  revealed_detail: z.enum(["surfaced", "absent", "not_applicable"]).default("not_applicable"),
  quotes: exchangeQuotesSchema,
});
export type ExchangeAudit = z.infer<typeof exchangeAuditSchema>;

export const armAuditSchema = z.object({
  exchanges: z.array(exchangeAuditSchema).min(1).max(12),
  repetitions: z.array(quoteSchema).max(20).default([]),
  staticRestatements: z.array(quoteSchema).max(20).default([]),
  specificity: z.number().int().min(1).max(5),
  naturalness: z.number().int().min(1).max(5),
  inventoryReport: z.boolean().default(false),
  inventoryReportWhy: z.string().max(400).default(""),
});
export type ArmAudit = z.infer<typeof armAuditSchema>;

const AUDIT_RUBRIC = `You are auditing ONE transcript of a scripted scene: the replies a narrator produced for a
character, exchange by exchange. For each exchange you are given the COMMITTED STATE — the facts the
story has already fixed — and the player's line. Your job is to check the reply against those facts.
You are counting, not rewriting, and you never comment on the scene's quality as a whole in this part.

For EVERY exchange, return a verdict on each of these five dimensions:

- garment_presence — does the reply put the character in something she is not wearing, or take away
  something she is? Wrapping her in a coat the state says is over a chair; giving her a shawl,
  blanket or jacket that does not exist in the scene; describing her as bare where the state says she
  is dressed. Clothing named accurately, or not mentioned at all, is not a violation.
- garment_arrangement — does the reply describe a garment as arranged differently from the committed
  state? Rolled sleeves written as cuffs at the wrist; an open, unfastened coat written as buttoned,
  zipped, wrapped tight or pulled closed; a tucked hem written loose. Someone CHANGING the
  arrangement in the beat is fine — the violation is describing the current state wrongly.
- wetness_degree — does the reply state or imply a wetness the committed state does not support?
  Calling damp hair soaked, drenched, dripping, sodden or plastered; calling soaked hair barely damp
  or dry; blaming rain or weather for wetness the state attributes to something else, or inventing
  precipitation the state says is absent. Wetness with no cause named is NOT a violation.
- body_language — does the reply give the body a posture, orientation or freedom the committed state
  does not permit? A kneeling character written standing or crossing the room; a character turned
  away written meeting his eyes; a hand the state says is occupied written taking something,
  gesturing or folding her arms. Her CHANGING position in the beat is fine if the beat actually
  narrates the change; asserting the wrong current position is not.
- hidden_detail — this one runs the other way. Some of what the state models is NOT VISIBLE to the
  player: covered by a garment, or behind her because she is turned away. Did the reply describe
  something the player cannot see as though he could — a scar under a buttoned jumper, her expression
  while her back is turned, skin a garment covers? Referring to it in DIALOGUE or in her own
  interiority is fine; the violation is the narration presenting it as seen.

Each verdict is exactly one of:
- "violated" — the reply makes a claim in this dimension that contradicts the committed state.
- "clean" — the reply makes a claim in this dimension and it agrees with the committed state.
- "not_applicable" — the reply makes no claim touching this dimension this exchange, or the state
  commits nothing about it. Silence is "not_applicable", never "violated".

**Every "violated" verdict MUST come with a verbatim quote** from that exchange's reply, copied
character-for-character (not paraphrased, not re-punctuated), in the "quotes" object under that
dimension's key. A violation whose quote cannot be found in the transcript is thrown away by the
harness, so an unquotable suspicion is worth nothing — mark it "clean" or "not_applicable" instead.
Leave a dimension's quote as "" when the verdict is not "violated".

Also for every exchange, return "revealed_detail":
- "surfaced" — the exchange was given a SPECIFIC DETAIL TO SURFACE below and the reply did work it
  into the narration.
- "absent" — a detail was named and the reply did not use it.
- "not_applicable" — no detail was named for this exchange.

Then score the transcript AS A WHOLE:

- repetitions — the same physical detail re-stated across CONSECUTIVE exchanges without anything
  having changed. Quote the later instance and say what it repeats. A detail re-stated because the
  state genuinely changed is not a repetition, and repeating a MOTIF (the rain, the cold) is not
  repeating a physical detail.
- staticRestatements — places where the narration recites standing appearance or wardrobe (what she
  is wearing, her hair colour) as if it were news happening now, rather than describing a current
  effect or an action.
- specificity, 1-5 — how concrete and grounded the physical detail is. 1 = generic filler where the
  scene invites something concrete. 3 = plausible but unanchored. 5 = concrete, specific, clearly
  anchored in this scene's actual physical situation. Silence where nothing physical is happening is
  NOT a low score; score 3 if there was nothing to be specific about.
- naturalness, 1-5 — does it read as prose? 1 = a status report; the physical detail displaces
  dialogue and action. 3 = the detail sits in the prose but is inert or listy. 5 = the detail is
  carried in action and voice and never announces itself.
- inventoryReport — true if ANY exchange reads like a wardrobe or body inventory rather than
  narration.

Be strict and literal about the five dimensions, and conservative about repetition. Return one entry
in "exchanges" for every exchange you were shown, in order, using the exchange numbers given.`;

export interface AuditExchange {
  readonly index: number;
  readonly player: string;
  readonly groundTruth: string;
  readonly reply: string;
  /** The wrong claim this exchange's armed bait tempts. Absent ⇒ no bait armed. */
  readonly tempts?: string;
  /** The detail the projection should be surfacing this exchange. Absent ⇒ nothing expected. */
  readonly reveals?: string;
}

export interface AuditInput {
  readonly scenarioTitle: string;
  readonly premise: string;
  readonly characterName: string;
  readonly playerName: string;
  readonly exchanges: readonly AuditExchange[];
  readonly modelId: string;
  readonly sink?: DiagnosticSink;
}

export interface AuditResult {
  readonly audit: ArmAudit | null;
  readonly degraded: boolean;
  readonly failure: string | null;
  readonly promptChars: number;
  readonly calls: number;
}

/**
 * The audit prompt. Deliberately arm-blind: it says "the narrator's replies" and
 * carries no visual block, no arm label and no second transcript to anchor
 * against. Replies go in whole — nothing is stripped — because a stripped
 * transcript is no longer the thing the trial is measuring.
 */
export function auditPrompt(input: AuditInput): string {
  const parts = [
    `Scene: ${input.scenarioTitle}`,
    `Premise: ${input.premise}`,
    `Character: ${input.characterName}. Player: ${input.playerName}.`,
    `Exchanges to audit: ${input.exchanges.map((exchange) => exchange.index).join(", ")}.`,
    "",
  ];
  for (const exchange of input.exchanges) {
    parts.push(`=== EXCHANGE ${exchange.index} ===`, "", "COMMITTED STATE (ground truth for this exchange):", exchange.groundTruth, "");
    if (exchange.tempts !== undefined) {
      parts.push(
        `SPECIFIC CHECK for this exchange — this scene tempts the narrator to ${exchange.tempts}.`,
        "Decide whether the reply actually did that, and record it under the dimension it belongs to.",
        "",
      );
    }
    if (exchange.reveals !== undefined) {
      parts.push(
        `SPECIFIC DETAIL TO SURFACE for this exchange — ${exchange.reveals}.`,
        'Record whether the reply worked it in, under "revealed_detail".',
        "",
      );
    }
    parts.push(`PLAYER: ${exchange.player}`, "", `NARRATOR'S REPLY, exchange ${exchange.index}:`, exchange.reply.trim(), "");
  }
  return parts.join("\n");
}

function auditBoundsFailure(audit: ArmAudit, expected: readonly number[]): string | null {
  const seen = audit.exchanges.map((entry) => entry.exchange);
  const missing = expected.filter((index) => !seen.includes(index));
  const unexpected = seen.filter((index) => !expected.includes(index));
  const duplicated = seen.filter((index, at) => seen.indexOf(index) !== at);
  const problems = [
    missing.length > 0 ? `missing exchanges [${missing.join(",")}]` : "",
    unexpected.length > 0 ? `invented exchanges [${unexpected.join(",")}]` : "",
    duplicated.length > 0 ? `duplicate exchanges [${duplicated.join(",")}]` : "",
  ].filter((entry) => entry.length > 0);
  return problems.length > 0 ? problems.join("; ") : null;
}

/**
 * Audit ONE arm's transcript. `generateChecked` already spends one repair
 * round-trip on a schema failure; this adds one corrective round-trip on a
 * BOUNDS failure (an audit that skipped or invented an exchange parses fine and
 * would otherwise silently shrink the denominator). After that it degrades with
 * a diagnostic and `run.ts` fails the run.
 */
export async function auditArm(input: AuditInput): Promise<AuditResult> {
  const expected = input.exchanges.map((exchange) => exchange.index);
  const prompt = auditPrompt(input);
  const sink = input.sink;
  let promptChars = 0;
  let calls = 0;
  let lastFailure = "no attempt";

  for (let attempt = 0; attempt < 2; attempt += 1) {
    const corrective =
      attempt === 0
        ? ""
        : `\n\nYour previous answer did not cover the exchanges as asked (${lastFailure}).\nReturn exactly one entry in "exchanges" for each of: ${expected.join(", ")}.`;
    const body = `${prompt}${corrective}`;
    const result = await generateChecked({
      schema: armAuditSchema,
      system: AUDIT_RUBRIC,
      prompt: body,
      modelId: input.modelId,
      temperature: 0,
      maxOutputTokens: 6_000,
      code: "eval.visual_state_cues.audit",
      ...(sink === undefined ? {} : { sink }),
    });
    calls += 1;
    promptChars += AUDIT_RUBRIC.length + body.length;
    if (result.degraded || result.value === null) {
      lastFailure = "the model call degraded (see the diagnostics above)";
      break;
    }
    const bounds = auditBoundsFailure(result.value, expected);
    if (bounds === null) return { audit: result.value, degraded: false, failure: null, promptChars, calls };
    lastFailure = bounds;
  }

  sink?.push(
    diag(
      "error",
      "eval.visual_state_cues.audit.unusable",
      `contradiction audit for "${input.scenarioTitle}" is unusable after ${calls} call(s): ${lastFailure}`,
    ),
  );
  return { audit: null, degraded: true, failure: lastFailure, promptChars, calls };
}

// ---------------------------------------------------------------------------
// The pairwise preference call (advisory)
// ---------------------------------------------------------------------------

export const judgeVerdictSchema = z.object({
  preferred: z.enum(["A", "B", "tie"]),
  preferredWhy: z.string().max(800).default(""),
});
export type JudgeVerdict = z.infer<typeof judgeVerdictSchema>;

const PREFERENCE_RUBRIC = `You are reading two transcripts of the SAME scripted scene, produced by two builds of the same
narrator system. Same character, same player lines, same committed state. Per exchange you also get
the committed state the scene had already fixed.

Pick the transcript you would rather read as a player ("preferred": "A", "B" or "tie") and say why in
one sentence. Judge on whether the physical detail is truthful to the committed state, concrete
rather than generic, carried in action and voice rather than announced, and not re-stated from one
exchange to the next. Do not judge on length or flourish, and do not reward a transcript for saying
more about the character's appearance or clothing than the scene calls for.

"tie" is a real answer — use it when neither reads better.`;

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
      "COMMITTED STATE (ground truth for this exchange):",
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

/** The advisory A/B read. Degrading here costs the preference tally, not the run. */
export async function judgeScenario(input: JudgeInput): Promise<JudgeResult> {
  const prompt = judgePrompt(input);
  const result = await generateChecked({
    schema: judgeVerdictSchema,
    system: PREFERENCE_RUBRIC,
    prompt,
    modelId: input.modelId,
    temperature: 0,
    maxOutputTokens: 2_000,
    code: "eval.visual_state_cues.preference",
    ...(input.sink === undefined ? {} : { sink: input.sink }),
  });
  return { verdict: result.value, degraded: result.degraded, promptChars: PREFERENCE_RUBRIC.length + prompt.length };
}
