"use client";

import { useState } from "react";
import {
  CHAT_MIND_NOTE_MAX_CHARS,
  conditionAttributeOverlays,
  familiarityBandForValue,
  meterDefinitions,
  regardBandForValue,
  splitStateCues,
  type ActiveCondition,
  type GarmentOperation,
} from "@/contracts";
import { charactersApi, chatsApi, type ChatStateSnapshot } from "@/lib/client/api";
import { wearerHintForGender } from "@/lib/clothing-slots";
import { useAsyncData } from "@/components/hooks/use-async";
import { useIsAdmin } from "@/components/hooks/use-is-admin";
import { ChatGarmentControls } from "./chat-garment-controls";
import { ChatWardrobeEditor } from "./chat-wardrobe-editor";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Tag } from "@/components/ui/tag";
import { Textarea } from "@/components/ui/textarea";
import { useToast } from "@/components/ui/toast";

/**
 * The per-character sheet (character-chat-state.spec.md slice 4; scoped per roster
 * member since followups ruling 13): inspect + edit ONE character's state — the
 * two axes + relationship texture toward the player, meters, conditions, mindNote,
 * outfit + exposure, presence. The engine-surface readouts — the pulse trace,
 * cue-split, memory trace, chat clock, and the next-turn memory-queries editor —
 * are **admin-only** (ux-improvements slice 4, ruled: hidden entirely from
 * players; same role check as the /chat/:chatId/inspector page). Chat-WIDE
 * fields (premise, house rules, scene prefs) live in the Scenario modal
 * instead. Available to the character owner. The form mounts fresh each open
 * (the Dialog unmounts its children when closed), so `useState` initializers
 * re-seed from the snapshot without an effect.
 */
export function ChatStateToolsModal({
  open,
  onClose,
  chatId,
  who,
  characterId,
  presence,
  onPresenceChanged,
  snapshot,
  onSaved,
}: {
  open: boolean;
  onClose: () => void;
  chatId: string;
  who: string;
  /** The roster member this sheet targets; absent ⇒ the primary. */
  characterId?: string;
  /** Rendered as a toggle when provided (roster > 1 — presence is a group concept). */
  presence?: "present" | "away";
  onPresenceChanged?: () => void;
  snapshot: ChatStateSnapshot;
  onSaved: (next: ChatStateSnapshot) => void;
}) {
  return (
    <Dialog open={open} onClose={onClose} title={`Character sheet — ${who}`} size="xl">
      {open ? (
        <StateToolsForm
          chatId={chatId}
          characterId={characterId}
          presence={presence}
          onPresenceChanged={onPresenceChanged}
          snapshot={snapshot}
          onSaved={onSaved}
          onClose={onClose}
        />
      ) : null}
    </Dialog>
  );
}

