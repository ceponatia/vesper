import "dotenv/config";
import fs from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
import { evalEdit, evalEditModel, evalGenerate, evalGenerateModel, hasImageProvider } from "./model";
import { buildSceneRenderPrompt } from "@/server/images";
import { EVAL_FIXTURES } from "./fixtures";

/**
 * Manual review render (NOT a test gate): generate a representative subset of the
 * eval fixtures through the REAL scene flow against the live Replicate models
 * (`qwen-image-2` text-to-image for the identity portrait + the location-only
 * scene; `qwen-image-2-edit` for each anchored scene edit). Outputs to
 * docs/scene-image-eval/ for human review. Needs VENICE_API_KEY (+ safe_mode off
 * for the uncensored fixtures). Run: `pnpm tsx scripts/eval/scene-images/render-subset.ts`.
 */
const OUT = "docs/scene-image-eval";
const SUBSET = [
  "single-clothed-anchor",
  "single-nude-anchor",
  "two-clothed-one-anchor",
  "character-plus-location",
  "location-only",
];

/** Distinctive look per focal character so identity preservation is judgeable across the edits. */
const PORTRAIT_LOOK: Record<string, string> = {
  Mira: "a woman in her late twenties, long auburn hair, green eyes, fair freckled skin, wearing a simple linen blouse",
};

function portraitPrompt(name: string): string {
  const look = PORTRAIT_LOOK[name] ?? "an adult character, distinctive face";
  return `Photorealistic waist-up portrait of ${name}, ${look}. Soft neutral studio lighting, plain background, single subject facing the camera.`;
}

async function toWebp(buffer: Buffer): Promise<Buffer> {
  return sharp(buffer).webp({ quality: 90 }).toBuffer();
}

interface RenderedFixture {
  name: string;
  model: string;
  path: string;
  anchor?: string;
  prompt: string;
}

async function main(): Promise<void> {
  if (!hasImageProvider()) throw new Error("REPLICATE_API_TOKEN not set — cannot generate");
  await fs.mkdir(path.join(OUT, "portraits"), { recursive: true });

  const fixtures = SUBSET.map((n) => EVAL_FIXTURES.find((f) => f.name === n)).filter((f) => f !== undefined);

  // 1) qwen-image-2 portraits for every focal character that anchors a subset scene (reused as the edit reference).
  const anchorNames = new Set<string>();
  for (const fx of fixtures) {
    const anchor = fx.references.find((r) => Boolean(r.imageId));
    if (anchor?.name) anchorNames.add(anchor.name);
  }
  const portraits = new Map<string, Buffer>();
  for (const name of anchorNames) {
    console.log(`portrait (${evalGenerateModel().slug}): ${name}…`);
    const gen = await evalGenerate(portraitPrompt(name));
    if (!gen.ok || !gen.image) {
      console.error(`  portrait failed for ${name}: ${gen.error ?? "no image"}`);
      continue;
    }
    const webp = await toWebp(gen.image);
    portraits.set(name, webp);
    await fs.writeFile(path.join(OUT, "portraits", `${name}.webp`), webp);
  }

  // 2) Render each fixture: anchored → qwen-image-2-edit on the focal portrait; else → qwen-image-2 text-to-image.
  const rendered: RenderedFixture[] = [];
  let index = 0;
  for (const fx of fixtures) {
    index += 1;
    const anchor = fx.references.find((r) => Boolean(r.imageId));
    const anchorName = anchor?.name;
    const file = `${String(index).padStart(2, "0")}-${fx.name}.webp`;
    const editPrompt = anchorName
      ? buildSceneRenderPrompt(fx.plan, { referenceName: anchorName, allowIntimate: anchor?.allowForIntimate ?? false })
      : buildSceneRenderPrompt(fx.plan, {});
    const textPrompt = buildSceneRenderPrompt(fx.plan, {});

    if (anchorName) {
      const portrait = portraits.get(anchorName);
      if (!portrait) {
        console.error(`  skip ${fx.name}: no portrait for anchor ${anchorName}`);
        continue;
      }
      console.log(`scene (${evalEditModel().slug}): ${fx.name} (anchor ${anchorName})…`);
      const edit = await evalEdit(editPrompt, [portrait]);
      if (!edit.ok || !edit.image) {
        console.error(`  edit failed for ${fx.name}: ${edit.error ?? "no image"}`);
        continue;
      }
      await fs.writeFile(path.join(OUT, file), await toWebp(edit.image));
      rendered.push({ name: fx.name, model: evalEditModel().slug, path: file, anchor: anchorName, prompt: editPrompt });
    } else {
      console.log(`scene (${evalGenerateModel().slug} t2i): ${fx.name}…`);
      const gen = await evalGenerate(textPrompt);
      if (!gen.ok || !gen.image) {
        console.error(`  t2i failed for ${fx.name}: ${gen.error ?? "no image"}`);
        continue;
      }
      await fs.writeFile(path.join(OUT, file), await toWebp(gen.image));
      rendered.push({ name: fx.name, model: evalGenerateModel().slug, path: file, prompt: textPrompt });
    }
  }

  await writeIndex(rendered, [...portraits.keys()]);
  console.log(`\nrendered ${rendered.length}/${fixtures.length} fixtures → ${OUT}/index.md`);
}

async function writeIndex(rendered: RenderedFixture[], portraitNames: string[]): Promise<void> {
  const lines: string[] = [
    "# Scene-image eval — manual review",
    "",
    `Generated through the real scene flow against the live Replicate models (\`${evalGenerateModel().slug}\` + \`${evalEditModel().slug}\`).`,
    "A representative subset of `scripts/eval/scene-images/fixtures.ts`. Regenerate with `pnpm tsx scripts/eval/scene-images/render-subset.ts`.",
    "",
    "## Identity portraits (qwen-image-2 text-to-image — reused as the edit anchor)",
    "",
    ...portraitNames.map((n) => `**${n}**\n\n![${n}](portraits/${n}.webp)\n`),
    "## Scenes",
    "",
  ];
  for (const r of rendered) {
    lines.push(`### ${r.path}`);
    lines.push("");
    lines.push(`- model: \`${r.model}\`${r.anchor ? ` (edit of **${r.anchor}**'s portrait)` : " (text-to-image)"}`);
    lines.push(`- prompt: ${r.prompt}`);
    lines.push("");
    lines.push(`![${r.name}](${r.path})`);
    lines.push("");
  }
  await fs.writeFile(path.join(OUT, "index.md"), `${lines.join("\n")}\n`);
}

main()
  .then(() => process.exit(0))
  .catch((err: unknown) => {
    console.error(err);
    process.exit(1);
  });
