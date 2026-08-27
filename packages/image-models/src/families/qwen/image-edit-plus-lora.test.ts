import { describe, expect, it } from "vitest";
import { qwenImageEdit2511 } from "./image-edit-2511";
import { qwenImageEditPlusLora } from "./image-edit-plus-lora";

/**
 * The LoRA wrapper's execution hints.
 *
 * This is not a literal pinned for its own sake. The Stage 0 baseline is a
 * bench run that sat in a cold start past its entire five-minute budget and was
 * aborted before it ever started, which Vesper then reported as a render
 * failure. Two edits would silently re-create that run: narrowing the startup
 * budget back under the observed queue, or "completing" the hint with a render
 * budget nobody has measured — an invented render budget is enforced against a
 * real render, and the shortest number wins.
 *
 * The contrast with the sibling editor is the rule being protected: an
 * execution hint is a claim about an endpoint somebody watched misbehave, not a
 * field every adapter fills in.
 */
describe("qwen edit + LoRA execution hints", () => {
  it("budgets a startup queue longer than the one that aborted the baseline run, and leaves the render budget to the lane", () => {
    const hints = qwenImageEditPlusLora.executionHints;

    expect(hints?.startupBudgetMs).toBeGreaterThan(5 * 60_000);
    expect(hints?.maxStartupRetries).toBe(1);
    expect(hints).not.toHaveProperty("renderBudgetMs");

    expect(qwenImageEdit2511.executionHints).toBeUndefined();
  });
});
