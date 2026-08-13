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
import { attr, makeProfile } from "@/server/test-support";
import {
  apparentAgeAnchor,
  characterAppearanceSummary,
  identityAnchorSummary,
  imageAgeWord,
  intimateSceneAppearance,
  sceneRevealAppearance,
} from "./prompts-appearance";
import { buildAvatarPrompt, visibleAvatarOutfit } from "./prompts-avatar";
import { buildItemImagePrompt, buildLocationImagePrompt } from "./prompts-entity";
import {
  buildSceneComposerPrompt,
  emptySceneSpec,
  formatExposure,
  RECENT_NARRATION_LATEST_CHARS,
  RECENT_NARRATION_PRIOR_CHARS,
  SCENE_COMPOSER_SYSTEM,
  type SceneComposerContext,
  sceneComposerSystem,
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

describe("buildItemImagePrompt", () => {
  it("frames clothing on a ghost mannequin and objects isolated, with fields folded in", () => {
    const clothing = buildItemImagePrompt({
      name: "Black abaya",
      kind: "clothing",
      description: "flowing floor-length robe",
      appearance: "matte black crepe",
    });
    expect(clothing).toContain("Black abaya");
    expect(clothing).toContain("ghost mannequin");
    expect(clothing).toContain("flowing floor-length robe");
    expect(clothing).toContain("matte black crepe");
    expect(clothing).toContain("no people, no text, no watermark");

    const object = buildItemImagePrompt({ name: "Brass compass", kind: "object" });
    expect(object).toContain("clean seamless surface");
    expect(object).not.toContain("ghost mannequin");
  });

  it("tolerates a nameless item and unknown kind", () => {
    const prompt = buildItemImagePrompt({ name: "" });
    expect(prompt).toContain("an object");
    expect(prompt).toContain("seamless surface"); // defaults to the object framing
  });
});

describe("buildLocationImagePrompt", () => {
  it("uses a landscape for open/expanse scales and an interior otherwise", () => {
    const outdoor = buildLocationImagePrompt({ name: "Tidal Flats", scale: "expanse", description: "salt marsh" });
    expect(outdoor).toContain("landscape photograph");
    expect(outdoor).not.toContain("interior");

    const indoor = buildLocationImagePrompt({ name: "The Study", scale: "room", description: "book-lined" });
    expect(indoor).toContain("interior");
    expect(indoor).not.toContain("landscape photograph");
  });

  it("includes the description and ambient light, and never people", () => {
    const prompt = buildLocationImagePrompt({
      name: "Lantern Hall",
      scale: "hall",
      description: "vaulted timber ceiling",
      light: "warm lantern glow",
    });
    expect(prompt).toContain("vaulted timber ceiling");
    expect(prompt).toContain("warm lantern glow");
    expect(prompt).toContain("no people");
  });
});

describe("buildVariantInstruction", () => {
  it("prefixes the identity lock and embeds the instruction", () => {
    const prompt = buildVariantInstruction("pose", "leaning against a railing");
    expect(prompt.startsWith(PORTRAIT_IDENTITY_LOCK)).toBe(true);
    expect(prompt).toContain("Change the pose: leaning against a railing");
    expect(prompt).toContain("Keep the same outfit");
  });

  it("drops the outfit-keep clause for outfit variants", () => {
    const prompt = buildVariantInstruction("outfit", "a winter coat");
    expect(prompt).toContain("Change the outfit: a winter coat.");
    expect(prompt).not.toContain("Keep the same outfit");
  });
});

describe("sceneSpecSchema", () => {
  it("parses an empty object into degraded defaults and never asks for an outfit", () => {
    const spec = sceneSpecSchema.parse({});
    expect(spec).toEqual(emptySceneSpec());
    expect(spec.lighting).toBe("soft natural light");
    expect(spec.focalCharacter).toBe("");
    expect(spec.others).toEqual([]);
    expect("outfitSummary" in spec).toBe(false); // outfit truth never comes from the model
  });
});

const mira: ScenePresentCharacter = {
  name: "Mira",
  activity: "reading",
  posture: "curled in an armchair",
  wornVisible: [
    { name: "linen shirt", visibility: "visible" },
    { name: "silk camisole", visibility: "hinted" },
  ],
  appearance: "Hair color: red",
};

const sayed: ScenePresentCharacter = {
  name: "Sayed",
  activity: "shelving books",
  wornVisible: [{ name: "wool coat", visibility: "visible" }],
  appearance: "Hair color: black",
};

const libraryContext: SceneComposerContext = {
  present: [mira, sayed],
  locationName: "The Drowned Library",
  timeOfDay: "dusk",
  recentNarration: ["Sayed climbed the ladder.", "Mira turned the page slowly."],
};

describe("buildSceneComposerPrompt", () => {
  it("lists every co-located NPC with their authoritative visible wardrobe", () => {
    const prompt = buildSceneComposerPrompt(libraryContext);
    expect(prompt).toContain("Present characters (the only people allowed in the image):");
    // Load-bearing: each NPC's line carries their data + the authoritative-wardrobe
    // marker. Exact field formatting (activity:/posture:/separators) is incidental.
    expect(prompt).toContain("- Mira");
    expect(prompt).toContain("reading");
    expect(prompt).toContain("curled in an armchair");
    expect(prompt).toContain("visible wardrobe (authoritative):");
    expect(prompt).toContain("linen shirt");
    expect(prompt).toContain("silk camisole");
    expect(prompt).toContain("- Sayed");
    expect(prompt).toContain("shelving books");
    expect(prompt).toContain("wool coat");
    expect(prompt).toContain("Location: The Drowned Library");
    expect(prompt).toContain("Time of day: dusk");
    expect(SCENE_COMPOSER_SYSTEM).toContain("never infer clothing from the narration");
  });

  it("states the player POV rule in the prompt and the system prompt", () => {
    const prompt = buildSceneComposerPrompt(libraryContext);
    expect(prompt).toContain("first-person, through the player's eyes");
    expect(prompt).toContain("The player is never visible");
    expect(SCENE_COMPOSER_SYSTEM).toContain("first-person POV");
    expect(SCENE_COMPOSER_SYSTEM).toContain("The player must NEVER appear");
    expect(SCENE_COMPOSER_SYSTEM).toContain("characters who are not in the room must not appear");
  });

  it("teaches the solo-pose translation and the pose/activity redundancy rule (owner report 2026-07-10)", () => {
    // Player-anchored beats must be translated, not just the player left undescribed.
    expect(SCENE_COMPOSER_SYSTEM).toContain("must describe that character ALONE");
    expect(SCENE_COMPOSER_SYSTEM).toContain('become "toward the viewer"');
    expect(SCENE_COMPOSER_SYSTEM).toContain("keep the expression and energy, lose the contact");
    // The worked example (the reported gallery beat) shows the translation shape.
    expect(SCENE_COMPOSER_SYSTEM).toContain('pose "glancing back toward the viewer, mid-laugh"');
    // Pose and activity carry distinct beats — no smile in one and laugh in the other.
    expect(SCENE_COMPOSER_SYSTEM).toContain("must not repeat each other's beats");
  });

  it("includes the recent narration, newest excerpted larger, capped at two turns", () => {
    const prompt = buildSceneComposerPrompt({
      ...libraryContext,
      recentNarration: ["ancient turn", "x".repeat(2000), "y".repeat(2000)],
    });
    expect(prompt).toContain("Recent narration (oldest first):");
    expect(prompt).not.toContain("ancient turn"); // only the last 2 turns
    const xRun = prompt.match(/x{10,}/)?.[0] ?? "";
    const yRun = prompt.match(/y{10,}/)?.[0] ?? "";
    expect(xRun.length).toBeLessThanOrEqual(RECENT_NARRATION_PRIOR_CHARS);
    expect(yRun.length).toBeLessThanOrEqual(RECENT_NARRATION_LATEST_CHARS);
    expect(yRun.length).toBeGreaterThan(xRun.length);
  });

  it("declares an empty room a location-only shot and an empty wardrobe explicitly", () => {
    const empty = buildSceneComposerPrompt({ present: [], locationName: "Atrium" });
    expect(empty).toContain("Present characters: none — compose a location-only shot.");
    const bare = buildSceneComposerPrompt({ present: [{ name: "Mira", wornVisible: [] }] });
    expect(bare).toContain("visible wardrobe (authoritative): none recorded");
  });

  it("renders garment description and appearance for visible wardrobe, name-only for hints", () => {
    const prompt = buildSceneComposerPrompt({
      present: [
        {
          name: "Mira",
          wornVisible: [
            { name: "linen shirt", description: "a pale linen shirt", appearance: "rumpled", visibility: "visible" },
            { name: "silk camisole", description: "an ivory silk camisole", visibility: "hinted" },
          ],
        },
      ],
    });
    // Visible garments carry description + appearance; hinted ones fold to a name + marker.
    expect(prompt).toContain("visible wardrobe (authoritative):");
    expect(prompt).toContain("a pale linen shirt (rumpled)");
    expect(prompt).toContain("silk camisole");
    expect(prompt).toContain("hinted");
  });

  it("lists a non-human NPC's species phrase first in their line", () => {
    const prompt = buildSceneComposerPrompt({
      present: [{ name: "Lilith", species: "Succubus", activity: "pouring a drink", wornVisible: [] }],
    });
    // Species phrase precedes the activity on the line; assert order without pinning separators.
    expect(prompt).toMatch(/- Lilith\b.*Succubus.*pouring a drink/);
  });
});

describe("wardrobeOutfitSummary", () => {
  it("joins visible items and folds hinted layers", () => {
    expect(
      wardrobeOutfitSummary([
        { name: "linen shirt", visibility: "visible" },
        { name: "wool skirt", visibility: "visible" },
        { name: "silk camisole", visibility: "hinted" },
      ]),
    ).toBe("linen shirt, wool skirt; hints of silk camisole beneath");
    expect(wardrobeOutfitSummary([])).toBe("");
  });

  it("uses description and appearance for visible garments, name-only for hints", () => {
    expect(
      wardrobeOutfitSummary([
        { name: "shirt", description: "a pale linen shirt", appearance: "rumpled", visibility: "visible" },
        { name: "camisole", description: "an ivory silk camisole", visibility: "hinted" },
      ]),
    ).toBe("a pale linen shirt (rumpled); hints of camisole beneath");
  });
});

describe("characterAppearanceSummary", () => {
  it("formats registry labels, skips unknown ids, and caps length", () => {
    const summary = characterAppearanceSummary([
      baseAttr("hair.color", "red"),
      baseAttr("hair.nonexistent_attr", "x"),
    ]);
    expect(summary).toContain("Hair color: red");
    expect(summary).not.toContain("nonexistent_attr");
    const long = characterAppearanceSummary(
      [
        baseAttr("hair.color", "red"),
        baseAttr("hair.length", "shoulder_length"),
      ],
      12,
    );
    expect(long.length).toBeLessThanOrEqual(12);
  });

  it("can filter feature attributes when profile context is supplied", () => {
    const attrs: AttributeValue[] = [baseAttr("wings.type", "membranous")];
    expect(characterAppearanceSummary(attrs, undefined, false, makeProfile({ speciesId: "human" }))).toBe("");
    expect(characterAppearanceSummary(attrs, undefined, false, makeProfile({ speciesId: "succubus" }))).toContain(
      "Wing type: membranous",
    );
  });

  it("omits apparent age — scene images lean on the avatar reference for how old a character looks", () => {
    const summary = characterAppearanceSummary([
      baseAttr("identity.apparent_age", "late_thirties"),
      baseAttr("hair.color", "red"),
    ]);
    expect(summary).toContain("Hair color: red");
    expect(summary).not.toContain("late thirties");
    expect(summary).not.toContain("Apparent age");
  });

  it("never leaks an excludeFromPrompts attribute (identity.natal_sex) — gender still renders", () => {
    const attrs: AttributeValue[] = [
      baseAttr("identity.gender", "androgynous_born_female"),
      baseAttr("identity.natal_sex", "female"),
      baseAttr("hair.color", "red"),
    ];
    const summary = characterAppearanceSummary(attrs);
    expect(summary).toContain("androgynous born female"); // the gender variant does steer rendering
    expect(summary).not.toContain("Natal sex");
    // The avatar prompt (subject phrase) also carries gender but never natal sex.
    const avatar = buildAvatarPrompt("Mira", makeProfile({ attributes: attrs }), "realistic");
    expect(avatar).toMatch(/Subject: Mira\b.*androgynous born female/);
    expect(avatar).not.toContain("Natal sex");
  });
});

describe('prompt-side "none" elision (renderNoneInPrompts)', () => {
  it('drops a "none" attribute from the avatar prompt — stating it plants the noun the model then paints', () => {
    const p = makeProfile({
      attributes: [
        baseAttr("nose.piercings", "none"),
        baseAttr("face.freckles", "none"),
        baseAttr("hair.color", "red"),
      ],
    });
    const prompt = buildAvatarPrompt("Mira", p, "realistic");
    expect(prompt).toContain("Hair: red");
    // The whole bucket vanishes — no "Nose: none" / "Face: none" clause survives.
    expect(prompt).not.toContain("Nose:");
    expect(prompt).not.toContain("Face:");
    expect(prompt).not.toMatch(/\bnone\b/);
  });

  it('drops "none" from the scene appearance summary but keeps real values', () => {
    const summary = characterAppearanceSummary([
      baseAttr("ears.piercings", "none"),
      baseAttr("eyes.luminosity", "none"),
      baseAttr("hair.color", "red"),
    ]);
    expect(summary).toBe("Hair color: red");
  });

  it('keeps a flagged none — bare pubic hair is itself the look (renderNoneInPrompts)', () => {
    const exposed = intimateSceneAppearance(
      [baseAttr("vulva.pubic_hair_density", "none")],
      { torso: "covered", pelvis: "bare", legs: "bare", feet: "bare" },
    );
    expect(exposed).toContain("Pubic hair density: none");
  });
});

describe("intimateSceneAppearance (exposure-gated)", () => {
  const attrs: AttributeValue[] = [
    baseAttr("penis.size", "average"),
    baseAttr("breasts.size", "full"),
    baseAttr("vulva.scent", "musky"), // sensory — never visual
  ];
  it("includes intimate detail only for an exposed region, skipping covered regions and sensory", () => {
    const exposed = intimateSceneAppearance(attrs, { torso: "covered", pelvis: "bare", legs: "bare", feet: "bare" });
    expect(exposed).toContain("Penis size: average"); // pelvis bare → shown
    expect(exposed).not.toContain("Breast size"); // torso covered → hidden
    expect(exposed).not.toContain("scent"); // sensory never renders
  });
  it("returns nothing when everything is covered or exposure is unknown", () => {
    expect(intimateSceneAppearance(attrs, { torso: "covered", pelvis: "covered", legs: "covered", feet: "covered" })).toBe("");
    expect(intimateSceneAppearance(attrs, undefined)).toBe("");
  });
});

describe("sceneRevealAppearance (shape reads through clothing; skin needs exposure)", () => {
  const attrs: AttributeValue[] = [
    baseAttr("breasts.size", "full"), // shape
    baseAttr("breasts.shape", "round"), // shape
    baseAttr("breasts.nipples", "large"), // skin (torso)
    baseAttr("vulva.labia_minora", "protruding"), // untagged intimate → exposure-only
    baseAttr("waist.definition", "defined"), // shape
    baseAttr("hips.width", "wide"), // shape
    baseAttr("legs.build", "toned"), // shape
    baseAttr("legs.length", "long"), // shape
    baseAttr("legs.hair", "fine"), // skin (legs)
    baseAttr("feet.size", "average"), // shape
    baseAttr("feet.arch", "high"), // skin (feet)
  ];
  const profile = makeProfile({ intimateRegions: ["breasts", "vulva"] });

  it("SFW lower-body line: shape always; skin only when the region is bare; never intimate", () => {
    const dressed = sceneRevealAppearance(
      attrs,
      { torso: "covered", pelvis: "covered", legs: "covered", feet: "covered" },
      profile,
      { intimate: false },
    );
    expect(dressed).toContain("Waist: defined");
    expect(dressed).toContain("Hips: wide");
    expect(dressed).toContain("Leg build: toned");
    expect(dressed).toContain("Leg length: long");
    expect(dressed).toContain("Foot size: average");
    expect(dressed).not.toContain("Leg hair"); // legs covered → skin hidden
    expect(dressed).not.toContain("Foot arch"); // feet covered → skin hidden
    expect(dressed).not.toContain("Breast"); // intimate is excluded from the SFW half

    const exposed = sceneRevealAppearance(
      attrs,
      { torso: "bare", pelvis: "bare", legs: "bare", feet: "bare" },
      profile,
      { intimate: false },
    );
    expect(exposed).toContain("Leg hair: fine"); // legs bare → shown
    expect(exposed).toContain("Foot arch: high"); // feet bare → shown
  });

  it("intimate line: breast size/shape read through clothing; nipples + untagged anatomy need exposure", () => {
    const covered = { torso: "covered", pelvis: "covered", legs: "covered", feet: "covered" } as const;
    const dressed = sceneRevealAppearance(attrs, covered, profile, { intimate: true });
    expect(dressed).toContain("Breast size: full"); // shape → always
    expect(dressed).toContain("Breast shape: round"); // shape → always
    expect(dressed).not.toContain("Nipples"); // skin → torso covered
    expect(dressed).not.toContain("Labia"); // untagged intimate → pelvis covered

    const topless = sceneRevealAppearance(attrs, { ...covered, torso: "bare" }, profile, { intimate: true });
    expect(topless).toContain("Nipples: large"); // torso bare → shown

    const bareBelow = sceneRevealAppearance(attrs, { ...covered, pelvis: "bare" }, profile, { intimate: true });
    expect(bareBelow).toContain("Labia minora: protruding"); // untagged intimate falls back to the exposure gate
  });

  it("returns nothing without exposure state", () => {
    expect(sceneRevealAppearance(attrs, undefined, profile, { intimate: false })).toBe("");
  });
});

describe("excludeFromPrompts holds on the scene-appearance builders", () => {
  // Written registry-first rather than against a single fixture id. Today the only
  // definition carrying the flag is `identity.natal_sex`, whose `identity` category can
  // reach neither the intimate loop nor the lower-body loop — so for those two this
  // passes without exercising the guard. That is the point: the day an intimate or
  // lower-body attribute is marked `excludeFromPrompts`, this fails instead of silently
  // shipping it to an image model.
  const excluded = attributeRegistry.definitions.filter((def) => def.excludeFromPrompts);
  const bare = { torso: "bare", pelvis: "bare", legs: "bare", feet: "bare" } as const;
  const probe = (def: AttributeDefinition): AttributeValue =>
    attr(def.id, def.allowedValues?.[0] ?? "probe", "base");

  it("has at least one flagged definition, so the sweep below is not empty", () => {
    expect(excluded.map((def) => def.id)).toContain("identity.natal_sex");
  });

  it("keeps every flagged definition out of both scene-appearance lines", () => {
    const profile = makeProfile({ intimateRegions: ["breasts", "vulva", "penis", "testicles"] });
    for (const def of excluded) {
      const attrs = [probe(def)];
      expect(intimateSceneAppearance(attrs, bare)).not.toContain(def.label);
      expect(sceneRevealAppearance(attrs, bare, profile, { intimate: true })).not.toContain(def.label);
      expect(sceneRevealAppearance(attrs, bare, profile, { intimate: false })).not.toContain(def.label);
    }
  });
});

describe("buildSceneRenderPrompt — subject body line (the waist-up portrait's blind spot)", () => {
  const plan = {
    ...emptySceneRenderPlan(),
    focal: {
      name: "Mira",
      action: "standing by the bar",
      outfitSummary: "red dress",
      appearance: "Hair color: red",
      lowerBody: "Waist: defined; Hips: wide; Leg build: toned",
      intimateAppearance: "Breast size: full",
    },
  };
  it("emits the Body line for the identity-locked reference subject", () => {
    const qwen = buildSceneRenderPrompt(plan, { referenceName: "Mira", allowIntimate: true });
    // Keep the load-bearing "below the portrait's framing" marker; the attribute
    // list order/separators are incidental.
    expect(qwen).toContain("Body (below the portrait's framing):");
    expect(qwen).toMatch(/Waist: defined/);
    expect(qwen).toMatch(/Hips: wide/);
    expect(qwen).toMatch(/Leg build: toned/);
  });
  it("omits the Body line when the subject is described textually (no reference image)", () => {
    expect(buildSceneRenderPrompt(plan)).not.toContain("Body (below the portrait's framing)");
  });
});

describe("identityAnchorSummary + render emission (chat-scene-fidelity slice 3)", () => {
  it("picks only whitelisted identity-critical attributes, and returns '' when none are authored", () => {
    const summary = identityAnchorSummary([
      baseAttr("skin.tone", "warm brown"),
      baseAttr("lips.fullness", "full"),
      baseAttr("eyes.color", "hazel"),
      baseAttr("build.height", 170), // not identity-critical — excluded
      baseAttr("presentation.grooming", "polished"), // not identity-critical — excluded
    ]);
    expect(summary).toContain("warm brown");
    expect(summary).toContain("full");
    expect(summary).toContain("hazel");
    expect(summary).not.toContain("170");
    expect(summary).not.toContain("polished");
    expect(identityAnchorSummary([baseAttr("build.height", 170)])).toBe("");
    expect(identityAnchorSummary([])).toBe("");
  });

  it("emits the reinforcement line for the identity-locked reference only, worded reference-authoritative", () => {
    const plan = {
      ...emptySceneRenderPlan(),
      focal: {
        name: "Mira",
        action: "standing by the bar",
        outfitSummary: "red dress",
        appearance: "Hair color: red",
        identityAnchors: "skin tone: warm brown; lips fullness: full",
      },
    };
    const anchored = buildSceneRenderPrompt(plan, { referenceName: "Mira" });
    expect(anchored).toContain("Same person as the reference image");
    expect(anchored).toContain("the reference is authoritative where they differ");
    expect(anchored).toContain("skin tone: warm brown; lips fullness: full");
    // No reference image ⇒ the subject is textual and already carries full appearance —
    // the reinforcement line must not appear.
    expect(buildSceneRenderPrompt(plan)).not.toContain("Same person as the reference image");
  });
});

describe("buildSceneRenderPrompt — intimate detail is route-gated", () => {
  const plan = {
    ...emptySceneRenderPlan(),
    focal: {
      name: "Mira",
      action: "reclining",
      outfitSummary: "",
      appearance: "Hair color: red",
      exposure: "fully nude, no clothing",
      intimateAppearance: "Breast size: full",
    },
  };
  it("emits intimate detail only on the uncensored (allowIntimate) route", () => {
    const textToImage = buildSceneRenderPrompt(plan); // text-to-image, no allowIntimate
    expect(textToImage).not.toContain("Breast size: full");
    const uncensored = buildSceneRenderPrompt(plan, { referenceName: "Mira", allowIntimate: true });
    expect(uncensored).toContain("Breast size: full");
  });
});

describe("buildSceneRenderPrompt — multi-reference", () => {
  const plan = {
    ...emptySceneRenderPlan(),
    focal: { name: "Mira", action: "leaning close", outfitSummary: "red dress", appearance: "Hair color: red" },
    others: [
      { name: "Sayed", action: "beside her", outfitSummary: "wool coat", appearance: "Hair color: black" },
      { name: "Wren", action: "in the doorway", outfitSummary: "apron", appearance: "Hair color: brown" },
    ],
    setting: "a rain-streaked library",
  };

  it("identity-locks every referenced person, enumerates the references, and stays under the render limit", () => {
    const prompt = buildSceneRenderPrompt(plan, {
      multiReferences: [
        { name: "Mira", kind: "character" },
        { name: "Sayed", kind: "character" },
        { name: "The Library", kind: "location" },
      ],
    });
    expect(prompt.startsWith(PORTRAIT_IDENTITY_LOCK)).toBe(true);
    expect(prompt).toContain(SCENE_POV_RULE);
    expect(prompt).toContain("3 reference images provided");
    expect(prompt).toContain("one shared scene");
    expect(prompt).toContain("The Library");
    // name → action → outfit on each person's line; assert order, not separators.
    expect(prompt).toMatch(/Mira\b.*leaning close.*red dress/);
    expect(prompt).toMatch(/Sayed\b.*beside her.*wool coat/);
    expect(prompt.length).toBeLessThanOrEqual(EDIT_RENDER_PROMPT_LIMIT);
  });

  it("describes a character with no reference image (beyond the 3-ref cap) from text instead", () => {
    // Only Mira + Sayed + the location fit; Wren has no reference image.
    const prompt = buildSceneRenderPrompt(plan, {
      multiReferences: [
        { name: "Mira", kind: "character" },
        { name: "Sayed", kind: "character" },
        { name: "The Library", kind: "location" },
      ],
    });
    // Over-cap character falls back to a text description; keep the marker + data.
    expect(prompt).toMatch(/Wren\b.*no reference image.*Hair color: brown/);
  });

  // Stage 7 promotion (qwen-advanced-image-subsystem.spec.md): the count assertion
  // says how many people and names them; the cast clause says what must not happen
  // to them. Two faces in one edit can be merged, swapped or duplicated, and no
  // per-slot binding prevents that — each of those is a statement about ONE image
  // while the failure is about the set.
  it("forbids merging, swapping and duplicating once two characters are referenced", () => {
    const prompt = buildSceneRenderPrompt(plan, {
      multiReferences: [
        { name: "Mira", kind: "character" },
        { name: "Sayed", kind: "character" },
      ],
    });
    expect(prompt).toContain("never merge, swap, or duplicate them");
    expect(prompt).toContain("Render each person exactly once");
  });

  it("omits the cast clause when only one character is referenced (nothing to swap)", () => {
    const prompt = buildSceneRenderPrompt(plan, {
      multiReferences: [
        { name: "Mira", kind: "character" },
        { name: "The Library", kind: "location" },
      ],
    });
    expect(prompt).not.toContain("never merge, swap, or duplicate them");
  });

  // The possession binding used to degrade to "belongs to one of them" past one
  // subject, which keeps the abstraction but drops the binding — and the binding is
  // the half the phantom-limb A/B proved was doing the work.
  it("names every subject in the possession binding rather than saying 'one of them'", () => {
    const prompt = buildSceneRenderPrompt(plan, {
      multiReferences: [
        { name: "Mira", kind: "character" },
        { name: "Sayed", kind: "character" },
      ],
    });
    expect(prompt).not.toContain("one of them");
    expect(prompt).toContain("Every visible body part belongs to Mira, Sayed or Wren.");
  });

  // The budgeter's only knobs were outfit and setting text, but the fields that
  // grow with CAST SIZE — identity anchors, the figure line, an unanchored
  // character's appearance — were uncapped, so a crowded prompt could not be
  // shrunk and `clampToLimit` cut the tail instead. These are state-derived and
  // genuinely long (untruncated garment and attribute text), so two characters
  // is enough to reach it.
  const longAnchors = `dark brown hair in loose waves past the shoulders; brown almond eyes; ${"thick straight brows and a soft oval face with a broad rounded jaw; ".repeat(6)}`;
  const crowded: SceneRenderPlan = {
    ...emptySceneRenderPlan(),
    focal: {
      name: "Mira",
      action: "leaning on the rail",
      outfitSummary: `red dress ${"of heavy raw silk with a hand-rolled hem; ".repeat(8)}`,
      appearance: "",
      identityAnchors: longAnchors,
      lowerBody: "long-limbed",
      exposure: "bare legs",
    },
    others: [
      {
        name: "Sayed",
        action: "beside her",
        outfitSummary: `wool coat ${"in charcoal herringbone with horn buttons; ".repeat(8)}`,
        appearance: "",
        identityAnchors: longAnchors,
        lowerBody: "broad-shouldered",
        exposure: "barefoot",
      },
    ],
    setting: "a rain-streaked library",
  };

  it("excerpts the per-character text under budget pressure instead of clamping the tail", () => {
    const prompt = buildSceneRenderPrompt(crowded, {
      multiReferences: [
        { name: "Mira", kind: "character" },
        { name: "Sayed", kind: "character" },
      ],
    });
    expect(prompt.length).toBeLessThanOrEqual(EDIT_RENDER_PROMPT_LIMIT);
    // The identity anchors were shortened rather than carried whole — the knob
    // that did not exist before.
    expect(prompt).not.toContain(longAnchors);
    expect(prompt).toContain("dark brown hair");
    // The tail survives: the clause that stops the edit model re-painting a
    // garment the fiction already removed.
    expect(prompt).toContain("Depict only the clothing described");
    expect(prompt).toContain("never merge, swap, or duplicate them");
  });

  it("emits intimate detail for multi-references only on the uncensored route", () => {
    const nude = {
      ...emptySceneRenderPlan(),
      focal: { name: "Mira", action: "reclining", outfitSummary: "", appearance: "Hair color: red", exposure: "fully nude, no clothing", intimateAppearance: "Breast size: full" },
    };
    const refs = [{ name: "Mira", kind: "character" as const }, { name: "Den", kind: "location" as const }];
    expect(buildSceneRenderPrompt(nude, { multiReferences: refs })).not.toContain("Breast size: full");
    expect(buildSceneRenderPrompt(nude, { multiReferences: refs, allowIntimate: true })).toContain("Breast size: full");
  });
});

describe("heuristicFocalName", () => {
  it("prefers the NPC mentioned latest in the newest narration", () => {
    expect(heuristicFocalName([mira, sayed], ["Mira waved.", "Mira nodded as Sayed entered."])).toBe("Sayed");
  });

  it("falls back to roster order when nobody is mentioned, and to '' for an empty room", () => {
    expect(heuristicFocalName([mira, sayed], ["The rain kept falling."])).toBe("Mira");
    expect(heuristicFocalName([], ["Mira waved."])).toBe("");
  });
});

describe("resolveScenePlan", () => {
  it("keeps a focal from the roster and forces every outfit from wardrobe state", () => {
    const plan = resolveScenePlan(
      sceneSpecSchema.parse({
        focalCharacter: "Mira",
        pose: "leaning on the rail",
        others: [{ name: "Sayed", action: "watching from the stacks" }],
        setting: "a rain-streaked library",
      }),
      libraryContext,
    );
    expect(plan.focal?.name).toBe("Mira");
    expect(plan.focal?.outfitSummary).toBe("linen shirt; hints of silk camisole beneath");
    expect(plan.others.map((o) => o.name)).toEqual(["Sayed"]);
    expect(plan.others[0]?.outfitSummary).toBe("wool coat");
  });

  it("clamps an absent focal to a present NPC and records the diagnostic", () => {
    const sink = new DiagnosticCollector();
    const plan = resolveScenePlan(
      sceneSpecSchema.parse({ focalCharacter: "The Stranger Upstairs" }),
      libraryContext,
      sink,
    );
    expect(plan.focal?.name).toBe("Mira"); // heuristic: latest mention in newest narration
    expect(sink.items.some((d) => d.code === "images.scene_composer.focal_clamped")).toBe(true);
  });

  it("drops invented 'others' who are not in the room and records the diagnostic", () => {
    const sink = new DiagnosticCollector();
    const plan = resolveScenePlan(
      sceneSpecSchema.parse({
        focalCharacter: "Mira",
        others: [{ name: "Ghost of the Annex", action: "looming" }, { name: "Sayed", action: "" }],
      }),
      libraryContext,
      sink,
    );
    expect(plan.others.map((o) => o.name)).toEqual(["Sayed"]);
    expect(plan.others[0]?.action).toBe("shelving books"); // empty action backfilled from state
    expect(sink.items.some((d) => d.code === "images.scene_composer.absent_character_dropped")).toBe(true);
  });

  // Membership belongs to the roster, not the composer: a present character the
  // composer never mentioned is still in the room, and the render sends their
  // reference either way — so leaving them out of the plan makes the prompt
  // contradict itself.
  it("adds a present character the composer omitted, and records the diagnostic", () => {
    const sink = new DiagnosticCollector();
    const plan = resolveScenePlan(sceneSpecSchema.parse({ focalCharacter: "Mira" }), libraryContext, sink);
    expect(plan.others.map((o) => o.name)).toEqual(["Sayed"]);
    expect(plan.others[0]?.action).toBe("shelving books"); // backfilled from their own state
    expect(sink.items.some((d) => d.code === "images.scene_composer.present_character_added")).toBe(true);
  });

  it("dedupes the focal out of others and yields a null focal for an empty room", () => {
    const dup = resolveScenePlan(
      sceneSpecSchema.parse({ focalCharacter: "Mira", others: [{ name: "mira", action: "again" }] }),
      libraryContext,
    );
    // Mira is the focal and must not appear twice; Sayed is present and joins.
    expect(dup.others.map((o) => o.name)).toEqual(["Sayed"]);
    const empty = resolveScenePlan(sceneSpecSchema.parse({ focalCharacter: "Mira" }), { present: [], locationName: "Atrium", locationDescription: "Glass and rain." });
    expect(empty.focal).toBeNull();
    expect(empty.others).toEqual([]);
    expect(empty.setting).toContain("Atrium");
  });

  it("joins pose + activity without stitched sentence punctuation and scrubs player clauses (owner report 2026-07-10)", () => {
    const plan = resolveScenePlan(
      sceneSpecSchema.parse({
        focalCharacter: "Mira",
        pose: "Walking beside the player, head turned slightly toward the player with a bright, teasing smile.",
        activity: "Leading the player back toward the main gallery, heels clicking on the pale stone floor.",
      }),
      libraryContext,
    );
    // Trailing periods stripped before the "; " join — no "smile.; Leading" stitches.
    expect(plan.focal?.action).not.toContain(".;");
    // "beside the player" / "leading the player" clauses drop; the gaze rewrites to the viewer.
    expect(plan.focal?.action).not.toMatch(/\bplayer\b/i);
    expect(plan.focal?.action).toContain("head turned slightly toward the viewer with a bright");
    expect(plan.focal?.action).toContain("heels clicking on the pale stone floor");
    expect(plan.focal?.action).not.toContain("Walking beside");
  });
});

describe("scrubPlayerFromAction (deterministic backstop)", () => {
  it("returns clean text unchanged (identity — no rejoin churn on the common case)", () => {
    const clean = "seated by the window, one leg crossed; flipping a page";
    expect(scrubPlayerFromAction(clean)).toBe(clean);
  });

  it("rewrites gaze toward the player to the viewer, drops contact/proximity clauses", () => {
    expect(scrubPlayerFromAction("glancing at the player, mid-laugh")).toBe("glancing at the viewer, mid-laugh");
    expect(scrubPlayerFromAction("Walking beside the player, heels clicking on the stone floor")).toBe(
      "heels clicking on the stone floor",
    );
    // A possessive is proximity, not gaze — the clause drops instead of rewriting.
    expect(scrubPlayerFromAction("standing at the player's side, smiling")).toBe("smiling");
  });

  it("documents the pronoun limit: 'his arm' is not scrubbed (a pronoun may be another character)", () => {
    expect(scrubPlayerFromAction("walking beside the player, one hand resting on his arm")).toBe(
      "one hand resting on his arm",
    );
  });
});

describe("scrubBlush (deterministic backstop)", () => {
  it("returns clean text unchanged (identity — no rejoin churn on the common case)", () => {
    const clean = "seated by the window, one leg crossed; flipping a page";
    expect(scrubBlush(clean)).toBe(clean);
  });

  it("drops the skin-colour clause and keeps the physiology beside it", () => {
    expect(scrubBlush("flushed, eyes bright and breath shallow")).toBe("eyes bright and breath shallow");
    expect(scrubBlush("blushing hard; looking away")).toBe("looking away");
    expect(scrubBlush("cheeks reddening, lips parted")).toBe("lips parted");
  });

  it("catches the whole word family the narrator's arousal hint seeds", () => {
    for (const word of ["flushed", "flushing", "flush", "blush", "blushed", "blushes", "rosy", "ruddy", "red-faced"]) {
      expect(scrubBlush(`${word} and still, mid-laugh`)).toBe("mid-laugh");
    }
  });

  it("leaves a clause with no colour word alone even when the text has one elsewhere", () => {
    expect(scrubBlush("flushed pink, seated by the window, flipping a page")).toBe(
      "seated by the window, flipping a page",
    );
  });

  // Degenerate case: nothing survives. buildSceneRenderPrompt guards on a truthy
  // action, so the Pose line is simply omitted — a missing pose beats a painted one.
  it("returns empty when every clause is a colour word", () => {
    expect(scrubBlush("flushed, blushing")).toBe("");
  });
});

describe("buildSceneRenderPrompt", () => {
  const plan = {
    ...emptySceneRenderPlan(),
    focal: { name: "Mira", action: "seated by the window", outfitSummary: "linen shirt", appearance: "Hair color: red" },
    others: [{ name: "Sayed", action: "shelving books", outfitSummary: "wool coat", appearance: "Hair color: black" }],
    setting: "a rain-streaked library",
  };

  it("always states the player POV rule, with or without a reference", () => {
    expect(buildSceneRenderPrompt(plan, { referenceName: "Mira" })).toContain(SCENE_POV_RULE);
    expect(buildSceneRenderPrompt(plan)).toContain(SCENE_POV_RULE);
    expect(SCENE_POV_RULE).toContain("never visible");
  });

  // The phantom-limb fix (2026-07-29): the count + possession assertions ride every
  // disembodied prompt, so "one hand holding a cup" can't become the viewer's hand.
  it("asserts person count and total limb possession on the disembodied prompt", () => {
    const prompt = buildSceneRenderPrompt(plan, { referenceName: "Mira" });
    expect(prompt).toContain("Exactly two people are fully in frame: Mira and Sayed. Nobody else appears.");
    expect(prompt).toContain("Every visible body part belongs to Mira or Sayed.");
    const solo = buildSceneRenderPrompt({ ...plan, others: [] }, { referenceName: "Mira" });
    expect(solo).toContain("Exactly one person is fully in frame: Mira.");
    expect(solo).toContain("Every visible body part belongs to Mira.");
  });

  it("identity-locks the focal reference and describes the others textually", () => {
    const prompt = buildSceneRenderPrompt(plan, { referenceName: "Mira" });
    expect(prompt.startsWith(PORTRAIT_IDENTITY_LOCK)).toBe(true);
    expect(prompt).toContain("Pose: seated by the window");
    expect(prompt).toContain("Wearing: linen shirt");
    expect(prompt).not.toContain("Subject: Mira");
    // "Also in frame" line carries the other's appearance + outfit + action, in order.
    expect(prompt).toMatch(/Also in frame: Sayed\b.*black.*wool coat.*shelving books/);
  });

  it("fallback reference on another present NPC keeps the focal textual", () => {
    const prompt = buildSceneRenderPrompt(plan, { referenceName: "Sayed" });
    expect(prompt.startsWith(PORTRAIT_IDENTITY_LOCK)).toBe(true);
    expect(prompt).toContain("Pose: shelving books");
    expect(prompt).toContain("Wearing: wool coat");
    expect(prompt).toMatch(/Also in frame: Mira\b.*red.*linen shirt.*seated by the window/);
  });

  it("text-to-image names the focal as subject; an empty reference outfit keeps the reference outfit", () => {
    const prompt = buildSceneRenderPrompt(plan);
    expect(prompt).not.toContain(PORTRAIT_IDENTITY_LOCK);
    expect(prompt).toMatch(/Subject: Mira\b.*red.*linen shirt.*seated by the window/);
    const bare = buildSceneRenderPrompt(
      { ...plan, focal: { ...plan.focal, outfitSummary: "" } },
      { referenceName: "Mira" },
    );
    expect(bare).toContain("Keep the same outfit");
  });

  it("describes a textual character's species first in their detail", () => {
    const prompt = buildSceneRenderPrompt({
      ...plan,
      focal: { ...plan.focal, name: "Lilith", species: "Succubus" },
    });
    // Species precedes the rest of the textual detail; assert order, not separators.
    expect(prompt).toMatch(/Subject: Lilith\b.*Succubus.*red.*linen shirt/);
  });

  it("renders a location-only POV shot when nobody is present", () => {
    const prompt = buildSceneRenderPrompt({ ...emptySceneRenderPlan(), setting: "an empty atrium at dusk" });
    expect(prompt).toContain(SCENE_POV_RULE);
    expect(prompt).toContain("No people in frame");
    expect(prompt).toContain("Setting: an empty atrium at dusk.");
    expect(prompt).not.toContain(PORTRAIT_IDENTITY_LOCK);
  });

  it("injects the reference's bare-region phrase and forbids unlisted garments", () => {
    const topless = {
      ...emptySceneRenderPlan(),
      focal: { name: "Mira", action: "seated by the window", outfitSummary: "lace panties", appearance: "Hair color: red", exposure: "topless, bare chest; barefoot" },
    };
    const prompt = buildSceneRenderPrompt(topless, { referenceName: "Mira" });
    expect(prompt).toContain("Wearing: lace panties.");
    expect(prompt).toContain("Topless, bare chest; barefoot.");
    expect(prompt).toContain("add no garment that is not listed");
  });

  it("describes a topless other textually without defaulting them into clothing", () => {
    const plan = {
      ...emptySceneRenderPlan(),
      focal: { name: "Mira", action: "watching", outfitSummary: "wool coat", appearance: "Hair color: red" },
      others: [{ name: "Sayed", action: "stretching", outfitSummary: "", appearance: "Hair color: black", exposure: "fully nude, no clothing" }],
    };
    const prompt = buildSceneRenderPrompt(plan, { referenceName: "Mira" });
    expect(prompt).toContain("Also in frame: Sayed — Hair color: black; fully nude, no clothing; stretching.");
    expect(prompt).not.toContain("casual everyday clothing");
  });

  // The reference-edit budget is 1500 chars (followups.phase3.md §6).
  const richOutfit =
    "A light-wash denim skirt with artfully placed rips and frayed edges (faded blue denim); stylish edgy platform boots in a bright contrasting color (thick sole, sturdy); quirky tights with a whimsical polka-dot pattern (vibrant pink and yellow); a cozy oversized rainbow-striped sweater (soft, slightly fuzzy)";
  const bigPlan = {
    ...emptySceneRenderPlan(),
    focal: {
      name: "Enid",
      action: "sitting with one leg tucked under her, facing the player, looking up with a shy smile, hand open between them",
      outfitSummary: richOutfit,
      appearance: "Hair color: blonde with rainbow streaks; eyes: bright",
    },
    setting: "Enid's side of the dorm room, a vibrant explosion of color and clutter with fairy lights, plush toys, and rainbow-hued clothes; Wednesday's side is a stark gothic sanctuary",
  };

  it("keeps the reference-edit prompt within the 1500-char limit, preserving the lock + POV", () => {
    const prompt = buildSceneRenderPrompt(bigPlan, { referenceName: "Enid" });
    expect(prompt.length).toBeLessThanOrEqual(EDIT_RENDER_PROMPT_LIMIT);
    expect(prompt.startsWith(PORTRAIT_IDENTITY_LOCK)).toBe(true);
    expect(prompt).toContain(SCENE_POV_RULE);
    expect(prompt).toContain("Wearing:");
    expect(prompt).toContain("add no garment that is not listed");
  });

  it("does not budget the text-to-image path (no such cap there)", () => {
    const prompt = buildSceneRenderPrompt(bigPlan); // no referenceName → t2i
    expect(prompt).toContain(richOutfit); // full, untruncated outfit detail
  });
});

describe("formatExposure", () => {
  const covered = { torso: "covered", pelvis: "covered", legs: "covered", feet: "covered" } as const;

  it("returns nothing when fully covered, or when the character is not wardrobe-tracked", () => {
    expect(formatExposure(covered, true)).toBe("");
    // Bare everywhere but untracked → unknown, never assumed nude.
    expect(formatExposure({ torso: "bare", pelvis: "bare", legs: "bare", feet: "bare" }, false)).toBe("");
    expect(formatExposure(undefined, true)).toBe("");
  });

  it("collapses a fully bare body to a single nude phrase, not a list", () => {
    expect(formatExposure({ torso: "bare", pelvis: "bare", legs: "bare", feet: "bare" }, true)).toBe("fully nude, no clothing");
  });

  it("states topless when only the top is gone", () => {
    expect(formatExposure({ ...covered, torso: "bare" }, true)).toBe("topless, bare chest");
  });

  it("states bare legs only when the pelvis is covered", () => {
    expect(formatExposure({ ...covered, legs: "bare" }, true)).toBe("bare legs");
    // Pelvis bare already implies bare legs — don't double up.
    expect(formatExposure({ ...covered, pelvis: "bare", legs: "bare" }, true)).toBe("bare below the waist, no underwear or bottoms");
  });

  it("adds barefoot for an otherwise-clothed subject, and folds it into nude", () => {
    expect(formatExposure({ ...covered, feet: "bare" }, true)).toBe("barefoot");
    expect(formatExposure({ torso: "bare", pelvis: "bare", legs: "bare", feet: "bare" }, true)).not.toContain("barefoot");
  });

  it("reports a sheer top distinctly from a bare one", () => {
    expect(formatExposure({ ...covered, torso: "sheer" }, true)).toBe("wearing only a sheer top, skin visible through it");
  });
});

describe("sceneFramingRule (scene-pov-embodiment slices 1+2)", () => {
  const part = (id: string) => viewerBodyPartById(id)!;

  // The disembodied rule is positive-only since the phantom-limb fix (2026-07-29): the
  // old "no hands or held objects" negative summoned disembodied foreground hands
  // whenever the pose text mentioned the character's hands or feet — the "no camera"
  // scar, again. Absence is asserted as a person count + total limb possession instead.
  it("builds the disembodied rule from the POV opening + count + possession", () => {
    expect(sceneFramingRule({})).toBe(`${SCENE_POV_RULE} No other person is in frame.`);
    expect(sceneFramingRule({ parts: [] })).toBe(`${SCENE_POV_RULE} No other person is in frame.`);
    expect(sceneFramingRule({ parts: [], subjects: ["Mira"] })).toBe(
      `${SCENE_POV_RULE} Exactly one person is fully in frame: Mira. Nobody else appears. Every visible body part belongs to Mira.`,
    );
    expect(SCENE_POV_RULE).not.toMatch(/no hands|no body/i);
  });

  // Named alternatives, not "one of them" (Stage 7): the A/B that settled this
  // sentence proved a NAME binds possession, and the anonymous plural kept the
  // abstraction while dropping the binding.
  it("names the subjects in the possession binding, and skips possession for location-only", () => {
    expect(sceneFramingRule({ parts: [], subjects: ["Mira", "Sayed"] })).toContain(
      "Every visible body part belongs to Mira or Sayed.",
    );
    expect(sceneFramingRule({ parts: [], subjects: ["Mira", "Sayed", "Wren"] })).toContain(
      "Every visible body part belongs to Mira, Sayed or Wren.",
    );
    expect(sceneFramingRule({ parts: [], subjects: [] })).not.toContain("belongs to");
  });

  it("binds every part to the viewer and to the frame, never as a subject", () => {
    const rule = sceneFramingRule({ parts: [part("forearms")], subjects: ["Mira"] });
    expect(rule).toContain("the viewer's own forearms");
    expect(rule).toContain("foreshortened");
    expect(rule).toContain("face and head are never in frame");
  });

  // The anti-third-person lever: a POSITIVE count, not a negative. "No man in frame" would
  // anchor the model on `man`, exactly as the literal "no camera" once summoned cameras.
  it("asserts the person count positively, from the featured list", () => {
    expect(sceneFramingRule({ parts: [part("hands")], subjects: ["Mira"] })).toContain(
      "Exactly one person is fully in frame: Mira.",
    );
    expect(sceneFramingRule({ parts: [part("hands")], subjects: ["Mira", "Sayed"] })).toContain(
      "Exactly two people are fully in frame: Mira and Sayed.",
    );
    expect(sceneFramingRule({ parts: [part("hands")], subjects: [] })).toContain("No other person is in frame.");
  });

  it("never names the player as a subject noun", () => {
    const rule = sceneFramingRule({ parts: [part("genitals"), part("torso")], subjects: ["Mira"] });
    expect(rule).not.toMatch(/\ba man\b|\bhis\b|\bthe player\b/i);
  });

  it("joins several parts readably", () => {
    const rule = sceneFramingRule({ parts: [part("hands"), part("forearms"), part("torso")], subjects: ["Mira"] });
    expect(rule).toContain("hands");
    expect(rule).toContain(" and ");
    expect(rule.split("Also in frame").length - 1).toBe(1);
  });

  it("drops trailing/blank subject names rather than rendering an empty slot", () => {
    expect(sceneFramingRule({ parts: [part("hands")], subjects: ["Mira", "  "] })).toContain(
      "Exactly one person is fully in frame: Mira.",
    );
  });
});

describe("buildSceneRenderPrompt with viewer parts", () => {
  const plan = {
    ...emptySceneRenderPlan(),
    focal: { name: "Mira", action: "seated by the window", outfitSummary: "linen shirt", appearance: "Hair color: red" },
  };

  it("carries today's rule when no parts are passed (every caller, today)", () => {
    expect(buildSceneRenderPrompt(plan, { referenceName: "Mira" })).toContain(SCENE_POV_RULE);
  });

  it("swaps in the embodied rule when parts are passed", () => {
    const prompt = buildSceneRenderPrompt(plan, {
      referenceName: "Mira",
      viewerParts: [viewerBodyPartById("forearms")!],
    });
    expect(prompt).not.toContain(SCENE_POV_RULE);
    expect(prompt).toContain("the viewer's own forearms");
    expect(prompt).toContain("Exactly one person is fully in frame: Mira.");
  });

  // The framing rule is never-dropped tier: budgetRenderPrompt shrinks outfit/setting text
  // to fit the 1500-char budget, and must not eat the thing that stops a second person
  // appearing.
  it("keeps the embodied rule intact even when the prompt is budgeted down", () => {
    const fat = {
      ...plan,
      focal: { ...plan.focal, outfitSummary: "a ".repeat(900) },
      setting: "s ".repeat(900),
    };
    const prompt = buildSceneRenderPrompt(fat, {
      referenceName: "Mira",
      viewerParts: [viewerBodyPartById("forearms")!],
    });
    expect(prompt.length).toBeLessThanOrEqual(EDIT_RENDER_PROMPT_LIMIT);
    expect(prompt).toContain("the viewer's own forearms");
    expect(prompt).toContain("Exactly one person is fully in frame: Mira.");
  });

  // A selfie is the subject's own camera — there is no viewer standing in the scene at all,
  // so viewer parts must not leak into that framing.
  it("ignores viewer parts for a selfie", () => {
    const prompt = buildSceneRenderPrompt(plan, {
      referenceName: "Mira",
      framing: "selfie",
      viewerParts: [viewerBodyPartById("forearms")!],
    });
    expect(prompt).toContain(SELFIE_FRAMING);
    expect(prompt).not.toContain("the viewer's own forearms");
  });
});

describe("the composer's viewer-body proposal (slice 3)", () => {
  const present: ScenePresentCharacter = { name: "Mira", wornVisible: [] };
  const narration = [
    "Mira leans in; her cheek comes to rest against your palm, your hands cradling her face while your forearms brace on the table, her torso pressing close against your chest.",
  ];
  const ctx = (over: Partial<SceneComposerContext> = {}): SceneComposerContext => ({
    present: [present],
    recentNarration: narration,
    ...over,
  });
  // Default evidence: a verbatim quote per part (the grounding gate, 2026-07-29). Tests
  // for the earlier clamps pass grounded evidence so they still exercise THEIR gate.
  const QUOTES: Record<string, string> = {
    hands: "her cheek comes to rest against your palm",
    forearms: "your forearms brace on the table",
    torso: "her torso pressing close against your chest",
  };
  const evidence = (parts: string[]) => parts.map((part) => ({ part, quote: QUOTES[part] ?? QUOTES.forearms ?? "" }));
  const spec = (viewerBody: string[], viewerBodyEvidence = evidence(viewerBody)) => ({
    ...emptySceneSpec(),
    focalCharacter: "Mira",
    viewerBody,
    viewerBodyEvidence,
  });

  it("keeps registry parts when the lane asked for embodiment", () => {
    const plan = resolveScenePlan(spec(["hands", "forearms"]), ctx({ embodiedViewer: true }));
    expect(plan.viewerBody).toEqual(["hands", "forearms"]);
  });

  // The session lane never sets embodiedViewer and gets the disembodied rules, so a
  // proposal there means the composer went off-script — dropped AND logged.
  it("drops everything in a lane that never asked, with a diagnostic", () => {
    const sink = new DiagnosticCollector();
    const plan = resolveScenePlan(spec(["hands"]), ctx(), sink);
    expect(plan.viewerBody).toEqual([]);
    expect(sink.items.map((d) => d.code)).toContain("images.scene_composer.viewer_body_unrequested");
  });

  it("drops invented ids, keeping the rest, with a diagnostic", () => {
    const sink = new DiagnosticCollector();
    const plan = resolveScenePlan(spec(["hands", "elbows"]), ctx({ embodiedViewer: true }), sink);
    expect(plan.viewerBody).toEqual(["hands"]);
    expect(sink.items.map((d) => d.code)).toContain("images.scene_composer.viewer_body_dropped");
  });

  // The composer runs allowIntimate:false on the moderation-prone tool model and has no
  // intimate vocabulary — proposing one is off-script, even though the render gate would
  // also have caught it.
  it("drops an intimate part the composer had no business proposing", () => {
    const sink = new DiagnosticCollector();
    const plan = resolveScenePlan(spec(["genitals", "torso"]), ctx({ embodiedViewer: true }), sink);
    expect(plan.viewerBody).toEqual(["torso"]);
    expect(sink.items.map((d) => d.code)).toContain("images.scene_composer.viewer_body_dropped");
  });

  it("carries the player's coverage onto the plan for the render gate", () => {
    const exposure = { torso: "bare", pelvis: "bare", legs: "bare", feet: "bare" } as const;
    expect(resolveScenePlan(spec([]), ctx({ embodiedViewer: true, playerExposure: exposure })).playerExposure).toEqual(
      exposure,
    );
    expect(resolveScenePlan(spec([]), ctx({ embodiedViewer: true })).playerExposure).toBeUndefined();
  });

  it("is empty by default — an unembodied plan is exactly today's shot", () => {
    expect(resolveScenePlan(emptySceneSpec(), ctx()).viewerBody).toEqual([]);
    expect(emptySceneRenderPlan().viewerBody).toEqual([]);
  });

  // The anti-eagerness gate (2026-07-29): an LLM given an optional field uses it far
  // more often than the fiction warrants — so every part must carry a verbatim quote
  // from the recent narration, checked in code. The composer proposes, the transcript
  // disposes; no second model call.
  it("drops a part with no evidence quote, with the ungrounded diagnostic", () => {
    const sink = new DiagnosticCollector();
    const plan = resolveScenePlan(spec(["hands"], []), ctx({ embodiedViewer: true }), sink);
    expect(plan.viewerBody).toEqual([]);
    expect(sink.items.map((d) => d.code)).toContain("images.scene_composer.viewer_body_ungrounded");
  });

  it("drops a paraphrased quote and keeps the verbatim one", () => {
    const plan = resolveScenePlan(
      spec(
        ["hands", "forearms"],
        [
          { part: "hands", quote: "her cheek comes to rest against your palm" },
          { part: "forearms", quote: "the player's forearms rest upon the table" }, // paraphrase — not in the narration
        ],
      ),
      ctx({ embodiedViewer: true }),
    );
    expect(plan.viewerBody).toEqual(["hands"]);
  });

  it("matches evidence case/whitespace-insensitively, but a trivial quote proves nothing", () => {
    const sloppy = resolveScenePlan(
      spec(["hands"], [{ part: "hands", quote: "  Her CHEEK comes to  rest against your palm " }]),
      ctx({ embodiedViewer: true }),
    );
    expect(sloppy.viewerBody).toEqual(["hands"]);
    const trivial = resolveScenePlan(spec(["hands"], [{ part: "hands", quote: "your palm" }]), ctx({ embodiedViewer: true }));
    expect(trivial.viewerBody).toEqual([]);
  });

  it("drops everything when there is no narration to ground against", () => {
    const plan = resolveScenePlan(spec(["hands"]), ctx({ embodiedViewer: true, recentNarration: [] }));
    expect(plan.viewerBody).toEqual([]);
  });
});

describe("bindLimbsToOwner (phantom-limb fix, 2026-07-29)", () => {
  const present: ScenePresentCharacter = { name: "Mira", wornVisible: [] };
  const ctx = (over: Partial<SceneComposerContext> = {}): SceneComposerContext => ({ present: [present], ...over });

  it("binds bare-article limbs to the owner", () => {
    expect(bindLimbsToOwner("one hand holding a cup, a finger tracing the rim", "Kristin")).toBe(
      "Kristin's hand holding a cup, Kristin's finger tracing the rim",
    );
  });

  it("binds 'both hands' as a plural possessive", () => {
    expect(bindLimbsToOwner("both hands wrapped around the mug", "Mira")).toBe("both of Mira's hands wrapped around the mug");
  });

  it("leaves already-possessive limbs, idioms and compounds untouched", () => {
    const text = "her hand on the viewer's forearm, keeping him at an arm's length by a hand-carved rail";
    expect(bindLimbsToOwner(text, "Mira")).toBe(text);
  });

  it("no-ops on a blank owner and non-limb nouns", () => {
    expect(bindLimbsToOwner("one hand raised", "  ")).toBe("one hand raised");
    expect(bindLimbsToOwner("a lamp in one corner", "Mira")).toBe("a lamp in one corner");
  });

  it("runs on composer pose text through resolveScenePlan", () => {
    const composed = resolveScenePlan(
      { ...emptySceneSpec(), focalCharacter: "Mira", pose: "sitting sideways, one hand holding a cup" },
      ctx(),
    );
    expect(composed.focal?.action).toBe("sitting sideways, Mira's hand holding a cup");
  });
});

describe("sceneComposerSystem lane scope (slice 3)", () => {
  it("is byte-identical to the shipped constant when not embodied — the session lane", () => {
    expect(sceneComposerSystem(false)).toBe(SCENE_COMPOSER_SYSTEM);
    expect(sceneComposerSystem()).toBe(SCENE_COMPOSER_SYSTEM);
  });

  it("keeps the session lane's absolute player-absence rule", () => {
    expect(SCENE_COMPOSER_SYSTEM).toContain("The player must NEVER appear in the image");
    expect(SCENE_COMPOSER_SYSTEM).not.toContain("viewerBody");
  });

  it("inverts both rules when embodied, and offers only the non-intimate vocabulary", () => {
    const embodied = sceneComposerSystem(true);
    expect(embodied).not.toContain("The player must NEVER appear in the image");
    expect(embodied).toContain("viewerBody");
    expect(embodied).toContain('"hands", "forearms", "lap_thighs", "legs_feet", "torso"');
    // Intimate anatomy is derived at render assembly, never proposed by this model.
    expect(embodied).not.toContain("genitals");
  });

  it("keeps the blush rule on both lanes", () => {
    for (const system of [sceneComposerSystem(false), sceneComposerSystem(true)]) {
      expect(system).toContain("NEVER describe skin colour");
    }
  });
});

describe("scrubPlayerFromAction when the viewer has a body (slice 3)", () => {
  it("rewrites player references to the viewer instead of dropping the clause", () => {
    expect(scrubPlayerFromAction("her hand closing over the player's forearm", { embodied: true })).toBe(
      "her hand closing over the viewer's forearm",
    );
    expect(scrubPlayerFromAction("leaning into the player, laughing", { embodied: true })).toBe(
      "leaning into the viewer, laughing",
    );
  });

  it("still drops the clause when the viewer has no body in frame", () => {
    expect(scrubPlayerFromAction("her hand closing over the player's forearm")).toBe("");
    expect(scrubPlayerFromAction("leaning into the player, laughing")).toBe("laughing");
  });

  it("leaves clean text alone either way", () => {
    const clean = "seated by the window, flipping a page";
    expect(scrubPlayerFromAction(clean, { embodied: true })).toBe(clean);
    expect(scrubPlayerFromAction(clean)).toBe(clean);
  });
});

describe("the viewer's own body facts (slice 4)", () => {
  const persona = makeProfile({
    intimateRegions: ["penis"],
    attributes: [
      baseAttr("skin.tone", "tan"),
      baseAttr("arms.hair", "moderate"),
      baseAttr("legs.hair", "heavy"),
      baseAttr("build.frame", "broad"),
    ],
  });
  const planWith = (over: Partial<SceneRenderPlan>): SceneRenderPlan => ({
    ...emptySceneRenderPlan(),
    focal: { name: "Mira", action: "seated", outfitSummary: "linen shirt", appearance: "" },
    playerAttributes: persona.attributes,
    playerProfile: persona,
    ...over,
  });

  // Without this the viewer's arms change colour between shots, which reads as a different
  // person reaching in — the whole reason the facts exist.
  it("always states skin tone and frame for an embodied shot", () => {
    const prompt = buildSceneRenderPrompt(planWith({ viewerBody: ["forearms"] }), {
      referenceName: "Mira",
      allowIntimate: true,
    });
    expect(prompt).toContain("The viewer's own body:");
    expect(prompt).toContain("tan");
    expect(prompt).toContain("broad");
  });

  it("states only what the parts in frame can show", () => {
    const armsOnly = buildSceneRenderPrompt(planWith({ viewerBody: ["forearms"] }), { referenceName: "Mira" });
    expect(armsOnly).toContain("moderate"); // arms.hair — in frame
    expect(armsOnly).not.toContain("heavy"); // legs.hair — not in frame

    const legs = buildSceneRenderPrompt(planWith({ viewerBody: ["legs_feet"] }), { referenceName: "Mira" });
    expect(legs).toContain("heavy");
  });

  it("says nothing at all when the viewer has no body in frame", () => {
    const prompt = buildSceneRenderPrompt(planWith({ viewerBody: [] }), { referenceName: "Mira" });
    expect(prompt).toContain(SCENE_POV_RULE);
    expect(prompt).not.toContain("The viewer's own body:");
    expect(prompt).not.toContain("tan");
  });

  it("emits the viewer's intimate anatomy only when a gated part survived AND the route allows it", () => {
    const nude = { torso: "bare", pelvis: "bare", legs: "bare", feet: "bare" } as const;
    const plan = planWith({
      viewerBody: ["lap_thighs"],
      playerExposure: nude,
      playerIntimateAppearance: "circumcised, average length",
    });
    // Uncensored route + looking-down shot + bare pelvis ⇒ the derived part earns it.
    expect(buildSceneRenderPrompt(plan, { referenceName: "Mira", allowIntimate: true })).toMatch(/circumcised/i);
    // Same plan, moderated text-to-image fallback ⇒ nothing.
    expect(buildSceneRenderPrompt(plan, {})).not.toMatch(/circumcised/i);
    // Uncensored, but trousered ⇒ the gate drops the part, so the anatomy goes with it.
    const dressed = planWith({
      viewerBody: ["lap_thighs"],
      playerExposure: { torso: "bare", pelvis: "covered", legs: "covered", feet: "bare" },
      playerIntimateAppearance: "circumcised, average length",
    });
    expect(buildSceneRenderPrompt(dressed, { referenceName: "Mira", allowIntimate: true })).not.toMatch(/circumcised/i);
  });
});

describe("apparent-age anchor + image age floor (owner ruling 2026-07-29)", () => {
  const anchorAttrs = (band: string): AttributeValue[] => [
    baseAttr("identity.gender", "female"),
    baseAttr("identity.apparent_age", band),
    baseAttr("skin.texture", "smooth"),
  ];

  it("states the sheet's age name-bound, with the youthful-skin clause for young smooth-skinned bands", () => {
    expect(apparentAgeAnchor("Kristin", anchorAttrs("late_twenties"))).toBe(
      "Kristin is in her late twenties; her skin, hands and legs read smooth and youthful.",
    );
  });

  it("makes eighteen explicit and adult — never an ambiguous teen word", () => {
    const line = apparentAgeAnchor("Marcus", [
      baseAttr("identity.gender", "male"),
      baseAttr("identity.apparent_age", "eighteen"),
    ]);
    expect(line).toBe("Marcus is exactly eighteen years old, an adult.");
    expect(line).not.toMatch(/\bteen\b/i);
  });

  it("emits NOTHING for minor bands and unknown values — no age text beats a wrong word", () => {
    expect(apparentAgeAnchor("Kid", anchorAttrs("teen"))).toBe("");
    expect(apparentAgeAnchor("Kid", anchorAttrs("child"))).toBe("");
    expect(apparentAgeAnchor("Kid", anchorAttrs("made_up_band"))).toBe("");
    expect(apparentAgeAnchor("Kid", [baseAttr("identity.gender", "female")])).toBe("");
  });

  it("skips the youthful-skin clause for older bands and unstated texture, and defaults pronouns to they/their", () => {
    expect(apparentAgeAnchor("Wren", anchorAttrs("forties"))).toBe("Wren is in her forties.");
    expect(
      apparentAgeAnchor("Ash", [baseAttr("identity.apparent_age", "late_twenties")]),
    ).toBe("Ash is in their late twenties.");
  });

  it("imageAgeWord floors the avatar subject descriptor the same way", () => {
    expect(imageAgeWord("eighteen")).toBe("eighteen-year-old");
    expect(imageAgeWord("late_twenties")).toBe("late twenties");
    expect(imageAgeWord("teen")).toBeUndefined();
    expect(imageAgeWord("tween")).toBeUndefined();
    expect(imageAgeWord(42)).toBeUndefined();
  });

  it("buildAvatarPrompt never emits a sub-adult age word", () => {
    const minor = makeProfile({ attributes: [baseAttr("identity.apparent_age", "teen"), baseAttr("hair.color", "red")] });
    const prompt = buildAvatarPrompt("Sib", minor, "realistic");
    expect(prompt).not.toMatch(/\bteen\b/i);
    const adult = makeProfile({ attributes: [baseAttr("identity.apparent_age", "eighteen")] });
    expect(buildAvatarPrompt("Marcus", adult, "realistic")).toContain("eighteen-year-old");
  });

  it("rides the identity-locked scene prompt after the lock, and the textual t2i subject", () => {
    const anchor = "Kristin is in her late twenties; her skin, hands and legs read smooth and youthful.";
    const plan = {
      ...emptySceneRenderPlan(),
      focal: { name: "Kristin", action: "reading", outfitSummary: "a sundress", appearance: "Hair color: black", ageAnchor: anchor },
    };
    expect(buildSceneRenderPrompt(plan, { referenceName: "Kristin" })).toContain(anchor);
    expect(buildSceneRenderPrompt(plan)).toContain(anchor); // no reference — the t2i path states it too
  });

  it("rides the multi-reference prompt on the anchored character's line", () => {
    const plan = {
      ...emptySceneRenderPlan(),
      focal: {
        name: "Kristin",
        action: "reading",
        outfitSummary: "a sundress",
        appearance: "",
        ageAnchor: "Kristin is in her late twenties.",
      },
    };
    const prompt = buildSceneRenderPrompt(plan, {
      multiReferences: [
        { name: "Kristin", kind: "character" },
        { name: "The Deck", kind: "location" },
      ],
    });
    expect(prompt).toContain("Kristin is in her late twenties");
  });

  it("slots into the variant instruction between the lock and the change", () => {
    const prompt = buildVariantInstruction("pose", "leaning on a railing", "Kristin is in her late twenties.");
    expect(prompt).toContain("apparent age. Kristin is in her late twenties. Change the pose");
    expect(buildVariantInstruction("pose", "leaning on a railing")).not.toContain("late twenties");
  });
});
