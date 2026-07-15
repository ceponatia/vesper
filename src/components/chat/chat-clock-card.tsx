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
import { minuteOfDay, MONTHS, to12Hour, from12Hour, type CalendarStart, type Meridiem } from "@/lib/clock";
import { chatsApi, type ChatStateSnapshot } from "@/lib/client/api";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { useToast } from "@/components/ui/toast";

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
  archived,
  skipBusy,
  onSkip,
  onSaved,
}: {
  chatId: string;
  clockMinutes: number;
  calendarStart: CalendarStart;
  archived: boolean;
  /** True while a skip or reply is in flight — chips disable. */
  skipBusy: boolean;
  /** Hands off to the host's time-skip call (the same one the pickup strip uses). */
  onSkip: (amount: ChatSkipAmount) => void;
  /** Receives the fresh snapshot after an anchor save. */
  onSaved: (snapshot: ChatStateSnapshot) => void;
}) {
  const [editing, setEditing] = useState(false);
  const time = chatGameTime(clockMinutes, calendarStart);
  const part = dayPartAtMinute(minuteOfDay(time));

  return (
    <div className="flex flex-col gap-1.5">
      <span className="text-xs font-medium tracking-wide text-paper-400 uppercase">Story time</span>
      <div className="rounded-md border border-ink-600 bg-ink-850 px-2.5 py-2">
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
        <div className="mt-2 flex flex-wrap gap-1" role="group" aria-label="Skip time">
          {SKIP_CHIPS.map((chip) => (
            <Button
              key={chip.amount}
              size="sm"
              variant="quiet"
              disabled={skipBusy || archived}
              title={`→ ${formatChatMoment(clockMinutes + CHAT_SKIP_MINUTES[chip.amount], calendarStart)}`}
              onClick={() => onSkip(chip.amount)}
            >
              {chip.label}
            </Button>
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

/**
 * The "story starts on…" editor: sets the calendar anchor (minute 0 of the chat).
 * Rebasing is safe — plans and schedules store anchor-relative minutes, so every
 * displayed weekday/date simply re-derives against the new anchor.
 */
function CalendarStartDialog({
  chatId,
  calendarStart,
  onClose,
  onSaved,
}: {
  chatId: string;
  calendarStart: CalendarStart;
  onClose: () => void;
  onSaved: (snapshot: ChatStateSnapshot) => void;
}) {
  const toast = useToast();
  const [saving, setSaving] = useState(false);
  const [month, setMonth] = useState(calendarStart.month);
  const [day, setDay] = useState(calendarStart.day);
  const [year, setYear] = useState(calendarStart.year);
  const start12 = to12Hour(calendarStart.hour);
  const [hour12, setHour12] = useState(start12.hour12);
  const [meridiem, setMeridiem] = useState<Meridiem>(start12.meridiem);

  const save = async () => {
    setSaving(true);
    const result = await chatsApi.editState(chatId, {
      calendarStart: { year, month, day, hour: from12Hour(hour12, meridiem), minute: calendarStart.minute },
    });
    setSaving(false);
    if (!result.ok) {
      toast.push({
        title: "Couldn't set the story start",
        description:
          result.error.code === "chat_busy" ? "A reply is still streaming — try again in a moment." : result.error.message,
        tone: "error",
      });
      return;
    }
    onSaved(result.data);
  };

  const selectClass =
    "rounded-md border border-ink-600 bg-ink-850 px-2 py-1.5 text-sm text-paper-200 focus:border-accent-500 focus:outline-none disabled:opacity-60";

  return (
    <Dialog
      open
      onClose={() => {
        if (!saving) onClose();
      }}
      title="Story starts on…"
      footer={
        <div className="flex w-full justify-end gap-2">
          <Button onClick={onClose} disabled={saving}>
            Cancel
          </Button>
          <Button variant="primary" busy={saving} onClick={() => void save()}>
            Save
          </Button>
        </div>
      }
    >
      <div className="flex flex-col gap-3">
        <div className="flex gap-2">
          <select value={month} onChange={(e) => setMonth(Number(e.target.value))} className={`${selectClass} flex-1`} aria-label="Month">
            {MONTHS.map((name, i) => (
              <option key={name} value={i + 1}>
                {name}
              </option>
            ))}
          </select>
          <select value={day} onChange={(e) => setDay(Number(e.target.value))} className={selectClass} aria-label="Day">
            {Array.from({ length: 31 }, (_, i) => i + 1).map((d) => (
              <option key={d} value={d}>
                {d}
              </option>
            ))}
          </select>
          <select value={year} onChange={(e) => setYear(Number(e.target.value))} className={selectClass} aria-label="Year">
            {Array.from({ length: 9 }, (_, i) => calendarStart.year - 4 + i).map((y) => (
              <option key={y} value={y}>
                {y}
              </option>
            ))}
          </select>
        </div>
        <div className="flex gap-2">
          <select value={hour12} onChange={(e) => setHour12(Number(e.target.value))} className={`${selectClass} flex-1`} aria-label="Hour">
            {Array.from({ length: 12 }, (_, i) => i + 1).map((h) => (
              <option key={h} value={h}>
                {h}:00
              </option>
            ))}
          </select>
          <select value={meridiem} onChange={(e) => setMeridiem(e.target.value as Meridiem)} className={selectClass} aria-label="AM or PM">
            <option value="am">am</option>
            <option value="pm">pm</option>
          </select>
        </div>
        <p className="text-[11px] text-paper-500">
          This anchors the story calendar: the conversation&apos;s first moment lands on this date and time, and every
          weekday, plan label, and schedule re-derives from it. The year only pins which weekday the date falls on.
        </p>
      </div>
    </Dialog>
  );
}
