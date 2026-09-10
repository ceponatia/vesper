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
  mentionsLimb,
  resolveScenePlan,
  scrubBlush,
  scrubPlayerFromAction,
  viewerGazeToCamera,
} from "./prompts-scene-plan";


/**
 * A character-SHEET attribute: every fixture in this file is `source: "base"`,
 * because the image path reads the authored sheet, not a chat overlay. The id is
 * the contract's template type, so a typo is a compile error.
 */
const baseAttr = (id: AttributeValue["id"], value: AttributeValue["value"]): AttributeValue =>
  attr(id, value, "base");

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
    expect(SCENE_COMPOSER_SYSTEM).toContain('become "toward the camera"');
    expect(SCENE_COMPOSER_SYSTEM).toContain("keep the expression and energy, lose the contact");
    // The worked example (the reported gallery beat) shows the translation shape.
    expect(SCENE_COMPOSER_SYSTEM).toContain('pose "glancing back toward the camera, mid-laugh"');
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

  it("makes the gaze translation orientation-aware in both rule sets, and aims it at the camera", () => {
    // The target is the LENS, on both lanes (#544 D3): the viewer is the one
    // thing the picture may not contain, so naming them as the thing she looks
    // at hands the model a second person to place across the room. The embodied
    // lane keeps "the viewer" for CONTACT alone, which is asserted below.
    for (const system of [sceneComposerSystem(false), sceneComposerSystem(true)]) {
      expect(system).toContain('become "toward the camera"');
      expect(system).toContain('"glancing back over her shoulder toward the camera" instead');
      expect(system).not.toContain('become "toward the viewer"');
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
    // "beside the player" / "leading the player" clauses drop; the gaze rewrites
    // to the CAMERA, because this shot holds no viewer to look at (#544 F3).
    expect(plan.focal?.action).not.toMatch(/\bplayer\b/i);
    expect(plan.focal?.action).not.toMatch(/\bviewer\b/i);
    expect(plan.focal?.action).toContain("head turned slightly toward the camera with a bright");
    expect(plan.focal?.action).toContain("heels clicking on the pale stone floor");
    expect(plan.focal?.action).not.toContain("Walking beside");
  });
});

