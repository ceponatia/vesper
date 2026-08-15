import { describe, expect, it } from "vitest";
import { DiagnosticCollector } from "@/contracts/diagnostics";
import type { SceneComposerContext } from "@/server/images";
import { emptySceneSpec, sceneSpecSchema } from "@/server/images";
import {
  type ComposerExpectation,
  gradeComposer,
  isEmptySpec,
  scoreOf,
  VAGUE_SIGNATURES,
} from "./composer-model-score";

/**
 * The composer A/B's grader (`composer-model-score.ts`).
 *
 * This is the one instrument in `scripts/eval/scene-images/` that produces a NUMBER rather
 * than a picture, and that number is what a decision to move the composer off a $3/M model
 * would be argued from. So it is tested on both sides: a right answer must score 1.0, and
 * every individual failure mode must actually be caught. A grader that only ever passes is
 * indistinguishable from no grader at all, and would quietly bless whichever cheap model
 * happened to be measured.
 *
 * The fixtures here are small and local on purpose — the probe itself imports the real beats
 * from `orientation-ab.ts`, and re-importing them here would test the fixtures rather than
 * the grading.
 */

const NARRATION =
  "She crawls forward onto her hands and knees on the bed, arching her back, and your hands settle on her hips.";

const context: SceneComposerContext = {
  present: [
    {
      name: "Mira",
      wornVisible: [],
      // `on_all_fours` carries `requiresBare: ["pelvis"]`, so the subject's coverage has to
      // report it or the real gate drops the staging before any of this grading is reached.
      exposure: { torso: "covered", pelvis: "bare", legs: "bare", feet: "bare" },
      wardrobeTracked: true,
    },
  ],
  locationName: "the bedroom",
  locationDescription: "a rumpled bed, one lamp left on",
  embodiedViewer: true,
  recentNarration: [NARRATION],
  recentPlayerMessages: ["I take her hips in both hands."],
  playerExposure: { torso: "bare", pelvis: "bare", legs: "bare", feet: "bare" },
};

const expectation: ComposerExpectation = {
  focalName: "Mira",
  stagingId: "on_all_fours",
  viewerBody: ["hands"],
};

/** The right answer: grounded staging, grounded hands, concrete prose, no invented cast. */
const goodSpec = (over: Record<string, unknown> = {}) =>
  sceneSpecSchema.parse({
    focalCharacter: "Mira",
    pose: "on her hands and knees on the bed, back arched, shoulders low",
    activity: "pushing back toward the viewer, breath shallow",
    setting: "a rumpled bed, one lamp left on",
    lighting: "low lamplight",
    mood: "intent",
    viewerBody: ["hands"],
    viewerBodyEvidence: [{ part: "hands", quote: "your hands settle on her hips" }],
    staging: { id: "on_all_fours", evidence: "she crawls forward onto her hands and knees" },
    ...over,
  });

const grade = (over: Record<string, unknown> = {}) =>
  gradeComposer({
    spec: goodSpec(over),
    degraded: false,
    context,
    expectation,
    sink: new DiagnosticCollector(),
  });

describe("gradeComposer — the right answer", () => {
  it("scores a fully grounded, concrete spec 1.0", () => {
    const result = grade();
    expect(result.checks).toMatchObject({
      answered: true,
      focal: true,
      staging: true,
      viewerBody: true,
      groundedParts: true,
      noInventedCast: true,
      noBannedWords: true,
      concrete: true,
    });
    expect(result.score).toBe(1);
  });

  it("does not grade the camera on a staged beat — a staging's camera outranks the composer's", () => {
    expect(grade().checks.camera).toBeNull();
  });
});

