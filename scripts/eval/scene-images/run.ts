import "dotenv/config";
import fs from "node:fs/promises";
import path from "node:path";
import { routeSceneAttempts } from "@vesper/image-core";
import { buildSceneRenderPrompt } from "../../../src/server/images";
import { EVAL_FIXTURES } from "./fixtures";
import { evalEditModel } from "./model";

/**
 * Scene-image eval harness runner (scene-images.spec.md §9). OFFLINE: for each
 * fixture it computes the provider routing decision and the exact prompt(s) the
 * executor would build, then writes a `manifest.json` (inputs/provider/prompt)
 * and a `scores.csv` template with the manual-scoring columns (identity-A/B,
 * location, clothing, exposure, collage contamination + the §3 safety row).
 *
 * Producing + scoring the actual images is the manual step (needs live keys and
 * human eyes): render each fixture's prompt through its `primary_provider`,
 * drop the output next to its row, and fill the scores. See README.md.
 */
const OUT = process.env.EVAL_OUT || "data/eval/scene-images";

interface ManifestEntry {
  name: string;
  category: string;
  chain: string[];
  primaryAttempt: string;
  uploadedAnchor: boolean;
  prompts: { edit?: string; text: string };
}

function csvCell(value: string): string {
  return /[",\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

async function main(): Promise<void> {
  await fs.mkdir(OUT, { recursive: true });

  const manifest: ManifestEntry[] = EVAL_FIXTURES.map((fx) => {
    const chain = routeSceneAttempts({ references: fx.references, demo: false, model: evalEditModel() });
    const anchor = fx.references.find((r) => Boolean(r.imageId));
    const textPrompt = buildSceneRenderPrompt(fx.plan, {});
    const editPrompt = anchor
      ? buildSceneRenderPrompt(fx.plan, { referenceName: anchor.name, allowIntimate: anchor.allowForIntimate })
      : undefined;
    return {
      name: fx.name,
      category: fx.category,
      chain,
      primaryAttempt: chain[0] ?? "generate",
      uploadedAnchor: Boolean(fx.uploadedAnchor),
      prompts: { edit: editPrompt, text: textPrompt },
    };
  });

  await fs.writeFile(path.join(OUT, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);

  const header = [
    "fixture",
    "category",
    "primary_provider",
    "identity_A",
    "identity_B",
    "location",
    "clothing",
    "exposure",
    "collage_contamination",
    "safety_uploaded_reached_uncensored",
    "notes",
  ];
  const rows = manifest.map((m) =>
    [m.name, m.category, m.primaryAttempt, "", "", "", "", "", "", m.uploadedAnchor ? "MUST_BE_NO" : "", ""]
      .map(csvCell)
      .join(","),
  );
  await fs.writeFile(path.join(OUT, "scores.csv"), `${[header.join(","), ...rows].join("\n")}\n`);

  console.log(`wrote ${manifest.length} fixtures → ${path.join(OUT, "manifest.json")} + scores.csv\n`);
  for (const m of manifest) console.log(`  ${m.name.padEnd(38)} ${m.chain.join(" → ")}`);
}

main()
  .then(() => process.exit(0))
  .catch((err: unknown) => {
    console.error(err);
    process.exit(1);
  });
