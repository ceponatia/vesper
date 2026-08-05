import "dotenv/config";
import fs from "node:fs/promises";
import path from "node:path";
import { evalEdit, evalEditModel, evalGenerate, evalGenerateModel, hasImageProvider } from "./model";
import {
  buildSceneRenderPrompt,
  resolveScenePlan,
  sceneFramingRule,
  sceneSpecSchema,
  type SceneComposerContext,
} from "../../../src/server/images";

/**
 * Phantom-limb A/B (owner report 2026-07-29, NOT a test gate): the character's
 * hands/feet in pose text were rendering as the VIEWER's foreground limbs. Renders
 * a limb-heavy beat through the real pipeline per variant, as Qwen edits of an
 * identity portrait.
 *
 * Beats (`AB_BEAT`):
 * - `drink`   (default) — disembodied: her hand/finger on a glass, feet tucked. Pass =
 *   no viewer limbs at all. Variants: `old` (pre-fix "no hands or held objects" rule,
 *   unbound "one hand"), `enum` (the REJECTED first fix — enumerated possession still
 *   painted a phantom hand; a limb noun summons a limb even bound), `new` (shipped:
 *   count assertion + abstract possession + bound pose limbs — 4/4 clean on adoption).
 * - `footrub` — EMBODIED contact (affordances direction): the player massages her
 *   extended foot; `viewerBody: ["hands"]` with verbatim narration evidence. Pass =
 *   her foot extended, the viewer's hands working on it, and NO viewer feet/legs in
 *   frame. Variants: `old` (unbound limbs in the pose text), `new` (shipped binding).
 *
 * Outputs land in the untracked screenshots/ folder for eyeball review.
 * Run: `pnpm tsx scripts/eval/scene-images/phantom-limb-ab.ts [anchor.webp] [variants]`
 * (AB_RUNS=n runs per variant, AB_BEAT=drink|footrub).
 */
const OUT = "screenshots/phantom-limb-ab";
/** Reference portrait: argv override for ad-hoc anchors; the eval portrait (untracked, regenerable) by default. */
const ANCHOR = process.argv[2] ?? "docs/scene-image-eval/portraits/Mira.webp";
const RUNS_PER_VARIANT = Number(process.env.AB_RUNS ?? 2);
const BEAT = process.env.AB_BEAT ?? "drink";

const OLD_RULE =
  "First-person POV through the player's own eyes. The player must NEVER be visible — no body, no face, no hands or held objects in frame.";

const PRESENT_MIRA = {
  name: "Mira",
  wornVisible: [],
  outfitDescription: "a red bikini top and denim shorts",
  appearance: "Hair color: auburn; Hair length: long; Eye color: green",
  // Shipped since the 2026-07-29 age ruling (buildCharacterSceneContext sets this
  // from the sheet in prod) — the probe that measured ~15–20 apparent years.
  ageAnchor: "Mira is in her late twenties; her skin, hands and legs read smooth and youthful.",
};

/** Beat 1 (disembodied): the reported Kristin failure — her limbs on a glass, nobody else's. */
function drinkVariants(): Record<string, string> {
  const context: SceneComposerContext = {
    present: [PRESENT_MIRA],
    locationName: "the boat deck",
    locationDescription: "the deck of a small cabin cruiser on a lake at golden hour, cushioned bench seats",
    timeOfDay: "dusk",
  };
  const spec = sceneSpecSchema.parse({
    focalCharacter: "Mira",
    pose: "sitting sideways on the cushioned bench, feet tucked under her, one hand holding a glass with ice clinking",
    activity: "swirling the last of her drink, then miming a slow typing motion with one finger",
    setting: context.locationDescription,
    lighting: "warm golden-hour light",
    mood: "relaxed",
  });
  const newPrompt = buildSceneRenderPrompt(resolveScenePlan(spec, context), { referenceName: "Mira" });

  // The shipped framing block, derived from the same builder the pipeline uses, so this
  // A/B never drifts from production wording.
  const shippedFraming = sceneFramingRule({ subjects: ["Mira"] });
  if (!newPrompt.includes(shippedFraming)) throw new Error("expected framing block not found — A/B would not be clean");

  // Historical variants predate the age ruling too — strip the shipped anchor from them.
  const preAge = newPrompt.replace(` ${PRESENT_MIRA.ageAnchor}`, "");
  return {
    // The OLD variant: the pre-fix negative rule, and the limbs unbound again.
    old: preAge
      .replace(shippedFraming, OLD_RULE)
      .replaceAll("Mira's hand ", "one hand ")
      .replaceAll("Mira's finger", "one finger"),
    // The rejected round-1 candidate, kept for the record: enumerated possession.
    enum: preAge.replace(
      shippedFraming,
      "First-person POV through the player's own eyes; the player's face and body are never in frame. Exactly one person is fully in frame: Mira. Nobody else appears. Every hand, arm, leg and foot in the image belongs to Mira.",
    ),
    new: newPrompt,
  };
}

