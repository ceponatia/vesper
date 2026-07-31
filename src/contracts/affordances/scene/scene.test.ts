import { describe, expect, it } from "vitest";
import { bodyLocationRegistry } from "../../body/locations";
import { DiagnosticCollector } from "../../diagnostics";
import { adapterSupported, adapterUnavailable, affordanceSubjectId, isAdapterSupported } from "../core";
import {
  commitContactResolution,
  contactEventRef,
  emptyContactLifecycleState,
  resolveContactAttempt,
  type ContactActionContext,
  type ContactActionIntent,
  type ContactSurfaceRef,
} from "../contact";
import {
  SCENE_CONTROL_UNAVAILABLE,
  SCENE_INTENT_INVALID,
  SCENE_INTENT_STALE,
  SCENE_RELATION_UNAVAILABLE,
  SCENE_STATE_CONTRADICTORY,
  SCENE_STATE_INVALID,
} from "./diagnostics";
import { applySceneIntents, commitSceneIntent, type SceneMovementChange } from "./intents";
import {
  sceneBodyZoneOf,
  sceneGeometryRead,
  sceneReach,
  sceneSupportOf,
  sceneSupportRead,
} from "./relations";
import { parseSceneState } from "./snapshot";
import {
  SCENE_STATE_VERSION,
  emptySceneState,
  sceneParticipant,
  sceneStateOf,
  withSceneContacts,
  withSceneParticipant,
  withSceneProximity,
  type SceneState,
} from "./state";
import {
  PROBE_BED,
  PROBE_FLOOR,
  PROBE_NPC,
  PROBE_PLAYER,
  probeFact,
  probeLeaning,
  probeMovement,
  probeParticipant,
  probeProximity,
  probeScene,
  probeSupportRelation,
  probeSurface,
} from "./test-support";
import {
  SCENE_CONTROL_ORIGINS,
  SCENE_ORIGIN_PROVENANCE,
  SCENE_POSTURE_ZONE_RUNG,
  SCENE_ZONE_REACH_SPAN,
  sceneBodyZones,
  sceneIntentOrigins,
  scenePostures,
  sceneProvenanceSources,
} from "./vocabulary";

/**
 * Fixture-driven proof of the scene owner
 * (romantic-contact-affordances.spec.scene.md).
 *
 * Four things are being proved, and they are the four the owner asked for: the
 * actor-control law holds in both directions, an absent fact produces
 * `unresolved` rather than a guess, every read carries its provenance, and the
 * whole scene survives a snapshot round trip byte for byte.
 */

const HANDS = "hands";
const SHOULDERS = "shoulders";
const FEET = "feet";
const HEAD = "head";

function bodySurface(subjectId: typeof PROBE_PLAYER, locationId: string) {
  return { kind: "body", subjectId, locationId } as const;
}

function reachOf(state: SceneState, sourceLocation: string, targetLocation: string) {
  return sceneReach({
    state,
    source: bodySurface(PROBE_PLAYER, sourceLocation),
    target: bodySurface(PROBE_NPC, targetLocation),
  });
}

function codes(sink: DiagnosticCollector): string[] {
  return sink.items.map((item) => item.code);
}

/**
 * The stored blob's shape, as a test may edit it — loose where the point is to
 * write something the schema will refuse.
 */
interface StoredFact<TValue> {
  value: TValue;
  provenance: { source: string; ref: string; storyTime: number; evidence: unknown[] };
}
interface StoredSupportRelation {
  role: string;
  anchor: { kind: string; supportId?: string; subjectId?: string };
  loadZones: string[];
}
interface StoredParticipant {
  subjectId: string;
  control?: StoredFact<string>;
  posture?: StoredFact<string>;
  support?: StoredFact<StoredSupportRelation[]>;
}
interface StoredScene {
  version: number;
  participants: StoredParticipant[];
  supports: { supportId: string; kind: string; height: StoredFact<string> }[];
  proximity: { subjectId: string; otherId: string; band: StoredFact<string> }[];
  facing: { subjectId: string; towardId: string; facing: StoredFact<string> }[];
  contacts: { version: number; contacts: unknown[] };
}

/** The default scene as a stored blob, ready to be corrupted one field at a time. */
function storedScene(): StoredScene {
  return JSON.parse(JSON.stringify(probeScene())) as StoredScene;
}

/** The stored player, with the support set every contradiction case edits. */
function storedPlayerSupport(raw: StoredScene): StoredFact<StoredSupportRelation[]> {
  const player = raw.participants.find((entry) => entry.subjectId === PROBE_PLAYER);
  if (player?.support === undefined) throw new Error("fixture has no player support");
  return player.support;
}

// ---------------------------------------------------------------------------
// Vocabularies as data
// ---------------------------------------------------------------------------

describe("scene vocabularies", () => {
  it("names every zone after a root of the shared body tree", () => {
    for (const zone of sceneBodyZones) {
      const location = bodyLocationRegistry.byId(zone);
      expect(location, `zone ${zone} must be a body location`).toBeDefined();
      expect(location?.parentId, `zone ${zone} must be a root`).toBeUndefined();
    }
  });

  it("has a rung for every posture/zone pair and a span for every zone", () => {
    for (const posture of scenePostures) {
      for (const zone of sceneBodyZones) {
        expect(typeof SCENE_POSTURE_ZONE_RUNG[posture][zone]).toBe("number");
      }
    }
    for (const zone of sceneBodyZones) expect(typeof SCENE_ZONE_REACH_SPAN[zone]).toBe("number");
  });

  it("offers no way to source a fact from narration", () => {
    const forbidden = /narrat|prose|text|message|reply/u;
    for (const source of sceneProvenanceSources) expect(source).not.toMatch(forbidden);
    for (const origin of sceneIntentOrigins) expect(origin).not.toMatch(forbidden);
  });

  it("keeps the actor-control law in one data table", () => {
    expect(SCENE_CONTROL_ORIGINS.player_controlled).toEqual(["player"]);
    expect(SCENE_CONTROL_ORIGINS.npc_controlled).toEqual(["npc", "simulation"]);
    for (const origin of sceneIntentOrigins) {
      expect(SCENE_ORIGIN_PROVENANCE[origin]).not.toBe("authored");
      expect(SCENE_ORIGIN_PROVENANCE[origin]).not.toBe("scene_default");
    }
  });
});

