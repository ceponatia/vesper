import { describe, expect, it } from "vitest";
import { expectAllValidate, expectRefsResolve, expectUniqueIds } from "@/test/registry-invariants";
import { attributeCategories } from "./category-ids";
import { attributeGroups } from "./categories";
import { materializeRegistryDefaults, registryDefaultSourceId } from "./index";
import { buildRegistry } from "./registry";
import {
  attributeDefinitionSchema,
  defineAttributeGroup,
  imageAppearanceMinimumFramings,
  imageAppearancePhraseGroupNoun,
  imageAppearancePhraseGroups,
  imageAppearancePhraseRoles,
  type AttributeDefinition,
} from "./types";
import { formatAttributePhrase, formatAttributeValue } from "./value";
import { bodyLocationRegistry, isIntimateAttributeCategory } from "../body/locations";

const registry = buildRegistry(attributeGroups);

describe("attribute registry invariants", () => {
  it("every definition validates against the definition schema", () => {
    expectAllValidate(registry.definitions, attributeDefinitionSchema);
  });

  it("all attribute ids are unique", () => {
    expectUniqueIds(registry.definitions, "attributeRegistry");
  });

  it("every enum/enum_list attribute has at least 2 allowed values", () => {
    for (const def of registry.definitions) {
      if (def.valueType === "enum" || def.valueType === "enum_list") {
        expect(def.allowedValues?.length ?? 0, def.id).toBeGreaterThanOrEqual(2);
      }
    }
  });

  it("every bodyLocationId references a known body location", () => {
    expectRefsResolve(
      registry.definitions,
      (def) => (def.bodyLocationId === undefined ? [] : [def.bodyLocationId]),
      (id) => bodyLocationRegistry.byId(id),
      (def, id) => `${def.id} → ${id}`,
    );
  });

  it("registers exactly one group per category, covering the full category list", () => {
    const registered = attributeGroups.map((g) => g.category);
    expect(new Set(registered).size).toBe(registered.length);
    expect([...registered].sort()).toEqual([...attributeCategories].sort());
    for (const category of attributeCategories) {
      expect(registry.forCategory(category).length, category).toBeGreaterThan(0);
    }
  });

  it("ids live in the group of their own category", () => {
    for (const group of attributeGroups) {
      for (const def of group.definitions) {
        expect(def.id.startsWith(`${group.category}.`), def.id).toBe(true);
        expect(def.category).toBe(group.category);
      }
    }
  });

  it("forBodyLocation returns attributes anchored at the location", () => {
    const atHair = registry.forBodyLocation("hair");
    expect(atHair.map((d) => d.id)).toContain("hair.color");
    expect(atHair.every((d) => d.bodyLocationId === "hair")).toBe(true);
  });

  it("narratorGuidance lives only on enum/enum_list attributes and keys only real members", () => {
    for (const def of registry.definitions) {
      if (!def.narratorGuidance) continue;
      expect(["enum", "enum_list"], def.id).toContain(def.valueType);
      for (const key of Object.keys(def.narratorGuidance)) {
        expect(def.allowedValues ?? [], `${def.id} → ${key}`).toContain(key);
      }
    }
  });

  // The orthogonality rule's cheap tripwire: a gloss
  // describes only its own attribute's dimension — height vocabulary outside the height
  // attributes reveals an entangled gloss. Extend the blocklist as authoring reveals leaks.
  it("orthogonality tripwire: no gloss outside height/apparent_age talks height", () => {
    for (const def of registry.definitions) {
      if (!def.narratorGuidance) continue;
      if (def.id === "build.height" || def.id === "identity.apparent_age") continue;
      for (const [key, gloss] of Object.entries(def.narratorGuidance)) {
        expect(/\b(tall|short|towering|height)\b/i.test(gloss), `${def.id}.${key}: "${gloss}"`).toBe(false);
      }
    }
  });

  it("defineAttributeGroup rejects narratorGuidance on non-enums and stray keys", () => {
    expect(() =>
      defineAttributeGroup("build", [
        {
          id: "build.bogus",
          label: "Bogus",
          kind: "physical",
          category: "build",
          valueType: "text",
          description: "Guidance on a non-enum.",
          mutability: "inherent",
          narratorGuidance: { anything: "a gloss" },
        },
      ]),
    ).toThrow(/not an enum/);
    expect(() =>
      defineAttributeGroup("build", [
        {
          id: "build.bogus",
          label: "Bogus",
          kind: "physical",
          category: "build",
          valueType: "enum",
          description: "Guidance key outside the vocabulary.",
          mutability: "inherent",
          allowedValues: ["a", "b"],
          narratorGuidance: { c: "a gloss" },
        },
      ]),
    ).toThrow(/not in allowedValues/);
  });

  it('defineAttributeGroup rejects renderNoneInPrompts when "none" is not in the vocabulary', () => {
    expect(() =>
      defineAttributeGroup("build", [
        {
          id: "build.bogus",
          label: "Bogus",
          kind: "physical",
          category: "build",
          valueType: "enum",
          description: "Flagged none-keeper with no none member.",
          mutability: "inherent",
          allowedValues: ["a", "b"],
          renderNoneInPrompts: true,
        },
      ]),
    ).toThrow(/"none" is not in allowedValues/);
  });

  it("buildRegistry rejects duplicate ids", () => {
    const dup = registry.definitions[0];
    expect(dup).toBeDefined();
    if (!dup) return;
    expect(() => buildRegistry([{ category: dup.category, definitions: [dup, dup] }])).toThrow(/Duplicate attribute id/);
  });

  it("buildRegistry rejects enums with fewer than 2 values", () => {
    const group = defineAttributeGroup("build", [
      {
        id: "build.bogus",
        label: "Bogus",
        kind: "physical",
        category: "build",
        valueType: "enum",
        description: "Degenerate enum.",
        mutability: "inherent",
        allowedValues: ["only_one"],
      },
    ]);
    expect(() => buildRegistry([group])).toThrow(/fewer than 2/);
  });
});

