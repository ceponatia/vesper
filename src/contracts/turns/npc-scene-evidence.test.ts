import { describe, expect, it } from "vitest";
import * as evidenceModule from "./npc-scene-evidence";
import {
  admitNpcSceneCandidate,
  groundNpcSceneEvidence,
  npcSceneNarrationSentences,
  type NpcSceneAdmission,
  type NpcSceneEvidenceContext,
  type NpcSceneEvidenceDrop,
  type NpcSceneEvidenceDropReason,
} from "./npc-scene-evidence";
import {
  buildNpcSceneDigest,
  contactRefAt,
  npcRefAt,
  NPC_SCENE_PLAYER_REF,
  type NpcApproachCandidate,
  type NpcContactStartCandidate,
  type NpcContactUpdateCandidate,
  type NpcDepartCandidate,
  type NpcRef,
  type NpcSceneContactInput,
  type NpcSceneDigest,
} from "./npc-scene-decision";

/**
 * Evidence admission — the four gates and the fence
 * (romantic-contact-affordances.spec.actor-control.md §"Evidence admission").
 *
 * Organised by risk: the fixtures here are the spec's ADVERSARIAL minimum —
 * every one of them is a way a plausible model output could commit an act the
 * prose does not carry, and every one must die in the right gate with the
 * right bounded reason.
 */

const PLAYER_ID = "player-subject";
const MARA_ID = "char-mara";
const SABRINA_ID = "char-sabrina";

function contact(id: string, targetLocationId: string): NpcSceneContactInput {
  return {
    contactId: id,
    actorSubjectId: MARA_ID,
    actionKind: "affectionate",
    sourceSubjectId: MARA_ID,
    sourceLocationId: "hands",
    targetSubjectId: PLAYER_ID,
    targetLocationId,
  };
}

function digestWith(contacts: readonly NpcSceneContactInput[]): NpcSceneDigest {
  return buildNpcSceneDigest({
    playerSubjectId: PLAYER_ID,
    roster: [
      { subjectId: MARA_ID, name: "Mara", aliases: [], presence: "present" },
      { subjectId: SABRINA_ID, name: "Sabrina", aliases: [], presence: "present" },
    ],
    contacts,
    proximity: [],
  }).digest;
}

const BOTH_ELIGIBLE: readonly NpcRef[] = [npcRefAt(0), npcRefAt(1)];

function context(
  reply: string,
  options: { readonly contacts?: readonly NpcSceneContactInput[]; readonly eligible?: readonly NpcRef[] } = {},
): NpcSceneEvidenceContext {
  return {
    reply,
    digest: digestWith(options.contacts ?? []),
    eligibleNpcRefs: options.eligible ?? BOTH_ELIGIBLE,
  };
}

function approach(overrides: Partial<NpcApproachCandidate> = {}): NpcApproachCandidate {
  return {
    kind: "approach",
    actorRef: npcRefAt(0),
    counterpartRef: NPC_SCENE_PLAYER_REF,
    band: "close",
    facing: null,
    evidence: "",
    ...overrides,
  };
}

function depart(overrides: Partial<NpcDepartCandidate> = {}): NpcDepartCandidate {
  return {
    kind: "depart",
    actorRef: npcRefAt(0),
    counterpartRef: NPC_SCENE_PLAYER_REF,
    band: "near",
    evidence: "",
    ...overrides,
  };
}

function start(overrides: Partial<NpcContactStartCandidate> = {}): NpcContactStartCandidate {
  return {
    kind: "start",
    actorRef: npcRefAt(0),
    targetRef: NPC_SCENE_PLAYER_REF,
    gesture: "rest",
    targetLocationId: "shoulders",
    evidence: "",
    ...overrides,
  };
}

function update(overrides: Partial<NpcContactUpdateCandidate> = {}): NpcContactUpdateCandidate {
  return {
    kind: "update",
    actorRef: npcRefAt(0),
    contactRef: contactRefAt(0),
    gesture: "squeeze",
    evidence: "",
    ...overrides,
  };
}

/** Any gate result that can carry a drop — admissions and raw grounding results alike. */
type DropCarrier =
  | { readonly status: "dropped"; readonly drop: NpcSceneEvidenceDrop }
  | { readonly status: "admitted" }
  | { readonly status: "grounded" };

