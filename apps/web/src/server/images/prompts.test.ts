import { describe, expect, it } from "vitest";
import { DiagnosticCollector } from "@/contracts/diagnostics";
import { attributeRegistry, type AttributeDefinition, type AttributeValue } from "@/contracts/attributes";
import {
  FEATURE_ATTRIBUTE_CATEGORIES,
  INTIMATE_ATTRIBUTE_CATEGORIES,
  isBelowWaist,
  isFeatureAttributeCategory,
  isIntimateAttributeCategory,
} from "@/contracts/body/locations";
import type { CharacterProfile } from "@/contracts/world/profile";
import { viewerBodyPartById } from "@/contracts/images/viewer-body";
import {
  sceneCameraHeightIds,
  sceneCameraHeights,
  sceneShotDistanceIds,
  sceneShotDistances,
} from "@/contracts/images/scene-camera";
import { sceneStagings } from "@/contracts/images/scene-staging";
import { attr, makeProfile } from "@/server/test-support";
import {
  apparentAgeAnchor,
  characterAppearanceSummary,
  identityAnchorSummary,
  imageAgeWord,
  sceneRevealAppearance,
} from "./prompts-appearance";
import { buildAvatarPrompt, visibleAvatarOutfit } from "./prompts-avatar";
import {
  buildSceneComposerPrompt,
  emptySceneSpec,
  formatExposure,
  RECENT_NARRATION_LATEST_CHARS,
  RECENT_NARRATION_PRIOR_CHARS,
  RECENT_PLAYER_MESSAGE_CHARS,
  SCENE_COMPOSER_SYSTEM,
  type SceneComposerContext,
  sceneComposerSystem,
  sceneEvidenceCorpus,
  type ScenePresentCharacter,
  sceneSpecSchema,
  wardrobeOutfitSummary,
} from "./prompts-scene-composer";
import {
  bindLimbsToOwner,
  emptySceneRenderPlan,
  heuristicFocalName,
  resolveScenePlan,
  type SceneRenderPlan,
  scrubBlush,
  scrubPlayerFromAction,
} from "./prompts-scene-plan";
import {
  buildSceneRenderPrompt,
  EDIT_RENDER_PROMPT_LIMIT,
  SCENE_POV_RULE,
  sceneFramingRule,
  SELFIE_FRAMING,
} from "./prompts-scene-render";
import { buildVariantInstruction, PORTRAIT_IDENTITY_LOCK } from "./prompts-variant";

/**
 * A character-SHEET attribute: every fixture in this file is `source: "base"`,
 * because the image path reads the authored sheet, not a chat overlay. The id is
 * the contract's template type, so a typo is a compile error.
 */
const baseAttr = (id: AttributeValue["id"], value: AttributeValue["value"]): AttributeValue =>
  attr(id, value, "base");

