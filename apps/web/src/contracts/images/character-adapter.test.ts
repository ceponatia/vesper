import { describe, expect, it } from "vitest";
import { characterAppearanceAspect, IMAGE_CHARACTER_APPEARANCE_REFERENCE_REDUNDANT } from "./character-adapter";

/**
 * `characterAppearanceAspect` (issue #450) — the ONE place a
 * `subject.appearance` fact's attribute id is translated into the closed
 * reference-authority vocabulary a resolved render contract may declare
 * itself authoritative over. Derived from the attribute registry's own
 * category, never a hand list of attribute ids: this suite pins that the
 * mapping matches the categories the registry actually declares, so a
 * category renamed or an attribute moved to a different one is caught here
 * rather than as a silent change in what a reference-anchored render states.
 */
describe("characterAppearanceAspect", () => {
  it.each([
    ["face.shape", "face"],
    ["skin.tone", "skin_tone"],
    ["skin.undertone", "skin_tone"],
    ["hair.color", "hair"],
    ["hair.length", "hair"],
    ["build.frame", "build"],
    ["build.weight_presentation", "build"],
  ] as const)("maps %s to the %s aspect", (attributeId, aspect) => {
    expect(characterAppearanceAspect(attributeId)).toBe(aspect);
  });

  /**
   * Eye colour, gender and apparent age are deliberately OUTSIDE the mapping
   * (docs/images/character-prompts.md §Identity on a reference-anchored
   * render): the Qwen edit 2511 dialect's identity lock never claims eye
   * colour, and the apparent-age anchor is a separate concept a lane's own
   * text-authoritative policy already owns, not a `subject.appearance` fact.
   * A category or id with no declared aspect must stay `undefined` rather
   * than defaulting to some aspect, or an unrelated attribute would silently
   * become a reference-authority candidate.
   */
  it.each(["eyes.color", "identity.gender", "identity.apparent_age", "voice.timbre"] as const)(
    "declares no aspect for %s",
    (attributeId) => {
      expect(characterAppearanceAspect(attributeId)).toBeUndefined();
    },
  );

  it("declares no aspect for an id the registry does not recognize", () => {
    expect(characterAppearanceAspect("not.a.real.attribute")).toBeUndefined();
  });
});

describe("IMAGE_CHARACTER_APPEARANCE_REFERENCE_REDUNDANT", () => {
  /**
   * The reason string is provenance a reader greps for; pinned so a rename
   * shows up as the diff it is rather than as a suppression report that
   * quietly stops matching a saved query.
   */
  it("carries the character.appearance namespace", () => {
    expect(IMAGE_CHARACTER_APPEARANCE_REFERENCE_REDUNDANT).toBe("character.appearance.reference_redundant");
  });
});
