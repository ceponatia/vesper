"use client";

import { useState } from "react";
import type { CharacterDraft } from "@/lib/client/api";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { Select } from "@/components/ui/select";
import { applyCharacterProposal, describeProposalValue, proposalChanges, proposalConflicts, valueAt, type CharacterProposal, type CharacterReviewState, type ProposalChoices } from "./character-proposals";

export function CharacterProposalReview({ draft, review, onReviewChange, onChange }: {
  draft: CharacterDraft;
  review: CharacterReviewState;
  onReviewChange: (review: CharacterReviewState) => void;
  onChange: (draft: CharacterDraft) => void;
}) {
  const [openId, setOpenId] = useState<string | null>(null);
  const proposal = review.pending.find((p) => p.id === openId) ?? (review.undo?.id === openId ? review.undo : null);
  const accept = (item: CharacterProposal, choices: ProposalChoices) => {
    const result = applyCharacterProposal(draft, item, choices);
    if (result.unresolved.length) return;
    onChange(result.draft);
    onReviewChange({ pending: review.pending.filter((p) => p.id !== item.id), undo: item.undo ? null : result.undo });
    setOpenId(null);
  };
  if (!review.pending.length && !review.undo) return null;
  return (
    <section aria-label="Character suggestions" className="mb-5 rounded-card border border-accent-500/40 bg-ink-850 p-4">
      <p className="text-sm font-medium text-paper-200">{review.pending.length ? `${review.pending.length} suggestion${review.pending.length === 1 ? "" : "s"} awaiting review` : "Changes accepted"}</p>
      <p className="mt-1 text-xs text-paper-400">Your edits save independently. Suggestions only apply when you accept them.</p>
      <div className="mt-3 flex flex-wrap gap-2">
        {review.pending.map((item) => <Button key={item.id} onClick={() => setOpenId(item.id)}>Review {item.label}</Button>)}
        {review.undo ? <Button variant="ghost" onClick={() => setOpenId(review.undo?.id ?? null)}>Undo last accepted changes</Button> : null}
      </div>
      {proposal ? <ReviewDialog key={proposal.id} draft={draft} proposal={proposal} onClose={() => setOpenId(null)} onAccept={(choices) => accept(proposal, choices)} onReject={() => {
        onReviewChange({ ...review, pending: review.pending.filter((p) => p.id !== proposal.id), undo: proposal.undo ? null : review.undo });
        setOpenId(null);
      }} /> : null}
    </section>
  );
}

function ReviewDialog({ draft, proposal, onClose, onAccept, onReject }: {
  draft: CharacterDraft; proposal: CharacterProposal; onClose: () => void;
  onAccept: (choices: ProposalChoices) => void; onReject: () => void;
}) {
  const [choices, setChoices] = useState<ProposalChoices>({});
  const conflicts = proposalConflicts(draft, proposal);
  const unresolved = conflicts.filter((change) => !choices[change.key]);
  const changes = proposalChanges(proposal);
  return (
    <Dialog open onClose={onClose} size="xl" title={proposal.label} footer={<div className="flex flex-wrap justify-end gap-2">
      <Button onClick={onClose}>Review later</Button>
      <Button onClick={onReject}>{proposal.undo ? "Dismiss undo" : "Reject"}</Button>
      <Button variant="primary" disabled={unresolved.length > 0} onClick={() => onAccept(choices)}>{proposal.undo ? "Undo selected" : "Accept selected"}</Button>
    </div>}>
      <p className="mb-4 text-sm text-paper-400">{proposal.undo ? "Restore accepted changes. Any later edits are kept unless you explicitly choose to replace them." : "Compare the original values with these suggestions. Changes you made since generation started are shown as conflicts."}</p>
      {!changes.length ? <p className="text-sm text-paper-400">No changes were proposed.</p> : null}
      <div className="flex flex-col gap-3">
        {changes.map((change) => {
          const conflict = conflicts.some((c) => c.key === change.key);
          return <div key={change.key} className="rounded-md border border-ink-600 p-3">
            <p className="text-sm font-medium capitalize text-paper-200">{change.label}</p>
            <div className="mt-2 grid gap-3 text-sm sm:grid-cols-2">
              <div><p className="text-xs text-paper-500">Before generation</p><p className="whitespace-pre-wrap break-words">{describeProposalValue(change.before)}</p></div>
              <div><p className="text-xs text-paper-500">{proposal.undo ? "Restore" : "Suggested"}</p><p className="whitespace-pre-wrap break-words">{describeProposalValue(change.after)}</p></div>
            </div>
            {conflict ? <p className="mt-2 whitespace-pre-wrap break-words text-sm text-warning">Changed since generation: {describeProposalValue(valueAt(draft, change.path))}</p> : null}
            <Select className="mt-3" aria-label={`Choice for ${change.label}`} value={choices[change.key] ?? (conflict ? "" : "proposed")} onChange={(event) => setChoices((old) => ({ ...old, [change.key]: event.target.value as "current" | "proposed" }))}>
              {conflict ? <option value="" disabled>Choose how to resolve this change</option> : null}
              <option value="proposed">{proposal.undo ? "Restore previous value" : "Use suggested value"}</option>
              <option value="current">Keep my current value</option>
            </Select>
          </div>;
        })}
      </div>
      {unresolved.length ? <p role="status" className="mt-3 text-sm text-warning">Resolve {unresolved.length} conflicting change{unresolved.length === 1 ? "" : "s"} to continue.</p> : null}
    </Dialog>
  );
}
