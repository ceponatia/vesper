import { afterEach, describe, expect, it } from "vitest";
import {
  affordanceSubjectId,
  buildNpcSceneDigest,
  DiagnosticCollector,
  parseNpcSceneDecisionOutput,
  type NpcSceneDecisionParse,
  type NpcSceneDigest,
} from "@/contracts";
import { codes, expectDiagnostic } from "@/test/diagnostics";
import {
  chatNpcSceneDecisionMode,
  evaluateNpcSceneDecision,
  npcSceneDecisionTriggered,
  type NpcSceneFloorInput,
} from "./chat-npc-scene-decision";

/**
 * The pure halves of the reply-scene decision leg (actor-control delivery
 * step 3): the cost-control trigger, the mode resolution, and the SHADOW dry
 * evaluation — admitted candidates recorded as admitted-not-committed, drops
 * with their spec reason codes, and the chronological action list the durable
 * envelope stores.
 */

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

interface RosterSpec {
  readonly name: string;
  readonly aliases?: readonly string[];
  readonly presence?: "present" | "away";
}

function digestOf(roster: readonly RosterSpec[]): NpcSceneDigest {
  return buildNpcSceneDigest({
    playerSubjectId: affordanceSubjectId("player"),
    roster: roster.map((member, index) => ({
      subjectId: affordanceSubjectId(`npc-subject-${index}`),
      name: member.name,
      aliases: member.aliases ?? [],
      presence: member.presence ?? "present",
    })),
    contacts: [],
    proximity: [],
  }).digest;
}

/** A parse whose slots came back from the real contract parser. */
function parsed(digest: NpcSceneDigest, raw: unknown): NpcSceneDecisionParse {
  const parse = parseNpcSceneDecisionOutput(digest, raw);
  if (parse.status !== "parsed") throw new Error("fixture output failed the envelope parse");
  return parse;
}

const ABSENT_PARSE: NpcSceneDecisionParse = {
  status: "parsed",
  movement: { status: "absent" },
  contact: { status: "absent" },
};

// ---------------------------------------------------------------------------
// Mode resolution
// ---------------------------------------------------------------------------

