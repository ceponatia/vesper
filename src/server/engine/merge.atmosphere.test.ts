import { describe, expect, it } from "vitest";
import { defaultExposureMask, type ExposureMask } from "@/contracts/state/brief";
import { resolveAtmosphere } from "./merge";

const exposure = (over: Partial<ExposureMask> = {}): ExposureMask => ({ ...defaultExposureMask(), ...over });

describe("resolveAtmosphere (scene-atmosphere.spec §2)", () => {
  it("the director's tone wins when present", () => {
    expect(resolveAtmosphere({ director: "tense", prior: "calm", exposure: exposure() })).toBe("tense");
  });

  it("no director ⇒ carry the prior tone forward (sticky)", () => {
    expect(resolveAtmosphere({ prior: "ominous", exposure: exposure() })).toBe("ominous");
  });

  it("scene start with no prior reads calm (the brief default)", () => {
    expect(resolveAtmosphere({ prior: "calm", exposure: exposure() })).toBe("calm");
  });

  it("an intimate frame floors a non-dark tone to romantic", () => {
    expect(resolveAtmosphere({ director: "warm", prior: "calm", exposure: exposure({ touch: "intimate" }) })).toBe("romantic");
    expect(resolveAtmosphere({ prior: "calm", exposure: exposure({ appearance: "intimate" }) })).toBe("romantic");
  });

  it("a dark director tone survives the intimate floor (an intimate scene can be fraught)", () => {
    expect(resolveAtmosphere({ director: "tense", prior: "romantic", exposure: exposure({ touch: "intimate" }) })).toBe("tense");
    expect(resolveAtmosphere({ director: "ominous", prior: "calm", exposure: exposure({ appearance: "intimate" }) })).toBe("ominous");
  });

  it("no intimate frame ⇒ the resolved tone passes through unchanged", () => {
    expect(resolveAtmosphere({ director: "melancholy", prior: "calm", exposure: exposure() })).toBe("melancholy");
    expect(resolveAtmosphere({ director: "hopeful", prior: "calm", exposure: exposure({ touch: "close" }) })).toBe("hopeful");
  });
});
