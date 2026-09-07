import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  adapterSupported,
  adapterUnavailable,
  affordanceEvidence,
  affordanceSubjectId,
  applySceneIntents,
  buildNpcSceneDigest,
  DiagnosticCollector,
  emptyEffectiveCoverageRead,
  emptySceneState,
  parseNpcSceneDecisionOutput,
  sceneEventRef,
  sceneFacingFact,
  sceneFact,
  sceneParticipant,
  sceneProvenance,
  sceneProximityFact,
  withSceneContacts,
  withSceneParticipant,
  type AffordanceSubjectId,
  type CommittedContactRead,
  type NpcSceneContactInput,
  type NpcSceneDecisionParse,
  type NpcSceneDigestBuild,
  type NpcSceneDigestHandles,
  type NpcSceneReplySpan,
  type SceneMovementIntent,
  type SceneProximityBand,
  type SceneState,
} from "@/contracts";
import { codes } from "@/test/diagnostics";
import { chatContactEventRef, CHAT_CONTACT_PLAYER_SUBJECT } from "./chat-contact/identity";
import { planChatContactTurn } from "./chat-contact-adapter";
import { seededChatScene } from "./chat-contact/scene";
import type { ChatContactRosterMember } from "./chat-contact/input-evidence";
import { chatReplyContactEventRef } from "./chat-contact-reply";
import { admitNpcSceneDecision } from "./chat-npc-scene-decision";
import {
  executeNpcSceneDecision,
  type NpcSceneExecutionFloor,
  type NpcSceneMaterialCut,
} from "./chat-npc-scene-execute";

/**
 * The AUTHORITY EXECUTOR (actor-control delivery step 4 — increment 1, movement;
 * step 5 — increment 2, contact starts; step 6 — increment 3, contact updates):
 * presence integration, the ordered walk against an evolving scene, the
 * composite departure's compute → fold → apply, the unordered-floor rule, the
 * arbitrary-actor contact start with its two-sided material and its same-reply
 * wardrobe veto, the gesture-only update with its post-settle identity re-check,
 * the scope knob, and the truthful payload entries each of those produces.
 *
 * Everything here is PURE — the admission half runs for real (so the spans are
 * the congruence verifier's own, not fixtures), and the executor's output is
 * the scene + commits + payload entries the guarded transaction would write.
 */

const WREN = affordanceSubjectId("character_wren");
const EVENT = chatReplyContactEventRef("assistant_1");
const REF = sceneEventRef(EVENT);
/** The story minute the player's leg committed at, and the reply-scene leg's own. */
const AT = 120;
const AFTER = AT + 1;

const ABSENT_PARSE: NpcSceneDecisionParse = {
  status: "parsed",
  movement: { status: "absent" },
  contact: { status: "absent" },
};

const ROSTER: readonly ChatContactRosterMember[] = [
  { subjectId: WREN, name: "Wren", aliases: [], material: adapterSupported(emptyEffectiveCoverageRead()) },
];

function digestOf(contacts: readonly NpcSceneContactInput[] = []): NpcSceneDigestBuild {
  return buildNpcSceneDigest({
    playerSubjectId: CHAT_CONTACT_PLAYER_SUBJECT,
    roster: [{ subjectId: WREN, name: "Wren", aliases: [], presence: "present" }],
    contacts,
    proximity: [],
  });
}

/** The one live contact the digest exposes for an `update` proposal. */
function digestWithHeldTouch(contactId: string): NpcSceneDigestBuild {
  return digestOf([
    {
      contactId,
      actorSubjectId: WREN,
      actionKind: "affectionate",
      sourceSubjectId: WREN,
      sourceLocationId: "hands",
      targetSubjectId: CHAT_CONTACT_PLAYER_SUBJECT,
      targetLocationId: "hands",
    },
  ]);
}

function seededScene(): SceneState {
  return seededChatScene(emptySceneState(), {
    player: CHAT_CONTACT_PLAYER_SUBJECT,
    characters: [WREN],
    ref: REF,
    storyTime: AT,
  });
}

/** A scene the PLAYER's leg placed: a stated distance, and the player turned toward her. */
function placedByPlayer(band: SceneProximityBand): SceneState {
  const intents: readonly SceneMovementIntent[] = [
    {
      intentId: "probe:proximity",
      subjectId: CHAT_CONTACT_PLAYER_SUBJECT,
      origin: "player",
      change: { kind: "set_proximity", otherId: WREN, band },
      ref: REF,
      storyTime: AT,
      evidence: [affordanceEvidence("adapter", "probe")],
    },
    {
      intentId: "probe:facing",
      subjectId: CHAT_CONTACT_PLAYER_SUBJECT,
      origin: "player",
      change: { kind: "set_facing", towardId: WREN, facing: "toward" },
      ref: REF,
      storyTime: AT,
      evidence: [affordanceEvidence("adapter", "probe")],
    },
  ];
  return applySceneIntents(seededScene(), intents).state;
}

/** A live contact, made by the PLAYER's own leg — the executor only ever ends one. */
function heldTouch(): { scene: SceneState; contactId: string } {
  const planned = planChatContactTurn({
    scene: placedByPlayer("close"),
    message: "I rest my hand on your shoulder.",
    narratorInput: false,
    characters: ROSTER,
    eventRef: chatContactEventRef("msg_player"),
    storyTime: AT,
  });
  if (planned.commit?.status !== "committed") throw new Error("fixture: the held touch must commit");
  return {
    scene: withSceneContacts(planned.scene, planned.commit.state),
    contactId: planned.commit.contact.contactId,
  };
}

