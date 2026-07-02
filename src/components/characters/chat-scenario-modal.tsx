"use client";

import { useState } from "react";
import {
  CHAT_OUTFIT_MAX_CHARS,
  CHAT_PREMISE_MAX_CHARS,
  relationshipStages,
  type SocialReactionCard,
} from "@/contracts";
import { chatsApi, type ChatStateEdit, type ChatStateSnapshot } from "@/lib/client/api";
import { SocialCardsEditor } from "@/components/personality/social-cards-editor";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { Field } from "@/components/ui/field";
import { Select } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { useToast } from "@/components/ui/toast";

/**
 * The Scenario setup modal (character-chat-scenario.plan.md): one place to configure a chat for
 * testing. It mixes the authored **Starting Relationship** (a profile field — written through to
 * the editor draft and saved with the character via the page's Save) with the **chat-only** fields
 * (scenario premise, free-text starting outfit + intimate-reveal toggle, and the social cards live
 * in this chat). The form mounts fresh each open (Dialog unmounts its children when closed), so the
 * `useState` initializers re-seed from the snapshot without an effect.
 */
export function ChatScenarioModal({
  open,
  onClose,
  chatId,
  ensureChat,
  who,
  snapshot,
  onSaved,
  startingStage,
  onStartingStageChange,
}: {
  open: boolean;
  onClose: () => void;
  /** Null until a conversation exists; Save then creates one via `ensureChat`. */
  chatId: string | null;
  ensureChat: () => Promise<string | null>;
  who: string;
  snapshot: ChatStateSnapshot;
  onSaved: (next: ChatStateSnapshot) => void;
  startingStage: string;
  onStartingStageChange: (stage: string) => void;
}) {
  return (
    <Dialog open={open} onClose={onClose} title={`Scenario setup — ${who}`} className="max-w-lg">
      {open ? (
        <ScenarioForm
          chatId={chatId}
          ensureChat={ensureChat}
          who={who}
          snapshot={snapshot}
          onSaved={onSaved}
          onClose={onClose}
          startingStage={startingStage}
          onStartingStageChange={onStartingStageChange}
        />
      ) : null}
    </Dialog>
  );
}

function ScenarioForm({
  chatId,
  ensureChat,
  who,
  snapshot,
  onSaved,
  onClose,
  startingStage,
  onStartingStageChange,
}: {
  chatId: string | null;
  ensureChat: () => Promise<string | null>;
  who: string;
  snapshot: ChatStateSnapshot;
  onSaved: (next: ChatStateSnapshot) => void;
  onClose: () => void;
  startingStage: string;
  onStartingStageChange: (stage: string) => void;
}) {
  const toast = useToast();
  const [premise, setPremise] = useState(snapshot.premise);
  const [outfit, setOutfit] = useState(snapshot.outfit);
  const [outfitExposed, setOutfitExposed] = useState(snapshot.outfitExposed);
  const [cards, setCards] = useState<SocialReactionCard[]>([...snapshot.activeSocialCards]);
  const [saving, setSaving] = useState(false);

  // The chat-only fields save here; Starting Relationship rides the editor's own SaveBar.
  // Only the touched fields go into the patch: a pre-chat save creates the conversation,
  // and the server seeds the new state row from the profile (authored stage, the
  // character's own social cards) — an untouched field must not clobber that seed with
  // this form's blank pre-chat default.
  const save = async () => {
    const patch: ChatStateEdit = {};
    if (premise !== snapshot.premise) patch.premise = premise;
    if (outfit !== snapshot.outfit) patch.outfit = outfit;
    if (outfitExposed !== snapshot.outfitExposed) patch.outfitExposed = outfitExposed;
    if (JSON.stringify(cards) !== JSON.stringify(snapshot.activeSocialCards)) patch.activeSocialCards = cards;
    setSaving(true);
    // Saving scenario edits is one of the actions that lazily creates the conversation.
    const id = chatId ?? (await ensureChat());
    if (!id) {
      setSaving(false);
      toast.push({ title: "Save failed", description: "The conversation couldn't be created.", tone: "error" });
      return;
    }
    const result = await chatsApi.editState(id, patch);
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
      <Field
        label="Starting Relationship"
        hint="How this character feels about the player at the start of a chat — saved with the character (use the page's Save)."
      >
        {(id) => (
          <Select id={id} value={startingStage} onChange={(e) => onStartingStageChange(e.target.value)}>
            {relationshipStages.map((s) => (
              <option key={s.id} value={s.id}>
                {s.label}
              </option>
            ))}
          </Select>
        )}
      </Field>

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
        <Button variant="primary" busy={saving} onClick={save}>
          Save
        </Button>
      </div>
    </div>
  );
}