describe("scrubPlayerFromAction (deterministic backstop)", () => {
  it("returns clean text unchanged (identity — no rejoin churn on the common case)", () => {
    const clean = "seated by the window, one leg crossed; flipping a page";
    expect(scrubPlayerFromAction(clean)).toBe(clean);
  });

  it("rewrites gaze toward the player to the camera, drops contact/proximity clauses", () => {
    expect(scrubPlayerFromAction("glancing at the player, mid-laugh")).toBe("glancing at the camera, mid-laugh");
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

  /**
   * Expression belongs to pose, mood is atmosphere (#544 D9/F9).
   *
   * The reported prompt carried both halves of one beat: the composer's own
   * "a small smile playing at her lips" and, five sentences later, "The mood is
   * nervous, curious, with a hint of playful tension." — the emotional label the
   * smile already showed. The lowering withholds the label where a pose or
   * activity carries the moment (`scene-lowering.ts`), and this is the rule that
   * stops the composer writing the label in the first place.
   */
  it("tells both lanes that pose shows the expression and mood is atmosphere alone", () => {
    for (const system of [sceneComposerSystem(false), sceneComposerSystem(true)]) {
      expect(system).toContain("Feeling is SHOWN, never labelled");
      expect(system).toContain("pose carries the character's visible expression");
      expect(system).toContain("mood is ATMOSPHERE only");
      expect(system).toContain("never name in mood a feeling pose has already shown");
    }
  });

  /**
   * The one place "the viewer" survives: CONTACT with a part the shot actually
   * holds. Gaze moved to the camera on both lanes (#544 F3) and contact did not,
   * because an embodied frame really does contain the viewer's own hands and the
   * possessive wording is what stops them reading as a third person's.
   */
  it("keeps the viewer as a contact noun on the embodied lane, and as nothing else", () => {
    const embodied = sceneComposerSystem(true);
    expect(embodied).toContain("her hand closing over the viewer's forearm");
    expect(embodied).toContain('eyes and head go to "the camera" or "the lens"');
    // The disembodied lane has no viewer to touch, and says so.
    expect(SCENE_COMPOSER_SYSTEM).toContain('Do not name "the viewer" either');
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

  /**
   * The gaze target follows embodiment (#544 F3). An embodied shot has the
   * viewer's own body in frame and "the viewer" is the measured contact wording;
   * a disembodied one has nobody there, so the same beat aims at the lens.
   */
  it("aims the gaze at the viewer only where the viewer has a body", () => {
    expect(scrubPlayerFromAction("head turned toward the player", { embodied: true })).toBe(
      "head turned toward the viewer",
    );
    expect(scrubPlayerFromAction("head turned toward the player")).toBe("head turned toward the camera");
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

/**
 * THE CAMERA BACKSTOP (issue #544 D3/F3).
 *
 * A shot with no viewer part in frame asserts, in the same prompt, that the
 * viewer is never visible — and the reported prompt then said "her attention
 * fixed on the viewer across the room" and "as she catches the viewer's eye".
 * That is a person standing in the room the picture is forbidden to contain, and
 * the model resolves the contradiction by painting them.
 *
 * The composer is ruled against it; this is the deterministic half, in the same
 * belt-and-braces shape as `scrubBlush` and `bindLimbsToOwner`. Aim the gaze at
 * the thing that IS there and drop whole any clause naming a viewer the rewrite
 * could not aim.
 */
describe("viewerGazeToCamera (deterministic backstop)", () => {
  it("returns clean text unchanged (identity — no rejoin churn on the common case)", () => {
    const clean = "seated by the window, one leg crossed; flipping a page";
    expect(viewerGazeToCamera(clean)).toBe(clean);
  });

  it("aims every gaze preposition at the lens", () => {
    expect(viewerGazeToCamera("her attention fixed on the viewer across the room")).toBe(
      "her attention fixed on the camera across the room",
    );
    expect(viewerGazeToCamera("turned slightly toward the viewer")).toBe("turned slightly toward the camera");
    expect(viewerGazeToCamera("looking directly into the viewer")).toBe("looking directly into the lens");
  });

  it("rewrites the possessive spelling of the same beat", () => {
    expect(viewerGazeToCamera("as she catches the viewer's eye")).toBe("as she catches the camera");
  });

  it("drops whole any clause naming a viewer the rewrite could not aim", () => {
    expect(viewerGazeToCamera("the viewer stands across the room, a small smile at her lips")).toBe(
      "a small smile at her lips",
    );
  });

  it("is idempotent — text already aimed at the camera passes through", () => {
    const aimed = "turned slightly toward the camera, a small smile at her lips";
    expect(viewerGazeToCamera(aimed)).toBe(aimed);
    expect(viewerGazeToCamera(viewerGazeToCamera("turned slightly toward the viewer"))).toBe(
      "turned slightly toward the camera",
    );
  });
});

/**
 * The plan is where the backstop is spent, and embodiment is what decides
 * whether it runs: with the viewer's own body in frame, "the viewer's own
 * forearm" is the measured contact wording and rewriting it would un-say the
 * geometry the arrangement is built on.
 */
describe("the resolved plan's viewer wording", () => {
  const present: ScenePresentCharacter = { name: "Mira", wornVisible: [] };
  const narration = ["Mira leans in; her cheek comes to rest against your palm, and she holds your eye."];
  const ctx = (over: Partial<SceneComposerContext> = {}): SceneComposerContext => ({
    present: [present],
    recentNarration: narration,
    ...over,
  });
  const spec = (pose: string) => ({ ...emptySceneSpec(), focalCharacter: "Mira", pose });

  it("names no viewer anywhere in a disembodied plan's action text", () => {
    const plan = resolveScenePlan(
      spec("her attention fixed on the viewer across the room, as she catches the viewer's eye"),
      ctx(),
    );
    expect(plan.focal?.action).not.toMatch(/\bviewer\b/i);
    expect(plan.focal?.action).toContain("the camera");
  });

  it("keeps the viewer's own body in an embodied plan", () => {
    const plan = resolveScenePlan(
      {
        ...spec("her hand closing over the viewer's forearm"),
        viewerBody: ["hands"],
        viewerBodyEvidence: [{ part: "hands", quote: "her cheek comes to rest against your palm" }],
      },
      ctx({ embodiedViewer: true }),
    );
    expect(plan.viewerBody).toEqual(["hands"]);
    expect(plan.focal?.action).toContain("the viewer's forearm");
  });
});

/**
 * The limb vocabulary is read by two backstops that must not drift: the binder
 * rewrites a bare limb to a possessive one, and the scene lowering arms the
 * total-possession clause only where a limb is actually named (#544 F3). Wider
 * than the binder's own pattern by design — the binder runs first, so by the
 * time anything downstream reads the text every bare limb is already possessive.
 */
describe("mentionsLimb", () => {
  it.each([
    "Mira's hand raising the cup",
    "both of Mira's hands wrapped around the mug",
    "one foot tucked under her",
    "her knee drawn up",
  ])("finds the limb in %j", (text) => {
    expect(mentionsLimb(text)).toBe(true);
  });

  it.each([
    "settling into the chair",
    "keeping the tray at an arm's length",
    "leaning on a hand-carved rail",
    "a small smile playing at her lips",
  ])("finds none in %j", (text) => {
    expect(mentionsLimb(text)).toBe(false);
  });
});
