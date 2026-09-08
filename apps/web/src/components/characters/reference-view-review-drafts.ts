import type { ReferenceViewFeedback } from "@/contracts";

/** In-progress rejection feedback, scoped to the exact stored attempt. */
export type ReferenceViewFeedbackDrafts = Readonly<Record<string, ReferenceViewFeedback>>;

const EMPTY_FEEDBACK: ReferenceViewFeedback = { reasons: [], correction: "" };

export function referenceViewFeedbackForAttempt(
  drafts: ReferenceViewFeedbackDrafts,
  attemptId: string | null,
  saved: ReferenceViewFeedback | null,
): ReferenceViewFeedback {
  return (attemptId === null ? undefined : drafts[attemptId]) ?? saved ?? EMPTY_FEEDBACK;
}

export function writeReferenceViewFeedbackDraft(
  drafts: ReferenceViewFeedbackDrafts,
  attemptId: string,
  feedback: ReferenceViewFeedback,
): ReferenceViewFeedbackDrafts {
  return { ...drafts, [attemptId]: feedback };
}

/** Clear only the submitted or explicitly discarded attempt; sibling drafts survive. */
export function discardReferenceViewFeedbackDraft(
  drafts: ReferenceViewFeedbackDrafts,
  attemptId: string,
): ReferenceViewFeedbackDrafts {
  if (!(attemptId in drafts)) return drafts;
  const next = { ...drafts };
  delete next[attemptId];
  return next;
}

export function hasReferenceViewFeedbackDraft(
  drafts: ReferenceViewFeedbackDrafts,
  attemptId: string | null,
): boolean {
  return attemptId !== null && attemptId in drafts;
}
