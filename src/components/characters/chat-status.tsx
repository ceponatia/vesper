"use client";

import {
  CHAT_ACTIONS,
  meterDefinitions,
  meterStateCue,
  MOOD_BRIGHT_MIN,
  MOOD_LOW_MAX,
  NEUTRAL_MOOD_METER,
  stageById,
  stageMidpoint,
  type ChatActionId,
} from "@/contracts";
import type { ChatStateSnapshot } from "@/lib/client/api";
import { Button } from "@/components/ui/button";
import { MoodChip } from "@/components/ui/mood-chip";
import { Tag, type TagTone } from "@/components/ui/tag";

/** Test-bed action chips (character-chat-state.spec.md slice 4): one-click state nudges. */
export function ActionChips({
  busy,
  disabled,
  onAction,
}: {
  busy: ChatActionId | null;
  disabled: boolean;
  onAction: (action: ChatActionId) => void;
}) {
  return (
    <div className="flex flex-wrap gap-1.5">
      {CHAT_ACTIONS.map((action) => (
        <Button
          key={action.id}
          size="sm"
          variant="quiet"
          busy={busy === action.id}
          disabled={disabled || busy !== null}
          onClick={() => onAction(action.id)}
        >
          {action.label}
        </Button>
      ))}
    </div>
  );
}

/** Presentation tone per meter; band vocabulary itself lives in the registry. */
const PIP_TONES: Record<string, TagTone> = { stress: "danger", arousal: "accent", intoxication: "accent" };

/**
 * Compact, off-baseline meter pips for the status strip (only what's worth saying).
 * Bands + labels come from the meters registry (`pipLabel` on each threshold), so a
 * registry edit moves this strip and the narration cues together — the old hardcoded
 * copies silently desynced (codebase-review A10). Mood is the deliberate exception:
 * it has no registry thresholds (derived descriptor instead), so it reads the shared
 * valence band cuts.
 */
function meterPips(meters: Record<string, number>): { id: string; label: string; tone: TagTone }[] {
  const pips: { id: string; label: string; tone: TagTone }[] = [];
  for (const def of meterDefinitions) {
    const value = meters[def.id];
    if (value === undefined) continue;
    const cue = meterStateCue(def.id, value);
    if (!cue?.pipLabel) continue;
    pips.push({ id: def.id, label: cue.pipLabel, tone: PIP_TONES[def.id] ?? "default" });
  }
  const mood = meters.mood ?? NEUTRAL_MOOD_METER;
  if (mood >= MOOD_BRIGHT_MIN) pips.push({ id: "mood", label: "bright", tone: "ok" });
  else if (mood <= MOOD_LOW_MAX) pips.push({ id: "mood", label: "low", tone: "default" });
  return pips;
}

/**
 * The status strip above the composer: an affinity stage chip (heart) + meter
 * pips, shown only when off-baseline so casual chats stay clean
 * (character-chat-state.spec.md §7). Fed by GET …/chat/state, refetched per send.
 */
export function StatusStrip({ state, startingStage }: { state: ChatStateSnapshot; startingStage: string }) {
  const pips = meterPips(state.meters);
  // A fresh chat (no stored row) previews the authored Starting Relationship, so editing
  // the dropdown moves the chip at once. Once the chat has its own disposition we show
  // that — the seed is then inert (Reset state re-seeds from the authored default).
  const seed = state.persisted ? undefined : stageById(startingStage);
  const stageLabel = seed?.label ?? state.stage.label;
  const affinity = seed ? stageMidpoint(startingStage) : state.affinity;
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <MoodChip emotion={state.emotion} className="text-xs" />
      <Tag tone="accent" title={`Affinity ${affinity}`}>
        <span aria-hidden>♥</span> {stageLabel}
      </Tag>
      {pips.map((p) => (
        <Tag key={p.id} tone={p.tone}>
          {p.label}
        </Tag>
      ))}
    </div>
  );
}
