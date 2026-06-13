import { DAYLIGHT_BAND_START_MINUTES } from "@/lib/clock";

/**
 * Deterministic pre-turn intent detection (docs/turn-engine.md §Pre-turn).
 * Regex-based and case-insensitive; targets resolve against participant
 * display names and in-scope item names. Overlapping names match longest-first
 * ("Maya Brennan" beats "Maya"); among distinct names the one nearest after
 * the verb wins. Text inside double quotes (spoken dialogue) is ignored so
 * 'she said "look at Maya"' never triggers physical intents.
 */

export interface SceneIntent {
  /** Participant display name the player is looking at / studying. */
  lookTarget?: string;
  /** Participant display name the player is touching. */
  touchTarget?: string;
  /** Participant display name the player is smelling. */
  smellTarget?: string;
  /** In-scope item name the player is examining / handling. */
  examineItem?: string;
  /** Raw location phrase after an enter/move verb (resolver grounds it). */
  enterLocation?: string;
}

const LOOK_RE =
  /\b(?:look(?:s|ed|ing)? (?:at|over|down at|up at)|examin(?:e|es|ed|ing)|stud(?:y|ies|ied|ying)|gaz(?:e|es|ed|ing) at|glanc(?:e|es|ed|ing) (?:at|down at|over)|star(?:e|es|ed|ing) at|peek(?:s|ed|ing)? at|watch(?:es|ed|ing)?|inspect(?:s|ed|ing)?|check(?:s|ed|ing)?(?: out| on)?|take[sn]? a (?:look|peek) at)\b/;

const TOUCH_RE =
  /\b(?:touch(?:es|ed|ing)?|feel(?:s|ing)?|felt|stroke(?:s|d|ing)?|caress(?:es|ed|ing)?|brush(?:es|ed|ing)? against|squeeze(?:s|d|zing)?|grab(?:s|bed|bing)?|hold(?:s|ing)?|held|run(?:s|ning)? (?:a|my|your|his|her|their) (?:hand|fingers|palm)|hug(?:s|ged|ging)?|embrace(?:s|d|ing)?)\b/;

const SMELL_RE =
  /\b(?:smell(?:s|ed|ing)?|sniff(?:s|ed|ing)?|inhal(?:e|es|ed|ing)|scent of|breath(?:e|es|ed|ing) in|nose (?:against|in|to))\b/;

const EXAMINE_RE =
  /\b(?:examin(?:e|es|ed|ing)|inspect(?:s|ed|ing)?|check(?:s|ed|ing)?|read(?:s|ing)?|open(?:s|ed|ing)?|pick(?:s|ed|ing)? up|look(?:s|ed|ing)? (?:at|inside|into|through))\b/;

