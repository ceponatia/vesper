import {
  assertNoResolverOnlyLeak,
  hairClaim,
  type DiagnosticSink,
  type HairClaimArea,
  type NarratorPhysicalGuidance,
  type PhysicalNarrationConstraint,
  type PhysicalPremiseCorrection,
} from "@/contracts";

/**
 * PROMPT PROJECTION for narrator physical guidance
 * (narrator-physical-guidance.plan.md §Architecture 7).
 *
 * One selected candidate → one imperative line. The renderer owns wording and owns
 * nothing else: it may not add a semantic the compiler did not select, may not
 * reorder the tiers, and may not upgrade a prohibition into an invitation.
 *
 * Four rules hold the register, and each of them is a failure the trial actually
 * measured or the plan explicitly forbids:
 *
 * 1. **A constraint is a fence, never a prompt to describe.** "Do not describe X as
 *    Y" contains no instruction to mention anything, so a constraint-only turn cannot
 *    make the narrator reach for a body detail it would otherwise have left alone —
 *    which is exactly how the closed positive-cue experiment raised the number of
 *    checkable claims.
 * 2. **A correction never states the truth aloud.** It names the claim not to adopt
 *    and stops. The committed truth rides the candidate (`truthCodes`) for the
 *    inspector and the eval harness, and is deliberately absent from the prose: the
 *    cause may be hidden, and "actually it was a bath" both leaks it and invites the
 *    narrator to argue with the player.
 * 3. **A constraint's truth clause ships only when perception licensed it.** That
 *    decision is already made — `allowedClaimCodes` is empty unless every locus was
 *    visible (`buildConstraintCandidates`) — so this file simply renders what is
 *    there. Empty means the line ends at the prohibition.
 * 4. **Silence beats an unsafe prompt.** The leak check runs first, and any error
 *    diagnostic means the whole block is dropped rather than partially rendered.
 *
 * The block also states its own precedence, because the prompt it joins already
 * carries a general sensory allowance that can read as forbidding what a fence
 * requires: rule 10's "no appearance description" and a binding "do not describe her
 * hair as loose" are about different things, and the narrator has to be told which
 * governs.
 *
 * Slice 2 renders two tiers. Action outcomes (slice 3) and state transitions (slice
 * 4) have their contracts and their selection tiers already, but no producer in this
 * lane and therefore no wording here — the slices that add the producers add the
 * lines, in the compiler's existing order.
 */

/** The block's heading. Distinct from every other prompt heading (plan §Architecture 7). */
export const PHYSICAL_GUIDANCE_BLOCK_HEADING = "Physical consistency for this exchange";

/**
 * The precedence sentence, first line under the heading. It exists because the
 * general allowances are worded as ceilings on DESCRIPTION while these are fences on
 * CLAIMS, and a model reading both without a ranking splits the difference.
 */
export const PHYSICAL_GUIDANCE_PRECEDENCE =
  "These rules override any general appearance or sensory-detail allowances for this exchange.";

export interface ChatPhysicalGuidanceRenderInput {
  readonly guidance: NarratorPhysicalGuidance;
  readonly characterName: string;
  /** How the lines name the subject — "Wren's". */
  readonly possessive: string;
  /** Leak diagnostics land here; the block is dropped either way. */
  readonly sink?: DiagnosticSink;
}

/**
 * How a correction's area is named, and what the narrator is told not to adopt the
 * claim AS.
 *
 * Per-area rather than one template, because each area answers a different question
 * about the same body part and a generic object ("as the state of her hair") reads as
 * vague in exactly the way an instruction must not: "do not adopt rain as the cause"
 * and "do not adopt loose as how her hair is worn" are the sentences that land.
 */
const AREA_WORDING: Readonly<Record<HairClaimArea, { readonly label: string; readonly object: (of: string) => string }>> =
  {
    wetness_degree: { label: "wetness", object: (of) => `how wet ${of} hair is` },
    wetness_cause: { label: "wetness-cause", object: (of) => `the cause of the wetness in ${of} hair` },
    arrangement: { label: "hairstyle", object: (of) => `how ${of} hair is worn` },
    motion: { label: "hair-motion", object: (of) => `what ${of} hair is doing` },
    coverage: { label: "coverage", object: (of) => `whether ${of} hair is covered` },
  };

/** The area a claim code belongs to, or `null` for a code this lane cannot word. */
function areaOf(code: string): HairClaimArea | null {
  return hairClaim(code)?.area ?? null;
}

