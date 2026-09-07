import {
  AFFORDANCE_CUES_PER_EXCHANGE,
  emptyAffordanceCueState,
  type AffordanceCueState,
} from "@/contracts/affordances/core";
import type { AffordanceRead } from "@/contracts/affordances/derive-affordance-read";
import { characterProfileSchema, type CharacterProfile } from "@/contracts/world/profile";
import { emptyChatSceneMemory, type ChatSceneMemory } from "@/contracts/turns/chat-scene-memory";
import { bodySurfaceWetnessAt, type BodySurfaceState } from "@/contracts/state/body-surface";
import { surfaceDryingSuspended } from "@/contracts/turns/chat-surface-ops";
import {
  hairAttributeFixture,
  type HairAttributeFixtureInput,
} from "@/contracts/affordances/domains/hair/fixtures";
import {
  AFFORDANCE_CUE_BLOCK_HEADING,
  buildChatAffordanceRead,
  buildCharacterChatSystemPrompt,
  chatAffordanceCueCarveOut,
  deriveChatSensoryAllowance,
  detectChatCue,
  detectSensoryFocus,
  narrationShapeId,
  type CharacterChatPromptInput,
  type ChatSensoryAllowance,
  type ChatTurn,
} from "@/server/engine";
// The ONE deep import in this harness: `chat-affordance-cues` is intra-module in
// production (the live pipeline and prompt preview call it) and is not on the engine
// barrel. The trial has to call the real projection — reimplementing it would
// mean measuring the harness's prose instead of the product's — so the barrel
// rule is waived here rather than widening the module's public surface for an
// eval. Promote it to `src/server/engine/index.ts` if another caller ever needs it.
// eslint-disable-next-line no-restricted-imports
import { renderChatAffordanceCues } from "@/server/engine/chat-affordance-cues";
import {
  evalCharacterById,
  type EvalCharacter,
  type EvalScenario,
  type EvalTurn,
} from "./fixtures";

/**
 * The trial's PURE half: turn a fixture exchange into the two arms' prompts.
 *
 * Everything load-bearing runs through the production code it is measuring —
 * `buildChatAffordanceRead` (the chat-lane adapter), `renderChatAffordanceCues`
 * (cue projection), `deriveChatSensoryAllowance` (the per-turn allowance the
 * route derives from the player's line) and `buildCharacterChatSystemPrompt`
 * (the narrator prompt). Nothing about the cue path is re-implemented here; if
 * it were, the trial would be measuring the harness.
 *
 * What this DOESN'T reuse is the pipeline's database-bound assembly
 * (`chat-pipeline.ts`: state load, RAG recall, wardrobe resolution, the fan-out).
 * Those need Postgres, and none of them differ between the arms — so the state
 * slice is built here instead, once, and handed to BOTH arms byte-identically.
 * The differences between the arms are `state.affordanceCues` and, on a
 * `none`-allowance turn that carries cues, the allowance line's carve-out
 * sentence (owner ruling 2026-07-28: "cues win") — see `stripCueCarveOut`.
 *
 * Pure: no IO, no clock, no randomness. `runTurn` in `run.ts` owns the live call.
 */

/** The block heading — the prompt builder's own constant, never a copy. */
export const CUE_HEADING = AFFORDANCE_CUE_BLOCK_HEADING;

export type ArmId = "cues" | "control";

// ---------------------------------------------------------------------------
// Per-turn state assembly
// ---------------------------------------------------------------------------

/** The hair this exchange actually has: cast default < scenario override < turn override. */
export function resolveHair(
  character: EvalCharacter,
  scenario: EvalScenario,
  turn: EvalTurn,
): HairAttributeFixtureInput {
  return { ...character.hair, ...scenario.hair, ...turn.hair };
}

/**
 * The profile the narrator sees THIS exchange. Rebuilt per turn so a mid-scene
 * style change moves the prompt's Attributes section and the affordance read
 * together — a cue that disagreed with the Attributes block would be a harness
 * bug masquerading as a contradiction.
 */
export function turnProfile(character: EvalCharacter, hair: HairAttributeFixtureInput): CharacterProfile {
  return characterProfileSchema.parse({
    ...character.profile,
    attributes: [
      ...hairAttributeFixture(hair),
      { id: "identity.gender", value: "female", source: "creation" },
    ],
  });
}