function expectDrop(result: DropCarrier, reason: NpcSceneEvidenceDropReason, field?: string): void {
  expect(result.status).toBe("dropped");
  if (result.status !== "dropped") return;
  expect(result.drop.reason).toBe(reason);
  if (field !== undefined) expect(result.drop.field).toBe(field);
}

function expectAdmitted(admission: NpcSceneAdmission): asserts admission is Extract<
  NpcSceneAdmission,
  { status: "admitted" }
> {
  expect(admission.status).toBe("admitted");
  if (admission.status !== "admitted") throw new Error("not admitted");
}

// ---------------------------------------------------------------------------
// Gate 1 — grounding
// ---------------------------------------------------------------------------

describe("grounding", () => {
  it("returns the quote's absolute offsets when it occurs exactly once in narration", () => {
    const reply = "A prelude sentence. Mara steps right beside you.";
    const result = groundNpcSceneEvidence(reply, "Mara steps right beside you.");
    expect(result.status).toBe("grounded");
    if (result.status !== "grounded") return;
    expect(reply.slice(result.grounding.span.start, result.grounding.span.end)).toBe(
      "Mara steps right beside you.",
    );
  });

  it("never grounds a quote that lives in dialogue — straight or curly quoted", () => {
    for (const reply of [
      '"Mara steps right beside you," she murmurs.',
      "“Mara steps right beside you,” she murmurs.",
    ]) {
      const result = groundNpcSceneEvidence(reply, "Mara steps right beside you");
      expectDrop(result, "evidence_ungrounded");
    }
  });

  it("never grounds thought or styled spans", () => {
    expectDrop(groundNpcSceneEvidence("*Mara pats your head*", "Mara pats your head"), "evidence_ungrounded");
    expectDrop(groundNpcSceneEvidence("_Mara pats your head_", "Mara pats your head"), "evidence_ungrounded");
  });

  it("fails closed on a duplicated quote — nobody can say which occurrence acted", () => {
    const reply = "Mara steps right beside you. Mara steps right beside you.";
    expectDrop(groundNpcSceneEvidence(reply, "Mara steps right beside you."), "evidence_ambiguous");
  });

  it("matches curly-quoted evidence against straight-quoted prose", () => {
    const result = groundNpcSceneEvidence("Mara pats Sabrina's shoulder.", "Mara pats Sabrina’s shoulder.");
    expect(result.status).toBe("grounded");
  });
});

describe("narration sentence geometry", () => {
  it("returns absolute offsets whose slices equal the sentences", () => {
    const reply = 'Mara smiles. "Hold still." Mara steps back.';
    const sentences = npcSceneNarrationSentences(reply);
    expect(sentences.map((sentence) => sentence.text)).toEqual(["Mara smiles.", "Mara steps back."]);
    for (const sentence of sentences) {
      expect(reply.slice(sentence.start, sentence.end)).toBe(sentence.text);
    }
  });
});

// ---------------------------------------------------------------------------
// Gate 2 — assertion vetoes (each one, by name)
// ---------------------------------------------------------------------------

