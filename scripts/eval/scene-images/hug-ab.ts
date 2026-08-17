import "dotenv/config";
import fs from "node:fs/promises";
import path from "node:path";
import { evalEdit, hasImageProvider } from "./model";
import {
  buildSceneRenderPrompt,
  PORTRAIT_IDENTITY_LOCK,
  resolveScenePlan,
  sceneSpecSchema,
  type SceneComposerContext,
} from "@/server/images";

/**
 * Hug A/B (owner report 2026-08-16, NOT a test gate): a "they hugged before parting"
 * beat rendered TWO women hugging each other instead of one woman hugging the camera.
 *
 * The failing prompt asked for something unsatisfiable — a hug (two bodies) alongside
 * "the player is never visible" and "every visible body part belongs to <name>" — and
 * the model resolved it by duplicating the reference subject. It also described the
 * subject's feet and toenails, which no close frame can show, so the camera pulled back
 * to a full-body standing shot.
 *
 * Five variants isolate the levers:
 * - `baseline`  — the failing shape, through the real pipeline. The control.
 * - `framefill` — baseline minus the lower-body block, plus an explicit close shot and a
 *   pose written as frame geometry. KEEPS the strict no-viewer-body rule, so the hug/
 *   possession contradiction survives. Measures what pose wording alone buys.
 * - `nolimb`    — framefill plus clothing trimmed to what the crop shows, the partial-face
 *   identity adaptation, and the background crowd resolved positively instead of forbidden.
 *   Still no viewer body. This is the ceiling WITHOUT a new viewer body part.
 * - `full`      — nolimb plus the viewer's own shoulder in frame, cropped and out of focus.
 *   Measures whether the POV cue is load-bearing.
 * - `staged`    — what a `hugging_viewer` registry row would actually emit: a house-style
 *   template sentence, the embodied framing with a hypothetical `shoulders` part, the
 *   staging's own close/eye_level camera, and the composer's prose demoted to atmosphere.
 *
 * Outputs land in the untracked screenshots/ folder for eyeball review.
 * Run: `pnpm tsx scripts/eval/scene-images/hug-ab.ts [anchor.webp] [variants]`
 * (HUG_RUNS=n runs per variant).
 */
const OUT = "screenshots/hug";
const ANCHOR = process.argv[2] ?? "docs/scene-image-eval/portraits/Mira.webp";
const RUNS_PER_VARIANT = Number(process.env.HUG_RUNS ?? 2);

const NAME = "Mira";
const AGE_ANCHOR = `${NAME} is in her late twenties; her skin, hands and legs read smooth and youthful.`;
const ANCHORS =
  "Skin tone: fair; Skin undertone: cool; Lip fullness: full; Lip shape: cupids bow; Eye color: green; Eye shape: almond; Hair color: auburn; Hair length: long";
const IDENTITY = `Same person as the reference image — these features confirm it (the reference is authoritative where they differ): ${ANCHORS}.`;

const OUTFIT = "a white low-cut tube top, a light blue skirt that covers her knees, open-toe heels";
const LOWER_BODY = "Foot size: average; Foot arch: average; Toenails: trimmed; Toe length: average; Waist: defined; Hips: average";
const SETTING = "A sunlit curb in Times Square, afternoon glare bouncing off glass and steel towers, screens and traffic behind";
const LIGHTING = "bright, warm afternoon sunlight with sharp glare";
const MOOD = "light, warm, and charged with unspoken promise";
const TAIL = "High quality, no text, no watermark.";

/** The failing pose, verbatim in shape: post-hug, at arm's length, four stacked actions. */
const BASELINE_POSE =
  "standing at the curb, facing the viewer, a slight upward tilt to her chin, a warm, unguarded smile on her lips; letting go of the viewer's arm after a brief, loose hug, adjusting the strap of her heel";

