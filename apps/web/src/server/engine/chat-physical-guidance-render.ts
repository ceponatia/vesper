import {
  assertNoResolverOnlyLeak,
  hairClaim,
  type DiagnosticSink,
  type HairClaimArea,
  type NarratorPhysicalGuidance,
  type PhysicalActionOutcome,
  type PhysicalNarrationConstraint,
  type PhysicalPremiseCorrection,
  type PhysicalStateTransition,
} from "@/contracts";
import {
  chatContactPhrase,
  type ChatContactPhraseKind,
  type ChatContactUnresolvedPremise,
} from "./chat-contact-adapter";
import { CHAT_CONTACT_DOMAIN_ID, CHAT_CONTACT_ENDED_CODE } from "./chat-permission-guidance";

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
 * 4. **Silence beats an unsafe prompt.** `assertNoResolverOnlyLeak` runs first over the
 *    COMPILED guidance, and any error it returns drops the whole block rather than
 *    rendering it partially. That check is the only thing this file fails closed on —
 *    deliberately not `guidance.diagnostics`, which is a different question. The
 *    compile-time gate is per-candidate: a `guidance.disclosure.invalid` error there
 *    means one candidate was already suppressed, and its valid siblings — including a
 *    slice-3 mandatory action outcome that says whether contact happened — must still
 *    reach the prompt. An error in the guidance is a report about a candidate that is
 *    gone; an error from the leak check is a candidate still here that should not be.
 *
 * The block also states its own precedence, because the prompt it joins already
 * carries a general sensory allowance that can read as forbidding what a fence
 * requires: rule 10's "no appearance description" and a binding "do not describe her
 * hair as loose" are about different things, and the narrator has to be told which
 * governs.
 *
 * All four tiers render today. **Action outcomes** arrived with the affectionate
 * contact proof (romantic-contact-affordances.plan.md §"Continuation order" 1) and
 * lead the block, which is the compiler's own order rather than this file's: whether
 * the touch the player just wrote actually happened outranks any standing truth about
 * the body. **State transitions** gained their first producer with the permission
 * owner's revocation handoff (romantic-contact-affordances.spec.permission.md
 * §"Revocation during active contact" step 4, `chat-permission-guidance.ts`): a
 * contact the state already ENDED that the prose has not yet shown ending. Each such
 * candidate is a binding stop — it states the observable change only (never the
 * standing record, the withdrawal, or any developer control behind it), forbids
 * continuing or resuming the touch, is phrased to stay correct when the prior reply's
 * prose already showed the stop, and leaves the player's reaction alone. One line per
 * candidate, always: an ensemble reply can end contact on several pairs at once, and
 * merging them into a sentence about everyone present would end contacts nothing
 * ended, so a multi-pair revocation ships one line per pair (the tier's budget covers
 * a whole exchange's worth for exactly that reason).
 *
 * The outcome lines obey the same four rules, and rule 1 is the one worth spelling out
 * for them. A COMMITTED outcome is the only positive statement this block ever makes,
 * and it is not an invitation: it states what is true, fences the denial of it, and
 * explicitly leaves the other person's response alone. "Do not narrate it as missed"
 * carries no instruction to describe anything, and how a character answers a hand on
 * her shoulder is a character choice this layer has no business proposing.
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
  /**
   * This turn's unresolved-contact premise (`chatContactUnresolvedPremise`),
   * when the contact leg produced one. Presentation only: the attempt it words
   * stayed `unresolved` — no row, no fold, no acknowledgment — and this line
   * fences the PROSE from inventing the landing the state refused to record.
   */
  readonly unresolvedPremise?: ChatContactUnresolvedPremise;
  /**
   * Display names for transition participants, keyed by subject id — the
   * roster's names plus the player entry ("player" → "the player"). Presentation
   * only, supplied by the pipeline when stop transitions are in play; a
   * transition whose participants this map cannot name renders the generic stop
   * line rather than a sentence with a hole in it.
   */
  readonly subjectNames?: Readonly<Record<string, string>>;
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
 * The wordable clauses of one action outcome, bucketed by what they are about.
 *
 * Codes stay opaque to this file exactly as claim codes do: the contact lane owns the
 * vocabulary and `chatContactPhrase` is the only door onto it, so a code this lane
 * cannot word costs a clause rather than corrupting a sentence. Duplicates collapse —
 * two requirement codes can legitimately share one phrase ("the distance would have to
 * be closed first"), and saying it twice reads as two different obstacles.
 */
type OutcomePhrases = Readonly<Record<ChatContactPhraseKind, readonly string[]>>;

function outcomePhrases(outcome: PhysicalActionOutcome): OutcomePhrases {
  const buckets: Record<ChatContactPhraseKind, string[]> = {
    gesture: [],
    locus: [],
    material: [],
    blocked: [],
    requirement: [],
  };
  for (const code of outcome.resultCodes) {
    const phrase = chatContactPhrase(code);
    if (phrase === undefined) continue;
    const bucket = buckets[phrase.kind];
    if (!bucket.includes(phrase.phrase)) bucket.push(phrase.phrase);
  }
  return buckets;
}

/**
 * A contact that happened: present-tense truth, then the denial it forecloses.
 *
 * The final clause is load-bearing and is the reason this line is not an invitation.
 * The contact is settled; the other person's answer to it is a character choice, and a
 * block that stated the contact and then went quiet would read as a prompt to write
 * that answer a particular way.
 *
 * Returns "" when the gesture or the surface has no wording. A committed outcome is not
 * mandatory (`guidanceActionMustResolve`), so an unwordable one is silence rather than
 * a sentence with a hole in it.
 */
function committedOutcomeLine(phrases: OutcomePhrases, input: ChatPhysicalGuidanceRenderInput): string {
  const gesture = phrases.gesture[0];
  const locus = phrases.locus[0];
  if (gesture === undefined || locus === undefined) return "";
  const material = phrases.material[0];
  return (
    `- Physical fact: the player's hand ${gesture} ${input.possessive} ${locus}` +
    `${material === undefined ? "" : `, ${material}`}. ` +
    "That contact is true right now — do not narrate it as missed, refused, or still being attempted. " +
    `How ${input.characterName} responds to it is not decided here.`
  );
}

/**
 * An attempt that did not land — the one line this block MUST ship.
 *
 * Unlike every other line here it never returns "": a refusal or a required transition
 * that fell out of the prompt is exactly how prose invents contact that never happened,
 * which is why the selection tier gives action outcomes no budget in the first place.
 * So each clause degrades on its own, and the sentence survives with whatever it has.
 */
function blockedOutcomeLine(phrases: OutcomePhrases, input: ChatPhysicalGuidanceRenderInput): string {
  const locus = phrases.locus[0];
  const reason = [...phrases.blocked, ...phrases.requirement][0];
  const reach =
    locus === undefined
      ? "the player's attempted touch does not land"
      : `the player's hand does not reach ${input.possessive} ${locus}`;
  return (
    `- Blocked contact: ${reach}${reason === undefined ? "" : ` — ${reason}`}. ` +
    "The narration must account for that; do not write the touch as landing."
  );
}

/**
 * One action-outcome line.
 *
 * `unresolved` renders NOTHING, by contract rather than by omission: the resolver could
 * not decide, and the correct output for a world that did not answer is silence — an
 * explanation of why it is unsure would be the layer narrating its own gaps.
 * `partially_committed` has no producer in this lane (contact either exists on a
 * surface pair or does not), so it has no wording either.
 */
function actionOutcomeLine(outcome: PhysicalActionOutcome, input: ChatPhysicalGuidanceRenderInput): string {
  const phrases = outcomePhrases(outcome);
  switch (outcome.status) {
    case "committed":
      return committedOutcomeLine(phrases, input);
    case "rejected":
    case "explicit_transition_required":
      return blockedOutcomeLine(phrases, input);
    case "unresolved":
    case "partially_committed":
      return "";
  }
}

/**
 * The unresolved-contact line — presentation for the unresolved cases that earn
 * any (`chatContactUnresolvedPremise`).
 *
 * Each states its own gap and the inventions it forecloses, and nothing else.
 * Neither says "too far apart", "across the room", or anything about a refusal:
 * those are positive facts the scene does not own, and the reasons that do own
 * them (`out_of_reach`, `permission_denied`, `permission_withdrawn`, the
 * reposition requirements) render through `blockedOutcomeLine` instead. The
 * underlying attempt stays `unresolved` in both cases — these lines exist
 * precisely because silence was letting the prose depict the landing anyway.
 *
 * The PERMISSION line is the harder one to word, and the difficulty is the
 * point. The contact system's standing law is that something unknown is not
 * something denied, so this line has to foreclose the landing WITHOUT
 * manufacturing the refusal nobody recorded. It therefore fences both
 * directions and says so — not landed, not refused — and hands the turn a third
 * option (leave it unsettled) so the model is not forced to pick one of the two
 * it was just told not to write. It also never mentions permission, consent, a
 * record, or a decision: naming the mechanic would leak the ledger the
 * disclosure rule keeps out of the prompt, and would imply a ruling that does
 * not exist.
 *
 * What it deliberately does NOT do is script the character's reaction. The
 * target's response to a gesture is hers, and a line that told the narrator how
 * to deflect would be this layer writing her behaviour.
 */
function unresolvedPremiseLine(premise: ChatContactUnresolvedPremise): string {
  const surface = premise.locus === undefined ? premise.targetName : `${premise.targetName}'s ${premise.locus}`;
  if (premise.kind === "reach") {
    return (
      `- Unestablished reach: the current scene does not establish that the player's hand can reach ${surface}. ` +
      "Do not depict that touch as landing, and do not invent movement by either participant to make it land."
    );
  }
  return (
    `- Unestablished contact: the current scene does not establish that the player's touch on ${surface} happens. ` +
    "Do not depict it as landing or as already having landed. " +
    "Do not depict it as refused, blocked, resisted, or unwelcome either — neither outcome is established. " +
    "Write the reply so it settles neither: respond to the attempt without confirming the contact."
  );
}

/**
 * The one wording every stop line ends on. Three obligations in one sentence,
 * each traceable to the spec's narrator-instruction constraints (§"Revocation
 * during active contact"): the continuation ban ("do not write it as
 * continuing…"), the idempotent portrayal instruction ("if the stop has not
 * already been shown…" — still correct when the prior reply's prose showed it),
 * and the authorship fence (the player's response is never decided here). The
 * NPC's own reaction is explicitly licensed and never scripted.
 */
const STOP_LINE_CLOSING =
  "That contact is over now — do not write it as continuing, resuming, or still in progress. " +
  "If the stop has not already been shown, portray it naturally (an in-character reaction is fine); " +
  "do not decide how the player responds.";

/**
 * One revocation stop transition (`chat-permission-guidance.ts`) as a binding line.
 *
 * OBSERVABLE CHANGE ONLY: the line names who is no longer touching what and
 * what the narration must do about it. It never mentions why — no standing
 * record, no withdrawal, no developer control, no mechanic vocabulary — because
 * the candidate carries no cause (`causeCodes` is empty by law) and this file
 * adds no semantic the compiler did not select.
 *
 * Degrades toward the instruction, not away from it: an unnamed participant or
 * an unwordable locus costs precision, never the stop itself. A transition from
 * any OTHER producer (a different domain, or codes this lane does not own)
 * renders nothing — wording it here would invent a semantic for a candidate
 * this file cannot understand.
 */
function transitionLine(transition: PhysicalStateTransition, input: ChatPhysicalGuidanceRenderInput): string {
  if (transition.domainId !== CHAT_CONTACT_DOMAIN_ID) return "";
  if (!transition.afterCodes.includes(CHAT_CONTACT_ENDED_CODE)) return "";
  const [actorId, targetId] = transition.subjectIds;
  const actorName = actorId === undefined ? undefined : input.subjectNames?.[String(actorId)];
  const targetName = targetId === undefined ? undefined : input.subjectNames?.[String(targetId)];
  if (actorName === undefined || targetName === undefined) {
    return `- Ended contact: a touch that was underway has ended. ${STOP_LINE_CLOSING}`;
  }
  const locusPhrases = transition.locusIds.flatMap((locusId) => {
    const phrase = chatContactPhrase(`contact.locus.${locusId}`);
    return phrase === undefined ? [] : [phrase.phrase];
  });
  // One wordable surface names it; several (or none) fall back to the person —
  // "no longer touching Wren" is still the whole instruction.
  const [onlyLocus] = locusPhrases;
  const surface =
    locusPhrases.length === 1 && onlyLocus !== undefined ? `${targetName}'s ${onlyLocus}` : targetName;
  return `- Ended contact: ${actorName} is no longer touching ${surface}. ${STOP_LINE_CLOSING}`;
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
 * non-allowlisted candidate in the COMPILED guidance, because at that point the safe
 * output is no block at all (`docs/resilience.md`: degraded defaults over failed turns;
 * the caller's contract from `assertNoResolverOnlyLeak` is to drop the guidance, never
 * to throw).
 *
 * `input.guidance.diagnostics` is deliberately not consulted. A compile-time disclosure
 * error names a candidate the gate ALREADY removed, and dropping the block over it would
 * discard the valid siblings that survived — the exact behaviour slice 3 cannot have.
 */
export function renderChatPhysicalGuidance(input: ChatPhysicalGuidanceRenderInput): readonly string[] {
  const leaks = assertNoResolverOnlyLeak(input.guidance);
  if (leaks.length > 0) {
    for (const leak of leaks) input.sink?.push(leak);
    return [];
  }
  return [
    // Tier order is the compiler's, not this file's: what the player's own act actually
    // did outranks everything, corrections are about the message in front of the
    // narrator, and constraints are standing truths about the body. The unresolved
    // premise rides with the action tier — it is about the act the player just wrote —
    // and renders where the unresolved outcome it accompanies renders nothing.
    ...input.guidance.actionOutcomes.map((outcome) => actionOutcomeLine(outcome, input)),
    ...(input.unresolvedPremise === undefined ? [] : [unresolvedPremiseLine(input.unresolvedPremise)]),
    ...input.guidance.corrections.map((correction) => correctionLine(correction, input)),
    ...input.guidance.constraints.map((constraint) => constraintLine(constraint, input.possessive)),
    // The transition tier renders last — the compiler's order, not a ranking
    // this file invented. Today's only producer is the revocation stop.
    ...input.guidance.transitions.map((transition) => transitionLine(transition, input)),
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
