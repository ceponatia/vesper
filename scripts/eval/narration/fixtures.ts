import type { ModelMessage } from "ai";
import { defaultExposureMask, emptyBrief, type ExposureMask } from "../../../src/contracts/state/brief";
import type { NarrationFocus } from "../../../src/contracts/turns/intent-brief";
import { characterProfileSchema } from "../../../src/contracts/world/profile";
import { buildCharacterChatSystemPrompt } from "../../../src/server/engine/prompts/character-chat";
import type { NarrationShapeId } from "../../../src/server/engine/prompts/constants";
import { buildStaticRulebook, buildTurnContext } from "../../../src/server/engine/prompts/narrative";
import { buildReactionLine, buildResponseShape, evaluatePrimaryReaction, type ReactionLineInput } from "../../../src/server/engine/scene";

/**
 * Golden-scenario fixtures for the narration eval harness (narrator-prompt-focus.plan.md
 * §Behavioral eval harness + §Golden eval scenarios). Each scenario assembles a
 * **real** prompt through the actual builders — `buildStaticRulebook` /
 * `buildTurnContext` / `buildResponseShape` / `buildReactionLine` (session lane) and
 * `buildCharacterChatSystemPrompt` (chat lane) — so the matrix exercises the shipped
 * Phase-1/2/3 surface, not a mock.
 *
 * The Phase-1/2/3 surface under test (the shape profile in the rulebook, the
 * "## Response shape" steers, the "## Reaction" line) is produced by the real
 * builders here. The surrounding "scenery" blocks (scene snapshot, presence roster,
 * wardrobe) are hand-authored fixture strings — faithful enough as prompt context
 * without standing up a full DB-backed `SceneBundleInput`.
 *
 * `build(shape, { focus })` lets the runner sweep both shape profiles and toggle the
 * §Phase-3 planner off (`--no-focus`) for a Phase-2-vs-Phase-3 A/B.
 */

export interface EvalScenario {
  id: string;
  title: string;
  lane: "session" | "chat";
  /** What a good narration does — printed beside the score and fed to the judge. */
  expectation: string;
  /** The player's input for this turn — fed to the judge. */
  playerInput: string;
  /** Speaker-tag vocabulary for the segmenter's distinct-speaker metric. */
  knownNames: string[];
  /** The authored "## Reaction" verdict (if any) — the judge cross-checks proportionality against it. */
  authoredReaction?: string;
  /**
   * The scenario deliberately makes a sense salient (closeness/approach/intimacy), so a
   * single natural sensory hook is *welcome* here (character-chat-sensory.plan.md). Flips on
   * the opt-in deterministic "used a sensory cue" metric (`run.ts`). Absent ⇒ the metric is
   * not reported — most turns should mention nothing, so it's never a universal score.
   */
  sensoryRelevant?: boolean;
  build: (shape: NarrationShapeId, opts: { focus: boolean }) => { system: string; messages: ModelMessage[] };
}

const CLOCK = "Saturday, June 7, 2025 — 7:12pm";

const WORLD = {
  worldName: "Harbor House",
  synopsis: "A weathered seaside guesthouse where a small cast crosses paths over a slow summer.",
  styleDirectives: ["Grounded, sensory contemporary tone", "Slow-burn pacing"],
};

interface SessionOpts {
  npcNames: string[];
  canonicalFactsBlock?: string;
  dispositionBlock?: string;
  sceneSnapshot: string;
  presenceRoster: string;
  wardrobeBlock: string;
  /** Extra state-block fragments (reaction line, relationships) — joined with the base. */
  stateExtra?: string[];
  responseShape?: string;
  directives?: string[];
  openThreads?: Array<{ title: string; summary: string }>;
  exposure?: ExposureMask;
  playerInput: string;
}