/** Both bodies bare and MODELLED — the answer a start composes to plain skin. */
const BARE_CUT: NpcSceneMaterialCut = new Map([
  [WREN, adapterSupported(emptyEffectiveCoverageRead())],
  [CHAT_CONTACT_PLAYER_SUBJECT, adapterSupported(emptyEffectiveCoverageRead())],
]);

/** One body's coverage read, as the post-settle garment cut hands it in. */
function covered(...entries: readonly { locationId: string; band: "opaque" | "hinted" | "exposed" }[]) {
  return adapterSupported({
    atMinutes: AT,
    entries: entries.map((entry) => ({ locationId: entry.locationId, band: entry.band, evidence: [] })),
  });
}

interface RunInput {
  readonly reply: string;
  readonly scene: SceneState;
  /** The raw classifier output; omitted ⇒ no proposals at all. */
  readonly raw?: unknown;
  readonly build?: NpcSceneDigestBuild;
  /** EXECUTION-side handles; omitted ⇒ the same build the admission read. */
  readonly handles?: NpcSceneDigestHandles;
  readonly floor?: NpcSceneExecutionFloor | null;
  /** The POST-settle presence answer for Wren. */
  readonly present?: boolean;
  /** The POST-settle garment cut; omitted ⇒ both bodies read as modelled and bare. */
  readonly material?: NpcSceneMaterialCut;
  /** Whose wardrobe this same reply's settle rewrote — the start's chronology veto. */
  readonly wardrobeChanged?: ReadonlySet<AffordanceSubjectId>;
  readonly sink?: DiagnosticCollector;
}

/** Admit + plan for real, then execute — the exact pair `finishLive` runs in authority mode. */
function run(input: RunInput) {
  const build = input.build ?? digestOf();
  const parse =
    input.raw === undefined ? ABSENT_PARSE : parseNpcSceneDecisionOutput(build.digest, input.raw);
  if (parse.status !== "parsed") throw new Error("fixture output failed the envelope parse");
  const present = input.present ?? true;
  const floor = input.floor ?? null;
  const admission = admitNpcSceneDecision({
    reply: input.reply,
    digest: build.digest,
    presentNpcRefs: present ? ["npc_0"] : [],
    parse,
    floor:
      floor === null || floor.span === null
        ? null
        : { reason: floor.ending.reason, subjectRef: floor.subjectRef, span: floor.span },
    ...(input.sink === undefined ? {} : { sink: input.sink }),
  });
  const execution = executeNpcSceneDecision({
    reply: input.reply,
    scene: input.scene,
    plan: admission.plan,
    floor,
    roster: [{ subjectId: WREN, present }],
    handles: input.handles ?? build.handles,
    eventRef: EVENT,
    storyMinute: AFTER,
    material: input.material ?? BARE_CUT,
    wardrobeChanged: input.wardrobeChanged ?? new Set<AffordanceSubjectId>(),
    ...(input.sink === undefined ? {} : { sink: input.sink }),
  });
  return { admission, execution };
}

/**
 * This file pins the FINISHED feature — what every kind does once the staged
 * rollout has run its course — so it states the end-state scope explicitly
 * rather than inheriting it. An unset scope now means `movement` only (the first
 * reviewed increment), which is the deployment safeguard, not the behavior these
 * tests are about. The scope-knob block below overrides this per test, which is
 * where a narrower scope belongs.
 */
beforeEach(() => {
  process.env.CHAT_NPC_SCENE_DECISION_AUTHORITY_KINDS = "movement,start,update";
});

afterEach(() => {
  delete process.env.CHAT_NPC_SCENE_DECISION_AUTHORITY_KINDS;
});

// ---------------------------------------------------------------------------
// Movement authority
// ---------------------------------------------------------------------------

const APPROACH_REPLY = "Wren crosses the room and stops right beside you.";
const approachRaw = (band: "touching" | "close", facing: "toward" | null, evidence: string) => ({
  version: 1,
  movement: { kind: "approach", actorRef: "npc_0", counterpartRef: "player", band, facing, evidence },
  contact: null,
});

describe("movement authority — an admitted approach commits", () => {
  it("writes the band as an NPC-origin fact and carries the committed intent as provenance", () => {
    const { execution } = run({
      reply: APPROACH_REPLY,
      scene: seededScene(),
      raw: approachRaw("touching", null, APPROACH_REPLY),
    });

    expect(execution.actions).toHaveLength(1);
    const action = execution.actions[0];
    if (!action) throw new Error("no action");
    expect(action.kind).toBe("movement");
    expect(action.resolution).toBe("committed");
    expect(action.contactRows).toEqual([]);

    // A movement leaves NO ledger row — the envelope's blob is its only durable
    // provenance, which is why it carries the real intent and its commit.
    const committed = action.committed as
      | { intent: { origin: string; subjectId: string }; commit: { kind: string } }
      | undefined;
    expect(committed?.intent.origin).toBe("npc");
    expect(committed?.intent.subjectId).toBe(WREN);
    expect(committed?.commit.kind).toBe("set_proximity");

    const fact = sceneProximityFact(execution.scene, WREN, CHAT_CONTACT_PLAYER_SUBJECT);
    expect(fact?.value).toBe("touching");
    expect(fact?.provenance.source).toBe("npc_decision");
    // Facing was not proposed, so nothing turned her.
    expect(sceneFacingFact(execution.scene, WREN, CHAT_CONTACT_PLAYER_SUBJECT)).toBeUndefined();
    expect(execution.commits).toEqual([]);
  });

  it("writes facing beside proximity when the candidate proposed it and congruence proved it", () => {
    const reply = "Wren steps closer to you, turning to face you.";
    const { execution } = run({
      reply,
      scene: seededScene(),
      raw: approachRaw("close", "toward", reply),
    });
    expect(execution.actions[0]?.resolution).toBe("committed");
    expect(sceneProximityFact(execution.scene, WREN, CHAT_CONTACT_PLAYER_SUBJECT)?.value).toBe("close");
    expect(sceneFacingFact(execution.scene, WREN, CHAT_CONTACT_PLAYER_SUBJECT)?.value).toBe("toward");
  });

  it("refuses to downgrade a pair the scene already calls `touching` — recorded, not committed", () => {
    const reply = "Wren steps closer to you.";
    const before = placedByPlayer("touching");
    const { execution } = run({ reply, scene: before, raw: approachRaw("close", null, reply) });
    const action = execution.actions[0];
    expect(action?.resolution).toBe("continued");
    expect(action?.detail).toBe("band_not_nearer");
    expect(action?.committed).toBeUndefined();
    expect(sceneProximityFact(execution.scene, WREN, CHAT_CONTACT_PLAYER_SUBJECT)?.value).toBe("touching");
  });
});

