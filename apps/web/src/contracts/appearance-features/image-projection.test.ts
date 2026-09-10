import { describe, expect, it } from "vitest";
import { attributeRegistry, imageAppearanceMinimumFramings, type AttributeValue } from "../attributes";
import { realizeBody } from "../species/realize";
import { projectImageAppearanceAttributes } from "./image-projection";

function project(attributes: readonly AttributeValue[], intimateRegions: readonly string[] = []) {
  const body = realizeBody({ intimateRegions });
  return projectImageAppearanceAttributes({
    attributes,
    isAttributeApplicable: body.isAttributeApplicable,
  });
}

describe("image appearance attribute projection", () => {
  it("carries canonical source, fingerprint, readable value, and independent selection policy", () => {
    const projected = project([
      { id: "hair.color", value: "platinum", source: "manual", sourceId: "edit_1" },
      { id: "eyes.color", value: "blue", source: "creation" },
      { id: "build.musculature", value: "defined", source: "narrative" },
    ]);

    expect(projected.map((fact) => fact.readableValue)).toEqual([
      "Musculature: defined",
      "Eye color: blue",
      "Hair color: platinum",
    ]);
    const hair = projected.find((fact) => fact.attributeId === "hair.color");
    expect(hair).toMatchObject({
      sourceRef: { kind: "attribute", attributeId: "hair.color" },
      truthFingerprint: '"platinum"',
      class: "core",
      referenceFreeRequired: true,
      minimumFraming: "close_up",
    });
    const musculature = projected.find((fact) => fact.attributeId === "build.musculature");
    expect(musculature).toMatchObject({ class: "core", referenceFreeRequired: false });
  });

  /**
   * The prose form travels BESIDE the label form, not instead of it (#547): the
   * character adapter prefers the phrase and every consumer that is listing
   * facts rather than writing a sentence still has `readableValue`. The pieces
   * matter as much as the text — a dialect composes "healthy dark-brown hair
   * worn loose to mid-back" out of fragments, and a projection that shipped only
   * the finished noun phrase would have taken that apart again.
   */
  it("renders the registry's phrase beside the label form", () => {
    const projected = project([
      { id: "hair.color", value: "dark_brown", source: "manual" },
      { id: "waist.definition", value: "subtle", source: "manual" },
      { id: "identity.heritage", value: "Igbo", source: "manual" },
    ]);
    const phraseOf = (id: string) => projected.find((fact) => fact.attributeId === id);

    expect(phraseOf("hair.color")).toMatchObject({
      readableValue: "Hair color: dark brown",
      phraseValue: {
        text: "dark-brown hair",
        // The position travels with the pieces: a colour seats against its noun.
        phrase: { group: "hair", role: "adjective", fragment: "dark-brown", order: 1 },
      },
    });
    expect(phraseOf("waist.definition")).toMatchObject({
      readableValue: "Waist: subtle",
      phraseValue: { text: "a subtle waist", phrase: { group: "build", role: "with", fragment: "a subtle waist" } },
    });
    // Free text has no template to word it: the label form stays the answer.
    expect(phraseOf("identity.heritage")).toMatchObject({
      readableValue: "Heritage: Igbo",
      phraseValue: null,
    });
  });

  it("derives reference-free completeness from metadata rather than forge flags", () => {
    const required = attributeRegistry.definitions
      .filter((definition) => definition.imageAppearance?.referenceFreeRequired)
      .map((definition) => definition.id)
      .sort();

    expect(required).toEqual([
      "build.frame",
      "build.weight_presentation",
      "eyes.color",
      "face.shape",
      "hair.color",
      "hair.length",
      "identity.gender",
      "skin.tone",
    ]);
    expect(attributeRegistry.byId("hair.texture")?.imageAppearance?.class).toBe("core");
    expect(attributeRegistry.byId("hair.texture")?.imageAppearance?.referenceFreeRequired).not.toBe(true);
  });

  it("elides none, ordinary defaults, nonvisual fields, prompt exclusions, and unapproved attributes", () => {
    const projected = project([
      { id: "face.freckles", value: "none", source: "creation" },
      { id: "eyes.luminosity", value: "none", source: "creation" },
      { id: "eyes.pupil", value: "round", source: "creation" },
      { id: "presentation.scent_baseline", value: "cedar", source: "manual" },
      { id: "identity.natal_sex", value: "female", source: "manual" },
      { id: "movement.gait", value: "gliding", source: "manual" },
      { id: "hair.color", value: "brown", source: "creation" },
    ]);

    expect(projected.map((fact) => fact.attributeId)).toEqual(["hair.color"]);
  });

  it("uses realized-body applicability and permits only the approved ordinary bust silhouette", () => {
    const values: readonly AttributeValue[] = [
      { id: "chest.size", value: "broad", source: "manual" },
      { id: "breasts.size", value: "full", source: "manual" },
      { id: "breasts.shape", value: "round", source: "manual" },
    ];

    expect(project(values).map((fact) => fact.attributeId)).toEqual(["chest.size"]);
    const withBreasts = project(values, ["breasts"]);
    expect(withBreasts.map((fact) => fact.attributeId)).toEqual(["breasts.size"]);
    expect(withBreasts[0]).toMatchObject({
      bodyLocationId: "breasts",
      ordinarySilhouette: true,
      minimumFraming: "portrait",
    });

    const ordinarySilhouettes = attributeRegistry.definitions
      .filter((definition) => definition.imageAppearance?.ordinarySilhouette)
      .map((definition) => definition.id);
    expect(ordinarySilhouettes).toEqual(["breasts.size"]);
  });

  it("carries the framing hint for later visibility selection, including wide through full-figure eligibility", () => {
    const [height] = project([{ id: "build.height", value: "tall", source: "manual" }]);
    expect(height).toMatchObject({
      attributeId: "build.height",
      minimumFraming: "full_figure",
      maximumFraming: "wide",
      class: "reinforcement",
    });
    expect(imageAppearanceMinimumFramings).toEqual([
      "close_up",
      "portrait",
      "waist_up",
      "full_figure",
      "wide",
    ]);
  });

  it("carries the widest useful framing for close detail", () => {
    const [piercing] = project([{ id: "nose.piercings", value: "septum", source: "manual" }]);
    expect(piercing).toMatchObject({
      attributeId: "nose.piercings",
      minimumFraming: "close_up",
      maximumFraming: "close_up",
      class: "fine",
    });
  });
});