/** The display phrases for a set of prohibited codes, in the candidate's own order. */
function prohibitedPhrases(constraint: PhysicalNarrationConstraint): readonly string[] {
  return constraint.prohibitedClaimCodes.flatMap((code) => {
    const phrase = hairClaim(code)?.display;
    return phrase === undefined ? [] : [phrase];
  });
}

/** The committed-truth clauses perception licensed, in the candidate's own order. */
function truthClauses(constraint: PhysicalNarrationConstraint): readonly string[] {
  return constraint.allowedClaimCodes.flatMap((code) => {
    const clause = hairClaim(code)?.truth;
    return clause === undefined ? [] : [clause];
  });
}

/**
 * One constraint line.
 *
 * Returns "" when no prohibited code is wordable — a fence nobody can read is not a
 * fence, and an empty bullet in a binding block is worse than a missing one.
 */
function constraintLine(constraint: PhysicalNarrationConstraint, possessive: string): string {
  const prohibited = prohibitedPhrases(constraint);
  if (prohibited.length === 0) return "";
  // The truth clause rides the SAME sentence, after a semicolon: a separate sentence
  // reads as a new instruction, and this half is a qualification of the fence.
  const truth = truthClauses(constraint);
  const clause = truth.length === 0 ? "" : `; ${truth.join("; ")}`;
  return `- Binding constraint: do not describe ${possessive} hair as ${joinPhrases(prohibited)}${clause}.`;
}

/** One correction line. Names the claim not to adopt; never the truth behind it. */
function correctionLine(correction: PhysicalPremiseCorrection, input: ChatPhysicalGuidanceRenderInput): string {
  const claim = hairClaim(correction.claimCode);
  const area = areaOf(correction.claimCode);
  if (claim === undefined || area === null) return "";
  const wording = AREA_WORDING[area];
  if (correction.verdict === "unsupported") {
    return (
      `- Premise check: the player's ${wording.label} claim (${claim.display}) is not established in the story. ` +
      "Do not treat it as fact; leave it unconfirmed rather than inventing detail."
    );
  }
  return (
    `- Premise check: the player's ${wording.label} claim conflicts with committed state. ` +
    `Do not adopt ${claim.display} as ${wording.object(input.possessive)}. ` +
    `Do not correct the player aloud unless ${input.characterName} would naturally do so.`
  );
}

/**
 * "a, b, or c" — the prohibition register, so a list reads as one forbidden idea.
 *
 * The `or` is skipped when the final phrase already carries one: a display phrase may
 * itself be a list ("cascading, streaming, or whipping"), and "loose, or cascading,
 * streaming, or whipping" reads as two alternatives rather than four.
 */
function joinPhrases(phrases: readonly string[]): string {
  if (phrases.length <= 1) return phrases[0] ?? "";
  const last = phrases[phrases.length - 1] ?? "";
  const head = phrases.slice(0, -1).join(", ");
  return last.includes(" or ") ? `${head}, ${last}` : `${head}, or ${last}`;
}

/**
 * Render the selected guidance as prompt lines, in the compiler's order.
 *
 * Returns `[]` when there is nothing to say — and also when the leak check finds a
 * resolver-only candidate, because at that point the safe output is no block at all
 * (`docs/resilience.md`: degraded defaults over failed turns; the caller's contract
 * from `assertNoResolverOnlyLeak` is to drop the guidance, never to throw).
 */
export function renderChatPhysicalGuidance(input: ChatPhysicalGuidanceRenderInput): readonly string[] {
  const leaks = assertNoResolverOnlyLeak(input.guidance);
  if (leaks.length > 0) {
    for (const leak of leaks) input.sink?.push(leak);
    return [];
  }
  return [
    // Tier order is the compiler's, not this file's: corrections are about the message
    // in front of the narrator, constraints are standing truths about the body.
    ...input.guidance.corrections.map((correction) => correctionLine(correction, input)),
    ...input.guidance.constraints.map((constraint) => constraintLine(constraint, input.possessive)),
  ].filter((line) => line.length > 0);
}

/**
 * The whole block, heading and precedence included — or "" when nothing is selected.
 *
 * The prompt builder calls this so the block's shape lives in ONE place; the
 * length-guard discipline (absent/empty ⇒ zero bytes) is the caller's, and it is what
 * keeps a flag-off prompt byte-identical.
 */
export function chatPhysicalGuidanceBlock(lines: readonly string[] | undefined): string {
  const armed = (lines ?? []).map((line) => line.trim()).filter((line) => line.length > 0);
  if (armed.length === 0) return "";
  return [`${PHYSICAL_GUIDANCE_BLOCK_HEADING}:`, PHYSICAL_GUIDANCE_PRECEDENCE, ...armed].join("\n");
}
