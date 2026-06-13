import { describe, expect, it } from "vitest";
import { DiagnosticCollector } from "@/contracts/diagnostics";
import { emptyCharacterProfile, type CharacterProfile } from "@/contracts/world/profile";
import {
  buildAvatarPrompt,
  buildSceneComposerPrompt,
  buildSceneRenderPrompt,
  buildVariantInstruction,
  characterAppearanceSummary,
  emptySceneRenderPlan,
  emptySceneSpec,
  heuristicFocalName,
  PORTRAIT_IDENTITY_LOCK,
  RECENT_NARRATION_LATEST_CHARS,
  RECENT_NARRATION_PRIOR_CHARS,
  resolveScenePlan,
  SCENE_COMPOSER_SYSTEM,
  SCENE_POV_RULE,
  sceneSpecSchema,
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

  it("composes registry labels and humanized values", () => {
    const prompt = buildAvatarPrompt("Mira", profile, "realistic");
    expect(prompt).toContain("Subject: Mira.");
    expect(prompt).toContain("Hair color: red");
    expect(prompt).toContain("Hair length: shoulder length");
    expect(prompt).toContain("wandering cartographer");
  });

  it("includes registry promptHints for present attributes", () => {
    const prompt = buildAvatarPrompt("Mira", profile, "realistic");
    expect(prompt).toContain("apparent age as an impression");
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

  it("treats the default outfit as authoritative clothing when provided", () => {
    const prompt = buildAvatarPrompt("Mira", profile, "realistic", [
      { name: "Black abaya", appearance: "flowing black fabric" },
      { name: "Hijab" },
    ]);
    expect(prompt).toContain("Wearing (authoritative — depict exactly this clothing): Black abaya (flowing black fabric); Hijab.");
  });

  it("prefers the garment description over its name and never truncates clothing detail", () => {
    const longAppearance = "deep crimson silk shot through with gold thread ".repeat(8).trim();
    const prompt = buildAvatarPrompt("Mira", profile, "realistic", [
      { name: "Coat", description: "a heavy charcoal wool overcoat with a fur collar", appearance: longAppearance },
      { name: "Brooch" }, // no description — falls back to the name
    ]);
    expect(prompt).toContain(`a heavy charcoal wool overcoat with a fur collar (${longAppearance})`);
    expect(prompt).toContain("Brooch");
    expect(prompt).not.toContain("…"); // appearance is passed whole, not excerpted
  });

  it("omits the wearing line without an outfit", () => {
    expect(buildAvatarPrompt("Mira", profile, "realistic")).not.toContain("Wearing");
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
    expect(prompt).toContain("Change the pose: leaning against a railing.");
    expect(prompt).toContain("Keep the same outfit as the reference image.");
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
    expect(prompt).toContain("- Mira — activity: reading; posture: curled in an armchair; visible wardrobe (authoritative): linen shirt; silk camisole (hinted beneath sheer layers)");
    expect(prompt).toContain("- Sayed — activity: shelving books; visible wardrobe (authoritative): wool coat");
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
    expect(prompt).toContain("visible wardrobe (authoritative): a pale linen shirt (rumpled); silk camisole (hinted beneath sheer layers)");
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
    expect(prompt).toContain("Pose: seated by the window.");
    expect(prompt).toContain("Wearing: linen shirt.");
    expect(prompt).not.toContain("Subject: Mira");
    expect(prompt).toContain("Also in frame: Sayed — Hair color: black; wearing wool coat; shelving books.");
  });

  it("fallback reference on another present NPC keeps the focal textual", () => {
    const prompt = buildSceneRenderPrompt(plan, { referenceName: "Sayed" });
    expect(prompt.startsWith(PORTRAIT_IDENTITY_LOCK)).toBe(true);
    expect(prompt).toContain("Pose: shelving books.");
    expect(prompt).toContain("Wearing: wool coat.");
    expect(prompt).toContain("Also in frame: Mira — Hair color: red; wearing linen shirt; seated by the window.");
  });

  it("text-to-image names the focal as subject; an empty reference outfit keeps the reference outfit", () => {
    const prompt = buildSceneRenderPrompt(plan);
    expect(prompt).not.toContain(PORTRAIT_IDENTITY_LOCK);
    expect(prompt).toContain("Subject: Mira — Hair color: red; wearing linen shirt; seated by the window.");
    const bare = buildSceneRenderPrompt(
      { ...plan, focal: { ...plan.focal, outfitSummary: "" } },
      { referenceName: "Mira" },
    );
    expect(bare).toContain("Keep the same outfit as the reference image.");
  });

  it("renders a location-only POV shot when nobody is present", () => {
    const prompt = buildSceneRenderPrompt({ ...emptySceneRenderPlan(), setting: "an empty atrium at dusk" });
    expect(prompt).toContain(SCENE_POV_RULE);
    expect(prompt).toContain("No people in frame");
    expect(prompt).toContain("Setting: an empty atrium at dusk.");
    expect(prompt).not.toContain(PORTRAIT_IDENTITY_LOCK);
  });
});