/**
 * The image render policy this registry carries as DATA — the two tables a
 * scene prompt is compiled from, asserted by derivation rather than by copying
 * the values out of the category files.
 *
 * Both censuses fail on an ADDITION, which is the point: the policy is a
 * per-attribute field any category edit can set, and neither of these rules is
 * visible from the file the edit lands in.
 */
describe("image render policy (#544)", () => {
  /**
   * `imageReveal: "shape"` means STATED THROUGH CLOTHING (`revealSurfaces`), so
   * on an intimate attribute it is a claim about a body a dressed picture does
   * not show. Breast SIZE is the one silhouette a sweater still carries, and it
   * is the same single exception `imageAppearance.ordinarySilhouette` names —
   * `defineAttributeGroup` enforces that pairing, and this census is the other
   * half: nothing else in an intimate category may take the through-clothing
   * tier. Shape, augmentation and fullness are `"skin"` (#544 F5): surface
   * facts, stated only when the torso reads bare or sheer.
   *
   * Non-intimate `"shape"` values (build.pregnancy, hips, waist, legs, buttocks)
   * are unaffected — they are ordinary silhouette and were never gated on
   * exposure.
   */
  it("states no intimate silhouette through clothing beyond breast size", () => {
    const throughClothing = registry.definitions
      .filter((def) => isIntimateAttributeCategory(def.category) && def.imageReveal === "shape")
      .map((def) => def.id);
    expect(throughClothing).toEqual(["breasts.size"]);

    const size = registry.byId("breasts.size");
    expect(size?.imageAppearance?.ordinarySilhouette).toBe(true);
    for (const id of ["breasts.shape", "breasts.augmentation", "breasts.fullness"]) {
      expect(registry.byId(id)?.imageReveal, id).toBe("skin");
      expect(registry.byId(id)?.imageAppearance?.ordinarySilhouette, id).toBeUndefined();
    }
  });

  /**
   * Fine facial detail may not be admitted by a waist-up or wider frame (#544
   * D7/F7). `maximumFraming` is the WIDEST band an `imageAppearance` fact still
   * contributes at — the adapter admits a fact when the shot's band sits
   * inclusively between `minimumFraming` and `maximumFraming`, and the band
   * order runs tight-to-wide. `portrait` is therefore the loosest any of these
   * four may be, and `close_up` is what it takes to leave a portrait too.
   * `minimumFraming` is the opposite knob — it is what keeps categorical height
   * out of a close-up — and raising it here would drop these facts from the
   * close shots that are the only ones which can show them.
   *
   * NOTE: this gate only runs when the digest carries a framing camera fact at
   * all; a lane that states none bypasses it entirely. That bypass is the
   * adapter's and the scene lowering's to close, not the registry's.
   */
  it("keeps fine facial detail out of a medium shot", () => {
    const widest = (id: string) => registry.byId(id)?.imageAppearance?.maximumFraming;
    expect(widest("teeth.condition")).toBe("close_up");
    expect(widest("brows.thickness")).toBe("close_up");
    expect(widest("ears.piercings")).toBe("portrait");
    expect(widest("skin.texture")).toBe("portrait");

    const waistUpAndWider = imageAppearanceMinimumFramings.slice(
      imageAppearanceMinimumFramings.indexOf("waist_up"),
    );
    for (const id of ["teeth.condition", "brows.thickness", "ears.piercings", "skin.texture"]) {
      const band = registry.byId(id)?.imageAppearance?.maximumFraming;
      expect(band, id).toBeDefined();
      expect(waistUpAndWider, id).not.toContain(band);
    }
  });
});

