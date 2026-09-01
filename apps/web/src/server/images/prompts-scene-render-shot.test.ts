import { describe, expect, it } from "vitest";
import {
  DEFAULT_SCENE_CAMERA,
  sceneCameraHeightById,
  sceneCameraHeightIds,
  sceneShotDistanceById,
  sceneShotDistanceIds,
  sceneSubjectOrientationById,
  sceneSubjectOrientationIds,
  type SceneCameraSpec,
} from "@/contracts/images/scene-camera";
import { sceneStagingById, sceneStagingList, type SceneStagingId } from "@/contracts/images/scene-staging";
import { viewerBodyPartById } from "@/contracts/images/viewer-body";
import { emptySceneRenderPlan, type SceneRenderPlan } from "./prompts-scene-plan";
import {
  buildSceneRenderPrompt,
  EDIT_RENDER_PROMPT_LIMIT,
  SCENE_POV_RULE,
  SELFIE_FRAMING,
  type SceneMultiReference,
} from "./prompts-scene-render";
import { PORTRAIT_IDENTITY_LOCK } from "./prompts-variant";

/**
 * The shot line, the staged act, and the identity lock's adaptation to a face the camera
 * cannot see (the emission half).
 *
 * The pin the whole slice was accepted on is the FIRST test here: a default camera changes
 * no byte of any prompt. Everything else in this file describes what a prompt gains once
 * evidence actually moved the camera.
 */

const NUDE = { torso: "bare", pelvis: "bare", legs: "bare", feet: "bare" } as const;
const TROUSERED = { torso: "bare", pelvis: "covered", legs: "covered", feet: "bare" } as const;

const camera = (over: Partial<SceneCameraSpec> = {}): SceneCameraSpec => ({ ...DEFAULT_SCENE_CAMERA, ...over });

/** Every camera and staging phrase is a `{name}` template; the focal is Mira throughout. */
const bound = (template: string): string => template.replaceAll("{name}", "Mira");

const planWith = (over: Partial<SceneRenderPlan> = {}): SceneRenderPlan => ({
  ...emptySceneRenderPlan(),
  focal: { name: "Mira", action: "seated by the window", outfitSummary: "linen shirt", appearance: "Hair color: red" },
  setting: "a rain-streaked library",
  ...over,
});

/**
 * A plan as `resolveScenePlan` hands it over once a staging survived: the staging's own
 * camera has OVERWRITTEN the composer's, and its `viewerParts` are unioned into
 * `viewerBody` (where the per-prompt coverage/route gate still gets its say).
 */
const stagedPlan = (id: SceneStagingId, over: Partial<SceneRenderPlan> = {}): SceneRenderPlan => {
  const staging = sceneStagingById(id);
  if (!staging) throw new Error(`no staging ${id}`);
  return planWith({
    staging,
    camera: staging.camera,
    viewerBody: [...staging.viewerParts],
    playerExposure: NUDE,
    ...over,
  });
};

const stagingSentence = (id: SceneStagingId): string => bound(sceneStagingById(id)?.template ?? "");

const CHARACTER_REF: SceneMultiReference[] = [
  { name: "Mira", kind: "character" },
  { name: "The Library", kind: "location" },
];

