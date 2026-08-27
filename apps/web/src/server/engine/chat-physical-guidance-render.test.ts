import { describe, expect, it } from "vitest";
import {
  affordanceSubjectId,
  buildActionOutcome,
  compileNarratorPhysicalGuidance,
  DiagnosticCollector,
  emptyNarratorPhysicalGuidance,
  guidanceFingerprint,
  GUIDANCE_DISCLOSURE_INVALID,
  GUIDANCE_DISCLOSURE_LEAK,
  HAIR_CLAIM_ARRANGEMENT_BRAID,
  HAIR_CLAIM_ARRANGEMENT_LOOSE,
  HAIR_CLAIM_CAUSE_RAIN,
  HAIR_CLAIM_COVERAGE_UNCOVERED,
  HAIR_CLAIM_MOTION_FREE_FLOW,
  HAIR_CLAIM_WETNESS_SOAKED,
  type GuidanceDisclosure,
  type NarratorPhysicalGuidance,
  type PhysicalActionOutcome,
  type PhysicalActionStatus,
  type PhysicalNarrationConstraint,
  type PhysicalPremiseCorrection,
  type PhysicalStateTransition,
} from "@/contracts";
import { CHAT_CONTACT_DOMAIN_ID, CHAT_CONTACT_ENDED_CODE } from "./chat-permission-guidance";
import type { ChatContactUnresolvedPremise } from "./chat-contact-adapter";
import {
  chatPhysicalGuidanceBlock,
  renderChatPhysicalGuidance,
  PHYSICAL_GUIDANCE_BLOCK_HEADING,
  PHYSICAL_GUIDANCE_PRECEDENCE,
} from "./chat-physical-guidance-render";

/**
 * The prompt projection for narrator physical guidance.
 *
 * Wording is the whole subject here, so the tests read the produced sentences rather
 * than structure — and the two that matter most are negative: a constraint-only turn
 * must carry no instruction to mention a body detail (the closed cue experiment's
 * failure mode), and a correction must never voice the truth behind it (the disclosure
 * law, and the reason the player is not argued with).
 */

const NAME = "Wren";
const POSSESSIVE = "Wren's";

function constraint(input: {
  prohibited: readonly string[];
  allowed?: readonly string[];
  disclosure?: GuidanceDisclosure;
}): PhysicalNarrationConstraint {
  return {
    id: "hair.bulk_restraint:bound:hair",
    subjectIds: [affordanceSubjectId("character_wren")],
    domainId: "hair",
    locusIds: ["hair"],
    prohibitedClaimCodes: [...input.prohibited],
    allowedClaimCodes: [...(input.allowed ?? [])],
    disclosure: input.disclosure ?? "consistency_only",
    priority: "high",
    evidence: [],
    fingerprint: guidanceFingerprint(["constraint", ...input.prohibited, ...(input.allowed ?? [])]),
  };
}

function correction(input: {
  claimCode: string;
  verdict?: PhysicalPremiseCorrection["verdict"];
  truthCodes?: readonly string[];
}): PhysicalPremiseCorrection {
  const verdict = input.verdict ?? "contradicted";
  return {
    id: `hair:probe:${input.claimCode}:${verdict}`,
    source: "ordinary_player_narration",
    claimCode: input.claimCode,
    verdict,
    truthCodes: [...(input.truthCodes ?? [])],
    disclosure: "consistency_only",
    evidence: [],
    fingerprint: guidanceFingerprint(["correction", input.claimCode, verdict]),
  };
}

/**
 * One action outcome, through the real `buildActionOutcome` seam so the
 * `narratorMustResolve` floor and the fingerprint are the production ones.
 */
function outcome(input: {
  status: PhysicalActionStatus;
  resultCodes: readonly string[];
}): PhysicalActionOutcome {
  return buildActionOutcome({
    actionId: "contact:msg_1#player:character_wren:shoulders",
    status: input.status,
    resultCodes: input.resultCodes,
    disclosure: "consistency_only",
  });
}

function guidanceOf(input: {
  constraints?: readonly PhysicalNarrationConstraint[];
  corrections?: readonly PhysicalPremiseCorrection[];
  actionOutcomes?: readonly PhysicalActionOutcome[];
  transitions?: readonly PhysicalStateTransition[];
}): NarratorPhysicalGuidance {
  return {
    ...emptyNarratorPhysicalGuidance(),
    constraints: input.constraints ?? [],
    corrections: input.corrections ?? [],
    actionOutcomes: input.actionOutcomes ?? [],
    transitions: input.transitions ?? [],
  };
}

