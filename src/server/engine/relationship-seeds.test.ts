import { describe, expect, it } from "vitest";
import { DiagnosticCollector } from "@/contracts/diagnostics";
import { stageMidpoint, type AuthoredRelationship } from "@/contracts";
import { seedRelationshipRows, type RelationshipSeedMember } from "./relationship-seeds";

const member = (
  participantId: string,
  displayName: string,
  relationships: AuthoredRelationship[] = [],
  bondText = "",
): RelationshipSeedMember => ({ participantId, displayName, relationships, bondText });

describe("seedRelationshipRows", () => {
  it("seeds an authored edge at the stage midpoint with the denormalized stage", () => {
    const rows = seedRelationshipRows(
      [member("a", "Rook", [{ toward: "Sable", stage: "friendly" }]), member("b", "Sable")],
      null,
    );
    const forward = rows.find((r) => r.fromParticipantId === "a");
    expect(forward).toEqual({ fromParticipantId: "a", toParticipantId: "b", kind: "feeling", value: 41, stage: "friendly" });
  });

  it("seeds each stage at its registry midpoint", () => {
    for (const stage of ["hostile", "wary", "acquaintance", "friendly", "close", "devoted"]) {
      const rows = seedRelationshipRows(
        [member("a", "Rook", [{ toward: "Sable", stage }]), member("b", "Sable")],
        null,
      );
      expect(rows.find((r) => r.fromParticipantId === "a")?.value).toBe(stageMidpoint(stage));
      expect(rows.find((r) => r.fromParticipantId === "a")?.stage).toBe(stage);
    }
  });

  it("implies the reverse NPC edge at the same midpoint", () => {
    const rows = seedRelationshipRows(
      [member("a", "Rook", [{ toward: "Sable", stage: "close" }]), member("b", "Sable")],
      null,
    );
    expect(rows).toHaveLength(2);
    expect(rows).toContainEqual({ fromParticipantId: "b", toParticipantId: "a", kind: "feeling", value: 72, stage: "close" });
    expect(rows.every((r) => r.kind === "feeling")).toBe(true); // perceived is player-only
  });

  it("explicit wins: an authored reverse direction is never overwritten by the implication", () => {
    const rows = seedRelationshipRows(
      [
        member("a", "Rook", [{ toward: "Sable", stage: "close" }]),
        member("b", "Sable", [{ toward: "Rook", stage: "wary" }]),
      ],
      null,
    );
    expect(rows).toHaveLength(2);
    expect(rows).toContainEqual({ fromParticipantId: "a", toParticipantId: "b", kind: "feeling", value: 72, stage: "close" });
    expect(rows).toContainEqual({ fromParticipantId: "b", toParticipantId: "a", kind: "feeling", value: -48, stage: "wary" });
  });

  it("sparse = stranger: an authored stranger stage writes no row", () => {
    const rows = seedRelationshipRows(
      [member("a", "Rook", [{ toward: "Sable", stage: "stranger" }]), member("b", "Sable")],
      null,
    );
    expect(rows).toEqual([]);
  });

  it("an authored stranger still suppresses the implied reverse edge", () => {
    const rows = seedRelationshipRows(
      [
        member("a", "Rook", [{ toward: "Sable", stage: "friendly" }]),
        member("b", "Sable", [{ toward: "Rook", stage: "stranger" }]),
      ],
      null,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ fromParticipantId: "a", toParticipantId: "b", kind: "feeling", value: 41 });
  });

  describe("player edges (decision 41 — the player owns no edges)", () => {
    it("mutual-knowledge bond text mirrors the midpoint into the perceived row", () => {
      const rows = seedRelationshipRows(
        [member("a", "Rook", [{ toward: "player", stage: "friendly" }], "an old friend of the player")],
        "p",
      );
      expect(rows).toHaveLength(2);
      expect(rows).toContainEqual({ fromParticipantId: "a", toParticipantId: "p", kind: "feeling", value: 41, stage: "friendly" });
      expect(rows).toContainEqual({ fromParticipantId: "a", toParticipantId: "p", kind: "perceived", value: 41, stage: "friendly" });
    });

    it("first-meeting phrasing seeds the feeling row only", () => {
      const rows = seedRelationshipRows(
        [member("a", "Rook", [{ toward: "Player", stage: "friendly" }], "watches the player but they have never met")],
        "p",
      );
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ kind: "feeling", value: 41 });
    });

    it("indeterminate text mirrors the midpoint (safe default)", () => {
      const rows = seedRelationshipRows(
        [member("a", "Rook", [{ toward: "player", stage: "wary" }], "keeps the lighthouse")],
        "p",
      );
      expect(rows).toHaveLength(2);
      expect(rows).toContainEqual({ fromParticipantId: "a", toParticipantId: "p", kind: "perceived", value: -48, stage: "wary" });
    });

    it("skips player edges with a diagnostic when there is no player participant", () => {
      const sink = new DiagnosticCollector();
      const rows = seedRelationshipRows(
        [member("a", "Rook", [{ toward: "player", stage: "friendly" }], "an old friend")],
        null,
        sink,
      );
      expect(rows).toEqual([]);
      expect(sink.items.some((d) => d.code === "spawn.relationship.unresolved_toward")).toBe(true);
    });
  });

  describe("played cast member (the player character sits in the cast)", () => {
    it("edges toward the played member's display name count as toward-player: perceived row, no implied reverse", () => {
      const rows = seedRelationshipRows(
        [
          member("a", "Rook", [{ toward: "Brian", stage: "friendly" }], "keeps the lighthouse"),
          member("p", "Brian"),
        ],
        "p",
      );
      expect(rows).toHaveLength(2);
      expect(rows).toContainEqual({ fromParticipantId: "a", toParticipantId: "p", kind: "feeling", value: 41, stage: "friendly" });
      expect(rows).toContainEqual({ fromParticipantId: "a", toParticipantId: "p", kind: "perceived", value: 41, stage: "friendly" });
      expect(rows.some((r) => r.fromParticipantId === "p")).toBe(false); // players own no edges
    });

    it("the played member's authored edge seeds the NPC side instead of player-owned rows", () => {
      const rows = seedRelationshipRows(
        [
          member("p", "Brian", [{ toward: "Sable", stage: "friendly" }]),
          member("b", "Sable", [], "keeps the lighthouse"),
        ],
        "p",
      );
      expect(rows).toHaveLength(2);
      expect(rows).toContainEqual({ fromParticipantId: "b", toParticipantId: "p", kind: "feeling", value: 41, stage: "friendly" });
      expect(rows).toContainEqual({ fromParticipantId: "b", toParticipantId: "p", kind: "perceived", value: 41, stage: "friendly" });
    });

    it("first-meeting phrasing on the NPC seeds its feeling row only", () => {
      const rows = seedRelationshipRows(
        [
          member("p", "Brian", [{ toward: "Sable", stage: "close" }]),
          member("b", "Sable", [], "watches the player but they have never met"),
        ],
        "p",
      );
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ fromParticipantId: "b", toParticipantId: "p", kind: "feeling", value: 72 });
    });

    it("explicit wins: the NPC's own authored edge toward the player beats the played member's implication", () => {
      const rows = seedRelationshipRows(
        [
          member("p", "Brian", [{ toward: "Sable", stage: "close" }]),
          member("b", "Sable", [{ toward: "player", stage: "wary" }], "keeps the lighthouse"),
        ],
        "p",
      );
      expect(rows).toHaveLength(2);
      expect(rows).toContainEqual({ fromParticipantId: "b", toParticipantId: "p", kind: "feeling", value: -48, stage: "wary" });
      expect(rows).toContainEqual({ fromParticipantId: "b", toParticipantId: "p", kind: "perceived", value: -48, stage: "wary" });
    });

    it("a stranger edge from the played member writes nothing", () => {
      const rows = seedRelationshipRows(
        [member("p", "Brian", [{ toward: "Sable", stage: "stranger" }]), member("b", "Sable")],
        "p",
      );
      expect(rows).toEqual([]);
    });

    it("the played member authoring toward the player token is a self-reference", () => {
      const sink = new DiagnosticCollector();
      const rows = seedRelationshipRows([member("p", "Brian", [{ toward: "player", stage: "devoted" }])], "p", sink);
      expect(rows).toEqual([]);
      expect(sink.items.some((d) => d.code === "spawn.relationship.self_reference")).toBe(true);
    });
  });

  it("resolves toward names case-insensitively against cast display names", () => {
    const rows = seedRelationshipRows(
      [member("a", "Rook", [{ toward: "sABLe", stage: "acquaintance" }]), member("b", "Sable")],
      null,
    );
    expect(rows.find((r) => r.fromParticipantId === "a")?.toParticipantId).toBe("b");
  });

  it("degrades on an unresolved toward name: diagnostic recorded, row skipped, the rest still seed", () => {
    const sink = new DiagnosticCollector();
    const rows = seedRelationshipRows(
      [
        member("a", "Rook", [
          { toward: "Ghost", stage: "devoted" },
          { toward: "Sable", stage: "friendly" },
        ]),
        member("b", "Sable"),
      ],
      null,
      sink,
    );
    expect(rows).toHaveLength(2); // Sable edge + implied reverse; nothing for Ghost
    expect(rows.every((r) => r.value === 41)).toBe(true);
    const diagnostic = sink.items.find((d) => d.code === "spawn.relationship.unresolved_toward");
    expect(diagnostic).toBeDefined();
    expect(diagnostic?.severity).toBe("warn");
    expect(diagnostic?.context).toMatchObject({ from: "Rook", toward: "Ghost" });
  });

  it("skips self-referencing entries with a diagnostic", () => {
    const sink = new DiagnosticCollector();
    const rows = seedRelationshipRows([member("a", "Rook", [{ toward: "Rook", stage: "devoted" }])], null, sink);
    expect(rows).toEqual([]);
    expect(sink.items.some((d) => d.code === "spawn.relationship.self_reference")).toBe(true);
  });

  it("keeps the first of duplicate entries toward the same target, with a diagnostic", () => {
    const sink = new DiagnosticCollector();
    const rows = seedRelationshipRows(
      [
        member("a", "Rook", [
          { toward: "Sable", stage: "close" },
          { toward: "sable", stage: "hostile" },
        ]),
        member("b", "Sable"),
      ],
      null,
      sink,
    );
    expect(rows.find((r) => r.fromParticipantId === "a")?.value).toBe(72);
    expect(sink.items.some((d) => d.code === "spawn.relationship.duplicate")).toBe(true);
  });

  it("returns nothing for cast with no authored relationships", () => {
    expect(seedRelationshipRows([member("a", "Rook"), member("b", "Sable")], "p")).toEqual([]);
  });
});
