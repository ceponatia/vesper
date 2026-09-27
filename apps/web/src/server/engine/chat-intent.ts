/**
 * Pre-turn intent cue for character chat.
 *
 * Chat has no pre-narrator agent; this is a cheap, regex-first read of the player's input
 * (mirroring `engine/intent.ts`) that raises a ONE-TURN hint when the beat invites an
 * opportunistic cue — the player drawing close, making contact, turning the moment
 * intimate, or putting their attention on the character's appearance.
 * The narrator already carries an opportunistic-cue rule; this just tells it
 * *this* is a turn where a sensory detail or a state beat can land, so cues fire when the
 * beat earns it rather than whenever a band merely allows it. It must NOT persist into chat
 * history, and adds no model call. A blank/OOC input ⇒ no hint ⇒ today's behavior.
 *
 * It also carries the sibling one-turn reads that share this "cheap regex over the turn"
 * spirit: scene-movement detection (chat scene memory), sense-targeted focus (the sensory
 * assembly), and the reply-discipline gates (hook cadence + intimate check-in over the last
 * assistant replies).
 */

import {
  chatEvidenceCandidateFlags,
  chatEvidenceSentences,
  normalizeChatEvidenceText,
} from "@/lib/chat-input-evidence";
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
   * a compliment, a mention of a feature or what they're wearing.
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

interface IndexedRegexMatch {
  readonly index: number;
  readonly end: number;
  readonly text: string;
}

function indexedMatches(text: string, pattern: RegExp): readonly IndexedRegexMatch[] {
  const flags = pattern.flags.includes("g") ? pattern.flags : `${pattern.flags}g`;
  const matcher = new RegExp(pattern.source, flags);
  const matches: IndexedRegexMatch[] = [];
  for (const match of text.matchAll(matcher)) {
    if (match.index === undefined || !match[0]) continue;
    matches.push({ index: match.index, end: match.index + match[0].length, text: match[0] });
  }
  return matches;
}

/** Current-event policy for proximity/touch/intimacy and scene movement. */
function hasCurrentActionMatch(sentence: string, pattern: RegExp): boolean {
  return indexedMatches(sentence, pattern).some((match) => {
    const flags = chatEvidenceCandidateFlags(sentence, match.index);
    return !flags.question && !flags.negated && !flags.irrealis && !flags.historical;
  });
}

export interface ChatCueDetectionContext {
  /** Storyteller-mode text is authored story, not a player body performing the cue. */
  readonly narratorInput?: boolean;
}

export function detectChatCue(input: string, context: ChatCueDetectionContext = {}): ChatCueHint {
  const physicalSentences = context.narratorInput ? [] : chatEvidenceSentences(input, ["narration"]);
  // Appearance attention may be narrated or directly spoken/texted. It is not a
  // physical-action premise, but questions/irrealis/history still do not earn it.
  const attentionSentences = context.narratorInput
    ? []
    : chatEvidenceSentences(input, ["narration", "speech", "comms", "styled"]);
  return {
    proximity: physicalSentences.some(({ text }) => hasCurrentActionMatch(text, PROXIMITY_RE)),
    touch: physicalSentences.some(({ text }) => hasCurrentActionMatch(text, TOUCH_RE)),
    intimate: physicalSentences.some(({ text }) => hasCurrentActionMatch(text, INTIMATE_RE)),
    attention: attentionSentences.some(({ text }) =>
      indexedMatches(text, ATTENTION_RE).some((match) => {
        const flags = chatEvidenceCandidateFlags(text, match.index);
        // "can't stop staring" is an explicit positive arm in ATTENTION_RE, so
        // negation is deliberately not a blanket attention veto.
        return !flags.question && !flags.irrealis && !flags.historical;
      }),
    ),
  };
}

/**
 * The deterministic per-turn sensory allowance — the chat-lane analogue of the
 * session's exposure mask (`exposureRules`,
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
 * player's senses, never as the character's property.
 *
 * RETIRED from the live pipeline (2026-07-10):
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
//
// A deterministic, token-level reading of every movement verb in the line (#330): pure,
// with no model call. Each verb answers three questions, each by a small structural rule
// rather than one wide regex whose capture has to be patched clause by clause:
//
// 1. WHERE TO — the noun phrase after the verb's FIRST destination preposition, cut at the
//    first function word ("to her desk and lean against it" → `desk`, "to the table by the
//    window" → `table`), or an adverbial destination ("outside"). A preposition that no
//    determiner follows ends the read: "walk over to talk", "go to bed", "walk over to Wren".
//    A verbless coordinated segment that opens on a path word continues the SAME verb's
//    motion to its own destination ("walk past her and into the kitchen", "…, then through
//    to the kitchen"); a coordinated clause with its own subject or verb never does.
// 2. WHAT KIND — a place; a position WITHIN the current place (furniture, a fixture — owner
//    ruling on #330, 2026-09-27); or no destination at all: a body part, a garment, or an
//    abstraction ("my hand to her thigh", "into my dress", "to an agreement") is a gesture
//    or an idiom, never locomotion.
// 3. WHOSE BODY MOVES — the verb's own subject (the nearest nominal before it in its
//    clause), else the subject SHARED from the previous clause ("the bartender nods and
//    walks …"), else — only when nothing precedes the verb in its sentence — the imperative
//    player; or a player direct object ("she leads ME …"). Player input must move the
//    player; storyteller input is authorized scene authoring, so any mover relocates it.
//
// The LAST place change in the line wins (where the bodies end the turn: "walk to the
// kitchen …, then carry it back to the living room"), and a within-place move is reported
// only when the line has no place change at all.

/** One place from the chat's scene memory, as the movement read needs it. */
export interface SceneMovementPlace {
  readonly name: string;
  readonly details: readonly string[];
  readonly connections: readonly string[];
}

export interface SceneMovementContext {
  /**
   * The chat's scene-memory places (`ChatSceneMemory.places`, current place included). A
   * destination naming an ESTABLISHED place — one the fiction gave at least one detail or
   * connection — is a place whatever its head noun (a nook called "the Reading Desk"). A bare
   * stub (no details, no connections) earns no such exemption: a stub named "desk" is exactly
   * what an earlier mis-read minted, and exempting it would keep the furniture read a room.
   */
  readonly knownPlaces?: readonly SceneMovementPlace[];
  /**
   * Storyteller (narrator-mode) input: authorized scene authoring, so any subject's movement
   * may relocate the scene. It is never the player's own POV (`supporting-cast.md`), so there
   * only "you" and the persona's name denote the player — and only a move of the player
   * reports a within-place move.
   */
  readonly narratorInput?: boolean;
  /** The player's persona name (and any aliases): in player input, the player's own subject. */
  readonly playerNames?: readonly string[];
}

