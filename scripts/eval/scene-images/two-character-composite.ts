import "dotenv/config";
import fs from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
import { evalEdit, evalEditModel, evalGenerate, evalGenerateModel, hasImageProvider } from "./model";

/**
 * Two-character composite-into-scene test (reference-sheet follow-up):
 * the reference-sheet path failed (qwen-image-2-edit copies a board), but
 * compositing one subject INTO the scene + "harmonize" worked. This generalizes
 * it to TWO identities.
 *
 * Dependency-free matting: generate each character on a solid chroma-green
 * background (qwen-image-2 t2i), then key the green out with a sharp raw-pixel
 * pass (+ despill) — no rembg/ONNX/Python. Composite both cutouts into the
 * location and ask qwen-image-2-edit to relight/blend/fix scale. Needs VENICE_API_KEY.
 */
const LOC = "docs/scene-image-eval/05-location-only.webp";
const OUT = "docs/scene-image-eval/two-character";
const SCENE_W = 1200;
const SCENE_H = 1600;

const CHARACTERS = [
  { name: "Mira", prompt: "a woman in her late twenties, long auburn hair, green eyes, freckles, wearing a fitted navy-blue dress" },
  { name: "Dorian", prompt: "a man in his thirties, short dark hair, trimmed beard, wearing a tan canvas jacket and dark trousers" },
];

function characterPrompt(look: string): string {
  return `Full-body studio photograph of ${look}, standing and facing the camera, even soft lighting, on a solid uniform pure chroma-green #00FF00 background. The entire background is flat bright green; the subject wears no green.`;
}

/** Key out the green screen (+ light despill) → an RGBA PNG cutout. Pure sharp, no deps. */
async function chromaKeyGreen(input: Buffer): Promise<Buffer> {
  const { data, info } = await sharp(input).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  for (let i = 0; i < data.length; i += 4) {
    const r = data[i] ?? 0;
    const g = data[i + 1] ?? 0;
    const b = data[i + 2] ?? 0;
    if (g > 110 && g > r * 1.35 && g > b * 1.35) {
      data[i + 3] = 0; // green → transparent
    } else if (g > r && g > b) {
      data[i + 1] = Math.max(r, b); // despill the green fringe on kept pixels
    }
  }
  return sharp(data, { raw: { width: info.width, height: info.height, channels: 4 } }).png().toBuffer();
}

async function placeFigure(cutout: Buffer, targetH: number, left: number): Promise<{ input: Buffer; left: number; top: number }> {
  const resized = await sharp(cutout).resize({ height: targetH }).png().toBuffer();
  return { input: resized, left, top: SCENE_H - targetH }; // stand on the floor
}

async function main(): Promise<void> {
  if (!hasImageProvider()) throw new Error("REPLICATE_API_TOKEN not set");
  await fs.mkdir(OUT, { recursive: true });

  // 1) generate each character on green and matte them out.
  const cutouts: Buffer[] = [];
  for (const character of CHARACTERS) {
    console.log(`generate-on-green (${character.name})…`);
    const gen = await evalGenerate(characterPrompt(character.prompt));
    if (!gen.ok || !gen.image) {
      console.error(`  failed for ${character.name}: ${gen.error ?? "no image"}`);
      return;
    }
    const cutout = await chromaKeyGreen(gen.image);
    await fs.writeFile(path.join(OUT, `cutout-${character.name}.png`), cutout);
    cutouts.push(cutout);
  }

  // 2) composite both cutouts into the location (two people standing, slightly overlapping).
  const [cutoutA, cutoutB] = cutouts;
  if (!cutoutA || !cutoutB) {
    console.error("missing a character cutout — aborting composite");
    return;
  }
  const figureA = await placeFigure(cutoutA, 1180, 150);
  const figureB = await placeFigure(cutoutB, 1240, 620);
  const composite = await sharp(await fs.readFile(LOC))
    .resize(SCENE_W, SCENE_H, { fit: "cover" })
    .composite([
      { input: figureB.input, top: figureB.top, left: figureB.left }, // back-to-front
      { input: figureA.input, top: figureA.top, left: figureA.left },
    ])
    .webp({ quality: 90 })
    .toBuffer();
  await fs.writeFile(path.join(OUT, "input-composite.webp"), composite);

  // 3) harmonize.
  const prompt = [
    `Two people — ${CHARACTERS[0]?.name} (auburn hair, navy dress) and ${CHARACTERS[1]?.name} (dark hair, tan jacket) — have been roughly pasted into this scene.`,
    "Integrate them naturally and photorealistically: relight both to match the environment, blend their edges seamlessly so there are no cutout borders, correct their scale and perspective so they are standing together in the space, and keep BOTH faces, hair and clothing exactly.",
    "Single natural photograph. Shot from the viewer's own eyes; none of the viewer's body is visible (no hands, no camera in frame).",
  ].join(" ");
  console.log(`\nharmonize (${evalEditModel().slug})…\nprompt: ${prompt}`);
  const result = await evalEdit(prompt, [composite]);
  if (!result.ok || !result.image) {
    console.error(`  harmonize failed: ${result.error ?? "no image"}`);
    return;
  }
  await fs.writeFile(path.join(OUT, "output.webp"), await sharp(result.image).webp({ quality: 90 }).toBuffer());
  console.log(`\noutput → ${path.join(OUT, "output.webp")}`);
  console.log("SCORE BY EYE: both identities kept? both standing in the location? edges/scale clean? any green fringe or cutout border?");
}

main()
  .then(() => process.exit(0))
  .catch((err: unknown) => {
    console.error(err);
    process.exit(1);
  });
