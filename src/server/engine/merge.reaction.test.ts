import { describe, expect, it } from "vitest";
import { DiagnosticCollector } from "@/contracts/diagnostics";
import type { Preference } from "@/contracts/personality/preference";
import { stageForValue } from "@/contracts/relationships/stages";
import { emptyParticipantState } from "@/contracts/state/participant-state";
import { emptyCharacterProfile } from "@/contracts/world/profile";
import type { BundleRelationship } from "./bundle";
import type { WorkingParticipant } from "./merge";
import { combineAffinityUpdates, planReactionAffinity } from "./merge/phases/reactions";
import type { AffinityUpdate, ReactionAffinityResult } from "./merge/types";

function player(id: string, displayName: string): WorkingParticipant {
  return { id, displayName, isUser: true, role: "player", characterId: null, snapshot: emptyCharacterProfile(), locationId: "loc-1", state: emptyParticipantState() };
}
function npc(id: string, displayName: string, preferences: Preference[] = [], tags: string[] = []): WorkingParticipant {
  return {
    id,
    displayName,
    isUser: false,
    role: "npc",
    characterId: null,
    snapshot: { ...emptyCharacterProfile(), preferences, tags },
    locationId: "loc-1",
    state: emptyParticipantState(),
  };
}

const brian = player("p-brian", "Brian");

function feeling(value: number): BundleRelationship {
  return { fromParticipantId: "p-sabrina", toParticipantId: "p-brian", kind: "feeling", value, stage: stageForValue(value).id };
}

describe("planReactionAffinity", () => {
  const sabrina = npc("p-sabrina", "Sabrina", [{ target: "compliment", valence: "dislike", intensity: 7, hint: "finds flattery cloying" }]);
  const parts = [brian, sabrina];

  it("no social acts ⇒ empty, nothing owned", () => {
    const r = planReactionAffinity([], parts, []);
    expect(r.updates).toEqual([]);
    expect(r.ownedEdgeKeys.size).toBe(0);
  });

  it("a disliked act writes a negative feeling delta and owns the edge", () => {
    const r = planReactionAffinity([{ concept: "compliment", target: "Sabrina" }], parts, [feeling(0)]);
    expect(r.updates).toEqual([
      { fromParticipantId: "p-sabrina", toParticipantId: "p-brian", kind: "feeling", delta: -5, reason: "reaction:compliment" },
    ]); // intensity 7 → magnitude 7 → clamped to ±5
    expect(r.ownedEdgeKeys.has("p-sabrina::p-brian::feeling")).toBe(true);
  });

  it("goodwill deadband: a minor slight against a beloved nets 0 but still owns the edge", () => {
    const mild = npc("p-sabrina", "Sabrina", [{ target: "compliment", valence: "dislike", intensity: 4 }]);
    const r = planReactionAffinity([{ concept: "compliment", target: "Sabrina" }], [brian, mild], [feeling(100)]);
    expect(r.updates).toEqual([]); // tolerance 0.04*100 = 4 ⇒ raw 0
    expect(r.ownedEdgeKeys.has("p-sabrina::p-brian::feeling")).toBe(true);
  });

  it("a liked act writes a positive delta (capped)", () => {
    const likes = npc("p-sabrina", "Sabrina", [{ target: "compliment", valence: "like", intensity: 6 }]);
    const r = planReactionAffinity([{ concept: "compliment", target: "Sabrina" }], [brian, likes], [feeling(0)]);
    expect(r.updates[0]?.delta).toBe(4); // like cap
  });

  it("an unmatched concept ⇒ empty, edge not owned (simulant handles it)", () => {
    const r = planReactionAffinity([{ concept: "insult", target: "Sabrina" }], parts, [feeling(0)]);
    expect(r.updates).toEqual([]);
    expect(r.ownedEdgeKeys.size).toBe(0);
  });

  it("an unresolved target ⇒ empty + diagnostic", () => {
    const sink = new DiagnosticCollector();
    const r = planReactionAffinity([{ concept: "compliment", target: "Nobody" }], parts, [], sink);
    expect(r.updates).toEqual([]);
    expect(sink.items.some((d) => d.code === "merge.reaction.unresolved_target")).toBe(true);
  });

  it("a resolved reaction nudges the target's mood (a dislike lowers it)", () => {
    const r = planReactionAffinity([{ concept: "compliment", target: "Sabrina" }], parts, [feeling(0)]);
    expect(r.moodAdjustment?.participantId).toBe("p-sabrina");
    expect(r.moodAdjustment!.delta).toBeLessThan(0);
  });

  it("turn-start mood sharpens a dislike — a bad mood lands a bigger sting than a neutral one", () => {
    const mild = npc("p-sabrina", "Sabrina", [{ target: "compliment", valence: "dislike", intensity: 3 }]);
    const act = [{ concept: "compliment", target: "Sabrina" }];
    const neutral = planReactionAffinity(act, [brian, mild], [feeling(0)], undefined, new Map([["p-sabrina", 0.5]]));
    const badMood = planReactionAffinity(act, [brian, mild], [feeling(0)], undefined, new Map([["p-sabrina", 0]]));
    expect(Math.abs(badMood.updates[0]!.delta)).toBeGreaterThan(Math.abs(neutral.updates[0]!.delta));
  });
});

