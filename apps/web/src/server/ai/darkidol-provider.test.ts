import { describe, expect, it } from "vitest";
import { NARRATIVE_MODELS, narrativeModelProvider } from "@/lib/narrative-models";
import {
  DARKIDOL_QWEN38_ID,
  featherlessRequestBody,
  narratorHiddenRetryModel,
  narratorRetryFloorOptions,
} from "./provider";

describe("DarkIdol Featherless narrator", () => {
  it("is curated as a Featherless narrator", () => {
    const option = NARRATIVE_MODELS.find((candidate) => candidate.id === DARKIDOL_QWEN38_ID);
    expect(option).toEqual({
      id: DARKIDOL_QWEN38_ID,
      label: "DarkIdol Qwen3.8 27B v1.1 (32K)",
      provider: "featherless",
    });
    expect(narrativeModelProvider(DARKIDOL_QWEN38_ID)).toBe("featherless");
  });

  it("applies the supported author-recommended sampler and medium reasoning settings", () => {
    expect(
      featherlessRequestBody({
        model: DARKIDOL_QWEN38_ID,
        messages: [],
        temperature: 0.85,
      }),
    ).toEqual({
      model: DARKIDOL_QWEN38_ID,
      messages: [],
      temperature: 1.0,
      min_p: 0.05,
      chat_template_kwargs: { reasoning_effort: "medium" },
    });
  });

  it("does not inherit the DavidAU hidden-empty retry policy", () => {
    expect(narratorHiddenRetryModel(DARKIDOL_QWEN38_ID)).toBe(false);
    expect(narratorRetryFloorOptions(DARKIDOL_QWEN38_ID)).toBeUndefined();
  });
});
