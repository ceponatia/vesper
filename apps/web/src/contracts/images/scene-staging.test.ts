import { describe, expect, it } from "vitest";
import { FULLY_COVERED } from "../items/visibility";
import {
  sceneCameraHeightById,
  sceneShotDistanceById,
  sceneSubjectOrientationById,
} from "./scene-camera";
import {
  sceneStagingById,
  sceneStagingContactEvidence,
  sceneStagingIds,
  sceneStagings,
  stagingEvidenceFromContacts,
  type SceneContactPairRead,
} from "./scene-staging";
import { viewerBodyPartById } from "./viewer-body";

/**
 * The bare-limb patterns, copied VERBATIM from `server/images/prompts-scene-plan.ts` (the
 * phantom-limb backstop `bindLimbsToOwner` runs). A contracts test may not import server
 * code, and the copy is deliberate: these templates are the one place explicit limb
 * geometry is written by hand, so they get checked against the exact pattern the runtime
 * scrub uses.
 */
const BARE_LIMB = /\b(?:a|an|one)\s+(hand|arm|leg|foot|finger|thumb|palm|wrist|knee|elbow)\b(?!['’-])/gi;
const BOTH_LIMBS = /\bboth\s+(hands|arms|legs|feet|knees|elbows)\b/gi;

/** `.test` on a `/g` pattern carries `lastIndex` between calls; check against a fresh copy each time. */
const matches = (pattern: RegExp, text: string): boolean => new RegExp(pattern.source, "i").test(text);

const GENDERED_PRONOUN = /\b(she|he|her|hers|his|him)\b/i;
const NEGATION = /\b(no|not|never|without|nor)\b/i;

/** Every limb noun in a template has to belong to somebody — the subject, or the viewer. */
const LIMB_NOUN = /\b(hands?|arms?|legs?|foot|feet|fingers?|thumbs?|palms?|wrists?|knees?|elbows?)\b/gi;

const bind = (template: string): string => template.replaceAll("{name}", "Mira");

/** The exposure regions a staging may demand — the whole of `RegionExposure`. */
const EXPOSURE_KEYS = Object.keys(FULLY_COVERED);

describe("the staging registry", () => {
  it("has one entry per id, in order, and no id twice", () => {
    expect(sceneStagings.map((entry) => entry.id)).toEqual([...sceneStagingIds]);
    expect(new Set(sceneStagingIds).size).toBe(sceneStagingIds.length);
  });

  it("resolves every id and nothing the composer invented", () => {
    for (const id of sceneStagingIds) expect(sceneStagingById(id)?.id).toBe(id);
    expect(sceneStagingById("carried_bridal")).toBeUndefined();
    expect(sceneStagingById("")).toBeUndefined();
  });

  it("every template is a non-empty {name} template", () => {
    for (const entry of sceneStagings) {
      expect(entry.template.trim().length, entry.id).toBeGreaterThan(0);
      expect(entry.template, entry.id).toContain("{name}");
    }
  });

  // Registry data, so every id it names must be real: an unknown camera id would silently
  // leave the composer's own camera standing, and an unknown viewer part would be dropped
  // by resolveViewerParts with no trace of what the staging meant to show.
  it("names only cameras the camera registry knows", () => {
    for (const entry of sceneStagings) {
      expect(sceneSubjectOrientationById(entry.camera.orientation), entry.id).toBeDefined();
      expect(sceneShotDistanceById(entry.camera.distance), entry.id).toBeDefined();
      expect(sceneCameraHeightById(entry.camera.height), entry.id).toBeDefined();
    }
  });

  it("names only viewer parts the viewer-body registry knows", () => {
    for (const entry of sceneStagings) {
      for (const part of entry.viewerParts) expect(viewerBodyPartById(part), `${entry.id}/${part}`).toBeDefined();
    }
  });

  it("names only real exposure regions in requiresBare", () => {
    for (const entry of sceneStagings) {
      for (const region of entry.requiresBare) expect(EXPOSURE_KEYS, entry.id).toContain(region);
    }
  });
});

describe("the template phrasing rules", () => {
  // THE phantom-limb pin. An unowned limb in a first-person prompt reads as the viewer's
  // own foreground limb — or, worse, as a third person standing in the room.
  it("leaves no unbound limb once {name} is substituted", () => {
    for (const entry of sceneStagings) {
      expect(matches(BARE_LIMB, bind(entry.template)), entry.id).toBe(false);
      expect(matches(BOTH_LIMBS, bind(entry.template)), entry.id).toBe(false);
    }
  });

  // Stronger than the regex above: every limb noun must be immediately preceded by a
  // possessive naming its owner, so no phrasing the pattern happens not to cover can slip
  // a free-floating limb into a prompt.
  it("possessively binds every limb noun to the subject or to the viewer", () => {
    for (const entry of sceneStagings) {
      const bound = bind(entry.template);
      for (const match of bound.matchAll(LIMB_NOUN)) {
        const before = bound.slice(0, match.index);
        expect(before, `${entry.id}: "${match[0]}"`).toMatch(/(Mira's|viewer's own|viewer's)\s*$/);
      }
    }
  });

  it("uses no gendered pronoun and no negation", () => {
    for (const entry of sceneStagings) {
      expect(entry.template, entry.id).not.toMatch(GENDERED_PRONOUN);
      expect(entry.template, entry.id).not.toMatch(NEGATION);
    }
  });
});

describe("the gates each entry carries", () => {
  // The rule, stated as a test: a template that names an explicit act or intimate anatomy
  // is intimate, and rides only the uncensored route. A clothed-capable hold is not.
  it("marks exactly the explicit entries intimate", () => {
    const intimate = sceneStagings.filter((entry) => entry.intimate).map((entry) => entry.id);
    expect(intimate).toEqual([
      "held_from_behind_bare",
      "kneeling_before_viewer",
      "kneeling_before_viewer_guided",
      "astride_viewer_facing",
      "astride_viewer_away",
      "bent_over_surface",
      "on_all_fours",
      "lying_beneath_viewer",
    ]);
  });

  // Clothed-capable holds must stay renderable on a fully dressed subject, or the whole
  // "held from behind" case never fires outside intimate play.
  it("leaves the clothed-capable holds free of exposure requirements", () => {
    for (const id of [
      "held_from_behind",
      "lying_face_down",
      "spooned_from_behind",
      "pressed_to_wall_facing",
      "pressed_to_wall_away",
    ]) {
      const entry = sceneStagingById(id);
      expect(entry?.intimate, id).toBe(false);
      expect(entry?.requiresBare, id).toEqual([]);
    }
  });

  it("requires a bare pelvis for every penetrative staging", () => {
    for (const entry of sceneStagings) {
      if (!entry.template.includes("penetration") && !entry.template.includes("bare hips")) continue;
      expect(entry.requiresBare, entry.id).toContain("pelvis");
    }
  });

  // Owner ruling 2026-08-14. Every template describes a two-body geometry between the
  // subject and the viewer, so a second present NPC would make the sentence a lie about
  // who is where. The gate itself runs in resolveScenePlan.
  it("is solo-cast throughout in v1", () => {
    for (const entry of sceneStagings) expect(entry.cast, entry.id).toBe("solo");
  });

  // Away means fully away (owner ruling 2026-08-10): a staging never claims the glance,
  // which is a separate physical claim needing its own narration evidence.
  it("never claims the glance back", () => {
    for (const entry of sceneStagings) expect(entry.camera.orientation).not.toBe("away_glance_back");
  });
});

/**
 * The three configurations the owner pinned to slice 2's pass/fail acceptance scenes
 * (scene-composition.spec.md §"Acceptance scenes"). Their camera, viewer parts, and the
 * elements their templates have to be able to express are graded in the probe, so they are
 * pinned here rather than left to a later phrasing pass.
 */
describe("the acceptance-scene entries", () => {
  it("stages doggy style away from the camera with the viewer's hands on her waist or hips", () => {
    const entry = sceneStagingById("on_all_fours");
    expect(entry?.camera).toEqual({ orientation: "away", distance: "close", height: "high" });
    expect(entry?.viewerParts).toEqual(["hands"]);
    expect(entry?.template).toContain("on all fours");
    expect(entry?.template).toContain("{name}'s back to the camera");
    expect(entry?.template).toContain("facing away from the lens");
    // The frame-edge clause is part of the pin (probe run 2026-08-14): hands stated
    // without an entry edge were drawn as HER hands, and the viewer vanished.
    expect(entry?.template).toContain(
      "the viewer's own hands entering frame from the lower edge and resting on {name}'s waist and hips",
    );
  });

  it("stages oral both ways — her face up, or the crown of her head under the viewer's hand", () => {
    const facing = sceneStagingById("kneeling_before_viewer");
    expect(facing?.camera).toEqual({ orientation: "toward_viewer", distance: "close", height: "high" });
    expect(facing?.viewerParts).toEqual(["genitals"]);
    expect(facing?.template).toContain("{name}'s face tilted up toward the viewer");
    expect(facing?.template).toContain("{name}'s mouth on the viewer's own genitals");
    // The orientation says toward_viewer, so the face reads full unless the entry overrides it.
    expect(facing?.faceVisibility).toBeUndefined();

    const guided = sceneStagingById("kneeling_before_viewer_guided");
    expect(guided?.camera).toEqual({ orientation: "toward_viewer", distance: "close", height: "high" });
    expect(guided?.viewerParts).toEqual(["hands", "genitals"]);
    expect(guided?.template).toContain("{name}'s head bowed");
    expect(guided?.template).toContain("the crown of {name}'s head toward the camera");
    expect(guided?.template).toContain("the viewer's own hand resting on top of {name}'s head");
    // The whole reason the override field exists: the camera faces her, and the face is
    // hidden by head angle alone, so the lock adaptation's `hidden` branch fires off this.
    expect(guided?.faceVisibility).toBe("hidden");
  });

  it("stages missionary with penetration at the bottom edge and either hand position", () => {
    const entry = sceneStagingById("lying_beneath_viewer");
    expect(entry?.camera).toEqual({ orientation: "toward_viewer", distance: "close", height: "high" });
    expect(entry?.viewerParts).toEqual(["hands", "genitals"]);
    expect(entry?.template).toContain("{name}'s face turned up toward the camera");
    expect(entry?.template).toContain("the viewer's own genitals entering frame at the bottom edge");
    expect(entry?.template).toContain("penetration");
    // "legs OR waist" both pass the grading, so the template names both.
    expect(entry?.template).toContain("the viewer's own hands holding {name}'s legs and waist");
  });
});

/**
 * Committed contact standing in for a narration quote. The table is EMPTY today and the
 * comment on it says why: the chat lane commits affectionate touch only (a hand meeting
 * shoulders, arms, back, head, hair), and every one of those pairs is consistent with
 * several stagings and with none. These tests pin the empty-and-typed state and the
 * degradation it implies, so the first real row has to be added deliberately.
 */
describe("contact as staging evidence", () => {
  it("names only real staging ids", () => {
    for (const row of sceneStagingContactEvidence) expect(sceneStagingById(row.stagingId)).toBeDefined();
  });

  it("grounds nothing today, so every staging still has to earn a quote", () => {
    expect(sceneStagingContactEvidence).toEqual([]);
    const handOnHerBack: SceneContactPairRead = {
      sourceLocationId: "hands",
      targetLocationId: "back",
      sourceIsPlayer: true,
    };
    // The tempting row, and the reason it is not there: a hand on the back belongs to a
    // face-to-face embrace as readily as to a hold from behind.
    expect(stagingEvidenceFromContacts([handOnHerBack], "held_from_behind")).toBe(false);
    expect(stagingEvidenceFromContacts([handOnHerBack], "spooned_from_behind")).toBe(false);
    expect(stagingEvidenceFromContacts([], "on_all_fours")).toBe(false);
    expect(stagingEvidenceFromContacts([handOnHerBack], "not_a_staging")).toBe(false);
  });
});