const DEPART_REPLY = "Wren steps away from you.";
const departRaw = (band: "near" | "distant", evidence: string) => ({
  version: 1,
  movement: { kind: "depart", actorRef: "npc_0", counterpartRef: "player", band, evidence },
  contact: null,
});

describe("movement authority — an admitted departure widens, and never invents", () => {
  it("widens a distance somebody stated", () => {
    const { execution } = run({
      reply: DEPART_REPLY,
      scene: placedByPlayer("close"),
      raw: departRaw("near", DEPART_REPLY),
    });
    expect(execution.actions[0]?.resolution).toBe("committed");
    expect(sceneProximityFact(execution.scene, WREN, CHAT_CONTACT_PLAYER_SUBJECT)?.value).toBe("near");
  });

  it("says nothing at all about a pair with neither a fact nor a contact", () => {
    const { execution } = run({
      reply: DEPART_REPLY,
      scene: seededScene(),
      raw: departRaw("near", DEPART_REPLY),
    });
    const action = execution.actions[0];
    expect(action?.resolution).toBe("continued");
    expect(action?.detail).toBe("band_unstated");
    expect(sceneProximityFact(execution.scene, WREN, CHAT_CONTACT_PLAYER_SUBJECT)).toBeUndefined();
  });

  it("never makes a placed pair nearer", () => {
    const { execution } = run({
      reply: DEPART_REPLY,
      scene: placedByPlayer("distant"),
      raw: departRaw("near", DEPART_REPLY),
    });
    expect(execution.actions[0]?.detail).toBe("band_not_wider");
    expect(sceneProximityFact(execution.scene, WREN, CHAT_CONTACT_PLAYER_SUBJECT)?.value).toBe("distant");
  });
});

// ---------------------------------------------------------------------------
// Contact starts (increment 2)
// ---------------------------------------------------------------------------

const START_REPLY = "Wren rests her hand on your shoulder.";
const startRaw = (evidence: string, targetLocationId = "shoulders", gesture = "rest") => ({
  version: 1,
  movement: null,
  contact: { kind: "start", actorRef: "npc_0", targetRef: "player", gesture, targetLocationId, evidence },
});

/**
 * The one scene an NPC start can land in without a movement of its own.
 *
 * `touching` deliberately: at any nearer-than-touching band the reach read
 * consults the ACTOR's own facing, and nothing the player's leg wrote turns
 * HER — a scene placed only by the player answers `facing_unknown` for an NPC
 * reaching back.
 */
function touchingScene(): SceneState {
  return placedByPlayer("touching");
}

/** The same scene with one body's controller rewritten — the actor-control mirror. */
function withControl(
  scene: SceneState,
  subjectId: AffordanceSubjectId,
  value: "player_controlled" | "npc_controlled",
): SceneState {
  const placed = sceneParticipant(scene, subjectId);
  if (placed === undefined) throw new Error("fixture: the body must already be placed");
  return withSceneParticipant(scene, {
    ...placed,
    control: sceneFact(value, sceneProvenance({ source: "authored", ref: REF, storyTime: AT })),
  });
}