describe("assertion vetoes", () => {
  const vetoed: readonly { readonly label: string; readonly reply: string }[] = [
    { label: "negation", reply: "Mara doesn't step closer to you." },
    { label: "modal/conditional", reply: "Mara might step closer to you." },
    { label: "third-person intent", reply: "Mara wants to step closer to you." },
    { label: "inceptive hedge", reply: "Mara starts to step closer to you." },
    { label: "future", reply: "Mara will step closer to you." },
    { label: "question", reply: "Mara steps closer to you?" },
    { label: "command", reply: "Step right beside Mara." },
    { label: "incomplete (trailing dash)", reply: "Mara steps closer to you —" },
    { label: "incomplete (cut off, no terminal)", reply: "Mara steps closer to you" },
  ];
  for (const { label, reply } of vetoed) {
    it(`vetoes ${label}`, () => {
      expectDrop(
        admitNpcSceneCandidate(context(reply), approach({ evidence: reply })),
        "evidence_unasserted",
      );
    });
  }

  it("vetoes refusal", () => {
    const reply = "Mara refuses and steps away.";
    expectDrop(admitNpcSceneCandidate(context(reply), depart({ evidence: reply })), "evidence_unasserted");
  });

  it("vetoes romantic framing and restraint for contact candidates", () => {
    const romantic = "Mara kisses your cheek and rests her hand on your shoulder.";
    expectDrop(admitNpcSceneCandidate(context(romantic), start({ evidence: romantic })), "evidence_unasserted");
    const restrained = "Mara grabs your hand.";
    expectDrop(
      admitNpcSceneCandidate(
        context(restrained, { contacts: [contact("c1", "hands")] }),
        update({ evidence: restrained }),
      ),
      "evidence_unasserted",
    );
  });

  it("does NOT veto movement for romantic framing — that veto is contact-specific", () => {
    const reply = "Mara kisses the air, then she steps right beside you.";
    const admission = admitNpcSceneCandidate(
      context(reply, { eligible: [npcRefAt(0)] }),
      approach({ band: "touching", evidence: reply }),
    );
    expectAdmitted(admission);
  });

  it("vetoes through the CONTAINING sentence, so a sub-clause quote cannot launder a negation", () => {
    const reply = "Mara doesn't take your hand.";
    expectDrop(
      admitNpcSceneCandidate(
        context(reply),
        start({ gesture: "rest", targetLocationId: "hands", evidence: "take your hand" }),
      ),
      "evidence_unasserted",
    );
  });
});

// ---------------------------------------------------------------------------
// Gate 3 — actor attribution
// ---------------------------------------------------------------------------

describe("actor attribution", () => {
  it("refuses a name that only appears as a possessive object (actor/object confusion)", () => {
    const reply = "Your hand rests on Mara's arm.";
    expectDrop(
      admitNpcSceneCandidate(context(reply), start({ targetLocationId: "arms", evidence: reply })),
      "evidence_misattributed",
    );
  });

  it("refuses a bare pronoun in an ensemble, and accepts it with exactly one eligible NPC", () => {
    const reply = "She steps right beside you.";
    expectDrop(
      admitNpcSceneCandidate(context(reply), approach({ band: "touching", evidence: reply })),
      "evidence_misattributed",
    );
    const sole = admitNpcSceneCandidate(
      context(reply, { eligible: [npcRefAt(0)] }),
      approach({ band: "touching", evidence: reply }),
    );
    expectAdmitted(sole);
  });

  it("refuses evidence in which a DIFFERENT roster member acts", () => {
    const reply = "Sabrina takes your hand.";
    expectDrop(
      admitNpcSceneCandidate(context(reply), start({ gesture: "rest", targetLocationId: "hands", evidence: reply })),
      "evidence_misattributed",
    );
  });

  it("resolves second-person narration only to the player — never to an NPC actor", () => {
    const reply = "You step closer to Mara.";
    expectDrop(admitNpcSceneCandidate(context(reply), approach({ evidence: reply })), "evidence_misattributed");
  });
});

// ---------------------------------------------------------------------------
// Gate 4 — congruence (wrong kind/actor/target/band/gesture/location, by field)
// ---------------------------------------------------------------------------

