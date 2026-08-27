import { z } from "zod";
import { generateChecked } from "@/server/ai";
import { diag, type DiagnosticSink } from "@/contracts/diagnostics";

/**
 * The LLM judge for the affordance-cue narrator trial — rematch shape.
 *
 * Round 1 asked ONE call to do two incompatible jobs: measure each arm and pick
 * a favourite. A comparative call cannot report an absolute rate — the judge
 * anchors every number against the other transcript it can see — and round 1's
 * headline (contradictions tied at 0.13/exchange) was exactly the measurement
 * that needed to be absolute. The rematch splits them:
 *
 * 1. **Per-arm contradiction audit** (`auditArm`) — 2 calls per scenario, one
 *    transcript each, at temperature 0. The audit prompt never says "cues",
 *    "control", "A" or "B": it presents "the narrator's replies", so the judge
 *    cannot know which arm it is grading even in principle. Per exchange it
 *    returns a five-dimension checklist (`AUDIT_DIMENSIONS`), each
 *    `violated | clean | not_applicable`, and a VERBATIM QUOTE for every
 *    `violated` — the runner verifies each quote against the transcript and
 *    discards the ones it cannot find, so a hallucinated violation cannot
 *    inflate the rate. The per-arm quality scores (repetitions, static
 *    restatements, specificity, naturalness) ride along in the same call, which
 *    is what stops them being comparative anchors.
 * 2. **Pairwise preference** (`judgeScenario`) — 1 call per scenario, both
 *    transcripts as A and B under `run.ts`'s deterministic per-scenario hash.
 *    Unchanged from round 1 in shape, but **advisory**: it no longer gates the
 *    decision, it exists to catch a cue arm that wins the audit while reading
 *    worse. The silence controls (byte-identical prompts) remain its own null
 *    control — a one-sided preference there is label noise, not signal.
 *
 * Blinding depends on the ground-truth blocks never carrying the rendered cue
 * lines (`groundTruth` in harness.ts is built without them). Both prompt
 * builders here are pure and exported so the fixture guard can assert that.
 *
 * Contract discipline (round-1 rule, kept): JSON round-trip against a zod
 * schema, bounds checked against the exchanges actually asked about, ONE
 * corrective retry, then a loud degrade. `run.ts` turns any degraded audit into
 * a non-zero exit — an eval that silently scores blank output is worse than one
 * that crashes.
 */

// ---------------------------------------------------------------------------
// The audit contract
// ---------------------------------------------------------------------------

/**
 * The five checkable ways a narrator reply can contradict committed hair state.
 * One per bait family in the rematch matrix, so a family's bait and the
 * dimension that catches it are the same question asked twice.
 */
export const AUDIT_DIMENSIONS = [
  "wetness_degree",
  "provenance",
  "motion_vs_binding",
  "coverage",
  "adopted_false_premise",
] as const;

export type AuditDimension = (typeof AUDIT_DIMENSIONS)[number];
export type DimensionVerdict = "violated" | "clean" | "not_applicable";

/** One-line human label for a dimension (console table, discard reports). */
export function dimensionLabel(dimension: AuditDimension): string {
  switch (dimension) {
    case "wetness_degree":
      return "wetness degree";
    case "provenance":
      return "wetness provenance";
    case "motion_vs_binding":
      return "motion vs binding";
    case "coverage":
      return "coverage";
    case "adopted_false_premise":
      return "adopted false premise";
  }
}

const dimensionVerdictSchema = z.enum(["violated", "clean", "not_applicable"]);

const quoteSchema = z.object({
  turn: z.number().int().min(1),
  quote: z.string().max(400),
  why: z.string().max(400),
});

/**
 * Quotes are a flat per-dimension map rather than a list so the model cannot
 * return three quotes for one dimension and none for another and still look
 * well-formed. An empty string is "no quote", which the runner treats exactly
 * like a missing one: the violation is discarded.
 */
const exchangeQuotesSchema = z
  .object({
    wetness_degree: z.string().max(400).default(""),
    provenance: z.string().max(400).default(""),
    motion_vs_binding: z.string().max(400).default(""),
    coverage: z.string().max(400).default(""),
    adopted_false_premise: z.string().max(400).default(""),
  })
  .default({
    wetness_degree: "",
    provenance: "",
    motion_vs_binding: "",
    coverage: "",
    adopted_false_premise: "",
  });

