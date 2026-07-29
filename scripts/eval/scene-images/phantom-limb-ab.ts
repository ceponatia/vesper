import "dotenv/config";
import fs from "node:fs/promises";
import path from "node:path";
import { hasVenice, veniceEditImage } from "../../../src/server/ai";
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
 * the same limb-heavy beat through the real pipeline per variant, as Qwen edits of
 * an identity portrait:
 *
 * - `old`  — the pre-fix framing ("no hands or held objects in frame", unbound "one hand")
 * - `enum` — the rejected first fix: enumerated possession ("every hand, arm, leg and
 *            foot belongs to Mira") — it STILL painted a phantom viewer hand (1/2 runs);
 *            a limb noun summons a limb even when possessively bound
 * - `new`  — the shipped framing (whatever sceneFramingRule currently emits: count
 *            assertion + abstract possession + bound pose limbs) — 3/3 clean on adoption
 *
 * Outputs land in the untracked screenshots/ folder for eyeball review.
 * Run: `pnpm tsx scripts/eval/scene-images/phantom-limb-ab.ts [anchor.webp] [old,enum,new]`
 * (AB_RUNS=n for more runs per variant).
 */
const OUT = "screenshots/phantom-limb-ab";
/** Reference portrait: argv override for ad-hoc anchors; the eval portrait (untracked, regenerable) by default. */
const ANCHOR = process.argv[2] ?? "docs/scene-image-eval/portraits/Mira.webp";
const RUNS_PER_VARIANT = Number(process.env.AB_RUNS ?? 2);

const OLD_RULE =
  "First-person POV through the player's own eyes. The player must NEVER be visible — no body, no face, no hands or held objects in frame.";

async function main(): Promise<void> {
  if (!hasVenice()) throw new Error("VENICE_API_KEY not set — cannot generate");
  const reference = await fs.readFile(ANCHOR);
  await fs.mkdir(OUT, { recursive: true });

  // The Kristin failure beat, through the REAL plan resolution (limb binding included).
  const context: SceneComposerContext = {
    present: [
      {
        name: "Mira",
        wornVisible: [],
        outfitDescription: "a red bikini top and denim shorts",
        appearance: "Hair color: auburn; Hair length: long; Eye color: green",
      },
    ],
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
  const plan = resolveScenePlan(spec, context);
  const newPrompt = buildSceneRenderPrompt(plan, { referenceName: "Mira" });

  // The shipped framing block, derived from the same builder the pipeline uses, so this
  // A/B never drifts from production wording.
  const shippedFraming = sceneFramingRule({ subjects: ["Mira"] });
  if (!newPrompt.includes(shippedFraming)) throw new Error("expected framing block not found — A/B would not be clean");

  // The OLD variant: the pre-fix negative rule, and the limbs unbound again.
  const oldPrompt = newPrompt
    .replace(shippedFraming, OLD_RULE)
    .replaceAll("Mira's hand ", "one hand ")
    .replaceAll("Mira's finger", "one finger");

  // The rejected round-1 candidate, kept for the record: enumerated possession.
  const enumFraming =
    "First-person POV through the player's own eyes; the player's face and body are never in frame. Exactly one person is fully in frame: Mira. Nobody else appears. Every hand, arm, leg and foot in the image belongs to Mira.";
  const enumPrompt = newPrompt.replace(shippedFraming, enumFraming);

  const variants = process.argv[3] ? process.argv[3].split(",") : ["old", "enum", "new"];
  for (const [variant, prompt] of (
    [
      ["old", oldPrompt],
      ["enum", enumPrompt],
      ["new", newPrompt],
    ] as const
  ).filter(([v]) => variants.includes(v))) {
    console.log(`\n=== ${variant} prompt ===\n${prompt}\n`);
    for (let run = 1; run <= RUNS_PER_VARIANT; run++) {
      const result = await veniceEditImage({ prompt, reference });
      if (!result.ok || !result.image) {
        console.error(`${variant} run ${run} FAILED: ${result.error ?? "no image"}`);
        continue;
      }
      const file = path.join(OUT, `${variant}-${run}.webp`);
      await fs.writeFile(file, result.image);
      console.log(`${variant} run ${run} → ${file}`);
    }
  }
}

main().catch((err: unknown) => {
  console.error(err);
  process.exitCode = 1;
});