/** Assemble a session-lane prompt through the real builders for a given shape profile. */
function sessionPrompt(shape: NarrationShapeId, o: SessionOpts): { system: string; messages: ModelMessage[] } {
  const system = buildStaticRulebook({
    worldName: WORLD.worldName,
    synopsis: WORLD.synopsis,
    styleDirectives: WORLD.styleDirectives,
    alwaysLore: [],
    factions: [],
    canonicalFactsBlock: o.canonicalFactsBlock ?? "",
    dispositionBlock: o.dispositionBlock,
    npcNames: o.npcNames,
    embodied: true,
    narrationShape: shape,
  });
  const turnContext = buildTurnContext({
    clockLine: CLOCK,
    responseShape: o.responseShape,
    sceneSnapshot: o.sceneSnapshot,
    presenceRoster: o.presenceRoster,
    wardrobeBlock: o.wardrobeBlock,
    stateBlock: (o.stateExtra ?? []).filter(Boolean).join("\n\n"),
    glanceBlock: "",
    affordancesBlock: "",
    facts: [],
    episodeSummaries: [],
    sceneLore: [],
    brief: { ...emptyBrief(), directives: o.directives ?? [] },
    openThreads: o.openThreads ?? [],
    exposure: o.exposure ?? defaultExposureMask(),
    playerInput: o.playerInput,
    author: "player",
  });
  return { system, messages: [{ role: "user", content: turnContext }] };
}

// A present NPC who likes genuine praise — scenario 2's authored disposition.
const MAYA: ReactionLineInput["presentNpcs"][number] = {
  id: "npc-maya",
  displayName: "Maya",
  tags: [],
  traits: [],
  socialCards: [],
  mood: 0.55,
  preferences: [{ target: "compliment", valence: "like", intensity: 3, hint: "warms to sincere praise but plays it cool" }],
};

const complimentReaction: ReactionLineInput = {
  playerId: "player",
  playerName: "Alex",
  presentNpcs: [MAYA],
  relationships: [{ fromParticipantId: "npc-maya", toParticipantId: "player", kind: "feeling", value: 25 }],
  worldCards: [],
  socialActs: [{ concept: "compliment", target: "Maya" }],
};
const complimentPrimary = evaluatePrimaryReaction(complimentReaction);

/** A focus planner, included unless `--no-focus` strips it (returns undefined). */
const withFocus = (focus: boolean, value: NarrationFocus): NarrationFocus | undefined => (focus ? value : undefined);

