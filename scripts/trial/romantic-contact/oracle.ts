import { z } from "zod";
import { generateChecked } from "@/server/ai";
import type { DiagnosticSink } from "@/contracts/diagnostics";

/**
 * The grading oracle for the romantic contact rollout rerun
 * (`docs/developer-notes/romantic-contact-affordances.trial.romantic-proof.md`).
 *
 * The first proof was graded by reading the replies. That was enough to find the
 * headline finding but not to SETTLE it: "the prose still described the caress
 * as landing" is a judgement somebody made once, by eye, and the rollout ruling
 * now turns on whether it still happens. So the grading is split in two, and the
 * split is the whole design.
 *
 * 1. **`gradeContactCase` is the oracle** — pure, total, and the only thing that
 *    decides pass or fail. It compares what the exchange RECORDED against what
 *    the prose DEPICTED and names the contradiction. It calls no model, so its
 *    verdicts are reproducible and its rules are readable in one screen.
 * 2. **`judgeContactReply` is only perception** — one arm-blind model call that
 *    reads a reply and reports what it depicts, with a verbatim quote for every
 *    positive claim. It never sees the recorded state, so it cannot be led to
 *    the answer, and every quote is verified against the reply text before the
 *    oracle is allowed to see it (`verifyQuotes`) — a hallucinated quote is
 *    discarded with its claim, exactly as the affordance-cues audit does it.
 *
 * The two failures the owner named are the two the oracle exists to reject:
 *
 * - **A false landing** — the state committed nothing, and the prose wrote the
 *   touch as having happened. This is the gap the proof found, and it is what
 *   the neutral `permission_unresolved` guidance is supposed to close.
 * - **A material contradiction** — the state committed the contact and the prose
 *   contradicts a fact it recorded: the layer between hand and skin (the proof's
 *   own observed mismatch — narration through a shirt over a recorded direct
 *   skin contact), a contact narrated as continuing after the exchange ended it,
 *   or a refusal narrated that nobody recorded.
 *
 * That last one is the asymmetry worth stating plainly. Under the contact
 * system's unknown-is-not-denied law an unanswered permission owner licenses
 * NEITHER outcome, so on those cases the oracle rejects an invented refusal on
 * exactly the same footing as an invented landing. Where a refusal genuinely IS
 * recorded — an explicit denial, a withdrawal — portraying it is correct and the
 * oracle says nothing.
 */

// ---------------------------------------------------------------------------
// What the exchange recorded
// ---------------------------------------------------------------------------

/**
 * The state half of one graded case, derived from the turn's own record and the
 * before/after projection — never from the case's intent.
 *
 * Deriving it from the intent is the mistake that would make this instrument
 * worthless: a case labelled "should refuse" that silently committed would then
 * be graded against the refusal it was supposed to produce, and the oracle would
 * confirm a bug instead of catching one.
 */
export interface ContactCaseState {
  /** Did this exchange durably record the touch? */
  readonly committed: boolean;
  /** What lay between hand and skin, AS RECORDED. Absent unless committed. */
  readonly layer?: ContactLayer;
  /**
   * Did anything actually refuse — a typed rejection the prose is entitled to
   * portray? True for an explicit denial, a withdrawal, a missing scope, an
   * out-of-reach refusal; false for every `unresolved` outcome, where nothing
   * was decided at all.
   */
  readonly refusalRecorded: boolean;
  /** Did this exchange end a contact that was live going in? */
  readonly endedLiveContact: boolean;
  /** Is any player↔character contact live once the exchange has settled? */
  readonly contactLiveAfter: boolean;
}

export type ContactLayer = "skin" | "through_layer";

// ---------------------------------------------------------------------------
// What the prose depicted
// ---------------------------------------------------------------------------

/** One thing a reply may or may not depict, with the words that show it. */
export interface ProseClaim {
  readonly depicted: boolean;
  /** Verbatim from the reply. Required whenever `depicted` — see `verifyQuotes`. */
  readonly quote?: string;
}

export interface ContactProseVerdict {
  /** The touch is written as having connected — completed, not merely attempted. */
  readonly landed: ProseClaim;
  /** The character is written as refusing, blocking, resisting, or preventing it. */
  readonly refused: ProseClaim;
  /** What the prose says is between the hand and the skin, if it says anything. */
  readonly layer: ContactLayer | "unstated";
  readonly layerQuote?: string;
  /** A touch is written as ongoing — still in progress, resumed, or continuing. */
  readonly continued: ProseClaim;
}

