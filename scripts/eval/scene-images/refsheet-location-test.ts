import "dotenv/config";
import fs from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
import { evalEdit, evalEditModel, evalGenerate, evalGenerateModel, hasImageProvider } from "./model";

/**
 * Reference-sheet test, single-character variant: merge
 * a character portrait + a LOCATION image into one labeled board and ask
 * qwen-image-2-edit to place the character INTO that location — testing whether
 * the edit model can read the *setting* from a panel (image-driven) rather than
 * from prose. Defaults to the Mira portrait + atrium already rendered under
 * docs/scene-image-eval/. Needs VENICE_API_KEY.
 *
 *   pnpm tsx scripts/eval/scene-images/refsheet-location-test.ts \
 *     [--character <portrait>] [--location <image>] [--name Mira] [--out <dir>]
 */
const LABEL_H = 44;
const PANEL_W = 600;
const PANEL_H = 800;

interface Args {
  character: string;
  location: string;
  name: string;
  out: string;
}

function parseArgs(argv: string[]): Args {
  const map = new Map<string, string>();
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token?.startsWith("--")) map.set(token.slice(2), argv[i + 1] ?? "");
  }
  return {
    character: map.get("character") || "docs/scene-image-eval/portraits/Mira.webp",
    location: map.get("location") || "docs/scene-image-eval/05-location-only.webp",
    name: map.get("name") || "Mira",
    out: map.get("out") || "docs/scene-image-eval/refsheet",
  };
}

async function labeledPanel(file: string, label: string): Promise<Buffer> {
  const image = await sharp(await fs.readFile(file)).resize(PANEL_W, PANEL_H, { fit: "cover" }).png().toBuffer();
  const header = Buffer.from(
    `<svg width="${PANEL_W}" height="${LABEL_H}"><rect width="100%" height="100%" fill="#111111"/>` +
      `<text x="14" y="30" font-family="sans-serif" font-size="24" fill="#ffffff">${label}</text></svg>`,
  );
  return sharp({ create: { width: PANEL_W, height: PANEL_H + LABEL_H, channels: 3, background: "#ffffff" } })
    .composite([
      { input: header, top: 0, left: 0 },
      { input: image, top: LABEL_H, left: 0 },
    ])
    .png()
    .toBuffer();
}

async function main(): Promise<void> {
  if (!hasImageProvider()) throw new Error("REPLICATE_API_TOKEN not set");
  const args = parseArgs(process.argv.slice(2));
  await fs.mkdir(args.out, { recursive: true });

  const charPanel = await labeledPanel(args.character, `CHARACTER: ${args.name.toUpperCase()}`);
  const locPanel = await labeledPanel(args.location, "LOCATION");
  const sheet = await sharp({ create: { width: PANEL_W * 2, height: PANEL_H + LABEL_H, channels: 3, background: "#ffffff" } })
    .composite([
      { input: charPanel, top: 0, left: 0 },
      { input: locPanel, top: 0, left: PANEL_W },
    ])
    .webp({ quality: 90 })
    .toBuffer();
  await fs.writeFile(path.join(args.out, "sheet.webp"), sheet);

  const prompt = [
    "The attached image is a reference board with two labeled panels.",
    `Render ONE photorealistic scene that places the person from the CHARACTER panel (${args.name}) inside the setting shown in the LOCATION panel.`,
    `Preserve ${args.name}'s face, hair, and features exactly from the CHARACTER panel; use the LOCATION panel only as the environment/background.`,
    "Do NOT reproduce the board, the two panels, the labels, or any split/collage layout — paint a single natural photograph.",
    "First-person POV: the camera is the viewer's eyes; the viewer is not visible in frame.",
  ].join(" ");

  console.log(`reference sheet → ${path.join(args.out, "sheet.webp")}`);
  console.log(`model: ${evalEditModel().slug}\nprompt: ${prompt}\n`);

  const result = await evalEdit(prompt, [sheet]);
  if (!result.ok || !result.image) {
    console.error(`edit failed: ${result.error ?? "no image"}`);
    process.exit(1);
  }
  const outPath = path.join(args.out, "output.webp");
  await fs.writeFile(outPath, await sharp(result.image).webp({ quality: 90 }).toBuffer());
  console.log(`output → ${outPath}`);
  console.log("\nSCORE BY EYE: did it (a) keep Mira's identity, (b) use the LOCATION as the setting, (c) avoid reproducing the board/labels/collage?");
}

main()
  .then(() => process.exit(0))
  .catch((err: unknown) => {
    console.error(err);
    process.exit(1);
  });