describe("buildAvatarPrompt", () => {
  const profile = makeProfile({
    bio: "A wandering cartographer of the northern reaches.",
    personality: "Dry wit, endlessly curious.",
    attributes: [
      baseAttr("hair.color", "red"),
      baseAttr("hair.length", "shoulder_length"),
      baseAttr("identity.apparent_age", "mid_twenties"),
    ],
  });

  it("groups like-fields by category and humanizes values", () => {
    const prompt = buildAvatarPrompt("Mira", profile, "realistic");
    // Apparent age folds into the subject line (no gender/species → "person" noun).
    expect(prompt).toMatch(/Subject: Mira\b.*mid twenties.*person/);
    // Hair facets collapse into one grouped, label-free clause (scene-images A+B+C).
    expect(prompt).toMatch(/Hair:.*red.*shoulder length/);
  });

  it("excludes registry promptHints — the image prompt carries visual values only", () => {
    const prompt = buildAvatarPrompt("Mira", profile, "realistic");
    // promptHints are narrator/inference guidance; an image model reads a hint's
    // concrete example ("late thirties") as literal subject detail and anchors
    // every face to it. They flow to the narrator (engine/scene.ts), not here.
    expect(prompt).not.toContain("apparent age as an impression");
    // …but the resolved value still reaches the image (in the subject phrase).
    expect(prompt).toContain("mid twenties");
  });

  it("differs by style and never leaks unknown attribute ids", () => {
    const odd = makeProfile({
      attributes: [baseAttr("hair.nonexistent_attr", "x")],
    });
    const realistic = buildAvatarPrompt("Mira", odd, "realistic");
    const stylized = buildAvatarPrompt("Mira", odd, "stylized");
    expect(realistic).not.toBe(stylized);
    expect(realistic).toContain("Ultra-realistic");
    expect(stylized).toContain("stylized");
    expect(realistic).not.toContain("nonexistent_attr");
  });

  it("tolerates an empty profile", () => {
    const prompt = buildAvatarPrompt("", makeProfile(), "realistic");
    expect(prompt).toContain("an unnamed character");
    expect(prompt).not.toContain("Appearance:");
  });

  it("never includes intimate anatomy — bare or dressed, the portrait studio is intimate-free", () => {
    const p = makeProfile({
      intimateRegions: ["breasts"],
      attributes: [
        baseAttr("hair.color", "red"),
        baseAttr("breasts.size", "full"),
      ],
    });
    // Chest bare (no top): still withheld — intimate detail is scene-render-only.
    const bare = buildAvatarPrompt("Mira", p, "realistic", []);
    expect(bare).toContain("Hair: red");
    expect(bare).not.toContain("Bust:");
    // Covered chest: withheld as well, trivially.
    const dressed = buildAvatarPrompt("Mira", p, "realistic", [{ name: "Tank top", coverage: ["chest"] }]);
    expect(dressed).not.toContain("Bust:");
  });

  it("drops every below-waist attribute from the waist-up portrait", () => {
    // Mirrors Maya: pelvic + feet + leg anatomy must never reach a waist-up
    // portrait. Above-waist, non-intimate chest detail stays.
    const p = makeProfile({
      intimateRegions: ["vulva"],
      attributes: [
        baseAttr("hair.color", "red"),
        baseAttr("chest.size", "full"), // chest (general) — above waist, not intimate
        baseAttr("feet.size", "average"),
        baseAttr("legs.length", "proportionate"),
        baseAttr("hips.width", "rounded"),
        baseAttr("vulva.labia_minora", "protruding"), // pelvic intimate
      ],
    });
    const prompt = buildAvatarPrompt("Mira", p, "realistic", []);
    expect(prompt).toContain("Hair: red");
    expect(prompt).toContain("Chest: full"); // above the waist → kept (chest bucket)
    expect(prompt).not.toContain("Feet"); // feet bucket → below waist
    expect(prompt).not.toContain("Legs"); // legs bucket → below waist
    expect(prompt).not.toContain("Hips"); // hips bucket → below waist
    expect(prompt).not.toContain("Labia"); // pelvic intimate → below waist, never in a waist-up shot
  });

  it("filters feature attributes through the realized body", () => {
    const attrs: AttributeValue[] = [
      baseAttr("horns.shape", "swept_back"),
      baseAttr("wings.type", "membranous"),
      baseAttr("tail.type", "spaded"),
    ];
    const human = buildAvatarPrompt("Mira", makeProfile({ speciesId: "human", attributes: attrs }), "realistic");
    expect(human).not.toContain("Horns:");
    expect(human).not.toContain("Wings:");
    expect(human).not.toContain("Tail:");

    // Morphology leads the appearance section and each feature is one grouped clause.
    const succubus = buildAvatarPrompt("Mira", makeProfile({ speciesId: "succubus", attributes: attrs }), "realistic");
    expect(succubus).toContain("Horns: swept back");
    expect(succubus).toContain("Wings: membranous");
    expect(succubus).toContain("Tail: spaded");

    const winglessSuccubus = buildAvatarPrompt(
      "Mira",
      makeProfile({ speciesId: "succubus", bodyFeatures: ["horns"], attributes: attrs }),
      "realistic",
    );
    expect(winglessSuccubus).toContain("Horns:");
    expect(winglessSuccubus).not.toContain("Wings:");
    expect(winglessSuccubus).not.toContain("Tail:");
  });

  it("treats the default outfit as authoritative clothing when provided", () => {
    const prompt = buildAvatarPrompt("Mira", profile, "realistic", [
      { name: "Black abaya", coverage: ["chest", "back", "shoulders"], appearance: "flowing black fabric" },
      { name: "Hijab", coverage: ["hair", "neck"] },
    ]);
    expect(prompt).toContain("Wearing (authoritative — depict exactly this clothing): Black abaya (flowing black fabric); Hijab.");
  });

  it("prefers the garment description over its name and never truncates clothing detail", () => {
    const longAppearance = "deep crimson silk shot through with gold thread ".repeat(8).trim();
    const prompt = buildAvatarPrompt("Mira", profile, "realistic", [
      { name: "Coat", coverage: ["chest", "back"], description: "a heavy charcoal wool overcoat with a fur collar", appearance: longAppearance },
      { name: "Brooch", coverage: [] }, // no description — falls back to the name; no coverage (a prop) stays visible
    ]);
    expect(prompt).toContain(`a heavy charcoal wool overcoat with a fur collar (${longAppearance})`);
    expect(prompt).toContain("Brooch");
    expect(prompt).not.toContain("…"); // appearance is passed whole, not excerpted
  });

  it("omits the wearing line without an outfit", () => {
    expect(buildAvatarPrompt("Mira", profile, "realistic")).not.toContain("Wearing");
  });

  it("omits low-value waist-up attributes — including ALL teeth (scene-images D)", () => {
    const p = makeProfile({
      speciesId: "succubus",
      attributes: [
        baseAttr("hair.color", "black"),
        baseAttr("teeth.shape", "sharp_canines"), // "sharp canines" makes SDXL render a mess
        baseAttr("teeth.condition", "pristine"),
        baseAttr("build.height", "short"), // no height reference in a waist-up crop
        baseAttr("skin.undertone", "cool"),
        baseAttr("hands.nails", "manicured"),
        baseAttr("movement.gait", "graceful"), // motion — invisible in a still
      ],
    });
    const prompt = buildAvatarPrompt("Kianna", p, "realistic", []);
    expect(prompt).toContain("Hair: black"); // kept
    expect(prompt).not.toContain("Teeth");
    expect(prompt).not.toContain("canines");
    expect(prompt).not.toContain("Build:"); // height was the only build field
    expect(prompt).not.toContain("Skin:"); // undertone was the only skin field
    expect(prompt).not.toContain("Nails");
    expect(prompt).not.toContain("Bearing"); // gait/posture bucket
  });

  it("appends ethnicity (heritage) as a comma after the species in the subject phrase", () => {
    const succubus = buildAvatarPrompt(
      "Kianna",
      makeProfile({
        speciesId: "succubus",
        attributes: [
          baseAttr("identity.gender", "female"),
          baseAttr("identity.apparent_age", "young_adult"),
          baseAttr("identity.heritage", "Latina"),
        ],
      }),
      "realistic",
    );
    // Species noun present; ethnicity carried. Assert the pieces, not the exact clause.
    expect(succubus).toMatch(/Subject: Kianna\b.*young adult.*female.*succubus.*Latina/);
    // Human (no species noun): ethnicity follows gender.
    const human = buildAvatarPrompt(
      "Mira",
      makeProfile({
        attributes: [
          baseAttr("identity.gender", "female"),
          baseAttr("identity.apparent_age", "young_adult"),
          baseAttr("identity.heritage", "Igbo"),
        ],
      }),
      "realistic",
    );
    expect(human).toMatch(/Subject: Mira\b.*young adult.*female.*Igbo/);
    expect(human).not.toMatch(/succubus/i); // no species noun for a human
  });

  it("states chest hair only when the torso is bare, never under clothing", () => {
    const p = makeProfile({ attributes: [baseAttr("chest.hair", "dense")] });
    // Clothed (a top covering the chest) → hidden.
    const clothed = buildAvatarPrompt("Sayed", p, "realistic", [{ name: "Shirt", coverage: ["chest"] }]);
    expect(clothed).not.toContain("Chest");
    expect(clothed).not.toContain("dense");
    // Bare chest → stated.
    expect(buildAvatarPrompt("Sayed", p, "realistic", [])).toContain("Chest: dense");
  });

  it("drops non-visual (sensory) attributes — voice and scent never reach an image prompt", () => {
    const p = makeProfile({
      attributes: [
        baseAttr("hair.color", "red"),
        baseAttr("voice.pitch", "high"),
        baseAttr("voice.cadence", "melodic"),
        baseAttr("presentation.scent_baseline", "lavender and cedar"),
      ],
    });
    const prompt = buildAvatarPrompt("Mira", p, "realistic", []);
    expect(prompt).toContain("Hair: red");
    expect(prompt).not.toContain("Voice");
    expect(prompt).not.toContain("Cadence");
    expect(prompt).not.toContain("scent");
    expect(prompt).not.toContain("lavender");
  });

  it("names a non-human species by label only (no appearance description) in the subject phrase, omitted for human", () => {
    const succubus = buildAvatarPrompt("Mira", makeProfile({ speciesId: "succubus" }), "realistic");
    expect(succubus).toContain("Subject: Mira — a succubus.");
    expect(succubus).not.toContain("leathery bat-like wings"); // appearance description dropped — feature attributes carry it
    const human = buildAvatarPrompt("Mira", makeProfile({ speciesId: "human" }), "realistic");
    expect(human).toContain("Subject: Mira.");
    expect(human).not.toContain("succubus");
  });

  it("never includes the bio — image prompts carry visual fields only", () => {
    const prompt = buildAvatarPrompt("Mira", profile, "realistic");
    expect(prompt).not.toContain("About:");
    expect(prompt).not.toContain("wandering cartographer"); // from the fixture bio
  });
});