/**
 * One revocation stop transition, as `chat-permission-guidance.ts` produces
 * them — the transition tier's only producer in this lane.
 */
function stopTransition(overrides: Partial<PhysicalStateTransition> = {}): PhysicalStateTransition {
  const identity = "permission-stop:permission-reply:msg_reply_1:player->char_wren";
  return {
    id: identity,
    subjectIds: [affordanceSubjectId("player"), affordanceSubjectId("char_wren")],
    domainId: CHAT_CONTACT_DOMAIN_ID,
    locusIds: ["shoulders"],
    beforeCodes: ["contact.locus.shoulders"],
    afterCodes: [CHAT_CONTACT_ENDED_CODE],
    causeCodes: [],
    relevance: "action",
    disclosure: "positive_detail_allowed",
    repeatKey: identity,
    evidence: [],
    fingerprint: guidanceFingerprint(["permission-stop", identity]),
    ...overrides,
  };
}

/**
 * A SECOND pair's stop, as one ensemble reply produces when its decisions end
 * contact on two pairs at once — the case the transition budget used to eat.
 */
function secondPairStopTransition(): PhysicalStateTransition {
  const identity = "permission-stop:permission-reply:msg_reply_1:char_mira->char_wren";
  return stopTransition({
    id: identity,
    subjectIds: [affordanceSubjectId("char_mira"), affordanceSubjectId("char_wren")],
    repeatKey: identity,
    fingerprint: guidanceFingerprint(["permission-stop", identity]),
  });
}

/** The subject names the pipeline supplies when a stop is in play. */
const STOP_NAMES: Readonly<Record<string, string>> = { player: "the player", char_wren: NAME };

const render = (guidance: NarratorPhysicalGuidance, sink?: DiagnosticCollector) =>
  renderChatPhysicalGuidance({
    guidance,
    characterName: NAME,
    possessive: POSSESSIVE,
    ...(sink === undefined ? {} : { sink }),
  });

