import { describe, expect, it } from "vitest";
import { FALLBACK_PLAYER_NAME, resolvePersonaFromRow } from "./persona";

describe("resolvePersonaFromRow", () => {
  it("uses the stored persona name and bio when set", () => {
    expect(resolvePersonaFromRow("acct-handle", { name: "Alex", persona: "A wry detective." })).toEqual({
      id: null,
      name: "Alex",
      persona: "A wry detective.",
    });
  });

  it("falls back to the account name when no persona name is set", () => {
    expect(resolvePersonaFromRow("Brian", { persona: "Just me." })).toEqual({
      id: null,
      name: "Brian",
      persona: "Just me.",
    });
  });

  it("drops a blank persona bio to undefined", () => {
    expect(resolvePersonaFromRow("Brian", { name: "Alex", persona: "   " })).toEqual({ id: null, name: "Alex" });
  });

  it("degrades a malformed blob to the account name, never throwing", () => {
    expect(resolvePersonaFromRow("Brian", "not-an-object")).toEqual({ id: null, name: "Brian" });
    expect(resolvePersonaFromRow("Brian", null)).toEqual({ id: null, name: "Brian" });
    expect(resolvePersonaFromRow("Brian", { name: 42 })).toEqual({ id: null, name: "Brian" });
  });

  it("uses the ultimate fallback when neither persona nor account name resolves", () => {
    expect(resolvePersonaFromRow(undefined, {})).toEqual({ id: null, name: FALLBACK_PLAYER_NAME });
    expect(resolvePersonaFromRow("   ", {})).toEqual({ id: null, name: FALLBACK_PLAYER_NAME });
  });
});