/** The rewrite's pose: the hug itself, stated as what occupies the frame. */
const FRAME_FILL_POSE =
  `${NAME} is hugging the viewer goodbye, pressed close against the viewer's chest, ${NAME}'s arms up around the viewer's shoulders and ${NAME}'s head turned to rest on the viewer's near shoulder. ` +
  `${NAME}'s cheek, ear, jaw and the loose waves of her hair fill the left side and lower third of the frame, close to the lens and slightly out of focus. ` +
  `Her eyes are closed, a small unguarded smile at the corner of her mouth. Only the near side of her face is visible, in three-quarter profile at close range`;

const CLOSE_SHOT = `Shot: a very close frame — ${NAME} is nearer than arm's length and fills most of the frame; camera at standing eye height.`;
const FACE_PARTIAL =
  `${NAME}'s face is partly turned from the camera; preserve the visible features, hair color and style, build and skin tone exactly from the reference — do not rotate ${NAME} to face the camera.`;

/** The strict disembodied rule the pipeline emits today (SCENE_POV_RULE + count + possession). */
const STRICT_POV =
  `First-person POV through the player's own eyes; the player is never visible in the image. ` +
  `Exactly one person is fully in frame: ${NAME}. Nobody else appears. Every visible body part belongs to ${NAME}.`;

/** The embodied rule, with a hypothetical `shoulders` viewer part written in registry house style. */
const EMBODIED_POV =
  `First-person POV through the viewer's own eyes; the viewer's face and head are never in frame. ` +
  `Exactly one person is fully in frame: ${NAME}. ` +
  `Also in frame, in the viewer's immediate foreground: the viewer's own shoulder and upper chest along the lower edge of the frame, cropped by the frame edge and strongly foreshortened, out of focus.`;

/** Background crowd resolved positively — "nobody else appears" was violated by a full crowd. */
const SETTING_RESOLVED =
  `Setting: behind her, thrown well out of focus, a sunlit Times Square afternoon — glare off glass and steel, blurred screens and traffic, distant passers-by reduced to soft shapes.`;

/** Variant 1: the real pipeline, reproducing the reported failure. */
function baselinePrompt(): string {
  const context: SceneComposerContext = {
    present: [
      {
        name: NAME,
        wornVisible: [],
        outfitDescription: OUTFIT,
        appearance: ANCHORS,
        identityAnchors: ANCHORS,
        ageAnchor: AGE_ANCHOR,
        lowerBody: LOWER_BODY,
      },
    ],
    locationName: "the curb",
    locationDescription: SETTING,
    timeOfDay: "day",
    embodiedViewer: true,
  };
  const spec = sceneSpecSchema.parse({
    focalCharacter: NAME,
    pose: BASELINE_POSE,
    activity: "saying goodbye before they part for the day",
    setting: SETTING,
    lighting: LIGHTING,
    mood: MOOD,
  });
  return buildSceneRenderPrompt(resolveScenePlan(spec, context), { referenceName: NAME });
}

/** Variant 2: pose geometry + close shot + no feet. Contradiction deliberately retained. */
function framefillPrompt(): string {
  return [
    PORTRAIT_IDENTITY_LOCK,
    AGE_ANCHOR,
    STRICT_POV,
    CLOSE_SHOT,
    IDENTITY,
    `Pose: ${FRAME_FILL_POSE}.`,
    `Wearing: ${OUTFIT}.`,
    "Depict only the clothing described; add no garment that is not listed.",
    `Setting: ${SETTING}.`,
    `Lighting: ${LIGHTING}.`,
    `Mood: ${MOOD}.`,
    TAIL,
  ].join(" ");
}

/** Variant 3: the full rewrite, still forbidding the viewer's body. */
function nolimbPrompt(): string {
  return [
    PORTRAIT_IDENTITY_LOCK,
    AGE_ANCHOR,
    STRICT_POV,
    CLOSE_SHOT,
    IDENTITY,
    `Pose: ${FRAME_FILL_POSE}.`,
    FACE_PARTIAL,
    "Visible clothing: the white tube top at her shoulders and upper back. Depict only the clothing described; add no garment that is not listed.",
    SETTING_RESOLVED,
    `Lighting: ${LIGHTING}, backlit, a rim of light through her hair.`,
    `Mood: ${MOOD}.`,
    "Shallow depth of field, close-range lens.",
    TAIL,
  ].join(" ");
}

