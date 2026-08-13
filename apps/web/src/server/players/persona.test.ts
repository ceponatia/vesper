import { describe, expect, it } from "vitest";
import { FALLBACK_PLAYER_NAME, personaFromRow, type PersonaRow } from "./persona";

const row = (over: Partial<PersonaRow> = {}): PersonaRow => ({
  id: "p1",
  name: "Alex",
  profile: { bio: "A wry detective." },
  ...over,
});

describe("personaFromRow", () => {
  it("uses the persona's name and bio when a row resolved", () => {
    const resolved = personaFromRow("acct-handle", row());
    expect(resolved.id).toBe("p1");
    expect(resolved.name).toBe("Alex");
    expect(resolved.persona).toBe("A wry detective.");
    expect(resolved.profile?.bio).toBe("A wry detective.");
  });

  it("falls back to the account name when NO persona resolved (the ladder's last rung)", () => {
    expect(personaFromRow("Brian", null)).toEqual({ id: null, name: "Brian" });
  });

  it("falls back to the account name when the persona row has a blank name", () => {
    expect(personaFromRow("Brian", row({ name: "  " })).name).toBe("Brian");
  });

  it("drops a blank bio to undefined so the prompt block is omitted", () => {
    expect(personaFromRow("Brian", row({ profile: { bio: "   " } })).persona).toBeUndefined();
  });

  it("degrades a malformed profile to an empty one, never throwing", () => {
    for (const bad of ["not-an-object", null, 42, { bio: 42 }]) {
      const resolved = personaFromRow("Brian", row({ profile: bad }));
      expect(resolved.name).toBe("Alex"); // the row's columns still stand
      expect(resolved.persona).toBeUndefined();
      expect(resolved.profile?.speciesId).toBe("human"); // healed to defaults
    }
  });

  it("uses the ultimate fallback when neither a persona nor an account name resolves", () => {
    expect(personaFromRow(undefined, null)).toEqual({ id: null, name: FALLBACK_PLAYER_NAME });
    expect(personaFromRow("   ", null)).toEqual({ id: null, name: FALLBACK_PLAYER_NAME });
    expect(personaFromRow(undefined, row({ name: "" })).name).toBe(FALLBACK_PLAYER_NAME);
  });

  // The invariant that keeps the library label away from every model: `title` is not a
  // field on this shape, so there is no path for it to reach a prompt.
  it("never carries the persona's title, however the row is shaped", () => {
    const resolved = personaFromRow("Brian", { ...row(), title: "Brian, 22" } as PersonaRow);
    expect(resolved).not.toHaveProperty("title");
    expect(JSON.stringify(resolved)).not.toContain("Brian, 22");
  });
});
