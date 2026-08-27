/**
 * R5 slice 2 — deterministic input admission: map a player's PROSE onto the
 * typed legal command set BEFORE the turn prepares, so "I hand her the
 * keepsake" executes a real transfer instead of being portrayed as an attempt.
 * Deterministic by ruling (the budget line: one narrator call per turn, zero
 * routine state-agent calls) — this is pattern matching against the world's
 * ACTUAL surface (items the player holds, zones that exist, actions in the
 * catalog), never a model call and never a guess: when nothing matches
 * confidently, the answer is null and the narrator portrays an attempt exactly
 * as before. A wrongly-admitted command would be a real world write, so every
 * rule here prefers silence over cleverness.
 */

export interface AdmissionSurface {
  /** Items currently HELD by the player actor — the only things they can hand over. */
  heldItems: readonly { itemId: string; name: string }[];
  /** The branch's zones; kinds seed the movement vocabulary (home/house, square/plaza…). */
  zones: readonly { zoneId: string; kind: string }[];
  /** Action-definition ids in the world's catalog; ids containing "rest" admit rest verbs. */
  actionDefinitionIds: readonly string[];
}

export type AdmittedCommand =
  | { kind: "give_item"; itemId: string; itemName: string }
  | { kind: "move"; toZoneId: string; placeWord: string }
  /**
   * A walk-with-me invite: the player asks the co-present primary to travel
   * together. Carries the same zone fields a `move` does, so a NOT-co-present
   * admission converts to a plain solo move cheaply.
   */
  | { kind: "accompany"; toZoneId: string; placeWord: string }
  | { kind: "start_activity"; actionDefinitionId: string; verb: string };

/**
 * Words that name a zone, by zone KIND — grows as world templates grow.
 *
 * `market` moved off `plaza` when the starter world grew a real market zone
 * (B8): a kind must not claim another kind's word, or "I walk to the market"
 * silently admits a move to the square.
 */
const ZONE_KIND_WORDS: Record<string, readonly string[]> = {
  home: ["home", "house", "indoors", "inside"],
  plaza: ["square", "plaza", "town"],
  market: ["market", "stall", "stalls"],
  town: ["town"],
};

const GIVE_VERBS = /\b(give|gives|hand|hands|pass|passes)\b/;
const MOVE_VERBS = /\b(go|goes|walk|walks|head|heads|run|runs|leave|leaves|step|steps)\b/;
const REST_VERBS = /\b(rest|rests|sleep|sleeps|nap|naps|lie down|lies down|turn in|turns in)\b/;
/**
 * The walk-with-me markers: first-person PLURAL or invite phrasing ("let's walk
 * to the square", "we head home", "walk with me…", "come with me…"). `come` joins
 * the move verbs here because "come with me" is the canonical invite.
 */
const ACCOMPANY_LEADS = /\blet'?s\b|\blet us\b|\bwe\b|\bwith me\b/;
const ACCOMPANY_VERBS = /\b(go|goes|come|comes|walk|walks|head|heads|run|runs|leave|leaves|step|steps)\b/;

/** Strip quoted spans — words SPOKEN are never words ACTED ("let's walk later"). */
function stripQuotes(utterance: string): string {
  return utterance.replace(/"[^"]*"/g, " ").replace(/“[^”]*”/g, " ").replace(/'[^']*'/g, " ");
}

/** The unquoted sentences of an utterance, lowercased (words SPOKEN are already stripped). */
function sentencesOf(utterance: string): string[] {
  return stripQuotes(utterance)
    .toLowerCase()
    .split(/[.!?\n]+/)
    .map((sentence) => sentence.trim())
    .filter((sentence) => sentence.length > 0);
}

/**
 * The sentences the player narrates THEMSELVES doing: unquoted, containing a
 * first-person subject. Everything else (dialogue, questions to the
 * character, second-person suggestions) is out of admission's reach.
 */
function firstPersonSentences(utterance: string): string[] {
  return sentencesOf(utterance).filter((sentence) => /(^|\W)i\b/.test(sentence));
}

/** Case-insensitive whole-word presence of any ≥4-char word of `name` in `sentence`. */
function nameWordIn(sentence: string, name: string): boolean {
  return name
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((word) => word.length >= 4)
    .some((word) => new RegExp(`\\b${word}\\b`).test(sentence));
}

/** The zone whose kind-word appears in `sentence`, plus the matched word — else null. */
function zoneWordIn(
  sentence: string,
  zones: readonly { zoneId: string; kind: string }[],
): { zoneId: string; word: string } | null {
  for (const zone of zones) {
    const words = ZONE_KIND_WORDS[zone.kind] ?? [];
    const word = words.find((candidate) => new RegExp(`\\b${candidate}\\b`).test(sentence));
    if (word) return { zoneId: zone.zoneId, word };
  }
  return null;
}

/**
 * Admit at most ONE command from one utterance. Priority: give (most specific:
 * names a held item) → accompany (a plural/invite over a known place) → move
 * (names a place, first person) → rest. Null when nothing matches with
 * confidence. Accompany precedes solo move so "let's walk to the square" reads
 * as an invite, not a self-move — but it draws on a broader sentence set (no
 * first-person "I" required), so a plain "I walk to the square" still admits a move.
 */
export function admitPlayerCommand(utterance: string, surface: AdmissionSurface): AdmittedCommand | null {
  const sentences = firstPersonSentences(utterance);
  const allSentences = sentencesOf(utterance);
  if (allSentences.length === 0) return null;

  for (const sentence of sentences) {
    if (!GIVE_VERBS.test(sentence)) continue;
    const item = surface.heldItems.find((held) => nameWordIn(sentence, held.name));
    if (item) return { kind: "give_item", itemId: item.itemId, itemName: item.name };
  }

  for (const sentence of allSentences) {
    if (!ACCOMPANY_LEADS.test(sentence) || !ACCOMPANY_VERBS.test(sentence)) continue;
    const zone = zoneWordIn(sentence, surface.zones);
    if (zone) return { kind: "accompany", toZoneId: zone.zoneId, placeWord: zone.word };
  }

  for (const sentence of sentences) {
    if (!MOVE_VERBS.test(sentence)) continue;
    const zone = zoneWordIn(sentence, surface.zones);
    if (zone) return { kind: "move", toZoneId: zone.zoneId, placeWord: zone.word };
  }

  for (const sentence of sentences) {
    const verb = REST_VERBS.exec(sentence)?.[0];
    if (!verb) continue;
    const actionDefinitionId = surface.actionDefinitionIds.find((id) => id.includes("rest"));
    if (actionDefinitionId) return { kind: "start_activity", actionDefinitionId, verb };
  }

  return null;
}
