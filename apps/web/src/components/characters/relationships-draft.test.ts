import { describe, expect, it } from "vitest";
import { emptyRelationshipTexture } from "@/contracts";
import { rebaseRelationshipRecovery, relationshipSnapshot, type EdgeDraft } from "./relationships-draft";

const edge: EdgeDraft = {
  toCharacterId: "character_2", toName: "Mira",
  record: { ...emptyRelationshipTexture(), familiarity: "strangers", regard: "neutral" },
};

describe("library relationship save acknowledgements", () => {
  it("retains edits made during a write and rebases their recovery on what actually saved", () => {
    const original = relationshipSnapshot([edge]);
    const sent = { ...edge, record: { ...edge.record, kind: "old friends" } };
    const saved = relationshipSnapshot([sent]);
    const later = { ...sent, record: { ...sent.record, history: "Reunited at the lighthouse" } };
    const pending = { base: original, edges: [later] };
    const acknowledged = rebaseRelationshipRecovery(pending, original, saved, false);
    expect(acknowledged?.edges).toBe(pending.edges);
    expect(acknowledged?.base).toBe(saved);
    expect(relationshipSnapshot(acknowledged!.edges)).not.toBe(saved);
  });

  it("does not approve a recovered version from another server baseline", () => {
    const recovery = { base: "older server state", edges: [edge] };
    expect(rebaseRelationshipRecovery(recovery, "current server state", "just saved", false)).toBe(recovery);
    expect(rebaseRelationshipRecovery(recovery, recovery.base, "just saved", true)).toBe(recovery);
  });

  it("preserves removing the last edge while the preceding write finishes", () => {
    const recovery = { base: "before", edges: [] };
    expect(rebaseRelationshipRecovery(recovery, "before", "saved", false)).toEqual({ base: "saved", edges: [] });
  });

  it("compares relationship sets consistently across server ordering and parsed key order", () => {
    const other = { ...edge, toCharacterId: "character_3" };
    const reordered = { ...edge, record: {
      looming: edge.record.looming, history: edge.record.history, kind: edge.record.kind,
      regard: edge.record.regard, familiarity: edge.record.familiarity,
    } };
    expect(relationshipSnapshot([edge, other])).toBe(relationshipSnapshot([other, reordered]));
  });

  it("ignores a display-name refresh when comparing saved state", () => {
    expect(relationshipSnapshot([edge])).toBe(relationshipSnapshot([{ ...edge, toName: "Mira Vale" }]));
  });
});
