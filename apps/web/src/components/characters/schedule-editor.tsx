"use client";

import {
  matchScheduleDayPart,
  SCHEDULE_DAY_PARTS,
  scheduleDayPartById,
  type ScheduleEntry,
} from "@/contracts";
import { Button } from "@/components/ui/button";
import { cx } from "@/components/ui/cx";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";

export interface ScheduleEditorProps {
  schedule: readonly ScheduleEntry[];
  onChange: (schedule: ScheduleEntry[]) => void;
  /** Outfit presets for the rhythm auto-dress pick (ux-improvements slice 8.4). */
  outfitPresets?: readonly { id: string; name: string }[];
}

const WEEKDAY_CHIPS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;

/** Minute-of-day ↔ the `<input type="time">` wire value ("HH:MM"). */
const toTimeValue = (minute: number) =>
  `${String(Math.floor(minute / 60)).padStart(2, "0")}:${String(minute % 60).padStart(2, "0")}`;
const fromTimeValue = (value: string, fallback: number): number => {
  const [h, m] = value.split(":").map(Number);
  if (h === undefined || Number.isNaN(h)) return fallback;
  return Math.min(1439, Math.max(0, h * 60 + (Number.isNaN(m ?? NaN) ? 0 : (m ?? 0))));
};

/**
 * The "Daily rhythm" card (chat-initiative.plan.md slice 4): light authoring for
 * `profile.schedule` — rows, not a timetable grid. Each row is a day-part preset
 * (or a custom minute window; windows may wrap past midnight) + what they're
 * doing + where. Chat openers ground "a life meanwhile" in it; in sessions the
 * movement engine walks the same rows. Rows saved with a blank activity/place
 * drop at the trust boundary (element-wise catch) rather than failing the save.
 */
export function ScheduleEditor({ schedule, onChange, outfitPresets = [] }: ScheduleEditorProps) {
  const update = (index: number, patch: Partial<ScheduleEntry>) =>
    onChange(schedule.map((e, i) => (i === index ? { ...e, ...patch } : e)));
  const remove = (index: number) => onChange(schedule.filter((_, i) => i !== index));
  const add = () => {
    const morning = SCHEDULE_DAY_PARTS[0];
    onChange([
      ...schedule,
      { startMinute: morning.startMinute, endMinute: morning.endMinute, activity: "", locationName: "" },
    ]);
  };
  const setWhen = (index: number, value: string) => {
    const part = scheduleDayPartById(value);
    // "Custom" keeps the current window — the time inputs below take over.
    if (part) update(index, { startMinute: part.startMinute, endMinute: part.endMinute });
  };
  const toggleDay = (index: number, day: number) => {
    const entry = schedule[index];
    if (!entry) return;
    const current = new Set(entry.days ?? []);
    if (current.has(day)) current.delete(day);
    else current.add(day);
    // Empty and full masks both mean "every day" — normalize to absent.
    const days = current.size === 0 || current.size === 7 ? undefined : [...current].sort((a, b) => a - b);
    update(index, { days });
  };

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center justify-between">
        <span className="text-sm font-medium text-paper-200">Daily rhythm</span>
        <Button size="sm" variant="ghost" onClick={add}>
          + Add row
        </Button>
      </div>
      <p className="text-xs text-paper-500">
        Where their ordinary days go. Chat openers draw on it (&ldquo;just got off shift&rdquo;), and in a session the
        world moves them along it. A place name matching a world location lets sessions walk them there.
      </p>

      {schedule.length === 0 ? (
        <p className="rounded-card border border-dashed border-ink-600 px-4 py-6 text-center text-sm text-paper-500">
          No rhythm yet. Add a row or two — a work shift and a leisure anchor go a long way.
        </p>
      ) : (
        <ul className="flex flex-col gap-2">
          {schedule.map((entry, index) => {
            const part = matchScheduleDayPart(entry);
            return (
              <li key={index} className="flex flex-col gap-2 rounded-card border border-ink-700 bg-ink-850 p-3">
                <div className="grid grid-cols-1 gap-2 sm:grid-cols-[9rem_1fr_1fr_auto] sm:items-end">
                  <Field label="When">
                    {(id) => (
                      <Select id={id} value={part ?? "custom"} onChange={(e) => setWhen(index, e.target.value)}>
                        {SCHEDULE_DAY_PARTS.map((p) => (
                          <option key={p.id} value={p.id}>
                            {p.label}
                          </option>
                        ))}
                        <option value="custom">Custom…</option>
                      </Select>
                    )}
                  </Field>
                  <Field
                    label="Doing"
                    error={!entry.activity.trim() ? "Blank — this row is dropped on save." : undefined}
                  >
                    {(id) => (
                      <Input
                        id={id}
                        value={entry.activity}
                        placeholder="waiting tables, morning run…"
                        onChange={(e) => update(index, { activity: e.target.value })}
                      />
                    )}
                  </Field>
                  <Field label="Where">
                    {(id) => (
                      <Input
                        id={id}
                        value={entry.locationName}
                        placeholder="the Dockside Café…"
                        onChange={(e) => update(index, { locationName: e.target.value })}
                      />
                    )}
                  </Field>
                  {outfitPresets.length > 0 ? (
                    // Rhythm auto-dress (slice 8.4): pickup skips landing in this
                    // window dress the character in the picked preset.
                    <Field label="Wearing">
                      {(id) => (
                        <Select
                          id={id}
                          value={entry.outfitPresetId ?? ""}
                          onChange={(e) => update(index, { outfitPresetId: e.target.value || undefined })}
                        >
                          <option value="">— (keep current)</option>
                          {outfitPresets.map((preset) => (
                            <option key={preset.id} value={preset.id}>
                              {preset.name || "Unnamed preset"}
                            </option>
                          ))}
                        </Select>
                      )}
                    </Field>
                  ) : null}
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => remove(index)}
                    aria-label="Remove schedule row"
                    className="touch-target w-full sm:w-auto"
                  >
                    ✕
                  </Button>
                </div>
                {part === null ? (
                  <div className="grid grid-cols-2 gap-2 sm:max-w-xs">
                    <Field label="From">
                      {(id) => (
                        <Input
                          id={id}
                          type="time"
                          value={toTimeValue(entry.startMinute)}
                          onChange={(e) => update(index, { startMinute: fromTimeValue(e.target.value, entry.startMinute) })}
                        />
                      )}
                    </Field>
                    <Field label="Until" hint="An earlier end wraps past midnight.">
                      {(id) => (
                        <Input
                          id={id}
                          type="time"
                          value={toTimeValue(entry.endMinute)}
                          onChange={(e) => update(index, { endMinute: fromTimeValue(e.target.value, entry.endMinute) })}
                        />
                      )}
                    </Field>
                  </div>
                ) : null}
                <div className="flex flex-wrap items-center gap-1">
                  <span className="w-16 text-[11px] text-paper-500">{entry.days?.length ? "On:" : "Every day"}</span>
                  {WEEKDAY_CHIPS.map((label, day) => {
                    const active = entry.days?.includes(day) ?? false;
                    return (
                      <button
                        key={label}
                        type="button"
                        onClick={() => toggleDay(index, day)}
                        aria-pressed={active}
                        className={cx(
                          "cursor-pointer rounded border px-1.5 py-0.5 text-[11px] transition-colors",
                          active
                            ? "border-accent-500/40 bg-accent-500/20 text-accent-300"
                            : "border-ink-600 text-paper-500 hover:border-ink-500 hover:text-paper-300",
                        )}
                      >
                        {label}
                      </button>
                    );
                  })}
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