describe("congruence", () => {
  it("admits an approach and returns the exact action phrase span", () => {
    const reply = "Mara crosses the room and steps right beside you. Sabrina takes your hand.";
    const admission = admitNpcSceneCandidate(
      context(reply),
      approach({ band: "touching", evidence: "Mara crosses the room and steps right beside you." }),
    );
    expectAdmitted(admission);
    expect(reply.slice(admission.actionSpan.start, admission.actionSpan.end)).toBe(
      "Mara crosses the room and steps right beside you",
    );
  });

  it("admits two NPCs acting in one reply as two independent proposals", () => {
    const reply = "Mara crosses the room and steps right beside you. Sabrina takes your hand.";
    const mara = admitNpcSceneCandidate(
      context(reply),
      approach({ band: "touching", evidence: "Mara crosses the room and steps right beside you." }),
    );
    const sabrina = admitNpcSceneCandidate(
      context(reply),
      start({
        actorRef: npcRefAt(1),
        gesture: "rest",
        targetLocationId: "hands",
        evidence: "Sabrina takes your hand.",
      }),
    );
    expectAdmitted(mara);
    expectAdmitted(sabrina);
    expect(mara.actionSpan.start).toBeLessThan(sabrina.actionSpan.start);
  });

  it("names the failing field: kind", () => {
    const reply = "Mara steps out of reach.";
    expectDrop(
      admitNpcSceneCandidate(context(reply), approach({ evidence: reply })),
      "evidence_incongruent",
      "kind",
    );
  });

  it("names the failing field: band — ordinary beside is close, only explicit adjacency is touching", () => {
    const beside = "Mara steps beside you.";
    expectDrop(
      admitNpcSceneCandidate(context(beside), approach({ band: "touching", evidence: beside })),
      "evidence_incongruent",
      "band",
    );
    const rightBeside = "Mara steps right beside you.";
    expectDrop(
      admitNpcSceneCandidate(context(rightBeside), approach({ band: "close", evidence: rightBeside })),
      "evidence_incongruent",
      "band",
    );
    expectAdmitted(admitNpcSceneCandidate(context(beside), approach({ band: "close", evidence: beside })));
    expectAdmitted(
      admitNpcSceneCandidate(context(rightBeside), approach({ band: "touching", evidence: rightBeside })),
    );
  });

  it("names the failing field: counterpartRef", () => {
    const reply = "Mara steps closer to Sabrina.";
    expectDrop(
      admitNpcSceneCandidate(context(reply), approach({ evidence: reply })),
      "evidence_incongruent",
      "counterpartRef",
    );
  });

  it("names the failing field: facing — and rejects facing while backing up", () => {
    const noFacing = "Mara steps right beside you.";
    expectDrop(
      admitNpcSceneCandidate(context(noFacing), approach({ band: "touching", facing: "toward", evidence: noFacing })),
      "evidence_incongruent",
      "facing",
    );
    const backing = "Mara moves right beside you, backing up against the counter.";
    expectDrop(
      admitNpcSceneCandidate(context(backing), approach({ band: "touching", facing: "toward", evidence: backing })),
      "evidence_incongruent",
      "facing",
    );
    expectAdmitted(
      admitNpcSceneCandidate(context(backing), approach({ band: "touching", facing: null, evidence: backing })),
    );
    const turning = "Mara walks over to you, turning to face you.";
    expectAdmitted(
      admitNpcSceneCandidate(context(turning), approach({ band: "close", facing: "toward", evidence: turning })),
    );
  });

  it("supports depart bands: steps back is near, walking across the room is distant", () => {
    const stepBack = "Mara steps back.";
    expectAdmitted(admitNpcSceneCandidate(context(stepBack), depart({ band: "near", evidence: stepBack })));
    expectDrop(
      admitNpcSceneCandidate(context(stepBack), depart({ band: "distant", evidence: stepBack })),
      "evidence_incongruent",
      "band",
    );
    const across = "Mara walks across the room.";
    expectAdmitted(admitNpcSceneCandidate(context(across), depart({ band: "distant", evidence: across })));
    expectDrop(
      admitNpcSceneCandidate(context(across), depart({ band: "near", evidence: across })),
      "evidence_incongruent",
      "band",
    );
  });

  it("refuses a possessive departure origin — stepping back from her desk names furniture", () => {
    const reply = "Mara steps back from her desk.";
    expectDrop(
      admitNpcSceneCandidate(context(reply), depart({ evidence: reply })),
      "evidence_incongruent",
      "counterpartRef",
    );
  });

  it("names the failing field: targetRef, gesture, targetLocationId on starts", () => {
    const shoulder = "Mara rests her hand on your shoulder.";
    expectDrop(
      admitNpcSceneCandidate(context(shoulder), start({ targetRef: npcRefAt(1), evidence: shoulder })),
      "evidence_incongruent",
      "targetRef",
    );
    expectDrop(
      admitNpcSceneCandidate(context(shoulder), start({ gesture: "squeeze", evidence: shoulder })),
      "evidence_incongruent",
      "gesture",
    );
    const arm = "Mara rests her hand on your arm.";
    expectDrop(
      admitNpcSceneCandidate(context(arm), start({ targetLocationId: "shoulders", evidence: arm })),
      "evidence_incongruent",
      "targetLocationId",
    );
    expectAdmitted(admitNpcSceneCandidate(context(shoulder), start({ evidence: shoulder })));
  });

  it("admits an NPC-to-NPC start through a named possessive", () => {
    const reply = "Mara rests her hand on Sabrina's shoulder.";
    expectAdmitted(
      admitNpcSceneCandidate(context(reply), start({ targetRef: npcRefAt(1), evidence: reply })),
    );
  });

  it("is ambiguous when one quote carries two action clauses by the same actor", () => {
    const reply = "Mara steps beside you and then Mara walks over to Sabrina.";
    expectDrop(
      admitNpcSceneCandidate(context(reply), approach({ evidence: reply })),
      "evidence_ambiguous",
    );
  });
});

