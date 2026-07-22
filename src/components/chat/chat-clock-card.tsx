"use client";

import { useState } from "react";
import {
  CHAT_SKIP_MINUTES,
  chatGameTime,
  dayPartAtMinute,
  formatChatDate,
  formatChatMoment,
  formatChatTime,
  type ChatSkipAmount,
} from "@/contracts";
import { minuteOfDay, type CalendarStart } from "@/lib/clock";
import { formatStoryClockShort, formatStoryTime, storyClockAt } from "@/lib/simulation";
import type { ChatStateSnapshot } from "@/lib/client/api";
import { Button } from "@/components/ui/button";
import { CalendarStartDialog } from "@/components/chat/calendar-start-dialog";

/** The four skip chips, in the pickup strip's vocabulary ("Moments" included here). */
const SKIP_CHIPS: { label: string; amount: ChatSkipAmount }[] = [
  { label: "Moments", amount: "moments" },
  { label: "Hours", amount: "hours" },
  { label: "Overnight", amount: "overnight" },
  { label: "Days", amount: "days" },
];

/**
 * The clock card (chat-clock-calendar.plan.md): story time made visible — day
 * counter, weekday + date, clock time + day-part — with the skip chips right
 * beside the display that makes them legible (each chip previews its landing),
 * and the "story starts on…" anchor editor behind the date. First tenant of the
 * desktop right aside; also rendered in the phone Roster sheet.
 */
export function ChatClockCard({
  chatId,
  clockMinutes,
  calendarStart,
  simStorySecond = null,
  archived,
  skipBusy,
  onSkip,
  onSaved,
}: {
  chatId: string;
  clockMinutes: number;
  calendarStart: CalendarStart;
  /**
   * The sim world's clock for a routed chat (R3 slice 4, ruling 17) — when set,
   * the card shows WORLD time (no weekday/calendar until R5's anchor) and the
   * anchor editor hides (the calendar start is a legacy-lane concept).
   */
  simStorySecond?: number | null;
  archived: boolean;
  /** True while a skip or reply is in flight — chips disable. */
  skipBusy: boolean;
  /** Hands off to the host's time-skip call (the same one the pickup strip uses). */
  onSkip: (amount: ChatSkipAmount) => void;
  /** Receives the fresh snapshot after an anchor save. */
  onSaved: (snapshot: ChatStateSnapshot) => void;
}) {
  const [editing, setEditing] = useState(false);
  const sim = simStorySecond == null ? null : storyClockAt(simStorySecond);
  const time = chatGameTime(clockMinutes, calendarStart);
  const part = sim ? sim.dayPart : dayPartAtMinute(minuteOfDay(time));
  const landing = (amount: ChatSkipAmount) =>
    sim
      ? formatStoryClockShort(storyClockAt(sim.storySecond + CHAT_SKIP_MINUTES[amount] * 60))
      : formatChatMoment(clockMinutes + CHAT_SKIP_MINUTES[amount], calendarStart);

  return (
    <div className="flex flex-col gap-1.5">
      <span className="text-xs font-medium tracking-wide text-paper-400 uppercase">{sim ? "World time" : "Story time"}</span>
      <div className="rounded-md border border-ink-600 bg-ink-850 px-2.5 py-2">
        {sim ? (
          // World time (sim-routed): no weekday/date to show or edit until the
          // R5 calendar anchor — day index + clock + day part IS the truth.
          <div className="w-full text-left">
            <span className="block text-sm text-paper-200">Day {sim.dayIndex + 1}</span>
            <span className="block text-xs text-paper-400">
              {formatStoryTime(sim)} · {part}
            </span>
          </div>
        ) : (
          <button
            type="button"
            onClick={() => setEditing(true)}
            disabled={archived}
            title={archived ? undefined : "Set when the story starts"}
            className="block w-full cursor-pointer text-left disabled:cursor-default"
          >
            <span className="block text-sm text-paper-200">{formatChatDate(time)}</span>
            <span className="block text-xs text-paper-400">
              {formatChatTime(time)} · {part} · day {time.dayIndex + 1}
            </span>
          </button>
        )}
        <div className="mt-2 flex flex-wrap gap-1" role="group" aria-label="Skip time">
          {SKIP_CHIPS.map((chip) => (
            <Button
              key={chip.amount}
              size="sm"
              variant="quiet"
              disabled={skipBusy || archived}
              title={`→ ${landing(chip.amount)}`}
              onClick={() => onSkip(chip.amount)}
            >
              {chip.label}
            </Button>
          ))}
        </div>
        {/* Landing previews visible without hover — the title tooltip above is invisible
            on touch, so a phone tap was committing to a skip blind (mobile-ux.plan.md). */}
        <div className="mt-1.5 flex flex-col gap-0.5 text-[10px] text-paper-600">
          {SKIP_CHIPS.map((chip) => (
            <span key={chip.amount}>
              {chip.label} <span aria-hidden>→</span> {landing(chip.amount)}
            </span>
          ))}
        </div>
      </div>
      {editing ? (
        <CalendarStartDialog
          chatId={chatId}
          calendarStart={calendarStart}
          onClose={() => setEditing(false)}
          onSaved={(snapshot) => {
            setEditing(false);
            onSaved(snapshot);
          }}
        />
      ) : null}
    </div>
  );
}
