"use client";

import { useState } from "react";
import { referenceViewAngles, referenceViewWardrobeEntries, referenceViewFeedbackReasons, type ReferenceViewFeedback, type ReferenceViewSetSummary, type ReferenceViewSummary } from "@/contracts";
import { referenceViewsApi } from "@/lib/client/api";
import { Button } from "@/components/ui/button";
import { Field } from "@/components/ui/field";
import { ImageLightbox } from "@/components/ui/image-lightbox";
import { Tag } from "@/components/ui/tag";
import { Textarea } from "@/components/ui/textarea";
import { referenceViewFeedbackReasonCopy, referenceViewStateCopy } from "./reference-view-copy";
import {
  hasReferenceViewFeedbackDraft,
  referenceViewFeedbackForAttempt,
  type ReferenceViewFeedbackDrafts,
} from "./reference-view-review-drafts";

export function referenceViewLabel(view: Pick<ReferenceViewSummary, "angle" | "wardrobe">): string {
  return `${referenceViewAngles.find((angle) => angle.id === view.angle)?.label ?? view.angle}, ${referenceViewWardrobeEntries.find((wardrobe) => wardrobe.id === view.wardrobe)?.label ?? view.wardrobe}`;
}

export function ReferenceViewFeedbackNote({ feedback }: { feedback: ReferenceViewFeedback | null }) {
  if (!feedback || (!feedback.reasons.length && !feedback.correction)) return null;
  return <div className="space-y-1 text-sm text-paper-400">
    {feedback.reasons.length ? <p>{feedback.reasons.map((reason) => referenceViewFeedbackReasonCopy[reason]).join(" · ")}</p> : null}
    {feedback.correction ? <p className="whitespace-pre-wrap break-words">{feedback.correction}</p> : null}
  </div>;
}

