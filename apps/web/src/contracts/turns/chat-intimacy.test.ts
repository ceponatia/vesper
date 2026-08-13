import { describe, expect, it } from "vitest";
import { exposedRegions, FULLY_COVERED } from "../items/visibility";
import { CHAT_INTIMATE_AROUSAL_AT, chatSceneIsIntimate, exposureIsIntimate } from "./chat-intimacy";

describe("chatSceneIsIntimate", () => {
  it("is closed for an ordinary scene — dressed, sober, unaroused", () => {
    expect(chatSceneIsIntimate({ characterExposed: false, playerExposed: false, meters: { arousal: 0.2 } })).toBe(false);
  });

  // The gate DEFAULTS shut. A chat with no state and no wardrobe has shown nothing, so
  // it earns nothing — the failure mode that matters is leaking intimate text, not
  // withholding it.
  it("is closed on missing input", () => {
    expect(chatSceneIsIntimate({})).toBe(false);
    expect(chatSceneIsIntimate({ meters: {} })).toBe(false);
    expect(chatSceneIsIntimate({ characterExposed: undefined, playerExposed: undefined })).toBe(false);
  });

  it("opens on the character's bare coverage alone", () => {
    expect(chatSceneIsIntimate({ characterExposed: true, meters: { arousal: 0 } })).toBe(true);
  });

  // Only possible since the player got a real wardrobe (persona-library slice 8) — before
  // that this half of the scene was invisible to any gate.
  it("opens on the PLAYER's bare coverage alone", () => {
    expect(chatSceneIsIntimate({ characterExposed: false, playerExposed: true, meters: { arousal: 0 } })).toBe(true);
  });

  it("opens on arousal alone — a scene can be intimate with the clothes still on", () => {
    expect(chatSceneIsIntimate({ meters: { arousal: CHAT_INTIMATE_AROUSAL_AT } })).toBe(true);
    expect(chatSceneIsIntimate({ meters: { arousal: 0.9 } })).toBe(true);
  });

  it("holds the arousal line exactly at the threshold", () => {
    expect(chatSceneIsIntimate({ meters: { arousal: CHAT_INTIMATE_AROUSAL_AT - 0.01 } })).toBe(false);
    expect(chatSceneIsIntimate({ meters: { arousal: CHAT_INTIMATE_AROUSAL_AT } })).toBe(true);
  });

  it("ignores every other meter", () => {
    expect(chatSceneIsIntimate({ meters: { intoxication: 1, energy: 1, hygiene: 0, stress: 1 } })).toBe(false);
  });
});

describe("exposureIsIntimate", () => {
  it("reads bare intimate regions off computed coverage", () => {
    // No worn items ⇒ everything bare ⇒ intimate.
    expect(exposureIsIntimate(exposedRegions([]))).toBe(true);
    expect(exposureIsIntimate(FULLY_COVERED)).toBe(false);
    expect(exposureIsIntimate(undefined)).toBe(false);
  });

  it("bare legs alone are not intimate — torso or pelvis is the line", () => {
    expect(exposureIsIntimate({ torso: "covered", pelvis: "covered", legs: "bare", feet: "bare" })).toBe(false);
    expect(exposureIsIntimate({ torso: "bare", pelvis: "covered", legs: "covered", feet: "covered" })).toBe(true);
    expect(exposureIsIntimate({ torso: "covered", pelvis: "bare", legs: "covered", feet: "covered" })).toBe(true);
  });
});