describe("gradeComposer — each failure mode is actually caught", () => {
  it("catches a refusal, and scores it zero rather than merely low", () => {
    const result = gradeComposer({
      spec: null,
      degraded: true,
      context,
      expectation,
      sink: new DiagnosticCollector(),
    });
    expect(result.checks.answered).toBe(false);
    expect(result.score).toBe(0);
  });

  it("treats an all-defaulted spec as a refusal — it parses, so nothing else would notice", () => {
    const result = gradeComposer({
      spec: emptySceneSpec(),
      degraded: false,
      context,
      expectation,
      sink: new DiagnosticCollector(),
    });
    expect(result.checks.answered).toBe(false);
    expect(result.score).toBe(0);
  });

  it("catches a staging the story never grounded — the evidence gate drops it", () => {
    const result = grade({ staging: { id: "on_all_fours", evidence: "a phrase nobody ever said" } });
    expect(result.checks.staging).toBe(false);
    expect(result.diagnosticCodes).toContain("images.scene_composer.staging_ungrounded");
  });

  it("catches the wrong staging id even when it IS grounded", () => {
    const result = grade({
      staging: { id: "lying_beneath_viewer", evidence: "she crawls forward onto her hands and knees" },
    });
    expect(result.checks.staging).toBe(false);
  });

  it("catches a missing viewer part", () => {
    expect(grade({ viewerBody: [], viewerBodyEvidence: [] }).checks.viewerBody).toBe(false);
  });

  it("catches an INVENTED viewer part — the quote must be in the transcript", () => {
    const result = grade({
      viewerBody: ["hands", "torso"],
      viewerBodyEvidence: [
        { part: "hands", quote: "your hands settle on her hips" },
        { part: "torso", quote: "your chest against her back" },
      ],
    });
    expect(result.checks.groundedParts).toBe(false);
    expect(result.diagnosticCodes).toContain("images.scene_composer.viewer_body_ungrounded");
  });

  it("catches a focal character who is not in the room", () => {
    const result = grade({ focalCharacter: "Someone Else" });
    expect(result.checks.focal).toBe(false);
    expect(result.diagnosticCodes).toContain("images.scene_composer.focal_clamped");
  });

  it("catches a character invented into the frame", () => {
    const result = grade({ others: [{ name: "A Stranger", action: "watching" }] });
    expect(result.checks.noInventedCast).toBe(false);
  });

  it("catches a skin-colour word the render prompt would have carried", () => {
    expect(grade({ pose: "on her hands and knees, cheeks flushed" }).checks.noBannedWords).toBe(false);
    expect(grade({ mood: "blushing and breathless" }).checks.noBannedWords).toBe(false);
  });

  it("catches the documented vagueness signature — the failure this probe exists to measure", () => {
    const result = grade({ pose: "on the bed, close to the viewer", activity: "intimate with the viewer" });
    expect(result.checks.concrete).toBe(false);
    // And it is ONLY that axis: a vague spec can still be perfectly grounded, which is
    // exactly what makes the failure hard to see without this check.
    expect(result.checks.staging).toBe(true);
  });

  it("does not flag ordinary intimate prose as vague — the check targets hedges, not explicitness", () => {
    expect(grade({ pose: "on her hands and knees, back arched", activity: "taking him inside her" }).checks.concrete).toBe(
      true,
    );
  });
});

describe("camera grading (unstaged beats)", () => {
  const cameraContext: SceneComposerContext = {
    present: [{ name: "Mira", wornVisible: [] }],
    recentNarration: ["She is at the stove with her back to the room, stirring the pan."],
    recentPlayerMessages: ["I cross the kitchen and stop right behind her."],
  };
  const cameraExpectation: ComposerExpectation = {
    focalName: "Mira",
    camera: { orientation: "away", distance: "medium", height: "eye_level" },
    viewerBody: [],
  };
  const cameraGrade = (camera: Record<string, string>) =>
    gradeComposer({
      spec: sceneSpecSchema.parse({
        focalCharacter: "Mira",
        pose: "standing at the stove with her back to the room",
        activity: "stirring the pan, steam rising",
        camera,
      }),
      degraded: false,
      context: cameraContext,
      expectation: cameraExpectation,
      sink: new DiagnosticCollector(),
    });

  it("passes a grounded non-default camera", () => {
    expect(
      cameraGrade({ orientation: "away", distance: "medium", height: "eye_level", evidence: "stop right behind her" })
        .checks.camera,
    ).toBe(true);
  });

  it("fails a camera the transcript never grounded — the resolver degrades it to the default", () => {
    const result = cameraGrade({ orientation: "away", distance: "medium", height: "eye_level", evidence: "" });
    expect(result.checks.camera).toBe(false);
    expect(result.diagnosticCodes).toContain("images.scene_composer.camera_ungrounded");
  });

  it("fails a composer that simply left the default in place", () => {
    expect(cameraGrade({ orientation: "toward_viewer", distance: "medium", height: "eye_level" }).checks.camera).toBe(
      false,
    );
  });

  it("does not grade staging on a beat that stages nothing", () => {
    expect(cameraGrade({ orientation: "away", distance: "medium", height: "eye_level", evidence: "stop right behind her" }).checks.staging).toBeNull();
  });
});

describe("scoreOf", () => {
  it("ignores axes this beat does not grade, so beats with different keys stay comparable", () => {
    const base = {
      answered: true,
      focal: true,
      groundedParts: true,
      noInventedCast: true,
      noBannedWords: true,
      concrete: true,
    };
    expect(scoreOf({ ...base, camera: null, staging: null, viewerBody: null })).toBe(1);
    expect(scoreOf({ ...base, camera: false, staging: null, viewerBody: null })).toBeCloseTo(6 / 7);
  });
});

describe("isEmptySpec", () => {
  it("is true only for the schema's own defaults", () => {
    expect(isEmptySpec(emptySceneSpec())).toBe(true);
    expect(isEmptySpec(goodSpec())).toBe(false);
    expect(isEmptySpec(sceneSpecSchema.parse({ mood: "calm" }))).toBe(true);
    expect(isEmptySpec(sceneSpecSchema.parse({ focalCharacter: "Mira" }))).toBe(false);
  });
});

describe("VAGUE_SIGNATURES", () => {
  it("is a short, documented list rather than a general prose heuristic", () => {
    // Guards the design decision, not the contents: if this grows into a dozen patterns it
    // has stopped being "the reported failure signature" and become an unagreed quality bar.
    expect(VAGUE_SIGNATURES.length).toBeLessThanOrEqual(8);
  });
});