const claimSchema = z.object({
  depicted: z.boolean().catch(false),
  quote: z.string().trim().optional(),
});

const verdictSchema = z.object({
  landed: claimSchema,
  refused: claimSchema,
  layer: z.enum(["skin", "through_layer", "unstated"]).catch("unstated"),
  layerQuote: z.string().trim().optional(),
  continued: claimSchema,
});

// ---------------------------------------------------------------------------
// The oracle
// ---------------------------------------------------------------------------

export const CONTACT_FAILURES = [
  "false_landing",
  "false_refusal",
  "material_contradiction",
  "stale_continuation",
] as const;

export type ContactFailureKind = (typeof CONTACT_FAILURES)[number];

export interface ContactFailure {
  readonly kind: ContactFailureKind;
  /** One plain sentence naming the contradiction, for the trial record. */
  readonly detail: string;
  /** The reply's own words, when the judge supplied a verified quote. */
  readonly quote?: string;
}

export interface ContactCaseGrade {
  readonly pass: boolean;
  readonly failures: readonly ContactFailure[];
}

/**
 * Grade one case. PURE, total, and the only thing that decides pass or fail.
 *
 * Every rule is one-directional: it fires when the prose asserts something the
 * state does not support, never when the prose merely declines to assert
 * something the state does. A reply that commits a contact and then writes
 * around it is quiet, not wrong, and an oracle that demanded positive depiction
 * would be grading style.
 */
export function gradeContactCase(state: ContactCaseState, verdict: ContactProseVerdict): ContactCaseGrade {
  const failures: ContactFailure[] = [];

  // 1. The false landing — the finding the whole rerun exists to re-test.
  if (!state.committed && verdict.landed.depicted) {
    failures.push({
      kind: "false_landing",
      detail: "the exchange recorded no contact, and the reply wrote the touch as landing",
      ...(verdict.landed.quote === undefined ? {} : { quote: verdict.landed.quote }),
    });
  }

  // 2. The invented refusal — the failure the neutral guidance could have caused
  //    if it had been worded as a denial. Unknown is not denied, in the prose too.
  if (!state.refusalRecorded && verdict.refused.depicted) {
    failures.push({
      kind: "false_refusal",
      detail: "nothing refused this touch on the record, and the reply wrote the character refusing it",
      ...(verdict.refused.quote === undefined ? {} : { quote: verdict.refused.quote }),
    });
  }

  // 3. The material contradiction — the proof's own observed mismatch. Only a
  //    STATED layer contradicts; "unstated" is silence, which is always allowed.
  if (state.committed && state.layer !== undefined && verdict.layer !== "unstated" && verdict.layer !== state.layer) {
    failures.push({
      kind: "material_contradiction",
      detail: `the recorded contact was ${describeLayer(state.layer)}, and the reply wrote it as ${describeLayer(verdict.layer)}`,
      ...(verdict.layerQuote === undefined ? {} : { quote: verdict.layerQuote }),
    });
  }

  // 4. The stale continuation — a withdrawal that ended a live contact, written
  //    as though the contact were still happening.
  if (state.endedLiveContact && !state.contactLiveAfter && verdict.continued.depicted) {
    failures.push({
      kind: "stale_continuation",
      detail: "the exchange ended the contact, and the reply wrote it as still in progress",
      ...(verdict.continued.quote === undefined ? {} : { quote: verdict.continued.quote }),
    });
  }

  return { pass: failures.length === 0, failures };
}

function describeLayer(layer: ContactLayer): string {
  return layer === "skin" ? "direct skin contact" : "through a layer of clothing";
}

// ---------------------------------------------------------------------------
// Quote verification
// ---------------------------------------------------------------------------

/**
 * Drop every claim whose quote is not verbatim in the reply.
 *
 * A judge that invents a quote invents the finding it supports, and an oracle
 * fed invented findings reports failures that never happened — which on this
 * trial would be worse than reporting none, because the rollout ruling would be
 * made against fiction. So a positive claim with no quote, or with a quote the
 * reply does not contain, is demoted to `depicted: false` rather than trusted.
 *
 * Comparison collapses whitespace and folds case, because a model reproducing a
 * span across a line wrap is quoting correctly; it does not otherwise normalise,
 * so a paraphrase still fails.
 */