/**
 * Beat 2 (embodied contact, affordances direction): a foot massage. The viewer's hands
 * are LEGITIMATELY in frame (`viewerBody: ["hands"]`, grounded by a verbatim narration
 * quote through the real evidence gate); her foot is extended into them. The trap under
 * test: "foot" nouns summoning the VIEWER's feet, and the massage hands promoting into
 * a whole second person.
 */
function footrubVariants(): Record<string, string> {
  const narration =
    "She stretches out along the bench with a lazy grin and settles her foot into your waiting hands; you press slow circles into her arch with your thumbs while she sighs.";
  const context: SceneComposerContext = {
    present: [PRESENT_MIRA],
    locationName: "the boat deck",
    locationDescription: "the deck of a small cabin cruiser on a lake at golden hour, cushioned bench seats",
    timeOfDay: "dusk",
    embodiedViewer: true,
    recentNarration: [narration],
  };
  const spec = sceneSpecSchema.parse({
    focalCharacter: "Mira",
    pose: "reclined along the cushioned bench, one leg extended toward the viewer, her foot resting in the viewer's hands",
    activity: "sighing with her head tipped back as the viewer's thumbs press slow circles into her arch",
    setting: context.locationDescription,
    lighting: "warm golden-hour light",
    mood: "relaxed",
    viewerBody: ["hands"],
    viewerBodyEvidence: [{ part: "hands", quote: "settles her foot into your waiting hands" }],
  });
  const plan = resolveScenePlan(spec, context);
  if (plan.viewerBody.length === 0) throw new Error("evidence gate dropped the hands — beat setup is wrong");
  const newPrompt = buildSceneRenderPrompt(plan, { referenceName: "Mira" });
  if (!newPrompt.includes("the viewer's own hands")) throw new Error("embodied framing missing from the prompt");

  return {
    // OLD here = pre-fix on both counts: pose limbs unbound and no age anchor.
    old: newPrompt.replace(` ${PRESENT_MIRA.ageAnchor}`, "").replaceAll("Mira's leg ", "one leg "),
    new: newPrompt,
    // The pre-age-ruling prompt (owner report: renders read far older than the
    // sheet's late_twenties) — the shipped anchor stripped back out, for
    // measuring what it buys.
    noage: newPrompt.replace(` ${PRESENT_MIRA.ageAnchor}`, ""),
  };
}

async function main(): Promise<void> {
  if (!hasImageProvider()) throw new Error("REPLICATE_API_TOKEN not set — cannot generate");
  const reference = await fs.readFile(ANCHOR);
  await fs.mkdir(OUT, { recursive: true });

  const prompts = BEAT === "footrub" ? footrubVariants() : drinkVariants();
  const variants = process.argv[3] ? process.argv[3].split(",") : Object.keys(prompts);
  for (const variant of variants) {
    const prompt = prompts[variant];
    if (!prompt) {
      console.error(`unknown variant "${variant}" for beat "${BEAT}" — have: ${Object.keys(prompts).join(", ")}`);
      continue;
    }
    console.log(`\n=== ${BEAT} / ${variant} prompt ===\n${prompt}\n`);
    for (let run = 1; run <= RUNS_PER_VARIANT; run++) {
      const result = await evalEdit(prompt, [reference]);
      if (!result.ok || !result.image) {
        console.error(`${variant} run ${run} FAILED: ${result.error ?? "no image"}`);
        continue;
      }
      const file = path.join(OUT, `${BEAT}-${variant}-${run}.webp`);
      await fs.writeFile(file, result.image);
      console.log(`${variant} run ${run} → ${file}`);
    }
  }
}

main().catch((err: unknown) => {
  console.error(err);
  process.exitCode = 1;
});