// Registry-wide guard so a NEW below-waist or intimate attribute category that
// forgets the gate fails here, not in production. Asserts the output property:
// a waist-up avatar's Appearance section never names below-waist anatomy, and
// never names intimate anatomy over a covered region (or with allowIntimate off). The
// trick: each profile carries exactly hair.color + the attribute under test, so
// "Appearance: Hair: red." (sole entry, anchored by BOTH the "Appearance: " prefix
// and the closing period) means the attribute under test was dropped; a leak adds
// another "; <Noun>: <value>" bucket — before or after hair — and breaks the match.
describe("buildAvatarPrompt field-gating invariants (whole attribute registry)", () => {
  const sampleValue = (def: AttributeDefinition): AttributeValue["value"] => {
    switch (def.valueType) {
      case "number":
        return def.min ?? 1;
      case "flag":
        return true;
      case "enum_list":
        return [def.allowedValues?.[0] ?? "sample"];
      case "enum":
      case "text":
        return def.allowedValues?.[0] ?? "sample";
    }
  };
  const profileFor = (id: string): CharacterProfile =>
    makeProfile({
      // Switch on every intimate region + feature group so the attribute under
      // test is applicable — then the ONLY thing that can drop it is the gate.
      intimateRegions: [...INTIMATE_ATTRIBUTE_CATEGORIES],
      bodyFeatures: [...FEATURE_ATTRIBUTE_CATEGORIES],
      attributes: [
        baseAttr("hair.color", "red"),
        baseAttr(id as AttributeValue["id"], sampleValue(attributeRegistry.byId(id) as AttributeDefinition)),
      ],
    });
  const fullSuit = {
    name: "Opaque bodysuit",
    coverage: ["chest", "back", "shoulders", "waist", "pelvis", "hips", "groin", "buttocks", "thighs", "calves", "ankles", "feet"],
    layer: 1,
    opacity: "opaque" as const,
  };

  const belowWaist = attributeRegistry.definitions.filter(
    (d) => d.bodyLocationId !== undefined && isBelowWaist(d.bodyLocationId) && !isFeatureAttributeCategory(d.category),
  );
  const aboveWaistIntimate = attributeRegistry.definitions.filter(
    (d) => isIntimateAttributeCategory(d.category) && !(d.bodyLocationId !== undefined && isBelowWaist(d.bodyLocationId)),
  );

  it.each(belowWaist.map((d) => d.id))("drops below-waist %s even bare (waist-up framing)", (id) => {
    // Bare is the most permissive wardrobe; gone here ⇒ the waist-up cut did it.
    expect(buildAvatarPrompt("X", profileFor(id), "realistic", [])).toContain("Appearance: Hair: red.");
  });

  it.each(aboveWaistIntimate.map((d) => d.id))("withholds intimate %s from the portrait unconditionally — covered or bare", (id) => {
    expect(buildAvatarPrompt("X", profileFor(id), "realistic", [fullSuit])).toContain("Appearance: Hair: red.");
    expect(buildAvatarPrompt("X", profileFor(id), "realistic", [])).toContain("Appearance: Hair: red.");
  });
});

