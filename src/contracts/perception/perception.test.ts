import { describe, it, expect } from "vitest";
import { deriveAttention, describeAttention } from "./attention";
import { perceives } from "./witness";
import { darknessVerdict, senseModsFromConditions } from "./darkness";
import { defaultSalience, concealedSalience, hasStealthMarker } from "./salience";
import { distantExists, defaultEntryTier, areAdjacentTiers, perceivableByDefault, tierIndex } from "./proximity";
import type { Salience } from "./salience";
import type { ActiveCondition } from "../conditions/condition";

const S = (visual: Salience["visual"], audible: Salience["audible"]): Salience => ({ visual, audible });

describe("deriveAttention", () => {
  it("reads sleep/unconscious as asleep_or_impaired", () => {
    expect(deriveAttention({ activity: "fast asleep in bed" }).state).toBe("asleep_or_impaired");
    expect(deriveAttention({ activity: "passed out on the couch" }).state).toBe("asleep_or_impaired");
  });

  it("reads active social activity as engaged_with", () => {
    expect(deriveAttention({ activity: "talking with Brian" }).state).toBe("engaged_with");
    expect(deriveAttention({ activity: "kissing him" }).state).toBe("engaged_with");
  });

  it("reads task activity as absorbed", () => {
    expect(deriveAttention({ activity: "washing dishes at the sink" }).state).toBe("absorbed");
    expect(deriveAttention({ hint: "absorbing", activity: "humming" }).state).toBe("absorbed");
  });

  it("reads alert/lookout activity as idle_alert and defaults to it", () => {
    expect(deriveAttention({ activity: "waiting by the door" }).state).toBe("idle_alert");
    expect(deriveAttention({ activity: "" }).state).toBe("idle_alert"); // neutral default
    expect(deriveAttention({ hint: "outward", activity: "standing" }).state).toBe("idle_alert");
  });

  it("flags facesAway from a hint or posture text, only meaningful when absorbed", () => {
    expect(deriveAttention({ activity: "scrubbing the floor", hint: "faces_away" }).facesAway).toBe(true);
    expect(deriveAttention({ activity: "reading", posture: "back turned to the room" }).facesAway).toBe(true);
    expect(deriveAttention({ activity: "reading" }).facesAway).toBe(false);
  });

  it("describeAttention is human-readable", () => {
    expect(describeAttention({ state: "absorbed", facesAway: true })).toMatch(/back turned/);
  });
});

describe("perceives — the witness matrix (defaults doc)", () => {
  it("engaged_with(actor): perceives everything", () => {
    const o = { attention: "engaged_with" as const, engagedWithActor: true };
    expect(perceives(o, S("obvious", "loud"))).toBe(true);
    expect(perceives(o, S("subtle", "quiet"))).toBe(true);
    expect(perceives(o, S("subtle", "silent"))).toBe(true); // sees the subtle visual
  });

  it("engaged_with(other): a conversation masks subtle/quiet elsewhere", () => {
    const o = { attention: "engaged_with" as const, engagedWithActor: false };
    expect(perceives(o, S("obvious", "silent"))).toBe(true);
    expect(perceives(o, S("subtle", "quiet"))).toBe(false);
    expect(perceives(o, S("subtle", "loud"))).toBe(true); // loud still cuts through
  });

  it("idle_alert: obvious visual or any audible", () => {
    const o = { attention: "idle_alert" as const };
    expect(perceives(o, S("obvious", "silent"))).toBe(true);
    expect(perceives(o, S("subtle", "silent"))).toBe(false);
    expect(perceives(o, S("subtle", "quiet"))).toBe(true); // alert hears quiet
  });

  it("absorbed (neutral): obvious visual or loud audible only", () => {
    const o = { attention: "absorbed" as const };
    expect(perceives(o, S("obvious", "silent"))).toBe(true);
    expect(perceives(o, S("subtle", "quiet"))).toBe(false);
    expect(perceives(o, S("subtle", "loud"))).toBe(true);
  });

  it("absorbed + faces_away: the kitchen-sink bug — misses everything but loud sound", () => {
    const o = { attention: "absorbed" as const, facesAway: true };
    expect(perceives(o, S("obvious", "quiet"))).toBe(false); // can't see (back turned), absorbed misses quiet
    expect(perceives(o, S("subtle", "silent"))).toBe(false);
    expect(perceives(o, S("obvious", "loud"))).toBe(true); // a loud noise still reaches her
  });

  it("asleep_or_impaired: only a loud sound", () => {
    const o = { attention: "asleep_or_impaired" as const };
    expect(perceives(o, S("obvious", "quiet"))).toBe(false);
    expect(perceives(o, S("obvious", "loud"))).toBe(true);
  });

  it("silent audible is never heard by anyone", () => {
    expect(perceives({ attention: "idle_alert" }, S("subtle", "silent"))).toBe(false);
    expect(perceives({ attention: "engaged_with", engagedWithActor: true }, S("subtle", "silent"))).toBe(true); // but sees it
  });

  it("darkness downgrades obvious visual to subtle", () => {
    const o = { attention: "idle_alert" as const };
    expect(perceives(o, S("obvious", "silent"))).toBe(true);
    expect(perceives(o, S("obvious", "silent"), { dark: true })).toBe(false); // now subtle, alert misses it
  });

  it("blocked sight / hearing removes that channel; reduced narrows it", () => {
    expect(perceives({ attention: "engaged_with", engagedWithActor: true }, S("obvious", "silent"), { sight: "blocked" })).toBe(false);
    expect(perceives({ attention: "idle_alert" }, S("subtle", "loud"), { hearing: "blocked" })).toBe(false);
    expect(perceives({ attention: "idle_alert" }, S("subtle", "quiet"), { hearing: "reduced" })).toBe(false); // reduced hearing misses quiet
  });

  it("proximityOverride (contact/entwined partner) perceives regardless", () => {
    expect(perceives({ attention: "asleep_or_impaired" }, S("subtle", "silent"), { proximityOverride: true })).toBe(true);
  });
});