describe("materialized registry defaults (persisted-baseline)", () => {
  it("the flagged set is exactly the four foot structural fields — never feet.smell", () => {
    const flagged = registry.definitions.filter((def) => def.materializeDefault).map((def) => def.id);
    expect(flagged.sort()).toEqual(["feet.arch", "feet.nails", "feet.size", "feet.toes"]);
  });

  it("pins the exact default each materialized fact carries", () => {
    // The agreed baseline (owner correction, 2026-07-30): structural axes rest
    // at "average", and toenails at "trimmed" — ordinary nail length without
    // assuming additional grooming. Neon is backfilled from this map, so a
    // change here is a data migration, not a data edit.
    const defaults = Object.fromEntries(
      registry.definitions.filter((def) => def.materializeDefault).map((def) => [def.id, def.defaultValue]),
    );
    expect(defaults).toEqual({
      "feet.size": "average",
      "feet.arch": "average",
      "feet.nails": "trimmed",
      "feet.toes": "average",
    });
  });

  it("every flagged definition carries a defaultValue, and none is coreVisual", () => {
    for (const def of registry.definitions) {
      if (!def.materializeDefault) continue;
      expect(def.defaultValue, def.id).toBeDefined();
      expect(def.coreVisual ?? false, def.id).toBe(false);
    }
  });

  it("defineAttributeGroup rejects materializeDefault without a defaultValue", () => {
    expect(() =>
      defineAttributeGroup("build", [
        {
          id: "build.bogus",
          label: "Bogus",
          kind: "physical",
          category: "build",
          valueType: "enum",
          description: "A baseline with nothing to materialize.",
          mutability: "inherent",
          allowedValues: ["a", "b"],
          materializeDefault: true,
        },
      ]),
    ).toThrow(/no defaultValue/);
  });

  it("fills every missing flagged fact with the versioned creation provenance", () => {
    const filled = materializeRegistryDefaults([]);
    expect(filled.map((value) => value.id).sort()).toEqual(["feet.arch", "feet.nails", "feet.size", "feet.toes"]);
    for (const value of filled) {
      expect(value.source).toBe("creation");
      expect(value.sourceId).toBe(registryDefaultSourceId("feet"));
    }
    expect(registryDefaultSourceId("feet")).toBe("registry-default:feet:v1");
  });

  it("never overwrites a supplied value, whatever its source", () => {
    const authored = [{ id: "feet.arch" as const, value: "high", source: "manual" as const }];
    const filled = materializeRegistryDefaults(authored);
    expect(filled.filter((value) => value.id === "feet.arch")).toEqual(authored);
    expect(filled.map((value) => value.id).sort()).toEqual(["feet.arch", "feet.nails", "feet.size", "feet.toes"]);
  });

  it("is idempotent — a second pass adds nothing", () => {
    const once = materializeRegistryDefaults([]);
    expect(materializeRegistryDefaults(once)).toEqual(once);
  });

  it("respects the applicability gate", () => {
    const filled = materializeRegistryDefaults([], { isApplicable: (def) => def.id !== "feet.nails" });
    expect(filled.map((value) => value.id).sort()).toEqual(["feet.arch", "feet.size", "feet.toes"]);
  });

  it("prefers the rule default when narrowing rejects the registry default, and skips when both fail", () => {
    const narrowed = materializeRegistryDefaults([], {
      allowedValuesFor: (def) => (def.id === "feet.arch" ? ["flat", "low"] : def.allowedValues),
      ruleDefaultFor: (def) => (def.id === "feet.arch" ? "low" : undefined),
    });
    expect(narrowed.find((value) => value.id === "feet.arch")?.value).toBe("low");

    const impossible = materializeRegistryDefaults([], {
      allowedValuesFor: (def) => (def.id === "feet.arch" ? ["flat"] : def.allowedValues),
      ruleDefaultFor: () => undefined,
    });
    expect(impossible.some((value) => value.id === "feet.arch")).toBe(false);
    expect(impossible.map((value) => value.id).sort()).toEqual(["feet.nails", "feet.size", "feet.toes"]);
  });
});