describe("contact starts — an admitted start commits through the shared adapter", () => {
  it("writes a durable contact row, advances the scene, and records a COMPACT reference", () => {
    const { execution } = run({
      reply: START_REPLY,
      scene: touchingScene(),
      raw: startRaw(START_REPLY),
    });

    const action = execution.actions[0];
    expect(action?.kind).toBe("contact");
    expect(action?.resolution).toBe("committed");
    expect(action?.contactRows).toEqual([{ eventRef: EVENT, sequence: 0 }]);
    expect(execution.commits).toHaveLength(1);
    expect(execution.commits[0]).toMatchObject({ kind: "contact_started" });

    // The contact's own ledger row is the provenance; the blob carries only the
    // handle a reader needs to find it.
    const committed = action?.committed as { contactId?: string; kind?: string } | undefined;
    expect(committed?.kind).toBe("contact_started");
    expect(committed?.contactId).toEqual(expect.any(String));
    expect(JSON.stringify(committed ?? {}).length).toBeLessThan(200);

    const contact = execution.scene.contacts.contacts[0];
    expect(contact?.actorId).toBe(WREN);
    expect(contact?.source).toMatchObject({ subjectId: WREN, locationId: "hands" });
    expect(contact?.target).toMatchObject({ subjectId: CHAT_CONTACT_PLAYER_SUBJECT, locationId: "shoulders" });
    expect(contact?.actionKind).toBe("affectionate");
  });

  it("refuses a start over a PLAYER-controlled body — an answer, not a gap", () => {
    // The mirror of the player leg's law. The classifier can only ever name an
    // NPC as the actor, so the one way an NPC-origin act reaches a
    // player-controlled body is a scene whose control fact says her body is the
    // player's — and then the control read denies it, exactly as a player line
    // over an `npc_controlled` body is denied on the other leg.
    const { execution } = run({
      reply: START_REPLY,
      scene: withControl(touchingScene(), WREN, "player_controlled"),
      raw: startRaw(START_REPLY),
    });
    expect(execution.actions[0]?.resolution).toBe("refused");
    expect(execution.actions[0]?.detail).toBe("actor_control_denied");
    expect(execution.commits).toEqual([]);
    expect(execution.scene.contacts.contacts).toEqual([]);
  });

  it("stays silent when the TARGET is dressed in something nobody modelled", () => {
    const { execution } = run({
      reply: START_REPLY,
      scene: touchingScene(),
      raw: startRaw(START_REPLY),
      material: new Map([
        [WREN, adapterSupported(emptyEffectiveCoverageRead())],
        [CHAT_CONTACT_PLAYER_SUBJECT, adapterUnavailable],
      ]),
    });
    expect(execution.actions[0]?.resolution).toBe("unresolved");
    expect(execution.actions[0]?.detail).toBe("material_unavailable");
    expect(execution.commits).toEqual([]);
    expect(execution.scene.contacts.contacts).toEqual([]);
  });

  it("stays silent when the ACTOR's own hand is dressed in something nobody modelled", () => {
    const { execution } = run({
      reply: START_REPLY,
      scene: touchingScene(),
      raw: startRaw(START_REPLY),
      material: new Map([
        [WREN, adapterUnavailable],
        [CHAT_CONTACT_PLAYER_SUBJECT, adapterSupported(emptyEffectiveCoverageRead())],
      ]),
    });
    expect(execution.actions[0]?.resolution).toBe("unresolved");
    expect(execution.actions[0]?.detail).toBe("material_unavailable");
    expect(execution.scene.contacts.contacts).toEqual([]);
  });

  it("a body the garment cut never answered for reads unavailable, never bare", () => {
    const { execution } = run({
      reply: START_REPLY,
      scene: touchingScene(),
      raw: startRaw(START_REPLY),
      material: new Map(),
    });
    expect(execution.actions[0]?.resolution).toBe("unresolved");
    expect(execution.actions[0]?.detail).toBe("material_unavailable");
  });

  it("composes the NPC's glove ahead of the target's garment in the committed material", () => {
    const { execution } = run({
      reply: START_REPLY,
      scene: touchingScene(),
      raw: startRaw(START_REPLY),
      material: new Map([
        [WREN, covered({ locationId: "hands", band: "opaque" })],
        [CHAT_CONTACT_PLAYER_SUBJECT, covered({ locationId: "shoulders", band: "hinted" })],
      ]),
    });
    expect(execution.actions[0]?.resolution).toBe("committed");
    const contact = execution.scene.contacts.contacts[0];
    // Source first, target after — one continuous stack, and the side prefixes
    // are what keep two `hands` reads from collapsing into one layer.
    expect(contact?.materialBetween.map((layer) => layer.layerId)).toEqual([
      "source:coverage:hands",
      "target:coverage:shoulders",
    ]);
    expect(contact?.materialBetween.map((layer) => layer.order)).toEqual([0, 1]);
  });
});

describe("the same-reply wardrobe-change veto", () => {
  it("drops a start whose TARGET was re-dressed this exchange — no row, no action entry", () => {
    const sink = new DiagnosticCollector();
    const { execution } = run({
      reply: START_REPLY,
      scene: touchingScene(),
      raw: startRaw(START_REPLY),
      wardrobeChanged: new Set([CHAT_CONTACT_PLAYER_SUBJECT]),
      sink,
    });
    expect(execution.drops).toEqual([
      // The sentence the start was grounded on rides the drop: a veto is only
      // reviewable beside the touch it refused to date.
      expect.objectContaining({
        candidate: "contact",
        reason: "wardrobe_chronology_ambiguous",
        evidence: START_REPLY,
      }),
    ]);
    expect(codes(sink)).toContain("npc_scene_decision.wardrobe_chronology_ambiguous");
    // A DROP, not a recorded resolution: no resolver ran, so no action entry.
    expect(execution.actions).toEqual([]);
    expect(execution.commits).toEqual([]);
    expect(execution.scene.contacts.contacts).toEqual([]);
  });

  it("drops it for the ACTOR's own wardrobe too — a glove that came off is the same problem", () => {
    const { execution } = run({
      reply: START_REPLY,
      scene: touchingScene(),
      raw: startRaw(START_REPLY),
      wardrobeChanged: new Set([WREN]),
    });
    expect(execution.drops[0]?.reason).toBe("wardrobe_chronology_ambiguous");
    expect(execution.drops[0]?.evidence).toBe(START_REPLY);
    expect(execution.actions).toEqual([]);
  });

  it("leaves an unrelated body's wardrobe change alone", () => {
    const { execution } = run({
      reply: START_REPLY,
      scene: touchingScene(),
      raw: startRaw(START_REPLY),
      wardrobeChanged: new Set([affordanceSubjectId("character_sabrina")]),
    });
    expect(execution.drops).toEqual([]);
    expect(execution.actions[0]?.resolution).toBe("committed");
  });
});

// ---------------------------------------------------------------------------
// The rollout scope knob
// ---------------------------------------------------------------------------

