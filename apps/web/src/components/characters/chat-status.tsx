"use client";

import { useState } from "react";
import {
  CHAT_ACTIONS,
  chatGameTime,
  formatChatTime,
  meterReadPips,
  type ChatActionId,
} from "@/contracts";
import type { ChatStateSnapshot } from "@/lib/client/api";
import { formatStoryTime, storyCalendarParams, storyClockAt } from "@/lib/simulation/clock";
import { Button } from "@/components/ui/button";
import { cx } from "@/components/ui/cx";
import { MoodChip } from "@/components/ui/mood-chip";
import { Tag, type TagTone } from "@/components/ui/tag";

/**
 * Action chips: a tap is a narrated one-beat exchange —
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
 * Bands + labels come from the one derived-read path (`meterReadPips` over the
 * server's `meterReads`), so the strip and the narration cues read every meter —
 * energy against sleep pressure, mood by valence — the same way. Tone is the
 * strip's own presentation.
 */
function meterPips(reads: Record<string, number>): { id: string; label: string; tone: TagTone }[] {
  return meterReadPips(reads).map((pip) => ({
    id: pip.meterId,
    label: pip.label,
    tone: pip.meterId === "mood" && pip.label === "bright" ? "ok" : (PIP_TONES[pip.meterId] ?? "default"),
  }));
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
 * The status strip above the composer: an **ambient story-time chip**
 * (weekday-first, "Fri · 2:10pm", always visible so the player can't silently
 * disagree with the narrator about what day it is; tap opens Scenario setup),
 * a regard-band chip (heart) + meter pips, shown only when off-baseline so
 * casual chats stay clean, plus a read-only **outfit chip**
 * (wardrobe finally visible during play): compact
 * garment summary, tap to expand to the full phrase, hidden when the outfit
 * text is empty. Editing stays in the Character sheet. Fed by GET …/state,
 * refetched per send — a pre-first-exchange snapshot is the server's
 * seed-on-read, which already carries the authored Starting Relationship.
 */
export function StatusStrip({ state, onOpenScenario }: { state: ChatStateSnapshot; onOpenScenario: () => void }) {
  const pips = meterPips(state.meterReads);
  const [outfitOpen, setOutfitOpen] = useState(false);
  // The rendered garment phrase (structured worn items + overlay); falls back to the
  // free-text outfit for legacy/ad-hoc chats (chat-wardrobe-parity).
  const outfit = (state.outfitLabel || state.outfit).trim();
  const time = chatGameTime(state.clockMinutes, state.calendarStart);
  // Sim-routed chats show the WORLD clock (R3 + R5 calendar) — the branch's
  // storySecond, the same truth the narrator colors by,
  // never the legacy clock. An anchored world reuses the legacy calendar
  // formatters verbatim via the adapter ("Mon · 8:01am"); unanchored stays
  // "Day N · 8:01am".
  const sim = state.simClock;
  const simTime =
    sim?.calendarStart != null
      ? (() => {
          const params = storyCalendarParams(sim.storySecond, sim.calendarStart);
          return chatGameTime(params.clockMinutes, params.calendarStart);
        })()
      : null;
  const simClock = sim == null ? null : storyClockAt(sim.storySecond);
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <button
        type="button"
        onClick={onOpenScenario}
        title={sim ? "World time (tap to open Scenario setup)" : `${time.weekday} — story time (tap to open Scenario setup)`}
        className="touch-target inline-flex shrink-0 items-center gap-1 rounded-full border border-ink-500 px-2 py-0.5 text-[11px] leading-4 whitespace-nowrap text-paper-300 transition-colors hover:border-accent-500/50 hover:text-paper-100"
      >
        {simTime ? (
          <>
            {simTime.weekday.slice(0, 3)} <span aria-hidden>·</span> {formatChatTime(simTime)}
          </>
        ) : simClock ? (
          <>
            Day {simClock.dayIndex + 1} <span aria-hidden>·</span> {formatStoryTime(simClock)}
          </>
        ) : (
          <>
            {time.weekday.slice(0, 3)} <span aria-hidden>·</span> {formatChatTime(time)}
          </>
        )}
      </button>
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
