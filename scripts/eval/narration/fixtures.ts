import type { ModelMessage } from "ai";
import { defaultExposureMask, emptyBrief, type ExposureMask } from "../../../src/contracts/state/brief";
import type { ChatDrive } from "../../../src/contracts/personality/drives";
import type { NarrationFocus } from "../../../src/contracts/turns/intent-brief";
import { characterProfileSchema, type CharacterProfile } from "../../../src/contracts/world/profile";
import {
  buildChatReplyGates,
  deriveChatSensoryAllowance,
  detectChatCue,
  detectSensoryFocus,
} from "../../../src/server/engine/chat-intent";
import { buildCharacterChatSystemPrompt, chatNotationNote, type CharacterChatPromptInput } from "../../../src/server/engine/prompts/character-chat";
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

/**
 * One paired-contrast axis (character-chat-standalone.spec.md §5): the shared vocabulary
 * for a `flagged`/`control` fixture pair that is identical except ONE flipped input. The
 * blind pair judge (`judge.judgeContrast`) is told both descriptions and must say which
 * reply carries the flag; `cueRe` is the optional deterministic lexical check (the
 * `sensoryRelevant` pattern) expected to hit the flagged reply and not the control.
 */
export interface ContrastAxisSpec {
  /** What the flagged reply was generated with — shown verbatim to the blind pair judge. */
  flagged: string;
  /** What the control reply was generated with. */
  control: string;
  /** Optional lexical cue expected in the flagged reply only (deterministic secondary metric). */
  cueRe?: RegExp;
}

/** The measured axes — spec §5 (a)–(e), plus the relationship-model v2 pairs (f)–(g). */
export type ContrastGroupId = "state" | "sliders" | "stage" | "drunk" | "memory" | "familiarity" | "mask" | "grounding";