const ENTER_RE =
  /\b(?:enter(?:s|ed|ing)?|go(?:es|ing)? (?:back )?(?:in)?to|went (?:back )?(?:in)?to|step(?:s|ped|ping)? (?:in)?to|walk(?:s|ed|ing)? (?:back )?(?:in)?to|head(?:s|ed|ing)? (?:back )?(?:in)?to|mov(?:e|es|ed|ing) (?:in)?to|arriv(?:e|es|ed|ing) (?:at|in)|return(?:s|ed|ing)? to)\s+(?:the\s+|a\s+|an\s+|my\s+|your\s+|his\s+|her\s+|their\s+)?([a-z][a-z0-9' -]{1,48}?)(?=[.,;:!?\n]|$| and | then | to )/;

/** Strip straight and curly double-quoted spans so spoken text never matches. */
function stripQuoted(input: string): string {
  return input.replace(/"[^"\n]*(?:"|$)|“[^”\n]*(?:”|$)/g, (span) => " ".repeat(span.length));
}

function escapeRe(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Earliest whole-word occurrence of any known name at/after fromIndex
 * (falling back to anywhere). Candidates are tried longest-first so an
 * occurrence of "Maya Brennan" wins over "Maya" at the same position.
 */
function findName(lower: string, names: readonly string[], fromIndex: number): string | undefined {
  const ordered = [...names].filter((n) => n.trim().length > 0).sort((a, b) => b.length - a.length);
  let best: { name: string; index: number } | undefined;
  for (const name of ordered) {
    const re = new RegExp(`(?:^|[^a-z0-9])(${escapeRe(name.toLowerCase())})(?:[^a-z0-9]|$)`, "g");
    let m: RegExpExecArray | null;
    while ((m = re.exec(lower)) !== null) {
      const index = m.index + m[0].indexOf(m[1] ?? "");
      if (best === undefined || index < best.index) best = { name, index };
      if (re.lastIndex === m.index) re.lastIndex++;
    }
  }
  if (!best) return undefined;
  if (best.index >= fromIndex) return best.name;

  // A name exists, but only before the verb: prefer one after it if any.
  let after: { name: string; index: number } | undefined;
  for (const name of ordered) {
    const re = new RegExp(`(?:^|[^a-z0-9])(${escapeRe(name.toLowerCase())})(?:[^a-z0-9]|$)`, "g");
    let m: RegExpExecArray | null;
    while ((m = re.exec(lower)) !== null) {
      const index = m.index + m[0].indexOf(m[1] ?? "");
      if (index >= fromIndex && (after === undefined || index < after.index)) after = { name, index };
      if (re.lastIndex === m.index) re.lastIndex++;
    }
  }
  return (after ?? best).name;
}

function targetAfter(lower: string, verb: RegExp, names: readonly string[]): string | undefined {
  const m = verb.exec(lower);
  if (!m) return undefined;
  return findName(lower, names, m.index + m[0].length);
}

// ---------------------------------------------------------------------------
// Declared rest (docs/developer-notes/time-and-travel-spec.phase3.md, decision 38)
// ---------------------------------------------------------------------------

export interface DeclaredRest {
  activity: "sleep" | "wait";
  /** Endpoint as minute-of-day (0–1439); null when an explicit duration was stated. */
  untilMinute: number | null;
  /** Ambiguous 12-hour endpoints ("until 7"): the +12h alternative — the resolver picks the sooner. */
  untilMinuteAlt: number | null;
  /** Explicit duration in minutes ("sleep for 2 hours"); null when an endpoint is used. */
  durationMinutes: number | null;
  /** Human label for the persisted clock cause ("morning", "7:30pm", "2 hours"). */
  label: string;
}

/** "I can't sleep", "I won't go to bed" — stated refusal is not a rest intent. */
const REST_NEGATION_RE =
  /\b(?:can(?:no|')?t|cannot|couldn'?t|won'?t|wouldn'?t|don'?t|do not|shouldn'?t|not)\s+(?:going\s+to\s+|go(?:ing)?\s+(?:back\s+)?to\s+|fall(?:ing)?\s+a?)?(?:sleep|bed)\b/;

const SLEEP_RE =
  /\b(?:go(?:es|ing)?|went|head(?:s|ed|ing)?|get(?:s|ting)?|crawl(?:s|ed|ing)?|climb(?:s|ed|ing)?)\s+(?:back\s+)?(?:in)?to\s+(?:bed|sleep)\b|\b(?:fall(?:s|ing)?|fell|drift(?:s|ed|ing)?)\s+(?:back\s+)?asleep\b|\bturn(?:s|ed|ing)?\s+in\s+for\s+the\s+night\b|\bcall(?:s|ed|ing)?\s+it\s+a\s+night\b|\bget(?:s|ting)?\s+some\s+(?:sleep|shut-?eye)\b|\bsleep(?:s)?\b(?!\s+with\b)/;

/** Bare "wait" never fast-forwards; it needs an until/till/for connector with a parseable time. */
const WAIT_CONNECTOR_RE = /\bwait(?:s|ed|ing)?\s+(?:until|till|'?til|for)\b/;

/** Text following the endpoint connector — fed to parseRestTarget. */
const UNTIL_TARGET_RE = /\b(?:until|till|'?til|for)\s+(.{1,40})/;

/** Daylight-band and fixed anchors a wake time can name (clock.ts owns band starts). */
const TIME_WORDS: ReadonlyArray<{ word: string; minute: number; label: string }> = [
  { word: "morning", minute: DAYLIGHT_BAND_START_MINUTES.dawn, label: "morning" },
  { word: "dawn", minute: DAYLIGHT_BAND_START_MINUTES.dawn, label: "dawn" },
  { word: "daybreak", minute: DAYLIGHT_BAND_START_MINUTES.dawn, label: "daybreak" },
  { word: "sunrise", minute: DAYLIGHT_BAND_START_MINUTES.dawn, label: "sunrise" },
  { word: "evening", minute: DAYLIGHT_BAND_START_MINUTES.dusk, label: "evening" },
  { word: "dusk", minute: DAYLIGHT_BAND_START_MINUTES.dusk, label: "dusk" },
  { word: "sunset", minute: DAYLIGHT_BAND_START_MINUTES.dusk, label: "sunset" },
  { word: "sundown", minute: DAYLIGHT_BAND_START_MINUTES.dusk, label: "sundown" },
  { word: "nightfall", minute: DAYLIGHT_BAND_START_MINUTES.night, label: "nightfall" },
  { word: "night", minute: DAYLIGHT_BAND_START_MINUTES.night, label: "night" },
  { word: "noon", minute: 720, label: "noon" },
  { word: "midday", minute: 720, label: "midday" },
  { word: "midnight", minute: 0, label: "midnight" },
];

const DURATION_RE = /^(\d{1,3}|a|an|half an?)\s*(hours?|hrs?|minutes?|mins?)\b/;
const CLOCK_RE = /^(\d{1,2})(?::(\d{2}))?\s*(a\.?m\.?|p\.?m\.?)?/;

type RestTarget = Pick<DeclaredRest, "untilMinute" | "untilMinuteAlt" | "durationMinutes" | "label">;

function parseRestTarget(raw: string): RestTarget | null {
  const text = raw.trim().replace(/^(?:the|next|early|tomorrow)\s+/g, "");

  for (const entry of TIME_WORDS) {
    if (new RegExp(`^${entry.word}\\b`).test(text)) {
      return { untilMinute: entry.minute, untilMinuteAlt: null, durationMinutes: null, label: entry.label };
    }
  }

  // Durations before clock times so "2 hours" never reads as 2 o'clock.
  const dur = DURATION_RE.exec(text);
  if (dur) {
    const quantity = dur[1] === "a" || dur[1] === "an" ? 1 : dur[1]?.startsWith("half") ? 0.5 : Number(dur[1]);
    const unitMinutes = dur[2]?.startsWith("h") ? 60 : 1;
    const minutes = Math.round(quantity * unitMinutes);
    if (minutes >= 1) return { untilMinute: null, untilMinuteAlt: null, durationMinutes: minutes, label: dur[0].trim() };
    return null;
  }

  const clock = CLOCK_RE.exec(text);
  if (clock) {
    const hour = Number(clock[1]);
    const minute = clock[2] !== undefined ? Number(clock[2]) : 0;
    if (hour > 23 || minute > 59) return null;
    const meridiem = clock[3]?.startsWith("p") ? "pm" : clock[3]?.startsWith("a") ? "am" : null;
    const mm = String(minute).padStart(2, "0");
    if (meridiem) {
      const h24 = (hour % 12) + (meridiem === "pm" ? 12 : 0);
      const h12 = hour % 12 === 0 ? 12 : hour % 12;
      return { untilMinute: h24 * 60 + minute, untilMinuteAlt: null, durationMinutes: null, label: `${h12}:${mm}${meridiem}` };
    }
    if (hour === 0 || hour >= 13) {
      return { untilMinute: hour * 60 + minute, untilMinuteAlt: null, durationMinutes: null, label: `${String(hour).padStart(2, "0")}:${mm}` };
    }
    // "until 7" — am or pm unstated: keep both; the resolver takes whichever comes first.
    return {
      untilMinute: hour * 60 + minute,
      untilMinuteAlt: (hour + 12) * 60 + minute,
      durationMinutes: null,
      label: `${hour}:${mm}`,
    };
  }

  return null;
}

/**
 * Declared rest (phase-2-plan T7): "I sleep", "I go to bed", "I sleep until
 * morning", "I wait until evening" resolve to a fast-forward with a
 * schedule-aware endpoint. Deterministic — keyword/registry, no LLM. Sleep
 * without an endpoint defaults to morning (the next dawn band start); waiting
 * requires a parseable time or it is not a rest ("I wait for Mara" isn't).
 * Registered actions (nap, …) are a different seam and keep their own minutes.
 */
export function detectDeclaredRest(input: string): DeclaredRest | null {
  const lower = stripQuoted(input).toLowerCase();
  if (REST_NEGATION_RE.test(lower)) return null;
  const sleeps = SLEEP_RE.test(lower);
  const waits = WAIT_CONNECTOR_RE.test(lower);
  if (!sleeps && !waits) return null;

  // "turn in for the night" names a span, not a 20:00 endpoint — strip the
  // idiom so sleep falls through to its morning default.
  const targetSource = lower.replace(/\bfor\s+the\s+(?:rest\s+of\s+the\s+)?night\b/g, " ");
  const targetText = UNTIL_TARGET_RE.exec(targetSource)?.[1];
  const target = targetText !== undefined ? parseRestTarget(targetText) : null;
  if (target) return { activity: sleeps ? "sleep" : "wait", ...target };
  if (!sleeps) return null;
  return {
    activity: "sleep",
    untilMinute: DAYLIGHT_BAND_START_MINUTES.dawn,
    untilMinuteAlt: null,
    durationMinutes: null,
    label: "morning",
  };
}

/**
 * Rest duration from the current minute of day, wrapping past midnight
 * ("until morning" at 23:00 → 360 min; at 03:00 → 120). Resting until the
 * minute you are already at means a full day; the merge clamps to
 * REST_CLAMP_MINUTES regardless. The cause string persists as the turn's
 * clock cause ("slept until morning").
 */
export function declaredRestMinutes(rest: DeclaredRest, currentMinuteOfDay: number): { minutes: number; cause: string } {
  const verb = rest.activity === "sleep" ? "slept" : "waited";
  if (rest.durationMinutes !== null) {
    return { minutes: Math.max(1, Math.round(rest.durationMinutes)), cause: `${verb} for ${rest.label}` };
  }
  const wrap = (target: number) => {
    const diff = (((target - currentMinuteOfDay) % 1440) + 1440) % 1440;
    return diff === 0 ? 1440 : diff;
  };
  let minutes = wrap(rest.untilMinute ?? DAYLIGHT_BAND_START_MINUTES.dawn);
  if (rest.untilMinuteAlt !== null) minutes = Math.min(minutes, wrap(rest.untilMinuteAlt));
  return { minutes, cause: `${verb} until ${rest.label}` };
}

// ---------------------------------------------------------------------------
// Comms intent (presence-and-perception-spec.phase3.md §comms)
// ---------------------------------------------------------------------------

export interface CommsIntent {
  kind: "call" | "text";
  /** Display name of the NPC the player is calling/texting. */
  targetName: string;
}

/**
 * "I call/phone/ring/dial X" — a voice link. Text verbs route to "text".
 * "call out (to)" / "call for" are in-room shouts, not phone calls — excluded
 * via a negative lookahead so "I call out to Maya" never stages a comms link.
 */
const CALL_RE =
  /\b(?:call(?:s|ed|ing)?(?!\s+(?:out|for)\b)|phon(?:e|es|ed|ing)|ring(?:s|ing)?|rang|dial(?:s|ed|ing)?|video[- ]?call(?:s|ed|ing)?|facetime(?:s|d|ing)?)\b/;

/** "I text/message/dm/email/write to X" — a written link. */
const TEXT_RE =
  /\b(?:text(?:s|ed|ing)?|messag(?:e|es|ed|ing)|dm(?:s|ed|ing)?|email(?:s|ed|ing)?|write(?:s)? to|writes? a (?:text|message) to|send(?:s)? (?:a )?(?:text|message|note) to)\b/;

/**
 * Comms intent (presence-and-perception-spec.phase3.md §comms): "I call Mara",
 * "I text Rhett". Deterministic — regex + name match, like the rest of intent
 * detection; quoted speech is stripped first so a quoted "call Mara" is inert.
 * Call verbs win over text verbs when both match (a video call is still a call).
 * The pipeline stages the named NPC as comms-present for this turn so the
 * narrator may voice them; the simulant persists the link post-turn.
 */
export function detectCommsIntent(input: string, npcNames: readonly string[]): CommsIntent | null {
  const lower = stripQuoted(input).toLowerCase();
  const call = CALL_RE.exec(lower);
  const text = TEXT_RE.exec(lower);
  // The earlier verb (and call over text on a tie) decides the channel kind.
  const callFirst = call !== null && (text === null || call.index <= text.index);
  const verbMatch = callFirst ? call : text;
  if (!verbMatch) return null;
  const targetName = findName(lower, npcNames, verbMatch.index + verbMatch[0].length);
  if (!targetName) return null;
  return { kind: callFirst ? "call" : "text", targetName };
}

/**
 * Out-of-character input: the player is asking the game, not acting. Matches
 * a leading OOC marker — "(OOC: …)", "[ooc] …", "OOC: …" — never mid-text
 * mentions, so in-world prose about "the OOC channel" can't trigger it.
 */
const OOC_RE = /^\s*[([]?\s*ooc\b\s*[:\])]/i;

export function isOocInput(input: string): boolean {
  return OOC_RE.test(input);
}

export function detectIntent(input: string, npcNames: string[], itemNames: string[]): SceneIntent {
  const lower = stripQuoted(input).toLowerCase();
  const intent: SceneIntent = {};

  const look = targetAfter(lower, LOOK_RE, npcNames);
  if (look) intent.lookTarget = look;

  const touch = targetAfter(lower, TOUCH_RE, npcNames);
  if (touch) intent.touchTarget = touch;

  const smell = targetAfter(lower, SMELL_RE, npcNames);
  if (smell) intent.smellTarget = smell;

  const examine = targetAfter(lower, LOOK_RE, itemNames) ?? targetAfter(lower, EXAMINE_RE, itemNames);
  if (examine) intent.examineItem = examine;

  const enter = ENTER_RE.exec(lower);
  const place = enter?.[1]?.trim();
  if (place) intent.enterLocation = place;

  return intent;
}
