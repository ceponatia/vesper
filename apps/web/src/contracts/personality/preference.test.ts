import { describe, expect, it } from "vitest";
import { describePreference, preferenceSchema, type Preference } from "./preference";

const pref = (over: Partial<Preference> = {}): Preference =>
  preferenceSchema.parse({ target: "compliment", valence: "dislike", intensity: 5, ...over });

describe("describePreference (slice 4 — preferences reach the narrator)", () => {
  it("names the concept and attaches the authored reaction hint", () => {
    expect(describePreference(pref({ target: "compliment", hint: "flattery makes her wary" }))).toBe(
      "compliment — flattery makes her wary",
    );
  });

  it("uses the bare concept label when no hint is authored", () => {
    expect(describePreference(pref({ target: "confide", valence: "like", hint: undefined }))).toBe("confiding");
  });

  it("humanizes a family target that has no concept of its own", () => {
    expect(describePreference(pref({ target: "affection_display" }))).toBe("affection display");
  });
});
