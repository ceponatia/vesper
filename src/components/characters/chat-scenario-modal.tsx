"use client";

import { useState } from "react";
import {
  CHAT_OUTFIT_MAX_CHARS,
  CHAT_PREMISE_MAX_CHARS,
  type SocialReactionCard,
} from "@/contracts";
import { chatsApi, type ChatStateEdit, type ChatStateSnapshot } from "@/lib/client/api";
import { SocialCardsEditor } from "@/components/personality/social-cards-editor";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { Textarea } from "@/components/ui/textarea";
import { useToast } from "@/components/ui/toast";

/**
 * The Scenario setup modal (character-chat-scenario.plan.md): configure the
 * **chat-only** framing — scenario premise, free-text starting outfit + the
 * intimate-reveal toggle, and the social cards live in this chat. The authored
 * Starting Relationship moved to the editor's Chat-defaults card (it's a profile
 * field, not chat state). The form mounts fresh each open (Dialog unmounts its
 * children when closed), so the `useState` initializers re-seed from the snapshot
 * without an effect.
 */
export function ChatScenarioModal({
  open,
  onClose,
  chatId,
  who,
  snapshot,
  onSaved,
}: {
  open: boolean;
  onClose: () => void;
  chatId: string;
  who: string;
  snapshot: ChatStateSnapshot;
  onSaved: (next: ChatStateSnapshot) => void;
}) {
  return (
    <Dialog open={open} onClose={onClose} title={`Scenario setup — ${who}`} className="max-w-lg">
      {open ? <ScenarioForm chatId={chatId} who={who} snapshot={snapshot} onSaved={onSaved} onClose={onClose} /> : null}
    </Dialog>
  );
}

function ScenarioForm({
  chatId,
  who,
  snapshot,
  onSaved,
  onClose,
}: {
  chatId: string;
  who: string;
  snapshot: ChatStateSnapshot;
  onSaved: (next: ChatStateSnapshot) => void;
  onClose: () => void;
}) {
  const toast = useToast();
  const [premise, setPremise] = useState(snapshot.premise);
  const [outfit, setOutfit] = useState(snapshot.outfit);
  const [outfitExposed, setOutfitExposed] = useState(snapshot.outfitExposed);
  const [cards, setCards] = useState<SocialReactionCard[]>([...snapshot.activeSocialCards]);
  const [saving, setSaving] = useState(false);

  // Only the touched fields go into the patch: a pre-first-exchange save upserts the
  // state row, and the server seeds the untouched rest from the profile (authored
  // stage, the character's own social cards) — an untouched field must not clobber
  // that seed with this form's blank default.
  const save = async () => {
    const patch: ChatStateEdit = {};
    if (premise !== snapshot.premise) patch.premise = premise;
    if (outfit !== snapshot.outfit) patch.outfit = outfit;
    if (outfitExposed !== snapshot.outfitExposed) patch.outfitExposed = outfitExposed;
    if (JSON.stringify(cards) !== JSON.stringify(snapshot.activeSocialCards)) patch.activeSocialCards = cards;
    setSaving(true);
    const result = await chatsApi.editState(chatId, patch);
    setSaving(false);
    if (result.ok) {
      onSaved(result.data);
      toast.push({ title: "Scenario saved" });
      onClose();
    } else {
      toast.push({ title: "Save failed", description: result.error.message, tone: "error" });
    }
  };

  return (
    <div className="flex max-h-[70vh] flex-col gap-4 overflow-y-auto">
      <label className="flex flex-col gap-1">
        <span className="text-xs font-medium tracking-wide text-paper-400 uppercase">Scenario</span>
        <Textarea
          rows={2}
          value={premise}
          maxLength={CHAT_PREMISE_MAX_CHARS}
          onChange={(e) => setPremise(e.target.value)}
          placeholder={`Set the scene for this chat with ${who} — e.g. "it's the night before you move away…"`}
        />
        <span className="text-[11px] text-paper-600">This chat only — it never touches {who}&rsquo;s saved bio or personality.</span>
      </label>

      <label className="flex flex-col gap-1">
        <span className="text-xs font-medium tracking-wide text-paper-400 uppercase">Starting outfit</span>
        <Textarea
          rows={2}
          value={outfit}
          maxLength={CHAT_OUTFIT_MAX_CHARS}
          onChange={(e) => setOutfit(e.target.value)}
          placeholder="What they're wearing in scene images — e.g. 'a loose silk robe and bare feet'…"
        />
        <label className="flex items-center gap-2 text-xs text-paper-400">
          <input
            type="checkbox"
            checked={outfitExposed}
            onChange={(e) => setOutfitExposed(e.target.checked)}
            className="size-4 accent-accent-500"
          />
          Reveal intimate anatomy in scene images
        </label>
        <span className="text-[11px] text-paper-600">
          Drives chat scene images only — the chat has no equippable wardrobe, so this stands in for it.
        </span>
      </label>

      <div className="flex flex-col gap-1">
        <span className="text-xs font-medium tracking-wide text-paper-400 uppercase">Active social cards</span>
        <SocialCardsEditor
          cards={cards}
          onChange={setCards}
          hint="The taboos / social rules live in this chat — seeded from the character's own cards. Test them here without a world or session."
          emptyText="No cards active — import from the library, or this character carries none."
        />
      </div>

      <div className="flex justify-end gap-2 border-t border-ink-600 pt-3">
        <Button onClick={onClose} disabled={saving}>
          Cancel
        </Button>
        <Button variant="primary" busy={saving} onClick={() => void save()}>
          Save
        </Button>
      </div>
    </div>
  );
}