describe("darknessVerdict", () => {
  it("is never dark outside the night band", () => {
    expect(darknessVerdict("day", "")).toEqual({ dark: false, miss: false });
    expect(darknessVerdict("dusk", "")).toEqual({ dark: false, miss: false });
  });
  it("night with no light is dark", () => {
    expect(darknessVerdict("night", "")).toEqual({ dark: true, miss: false });
    expect(darknessVerdict("night", undefined)).toEqual({ dark: true, miss: false });
  });
  it("night with lit-leaning light stays lit", () => {
    expect(darknessVerdict("night", "warm lamplight by the bed").dark).toBe(false);
    expect(darknessVerdict("night", "a candle flickers").dark).toBe(false);
  });
  it("night with dark-leaning light is dark", () => {
    expect(darknessVerdict("night", "pitch black").dark).toBe(true);
  });
  it("night with ambiguous light defaults dark and flags a miss", () => {
    expect(darknessVerdict("night", "a faint hum in the air")).toEqual({ dark: true, miss: true });
  });
});

describe("senseModsFromConditions", () => {
  const cond = (label: string, extra: Partial<ActiveCondition> = {}): ActiveCondition => ({
    id: label, label, startedAtMinutes: 0, attributeEffects: [], ...extra,
  });
  it("maps known labels to sense effects", () => {
    expect(senseModsFromConditions([cond("blindfolded")])).toEqual({ sight: "blocked", hearing: "normal" });
    expect(senseModsFromConditions([cond("drunk")])).toEqual({ sight: "reduced", hearing: "reduced" });
  });
  it("explicit senseEffects on a condition win", () => {
    expect(senseModsFromConditions([cond("hexed", { senseEffects: { hearing: "blocked" } })])).toEqual({
      sight: "normal", hearing: "blocked",
    });
  });
  it("blocked beats reduced across stacked conditions; no effect ⇒ normal", () => {
    expect(senseModsFromConditions([cond("drunk"), cond("blind")]).sight).toBe("blocked");
    expect(senseModsFromConditions([cond("cheerful")])).toEqual({ sight: "normal", hearing: "normal" });
  });
});

describe("salience helpers", () => {
  it("defaults to obvious/quiet; concealed is subtle/quiet", () => {
    expect(defaultSalience()).toEqual({ visual: "obvious", audible: "quiet" });
    expect(concealedSalience()).toEqual({ visual: "subtle", audible: "quiet" });
  });
  it("detects stealth markers", () => {
    expect(hasStealthMarker("I quietly slip the note into her bag")).toBe(true);
    expect(hasStealthMarker("I tell her about my day")).toBe(false);
  });
});

describe("proximity primitive", () => {
  it("distant exists only at open/expanse", () => {
    expect(distantExists("room")).toBe(false);
    expect(distantExists("open")).toBe(true);
    expect(distantExists("expanse")).toBe(true);
  });
  it("entry default is apart for small spaces, distant for large", () => {
    expect(defaultEntryTier("intimate")).toBe("apart");
    expect(defaultEntryTier("room")).toBe("apart");
    expect(defaultEntryTier("expanse")).toBe("distant");
  });
  it("perceivable-by-default everywhere except where distant is the entry tier", () => {
    expect(perceivableByDefault("room")).toBe(true);
    expect(perceivableByDefault("open")).toBe(false);
  });
  it("tier adjacency follows the ladder order", () => {
    expect(tierIndex("distant")).toBe(0);
    expect(areAdjacentTiers("apart", "near")).toBe(true);
    expect(areAdjacentTiers("apart", "close")).toBe(false);
    expect(areAdjacentTiers("contact", "entwined")).toBe(true);
  });
});