describe("parseValue", () => {
  it("enum: accepts an allowed value, rejects anything else", () => {
    expect(registry.parseValue("hair.color", "auburn")).toEqual({ ok: true, value: "auburn" });
    expect(registry.parseValue("hair.color", "neon_green").ok).toBe(false);
    expect(registry.parseValue("hair.color", 4).ok).toBe(false);
  });

  it("enum_list: accepts a non-empty array of allowed values", () => {
    expect(registry.parseValue("skin.markings", ["tattoos", "scars"])).toEqual({
      ok: true,
      value: ["tattoos", "scars"],
    });
    expect(registry.parseValue("skin.markings", []).ok).toBe(false);
    expect(registry.parseValue("skin.markings", ["tattoos", "antlers"]).ok).toBe(false);
    expect(registry.parseValue("skin.markings", "tattoos").ok).toBe(false);
  });

  it("text: accepts 1–500 chars, rejects empty and oversized", () => {
    expect(registry.parseValue("hair.style", "loose braid over one shoulder")).toEqual({
      ok: true,
      value: "loose braid over one shoulder",
    });
    expect(registry.parseValue("hair.style", "").ok).toBe(false);
    expect(registry.parseValue("hair.style", "x".repeat(501)).ok).toBe(false);
  });

  // The starter vocabulary has no number/flag attributes yet; exercise those
  // parse paths through a synthetic registry so they stay covered.
  it("number: respects min/max bounds", () => {
    const synthetic = buildRegistry([
      defineAttributeGroup("build", [
        {
          id: "build.reach_cm",
          label: "Reach",
          kind: "physical",
          category: "build",
          valueType: "number",
          description: "Synthetic bounded number.",
          mutability: "inherent",
          min: 0,
          max: 100,
        },
        {
          id: "build.double_jointed",
          label: "Double-jointed",
          kind: "biological",
          category: "build",
          valueType: "flag",
          description: "Synthetic flag.",
          mutability: "inherent",
        },
      ]),
    ]);
    expect(synthetic.parseValue("build.reach_cm", 42)).toEqual({ ok: true, value: 42 });
    expect(synthetic.parseValue("build.reach_cm", -1).ok).toBe(false);
    expect(synthetic.parseValue("build.reach_cm", 101).ok).toBe(false);
    expect(synthetic.parseValue("build.reach_cm", "42").ok).toBe(false);
    expect(synthetic.parseValue("build.double_jointed", true)).toEqual({ ok: true, value: true });
    expect(synthetic.parseValue("build.double_jointed", "yes").ok).toBe(false);
  });

  it("unknown attribute id fails with an issue, not a throw", () => {
    const result = registry.parseValue("hair.glitter", "sparkly");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.issues[0]).toMatch(/unknown attribute id/);
  });
});

/**
 * The registry's image-appearance PHRASES (#547).
 *
 * An image-eligible attribute reaches a prompt either as prose ("dark-brown
 * hair") or as its self-describing label form ("Hair color: dark brown"), and
 * which one is a per-attribute registry decision. Two things can go wrong
 * silently, and neither shows up in any other suite:
 *
 * 1. A template that does not render — a typo'd `{valu}`, a per-value key that
 *    is not an allowed member, a fragment that renders empty — ships either a
 *    placeholder to an image provider or a fact that quietly falls back to the
 *    label form it was written to replace.
 * 2. A new image-eligible attribute nobody decided about inherits the label
 *    form by default, which is how "She has musculature: lightly toned" got
 *    into a scene prompt in the first place (#544).
 *
 * Both are derived from the registry rather than from a copied list, so adding
 * an attribute or an enum member fails here instead of in a render.
 */
