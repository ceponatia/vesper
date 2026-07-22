/**
 * R5 slice 2 (engine.rollout.plan.md) — deterministic input admission: map a
 * player's PROSE onto the typed legal command set BEFORE the turn prepares,
 * so "I hand her the keepsake" executes a real transfer instead of being
 * portrayed as an attempt. Deterministic by ruling (the budget line: one
 * narrator call per turn, zero routine state-agent calls) — this is pattern
 * matching against the world's ACTUAL surface (items the player holds, zones
 * that exist, actions in the catalog), never a model call and never a guess:
 * when nothing matches confidently, the answer is null and the narrator
 * portrays an attempt exactly as before. A wrongly-admitted command would be
 * a real world write, so every rule here prefers silence over cleverness.
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
  | { kind: "start_activity"; actionDefinitionId: string; verb: string };

/** Words that name a zone, by zone KIND — grows as world templates grow. */
const ZONE_KIND_WORDS: Record<string, readonly string[]> = {
  home: ["home", "house", "indoors", "inside"],
  plaza: ["square", "plaza", "market", "town"],
  town: ["town"],
};

const GIVE_VERBS = /\b(give|gives|hand|hands|pass|passes)\b/;
const MOVE_VERBS = /\b(go|goes|walk|walks|head|heads|run|runs|leave|leaves|step|steps)\b/;
const REST_VERBS = /\b(rest|rests|sleep|sleeps|nap|naps|lie down|lies down|turn in|turns in)\b/;

/** Strip quoted spans — words SPOKEN are never words ACTED ("let's walk later"). */
function stripQuotes(utterance: string): string {
  return utterance.replace(/"[^"]*"/g, " ").replace(/“[^”]*”/g, " ").replace(/'[^']*'/g, " ");
}

/**
 * The sentences the player narrates THEMSELVES doing: unquoted, containing a
 * first-person subject. Everything else (dialogue, questions to the
 * character, second-person suggestions) is out of admission's reach.
 */
function firstPersonSentences(utterance: string): string[] {
  return stripQuotes(utterance)
    .toLowerCase()
    .split(/[.!?\n]+/)
    .map((sentence) => sentence.trim())
    .filter((sentence) => /(^|\W)i\b/.test(sentence));
}

/** Case-insensitive whole-word presence of any ≥4-char word of `name` in `sentence`. */
function nameWordIn(sentence: string, name: string): boolean {
  return name
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((word) => word.length >= 4)
    .some((word) => new RegExp(`\\b${word}\\b`).test(sentence));
}

/**
 * Admit at most ONE command from one utterance. Priority: give (most
 * specific: names a held item) → move (names a place) → rest. Null when
 * nothing matches with confidence.
 */
export function admitPlayerCommand(utterance: string, surface: AdmissionSurface): AdmittedCommand | null {
  const sentences = firstPersonSentences(utterance);
  if (sentences.length === 0) return null;

  for (const sentence of sentences) {
    if (!GIVE_VERBS.test(sentence)) continue;
    const item = surface.heldItems.find((held) => nameWordIn(sentence, held.name));
    if (item) return { kind: "give_item", itemId: item.itemId, itemName: item.name };
  }

  for (const sentence of sentences) {
    if (!MOVE_VERBS.test(sentence)) continue;
    for (const zone of surface.zones) {
      const words = ZONE_KIND_WORDS[zone.kind] ?? [];
      const word = words.find((candidate) => new RegExp(`\\b${candidate}\\b`).test(sentence));
      if (word) return { kind: "move", toZoneId: zone.zoneId, placeWord: word };
    }
  }

  for (const sentence of sentences) {
    const verb = REST_VERBS.exec(sentence)?.[0];
    if (!verb) continue;
    const actionDefinitionId = surface.actionDefinitionIds.find((id) => id.includes("rest"));
    if (actionDefinitionId) return { kind: "start_activity", actionDefinitionId, verb };
  }

  return null;
}
