"use client";

import { useState, type ReactNode } from "react";
import type { CharacterDraft } from "@/lib/client/api";
import { portraitVisibilityLabel, type PortraitFieldEvidence } from "@/lib/portrait-extraction";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { EntityImage } from "@/components/ui/entity-image";
import { Select } from "@/components/ui/select";
import { applyCharacterProposal, describeProposalValue, proposalChanges, proposalConflicts, valueAt, type CharacterProposal, type CharacterReviewState, type ProposalChoices } from "./character-proposals";

function evidenceForChange(proposal: CharacterProposal, path: readonly (string | { id: string })[]): PortraitFieldEvidence | null {
  const id = path.find((part): part is { id: string } => typeof part === "object")?.id;
  return id ? proposal.portraitEvidence?.fields.find((field) => field.id === id) ?? null : null;
}

function EvidenceRegion({ imageId, field }: { imageId: string; field: PortraitFieldEvidence }) {
  const region = field.evidenceRegion;
  return <div className="relative mt-2 aspect-[3/4] w-36 overflow-hidden rounded-md border border-ink-600 bg-ink-900">
    <EntityImage imageId={imageId} name={field.id} alt={`Portrait evidence for ${field.id}`} className="size-full object-cover" />
    {region ? <span aria-hidden className="absolute border-2 border-accent-400 bg-accent-500/10" style={{
      left: `${region.left / 100}%`, top: `${region.top / 100}%`, width: `${region.width / 100}%`, height: `${region.height / 100}%`,
    }} /> : null}
  </div>;
}

export function CharacterProposalReview({ draft, review, onReviewChange, onChange, onDecision, disabled = false, isBlocked }: {
  draft: CharacterDraft;
  review: CharacterReviewState;
  disabled?: boolean;
  isBlocked?: () => boolean;
  onReviewChange: (review: CharacterReviewState) => void;
  onChange: (draft: CharacterDraft) => void;
  onDecision?: (proposal: CharacterProposal, action: "accept" | "reject" | "undo" | "dismiss", choices: ProposalChoices) => Promise<{
    applyLocally: boolean;
    appliedDraft: CharacterDraft | null;
    undo: CharacterProposal | null;
  } | null>;
}) {
  const [openId, setOpenId] = useState<string | null>(null);
  const proposal = review.pending.find((p) => p.id === openId) ?? (review.undo?.id === openId ? review.undo : null);
  const blocked = () => disabled || isBlocked?.() === true;
  const [deciding, setDeciding] = useState(false);
  const accept = async (item: CharacterProposal, choices: ProposalChoices) => {
    if (blocked()) return;
    const result = applyCharacterProposal(draft, item, choices);
    if (result.unresolved.length) return;
    setDeciding(true);
    const persisted = item.sourceRunId && onDecision
      ? await onDecision(item, item.undo ? "undo" : "accept", choices)
      : { applyLocally: true, appliedDraft: result.draft, undo: item.undo ? null : result.undo };
    setDeciding(false);
    if (!persisted) return;
    if (persisted.applyLocally && persisted.appliedDraft) onChange(persisted.appliedDraft);
    const handledId = item.sourceRunId ?? item.id;
    onReviewChange({ ...review, pending: review.pending.filter((p) => p.id !== item.id), handledIds: [...new Set([...(review.handledIds ?? []), handledId])], undo: persisted.undo });
    setOpenId(null);
  };
  if (!review.pending.length && !review.undo) return null;
  return (
    <section aria-label="Character suggestions" className="mb-5 rounded-card border border-accent-500/40 bg-ink-850 p-4">
      <p className="text-sm font-medium text-paper-200">{review.pending.length ? `${review.pending.length} suggestion${review.pending.length === 1 ? "" : "s"} awaiting review` : "Changes accepted"}</p>
      <p className="mt-1 text-xs text-paper-400">Your edits save independently. Suggestions only apply when you accept them.</p>
      <div className="mt-3 flex flex-wrap gap-2">
        {review.pending.map((item) => <Button key={item.id} disabled={disabled} onClick={() => { if (!blocked()) setOpenId(item.id); }}>Review {item.label}</Button>)}
        {review.undo ? <Button variant="ghost" disabled={disabled} onClick={() => { if (!blocked()) setOpenId(review.undo?.id ?? null); }}>Undo last accepted changes</Button> : null}
      </div>
      {proposal && !disabled ? <CharacterProposalDialog key={proposal.id} draft={draft} proposal={proposal} disabled={deciding} onClose={() => setOpenId(null)} onAccept={(choices) => { void accept(proposal, choices); }} onReject={() => {
        if (blocked()) return;
        void (async () => {
          setDeciding(true);
          const persisted = proposal.sourceRunId && onDecision
            ? await onDecision(proposal, proposal.undo ? "dismiss" : "reject", {})
            : { applyLocally: false, appliedDraft: null, undo: proposal.undo ? null : review.undo };
          setDeciding(false);
          if (!persisted) return;
          const handledId = proposal.sourceRunId ?? proposal.id;
          onReviewChange({ ...review, pending: review.pending.filter((p) => p.id !== proposal.id), handledIds: [...new Set([...(review.handledIds ?? []), handledId])], undo: persisted.undo });
          setOpenId(null);
        })();
      }} /> : null}
    </section>
  );
}