describe("the shot line (scene-composition slice 1)", () => {
  // THE no-regression anchor. The front-facing default is the fallback for every
  // degradation in the resolution chain — an unknown id, an ungrounded quote, a lane with
  // no evidence at all — so it has to cost exactly nothing.
  it("emits nothing at all for the default camera, byte for byte", () => {
    const expected = [
      PORTRAIT_IDENTITY_LOCK,
      `${SCENE_POV_RULE} Exactly one person is fully in frame: Mira. Nobody else appears. Every visible body part belongs to Mira.`,
      "Pose: seated by the window.",
      "Wearing: linen shirt.",
      "Depict only the clothing described; add no garment that is not listed.",
      "Setting: a rain-streaked library.",
      "Lighting: soft natural light.",
      "Mood: calm.",
      "High quality, no text, no watermark.",
    ].join(" ");
    expect(buildSceneRenderPrompt(planWith(), { referenceName: "Mira" })).toBe(expected);
  });

  it("says nothing on any route while the camera is where it has always been", () => {
    const plan = planWith();
    expect(buildSceneRenderPrompt(plan, { referenceName: "Mira" })).not.toContain("Shot:");
    expect(buildSceneRenderPrompt(plan)).not.toContain("Shot:");
    expect(buildSceneRenderPrompt(plan, { multiReferences: CHARACTER_REF })).not.toContain("Shot:");
  });

  it("states each non-default orientation, name-bound", () => {
    for (const id of sceneSubjectOrientationIds) {
      const entry = sceneSubjectOrientationById(id);
      const prompt = buildSceneRenderPrompt(planWith({ camera: camera({ orientation: id }) }), {
        referenceName: "Mira",
      });
      if (id === DEFAULT_SCENE_CAMERA.orientation) expect(prompt).not.toContain("Shot:");
      else expect(prompt).toContain(`Shot: ${bound(entry?.phrase ?? "")}.`);
    }
  });

  it("states each non-default distance and camera height", () => {
    for (const id of sceneShotDistanceIds) {
      const prompt = buildSceneRenderPrompt(planWith({ camera: camera({ distance: id }) }), { referenceName: "Mira" });
      if (id === DEFAULT_SCENE_CAMERA.distance) expect(prompt).not.toContain("Shot:");
      else expect(prompt).toContain(`Shot: ${bound(sceneShotDistanceById(id)?.phrase ?? "")}.`);
    }
    for (const id of sceneCameraHeightIds) {
      const prompt = buildSceneRenderPrompt(planWith({ camera: camera({ height: id }) }), { referenceName: "Mira" });
      if (id === DEFAULT_SCENE_CAMERA.height) expect(prompt).not.toContain("Shot:");
      else expect(prompt).toContain(`Shot: ${bound(sceneCameraHeightById(id)?.phrase ?? "")}.`);
    }
  });

  // Only what moved is named: a default distance stated alongside a moved orientation
  // steers nothing and spends budget.
  it("joins only the components that left their default, orientation first", () => {
    const moved = buildSceneRenderPrompt(planWith({ camera: { orientation: "away", distance: "close", height: "high" } }), {
      referenceName: "Mira",
    });
    expect(moved).toContain(
      `Shot: ${bound(sceneSubjectOrientationById("away")?.phrase ?? "")}; ${bound(
        sceneShotDistanceById("close")?.phrase ?? "",
      )}; ${bound(sceneCameraHeightById("high")?.phrase ?? "")}.`,
    );
    const partial = buildSceneRenderPrompt(planWith({ camera: camera({ orientation: "profile", height: "low" }) }), {
      referenceName: "Mira",
    });
    expect(partial).toContain(
      `Shot: ${bound(sceneSubjectOrientationById("profile")?.phrase ?? "")}; ${bound(
        sceneCameraHeightById("low")?.phrase ?? "",
      )}.`,
    );
    expect(partial).not.toContain("head and torso in the frame"); // the default distance
  });

  it("rides every non-selfie route and follows the framing rule", () => {
    const plan = planWith({ camera: camera({ orientation: "away" }) });
    const away = bound(sceneSubjectOrientationById("away")?.phrase ?? "");
    for (const prompt of [
      buildSceneRenderPrompt(plan, { referenceName: "Mira" }),
      buildSceneRenderPrompt(plan),
      buildSceneRenderPrompt(plan, { multiReferences: CHARACTER_REF }),
    ]) {
      expect(prompt).toContain(`Shot: ${away}.`);
      // The POV rule says whose eyes these are; the shot says where they stand — in that order.
      expect(prompt.indexOf("Shot:")).toBeGreaterThan(prompt.indexOf("fully in frame"));
    }
  });

  // A selfie's camera is the subject's own, held at arm's length — there is no viewer
  // standing anywhere for a shot line to describe.
  it("never states a shot on a selfie", () => {
    const prompt = buildSceneRenderPrompt(planWith({ camera: camera({ orientation: "away", height: "low" }) }), {
      referenceName: "Mira",
      framing: "selfie",
    });
    expect(prompt).toContain(SELFIE_FRAMING);
    expect(prompt).not.toContain("Shot:");
  });

  // Orientation is a fact about a SUBJECT (owner ruling 2026-08-10, focal-only). An empty
  // room has nobody to face anywhere.
  it("never states a shot for a location-only render", () => {
    const prompt = buildSceneRenderPrompt(
      { ...emptySceneRenderPlan(), setting: "an empty atrium at dusk", camera: camera({ orientation: "away" }) },
    );
    expect(prompt).toContain("No people in frame");
    expect(prompt).not.toContain("Shot:");
  });
});

