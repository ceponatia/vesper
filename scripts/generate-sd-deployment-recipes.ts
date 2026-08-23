import { writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { sdRecipes } from "@vesper/image-sd";

/**
 * Write the Stable Diffusion recipe registry out for the Python side of the
 * renderer.
 *
 *   pnpm tsx scripts/generate-sd-deployment-recipes.ts
 *
 * `packages/image-sd/deployment/` is a Cog/ComfyUI deployment: it builds into a
 * container that has no TypeScript in it, and its predictor still has to resolve
 * the `recipe` input it is handed to the exact sampler, scheduler, step count,
 * CFG and control strengths the registry defines. Something has to cross the
 * language boundary, and the two honest options are "the deployment re-declares
 * the recipes" or "the deployment reads a generated copy". A re-declaration is a
 * second source of truth that drifts silently — a revision bump in TypeScript
 * would leave the deployed renderer running last month's numbers while every
 * render's provenance recorded the new revision id.
 *
 * So the copy is GENERATED and its freshness is GATED:
 * `scripts/sd-deployment-recipes.test.ts` runs in the ordinary pure suite and
 * fails if `recipes.json` stops matching `sdRecipes`. The generated file is
 * checked in rather than built at image-build time because `cog build` runs from
 * a directory that has no access to the workspace's TypeScript.
 *
 * Operator tooling, deliberately outside the application: nothing in `src/`
 * imports it, and it imports nothing from `src/`.
 */

const OUTPUT_PATH = resolve(dirname(fileURLToPath(import.meta.url)), "..", "packages/image-sd/deployment/recipes.json");

/** The exact bytes `recipes.json` must contain. */
function serializeSdRecipes(): string {
  return `${JSON.stringify(sdRecipes, null, 2)}\n`;
}

/** Where the generated copy lives, so the test and the generator cannot disagree. */
export const SD_DEPLOYMENT_RECIPES_PATH = OUTPUT_PATH;

/** How a developer regenerates it, quoted verbatim in the test's failure message. */
export const SD_DEPLOYMENT_RECIPES_COMMAND = "pnpm tsx scripts/generate-sd-deployment-recipes.ts";

function main(): void {
  writeFileSync(OUTPUT_PATH, serializeSdRecipes(), "utf8");
  console.log(`Wrote ${String(sdRecipes.length)} recipe(s) to ${OUTPUT_PATH}`);
}

const isMain = process.argv[1] !== undefined && process.argv[1] === fileURLToPath(import.meta.url);
if (isMain) main();
