import { describe, expect, it } from "vitest";
import {
  authoredRecordToLive,
  authoredRelationshipRecordSchema,
  emptyRelationshipRecord,
  relationshipRecordSchema,
} from "./record";

describe("relationship record (live form)", () => {
  it("parses the empty record to the neutral default", () => {
    expect(emptyRelationshipRecord()).toEqual({
      familiarity: 0,
      regard: 0,
      kind: "",
      history: "",
      presented: undefined,
      looming: false,
    });
  });

  it("self-heals malformed fields instead of failing the record", () => {
    const parsed = relationshipRecordSchema.parse({
      familiarity: "not-a-number",
      regard: 42,
      kind: 7,
      history: null,
      presented: { lean: "bogus-lean", note: "kept?" },
      looming: "yes",
    });
    expect(parsed.familiarity).toBe(0);
    expect(parsed.regard).toBe(42);
    expect(parsed.kind).toBe("");
    expect(parsed.history).toBe("");
    expect(parsed.presented).toBeUndefined(); // malformed mask heals to honest
    expect(parsed.looming).toBe(false);
  });

  it("keeps a well-formed mask", () => {
    const parsed = relationshipRecordSchema.parse({
      familiarity: 85,
      regard: -20,
      presented: { lean: "masks_warmth", note: "icily civil" },
    });
    expect(parsed.presented).toEqual({ lean: "masks_warmth", note: "icily civil" });
  });
});

describe("relationship record (authored form)", () => {
  it("defaults to strangers/neutral and self-heals unknown bands", () => {
    const parsed = authoredRelationshipRecordSchema.parse({ familiarity: "bogus", regard: "bogus" });
    expect(parsed.familiarity).toBe("strangers");
    expect(parsed.regard).toBe("neutral");
    expect(authoredRelationshipRecordSchema.parse({}).looming).toBe(false);
  });

  it("authoredRecordToLive seeds scalars at band midpoints and carries the texture", () => {
    const live = authoredRecordToLive(
      authoredRelationshipRecordSchema.parse({
        familiarity: "deeply_known",
        regard: "cool",
        kind: "estranged childhood friends",
        history: "he left town without a word; she rebuilt alone",
        presented: { lean: "masks_dislike" },
        looming: true,
      }),
    );
    expect(live.familiarity).toBe(90); // deeply_known midpoint
    expect(live.regard).toBe(-25); // cool midpoint
    expect(live.kind).toBe("estranged childhood friends");
    expect(live.presented?.lean).toBe("masks_dislike");
    expect(live.looming).toBe(true);
  });
});
