import { describe, expect, it } from "vitest";
import type { RelationshipEdge } from "@/lib/client/api";
import { relationshipToPlayer } from "./cast-relationship";

function edge(over: Partial<RelationshipEdge> & { id: string }): RelationshipEdge {
  return {
    fromParticipantId: "npc",
    toParticipantId: "player",
    kind: "feeling",
    stage: "stranger",
    ...over,
  };
}

describe("relationshipToPlayer", () => {
  // The perceived-line ruling (followups.phase2.md #3): hidden only while the
  // pair is mutually stranger; shown (defaulting to "stranger") otherwise.

  it("no edges at all: stranger feeling, perceived line suppressed", () => {
    expect(relationshipToPlayer([], "npc", "player")).toEqual({
      stage: "stranger",
      perceivedStage: null,
    });
  });

  it("explicit stranger feeling + stranger perceived row: still mutually stranger, line suppressed", () => {
    const edges = [
      edge({ id: "e1", kind: "feeling", stage: "stranger" }),
      edge({ id: "e2", kind: "perceived", stage: "stranger" }),
    ];
    expect(relationshipToPlayer(edges, "npc", "player").perceivedStage).toBeNull();
  });

  it("non-stranger feeling with no perceived row: line shown, displayed as stranger", () => {
    const edges = [edge({ id: "e1", kind: "feeling", stage: "friendly" })];
    expect(relationshipToPlayer(edges, "npc", "player")).toEqual({
      stage: "friendly",
      perceivedStage: "stranger",
    });
  });

  it("stranger feeling but a non-stranger perceived row: the perception carries information, both lines render", () => {
    const edges = [edge({ id: "e1", kind: "perceived", stage: "friendly" })];
    expect(relationshipToPlayer(edges, "npc", "player")).toEqual({
      stage: "stranger",
      perceivedStage: "friendly",
    });
  });

  it("both edges non-stranger: both stages pass through", () => {
    const edges = [
      edge({ id: "e1", kind: "feeling", stage: "acquaintance" }),
      edge({ id: "e2", kind: "perceived", stage: "acquaintance" }),
    ];
    expect(relationshipToPlayer(edges, "npc", "player")).toEqual({
      stage: "acquaintance",
      perceivedStage: "acquaintance",
    });
  });

  it("ignores edges in the other direction and edges between other participants", () => {
    const edges = [
      edge({ id: "e1", fromParticipantId: "player", toParticipantId: "npc", kind: "feeling", stage: "friendly" }),
      edge({ id: "e2", fromParticipantId: "npc", toParticipantId: "other", kind: "feeling", stage: "friendly" }),
    ];
    expect(relationshipToPlayer(edges, "npc", "player")).toEqual({
      stage: "stranger",
      perceivedStage: null,
    });
  });
});
