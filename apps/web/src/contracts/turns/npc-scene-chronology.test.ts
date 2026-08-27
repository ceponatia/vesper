import { describe, expect, it } from "vitest";
import { planNpcSceneChronology, type NpcSceneFloorEntry, type NpcSceneTier2Entry } from "./npc-scene-chronology";
import { contactRefAt, npcRefAt, NPC_SCENE_PLAYER_REF } from "./npc-scene-decision";
import type { NpcSceneReplySpan } from "./npc-scene-evidence";

/**
 * The chronological planner: reply order — absolute action offsets — replaces the old fixed
 * floor→movement→contact order; unorderable tier-2 actions drop; the floor
 * always survives; a floor ending and a depart over the same span group into
 * one composite-departure entry (data only — band math is increment-1 work).
 */

function span(start: number, end: number): NpcSceneReplySpan {
  return { start, end };
}

function updateEntry(at: NpcSceneReplySpan): NpcSceneTier2Entry {
  return {
    candidate: {
      kind: "update",
      actorRef: npcRefAt(0),
      contactRef: contactRefAt(0),
      gesture: "squeeze",
      evidence: "She squeezes your hand",
    },
    span: at,
  };
}

function approachEntry(at: NpcSceneReplySpan): NpcSceneTier2Entry {
  return {
    candidate: {
      kind: "approach",
      actorRef: npcRefAt(0),
      counterpartRef: NPC_SCENE_PLAYER_REF,
      band: "close",
      facing: null,
      evidence: "She steps closer",
    },
    span: at,
  };
}

function startEntry(at: NpcSceneReplySpan): NpcSceneTier2Entry {
  return {
    candidate: {
      kind: "start",
      actorRef: npcRefAt(0),
      targetRef: NPC_SCENE_PLAYER_REF,
      gesture: "rest",
      targetLocationId: "hands",
      evidence: "takes your hand",
    },
    span: at,
  };
}

function departEntry(at: NpcSceneReplySpan, actor = npcRefAt(0)): NpcSceneTier2Entry {
  return {
    candidate: {
      kind: "depart",
      actorRef: actor,
      counterpartRef: NPC_SCENE_PLAYER_REF,
      band: "near",
      evidence: "steps away",
    },
    span: at,
  };
}

function floorEntry(at: NpcSceneReplySpan, subjectRef = npcRefAt(0)): NpcSceneFloorEntry {
  return { reason: "separated", subjectRef, span: at };
}

describe("reply order replaces slot order", () => {
  it("orders 'squeezes your hand, then steps away' as update before depart", () => {
    const plan = planNpcSceneChronology({
      floor: null,
      tier2: [departEntry(span(30, 40)), updateEntry(span(0, 22))],
    });
    expect(plan.dropped).toHaveLength(0);
    expect(
      plan.actions.map((action) => (action.source === "tier2" ? action.entry.candidate.kind : action.source)),
    ).toEqual(["update", "depart"]);
  });

  it("orders 'steps closer, then takes your hand' as approach before start", () => {
    const plan = planNpcSceneChronology({
      floor: null,
      tier2: [startEntry(span(24, 44)), approachEntry(span(0, 16))],
    });
    expect(
      plan.actions.map((action) => (action.source === "tier2" ? action.entry.candidate.kind : action.source)),
    ).toEqual(["approach", "start"]);
  });
});