describe("chatNpcSceneDecisionMode", () => {
  afterEach(() => {
    delete process.env.CHAT_NPC_SCENE_DECISION_SHADOW;
    delete process.env.CHAT_NPC_SCENE_DECISIONS;
    delete process.env.CHAT_CONTACT_ACTIONS;
  });

  it("is null with both flags off — the leg does not exist", () => {
    expect(chatNpcSceneDecisionMode()).toBeNull();
  });

  it("is shadow with the shadow flag alone (no contact-flag dependency)", () => {
    process.env.CHAT_NPC_SCENE_DECISION_SHADOW = "on";
    expect(chatNpcSceneDecisionMode()).toBe("shadow");
  });

  it("authority wins when both flags are on AND the contact lane is on", () => {
    process.env.CHAT_NPC_SCENE_DECISION_SHADOW = "on";
    process.env.CHAT_NPC_SCENE_DECISIONS = "on";
    process.env.CHAT_CONTACT_ACTIONS = "on";
    expect(chatNpcSceneDecisionMode()).toBe("authority");
  });

  it("the authority flag is inert without CHAT_CONTACT_ACTIONS", () => {
    process.env.CHAT_NPC_SCENE_DECISIONS = "on";
    expect(chatNpcSceneDecisionMode()).toBeNull();
    process.env.CHAT_NPC_SCENE_DECISION_SHADOW = "on";
    expect(chatNpcSceneDecisionMode()).toBe("shadow");
  });

  it("only the literal 'on' enables (the repo flag convention)", () => {
    process.env.CHAT_NPC_SCENE_DECISION_SHADOW = "true";
    expect(chatNpcSceneDecisionMode()).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// The trigger
// ---------------------------------------------------------------------------

describe("npcSceneDecisionTriggered", () => {
  it("fires on a movement verb stem beside a roster name", () => {
    expect(npcSceneDecisionTriggered("Wren steps closer to the window.", digestOf([{ name: "Wren" }]))).toBe(true);
  });

  it("fires on an alias and on a first name", () => {
    const digest = digestOf([{ name: "Wren Ashford", aliases: ["Wrennie"] }]);
    expect(npcSceneDecisionTriggered("Wrennie crosses the room.", digest)).toBe(true);
    expect(npcSceneDecisionTriggered("Wren settles beside you.", digest)).toBe(true);
  });

  it("fires on a bare third-person pronoun when the digest holds exactly one NPC", () => {
    expect(npcSceneDecisionTriggered("She crosses the room.", digestOf([{ name: "Wren" }]))).toBe(true);
  });

  it("fires on a pronoun when exactly one of several NPCs is pre-settle present", () => {
    const digest = digestOf([{ name: "Wren" }, { name: "Vaelith", presence: "away" }]);
    expect(npcSceneDecisionTriggered("She steps back toward the door.", digest)).toBe(true);
  });

  it("refuses a pronoun in a two-present ensemble but accepts a name there", () => {
    const digest = digestOf([{ name: "Wren" }, { name: "Vaelith" }]);
    expect(npcSceneDecisionTriggered("She steps closer.", digest)).toBe(false);
    expect(npcSceneDecisionTriggered("Vaelith steps closer.", digest)).toBe(true);
  });

  it("misses without a verb stem, and without any naming", () => {
    const digest = digestOf([{ name: "Wren" }]);
    expect(npcSceneDecisionTriggered("Wren smiles at you across the counter.", digest)).toBe(false);
    expect(npcSceneDecisionTriggered("Someone steps outside in the hall.", digest)).toBe(false);
  });

  it("requires the verb and the name in the SAME sentence", () => {
    const digest = digestOf([{ name: "Wren" }]);
    expect(npcSceneDecisionTriggered("Wren laughs. The kettle steps up its whistling.", digest)).toBe(false);
  });

  it("reads narration only — a quoted sentence cannot fire it", () => {
    const digest = digestOf([{ name: "Wren" }]);
    expect(npcSceneDecisionTriggered('"Wren steps closer," you read aloud.', digest)).toBe(false);
  });

  it("is false for a rosterless digest", () => {
    expect(npcSceneDecisionTriggered("She steps closer.", digestOf([]))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Shadow dry evaluation
// ---------------------------------------------------------------------------

describe("evaluateNpcSceneDecision — the shadow dry run", () => {
  const APPROACH_REPLY = "Wren crosses the room and stops right beside you.";
  const approachRaw = {
    version: 1,
    movement: {
      kind: "approach",
      actorRef: "npc_0",
      counterpartRef: "player",
      band: "touching",
      facing: null,
      evidence: APPROACH_REPLY,
    },
    contact: null,
  };

  it("records an admitted movement as ADMITTED, NOT COMMITTED — unresolved, shadow-labelled, rowless", () => {
    const digest = digestOf([{ name: "Wren" }]);
    const evaluation = evaluateNpcSceneDecision({
      reply: APPROACH_REPLY,
      digest,
      presentNpcRefs: ["npc_0"],
      parse: parsed(digest, approachRaw),
      floor: null,
    });
    expect(evaluation.slots).toEqual({ movement: "parsed", contact: "absent" });
    expect(evaluation.drops).toEqual([]);
    expect(evaluation.actions).toHaveLength(1);
    const action = evaluation.actions[0];
    if (!action) throw new Error("no action recorded");
    expect(action.kind).toBe("movement");
    expect(action.resolution).toBe("unresolved");
    expect(action.detail).toBe("shadow_admitted_not_executed");
    expect(action.contactRows).toEqual([]);
    expect(action.span.end).toBeGreaterThan(action.span.start);
    expect(action.quoteHash).toMatch(/^[0-9a-f]{64}$/);
    expect(action.summary).toContain("approach npc_0 → player");
  });

  it("a malformed slot never erases its valid sibling — and both trace outcomes persist", () => {
    const reply = "Wren rests a hand on your shoulder.";
    const digest = digestOf([{ name: "Wren" }]);
    const sink = new DiagnosticCollector();
    const evaluation = evaluateNpcSceneDecision({
      reply,
      digest,
      presentNpcRefs: ["npc_0"],
      parse: parseNpcSceneDecisionOutput(digest, {
        version: 1,
        // npc_7 is a ref this digest never granted — the slot is malformed.
        movement: {
          kind: "approach",
          actorRef: "npc_7",
          counterpartRef: "player",
          band: "close",
          facing: null,
          evidence: reply,
        },
        contact: {
          kind: "start",
          actorRef: "npc_0",
          targetRef: "player",
          gesture: "rest",
          targetLocationId: "shoulders",
          evidence: reply,
        },
      }),
      floor: null,
      sink,
    });
    expect(evaluation.slots).toEqual({ movement: "malformed", contact: "parsed" });
    expect(evaluation.drops).toEqual([
      expect.objectContaining({ candidate: "movement", reason: "slot_malformed" }),
    ]);
    expect(evaluation.actions.map((action) => action.kind)).toEqual(["contact"]);
    expectDiagnostic(sink, "npc_scene_decision.slot_malformed");
  });

  it("drops an admitted candidate whose actor is not post-settle present (presence precedence)", () => {
    const digest = digestOf([{ name: "Wren" }]);
    const sink = new DiagnosticCollector();
    const evaluation = evaluateNpcSceneDecision({
      reply: APPROACH_REPLY,
      digest,
      // The post-settle cut says nobody is present — pre-settle presence and
      // the model's proposal cannot rescue the actor.
      presentNpcRefs: [],
      parse: parsed(digest, approachRaw),
      floor: null,
      sink,
    });
    expect(evaluation.actions).toEqual([]);
    expect(evaluation.drops).toEqual([
      expect.objectContaining({ candidate: "movement", reason: "presence_conflict" }),
    ]);
    expectDiagnostic(sink, "npc_scene_decision.presence_conflict");
  });

  it("files the admission gates' own reasons — an unsupported band is evidence_incongruent naming the field", () => {
    const reply = "Wren steps closer to you.";
    const digest = digestOf([{ name: "Wren" }]);
    const sink = new DiagnosticCollector();
    const evaluation = evaluateNpcSceneDecision({
      reply,
      digest,
      presentNpcRefs: ["npc_0"],
      parse: parsed(digest, {
        version: 1,
        movement: {
          kind: "approach",
          actorRef: "npc_0",
          counterpartRef: "player",
          // The prose supports `close` ("closer to"); `touching` needs explicit adjacency.
          band: "touching",
          facing: null,
          evidence: reply,
        },
        contact: null,
      }),
      floor: null,
      sink,
    });
    expect(evaluation.drops).toEqual([
      expect.objectContaining({ candidate: "movement", reason: "evidence_incongruent", field: "band" }),
    ]);
    expect(evaluation.actions).toEqual([]);
    expectDiagnostic(sink, "npc_scene_decision.evidence_incongruent");
  });

  it("orders the floor and an admitted candidate by reply offset — the written order is the record", () => {
    const digest = digestOf([{ name: "Wren" }]);
    const reply = "Wren crosses the room and stops right beside you. Wren pulls away.";
    const floor: NpcSceneFloorInput = {
      reason: "withdrawn",
      subjectRef: "npc_0",
      // The floor's sentence sits AFTER the approach in the reply.
      span: { start: 50, end: 66 },
      rows: [{ eventRef: "contact-reply:m1", sequence: 0 }],
      committed: true,
    };
    const evaluation = evaluateNpcSceneDecision({
      reply,
      digest,
      presentNpcRefs: ["npc_0"],
      parse: parsed(digest, {
        version: 1,
        movement: {
          kind: "approach",
          actorRef: "npc_0",
          counterpartRef: "player",
          band: "touching",
          facing: null,
          evidence: "Wren crosses the room and stops right beside you.",
        },
        contact: null,
      }),
      floor,
    });
    expect(evaluation.actions.map((action) => action.kind)).toEqual(["movement", "floor_ending"]);
    const floorAction = evaluation.actions[1];
    if (!floorAction) throw new Error("no floor action");
    expect(floorAction.resolution).toBe("committed");
    expect(floorAction.contactRows).toEqual([{ eventRef: "contact-reply:m1", sequence: 0 }]);
    expect(floorAction.summary).toContain("withdrawn");
  });

  it("drops a tier-2 span that overlaps the floor's as chronology_ambiguous — the floor survives", () => {
    const digest = digestOf([{ name: "Wren" }]);
    const reply = "Wren crosses the room and stops right beside you.";
    const sink = new DiagnosticCollector();
    const parse = parsed(digest, approachRaw);
    // Recover the admitted action span first, then hand the floor that exact span.
    const admitted = evaluateNpcSceneDecision({
      reply,
      digest,
      presentNpcRefs: ["npc_0"],
      parse,
      floor: null,
    });
    const span = admitted.actions[0]?.span;
    if (!span) throw new Error("no admitted span");
    const evaluation = evaluateNpcSceneDecision({
      reply,
      digest,
      presentNpcRefs: ["npc_0"],
      parse,
      floor: {
        reason: "withdrawn",
        subjectRef: "npc_0",
        span,
        rows: [],
        committed: true,
      },
      sink,
    });
    // An approach cannot composite with an ending; an equal span is unorderable.
    expect(evaluation.drops).toEqual([
      expect.objectContaining({ candidate: "movement", reason: "chronology_ambiguous" }),
    ]);
    expect(evaluation.actions.map((action) => action.kind)).toEqual(["floor_ending"]);
    expect(codes(sink)).toContain("npc_scene_decision.chronology_ambiguous");
  });

  it("an absent parse with a located floor yields the trigger-miss/degraded payload shape: empty slots, floor action only", () => {
    const digest = digestOf([{ name: "Wren" }]);
    const evaluation = evaluateNpcSceneDecision({
      reply: "Wren pulls away.",
      digest,
      presentNpcRefs: ["npc_0"],
      parse: ABSENT_PARSE,
      floor: {
        reason: "withdrawn",
        subjectRef: "npc_0",
        span: { start: 0, end: 16 },
        rows: [{ eventRef: "contact-reply:m2", sequence: 0 }],
        committed: true,
      },
    });
    expect(evaluation.slots).toEqual({ movement: "absent", contact: "absent" });
    expect(evaluation.drops).toEqual([]);
    expect(evaluation.actions.map((action) => action.kind)).toEqual(["floor_ending"]);
  });

  it("a floor whose sentence could not be located is recorded LAST, unordered, with the detail naming why", () => {
    const digest = digestOf([{ name: "Wren" }]);
    const reply = "Wren crosses the room and stops right beside you.";
    const evaluation = evaluateNpcSceneDecision({
      reply,
      digest,
      presentNpcRefs: ["npc_0"],
      parse: parsed(digest, approachRaw),
      floor: {
        reason: "separated",
        subjectRef: "npc_0",
        span: null,
        rows: [{ eventRef: "contact-reply:m3", sequence: 0 }],
        committed: true,
      },
    });
    expect(evaluation.actions.map((action) => action.kind)).toEqual(["movement", "floor_ending"]);
    const floorAction = evaluation.actions[1];
    if (!floorAction) throw new Error("no floor action");
    expect(floorAction.detail).toContain("span_unlocated");
    expect(floorAction.span).toEqual({ start: 0, end: reply.length });
  });
});
