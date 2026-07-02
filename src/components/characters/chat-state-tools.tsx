"use client";

import { useState } from "react";
import {
  CHAT_MIND_NOTE_MAX_CHARS,
  CHAT_PREMISE_MAX_CHARS,
  conditionAttributeOverlays,
  meterDefinitions,
  splitStateCues,
  stageForValue,
  type ActiveCondition,
} from "@/contracts";
import { chatsApi, type ChatStateSnapshot } from "@/lib/client/api";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Tag } from "@/components/ui/tag";
import { Textarea } from "@/components/ui/textarea";
import { useToast } from "@/components/ui/toast";

/**
 * The state-tools modal (character-chat-state.spec.md slice 4): inspect + edit a
 * chat's light state — affinity/stage, meters, conditions, mindNote, premise — plus
 * a read-only last-turn debug readout (the deterministic pulse trace). Available to
 * the character owner. The form mounts fresh each open (the Dialog unmounts its
 * children when closed), so `useState` initializers re-seed from the snapshot
 * without an effect.
 */
export function ChatStateToolsModal({
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
    <Dialog open={open} onClose={onClose} title={`State tools — ${who}`} className="max-w-lg">
      {open ? <StateToolsForm chatId={chatId} snapshot={snapshot} onSaved={onSaved} onClose={onClose} /> : null}
    </Dialog>
  );
}

function StateToolsForm({
  chatId,
  snapshot,
  onSaved,
  onClose,
}: {
  chatId: string;
  snapshot: ChatStateSnapshot;
  onSaved: (next: ChatStateSnapshot) => void;
  onClose: () => void;
}) {
  const toast = useToast();
  const [affinity, setAffinity] = useState(snapshot.affinity);
  const [meters, setMeters] = useState<Record<string, number>>({ ...snapshot.meters });
  const [conditions, setConditions] = useState<ActiveCondition[]>(snapshot.conditions);
  const [mindNote, setMindNote] = useState(snapshot.mindNote);
  const [premise, setPremise] = useState(snapshot.premise);
  const [newCondition, setNewCondition] = useState("");
  const [saving, setSaving] = useState(false);

  const stage = stageForValue(affinity);
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

  const save = async () => {
    setSaving(true);
    const result = await chatsApi.editState(chatId, { affinity, meters, conditions, mindNote, premise });
    setSaving(false);
    if (result.ok) {
      onSaved(result.data);
      toast.push({ title: "State updated" });
      onClose();
    } else {
      toast.push({ title: "Update failed", description: result.error.message, tone: "error" });
    }
  };

  return (
    <div className="flex max-h-[70vh] flex-col gap-4 overflow-y-auto">
      <div className="flex items-center justify-between gap-3">
        <span className="text-xs font-medium tracking-wide text-paper-400 uppercase">Affinity</span>
        <div className="flex items-center gap-2">
          <input
            type="range"
            min={-100}
            max={100}
            value={affinity}
            onChange={(e) => setAffinity(Number(e.target.value))}
            className="w-44"
            aria-label="Affinity"
          />
          <span className="w-24 text-right text-xs text-paper-300">
            {affinity} · {stage.label}
          </span>
        </div>
      </div>

      <div className="flex flex-col gap-2">
        <span className="text-xs font-medium tracking-wide text-paper-400 uppercase">Meters</span>
        {meterDefinitions.map((def) => {
          const value = meters[def.id] ?? def.initial;
          return (
            <div key={def.id} className="flex items-center justify-between gap-3">
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

      <label className="flex flex-col gap-1">
        <span className="text-xs font-medium tracking-wide text-paper-400 uppercase">Premise</span>
        <Textarea
          rows={2}
          value={premise}
          maxLength={CHAT_PREMISE_MAX_CHARS}
          onChange={(e) => setPremise(e.target.value)}
          placeholder="The scenario this chat plays inside…"
        />
      </label>

      <div className="rounded-card border border-ink-600 bg-ink-950/40 p-3 text-xs text-paper-400">
        <div className="flex justify-between">
          <span>Chat clock</span>
          <span className="text-paper-300">{snapshot.clockMinutes} min</span>
        </div>
        <div className="flex justify-between">
          <span>Last visit</span>
          <span className="text-paper-300">{formatLastInteraction(snapshot.lastInteractionAt)}</span>
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
              Affinity {signed(trace.affinityDelta)} · Mood {signed(trace.moodDelta)} · Arousal{" "}
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

function formatLastInteraction(iso: string | null): string {
  if (!iso) return "never";
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? "—" : date.toLocaleString();
}