// ---------------------------------------------------------------------------
// Updates — the exact contact behind the ref
// ---------------------------------------------------------------------------

describe("updates", () => {
  const oneContact = [contact("c1", "hands")];
  const twoContacts = [contact("c1", "hands"), contact("c2", "shoulders")];

  it("admits a surface-named modulation of the ref'd contact", () => {
    const reply = "Mara squeezes your hand.";
    expectAdmitted(
      admitNpcSceneCandidate(context(reply, { contacts: oneContact }), update({ evidence: reply })),
    );
  });

  it("names the failing field: gesture", () => {
    const reply = "Mara squeezes your hand.";
    expectDrop(
      admitNpcSceneCandidate(context(reply, { contacts: oneContact }), update({ gesture: "pat", evidence: reply })),
      "evidence_incongruent",
      "gesture",
    );
  });

  it("admits a bare own-hand modulation only when the actor has exactly one live contact", () => {
    const reply = "Mara stills her hand.";
    expectAdmitted(
      admitNpcSceneCandidate(
        context(reply, { contacts: oneContact }),
        update({ gesture: "rest", evidence: reply }),
      ),
    );
    expectDrop(
      admitNpcSceneCandidate(
        context(reply, { contacts: twoContacts }),
        update({ gesture: "rest", evidence: reply }),
      ),
      "evidence_ambiguous",
    );
  });

  it("refuses evidence naming a different contact's surface than the ref'd one", () => {
    const reply = "Mara pats your shoulder.";
    expectDrop(
      admitNpcSceneCandidate(
        context(reply, { contacts: twoContacts }),
        update({ contactRef: contactRefAt(0), gesture: "pat", evidence: reply }),
      ),
      "evidence_incongruent",
      "contactRef",
    );
  });
});

// ---------------------------------------------------------------------------
// Gate 0 — refs
// ---------------------------------------------------------------------------

describe("ref validity", () => {
  it("drops refs outside the digest as ref_invalid", () => {
    const reply = "Mara steps right beside you.";
    expectDrop(
      admitNpcSceneCandidate(context(reply), approach({ actorRef: npcRefAt(7), evidence: reply })),
      "ref_invalid",
    );
    expectDrop(
      admitNpcSceneCandidate(
        context(reply, { contacts: [contact("c1", "hands")] }),
        update({ contactRef: contactRefAt(7), evidence: reply }),
      ),
      "ref_invalid",
    );
  });

  it("drops an update whose ref'd contact belongs to a different actor", () => {
    const reply = "Sabrina squeezes your hand.";
    expectDrop(
      admitNpcSceneCandidate(
        context(reply, { contacts: [contact("c1", "hands")] }),
        update({ actorRef: npcRefAt(1), evidence: reply }),
      ),
      "ref_invalid",
    );
  });

  it("drops a self-targeting start", () => {
    const reply = "Mara rests her hand on your shoulder.";
    expectDrop(
      admitNpcSceneCandidate(context(reply), start({ targetRef: npcRefAt(0), evidence: reply })),
      "ref_invalid",
    );
  });
});

// ---------------------------------------------------------------------------
// The fence
// ---------------------------------------------------------------------------

describe("the fence", () => {
  it("exports no free-prose extractor — the surface is gates and geometry only", () => {
    expect(Object.keys(evidenceModule).sort()).toEqual(
      ["admitNpcSceneCandidate", "groundNpcSceneEvidence", "npcSceneEvidenceDropReasons", "npcSceneNarrationSentences"].sort(),
    );
  });
});
