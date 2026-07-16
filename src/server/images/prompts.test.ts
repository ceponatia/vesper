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
import { emptyCharacterProfile, type CharacterProfile } from "@/contracts/world/profile";
import { viewerBodyPartById } from "@/contracts/images/viewer-body";
import {
  buildAvatarPrompt,
  buildItemImagePrompt,
  buildLocationImagePrompt,
  buildSceneComposerPrompt,
  buildSceneRenderPrompt,
  buildVariantInstruction,
  characterAppearanceSummary,
  emptySceneRenderPlan,
  emptySceneSpec,
  formatExposure,
  heuristicFocalName,
  identityAnchorSummary,
  intimateSceneAppearance,
  PORTRAIT_IDENTITY_LOCK,
  RECENT_NARRATION_LATEST_CHARS,
  RECENT_NARRATION_PRIOR_CHARS,
  resolveScenePlan,
  sceneFramingRule,
  sceneRevealAppearance,
  scrubBlush,
  scrubPlayerFromAction,
  SCENE_COMPOSER_SYSTEM,
  SCENE_POV_RULE,
  SELFIE_FRAMING,
  sceneSpecSchema,
  VENICE_RENDER_PROMPT_LIMIT,
  visibleAvatarOutfit,
  wardrobeOutfitSummary,
  type SceneComposerContext,
  type ScenePresentCharacter,
} from "./prompts";

function profileWith(overrides: Partial<CharacterProfile>): CharacterProfile {
  return { ...emptyCharacterProfile(), ...overrides };
}

