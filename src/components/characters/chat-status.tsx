"use client";

import { useState } from "react";
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
import { cx } from "@/components/ui/cx";
import { MoodChip } from "@/components/ui/mood-chip";
import { Tag, type TagTone } from "@/components/ui/tag";

/**
 * Action chips (chat-action-beats.plan.md): a tap is a narrated one-beat exchange —
 * the character plays a small beat and the paired deterministic effect applies
 * pre-narration. Each chip's `hint` (registry copy) is a tooltip saying what the tap
 * will do; `busy` marks the tapped chip while its reply streams.
 */
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
          title={action.hint}
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

/** First couple of garments from the free-text outfit phrase ("a, b and c" → "a, b…"). */
export function outfitSummary(outfit: string): string {
  const parts = outfit
    .split(/,\s*|\s+(?:and|with)\s+/i)
    .map((p) => p.trim())
    .filter(Boolean);
  if (parts.length <= 2) return outfit;
  return `${parts.slice(0, 2).join(", ")}…`;
}

/**
 * The status strip above the composer: a regard-band chip (heart) + meter
 * pips, shown only when off-baseline so casual chats stay clean
 * (character-chat-state.spec.md §7), plus a read-only **outfit chip**
 * (ux-improvements slice 3 — wardrobe finally visible during play): compact
 * garment summary, tap to expand to the full phrase, hidden when the outfit
 * text is empty. Editing stays in the Character sheet. Fed by GET …/state,
 * refetched per send — a pre-first-exchange snapshot is the server's
 * seed-on-read, which already carries the authored Starting Relationship.
 */
export function StatusStrip({ state }: { state: ChatStateSnapshot }) {
  const pips = meterPips(state.meters);
  const [outfitOpen, setOutfitOpen] = useState(false);
  const outfit = state.outfit.trim();
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
      {outfit ? (
        <button
          type="button"
          aria-expanded={outfitOpen}
          onClick={() => setOutfitOpen((open) => !open)}
          title={outfitOpen ? "Show less" : outfit}
          className="inline-flex max-w-full cursor-pointer items-center gap-1 rounded-full border border-ink-500 px-2 py-0.5 text-[11px] leading-4 text-paper-300 transition-colors hover:border-accent-500/50 hover:text-paper-100"
        >
          <span aria-hidden className="text-paper-500">
            wearing
          </span>
          <span className={cx("min-w-0", outfitOpen ? "whitespace-normal" : "max-w-48 truncate")}>
            {outfitOpen ? outfit : outfitSummary(outfit)}
            {state.outfitExposed ? <span className="text-accent-300"> · exposed</span> : null}
          </span>
        </button>
      ) : null}
    </div>
  );
}