describe("image appearance phrases", () => {
  const phrased = registry.definitions.filter((def) => def.imageAppearance?.phrase !== undefined);

  const definitionOf = (id: string): AttributeDefinition => {
    const def = registry.byId(id);
    if (def === undefined) throw new Error(`missing fixture attribute ${id}`);
    return def;
  };
  const textOf = (id: string, value: string): string | undefined =>
    formatAttributePhrase(definitionOf(id), value)?.text;

  it("declares phrases on a real share of the image-eligible set", () => {
    expect(phrased.length).toBeGreaterThan(20);
  });

  /** The vocabulary is `@vesper/image-core`'s; a group or role outside it has no grammar. */
  it("uses only the engine's group and role vocabulary", () => {
    for (const def of phrased) {
      const phrase = def.imageAppearance?.phrase;
      if (phrase === undefined) continue;
      expect([...imageAppearancePhraseGroups], def.id).toContain(phrase.group);
      expect([...imageAppearancePhraseRoles], def.id).toContain(phrase.role);
    }
  });

  /**
   * The build-stopping half: every value of every phrased attribute renders, or
   * is one of the two states that legitimately produce no phrase — an elided
   * value ("none"), or a member a partial `fragmentByValue` deliberately leaves
   * on the label form. Anything else is a template that does not work.
   */
  it("renders every allowed value with no placeholder and no empty fragment", () => {
    const unrendered: string[] = [];
    for (const def of phrased) {
      const phrase = def.imageAppearance?.phrase;
      if (phrase === undefined) continue;
      for (const value of def.allowedValues ?? []) {
        const rendered = formatAttributePhrase(def, value);
        if (rendered === null) {
          const elided = formatAttributeValue(def, value).length === 0;
          const noTemplate = phrase.fragment === undefined && phrase.fragmentByValue?.[value] === undefined;
          if (!elided && !noTemplate) unrendered.push(`${def.id}.${value}`);
          continue;
        }
        for (const part of [rendered.text, rendered.phrase.fragment]) {
          expect(part, `${def.id}.${value}`).not.toMatch(/\{(?:value|compound|fragment)\}/);
          expect(part.trim(), `${def.id}.${value}`).not.toBe("");
        }
        expect(rendered.phrase.group, `${def.id}.${value}`).toBe(phrase.group);
        expect(rendered.phrase.role, `${def.id}.${value}`).toBe(phrase.role);
      }
    }
    expect(unrendered).toEqual([]);
  });

  /**
   * The standalone form is what a non-composing dialect says on its own, so it
   * has to name the thing it is about: an adjective or trailer states its group
   * noun ("dark-brown hair", "hair to mid-back"), and a `with` phrase is already
   * a whole noun phrase.
   */
  it("names the group noun in every derived adjective and trailer standalone", () => {
    for (const def of phrased) {
      const phrase = def.imageAppearance?.phrase;
      if (phrase === undefined || phrase.standalone !== undefined) continue;
      const noun = imageAppearancePhraseGroupNoun(phrase.group);
      if (phrase.role === "with" || noun === null) continue;
      for (const value of def.allowedValues ?? []) {
        const rendered = formatAttributePhrase(def, value);
        if (rendered === null) continue;
        expect(rendered.text, `${def.id}.${value}`).toContain(noun);
        expect(rendered.text, `${def.id}.${value}`).toContain(rendered.phrase.fragment);
      }
    }
  });

  /**
   * The other direction, and the reason this is a census: an image-eligible
   * attribute with NO phrase keeps the label form, which is a deliberate choice
   * for a handful of attributes and a mistake for anything else. Free text
   * cannot be templated (`hair.style`, `identity.heritage`); the two scalp-hair
   * bulk axes share the words "fine" and "thick" and would read as each other's
   * dimension; and `identity.gender` is absorbed by the subject's pronoun where
   * one exists, so wording it is the pronoun policy's decision, not this one.
   */
  it("keeps the label form only for the reviewed set", () => {
    const unphrased = registry.definitions
      .filter((def) => def.imageAppearance !== undefined && def.imageAppearance.phrase === undefined)
      .map((def) => def.id)
      .sort();
    expect(unphrased).toEqual([
      "hair.density",
      "hair.strand_thickness",
      "hair.style",
      "identity.gender",
      "identity.heritage",
    ]);
  });

  /** The worked example the issue names, end to end through the registry. */
  it("words the #544 fixture's hair and build facts as prose", () => {
    const phraseOf = (id: string, value: string): { text: string; fragment: string } => {
      const rendered = formatAttributePhrase(definitionOf(id), value);
      if (rendered === null) throw new Error(`${id} words no phrase for ${value}`);
      return { text: rendered.text, fragment: rendered.phrase.fragment };
    };
    expect(phraseOf("hair.color", "dark_brown")).toEqual({ text: "dark-brown hair", fragment: "dark-brown" });
    expect(phraseOf("hair.length", "mid_back")).toEqual({ text: "hair to mid-back", fragment: "to mid-back" });
    expect(phraseOf("hair.condition", "healthy")).toEqual({ text: "healthy hair", fragment: "healthy" });
    expect(phraseOf("build.weight_presentation", "slim")).toEqual({ text: "a slim build", fragment: "slim" });
    expect(phraseOf("build.musculature", "lightly_toned")).toEqual({
      text: "a lightly toned build",
      fragment: "lightly toned",
    });
    expect(phraseOf("arms.build", "slender")).toEqual({ text: "slender arms", fragment: "slender arms" });
    expect(phraseOf("waist.definition", "subtle")).toEqual({ text: "a subtle waist", fragment: "a subtle waist" });
    expect(phraseOf("eyes.color", "hazel")).toEqual({ text: "hazel eyes", fragment: "hazel" });
  });

  /**
   * Two rules that only show up on a value the template did not anticipate: the
   * article agrees with the word it introduces, and a compound modifier
   * hyphenates where a running-words fragment would not.
   */
  it("agrees the article it writes and hyphenates a compound modifier", () => {
    expect(textOf("breasts.size", "ample")).toBe("an ample bust");
    expect(textOf("breasts.size", "modest")).toBe("a modest bust");
    expect(textOf("face.shape", "oval")).toBe("an oval face");
    expect(textOf("face.shape", "heart")).toBe("a heart-shaped face");
    expect(textOf("skin.tone", "light_olive")).toBe("light-olive skin");
  });

  /**
   * "none" elides before anything is worded, so a deliberate absence never
   * plants the noun it is absent of — the same rule `formatAttributeValue`
   * applies, reached through the phrase path.
   */
  it("words no phrase for an elided value", () => {
    expect(formatAttributePhrase(definitionOf("build.pregnancy"), "none")).toBeNull();
    expect(textOf("build.pregnancy", "showing")).toBe("a visibly pregnant belly");
  });

  /**
   * A member a partial map leaves out keeps the label form rather than being
   * forced through a template that does not word it: `hair.arrangement: other`
   * means "read the styling text", and there is no phrase for that.
   */
  it("leaves a member with no template on the label form", () => {
    expect(formatAttributePhrase(definitionOf("hair.arrangement"), "other")).toBeNull();
    expect(textOf("hair.arrangement", "bun")).toBe("hair in a bun");
  });
});