const exchangeAuditSchema = z.object({
  exchange: z.number().int().min(1),
  wetness_degree: dimensionVerdictSchema,
  provenance: dimensionVerdictSchema,
  motion_vs_binding: dimensionVerdictSchema,
  coverage: dimensionVerdictSchema,
  adopted_false_premise: dimensionVerdictSchema,
  quotes: exchangeQuotesSchema,
});
export type ExchangeAudit = z.infer<typeof exchangeAuditSchema>;

export const armAuditSchema = z.object({
  exchanges: z.array(exchangeAuditSchema).min(1).max(12),
  repetitions: z.array(quoteSchema).max(20).default([]),
  staticRestatements: z.array(quoteSchema).max(20).default([]),
  specificity: z.number().int().min(1).max(5),
  naturalness: z.number().int().min(1).max(5),
  physicsReport: z.boolean().default(false),
  physicsReportWhy: z.string().max(400).default(""),
});
export type ArmAudit = z.infer<typeof armAuditSchema>;

const AUDIT_RUBRIC = `You are auditing ONE transcript of a scripted scene: the replies a narrator produced for a
character, exchange by exchange. For each exchange you are given the COMMITTED PHYSICAL STATE — the
facts the story has already committed to — and the player's line. Your job is to check the reply
against those facts. You are counting, not rewriting, and you never comment on the scene's quality
as a whole in this part.

For EVERY exchange, return a verdict on each of these five dimensions:

- wetness_degree — does the reply state or imply a wetness intensity for the hair that is not the
  committed one? Calling damp or barely-damp hair "soaked", "drenched", "dripping", "sodden" is a
  violation; so is calling soaked hair "barely damp" or "dry". The committed band is the one in the
  state block, not the one the scene feels like it should have.
- provenance — does the reply attribute the hair's wetness to a cause the state does not support?
  Blaming rain or weather when the committed cause is a bath, a burst tap, a dunk or a splash is a
  violation, as is inventing precipitation the environment line says is absent. Wetness with no
  cause named at all is NOT a violation.
- motion_vs_binding — does the reply give the hair motion, volume or freedom that its committed
  arrangement and the committed air do not permit? Bound, pinned, braided or tied hair "streaming",
  "cascading", "whipping", "fanning out", "spilling loose"; whole-hair motion in still air or
  indoors; water-logged hair lifting or floating. Loose wisps or escaped strands moving where the
  state allows it are fine.
- coverage — does the reply describe hair as visible, exposed or moving freely when a garment covers
  it (or as hidden when nothing covers it)? A hooded or wrapped head rendered as a visible cascade
  is a violation; what the covering's edge lets through is not.
- adopted_false_premise — the player's line sometimes ASSERTS a physical state that the committed
  state contradicts. Did the reply accept, echo or build on the player's false framing instead of
  the true state? Politely correcting it, deflecting it, or simply narrating the true state is
  clean. The player being wrong is not itself a violation — only the narrator adopting it is.

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

Then score the transcript AS A WHOLE:

- repetitions — the same physical detail about the character's hair re-stated across CONSECUTIVE
  exchanges without anything having changed. Quote the later instance and say what it repeats. A
  detail re-stated because the state genuinely changed is not a repetition, and repeating a MOTIF
  (the rain, the cold) is not repeating a hair detail.
- staticRestatements — places where the narration recites stable appearance (hair colour, length,
  texture) as if it were news happening now, rather than describing a current effect.
- specificity, 1-5 — how concrete and grounded the physical detail is. 1 = generic filler with no
  physical detail where the scene invites one. 3 = plausible but unanchored. 5 = concrete, specific,
  clearly anchored in this scene's actual physical situation. Silence where nothing physical is
  happening is NOT a low score; score 3 if there was nothing to be specific about.
- naturalness, 1-5 — does it read as prose? 1 = a physics or status report; the physical detail
  displaces dialogue and action. 3 = the detail sits in the prose but is inert or listy. 5 = the
  detail is carried in action and voice and never announces itself.
- physicsReport — true if ANY exchange reads like a state readout rather than narration.

Be strict and literal about the five dimensions, and conservative about repetition. Return one
entry in "exchanges" for every exchange you were shown, in order, using the exchange numbers given.`;

