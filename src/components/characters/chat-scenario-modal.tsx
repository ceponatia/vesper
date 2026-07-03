"use client";

import { useState } from "react";
import {
  CHAT_OUTFIT_MAX_CHARS,
  CHAT_PREMISE_MAX_CHARS,
  type SocialReactionCard,
} from "@/contracts";
import { chatPresetsApi, chatsApi, type ChatStateEdit, type ChatStateSnapshot } from "@/lib/client/api";
import { useAsyncData } from "@/components/hooks/use-async";
import { SocialCardsEditor } from "@/components/personality/social-cards-editor";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { useToast } from "@/components/ui/toast";

/**
 * The Scenario setup modal (character-chat-scenario.plan.md): configure the
 * **chat-only** framing — scenario premise, free-text starting outfit + the
 * intimate-reveal toggle, and the social cards live in this chat. The authored
 * Starting Relationship moved to the editor's Chat-defaults card (it's a profile
 * field, not chat state). Scenario presets (character-chat-standalone.spec.md
 * §1.5) ride on top: "Apply preset" fills the draft fields (Save still persists),
 * and "Save as preset" captures the current draft as a reusable bundle. The form
 * mounts fresh each open (Dialog unmounts its children when closed), so the
 * `useState` initializers re-seed from the snapshot without an effect.
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
  const [sceneAuto, setSceneAuto] = useState(snapshot.sceneAuto === "milestones");
  const [cards, setCards] = useState<SocialReactionCard[]>([...snapshot.activeSocialCards]);
  const [saving, setSaving] = useState(false);

  // --- Scenario presets (spec §1.5) — the form mounts per open, so this loads then.
  const presets = useAsyncData(() => chatPresetsApi.list(), []);
  const [appliedPresetId, setAppliedPresetId] = useState("");
  const [presetNameOpen, setPresetNameOpen] = useState(false);
  const [presetName, setPresetName] = useState("");
  const [presetBusy, setPresetBusy] = useState(false);

  /** Fill the draft fields from a preset — the user still hits Save to persist. */
  const applyPreset = (presetId: string) => {
    setAppliedPresetId(presetId);
    const preset = (presets.data ?? []).find((p) => p.id === presetId);
    if (!preset) return;
    setPremise(preset.premise);
    setOutfit(preset.outfit);
    setOutfitExposed(preset.outfitExposed);
    if (preset.socialCards.length) setCards([...preset.socialCards]);
  };

  const deletePreset = async () => {
    if (!appliedPresetId || presetBusy) return;
    setPresetBusy(true);
    const result = await chatPresetsApi.remove(appliedPresetId);
    setPresetBusy(false);
    if (result.ok) {
      setAppliedPresetId("");
      presets.reload({ silent: true });
      toast.push({ title: "Preset deleted" });
    } else {
      toast.push({ title: "Delete failed", description: result.error.message, tone: "error" });
    }
  };

  /** Capture the current draft (startingStage stays the server default, "stranger"). */
  const savePreset = async () => {
    const name = presetName.trim();
    if (!name || presetBusy) return;
    setPresetBusy(true);
    const result = await chatPresetsApi.create({ name, premise, outfit, outfitExposed, socialCards: cards });
    setPresetBusy(false);
    if (result.ok) {
      setPresetNameOpen(false);
      setPresetName("");
      presets.reload({ silent: true });
      toast.push({ title: "Preset saved", description: `"${name}" is available on any new conversation.` });
    } else {
      toast.push({ title: "Preset save failed", description: result.error.message, tone: "error" });
    }
  };

  // Only the touched fields go into the patch: a pre-first-exchange save upserts the
  // state row, and the server seeds the untouched rest from the profile (authored
  // stage, the character's own social cards) — an untouched field must not clobber
  // that seed with this form's blank default.
  const save = async () => {
    const patch: ChatStateEdit = {};
    if (premise !== snapshot.premise) patch.premise = premise;
    if (outfit !== snapshot.outfit) patch.outfit = outfit;
    if (outfitExposed !== snapshot.outfitExposed) patch.outfitExposed = outfitExposed;
    const sceneAutoMode = sceneAuto ? "milestones" : "off";
    if (sceneAutoMode !== snapshot.sceneAuto) patch.sceneAuto = sceneAutoMode;
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
      {(presets.data?.length ?? 0) > 0 ? (
        <div className="flex flex-col gap-1">
          <span className="text-xs font-medium tracking-wide text-paper-400 uppercase">Apply preset</span>
          <div className="flex items-center gap-2">
            <Select
              value={appliedPresetId}
              onChange={(e) => applyPreset(e.target.value)}
              aria-label="Apply a saved scenario preset"
              className="flex-1"
            >
              <option value="">Choose a saved scenario…</option>
              {(presets.data ?? []).map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </Select>
            {appliedPresetId ? (
              <Button size="sm" variant="danger" busy={presetBusy} onClick={() => void deletePreset()}>
                Delete
              </Button>
            ) : null}
          </div>
          <span className="text-[11px] text-paper-600">Fills the fields below — hit Save to apply it to this chat.</span>
        </div>
      ) : null}

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
        <label className="flex items-center gap-2 text-xs text-paper-400">
          <input
            type="checkbox"
            checked={sceneAuto}
            onChange={(e) => setSceneAuto(e.target.checked)}
            className="size-4 accent-accent-500"
          />
          Auto-generate a scene at big moments
        </label>
        <span className="text-[11px] text-paper-600">
          A relationship-stage change or a strong reaction paints the moment into the transcript on its own.
          Generation otherwise stays yours to trigger.
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

      <div className="flex items-center gap-2 border-t border-ink-600 pt-3">
        {presetNameOpen ? (
          <div className="flex min-w-0 flex-1 items-center gap-2">
            <Input
              autoFocus
              value={presetName}
              maxLength={80}
              placeholder="Preset name…"
              aria-label="Preset name"
              onChange={(e) => setPresetName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") void savePreset();
                if (e.key === "Escape") setPresetNameOpen(false);
              }}
              className="h-8 flex-1 text-sm"
            />
            <Button size="sm" busy={presetBusy} disabled={!presetName.trim()} onClick={() => void savePreset()}>
              Save preset
            </Button>
            <Button size="sm" variant="quiet" disabled={presetBusy} onClick={() => setPresetNameOpen(false)}>
              Cancel
            </Button>
          </div>
        ) : (
          <Button size="sm" variant="quiet" onClick={() => setPresetNameOpen(true)}>
            Save as preset…
          </Button>
        )}
        <div className="ml-auto flex gap-2">
          <Button onClick={onClose} disabled={saving}>
            Cancel
          </Button>
          <Button variant="primary" busy={saving} onClick={() => void save()}>
            Save
          </Button>
        </div>
      </div>
    </div>
  );
}