function bodySurface(turn: EvalTurn): BodySurfaceState {
  if (!turn.wetness) return { wetness: {} };
  const { level, updatedAtMinutes, cause } = turn.wetness;
  return { wetness: { hair: { level, updatedAtMinutes, ...(cause === undefined ? {} : { cause }) } } };
}

/**
 * The scene block both arms get, byte for byte: the place, its standing detail,
 * and the scenario's `sceneFacts`.
 *
 * `sceneFacts` is the rematch-v2 BOTH-ARMS CHANNEL. The narrator prompt carries
 * no environment line and no wetness line: outside the cue block, the only things
 * that tell either arm what is physically true are the premise, the outfit
 * phrase, the player's lines and this list. Round R1's control arm therefore
 * could not misattribute a wetness it had never been told about — it stayed
 * vague, stayed clean, and the induction gate failed. Folding the scene's
 * standing facts in here (the storm at the window, the squall an hour gone, the
 * hood knotted since they cast off) gives the CONTROL arm something true to get
 * wrong, symmetrically with the cue arm.
 *
 * They are place details, so they land in the prompt's Scene block identically
 * for both arms — the splice self-check still proves the arms differ by the cue
 * block alone.
 */
function sceneMemory(scenario: EvalScenario): ChatSceneMemory {
  return {
    ...emptyChatSceneMemory(),
    current: scenario.place,
    places: [
      {
        name: scenario.place,
        details: [scenario.placeDetail, ...(scenario.sceneFacts ?? [])],
        connections: [],
      },
    ],
  };
}

// ---------------------------------------------------------------------------
// The read
// ---------------------------------------------------------------------------

export interface TurnRead {
  readonly read: AffordanceRead;
  readonly cueLines: readonly string[];
  readonly nextCues: AffordanceCueState;
  /** Wetness the read actually saw, after lazy drying — 0…10_000, or null when quarantined. */
  readonly wetnessLevel: number | null;
}

/**
 * The affordance read for this exchange, exactly as the pipeline takes it: the
 * committed pre-fan-out cut (this turn's state, this turn's environment, this
 * turn's wardrobe rows) plus the cue memory carried forward from the previous
 * exchange, which is what makes the repeat gate observable across turns.
 */
export function readTurn(input: {
  character: EvalCharacter;
  scenario: EvalScenario;
  turn: EvalTurn;
  previousCues: AffordanceCueState;
}): TurnRead {
  const { character, scenario, turn } = input;
  const hair = resolveHair(character, scenario, turn);
  const worn = turn.worn ?? scenario.worn;
  const surface = bodySurface(turn);
  const result = buildChatAffordanceRead({
    subjectId: character.id,
    attributes: hairAttributeFixture(hair),
    wardrobe: { worn: [...worn] },
    bodySurface: surface,
    environment: turn.environment,
    clockMinutes: turn.clockMinutes,
    previousCues: input.previousCues,
  });
  const wetness = bodySurfaceWetnessAt(surface, "hair", turn.clockMinutes, {
    suspendDrying: surfaceDryingSuspended(turn.environment),
  });
  return {
    read: result.read,
    cueLines: renderChatAffordanceCues({
      cues: result.read.cues,
      attributes: result.attributes,
      possessive: `${character.name}'s`,
    }),
    nextCues: result.nextCues,
    wetnessLevel: wetness.status === "known" ? wetness.level : null,
  };
}

// ---------------------------------------------------------------------------
// The prompt
// ---------------------------------------------------------------------------

export const PLAYER_NAME = "Sam";

const PLAYER_PERSONA =
  "A bookbinder who moved back to the river three months ago and has not decided how long they are staying.";

/**
 * The one binding per-turn appearance ceiling the route derives from the player's
 * line (`none` / `visual_accent` / `close_range_hook`). Recorded per exchange
 * because it is the prompt element the cue block most plausibly argues with: on a
 * `none` turn the prompt simultaneously says "no appearance description" and
 * offers a physical detail to weave in.
 */
export function turnAllowance(playerMessage: string): ChatSensoryAllowance {
  return deriveChatSensoryAllowance({
    cue: detectChatCue(playerMessage),
    sensoryFocus: detectSensoryFocus(playerMessage),
  });
}

