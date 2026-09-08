import { describe, expect, it } from "vitest";
import {
  discardReferenceViewFeedbackDraft,
  hasReferenceViewFeedbackDraft,
  referenceViewFeedbackForAttempt,
  writeReferenceViewFeedbackDraft,
} from "./reference-view-review-drafts";

describe("reference rejection feedback drafts", () => {
  it("restores feedback for the exact attempt and clears only the submitted or discarded attempt", () => {
    const first = { reasons: ["wrong_angle" as const], correction: "Turn farther left." };
    const second = { reasons: ["image_defect" as const], correction: "Repair the hand." };
    let drafts = writeReferenceViewFeedbackDraft({}, "attempt-a", first);
    drafts = writeReferenceViewFeedbackDraft(drafts, "attempt-b", second);

    expect(referenceViewFeedbackForAttempt(drafts, "attempt-a", null)).toEqual(first);
    expect(referenceViewFeedbackForAttempt(drafts, "attempt-b", null)).toEqual(second);
    expect(referenceViewFeedbackForAttempt(drafts, "attempt-c", { reasons: [], correction: "Saved note" }))
      .toEqual({ reasons: [], correction: "Saved note" });

    drafts = discardReferenceViewFeedbackDraft(drafts, "attempt-a");
    expect(hasReferenceViewFeedbackDraft(drafts, "attempt-a")).toBe(false);
    expect(referenceViewFeedbackForAttempt(drafts, "attempt-b", null)).toEqual(second);
  });
});
