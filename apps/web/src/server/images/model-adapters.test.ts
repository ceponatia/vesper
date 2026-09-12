import { imageModelSchema, type ImageModel } from "@vesper/image-core";
import { describe, expect, it } from "vitest";
import { benchExecutionPolicy, prepareModelPrompt } from "./model-adapters";

/**
 * `model-adapters.ts` is where an adapter's (absent) hooks join the render
 * path — `preparePromptFor`/`prepareModelPrompt` fall back to the identity
 * preparer and `benchExecutionPolicy` falls back to the bench lane's own
 * defaults whenever `adapterForImageModel` has no hook to offer. No shipped
 * adapter, Qwen or the FLUX.2 klein family added in #567, composes
 * `preparePrompt` or `executionHints`, and nothing pinned that fallback for a
 * REGISTERED adapter before this file
 * (`grep -rn "benchExecutionPolicy\|preparePromptFor\|prepareModelPrompt"
 * apps/web/src --include='*.test.ts'` found no existing coverage when #567
 * was built). The klein distilled row is the fixture because it is the
 * nearest registered adapter with no hooks; nothing here asserts anything
 * klein-specific beyond "this adapter contributes no hook".
 */

function kleinRow(overrides: Partial<ImageModel> = {}): ImageModel {
  return imageModelSchema.parse({
    id: "klein-row",
    slug: "black-forest-labs/flux-2-klein-4b",
    label: "FLUX.2 klein 4B",
    canGenerate: true,
    canEdit: true,
    referenceArity: "array",
    ...overrides,
  });
}

describe("model-adapters: a registered adapter with no hooks", () => {
  it("passes the authored prompt through byte-identical", () => {
    const prompt = "a woman in a red dress, cinematic lighting, reference 1 is the identity";
    expect(prepareModelPrompt(kleinRow(), prompt, 2)).toBe(prompt);
  });

  it("uses the bench lane's own defaults for execution policy, contributing no hint", () => {
    expect(benchExecutionPolicy(kleinRow())).toEqual({
      startupBudgetMs: 8 * 60_000,
      renderBudgetMs: 3 * 60_000,
      maxStartupRetries: 1,
    });
  });
});