describe("planReactionAffinity — welcome/unwelcome touch (mood.spec §5)", () => {
  const touch = [{ concept: "physical_affection", target: "Sabrina" }];

  it("a no-preference touch at a warm stage ⇒ welcome: mood up, stress eased, no affinity write", () => {
    const sabrina = npc("p-sabrina", "Sabrina");
    const r = planReactionAffinity(touch, [brian, sabrina], [feeling(55)]); // warm
    expect(r.updates).toEqual([]);
    expect(r.ownedEdgeKeys.size).toBe(0);
    expect(r.moodAdjustment?.delta).toBeGreaterThan(0);
    expect(r.stressAdjustment!.delta).toBeLessThan(0);
  });

  it("the same touch at a cool stage ⇒ unwelcome: mood drops, stress spikes", () => {
    const sabrina = npc("p-sabrina", "Sabrina");
    const r = planReactionAffinity(touch, [brian, sabrina], [feeling(-25)]); // cool
    expect(r.moodAdjustment!.delta).toBeLessThan(0);
    expect(r.stressAdjustment!.delta).toBeGreaterThan(0);
  });

  it("a stranger-stage touch is ambiguous ⇒ faint mood, no stress", () => {
    const sabrina = npc("p-sabrina", "Sabrina");
    const r = planReactionAffinity(touch, [brian, sabrina], [feeling(0)]);
    expect(r.moodAdjustment?.delta).toBeGreaterThan(0);
    expect(r.stressAdjustment).toBeUndefined(); // |stress| < 0.005 ⇒ omitted
  });

  it("a preference on the touch concept overrides the gate (reaction curve owns it)", () => {
    const likesTouch = npc("p-sabrina", "Sabrina", [{ target: "physical_affection", valence: "like", intensity: 6 }]);
    const r = planReactionAffinity(touch, [brian, likesTouch], [feeling(-25)]); // cool, but she likes it
    expect(r.ownedEdgeKeys.has("p-sabrina::p-brian::feeling")).toBe(true); // routed through the reaction path
    expect(r.moodAdjustment!.delta).toBeGreaterThan(0); // liked ⇒ mood up despite the cool stage
  });
});

describe("combineAffinityUpdates", () => {
  it("the reaction wins its edge; the simulant's update on that edge is dropped, others kept", () => {
    const reaction: ReactionAffinityResult = {
      updates: [{ fromParticipantId: "p-sabrina", toParticipantId: "p-brian", kind: "feeling", delta: -5 }],
      ownedEdgeKeys: new Set(["p-sabrina::p-brian::feeling"]),
    };
    const simulant: AffinityUpdate[] = [
      { fromParticipantId: "p-sabrina", toParticipantId: "p-brian", kind: "feeling", delta: 2 }, // dropped (owned)
      { fromParticipantId: "p-sabrina", toParticipantId: "p-brian", kind: "perceived", delta: 1 }, // kept (other edge)
      { fromParticipantId: "p-tom", toParticipantId: "p-brian", kind: "feeling", delta: 3 }, // kept (other NPC)
    ];
    const combined = combineAffinityUpdates(reaction, simulant);
    expect(combined).toHaveLength(3);
    expect(combined.filter((u) => u.fromParticipantId === "p-sabrina" && u.kind === "feeling")).toEqual([
      { fromParticipantId: "p-sabrina", toParticipantId: "p-brian", kind: "feeling", delta: -5 },
    ]);
  });

  it("a deadband (zero-delta) reaction still suppresses the simulant on the owned edge", () => {
    const reaction: ReactionAffinityResult = { updates: [], ownedEdgeKeys: new Set(["p-sabrina::p-brian::feeling"]) };
    const simulant: AffinityUpdate[] = [{ fromParticipantId: "p-sabrina", toParticipantId: "p-brian", kind: "feeling", delta: 2 }];
    expect(combineAffinityUpdates(reaction, simulant)).toEqual([]);
  });
});
