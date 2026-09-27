import { deriveSleepCredit } from "@vesper/simulation-core/bodies";
import { COLLAPSE_SLEEP_SECONDS, METER_FIXED_POINT_ONE } from "@vesper/simulation-core/contracts/bodies";
import {
  applyMeterDrift,
  CHAT_DEFAULT_CALENDAR_START,
  chatGameTime,
  conditionKey,
  deriveChatEnergyRead,
  formatChatMoment,
  isConditionExpired,
  meterDefinitions,
  personalizeMeters,
  resolveOutfitPreset,
  SKIP_HISTORY_CAP,
  type ActiveCondition,
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
 * The condition that means a character is asleep, matched by its normalized
 * label like every condition table. However it began — a collapse, the pulse,
 * an author — an `asleep` condition holds the energy reserve and credits sleep.
 */
export const CHAT_ASLEEP_CONDITION_LABEL = "asleep";

/** Collapse is forced sleep: the successor's eight story hours of what the body was denied. */
export const CHAT_COLLAPSE_SLEEP_MINUTES = COLLAPSE_SLEEP_SECONDS / 60;

/** The meter sleep holds and restores — the energy reserve. */
const SLEEP_RESERVE_METER_ID = "energy";

const isAsleepCondition = (condition: ActiveCondition): boolean =>
  conditionKey(condition) === CHAT_ASLEEP_CONDITION_LABEL;

/** A condition's end minute; null when it is open-ended. */
const conditionEndMinutes = (condition: ActiveCondition): number | null =>
  condition.durationMinutes === undefined ? null : condition.startedAtMinutes + condition.durationMinutes;

/** Whether a condition stands through the whole of `[fromMinutes, toMinutes]`. */
function standsThrough(condition: ActiveCondition, fromMinutes: number, toMinutes: number): boolean {
  const end = conditionEndMinutes(condition);
  return condition.startedAtMinutes <= fromMinutes && (end === null || end >= toMinutes);
}

/**
 * Sleep credit for `minutes` asleep on a 0–1 reserve — simulation-core's
 * `deriveSleepCredit` (+0.09 per story hour, never past 0.95, never lowering a
 * reserve already above it). Credit accrues as the sleep is integrated, so a
 * night integrated in one piece or several lands on the same reserve.
 */
function creditSleep(reserve: number, minutes: number): number {
  const reserveFixedPoint = Math.round(Math.min(1, Math.max(0, reserve)) * METER_FIXED_POINT_ONE);
  const credit = deriveSleepCredit({ sleptSeconds: Math.round(minutes * 60), reserveAtWakeFixedPoint: reserveFixedPoint });
  return credit > 0 ? (reserveFixedPoint + credit) / METER_FIXED_POINT_ONE : reserve;
}

/**
 * Integrate a character's meters across ONE piece of story time,
 * `[fromMinutes, toMinutes]`, under their personalized drift laws — the one
 * elapsed-time meter step; nothing else moves meters with time. PURE and
 * closed-form: meters depend only on the interval, never on how often it is
 * read.
 *
 * `conditions` are the conditions standing through the WHOLE piece — the
 * caller cuts the interval wherever a condition begins or ends. A standing
 * `asleep` condition holds the energy reserve instead of letting it drain and
 * credits the time slept. Only the latest `CHAT_METER_CATCH_UP_MAX_MINUTES` of
 * a piece integrate.
 */
export function integrateChatMeters(args: {
  meters: Record<string, number>;
  profile: CharacterProfile;
  fromMinutes: number;
  toMinutes: number;
  conditions?: readonly ActiveCondition[];
}): Record<string, number> {
  const elapsed = Math.min(args.toMinutes - args.fromMinutes, CHAT_METER_CATCH_UP_MAX_MINUTES);
  if (!(elapsed > 0)) return args.meters;
  const drifted = applyMeterDrift(args.meters, elapsed, personalizeMeters(meterDefinitions, args.profile.traits));
  const reserve = args.meters[SLEEP_RESERVE_METER_ID];
  if (reserve === undefined || !(args.conditions ?? []).some(isAsleepCondition)) return drifted;
  return { ...drifted, [SLEEP_RESERVE_METER_ID]: creditSleep(reserve, elapsed) };
}

/**
 * Integrate `[fromMinutes, toMinutes]` piece by piece, cutting wherever one of
 * the state's conditions begins or ends, and record the latest real sleep that
 * ended inside it. PURE.
 */
function integrateAcrossConditions(
  state: ChatState,
  profile: CharacterProfile,
  fromMinutes: number,
  toMinutes: number,
): { meters: Record<string, number>; lastSleepEndedAtMinutes: number | null } {
  const cuts = new Set<number>();
  for (const condition of state.conditions) {
    for (const point of [condition.startedAtMinutes, conditionEndMinutes(condition)]) {
      if (point !== null && point > fromMinutes && point < toMinutes) cuts.add(point);
    }
  }
  let meters = state.meters;
  let cursor = fromMinutes;
  for (const boundary of [...[...cuts].sort((left, right) => left - right), toMinutes]) {
    const conditions = state.conditions.filter((condition) => standsThrough(condition, cursor, boundary));
    meters = integrateChatMeters({ meters, profile, fromMinutes: cursor, toMinutes: boundary, conditions });
    cursor = boundary;
  }
  let lastSleepEndedAtMinutes = state.lastSleepEndedAtMinutes;
  for (const condition of state.conditions) {
    const end = conditionEndMinutes(condition);
    if (!isAsleepCondition(condition) || end === null || end <= fromMinutes || end > toMinutes) continue;
    lastSleepEndedAtMinutes = Math.max(lastSleepEndedAtMinutes ?? end, end);
  }
  return { meters, lastSleepEndedAtMinutes };
}

/**
 * Collapse — the energy read at its saturated floor (reserve − pressure ≤ −1)
 * — is forced sleep: a self-expiring `asleep` condition from this minute for
 * `CHAT_COLLAPSE_SLEEP_MINUTES`, which the next catch-up integrates like any
 * sleep. Like the successor, it needs witnessed wakefulness: with no sleep on
 * record the pressure curve assumes the routine was kept and never reaches
 * the floor. Null when the character is already asleep or holds nowhere near it.
 */
function collapseCondition(
  state: ChatState,
  profile: CharacterProfile,
  clockMinutes: number,
  calendarStart: CalendarStart,
): ActiveCondition | null {
  const reserve = state.meters[SLEEP_RESERVE_METER_ID];
  if (reserve === undefined || state.lastSleepEndedAtMinutes === null) return null;
  if (state.conditions.some((condition) => isAsleepCondition(condition) && condition.startedAtMinutes <= clockMinutes)) {
    return null;
  }
  const { read } = deriveChatEnergyRead(reserve, {
    clockMinutes,
    calendarStart,
    schedule: profile.schedule,
    lastSleepEndedAtMinutes: state.lastSleepEndedAtMinutes,
    conditions: state.conditions,
  });
  if (read.signedFixedPoint > -METER_FIXED_POINT_ONE) return null;
  return {
    // Deterministic, so re-reading the same interval projects the same condition.
    id: `collapse-${clockMinutes}`,
    label: CHAT_ASLEEP_CONDITION_LABEL,
    startedAtMinutes: clockMinutes,
    durationMinutes: CHAT_COLLAPSE_SLEEP_MINUTES,
    attributeEffects: [],
    promptHint: "Asleep: exhaustion finally won — dead to the world where they dropped; only something real rouses them.",
  };
}

/**
 * Catch a character's state up to the shared story clock. PURE. Their meters
 * integrate from the minute they hold at (`metersAtMinutes`) to `clockMinutes`
 * — cut wherever a condition begins or ends, so time asleep holds and restores
 * the energy reserve — and are re-stamped there; real sleep that ended inside
 * the interval updates `lastSleepEndedAtMinutes`; a character whose energy read
 * has hit its floor collapses into sleep; and conditions past the clock expire
 * (after their interval has been integrated, so an `asleep` condition read
 * after it ended still credits its sleep exactly once). Physiology is
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
  options: { clockMinutes: number; calendarStart: CalendarStart },
): ChatState {
  const { clockMinutes, calendarStart } = options;
  // Conditions expire against the SHARED story clock — one timeline for the roster.
  const live = state.conditions.filter((c) => !isConditionExpired(c, clockMinutes));
  const stamp = state.metersAtMinutes ?? clockMinutes;
  if (stamp >= clockMinutes) {
    if (state.metersAtMinutes !== null && live.length === state.conditions.length) return state;
    return { ...state, conditions: live, metersAtMinutes: state.metersAtMinutes ?? clockMinutes };
  }
  const fromMinutes = Math.max(stamp, clockMinutes - CHAT_METER_CATCH_UP_MAX_MINUTES);
  const body = integrateAcrossConditions(state, profile, fromMinutes, clockMinutes);
  const caughtUp: ChatState = { ...state, ...body, metersAtMinutes: clockMinutes, conditions: live };
  const collapse = collapseCondition(caughtUp, profile, clockMinutes, calendarStart);
  return collapse === null ? caughtUp : { ...caughtUp, conditions: [...live, collapse] };
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
  const caughtUp = driftChatState(state, profile, { clockMinutes, calendarStart });
  return caughtUp.presence === "present"
    ? applyTimeSkip(caughtUp, amount, clockMinutes, profile, calendarStart)
    : caughtUp;
}
