import { describe, expect, it } from "vitest";
import { affordanceSubjectId } from "../affordances/core";
import {
  activeRomanticPermissionGrants,
  foldRomanticPermissionProjection,
  type RomanticPermissionEvent,
} from "../affordances/permission";
import {
  buildRomanticPermissionDigest,
  groundRomanticPermissionEvidence,
  parseRomanticPermissionDecisionOutput,
  romanticPermissionDecisionTriggered,
  romanticPermissionEvidenceSentences,
  validateRomanticPermissionDecisions,
  ROMANTIC_PERMISSION_DECISION_CAP,
  type RomanticPermissionDecisionCandidate,
  type RomanticPermissionDigest,
  type ValidatedRomanticPermissionDecision,
} from "./romantic-permission-decision";

/**
 * The NPC-side romantic-permission decision contract
 * (romantic-contact-affordances.spec.permission.md §"Grant, denial, absence,
 * and withdrawal", §"Required fixtures and tests" — the Evidence and
 * authorship block; plan rulings 4, 5, 7).
 *
 * Adversarial and natural-language fixtures are REQUIRED here by the spec: the
 * first consent-classifier pass is expected to need refinement, and this suite
 * is the safety net that keeps refinement honest. The load-bearing claims:
 * evidence must ground verbatim in the reply's own dialogue/narration with an
 * absolute offset; only the granting NPC's own words or conduct can decide
 * (player echoes never); grants cannot be conditional, negated, questioned,
 * or restraint-phrased; withdrawal requires a standing grant; and everything
 * structurally ambiguous drops with a typed reason — the fail-closed
 * direction is always "less is granted".
 */

const PLAYER = affordanceSubjectId("player-subject");
const CHAT = "chat-1";

interface RosterSpec {
  readonly name: string;
  readonly aliases?: readonly string[];
}

function subjectOf(index: number) {
  return affordanceSubjectId(`char-${index}`);
}

function digestBuildOf(
  roster: readonly RosterSpec[],
  grants: readonly { readonly actor: "player" | number; readonly target: number }[] = [],
) {
  return buildRomanticPermissionDigest({
    playerSubjectId: PLAYER,
    roster: roster.map((member, index) => ({
      subjectId: subjectOf(index),
      name: member.name,
      aliases: member.aliases ?? [],
    })),
    standingGrants: grants.map((grant) => ({
      permittedActorId: grant.actor === "player" ? PLAYER : subjectOf(grant.actor),
      grantingTargetId: subjectOf(grant.target),
    })),
  });
}

function digestOf(
  roster: readonly RosterSpec[],
  grants: readonly { readonly actor: "player" | number; readonly target: number }[] = [],
): RomanticPermissionDigest {
  return digestBuildOf(roster, grants).digest;
}

function candidate(over: Partial<RomanticPermissionDecisionCandidate>): RomanticPermissionDecisionCandidate {
  return {
    kind: "granted",
    permittedActorRef: "player",
    grantingTargetRef: "npc_0",
    evidenceQuote: "",
    ...over,
  };
}

/** A minimal well-formed ledger event for fold-level assertions. */
function ledgerEvent(over: Partial<RomanticPermissionEvent>): RomanticPermissionEvent {
  return {
    eventId: "event-0",
    branchId: CHAT,
    permittedActorId: PLAYER,
    grantingTargetId: subjectOf(0),
    scope: "romantic_touch",
    kind: "granted",
    sourceKind: "npc_decision",
    storyTime: 0,
    orderInSource: 0,
    ...over,
  };
}

/** The server leg's ref→subject handle, in miniature (`chat-permission-decision.ts`). */
function subjectOfRef(ref: string) {
  return ref === "player" ? PLAYER : subjectOf(Number(ref.slice("npc_".length)));
}

/**
 * The accepted decisions as the rows the server would append — same order, same
 * `orderInSource`, same evidence offsets. Folding THESE is how a test asserts
 * what a reply actually leaves standing, rather than trusting the validator's
 * own summary of itself.
 */
function ledgerEventsOf(accepted: readonly ValidatedRomanticPermissionDecision[]): readonly RomanticPermissionEvent[] {
  return accepted.map((decision, index) =>
    ledgerEvent({
      eventId: `event-${index}`,
      kind: decision.kind,
      permittedActorId: subjectOfRef(decision.permittedActorRef),
      grantingTargetId: subjectOfRef(decision.grantingTargetRef),
      orderInSource: index,
      evidenceOffset: decision.evidenceOffset,
    }),
  );
}

