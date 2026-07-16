"use client";

import { useState } from "react";
import {
  CHAT_PREMISE_MAX_CHARS,
  chatSceneModelLabels,
  chatSceneModels,
  parseChatSceneModel,
  type SocialReactionCard,
} from "@/contracts";
import { chatPresetsApi, chatsApi, personasApi, type ChatStateEdit, type ChatStateSnapshot } from "@/lib/client/api";
import { useAsyncData } from "@/components/hooks/use-async";
import { SocialCardsEditor } from "@/components/personality/social-cards-editor";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { useToast } from "@/components/ui/toast";

/**
 * The Scenario setup modal (character-chat-scenario.plan.md; slimmed to the
 * genuinely CHAT-WIDE fields by followups ruling 13): the premise, the
 * setting-wide house rules (the active social cards — one set for the whole
 * roster, ruling 9), auto-scene mode, and the scene-image model. Per-character
 * fields (outfit + exposure, axes, texture) live on each member's Character
 * sheet instead. Scenario presets (character-chat-standalone.spec.md §1.5) ride
 * on top: "Apply preset" fills the chat-wide draft fields (a preset's outfit /
 * starting relationship only seed NEW conversations), and "Save as preset"
 * captures the draft + the primary's current outfit/relationship as a reusable
 * bundle. The form mounts fresh each open (Dialog unmounts its children when
 * closed), so the `useState` initializers re-seed from the snapshot without an
 * effect.
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
    <Dialog open={open} onClose={onClose} title={`Scenario setup — ${who}`} size="xl">
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
  const [sceneAuto, setSceneAuto] = useState(snapshot.sceneAuto === "milestones");
  const [sceneModel, setSceneModel] = useState(parseChatSceneModel(snapshot.sceneModel));
  const [cards, setCards] = useState<SocialReactionCard[]>([...snapshot.activeSocialCards]);
  const [personaId, setPersonaId] = useState(snapshot.playerState.personaId);
  const [saving, setSaving] = useState(false);

  // Who the player can be here (persona-library.plan.md slice 7). Chat-wide, like the
  // premise beside it. Blank ⇒ the resolver falls back to the owner's default persona,
  // so an untouched chat still knows who you are.
  const personas = useAsyncData(() => personasApi.list({ sort: "name" }), []);

  // --- Scenario presets (spec §1.5) — the form mounts per open, so this loads then.
  const presets = useAsyncData(() => chatPresetsApi.list(), []);
  const [appliedPresetId, setAppliedPresetId] = useState("");
  const [presetNameOpen, setPresetNameOpen] = useState(false);
  const [presetName, setPresetName] = useState("");
  const [presetBusy, setPresetBusy] = useState(false);

  /**
   * Fill the CHAT-WIDE draft fields from a preset — the user still hits Save to
   * persist. The preset's outfit / starting relationship are per-character seeds
   * and only apply when a NEW conversation is created from it.
   */
  const applyPreset = (presetId: string) => {
    setAppliedPresetId(presetId);
    const preset = (presets.data ?? []).find((p) => p.id === presetId);
    if (!preset) return;
    setPremise(preset.premise);
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

  /**
   * Capture the current draft + the chat's CURRENT relationship as the preset's
   * starting point (followups ruling 4): both band ids and the kind/history/mask
   * texture ride along, applied only when a NEW conversation seeds from this
   * preset — never to a running chat.
   */
  const savePreset = async () => {
    const name = presetName.trim();
    if (!name || presetBusy) return;
    setPresetBusy(true);
    const result = await chatPresetsApi.create({
      name,
      premise,
      // Per-character seeds (applied to a NEW conversation's primary): captured
      // from the primary's CURRENT sheet, since this modal no longer edits them.
      outfit: snapshot.outfit,
      outfitExposed: snapshot.outfitExposed,
      socialCards: cards,
      startingRelationship: {
        familiarity: snapshot.familiarityBand.id,
        regard: snapshot.regardBand.id,
        kind: snapshot.relationship.kind,
        history: snapshot.relationship.history,
        ...(snapshot.relationship.presented
          ? { presented: { lean: snapshot.relationship.presented.lean, note: snapshot.relationship.presented.note ?? "" } }
          : {}),
        looming: snapshot.relationship.looming,
      },
    });
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
    const sceneAutoMode = sceneAuto ? "milestones" : "off";
    if (sceneAutoMode !== snapshot.sceneAuto) patch.sceneAuto = sceneAutoMode;
    if (sceneModel !== parseChatSceneModel(snapshot.sceneModel)) patch.sceneModel = sceneModel;
    if (JSON.stringify(cards) !== JSON.stringify(snapshot.activeSocialCards)) patch.activeSocialCards = cards;
    // Switching persona RESETS the wardrobe rather than carrying it over: the worn list
    // and overlay describe the person who was wearing them. A blank list re-seeds from
    // the new persona's default outfit preset on the next resolve (resolveChatWardrobe),
    // exactly as a fresh chat does.
    if (personaId !== snapshot.playerState.personaId) {
      // `seeded: false` is the load-bearing part — it re-arms the default-preset seed, so
      // the new persona turns up dressed in their own clothes rather than naked.
      patch.playerState = { personaId, wornItemIds: [], seeded: false, outfitPresetId: "", overlay: "" };
    }
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
        <span className="text-xs font-medium tracking-wide text-paper-400 uppercase">Playing as</span>
        <Select
          value={personaId}
          onChange={(e) => setPersonaId(e.target.value)}
          aria-label="The persona you play as in this chat"
        >
          <option value="">— Your default persona —</option>
          {(personas.data ?? []).map((p) => (
            <option key={p.id} value={p.id}>
              {p.title}
            </option>
          ))}
        </Select>
        <span className="text-[11px] text-paper-600">
          {personaId
            ? `${who} will know you as ${personas.data?.find((p) => p.id === personaId)?.name ?? "this persona"}. Switching resets what you're wearing here.`
            : "Personas are built in your library. Leave this to use whichever one you set as default."}
        </span>
      </label>

      <div className="flex flex-col gap-2">
        <span className="text-xs font-medium tracking-wide text-paper-400 uppercase">Scene images</span>
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
        <Select value={sceneModel} onChange={(e) => setSceneModel(parseChatSceneModel(e.target.value))} aria-label="Scene image model">
          {chatSceneModels.map((model) => (
            <option key={model} value={model}>
              {chatSceneModelLabels[model]}
            </option>
          ))}
        </Select>
        <span className="text-[11px] text-paper-600">
          Outfits and exposure moved to each character&rsquo;s sheet — tap a name in the roster.
        </span>
      </div>

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