export interface AuditExchange {
  readonly index: number;
  readonly player: string;
  readonly groundTruth: string;
  /** The narrator's reply for the arm under audit. */
  readonly reply: string;
  /**
   * The wrong claim this exchange's armed bait tempts ("attributes bath wetness
   * to rain"), handed to the judge as a named specific check. Absent ⇒ no bait
   * is armed on this exchange and only the five standing dimensions apply.
   */
  readonly tempts?: string;
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
  /** Why the audit is unusable — a model degrade or a failed bounds check. */
  readonly failure: string | null;
  readonly promptChars: number;
  readonly calls: number;
  readonly latencyMs?: number;
}

/**
 * The audit prompt. Deliberately arm-blind: it says "the narrator's replies" and
 * carries no cue block, no arm label and no second transcript to anchor against.
 * Replies go in whole — nothing is stripped — because a stripped transcript is
 * no longer the thing the trial is measuring.
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
    parts.push(
      `=== EXCHANGE ${exchange.index} ===`,
      "",
      "COMMITTED PHYSICAL STATE (ground truth for this exchange):",
      exchange.groundTruth,
      "",
    );
    if (exchange.tempts) {
      parts.push(
        `SPECIFIC CHECK for this exchange — this scene tempts the narrator to ${exchange.tempts}.`,
        "Decide whether the reply actually did that, and record it under the dimension it belongs to.",
        "",
      );
    }
    parts.push(
      `PLAYER: ${exchange.player}`,
      "",
      `NARRATOR'S REPLY, exchange ${exchange.index}:`,
      exchange.reply.trim(),
      "",
    );
  }
  return parts.join("\n");
}

/** Every exchange asked about is answered exactly once, with no invented indices. */
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
  let latencyMs: number | undefined;
  let lastFailure = "no attempt";

  for (let attempt = 0; attempt < 2; attempt += 1) {
    const corrective =
      attempt === 0
        ? ""
        : [
            "",
            `Your previous answer did not cover the exchanges as asked (${lastFailure}).`,
            `Return exactly one entry in "exchanges" for each of: ${expected.join(", ")}.`,
          ].join("\n");
    const body = `${prompt}${corrective}`;
    const result = await generateChecked({
      schema: armAuditSchema,
      system: AUDIT_RUBRIC,
      prompt: body,
      modelId: input.modelId,
      temperature: 0,
      maxOutputTokens: 6_000,
      code: "eval.affordance_cues.audit",
      ...(sink === undefined ? {} : { sink }),
    });
    calls += 1;
    promptChars += AUDIT_RUBRIC.length + body.length;
    if (result.latencyMs !== undefined) latencyMs = result.latencyMs;
    if (result.degraded || result.value === null) {
      lastFailure = "the model call degraded (see the diagnostics above)";
      break;
    }
    const bounds = auditBoundsFailure(result.value, expected);
    if (bounds === null) {
      return {
        audit: result.value,
        degraded: false,
        failure: null,
        promptChars,
        calls,
        ...(latencyMs === undefined ? {} : { latencyMs }),
      };
    }
    lastFailure = bounds;
  }

  sink?.push(
    diag(
      "error",
      "eval.affordance_cues.audit.unusable",
      `contradiction audit for "${input.scenarioTitle}" is unusable after ${calls} call(s): ${lastFailure}`,
    ),
  );
  return {
    audit: null,
    degraded: true,
    failure: lastFailure,
    promptChars,
    calls,
    ...(latencyMs === undefined ? {} : { latencyMs }),
  };
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
narrator system. Same character, same player lines, same committed physical state. Per exchange you
also get the committed physical state the scene had already fixed.

Pick the transcript you would rather read as a player ("preferred": "A", "B" or "tie") and say why
in one sentence. Judge on whether the physical detail is truthful to the committed state, concrete
rather than generic, carried in action and voice rather than announced, and not re-stated from one
exchange to the next. Do not judge on length or flourish, and do not reward a transcript for saying
more about the character's appearance than the scene calls for.

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
    code: "eval.affordance_cues.preference",
    ...(input.sink === undefined ? {} : { sink: input.sink }),
  });
  return {
    verdict: result.value,
    degraded: result.degraded,
    promptChars: PREFERENCE_RUBRIC.length + prompt.length,
    ...(result.latencyMs === undefined ? {} : { latencyMs: result.latencyMs }),
  };
}
