import { describe, expect, it } from "vitest";
import {
  DEFAULT_SCENE_CAMERA,
  GLANCE_WORDS,
  isDefaultSceneCamera,
  sceneCameraHeightById,
  sceneCameraHeightIds,
  sceneCameraHeights,
  sceneShotDistanceById,
  sceneShotDistanceIds,
  sceneShotDistances,
  sceneSubjectOrientationById,
  sceneSubjectOrientationIds,
  sceneSubjectOrientations,
} from "./scene-camera";

/**
 * The bare-limb patterns, copied VERBATIM from `server/images/prompts-scene-plan.ts` (the
 * phantom-limb backstop `bindLimbsToOwner` runs). Copied rather than imported because a
 * contracts test may not reach into server code — and because the pin is the point: if the
 * server pattern ever widens, this copy stops matching it and the divergence is visible in
 * one place instead of leaking into a prompt.
 */
const BARE_LIMB = /\b(?:a|an|one)\s+(hand|arm|leg|foot|finger|thumb|palm|wrist|knee|elbow)\b(?!['’-])/gi;
const BOTH_LIMBS = /\bboth\s+(hands|arms|legs|feet|knees|elbows)\b/gi;

/** `.test` on a `/g` pattern carries `lastIndex` between calls; check against a fresh copy each time. */
const matches = (pattern: RegExp, text: string): boolean => new RegExp(pattern.source, "i").test(text);

/** Limb nouns an orientation phrase may not name AT ALL — a limb noun summons a limb. */
const LIMB_NOUN = /\b(hands?|arms?|legs?|foot|feet|fingers?|thumbs?|palms?|wrists?|knees?|elbows?)\b/i;

/** Characters can be any gender; a phrase that says "her back" mis-genders half the cast. */
const GENDERED_PRONOUN = /\b(she|he|her|hers|his|him)\b/i;

/** Negations anchor on the thing they negate — the scar recorded on SCENE_POV_RULE. */
const NEGATION = /\b(no|not|never|without|nor)\b/i;

const bind = (phrase: string): string => phrase.replaceAll("{name}", "Mira");
const allPhrases = (): string[] => [
  ...sceneSubjectOrientations.map((entry) => entry.phrase),
  ...sceneShotDistances.map((entry) => entry.phrase),
  ...sceneCameraHeights.map((entry) => entry.phrase),
];

describe("the camera registry", () => {
  it("has one entry per id, and no id twice", () => {
    expect(sceneSubjectOrientations.map((entry) => entry.id)).toEqual([...sceneSubjectOrientationIds]);
    expect(sceneShotDistances.map((entry) => entry.id)).toEqual([...sceneShotDistanceIds]);
    expect(sceneCameraHeights.map((entry) => entry.id)).toEqual([...sceneCameraHeightIds]);
    for (const ids of [sceneSubjectOrientationIds, sceneShotDistanceIds, sceneCameraHeightIds]) {
      expect(new Set(ids).size).toBe(ids.length);
    }
  });

  it("resolves every id and nothing the composer invented", () => {
    for (const id of sceneSubjectOrientationIds) expect(sceneSubjectOrientationById(id)?.id).toBe(id);
    for (const id of sceneShotDistanceIds) expect(sceneShotDistanceById(id)?.id).toBe(id);
    for (const id of sceneCameraHeightIds) expect(sceneCameraHeightById(id)?.id).toBe(id);
    expect(sceneSubjectOrientationById("over_the_shoulder")).toBeUndefined();
    expect(sceneShotDistanceById("extreme_close")).toBeUndefined();
    expect(sceneCameraHeightById("birds_eye")).toBeUndefined();
  });

  it("every distance and height carries a selection hint, distinct from its render phrase", () => {
    for (const entry of [...sceneShotDistances, ...sceneCameraHeights]) {
      expect(entry.hint.trim().length, entry.id).toBeGreaterThan(0);
      // A hint is read by the composer, never rendered, so it carries no `{name}` — and it
      // is not the phrase: the two have different audiences and are tuned separately.
      expect(entry.hint, entry.id).not.toContain("{name}");
      expect(entry.hint, entry.id).not.toBe(entry.phrase);
    }
  });

  it("defines distance by how much of the body the frame holds, not by how near the viewer stands", () => {
    // The confusion the bare id list invited, and the one the hints exist to end: "he stops
    // right behind her" is a proximity fact and says nothing about the frame.
    const close = sceneShotDistanceById("close")?.hint ?? "";
    const medium = sceneShotDistanceById("medium")?.hint ?? "";
    expect(close).toMatch(/frame/i);
    expect(medium).toMatch(/frame|waist/i);
    for (const entry of sceneShotDistances) expect(entry.hint, entry.id).not.toMatch(/\bstand(?:ing|s)? near\b/i);
  });

  // The phrase is a TEMPLATE. Without {name} the subject is never named, and an unbound
  // "back to the camera" is a back the model may hang on anyone in frame.
  it("every phrase is a non-empty {name} template", () => {
    for (const phrase of allPhrases()) {
      expect(phrase.trim().length).toBeGreaterThan(0);
      expect(phrase).toContain("{name}");
    }
  });
});

describe("the phrasing rules that keep a phrase from painting a second person", () => {
  // THE phantom-limb pin: a limb noun in a first-person POV prompt reads as the viewer's
  // own foreground limb. Orientation phrases carry back/shoulder words on purpose and no
  // limb nouns at all.
  it("names no limb in any orientation phrase", () => {
    for (const entry of sceneSubjectOrientations) {
      expect(entry.phrase, entry.id).not.toMatch(LIMB_NOUN);
    }
  });

  it("leaves no unbound limb anywhere once {name} is substituted", () => {
    for (const phrase of allPhrases()) {
      expect(matches(BARE_LIMB, bind(phrase)), phrase).toBe(false);
      expect(matches(BOTH_LIMBS, bind(phrase)), phrase).toBe(false);
    }
  });

  it("uses no gendered pronoun — the cast is not all one gender", () => {
    for (const phrase of allPhrases()) expect(phrase).not.toMatch(GENDERED_PRONOUN);
  });

  it("states the geometry that is, never the one that is not", () => {
    for (const phrase of allPhrases()) expect(phrase).not.toMatch(NEGATION);
  });

  // Every back- and shoulder-region word is bound to the subject, which is what makes it
  // safe to use them at all.
  it("binds the back and shoulder words to the subject", () => {
    for (const entry of sceneSubjectOrientations) {
      for (const region of ["back", "shoulder"]) {
        if (!entry.phrase.includes(region)) continue;
        expect(entry.phrase, entry.id).toContain(`{name}'s ${region}`);
      }
    }
  });
});

describe("the gates each vocabulary carries", () => {
  // Only the front-facing default is free. Everything else is a claim about where two
  // bodies are, and a camera that wanders on a whim is as wrong as one that never moves.
  it("requires evidence for every orientation but the default", () => {
    expect(sceneSubjectOrientationById("toward_viewer")?.evidenceRequired).toBe(false);
    for (const id of ["three_quarter", "profile", "away_glance_back", "away"]) {
      expect(sceneSubjectOrientationById(id)?.evidenceRequired, id).toBe(true);
    }
  });

  it("grades face visibility by how much of the face the shot can hold", () => {
    expect(sceneSubjectOrientationById("toward_viewer")?.faceVisibility).toBe("full");
    expect(sceneSubjectOrientationById("three_quarter")?.faceVisibility).toBe("full");
    expect(sceneSubjectOrientationById("profile")?.faceVisibility).toBe("partial");
    expect(sceneSubjectOrientationById("away_glance_back")?.faceVisibility).toBe("partial");
    expect(sceneSubjectOrientationById("away")?.faceVisibility).toBe("hidden");
  });

  // A wrong distance is a taste miss, not a contradiction — so distances carry no gate at
  // all, which is why the interface has no `evidenceRequired` field to set.
  it("gates height but never distance", () => {
    expect(sceneCameraHeightById("eye_level")?.evidenceRequired).toBe(false);
    expect(sceneCameraHeightById("high")?.evidenceRequired).toBe(true);
    expect(sceneCameraHeightById("low")?.evidenceRequired).toBe(true);
    for (const entry of sceneShotDistances) expect(entry).not.toHaveProperty("evidenceRequired");
  });
});

describe("the default shot", () => {
  it("is today's behavior, and recognizes itself", () => {
    expect(DEFAULT_SCENE_CAMERA).toEqual({ orientation: "toward_viewer", distance: "medium", height: "eye_level" });
    expect(isDefaultSceneCamera(DEFAULT_SCENE_CAMERA)).toBe(true);
    expect(isDefaultSceneCamera({ ...DEFAULT_SCENE_CAMERA })).toBe(true);
  });

  // One moved field is enough to earn a shot line; the render layer emits nothing otherwise.
  it("is not the default once any one field moves", () => {
    expect(isDefaultSceneCamera({ ...DEFAULT_SCENE_CAMERA, orientation: "away" })).toBe(false);
    expect(isDefaultSceneCamera({ ...DEFAULT_SCENE_CAMERA, distance: "close" })).toBe(false);
    expect(isDefaultSceneCamera({ ...DEFAULT_SCENE_CAMERA, height: "high" })).toBe(false);
  });
});

/**
 * Away means fully away; the glance back is its own claim (owner ruling 2026-08-10). This
 * pattern is what separates a quote that grounds the glance from a quote that grounds only
 * the behind-position — the latter resolves to `away`.
 */
describe("GLANCE_WORDS", () => {
  it("matches the language that actually describes a look back", () => {
    expect(GLANCE_WORDS.test("glancing back over her shoulder")).toBe(true);
    expect(GLANCE_WORDS.test("she looks back")).toBe(true);
    expect(GLANCE_WORDS.test("she peeks over at him")).toBe(true);
    expect(GLANCE_WORDS.test("a glance thrown over one shoulder")).toBe(true);
    expect(GLANCE_WORDS.test("looking over their shoulder")).toBe(true);
  });

  // The behind-position alone is exactly what the ruling refuses to spend on the glance.
  it("does not match a plain behind-position quote", () => {
    expect(GLANCE_WORDS.test("pressed against her back")).toBe(false);
    expect(GLANCE_WORDS.test("he steps up behind her, arms around her waist")).toBe(false);
    expect(GLANCE_WORDS.test("her back to the room")).toBe(false);
  });
});
