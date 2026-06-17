import "dotenv/config";
import fs from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
import { veniceEditImage } from "../../src/server/ai";
import { SCENE_POV_RULE } from "../../src/server/images";

/**
 * SPIKE (scene-images.spec.md §6 — throwaway, manual): the direct test of
 * "Strategy B". Composite two character portraits (+ an optional location panel)
 * into one labeled reference sheet and send it to the uncensored Qwen edit model
 * with a compose prompt, to see whether Qwen binds TWO identities from a contact
 * sheet well enough to ship as the intimate multi-character stopgap.
 *
 * This is NOT wired into the app. Run it by hand with VENICE_API_KEY set, then
 * SCORE THE OUTPUT BY EYE on: identity-A, identity-B, location match, and
 * `copied_reference_sheet` (did the model reproduce the board/frame/labels
 * instead of composing a scene?). Record the score next to the saved output.
 *
 *   pnpm tsx scripts/spikes/qwen-reference-sheet.ts \
 *     --a path/to/charA.webp --b path/to/charB.webp [--location path/to/loc.webp] \
 *     [--out data/spikes/qwen-sheet] [--prompt "..."]
 */

const LABEL_H = 44;
const PORTRAIT_W = 600;
const PORTRAIT_H = 800;
const LOCATION_H = 400;

interface Args {
  a: string;
  b: string;
  location?: string;
  out: string;
  prompt?: string;
}

function parseArgs(argv: string[]): Args {
  const map = new Map<string, string>();
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token?.startsWith("--")) map.set(token.slice(2), argv[i + 1] ?? "");
  }
  const a = map.get("a");
  const b = map.get("b");
  if (!a || !b) throw new Error("usage: --a <portraitA> --b <portraitB> [--location <loc>] [--out <dir>] [--prompt <text>]");
  return { a, b, location: map.get("location") || undefined, out: map.get("out") || "data/spikes/qwen-sheet", prompt: map.get("prompt") || undefined };
}

/** One image panel with a labeled header bar (a "board zone"). */
async function labeledPanel(file: string, width: number, height: number, label: string): Promise<Buffer> {
  const image = await sharp(await fs.readFile(file)).resize(width, height, { fit: "cover" }).png().toBuffer();
  const header = Buffer.from(
    `<svg width="${width}" height="${LABEL_H}"><rect width="100%" height="100%" fill="#111111"/>` +
      `<text x="14" y="30" font-family="sans-serif" font-size="24" fill="#ffffff">${label}</text></svg>`,
  );
  return sharp({ create: { width, height: height + LABEL_H, channels: 3, background: "#ffffff" } })
    .composite([
      { input: header, top: 0, left: 0 },
      { input: image, top: LABEL_H, left: 0 },
    ])
    .png()
    .toBuffer();
}

async function buildReferenceSheet(args: Args): Promise<Buffer> {
  const panelA = await labeledPanel(args.a, PORTRAIT_W, PORTRAIT_H, "CHARACTER A");
  const panelB = await labeledPanel(args.b, PORTRAIT_W, PORTRAIT_H, "CHARACTER B");
  const rowH = PORTRAIT_H + LABEL_H;
  let sheet = await sharp({ create: { width: PORTRAIT_W * 2, height: rowH, channels: 3, background: "#ffffff" } })
    .composite([
      { input: panelA, top: 0, left: 0 },
      { input: panelB, top: 0, left: PORTRAIT_W },
    ])
    .png()
    .toBuffer();

  if (args.location) {
    const panelLoc = await labeledPanel(args.location, PORTRAIT_W * 2, LOCATION_H, "LOCATION / SETTING");
    const locRowH = LOCATION_H + LABEL_H;
    sheet = await sharp({ create: { width: PORTRAIT_W * 2, height: rowH + locRowH, channels: 3, background: "#ffffff" } })
      .composite([
        { input: sheet, top: 0, left: 0 },
        { input: panelLoc, top: rowH, left: 0 },
      ])
      .png()
      .toBuffer();
  }
  return sheet;
}

function composePrompt(custom: string | undefined, hasLocation: boolean): string {
  if (custom) return custom;
  const subject = hasLocation
    ? "Compose ONE coherent scene of CHARACTER A and CHARACTER B together in the LOCATION shown."
    : "Compose ONE coherent scene of CHARACTER A and CHARACTER B together.";
  return [
    "The attached image is a REFERENCE BOARD, not the composition.",
    "Use the labeled panels only as identity/appearance/setting references.",
    subject,
    "Do NOT reproduce the board, its frame, the panel labels, or a collage/grid layout — paint a single natural photograph.",
    SCENE_POV_RULE,
  ].join(" ");
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  await fs.mkdir(args.out, { recursive: true });

  const sheet = await buildReferenceSheet(args);
  const sheetPath = path.join(args.out, "reference-sheet.png");
  await fs.writeFile(sheetPath, sheet);

  const prompt = composePrompt(args.prompt, Boolean(args.location));
  console.log(`reference sheet → ${sheetPath}`);
  console.log(`prompt: ${prompt}\n`);

  const result = await veniceEditImage({ prompt, reference: sheet });
  if (!result.ok || !result.image) {
    console.error(`venice edit failed: ${result.error ?? "no image"}`);
    process.exit(1);
  }
  const outPath = path.join(args.out, "output.webp");
  await fs.writeFile(outPath, await sharp(result.image).webp({ quality: 90 }).toBuffer());
  console.log(`output → ${outPath}`);
  console.log(
    "\nSCORE BY EYE: identity-A, identity-B, location match, and copied_reference_sheet " +
      "(did it reproduce the board/frame/labels instead of composing a scene?).",
  );
}

main()
  .then(() => process.exit(0))
  .catch((err: unknown) => {
    console.error(err);
    process.exit(1);
  });