function sceneWordSet(words: string): ReadonlySet<string> {
  return new Set(words.split(/\s+/u).filter(Boolean));
}

/** Movement verb forms that can carry a destination ("head to the kitchen", "follow her outside"). */
const SCENE_MOVE_VERBS = sceneWordSet(`
  go goes going went head heads heading headed walk walks walking walked
  move moves moving moved follow follows following followed lead leads leading led
  step steps stepping stepped slip slips slipping slipped wander wanders wandering wandered
  retreat retreats retreating retreated come comes coming came drive drives driving drove
  run runs running ran take takes taking took bring brings bringing brought
  carry carries carrying carried
`);
/** "make my way" / "made our way": one of these, a possessive, then "way". */
const SCENE_MAKE_WAY_VERBS = sceneWordSet("make makes making made");
const SCENE_POSSESSIVES = sceneWordSet("my your his her their our its");
/** A destination noun phrase follows one of these ("over to", "back into" end in them). */
const SCENE_DEST_PREPOSITIONS = sceneWordSet("to into onto toward towards");
/** What must follow the preposition for a noun-phrase destination. */
const SCENE_DEST_DETERMINERS = sceneWordSet("the a an my your his her their our");
/** Adverbial destinations ("we head outside", "let's go upstairs"); "out back"/"out front" too. */
const SCENE_BARE_DESTINATIONS = sceneWordSet("outside inside indoors outdoors upstairs downstairs");
/**
 * First words of a verbless segment that continues the previous verb's path ("… and INTO the
 * kitchen", "… and OUT to the patio", "…, then THROUGH to the kitchen").
 */
const SCENE_PATH_WORDS = sceneWordSet(`
  to into onto toward towards out back over down up through past across along around away in
  inside outside indoors outdoors upstairs downstairs straight right
`);
/** What may join a path continuation to its verb: a comma or dash, "and", "then". */
const SCENE_CONTINUATION_JOINS = sceneWordSet(", \u2013 \u2014 - and then");
/** Clause boundaries (with clause punctuation): no read crosses one forward. */
const SCENE_CLAUSE_CONJUNCTIONS = sceneWordSet(`
  and but or nor yet so then while whereas as when once because since though although where
  if unless until till before after
`);
const SCENE_PERSONAL_PRONOUNS = sceneWordSet(`
  i me we us you he him she her it they them someone somebody everyone everybody anyone anybody
`);
/** In player input, the words that put the player in a subject or object slot. */
const SCENE_PLAYER_SELF_WORDS = sceneWordSet("i me we us let's");
/** A pronoun object after "inside"/"outside" makes it a preposition to a person ("slip inside her"). */
const SCENE_OBJECT_PRONOUNS = sceneWordSet("me you him them us it");
/** Words that open a third-party noun phrase ("the bartender", "my friend", "both of us"). */
const SCENE_NP_DETERMINERS = sceneWordSet(`
  the a an this that these those my your his her their our its some every each another both all no
`);
/** Adverbs, interjections, auxiliaries, and the infinitive marker a subject read reads past. */
const SCENE_SUBJECT_SKIP_WORDS = sceneWordSet(`
  to now soon later just also still even too again together already instead anyway first finally all both
  okay ok alright well yes yeah sure fine hey oh um uh please
  am is are was were be been do does did will shall can must
`);
/** A sentence-initial word followed by one of these is an imperative verb ("Grab my keys"), not a name. */
const SCENE_OBJECT_LEAD = sceneWordSet(`
  the a an this that these those my your his her their our its some me you him them us it
  up down out off back over on in at to into onto toward towards away around through across along
  closer close forward aside inside outside
`);
/** Function words that end a destination noun phrase ("the window to look out" → `window`). */
const SCENE_NP_STOP = sceneWordSet(`
  to into onto toward towards in on at by near beside behind with for from of off under over across
  along through past around against inside outside above below beneath underneath between among beyond
  like without within upon via during except alongside throughout amid
  i me my mine you your yours he him his she her hers it its we us our ours they them their theirs
  myself yourself himself herself itself ourselves themselves
  the a an this that these those some any each every
  up down out away together again now there here too just also still very already instead anyway alone
  which who whom whose what how why
  is are was were am be been being has have had will would can could should shall may might must do does did
`);
/**
 * Trailing words dropped from a destination phrase ("the bathroom real quick" → `bathroom`,
 * "the table next to the window" → `table`); "next" opens a phrase fine ("the next room").
 */
const SCENE_NP_TRAILING = sceneWordSet("first quick fast real next");
/** "the second floor" is a storey, not the floor underfoot. */
const SCENE_STOREY_MODIFIERS = sceneWordSet("first second third fourth fifth sixth top ground upper lower main bottom next");

/**
 * Furniture, fixtures, and positions a beat can cross to without leaving the current place
 * ("walk over to the desk", "carry it to the counter", "retreat to the corner"): a
 * destination whose head noun is one of these is a WITHIN-place move. Kept to obvious
 * furniture/fixtures on purpose — room-type nouns ("back room", "kitchen", "garden",
 * "study") are never here, so a genuinely new place still establishes. Not exhaustive: a
 * miss is the soft error the archivist reconciles post-turn.
 */
const SCENE_FIXTURE_NOUNS = sceneWordSet(`
  desk chair armchair table bed couch sofa bench stool barstool counter sink tub bathtub bath shower toilet
  stove oven fridge refrigerator shelf shelves bookshelf bookcase cabinet drawer dresser mirror nightstand
  ottoman rug carpet cushion pillow blanket covers sheets window windowsill sill ledge door doorway
  doorframe threshold wall floor ceiling fireplace hearth mantel mantle wardrobe vanity seat seats booth
  stairs staircase railing banister lamp piano easel recliner loveseat futon chaise hammock cot crib
  headboard bedside curtains corner middle center centre
`);
/**
 * Body parts, garments, and the gaze: as a destination ("to her thigh", "into my dress",
 * "into her arms") or as the thing a verb moves ("I move my hand …", "I follow her gaze …")
 * they make the line a gesture, never locomotion — no place change and no within-place move.
 */