export interface BuildPromptInput {
  character: EvalCharacter;
  scenario: EvalScenario;
  turn: EvalTurn;
  turnIndex: number;
  /** Cue lines to inject; `[]` is the control arm AND a cue arm the read silenced. */
  cueLines: readonly string[];
}

/** The narrator system prompt for one arm of one exchange. */
export function buildArmPrompt(input: BuildPromptInput): string {
  const { character, scenario, turn, turnIndex } = input;
  const hair = resolveHair(character, scenario, turn);
  const profile = turnProfile(character, hair);
  const promptInput: CharacterChatPromptInput = {
    name: character.name,
    profile,
    player: { name: PLAYER_NAME, persona: PLAYER_PERSONA },
    state: {
      meters: {},
      regard: scenario.regard,
      familiarity: scenario.familiarity,
      conditions: [],
      premise: scenario.premise,
      outfit: turn.outfit ?? scenario.outfit,
      outfitExposed: false,
      sceneMemory: sceneMemory(scenario),
      storyMoment: storyMoment(turn.clockMinutes),
      ...(input.cueLines.length > 0 ? { affordanceCues: [...input.cueLines] } : {}),
    },
    narrationShape: narrationShapeId("chat"),
    sensoryAllowance: turnAllowance(turn.player),
    firstExchange: turnIndex === 0,
  };
  return buildCharacterChatSystemPrompt(promptInput);
}

/** "2:02pm (afternoon)" — the same shape `formatStoryMoment` renders, without the calendar anchor. */
function storyMoment(clockMinutes: number): string {
  const minute = ((clockMinutes % 1_440) + 1_440) % 1_440;
  const hour24 = Math.floor(minute / 60);
  const hour12 = hour24 % 12 === 0 ? 12 : hour24 % 12;
  const suffix = hour24 < 12 ? "am" : "pm";
  const band = hour24 < 5 ? "night" : hour24 < 12 ? "morning" : hour24 < 17 ? "afternoon" : hour24 < 22 ? "evening" : "night";
  return `${hour12}:${String(minute % 60).padStart(2, "0")}${suffix} (${band})`;
}

/** The model history for this arm: every prior exchange of THIS arm, oldest first. */
export function armHistory(
  scenario: EvalScenario,
  replies: readonly string[],
  turnIndex: number,
): ChatTurn[] {
  const history: ChatTurn[] = [];
  for (let index = 0; index < turnIndex; index += 1) {
    const turn = scenario.turns[index];
    const reply = replies[index];
    if (!turn || reply === undefined) continue;
    history.push({ role: "user", content: turn.player });
    history.push({ role: "assistant", content: reply });
  }
  const current = scenario.turns[turnIndex];
  if (current) history.push({ role: "user", content: current.player });
  return history;
}

// ---------------------------------------------------------------------------
// Ground truth for the judge
// ---------------------------------------------------------------------------

const WETNESS_WORD = (level: number): string =>
  level >= 8_000 ? "soaked" : level >= 4_000 ? "wet" : level >= 1_500 ? "damp" : level > 0 ? "barely damp" : "dry";

/**
 * The committed physical state in plain English — what the contradiction judge
 * scores against. Deliberately free of the RENDERED CUE LINES: a judge that could
 * see the cue block would know instantly which arm was which, and the blinding
 * would be theatre.
 */
export function groundTruth(input: {
  character: EvalCharacter;
  scenario: EvalScenario;
  turn: EvalTurn;
  wetnessLevel: number | null;
}): string {
  const { character, scenario, turn } = input;
  const hair = resolveHair(character, scenario, turn);
  const worn = turn.worn ?? scenario.worn;
  const headwear = worn.filter((item) => item.coverage.includes("hair"));
  const environment = turn.environment;
  const level = input.wetnessLevel ?? 0;
  const lines = [
    `Hair: ${hair.color ?? "unstated"}, ${hair.length.replace(/_/gu, " ")}, ${hair.density}, ${hair.strandThickness} strands, ${hair.texture}, condition ${hair.condition}. Worn ${hair.arrangement}.`,
    `Wetness of the hair: ${WETNESS_WORD(level)}.`,
    `On her head: ${headwear.length ? headwear.map((item) => `${item.name} (${item.opacity})`).join(", ") : "nothing"}.`,
    `Scene: ${environment.indoors ? "indoors" : "outdoors"}; wind ${environment.wind}; precipitation ${environment.precipitation}.`,
    "",
    "Facts that follow from the above. The reply must not contradict any of them:",
    ...turn.facts.map((fact) => `- ${fact}`),
  ];
  return lines.join("\n");
}