export function ReferenceViewReviewer({
  characterId,
  initialView,
  set,
  onChanged,
  onClose,
  drafts,
  onDraftChange,
  onDraftDiscard,
}: {
  characterId: string;
  initialView: ReferenceViewSummary;
  set: ReferenceViewSetSummary;
  onChanged: () => void;
  onClose: () => void;
  drafts: ReferenceViewFeedbackDrafts;
  onDraftChange: (attemptId: string, feedback: ReferenceViewFeedback) => void;
  onDraftDiscard: (attemptId: string) => void;
}) {
  // Keep the displayed attempt until the author explicitly refreshes or navigates.
  // Polling must never change the image underneath a pending verdict or feedback.
  const [view, setView] = useState(initialView);
  const [acceptedImageId, setAcceptedImageId] = useState(set.acceptedImageId);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [rejecting, setRejecting] = useState(false);
  const index = set.views.findIndex((entry) => entry.angle === view.angle && entry.wardrobe === view.wardrobe);
  const latest = set.views[index];
  const changed = (latest && (latest.attemptId !== view.attemptId || latest.reviewRevision > view.reviewRevision || (latest.reviewRevision === view.reviewRevision && (latest.imageId !== view.imageId || latest.state !== view.state)))) || set.acceptedImageId !== acceptedImageId;
  const feedback = referenceViewFeedbackForAttempt(drafts, view.attemptId, view.feedback);
  const setFeedback = (value: ReferenceViewFeedback) => {
    if (view.attemptId !== null) onDraftChange(view.attemptId, value);
  };
  const copy = referenceViewStateCopy[view.state];

  const move = (offset: number) => {
    const target = set.views[index + offset];
    if (!target || busy) return;
    setView(target); setAcceptedImageId(set.acceptedImageId); setError(null); setNotice(null); setRejecting(false);
  };
  const refresh = async () => {
    setBusy(true);
    const result = await referenceViewsApi.get(characterId);
    setBusy(false);
    if (!result.ok) { setError(result.error.message); return; }
    const current = result.data.set.views.find((entry) => entry.angle === view.angle && entry.wardrobe === view.wardrobe);
    if (!current) { setError("This view is no longer available. Close the viewer and refresh the reference views."); return; }
    setView(current); setAcceptedImageId(result.data.set.acceptedImageId); setError(null); setNotice(null); setRejecting(false); onChanged();
  };
  const review = async (verdict: "approve" | "reject" | "undo") => {
    const attemptId = view.attemptId;
    if (!attemptId || busy) return;
    setBusy(true); setError(null); setNotice(null);
    const result = await referenceViewsApi.review(characterId, view.angle, view.wardrobe, {
      attemptId, expectedRevision: view.reviewRevision, verdict,
      ...(verdict === "reject" ? { feedback } : {}),
    });
    setBusy(false);
    if (!result.ok) { setError(result.error.message); return; }
    if (verdict === "reject") onDraftDiscard(attemptId);
    setView(result.data.view); setRejecting(false);
    setNotice(verdict === "undo" ? "Review undone. This view needs approval before it can be used." : verdict === "approve" ? "View approved." : "View rejected. Your feedback is saved with this attempt.");
    onChanged();
  };

  return <ImageLightbox open imageId={view.imageId} viewKey={`${view.angle}:${view.wardrobe}:${view.attemptId ?? "missing"}`} alt={referenceViewLabel(view)} caption={referenceViewLabel(view)}
    comparisonImageId={acceptedImageId} onClose={onClose} emptyMessage={view.failureMessage ?? copy.hint}
    onPrevious={index > 0 && !busy ? () => move(-1) : undefined}
    onNext={index < set.views.length - 1 && !busy ? () => move(1) : undefined}
    controls={({ imageStatus }) => <div className="mx-auto flex max-w-5xl flex-col gap-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-2"><span className="text-sm font-medium">{referenceViewLabel(view)}</span><Tag tone={copy.tone}>{copy.label}</Tag><span className="text-sm text-paper-400">{index + 1} of {set.views.length}</span></div>
        <div className="flex gap-2"><Button size="sm" variant="ghost" aria-keyshortcuts="ArrowLeft" disabled={index <= 0 || busy} onClick={() => move(-1)}>Previous</Button><Button size="sm" variant="ghost" aria-keyshortcuts="ArrowRight" disabled={index >= set.views.length - 1 || busy} onClick={() => move(1)}>Next</Button></div>
      </div>
      {changed ? <p role="status" className="text-sm text-paper-200">This view or its accepted portrait changed elsewhere. Refresh before reviewing.</p> : null}
      {error ? <p role="alert" className="text-sm text-paper-200">{error}</p> : null}
      {notice ? <p role="status" className="text-sm text-paper-300">{notice}</p> : null}
      {changed || error ? <Button size="sm" className="self-start" busy={busy} onClick={() => void refresh()}>Refresh view</Button> : null}
      {rejecting ? <div className="flex flex-col gap-3">
        <fieldset disabled={busy} className="flex flex-wrap gap-x-4 gap-y-1"><legend className="mb-1 text-sm font-medium">Why is this unsuitable? (optional)</legend>
          {referenceViewFeedbackReasons.map((reason) => <label key={reason} className="touch-target flex cursor-pointer items-center gap-2 text-sm"><input type="checkbox" className="accent-accent-500" checked={feedback.reasons.includes(reason)} onChange={(event) => setFeedback({ ...feedback, reasons: event.target.checked ? [...feedback.reasons, reason] : feedback.reasons.filter((value) => value !== reason) })} />{referenceViewFeedbackReasonCopy[reason]}</label>)}
        </fieldset>
        <Field label="Correction note (optional)" hint="Saved with this attempt for review. This note does not change regeneration instructions.">{(controlId) => <Textarea id={controlId} rows={2} maxLength={1000} value={feedback.correction} disabled={busy} onChange={(event) => setFeedback({ ...feedback, correction: event.target.value })} />}</Field>
        <div className="flex flex-wrap gap-2"><Button size="sm" variant="primary" busy={busy} disabled={Boolean(changed)} onClick={() => void review("reject")}>Reject view</Button><Button size="sm" variant="quiet" disabled={busy} onClick={() => setRejecting(false)}>Keep for later</Button>{hasReferenceViewFeedbackDraft(drafts, view.attemptId) ? <Button size="sm" variant="ghost" disabled={busy} onClick={() => { if (view.attemptId !== null) onDraftDiscard(view.attemptId); setRejecting(false); }}>Discard feedback</Button> : null}</div>
      </div> : <>
        <ReferenceViewFeedbackNote feedback={view.feedback} />
        <div className="flex flex-wrap items-center gap-2">
          {view.state === "unreviewed" ? <><Button size="sm" variant="primary" busy={busy} disabled={Boolean(changed) || imageStatus !== "loaded"} onClick={() => { if (imageStatus === "loaded") void review("approve"); }}>Approve</Button><Button size="sm" variant="quiet" disabled={busy || Boolean(changed)} onClick={() => setRejecting(true)}>Reject</Button>{imageStatus !== "loaded" ? <p className="text-sm text-paper-400">Load the reference image before approving it.</p> : null}</> : null}
          {view.state === "approved" || view.state === "rejected" ? <Button size="sm" variant="ghost" busy={busy} disabled={Boolean(changed)} onClick={() => void review("undo")}>Undo review</Button> : null}
          {view.state !== "approved" && view.state !== "unreviewed" && view.state !== "rejected" ? <p className="text-sm text-paper-400">{view.failureMessage ?? copy.hint}</p> : null}
        </div>
      </>}
    </div>} />;
}