const SCENE_GESTURE_NOUNS = sceneWordSet(`
  hand hands finger fingers fingertip fingertips palm palms thumb thumbs knuckles wrist wrists arm arms
  elbow shoulder shoulders neck throat nape head face cheek cheeks chin jaw lip lips mouth tongue ear ears
  forehead temple hair chest breast breasts nipple nipples heart waist hip hips thigh thighs leg legs knee
  knees lap foot feet toes ankle ankles stomach belly navel side body skin spine collarbone ass butt groin
  crotch gaze eye eyes glance stare attention focus
  dress shirt t-shirt jeans pants trousers skirt robe gown nightgown pajamas pyjamas clothes clothing outfit
  sweater hoodie jacket coat shoes heels boots socks stockings lingerie underwear panties bra bikini
  swimsuit uniform costume blouse tights shorts leggings suit
`);
/** Figurative destinations ("come to an agreement", "bring her to the edge"): an idiom, never a place. */
const SCENE_ABSTRACT_NOUNS = sceneWordSet(`
  agreement understanding conclusion decision realization compromise stop halt standstill end close finish
  edge brink point topic subject matter question idea truth senses terms rescue aid limit extreme
`);

interface SceneToken {
  /** Lowercased. */
  readonly text: string;
  /** As written: capitalization is the one name signal a pure read has. */
  readonly raw: string;
  /** Character offset in the sentence. */
  readonly index: number;
  /** False for clause punctuation (`,` `;` `:` parentheses, dashes). */
  readonly word: boolean;
}