export function scenarioCharacter(scenario: EvalScenario): EvalCharacter {
  return evalCharacterById(scenario.characterId);
}

// ---------------------------------------------------------------------------
// Mechanical (model-free) metrics
// ---------------------------------------------------------------------------

const HAIR_WORDS =
  /\b(hair|strands?|tresses|locks?|braid(?:ed|s)?|plait(?:ed|s)?|ponytail|bun|curls?|fringe|bangs?|scalp|hairline)\b/giu;

const STOP_WORDS = new Set([
  "the", "a", "an", "and", "or", "but", "of", "to", "in", "on", "at", "it", "its", "is", "was", "her", "his",
  "she", "he", "they", "with", "as", "that", "this", "for", "from", "by", "into", "over", "under", "then",
  "still", "just", "like", "up", "down", "out", "off", "back", "one", "not", "no", "has", "had", "have",
]);

/** Sentences that talk about hair at all — the unit both repetition proxies work over. */
export function hairSentences(reply: string): string[] {
  return reply
    .split(/(?<=[.!?…])\s+|\n+/u)
    .map((sentence) => sentence.trim())
    .filter((sentence) => sentence.length > 0 && new RegExp(HAIR_WORDS.source, "iu").test(sentence));
}

export function hairMentionCount(reply: string): number {
  return (reply.match(HAIR_WORDS) ?? []).length;
}

function contentWords(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .replace(/[^a-z\s]/gu, " ")
      .split(/\s+/u)
      .filter((word) => word.length > 2 && !STOP_WORDS.has(word)),
  );
}

/**
 * Lexical overlap between the hair talk of consecutive replies — a cheap,
 * model-free proxy for "the same hair detail re-stated across exchanges".
 * Returns null when either exchange said nothing about hair (no overlap to
 * measure, and scoring silence as 0 would reward a transcript for saying less).
 */
export function hairOverlap(previous: string, current: string): number | null {
  const before = contentWords(hairSentences(previous).join(" "));
  const after = contentWords(hairSentences(current).join(" "));
  if (before.size === 0 || after.size === 0) return null;
  let shared = 0;
  for (const word of after) if (before.has(word)) shared += 1;
  const union = new Set([...before, ...after]).size;
  return union === 0 ? null : shared / union;
}

/**
 * Does any cue line merely restate what the prompt ALREADY says elsewhere
 * (the Attributes section, the outfit phrase)? The plan's "stable appearance and
 * affordance cues must not duplicate one another", checked mechanically: a cue's
 * distinguishing clause must not appear verbatim in the rest of the prompt.
 */
export function cueDuplicatesPrompt(prompt: string, cueLines: readonly string[]): string[] {
  if (cueLines.length === 0) return [];
  const withoutBlock = stripCueBlock(prompt).toLowerCase();
  return cueLines.filter((line) => {
    const clause = line.split(",")[0]?.trim().toLowerCase() ?? "";
    return clause.length > 0 && withoutBlock.includes(clause);
  });
}

/** The prompt with the affordance cue block removed. */
export function stripCueBlock(prompt: string): string {
  const start = prompt.indexOf(`\n\n${CUE_HEADING}`);
  if (start < 0) return prompt;
  const end = prompt.indexOf("\n\n", start + 2 + CUE_HEADING.length);
  return `${prompt.slice(0, start)}${end < 0 ? "" : prompt.slice(end)}`;
}

/**
 * The prompt with the sensory-allowance carve-out removed (the sentence the
 * "cues win" ruling appends to a `none` allowance when cue lines are present).
 * `stripCueBlock` + `stripCueCarveOut` together reproduce the control arm's
 * prompt byte-for-byte — the splice self-checks assert exactly that, so any
 * third arm-delta the prompt builder ever grows shows up as a red check, not
 * as an invisible confound in the trial.
 */
export function stripCueCarveOut(prompt: string, characterName: string): string {
  return prompt.replace(chatAffordanceCueCarveOut(characterName), "");
}

export { AFFORDANCE_CUES_PER_EXCHANGE, emptyAffordanceCueState };
