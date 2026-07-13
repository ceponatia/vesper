/**
 * Pre-turn intent cue for character chat (character-chat-state-narration.spec.md §7).
 *
 * Chat has no pre-narrator agent; this is a cheap, regex-first read of the player's input
 * (mirroring `engine/intent.ts`) that raises a ONE-TURN hint when the beat invites an
 * opportunistic cue — the player drawing close, making contact, turning the moment
 * intimate, or putting their attention on the character's appearance
 * (chat-narrator-pov.plan.md). The narrator already carries an opportunistic-cue rule; this just tells it
 * *this* is a turn where a sensory detail or a state beat can land, so cues fire when the
 * beat earns it rather than whenever a band merely allows it. It must NOT persist into chat
 * history, and adds no model call. A blank/OOC input ⇒ no hint ⇒ today's behavior.
 *
 * It also carries the sibling one-turn reads that share this "cheap regex over the turn"
 * spirit: scene-movement detection (chat scene memory), sense-targeted focus (the sensory
 * assembly), and the reply-discipline gates (hook cadence + intimate check-in over the last
 * assistant replies).
 */

import { parseMessageSpans } from "@/lib/message-spans";

export interface ChatCueHint {
  /** The player drew close / approached / reached toward the character. */
  proximity: boolean;
  /** The player made physical contact (touch / hold / embrace). */
  touch: boolean;
  /** The beat turned intimate (kiss / taste / undress / explicit). */
  intimate: boolean;
  /**
   * The player's attention is on the character's appearance — a look-over, a stare,
   * a compliment, a mention of a feature or what they're wearing (chat-narrator-pov.plan.md).
   * Unlike the three above this is NOT proximity-gated: sight carries at any distance.
   */
  attention: boolean;
}

const PROXIMITY_RE =
  /\b(?:lean(?:s|ed|ing)?(?: in| close(?:r)?| toward)?|step(?:s|ped|ping)? (?:close|closer|toward|in)|move(?:s|d)? (?:close|closer|in|toward)|draw(?:s|n|ing)? (?:close|near)|drew (?:close|near)|come(?:s)? closer|slide(?:s|d)? (?:up |in )?(?:beside|next to|close)|press(?:es|ed)? (?:close|against)|sit(?:s|ting)? (?:beside|next to|close)|close the (?:distance|gap)|right up (?:to|against)|inches from)\b/i;

const TOUCH_RE =
  /\b(?:touch(?:es|ed|ing)?|brush(?:es|ed|ing)?(?: against)?|stroke(?:s|d|ing)?|caress(?:es|ed|ing)?|hold(?:s|ing)?|held|hug(?:s|ged|ging)?|embrace(?:s|d|ing)?|take[sn]? (?:your|her|his|their|my) hand|took (?:your|her|his|their|my) hand|grab(?:s|bed|bing)?|squeeze(?:s|d|zing)?|run(?:s|ning)? (?:a |my |your |his |her |their )?(?:hand|fingers|palm)|rest(?:s|ed)? (?:a |my |your |his |her |their )?hand|pull(?:s|ed)? (?:you|her|him|them) (?:close|in)|wrap(?:s|ped)? (?:an? )?arm)\b/i;