/** Variant 4: the rewrite with the viewer's shoulder in frame. */
function fullPrompt(): string {
  return [
    PORTRAIT_IDENTITY_LOCK,
    AGE_ANCHOR,
    EMBODIED_POV,
    CLOSE_SHOT,
    IDENTITY,
    `Pose: ${FRAME_FILL_POSE}.`,
    FACE_PARTIAL,
    "Visible clothing: the white tube top at her shoulders and upper back. Depict only the clothing described; add no garment that is not listed.",
    SETTING_RESOLVED,
    `Lighting: ${LIGHTING}, backlit, a rim of light through her hair.`,
    `Mood: ${MOOD}.`,
    "Shallow depth of field, close-range lens.",
    TAIL,
  ].join(" ");
}

/**
 * Variant 5: what a `hugging_viewer` registry row would emit.
 *
 * The template is written in the catalog's house style — `{name}` bound, the viewer
 * possessive-only, geometry stated as body-against-body — and the composer's own prose is
 * demoted to the trailing atmosphere clause exactly as `poseTextFor` orders it.
 */
function stagedPrompt(): string {
  const template =
    `${NAME} standing pressed against the viewer's chest, ${NAME}'s arms closed around the viewer's shoulders and ` +
    `${NAME}'s head turned to rest on the viewer's near shoulder, ${NAME}'s face in three-quarter profile close to the lens, ` +
    `the near side of ${NAME}'s face and hair filling the lower left of the frame`;
  return [
    PORTRAIT_IDENTITY_LOCK,
    AGE_ANCHOR,
    FACE_PARTIAL,
    EMBODIED_POV,
    `Shot: a close frame on ${NAME}; camera at standing eye height.`,
    IDENTITY,
    `Pose: ${template}; a warm, unguarded goodbye smile, her eyes closed.`,
    "Visible clothing: the white tube top at her shoulders and upper back. Depict only the clothing described; add no garment that is not listed.",
    SETTING_RESOLVED,
    `Lighting: ${LIGHTING}.`,
    `Mood: ${MOOD}.`,
    TAIL,
  ].join(" ");
}

async function main(): Promise<void> {
  if (!hasImageProvider()) throw new Error("REPLICATE_API_TOKEN not set — cannot generate");
  const reference = await fs.readFile(ANCHOR);
  await fs.mkdir(OUT, { recursive: true });

  const prompts: Record<string, string> = {
    baseline: baselinePrompt(),
    framefill: framefillPrompt(),
    nolimb: nolimbPrompt(),
    full: fullPrompt(),
    staged: stagedPrompt(),
  };
  const variants = process.argv[3] ? process.argv[3].split(",") : Object.keys(prompts);

  const notes: string[] = ["# Hug A/B — prompt variants", "", `Anchor: \`${ANCHOR}\`  •  runs per variant: ${RUNS_PER_VARIANT}`, ""];
  for (const variant of variants) {
    const prompt = prompts[variant];
    if (!prompt) {
      console.error(`unknown variant "${variant}" — have: ${Object.keys(prompts).join(", ")}`);
      continue;
    }
    console.log(`\n=== ${variant} ===\n${prompt}\n`);
    notes.push(`## ${variant}`, "", "```", prompt, "```", "");
    for (let run = 1; run <= RUNS_PER_VARIANT; run++) {
      const result = await evalEdit(prompt, [reference]);
      if (!result.ok || !result.image) {
        console.error(`${variant} run ${run} FAILED: ${result.error ?? "no image"}`);
        continue;
      }
      const file = path.join(OUT, `${variant}-${run}.webp`);
      await fs.writeFile(file, result.image);
      console.log(`${variant} run ${run} → ${file}`);
    }
  }
  await fs.writeFile(path.join(OUT, "prompts.md"), notes.join("\n"));
  console.log(`\nprompts → ${path.join(OUT, "prompts.md")}`);
}

main().catch((err: unknown) => {
  console.error(err);
  process.exitCode = 1;
});