describe("resolveAlias", () => {
  it("resolves a free-text mention to its attribute", () => {
    expect(registry.resolveAlias("ginger").map((d) => d.id)).toEqual(["hair.color"]);
  });

  it("is case-insensitive", () => {
    expect(registry.resolveAlias("Ginger").map((d) => d.id)).toEqual(["hair.color"]);
    expect(registry.resolveAlias("FRECKLED").map((d) => d.id)).toEqual(["face.freckles"]);
  });

  it("returns an empty list for unknown text", () => {
    expect(registry.resolveAlias("dorsal fin")).toEqual([]);
  });

  it("fans out a shared alias to every attribute that claims it", () => {
    // Aliases are deliberately many-to-many: a generic mention ("feet") can
    // surface several candidate attributes. resolveAlias returns all of them.
    const shared = buildRegistry([
      defineAttributeGroup("feet", [
        { id: "feet.a", label: "A", kind: "physical", category: "feet", valueType: "text", description: "x", mutability: "inherent", aliases: ["paws"] },
        { id: "feet.b", label: "B", kind: "presentation", category: "feet", valueType: "text", description: "y", mutability: "mutable", aliases: ["paws"] },
      ]),
    ]);
    expect(shared.resolveAlias("paws").map((d) => d.id).sort()).toEqual(["feet.a", "feet.b"]);
  });
});
