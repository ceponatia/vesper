import { z } from "zod";
import { generateChecked } from "@/server/ai";
import type { DiagnosticSink } from "@/contracts/diagnostics";

/**
 * Arm-blind absolute audit for the garment narrator comparison.
 *
 * Each arm is judged alone. A comparative judge cannot produce an honest
 * contradiction or repetition rate because it anchors every score against the
 * other transcript; the closed affordance campaign already demonstrated that
 * failure mode. Quotes are required for every counted defect and the runner
 * verifies them against the transcript before including them in the summary.
 */

const verdictSchema = z.enum(["violated", "clean", "not_applicable"]);
export type GarmentAuditVerdict = z.infer<typeof verdictSchema>;

const exchangeAuditSchema = z.object({
  exchange: z.number().int().min(1),
  stateConsistency: verdictSchema,
  visibilityAndCoverage: verdictSchema,
  adoptedFalsePremise: verdictSchema,
  quoteStateConsistency: z.string().max(500).default(""),
  quoteVisibilityAndCoverage: z.string().max(500).default(""),
  quoteAdoptedFalsePremise: z.string().max(500).default(""),
});
export type GarmentExchangeAudit = z.infer<typeof exchangeAuditSchema>;

const quotedFindingSchema = z.object({
  exchange: z.number().int().min(1),
  quote: z.string().max(500),
  why: z.string().max(500),
});

export const garmentArmAuditSchema = z.object({
  exchanges: z.array(exchangeAuditSchema).min(1).max(12),
  repetitions: z.array(quotedFindingSchema).max(20).default([]),
  staticRestatements: z.array(quotedFindingSchema).max(20).default([]),
  concreteDetail: z.number().int().min(1).max(5),
  naturalness: z.number().int().min(1).max(5),
});
export type GarmentArmAudit = z.infer<typeof garmentArmAuditSchema>;

const AUDIT_SYSTEM = `You are auditing ONE transcript from a scripted character scene. You are not comparing two
versions and you are not rewriting the prose. For each exchange, the committed wardrobe state is the
source of truth. Count only claims the narrator actually made; silence is not a contradiction.

For every exchange return these verdicts:

- stateConsistency: "violated" when the reply contradicts an authoritative garment fact — wrong garment,
  wrong wearer/location, wrong side or part, wrong closure/roll/tuck state, wrong wetness/cleanliness/crease/wear
  band, or a deposit/damage mark that is absent or placed elsewhere. "clean" when it makes a garment claim that
  agrees. "not_applicable" when it makes no garment-state claim.
- visibilityAndCoverage: "violated" when the reply describes a hidden/covered garment part as visible, treats a
  doffed or room-located garment as worn, or infers exposed body coverage the state does not support. "clean" when
  it makes such a claim accurately. Otherwise "not_applicable".
- adoptedFalsePremise: the player may assert a garment fact that the committed state says is false. "violated"
  only when the narrator accepts or builds on that false claim; correcting, sidestepping or stating the truth is
  clean. When no false premise is present or the reply ignores garments, use "not_applicable".

Every "violated" verdict MUST include a verbatim quote from that exchange's narrator reply in the matching quote
field. Leave the quote empty for clean/not_applicable. A quote the harness cannot find is discarded.

Then judge the transcript as a whole:

- repetitions: the same garment detail re-announced on consecutive exchanges even though the committed state did
  not change. Quote the later occurrence. Do not count a necessary correction or a detail newly relevant to an action.
- staticRestatements: stable clothing recited as fresh description rather than used as continuity guard. Quote it.
- concreteDetail 1-5: 1 generic/vague or wrong; 3 plausible but weakly anchored; 5 precise garment/part/state detail
  woven into the action. A scene with no reason to mention clothes should receive 3 rather than being punished for silence.
- naturalness 1-5: 1 reads like a status report; 3 acceptable but inert/listy; 5 feels like ordinary prose and the
  clothing detail never announces the underlying state system.

Return exactly one exchange entry for every numbered exchange shown.`;

export interface GarmentAuditExchangeInput {
  index: number;
  player: string;
  groundTruth: string;
  reply: string;
}

export interface AuditGarmentArmInput {
  scenarioTitle: string;
  premise: string;
  characterName: string;
  playerName: string;
  exchanges: readonly GarmentAuditExchangeInput[];
  modelId: string;
  sink?: DiagnosticSink;
}

export interface AuditGarmentArmResult {
  audit: GarmentArmAudit | null;
  degraded: boolean;
  failure: string | null;
  calls: number;
  promptChars: number;
}

export function garmentAuditPrompt(input: AuditGarmentArmInput): string {
  const lines = [
    `Scene: ${input.scenarioTitle}`,
    `Premise: ${input.premise}`,
    `Character: ${input.characterName}. Player: ${input.playerName}.`,
    "",
  ];
  for (const exchange of input.exchanges) {
    lines.push(
      `=== EXCHANGE ${exchange.index} ===`,
      "COMMITTED WARDROBE STATE:",
      exchange.groundTruth,
      "",
      `PLAYER: ${exchange.player}`,
      "",
      `NARRATOR REPLY ${exchange.index}:`,
      exchange.reply.trim(),
      "",
    );
  }
  return lines.join("\n");
}

function boundsFailure(audit: GarmentArmAudit, expected: readonly number[]): string | null {
  const seen = audit.exchanges.map((entry) => entry.exchange);
  const missing = expected.filter((index) => !seen.includes(index));
  const unexpected = seen.filter((index) => !expected.includes(index));
  const duplicated = seen.filter((index, at) => seen.indexOf(index) !== at);
  const failures = [
    missing.length ? `missing [${missing.join(",")}]` : "",
    unexpected.length ? `invented [${unexpected.join(",")}]` : "",
    duplicated.length ? `duplicated [${duplicated.join(",")}]` : "",
  ].filter(Boolean);
  return failures.length ? failures.join("; ") : null;
}

/** One repair attempt on a structurally valid answer that skipped/invented exchanges. */
export async function auditGarmentArm(input: AuditGarmentArmInput): Promise<AuditGarmentArmResult> {
  const expected = input.exchanges.map((exchange) => exchange.index);
  const basePrompt = garmentAuditPrompt(input);
  let calls = 0;
  let promptChars = 0;
  let lastFailure = "no attempt";

  for (let attempt = 0; attempt < 2; attempt += 1) {
    const correction =
      attempt === 0
        ? ""
        : `\nYour previous answer had invalid exchange coverage (${lastFailure}). Return exactly: ${expected.join(", ")}.`;
    const prompt = `${basePrompt}${correction}`;
    const result = await generateChecked({
      schema: garmentArmAuditSchema,
      system: AUDIT_SYSTEM,
      prompt,
      modelId: input.modelId,
      temperature: 0,
      maxOutputTokens: 5_000,
      code: "eval.garment_cues.audit",
      ...(input.sink ? { sink: input.sink } : {}),
    });
    calls += 1;
    promptChars += AUDIT_SYSTEM.length + prompt.length;
    if (result.degraded || result.value === null) {
      return {
        audit: null,
        degraded: true,
        failure: "judge model call degraded",
        calls,
        promptChars,
      };
    }
    const bounds = boundsFailure(result.value, expected);
    if (bounds === null) {
      return { audit: result.value, degraded: false, failure: null, calls, promptChars };
    }
    lastFailure = bounds;
  }

  return {
    audit: null,
    degraded: true,
    failure: `judge failed exchange bounds after repair: ${lastFailure}`,
    calls,
    promptChars,
  };
}