describe("the unresolved-premise line", () => {
  const premiseRender = (premise: ChatContactUnresolvedPremise, guidance = guidanceOf({})) =>
    renderChatPhysicalGuidance({
      guidance,
      characterName: NAME,
      possessive: POSSESSIVE,
      unresolvedPremise: premise,
    });

  it("states the unestablished reach with the target's name and surface, and the two forbidden inventions", () => {
    const lines = premiseRender({ kind: "reach", targetName: "Sabrina", locus: "shoulder" });
    expect(lines).toEqual([
      "- Unestablished reach: the current scene does not establish that the player's hand can reach Sabrina's shoulder. " +
        "Do not depict that touch as landing, and do not invent movement by either participant to make it land.",
    ]);
  });

  it("falls back to the target's name alone when the surface has no wording", () => {
    const lines = premiseRender({ kind: "reach", targetName: "Sabrina" });
    expect(lines[0]).toContain("can reach Sabrina.");
  });

  it("claims only the gap — never a distance, a refusal, or a movement", () => {
    const line = premiseRender({ kind: "reach", targetName: "Sabrina", locus: "shoulder" })[0] ?? "";
    for (const positiveFact of ["across the room", "far apart", "pulls away", "refused", "too far"]) {
      expect(line.toLowerCase()).not.toContain(positiveFact);
    }
  });

  it("rides beside the unresolved outcome's silence, after the action tier", () => {
    const lines = renderChatPhysicalGuidance({
      guidance: guidanceOf({
        actionOutcomes: [
          outcome({
            status: "unresolved",
            resultCodes: ["contact.locus.shoulders", "contact.unresolved.geometry_unavailable"],
          }),
        ],
      }),
      characterName: NAME,
      possessive: POSSESSIVE,
      unresolvedPremise: { kind: "reach", targetName: "Sabrina", locus: "shoulder" },
    });
    // The unresolved outcome still renders nothing of its own; only the premise ships.
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("Unestablished reach");
  });

  it("absent premise renders the exact lines it always rendered", () => {
    expect(render(guidanceOf({}))).toEqual([]);
  });

  /**
   * The permission line, and the two obligations that only look like one.
   *
   * The 2026-08-18 romantic proof found that an unanswered permission owner
   * rendered NOTHING, so the reply described the caress as landing. Closing that
   * with the obvious wording — "that has not been allowed", the phrase
   * `permission_denied` already uses — would trade a false landing for a false
   * REFUSAL, asserting a decision the character never made.
   *
   * Reading "do not invent a refusal" as "do not depict a refusal" is the
   * mistake this suite exists to prevent, and it is not cosmetic. The NPC
   * permission decision leg reads the COMMITTED REPLY, so the character
   * declining in prose is the only route by which `attempt_denied` ever reaches
   * the ledger — and a first advance is unanswered by definition, because no
   * grant exists yet. A line that forbade the refusal would therefore make the
   * denial path unreachable and leave the character no way to refuse anything.
   *
   * So the line is graded on three separable things: it forecloses the landing,
   * it asserts no refusal of its own while explicitly leaving refusal open as
   * HERS, and it names no mechanic.
   */
  describe("the permission line — unknown is not denied, without gagging her", () => {
    const line = () => premiseRender({ kind: "permission", targetName: "Sabrina", locus: "shoulder" })[0] ?? "";

    it("forecloses the landing and nothing else", () => {
      expect(line()).toBe(
        "- Unestablished contact: the current scene does not establish that the player's touch on Sabrina's shoulder happens. " +
          "Do not depict it as landing or as already having landed, and do not invent movement by either participant to make it land. " +
          "How Sabrina answers the attempt is Sabrina's own to decide — welcoming it, ignoring it, or refusing it outright are all open. " +
          "The one thing not open is narrating the touch as completed.",
      );
    });

    /**
     * The agency clause, asserted on its own so it cannot be quietly dropped by
     * a future tightening of the wording. Without it the character can never say
     * no to a first advance.
     */
    it("leaves refusing open as the character's own choice", () => {
      expect(line()).toContain("refusing it outright");
      expect(line()).toContain("is Sabrina's own to decide");
    });

    it("asserts no refusal of its own, and names no mechanic behind the gap", () => {
      const lowered = line().toLowerCase();
      for (const leak of ["permission", "consent", "allowed", "record", "ledger", "granted"]) {
        expect(lowered).not.toContain(leak);
      }
      // The renderer never states that a refusal HAPPENED, only that one is open.
      for (const asserted of ["has been refused", "she refuses", "was refused", "is unwelcome", "pulls away"]) {
        expect(lowered).not.toContain(asserted);
      }
    });
  });
});

describe("constraint lines", () => {
  it("renders the plan's worked line, truth clause included, when perception licensed it", () => {
    const lines = render(
      guidanceOf({
        constraints: [
          constraint({
            prohibited: [HAIR_CLAIM_ARRANGEMENT_LOOSE, HAIR_CLAIM_MOTION_FREE_FLOW],
            allowed: [HAIR_CLAIM_ARRANGEMENT_BRAID],
          }),
        ],
      }),
    );
    expect(lines).toEqual([
      "- Binding constraint: do not describe Wren's hair as loose, cascading, streaming, or whipping; it remains secured in a braid.",
    ]);
  });

  it("drops the truth clause when nothing licensed it — the fence does not explain itself", () => {
    const lines = render(
      guidanceOf({ constraints: [constraint({ prohibited: [HAIR_CLAIM_MOTION_FREE_FLOW] })] }),
    );
    expect(lines).toEqual([
      "- Binding constraint: do not describe Wren's hair as cascading, streaming, or whipping.",
    ]);
    // Nothing about a bath, a hood, or how wet the hair is: the hidden state stays out.
    expect(lines.join(" ")).not.toMatch(/soaked|braid|bath|hood|covered/iu);
  });

  it("names each prohibited claim it can word, and skips a code it cannot", () => {
    const lines = render(
      guidanceOf({ constraints: [constraint({ prohibited: [HAIR_CLAIM_COVERAGE_UNCOVERED, "some.other.domain"] })] }),
    );
    expect(lines).toEqual(["- Binding constraint: do not describe Wren's hair as uncovered."]);
  });

  it("renders nothing for a constraint with no wordable prohibition", () => {
    expect(render(guidanceOf({ constraints: [constraint({ prohibited: ["some.other.domain"] })] }))).toEqual([]);
  });

  it("a constraint-only turn contains no instruction to mention a body detail", () => {
    const lines = render(
      guidanceOf({
        constraints: [
          constraint({
            prohibited: [HAIR_CLAIM_ARRANGEMENT_LOOSE, HAIR_CLAIM_MOTION_FREE_FLOW],
            allowed: [HAIR_CLAIM_ARRANGEMENT_BRAID],
          }),
        ],
      }),
    );
    const text = chatPhysicalGuidanceBlock(lines);
    // The failure this asserts against is the closed cue experiment's: a block that
    // invites a physical detail raises the number of checkable claims.
    for (const invitation of [
      "you may",
      "mention",
      "weave",
      "include",
      "offer",
      "describe it",
      "worth noticing",
      "if the moment",
    ]) {
      expect(text.toLowerCase(), invitation).not.toContain(invitation);
    }
    // The only imperative about describing is a prohibition.
    expect(text).toContain("do not describe");
  });
});