const SCENE_TOKEN_RE = /[\p{L}\p{N}]+(?:['-][\p{L}\p{N}]+)*|[,;:()\u2013\u2014]|(?<=\s)-(?=\s)/gu;

function sceneTokens(text: string): SceneToken[] {
  const tokens: SceneToken[] = [];
  for (const match of normalizeChatEvidenceText(text).matchAll(SCENE_TOKEN_RE)) {
    if (match.index === undefined || !match[0]) continue;
    const raw = match[0];
    tokens.push({ text: raw.toLowerCase(), raw, index: match.index, word: /^[\p{L}\p{N}]/u.test(raw) });
  }
  return tokens;
}

function sceneIsBoundary(token: SceneToken): boolean {
  return !token.word || SCENE_CLAUSE_CONJUNCTIONS.has(token.text);
}

function sceneIsCapitalized(token: SceneToken): boolean {
  return /^\p{Lu}/u.test(token.raw);
}

/** "we're" → "we", "i'll" → "i"; "let's" stays itself. */
function sceneBaseWord(text: string): string {
  return text === "let's" ? text : text.replace(/'(?:s|re|ll|m|d|ve)$/u, "");
}

function sceneIsFunctionWord(word: string): boolean {
  return (
    SCENE_PERSONAL_PRONOUNS.has(word) ||
    SCENE_NP_DETERMINERS.has(word) ||
    SCENE_NP_STOP.has(word) ||
    SCENE_CLAUSE_CONJUNCTIONS.has(word) ||
    SCENE_SUBJECT_SKIP_WORDS.has(word) ||
    SCENE_MOVE_VERBS.has(word)
  );
}

type ScenePersonRole = "player" | "other";

interface SceneReadContext {
  readonly narratorInput: boolean;
  /** Lowercased word sequences that name the player (full name, then a given-name form). */
  readonly names: readonly (readonly string[])[];
  /** Normalized names of established (non-stub) places. */
  readonly established: ReadonlySet<string>;
}

function scenePlayerNameForms(names: readonly string[] | undefined): readonly (readonly string[])[] {
  const forms: string[][] = [];
  for (const name of names ?? []) {
    const words = sceneTokens(name)
      .filter((token) => token.word)
      .map((token) => token.text);
    const first = words[0];
    if (first === undefined || (words.length === 1 && first.length < 2)) continue;
    forms.push(words);
    // A given name alone ("Brian" for "Brian Grubba") — never a function word ("the visitor").
    if (words.length > 1 && first.length > 1 && !sceneIsFunctionWord(first)) forms.push([first]);
  }
  return forms;
}

/** How many tokens from `start` spell a player name (0 when none does). */
function sceneNameLengthAt(tokens: readonly SceneToken[], start: number, read: SceneReadContext): number {
  for (const form of read.names) {
    const matches = form.every((word, offset) => {
      const token = tokens[start + offset];
      return token !== undefined && token.word && token.text === word;
    });
    const first = tokens[start];
    if (!matches || first === undefined) continue;
    // A one-word name that is also a function word ("Will") counts only as written, capitalized.
    if (form.length === 1 && sceneIsFunctionWord(first.text) && !sceneIsCapitalized(first)) continue;
    return form.length;
  }
  return 0;
}

function sceneNameEndsAt(tokens: readonly SceneToken[], end: number, read: SceneReadContext): boolean {
  return read.names.some((form) => {
    const start = end - form.length + 1;
    return start >= 0 && sceneNameLengthAt(tokens, start, { ...read, names: [form] }) === form.length;
  });
}

/**
 * Whose word this is. Player input: I/me/we/us/let's are the player and "you" is the
 * character (as the sensory read has it). Storyteller input is never the player's own POV,
 * so there "you" is the player and every first-person word is the storyteller's.
 */
function sceneWordRole(text: string, narratorInput: boolean): ScenePersonRole | null {
  const word = sceneBaseWord(text);
  if (narratorInput) {
    if (word === "you") return "player";
    return SCENE_PERSONAL_PRONOUNS.has(word) || word === "let's" ? "other" : null;
  }
  if (SCENE_PLAYER_SELF_WORDS.has(word)) return "player";
  return SCENE_PERSONAL_PRONOUNS.has(word) ? "other" : null;
}

/** "(the two) of us", "(both) of us" within the next three words. */
function sceneOfUsAfter(tokens: readonly SceneToken[], from: number): boolean {
  for (let k = from; k < from + 3; k += 1) {
    const token = tokens[k];
    if (token === undefined || sceneIsBoundary(token)) return false;
    if (token.text === "of") return tokens[k + 1]?.text === "us";
  }
  return false;
}

/** The first index of the clause that ends at `end`: just past the nearest boundary. */
function sceneClauseStart(tokens: readonly SceneToken[], end: number): number {
  let k = end;
  while (k >= 0) {
    const token = tokens[k];
    if (token === undefined || sceneIsBoundary(token)) break;
    k -= 1;
  }
  return k + 1;
}

/** A lowercase word a determiner opens within three words is a noun ("the old bartender"). */
function sceneHeadsNounPhrase(tokens: readonly SceneToken[], k: number, from: number): boolean {
  for (let j = k - 1; j >= Math.max(from, k - 3); j -= 1) {
    const token = tokens[j];
    if (token === undefined) return false;
    if (SCENE_NP_DETERMINERS.has(token.text)) return true;
    if (sceneWordRole(token.text, false) !== null || SCENE_SUBJECT_SKIP_WORDS.has(token.text) || SCENE_NP_STOP.has(token.text)) {
      return false;
    }
  }
  return false;
}

/**
 * The subject of the verb's OWN clause (`from`..`to`, the words before the verb): the
 * nearest nominal, read right to left — so "I watch the bartender walk" is the bartender's
 * walk and "she watches me walk" is the player's. Adverbs and auxiliaries are read past, and
 * so is an unknown lowercase word no determiner opens (a verb: "I decide to walk"). Null
 * when the clause names no subject (a shared-subject predicate or an imperative).
 */
function sceneSubjectBeforeVerb(
  tokens: readonly SceneToken[],
  from: number,
  to: number,
  firstWord: number,
  read: SceneReadContext,
): ScenePersonRole | null {
  for (let k = to; k >= from; k -= 1) {
    const token = tokens[k];
    if (token === undefined) continue;
    if (sceneNameEndsAt(tokens, k, read)) return "player";
    const role = sceneWordRole(token.text, read.narratorInput);
    if (role !== null) return role;
    if (SCENE_SUBJECT_SKIP_WORDS.has(sceneBaseWord(token.text))) continue;
    // "Lets go outside": the apostrophe-less imperative contraction.
    if (k === firstWord && token.text === "lets") return read.narratorInput ? "other" : "player";
    // A name as written, a sentence-initial word right before the verb ("Emily walks"), or a
    // determiner-opened noun phrase ("the bartender", "my friend") is a third party.
    if (k === firstWord || sceneIsCapitalized(token) || SCENE_NP_DETERMINERS.has(token.text)) return "other";
    if (sceneHeadsNounPhrase(tokens, k, from)) return "other";
  }
  return null;
}

/** An "-ly"/"-ing" word a pronoun, determiner, or name follows is an adverb ("Slowly the bartender …"). */
function sceneLeadingAdverb(tokens: readonly SceneToken[], k: number, narratorInput: boolean): boolean {
  const token = tokens[k];
  if (token === undefined || token.text.length < 5 || !/(?:ly|ing)$/u.test(token.text)) return false;
  const next = tokens[k + 1];
  return (
    next !== undefined &&
    next.word &&
    (sceneWordRole(next.text, narratorInput) !== null || SCENE_NP_DETERMINERS.has(next.text) || sceneIsCapitalized(next))
  );
}

/**
 * A sentence-initial word with no determiner is a name ("Mara grabs her purse") unless an
 * object follows it ("Grab my keys", "Turn around") or it stands alone before a conjunction
 * ("Nod and walk …") — then it is an imperative verb. Alone before a comma it is a name
 * ("Mara, sighing, walks …").
 */
function sceneInitialWordIsName(tokens: readonly SceneToken[], k: number, to: number): boolean {
  const next = k < to ? tokens[k + 1] : undefined;
  if (next === undefined) {
    const after = tokens[to + 1];
    return after !== undefined && !after.word;
  }
  return !SCENE_OBJECT_LEAD.has(sceneBaseWord(next.text));
}

/**
 * The subject a PREVIOUS clause (`from`..`to`) shares with a later subjectless one — its
 * leading nominal ("I grab my keys and walk …", "the bartender nods and walks …"). Null
 * when the clause itself starts with its verb ("… sighing, …", "grab my keys and …").
 */
function sceneLeadingSubject(
  tokens: readonly SceneToken[],
  from: number,
  to: number,
  firstWord: number,
  read: SceneReadContext,
): ScenePersonRole | null {
  for (let k = from; k <= to; k += 1) {
    const token = tokens[k];
    if (token === undefined) continue;
    if (sceneNameLengthAt(tokens, k, read) > 0) return "player";
    const role = sceneWordRole(token.text, read.narratorInput);
    if (role !== null) return role;
    if (SCENE_NP_DETERMINERS.has(token.text)) {
      return !read.narratorInput && sceneOfUsAfter(tokens, k + 1) ? "player" : "other";
    }
    if (SCENE_SUBJECT_SKIP_WORDS.has(sceneBaseWord(token.text)) || sceneLeadingAdverb(tokens, k, read.narratorInput)) {
      continue;
    }
    if (k === firstWord) return sceneInitialWordIsName(tokens, k, to) ? "other" : null;
    return sceneIsCapitalized(token) ? "other" : null;
  }
  return null;
}

/** "Brian and Mara walk …": a bare player reference joined by "and" to the verb's own subject. */
function sceneCoordinatedWithPlayer(tokens: readonly SceneToken[], ownStart: number, read: SceneReadContext): boolean {
  if (tokens[ownStart - 1]?.text !== "and") return false;
  const end = ownStart - 2;
  const start = sceneClauseStart(tokens, end);
  const length = end - start + 1;
  const only = tokens[start];
  if (length <= 0 || only === undefined) return false;
  if (length === 1 && sceneWordRole(only.text, read.narratorInput) === "player") return true;
  return sceneNameLengthAt(tokens, start, read) === length;
}

/**
 * A sentence-opening participle takes its subject from the clause after the comma: "Walking
 * into the kitchen, I grab a glass" is the player's move, "…, she grabs a glass" is not.
 * Null when the verb is no participle, or that clause names no subject.
 */
function sceneParticipleSubject(
  tokens: readonly SceneToken[],
  v: number,
  firstWord: number,
  read: SceneReadContext,
): ScenePersonRole | null {
  if (!(tokens[v]?.text ?? "").endsWith("ing")) return null;
  const comma = tokens.findIndex((token, k) => k > v && !token.word);
  if (comma < 0) return null;
  let end = comma;
  for (let k = comma + 1; k < tokens.length; k += 1) {
    const token = tokens[k];
    if (token === undefined || sceneIsBoundary(token)) break;
    end = k;
  }
  return end > comma ? sceneLeadingSubject(tokens, comma + 1, end, firstWord, read) : null;
}

/**
 * Is the player the subject of the verb at `v`? Its own clause's subject when it has one;
 * otherwise the subject shared from the nearest earlier clause that names one; otherwise —
 * nothing precedes the verb in its sentence — the subject after an opening participle, else
 * an imperative or subject-dropped beat: the player's own in player input (never in
 * storyteller input, which is not the player's POV).
 */
function sceneSubjectIsPlayer(tokens: readonly SceneToken[], v: number, firstWord: number, read: SceneReadContext): boolean {
  const ownStart = sceneClauseStart(tokens, v - 1);
  const own = sceneSubjectBeforeVerb(tokens, ownStart, v - 1, firstWord, read);
  if (own === "player") return true;
  if (own === "other") return sceneCoordinatedWithPlayer(tokens, ownStart, read);
  let boundary = ownStart - 1;
  while (boundary >= 0) {
    const clauseStart = sceneClauseStart(tokens, boundary - 1);
    if (clauseStart <= boundary - 1) {
      const lead = sceneLeadingSubject(tokens, clauseStart, boundary - 1, firstWord, read);
      if (lead !== null) return lead === "player";
    }
    boundary = clauseStart - 1;
  }
  const participle = sceneParticipleSubject(tokens, v, firstWord, read);
  if (participle !== null) return participle === "player";
  return !read.narratorInput;
}

/** The verb's direct object is the player ("she leads ME", "leads BRIAN", "leads the two of US"). */
function sceneObjectIsPlayer(tokens: readonly SceneToken[], at: number, read: SceneReadContext): boolean {
  const token = tokens[at];
  if (token === undefined || !token.word) return false;
  if (sceneNameLengthAt(tokens, at, read) > 0) return true;
  if (sceneWordRole(token.text, read.narratorInput) === "player") return true;
  return !read.narratorInput && SCENE_NP_DETERMINERS.has(token.text) && sceneOfUsAfter(tokens, at + 1);
}

/** Up to three words after a determiner, cut at the first function word or clause boundary. */
function sceneNounPhrase(tokens: readonly SceneToken[], from: number): string[] {
  const words: string[] = [];
  for (let k = from; k < tokens.length && words.length < 3; k += 1) {
    const token = tokens[k];
    if (token === undefined || sceneIsBoundary(token) || SCENE_NP_STOP.has(token.text)) break;
    words.push(token.text);
  }
  while (words.length > 1) {
    const last = words.at(-1);
    if (last === undefined || !(SCENE_NP_TRAILING.has(last) || (last.length >= 5 && last.endsWith("ly")))) break;
    words.pop();
  }
  return words;
}

/** "I move my hand …", "I follow her gaze …": the verb moves a body part, not a body. */
function sceneObjectIsGesture(tokens: readonly SceneToken[], at: number): boolean {
  const determiner = tokens[at];
  if (determiner === undefined || !SCENE_NP_DETERMINERS.has(determiner.text)) return false;
  const head = sceneNounPhrase(tokens, at + 1).at(-1);
  return head !== undefined && SCENE_GESTURE_NOUNS.has(head);
}

/** "inside her", "inside of him": a preposition with a person object, never a destination. */
function sceneBareIsIntoAPerson(tokens: readonly SceneToken[], from: number): boolean {
  const at = tokens[from]?.text === "of" ? from + 1 : from;
  const object = tokens[at];
  if (object === undefined || !object.word) return false;
  if (SCENE_OBJECT_PRONOUNS.has(object.text)) return true;
  if (object.text !== "her") return false;
  const after = tokens[at + 1];
  return after === undefined || sceneIsBoundary(after) || SCENE_NP_STOP.has(after.text);
}

function sceneBareDestinationAt(tokens: readonly SceneToken[], k: number): string | null {
  const token = tokens[k];
  if (token === undefined) return null;
  if (token.text === "out") {
    const next = tokens[k + 1];
    return next !== undefined && (next.text === "back" || next.text === "front") ? `out ${next.text}` : null;
  }
  if (!SCENE_BARE_DESTINATIONS.has(token.text)) return null;
  return sceneBareIsIntoAPerson(tokens, k + 1) ? null : token.text;
}

interface SceneDestinationWords {
  /** The noun phrase after the first destination preposition, or null. */
  readonly phrase: readonly string[] | null;
  /** An adverbial destination seen before it ("outside"), or null. */
  readonly bare: string | null;
}

/** Scan forward from the verb, inside its clause, for its destination. */
function sceneDestinationAfter(tokens: readonly SceneToken[], from: number): SceneDestinationWords {
  let bare: string | null = null;
  for (let k = from; k < tokens.length; k += 1) {
    const token = tokens[k];
    if (token === undefined || sceneIsBoundary(token)) break;
    if (SCENE_DEST_PREPOSITIONS.has(token.text)) {
      const determiner = tokens[k + 1];
      // "walk over to talk", "go to bed", "walk over to Wren": no destination phrase.
      if (determiner === undefined || !SCENE_DEST_DETERMINERS.has(determiner.text)) break;
      const phrase = sceneNounPhrase(tokens, k + 2);
      // "move closer to her on the couch": a person, not a destination.
      return { phrase: phrase.length > 0 ? phrase : null, bare };
    }
    bare ??= sceneBareDestinationAt(tokens, k);
  }
  return { phrase: null, bare };
}

type SceneDestinationKind = "place" | "within_place";

/** Null for a gesture or an idiom (a body part, garment, or abstraction: no destination at all). */
function sceneDestinationKind(words: readonly string[], read: SceneReadContext): SceneDestinationKind | null {
  if (read.established.has(words.join(" "))) return "place";
  const head = words.at(-1);
  if (head === undefined || SCENE_GESTURE_NOUNS.has(head) || SCENE_ABSTRACT_NOUNS.has(head)) return null;
  if (!SCENE_FIXTURE_NOUNS.has(head)) return "place";
  const storey = head === "floor" && words.slice(0, -1).some((word) => SCENE_STOREY_MODIFIERS.has(word));
  return storey ? "place" : "within_place";
}

function sceneEstablishedPlaceNames(places: readonly SceneMovementPlace[] | undefined): ReadonlySet<string> {
  const names = new Set<string>();
  for (const place of places ?? []) {
    if (place.details.length === 0 && place.connections.length === 0) continue;
    const words = sceneTokens(place.name)
      .filter((token) => token.word)
      .map((token) => token.text);
    if (words.length === 0) continue;
    names.add(words.join(" "));
    // "The Rusty Anchor" is reached as "to the rusty anchor".
    if (words[0] === "the" || words[0] === "a" || words[0] === "an") names.add(words.slice(1).join(" "));
  }
  return names;
}

/**
 * A place phrase wins; then an adverbial ("we head outside to the bench" leaves the room);
 * a furniture/fixture phrase is a within-place move only when nothing else names a place.
 */
function sceneChosenDestination(
  words: SceneDestinationWords,
  read: SceneReadContext,
): { readonly name: string; readonly withinPlace: boolean } | null {
  const { phrase, bare } = words;
  const kind = phrase === null ? null : sceneDestinationKind(phrase, read);
  if (phrase !== null && kind === "place") return { name: phrase.join(" "), withinPlace: false };
  if (bare !== null) return { name: bare, withinPlace: false };
  if (phrase !== null && kind === "within_place") return { name: phrase.join(" "), withinPlace: true };
  return null;
}

/** The index of the first clause boundary at or after `from`: where that segment ends. */
function sceneSegmentEnd(tokens: readonly SceneToken[], from: number): number {
  let k = from;
  while (k < tokens.length) {
    const token = tokens[k];
    if (token === undefined || sceneIsBoundary(token)) break;
    k += 1;
  }
  return k;
}

/**
 * Where the verbless segment continuing a verb's path begins, past the boundary at `at`
 * ("I walk past her AND INTO the kitchen", "…, THEN THROUGH to the kitchen"), or null. Only a
 * comma or dash, "and", or "then" joins one, and the segment must open on a path word — so a
 * coordinated clause with its own subject ("and we head outside") or its own verb ("and lean
 * against it") is never read as the same motion; it gets its own read.
 */
function scenePathContinuationAt(tokens: readonly SceneToken[], at: number): number | null {
  let k = at;
  while (k < tokens.length) {
    const token = tokens[k];
    if (token === undefined) return null;
    if (!sceneIsBoundary(token)) break;
    if (!SCENE_CONTINUATION_JOINS.has(token.text)) return null;
    k += 1;
  }
  const first = tokens[k];
  return first !== undefined && SCENE_PATH_WORDS.has(first.text) ? k : null;
}

/**
 * Every destination one verb's motion reaches, in order: its own segment's, then each path
 * continuation's ("I walk over to her desk and into the back room" → `desk`, `back room`).
 */
function sceneVerbDestinations(
  tokens: readonly SceneToken[],
  from: number,
  read: SceneReadContext,
): readonly { readonly name: string; readonly withinPlace: boolean }[] {
  const destinations: { readonly name: string; readonly withinPlace: boolean }[] = [];
  let start: number | null = from;
  while (start !== null) {
    const destination = sceneChosenDestination(sceneDestinationAfter(tokens, start), read);
    if (destination !== null) destinations.push(destination);
    start = scenePathContinuationAt(tokens, sceneSegmentEnd(tokens, start));
  }
  return destinations;
}

interface SceneMoveCandidate {
  readonly destination: string;
  readonly withinPlace: boolean;
  /** The player's own body moves (subject or direct object) — not merely a third party's. */
  readonly playerMoves: boolean;
}

function sceneMoveCandidatesAt(
  sentence: string,
  tokens: readonly SceneToken[],
  v: number,
  firstWord: number,
  read: SceneReadContext,
): readonly SceneMoveCandidate[] {
  const verb = tokens[v];
  if (verb === undefined) return [];
  const makesWay =
    SCENE_MAKE_WAY_VERBS.has(verb.text) &&
    SCENE_POSSESSIVES.has(tokens[v + 1]?.text ?? "") &&
    tokens[v + 2]?.text === "way";
  if (!SCENE_MOVE_VERBS.has(verb.text) && !makesWay) return [];
  const flags = chatEvidenceCandidateFlags(sentence, verb.index);
  if (flags.question || flags.negated || flags.irrealis || flags.historical) return [];
  const objectAt = makesWay ? null : v + 1;
  if (objectAt !== null && sceneObjectIsGesture(tokens, objectAt)) return [];

  const destinations = sceneVerbDestinations(tokens, makesWay ? v + 3 : v + 1, read);
  if (destinations.length === 0) return [];

  // One mover for the verb's whole path, continuations included.
  const playerMoves =
    (objectAt !== null && sceneObjectIsPlayer(tokens, objectAt, read)) || sceneSubjectIsPlayer(tokens, v, firstWord, read);
  return destinations.map((destination) => ({
    destination: destination.name,
    withinPlace: destination.withinPlace,
    playerMoves,
  }));
}

/**
 * The one read both exported detectors derive from, so they can never disagree: every
 * movement verb in the line's narration, the last place change the line establishes, and —
 * only when there is none — the player's last within-place move.
 */
function sceneMovementRead(
  input: string,
  context: SceneMovementContext,
): { readonly place: string | null; readonly withinPlace: string | null } {
  const read: SceneReadContext = {
    narratorInput: context.narratorInput === true,
    names: scenePlayerNameForms(context.playerNames),
    established: sceneEstablishedPlaceNames(context.knownPlaces),
  };
  let place: string | null = null;
  let withinPlace: string | null = null;
  for (const { text } of chatEvidenceSentences(input, ["narration"])) {
    const tokens = sceneTokens(text);
    const firstWord = tokens.findIndex((token) => token.word);
    for (let v = 0; v < tokens.length; v += 1) {
      for (const candidate of sceneMoveCandidatesAt(text, tokens, v, firstWord, read)) {
        if (candidate.withinPlace) {
          if (candidate.playerMoves) withinPlace = candidate.destination;
        } else if (candidate.playerMoves || read.narratorInput) {
          place = candidate.destination;
        }
      }
    }
  }
  return { place, withinPlace: place === null ? withinPlace : null };
}

/**
 * Deterministic movement/arrival read of the turn's input (chat scene memory): the place
 * ("kitchen", "outside", "back garden") the line moves the scene to, or null. The route feeds
 * it to `switchScenePlace` BEFORE the prompt builds so this turn's Scene injection is right.
 * In player input only the player's own move counts — an unrelated third party's errand
 * narrated in passing ("the bartender walks back to the back room") settles nothing (#330);
 * storyteller input is authorized scene authoring and may move the scene through anyone. A
 * move onto furniture or a fixture within the current place ("I walk over to the desk") is
 * never a place change (owner ruling on #330, 2026-09-27) — `detectWithinPlaceMovement`
 * carries that signal instead.
 */
export function detectSceneMovement(input: string, context: SceneMovementContext = {}): string | null {
  return sceneMovementRead(input, context).place;
}

/**
 * The sibling read for the player's own move onto furniture or a fixture within the current
 * place ("I walk over to the desk", "I carry my drink over to the counter") — its name, or
 * null. The scene does NOT change (no stub place, no `current` switch), but the player's own
 * body crossed the room: the route ends the player's held contacts and clears the player's
 * pair proximity to unknown without a place change (owner ruling on #330, 2026-09-27). Null
 * whenever the same line changes place (`detectSceneMovement` — that end is the blanket one),
 * and in storyteller input unless the mover is the player ("you", the persona's name).
 */
export function detectWithinPlaceMovement(input: string, context: SceneMovementContext = {}): string | null {
  return sceneMovementRead(input, context).withinPlace;
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
   * region's own authored attributes via `expandBodyTarget`,
   * so "foot" surfaces `feet.smell`, not just the generic scent baseline. Absent for
   * garment targets (a dress has no anatomy to expand) and unmapped colloquialisms.
   */
  region?: string;
  /** The present roster member the target owner resolved to, when context was supplied. */
  targetCharacterId?: string;
  /** Detector provenance: only ordinary player narration can produce a focus premise. */
  source?: "player_narration";
}

export interface SensoryFocusCharacter {
  readonly id: string;
  readonly name: string;
  readonly aliases: readonly string[];
}

export interface SensoryFocusDetectionContext {
  /** PRESENT roster only. Pronouns fail closed unless this contains exactly one member. */
  readonly characters?: readonly SensoryFocusCharacter[];
  /** Storyteller narration is authored story, never evidence that the player performed an action. */
  readonly narratorInput?: boolean;
}

const SMELL_RE =
  /\b(?:smell(?:s|ing|ed)?|sniff(?:s|ing|ed)?|inhal(?:e|es|ing|ed)|breathe(?:s)? (?:in|deep)|breathing (?:in|deep)|(?:the )?scent of|nose(?:s)? (?:at|against))\b/i;
const TASTE_RE =
  /\b(?:taste(?:s|d)?|tasting|lick(?:s|ing|ed)?|(?:my|your|her|his|their) tongue|tongue(?:s|d)? (?:at|against|over|along)|mouth(?:s|ed)? (?:at|on))\b/i;
const TOUCH_FOCUS_RE =
  /\b(?:touch(?:es|ing|ed)?|feel(?:s|ing)?|felt|stroke(?:s|d|ing)?|caress(?:es|ed|ing)?|trace(?:s|d)?|tracing|cup(?:s|ped|ping)?|grips?|gripp(?:ed|ing)|grope(?:s|d|ing)?|squeeze(?:s|d|zing)?|fondle(?:s|d|ing)?|palm(?:s|ed|ing)?|graze(?:s|d)?|run(?:s|ning)? (?:a |my |your |her |his |their )?(?:hand|fingers|palm|fingertips|thumb))\b/i;
const STUDY_RE =
  /\b(?:study(?:ing|ies)?|studied|examine(?:s|d)?|examining|inspect(?:s|ing|ed)?|scrutiniz(?:e|es|ed|ing)|look(?:s|ing|ed)? (?:closely|over)|takes? in|taking in|drink(?:s|ing)? in|drank in)\b/i;

// Target vocabularies only. Ownership is resolved positionally below, so the player's
// own hand in "run my fingers along your collarbone" is rejected while the character's
// collarbone remains eligible.
/** Intimate anatomy nouns — a match sets `intimate`, gating the intimate-attribute surfacing. */
const INTIMATE_TARGET_RE =
  /\b(breasts?|nipples?|cleavage|vulva|pussy|cunt|clit(?:oris)?|labia|folds|penis|cock|dick|shaft|balls|testicles?|groin|crotch|anus|ass|arse|buttocks?|butt|rear|panties|thong|lingerie)\b/gi;
/** Everyday body-region + garment nouns the sense can land on. */
const BODY_TARGET_RE =
  /\b(hair|neck|throat|nape|collarbones?|shoulders?|skin|cheeks?|jaw|chin|forehead|temples?|ears?|eyes?|nose|lips?|mouth|wrists?|hands?|palms?|fingers?|knuckles?|forearms?|arms?|chest|waist|midriff|tummy|abdomen|hips?|thighs?|legs?|knees?|calves|calf|ankles?|feet|foot|soles?|heels?|toes?|back|spine|tail|wings?|horns?|stomach|belly|navel|face|dress|skirt|blouse|shirt|sweater|collar|neckline|sleeves?|stockings?|lace|hem|bodice|corset|bra|scarf|coat|jacket)\b/gi;

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
interface ResolvedTargetOwner {
  readonly targetCharacterId?: string;
}

interface FocusTargetCandidate extends ResolvedTargetOwner {
  readonly index: number;
  readonly end: number;
  readonly target: string;
  readonly intimate: boolean;
  readonly region?: string;
}

interface FocusSenseCandidate extends IndexedRegexMatch {
  readonly sense: SensoryFocusSense;
}

const OTHER_OWNER_TOKENS = ["your", "her", "his", "their"] as const;
const OTHER_OWNER_TOKEN_SET: ReadonlySet<string> = new Set(OTHER_OWNER_TOKENS);
const SELF_OWNER_TOKENS = new Set(["my", "our"]);
const PAIR_BARRIER_RE =
  /[.!?;:\n]|\b(?:while|whereas|although|because|unless|before|after|as|but|yet)\b|\band\s+(?:the|a|an|she|he|they|it|that|this|those|these)\b/iu;

function sensoryOwnerSource(context: SensoryFocusDetectionContext): string {
  const names = (context.characters ?? [])
    .flatMap((character) => [character.name, ...character.aliases])
    .map((name) => name.trim())
    .filter(Boolean)
    .sort((a, b) => b.length - a.length)
    .map((name) => `${escapeRegExp(name)}['’]s`);
  return [...OTHER_OWNER_TOKENS, ...SELF_OWNER_TOKENS, ...names].join("|");
}

function resolveSensoryOwner(
  owner: string,
  context: SensoryFocusDetectionContext,
): ResolvedTargetOwner | null {
  const token = normalizeChatEvidenceText(owner).trim().replace(/'s$/iu, "").toLowerCase();
  if (SELF_OWNER_TOKENS.has(token)) return null;
  const named = (context.characters ?? []).find(
    (character) =>
      character.name.trim().toLowerCase() === token ||
      character.aliases.some((alias) => alias.trim().toLowerCase() === token),
  );
  if (named) return { targetCharacterId: named.id };
  if (!OTHER_OWNER_TOKEN_SET.has(token)) return null;
  if (context.characters === undefined) return {};
  const sole = context.characters.length === 1 ? context.characters[0] : undefined;
  return sole ? { targetCharacterId: sole.id } : null;
}

function targetOwner(
  sentence: string,
  match: IndexedRegexMatch,
  context: SensoryFocusDetectionContext,
): ResolvedTargetOwner | null {
  const source = sensoryOwnerSource(context);
  const left = sentence.slice(Math.max(0, match.index - 80), match.index);
  // Allow a short adjective/material phrase between the owner and noun:
  // "her dark silk dress". Resolve the nearest owner token so the `your` in
  // "run my fingers along your collarbone" beats the earlier `my`.
  const ownerMatcher = new RegExp(`\\b(${source})\\b`, "giu");
  const ownerMatches = [...left.matchAll(ownerMatcher)];
  const nearest = ownerMatches.at(-1);
  if (nearest?.index !== undefined && nearest[0] && nearest[1]) {
    const afterOwner = left.slice(nearest.index + nearest[0].length);
    if (/^(?:\s+[\p{L}'-]+){0,3}\s*$/iu.test(afterOwner)) {
      return resolveSensoryOwner(nearest[1], context);
    }
  }
  // Partitive nouns keep the named region as the focus: "the sole of her foot"
  // returns `sole`, with ownership proved by the phrase to its right.
  const right = sentence.slice(match.end, Math.min(sentence.length, match.end + 60));
  const partitive = new RegExp(`^\\s+(?:of|on|at)\\s+(?:the\\s+)?(${source})\\b`, "iu").exec(right)?.[1];
  return partitive ? resolveSensoryOwner(partitive, context) : null;
}

function sensoryTargets(
  sentence: string,
  context: SensoryFocusDetectionContext,
): readonly FocusTargetCandidate[] {
  const candidates: FocusTargetCandidate[] = [];
  for (const [pattern, intimate] of [
    [INTIMATE_TARGET_RE, true],
    [BODY_TARGET_RE, false],
  ] as const) {
    for (const match of indexedMatches(sentence, pattern)) {
      const owner = targetOwner(sentence, match, context);
      if (!owner) continue;
      const target = match.text.toLowerCase();
      const region = intimate
        ? INTIMATE_REGION_BY_NOUN[target]
        : GARMENT_NOUNS.has(target)
          ? undefined
          : (EVERYDAY_REGION_BY_NOUN[target] ?? target);
      candidates.push({
        index: match.index,
        end: match.end,
        target,
        intimate,
        ...(region ? { region } : {}),
        ...(owner.targetCharacterId ? { targetCharacterId: owner.targetCharacterId } : {}),
      });
    }
  }
  return candidates;
}

function playerPerformsSenseAction(
  sentence: string,
  candidate: FocusSenseCandidate,
  context: SensoryFocusDetectionContext,
): boolean {
  const before = sentence.slice(0, candidate.index);
  const clause = before.split(/[,;:]|\b(?:and|but|while|whereas|as|then)\b/iu).at(-1) ?? before;
  const namedSubjects = (context.characters ?? [])
    .flatMap((character) => [character.name, ...character.aliases])
    .map((name) => name.trim())
    .filter(Boolean)
    .sort((a, b) => b.length - a.length)
    .map(escapeRegExp);
  const thirdPersonSource = ["she", "he", "they", "you", ...namedSubjects].join("|");
  if (new RegExp(`\\b(?:${thirdPersonSource})(?:\\s+[\\p{L}'-]+){0,3}\\s*$`, "iu").test(clause)) return false;
  const throughCandidate = sentence.slice(0, candidate.end);
  if (/\b(?:i|we|my|our)\b/iu.test(throughCandidate)) return true;
  // Leading participial narration is common RP grammar: "Touching her cheek, I
  // smile." It is still player-owned when the sentence supplies a first-person
  // subject immediately afterward.
  return candidate.index === 0 && /\b(?:i|we)\b/iu.test(sentence.slice(candidate.end));
}

function locallyBound(candidate: FocusSenseCandidate, target: FocusTargetCandidate, sentence: string): boolean {
  const betweenStart = Math.min(candidate.end, target.end);
  const betweenEnd = Math.max(candidate.index, target.index);
  const between = sentence.slice(betweenStart, betweenEnd);
  if (PAIR_BARRIER_RE.test(between)) return false;
  const wordCount = between.split(/\s+/u).filter(Boolean).length;
  return wordCount <= 8;
}

function senseCandidates(sentence: string): readonly FocusSenseCandidate[] {
  const candidates: FocusSenseCandidate[] = [];
  for (const [sense, pattern] of [
    ["smell", SMELL_RE],
    ["taste", TASTE_RE],
    ["touch", TOUCH_FOCUS_RE],
    ["study", STUDY_RE],
  ] as const) {
    candidates.push(...indexedMatches(sentence, pattern).map((match) => ({ ...match, sense })));
  }
  return candidates.sort((a, b) => a.index - b.index);
}

export function detectSensoryFocus(
  input: string,
  context: SensoryFocusDetectionContext = {},
): SensoryFocusHint | null {
  if (context.narratorInput) return null;
  for (const { text: rawSentence } of chatEvidenceSentences(input, ["narration"])) {
    const sentence = normalizeChatEvidenceText(rawSentence);
    const targets = sensoryTargets(sentence, context);
    if (!targets.length) continue;
    for (const candidate of senseCandidates(sentence)) {
      const flags = chatEvidenceCandidateFlags(sentence, candidate.index);
      if (flags.question || flags.negated || flags.irrealis || flags.historical) continue;
      if (!playerPerformsSenseAction(sentence, candidate, context)) continue;
      const target = targets
        .filter((entry) => locallyBound(candidate, entry, sentence))
        .sort((a, b) => {
          const distanceA = Math.max(a.index - candidate.end, candidate.index - a.end, 0);
          const distanceB = Math.max(b.index - candidate.end, candidate.index - b.end, 0);
          return distanceA - distanceB || a.index - b.index;
        })[0];
      if (!target) continue;
      const hint: SensoryFocusHint = {
        sense: candidate.sense,
        target: target.target,
        intimate: target.intimate,
        ...(target.region ? { region: target.region } : {}),
        ...(target.targetCharacterId ? { targetCharacterId: target.targetCharacterId } : {}),
      };
      return context.characters !== undefined ? { ...hint, source: "player_narration" } : hint;
    }
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
 * Deterministic mention/spoken-to stamping:
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