function StateToolsForm({
  chatId,
  characterId,
  presence,
  onPresenceChanged,
  snapshot,
  onSaved,
  onClose,
}: {
  chatId: string;
  characterId?: string;
  presence?: "present" | "away";
  onPresenceChanged?: () => void;
  snapshot: ChatStateSnapshot;
  onSaved: (next: ChatStateSnapshot) => void;
  onClose: () => void;
}) {
  const toast = useToast();
  const isAdmin = useIsAdmin();
  const [regard, setRegard] = useState(snapshot.regard);
  const [familiarity, setFamiliarity] = useState(snapshot.familiarity);
  const [relationship, setRelationship] = useState(snapshot.relationship);
  const [meters, setMeters] = useState<Record<string, number>>({ ...snapshot.meters });
  const [conditions, setConditions] = useState<ActiveCondition[]>(snapshot.conditions);
  const [mindNote, setMindNote] = useState(snapshot.mindNote);
  const [wornItemIds, setWornItemIds] = useState(snapshot.wornItemIds);
  const [outfitPresetId, setOutfitPresetId] = useState(snapshot.outfitPresetId);
  const [outfit, setOutfit] = useState(snapshot.outfit);
  const [outfitExposed, setOutfitExposed] = useState(snapshot.outfitExposed);
  // The presentation graph (clothing-state-graph slice 3): the last-saved readout
  // plus the operations this sheet has queued but not yet sent.
  const [garments, setGarments] = useState(snapshot.garments);
  const [garmentOperations, setGarmentOperations] = useState<GarmentOperation[]>([]);
  const [garmentDiagnostics, setGarmentDiagnostics] = useState(snapshot.garmentDiagnostics);
  const [livePresence, setLivePresence] = useState(presence);
  const [presenceBusy, setPresenceBusy] = useState(false);
  const [newCondition, setNewCondition] = useState("");
  // Inspector-grade fields (character-chat-standalone.spec.md §6.1): open loops +
  // next-turn memory queries, edited as one-per-line text.
  const [openLoops, setOpenLoops] = useState(snapshot.openLoops.join("\n"));
  const [memoryQueries, setMemoryQueries] = useState(snapshot.memoryQueries.join("\n"));
  const [saving, setSaving] = useState(false);

  // The character's authored profile — the outfit presets (the wardrobe switcher) and the
  // wearer hint for the equip picker. Fetched once per sheet open; absent characterId or a
  // failed fetch just leaves the presets empty (the equip slots + free text still work).
  const presetSource = useAsyncData(
    () =>
      characterId
        ? charactersApi.get(characterId)
        : Promise.resolve({ ok: false as const, error: { code: "no_character", message: "", status: 0 } }),
    [characterId],
  );
  const outfitPresets = presetSource.data?.profile.outfits ?? [];
  const genderValue = presetSource.data?.profile.attributes.find((a) => a.id === "identity.gender")?.value;
  const wearerHint = wearerHintForGender(typeof genderValue === "string" ? genderValue : undefined);

  const regardBand = regardBandForValue(regard);
  const familiarityBand = familiarityBandForValue(familiarity);
  const trace = snapshot.lastPulseTrace;
  const memory = snapshot.lastMemoryTrace;
  const attributeOverlays = snapshot.attributeOverlays;

  // What the live (edited) state would surface to the narrator next turn
  // (character-chat-state-narration.spec.md §5/§9): the foreground "just shifted" beat vs the
  // standing cues, diffed against the bands surfaced last turn, plus the condition overlays.
  const cueSplit = splitStateCues(meters, snapshot.surfacedCues);
  const overlays = conditionAttributeOverlays(conditions);

  const addCondition = () => {
    const label = newCondition.trim();
    if (!label) return;
    const id = label.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || `cond-${conditions.length}`;
    setNewCondition("");
    if (conditions.some((c) => c.id === id)) return;
    setConditions((cs) => [
      ...cs,
      { id, label, startedAtMinutes: snapshot.clockMinutes, attributeEffects: [], promptHint: label },
    ]);
  };

  /** One-per-line textarea → trimmed list (blank lines drop). */
  const toLines = (text: string) => text.split("\n").map((l) => l.trim()).filter(Boolean);

  const save = async () => {
    setSaving(true);
    const result = await chatsApi.editState(
      chatId,
      {
        regard,
        familiarity,
        relationship,
        meters,
        conditions,
        mindNote,
        wornItemIds,
        outfitPresetId,
        outfit,
        outfitExposed,
        ...(garmentOperations.length > 0 ? { garmentOperations } : {}),
        openLoops: toLines(openLoops),
        memoryQueries: toLines(memoryQueries),
      },
      characterId,
    );
    setSaving(false);
    if (result.ok) {
      onSaved(result.data);
      // A rejected garment operation is a diagnostic, not a failed save — keep the
      // sheet open so the reason is readable instead of vanishing with the modal.
      if (result.data.garmentDiagnostics.length > 0) {
        setGarments(result.data.garments);
        setGarmentOperations([]);
        setGarmentDiagnostics(result.data.garmentDiagnostics);
        toast.push({ title: "State updated", description: "Some garment changes were rejected — see the sheet." });
        return;
      }
      toast.push({ title: "State updated" });
      onClose();
    } else {
      toast.push({ title: "Update failed", description: result.error.message, tone: "error" });
    }
  };

  const flipPresence = async () => {
    if (!characterId || !livePresence || presenceBusy) return;
    const next = livePresence === "present" ? "away" : "present";
    setPresenceBusy(true);
    const result = await chatsApi.setPresence(chatId, characterId, next);
    setPresenceBusy(false);
    if (result.ok) {
      setLivePresence(next);
      onPresenceChanged?.();
    } else {
      toast.push({ title: "Couldn't change presence", description: result.error.message, tone: "error" });
    }
  };

  return (
    <div className="flex max-h-[70vh] flex-col gap-4 overflow-y-auto">
      {livePresence ? (
        <div className="flex items-center justify-between gap-3">
          <span className="text-xs font-medium tracking-wide text-paper-400 uppercase">Presence</span>
          <button
            type="button"
            disabled={presenceBusy}
            onClick={() => void flipPresence()}
            aria-pressed={livePresence === "present"}
            className={
              livePresence === "present"
                ? "cursor-pointer rounded-full border border-accent-500/60 bg-accent-500/10 px-3 py-1 text-xs text-accent-300"
                : "cursor-pointer rounded-full border border-ink-500 px-3 py-1 text-xs text-paper-500 hover:text-paper-300"
            }
          >
            {livePresence === "present" ? "Present — sharing the scene" : "Away — living their life"}
          </button>
        </div>
      ) : null}

      {/* flex-wrap: label + range + value totals ~347px, wider than the ~318px
          dialog column at a 390px viewport — the range+value pair drops to its
          own line instead of overflowing (mobile-ux W3 task 4). */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <span className="text-xs font-medium tracking-wide text-paper-400 uppercase">Regard</span>
        <div className="flex items-center gap-2">
          <input
            type="range"
            min={-100}
            max={100}
            value={regard}
            onChange={(e) => setRegard(Number(e.target.value))}
            className="w-44"
            aria-label="Regard"
          />
          <span className="w-24 text-right text-xs text-paper-300">
            {regard} · {regardBand.label}
          </span>
        </div>
      </div>

      <div className="flex flex-wrap items-center justify-between gap-3">
        <span className="text-xs font-medium tracking-wide text-paper-400 uppercase">Familiarity</span>
        <div className="flex items-center gap-2">
          <input
            type="range"
            min={0}
            max={100}
            value={familiarity}
            onChange={(e) => setFamiliarity(Number(e.target.value))}
            className="w-44"
            aria-label="Familiarity"
          />
          <span className="w-24 text-right text-xs text-paper-300">
            {familiarity} · {familiarityBand.label}
          </span>
        </div>
      </div>

      <div className="flex flex-col gap-2">
        <span className="text-xs font-medium tracking-wide text-paper-400 uppercase">Relationship texture</span>
        <Input
          value={relationship.kind}
          onChange={(e) => setRelationship((r) => ({ ...r, kind: e.target.value }))}
          placeholder='Kind — e.g. "estranged childhood friends"'
          aria-label="Relationship kind"
        />
        <Input
          value={relationship.history}
          onChange={(e) => setRelationship((r) => ({ ...r, history: e.target.value }))}
          placeholder="Shared history — one line the narrator can lean on"
          aria-label="Shared history"
        />
        <div className="flex gap-2">
          <select
            value={relationship.presented?.lean ?? ""}
            onChange={(e) => {
              const lean = e.target.value;
              setRelationship((r) => ({
                ...r,
                presented:
                  lean === "" ? undefined : { lean: lean as "masks_warmth" | "masks_dislike", note: r.presented?.note ?? "" },
              }));
            }}
            className="rounded-md border border-ink-600 bg-ink-900 px-2 py-1.5 text-sm text-paper-200"
            aria-label="Outward mask"
          >
            <option value="">Honest — no mask</option>
            <option value="masks_warmth">Acts colder than they feel</option>
            <option value="masks_dislike">Acts warmer than they feel</option>
          </select>
          {relationship.presented ? (
            <Input
              value={relationship.presented.note}
              onChange={(e) =>
                setRelationship((r) => ({
                  ...r,
                  presented: r.presented ? { ...r.presented, note: e.target.value } : undefined,
                }))
              }
              placeholder='Mask flavor — e.g. "icily civil"'
              aria-label="Mask flavor"
              className="flex-1"
            />
          ) : null}
        </div>
      </div>

      <div className="flex flex-col gap-2">
        <span className="text-xs font-medium tracking-wide text-paper-400 uppercase">Meters</span>
        {meterDefinitions.map((def) => {
          const value = meters[def.id] ?? def.initial;
          return (
            <div key={def.id} className="flex flex-wrap items-center justify-between gap-3">
              <label className="text-sm text-paper-300">{def.label}</label>
              <div className="flex items-center gap-2">
                <input
                  type="range"
                  min={0}
                  max={1}
                  step={0.05}
                  value={value}
                  onChange={(e) => setMeters((m) => ({ ...m, [def.id]: Number(e.target.value) }))}
                  className="w-44"
                  aria-label={def.label}
                />
                <span className="w-10 text-right text-xs text-paper-400">{Math.round(value * 100)}%</span>
              </div>
            </div>
          );
        })}
      </div>

      <div className="flex flex-col gap-2">
        <span className="text-xs font-medium tracking-wide text-paper-400 uppercase">Conditions</span>
        {conditions.length === 0 ? (
          <p className="text-xs text-paper-600">None.</p>
        ) : (
          <div className="flex flex-wrap gap-1.5">
            {conditions.map((c) => (
              <Tag key={c.id} onRemove={() => setConditions((cs) => cs.filter((x) => x.id !== c.id))}>
                {c.label}
              </Tag>
            ))}
          </div>
        )}
        <div className="flex gap-2">
          <Input
            value={newCondition}
            onChange={(e) => setNewCondition(e.target.value)}
            placeholder="Add a condition…"
            className="flex-1"
          />
          <Button size="sm" onClick={addCondition} disabled={!newCondition.trim()}>
            Add
          </Button>
        </div>
      </div>

      <label className="flex flex-col gap-1">
        <span className="text-xs font-medium tracking-wide text-paper-400 uppercase">Mind note</span>
        <Textarea
          rows={2}
          value={mindNote}
          maxLength={CHAT_MIND_NOTE_MAX_CHARS}
          onChange={(e) => setMindNote(e.target.value)}
          placeholder="What's on their mind right now…"
        />
      </label>

      <ChatWardrobeEditor
        wornItemIds={wornItemIds}
        outfitPresetId={outfitPresetId}
        outfit={outfit}
        outfitExposed={outfitExposed}
        presets={outfitPresets}
        wearerHint={wearerHint}
        onChange={(patch) => {
          if (patch.wornItemIds !== undefined) setWornItemIds(patch.wornItemIds);
          if (patch.outfitPresetId !== undefined) setOutfitPresetId(patch.outfitPresetId);
          if (patch.outfit !== undefined) setOutfit(patch.outfit);
          if (patch.outfitExposed !== undefined) setOutfitExposed(patch.outfitExposed);
        }}
      />

      <ChatGarmentControls
        garments={garments}
        operations={garmentOperations}
        diagnostics={garmentDiagnostics}
        onChange={setGarmentOperations}
      />

      <label className="flex flex-col gap-1">
        <span className="text-xs font-medium tracking-wide text-paper-400 uppercase">Open loops (one per line, max 3)</span>
        <Textarea
          rows={2}
          value={openLoops}
          onChange={(e) => setOpenLoops(e.target.value)}
          placeholder={"Unfinished business the character carries…\ne.g. promised to tell them about her sister"}
        />
      </label>

      {/* Engine surface below — admin-only (ux-improvements slice 4). Players get
          the editable fields above; the traces mirror /chat/:chatId/inspector. */}
      {isAdmin ? (
        <>
      <label className="flex flex-col gap-1">
        <span className="text-xs font-medium tracking-wide text-paper-400 uppercase">Next-turn memory queries (one per line)</span>
        <Textarea
          rows={2}
          value={memoryQueries}
          onChange={(e) => setMemoryQueries(e.target.value)}
          placeholder="What next turn's recall should search for…"
        />
      </label>

      <div className="rounded-card border border-ink-600 bg-ink-950/40 p-3 text-xs text-paper-400">
        <div className="flex justify-between">
          <span>Chat clock (in-game — the only time model, D3/D8)</span>
          <span className="text-paper-300">{snapshot.clockMinutes} min</span>
        </div>
      </div>

      <div className="rounded-card border border-ink-600 bg-ink-950/40 p-3 text-xs">
        <span className="block font-medium tracking-wide text-paper-400 uppercase">Last turn</span>
        {trace.degraded ? (
          <p className="mt-1 text-paper-500">
            Pulse degraded ({trace.diagnostic ?? "drift-only"}) — no conversation reaction this turn.
          </p>
        ) : trace.concept ? (
          <ul className="mt-1 space-y-0.5 text-paper-400">
            <li>
              Act: <span className="text-paper-300">{trace.concept}</span>{" "}
              {trace.valence ? `(${trace.valence})` : "(no preference match)"}
            </li>
            <li>
              Regard {signed(trace.regardDelta)} · Mood {signed(trace.moodDelta)} · Arousal{" "}
              {signed(trace.arousalDelta)}
            </li>
            {trace.changed.length ? <li>Changed: {trace.changed.join(", ")}</li> : null}
          </ul>
        ) : (
          <p className="mt-1 text-paper-500">No act classified last turn.</p>
        )}
      </div>

      <div className="rounded-card border border-ink-600 bg-ink-950/40 p-3 text-xs text-paper-400">
        <span className="block font-medium tracking-wide text-paper-400 uppercase">State → narration</span>
        <ul className="mt-1 space-y-0.5">
          <li>
            Just-shifted beat:{" "}
            <span className="text-paper-300">{cueSplit.foreground ? cueSplit.foreground.hint : "—"}</span>
          </li>
          <li>
            Standing cues:{" "}
            <span className="text-paper-300">
              {cueSplit.standing.length ? cueSplit.standing.map((c) => c.meterId).join(", ") : "—"}
            </span>
          </li>
          <li>
            Surfaced last turn:{" "}
            <span className="text-paper-300">
              {Object.keys(snapshot.surfacedCues).length ? Object.values(snapshot.surfacedCues).join(", ") : "—"}
            </span>
          </li>
          <li>
            Condition overlays:{" "}
            <span className="text-paper-300">
              {overlays.length ? overlays.map((o) => `${o.id}=${String(o.value)}`).join(", ") : "—"}
            </span>
          </li>
          <li>
            Attribute overlays (persisted):{" "}
            <span className="text-paper-300">
              {attributeOverlays.length
                ? attributeOverlays.map((o) => `${o.id}=${String(o.value)}`).join(", ")
                : "—"}
            </span>
          </li>
        </ul>
      </div>

      <div className="rounded-card border border-ink-600 bg-ink-950/40 p-3 text-xs text-paper-400">
        <span className="block font-medium tracking-wide text-paper-400 uppercase">Memory (last turn)</span>
        {memory.degraded ? (
          <p className="mt-1 text-paper-500">Archivist degraded — no memory extracted this turn.</p>
        ) : (
          <ul className="mt-1 space-y-0.5">
            <li>
              Recalled: <span className="text-paper-300">{memory.retrievedFacts.length} facts</span> ·{" "}
              <span className="text-paper-300">{memory.retrievedEpisodes.length} episodes</span>
            </li>
            <li>
              Extracted: <span className="text-paper-300">{memory.factsAdded} new facts</span>
              {memory.episodeSummary ? " · +1 episode" : ""}
            </li>
            {memory.episodeSummary ? (
              <li className="text-paper-500">
                Episode: <span className="text-paper-400">{memory.episodeSummary}</span>
              </li>
            ) : null}
            <li>
              Next-turn queries:{" "}
              <span className="text-paper-300">{memory.memoryQueries.length ? memory.memoryQueries.join("; ") : "—"}</span>
            </li>
            {memory.attributeChanges.length ? (
              <li>
                Attribute changes: <span className="text-paper-300">{memory.attributeChanges.join(", ")}</span>
              </li>
            ) : null}
          </ul>
        )}
      </div>
        </>
      ) : null}

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

/** Format a signed delta compactly: integers as ±n, fractions as ±0.0n, 0 as "0". */
function signed(n: number): string {
  if (n === 0) return "0";
  const body = Number.isInteger(n) ? String(Math.abs(n)) : Math.abs(n).toFixed(2);
  return `${n > 0 ? "+" : "−"}${body}`;
}