// ---------------------------------------------------------------------------
// Digest
// ---------------------------------------------------------------------------

describe("buildRomanticPermissionDigest", () => {
  it("assigns npc refs in roster order and keeps the handles OUT of the digest", () => {
    const build = digestBuildOf([{ name: "Wren" }, { name: "Vaelith" }], [{ actor: "player", target: 0 }]);
    expect(build.digest.npcs.map((npc) => npc.ref)).toEqual(["npc_0", "npc_1"]);
    expect(build.digest.standingGrants).toEqual([{ permittedActorRef: "player", grantingTargetRef: "npc_0" }]);
    expect(build.handles.subjectIdByRef.get("npc_0")).toBe(subjectOf(0));
    expect(build.handles.subjectIdByRef.get("player")).toBe(PLAYER);
    expect(build.handles.refBySubjectId.get(subjectOf(1))).toBe("npc_1");
    // The digest itself carries no subject ids anywhere.
    expect(JSON.stringify(build.digest)).not.toContain("char-");
  });

  it("drops over-cap roster members AND names them", () => {
    const build = digestBuildOf([
      { name: "A" },
      { name: "B" },
      { name: "C" },
      { name: "D" },
      { name: "E" },
    ]);
    expect(build.digest.npcs).toHaveLength(4);
    expect(build.droppedRosterSubjectIds).toEqual([subjectOf(4)]);
  });

  it("drops (and counts) a standing grant whose participant is off the roster", () => {
    const build = digestBuildOf([{ name: "Wren" }], [{ actor: "player", target: 3 }]);
    expect(build.digest.standingGrants).toEqual([]);
    expect(build.droppedGrantCount).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// The trigger
// ---------------------------------------------------------------------------

describe("romanticPermissionDecisionTriggered", () => {
  it("fires on a spoken grant (cue and touch context in the same sentence)", () => {
    expect(romanticPermissionDecisionTriggered('"You can touch me," Mara says softly.')).toBe(true);
  });

  it("fires when the cue is dialogue and the touch context is same-line narration", () => {
    expect(romanticPermissionDecisionTriggered('"Not now," she murmurs, easing your hand away.')).toBe(true);
  });

  it("misses an ordinary reply with neither half", () => {
    expect(romanticPermissionDecisionTriggered("Wren smiles and pours the morning tea.")).toBe(false);
  });

  it("misses when the cue and the touch context sit on different lines", () => {
    expect(romanticPermissionDecisionTriggered('"You may."\n\nHer hands fold in her lap.')).toBe(false);
  });

  it("cannot fire from a thought span", () => {
    expect(romanticPermissionDecisionTriggered("*She would let you touch her hand* She pours the tea.")).toBe(false);
  });

  it("treats developer-command-shaped chat text as ordinary text — no fire without real touch context", () => {
    // `_` is a word character: `romantic_touch` never matches the touch regex.
    expect(romanticPermissionDecisionTriggered('"/permission grant player romantic_touch," she recites.')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Evidence geometry and grounding
// ---------------------------------------------------------------------------

describe("evidence geometry and grounding", () => {
  it("returns admissible sentences with absolute offsets that slice back out of the reply", () => {
    const reply = 'Mara sets down her cup.\n"You can touch me," Mara says softly.';
    for (const sentence of romanticPermissionEvidenceSentences(reply)) {
      expect(reply.slice(sentence.start, sentence.end)).toBe(sentence.text);
    }
    const kinds = romanticPermissionEvidenceSentences(reply).map((sentence) => sentence.kind);
    expect(kinds).toContain("narration");
    expect(kinds).toContain("speech");
  });

  it("grounds a quote at its absolute reply offset", () => {
    const reply = 'Mara sets down her cup.\n"You can touch me," Mara says softly.';
    const grounded = groundRomanticPermissionEvidence(reply, "You can touch me,");
    if (grounded.status !== "grounded") throw new Error("expected grounding");
    expect(grounded.grounding.start).toBe(reply.indexOf("You can touch me,"));
    expect(grounded.grounding.channel).toBe("speech");
  });

  it("refuses a quote found nowhere, and a quote found twice", () => {
    const reply = '"Touch me," Mara says. "Touch me," she repeats after a pause.';
    expect(groundRomanticPermissionEvidence(reply, "She seems willing")).toEqual({
      status: "dropped",
      reason: "evidence_ungrounded",
    });
    expect(groundRomanticPermissionEvidence(reply, "Touch me,")).toEqual({
      status: "dropped",
      reason: "evidence_ambiguous",
    });
  });

  it("cannot ground inside a thought span — a private thought is not an utterance", () => {
    const reply = "*I want him to touch me* She pours the tea in silence.";
    expect(groundRomanticPermissionEvidence(reply, "I want him to touch me")).toEqual({
      status: "dropped",
      reason: "evidence_ungrounded",
    });
  });
});

// ---------------------------------------------------------------------------
// Parse: absent vs malformed, item independence
// ---------------------------------------------------------------------------

describe("parseRomanticPermissionDecisionOutput", () => {
  const digest = digestOf([{ name: "Mara" }]);
  const valid = {
    kind: "granted",
    permittedActorRef: "player",
    grantingTargetRef: "npc_0",
    evidenceQuote: "You can touch me,",
  };

  it("an absent decision list is parsed-and-empty, in all three spellings — never malformed", () => {
    for (const raw of [{ version: 1 }, { version: 1, decisions: null }, { version: 1, decisions: [] }]) {
      const parse = parseRomanticPermissionDecisionOutput(digest, raw);
      expect(parse).toEqual({ status: "parsed", decisions: [] });
    }
  });

  it("parses a valid decision (object or JSON string input)", () => {
    for (const raw of [
      { version: 1, decisions: [valid] },
      JSON.stringify({ version: 1, decisions: [valid] }),
    ]) {
      const parse = parseRomanticPermissionDecisionOutput(digest, raw);
      if (parse.status !== "parsed") throw new Error("expected parsed");
      expect(parse.decisions).toEqual([{ status: "parsed", candidate: valid }]);
    }
  });

  it("refuses malformed envelopes: bad JSON, wrong version, unknown keys, non-array decisions, unbounded lists", () => {
    for (const raw of [
      "not json {",
      { version: 2, decisions: [] },
      { version: 1, decisions: [], extra: true },
      { version: 1, decisions: {} },
      { version: 1, decisions: Array.from({ length: 9 }, () => valid) },
    ]) {
      expect(parseRomanticPermissionDecisionOutput(digest, raw).status).toBe("malformed_envelope");
    }
  });

  it("a malformed item never erases its valid sibling — absent and malformed stay distinct outcomes", () => {
    const parse = parseRomanticPermissionDecisionOutput(digest, {
      version: 1,
      decisions: [{ ...valid, grantingTargetRef: "npc_7" }, valid],
    });
    if (parse.status !== "parsed") throw new Error("expected parsed");
    expect(parse.decisions.map((slot) => slot.status)).toEqual(["malformed", "parsed"]);
  });

  it("an unknown key makes the ITEM malformed (strict item schema)", () => {
    const parse = parseRomanticPermissionDecisionOutput(digest, {
      version: 1,
      decisions: [{ ...valid, sourceKind: "developer_override" }],
    });
    if (parse.status !== "parsed") throw new Error("expected parsed");
    expect(parse.decisions[0]?.status).toBe("malformed");
  });
});

// ---------------------------------------------------------------------------
// The deterministic validator
// ---------------------------------------------------------------------------

describe("validateRomanticPermissionDecisions", () => {
  const soleMara = digestOf([{ name: "Mara" }]);

  it("accepts an explicit NPC dialogue grant with a grounded absolute offset", () => {
    const reply = 'Mara sets down her cup and studies you.\n"You can touch me," Mara says softly.';
    const result = validateRomanticPermissionDecisions({
      reply,
      digest: soleMara,
      candidates: [candidate({ evidenceQuote: "You can touch me," })],
    });
    expect(result.drops).toEqual([]);
    expect(result.accepted).toEqual([
      {
        kind: "granted",
        permittedActorRef: "player",
        grantingTargetRef: "npc_0",
        evidenceOffset: reply.indexOf("You can touch me,"),
        evidenceQuote: "You can touch me,",
      },
    ]);
  });

  it("accepts unambiguous NPC-authored conduct that directly offers the contact", () => {
    const reply = "Mara takes your hand and guides it to rest against her waist, a silent invitation.";
    const result = validateRomanticPermissionDecisions({
      reply,
      digest: soleMara,
      candidates: [candidate({ evidenceQuote: reply })],
    });
    expect(result.accepted).toHaveLength(1);
    expect(result.accepted[0]?.evidenceOffset).toBe(0);
  });

  it("drops evidence the reply never states — paraphrased affection/arousal/silence has nothing to quote", () => {
    const reply = "Mara leans back, flushed, saying nothing as your hand rests on her arm.";
    const result = validateRomanticPermissionDecisions({
      reply,
      digest: soleMara,
      candidates: [
        candidate({ evidenceQuote: "She seems willing and aroused" }),
        candidate({ evidenceQuote: "Mara does not resist" }),
      ],
    });
    expect(result.accepted).toEqual([]);
    expect(result.drops.map((drop) => drop.reason)).toEqual(["evidence_ungrounded", "evidence_ungrounded"]);
  });

  it('"not now" is an attempt denial — and at fold level the standing grant survives it', () => {
    const reply = '"Not now," Mara murmurs, easing your hand away from her waist.';
    const result = validateRomanticPermissionDecisions({
      reply,
      digest: digestOf([{ name: "Mara" }], [{ actor: "player", target: 0 }]),
      candidates: [candidate({ kind: "attempt_denied", evidenceQuote: "Not now," })],
    });
    expect(result.accepted.map((accepted) => accepted.kind)).toEqual(["attempt_denied"]);

    // Fold-level: a prior grant plus this denial still projects a standing grant.
    const projection = foldRomanticPermissionProjection({
      events: [
        ledgerEvent({ eventId: "event-grant" }),
        ledgerEvent({ eventId: "event-denial", kind: "attempt_denied", storyTime: 1 }),
      ],
    });
    expect(activeRomanticPermissionGrants(projection)).toHaveLength(1);
  });

  it('"do not touch me like that anymore" withdraws — but ONLY against a standing grant in the digest', () => {
    const reply = '"Do not touch me like that anymore," Mara says, stepping out of reach.';
    const withdrawal = candidate({ kind: "withdrawn", evidenceQuote: "Do not touch me like that anymore," });

    const withStanding = validateRomanticPermissionDecisions({
      reply,
      digest: digestOf([{ name: "Mara" }], [{ actor: "player", target: 0 }]),
      candidates: [withdrawal],
    });
    expect(withStanding.accepted.map((accepted) => accepted.kind)).toEqual(["withdrawn"]);

    const withoutStanding = validateRomanticPermissionDecisions({
      reply,
      digest: soleMara,
      candidates: [withdrawal],
    });
    expect(withoutStanding.accepted).toEqual([]);
    expect(withoutStanding.drops.map((drop) => drop.reason)).toEqual(["no_standing_grant"]);
  });

  it("drops conditional offers — a maybe is not a grant", () => {
    const reply = `"If you behave, maybe I'll let you touch me," Mara teases.`;
    const result = validateRomanticPermissionDecisions({
      reply,
      digest: soleMara,
      candidates: [candidate({ evidenceQuote: "If you behave, maybe I'll let you touch me," })],
    });
    expect(result.accepted).toEqual([]);
    expect(result.drops.map((drop) => drop.reason)).toEqual(["evidence_conditional"]);
  });

  it("drops a negated 'grant' and a question-shaped one", () => {
    const negated = validateRomanticPermissionDecisions({
      reply: '"You may not touch me," Mara says evenly.',
      digest: soleMara,
      candidates: [candidate({ evidenceQuote: "You may not touch me," })],
    });
    expect(negated.drops.map((drop) => drop.reason)).toEqual(["evidence_negated"]);

    const question = validateRomanticPermissionDecisions({
      reply: '"Can I touch you?" Mara asks.',
      digest: soleMara,
      candidates: [candidate({ permittedActorRef: "npc_0", grantingTargetRef: "npc_0", evidenceQuote: "Can I touch you?" })],
    });
    // self_grant outranks the question here — assert with a player-permitted shape instead.
    const questionAsGrant = validateRomanticPermissionDecisions({
      reply: '"Can you touch me?" Mara asks.',
      digest: soleMara,
      candidates: [candidate({ evidenceQuote: "Can you touch me?" })],
    });
    expect(question.drops.map((drop) => drop.reason)).toEqual(["self_grant"]);
    expect(questionAsGrant.drops.map((drop) => drop.reason)).toEqual(["evidence_question"]);
  });

  it("drops restraint-phrased 'conduct' — force is never an offer", () => {
    const reply = "Mara grabs your wrist and drags your hand to her chest.";
    const result = validateRomanticPermissionDecisions({
      reply,
      digest: soleMara,
      candidates: [candidate({ evidenceQuote: reply })],
    });
    expect(result.drops.map((drop) => drop.reason)).toEqual(["evidence_restrained"]);
  });

  it("player-authored prose quoted in the reply cannot ground a grant (ruling 5)", () => {
    const reply = '"Mara lets you touch her whenever you want," you had written in the note.';
    const result = validateRomanticPermissionDecisions({
      reply,
      digest: soleMara,
      candidates: [candidate({ evidenceQuote: "Mara lets you touch her whenever you want," })],
    });
    expect(result.accepted).toEqual([]);
    expect(result.drops.map((drop) => drop.reason)).toEqual(["evidence_misattributed"]);
  });

  it('a granting target of "player" drops — the player is never a granting target', () => {
    const reply = '"You can touch me," Mara says.';
    const result = validateRomanticPermissionDecisions({
      reply,
      digest: soleMara,
      candidates: [
        candidate({ permittedActorRef: "npc_0", grantingTargetRef: "player", evidenceQuote: "You can touch me," }),
      ],
    });
    expect(result.drops.map((drop) => drop.reason)).toEqual(["target_player"]);
  });

  it("an NPC cannot grant themselves their own touch", () => {
    const result = validateRomanticPermissionDecisions({
      reply: '"You can touch me," Mara says.',
      digest: soleMara,
      candidates: [
        candidate({ permittedActorRef: "npc_0", grantingTargetRef: "npc_0", evidenceQuote: "You can touch me," }),
      ],
    });
    expect(result.drops.map((drop) => drop.reason)).toEqual(["self_grant"]);
  });

  it("an ensemble's unattributed dialogue proves no speaker; a sole NPC's bare line is hers", () => {
    const reply = '"Touch me."';
    const ensemble = validateRomanticPermissionDecisions({
      reply,
      digest: digestOf([{ name: "Wren" }, { name: "Vaelith" }]),
      candidates: [candidate({ evidenceQuote: "Touch me." })],
    });
    expect(ensemble.drops.map((drop) => drop.reason)).toEqual(["evidence_misattributed"]);

    const sole = validateRomanticPermissionDecisions({
      reply,
      digest: soleMara,
      candidates: [candidate({ evidenceQuote: "Touch me." })],
    });
    expect(sole.accepted).toHaveLength(1);
  });

  it("a bare dialogue line the NEXT line hands back to the player cannot ground a grant", () => {
    // The steer: get the narrator to echo the player's own words as a
    // standalone dialogue line, then re-attribute them one line later — where
    // a same-line-only authorship scan never looks.
    const reply = '"You can touch me."\nThat was what you had said, mimicking her voice.';
    const result = validateRomanticPermissionDecisions({
      reply,
      digest: soleMara,
      candidates: [candidate({ evidenceQuote: "You can touch me." })],
    });
    expect(result.accepted).toEqual([]);
    expect(result.drops.map((drop) => drop.reason)).toEqual(["evidence_misattributed"]);
  });

  it("a bare dialogue line the PREVIOUS line hands back to the player cannot ground a grant either", () => {
    const reply = 'You had told her exactly what to say.\n"You can touch me."';
    const result = validateRomanticPermissionDecisions({
      reply,
      digest: soleMara,
      candidates: [candidate({ evidenceQuote: "You can touch me." })],
    });
    expect(result.drops.map((drop) => drop.reason)).toEqual(["evidence_misattributed"]);
  });

  it("ordinary narration around a sole NPC's bare dialogue line still grants — the echo scan is not a blanket veto", () => {
    const reply = 'Mara sets down her cup.\n"You can touch me."\nHer hands stay open in her lap.';
    const result = validateRomanticPermissionDecisions({
      reply,
      digest: soleMara,
      candidates: [candidate({ evidenceQuote: "You can touch me." })],
    });
    expect(result.drops).toEqual([]);
    expect(result.accepted[0]?.evidenceOffset).toBe(reply.indexOf("You can touch me."));
  });

  it("bare pronoun narration re-attributed on the next line cannot ground a grant", () => {
    const reply = "She lets you rest your hand wherever you like.\nThat was what you had written for her, word for word.";
    const result = validateRomanticPermissionDecisions({
      reply,
      digest: soleMara,
      candidates: [candidate({ evidenceQuote: "She lets you rest your hand wherever you like." })],
    });
    expect(result.drops.map((drop) => drop.reason)).toEqual(["evidence_misattributed"]);
  });

  it("a pronoun alias cannot attribute another NPC's line — profile data never becomes a wildcard", () => {
    // `aliases` is player-authored: an alias of "she" would otherwise match the
    // attribution clause of ANY line and defeat ensemble misattribution.
    const pronounAlias = validateRomanticPermissionDecisions({
      reply: '"You can touch me," she says quietly.',
      digest: digestOf([{ name: "Wren", aliases: ["she"] }, { name: "Vaelith" }]),
      candidates: [candidate({ evidenceQuote: "You can touch me," })],
    });
    expect(pronounAlias.drops.map((drop) => drop.reason)).toEqual(["evidence_misattributed"]);

    // Same rule on the derived FIRST-name token: "The Weaver" contributes
    // "the weaver", never the article.
    const articleFirstName = validateRomanticPermissionDecisions({
      reply: '"You can touch me," the woman across the table says.',
      digest: digestOf([{ name: "The Weaver" }, { name: "Vaelith" }]),
      candidates: [candidate({ evidenceQuote: "You can touch me," })],
    });
    expect(articleFirstName.drops.map((drop) => drop.reason)).toEqual(["evidence_misattributed"]);

    // A multi-word alias survives intact — only a WHOLE stop-word token is cut.
    const multiWordAlias = validateRomanticPermissionDecisions({
      reply: '"You can touch me," the innkeeper says.',
      digest: digestOf([{ name: "Wren", aliases: ["the innkeeper"] }, { name: "Vaelith" }]),
      candidates: [candidate({ evidenceQuote: "You can touch me," })],
    });
    expect(multiWordAlias.drops).toEqual([]);
    expect(multiWordAlias.accepted).toHaveLength(1);
  });

  it("dialogue attributed to a DIFFERENT roster NPC cannot decide for the claimed target", () => {
    const reply = '"You can hold my hand, Vaelith," Wren says.';
    const digest = digestOf([{ name: "Wren" }, { name: "Vaelith" }]);
    const wrong = validateRomanticPermissionDecisions({
      reply,
      digest,
      candidates: [
        // Claims Vaelith (npc_1) granted — but the attribution clause names Wren.
        candidate({ permittedActorRef: "player", grantingTargetRef: "npc_1", evidenceQuote: "You can hold my hand, Vaelith," }),
      ],
    });
    expect(wrong.drops.map((drop) => drop.reason)).toEqual(["evidence_misattributed"]);
  });

  it("does not let a named addressee steal another NPC's attributed line", () => {
    const reply = 'Wren tells Mara, "You can touch me."';
    const result = validateRomanticPermissionDecisions({
      reply,
      digest: digestOf([{ name: "Wren" }, { name: "Mara" }]),
      candidates: [
        candidate({
          permittedActorRef: "player",
          grantingTargetRef: "npc_1",
          evidenceQuote: "You can touch me.",
        }),
      ],
    });
    expect(result.accepted).toEqual([]);
    expect(result.drops.map((drop) => drop.reason)).toEqual(["evidence_misattributed"]);
  });

  it("an NPC-to-NPC grant in one direction leaves the reverse absent (mutual = two records)", () => {
    const reply = '"You can hold my hand, Vaelith," Wren says.';
    const digest = digestOf([{ name: "Wren" }, { name: "Vaelith" }]);
    const result = validateRomanticPermissionDecisions({
      reply,
      digest,
      candidates: [
        candidate({ permittedActorRef: "npc_1", grantingTargetRef: "npc_0", evidenceQuote: "You can hold my hand, Vaelith," }),
      ],
    });
    expect(result.accepted).toEqual([
      expect.objectContaining({ permittedActorRef: "npc_1", grantingTargetRef: "npc_0" }),
    ]);

    // Fold-level: exactly ONE directional entry exists — the reverse is absent.
    const projection = foldRomanticPermissionProjection({
      events: [ledgerEvent({ permittedActorId: subjectOf(1), grantingTargetId: subjectOf(0) })],
    });
    const grants = activeRomanticPermissionGrants(projection);
    expect(grants).toHaveLength(1);
    expect(grants[0]?.permittedActorId).toBe(subjectOf(1));
    expect(grants[0]?.grantingTargetId).toBe(subjectOf(0));
  });

  it("names the SPEAKER, not merely someone named: a clause naming both NPCs attributes to the first", () => {
    // The two readings are indistinguishable by presence — both clauses name
    // both NPCs — so order is what separates one NPC's offer from another NPC
    // being spoken to.
    const digest = digestOf([{ name: "Wren" }, { name: "Vaelith" }]);

    // Wren is speaking TO Vaelith. A candidate claiming Vaelith offered must not
    // turn Wren's words into Vaelith's grant.
    const spokenTo = validateRomanticPermissionDecisions({
      reply: 'Wren tells Vaelith, "You can hold my hand."',
      digest,
      candidates: [
        candidate({ permittedActorRef: "npc_0", grantingTargetRef: "npc_1", evidenceQuote: "You can hold my hand." }),
      ],
    });
    expect(spokenTo.accepted).toEqual([]);
    expect(spokenTo.drops.map((drop) => drop.reason)).toEqual(["evidence_misattributed"]);

    // The mirror image is a legitimate NPC-to-NPC grant and must still land —
    // the fix would be worthless if it bought safety by refusing these.
    const speaking = validateRomanticPermissionDecisions({
      reply: 'Vaelith tells Wren, "You can hold my hand."',
      digest,
      candidates: [
        candidate({ permittedActorRef: "npc_0", grantingTargetRef: "npc_1", evidenceQuote: "You can hold my hand." }),
      ],
    });
    expect(speaking.accepted).toEqual([
      expect.objectContaining({ permittedActorRef: "npc_0", grantingTargetRef: "npc_1" }),
    ]);
  });

  it("attributes narrated conduct to its subject, not to whoever else the sentence names", () => {
    const digest = digestOf([{ name: "Wren" }, { name: "Vaelith" }]);
    const result = validateRomanticPermissionDecisions({
      reply: "Wren guides Vaelith's hand to her own waist and holds it there.",
      digest,
      candidates: [
        candidate({
          permittedActorRef: "npc_1",
          grantingTargetRef: "npc_0",
          evidenceQuote: "Wren guides Vaelith's hand to her own waist and holds it there.",
        }),
        // Wren's act, so Vaelith has offered nothing — being named is not consenting.
        candidate({
          permittedActorRef: "npc_0",
          grantingTargetRef: "npc_1",
          evidenceQuote: "Wren guides Vaelith's hand to her own waist and holds it there.",
        }),
      ],
    });
    expect(result.accepted).toEqual([
      expect.objectContaining({ permittedActorRef: "npc_1", grantingTargetRef: "npc_0" }),
    ]);
    expect(result.drops.map((drop) => drop.reason)).toEqual(["evidence_misattributed"]);
  });

  it("orders survivors by evidence offset (the reply's written chronology), whatever order the model listed", () => {
    const reply = '"You can hold my hand, Vaelith," Wren says. "And you can hold mine," Vaelith replies.';
    const digest = digestOf([{ name: "Wren" }, { name: "Vaelith" }]);
    const result = validateRomanticPermissionDecisions({
      reply,
      digest,
      candidates: [
        // Listed in REVERSE of their reply order.
        candidate({ permittedActorRef: "npc_0", grantingTargetRef: "npc_1", evidenceQuote: "And you can hold mine," }),
        candidate({ permittedActorRef: "npc_1", grantingTargetRef: "npc_0", evidenceQuote: "You can hold my hand, Vaelith," }),
      ],
    });
    expect(result.accepted.map((accepted) => accepted.grantingTargetRef)).toEqual(["npc_0", "npc_1"]);
    const offsets = result.accepted.map((accepted) => accepted.evidenceOffset);
    expect(offsets[0]).toBeLessThan(offsets[1] ?? -1);
  });

  it("dedupes duplicate directions keeping the LARGEST evidence offset — the reply's last word stands", () => {
    const reply = '"You can touch me," Mara says. Then she softens further. "Touch me, please," Mara adds.';
    const result = validateRomanticPermissionDecisions({
      reply,
      digest: soleMara,
      candidates: [
        candidate({ evidenceQuote: "You can touch me," }),
        candidate({ evidenceQuote: "Touch me, please," }),
      ],
    });
    expect(result.accepted).toHaveLength(1);
    expect(result.accepted[0]?.evidenceOffset).toBe(reply.indexOf("Touch me, please,"));
    expect(result.drops).toEqual([expect.objectContaining({ index: 0, reason: "duplicate_direction" })]);
  });

  it("a same-reply grant-then-withdrawal collapses to the withdrawal (later offset wins the direction)", () => {
    const reply = '"You can touch me," Mara says. A beat later she stiffens. "Do not touch me anymore," Mara says.';
    const result = validateRomanticPermissionDecisions({
      reply,
      digest: digestOf([{ name: "Mara" }], [{ actor: "player", target: 0 }]),
      candidates: [
        candidate({ evidenceQuote: "You can touch me," }),
        candidate({ kind: "withdrawn", evidenceQuote: "Do not touch me anymore," }),
      ],
    });
    expect(result.accepted.map((accepted) => accepted.kind)).toEqual(["withdrawn"]);
    expect(result.drops.map((drop) => drop.reason)).toEqual(["duplicate_direction"]);
  });

  it("a reply that grants and then retracts leaves NOTHING standing, even with no prior grant to take back", () => {
    // The regression: judged against the digest alone (the PRE-reply projection)
    // the withdrawal dropped `no_standing_grant`, the grant survived the dedupe
    // unopposed, and the ledger recorded a grant this very reply retracted.
    const reply =
      '"You can touch me," Mara says. Her hand stills. "On second thought — do not touch me anymore," Mara says.';
    const result = validateRomanticPermissionDecisions({
      reply,
      digest: soleMara, // no standing grant anywhere
      candidates: [
        candidate({ evidenceQuote: "You can touch me," }),
        candidate({ kind: "withdrawn", evidenceQuote: "do not touch me anymore," }),
      ],
    });
    expect(result.accepted.map((accepted) => accepted.kind)).toEqual(["withdrawn"]);
    expect(result.drops.map((drop) => drop.reason)).toEqual(["duplicate_direction"]);
    // The retracted grant is NOT also emitted: one decision per direction.
    expect(result.accepted).toHaveLength(1);

    // Through the REAL fold: the direction ends as a withdrawn tombstone, and
    // nothing authorizes the player's next attempt.
    const projection = foldRomanticPermissionProjection({ events: ledgerEventsOf(result.accepted) });
    expect(activeRomanticPermissionGrants(projection)).toEqual([]);
    expect(projection.entries.map((entry) => entry.standing)).toEqual(["withdrawn"]);
  });

  it("a same-reply withdrawal BEFORE the grant ends standing — the reply's last word grants", () => {
    const reply = '"Do not touch me anymore," Mara says. Then her shoulders drop. "You can touch me," Mara says.';
    const noPriorGrant = validateRomanticPermissionDecisions({
      reply,
      digest: soleMara,
      candidates: [
        candidate({ kind: "withdrawn", evidenceQuote: "Do not touch me anymore," }),
        candidate({ evidenceQuote: "You can touch me," }),
      ],
    });
    // Nothing stood, and the reply's only grant comes LATER — a withdrawal
    // cannot reach forward to take back an offer not yet made.
    expect(noPriorGrant.accepted.map((accepted) => accepted.kind)).toEqual(["granted"]);
    expect(noPriorGrant.drops.map((drop) => drop.reason)).toEqual(["no_standing_grant"]);
    const projection = foldRomanticPermissionProjection({ events: ledgerEventsOf(noPriorGrant.accepted) });
    expect(activeRomanticPermissionGrants(projection)).toHaveLength(1);

    // With a grant already standing the withdrawal is lawful, and the later
    // grant still wins the direction — the same last-word rule, both ways.
    const withPriorGrant = validateRomanticPermissionDecisions({
      reply,
      digest: digestOf([{ name: "Mara" }], [{ actor: "player", target: 0 }]),
      candidates: [
        candidate({ kind: "withdrawn", evidenceQuote: "Do not touch me anymore," }),
        candidate({ evidenceQuote: "You can touch me," }),
      ],
    });
    expect(withPriorGrant.accepted.map((accepted) => accepted.kind)).toEqual(["granted"]);
    expect(withPriorGrant.drops.map((drop) => drop.reason)).toEqual(["duplicate_direction"]);
    expect(
      activeRomanticPermissionGrants(
        foldRomanticPermissionProjection({ events: ledgerEventsOf(withPriorGrant.accepted) }),
      ),
    ).toHaveLength(1);
  });

  it("only a grant that SURVIVED the vetoes can license a same-reply withdrawal", () => {
    const reply =
      `"If you behave, maybe I'll let you touch me," Mara says. She pauses. "Do not touch me anymore," Mara says.`;
    const result = validateRomanticPermissionDecisions({
      reply,
      digest: soleMara,
      candidates: [
        candidate({ evidenceQuote: "If you behave, maybe I'll let you touch me," }),
        candidate({ kind: "withdrawn", evidenceQuote: "Do not touch me anymore," }),
      ],
    });
    expect(result.accepted).toEqual([]);
    expect(result.drops.map((drop) => drop.reason)).toEqual(["evidence_conditional", "no_standing_grant"]);
  });

  it("caps at four decisions — the fifth drops over_cap before any other judgment", () => {
    const reply = '"You can touch me," Mara says.';
    const five = Array.from({ length: ROMANTIC_PERMISSION_DECISION_CAP + 1 }, () =>
      candidate({ evidenceQuote: "You can touch me," }),
    );
    const result = validateRomanticPermissionDecisions({ reply, digest: soleMara, candidates: five });
    expect(result.drops.map((drop) => drop.reason)).toContain("over_cap");
    expect(result.drops.find((drop) => drop.reason === "over_cap")?.index).toBe(ROMANTIC_PERMISSION_DECISION_CAP);
  });
});