describe("the staged act (scene-composition slice 2)", () => {
  it("leads the pose, with the composer's own text following", () => {
    const prompt = buildSceneRenderPrompt(stagedPlan("on_all_fours"), {
      referenceName: "Mira",
      allowIntimate: true,
    });
    expect(prompt).toContain(`Pose: ${stagingSentence("on_all_fours")}; seated by the window.`);
  });

  it("stands alone when the composer wrote no pose at all", () => {
    const plan = stagedPlan("on_all_fours");
    const bare = { ...plan, focal: plan.focal ? { ...plan.focal, action: "" } : null };
    const prompt = buildSceneRenderPrompt(bare, { referenceName: "Mira", allowIntimate: true });
    expect(prompt).toContain(`Pose: ${stagingSentence("on_all_fours")}.`);
  });

  // Route gating is per-prompt, exactly like `intimateAppearance`: one resolved plan feeds
  // the uncensored edit AND the moderated text-to-image fallback.
  it("emits an intimate staging only on the uncensored route", () => {
    const plan = stagedPlan("on_all_fours");
    expect(buildSceneRenderPrompt(plan, { referenceName: "Mira", allowIntimate: true })).toContain(
      stagingSentence("on_all_fours"),
    );
    expect(buildSceneRenderPrompt(plan, { referenceName: "Mira" })).not.toContain("on all fours");
    // The composer's cautious pose stands alone there, as today.
    expect(buildSceneRenderPrompt(plan, { referenceName: "Mira" })).toContain("Pose: seated by the window.");
  });

  it("emits a clothed staging on a moderated route", () => {
    const prompt = buildSceneRenderPrompt(stagedPlan("lying_face_down"), { referenceName: "Mira" });
    expect(prompt).toContain(stagingSentence("lying_face_down"));
  });

  // The leak-proofing gate. A template names the viewer's anatomy in its own words, so it
  // must not survive a prompt where `resolveViewerParts` refused that part.
  it("does not emit when a part it names is gated out by the player's coverage", () => {
    const trousered = stagedPlan("kneeling_before_viewer", { playerExposure: TROUSERED });
    const prompt = buildSceneRenderPrompt(trousered, { referenceName: "Mira", allowIntimate: true });
    expect(prompt).not.toContain("mouth on the viewer's own genitals");
    expect(prompt).toContain("Pose: seated by the window.");
  });

  it("does not emit when the route refuses the part it names", () => {
    const prompt = buildSceneRenderPrompt(stagedPlan("kneeling_before_viewer"), { referenceName: "Mira" });
    expect(prompt).not.toContain("mouth on the viewer's own genitals");
    expect(prompt).toContain("Pose: seated by the window.");
  });

  it("never stages a selfie", () => {
    const prompt = buildSceneRenderPrompt(stagedPlan("lying_face_down"), {
      referenceName: "Mira",
      framing: "selfie",
      allowIntimate: true,
    });
    expect(prompt).toContain(SELFIE_FRAMING);
    expect(prompt).not.toContain("lying face down");
  });

  it("stages a textual focal and a multi-reference focal too", () => {
    const plan = stagedPlan("lying_face_down");
    expect(buildSceneRenderPrompt(plan)).toContain(stagingSentence("lying_face_down"));
    expect(buildSceneRenderPrompt(plan, { multiReferences: CHARACTER_REF })).toContain(
      stagingSentence("lying_face_down"),
    );
  });
});