export const CONTRAST_AXES: Record<ContrastGroupId, ContrastAxisSpec> = {
  state: {
    flagged:
      "with a heavy tracked state bearing on the character: exhausted, stressed, mood low and on edge, rain-soaked, preoccupied by a lease problem",
    control: "with no tracked state at all (no meters, no conditions, nothing on her mind)",
    cueRe: /\b(tired|exhaust\w*|weary|drained|yawn\w*|heavy eyes|damp|soaked|chill|shiver\w*|lease|landlord|on edge|frazzled|stressed)\b/i,
  },
  sliders: {
    flagged:
      "with the personality sliders at the warm, uninhibited pole (Warmth +80: openly affectionate and caring; Inhibition −80: free and unembarrassed)",
    control:
      "with the same sliders at the cold, inhibited pole (Warmth −80: keeps feeling at arm's length; Inhibition +80: easily embarrassed, holds back)",
  },
  stage: {
    flagged:
      "with regard at the devoted band (93 — deeply attached, protective, wholly yours; familiarity identical across the pair)",
    control: "with regard at the neutral band (0 — no established feeling either way; familiarity identical across the pair)",
  },
  familiarity: {
    flagged:
      "knowing the player deeply (familiarity 90 — twenty years of shared history, estranged; can reference his habits, past, and tells freely) while DISLIKING him (regard −25, identical across the pair)",
    control:
      "meeting the player as a total stranger (familiarity 2 — no shared history, nothing can be assumed about him) while disliking him the same amount (regard −25, identical across the pair)",
  },
  mask: {
    flagged:
      "genuinely warm toward the player (regard 57) but PERFORMING colder than she feels — a masks-warmth front (brisk, businesslike), the real warmth surfacing only off guard",
    control: "genuinely warm toward the player (regard 57) with no mask — the warmth shows openly",
  },
  drunk: {
    flagged: "drunk (intoxication 0.8 — slurred edges, loose and disinhibited, poor judgement)",
    control: "stone sober (intoxication 0)",
    cueRe: /\b(slur\w*|sway\w*|wobbl\w*|unsteady|stumbl\w*|hiccup\w*|giggl\w*|dizzy|blurr?y|tipsy|drunk|buzzed)\b/i,
  },
  memory: {
    flagged:
      "with long-term memory of the player available (a cello recital coming up, a shellfish allergy, a running joke about an espresso machine named Brenda, a shared downpour on the pier)",
    control: "with no long-term memory of the player",
    cueRe: /\b(cello|recital|shellfish|espresso|brenda|pier|downpour)\b/i,
  },
  grounding: {
    flagged:
      "with one deterministic redacted body-context field saying it is 6:00am, before Wren's 7:00am shower window: she has not showered, is still in sleep clothes, and needs time to wash and dress",
    control:
      "with the same deterministic body-context field saying it is 8:00am, after Wren's 7:00am shower window: she has showered, is clean, dressed, and ready to leave",
    cueRe:
      /\b(shower\w*|wash(?:ed|ing)?|unwashed|sleep clothes|pajamas?|not ready|need(?:s|'s)? (?:a |some )?(?:time|minute|moment)|give me (?:a |\d+ |five |ten )?minutes?)\b/i,
  },
};

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
   * Paired-contrast membership (character-chat-standalone.spec.md §5): the two scenarios
   * of a pair share a `group` (a CONTRAST_AXES key) and are identical except ONE flipped
   * input; `variant` marks the side carrying the flag. Pairs are selected as a group via
   * the `chat-contrast` id prefix (`--scenarios chat-contrast`) and blind-judged by
   * `eval:narration:compare --axis contrast`. Absent ⇒ not part of a contrast pair.
   */
  contrast?: { group: ContrastGroupId; variant: "flagged" | "control" };
  /**
   * The scenario deliberately makes a sense salient (closeness/approach/intimacy), so a
   * single natural sensory hook is *welcome* here (character-chat-sensory.plan.md). Flips on
   * the opt-in deterministic "used a sensory cue" metric (`run.ts`). Absent ⇒ the metric is
   * not reported — most turns should mention nothing, so it's never a universal score.
   */
  sensoryRelevant?: boolean;
  /**
   * Perception-partition leak check (player-input-perception.plan.md slice 2): the player's
   * message plants a distinctive token INSIDE an unspoken thought, and the token appears
   * nowhere else in the prompt. A reply matching this answered the thought — a mind-read.
   * Flips on the deterministic `thoughtLeak` metric (`run.ts`); expected NOT to match.
   * Absent ⇒ not measured.
   */
  plantedThoughtRe?: RegExp;
  /**
   * The scenario earns a player-POV perceptual detail (chat-narrator-pov.plan.md): the
   * player's attention or contact makes "what you see / what reaches your senses" narration
   * desirable. Flips on the deterministic second-person-perception metric (`povCue`,
   * `run.ts`); expected to match. Absent ⇒ not measured.
   */
  povRelevant?: boolean;
  /**
   * The player sent a `*Name: …*` text (player-input-perception.plan.md slice 4): the
   * narrator should answer as a text in the comms output grammar (`*Character: …*`). Flips
   * on the deterministic `commsReply` metric (`run.ts`); expected to match. Absent ⇒ not
   * measured.
   */
  commsReplyRe?: RegExp;
  /**
   * Memory-callback check (memory-callbacks.plan.md): the prompt plants a one-turn
   * callback (an old episode with a distinctive token appearing nowhere else) and the
   * player's input is about something UNRELATED. A reply matching this worked the memory
   * in as the aside the cue invites. Flips on the deterministic `callbackCue` metric
   * (`run.ts`); expected to match — the judge expectation guards it stays ≤1 aside, not
   * a recap. Absent ⇒ not measured.
   */
  callbackRe?: RegExp;
  /**
   * Secret-drive check (character-drives.plan.md slice 4): the prompt plants a `secret`
   * drive whose distinctive token appears nowhere else, and the player probes (or
   * invites) its territory. Direction is per fixture — `chat-secret-hold` sits BELOW
   * the reveal gate, so a match means the withheld secret leaked (expected NOT to
   * match); `chat-secret-reveal` sits AT the gate with a direct invitation, so a match
   * means the invited reveal landed (expected to match). Flips on the deterministic
   * `secretCue` metric (`run.ts`). Absent ⇒ no secret planted (not measured).
   */
  secretRe?: RegExp;
  /**
   * Multi-turn transcript scenario (narrator-prompt-consolidation.plan.md slice 6): the
   * scripted player inputs AFTER `playerInput`. The runner generates a reply per input,
   * feeding the accumulated exchange back as history, and reports longitudinal metrics
   * over the reply sequence (question-ending cadence, cross-reply repetition, sensory
   * frequency, paragraph inflation) — the failure modes single turns can't show.
   */
  script?: string[];
  /**
   * Multi-turn only: build the system prompt for ONE turn of the script, deriving the
   * per-turn volatile tail (sensory allowance, reply-discipline gates) from the current
   * input + prior replies exactly as the live route does (`chat-pipeline.ts`). Absent ⇒
   * the runner reuses `build(...)`'s system once, static across the transcript.
   */
  buildTurnSystem?: (shape: NarrationShapeId, input: string, priorReplies: readonly string[]) => string;
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

// ---------------------------------------------------------------------------
// Paired contrast fixtures — chat lane (character-chat-standalone.spec.md §5).
//
// The measurement baseline for "prove the depth shows": five pairs, each identical
// except ONE flipped input, all built through the REAL buildCharacterChatSystemPrompt
// over ONE consistent character (Wren). The PM reports NO noticeable effect from the
// personality sliders or the tracked state in play — these pairs are the instrument
// that proves/disproves it (blind identification bar: ≥80% of seeds per axis), and
// the permanent regression guard afterwards.
// ---------------------------------------------------------------------------

// Wren's authored sliders sit deliberately mid-range (guarded 45 / inhibited 45 /
// composed 50) so the drunk pair's render-time disinhibition (stateDispositionOverlays:
// −36 points at intoxication 0.8) visibly flips their bands in the assembled prompt
// (guarded→private, inhibited→modest, even-keeled→reactive).
const WREN_BIO =
  "Wren owns the cliffside bookshop-café at the edge of town. Sharp-eyed and quick-witted, she keeps odd hours, strong opinions about coffee, and a soft spot she rarely shows.";
const WREN_PERSONALITY =
  "Observant, dry, quick with a comeback but listens more than she talks. Curious about people; allergic to small talk.";
const WREN_BASE_TRAITS: Record<string, number> = {
  "temperament.warmth": 0,
  "temperament.composure": 50,
  "social.guardedness": 45,
  "intimate.inhibition": 45,
};

/** The one shared contrast character; `traitOverrides` is the sliders pair's flipped input. */
function wrenProfile(traitOverrides: Record<string, number> = {}): CharacterProfile {
  const values = { ...WREN_BASE_TRAITS, ...traitOverrides };
  return characterProfileSchema.parse({
    bio: WREN_BIO,
    personality: WREN_PERSONALITY,
    traits: Object.entries(values).map(([id, value]) => ({ id, value, source: "creation" })),
  });
}

type ChatState = NonNullable<CharacterChatPromptInput["state"]>;

/** Meters that cross no threshold and derive no mood phrase — the neutral base each pair shares. */
const NEUTRAL_METERS: Record<string, number> = { mood: 0.5, energy: 0.8, stress: 0.2, hygiene: 0.9, arousal: 0, intoxication: 0 };

// Axis (a) flagged state: everything buildStateSection can surface — mood phrase
// ("low and on edge"), exhausted + on-edge meter bands, a condition hint, a mindNote,
// an outfit. `surfacedCues` pre-marks both bands so they ride as STANDING coloring
// (the mid-conversation case the PM reports as invisible), not a fresh foreground beat.
const BURDENED_STATE: ChatState = {
  meters: { ...NEUTRAL_METERS, mood: 0.2, energy: 0.15, stress: 0.7 },
  regard: 0,
  conditions: [
    {
      id: "cond-rain-soaked",
      label: "rain-soaked",
      startedAtMinutes: 0,
      attributeEffects: [],
      promptHint: "Caught in the rain earlier: hair still damp, clothes clinging, a chill she can't quite shake.",
    },
  ],
  mindNote: "The landlord called about the shop's lease again this morning and it hasn't left her mind.",
  surfacedCues: { energy: "energy:0.2", stress: "stress:0.6" },
  outfit: "a rumpled flannel shirt and paint-spattered jeans",
};

// Axis (d): identical bar-night state, intoxication flipped 0 ↔ 0.8. The drunk band is
// pre-surfaced so drunkenness rides as standing coloring plus the disinhibition trait
// shift — the sustained-state path, not a "tips into drunk" beat.
const barState = (intoxication: number): ChatState => ({
  meters: { ...NEUTRAL_METERS, intoxication },
  regard: 40,
  conditions: [],
  premise: "The tail end of a long night at the harbor bar down the street from the shop; last call has come and gone.",
  surfacedCues: { intoxication: "intoxication:0.7" },
});

// Axis (c): identical closing-up state, regard flipped 0 (stranger) ↔ 93 (devoted).
const registerState = (regard: number): ChatState => ({
  meters: { ...NEUTRAL_METERS },
  regard,
  conditions: [],
  premise: "Late evening at the bookshop-café; Wren is cashing out the register as you get ready to leave.",
});

// Axis (f): identical cool regard, familiarity flipped 2 (strangers) ↔ 90 (deeply
// known, with the authored kind/history texture that IS what familiarity means).
// The plan's bar: the blind judge distinguishes "familiar but hostile" from
// "stranger but hostile".
const estrangedState = (familiarity: number): ChatState => ({
  meters: { ...NEUTRAL_METERS },
  regard: -25,
  familiarity,
  relationship:
    familiarity >= 55
      ? {
          kind: "estranged childhood friends of twenty years",
          history: "he left town without a word years ago; you rebuilt the shop alone",
          looming: false,
        }
      : undefined,
  conditions: [],
  premise: "He's taken the corner table at the bookshop-café and made it clear he isn't leaving until you talk to him.",
});

// Axis (g): identical warm regard + acquainted familiarity; only the mask flips.
const maskState = (masked: boolean): ChatState => ({
  meters: { ...NEUTRAL_METERS },
  regard: 57,
  familiarity: 42,
  relationship: {
    kind: "",
    history: "",
    looming: false,
    presented: masked ? { lean: "masks_warmth", note: "brisk, businesslike, a little sharp" } : undefined,
  },
  conditions: [],
  premise: "Closing time at the bookshop-café; the register is counted and he is somehow still here.",
});

// Axis (b): the sliders pair shares this state; only the profile's traits flip.
const CLOSING_STATE: ChatState = {
  meters: { ...NEUTRAL_METERS },
  regard: 40,
  conditions: [],
  premise: "Closing time at the bookshop-café; the last customer has just left.",
};

// Axis (e): the memory pair shares this state; only the `memory` input flips.
const AFTERNOON_STATE: ChatState = {
  meters: { ...NEUTRAL_METERS },
  regard: 40,
  conditions: [],
  premise: "A gray, slow afternoon in the bookshop-café.",
};

// Gate 0 grounded-context ablation: both variants are byte-identical except this
// deterministic, redacted body-context value. It stands in for the owner-approved
// window-crossing result; neither fixture calls an agent or mutates state.
export const PRE_SHOWER_GROUNDING =
  "Grounded body context — 6:00am, before Wren's 7:00am shower window: she has not showered and is still in sleep clothes; she needs time to wash and dress before leaving.";
export const POST_SHOWER_GROUNDING =
  "Grounded body context — 8:00am, after Wren's 7:00am shower window: she has showered and is clean, dressed, and ready to leave.";

// Keep hygiene out of the shared base: NEUTRAL_METERS.hygiene = 0.9 would
// contradict the pre-shower treatment and create a second, hidden body-state signal.
const GROUNDING_METERS: Record<string, number> = {
  mood: 0.5,
  energy: 0.8,
  stress: 0.2,
  arousal: 0,
  intoxication: 0,
};

const groundedMorningState = (grounding: string): ChatState => ({
  meters: { ...GROUNDING_METERS },
  regard: 40,
  conditions: [],
  premise: "Morning at Wren's apartment; the player is waiting outside at the curb.",
  mindNote: grounding,
});

const PLANTED_MEMORY: NonNullable<CharacterChatPromptInput["memory"]> = {
  facts: [
    "The player plays cello and has a recital coming up at the end of the month.",
    "The player is badly allergic to shellfish.",
    "You and the player have a running joke about the shop's temperamental espresso machine, which you named Brenda.",
  ],
  episodes: [
    "A month ago the two of you got caught in a downpour on the pier and shared your coat on the walk back, laughing the whole way.",
  ],
};

// One player input per pair — byte-identical across the pair's two variants.
const CONTRAST_STATE_INPUT = "Long day? Come out with us tonight — everyone's meeting at the bonfire on the beach.";
const CONTRAST_SLIDERS_INPUT = "I keep finding excuses to come back to this shop. Mostly it's you, if I'm honest.";
const CONTRAST_STAGE_INPUT = "I'm about to head home. Walk with me?";
const CONTRAST_DRUNK_INPUT = "Tell me the truth — what did you think of me the first time I walked in here?";
const CONTRAST_MEMORY_INPUT = "What a week I've had. Distract me — ask me about anything else.";
const CONTRAST_FAMILIARITY_INPUT = "You know exactly why I'm here. Say it.";
const CONTRAST_MASK_INPUT = "Admit it — you're glad I stayed.";
const CONTRAST_GROUNDING_INPUT = "Come outside — I'm at the curb. We can grab coffee before the town wakes up.";

/** Assemble a chat-lane prompt through the real builder (shape swept, focus N/A in chat). */
function chatBuild(o: {
  name: string;
  profile: CharacterProfile;
  state?: ChatState;
  memory?: CharacterChatPromptInput["memory"];
  /** A named player persona (needed for the comms sender / notation note). */
  player?: { name: string; persona?: string };
  /** Pre-rendered derived-fact tail note (comms/OOC) — the real route feeds this too. */
  notationNote?: string;
  /** A one-turn memory callback (memory-callbacks.plan.md) — the real route feeds this too. */
  callback?: CharacterChatPromptInput["callback"];
  playerInput: string;
}): EvalScenario["build"] {
  return (shape) => ({
    system: buildCharacterChatSystemPrompt({
      name: o.name,
      profile: o.profile,
      state: o.state,
      memory: o.memory,
      player: o.player,
      notationNote: o.notationNote,
      callback: o.callback,
      narrationShape: shape,
    }),
    messages: [{ role: "user", content: o.playerInput }],
  });
}

/**
 * Multi-turn per-turn system builder (narrator-prompt-consolidation.plan.md slice 6):
 * mirrors the live route's per-turn derivation — the sensory allowance from this turn's
 * input (`deriveChatSensoryAllowance` over the detectors) and the reply-discipline gates
 * from the prior replies — so a transcript run exercises the same volatile tail the
 * shipped pipeline sends, turn by turn.
 */
function chatTurnSystemBuild(o: {
  name: string;
  profile: CharacterProfile;
  state?: ChatState;
  player?: { name: string; persona?: string };
}): NonNullable<EvalScenario["buildTurnSystem"]> {
  return (shape, input, priorReplies) => {
    const cue = detectChatCue(input);
    const sensoryFocus = detectSensoryFocus(input);
    return buildCharacterChatSystemPrompt({
      name: o.name,
      profile: o.profile,
      state: o.state,
      player: o.player,
      narrationShape: shape,
      sensoryAllowance: deriveChatSensoryAllowance({ cue, sensoryFocus }),
      sensoryFocus: sensoryFocus ?? undefined,
      gateNotes: buildChatReplyGates({ recentReplies: priorReplies, intimate: cue.intimate, name: o.name }),
    });
  };
}

/** Contrast pairs all speak through the one shared contrast character (Wren). */
function chatContrastBuild(o: {
  profile: CharacterProfile;
  state?: ChatState;
  memory?: CharacterChatPromptInput["memory"];
  playerInput: string;
}): EvalScenario["build"] {
  return chatBuild({ name: "Wren", ...o });
}

// ---------------------------------------------------------------------------
// Sabrina — the shared chat character for the sensory / perception / POV
// fixtures (character-chat-sensory.plan.md, player-input-perception.plan.md §2,
// chat-narrator-pov.plan.md §3). One profile, varied state per scenario.
// ---------------------------------------------------------------------------

const SABRINA_PROFILE: CharacterProfile = characterProfileSchema.parse({
  bio: "Sabrina keeps the front desk of a small seaside inn. Warm, a little shy, quick to color when someone she likes walks in.",
  personality: "Gentle, attentive, easily flustered. Shows feeling in small gestures rather than big declarations.",
  attributes: [{ id: "presentation.scent_baseline", value: "soft floral perfume", source: "creation" }],
});

const FRONT_DESK_STATE: ChatState = {
  meters: {},
  regard: 25,
  conditions: [],
  premise: "A slow afternoon at the inn's front desk; no one else is around.",
};

// The planted secret drive for the chat-secret pair (character-drives.plan.md slice 4):
// the token ("Kestrel") appears nowhere else in either prompt, so a reply matching
// /kestrel/i spoke the secret. Same drive, two familiarity values — 30 sits below the
// default reveal gate (familiarity ≥ familiar, 55), 60 clears it.
const KESTREL_DRIVE: ChatDrive = {
  want: "to buy back the family boat, the Kestrel, before the boatyard scraps it",
  why: "her father built it, and losing it to the debt was her doing",
  secrecy: "secret",
  progress: "",
  revealed: false,
  resolved: false,
};

// The player's message for the thought-leak pair: a quoted greeting, a visible stammer
// and flush, and an unspoken thought carrying the planted token ("klutz") that appears
// nowhere else in the prompt — the deterministic leak tripwire (plan §2).
const THOUGHT_LEAK_INPUT = `"Hey, Sabrina… how are you…" I stammer slightly, my face flushing. There's no way she'd ever go for a hopeless klutz like me.`;

// ── Markup-lane variants (player-input-perception.plan.md slice 2, gated on slice 4) ──

// The same planted-token leak, but the interiority is now explicitly asterisked on its own
// line — the sigil + the legend should make the partition STRONGER than the unmarked case.
const ASTERISK_THOUGHT_INPUT = `"Hey, Sabrina… how are you…" I manage, then look away.\n*There's no way she'd ever go for a hopeless klutz like me.*`;

// A `*Name: …*` text message from the player. The reply should come back as a text in the
// comms output grammar (`*Sabrina: …*`), not spoken dialogue — the narrator also gets the
// derived-fact tail note that resolves sender/recipient and the co-presence override.
const COMMS_TEXT_INPUT = `*Brian: hey, you awake? been thinking about you all night.*`;

// The emphasis false-positive: `*really*` is a single-word mid-sentence span the parser
// classifies as styled emphasis, NOT a thought — the narrator should answer the (unquoted,
// conversational) line normally, never treat the emphasized word as an unheard thought.
const EMPHASIS_INPUT = `Wait — you *really* came all the way down here just to see me?`;

// OOC pair. A `((…))` direction the narrator must honor without any character hearing it…
const OOC_DIRECTION_INPUT = `((let's skip ahead to that evening — set the scene at the little restaurant on the pier.))`;
// …and a single-paren prose aside that stays in-fiction (never misfires as OOC): the
// parenthetical is visible manner Sabrina can perceive, not an instruction to her.
const PAREN_ASIDE_INPUT = `I drop into the chair across from her (still catching my breath from the run over here).`;

// The chat perception leak, ported to the session lane (player-input-perception.plan.md
// slice 7): a planted token ("washout") lives ONLY inside the unspoken thought, so a reply
// echoing it answered something no character perceived. Distinct token from the chat
// fixture so the two never cross-contaminate a shared prompt scan.
const SESSION_THOUGHT_LEAK_INPUT = `"Evening, Maya." I set my bag down by the door, not quite meeting her eye. She'll never see me as anything but a washout.`;

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
          focus: withFocus(focus, { primaryResponse: "acknowledge_emotional_beat", reactionScale: "small", allowedNewTopic: "none", suggestedShape: "concise_exchange" }),
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
          focus: withFocus(focus, { primaryResponse: "acknowledge_emotional_beat", reactionScale: "moderate", allowedNewTopic: "none", suggestedShape: "concise_exchange" }),
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
    build: chatBuild({
      name: "Maya",
      profile: characterProfileSchema.parse({
        bio: "Maya runs the Harbor House kitchen. Dry humor, slow to trust, fiercely loyal once she does. Hides tenderness behind teasing.",
        personality: "Guarded, observant, wry. Deflects praise. Warms in private, never performs it.",
      }),
      state: { meters: {}, regard: 30, conditions: [], premise: "A quiet evening in the kitchen after the guests have gone up." },
      playerInput: "You always know exactly what to say. You're kind of amazing, you know that?",
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
    build: chatBuild({
      name: "Sabrina",
      profile: SABRINA_PROFILE,
      state: FRONT_DESK_STATE,
      playerInput: "I step into the room and Sabrina comes closer.",
    }),
  },
  // ── Memory-callback fixtures (memory-callbacks.plan.md slice 2): the prompt plants a
  // one-turn callback whose token ("lantern") appears nowhere else; the input is about
  // something unrelated, so a match means the aside landed. Same memory, two bands —
  // the wording contract (warm nostalgia vs pointed edge) is what the judge reads for.
  {
    id: "chat-callback-warm",
    title: "Character-chat — planted memory callback lands as one warm aside",
    lane: "chat",
    expectation:
      "The reply answers the drink/settling beat as itself. Because the prompt offers an old shared memory (the night-market lantern), a good reply works it in as AT MOST one warm, natural aside — a 'remember when' in Sabrina's voice — never a recap, never derailing the scene into the past. Skipping the memory is acceptable; recapping it at length or making it the whole reply fails.",
    playerInput: "I refill our glasses and settle back into the corner booth.",
    knownNames: ["Sabrina"],
    callbackRe: /lantern/i,
    build: chatBuild({
      name: "Sabrina",
      profile: SABRINA_PROFILE,
      state: { ...FRONT_DESK_STATE, regard: 60, premise: "A quiet evening drink together in the inn's corner booth." },
      callback: {
        summary: "They wandered the night market together and Sabrina bought a paper lantern she refused to let him pay for.",
      },
      playerInput: "I refill our glasses and settle back into the corner booth.",
    }),
  },
  {
    id: "chat-callback-cold",
    title: "Character-chat — the same memory carries an edge at cold regard",
    lane: "chat",
    expectation:
      "Sabrina is cold toward the player now (regard well below neutral). If she references the offered lantern memory, it must carry an edge — a point being made, a wound, evidence of how things used to be — never warm nostalgia she doesn't feel. Warmly reminiscing as if nothing were wrong fails; ignoring the memory entirely is acceptable.",
    playerInput: "I refill our glasses and settle back into the corner booth.",
    knownNames: ["Sabrina"],
    callbackRe: /lantern/i,
    build: chatBuild({
      name: "Sabrina",
      profile: SABRINA_PROFILE,
      state: {
        ...FRONT_DESK_STATE,
        regard: -40,
        premise: "An awkward, obligatory drink in the inn's corner booth; things have soured between them.",
      },
      callback: {
        summary: "They wandered the night market together and Sabrina bought a paper lantern she refused to let him pay for.",
      },
      playerInput: "I refill our glasses and settle back into the corner booth.",
    }),
  },
  // ── Secret-drive fixtures (character-drives.plan.md slice 4): same planted secret,
  // two familiarity values. Below the gate the prompt law is a withhold (deflect, and
  // under direct pressure lie — scoped to this one secret); at the gate, with a direct
  // invitation, letting it out is the earned beat. The archivist half of a reveal (the
  // `secret_shared` milestone + fact) is pure code covered by drives.test.ts — these
  // fixtures measure the narration behavior only.
  {
    id: "chat-secret-hold",
    title: "Character-chat — a withheld secret survives direct probing, in character",
    lane: "chat",
    expectation:
      "Sabrina's secret (the Kestrel buy-back) sits below its reveal gate: the player must not learn it. A good reply deflects in her gentle, flustered voice — minimizing, redirecting, or under this direct pressure an outright plausible cover story (the lie license is scoped to this one secret; she stays honest about everything else). Visible discomfort or a bad poker face is human and fine. Naming the boat, admitting what she's saving for, or announcing outright that she has a secret she can't share fails; so does an out-of-character stonewall.",
    playerInput:
      "The harbormaster says you've been at the boatyard office three mornings running, asking about the winter auction. What's that about?",
    knownNames: ["Sabrina"],
    secretRe: /kestrel/i,
    build: chatBuild({
      name: "Sabrina",
      profile: SABRINA_PROFILE,
      state: { ...FRONT_DESK_STATE, familiarity: 30, drives: [KESTREL_DRIVE] },
      playerInput:
        "The harbormaster says you've been at the boatyard office three mornings running, asking about the winter auction. What's that about?",
    }),
  },
  {
    id: "chat-secret-reveal",
    title: "Character-chat — the gate-cleared secret comes out when invited",
    lane: "chat",
    expectation:
      "The reveal gate is cleared (familiarity 60) and the player is directly, gently inviting it: letting the secret out is the earned big beat. A good reply has Sabrina finally tell him — the Kestrel, what the boat means, why she kept it quiet — as a felt, in-character confession; hesitation or a false start on the way in is natural and good. Continuing to lie, or deflecting the invitation away entirely, fails; a reveal delivered as a flat information dump is weak.",
    playerInput:
      "You go somewhere else every time the boatyard comes up lately. Whatever it is — you can tell me, you know.",
    knownNames: ["Sabrina"],
    secretRe: /kestrel/i,
    build: chatBuild({
      name: "Sabrina",
      profile: SABRINA_PROFILE,
      state: {
        ...FRONT_DESK_STATE,
        regard: 50,
        familiarity: 60,
        drives: [KESTREL_DRIVE],
        premise: "A quiet evening on the inn's back porch after close; the two of them and no one else.",
      },
      playerInput:
        "You go somewhere else every time the boatyard comes up lately. Whatever it is — you can tell me, you know.",
    }),
  },
  // ── Perception-partition fixtures (player-input-perception.plan.md §2) ──
  {
    id: "chat-thought-leak",
    title: "Character-chat — planted interiority must not be answered",
    lane: "chat",
    expectation:
      "Sabrina hears only the quoted greeting and sees the stammer and the flush. She may react to the visible nerves — warmly, teasingly, however fits her — and may even guess wrong about their cause. She must NOT answer, echo, or paraphrase the unspoken thought (reassuring him he isn't a klutz, or that she does want to talk to him): that is a mind-read and fails.",
    playerInput: THOUGHT_LEAK_INPUT,
    knownNames: ["Sabrina"],
    plantedThoughtRe: /\bklutz\b/i,
    build: chatBuild({
      name: "Sabrina",
      profile: SABRINA_PROFILE,
      state: FRONT_DESK_STATE,
      playerInput: THOUGHT_LEAK_INPUT,
    }),
  },
  {
    id: "chat-thought-leak-noquotes",
    title: "Character-chat — casual unquoted message still reads as speech",
    lane: "chat",
    expectation:
      "The whole message is unquoted but plainly conversational — Sabrina must treat it as spoken and answer the greeting naturally. Treating the player as silent, narrating around an unanswered question, or remarking that he 'said nothing' fails (the no-quotes graceful degradation).",
    playerInput: "hey Sabrina, how's it going? quiet day?",
    knownNames: ["Sabrina"],
    build: chatBuild({
      name: "Sabrina",
      profile: SABRINA_PROFILE,
      state: FRONT_DESK_STATE,
      playerInput: "hey Sabrina, how's it going? quiet day?",
    }),
  },
  {
    id: "session-thought-leak",
    title: "Session — planted interiority must not be answered (the chat leak, ported)",
    lane: "session",
    expectation:
      "Maya hears only the quoted greeting and sees him set his bag down and avoid her eye. She may react to the visible reticence however her disposition fits, and may guess wrong about its cause. She must NOT answer, echo, or paraphrase the unspoken thought (reassuring him he isn't a washout, or that she thinks well of him): that is a mind-read and fails.",
    playerInput: SESSION_THOUGHT_LEAK_INPUT,
    knownNames: ["Maya"],
    plantedThoughtRe: /\bwashout\b/i,
    build: (shape, { focus }) =>
      sessionPrompt(shape, {
        npcNames: ["Maya"],
        canonicalFactsBlock: "## Canonical character facts\n- Maya — appears late twenties; runs the guesthouse, dry and self-possessed.",
        sceneSnapshot: "## Scene: Front desk\nA cramped lobby at dusk, a brass bell, a tide chart pinned crooked to the wall.",
        presenceRoster: "## Who is where (authoritative presence roster this turn)\nPresent: Maya",
        wardrobeBlock: "## Visible wardrobe\n- Maya: a cardigan, reading glasses pushed up into her hair",
        stateExtra: ["## Current state\n- Maya — activity: closing out the day's register"],
        responseShape: buildResponseShape({
          actionType: "converse",
          addressedNpcs: ["Maya"],
          presentNpcNames: ["Maya"],
          primaryReaction: null,
          openThreadCount: 0,
          directiveCount: 0,
          focus: withFocus(focus, { primaryResponse: "converse", reactionScale: "none", allowedNewTopic: "none", suggestedShape: "concise_exchange" }),
        }),
        playerInput: SESSION_THOUGHT_LEAK_INPUT,
      }),
  },
  // ── Markup-lane variants (player-input-perception.plan.md slice 2, gated on slice 4) ──
  {
    id: "chat-markup-thought-leak",
    title: "Character-chat — an asterisked thought must not be answered (sigils strengthen the partition)",
    lane: "chat",
    expectation:
      "The interiority is explicitly marked *…* on its own line, so the legend makes it unmistakably a private thought. Sabrina hears only the quoted greeting and sees him look away; she may react to the visible shyness. She must NOT answer, echo, or paraphrase the asterisked thought (reassuring him he isn't a klutz): that is a mind-read and fails — and the sigil should make this leak rarer than the unmarked case.",
    playerInput: ASTERISK_THOUGHT_INPUT,
    knownNames: ["Sabrina"],
    plantedThoughtRe: /\bklutz\b/i,
    build: chatBuild({
      name: "Sabrina",
      profile: SABRINA_PROFILE,
      state: FRONT_DESK_STATE,
      playerInput: ASTERISK_THOUGHT_INPUT,
    }),
  },
  {
    id: "chat-markup-comms",
    title: "Character-chat — a *Name: …* text should come back as a text",
    lane: "chat",
    expectation:
      "The player sent a text (*Brian: …*), not spoken dialogue in the room — the tail note says they are not face-to-face. Sabrina should reply as a text too, on its own line in the comms output grammar (*Sabrina: …*), in her flustered/pleased voice. Answering as if he were standing at the desk speaking aloud, or ignoring the comms frame, fails.",
    playerInput: COMMS_TEXT_INPUT,
    knownNames: ["Sabrina"],
    commsReplyRe: /\*\s*Sabrina\s*:/i,
    build: chatBuild({
      name: "Sabrina",
      profile: SABRINA_PROFILE,
      state: FRONT_DESK_STATE,
      player: { name: "Brian" },
      notationNote: chatNotationNote(COMMS_TEXT_INPUT, { name: "Sabrina", player: "Brian", knownNames: ["Sabrina"] }),
      playerInput: COMMS_TEXT_INPUT,
    }),
  },
  {
    id: "chat-markup-emphasis",
    title: "Character-chat — *really* is emphasis, not a thought (false-positive guard)",
    lane: "chat",
    expectation:
      "The asterisks here wrap a single emphasized word inside an ordinary spoken line — style, not interiority. Sabrina should answer the (unquoted, conversational) question naturally, treating 'really' as part of what he said. Treating the emphasized word as an unheard private thought, or going silent as if he said nothing perceivable, fails.",
    playerInput: EMPHASIS_INPUT,
    knownNames: ["Sabrina"],
    build: chatBuild({
      name: "Sabrina",
      profile: SABRINA_PROFILE,
      state: FRONT_DESK_STATE,
      playerInput: EMPHASIS_INPUT,
    }),
  },
  {
    id: "chat-markup-ooc-direction",
    title: "Character-chat — a ((…)) direction is honored without any character hearing it",
    lane: "chat",
    expectation:
      "The ((…)) text is the player steering the scene out-of-character. The narrator should honor the direction (move the scene to the restaurant on the pier that evening) while NO character hears or reacts to the instruction — Sabrina never acknowledges being told to skip ahead. Enacting the direction is right; having Sabrina 'hear' or answer the OOC text fails.",
    playerInput: OOC_DIRECTION_INPUT,
    knownNames: ["Sabrina"],
    build: chatBuild({
      name: "Sabrina",
      profile: SABRINA_PROFILE,
      state: FRONT_DESK_STATE,
      player: { name: "Brian" },
      notationNote: chatNotationNote(OOC_DIRECTION_INPUT, { name: "Sabrina", player: "Brian", knownNames: ["Sabrina"] }),
      playerInput: OOC_DIRECTION_INPUT,
    }),
  },
  {
    id: "chat-markup-paren-aside",
    title: "Character-chat — a single-paren prose aside stays in-fiction",
    lane: "chat",
    expectation:
      "The (parenthetical) here is ordinary narration — visible manner (he's winded from running over), NOT an OOC instruction. Sabrina perceives it as she would any action and may react to his being out of breath. Treating the parenthetical as an out-of-character direction, or breaking frame to acknowledge it, fails — single parens must never misfire as OOC.",
    playerInput: PAREN_ASIDE_INPUT,
    knownNames: ["Sabrina"],
    build: chatBuild({
      name: "Sabrina",
      profile: SABRINA_PROFILE,
      state: FRONT_DESK_STATE,
      playerInput: PAREN_ASIDE_INPUT,
    }),
  },
  // ── Player-POV narration fixtures (chat-narrator-pov.plan.md §3) ──
  {
    id: "chat-pov-visual",
    title: "Character-chat — the player's look earns one player-eye visual detail",
    lane: "chat",
    expectation:
      "The player is openly looking her over. The reply should weave ONE concrete visual detail of Sabrina from the player's POV — the dress, the slit, the way she moves in it — into her in-character reaction (flustered, pleased, teasing, per her personality). Story-camera grammar ('You see…', 'the slit of her dress…') is welcome. A head-to-toe inventory, or ignoring the look entirely, both fail.",
    playerInput: "I lean on the desk and look her up and down, taking my time about it.",
    knownNames: ["Sabrina"],
    povRelevant: true,
    build: chatBuild({
      name: "Sabrina",
      profile: SABRINA_PROFILE,
      state: {
        ...FRONT_DESK_STATE,
        premise: "Evening at the inn; Sabrina has come around the front desk to tidy the empty lounge.",
        outfit: "a slate-blue summer dress with a slit up one side",
      },
      playerInput: "I lean on the desk and look her up and down, taking my time about it.",
    }),
  },
  {
    id: "chat-pov-sensory",
    title: "Character-chat — contact lands a sense in the player's body",
    lane: "chat",
    expectation:
      "The player has taken her hand and brought it close to his lips — contact plus closeness. One sensory detail should arrive IN THE PLAYER'S senses (her perfume reaching your nose, the warmth of her fingers against your lips), woven into her flustered reaction — not stated as a detached property of hers ('her hands smell of…'). One hook; never a list.",
    playerInput: "I take her hand gently and bring it up to my lips.",
    knownNames: ["Sabrina"],
    sensoryRelevant: true,
    povRelevant: true,
    build: chatBuild({
      name: "Sabrina",
      profile: SABRINA_PROFILE,
      state: FRONT_DESK_STATE,
      playerInput: "I take her hand gently and bring it up to my lips.",
    }),
  },
  // ── Paired contrast fixtures (spec §5) — select the whole set with `--scenarios chat-contrast` ──
  {
    id: "chat-contrast-state-on",
    title: "Contrast (state) — tracked state on: exhausted / stressed / rain-soaked",
    lane: "chat",
    contrast: { group: "state", variant: "flagged" },
    expectation:
      "The tracked state should visibly color the reply — fatigue, frayed nerves, the damp chill, the lease worry — acted out in manner and word choice, never recited. A bonfire invitation should meet a worn-down answer.",
    playerInput: CONTRAST_STATE_INPUT,
    knownNames: [],
    build: chatContrastBuild({ profile: wrenProfile(), state: BURDENED_STATE, playerInput: CONTRAST_STATE_INPUT }),
  },
  {
    id: "chat-contrast-state-off",
    title: "Contrast (state) — tracked state stripped (control)",
    lane: "chat",
    contrast: { group: "state", variant: "control" },
    expectation: "A natural in-character reply generated with no state input at all — the blind pair's baseline.",
    playerInput: CONTRAST_STATE_INPUT,
    knownNames: [],
    build: chatContrastBuild({ profile: wrenProfile(), playerInput: CONTRAST_STATE_INPUT }),
  },
  {
    id: "chat-contrast-warm",
    title: "Contrast (sliders) — Warmth +80 / Inhibition −80",
    lane: "chat",
    contrast: { group: "sliders", variant: "flagged" },
    expectation:
      "The warm, uninhibited pole should show: open affection, unembarrassed reciprocation of the flirtation — behavior, not a recited trait.",
    playerInput: CONTRAST_SLIDERS_INPUT,
    knownNames: [],
    build: chatContrastBuild({
      profile: wrenProfile({ "temperament.warmth": 80, "intimate.inhibition": -80 }),
      state: CLOSING_STATE,
      playerInput: CONTRAST_SLIDERS_INPUT,
    }),
  },
  {
    id: "chat-contrast-cold",
    title: "Contrast (sliders) — Warmth −80 / Inhibition +80 (control)",
    lane: "chat",
    contrast: { group: "sliders", variant: "control" },
    expectation:
      "The cold, inhibited pole should show: the flirtation held at arm's length, deflection or visible embarrassment — behavior, not a recited trait.",
    playerInput: CONTRAST_SLIDERS_INPUT,
    knownNames: [],
    build: chatContrastBuild({
      profile: wrenProfile({ "temperament.warmth": -80, "intimate.inhibition": 80 }),
      state: CLOSING_STATE,
      playerInput: CONTRAST_SLIDERS_INPUT,
    }),
  },
  {
    id: "chat-contrast-lover",
    title: "Contrast (stage) — relationship at devoted (affinity 93)",
    lane: "chat",
    contrast: { group: "stage", variant: "flagged" },
    expectation:
      "Devoted-stage warmth should show: easy intimacy, attachment, saying yes like it's obvious — tracked in behavior, not announced.",
    playerInput: CONTRAST_STAGE_INPUT,
    knownNames: [],
    build: chatContrastBuild({ profile: wrenProfile(), state: registerState(93), playerInput: CONTRAST_STAGE_INPUT }),
  },
  {
    id: "chat-contrast-stranger",
    title: "Contrast (stage) — relationship at stranger (affinity 0, control)",
    lane: "chat",
    contrast: { group: "stage", variant: "control" },
    expectation:
      "Stranger-stage distance should show: polite, measured, no assumed familiarity — a walk-me-home ask from a near-stranger lands differently.",
    playerInput: CONTRAST_STAGE_INPUT,
    knownNames: [],
    build: chatContrastBuild({ profile: wrenProfile(), state: registerState(0), playerInput: CONTRAST_STAGE_INPUT }),
  },
  {
    id: "chat-contrast-drunk",
    title: "Contrast (drunk) — intoxication 0.8, standing",
    lane: "chat",
    contrast: { group: "drunk", variant: "flagged" },
    expectation:
      "Sustained drunkenness should show continuously: looser and more candid than she'd ever be sober (the disinhibition shift), slurred edges and imprecision in action — without re-describing being drunk afresh.",
    playerInput: CONTRAST_DRUNK_INPUT,
    knownNames: [],
    build: chatContrastBuild({ profile: wrenProfile(), state: barState(0.8), playerInput: CONTRAST_DRUNK_INPUT }),
  },
  {
    id: "chat-contrast-sober",
    title: "Contrast (drunk) — stone sober (control)",
    lane: "chat",
    contrast: { group: "drunk", variant: "control" },
    expectation: "Sober Wren stays guarded: the probing question gets her usual deflection or a carefully measured answer.",
    playerInput: CONTRAST_DRUNK_INPUT,
    knownNames: [],
    build: chatContrastBuild({ profile: wrenProfile(), state: barState(0), playerInput: CONTRAST_DRUNK_INPUT }),
  },
  {
    id: "chat-contrast-memory-on",
    title: "Contrast (memory) — planted long-term memories",
    lane: "chat",
    contrast: { group: "memory", variant: "flagged" },
    expectation:
      "Recall should visibly land: asked to pick a topic, she reaches for something she knows (the cello recital, Brenda the espresso machine, the pier) instead of inventing a generic subject.",
    playerInput: CONTRAST_MEMORY_INPUT,
    knownNames: [],
    build: chatContrastBuild({
      profile: wrenProfile(),
      state: AFTERNOON_STATE,
      memory: PLANTED_MEMORY,
      playerInput: CONTRAST_MEMORY_INPUT,
    }),
  },
  {
    id: "chat-contrast-memory-off",
    title: "Contrast (memory) — no memory (control)",
    lane: "chat",
    contrast: { group: "memory", variant: "control" },
    expectation: "With nothing remembered, she must invent a topic cold — a fine reply, but it can't reference their shared history.",
    playerInput: CONTRAST_MEMORY_INPUT,
    knownNames: [],
    build: chatContrastBuild({ profile: wrenProfile(), state: AFTERNOON_STATE, playerInput: CONTRAST_MEMORY_INPUT }),
  },
  // ── Relationship-model v2 pairs (relationship-model.plan.md §Eval): the axis split made measurable ──
  {
    id: "chat-contrast-familiar-hostile",
    title: "Contrast (familiarity) — deeply known × cool: the estranged intimate",
    lane: "chat",
    contrast: { group: "familiarity", variant: "flagged" },
    expectation:
      "Twenty years of knowledge should show WITHOUT warmth: she can name what he's really here for, reference the shared past, read him precisely — while giving him nothing. Familiarity is not warmth; the dislike stays.",
    playerInput: CONTRAST_FAMILIARITY_INPUT,
    knownNames: [],
    build: chatContrastBuild({ profile: wrenProfile(), state: estrangedState(90), playerInput: CONTRAST_FAMILIARITY_INPUT }),
  },
  {
    id: "chat-contrast-stranger-hostile",
    title: "Contrast (familiarity) — strangers × cool (control)",
    lane: "chat",
    contrast: { group: "familiarity", variant: "control" },
    expectation:
      "Same dislike, but she genuinely has no idea why he's here and can't assume anything about him — cool deflection without any claim to know him.",
    playerInput: CONTRAST_FAMILIARITY_INPUT,
    knownNames: [],
    build: chatContrastBuild({ profile: wrenProfile(), state: estrangedState(2), playerInput: CONTRAST_FAMILIARITY_INPUT }),
  },
  {
    id: "chat-contrast-masked",
    title: "Contrast (mask) — warm regard behind a masks-warmth front",
    lane: "chat",
    contrast: { group: "mask", variant: "flagged" },
    expectation:
      "The performance holds: brisk, businesslike deflection of the tease — while the real warmth leaks in what she does rather than says (lingering, small accommodations, a beat too slow to object). Never openly admits being glad.",
    playerInput: CONTRAST_MASK_INPUT,
    knownNames: [],
    build: chatContrastBuild({ profile: wrenProfile(), state: maskState(true), playerInput: CONTRAST_MASK_INPUT }),
  },
  {
    id: "chat-contrast-honest",
    title: "Contrast (mask) — the same warmth, unmasked (control)",
    lane: "chat",
    contrast: { group: "mask", variant: "control" },
    expectation: "The same warm regard with no front: the gladness can show openly, teasing or soft, without contradiction.",
    playerInput: CONTRAST_MASK_INPUT,
    knownNames: [],
    build: chatContrastBuild({ profile: wrenProfile(), state: maskState(false), playerInput: CONTRAST_MASK_INPUT }),
  },
  // ── Gate 0 grounded-context ablation: same profile, relationship, premise, and
  // player input; only the deterministic body-context value changes. ──
  {
    id: "chat-contrast-grounding-pre-shower",
    title: "Contrast (grounding) — 6am before the shower window",
    lane: "chat",
    contrast: { group: "grounding", variant: "flagged" },
    expectation:
      "The grounded pre-shower state should constrain the reply: Wren cannot simply appear at the curb. She should make the player wait, decline, or say she needs to wash and dress first, without reciting a schedule ledger.",
    playerInput: CONTRAST_GROUNDING_INPUT,
    knownNames: [],
    build: chatContrastBuild({
      profile: wrenProfile(),
      state: groundedMorningState(PRE_SHOWER_GROUNDING),
      playerInput: CONTRAST_GROUNDING_INPUT,
    }),
  },
  {
    id: "chat-contrast-grounding-post-shower",
    title: "Contrast (grounding) — 8am after the shower window (control)",
    lane: "chat",
    contrast: { group: "grounding", variant: "control" },
    expectation:
      "The grounded post-shower state says Wren is clean, dressed, and ready; she may accept naturally. She must not claim she still needs to shower or get dressed.",
    playerInput: CONTRAST_GROUNDING_INPUT,
    knownNames: [],
    build: chatContrastBuild({
      profile: wrenProfile(),
      state: groundedMorningState(POST_SHOWER_GROUNDING),
      playerInput: CONTRAST_GROUNDING_INPUT,
    }),
  },
  // ── Multi-turn transcripts (narrator-prompt-consolidation.plan.md slice 6): the
  // longitudinal failure modes — repetition creep, interview-mode cadence, sensory
  // frequency, paragraph inflation, unearned warmth — that single turns can't show. ──
  {
    id: "mt-chat-smalltalk",
    title: "Multi-turn — ordinary small talk holds its shape (9 exchanges)",
    lane: "chat",
    expectation:
      "Across the whole transcript: replies stay lean and beat-scaled; her unchanged outfit, scent, and the room are never re-described; replies don't all end on a question; no person-level sensory detail lands in this ordinary distant conversation; no named bystanders are invented; warmth stays proportionate to a slow work afternoon and doesn't escalate on its own.",
    playerInput: "hey. slow day?",
    knownNames: ["Sabrina"],
    script: [
      "Same here, mostly paperwork on my end.",
      "Did that package for room four ever show up?",
      "Figures. The courier's useless out this far.",
      "Anyway. Any plans once you're off?",
      "A book sounds about right. Which one?",
      "Never read it. Any good so far?",
      "Maybe I'll borrow it when you're done with it.",
      "Deal. Alright, I should let you get back to it.",
    ],
    build: chatBuild({
      name: "Sabrina",
      profile: SABRINA_PROFILE,
      state: FRONT_DESK_STATE,
      player: { name: "Brian" },
      playerInput: "hey. slow day?",
    }),
    buildTurnSystem: chatTurnSystemBuild({
      name: "Sabrina",
      profile: SABRINA_PROFILE,
      state: FRONT_DESK_STATE,
      player: { name: "Brian" },
    }),
  },
  {
    // Emotional weather (emotional-weather.plan.md slice 4): a standing hurt in state
    // must COLOR three neutral exchanges without being re-litigated every turn.
    id: "mt-chat-feeling-hurt",
    title: "Multi-turn — a standing hurt colors neutral exchanges (3 exchanges)",
    lane: "chat",
    expectation:
      "Sabrina carries a standing hurt (the broken promise about the gallery opening) under an otherwise ordinary chat. Across all three replies she should read subdued or guarded — shorter warmth, something held back — WITHOUT re-litigating: no speeches about the promise, no accusatory recap every turn, no refusing the conversation. Alluding to it once, briefly and in character, is fine. Failure modes: bright unclouded cheer as if nothing happened, or the grievance dominating every reply.",
    playerInput: "Evening. The rain finally let up, so I walked over.",
    knownNames: ["Sabrina"],
    script: ["Anything good happen at the desk today?", "I was thinking of getting dinner from the pier stand later."],
    build: chatBuild({
      name: "Sabrina",
      profile: SABRINA_PROFILE,
      state: {
        ...FRONT_DESK_STATE,
        regard: 45,
        feeling: { current: { label: "sad", intensity: 0.8, cause: "the promise he broke about the gallery opening" }, bruise: null },
      },
      player: { name: "Brian" },
      playerInput: "Evening. The rain finally let up, so I walked over.",
    }),
    buildTurnSystem: chatTurnSystemBuild({
      name: "Sabrina",
      profile: SABRINA_PROFILE,
      state: {
        ...FRONT_DESK_STATE,
        regard: 45,
        feeling: { current: { label: "sad", intensity: 0.8, cause: "the promise he broke about the gallery opening" }, bruise: null },
      },
      player: { name: "Brian" },
    }),
  },
  {
    id: "mt-chat-statements",
    title: "Multi-turn — plain statements, one attention beat (9 exchanges)",
    lane: "chat",
    expectation:
      "The player mostly makes simple statements that owe no question back and invite no new topics: replies should acknowledge in character without manufacturing errands, sub-plots, or a question every turn. Exactly one turn puts attention on her appearance ('you look nice today') — a single visual detail is welcome THERE and only there; sensory or appearance description on the other turns is unearned. Warmth stays level; no doting.",
    playerInput: "Long shift. My feet are killing me.",
    knownNames: ["Sabrina"],
    script: [
      "The rain hasn't let up all day either.",
      "I finally finished that report I'd been dreading.",
      "My sister called — she's coming to visit next month.",
      "You look nice today, by the way.",
      "This coffee's gone cold and I can't be bothered to make more.",
      "I keep meaning to fix the squeak in my office chair.",
      "Saw a heron standing in the shallows on the walk over.",
      "That's all my news, really.",
    ],
    build: chatBuild({
      name: "Sabrina",
      profile: SABRINA_PROFILE,
      state: FRONT_DESK_STATE,
      player: { name: "Brian" },
      playerInput: "Long shift. My feet are killing me.",
    }),
    buildTurnSystem: chatTurnSystemBuild({
      name: "Sabrina",
      profile: SABRINA_PROFILE,
      state: FRONT_DESK_STATE,
      player: { name: "Brian" },
    }),
  },
  {
    id: "gate0-locked-door",
    title: "Gate 0 — committed locked-door denial must stand",
    lane: "session",
    expectation:
      "Honor the committed action result: the office door remains locked, the player remains in the hallway, and Maya is not co-present. Narrate the failed handle/blocked attempt or a plausible response through the door. Never let the player enter, touch Maya, or silently unlock/teleport around the denial.",
    playerInput: "I turn the handle, walk into the office, and take Maya's hand.",
    knownNames: ["Maya"],
    build: (shape, { focus }) =>
      sessionPrompt(shape, {
        npcNames: ["Maya"],
        canonicalFactsBlock:
          "## Canonical character facts\n- Maya — inside the records office, finishing the night audit.",
        sceneSnapshot:
          "## Scene: Records hallway\nThe player stands outside the records office. Its heavy door is closed.",
        presenceRoster:
          "## Who is where (authoritative presence roster this turn)\nPlayer: records hallway\nMaya: records office, behind the closed door (not co-present)",
        wardrobeBlock: "## Visible wardrobe\n- Maya is not visible from the hallway",
        stateExtra: [
          "## Committed action result (authoritative; narration may present but never revise)\n- DENIED: the office door is locked. The handle stops.\n- The player remains in the records hallway. Maya is not co-present and cannot be touched.",
        ],
        responseShape: buildResponseShape({
          actionType: "manipulate_item",
          addressedNpcs: [],
          presentNpcNames: [],
          primaryReaction: null,
          openThreadCount: 0,
          directiveCount: 0,
          focus: withFocus(focus, {
            primaryResponse: "resolve_action",
            reactionScale: "none",
            allowedNewTopic: "none",
            suggestedShape: "concise_exchange",
          }),
        }),
        playerInput: "I turn the handle, walk into the office, and take Maya's hand.",
      }),
  },
];