describe("the authority scope knob gates EXECUTION only", () => {
  it("excluding `movement` records the admitted candidate dry and leaves the scene alone", () => {
    process.env.CHAT_NPC_SCENE_DECISION_AUTHORITY_KINDS = "start,update";
    const { admission, execution } = run({
      reply: APPROACH_REPLY,
      scene: seededScene(),
      raw: approachRaw("touching", null, APPROACH_REPLY),
    });
    // Admission is untouched by the knob — the measurement stays continuous
    // across a rollout step.
    expect(admission.slots.movement).toBe("parsed");
    expect(admission.drops).toEqual([]);
    const action = execution.actions[0];
    expect(action?.kind).toBe("movement");
    expect(action?.resolution).toBe("unresolved");
    expect(action?.detail).toBe("authority_scope_excluded");
    expect(sceneProximityFact(execution.scene, WREN, CHAT_CONTACT_PLAYER_SUBJECT)).toBeUndefined();
  });

  it("excluding `start` records the admitted start dry and writes no contact", () => {
    process.env.CHAT_NPC_SCENE_DECISION_AUTHORITY_KINDS = "movement";
    const { admission, execution } = run({
      reply: START_REPLY,
      scene: touchingScene(),
      raw: startRaw(START_REPLY),
    });
    expect(admission.slots.contact).toBe("parsed");
    expect(admission.drops).toEqual([]);
    const action = execution.actions[0];
    expect(action?.kind).toBe("contact");
    expect(action?.resolution).toBe("unresolved");
    expect(action?.detail).toBe("authority_scope_excluded");
    expect(execution.commits).toEqual([]);
    expect(execution.scene.contacts.contacts).toEqual([]);
  });

  it.each([
    ["blank", "  "],
    ["unset", undefined],
  ])("a %s value grants the first increment only — movement runs, a start does not", (_label, value) => {
    if (value === undefined) delete process.env.CHAT_NPC_SCENE_DECISION_AUTHORITY_KINDS;
    else process.env.CHAT_NPC_SCENE_DECISION_AUTHORITY_KINDS = value;

    const movement = run({
      reply: APPROACH_REPLY,
      scene: seededScene(),
      raw: approachRaw("touching", null, APPROACH_REPLY),
    });
    expect(movement.execution.actions[0]?.resolution).toBe("committed");

    // The safeguard: forgetting the scope secret cannot skip the staged rollout
    // to contact authority. A start is admitted and recorded, never executed.
    const start = run({
      reply: START_REPLY,
      scene: touchingScene(),
      raw: startRaw(START_REPLY),
    });
    expect(start.execution.actions[0]?.resolution).toBe("unresolved");
    expect(start.execution.actions[0]?.detail).toBe("authority_scope_excluded");
    expect(start.execution.scene.contacts.contacts).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Ordering — the reply's own written order is the execution order
// ---------------------------------------------------------------------------

describe("the ordered walk", () => {
  it('"she crosses the room, then takes your hand" resolves the START against the nearer scene', () => {
    const reply = `${APPROACH_REPLY} She takes your hand.`;
    const { execution } = run({
      reply,
      // NOBODY has been placed: the start is only reachable because the approach
      // in the same reply ran FIRST and stated a distance. Against the scene as
      // it arrives, the reach read answers `proximity_unknown` and the start is
      // silence — so a commit here IS the ordered walk working.
      scene: seededScene(),
      raw: {
        version: 1,
        movement: {
          kind: "approach",
          actorRef: "npc_0",
          counterpartRef: "player",
          band: "touching",
          facing: null,
          evidence: APPROACH_REPLY,
        },
        contact: {
          kind: "start",
          actorRef: "npc_0",
          targetRef: "player",
          gesture: "rest",
          targetLocationId: "hands",
          evidence: "She takes your hand.",
        },
      },
    });
    expect(execution.actions.map((action) => action.kind)).toEqual(["movement", "contact"]);
    expect(execution.actions[0]?.resolution).toBe("committed");
    expect(execution.actions[1]?.resolution).toBe("committed");
    expect(sceneProximityFact(execution.scene, WREN, CHAT_CONTACT_PLAYER_SUBJECT)?.value).toBe("touching");
    expect(execution.scene.contacts.contacts).toHaveLength(1);

    // The same candidate WITHOUT its approach: the pair is unplaced, so the
    // resolver cannot say whether the hand reaches at all.
    const alone = run({
      reply: "She takes your hand.",
      scene: seededScene(),
      raw: {
        version: 1,
        movement: null,
        contact: {
          kind: "start",
          actorRef: "npc_0",
          targetRef: "player",
          gesture: "rest",
          targetLocationId: "hands",
          evidence: "She takes your hand.",
        },
      },
    });
    expect(alone.execution.actions[0]?.resolution).toBe("unresolved");
    expect(alone.execution.actions[0]?.detail).toBe("geometry_unavailable");
    expect(alone.execution.scene.contacts.contacts).toEqual([]);
  });

  it('"she squeezes your hand, then steps away" updates FIRST, then widens', () => {
    const held = npcHeldTouch();
    const reply = "Wren squeezes your hand. She steps away.";
    const { execution } = run({
      reply,
      scene: held.scene,
      build: digestWithHeldTouch(held.contactId),
      raw: {
        version: 1,
        movement: {
          kind: "depart",
          actorRef: "npc_0",
          counterpartRef: "player",
          band: "near",
          evidence: "She steps away.",
        },
        contact: {
          kind: "update",
          actorRef: "npc_0",
          contactRef: "contact_0",
          gesture: "squeeze",
          evidence: "Wren squeezes your hand.",
        },
      },
    });
    // The spec's own worked example, and the order is the reply's: the squeeze
    // lands on a contact that is still held, and the departure follows it.
    expect(execution.actions.map((action) => action.kind)).toEqual(["contact", "movement"]);
    expect(execution.actions[0]?.resolution).toBe("committed");
    expect(execution.actions[1]?.resolution).toBe("committed");
    expect(execution.scene.contacts.contacts[0]?.pressure).toBe("moderate");
    expect(sceneProximityFact(execution.scene, WREN, CHAT_CONTACT_PLAYER_SUBJECT)?.value).toBe("near");
  });
});

// ---------------------------------------------------------------------------
// Contact updates (increment 3)
// ---------------------------------------------------------------------------

/** The one sentence that starts a contact by HER hand — the only kind an update may modulate. */
const NPC_TOUCH_SENTENCE = "She takes your hand.";
const NPC_TOUCH_RAW = {
  version: 1,
  movement: null,
  contact: {
    kind: "start",
    actorRef: "npc_0",
    targetRef: "player",
    gesture: "rest",
    targetLocationId: "hands",
    evidence: NPC_TOUCH_SENTENCE,
  },
};

/**
 * A live contact WREN made, committed by the executor's own start leg.
 *
 * Built through the real path rather than hand-assembled, so the identity the
 * update's re-check reads is the identity a start actually writes.
 */
function npcHeldTouch(material?: NpcSceneMaterialCut): { scene: SceneState; contactId: string } {
  const { execution } = run({
    reply: NPC_TOUCH_SENTENCE,
    scene: touchingScene(),
    raw: NPC_TOUCH_RAW,
    ...(material === undefined ? {} : { material }),
  });
  const contact = execution.scene.contacts.contacts[0];
  if (!contact) throw new Error("fixture: the NPC's touch must commit");
  return { scene: execution.scene, contactId: contact.contactId };
}

/**
 * One squeeze against a scene whose STORED contact identity was rewritten — the
 * re-check's mirror. The digest still describes her lawful affectionate hand
 * contact, so admission passes and only the post-settle read can refuse it.
 */
function conflictOn(patch: (contact: CommittedContactRead) => CommittedContactRead) {
  const held = npcHeldTouch();
  return run({
    reply: SQUEEZE_REPLY,
    scene: withSceneContacts(held.scene, {
      ...held.scene.contacts,
      contacts: held.scene.contacts.contacts.map(patch),
    }),
    build: digestWithHeldTouch(held.contactId),
    raw: updateRaw("squeeze", SQUEEZE_REPLY),
  });
}

const updateRaw = (gesture: string, evidence: string, contactRef = "contact_0") => ({
  version: 1,
  movement: null,
  contact: { kind: "update", actorRef: "npc_0", contactRef, gesture, evidence },
});

const SQUEEZE_REPLY = "Wren squeezes your hand.";
/** The own-hand shape: a modulation back to a plain rest, with no surface named. */
const STILL_REPLY = "Wren stills her hand.";

describe("contact updates — an admitted update modulates the gesture and nothing else", () => {
  it("writes a durable contact_updated row and moves ONLY the pressure", () => {
    const held = npcHeldTouch();
    const before = held.scene.contacts.contacts[0];
    if (!before) throw new Error("fixture: no held contact");

    const { execution } = run({
      reply: SQUEEZE_REPLY,
      scene: held.scene,
      build: digestWithHeldTouch(held.contactId),
      raw: updateRaw("squeeze", SQUEEZE_REPLY),
    });

    const action = execution.actions[0];
    expect(action?.kind).toBe("contact");
    expect(action?.resolution).toBe("committed");
    expect(action?.detail).toBe("contact_updated");
    expect(action?.contactRows).toEqual([{ eventRef: EVENT, sequence: 0 }]);
    expect(execution.commits).toHaveLength(1);
    expect(execution.commits[0]).toMatchObject({ kind: "contact_updated", contactId: held.contactId });
    expect(execution.drops).toEqual([]);

    // The compact handle, exactly as a committed start records one.
    const committed = action?.committed as { contactId?: string; kind?: string } | undefined;
    expect(committed).toEqual({ contactId: held.contactId, kind: "contact_updated" });

    const after = execution.scene.contacts.contacts[0];
    expect(after?.contactId).toBe(held.contactId);
    expect(after?.pressure).toBe("moderate");
    // Identity, orientation, and the start authorization: untouched.
    expect(after?.actorId).toBe(before.actorId);
    expect(after?.source).toEqual(before.source);
    expect(after?.target).toEqual(before.target);
    expect(after?.actionKind).toBe("affectionate");
    expect(after?.startedByEventRef).toBe(before.startedByEventRef);
    expect(after?.startedAt).toBe(before.startedAt);
    expect(after?.actorControl).toEqual(before.actorControl);
  });

  it("preserves the material the touch landed through, byte for byte", () => {
    // The whole reason an update is not a re-resolution: this cut is the POST
    // settle wardrobe, and a start would have to be vetoed over it.
    const held = npcHeldTouch(
      new Map([
        [WREN, covered({ locationId: "hands", band: "opaque" })],
        [CHAT_CONTACT_PLAYER_SUBJECT, covered({ locationId: "hands", band: "hinted" })],
      ]),
    );
    const before = held.scene.contacts.contacts[0];
    if (!before) throw new Error("fixture: no held contact");
    expect(before.materialBetween.map((layer) => layer.layerId)).toEqual([
      "source:coverage:hands",
      "target:coverage:hands",
    ]);

    const { execution } = run({
      reply: SQUEEZE_REPLY,
      scene: held.scene,
      build: digestWithHeldTouch(held.contactId),
      raw: updateRaw("squeeze", SQUEEZE_REPLY),
      // A material cut the update never reads — an update composes nothing.
      material: new Map(),
    });
    const after = execution.scene.contacts.contacts[0];
    expect(execution.actions[0]?.resolution).toBe("committed");
    expect(after?.materialBetween).toEqual(before.materialBetween);
    expect(after?.transmission).toEqual(before.transmission);
    expect(after?.implicitAdjustments).toEqual(before.implicitAdjustments);
  });

  it("writes NO row for the gesture the contact already holds", () => {
    const held = npcHeldTouch();
    const { execution } = run({
      reply: STILL_REPLY,
      scene: held.scene,
      build: digestWithHeldTouch(held.contactId),
      raw: updateRaw("rest", STILL_REPLY),
    });
    const action = execution.actions[0];
    expect(action?.resolution).toBe("continued");
    expect(action?.detail).toBe("contact_continued gesture_unchanged");
    expect(action?.contactRows).toEqual([]);
    expect(action?.committed).toBeUndefined();
    // The commit still rides the ONE ledger list, so its sequence index matches
    // what `chatContactEventRowsFor` assigns when the transaction writes them.
    expect(execution.commits).toHaveLength(1);
    expect(execution.commits[0]?.kind).toBe("contact_continued");
    expect(execution.scene.contacts.contacts[0]).toEqual(held.scene.contacts.contacts[0]);
  });
});

describe("contact updates — the post-settle re-check is the authority, never the handle", () => {
  it("drops as contact_conflict when the walk ALREADY ended the contact", () => {
    const held = npcHeldTouch();
    const sink = new DiagnosticCollector();
    const reply = `She lets go of you. ${SQUEEZE_REPLY}`;
    const { execution } = run({
      reply,
      scene: held.scene,
      build: digestWithHeldTouch(held.contactId),
      raw: updateRaw("squeeze", SQUEEZE_REPLY),
      // The frozen floor's ending, ordered ahead of the update by its own span.
      floor: { ending: { subjectId: WREN, reason: "withdrawn" }, subjectRef: "npc_0", span: { start: 0, end: 19 } },
      sink,
    });
    expect(execution.actions.map((action) => action.kind)).toEqual(["floor_ending"]);
    expect(execution.actions[0]?.resolution).toBe("committed");
    expect(execution.drops).toEqual([
      expect.objectContaining({
        candidate: "contact",
        reason: "contact_conflict",
        field: "contactRef",
        evidence: SQUEEZE_REPLY,
      }),
    ]);
    expect(codes(sink)).toContain("npc_scene_decision.contact_conflict");
    // Never promoted to a start: the projection is empty, not holding a new touch.
    expect(execution.scene.contacts.contacts).toEqual([]);
    expect(execution.commits).toHaveLength(1);
  });

  it("never modulates ANOTHER actor's contact", () => {
    // The digest says this is her affectionate hand contact; the live projection
    // says the PLAYER made it. The scene wins.
    const held = heldTouch();
    const { execution } = run({
      reply: SQUEEZE_REPLY,
      scene: held.scene,
      build: digestWithHeldTouch(held.contactId),
      raw: updateRaw("squeeze", SQUEEZE_REPLY),
    });
    expect(execution.drops).toEqual([
      expect.objectContaining({ reason: "contact_conflict", field: "actorId", evidence: SQUEEZE_REPLY }),
    ]);
    expect(execution.actions).toEqual([]);
    expect(execution.commits).toEqual([]);
    expect(execution.scene.contacts.contacts[0]?.pressure).toBe(held.scene.contacts.contacts[0]?.pressure);
  });

  it("refuses a contact whose source is not the actor's hands", () => {
    const { execution } = conflictOn((contact) => ({
      ...contact,
      source: { ...contact.source, locationId: "arms" },
    }));
    expect(execution.drops).toEqual([
      expect.objectContaining({ reason: "contact_conflict", field: "source", evidence: SQUEEZE_REPLY }),
    ]);
    expect(execution.commits).toEqual([]);
  });

  it("refuses a contact whose action kind is not affectionate", () => {
    const { execution } = conflictOn((contact) => ({ ...contact, actionKind: "romantic" }));
    expect(execution.drops).toEqual([
      expect.objectContaining({ reason: "contact_conflict", field: "actionKind", evidence: SQUEEZE_REPLY }),
    ]);
    expect(execution.commits).toEqual([]);
  });

  it("records a contactRef no handle map can translate as an unresolved ref, not a conflict", () => {
    const held = npcHeldTouch();
    const { execution } = run({
      reply: SQUEEZE_REPLY,
      scene: held.scene,
      build: digestWithHeldTouch(held.contactId),
      // A handle map built for a contactless digest: the executor and the digest
      // disagree about what `contact_0` means, which is plumbing, not scene.
      handles: digestOf().handles,
      raw: updateRaw("squeeze", SQUEEZE_REPLY),
    });
    expect(execution.actions[0]?.resolution).toBe("unresolved");
    expect(execution.actions[0]?.detail).toBe("ref_unresolved");
    expect(execution.drops).toEqual([]);
    expect(execution.commits).toEqual([]);
  });

  it("the scope knob excluding `update` records it dry and modulates nothing", () => {
    process.env.CHAT_NPC_SCENE_DECISION_AUTHORITY_KINDS = "movement,start";
    try {
      const held = npcHeldTouch();
      const { admission, execution } = run({
        reply: SQUEEZE_REPLY,
        scene: held.scene,
        build: digestWithHeldTouch(held.contactId),
        raw: updateRaw("squeeze", SQUEEZE_REPLY),
      });
      expect(admission.slots.contact).toBe("parsed");
      expect(admission.drops).toEqual([]);
      expect(execution.actions[0]?.resolution).toBe("unresolved");
      expect(execution.actions[0]?.detail).toBe("authority_scope_excluded");
      expect(execution.commits).toEqual([]);
      expect(execution.scene.contacts.contacts[0]?.pressure).toBe("light");
    } finally {
      delete process.env.CHAT_NPC_SCENE_DECISION_AUTHORITY_KINDS;
    }
  });
});

// ---------------------------------------------------------------------------
// Presence integration
// ---------------------------------------------------------------------------

describe("presence integration runs before any proposal resolves", () => {
  it("ends an away member's contacts as `separated`, first in the ledger", () => {
    const held = heldTouch();
    const { execution } = run({
      reply: "Wren is nowhere to be seen.",
      scene: held.scene,
      present: false,
    });
    expect(execution.actions.map((action) => action.kind)).toEqual(["presence_ending"]);
    expect(execution.actions[0]?.resolution).toBe("committed");
    expect(execution.actions[0]?.detail).toBe("presence_away_separated presence_away_relations_cleared");
    expect(execution.actions[0]?.contactRows).toEqual([{ eventRef: EVENT, sequence: 0 }]);
    expect(execution.commits).toHaveLength(1);
    expect(execution.commits[0]).toMatchObject({ kind: "contact_ended", reason: "separated" });
    expect(execution.scene.contacts.contacts).toEqual([]);
  });

  it("takes an away member's DISTANCE with them, so a remembered `close` cannot satisfy reach", () => {
    // The stale-relation hazard: she was `close` when she left. If the band
    // survived her departure, a start narrated after she came back would pass
    // the reach read on a distance nobody re-established.
    const { execution } = run({
      reply: "Wren is nowhere to be seen.",
      scene: placedByPlayer("close"),
      present: false,
    });
    expect(sceneProximityFact(execution.scene, WREN, CHAT_CONTACT_PLAYER_SUBJECT)).toBeUndefined();
    expect(execution.scene.facing).toEqual([]);
    // The participant row itself stays — control and posture are facts about one
    // body, and re-seeding her on return would overwrite an authored posture.
    expect(sceneParticipant(execution.scene, WREN)?.control?.value).toBe("npc_controlled");
    expect(execution.actions[0]?.detail).toBe("presence_away_relations_cleared");
    expect(execution.actions[0]?.contactRows).toEqual([]);
    expect(execution.commits).toEqual([]);
  });

  it("records nothing for an away member who held neither a contact nor a distance", () => {
    const { execution } = run({
      reply: "Wren is nowhere to be seen.",
      scene: emptySceneState(),
      present: false,
    });
    expect(execution.actions).toEqual([]);
    expect(execution.commits).toEqual([]);
  });

  it("seeds a member the cut says is PRESENT, so an arrival narrated this reply can act", () => {
    // The scene is empty: nobody has ever been placed in it, so without the
    // seeding step every intent about Wren would answer `control_unresolved`.
    const { execution } = run({
      reply: APPROACH_REPLY,
      scene: emptySceneState(),
      raw: approachRaw("touching", null, APPROACH_REPLY),
    });
    expect(execution.actions[0]?.resolution).toBe("committed");
    expect(sceneProximityFact(execution.scene, WREN, CHAT_CONTACT_PLAYER_SUBJECT)?.value).toBe("touching");
  });
});

// ---------------------------------------------------------------------------
// The composite departure, and the unordered floor
// ---------------------------------------------------------------------------

/** The floor's detected ending, as the executor takes it. */
function floorOf(span: NpcSceneReplySpan | null): NpcSceneExecutionFloor {
  return { ending: { subjectId: WREN, reason: "separated" }, subjectRef: "npc_0", span };
}

describe("the composite departure — compute, fold, apply", () => {
  it("reads the band from the scene BEFORE the ending, and runs the ending once", () => {
    const held = heldTouch();
    // The pair is UNPLACED: the live contact is the only thing that licenses a
    // distance claim at all, so a band computed after the fold would be `null`.
    const unplaced: SceneState = { ...held.scene, proximity: [] };
    const raw = departRaw("near", DEPART_REPLY);

    // Recover the depart's own action span first, then hand the floor that exact
    // span — span equality is what the planner composites on.
    const probe = run({ reply: DEPART_REPLY, scene: unplaced, raw });
    const span = probe.execution.actions[0]?.span;
    if (!span) throw new Error("no admitted depart span");

    const { execution } = run({ reply: DEPART_REPLY, scene: unplaced, raw, floor: floorOf(span) });
    expect(execution.actions.map((action) => action.kind)).toEqual(["floor_ending", "movement"]);
    expect(execution.actions[0]?.detail).toContain("composite_departure");
    expect(execution.actions[1]?.detail).toContain("composite_departure");
    // The ending ran exactly once...
    expect(execution.commits).toHaveLength(1);
    expect(execution.scene.contacts.contacts).toEqual([]);
    // ...and the distance the contact licensed still landed.
    expect(execution.actions[1]?.resolution).toBe("committed");
    expect(sceneProximityFact(execution.scene, WREN, CHAT_CONTACT_PLAYER_SUBJECT)?.value).toBe("near");
  });
});

describe("an unordered floor drops every tier-2 candidate", () => {
  it("applies the floor alone and files chronology_ambiguous for the rest", () => {
    const held = heldTouch();
    const sink = new DiagnosticCollector();
    const { execution } = run({
      reply: APPROACH_REPLY,
      scene: held.scene,
      raw: approachRaw("touching", null, APPROACH_REPLY),
      // A floor whose sentence could not be located cannot be totally ordered
      // against anything, and the chronology rule refuses to guess.
      floor: floorOf(null),
      sink,
    });
    expect(execution.drops).toEqual([
      expect.objectContaining({
        candidate: "movement",
        reason: "chronology_ambiguous",
        evidence: APPROACH_REPLY,
      }),
    ]);
    expect(codes(sink)).toContain("npc_scene_decision.chronology_ambiguous");
    expect(execution.actions.map((action) => action.kind)).toEqual(["floor_ending"]);
    expect(execution.actions[0]?.detail).toContain("span_unlocated");
    expect(execution.actions[0]?.span).toEqual({ start: 0, end: APPROACH_REPLY.length });
    // The approach never ran: the pair keeps the distance the player's leg set.
    expect(sceneProximityFact(execution.scene, WREN, CHAT_CONTACT_PLAYER_SUBJECT)?.value).toBe("close");
    expect(execution.scene.contacts.contacts).toEqual([]);
  });
});