describe("action-outcome lines", () => {
  it("states a committed contact as present-tense truth, and forecloses only its denial", () => {
    const lines = render(
      guidanceOf({
        actionOutcomes: [
          outcome({
            status: "committed",
            resultCodes: ["contact.locus.shoulders", "contact.gesture.rest", "contact.material.direct"],
          }),
        ],
      }),
    );
    expect(lines).toEqual([
      "- Physical fact: the player's hand rests on Wren's shoulder. " +
        "That contact is true right now — do not narrate it as missed, refused, or still being attempted. " +
        "How Wren responds to it is not decided here.",
    ]);
  });

  it("says there is cloth between when there is, and stays quiet when there is not", () => {
    const [through] = render(
      guidanceOf({
        actionOutcomes: [
          outcome({
            status: "committed",
            resultCodes: ["contact.locus.arms", "contact.gesture.rest", "contact.material.through"],
          }),
        ],
      }),
    );
    expect(through).toContain("rests on Wren's arm, through the cloth over it.");
    // `contact.material.direct` has no wording: "skin to skin" would be this block
    // volunteering a positive detail, which is the one thing it never does.
    const [direct] = render(
      guidanceOf({
        actionOutcomes: [
          outcome({
            status: "committed",
            resultCodes: ["contact.locus.arms", "contact.gesture.rest", "contact.material.direct"],
          }),
        ],
      }),
    );
    expect(direct).not.toMatch(/skin|bare/iu);
  });

  it("words every gesture the lane can detect", () => {
    for (const [code, phrase] of [
      ["contact.gesture.rest", "rests on Wren's head"],
      ["contact.gesture.pat", "pats Wren's head"],
      ["contact.gesture.squeeze", "closes lightly around Wren's head"],
    ] as const) {
      const [line] = render(
        guidanceOf({ actionOutcomes: [outcome({ status: "committed", resultCodes: ["contact.locus.head", code] })] }),
      );
      expect(line, code).toContain(phrase);
    }
  });

  it("a committed contact is not an invitation to describe anything", () => {
    const text = chatPhysicalGuidanceBlock(
      render(
        guidanceOf({
          actionOutcomes: [
            outcome({ status: "committed", resultCodes: ["contact.locus.shoulders", "contact.gesture.rest"] }),
          ],
        }),
      ),
    );
    for (const invitation of ["you may", "mention", "weave", "include", "offer", "worth noticing", "if the moment"]) {
      expect(text.toLowerCase(), invitation).not.toContain(invitation);
    }
    // And it never proposes the other person's answer — that is a character choice.
    expect(text).toContain("not decided here");
  });

  it("makes a refusal mandatory, and names the reason when it can word one", () => {
    const lines = render(
      guidanceOf({
        actionOutcomes: [
          outcome({ status: "rejected", resultCodes: ["contact.locus.shoulders", "contact.blocked.out_of_reach"] }),
        ],
      }),
    );
    expect(lines).toEqual([
      "- Blocked contact: the player's hand does not reach Wren's shoulder — they are too far apart for it. " +
        "The narration must account for that; do not write the touch as landing.",
    ]);
  });

  it("words a required transition as the thing that would have to happen first", () => {
    const [line] = render(
      guidanceOf({
        actionOutcomes: [
          outcome({
            status: "explicit_transition_required",
            resultCodes: ["contact.locus.arms", "contact.requires.reposition"],
          }),
        ],
      }),
    );
    expect(line).toContain("the distance would have to be closed first");
    expect(line).toContain("do not write the touch as landing");
  });

  it("still ships a blocked line when it can word neither the surface nor the reason", () => {
    // An outcome with no budget must never vanish: a refusal that fell out of the
    // prompt is exactly how prose invents contact that never happened.
    const lines = render(guidanceOf({ actionOutcomes: [outcome({ status: "rejected", resultCodes: [] })] }));
    expect(lines).toEqual([
      "- Blocked contact: the player's attempted touch does not land. " +
        "The narration must account for that; do not write the touch as landing.",
    ]);
  });

  it("renders NOTHING for an unresolved outcome — the resolver did not decide", () => {
    const lines = render(
      guidanceOf({
        actionOutcomes: [
          outcome({
            status: "unresolved",
            resultCodes: ["contact.locus.shoulders", "contact.unresolved.geometry_unavailable"],
          }),
        ],
      }),
    );
    expect(lines).toEqual([]);
    expect(chatPhysicalGuidanceBlock(lines)).toBe("");
  });

  it("drops a committed outcome it cannot word rather than half-stating it", () => {
    expect(render(guidanceOf({ actionOutcomes: [outcome({ status: "committed", resultCodes: [] })] }))).toEqual([]);
  });

  it("renders action outcomes ahead of corrections and constraints", () => {
    const lines = render(
      guidanceOf({
        constraints: [constraint({ prohibited: [HAIR_CLAIM_MOTION_FREE_FLOW] })],
        corrections: [correction({ claimCode: HAIR_CLAIM_CAUSE_RAIN })],
        actionOutcomes: [
          outcome({ status: "committed", resultCodes: ["contact.locus.shoulders", "contact.gesture.rest"] }),
        ],
      }),
    );
    expect(lines[0]).toContain("Physical fact");
    expect(lines[1]).toContain("Premise check");
    expect(lines[2]).toContain("Binding constraint");
  });
});