// Appearance-directed attention: a gaze verb aimed at a person, an appearance
// compliment, or a possessive + body/clothing noun ("your hair", "her legs"). The
// gaze verbs require a person object so "I glance at the clock" stays silent; the
// possessive arm deliberately excludes "my" (the player's own body isn't the
// character's appearance). A false positive costs only an unused one-turn invite.
const ATTENTION_RE =
  /\b(?:look(?:s|ed|ing)? (?:you|her|him|them) (?:up and down|over)|look(?:s|ed|ing)? (?:at|over) (?:you|her|him|them)\b|watch(?:es|ed|ing)? (?:you|her|him|them)\b|star(?:e|es|ed|ing) at (?:you|her|him|them)\b|gaz(?:e|es|ed|ing) at (?:you|her|him|them)\b|glanc(?:e|es|ed|ing) (?:at|over) (?:you|her|him|them)\b|check(?:s|ed|ing)? (?:you|her|him|them) out|siz(?:e|es|ed|ing) (?:you|her|him|them) up|drink(?:s|ing)? (?:you|her|him|them) in|admir(?:e|es|ed|ing) (?:you|her|him|them)\b|(?:my|his|her|their) eyes (?:linger|trace|travel|wander|drift|rake|roam)|can't (?:stop|help) (?:looking|staring)|you look (?:beautiful|gorgeous|stunning|amazing|incredible|lovely|radiant|hot|great|good|nice)|looks? (?:good|great|amazing|stunning|beautiful|gorgeous|incredible|nice|perfect) on you|(?:your|her|his|their) (?:hair|eyes|lips|smile|face|cheeks?|neck|shoulders?|arms?|chest|waist|hips?|thighs?|legs?|feet|ankles?|figure|curves?|skin|dress|skirt|blouse|neckline|outfit|heels|stockings?)\b)/i;

const INTIMATE_RE =
  /\b(?:kiss(?:es|ed|ing)?|taste(?:s|d)?|tasting|lick(?:s|ed|ing)?|nibble(?:s|d|ing)?|undress(?:es|ed|ing)?|strip(?:s|ped|ping)?|naked|bare(?:s|d)? (?:skin|chest|body)?|slip(?:s|ped)? (?:off|out of)|pull(?:s|ed)? off (?:your|her|his|their|my)|bite(?:s)? (?:your|her|his|their) (?:lip|neck)|breath(?:e|es)? against|mouth(?:es|ed)? (?:at|on))\b/i;

export function detectChatCue(input: string): ChatCueHint {
  const text = input ?? "";
  return {
    proximity: PROXIMITY_RE.test(text),
    touch: TOUCH_RE.test(text),
    intimate: INTIMATE_RE.test(text),
    attention: ATTENTION_RE.test(text),
  };
}

/**
 * The deterministic per-turn sensory allowance (narrator-prompt-consolidation.plan.md
 * slice 4) — the chat-lane analogue of the session's exposure mask (`exposureRules`,
 * prompts/narrative.ts): ONE binding per-turn statement of what person-level sensory /
 * appearance detail may land, instead of four scattered "one cue, earned" teachings.
 * - `focused_description` — a sense-targeted beat (`detectSensoryFocus` fired); the
 *   Sensory-focus block carries the grant.
 * - `close_range_hook` — the beat closes distance or turns intimate (cue arms that
 *   used to trigger old rule 11 / the cue-invite line).
 * - `visual_accent` — the player's attention is on the character's appearance (the
 *   old rule 12 attention arm; sight carries at any distance).
 * - `none` — an ordinary distant exchange: no person-level sensory detail is earned.
 */
export type ChatSensoryAllowance = "none" | "visual_accent" | "close_range_hook" | "focused_description";

/**
 * Map the turn's existing detector reads to the allowance — pure, no new signal:
 * this only centralizes the decision the prompt used to restate as prose in four
 * places. Arousal alone deliberately does NOT raise the allowance (a distant
 * conversation stays distant however keyed-up the character is).
 */
export function deriveChatSensoryAllowance(args: {
  cue: ChatCueHint | null;
  sensoryFocus: SensoryFocusHint | null;
}): ChatSensoryAllowance {
  if (args.sensoryFocus) return "focused_description";
  if (args.cue?.intimate || args.cue?.touch || args.cue?.proximity) return "close_range_hook";
  if (args.cue?.attention) return "visual_accent";
  return "none";
}

/**
 * Render the one-turn cue invitation line for the prompt (most-charged signal wins:
 * intimate > touch > proximity > attention), or "" when the input invites nothing. The
 * route passes the rendered string to the prompt builder, so the builder stays a pure
 * function over a plain string. Each arm is worded as sensation ARRIVING in the
 * player's senses, never as the character's property (chat-narrator-pov.plan.md).
 *
 * RETIRED from the live pipeline by narrator-prompt-consolidation slice 4 (2026-07-10):
 * the deterministic `deriveChatSensoryAllowance` line supersedes these sensory arms.
 * Kept (with its tests) for rollback — restoring the pipeline's old
 * `chatCueInviteLine(cueHint, name)` arm re-enables it.
 */
export function chatCueInviteLine(cue: ChatCueHint, name: string): string {
  if (cue.intimate) {
    return `This turn the moment is turning intimate — a sensory detail (scent, warmth, taste, the catch of ${name}'s breath) or a visible shift in ${name}'s state can land now, written as it reaches the player's senses. Weave at most one into the action; never list it.`;
  }
  if (cue.touch) {
    return `The player has just made contact — closeness like this is a moment a single sensory cue (warmth, scent, texture) can register in the player's own senses. Use one only if ${name} has it, woven into a gesture; never list it.`;
  }
  if (cue.proximity) {
    return `The player has drawn close — if ${name} has a sensory cue (scent, the sound of their voice), this is when it might reach them. One at most, woven into action, never announced.`;
  }
  if (cue.attention) {
    return `The player's attention is on ${name}'s appearance — this is a turn where one concrete visual detail (drawn from ${name}'s attributes and what ${name} is wearing) lands well, woven into ${name}'s reaction and seen from the player's eye. One detail at most; never a head-to-toe description.`;
  }
  return "";
}

// ---------------------------------------------------------------------------
// Scene movement (chat scene memory): switch `current` before the prompt builds
// ---------------------------------------------------------------------------

/** Movement verbs that can carry a destination ("head to the kitchen", "follow her outside"). */
const MOVE_VERB =
  "(?:go(?:es|ing)?|went|head(?:s|ing|ed)?|walk(?:s|ing|ed)?|move(?:s|d|ing)?|follow(?:s|ing|ed)?|lead(?:s|ing)?|led|step(?:s|ping|ped)?|slip(?:s|ping|ped)?|wander(?:s|ing|ed)?|retreat(?:s|ing|ed)?|comes?|came|drive(?:s)?|drove|run(?:s|ning)?|ran|takes?|took|brings?|brought|carr(?:y|ies|ied)|makes? (?:our|your|my) way|made (?:our|your|my) way)";
/** Prepositions that introduce a movement destination. */
const DEST_PREP = "(?:in ?to|to|toward|towards|onto|out to|over to|back to|down to|up to|through to)";

/**
 * A movement verb → preposition → a `the/a/…` + up-to-3-word place noun ("head to the
 * living room", "follow her into the kitchen"). The article requirement keeps
 * "want to talk" / "listen to the radio" from misfiring as movement.
 */
const MOVE_DEST_RE = new RegExp(
  `\\b${MOVE_VERB}\\b[^.?!,;:]*?\\b${DEST_PREP}\\s+(?:the|a|an|his|her|their|your|my|our)\\s+([a-z][a-z'’-]+(?:\\s+[a-z][a-z'’-]+){0,2})\\b`,
  "i",
);
/** A movement verb followed by an adverbial destination ("we head outside", "let's go upstairs"). */
const MOVE_BARE_RE = new RegExp(
  `\\b${MOVE_VERB}\\b[^.?!,;:]*?\\b(outside|inside|indoors|outdoors|upstairs|downstairs|out back|out front)\\b`,
  "i",
);

/**
 * Deterministic movement/arrival read of the player's input (chat scene memory): the
 * destination place ("kitchen", "outside", "back garden") the beat moves the scene to, or
 * null. Regex-first and pure like `detectChatCue`; the route feeds the result to
 * `switchScenePlace` BEFORE the prompt builds so this turn's Scene injection is right. A
 * false positive only mints a stub place the archivist then reconciles — a soft error.
 */
export function detectSceneMovement(input: string): string | null {
  const text = input ?? "";
  const dest = MOVE_DEST_RE.exec(text)?.[1] ?? MOVE_BARE_RE.exec(text)?.[1];
  if (!dest) return null;
  return dest.trim().replace(/\s+/g, " ").toLowerCase();
}

// ---------------------------------------------------------------------------
// Sense-targeted focus (scope guard): smell/taste/touch/study × a body region/garment
// ---------------------------------------------------------------------------

/** Which sense the player's beat brings to bear. */
export type SensoryFocusSense = "smell" | "taste" | "touch" | "study";

export interface SensoryFocusHint {
  sense: SensoryFocusSense;
  /** The matched body-region / garment noun, as written (lowercased). */
  target: string;
  /** Whether the target is intimate anatomy (gates the intimate-attribute surfacing). */
  intimate: boolean;
  /**
   * The body-registry term the target resolves to — the prompt builder joins it to the
   * region's own authored attributes via `expandBodyTarget` (sensory-grounding.plan.md),
   * so "foot" surfaces `feet.smell`, not just the generic scent baseline. Absent for
   * garment targets (a dress has no anatomy to expand) and unmapped colloquialisms.
   */
  region?: string;
}

const SMELL_RE =
  /\b(?:smell(?:s|ing|ed)?|sniff(?:s|ing|ed)?|inhal(?:e|es|ing|ed)|breathe(?:s)? (?:in|deep)|breathing (?:in|deep)|(?:the )?scent of|nose(?:s)? (?:at|against))\b/i;
const TASTE_RE =
  /\b(?:taste(?:s|d)?|tasting|lick(?:s|ing|ed)?|(?:my|your|her|his|their) tongue|tongue(?:s|d)? (?:at|against|over|along)|mouth(?:s|ed)? (?:at|on))\b/i;
const TOUCH_FOCUS_RE =
  /\b(?:touch(?:es|ing|ed)?|feel(?:s|ing)?|felt|stroke(?:s|d|ing)?|caress(?:es|ed|ing)?|trace(?:s|d)?|tracing|cup(?:s|ped|ping)?|grips?|gripp(?:ed|ing)|grope(?:s|d|ing)?|squeeze(?:s|d|zing)?|fondle(?:s|d|ing)?|palm(?:s|ed|ing)?|graze(?:s|d)?|run(?:s|ning)? (?:a |my |your |her |his |their )?(?:hand|fingers|palm|fingertips|thumb))\b/i;
const STUDY_RE =
  /\b(?:study(?:ing|ies)?|studied|examine(?:s|d)?|examining|inspect(?:s|ing|ed)?|scrutiniz(?:e|es|ed|ing)|look(?:s|ing|ed)? (?:closely|over)|takes? in|taking in|drink(?:s|ing)? in|drank in)\b/i;

// The target noun is the CHARACTER's body/garment, never the actor's own hand doing the
// touching — the two negative lookbehinds drop a noun owned by "my"/"our" so "run my
// fingers along your collarbone" targets the collarbone, not the fingers.
const NOT_ACTOR = "(?<!\\bmy )(?<!\\bour )";
/** Intimate anatomy nouns — a match sets `intimate`, gating the intimate-attribute surfacing. */
const INTIMATE_TARGET_RE = new RegExp(
  `${NOT_ACTOR}\\b(breasts?|nipples?|cleavage|vulva|pussy|cunt|clit(?:oris)?|labia|folds|penis|cock|dick|shaft|balls|testicles?|groin|crotch|anus|ass|arse|buttocks?|butt|rear|panties|thong|lingerie)\\b`,
  "i",
);
/** Everyday body-region + garment nouns the sense can land on. */
const BODY_TARGET_RE = new RegExp(
  `${NOT_ACTOR}\\b(hair|neck|throat|nape|collarbones?|shoulders?|skin|cheeks?|jaw|chin|forehead|temples?|ears?|eyes?|nose|lips?|mouth|wrists?|hands?|palms?|fingers?|knuckles?|forearms?|arms?|chest|waist|midriff|tummy|abdomen|hips?|thighs?|legs?|knees?|calves|calf|ankles?|feet|foot|soles?|heels?|toes?|back|spine|tail|wings?|horns?|stomach|belly|navel|face|dress|skirt|blouse|shirt|sweater|collar|neckline|sleeves?|stockings?|lace|hem|bodice|corset|bra|scarf|coat|jacket)\\b`,
  "i",
);

/**
 * Colloquial intimate noun → the body-registry region it names, for the hint's `region`.
 * Intimate garments (panties, thong) map to the region they cover — a sense brought to
 * them is colloquially about that region's senses; `lingerie` stays garment-only.
 */
const INTIMATE_REGION_BY_NOUN: Readonly<Record<string, string>> = {
  breast: "breasts",
  breasts: "breasts",
  nipple: "nipples",
  nipples: "nipples",
  cleavage: "breasts",
  vulva: "vulva",
  pussy: "vulva",
  cunt: "vulva",
  folds: "vulva",
  labia: "vulva",
  clit: "clitoris",
  clitoris: "clitoris",
  penis: "penis",
  cock: "penis",
  dick: "penis",
  shaft: "penis",
  balls: "testicles",
  testicle: "testicles",
  testicles: "testicles",
  groin: "groin",
  crotch: "groin",
  anus: "anus",
  ass: "buttocks",
  arse: "buttocks",
  butt: "buttocks",
  buttock: "buttocks",
  buttocks: "buttocks",
  rear: "buttocks",
  panties: "groin",
  thong: "groin",
};

/**
 * Everyday nouns that are NOT registry terms themselves → the registry term whose
 * attributes they colloquially read from ("throat" → neck, "sole" → feet). Nouns
 * absent here pass through as-is — `expandBodyTarget` resolves registry ids, labels,
 * singulars, and its own colloquial map ("mouth", "figure").
 */
const EVERYDAY_REGION_BY_NOUN: Readonly<Record<string, string>> = {
  throat: "neck",
  nape: "neck",
  collarbone: "shoulders",
  collarbones: "shoulders",
  cheek: "face",
  cheeks: "face",
  jaw: "face",
  chin: "face",
  forehead: "face",
  temple: "face",
  temples: "face",
  knuckle: "fingers",
  knuckles: "fingers",
  palm: "hands",
  palms: "hands",
  spine: "back",
  stomach: "waist",
  belly: "waist",
  navel: "waist",
  tummy: "waist",
  midriff: "waist",
  abdomen: "waist",
  sole: "feet",
  soles: "feet",
  heel: "feet",
  heels: "feet",
  knee: "legs",
  knees: "legs",
};

/** Garment nouns — no anatomy to expand, so the hint carries no `region`. */
const GARMENT_NOUNS: ReadonlySet<string> = new Set([
  "dress",
  "skirt",
  "blouse",
  "shirt",
  "sweater",
  "collar",
  "neckline",
  "sleeve",
  "sleeves",
  "stocking",
  "stockings",
  "lace",
  "hem",
  "bodice",
  "corset",
  "bra",
  "scarf",
  "coat",
  "jacket",
  "lingerie",
]);

/**
 * Detect a sense-targeted beat in the player's input (scope guard): a smell/taste/touch/study
 * verb aimed at a specific body region or garment. Returns the sense + the matched target
 * (intimate-flagged, region-resolved) or null when there is no verb-and-target pair — the
 * block is deliberately sense×TARGET, so a bare "I feel nervous" never fires. Regex-first and
 * pure; the builder joins `region` to the character's authored per-location sensory values.
 */
export function detectSensoryFocus(input: string): SensoryFocusHint | null {
  const text = input ?? "";
  const sense: SensoryFocusSense | null = SMELL_RE.test(text)
    ? "smell"
    : TASTE_RE.test(text)
      ? "taste"
      : TOUCH_FOCUS_RE.test(text)
        ? "touch"
        : STUDY_RE.test(text)
          ? "study"
          : null;
  if (!sense) return null;
  const intimateMatch = INTIMATE_TARGET_RE.exec(text)?.[1];
  if (intimateMatch) {
    const target = intimateMatch.toLowerCase();
    const region = INTIMATE_REGION_BY_NOUN[target];
    return { sense, target, intimate: true, ...(region ? { region } : {}) };
  }
  const bodyMatch = BODY_TARGET_RE.exec(text)?.[1];
  if (bodyMatch) {
    const target = bodyMatch.toLowerCase();
    const region = GARMENT_NOUNS.has(target) ? undefined : (EVERYDAY_REGION_BY_NOUN[target] ?? target);
    return { sense, target, intimate: false, ...(region ? { region } : {}) };
  }
  return null;
}

// ---------------------------------------------------------------------------
// Reply-discipline gates (deliverable D): hook cadence + intimate check-in
// ---------------------------------------------------------------------------

/**
 * True when the character's reply ends on a DIALOGUE question — its last non-empty span is
 * speech (or a texted comms line) whose text ends with "?". A mid-reply question that the
 * reply then moves past (a trailing action/narration span) does NOT count, and neither does
 * a narrated rhetorical question outside quotes. Uses the shared span parser, never a fresh
 * regex. Pure.
 */
export function replyEndsInQuestion(reply: string): boolean {
  const spans = parseMessageSpans(reply).filter((s) => s.text.trim().length > 0);
  const last = spans.at(-1);
  if (!last || (last.kind !== "speech" && last.kind !== "comms")) return false;
  return last.text.trim().endsWith("?");
}

/** Recurring intimate check-in solicitations ("does that feel good?", "is this okay?"). */
const CHECK_IN_RE =
  /\b(?:doing (?:this|it) (?:right|okay|ok)|does (?:that|this|it) feel|feels? (?:good|okay|ok|right|nice|alright)\b|is (?:this|that|it) (?:okay|ok|alright|too much|too fast|good)|do you (?:like|want) (?:this|that|it)|want me to (?:keep|stop|continue|slow|go on)|should i (?:keep|stop|continue|slow)|are you (?:okay|ok|alright)|you okay)\b/i;

/** True when the reply carries a check-in-question solicitation (the intimate "am I doing this right?" habit). */
export function isCheckInReply(reply: string): boolean {
  return CHECK_IN_RE.test(reply ?? "");
}

/**
 * The one-turn reply-discipline gate notes (deliverable D): a pure read of the last 1–2
 * assistant replies in the window. Two cheap steers, joined with newlines ("" when neither
 * fires):
 * - **Hook cadence** — the last TWO replies both ended on a dialogue question ⇒ vary the
 *   ending this turn (break the "interview mode" streak).
 * - **Intimate check-in** — an intimate beat AND the previous reply solicited a check-in ⇒
 *   suppress the repeated "does that feel good?" habit for one turn.
 * Rendered by the route into the volatile tail; never persisted into history.
 */
export function buildChatReplyGates(args: {
  recentReplies: readonly string[];
  intimate: boolean;
  name: string;
}): string {
  const recent = args.recentReplies.filter((r) => r.trim().length > 0);
  const lines: string[] = [];
  const lastTwo = recent.slice(-2);
  if (lastTwo.length === 2 && lastTwo.every(replyEndsInQuestion)) {
    lines.push(
      "Your recent replies ended in questions — end this one differently unless the moment truly demands one.",
    );
  }
  const prev = recent.at(-1);
  if (args.intimate && prev && isCheckInReply(prev)) {
    lines.push(
      `No check-in questions this turn — show ${args.name}'s experience through action and involuntary sound, not solicitation.`,
    );
  }
  return lines.join("\n");
}

/**
 * Deterministic mention/spoken-to stamping (multi-character-chat.plan.md slice 3):
 * does this text name the character — display name or an authored alias — as a
 * whole word, case-insensitively? The activity-recency signal's cheap half; the
 * archivist's presence read is the confirming half.
 */
export function mentionsCharacter(text: string, name: string, aliases: readonly string[] = []): boolean {
  const needles = [name, ...aliases].map((n) => n.trim()).filter((n) => n.length > 1);
  if (!text || !needles.length) return false;
  return needles.some((needle) => new RegExp(`(?:^|[^\\p{L}\\p{N}])${escapeRegExp(needle)}(?:[^\\p{L}\\p{N}]|$)`, "iu").test(text));
}

/** Did the reply give this character a tagged spoken line (`[Name] "…"`)? */
export function spokeInReply(reply: string, name: string): boolean {
  const trimmed = name.trim();
  if (!reply || !trimmed) return false;
  return new RegExp(`\\[${escapeRegExp(trimmed)}\\]`, "i").test(reply);
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
