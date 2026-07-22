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
import { formatStoryClockShort, formatStoryTime, storyCalendarParams, storyClockAt } from "@/lib/simulation";
import { successorChatsApi, type ChatStateSnapshot } from "@/lib/client/api";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
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
  simClock = null,
  archived,
  skipBusy,
  onSkip,
  onSaved,
  onSimCalendarSaved,
}: {
  chatId: string;
  clockMinutes: number;
  calendarStart: CalendarStart;
  /**
   * The sim world's clock for a routed chat (R3 slice 4 + R5 calendar, ruling
   * 17) — when set, the card shows WORLD time. With an anchor the display and
   * the "story starts on…" editor reuse the legacy calendar rendering via the
   * adapter; without one it stays "Day N" and the editor SETS the anchor.
   */
  simClock?: { storySecond: number; calendarStart: { year: number; month: number; day: number } | null } | null;
  archived: boolean;
  /** True while a skip or reply is in flight — chips disable. */
  skipBusy: boolean;
  /** Hands off to the host's time-skip call (the same one the pickup strip uses). */
  onSkip: (amount: ChatSkipAmount) => void;
  /** Receives the fresh snapshot after a LEGACY anchor save. */
  onSaved: (snapshot: ChatStateSnapshot) => void;
  /** Fired after the SIM anchor saves — the host refetches state. */
  onSimCalendarSaved?: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const sim = simClock == null ? null : storyClockAt(simClock.storySecond);
  const simParams = simClock?.calendarStart != null ? storyCalendarParams(simClock.storySecond, simClock.calendarStart) : null;
  const simTime = simParams === null ? null : chatGameTime(simParams.clockMinutes, simParams.calendarStart);
  const time = chatGameTime(clockMinutes, calendarStart);
  const part = simTime ? dayPartAtMinute(minuteOfDay(simTime)) : sim ? sim.dayPart : dayPartAtMinute(minuteOfDay(time));
  const landing = (amount: ChatSkipAmount) => {
    if (simParams !== null) return formatChatMoment(simParams.clockMinutes + CHAT_SKIP_MINUTES[amount], simParams.calendarStart);
    if (sim) return formatStoryClockShort(storyClockAt(sim.storySecond + CHAT_SKIP_MINUTES[amount] * 60));
    return formatChatMoment(clockMinutes + CHAT_SKIP_MINUTES[amount], calendarStart);
  };

  return (
    <div className="flex flex-col gap-1.5">
      <span className="text-xs font-medium tracking-wide text-paper-400 uppercase">{sim ? "World time" : "Story time"}</span>
      <div className="rounded-md border border-ink-600 bg-ink-850 px-2.5 py-2">
        {sim ? (
          // World time (sim-routed): the anchor renders a real date (R5); the
          // date button opens the sim anchor editor either way.
          <button
            type="button"
            onClick={() => setEditing(true)}
            disabled={archived}
            title={archived ? undefined : "Set when the story starts"}
            className="block w-full cursor-pointer text-left disabled:cursor-default"
          >
            <span className="block text-sm text-paper-200">
              {simTime ? formatChatDate(simTime) : `Day ${sim.dayIndex + 1}`}
            </span>
            <span className="block text-xs text-paper-400">
              {simTime ? formatChatTime(simTime) : formatStoryTime(sim)} · {part}
              {simTime ? ` · day ${sim.dayIndex + 1}` : ""}
            </span>
          </button>
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
      {editing && simClock ? (
        <SimCalendarDialog
          chatId={chatId}
          anchor={simClock.calendarStart}
          onClose={() => setEditing(false)}
          onSaved={() => {
            setEditing(false);
            onSimCalendarSaved?.();
          }}
        />
      ) : editing ? (
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

/**
 * The sim anchor editor (R5 time domain, ruling 17): the date of story day
 * one. Date-only — the world's time-of-day comes from its own clock.
 */
function SimCalendarDialog({
  chatId,
  anchor,
  onClose,
  onSaved,
}: {
  chatId: string;
  anchor: { year: number; month: number; day: number } | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [year, setYear] = useState(String(anchor?.year ?? 2026));
  const [month, setMonth] = useState(String(anchor?.month ?? 6));
  const [day, setDay] = useState(String(anchor?.day ?? 1));
  const [busy, setBusy] = useState(false);
  const save = async () => {
    if (busy) return;
    setBusy(true);
    await successorChatsApi.setCalendar(chatId, {
      year: Number(year) || 2026,
      month: Math.min(12, Math.max(1, Number(month) || 1)),
      day: Math.min(31, Math.max(1, Number(day) || 1)),
    });
    setBusy(false);
    onSaved();
  };
  return (
    <Dialog open title="Story starts on…" onClose={onClose}>
      <div className="flex flex-col gap-3">
        <p className="text-xs text-paper-500">
          The calendar date of day 1. The weekday falls out of the real calendar; time of day is the world&apos;s own
          clock.
        </p>
        <div className="flex gap-2">
          <label className="flex flex-col gap-1 text-xs text-paper-400">
            Year
            <Input value={year} onChange={(e) => setYear(e.target.value)} inputMode="numeric" className="w-20" />
          </label>
          <label className="flex flex-col gap-1 text-xs text-paper-400">
            Month
            <Input value={month} onChange={(e) => setMonth(e.target.value)} inputMode="numeric" className="w-16" />
          </label>
          <label className="flex flex-col gap-1 text-xs text-paper-400">
            Day
            <Input value={day} onChange={(e) => setDay(e.target.value)} inputMode="numeric" className="w-16" />
          </label>
        </div>
        <div className="flex justify-end gap-2">
          <Button variant="quiet" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" busy={busy} onClick={() => void save()}>
            Save
          </Button>
        </div>
      </div>
    </Dialog>
  );
}