export function verifyQuotes(verdict: ContactProseVerdict, reply: string): ContactProseVerdict {
  const haystack = normalizeForQuote(reply);
  const check = (claim: ProseClaim): ProseClaim => {
    if (!claim.depicted) return { depicted: false };
    const quote = claim.quote?.trim() ?? "";
    if (quote.length === 0 || !haystack.includes(normalizeForQuote(quote))) return { depicted: false };
    return { depicted: true, quote };
  };
  const layerQuote = verdict.layerQuote?.trim() ?? "";
  const layerVerified = verdict.layer !== "unstated" && layerQuote.length > 0 && haystack.includes(normalizeForQuote(layerQuote));
  return {
    landed: check(verdict.landed),
    refused: check(verdict.refused),
    layer: layerVerified ? verdict.layer : "unstated",
    ...(layerVerified ? { layerQuote } : {}),
    continued: check(verdict.continued),
  };
}

function normalizeForQuote(text: string): string {
  return text.replace(/[‘’]/gu, "'").replace(/[“”]/gu, '"').replace(/\s+/gu, " ").trim().toLowerCase();
}

// ---------------------------------------------------------------------------
// Perception
// ---------------------------------------------------------------------------

/**
 * The judge's whole instruction. It is deliberately ignorant of contact,
 * permission, and the trial: it asks a reader what a passage depicts.
 *
 * Nothing here mentions what the state recorded, what the case was supposed to
 * prove, or that a system decided anything — because a judge told the expected
 * answer reports the expected answer. It is also told to treat an attempt as an
 * attempt: the player's own line always says a touch happened, and the question
 * is only ever whether the REPLY writes it as having connected.
 */
const JUDGE_RUBRIC = [
  "You read one passage of fiction and report what it depicts. You are not grading it.",
  "",
  "The passage is one character's reply in a scene where the other person has just written that they touch them.",
  "Answer only about the REPLY passage. Do not reason about what should have happened.",
  "",
  "Report five things:",
  '1. "landed" — does the reply depict the touch as having connected? Only a completed touch counts.',
  "   A touch that is only attempted, described from the toucher's intent, or left unaddressed is NOT landed.",
  '2. "refused" — does the reply depict the character refusing, blocking, resisting, pulling away from,',
  "   or otherwise preventing the touch? Discomfort or hesitation alone is not refusal; stopping it is.",
  '3. "layer" — if the reply says what is between the hand and the skin, is it "skin" (bare contact) or',
  '   "through_layer" (clothing, fabric, a sleeve)? If the reply does not say, answer "unstated".',
  '4. "continued" — does the reply depict a touch as ongoing: still in progress, resumed, or unbroken?',
  "5. A VERBATIM quote from the reply for every positive answer, copied exactly, no paraphrase.",
  "",
  "If you cannot supply an exact quote for a positive answer, answer false instead. A missing quote",
  "discards the finding, so guessing costs more than declining.",
  "",
  "Reply with JSON only.",
].join("\n");

export interface JudgeContactReplyInput {
  /** The reply text exactly as it was generated. */
  readonly reply: string;
  /** The player's line, for context only — never graded. */
  readonly playerLine: string;
  readonly modelId?: string;
  readonly sink?: DiagnosticSink;
}

export interface JudgeContactReplyResult {
  /** Null when the call degraded — the runner turns that into a non-zero exit. */
  readonly verdict: ContactProseVerdict | null;
  readonly degraded: boolean;
}

/**
 * One arm-blind reading of one reply, with every quote verified.
 *
 * A degraded call returns `null` rather than a permissive default. An oracle
 * that scored an unread reply as clean would report a pass for a turn nobody
 * graded, which is the one result this trial must never produce.
 */
export async function judgeContactReply(input: JudgeContactReplyInput): Promise<JudgeContactReplyResult> {
  const prompt = [
    "THE OTHER PERSON'S LINE (context only, do not grade it):",
    input.playerLine.trim(),
    "",
    "THE REPLY (grade only this):",
    input.reply.trim(),
  ].join("\n");

  const result = await generateChecked({
    schema: verdictSchema,
    system: JUDGE_RUBRIC,
    prompt,
    temperature: 0,
    maxOutputTokens: 2_000,
    code: "trial.romantic_contact.judge",
    ...(input.modelId === undefined ? {} : { modelId: input.modelId }),
    ...(input.sink === undefined ? {} : { sink: input.sink }),
  });

  if (result.degraded || result.value === null) return { verdict: null, degraded: true };
  return { verdict: verifyQuotes(result.value, input.reply), degraded: false };
}
