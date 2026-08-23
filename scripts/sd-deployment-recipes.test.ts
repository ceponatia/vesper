import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { sdRecipes } from "@vesper/image-sd";
import { describe, expect, it } from "vitest";
import {
  SD_DEPLOYMENT_RECIPES_COMMAND,
  SD_DEPLOYMENT_RECIPES_PATH,
} from "./generate-sd-deployment-recipes";

/**
 * Tripwire: the deployment's `recipes.json` still matches the recipe registry.
 *
 * `packages/image-sd/deployment/` is a Cog/ComfyUI image with no TypeScript in
 * it, and its predictor resolves the `recipe` input it is handed to a sampler,
 * a scheduler, a step count, a CFG and control strengths. Those numbers are
 * defined once, in `sd-recipe-registry.ts`, and generated across the language
 * boundary by `scripts/generate-sd-deployment-recipes.ts`.
 *
 * Nothing else notices when the copy goes stale. Typecheck does not read JSON,
 * the package boundary checker does not either, and the deployed renderer would
 * keep producing perfectly plausible images under the previous revision's
 * settings while every render's provenance recorded the NEW revision id — which
 * is exactly the failure the recipe contract exists to prevent.
 *
 * The defect this kills: adding revision 2 of a recipe (or editing a value in
 * the registry) and shipping without re-running the generator.
 */

describe("the SD deployment's recipe copy", () => {
  it("matches the @vesper/image-sd registry", () => {
    const generated: unknown = JSON.parse(readFileSync(SD_DEPLOYMENT_RECIPES_PATH, "utf8"));
    expect(generated, `recipes.json is stale — regenerate it with: ${SD_DEPLOYMENT_RECIPES_COMMAND}`).toEqual(
      sdRecipes,
    );
  });
});

type WeightArtifact = {
  name?: string;
  kind?: string;
  source_url?: string;
  filename?: string;
  sha256?: string;
  target_root?: string;
  target_dir?: string;
  hf_repo_id?: string;
  hf_filename?: string;
};

type WeightManifest = { artifacts?: WeightArtifact[] };

function expectedBakeDestination(artifact: WeightArtifact): string | null {
  if (!artifact.filename || artifact.target_dir === undefined) return null;
  let root: string | null = null;
  if (artifact.target_root === "comfyui") root = "/ComfyUI";
  if (artifact.target_root === "facexlib") root = "$FACEXLIB_DIR";
  if (!root) return null;
  return [root, artifact.target_dir, artifact.filename].filter(Boolean).join("/");
}

/**
 * The static renderer weights intentionally appear twice: the manifest is the
 * runtime/provenance contract, while cog.yaml has to contain the build-time
 * download declarations because Cog's build.run commands cannot read source
 * files. If those declarations drift, a rebuild can bake different bytes than
 * the predictor says it pinned. Keep the identity AND destination mechanically
 * checked; the Python deployment checker additionally verifies each ordinary
 * URL + destination + digest as one tuple.
 */
describe("the SD deployment's baked weights", () => {
  const deploymentDir = resolve(process.cwd(), "packages/image-sd/deployment");
  const manifest = JSON.parse(
    readFileSync(resolve(deploymentDir, "weights_manifest.json"), "utf8"),
  ) as WeightManifest;
  const cog = readFileSync(resolve(deploymentDir, "cog.yaml"), "utf8");

  it("contains every artifact pinned by weights_manifest.json at its declared target", () => {
    expect(manifest.artifacts?.length).toBeGreaterThan(0);
    for (const artifact of manifest.artifacts ?? []) {
      const name = artifact.name ?? "<unnamed>";
      const required =
        artifact.kind === "hf_hub"
          ? [artifact.sha256, artifact.filename, artifact.hf_repo_id, artifact.hf_filename]
          : [
              artifact.source_url,
              artifact.sha256,
              artifact.filename,
              expectedBakeDestination(artifact),
            ];

      for (const value of required) {
        expect(value, `${name} has an incomplete manifest declaration`).toBeTruthy();
        expect(
          cog,
          `${name} is pinned in weights_manifest.json but absent or mis-targeted in cog.yaml`,
        ).toContain(value);
      }
    }
  });

  it("keeps baked Hugging Face assets cache-first and ComfyUI offline", () => {
    const predictor = readFileSync(resolve(deploymentDir, "predict.py"), "utf8");
    expect(predictor).toContain("try_to_load_from_cache");
    expect(predictor).toContain('os.environ["HF_HUB_OFFLINE"] = "1"');
  });
});
