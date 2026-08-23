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
  hf_repo_id?: string;
  hf_filename?: string;
};

type WeightManifest = { artifacts?: WeightArtifact[] };

/**
 * The static renderer weights intentionally appear twice: the manifest is the
 * runtime/provenance contract, while cog.yaml has to contain the build-time
 * download declarations because Cog's build.run commands cannot read source
 * files. If those declarations drift, a rebuild can bake different bytes than
 * the predictor says it pinned. Keep that duplication mechanically checked.
 */
describe("the SD deployment's baked weights", () => {
  it("contains every artifact pinned by weights_manifest.json", () => {
    const deploymentDir = resolve(process.cwd(), "packages/image-sd/deployment");
    const manifest = JSON.parse(
      readFileSync(resolve(deploymentDir, "weights_manifest.json"), "utf8"),
    ) as WeightManifest;
    const cog = readFileSync(resolve(deploymentDir, "cog.yaml"), "utf8");

    expect(manifest.artifacts?.length).toBeGreaterThan(0);
    for (const artifact of manifest.artifacts ?? []) {
      const name = artifact.name ?? "<unnamed>";
      const required =
        artifact.kind === "hf_hub"
          ? [artifact.sha256, artifact.filename, artifact.hf_repo_id, artifact.hf_filename]
          : [artifact.source_url, artifact.sha256, artifact.filename];

      for (const value of required) {
        expect(value, `${name} has an incomplete manifest declaration`).toBeTruthy();
        expect(
          cog,
          `${name} is pinned in weights_manifest.json but absent from cog.yaml`,
        ).toContain(value);
      }
    }
  });
});
