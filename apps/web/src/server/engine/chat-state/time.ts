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
import { CHAT_METER_CATCH_UP_MAX_MINUTES, CHAT_SKIP_MINUTES } from "../constants";
import { chatSkipNote } from "../prompts/character-chat";
import type { ChatScenario, ChatState } from "./types";

/**
 * Integrate a character's meters across the story interval `[fromMinutes,
 * toMinutes]` under their personalized drift laws — the ONE elapsed-time meter
 * path; nothing else moves meters with time. PURE and closed-form: meters depend
 * only on the interval, never on how often it is read.
 *
 * Only the latest `CHAT_METER_CATCH_UP_MAX_MINUTES` of the interval integrate.
 * The interval is one piece today; a caller that must stop at a boundary inside
 * it (a crossed routine window, a standing condition that suspends a meter's
 * drift) integrates each piece with this function and applies the boundary's
 * effect between them.
 */
export function integrateChatMeters(args: {
  meters: Record<string, number>;
  profile: CharacterProfile;
  fromMinutes: number;
  toMinutes: number;
}): Record<string, number> {
  const elapsed = Math.min(args.toMinutes - args.fromMinutes, CHAT_METER_CATCH_UP_MAX_MINUTES);
  if (!(elapsed > 0)) return args.meters;
  return applyMeterDrift(args.meters, elapsed, personalizeMeters(meterDefinitions, args.profile.traits));
}

/**
 * Catch a character's state up to the shared story clock. PURE. Their meters
 * integrate from the minute they hold at (`metersAtMinutes`) to `clockMinutes`
 * and are re-stamped there, and conditions past the clock expire. Physiology is
 * presence-independent — an away character catches up exactly as a present one
 * does, whether on an exchange, a skip, or a read.
 *
 * Idempotent: a second call at the same clock returns its input unchanged, so a
 * read, a retake, or a repeated projection never moves meters twice. A stamp
 * ahead of the clock (a state that settled but whose clock tick did not) never
 * integrates backwards. An unstamped state (`null`) holds at the clock it meets.
 * Emotional weather is NOT elapsed-time physiology: it decays per exchange
 * (`decayExchangeFeeling`) and over skips (`applyTimeSkip`).
 */
export function driftChatState(
  state: ChatState,
  profile: CharacterProfile,
  options: { clockMinutes: number },
): ChatState {
  const { clockMinutes } = options;
  // Conditions expire against the SHARED story clock — one timeline for the roster.
  const conditions = state.conditions.filter((c) => !isConditionExpired(c, clockMinutes));
  const expired = conditions.length !== state.conditions.length;
  const from = state.metersAtMinutes ?? clockMinutes;
  if (from >= clockMinutes) {
    if (state.metersAtMinutes !== null && !expired) return state;
    return { ...state, conditions, metersAtMinutes: state.metersAtMinutes ?? clockMinutes };
  }
  const meters = integrateChatMeters({ meters: state.meters, profile, fromMinutes: from, toMinutes: clockMinutes });
  return { ...state, meters, metersAtMinutes: clockMinutes, conditions };
}

/**
 * One exchange's emotional-weather beat: the standing feeling fades and the
 * bruise heals per EXCHANGE, never per story minute. Kept apart from the
 * elapsed-time meter path on purpose; a character in the exchange takes it.
 */
export function decayExchangeFeeling(state: ChatState): ChatState {
  return { ...state, feeling: decayFeelingState(state.feeling) };
}

/**
 * Apply a player time skip to the SCENARIO. PURE. The clock advances (which
 * lets already-running timed conditions expire through the existing clock-keyed
 * filter), the one-shot skip note is stamped (worded by the CURRENT stage band),
 * and the skip records itself into the capped history ring. Each member's meters
 * then follow the skipped minutes through `skipChatMember`.
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

/**
 * The scene-boundary half of a time skip for a member in the scene: expiry vs
 * the advanced shared clock, the familiarity scene-budget reset, feeling
 * softening over the skipped time (+ rhythm dress when `profile` given). Moves
 * no meter — `skipChatMember` integrates those first.
 */
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

/**
 * One roster member's half of a time skip. PURE. Every member's meters — away
 * members included, because physiology is presence-independent — integrate
 * across the skipped minutes on the one elapsed-time path (`driftChatState`).
 * The scene-boundary effects (`applyTimeSkip`) belong to the scene, so only a
 * PRESENT member takes them; an away member's feeling, scene budget and
 * wardrobe carry on untouched.
 */
export function skipChatMember(
  state: ChatState,
  amount: ChatSkipAmount,
  clockMinutes: number,
  profile: CharacterProfile,
  calendarStart: CalendarStart = CHAT_DEFAULT_CALENDAR_START,
): ChatState {
  const caughtUp = driftChatState(state, profile, { clockMinutes });
  return caughtUp.presence === "present"
    ? applyTimeSkip(caughtUp, amount, clockMinutes, profile, calendarStart)
    : caughtUp;
}