describe("composite departure", () => {
  it("groups a floor ending and a depart over the SAME span into one composite entry", () => {
    const floor = floorEntry(span(30, 45));
    const departing = departEntry(span(30, 45));
    const plan = planNpcSceneChronology({ floor, tier2: [updateEntry(span(0, 22)), departing] });
    expect(plan.dropped).toHaveLength(0);
    expect(plan.actions.map((action) => action.source)).toEqual(["tier2", "composite_departure"]);
    const composite = plan.actions[1];
    if (composite?.source !== "composite_departure") throw new Error("expected composite");
    expect(composite.floor).toBe(floor);
    expect(composite.depart).toBe(departing);
  });

  it("composites OVERLAPPING phrases — the production span shapes", () => {
    // The floor's phrase includes its subject token ("Wren steps away" ⇒
    // [30, 45)) while the verifier's phrase anchors its own lexicon ("steps
    // away" ⇒ [34, 44)). The same written action at two boundaries must
    // composite, not drop — equality would leave every real floor+depart pair
    // uncomposited and the distance would never widen when the floor fires.
    const floor = floorEntry(span(30, 45));
    const departing = departEntry(span(34, 44));
    const plan = planNpcSceneChronology({ floor, tier2: [departing] });
    expect(plan.dropped).toHaveLength(0);
    expect(plan.actions.map((action) => action.source)).toEqual(["composite_departure"]);
    const composite = plan.actions[0];
    if (composite?.source !== "composite_departure") throw new Error("expected composite");
    expect(composite.depart).toBe(departing);
  });

  it("orders 'steps back, then rests her hand on your shoulder' as ending before start", () => {
    // Phrase-grain floor spans are what keep a one-sentence "ending, then
    // action" reply alive: the ending's phrase [0, 15) and the start's phrase
    // [21, 52) are disjoint, so both survive and order by offset. A
    // sentence-grain floor span would have swallowed the start as ambiguous.
    const floor = floorEntry(span(0, 15));
    const plan = planNpcSceneChronology({ floor, tier2: [startEntry(span(21, 52))] });
    expect(plan.dropped).toHaveLength(0);
    expect(plan.actions.map((action) => action.source)).toEqual(["floor", "tier2"]);
  });

  it("composites when the floor's subject could not be mapped to a ref", () => {
    const floor: NpcSceneFloorEntry = { reason: "separated", subjectRef: null, span: span(10, 25) };
    const plan = planNpcSceneChronology({ floor, tier2: [departEntry(span(10, 25))] });
    expect(plan.actions.map((action) => action.source)).toEqual(["composite_departure"]);
  });

  it("refuses to composite across different bodies — the depart drops, the floor stands", () => {
    const floor = floorEntry(span(30, 45), npcRefAt(1));
    const plan = planNpcSceneChronology({ floor, tier2: [departEntry(span(30, 45), npcRefAt(0))] });
    expect(plan.actions.map((action) => action.source)).toEqual(["floor"]);
    expect(plan.dropped).toHaveLength(1);
    expect(plan.dropped[0]?.reason).toBe("chronology_ambiguous");
  });
});

describe("unorderable actions", () => {
  it("drops a tier-2 candidate overlapping the floor; the independently valid floor survives", () => {
    const floor = floorEntry(span(10, 30));
    const plan = planNpcSceneChronology({ floor, tier2: [startEntry(span(15, 25))] });
    expect(plan.actions.map((action) => action.source)).toEqual(["floor"]);
    expect(plan.dropped.map((drop) => drop.reason)).toEqual(["chronology_ambiguous"]);
  });

  it("drops EVERY tier-2 party to a tier-2/tier-2 overlap", () => {
    const plan = planNpcSceneChronology({
      floor: null,
      tier2: [approachEntry(span(0, 20)), startEntry(span(10, 30))],
    });
    expect(plan.actions).toHaveLength(0);
    expect(plan.dropped.map((drop) => drop.reason)).toEqual(["chronology_ambiguous", "chronology_ambiguous"]);
  });

  it("keeps non-overlapping entries and never drops the floor", () => {
    const floor = floorEntry(span(50, 70));
    const plan = planNpcSceneChronology({
      floor,
      tier2: [approachEntry(span(0, 16)), startEntry(span(20, 40))],
    });
    expect(plan.dropped).toHaveLength(0);
    expect(
      plan.actions.map((action) => (action.source === "tier2" ? action.entry.candidate.kind : action.source)),
    ).toEqual(["approach", "start", "floor"]);
  });
});
