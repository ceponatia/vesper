import { describe, expect, it } from "vitest";
import { fillPlayerToken, fillPlayerTokenOpt, OBSERVER_PLAYER_NAME } from "./player-token";

describe("fillPlayerToken", () => {
  it("replaces the token with the name", () => {
    expect(fillPlayerToken("{{player}} arrives at the inn.", "Brian")).toBe("Brian arrives at the inn.");
  });

  it("is case-insensitive", () => {
    expect(fillPlayerToken("{{Player}} and {{PLAYER}} and {{pLaYeR}}", "Brian")).toBe("Brian and Brian and Brian");
  });

  it("tolerates inner whitespace", () => {
    expect(fillPlayerToken("{{ player }} waves; {{  Player}} nods; {{player\t}} laughs", "Mara")).toBe(
      "Mara waves; Mara nods; Mara laughs",
    );
  });

  it("replaces every occurrence", () => {
    expect(fillPlayerToken("{{player}}, {{player}}, {{player}}", "Jo")).toBe("Jo, Jo, Jo");
  });

  it("no-ops on text without the token, returning the same reference", () => {
    const text = "Maya runs the inn alone.";
    expect(fillPlayerToken(text, "Brian")).toBe(text);
  });

  it("leaves non-token braces and unknown tokens alone", () => {
    expect(fillPlayerToken("{{narrator}} keeps {braces} and {{ player_two }}", "Brian")).toBe(
      "{{narrator}} keeps {braces} and {{ player_two }}",
    );
  });

  it("is idempotent for ordinary names", () => {
    const once = fillPlayerToken("{{player}} meets {{ Player }}.", "Brian");
    expect(fillPlayerToken(once, "Brian")).toBe(once);
  });

  it("inserts names with replacement-pattern characters literally", () => {
    expect(fillPlayerToken("{{player}} pays.", "D$& Vito")).toBe("D$& Vito pays.");
  });

  it("handles the empty string", () => {
    expect(fillPlayerToken("", "Brian")).toBe("");
  });

  it("fills the observer phrase like any other name", () => {
    expect(fillPlayerToken("They speak of {{player}}.", OBSERVER_PLAYER_NAME)).toBe("They speak of the protagonist.");
  });
});

describe("fillPlayerTokenOpt", () => {
  it("passes undefined through and fills present values", () => {
    expect(fillPlayerTokenOpt(undefined, "Brian")).toBeUndefined();
    expect(fillPlayerTokenOpt("{{player}} hums", "Brian")).toBe("Brian hums");
  });
});

describe("PLAYER_TOKEN", () => {
  it("does not match across separate brace pairs", () => {
    expect(fillPlayerToken("{{pla}}{{yer}}", "Brian")).toBe("{{pla}}{{yer}}");
  });
});
