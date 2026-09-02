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
import {
  sceneCameraHeightIds,
  sceneCameraHeights,
  sceneShotDistanceIds,
  sceneShotDistances,
} from "@/contracts/images/scene-camera";
import { sceneStagingList } from "@/contracts/images/scene-staging";
import { attr, makeProfile } from "@/server/test-support";
import { apparentAgeAnchor, imageAgeWord } from "./prompts-appearance";
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
  scrubBlush,
  scrubPlayerFromAction,
} from "./prompts-scene-plan";
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

  // The bench kind renders whatever the owner types, INCLUDING undress, so a
  // sentence pinning the reference's clothes would contradict the instruction the
  // render exists to test. It states the sheet's anatomy instead, and still
  // anchors the age. Kills the obvious defect: a kind added to the tuple that
  // silently inherits the outfit lock, or an anatomy line that stops travelling.
  it("nsfw_test states the sheet's anatomy, keeps the age anchor, and never mentions the outfit", () => {
    const prompt = buildVariantInstruction("nsfw_test", "lying back across the bed", {
      ageAnchor: "She appears to be in her late twenties.",
      anatomy: "Breast size: full; Nipples: large",
    });
    expect(prompt).toContain("Restage the subject: lying back across the bed.");
    expect(prompt).toContain("Anatomy: Breast size: full; Nipples: large.");
    expect(prompt).toContain("late twenties");
    expect(prompt).not.toContain("outfit");
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
};

const sayed: ScenePresentCharacter = {
  name: "Sayed",
  activity: "shelving books",
  wornVisible: [{ name: "wool coat", visibility: "visible" }],
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

describe("the composer's camera and staging rules (scene-composition slices 1–2)", () => {
  it("states the camera menu, its default, and the quote requirement in BOTH lanes", () => {
    for (const system of [sceneComposerSystem(false), sceneComposerSystem(true)]) {
      expect(system).toContain('"toward_viewer", "three_quarter", "profile", "away_glance_back", "away"');
      // Distance and height are stated as `"id" (what it means)` — the menu is still every
      // id, in registry order, and the definitions are asserted below.
      for (const id of sceneShotDistanceIds) expect(system).toContain(`"${id}" (`);
      for (const id of sceneCameraHeightIds) expect(system).toContain(`"${id}" (`);
      expect(system).toContain("MUST carry camera.evidence");
      expect(system).toContain("copied EXACTLY, word for word, from the recent narration or the player's own words");
      expect(system).toContain("Distance never needs a quote");
    }
  });

  it("teaches away-means-fully-away and gates the glance on its own quote (owner ruling 2026-08-10)", () => {
    expect(SCENE_COMPOSER_SYSTEM).toContain("away means fully away");
    expect(SCENE_COMPOSER_SYSTEM).toContain(
      'Propose "away_glance_back" ONLY when the history actually describes her looking or glancing back',
    );
    expect(SCENE_COMPOSER_SYSTEM).toContain("the quote must be that glance itself, not the behind-position");
  });

  it("makes the gaze translation orientation-aware in both rule sets", () => {
    for (const system of [sceneComposerSystem(false), sceneComposerSystem(true)]) {
      expect(system).toContain('become "toward the viewer"');
      expect(system).toContain('"glancing back over her shoulder toward the viewer" instead');
    }
  });

  it("offers staging only to the embodied lane, as ids plus a quote and never as prose", () => {
    const embodied = sceneComposerSystem(true);
    expect(embodied).toContain("- staging:");
    expect(embodied).toContain("held_from_behind");
    expect(embodied).toContain("pressed_to_wall_away");
    expect(embodied).toContain("You never write the configuration out in words");
    expect(sceneComposerSystem(false)).not.toContain("staging");
  });

  it("describes every staging id rather than listing bare ids", () => {
    const embodied = sceneComposerSystem(true);
    for (const entry of sceneStagingList) {
      expect(embodied, entry.id).toContain(`${entry.id} — ${entry.hint}`);
    }
  });

  it("never shows the composer a render template — the registry owns those words, not the model", () => {
    const embodied = sceneComposerSystem(true);
    for (const entry of sceneStagingList) {
      expect(embodied, entry.id).not.toContain(entry.template);
    }
  });

  it("tells the composer to quote the detail that separates sibling variants", () => {
    const embodied = sceneComposerSystem(true);
    // The rule that makes `kneeling_before_viewer_guided` reachable: quoting "she kneels"
    // grounds the act both entries share and settles nothing between them.
    expect(embodied).toContain("differ by one detail");
    expect(embodied).toContain("quote the hand on her head");
    expect(embodied).toContain("pick the plainer entry");
  });

  it("defines the camera vocabulary instead of naming it, in both lanes", () => {
    for (const system of [sceneComposerSystem(false), sceneComposerSystem(true)]) {
      for (const entry of [...sceneShotDistances, ...sceneCameraHeights]) {
        expect(system, entry.id).toContain(`"${entry.id}" (${entry.hint})`);
      }
      // Distance is the axis every arm missed in the 2026-08-15 A/B, in both directions.
      expect(system).toContain("NOT how near the viewer is standing");
    }
  });
});

describe("the composer's new context inputs (scene-composition slices 1+3)", () => {
  it("adds nothing at all when neither input is supplied — the byte-identical pin", () => {
    expect(buildSceneComposerPrompt(libraryContext)).not.toContain("The player's own words");
    expect(buildSceneComposerPrompt(libraryContext)).not.toContain("Committed scene facts");
  });

  it("quotes the NEWEST player message only, labeled as theirs and excerpted", () => {
    const prompt = buildSceneComposerPrompt({
      ...libraryContext,
      recentPlayerMessages: ["older words entirely", "z".repeat(2000)],
    });
    expect(prompt).toContain("The player's own words (their stated position and actions):");
    expect(prompt).not.toContain("older words entirely");
    const zRun = prompt.match(/z{10,}/)?.[0] ?? "";
    expect(zRun.length).toBeGreaterThan(0);
    expect(zRun.length).toBeLessThanOrEqual(RECENT_PLAYER_MESSAGE_CHARS);
  });

  it("states committed facts as authoritative, before the narration they outrank", () => {
    const prompt = buildSceneComposerPrompt({
      ...libraryContext,
      committedScene: new Map([["mira", { facing: "away", focalPosture: "standing", proximity: "touching" }]]),
    });
    expect(prompt).toContain("Committed scene facts (authoritative");
    expect(prompt).toContain("outrank anything the narration implies");
    expect(prompt).toContain("Mira faces away from the player; Mira is standing; they are touching.");
    expect(prompt.indexOf("Committed scene facts")).toBeLessThan(prompt.indexOf("Recent narration"));
    // A present character the scene knows nothing about contributes no line.
    expect(prompt).not.toContain("Sayed faces");
  });

  it("adds no header when the map holds nothing for anyone present", () => {
    const prompt = buildSceneComposerPrompt({ ...libraryContext, committedScene: new Map([["lyra", { facing: "away" }]]) });
    expect(prompt).not.toContain("Committed scene facts");
  });
});

describe("sceneEvidenceCorpus", () => {
  it("is narration AND the player's own messages — every one of them, not just the prompted newest", () => {
    expect(
      sceneEvidenceCorpus({ recentNarration: ["a", "  "], recentPlayerMessages: ["b", "c"] }),
    ).toEqual(["a", "b", "c"]);
    expect(sceneEvidenceCorpus({})).toEqual([]);
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

  // Degenerate case: nothing survives. The lowering states no pose fact for an
  // empty field, so the claim is simply absent — a missing pose beats a painted one.
  it("returns empty when every clause is a colour word", () => {
    expect(scrubBlush("flushed, blushing")).toBe("");
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

  // The composer runs allowIntimate:false whatever model its seam picks and has no
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

  it("keeps EVERY rule of the embodied set, the contact rule that spends viewerBody included", () => {
    // A two-name destructure once dropped this third rule on the floor: the lane was handed
    // a `viewerBody` vocabulary and never told it may name contact with the player at all.
    expect(sceneComposerSystem(true)).toContain("- pose/activity may now name contact with the player");
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

  it("slots into the variant instruction between the lock and the change", () => {
    const prompt = buildVariantInstruction("pose", "leaning on a railing", {
      ageAnchor: "Kristin is in her late twenties.",
    });
    expect(prompt).toContain("apparent age. Kristin is in her late twenties. Change the pose");
    expect(buildVariantInstruction("pose", "leaning on a railing")).not.toContain("late twenties");
  });
});