describe("visibleAvatarOutfit", () => {
  const abayaCoverage = ["shoulders", "chest", "back", "waist", "upper_arms", "forearms", "wrists", "pelvis", "thighs", "calves", "ankles"];

  it("omits layers fully hidden under opaque outer layers (abaya over t-shirt and jeans)", () => {
    const outfit = visibleAvatarOutfit([
      { name: "Black abaya", coverage: abayaCoverage, layer: 3 },
      { name: "Hijab", coverage: ["hair", "neck"], layer: 2 },
      { name: "T-shirt", coverage: ["shoulders", "chest", "back", "waist", "upper_arms"], layer: 1 },
      { name: "Jeans", coverage: ["pelvis", "thighs", "calves", "ankles"], layer: 1 },
    ]);
    expect(outfit.map((o) => o.name)).toEqual(["Black abaya", "Hijab"]);
  });

  it("keeps partially visible lower layers", () => {
    const outfit = visibleAvatarOutfit([
      { name: "Apron", coverage: ["chest", "waist"], layer: 2 },
      { name: "Shirt", coverage: ["shoulders", "chest", "back", "waist", "upper_arms"], layer: 1 },
    ]);
    expect(outfit.map((o) => o.name)).toEqual(["Apron", "Shirt"]);
  });

  it("hints items only covered by sheer layers, without their appearance detail", () => {
    const outfit = visibleAvatarOutfit([
      { name: "Chiffon overdress", coverage: ["chest", "back", "waist"], layer: 2, opacity: "sheer" },
      { name: "Slip", coverage: ["chest", "back", "waist"], layer: 0, appearance: "ivory satin" },
    ]);
    expect(outfit[1]?.name).toBe("Slip (only a vague hint beneath sheer layers)");
    expect(outfit[1]?.appearance).toBeUndefined();
  });

  it("items with no coverage (jewelry, props) stay visible", () => {
    const outfit = visibleAvatarOutfit([
      { name: "Coat", coverage: ["chest", "back"], layer: 3 },
      { name: "Locket", coverage: [] },
    ]);
    expect(outfit.map((o) => o.name)).toContain("Locket");
  });

  it("omits garments worn entirely below the waist (waist-up framing) but keeps props", () => {
    const outfit = visibleAvatarOutfit([
      { name: "Blouse", coverage: ["shoulders", "chest"], layer: 1 },
      { name: "Jeans", coverage: ["pelvis", "thighs", "calves", "ankles"], layer: 1 },
      { name: "Sneakers", coverage: ["feet"], layer: 1 },
      { name: "Necklace", coverage: [] },
    ]);
    expect(outfit.map((o) => o.name)).toEqual(["Blouse", "Necklace"]);
  });

  it("keeps a full-length garment that also covers the torso", () => {
    const outfit = visibleAvatarOutfit([
      { name: "Evening gown", coverage: ["chest", "waist", "thighs", "calves", "ankles"], layer: 1 },
    ]);
    expect(outfit.map((o) => o.name)).toEqual(["Evening gown"]);
  });

  it("carries description and appearance through for visible garments", () => {
    const outfit = visibleAvatarOutfit([
      { name: "Coat", coverage: ["chest", "back"], layer: 3, description: "a wool overcoat", appearance: "storm-grey" },
    ]);
    expect(outfit[0]).toEqual({ name: "Coat", description: "a wool overcoat", appearance: "storm-grey" });
  });
});
