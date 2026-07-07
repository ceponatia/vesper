"use client";

import {
  CHAT_ACTIONS,
  meterDefinitions,
  meterStateCue,
  MOOD_BRIGHT_MIN,
  MOOD_LOW_MAX,
  NEUTRAL_MOOD_METER,
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
 * The status strip above the composer: a regard-band chip (heart) + meter
 * pips, shown only when off-baseline so casual chats stay clean
 * (character-chat-state.spec.md §7). Fed by GET …/state, refetched per send —
 * a pre-first-exchange snapshot is the server's seed-on-read, which already
 * carries the authored Starting Relationship.
 */
export function StatusStrip({ state }: { state: ChatStateSnapshot }) {
  const pips = meterPips(state.meters);
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <MoodChip emotion={state.emotion} className="text-xs" />
      <Tag tone="accent" title={`Regard ${state.regard} · Familiarity ${state.familiarity}`}>
        <span aria-hidden>♥</span> {state.regardBand.label}
      </Tag>
      {pips.map((p) => (
        <Tag key={p.id} tone={p.tone}>
          {p.label}
        </Tag>
      ))}
    </div>
  );
}