describe("buildAvatarPrompt", () => {
  const profile = profileWith({
    bio: "A wandering cartographer of the northern reaches.",
    personality: "Dry wit, endlessly curious.",
    attributes: [
      { id: "hair.color", value: "red", source: "base" },
      { id: "hair.length", value: "shoulder_length", source: "base" },
      { id: "identity.apparent_age", value: "mid_twenties", source: "base" },
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
    const odd = profileWith({
      attributes: [{ id: "hair.nonexistent_attr", value: "x", source: "base" }],
    });
    const realistic = buildAvatarPrompt("Mira", odd, "realistic");
    const stylized = buildAvatarPrompt("Mira", odd, "stylized");
    expect(realistic).not.toBe(stylized);
    expect(realistic).toContain("Ultra-realistic");
    expect(stylized).toContain("stylized");
    expect(realistic).not.toContain("nonexistent_attr");
  });

  it("tolerates an empty profile", () => {
    const prompt = buildAvatarPrompt("", emptyCharacterProfile(), "realistic");
    expect(prompt).toContain("an unnamed character");
    expect(prompt).not.toContain("Appearance:");
  });

  it("never includes intimate anatomy — bare or dressed, the portrait studio is intimate-free", () => {
    const p = profileWith({
      intimateRegions: ["breasts"],
      attributes: [
        { id: "hair.color", value: "red", source: "base" },
        { id: "breasts.size", value: "full", source: "base" },
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
    const p = profileWith({
      intimateRegions: ["vulva"],
      attributes: [
        { id: "hair.color", value: "red", source: "base" },
        { id: "chest.size", value: "full", source: "base" }, // chest (general) — above waist, not intimate
        { id: "feet.size", value: "average", source: "base" },
        { id: "legs.length", value: "proportionate", source: "base" },
        { id: "hips.width", value: "rounded", source: "base" },
        { id: "vulva.labia_minora", value: "protruding", source: "base" }, // pelvic intimate
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
      { id: "horns.shape", value: "swept_back", source: "base" },
      { id: "wings.type", value: "membranous", source: "base" },
      { id: "tail.type", value: "spaded", source: "base" },
    ];
    const human = buildAvatarPrompt("Mira", profileWith({ speciesId: "human", attributes: attrs }), "realistic");
    expect(human).not.toContain("Horns:");
    expect(human).not.toContain("Wings:");
    expect(human).not.toContain("Tail:");

    // Morphology leads the appearance section and each feature is one grouped clause.
    const succubus = buildAvatarPrompt("Mira", profileWith({ speciesId: "succubus", attributes: attrs }), "realistic");
    expect(succubus).toContain("Horns: swept back");
    expect(succubus).toContain("Wings: membranous");
    expect(succubus).toContain("Tail: spaded");

    const winglessSuccubus = buildAvatarPrompt(
      "Mira",
      profileWith({ speciesId: "succubus", bodyFeatures: ["horns"], attributes: attrs }),
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
    const p = profileWith({
      speciesId: "succubus",
      attributes: [
        { id: "hair.color", value: "black", source: "base" },
        { id: "teeth.shape", value: "sharp_canines", source: "base" }, // "sharp canines" makes SDXL render a mess
        { id: "teeth.condition", value: "pristine", source: "base" },
        { id: "build.height", value: "short", source: "base" }, // no height reference in a waist-up crop
        { id: "skin.undertone", value: "cool", source: "base" },
        { id: "hands.nails", value: "manicured", source: "base" },
        { id: "movement.gait", value: "graceful", source: "base" }, // motion — invisible in a still
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
      profileWith({
        speciesId: "succubus",
        attributes: [
          { id: "identity.gender", value: "female", source: "base" },
          { id: "identity.apparent_age", value: "young_adult", source: "base" },
          { id: "identity.heritage", value: "Latina", source: "base" },
        ],
      }),
      "realistic",
    );
    // Species noun present; ethnicity carried. Assert the pieces, not the exact clause.
    expect(succubus).toMatch(/Subject: Kianna\b.*young adult.*female.*succubus.*Latina/);
    // Human (no species noun): ethnicity follows gender.
    const human = buildAvatarPrompt(
      "Mira",
      profileWith({
        attributes: [
          { id: "identity.gender", value: "female", source: "base" },
          { id: "identity.apparent_age", value: "young_adult", source: "base" },
          { id: "identity.heritage", value: "Igbo", source: "base" },
        ],
      }),
      "realistic",
    );
    expect(human).toMatch(/Subject: Mira\b.*young adult.*female.*Igbo/);
    expect(human).not.toMatch(/succubus/i); // no species noun for a human
  });

  it("states chest hair only when the torso is bare, never under clothing", () => {
    const p = profileWith({ attributes: [{ id: "chest.hair", value: "dense", source: "base" }] });
    // Clothed (a top covering the chest) → hidden.
    const clothed = buildAvatarPrompt("Sayed", p, "realistic", [{ name: "Shirt", coverage: ["chest"] }]);
    expect(clothed).not.toContain("Chest");
    expect(clothed).not.toContain("dense");
    // Bare chest → stated.
    expect(buildAvatarPrompt("Sayed", p, "realistic", [])).toContain("Chest: dense");
  });

  it("drops non-visual (sensory) attributes — voice and scent never reach an image prompt", () => {
    const p = profileWith({
      attributes: [
        { id: "hair.color", value: "red", source: "base" },
        { id: "voice.pitch", value: "high", source: "base" },
        { id: "voice.cadence", value: "melodic", source: "base" },
        { id: "presentation.scent_baseline", value: "lavender and cedar", source: "base" },
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
    const succubus = buildAvatarPrompt("Mira", profileWith({ speciesId: "succubus" }), "realistic");
    expect(succubus).toContain("Subject: Mira — a succubus.");
    expect(succubus).not.toContain("leathery bat-like wings"); // appearance description dropped — feature attributes carry it
    const human = buildAvatarPrompt("Mira", profileWith({ speciesId: "human" }), "realistic");
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
    profileWith({
      // Switch on every intimate region + feature group so the attribute under
      // test is applicable — then the ONLY thing that can drop it is the gate.
      intimateRegions: [...INTIMATE_ATTRIBUTE_CATEGORIES],
      bodyFeatures: [...FEATURE_ATTRIBUTE_CATEGORIES],
      attributes: [
        { id: "hair.color", value: "red", source: "base" },
        { id: id as AttributeDefinition["id"], value: sampleValue(attributeRegistry.byId(id) as AttributeDefinition), source: "base" },
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
      { id: "hair.color", value: "red", source: "base" },
      { id: "hair.nonexistent_attr", value: "x", source: "base" },
    ]);
    expect(summary).toContain("Hair color: red");
    expect(summary).not.toContain("nonexistent_attr");
    const long = characterAppearanceSummary(
      [
        { id: "hair.color", value: "red", source: "base" },
        { id: "hair.length", value: "shoulder_length", source: "base" },
      ],
      12,
    );
    expect(long.length).toBeLessThanOrEqual(12);
  });

  it("can filter feature attributes when profile context is supplied", () => {
    const attrs: AttributeValue[] = [{ id: "wings.type", value: "membranous", source: "base" }];
    expect(characterAppearanceSummary(attrs, undefined, false, profileWith({ speciesId: "human" }))).toBe("");
    expect(characterAppearanceSummary(attrs, undefined, false, profileWith({ speciesId: "succubus" }))).toContain(
      "Wing type: membranous",
    );
  });

  it("omits apparent age — scene images lean on the avatar reference for how old a character looks", () => {
    const summary = characterAppearanceSummary([
      { id: "identity.apparent_age", value: "late_thirties", source: "base" },
      { id: "hair.color", value: "red", source: "base" },
    ]);
    expect(summary).toContain("Hair color: red");
    expect(summary).not.toContain("late thirties");
    expect(summary).not.toContain("Apparent age");
  });

  it("never leaks an excludeFromPrompts attribute (identity.natal_sex) — gender still renders", () => {
    const attrs: AttributeValue[] = [
      { id: "identity.gender", value: "androgynous_born_female", source: "base" },
      { id: "identity.natal_sex", value: "female", source: "base" },
      { id: "hair.color", value: "red", source: "base" },
    ];
    const summary = characterAppearanceSummary(attrs);
    expect(summary).toContain("androgynous born female"); // the gender variant does steer rendering
    expect(summary).not.toContain("Natal sex");
    // The avatar prompt (subject phrase) also carries gender but never natal sex.
    const avatar = buildAvatarPrompt("Mira", profileWith({ attributes: attrs }), "realistic");
    expect(avatar).toMatch(/Subject: Mira\b.*androgynous born female/);
    expect(avatar).not.toContain("Natal sex");
  });
});

describe("intimateSceneAppearance (exposure-gated)", () => {
  const attrs: AttributeValue[] = [
    { id: "penis.size", value: "average", source: "base" },
    { id: "breasts.size", value: "full", source: "base" },
    { id: "vulva.scent", value: "musky", source: "base" }, // sensory — never visual
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
    { id: "breasts.size", value: "full", source: "base" }, // shape
    { id: "breasts.shape", value: "round", source: "base" }, // shape
    { id: "breasts.nipples", value: "large", source: "base" }, // skin (torso)
    { id: "vulva.labia_minora", value: "protruding", source: "base" }, // untagged intimate → exposure-only
    { id: "waist.definition", value: "defined", source: "base" }, // shape
    { id: "hips.width", value: "wide", source: "base" }, // shape
    { id: "legs.build", value: "toned", source: "base" }, // shape
    { id: "legs.length", value: "long", source: "base" }, // shape
    { id: "legs.hair", value: "fine", source: "base" }, // skin (legs)
    { id: "feet.size", value: "average", source: "base" }, // shape
    { id: "feet.arch", value: "high", source: "base" }, // skin (feet)
  ];
  const profile = profileWith({ intimateRegions: ["breasts", "vulva"] });

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
      { id: "skin.tone", value: "warm brown", source: "base" },
      { id: "lips.fullness", value: "full", source: "base" },
      { id: "eyes.color", value: "hazel", source: "base" },
      { id: "build.height", value: 170, source: "base" }, // not identity-critical — excluded
      { id: "presentation.grooming", value: "polished", source: "base" }, // not identity-critical — excluded
    ]);
    expect(summary).toContain("warm brown");
    expect(summary).toContain("full");
    expect(summary).toContain("hazel");
    expect(summary).not.toContain("170");
    expect(summary).not.toContain("polished");
    expect(identityAnchorSummary([{ id: "build.height", value: 170, source: "base" }])).toBe("");
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

describe("buildSceneRenderPrompt — multi-reference (Venice /image/multi-edit)", () => {
  const plan = {
    ...emptySceneRenderPlan(),
    focal: { name: "Mira", action: "leaning close", outfitSummary: "red dress", appearance: "Hair color: red" },
    others: [
      { name: "Sayed", action: "beside her", outfitSummary: "wool coat", appearance: "Hair color: black" },
      { name: "Wren", action: "in the doorway", outfitSummary: "apron", appearance: "Hair color: brown" },
    ],
    setting: "a rain-streaked library",
  };

  it("identity-locks every referenced person, enumerates the references, and stays under the Venice limit", () => {
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
    expect(prompt.length).toBeLessThanOrEqual(VENICE_RENDER_PROMPT_LIMIT);
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

  it("dedupes the focal out of others and yields a null focal for an empty room", () => {
    const dup = resolveScenePlan(
      sceneSpecSchema.parse({ focalCharacter: "Mira", others: [{ name: "mira", action: "again" }] }),
      libraryContext,
    );
    expect(dup.others).toEqual([]);
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
    expect(SCENE_POV_RULE).toContain("NEVER be visible");
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

  // Venice's edit endpoint hard-rejects >1500 chars (followups.phase3.md §6).
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

  it("keeps the Venice edit prompt within the 1500-char limit, preserving the lock + POV", () => {
    const prompt = buildSceneRenderPrompt(bigPlan, { referenceName: "Enid" });
    expect(prompt.length).toBeLessThanOrEqual(VENICE_RENDER_PROMPT_LIMIT);
    expect(prompt.startsWith(PORTRAIT_IDENTITY_LOCK)).toBe(true);
    expect(prompt).toContain(SCENE_POV_RULE);
    expect(prompt).toContain("Wearing:");
    expect(prompt).toContain("add no garment that is not listed");
  });

  it("does not budget the text-to-image path (Venice t2i has no such cap)", () => {
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

  // THE property that makes this slice safe to land: every caller passes no parts today,
  // so not one rendered image changes. If this breaks, the default path regressed.
  it("is byte-identical to the old constant with no viewer parts", () => {
    expect(sceneFramingRule({})).toBe(SCENE_POV_RULE);
    expect(sceneFramingRule({ parts: [] })).toBe(SCENE_POV_RULE);
    expect(sceneFramingRule({ parts: [], subjects: ["Mira"] })).toBe(SCENE_POV_RULE);
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

  // The framing rule is never-dropped tier: budgetVenicePrompt shrinks outfit/setting text
  // to fit Venice's 1500-char cap, and must not eat the thing that stops a second person
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
    expect(prompt.length).toBeLessThanOrEqual(VENICE_RENDER_PROMPT_LIMIT);
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
