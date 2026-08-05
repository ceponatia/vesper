import "dotenv/config";
import fs from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
import { evalEdit, evalEditModel, evalGenerate, evalGenerateModel, hasImageProvider } from "./model";

/**
 * Two follow-up reference-sheet experiments for qwen-image-2-edit
 * (scene-images.spec.md §6), after a labeled board got copied verbatim:
 *
 *   exp2 — "seamless board": two halves side by side, NO label bars / no black
 *          structure, asking it to merge the person into the location. Isolates
 *          whether the model was copying the board *structure* (labels/bars).
 *   exp1 — "composite-into-scene": feather a cutout of the person directly onto
 *          the location (one image, no panels) and ask the edit model to relight
 *          + blend her in. Plays to the edit model's preserve-and-harmonize
 *          strength instead of against it.
 *
 * Defaults to the Mira portrait + atrium under docs/scene-image-eval/. Needs VENICE_API_KEY.
 */
const CHAR = "docs/scene-image-eval/portraits/Mira.webp";
const LOC = "docs/scene-image-eval/05-location-only.webp";
const NAME = "Mira";
const OUT = "docs/scene-image-eval/refsheet";

async function runEdit(label: string, reference: Buffer, prompt: string): Promise<void> {
  console.log(`\n[${label}] model ${evalEditModel().slug}\nprompt: ${prompt}`);
  const result = await evalEdit(prompt, [reference]);
  if (!result.ok || !result.image) {
    console.error(`  [${label}] failed: ${result.error ?? "no image"}`);
    return;
  }
  const outPath = path.join(OUT, `output-${label}.webp`);
  await fs.writeFile(outPath, await sharp(result.image).webp({ quality: 90 }).toBuffer());
  console.log(`  → ${outPath}`);
}

/** exp2: two halves, no labels/bars. */
async function seamlessBoard(): Promise<Buffer> {
  const w = 600;
  const h = 800;
  const left = await sharp(await fs.readFile(CHAR)).resize(w, h, { fit: "cover" }).png().toBuffer();
  const right = await sharp(await fs.readFile(LOC)).resize(w, h, { fit: "cover" }).png().toBuffer();
  return sharp({ create: { width: w * 2, height: h, channels: 3, background: "#ffffff" } })
    .composite([
      { input: left, top: 0, left: 0 },
      { input: right, top: 0, left: w },
    ])
    .webp({ quality: 90 })
    .toBuffer();
}

/** exp1: feather the character cutout onto the location as one rough composite. */
async function compositeIntoScene(): Promise<Buffer> {
  const sceneW = 1200;
  const sceneH = 1600;
  const figW = 560;
  const figH = 747;
  const figure = await sharp(await fs.readFile(CHAR)).resize(figW, figH, { fit: "cover" }).ensureAlpha().png().toBuffer();
  const mask = Buffer.from(
    `<svg width="${figW}" height="${figH}"><defs><filter id="b"><feGaussianBlur stdDeviation="34"/></filter></defs>` +
      `<rect x="46" y="46" width="${figW - 92}" height="${figH - 92}" rx="80" fill="#ffffff" filter="url(#b)"/></svg>`,
  );
  const feathered = await sharp(figure)
    .composite([{ input: await sharp(mask).png().toBuffer(), blend: "dest-in" }])
    .png()
    .toBuffer();
  return sharp(await fs.readFile(LOC))
    .resize(sceneW, sceneH, { fit: "cover" })
    .composite([{ input: feathered, top: sceneH - figH - 40, left: Math.round((sceneW - figW) / 2) }])
    .webp({ quality: 90 })
    .toBuffer();
}

async function main(): Promise<void> {
  if (!hasImageProvider()) throw new Error("REPLICATE_API_TOKEN not set");
  await fs.mkdir(OUT, { recursive: true });

  const board = await seamlessBoard();
  await fs.writeFile(path.join(OUT, "input-nolabel.webp"), board);
  await runEdit(
    "nolabel",
    board,
    `This image places ${NAME} (left) beside an empty location (right). Render ONE photorealistic scene that puts ${NAME} inside that location, preserving her face, hair and features. Do NOT output a side-by-side, split, or two-panel image — a single natural photograph. First-person POV: the camera is the viewer's eyes; the viewer is not visible.`,
  );

  const composite = await compositeIntoScene();
  await fs.writeFile(path.join(OUT, "input-composite.webp"), composite);
  await runEdit(
    "composite",
    composite,
    `${NAME} has been roughly pasted into this scene. Integrate her naturally and photorealistically: relight her to match the environment, blend her edges seamlessly so there is no cutout border, and correct her scale and perspective so she is standing within the space. Keep her face, hair and features. First-person POV: the camera is the viewer's eyes; the viewer is not visible.`,
  );

  console.log("\nSCORE BY EYE: identity kept? location used as setting? any board/split/cutout-border contamination?");
}

main()
  .then(() => process.exit(0))
  .catch((err: unknown) => {
    console.error(err);
    process.exit(1);
  });
