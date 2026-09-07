import {
  applyMeterDrift,
  CHAT_DEFAULT_CALENDAR_START,
  chatGameTime,
  formatChatMoment,
  isConditionExpired,
  meterDefinitions,
  personalizeMeters,
  resolveOutfitPreset,
  SKIP_HISTORY_CAP,
  type CharacterProfile,
  type ChatSkipAmount,
  type SkipRecord,
} from "@/contracts";
import { minuteOfDay, type CalendarStart } from "@/lib/clock";
import { CHAT_FEELING_SKIP_STEPS, decayFeelingState } from "../chat-feeling";
import { CHAT_METER_DRIFT_MINUTES, CHAT_SKIP_MINUTES } from "../constants";
import { chatSkipNote } from "../prompts/character-chat";
import type { ChatScenario, ChatState } from "./types";

/**
 * Advance the in-game state for one exchange. There is no between-visit
 * wall-clock recovery — no time passes between visits at all. PURE and idempotent
 * on read: without `advance` it is a pass-through projection, with it meters
 * decay CHAT_METER_DRIFT_MINUTES toward their *personalized* baselines (meter
 * pacing is exchange-keyed — deliberately NOT the 1-minute clock tick, see
 * constants.ts) and conditions past the clock expire.
 */
export function driftChatState(
  state: ChatState,
  profile: CharacterProfile,
  options: { advance?: boolean; clockMinutes: number },
): ChatState {
  // Conditions expire against the SHARED story clock even when this member's
  // meters are frozen — one timeline for the roster.
  const conditions = state.conditions.filter((c) => !isConditionExpired(c, options.clockMinutes));
  if (!options.advance) return conditions.length === state.conditions.length ? state : { ...state, conditions };
  const meters = applyMeterDrift({ ...state.meters }, CHAT_METER_DRIFT_MINUTES, personalizeMeters(meterDefinitions, profile.traits));
  // Emotional weather decays per EXCHANGE, not clock minutes: one advance =
  // one beat of the feeling fading and the bruise healing.
  return { ...state, meters, conditions, feeling: decayFeelingState(state.feeling) };
}

/**
 * Apply a player time skip (flavor-only). PURE. Exactly three
 * effects: the clock advances (which lets already-running timed conditions expire
 * through the existing clock-keyed filter — no new wiring), the one-shot skip note
 * is stamped (worded by the CURRENT stage band), and the skip records itself into
 * the capped history ring. **Meters do not change** — whether twelve skipped hours
 * mean recovery or deterioration is circumstance, and the time-effects system that
 * could know stays scaffolded, not wired.
 */
export function applyTimeSkipToScenario(
  scenario: ChatScenario,
  amount: ChatSkipAmount,
  primaryRegardBandId: string,
  now: Date,
): ChatScenario {
  const clockMinutes = scenario.clockMinutes + CHAT_SKIP_MINUTES[amount];
  const record: SkipRecord = { at: now.toISOString(), clockMinutes, amount };
  return {
    ...scenario,
    clockMinutes,
    // The one-shot note is worded by the PRIMARY's current band (the anchor voice)
    // and names the landing on the story calendar ("Friday evening").
    pendingSkipNote: chatSkipNote(amount, primaryRegardBandId, formatChatMoment(clockMinutes, scenario.calendarStart)),
    skipHistory: [...scenario.skipHistory, record].slice(-SKIP_HISTORY_CAP),
  };
}

/**
 * Rhythm auto-dress: a schedule row covering the skipped-to clock that names an
 * outfit preset re-dresses the character for that window — in STRUCTURED form,
 * seeding the worn list + active preset from that
 * preset's items and clearing the free-text overlay. A skip is a scene boundary,
 * so the rhythm wins over the tracked outfit (undressed overnight → dressed for
 * the morning shift). The weekday and minute-of-day are REAL — resolved against
 * the scenario's calendar anchor rather than a `clock % 1440` / day-mod-7
 * pseudo-calendar.
 */
type ScheduleEntry = CharacterProfile["schedule"][number];

/**
 * Schedule entry covering a minute-of-day; windows may wrap past midnight.
 * Entries with a `days` mask only match on those weekdays (absent ⇒ daily).
 * (Relocated from the deleted session merge lane — the chat rhythm-dress read
 * is its only surviving consumer.)
 */
function scheduleEntryAt(
  schedule: readonly ScheduleEntry[],
  minute: number,
  weekdayIndex?: number,
): ScheduleEntry | null {
  for (const entry of schedule) {
    if (entry.days && weekdayIndex !== undefined && !entry.days.includes(weekdayIndex)) continue;
    if (entry.startMinute <= entry.endMinute) {
      if (minute >= entry.startMinute && minute < entry.endMinute) return entry;
    } else if (minute >= entry.startMinute || minute < entry.endMinute) {
      return entry;
    }
  }
  return null;
}

export function rhythmOutfitPatch(
  profile: CharacterProfile,
  clockMinutes: number,
  calendarStart: CalendarStart = CHAT_DEFAULT_CALENDAR_START,
): Partial<ChatState> {
  const time = chatGameTime(clockMinutes, calendarStart);
  const entry = scheduleEntryAt(profile.schedule, minuteOfDay(time), time.weekdayIndex);
  if (!entry?.outfitPresetId) return {};
  const preset = resolveOutfitPreset(profile, entry.outfitPresetId);
  return preset && preset.items.length
    ? { wornItemIds: preset.items, outfitPresetId: preset.id, outfit: "", outfitExposed: false }
    : {};
}

/** The per-character half of a time skip: expiry vs the advanced shared clock + scene-boundary resets (+ rhythm dress when `profile` given). */
export function applyTimeSkip(
  state: ChatState,
  amount: ChatSkipAmount,
  clockMinutes: number,
  profile?: CharacterProfile,
  calendarStart: CalendarStart = CHAT_DEFAULT_CALENDAR_START,
): ChatState {
  return {
    ...state,
    conditions: state.conditions.filter((c) => !isConditionExpired(c, clockMinutes)),
    // A skip is a scene boundary: the familiarity ratchet's per-scene budget resets.
    familiaritySceneGain: 0,
    // Emotional weather softens over skipped time — deliberately slower than the
    // beat-for-beat conversion (a "moments" skip barely dents a strong feeling; a
    // night softens it; days clear it). Bruises heal on the same steps.
    feeling: decayFeelingState(state.feeling, CHAT_FEELING_SKIP_STEPS[amount]),
    ...(profile ? rhythmOutfitPatch(profile, clockMinutes, calendarStart) : {}),
  };
}
