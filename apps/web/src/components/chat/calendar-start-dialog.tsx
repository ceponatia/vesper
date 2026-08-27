"use client";

import { useState } from "react";
import { chatGameTime, formatChatTime } from "@/contracts";
import { MONTHS, to12Hour, from12Hour, type CalendarStart, type Meridiem } from "@/lib/clock";
import { chatsApi, type ChatStateSnapshot } from "@/lib/client/api";
import { Button } from "@/components/ui/button";
import { daysInMonth, DatePicker, type DatePickerValue } from "@/components/ui/date-picker";
import { Dialog } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { useToast } from "@/components/ui/toast";

/** 2-digit years type as the current century — a tolerant nicety, not a requirement. */
function normalizeYear(year: number): number {
  return year < 100 ? 2000 + year : year;
}

/** Bounds-check a candidate date; out-of-range days (Feb 31) fail rather than overflow. */
function validated(year: number, month: number, day: number): DatePickerValue | null {
  if (month < 1 || month > 12) return null;
  if (day < 1 || day > daysInMonth(year, month)) return null;
  return { year, month, day };
}

const MONTH_ABBR = MONTHS.map((m) => m.slice(0, 3).toLowerCase());

/** "march"/"mar"/"January" → 1-based month, matched on the first 3 letters (tolerant of typos past that). */
function monthFromName(raw: string): number | null {
  const index = MONTH_ABBR.indexOf(raw.toLowerCase().slice(0, 3));
  return index >= 0 ? index + 1 : null;
}

/**
 * A tolerant free-form date parser for the desktop "jump to a date" field:
 * "3/14" (M/D, current-year fallback), "march 3",
 * "jan 5 2027". A missing year keeps `fallbackYear` (the anchor's current year —
 * this is a fictional calendar, not the real one). Returns null on anything it
 * can't confidently parse; the caller never blocks on that, it just hints.
 */
export function parseTypedDate(input: string, fallbackYear: number): DatePickerValue | null {
  const trimmed = input.trim();
  if (!trimmed) return null;

  const numeric = /^(\d{1,2})[/-](\d{1,2})(?:[/-](\d{2,4}))?$/.exec(trimmed);
  if (numeric) {
    const month = Number(numeric[1]);
    const day = Number(numeric[2]);
    const year = numeric[3] ? normalizeYear(Number(numeric[3])) : fallbackYear;
    return validated(year, month, day);
  }

  const worded = /^([A-Za-z]+)\.?\s+(\d{1,2})(?:st|nd|rd|th)?,?\s*(\d{4})?$/.exec(trimmed);
  if (worded) {
    const month = monthFromName(worded[1] ?? "");
    if (month === null) return null;
    const day = Number(worded[2]);
    const year = worded[3] ? Number(worded[3]) : fallbackYear;
    return validated(year, month, day);
  }

  return null;
}

/**
 * The "story starts on…" editor (extracted from
 * chat-clock-card.tsx and rebuilt around the themed `DatePicker`): sets the
 * calendar anchor (minute 0 of the chat). Rebasing is safe — plans and
 * schedules store anchor-relative minutes, so every displayed weekday/date
 * simply re-derives against the new anchor. Opened from the clock card's date
 * tap (desktop) and from Scenario setup's "Story starts" row.
 */
export function CalendarStartDialog({
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
  const [draft, setDraft] = useState<DatePickerValue>({
    year: calendarStart.year,
    month: calendarStart.month,
    day: calendarStart.day,
  });
  const start12 = to12Hour(calendarStart.hour);
  const [hour12, setHour12] = useState(start12.hour12);
  const [meridiem, setMeridiem] = useState<Meridiem>(start12.meridiem);
  const [typedInput, setTypedInput] = useState("");

  const preview = chatGameTime(0, { ...draft, hour: from12Hour(hour12, meridiem), minute: calendarStart.minute });
  const parsedTyped = parseTypedDate(typedInput, draft.year);
  const typedInvalid = typedInput.trim().length > 0 && parsedTyped === null;
  const parsedWeekday = parsedTyped ? chatGameTime(0, { ...parsedTyped, hour: 0, minute: 0 }).weekday : null;

  const applyTypedInput = (next: string) => {
    setTypedInput(next);
    const parsed = parseTypedDate(next, draft.year);
    if (parsed) setDraft(parsed);
  };

  const save = async () => {
    setSaving(true);
    const result = await chatsApi.editState(chatId, {
      calendarStart: { ...draft, hour: from12Hour(hour12, meridiem), minute: calendarStart.minute },
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
        <p className="text-sm text-paper-200">
          <strong className="font-semibold text-paper-50">{preview.weekday}</strong>, {MONTHS[preview.month - 1] ?? "January"}{" "}
          {preview.day} — {formatChatTime(preview)}
        </p>

        <DatePicker value={draft} onChange={setDraft} />

        {/* Typed free-form entry — desktop only: iOS's native
            date wheel has no weekday, which defeats the point of this whole editor. */}
        <label className="hidden flex-col gap-1 sm:flex">
          <span className="text-xs font-medium tracking-wide text-paper-400 uppercase">Jump to a date</span>
          <Input value={typedInput} onChange={(e) => applyTypedInput(e.target.value)} placeholder={'e.g. "march 3" or "3/14"'} />
          {parsedWeekday ? (
            <span className="text-[11px] text-accent-300">→ {parsedWeekday}</span>
          ) : typedInvalid ? (
            <span className="text-[11px] text-paper-500">Unrecognized date — try the grid instead.</span>
          ) : null}
        </label>

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
          weekday, plan label, and schedule re-derives from it. The year is kept only to pin which weekday the date falls
          on.
        </p>
      </div>
    </Dialog>
  );
}
