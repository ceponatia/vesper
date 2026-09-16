import { describe, expect, it } from "vitest";
import {
  MAX_TRIAL_PREDICTION_MS,
  TRIAL_FALLBACK_PREDICTION_MS,
  type ImageModel,
  imageModelSchema,
} from "@vesper/image-core";
import { CIVITAI_FLUX2_KLEIN4B_SLUG } from "@vesper/image-models";
import { benchPredictionBudgetMs } from "./image-generator-request";

/**
 * `benchPredictionBudgetMs` (pure): which prediction budget the admin Image
 * Generator plans a bench run under.
 *
 * The defect this suite kills: the Civitai adapter's own nullish default was
 * raised to fifteen minutes, but the bench profile — this row's ONLY selectable
 * surface — always supplied `TRIAL_FALLBACK_PREDICTION_MS`, so the adapter's
 * default could never be selected and the longer budget was inert. The fix has
 * to live where the plan states its budget, and nothing covered that, which is
 * exactly why it shipped.
 *
 * Why the lane differs at all: Civitai debits Buzz at submit and neither cancels
 * nor refunds when the client stops polling, so a budget shorter than its shared
 * queue discards an image the account has already paid for. A compute-billed
 * provider has the opposite economics — stopping the wait stops the charge — so
 * five minutes stays correct there.
 */
describe("image generator bench prediction budget", () => {
  function model(slug: string): ImageModel {
    return imageModelSchema.parse({
      id: "budget-fixture",
      slug,
      label: slug,
      canGenerate: true,
      canEdit: false,
      probedVersionId: "v1",
    });
  }

  it("plans the Civitai lane at the profile ceiling, where the budget is spent on queue time", () => {
    expect(benchPredictionBudgetMs(model(CIVITAI_FLUX2_KLEIN4B_SLUG))).toBe(MAX_TRIAL_PREDICTION_MS);

    // The ceiling is the stored-profile maximum, so the value is legal to plan
    // with rather than a number that would be clamped back down downstream.
    expect(MAX_TRIAL_PREDICTION_MS).toBeGreaterThan(TRIAL_FALLBACK_PREDICTION_MS);
  });

  it("leaves a compute-billed provider on the ordinary default", () => {
    for (const slug of ["qwen/qwen-image-edit-2511", "black-forest-labs/flux-2-klein-4b"]) {
      expect(benchPredictionBudgetMs(model(slug)), slug).toBe(TRIAL_FALLBACK_PREDICTION_MS);
    }
  });
});