describe("correction lines", () => {
  it("names the claim not to adopt, and never the committed truth behind it", () => {
    const lines = render(
      guidanceOf({
        corrections: [correction({ claimCode: HAIR_CLAIM_CAUSE_RAIN, truthCodes: ["hair.cause.immersion"] })],
      }),
    );
    expect(lines).toEqual([
      "- Premise check: the player's wetness-cause claim conflicts with committed state. " +
        "Do not adopt rain as the cause of the wetness in Wren's hair. " +
        "Do not correct the player aloud unless Wren would naturally do so.",
    ]);
    // The truth rides the candidate for the inspector; voicing it would both leak a
    // hidden cause and invite the narrator to argue with the player.
    expect(lines.join(" ")).not.toMatch(/immersion|bath|actually/iu);
  });

  it("words an unsupported claim as unestablished, and supplies no alternative", () => {
    const lines = render(
      guidanceOf({ corrections: [correction({ claimCode: HAIR_CLAIM_WETNESS_SOAKED, verdict: "unsupported" })] }),
    );
    expect(lines).toEqual([
      "- Premise check: the player's wetness claim (soaked) is not established in the story. " +
        "Do not treat it as fact; leave it unconfirmed rather than inventing detail.",
    ]);
    expect(lines.join(" ")).not.toContain("conflicts with committed state");
  });

  it("words every area it can be asked about", () => {
    for (const code of [
      HAIR_CLAIM_WETNESS_SOAKED,
      HAIR_CLAIM_CAUSE_RAIN,
      HAIR_CLAIM_ARRANGEMENT_LOOSE,
      HAIR_CLAIM_MOTION_FREE_FLOW,
      HAIR_CLAIM_COVERAGE_UNCOVERED,
    ]) {
      const [line] = render(guidanceOf({ corrections: [correction({ claimCode: code })] }));
      expect(line, code).toMatch(/^- Premise check: the player's \S+ claim conflicts with committed state\./u);
      expect(line, code).toContain("Wren's hair");
    }
  });

  it("renders nothing for a claim code this lane cannot word", () => {
    expect(render(guidanceOf({ corrections: [correction({ claimCode: "some.other.domain" })] }))).toEqual([]);
  });
});

describe("order, safety, and the block", () => {
  it("renders corrections before constraints — the compiler's own selection order", () => {
    const lines = render(
      guidanceOf({
        constraints: [constraint({ prohibited: [HAIR_CLAIM_MOTION_FREE_FLOW] })],
        corrections: [correction({ claimCode: HAIR_CLAIM_CAUSE_RAIN })],
      }),
    );
    expect(lines[0]).toContain("Premise check");
    expect(lines[1]).toContain("Binding constraint");
  });

  it("renders NOTHING when a resolver-only candidate leaked, and files the error", () => {
    const sink = new DiagnosticCollector();
    const leaked = guidanceOf({
      constraints: [
        constraint({ prohibited: [HAIR_CLAIM_MOTION_FREE_FLOW], disclosure: "resolver_only" }),
        constraint({ prohibited: [HAIR_CLAIM_COVERAGE_UNCOVERED] }),
      ],
      corrections: [correction({ claimCode: HAIR_CLAIM_CAUSE_RAIN })],
    });
    // The WHOLE block goes, not just the offender: degraded silence over an unsafe
    // prompt (docs/resilience.md), and never a thrown turn.
    expect(render(leaked, sink)).toEqual([]);
    const leak = sink.items.find((item) => item.code === GUIDANCE_DISCLOSURE_LEAK);
    expect(leak?.severity).toBe("error");
  });

  it("renders NOTHING for a disclosure outside the vocabulary either — no renderer change needed", () => {
    const sink = new DiagnosticCollector();
    // The value a lane adapter's parse could hand over; the cast is confined to this
    // test because the compile-time union is exactly what the runtime gate distrusts.
    const rogue = {
      ...constraint({ prohibited: [HAIR_CLAIM_MOTION_FREE_FLOW] }),
      disclosure: "narrator_prompt_allowed",
    } as unknown as PhysicalNarrationConstraint;

    expect(render(guidanceOf({ constraints: [rogue] }), sink)).toEqual([]);
    // Drop-the-block-on-any-LEAK-CHECK-error is what makes the broadened gate free here:
    // the renderer never learned a second rule, it just kept obeying the first one. Note
    // what this fixture does that a compiled one cannot — it puts the bad value INTO
    // guidance the compiler already gated, i.e. post-compile mutation.
    const invalid = sink.items.find((item) => item.code === GUIDANCE_DISCLOSURE_INVALID);
    expect(invalid?.severity).toBe("error");
    expect(invalid?.context).toMatchObject({ kind: "constraint", disclosure: "narrator_prompt_allowed" });
  });

  it("still renders the valid siblings of a candidate the COMPILER suppressed", () => {
    // The other half of the disclosure law, and the distinction the two layers turn on:
    // a compile-time `guidance.disclosure.invalid` error means one candidate was
    // suppressed, NOT that the block is unsafe. The renderer keys off
    // `assertNoResolverOnlyLeak` over the compiled guidance — never off
    // `guidance.diagnostics` — so what survived the gate still reaches the prompt.
    //
    // Slice 3 is why this matters: a mandatory action outcome carries whether contact
    // happened, and losing the block over an unrelated mangled constraint would hand
    // that question back to the narrator to invent.
    const sink = new DiagnosticCollector();
    const rogue = {
      ...constraint({ prohibited: [HAIR_CLAIM_ARRANGEMENT_LOOSE] }),
      disclosure: "narrator_prompt_allowed",
    } as unknown as PhysicalNarrationConstraint;
    const guidance = compileNarratorPhysicalGuidance({
      constraints: [rogue, constraint({ prohibited: [HAIR_CLAIM_MOTION_FREE_FLOW] })],
      corrections: [correction({ claimCode: HAIR_CLAIM_CAUSE_RAIN })],
      sink,
    });

    // The compile really did report the error — this is not a fixture that dodged it.
    expect(guidance.diagnostics.filter((item) => item.severity === "error")).toHaveLength(1);
    expect(guidance.diagnostics[0]?.code).toBe(GUIDANCE_DISCLOSURE_INVALID);

    const lines = render(guidance);
    expect(lines).toEqual([
      "- Premise check: the player's wetness-cause claim conflicts with committed state. " +
        "Do not adopt rain as the cause of the wetness in Wren's hair. " +
        "Do not correct the player aloud unless Wren would naturally do so.",
      "- Binding constraint: do not describe Wren's hair as cascading, streaming, or whipping.",
    ]);
    expect(chatPhysicalGuidanceBlock(lines)).toContain(PHYSICAL_GUIDANCE_BLOCK_HEADING);
    // The suppressed candidate's own wording is the one thing that must not appear.
    expect(lines.join(" ")).not.toContain("loose");
  });

  it("empty guidance renders no lines and no block", () => {
    expect(render(emptyNarratorPhysicalGuidance())).toEqual([]);
    expect(chatPhysicalGuidanceBlock([])).toBe("");
    expect(chatPhysicalGuidanceBlock(undefined)).toBe("");
    expect(chatPhysicalGuidanceBlock(["", "   "])).toBe("");
  });

  it("the block leads with its heading and its precedence sentence", () => {
    const block = chatPhysicalGuidanceBlock(["- one", "- two"]);
    expect(block.split("\n")).toEqual([
      `${PHYSICAL_GUIDANCE_BLOCK_HEADING}:`,
      PHYSICAL_GUIDANCE_PRECEDENCE,
      "- one",
      "- two",
    ]);
    // The precedence sentence exists because the same prompt carries a general sensory
    // allowance that can read as forbidding what a fence requires.
    expect(PHYSICAL_GUIDANCE_PRECEDENCE).toContain("override");
  });
});

describe("the revocation stop line", () => {
  const stopRender = (transitions: readonly PhysicalStateTransition[], names: Readonly<Record<string, string>> | null = STOP_NAMES) =>
    renderChatPhysicalGuidance({
      guidance: guidanceOf({ transitions }),
      characterName: NAME,
      possessive: POSSESSIVE,
      ...(names === null ? {} : { subjectNames: names }),
    });

  /**
   * The narrator-instruction constraints as a word list: relationship
   * thresholds, permission records, developer overrides, and diagnostic detail
   * may NEVER surface.
   */
  const BANNED_VOCABULARY = [
    "permission",
    "grant",
    "policy",
    "override",
    "overridden",
    "revoke",
    "revoked",
    "revocation",
    "threshold",
    "withdraw",
    "withdrawn",
    "developer",
    "ledger",
    "record",
    "diagnostic",
    "standing",
    "invalidated",
  ];

  it("names the pair and the surface, and binds the stop", () => {
    const lines = stopRender([stopTransition()]);
    expect(lines).toEqual([
      "- Ended contact: the player is no longer touching Wren's shoulder. " +
        "That contact is over now — do not write it as continuing, resuming, or still in progress. " +
        "If the stop has not already been shown, portray it naturally (an in-character reaction is fine); " +
        "do not decide how the player responds.",
    ]);
  });

  it("explicitly forbids continuing or resuming the invalidated contact", () => {
    // The spec fixture "narrator output cannot continue invalidated contact":
    // the instruction half is this line; the behavioral half is prompt-level.
    const line = stopRender([stopTransition()])[0] ?? "";
    expect(line).toContain("do not write it as continuing, resuming, or still in progress");
  });

  it("is phrased to stay correct when the prior reply already showed the stop", () => {
    const line = stopRender([stopTransition()])[0] ?? "";
    expect(line).toContain("If the stop has not already been shown");
    // And it never claims the stop is new information or scripts the moment.
    expect(line.toLowerCase()).not.toMatch(/just now|suddenly|for the first time/u);
  });

  it("never exposes policy internals — the banned vocabulary stays out", () => {
    const named = stopRender([stopTransition()]).join(" ").toLowerCase();
    const generic = stopRender([stopTransition()], null).join(" ").toLowerCase();
    const multiLocus = stopRender([stopTransition({ locusIds: ["shoulders", "hair"] })]).join(" ").toLowerCase();
    for (const banned of BANNED_VOCABULARY) {
      expect(named, banned).not.toContain(banned);
      expect(generic, banned).not.toContain(banned);
      expect(multiLocus, banned).not.toContain(banned);
    }
  });

  it("does not author the player's reaction and does not script the NPC's", () => {
    const line = stopRender([stopTransition()])[0] ?? "";
    expect(line).toContain("do not decide how the player responds");
    // The NPC's reaction is licensed, never specified.
    expect(line).toContain("an in-character reaction is fine");
    expect(line.toLowerCase()).not.toMatch(/she pulls|he pulls|flinch|recoil/u);
  });

  it("degrades to the generic stop when the participants cannot be named", () => {
    // No name map at all, and a map missing one side, both keep the instruction.
    for (const lines of [
      stopRender([stopTransition()], null),
      stopRender([stopTransition()], { player: "the player" }),
      stopRender([stopTransition({ subjectIds: [] })]),
    ]) {
      expect(lines).toHaveLength(1);
      expect(lines[0]).toContain("- Ended contact: a touch that was underway has ended.");
      expect(lines[0]).toContain("do not write it as continuing");
    }
  });

  it("falls back to the person alone for several loci, or an unwordable one", () => {
    const [several] = stopRender([stopTransition({ locusIds: ["shoulders", "hair"] })]);
    expect(several).toContain("is no longer touching Wren.");
    const [unwordable] = stopRender([stopTransition({ locusIds: ["feet"] })]);
    expect(unwordable).toContain("is no longer touching Wren.");
  });

  it("renders nothing for a transition from a domain this lane does not word", () => {
    expect(stopRender([stopTransition({ domainId: "hair" })])).toEqual([]);
    expect(stopRender([stopTransition({ afterCodes: ["hair.dried"] })])).toEqual([]);
  });

  it("renders after every other tier — the compiler's order", () => {
    const lines = render(
      guidanceOf({
        constraints: [constraint({ prohibited: [HAIR_CLAIM_MOTION_FREE_FLOW] })],
        transitions: [stopTransition()],
      }),
    );
    expect(lines[0]).toContain("Binding constraint");
    // Without the names map the stop still ships, generically.
    expect(lines[1]).toContain("Ended contact");
  });

  it("survives the shared gate and budget — a multi-pair revocation loses no stop", () => {
    // The ensemble case: one reply's decisions end contact on two pairs. Both
    // are binding, and the producer's emission window closes with the next
    // reply, so a pair the budget dropped would never be told to anyone
    // (chat-permission-guidance.ts §"Budget interaction").
    const sink = new DiagnosticCollector();
    const compiled = compileNarratorPhysicalGuidance({
      transitions: [stopTransition(), secondPairStopTransition()],
      sink,
    });
    expect(compiled.transitions).toHaveLength(2);
    expect(sink.items).toEqual([]);
    const lines = renderChatPhysicalGuidance({
      guidance: compiled,
      characterName: NAME,
      possessive: POSSESSIVE,
      subjectNames: { ...STOP_NAMES, char_mira: "Mira" },
    });
    // Two candidates, two lines — the renderer stays one line per candidate, and
    // each names its OWN pair rather than merging them into a claim about
    // everybody (which would end contacts nothing ended). Order inside the tier
    // is a fingerprint tie-break between two equally binding stops, so it is
    // deliberately not asserted.
    expect(lines).toHaveLength(2);
    for (const actor of ["the player", "Mira"]) {
      expect(lines).toContain(
        `- Ended contact: ${actor} is no longer touching Wren's shoulder. ` +
          "That contact is over now — do not write it as continuing, resuming, or still in progress. " +
          "If the stop has not already been shown, portray it naturally (an in-character reaction is fine); " +
          "do not decide how the player responds.",
      );
    }
    // The safety sweep holds for every line of a multi-pair block, not just one.
    const joined = lines.join(" ").toLowerCase();
    for (const banned of BANNED_VOCABULARY) expect(joined, banned).not.toContain(banned);
  });

  it("drops the block when a stop transition's disclosure was tampered post-compile", () => {
    const sink = new DiagnosticCollector();
    const tampered = {
      ...stopTransition(),
      disclosure: "resolver_only",
    } as unknown as PhysicalStateTransition;
    expect(stopRender([tampered], STOP_NAMES)).toEqual([]);
    const renderedWithSink = renderChatPhysicalGuidance({
      guidance: guidanceOf({ transitions: [tampered] }),
      characterName: NAME,
      possessive: POSSESSIVE,
      subjectNames: STOP_NAMES,
      sink,
    });
    expect(renderedWithSink).toEqual([]);
    expect(sink.items.some((item) => item.code === GUIDANCE_DISCLOSURE_LEAK)).toBe(true);
  });
});