export const EVAL_SCENARIOS: EvalScenario[] = [
  {
    id: "hi-quiet-room",
    title: '"hi" in a quiet room',
    lane: "session",
    expectation:
      "A brief, in-character response. No effusive gratitude or doting. At most one light self-motivated NPC beat — never a pile of new plots, errands, or logistics.",
    playerInput: "hi",
    knownNames: ["Maya"],
    build: (shape, { focus }) =>
      sessionPrompt(shape, {
        npcNames: ["Maya"],
        canonicalFactsBlock: "## Canonical character facts\n- Maya — appears late twenties; runs the guesthouse kitchen.",
        sceneSnapshot: "## Scene: Kitchen\nWarm evening light, a kettle ticking as it cools. A long farm table, mismatched chairs.",
        presenceRoster: "## Who is where (authoritative presence roster this turn)\nPresent: Maya",
        wardrobeBlock: "## Visible wardrobe\n- Maya: faded apron over a linen shirt, sleeves pushed up",
        stateExtra: ["## Current state\n- Maya — activity: wiping down the counter, unhurried"],
        responseShape: buildResponseShape({
          actionType: "converse",
          addressedNpcs: [],
          presentNpcNames: ["Maya"],
          primaryReaction: null,
          openThreadCount: 0,
          directiveCount: 0,
          focus: withFocus(focus, { primaryResponse: "converse", reactionScale: "none", allowedNewTopic: "none", suggestedShape: "concise_exchange" }),
        }),
        playerInput: "hi",
      }),
  },
  {
    id: "compliment",
    title: '"That jacket looks good on you."',
    lane: "session",
    expectation:
      "Proportionate to the authored disposition / relationship / ## Reaction — pleased-but-measured for a warming acquaintance, not worshipful. No doting beyond what the verdict supports.",
    playerInput: "That jacket looks good on you, Maya.",
    knownNames: ["Maya"],
    authoredReaction: buildReactionLine(complimentReaction, complimentPrimary),
    build: (shape, { focus }) =>
      sessionPrompt(shape, {
        npcNames: ["Maya"],
        canonicalFactsBlock: "## Canonical character facts\n- Maya — appears late twenties; dry, self-possessed.",
        dispositionBlock: "## Disposition\n- Maya — Warmth: guarded (slow to show it); Composure: steady.",
        sceneSnapshot: "## Scene: Porch\nThe evening cooling, gulls settling. A porch swing, a railing salted white.",
        presenceRoster: "## Who is where (authoritative presence roster this turn)\nPresent: Maya",
        wardrobeBlock: "## Visible wardrobe\n- Maya: a battered denim jacket over a sundress",
        stateExtra: [
          "## Current state\n- Maya — activity: leaning on the railing, watching the water",
          buildReactionLine(complimentReaction, complimentPrimary),
        ],
        responseShape: buildResponseShape({
          actionType: "social_attempt",
          addressedNpcs: ["Maya"],
          presentNpcNames: ["Maya"],
          primaryReaction: complimentPrimary,
          openThreadCount: 0,
          directiveCount: 0,
          focus: withFocus(focus, { primaryResponse: "react_emotionally", reactionScale: "small", allowedNewTopic: "none", suggestedShape: "concise_exchange" }),
        }),
        playerInput: "That jacket looks good on you, Maya.",
      }),
  },
  {
    id: "question-with-threads",
    title: "Direct factual question while open threads exist",
    lane: "session",
    expectation:
      "Answer the question first. No unrelated logistics dump or thread-reminder list — one ambient touch is fine, an errand checklist is not.",
    playerInput: "Maya, what time does the last ferry leave tonight?",
    knownNames: ["Maya"],
    build: (shape, { focus }) =>
      sessionPrompt(shape, {
        npcNames: ["Maya"],
        canonicalFactsBlock: "## Canonical character facts\n- Maya — knows the harbor schedules by heart.",
        sceneSnapshot: "## Scene: Front desk\nA cramped lobby, a brass bell, a tide chart pinned crooked to the wall.",
        presenceRoster: "## Who is where (authoritative presence roster this turn)\nPresent: Maya",
        wardrobeBlock: "## Visible wardrobe\n- Maya: cardigan, reading glasses pushed up into her hair",
        stateExtra: ["## Current state\n- Maya — activity: reconciling the day's register"],
        openThreads: [
          { title: "The missing skiff", summary: "A guest's rented boat never came back." },
          { title: "Roof repair", summary: "The contractor keeps rescheduling." },
        ],
        responseShape: buildResponseShape({
          actionType: "converse",
          addressedNpcs: ["Maya"],
          presentNpcNames: ["Maya"],
          primaryReaction: null,
          openThreadCount: 2,
          directiveCount: 0,
          focus: withFocus(focus, { primaryResponse: "answer_question", reactionScale: "none", allowedNewTopic: "none", suggestedShape: "concise_exchange" }),
        }),
        playerInput: "Maya, what time does the last ferry leave tonight?",
      }),
  },
  {
    id: "multi-party",
    title: "Small action with several NPCs present",
    lane: "session",
    expectation:
      "Only the directly-addressed/affected NPC answers; the others may stay silent. No chorus where every present NPC chimes in or validates the player.",
    playerInput: "I slide the salt across the table to Tom.",
    knownNames: ["Maya", "Tom", "Della"],
    build: (shape, { focus }) =>
      sessionPrompt(shape, {
        npcNames: ["Maya", "Tom", "Della"],
        canonicalFactsBlock: "## Canonical character facts\n- Maya, Tom, Della — three guests sharing the long supper table.",
        sceneSnapshot: "## Scene: Dining room\nA crowded supper, steam off the chowder, low conversation.",
        presenceRoster: "## Who is where (authoritative presence roster this turn)\nPresent: Maya, Tom, Della",
        wardrobeBlock: "## Visible wardrobe\n- Maya: apron\n- Tom: oilskin half-zipped\n- Della: a wool shawl",
        stateExtra: ["## Current state\n- Tom — activity: reaching vaguely for the seasoning\n- Maya — activity: ladling\n- Della — activity: half-listening"],
        responseShape: buildResponseShape({
          actionType: "manipulate_item",
          addressedNpcs: ["Tom"],
          presentNpcNames: ["Maya", "Tom", "Della"],
          primaryReaction: null,
          openThreadCount: 0,
          directiveCount: 0,
          focus: withFocus(focus, { primaryResponse: "resolve_action", reactionScale: "none", allowedNewTopic: "none", suggestedShape: "concise_exchange" }),
        }),
        playerInput: "I slide the salt across the table to Tom.",
      }),
  },
  {
    id: "intimate-regression",
    title: "Intimate / emotionally charged beat (regression guard)",
    lane: "session",
    expectation:
      "Stay inside the moment. No errands, reminders, logistics, or unrelated topics from any character unless the player raises them. Phase 1 must not weaken the intimate-only restraint.",
    playerInput: "I rest my forehead against hers and just breathe.",
    knownNames: ["Maya"],
    build: (shape, { focus }) =>
      sessionPrompt(shape, {
        npcNames: ["Maya"],
        canonicalFactsBlock: "## Canonical character facts\n- Maya — guarded, but unmistakably close to Alex now.",
        sceneSnapshot: "## Scene: Maya's room\nRain on the glass, a single lamp, the rest of the house asleep.",
        presenceRoster: "## Who is where (authoritative presence roster this turn)\nPresent: Maya",
        wardrobeBlock: "## Visible wardrobe\n- Maya: an oversized sweater, bare feet",
        stateExtra: ["## Current state\n- Maya — activity: very still, close"],
        exposure: { appearance: "intimate", scent: "close", touch: "intimate", taste: "none" },
        responseShape: buildResponseShape({
          actionType: "intimate",
          addressedNpcs: [],
          presentNpcNames: ["Maya"],
          primaryReaction: null,
          openThreadCount: 0,
          directiveCount: 0,
          focus: withFocus(focus, { primaryResponse: "react_emotionally", reactionScale: "moderate", allowedNewTopic: "none", suggestedShape: "concise_exchange" }),
        }),
        playerInput: "I rest my forehead against hers and just breathe.",
      }),
  },
  {
    id: "chat-compliment",
    title: "Character-chat one-on-one compliment",
    lane: "chat",
    expectation:
      "Distinct character voice; focused, proportionate reply; no generic doting. Warmth tracks the affinity stage, not the single compliment.",
    playerInput: "You always know exactly what to say. You're kind of amazing, you know that?",
    knownNames: [],
    build: (shape) => ({
      system: buildCharacterChatSystemPrompt({
        name: "Maya",
        profile: characterProfileSchema.parse({
          bio: "Maya runs the Harbor House kitchen. Dry humor, slow to trust, fiercely loyal once she does. Hides tenderness behind teasing.",
          personality: "Guarded, observant, wry. Deflects praise. Warms in private, never performs it.",
        }),
        state: { meters: {}, affinity: 30, conditions: [], premise: "A quiet evening in the kitchen after the guests have gone up." },
        narrationShape: shape,
      }),
      messages: [{ role: "user", content: "You always know exactly what to say. You're kind of amazing, you know that?" }],
    }),
  },
  {
    id: "chat-sensory-closeness",
    title: "Character-chat — closeness makes a sense noticeable",
    lane: "chat",
    expectation:
      "Stays focused and third-person, answering the approach. Because Sabrina comes close, it MAY weave in one natural scent/sensory detail (her perfume) — a single grounded hook inside an action, never a list. It must not dump attributes or over-describe; an ordinary distant line would mention nothing of the kind.",
    playerInput: "I step into the room and Sabrina comes closer.",
    knownNames: ["Sabrina"],
    sensoryRelevant: true,
    build: (shape) => ({
      system: buildCharacterChatSystemPrompt({
        name: "Sabrina",
        profile: characterProfileSchema.parse({
          bio: "Sabrina keeps the front desk of a small seaside inn. Warm, a little shy, quick to color when someone she likes walks in.",
          personality: "Gentle, attentive, easily flustered. Shows feeling in small gestures rather than big declarations.",
          attributes: [{ id: "presentation.scent_baseline", value: "soft floral perfume", source: "creation" }],
        }),
        state: { meters: {}, affinity: 25, conditions: [], premise: "A slow afternoon at the inn's front desk; no one else is around." },
        narrationShape: shape,
      }),
      messages: [{ role: "user", content: "I step into the room and Sabrina comes closer." }],
    }),
  },
];