// ---------------------------------------------------------------------------
// Zones
// ---------------------------------------------------------------------------

describe("body zones", () => {
  it("walks a deep locus up to its coarse zone", () => {
    expect(sceneBodyZoneOf("foot_arch")).toBe("legs");
    expect(sceneBodyZoneOf(SHOULDERS)).toBe("torso");
    expect(sceneBodyZoneOf("fingers")).toBe("arms");
    expect(sceneBodyZoneOf(HEAD)).toBe("head");
  });

  it("has no zone for a location the body tree does not know", () => {
    expect(sceneBodyZoneOf("tentacle")).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Reach
// ---------------------------------------------------------------------------

describe("reach", () => {
  it("answers the affectionate case: a standing hand to a standing shoulder", () => {
    const answer = reachOf(probeScene(), HANDS, SHOULDERS);
    expect(answer.status).toBe("resolved");
    if (answer.status !== "resolved") return;
    expect(answer.reach).toBe("within_reach");
    expect(answer.provenance.length).toBeGreaterThan(0);
  });

  it("reads contact as contact and a crossed room as out of reach", () => {
    const touching = reachOf(probeScene({ proximity: "touching" }), HANDS, SHOULDERS);
    expect(touching.status === "resolved" && touching.reach).toBe("in_contact");
    const near = reachOf(probeScene({ proximity: "near" }), HANDS, SHOULDERS);
    expect(near.status === "resolved" && near.reach).toBe("within_reach_after_adjustment");
    const distant = reachOf(probeScene({ proximity: "distant" }), HANDS, SHOULDERS);
    expect(distant.status === "resolved" && distant.reach).toBe("out_of_reach");
  });

  it("does not demand a posture it would not use", () => {
    // Two bodies in different parts of the room are out of reach whatever they
    // are doing, so an unstated posture must not turn an answer into a gap.
    const state = probeScene({
      proximity: "distant",
      player: probeParticipant(PROBE_PLAYER, { posture: null }),
      npc: probeParticipant(PROBE_NPC, { posture: null }),
    });
    const answer = reachOf(state, HANDS, SHOULDERS);
    expect(answer.status === "resolved" && answer.reach).toBe("out_of_reach");
  });

  it("costs a step for a body turned away, and ignores facing once they touch", () => {
    const away = reachOf(probeScene({ facing: "away" }), HANDS, SHOULDERS);
    expect(away.status === "resolved" && away.reach).toBe("within_reach_after_adjustment");

    const touchingBlind = reachOf(probeScene({ proximity: "touching", facing: null }), HANDS, SHOULDERS);
    expect(touchingBlind.status === "resolved" && touchingBlind.reach).toBe("in_contact");
  });

  it("puts a standing head out of a foot's reach and a standing torso one adjustment away", () => {
    const state = probeScene();
    expect(reachOf(state, FEET, HEAD)).toMatchObject({ status: "resolved", reach: "out_of_reach" });
    expect(reachOf(state, FEET, SHOULDERS)).toMatchObject({
      status: "resolved",
      reach: "within_reach_after_adjustment",
    });
  });

  it("lets surface height change the answer", () => {
    const onFloor = reachOf(probeScene(), HANDS, HEAD);
    expect(onFloor.status === "resolved" && onFloor.reach).toBe("within_reach");

    const onTable = probeScene({
      npc: probeParticipant(PROBE_NPC, {
        support: [probeSupportRelation({ anchor: { kind: "surface", supportId: PROBE_BED } })],
      }),
      supports: [probeSurface(), probeSurface(PROBE_BED, "hip", "table")],
    });
    const raised = reachOf(onTable, HANDS, HEAD);
    expect(raised.status === "resolved" && raised.reach).toBe("within_reach_after_adjustment");
  });

  it("reaches an object only through the surface the body is anchored to", () => {
    const state = probeScene();
    const onFloor = sceneReach({
      state,
      source: bodySurface(PROBE_PLAYER, FEET),
      target: { kind: "object", entityId: PROBE_FLOOR, surfaceId: "top" },
    });
    expect(onFloor.status === "resolved" && onFloor.reach).toBe("in_contact");

    const acrossTheRoom = sceneReach({
      state: sceneStateOf({
        participants: [probeParticipant(PROBE_PLAYER)],
        supports: [probeSurface(), probeSurface(PROBE_BED, "knee", "bed")],
      }),
      source: bodySurface(PROBE_PLAYER, HANDS),
      target: { kind: "object", entityId: PROBE_BED, surfaceId: "top" },
    });
    expect(acrossTheRoom).toMatchObject({ status: "unresolved", reason: "object_surface_unanchored" });
  });
});

// ---------------------------------------------------------------------------
// Unknown is not a default
// ---------------------------------------------------------------------------

describe("absent facts", () => {
  it("never guesses a posture, a distance, an orientation, or a floor", () => {
    const noPosture = probeScene({ player: probeParticipant(PROBE_PLAYER, { posture: null }) });
    expect(reachOf(noPosture, HANDS, SHOULDERS)).toMatchObject({ reason: "posture_unknown" });

    const noProximity = probeScene({ proximity: null });
    expect(reachOf(noProximity, HANDS, SHOULDERS)).toMatchObject({ reason: "proximity_unknown" });

    const noFacing = probeScene({ facing: null });
    expect(reachOf(noFacing, HANDS, SHOULDERS)).toMatchObject({ reason: "facing_unknown" });

    const noSupport = probeScene({ player: probeParticipant(PROBE_PLAYER, { support: null }) });
    expect(reachOf(noSupport, HANDS, SHOULDERS)).toMatchObject({ reason: "elevation_unknown" });

    // A support set somebody CLEARED is a timestamped clearing, not a claim that
    // she is holding herself up by nothing: it reads exactly like silence.
    const clearedSupport = probeScene({ player: probeParticipant(PROBE_PLAYER, { support: [] }) });
    expect(reachOf(clearedSupport, HANDS, SHOULDERS)).toMatchObject({ reason: "elevation_unknown" });
  });

  it("refuses to choose between two things that bear the same body", () => {
    const state = probeScene({
      player: probeParticipant(PROBE_PLAYER, {
        support: [
          probeSupportRelation(),
          probeSupportRelation({ anchor: { kind: "surface", supportId: PROBE_BED } }),
        ],
      }),
      supports: [probeSurface(), probeSurface(PROBE_BED, "knee", "bed")],
    });
    expect(reachOf(state, HANDS, SHOULDERS)).toMatchObject({ reason: "elevation_ambiguous" });
  });

  it("has no answer about a body nobody placed, or a part the tree does not know", () => {
    expect(reachOf(emptySceneState(), HANDS, SHOULDERS)).toMatchObject({ reason: "participant_absent" });
    expect(reachOf(probeScene(), "tentacle", SHOULDERS)).toMatchObject({ reason: "zone_unknown" });
  });

  it("keeps the provenance of what it did consult when it gives up", () => {
    const answer = reachOf(probeScene({ facing: null }), HANDS, SHOULDERS);
    expect(answer.status).toBe("unresolved");
    // Proximity and both postures/elevations were read before facing was missed.
    expect(answer.provenance.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// Support
// ---------------------------------------------------------------------------

describe("support", () => {
  it("says which parts are holding the body up and which are free", () => {
    const state = probeScene();
    expect(sceneSupportOf(state, bodySurface(PROBE_PLAYER, FEET))).toMatchObject({
      status: "resolved",
      mobility: "fixed",
      supportRole: "weight_bearing",
    });
    expect(sceneSupportOf(state, bodySurface(PROBE_PLAYER, HANDS))).toMatchObject({
      status: "resolved",
      mobility: "free",
      supportRole: "free",
    });
  });

  it("calls a leaning hand partial rather than free", () => {
    const state = probeScene({
      player: probeParticipant(PROBE_PLAYER, { support: [probeSupportRelation(), probeLeaning()] }),
    });
    expect(sceneSupportOf(state, bodySurface(PROBE_PLAYER, HANDS))).toMatchObject({
      mobility: "limited",
      supportRole: "partial",
    });
  });

  it("answers unresolved — not free — when nobody said what holds the body up", () => {
    for (const support of [null, []] as const) {
      const state = probeScene({ player: probeParticipant(PROBE_PLAYER, { support }) });
      expect(sceneSupportOf(state, bodySurface(PROBE_PLAYER, HANDS))).toMatchObject({
        status: "unresolved",
        reason: "support_unknown",
      });
    }
  });
});

// ---------------------------------------------------------------------------
// Provenance
// ---------------------------------------------------------------------------

describe("provenance", () => {
  it("carries a source and a ref on every fact behind a resolved read", () => {
    const answer = reachOf(probeScene(), HANDS, SHOULDERS);
    expect(answer.status).toBe("resolved");
    if (answer.status !== "resolved") return;
    for (const entry of answer.provenance) {
      expect(sceneProvenanceSources).toContain(entry.source);
      expect(entry.ref.length).toBeGreaterThan(0);
      expect(Number.isInteger(entry.storyTime)).toBe(true);
    }
  });

  it("hands the trail on to the contact core's evidence", () => {
    const read = sceneGeometryRead({
      state: probeScene(),
      source: bodySurface(PROBE_PLAYER, HANDS),
      target: bodySurface(PROBE_NPC, SHOULDERS),
    });
    expect(isAdapterSupported(read)).toBe(true);
    if (!isAdapterSupported(read)) return;
    expect(read.value.evidence.length).toBeGreaterThan(0);
    expect(read.value.evidence.some((entry) => entry.ref === "scene_probe_event")).toBe(true);
  });

  it("reports an unanswerable read as unavailable, with the reason", () => {
    const sink = new DiagnosticCollector();
    const read = sceneGeometryRead({
      state: probeScene({ proximity: null }),
      source: bodySurface(PROBE_PLAYER, HANDS),
      target: bodySurface(PROBE_NPC, SHOULDERS),
      sink,
    });
    expect(read.status).toBe("unavailable");
    expect(codes(sink)).toEqual([SCENE_RELATION_UNAVAILABLE]);
    expect(sink.items[0]?.context).toMatchObject({ reason: "proximity_unknown" });

    const supportSink = new DiagnosticCollector();
    const supportRead = sceneSupportRead(
      probeScene({ player: probeParticipant(PROBE_PLAYER, { support: [] }) }),
      bodySurface(PROBE_PLAYER, HANDS),
      supportSink,
    );
    expect(supportRead.status).toBe("unavailable");
    expect(codes(supportSink)).toEqual([SCENE_RELATION_UNAVAILABLE]);
  });
});

// ---------------------------------------------------------------------------
// The actor-control law
// ---------------------------------------------------------------------------

describe("actor control", () => {
  it("refuses to let player input move an NPC's body", () => {
    const outcome = commitSceneIntent({
      state: probeScene(),
      intent: probeMovement({ subjectId: PROBE_NPC, origin: "player" }),
    });
    expect(outcome).toMatchObject({ status: "rejected", reason: "npc_movement_requires_npc_authority" });
    // The refusal states its own authority, and carries no state to pick up.
    expect(outcome.status === "rejected" && outcome.control.value).toBe("npc_controlled");
    expect("state" in outcome).toBe(false);
  });

  it("refuses to let the NPC side move the player's body", () => {
    for (const origin of ["npc", "simulation"] as const) {
      const outcome = commitSceneIntent({
        state: probeScene(),
        intent: probeMovement({ subjectId: PROBE_PLAYER, origin }),
      });
      expect(outcome).toMatchObject({ status: "rejected", reason: "player_movement_requires_player_authority" });
    }
  });

  it("commits a movement from the side that owns the body, stamped with its origin", () => {
    const player = commitSceneIntent({ state: probeScene(), intent: probeMovement() });
    expect(player.status).toBe("committed");
    if (player.status !== "committed") return;
    expect(player.commit.provenance.source).toBe("player_intent");
    expect(sceneParticipant(player.state, PROBE_PLAYER)?.posture?.value).toBe("kneeling");

    for (const origin of ["npc", "simulation"] as const) {
      const npc = commitSceneIntent({
        state: probeScene(),
        intent: probeMovement({ subjectId: PROBE_NPC, origin }),
      });
      expect(npc.status).toBe("committed");
      if (npc.status !== "committed") continue;
      expect(npc.commit.provenance.source).toBe(SCENE_ORIGIN_PROVENANCE[origin]);
    }
  });

  it("cannot commit a movement to a body whose controller nobody stated", () => {
    const sink = new DiagnosticCollector();
    const state = probeScene({ npc: probeParticipant(PROBE_NPC, { control: null }) });
    const outcome = commitSceneIntent({
      state,
      intent: probeMovement({ subjectId: PROBE_NPC, origin: "npc" }),
      sink,
    });
    expect(outcome).toMatchObject({ status: "unresolved", reason: "control_unresolved" });
    expect(codes(sink)).toEqual([SCENE_CONTROL_UNAVAILABLE]);
  });

  it("refuses an intent it cannot make sense of", () => {
    const state = probeScene();
    const cases = [
      probeMovement({ intentId: "  " }),
      probeMovement({ storyTime: -1 }),
      probeMovement({ change: { kind: "set_facing", towardId: PROBE_PLAYER, facing: "toward" } }),
      probeMovement({
        change: { kind: "set_proximity", otherId: affordanceSubjectId("nobody"), band: "close" },
      }),
      probeMovement({
        change: {
          kind: "set_support",
          support: [probeSupportRelation(), probeSupportRelation({ anchor: { kind: "surface", supportId: PROBE_BED } })],
        },
      }),
      probeMovement({
        change: { kind: "set_support", support: [probeSupportRelation({ loadZones: [] })] },
      }),
      probeMovement({
        change: {
          kind: "set_support",
          support: [probeSupportRelation({ anchor: { kind: "participant", subjectId: PROBE_PLAYER } })],
        },
      }),
    ];
    for (const intent of cases) {
      const sink = new DiagnosticCollector();
      expect(commitSceneIntent({ state, intent, sink })).toMatchObject({
        status: "unresolved",
        reason: "intent_invalid",
      });
      expect(sink.hasErrors).toBe(true);
    }
  });

  it("has nothing to move when the body is not in the scene", () => {
    const sink = new DiagnosticCollector();
    const outcome = commitSceneIntent({
      state: emptySceneState(),
      intent: probeMovement(),
      sink,
    });
    expect(outcome).toMatchObject({ status: "unresolved", reason: "participant_absent" });
    expect(codes(sink)).toEqual([SCENE_INTENT_INVALID]);
  });

  it("carries a refusal through a fold without dropping the movements around it", () => {
    const { state, outcomes } = applySceneIntents(probeScene(), [
      probeMovement({ intentId: "one", change: { kind: "set_posture", posture: "kneeling" } }),
      probeMovement({ intentId: "two", subjectId: PROBE_NPC, origin: "player" }),
      probeMovement({ intentId: "three", change: { kind: "set_proximity", otherId: PROBE_NPC, band: "touching" } }),
    ]);
    expect(outcomes.map((outcome) => outcome.status)).toEqual(["committed", "rejected", "committed"]);
    expect(sceneParticipant(state, PROBE_PLAYER)?.posture?.value).toBe("kneeling");
    expect(sceneParticipant(state, PROBE_NPC)?.posture?.value).toBe("standing");
    expect(reachOf(state, HANDS, SHOULDERS)).toMatchObject({ status: "resolved", reach: "in_contact" });
  });
});

// ---------------------------------------------------------------------------
// The ordering law
// ---------------------------------------------------------------------------

/**
 * One case per fact an intent can target. `fresh` changes it; `restatement`
 * asserts exactly what the fixture already says. Every fixture fact is stamped
 * story minute 100, so 99 is late, 100 is simultaneous, and 101 is new.
 */
const ORDERED_CHANGES: readonly {
  readonly slot: string;
  readonly fresh: SceneMovementChange;
  readonly restatement: SceneMovementChange;
}[] = [
  {
    slot: "posture",
    fresh: { kind: "set_posture", posture: "kneeling" },
    restatement: { kind: "set_posture", posture: "standing" },
  },
  {
    slot: "facing",
    fresh: { kind: "set_facing", towardId: PROBE_NPC, facing: "away" },
    restatement: { kind: "set_facing", towardId: PROBE_NPC, facing: "toward" },
  },
  {
    slot: "proximity",
    fresh: { kind: "set_proximity", otherId: PROBE_NPC, band: "touching" },
    restatement: { kind: "set_proximity", otherId: PROBE_NPC, band: "close" },
  },
  {
    slot: "support",
    fresh: { kind: "set_support", support: [probeLeaning()] },
    restatement: { kind: "set_support", support: [probeSupportRelation()] },
  },
];

describe("the ordering law", () => {
  it.each(ORDERED_CHANGES)("never lets a late intent overwrite a newer $slot", ({ fresh }) => {
    const sink = new DiagnosticCollector();
    const state = probeScene();
    const outcome = commitSceneIntent({ state, intent: probeMovement({ storyTime: 99, change: fresh }), sink });
    expect(outcome).toMatchObject({ status: "superseded", reason: "newer_fact_present" });
    // A refusal must not be mistakable for a commit: there is no scene on it.
    expect("state" in outcome).toBe(false);
    expect(outcome.status === "superseded" && outcome.standing.storyTime).toBe(100);
    expect(codes(sink)).toEqual([SCENE_INTENT_STALE]);
  });

  it.each(ORDERED_CHANGES)("writes nothing when an intent merely restates the $slot", ({ restatement }) => {
    const sink = new DiagnosticCollector();
    const state = probeScene();
    for (const storyTime of [99, 100, 101]) {
      const outcome = commitSceneIntent({ state, intent: probeMovement({ storyTime, change: restatement }), sink });
      expect(outcome).toMatchObject({ status: "superseded", reason: "already_asserted" });
    }
    // Agreement is not a fault, and re-stamping a fact that did not change is
    // how a scene where nothing happened produces a new snapshot every turn.
    expect(sink.items).toEqual([]);
  });

  it.each(ORDERED_CHANGES)("commits a different $slot stated in the same story minute", ({ fresh }) => {
    const outcome = commitSceneIntent({ state: probeScene(), intent: probeMovement({ storyTime: 100, change: fresh }) });
    expect(outcome.status).toBe("committed");
  });

  it("has nothing to be late against when the fact does not exist yet", () => {
    const state = probeScene({ player: probeParticipant(PROBE_PLAYER, { posture: null }) });
    const outcome = commitSceneIntent({ state, intent: probeMovement({ storyTime: 1 }) });
    expect(outcome.status).toBe("committed");
    if (outcome.status !== "committed") return;
    expect(sceneParticipant(outcome.state, PROBE_PLAYER)?.posture?.value).toBe("kneeling");
  });

  it("keeps the timestamp of a support set that was CLEARED", () => {
    const cleared = commitSceneIntent({
      state: probeScene(),
      intent: probeMovement({ storyTime: 110, change: { kind: "set_support", support: [] } }),
    });
    expect(cleared.status).toBe("committed");
    if (cleared.status !== "committed") return;
    const support = sceneParticipant(cleared.state, PROBE_PLAYER)?.support;
    expect(support?.value).toEqual([]);
    // The clearing is a fact about minute 110 — which is the whole reason the
    // SET carries the provenance instead of the relations inside it.
    expect(support?.provenance.storyTime).toBe(110);

    const sink = new DiagnosticCollector();
    const late = commitSceneIntent({
      state: cleared.state,
      intent: probeMovement({ storyTime: 105, change: { kind: "set_support", support: [probeSupportRelation()] } }),
      sink,
    });
    expect(late).toMatchObject({ status: "superseded", reason: "newer_fact_present" });
    expect(codes(sink)).toEqual([SCENE_INTENT_STALE]);

    const later = commitSceneIntent({
      state: cleared.state,
      intent: probeMovement({ storyTime: 111, change: { kind: "set_support", support: [probeSupportRelation()] } }),
    });
    expect(later.status).toBe("committed");
  });

  it("weighs each intent against its OWN slot, not against the scene's last movement", () => {
    // A posture written at minute 200 must not make a facing intent from minute
    // 150 look late: they are different facts about different things.
    const moved = commitSceneIntent({
      state: probeScene(),
      intent: probeMovement({ storyTime: 200, change: { kind: "set_posture", posture: "kneeling" } }),
    });
    expect(moved.status).toBe("committed");
    if (moved.status !== "committed") return;
    const turned = commitSceneIntent({
      state: moved.state,
      intent: probeMovement({ storyTime: 150, change: { kind: "set_facing", towardId: PROBE_NPC, facing: "away" } }),
    });
    expect(turned.status).toBe("committed");
  });

  it("folds the same intents twice into the identical scene", () => {
    const intents = [
      probeMovement({ intentId: "a", change: { kind: "set_posture", posture: "sitting" } }),
      probeMovement({ intentId: "b", change: { kind: "set_proximity", otherId: PROBE_NPC, band: "touching" } }),
      probeMovement({ intentId: "c", change: { kind: "set_support", support: [probeLeaning()] } }),
    ];
    const once = applySceneIntents(probeScene(), intents);
    const twice = applySceneIntents(once.state, intents);
    expect(once.outcomes.map((outcome) => outcome.status)).toEqual(["committed", "committed", "committed"]);
    expect(twice.outcomes.map((outcome) => outcome.status)).toEqual(["superseded", "superseded", "superseded"]);
    expect(JSON.stringify(twice.state)).toBe(JSON.stringify(once.state));
  });
});

// ---------------------------------------------------------------------------
// Snapshot and replay
// ---------------------------------------------------------------------------

describe("snapshot", () => {
  it("round-trips through JSON unchanged", () => {
    const state = probeScene();
    expect(parseSceneState(JSON.parse(JSON.stringify(state)))).toEqual(state);
  });

  it("replays the same intents from a restored snapshot into the identical scene", () => {
    const intents = [
      probeMovement({ intentId: "a", change: { kind: "set_posture", posture: "sitting" } }),
      probeMovement({ intentId: "b", subjectId: PROBE_NPC, origin: "npc", change: { kind: "set_facing", towardId: PROBE_PLAYER, facing: "away" } }),
      probeMovement({ intentId: "c", change: { kind: "set_proximity", otherId: PROBE_NPC, band: "near" } }),
    ];
    const live = applySceneIntents(probeScene(), intents).state;
    const restored = applySceneIntents(parseSceneState(JSON.parse(JSON.stringify(probeScene()))), intents).state;
    expect(restored).toEqual(live);
    expect(JSON.stringify(restored)).toBe(JSON.stringify(live));
  });

  it("degrades a blob that is not a scene to nobody placed", () => {
    expect(parseSceneState("not a scene")).toEqual(emptySceneState());
    expect(parseSceneState(null)).toEqual(emptySceneState());
    expect(parseSceneState(undefined)).toEqual(emptySceneState());
  });

  it.each([
    ["a future version", 99],
    ["a version that is not a number", "one"],
    ["a fractional version", 1.5],
    ["a null version", null],
    ["a version key holding nothing", undefined],
  ])("fails closed on %s rather than assuming the current one", (_label, version) => {
    // A `.catch(CURRENT)` here would read a blob nobody wrote for this build as
    // though somebody had, and then trust every placement inside it.
    const sink = new DiagnosticCollector();
    expect(parseSceneState({ ...storedScene(), version }, sink)).toEqual(emptySceneState());
    expect(codes(sink)).toContain(SCENE_STATE_INVALID);
  });

  it("fails closed on a blob with no version at all", () => {
    const sink = new DiagnosticCollector();
    const { participants, supports, proximity, facing, contacts } = storedScene();
    expect(parseSceneState({ participants, supports, proximity, facing, contacts }, sink)).toEqual(emptySceneState());
    expect(codes(sink)).toContain(SCENE_STATE_INVALID);
  });

  it("drops an unreadable participant and says so, rather than voiding the scene", () => {
    const sink = new DiagnosticCollector();
    const raw = JSON.parse(JSON.stringify(probeScene())) as { participants: unknown[] };
    raw.participants = [...raw.participants, { subjectId: "" }];
    const parsed = parseSceneState(raw, sink);
    expect(parsed.participants).toHaveLength(2);
    expect(codes(sink)).toEqual([SCENE_STATE_INVALID]);
    expect(sink.hasErrors).toBe(true);
  });

  it("never repairs a corrupt posture into a posture", () => {
    const sink = new DiagnosticCollector();
    const raw = JSON.parse(JSON.stringify(probeScene())) as {
      participants: { subjectId: string; posture?: { value: string } }[];
    };
    const first = raw.participants.find((entry) => entry.subjectId === PROBE_PLAYER);
    if (first?.posture === undefined) throw new Error("fixture has no posture");
    first.posture.value = "levitating";
    const parsed = parseSceneState(raw, sink);
    // The whole participant goes, and the scene answers unresolved rather than
    // standing them up at a plausible height.
    expect(sceneParticipant(parsed, PROBE_PLAYER)).toBeUndefined();
    expect(reachOf(parsed, HANDS, SHOULDERS)).toMatchObject({ reason: "participant_absent" });
  });

  it("drops relations and anchors that point at things no longer there", () => {
    const sink = new DiagnosticCollector();
    const raw = JSON.parse(JSON.stringify(probeScene())) as {
      participants: { subjectId: string }[];
      supports: unknown[];
    };
    raw.participants = raw.participants.filter((entry) => entry.subjectId !== PROBE_NPC);
    raw.supports = [];
    const parsed = parseSceneState(raw, sink);
    expect(parsed.proximity).toEqual([]);
    expect(parsed.facing).toEqual([]);
    // The SET survives its own emptying, and keeps the timestamp that says when
    // the scene last had anything to say about what holds this body up.
    expect(sceneParticipant(parsed, PROBE_PLAYER)?.support?.value).toEqual([]);
    expect(sceneParticipant(parsed, PROBE_PLAYER)?.support?.provenance.storyTime).toBe(100);
    expect(codes(sink)).toEqual([SCENE_STATE_INVALID]);
  });

  it("trims a scene past its bounds instead of carrying it", () => {
    const crowd = Array.from({ length: 12 }, (_, index) =>
      probeParticipant(affordanceSubjectId(`crowd_${index}`)),
    );
    const state = sceneStateOf({ participants: crowd, supports: [probeSurface()] });
    expect(state.participants.length).toBeLessThanOrEqual(8);
  });
});

// ---------------------------------------------------------------------------
// Contradictions in stored state
// ---------------------------------------------------------------------------

describe("stored contradictions", () => {
  it("drops both claimants of a duplicated participant id", () => {
    const sink = new DiagnosticCollector();
    const raw = storedScene();
    raw.participants = [...raw.participants, { subjectId: PROBE_PLAYER }];
    const parsed = parseSceneState(raw, sink);
    // Neither row is the survivor. Array position is not evidence of recency,
    // and an absent body is honest where a chosen one would be invented.
    expect(sceneParticipant(parsed, PROBE_PLAYER)).toBeUndefined();
    expect(sceneParticipant(parsed, PROBE_NPC)).toBeDefined();
    expect(codes(sink)).toContain(SCENE_STATE_CONTRADICTORY);
  });

  it("drops a pair's distance stated twice, whichever way round each was stored", () => {
    const sink = new DiagnosticCollector();
    const raw = storedScene();
    const stated = raw.proximity[0];
    if (stated === undefined) throw new Error("fixture has no proximity");
    raw.proximity = [
      stated,
      { subjectId: stated.otherId, otherId: stated.subjectId, band: { ...stated.band, value: "distant" } },
    ];
    const parsed = parseSceneState(raw, sink);
    expect(parsed.proximity).toEqual([]);
    expect(reachOf(parsed, HANDS, SHOULDERS)).toMatchObject({ reason: "proximity_unknown" });
    expect(codes(sink)).toContain(SCENE_STATE_CONTRADICTORY);
  });

  it("drops one direction of a facing pair stated twice and keeps the other", () => {
    const sink = new DiagnosticCollector();
    const raw = storedScene();
    const stated = raw.facing.find((entry) => entry.subjectId === PROBE_PLAYER);
    if (stated === undefined) throw new Error("fixture has no player facing");
    raw.facing = [...raw.facing, { ...stated, facing: { ...stated.facing, value: "away" } }];
    const parsed = parseSceneState(raw, sink);
    expect(parsed.facing).toHaveLength(1);
    expect(parsed.facing[0]?.subjectId).toBe(PROBE_NPC);
    expect(codes(sink)).toContain(SCENE_STATE_CONTRADICTORY);
  });

  it("drops both claimants of a duplicated support surface", () => {
    const sink = new DiagnosticCollector();
    const raw = storedScene();
    const floor = raw.supports[0];
    if (floor === undefined) throw new Error("fixture has no support surface");
    raw.supports = [floor, { ...floor, kind: "table", height: { ...floor.height, value: "hip" } }];
    const parsed = parseSceneState(raw, sink);
    expect(parsed.supports).toEqual([]);
    expect(reachOf(parsed, HANDS, SHOULDERS)).toMatchObject({ reason: "elevation_unknown" });
    expect(codes(sink)).toContain(SCENE_STATE_CONTRADICTORY);
  });

  it("drops support relations that claim one anchor twice", () => {
    const sink = new DiagnosticCollector();
    const raw = storedScene();
    const support = storedPlayerSupport(raw);
    const stated = support.value[0];
    if (stated === undefined) throw new Error("fixture has no support relation");
    support.value = [stated, { ...stated, role: "leaning_on", loadZones: ["arms"] }];
    const parsed = parseSceneState(raw, sink);
    expect(sceneParticipant(parsed, PROBE_PLAYER)?.support?.value).toEqual([]);
    expect(reachOf(parsed, HANDS, SHOULDERS)).toMatchObject({ reason: "elevation_unknown" });
    expect(codes(sink)).toContain(SCENE_STATE_CONTRADICTORY);
  });

  it("drops both things that claim to bear one body", () => {
    const sink = new DiagnosticCollector();
    const raw = storedScene();
    const floor = raw.supports[0];
    if (floor === undefined) throw new Error("fixture has no support surface");
    raw.supports = [floor, { supportId: PROBE_BED, kind: "bed", height: { ...floor.height, value: "knee" } }];
    const support = storedPlayerSupport(raw);
    const stated = support.value[0];
    if (stated === undefined) throw new Error("fixture has no support relation");
    support.value = [stated, { ...stated, anchor: { kind: "surface", supportId: PROBE_BED } }];
    const parsed = parseSceneState(raw, sink);
    // The read still refuses to choose between two bearers; the boundary refuses
    // to STORE the choice at all, so the elevation is honestly unknown instead.
    expect(sceneParticipant(parsed, PROBE_PLAYER)?.support?.value).toEqual([]);
    expect(reachOf(parsed, HANDS, SHOULDERS)).toMatchObject({ reason: "elevation_unknown" });
    expect(codes(sink)).toContain(SCENE_STATE_CONTRADICTORY);
  });

  it("refuses a stored body that is near or facing ITSELF", () => {
    const sink = new DiagnosticCollector();
    const raw = storedScene();
    const near = raw.proximity[0];
    const toward = raw.facing[0];
    if (near === undefined || toward === undefined) throw new Error("fixture has no relations");
    raw.proximity = [...raw.proximity, { subjectId: PROBE_PLAYER, otherId: PROBE_PLAYER, band: near.band }];
    raw.facing = [...raw.facing, { subjectId: PROBE_PLAYER, towardId: PROBE_PLAYER, facing: toward.facing }];
    const parsed = parseSceneState(raw, sink);
    expect(parsed.proximity).toHaveLength(1);
    expect(parsed.facing).toHaveLength(2);
    expect(parsed.facing.every((entry) => entry.subjectId !== entry.towardId)).toBe(true);
    expect(sink.hasErrors).toBe(true);
  });

  it("refuses a stored body that holds ITSELF up, and takes the record with it", () => {
    const sink = new DiagnosticCollector();
    const raw = storedScene();
    const support = storedPlayerSupport(raw);
    support.value = [{ role: "borne_by", anchor: { kind: "participant", subjectId: PROBE_PLAYER }, loadZones: ["legs"] }];
    const parsed = parseSceneState(raw, sink);
    expect(sceneParticipant(parsed, PROBE_PLAYER)).toBeUndefined();
    expect(sceneParticipant(parsed, PROBE_NPC)).toBeDefined();
    expect(sink.hasErrors).toBe(true);
  });

  it("cannot be built with a self-relation either, but keeps the body", () => {
    const state = sceneStateOf({
      participants: [
        probeParticipant(PROBE_PLAYER, {
          support: [probeSupportRelation({ anchor: { kind: "participant", subjectId: PROBE_PLAYER } })],
        }),
      ],
      supports: [probeSurface()],
      proximity: [{ subjectId: PROBE_PLAYER, otherId: PROBE_PLAYER, band: probeFact("close") }],
      facing: [{ subjectId: PROBE_PLAYER, towardId: PROBE_PLAYER, facing: probeFact("toward") }],
    });
    expect(state.proximity).toEqual([]);
    expect(state.facing).toEqual([]);
    // A programmatic caller loses the impossible relation, not the whole body:
    // the facts around it came from code, not from an untrusted blob.
    expect(sceneParticipant(state, PROBE_PLAYER)).toBeDefined();
    expect(sceneParticipant(state, PROBE_PLAYER)?.support?.value).toEqual([]);
  });

  it("still replaces last-write-wins when a caller writes, which the boundary never does", () => {
    const replaced = withSceneParticipant(probeScene(), probeParticipant(PROBE_PLAYER, { posture: "kneeling" }));
    expect(replaced.participants).toHaveLength(2);
    expect(sceneParticipant(replaced, PROBE_PLAYER)?.posture?.value).toBe("kneeling");
  });
});

// ---------------------------------------------------------------------------
// Housing the contact projection
// ---------------------------------------------------------------------------

describe("the housed contact projection", () => {
  it("carries the contact core's own state through a round trip", () => {
    const state = probeScene();
    expect(state.contacts.version).toBe(1);
    expect(parseSceneState(JSON.parse(JSON.stringify(state))).contacts).toEqual(state.contacts);
  });

  it("lets the contact core heal its own rows without taking the scene with them", () => {
    const sink = new DiagnosticCollector();
    const raw = JSON.parse(JSON.stringify(probeScene())) as { contacts: { contacts: unknown[] } };
    raw.contacts.contacts = [{ phase: "active", contactId: "" }];
    const parsed = parseSceneState(raw, sink);
    expect(parsed.contacts.contacts).toEqual([]);
    expect(parsed.participants).toHaveLength(2);
    expect(sink.hasErrors).toBe(true);
  });

  it("keeps the scene version and the contact version independent", () => {
    expect(SCENE_STATE_VERSION).toBe(1);
    const raw = { ...JSON.parse(JSON.stringify(probeScene())), contacts: { version: 99, contacts: [] } };
    const parsed = parseSceneState(raw);
    expect(parsed.participants).toHaveLength(2);
    expect(parsed.contacts.contacts).toEqual([]);
  });

  it("carries a real committed contact through a round trip", () => {
    const state = sceneHousingContact();
    expect(state.contacts.contacts).toHaveLength(1);
    expect(parseSceneState(JSON.parse(JSON.stringify(state))).contacts).toEqual(state.contacts);
  });

  it("drops a housed contact whose body did not survive restoration", () => {
    // The contact core heals its rows without knowing who is in this scene, so a
    // perfectly well-formed touch can come back naming a body that just went.
    const sink = new DiagnosticCollector();
    const raw = JSON.parse(JSON.stringify(sceneHousingContact())) as StoredScene;
    const npc = raw.participants.find((entry) => entry.subjectId === PROBE_NPC);
    if (npc?.posture === undefined) throw new Error("fixture has no npc posture");
    npc.posture.value = "levitating";
    const parsed = parseSceneState(raw, sink);
    expect(sceneParticipant(parsed, PROBE_NPC)).toBeUndefined();
    expect(parsed.contacts.contacts).toEqual([]);
    expect(sink.items.find((item) => item.code === SCENE_STATE_INVALID)?.context).toMatchObject({
      orphanedContacts: 1,
    });
  });

  it("keeps a contact on an object when the body that made it is still placed", () => {
    const state = sceneHousingContact({ kind: "object", entityId: PROBE_FLOOR, surfaceId: "top" });
    expect(state.contacts.contacts).toHaveLength(1);
    const raw = JSON.parse(JSON.stringify(state)) as StoredScene;
    raw.participants = raw.participants.filter((entry) => entry.subjectId !== PROBE_NPC);
    // A hand on the floor names one body, so only that body has to be here.
    expect(parseSceneState(raw).contacts.contacts).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Enough for a contact proof
// ---------------------------------------------------------------------------

function contactAttempt(
  state: SceneState,
  target: ContactSurfaceRef = bodySurface(PROBE_NPC, SHOULDERS),
): { intent: ContactActionIntent; context: ContactActionContext } {
  const source = bodySurface(PROBE_PLAYER, HANDS);
  const intent: ContactActionIntent = {
    actionId: "scene_probe_contact",
    actorId: PROBE_PLAYER,
    source,
    target,
    actionKind: "affectionate",
    access: "any_material",
    storyTime: 120,
  };
  const context: ContactActionContext = {
    actorControl: { status: "allowed", actorId: PROBE_PLAYER, evidence: [] },
    // Nothing but the actor moves, so no target's own authority is engaged.
    targetAgencies: [],
    participantEligibility: { status: "not_required", participantIds: [], evidence: [] },
    policy: { status: "not_required", scopes: [], evidence: [] },
    geometry: sceneGeometryRead({ state, source, target }),
    sourceSupport: sceneSupportRead(state, source),
    // An object has no support answer of its own; the scene owns bodies.
    targetSupport: target.kind === "body" ? sceneSupportRead(state, target) : adapterUnavailable,
    material: adapterSupported({ layers: [], evidence: [] }),
    adjustments: [],
  };
  return { intent, context };
}

/**
 * The default scene with one REAL contact housed in it.
 *
 * Committed through the contact core's own resolver and commit path rather than
 * hand-built, so the fixture carries whatever a valid stored contact carries and
 * cannot drift from the core's own schema.
 */
function sceneHousingContact(target: ContactSurfaceRef = bodySurface(PROBE_NPC, SHOULDERS)): SceneState {
  const state = probeScene();
  const resolution = resolveContactAttempt(contactAttempt(state, target));
  if (resolution.status !== "committable") throw new Error(`fixture contact resolved ${resolution.status}`);
  const outcome = commitContactResolution({
    state: emptyContactLifecycleState(),
    resolution,
    eventRef: contactEventRef("scene_probe_contact_event"),
  });
  return withSceneContacts(state, outcome.state);
}

describe("as a contact resolver input", () => {
  it("lets an affectionate hand-to-shoulder contact commit", () => {
    const resolution = resolveContactAttempt(contactAttempt(probeScene()));
    expect(resolution.status).toBe("committable");
  });

  it("turns a scene nobody described into narrator silence rather than a guess", () => {
    const resolution = resolveContactAttempt(
      contactAttempt(probeScene({ player: probeParticipant(PROBE_PLAYER, { posture: null }) })),
    );
    expect(resolution).toMatchObject({ status: "unresolved", reason: "geometry_unavailable" });
  });

  it("rejects a contact the scene puts out of reach", () => {
    const resolution = resolveContactAttempt(contactAttempt(probeScene({ proximity: "distant" })));
    expect(resolution).toMatchObject({ status: "rejected", reason: "out_of_reach" });
  });

  it("sends a weight-bearing limb through a visible transition", () => {
    // The player is on all fours: the acting hand is holding the body up, so the
    // contact core demands the support change be played out rather than folded in.
    const state = probeScene({
      player: probeParticipant(PROBE_PLAYER, {
        posture: "crouching",
        support: [probeSupportRelation({ loadZones: ["legs", "arms"] })],
      }),
    });
    const resolution = resolveContactAttempt(contactAttempt(state));
    expect(resolution.status).toBe("explicit_transition_required");
  });
});

// ---------------------------------------------------------------------------
// Purity
// ---------------------------------------------------------------------------

describe("purity", () => {
  it("never mutates the state handed to it", () => {
    const state = probeScene();
    const before = JSON.stringify(state);
    commitSceneIntent({ state, intent: probeMovement() });
    reachOf(state, HANDS, SHOULDERS);
    sceneSupportOf(state, bodySurface(PROBE_PLAYER, HANDS));
    expect(JSON.stringify(state)).toBe(before);
  });

  it("freezes what it hands back", () => {
    const state = withSceneProximity(
      withSceneParticipant(emptySceneState(), probeParticipant(PROBE_PLAYER)),
      probeProximity(),
    );
    expect(Object.isFrozen(state)).toBe(true);
    expect(Object.isFrozen(state.participants)).toBe(true);
  });

  it("orders a scene canonically however it was built", () => {
    const forwards = sceneStateOf({
      participants: [probeParticipant(PROBE_PLAYER), probeParticipant(PROBE_NPC)],
      proximity: [probeProximity()],
    });
    const backwards = sceneStateOf({
      participants: [probeParticipant(PROBE_NPC), probeParticipant(PROBE_PLAYER)],
      proximity: [{ subjectId: PROBE_NPC, otherId: PROBE_PLAYER, band: probeFact("close") }],
    });
    expect(JSON.stringify(forwards)).toBe(JSON.stringify(backwards));
  });
});