export function CharacterProposalDialog({ draft, proposal, onClose, onAccept, onReject, purpose = "generated", children, acceptDisabled = false, disabled = false }: {
  draft: CharacterDraft; proposal: CharacterProposal; onClose: () => void;
  onAccept: (choices: ProposalChoices) => void; onReject: () => void;
  purpose?: "generated" | "recovery";
  children?: ReactNode;
  acceptDisabled?: boolean;
  disabled?: boolean;
}) {
  const changes = proposalChanges(proposal);
  const [choices, setChoices] = useState<ProposalChoices>(() => Object.fromEntries(changes.flatMap((change) => {
    const evidence = evidenceForChange(proposal, change.path);
    return evidence && !evidence.defaultSelected ? [[change.key, "current" as const]] : [];
  })));
  const conflicts = proposalConflicts(draft, proposal);
  const unresolved = conflicts.filter((change) => !choices[change.key]);
  const portrait = proposal.portraitEvidence;
  const requestClose = () => {
    if (!disabled) onClose();
  };
  return (
    <Dialog open onClose={requestClose} size="xl" title={proposal.label} footer={<div className="flex flex-wrap justify-end gap-2">
      <Button disabled={disabled} onClick={requestClose}>Review later</Button>
      <Button disabled={disabled} onClick={onReject}>{purpose === "recovery" ? "Use saved version" : proposal.undo ? "Dismiss undo" : "Reject"}</Button>
      <Button variant="primary" disabled={disabled || acceptDisabled || unresolved.length > 0} onClick={() => onAccept(choices)}>{purpose === "recovery" ? "Restore selected" : proposal.undo ? "Undo selected" : "Accept selected"}</Button>
    </div>}>
      <p className="mb-4 text-sm text-paper-400">{purpose === "recovery" ? "These edits were retained in your browser. Compare them with the saved character and choose which changes to restore." : proposal.undo ? "Restore accepted changes. Any later edits are kept unless you explicitly choose to replace them." : "Compare the original values with these suggestions. Changes you made since generation started are shown as conflicts."}</p>
      {portrait ? <div className="mb-4 flex flex-wrap items-start gap-3 rounded-md border border-ink-600 bg-ink-900/60 p-3">
        <EntityImage imageId={portrait.source.imageId} name={proposal.label} alt="Portrait inspected for these suggestions" className="h-28 w-24 rounded-md object-cover" />
        <div className="min-w-0 text-xs text-paper-400">
          <p className="font-medium text-paper-200">Inspected portrait evidence</p>
          <p className="mt-1">{portrait.model.id} · {portrait.model.promptVersion}</p>
          <p className="mt-1">Source {portrait.source.contentHash.slice(0, 12)} · {portrait.timing.durationMs} ms</p>
          <p className="mt-1">Weak, uncertain, occluded, or out-of-frame observations start on Keep current.</p>
        </div>
      </div> : null}
      {!changes.length ? <p className="text-sm text-paper-400">No changes were proposed.</p> : null}
      <div className="flex flex-col gap-3">
        {changes.map((change) => {
          const conflict = conflicts.some((c) => c.key === change.key);
          const evidence = evidenceForChange(proposal, change.path);
          return <div key={change.key} className="rounded-md border border-ink-600 p-3">
            <p className="text-sm font-medium capitalize text-paper-200">{change.label}</p>
            <div className="mt-2 grid gap-3 text-sm sm:grid-cols-2">
              <div><p className="text-xs text-paper-500">{purpose === "recovery" ? "Before editing" : "Before generation"}</p><p className="whitespace-pre-wrap break-words">{describeProposalValue(change.before)}</p></div>
              <div><p className="text-xs text-paper-500">{purpose === "recovery" ? "Recovered" : proposal.undo ? "Restore" : "Suggested"}</p><p className="whitespace-pre-wrap break-words">{describeProposalValue(change.after)}</p></div>
            </div>
            {conflict ? <p className="mt-2 whitespace-pre-wrap break-words text-sm text-warning">{purpose === "recovery" ? "Saved/current value:" : "Changed since generation:"}{" "} {describeProposalValue(valueAt(draft, change.path))}</p> : null}
            {evidence && portrait ? <div className="mt-2 rounded-md bg-ink-900/70 p-2 text-xs text-paper-400">
              <p><span className="text-paper-200">Evidence:</span>{" "}{evidence.evidence}</p>
              <p className="mt-1">{portraitVisibilityLabel(evidence.visibility)} · {Math.round(evidence.confidence / 100)}% confidence{evidence.defaultSelected ? "" : " · unchecked"}</p>
              <EvidenceRegion imageId={portrait.source.imageId} field={evidence} />
            </div> : null}
            <Select className="mt-3" aria-label={`Choice for ${change.label}`} value={choices[change.key] ?? (conflict ? "" : "proposed")} onChange={(event) => setChoices((old) => ({ ...old, [change.key]: event.target.value as "current" | "proposed" }))}>
              {conflict ? <option value="" disabled>Choose how to resolve this change</option> : null}
              <option value="proposed">{purpose === "recovery" ? "Use recovered value" : proposal.undo ? "Restore previous value" : "Use suggested value"}</option>
              <option value="current">Keep my current value</option>
            </Select>
          </div>;
        })}
      </div>
      {children}
      {unresolved.length ? <p role="status" className="mt-3 text-sm text-warning">Resolve {unresolved.length} conflicting change{unresolved.length === 1 ? "" : "s"} to continue.</p> : null}
    </Dialog>
  );
}
