"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Select } from "@/components/ui/select";
import { authorModelConflict, authorRecoveryProposal } from "./character-author-draft";
import { CharacterProposalDialog } from "./character-proposal-review";
import type { ProposalChoices } from "./character-proposals";
import type { AuthorRecoveryReview } from "./use-character-author-draft";

export function CharacterAuthorRecoveryNotice({ recovery, disabled, onRestore, onDiscard, title = "Recovered edits need review", description = "The saved character changed since this browser draft began. Your edits are retained; review them before saving." }: {
  recovery: AuthorRecoveryReview; disabled: boolean;
  onRestore: (choices: ProposalChoices, modelChoice?: "current" | "proposed") => void;
  onDiscard: () => void;
  title?: string;
  description?: string;
}) {
  const [open, setOpen] = useState(false);
  const [modelChoice, setModelChoice] = useState<"current" | "proposed" | undefined>();
  const modelConflict = authorModelConflict(recovery.server, recovery.record);
  const modelChanged = recovery.record.authored.chatModel !== recovery.record.base.chatModel;
  return <section role="status" className="mb-4 rounded-card border border-ink-600 bg-ink-850 p-4">
    <p className="text-sm font-medium">{title}</p>
    <p className="mt-1 text-sm text-paper-400">{description}</p>
    <Button className="mt-3" disabled={disabled} onClick={() => setOpen(true)}>Review recovered edits</Button>
    {open && !disabled ? <CharacterProposalDialog draft={recovery.server.draft} proposal={authorRecoveryProposal(recovery.record)} purpose="recovery" onClose={() => setOpen(false)} onReject={onDiscard} onAccept={(choices) => onRestore(choices, modelChoice)} acceptDisabled={modelConflict && !modelChoice}>
      {modelChanged ? <div className="mt-4 rounded-md border border-ink-600 p-3">
        <p className="text-sm font-medium">Narrator choice</p>
        <p className="mt-1 text-sm">Saved: {recovery.server.chatModel}</p>
        <p className="text-sm">Recovered: {recovery.record.authored.chatModel}</p>
        <Select className="mt-2" aria-label="Recovered narrator choice" value={modelChoice ?? (modelConflict ? "" : "proposed")} onChange={(event) => setModelChoice(event.target.value as "current" | "proposed")}>
          {modelConflict ? <option value="" disabled>Choose which narrator to keep</option> : null}
          <option value="proposed">Use recovered narrator</option><option value="current">Keep saved narrator</option>
        </Select>
      </div> : null}
    </CharacterProposalDialog> : null}
  </section>;
}