describe("staged geometry versus the generic viewer-body framing", () => {
  const HANDS = viewerBodyPartById("hands")?.framing ?? "";
  const FOREARMS = viewerBodyPartById("forearms")?.framing ?? "";

  // Two true statements about the same two hands — one placing them on somebody, one placing
  // them at the lens — is the self-contradiction that makes a model paint a third party.
  it("drops the generic line for the parts the staging names, keeping the others", () => {
    const plan = stagedPlan("lying_face_down", { viewerBody: ["hands", "forearms"] });
    const prompt = buildSceneRenderPrompt(plan, { referenceName: "Mira" });
    expect(prompt).toContain(stagingSentence("lying_face_down"));
    expect(prompt).not.toContain(HANDS);
    expect(prompt).toContain(FOREARMS);
  });

  it("drops the whole foreground line when the staging names every part in frame", () => {
    const prompt = buildSceneRenderPrompt(stagedPlan("lying_face_down"), { referenceName: "Mira" });
    expect(prompt).not.toContain("Also in frame, in the viewer's immediate foreground");
    // Still an EMBODIED shot: the viewer's hands are on her, they are simply placed by the
    // staged sentence rather than by the registry's frame geometry.
    expect(prompt).not.toContain(SCENE_POV_RULE);
    expect(prompt).toContain("the viewer's face and head are never in frame");
    expect(prompt).toContain("Exactly one person is fully in frame: Mira.");
  });

  // The staging owns geometry, not whose body this is: the facts and the intimate anatomy
  // keep describing every surviving part.
  it("keeps the viewer's own body facts and intimate anatomy for staged parts", () => {
    const plan = stagedPlan("kneeling_before_viewer", { playerIntimateAppearance: "circumcised, average length" });
    const prompt = buildSceneRenderPrompt(plan, { referenceName: "Mira", allowIntimate: true });
    expect(prompt).toContain(stagingSentence("kneeling_before_viewer"));
    expect(prompt).toMatch(/circumcised/i);
  });

  it("leaves the generic framing untouched when no staging survived", () => {
    const plan = planWith({ viewerBody: ["hands"] });
    expect(buildSceneRenderPrompt(plan, { referenceName: "Mira" })).toContain(HANDS);
  });
});

describe("the identity lock adapted to a face the shot cannot show", () => {
  const hidden = "Mira's face is not visible in this shot;";
  const partial = "Mira's face is partly turned from the camera;";
  const noRotate = "do not rotate Mira to face the camera.";

  it("fires for a hidden face and a partial one, never for a full one", () => {
    const away = buildSceneRenderPrompt(planWith({ camera: camera({ orientation: "away" }) }), {
      referenceName: "Mira",
    });
    expect(away).toContain(hidden);
    expect(away).toContain(noRotate);

    const profile = buildSceneRenderPrompt(planWith({ camera: camera({ orientation: "profile" }) }), {
      referenceName: "Mira",
    });
    expect(profile).toContain(partial);

    for (const orientation of ["toward_viewer", "three_quarter"] as const) {
      const full = buildSceneRenderPrompt(planWith({ camera: camera({ orientation }) }), { referenceName: "Mira" });
      expect(full).not.toContain("face is not visible");
      expect(full).not.toContain("partly turned from the camera");
    }
  });

  // The lock is rewritten per model family by an EXACT-string match at the provider boundary
  // (the Qwen edit adapter's dialect quirk), so the adaptation is an appended sentence and the
  // lock itself must survive byte for byte.
  it("appends after the lock without touching a character of it", () => {
    const prompt = buildSceneRenderPrompt(planWith({ camera: camera({ orientation: "away" }) }), {
      referenceName: "Mira",
    });
    expect(prompt).toContain(PORTRAIT_IDENTITY_LOCK);
    expect(prompt.startsWith(`${PORTRAIT_IDENTITY_LOCK} Mira's face is not visible`)).toBe(true);
  });

  // The age anchor's adjacency to the lock's "preserve apparent age" clause is where the A/B
  // probe measured its effect — the adaptation goes after the pair, not between them.
  it("keeps the age anchor adjacent to the lock", () => {
    const plan = planWith({
      camera: camera({ orientation: "away" }),
      focal: { name: "Mira", action: "seated", outfitSummary: "linen shirt", appearance: "", ageAnchor: "Mira is in her thirties." },
    });
    const prompt = buildSceneRenderPrompt(plan, { referenceName: "Mira" });
    expect(prompt.startsWith(`${PORTRAIT_IDENTITY_LOCK} Mira is in her thirties. Mira's face is not visible`)).toBe(true);
  });

  // A face can hide by head angle alone: `kneeling_before_viewer_guided` is a toward_viewer
  // shot of the crown of someone's head, and only the staging knows that.
  it("lets a staging's faceVisibility override the orientation's", () => {
    const prompt = buildSceneRenderPrompt(stagedPlan("kneeling_before_viewer_guided"), {
      referenceName: "Mira",
      allowIntimate: true,
    });
    expect(sceneStagingById("kneeling_before_viewer_guided")?.camera.orientation).toBe("toward_viewer");
    expect(prompt).toContain(hidden);
    // The sibling entry without the override keeps the orientation's full visibility.
    expect(
      buildSceneRenderPrompt(stagedPlan("kneeling_before_viewer"), { referenceName: "Mira", allowIntimate: true }),
    ).not.toContain("face is not visible");
  });

  it("keeps emitting the identity anchors — the reference still owns what IS visible", () => {
    const plan = planWith({
      camera: camera({ orientation: "away" }),
      focal: { name: "Mira", action: "seated", outfitSummary: "linen shirt", appearance: "", identityAnchors: "red hair in loose waves" },
    });
    const prompt = buildSceneRenderPrompt(plan, { referenceName: "Mira" });
    expect(prompt).toContain(hidden);
    expect(prompt).toContain("Same person as the reference image");
  });

  // The adaptation is about the LOCKED face. A reference that fell back to another present
  // NPC locks that NPC, and this shot has said nothing about which way they face.
  it("does not fire when the identity-locked subject is not the focal", () => {
    const plan = planWith({
      camera: camera({ orientation: "away" }),
      others: [{ name: "Sayed", action: "shelving books", outfitSummary: "wool coat", appearance: "" }],
    });
    expect(buildSceneRenderPrompt(plan, { referenceName: "Sayed" })).not.toContain("face is not visible");
    // Nor on a text-to-image render, which has no reference face to preserve at all.
    expect(buildSceneRenderPrompt(plan)).not.toContain("face is not visible");
  });

  it("fires on the multi-reference path when the focal has a reference image", () => {
    const plan = planWith({ camera: camera({ orientation: "away" }) });
    expect(buildSceneRenderPrompt(plan, { multiReferences: CHARACTER_REF })).toContain(hidden);
    expect(buildSceneRenderPrompt(plan, { multiReferences: [{ name: "The Library", kind: "location" }] })).not.toContain(
      "face is not visible",
    );
  });

  it("never adapts a selfie", () => {
    const prompt = buildSceneRenderPrompt(planWith({ camera: camera({ orientation: "away" }) }), {
      referenceName: "Mira",
      framing: "selfie",
    });
    expect(prompt).not.toContain("face is not visible");
  });
});

describe("the shot survives the budget, and no template leaks a placeholder", () => {
  // The shot line and the staged sentence are never-dropped tier: the budgeter shrinks
  // description text instead, exactly as it does for the POV rule.
  it("keeps the shot line and staged sentence when the caps bite", () => {
    const plan = stagedPlan("on_all_fours", {
      focal: { name: "Mira", action: "seated", outfitSummary: "a ".repeat(900), appearance: "Hair color: red" },
      setting: "s ".repeat(900),
    });
    const prompt = buildSceneRenderPrompt(plan, { referenceName: "Mira", allowIntimate: true });
    expect(prompt.length).toBeLessThanOrEqual(EDIT_RENDER_PROMPT_LIMIT);
    expect(prompt).toContain("Shot:");
    expect(prompt).toContain(stagingSentence("on_all_fours"));
    expect(prompt).toContain(PORTRAIT_IDENTITY_LOCK);
  });

  // Every phrase in both registries is a `{name}` template. One unbound placeholder reaching
  // a provider is a prompt that literally asks for the word "{name}" in the picture.
  it("binds {name} everywhere, on every route and every registry entry", () => {
    const prompts: string[] = [];
    for (const orientation of sceneSubjectOrientationIds) {
      for (const distance of sceneShotDistanceIds) {
        for (const height of sceneCameraHeightIds) {
          const plan = planWith({ camera: { orientation, distance, height } });
          prompts.push(buildSceneRenderPrompt(plan, { referenceName: "Mira" }));
          prompts.push(buildSceneRenderPrompt(plan));
          prompts.push(buildSceneRenderPrompt(plan, { multiReferences: CHARACTER_REF }));
        }
      }
    }
    for (const staging of sceneStagingList) {
      const plan = stagedPlan(staging.id);
      prompts.push(buildSceneRenderPrompt(plan, { referenceName: "Mira", allowIntimate: true }));
      prompts.push(buildSceneRenderPrompt(plan, { allowIntimate: true }));
      prompts.push(buildSceneRenderPrompt(plan, { multiReferences: CHARACTER_REF, allowIntimate: true }));
    }
    for (const prompt of prompts) expect(prompt).not.toContain("{name}");
    expect(prompts.length).toBeGreaterThan(60);
  });
});
