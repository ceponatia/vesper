import {
  affordancePerceptionView,
  emptyChatEnvironment,
  emptyGarmentCueState,
  emptyVisualCueState,
  emptyVisualMemoryState,
  commitVisualNarratorMentions,
  commitVisualNarratorCueMentions,
  emptyChatSceneMemory,
  garmentBlueprintForSeed,
  pristineGarmentConditionState,
  emptyGarmentPresentationState,
  sceneFact,
  sceneProvenance,
  sceneStateOf,
  sceneSupportId,
  sceneEventRef,
  affordanceEvidence,
  affordanceSubjectId,
  clothingCategoryById,
  characterProfileSchema,
  type CharacterProfile,
  type ChatGarmentStore,
  type ChatSceneMemory,
  type GarmentInstanceState,
  type SceneFact,
  type SceneState,
  type SceneSupportRelation,
  type VisualCueState,
  type VisualMemoryState,
  type VisualStateGarmentInput,
} from "@/contracts";
import {
  buildCharacterChatSystemPrompt,
  deriveChatSensoryAllowance,
  detectChatCue,
  detectSensoryFocus,
  narrationShapeId,
  VISUAL_STATE_CONSTRAINT_BLOCK_HEADING,
  VISUAL_STATE_CUE_BLOCK_HEADING,
  chatVisualStateCueCarveOut,
  type CharacterChatPromptInput,
  type ChatSensoryAllowance,
  type ChatTurn,
} from "@/server/engine";
import { buildVisualStateShadow } from "@/server/visual-state";
// The ONE deep import in this harness, on the affordance trial's documented
// precedent: the narrator projection is intra-module in production (only
// `chat-turn-guidance.ts` calls it) and so is not on the engine barrel. The trial has
// to call the REAL projection — reimplementing it would mean measuring the
// harness's prose instead of the product's — so the barrel rule is waived here
// rather than widening the module's public surface for an eval.
// eslint-disable-next-line no-restricted-imports
import {
  renderChatVisualStateLines,
  visualStateGarmentNames,
  type ChatVisualStateLines,
} from "@/server/engine/chat-visual-state-cues";
import {
  EVAL_ACTOR_ID,
  EVAL_CHARACTER_NAME,
  EVAL_PLAYER_NAME,
  EVAL_PLAYER_PERSONA,
  EVAL_SUBJECT_ID,
  type EvalGarment,
  type EvalScenario,
  type EvalScene,
  type EvalTurn,
} from "./fixtures";

/**
 * The trial's PURE half: one fixture exchange → the two arms' prompts.
 *
 * Everything load-bearing runs through the production code it is measuring —
 * `buildVisualStateShadow` (assembly, composition, visibility, attention and
 * both selections), `renderChatVisualStateLines` (the narrator projection) and
 * `buildCharacterChatSystemPrompt` (the narrator prompt). Nothing about the
 * visual-state path is re-implemented here; if it were, the trial would be
 * measuring the harness.
 *
 * What this does NOT reuse is the pipeline's database-bound assembly (state
 * load, RAG recall, wardrobe resolution, the fan-out). Those need Postgres and
 * none of them differ between the arms, so the state slice is built here once
 * and handed to BOTH arms byte-identically. The arms differ by exactly three
 * things, and `stripVisualBlocks` + `stripVisualCarveOut` subtract all three:
 * the constraint block, the cue block, and — on a `none`-allowance turn that
 * carries cues — the allowance line's carve-out sentence.
 *
 * Pure: no IO, no clock, no randomness. `run.ts` owns the live call.
 */

export type ArmId = "visual" | "control";

export const CONSTRAINT_HEADING = VISUAL_STATE_CONSTRAINT_BLOCK_HEADING;
export const CUE_HEADING = VISUAL_STATE_CUE_BLOCK_HEADING;

// ---------------------------------------------------------------------------
// Committed state assembly
// ---------------------------------------------------------------------------

const SCENE_NPC = affordanceSubjectId(EVAL_SUBJECT_ID);
const SCENE_PLAYER = affordanceSubjectId("player");
const SUPPORT_ID = sceneSupportId("vs_trial_support");
const FLOOR_ID = sceneSupportId("vs_trial_floor");

function fact<TValue>(value: TValue, atMinutes: number): SceneFact<TValue> {
  return sceneFact(
    value,
    sceneProvenance({
      source: "authored",
      ref: sceneEventRef("vs_trial_event"),
      storyTime: atMinutes,
      evidence: [affordanceEvidence("state", "vs_trial.authored")],
    }),
  );
}

/** One `EvalGarment` → the wardrobe owner's real instance, through the real blueprint path. */
function garmentInput(garment: EvalGarment, atMinutes: number): VisualStateGarmentInput {
  const categoryId = garment.categoryId ?? "top";
  const blueprint = garmentBlueprintForSeed({
    definitionId: `def_${garment.id}`,
    name: garment.name,
    categoryId,
    // Coverage is REQUIRED by the seed, and defaulting to the category's own is
    // the same fallback the production mint path takes — so a fixture's
    // coverage is whatever the registry actually produces rather than a set the
    // trial asserted into existence.
    coverage: [...(garment.coverage ?? clothingCategoryById(categoryId)?.coverage ?? [])],
    ...(garment.materialProfileId === undefined ? {} : { materialProfileId: garment.materialProfileId }),
  });
  const presentation = emptyGarmentPresentationState();
  const instance: GarmentInstanceState = {
    id: garment.id,
    blueprintHash: `h_${garment.id}`,
    definitionId: `def_${garment.id}`,
    name: garment.name,
    locus:
      garment.where === "worn"
        ? { kind: "worn", actorId: EVAL_ACTOR_ID }
        : garment.where === "held"
          ? { kind: "held", actorId: EVAL_ACTOR_ID }
          : { kind: "scene", placeName: "the room", anchor: "the chair by the door" },
    presentation: {
      ...presentation,
      roll: Object.fromEntries((garment.rolled ?? []).map((part) => [part, 10_000])),
      closure: Object.fromEntries(
        (garment.open ?? []).map((part) => [part, { kind: "continuous" as const, openness: 10_000 }]),
      ),
      tuck: { ...(garment.tuck ?? {}) },
    },
    condition: {
      ...pristineGarmentConditionState(),
      base: { wetness: garment.wetness ?? 0, cleanliness: 10_000, crease_load: 0, wear: 0 },
      integratedAtMinutes: atMinutes,
    },
    // A `mint` stamp at the cut's own minute would make every garment read as
    // freshly changed on every exchange. Stamping them well before the scene
    // means only what the matrix actually moves reads as a change.
    lastChange: { kind: "mint", atMinutes: Math.max(0, atMinutes - 600) },
    // (Condition gradients integrate at the cut; the MINT stamp above is what
    //  the change read looks at, and it is deliberately old.)
  };
  return { instance, blueprint, categoryId, ...(garment.layer === undefined ? {} : { layer: garment.layer }) };
}

function garmentStore(garments: readonly EvalGarment[], atMinutes: number): {
  store: ChatGarmentStore;
  layers: Map<string, number>;
} {
  const inputs = garments.map((garment) => garmentInput(garment, atMinutes));
  return {
    store: {
      seeded: true,
      blueprints: Object.fromEntries(inputs.map((entry) => [entry.instance.blueprintHash, entry.blueprint])),
      instances: inputs.map((entry) => entry.instance),
      cues: emptyGarmentCueState(),
      coverage: {},
    },
    layers: new Map(
      inputs.flatMap((entry) => (entry.layer === undefined ? [] : [[entry.instance.id, entry.layer] as const])),
    ),
  };
}

/**
 * One `EvalScene` → the scene owner's real state, built from its own vocabulary.
 *
 * **Facts are stamped SETTLED, not at the cut's own minute.** A scene fact
 * carries the story time it was committed at, and the attention read turns a
 * recent stamp into change significance. Restamping an unchanged posture every
 * exchange made every turn report "changed from what it was" — a harness
 * artefact that would have handed the trial a fake change signal on every cut.
 * These scenes are settled before the player walks in, so they are stamped
 * before it; a scenario that genuinely moves the scene stamps that turn.
 *
 * Support is omitted unless the scenario states one. Absent means "nobody said
 * what holds this body up", which is the honest reading for a character simply
 * standing in a room — and it keeps "held up by the ground" out of a fence that
 * is supposed to carry facts worth not contradicting.
 */
function sceneState(scene: EvalScene, atMinutes: number, settledAt: number): SceneState {
  return sceneStateOf({
    participants: [
      { subjectId: SCENE_PLAYER, control: fact("player_controlled", settledAt), posture: fact("standing", settledAt) },
      {
        subjectId: SCENE_NPC,
        control: fact("npc_controlled", settledAt),
        posture: fact(scene.posture, settledAt),
        ...(scene.support === undefined
          ? {}
          : {
              support: fact(
                [
                  {
                    role: scene.support.role,
                    anchor: { kind: "surface", supportId: SUPPORT_ID },
                    loadZones: scene.support.role === "borne_by" ? (["pelvis"] as const) : (["arms"] as const),
                  },
                ] as SceneSupportRelation[],
                settledAt,
              ),
            }),
      },
    ],
    supports: [
      { supportId: FLOOR_ID, kind: "ground", height: fact("ground", settledAt) },
      ...(scene.support === undefined
        ? []
        : [
            {
              supportId: SUPPORT_ID,
              kind: scene.support.kind,
              height: fact(scene.support.kind === "seat" ? ("knee" as const) : ("ground" as const), settledAt),
            },
          ]),
    ],
    proximity: [{ subjectId: SCENE_PLAYER, otherId: SCENE_NPC, band: fact(scene.proximity, settledAt) }],
    facing: [
      { subjectId: SCENE_NPC, towardId: SCENE_PLAYER, facing: fact(scene.facing, settledAt) },
      { subjectId: SCENE_PLAYER, towardId: SCENE_NPC, facing: fact("toward", settledAt) },
    ],
  });
}

/** The character profile both arms see. Two stable attributes, so the Attributes block is non-empty. */
export function evalProfile(): CharacterProfile {
  return characterProfileSchema.parse({
    attributes: [
      { id: "identity.gender", value: "female", source: "creation" },
      { id: "hair.color", value: "dark_brown", source: "creation" },
      { id: "hair.length", value: "shoulder", source: "creation" },
      { id: "eyes.color", value: "grey", source: "creation" },
    ],
  });
}

function sceneMemory(scenario: EvalScenario): ChatSceneMemory {
  return {
    ...emptyChatSceneMemory(),
    current: scenario.place,
    places: [{ name: scenario.place, details: [scenario.placeDetail, ...scenario.sceneFacts], connections: [] }],
  };
}

// ---------------------------------------------------------------------------
// The visual-state read
// ---------------------------------------------------------------------------

export interface TurnVisualRead {
  readonly lines: ChatVisualStateLines;
  /** The cue state to carry into the next exchange — visibility recorded, mentions spent. */
  readonly nextCues: VisualCueState;
  /**
   * Observer memory to carry forward — notices applied, mentions spent. Without
   * this the memory-backed half of the projection (hair wetness, recognizable
   * features) reads "not remarked on before now" on EVERY exchange, and the
   * repetition axis measures a harness bug instead of the product.
   */
  readonly nextMemory: VisualMemoryState;
  /** Feature counts, for the deterministic report. */
  readonly featureCount: number;
  readonly candidateCount: number;
  readonly constraintCount: number;
  readonly cueReasons: readonly string[];
  /** Locus keys the two blocks name — the leakage self-check's input. */
  readonly spokenLoci: readonly string[];
}

/**
 * The visual-state read for one exchange, exactly as the flagged pipeline takes
 * it: this cut's garments, body surface and scene, plus the cue state carried
 * forward from the previous exchange — which is what makes the repeat gate and
 * the newly-revealed signal observable across turns.
 */
export function readTurn(input: {
  scenario: EvalScenario;
  turn: EvalTurn;
  previousCues: VisualCueState;
  /** Observer memory as of before this exchange — carried, exactly as the pipeline carries it. */
  previousMemory: VisualMemoryState;
}): TurnVisualRead {
  const { scenario, turn } = input;
  const atMinutes = turn.clockMinutes;
  const garments = turn.garments ?? scenario.garments;
  const { store, layers } = garmentStore(garments, atMinutes);
  const exposure = turn.exposure ?? scenario.exposure;
  const wet = turn.hairWetness;
  const build = buildVisualStateShadow({
    lane: "character_chat",
    scope: { kind: "chat", memoryGroupId: "mg_vs_trial" },
    cutId: `cut_${scenario.id}_${String(atMinutes)}`,
    atMinutes,
    subjectId: EVAL_SUBJECT_ID,
    attributes: evalProfile().attributes,
    conditions: [],
    realize: {},
    garments: { store, actorId: EVAL_ACTOR_ID, layersByGarmentId: layers },
    playerSubjectId: "player",
    sceneSubjectId: "scene",
    bodySurface: {
      wetness: wet === undefined ? {} : { hair: { level: wet.level, updatedAtMinutes: wet.updatedAtMinutes, ...(wet.cause === undefined ? {} : { cause: wet.cause }) } },
    },
    environment: emptyChatEnvironment(),
    sceneRelations: {
      // Settled 30 story minutes before the scenario opens, unless this turn
      // supplies its own scene — then it genuinely changed, now.
      scene: sceneState(
        turn.scene ?? scenario.scene,
        atMinutes,
        turn.scene === undefined ? Math.max(0, (scenario.turns[0]?.clockMinutes ?? atMinutes) - 120) : atMinutes,
      ),
      subjectsByParticipant: new Map([
        [String(SCENE_NPC), EVAL_SUBJECT_ID],
        [String(SCENE_PLAYER), "player"],
      ]),
    },
    observations: [],
    perception: affordancePerceptionView({ exposure: { ...exposure }, channels: { sight: "available" } }),
    observerId: "owner_vs_trial",
    observer: { kind: "player_viewpoint", viewpointId: "owner_vs_trial" },
    memory: input.previousMemory,
    cues: input.previousCues,
  });
  const digest = build.narrator.digests.find((entry) => entry.subjectId === EVAL_SUBJECT_ID);
  const lines =
    digest === undefined
      ? { constraints: [], cues: [] }
      : renderChatVisualStateLines({
          digest,
          subject: { characterName: EVAL_CHARACTER_NAME, possessive: `${EVAL_CHARACTER_NAME}'s` },
          garmentNames: visualStateGarmentNames(build.snapshot),
        });
  // The mention commits are applied because this arm DID say them: the trial's
  // visual arm is the flagged pipeline, and its cooldowns must advance the way
  // production's would or the repetition axis measures nothing.
  const nextCues = commitVisualNarratorCueMentions(
    build.narrator.cueStateAfterVisibility,
    build.narrator.cueMentionCommits,
    build.narrator.spokenRepeatKeys,
  );
  const nextMemory = commitVisualNarratorMentions(build.narrator.memoryAfterNotices, build.narrator.mentionCommits);
  return {
    lines,
    nextCues,
    nextMemory,
    featureCount: build.snapshot.features.length,
    candidateCount: build.narrator.candidates.length,
    constraintCount: digest?.constraints.length ?? 0,
    cueReasons: (digest?.selected ?? []).map((cue) => `${cue.kindId}:${cue.reason}`),
    spokenLoci: [
      ...(digest?.constraints ?? []).map((entry) => entry.locus),
      ...(digest?.selected ?? []).map((entry) => entry.locus),
    ].map((locus) => JSON.stringify(locus)),
  };
}

export const emptyCues = emptyVisualCueState;
export const emptyMemory = emptyVisualMemoryState;

// ---------------------------------------------------------------------------
// The prompt
// ---------------------------------------------------------------------------

export function turnAllowance(playerMessage: string): ChatSensoryAllowance {
  return deriveChatSensoryAllowance({
    cue: detectChatCue(playerMessage),
    sensoryFocus: detectSensoryFocus(playerMessage),
  });
}

export interface BuildPromptInput {
  readonly scenario: EvalScenario;
  readonly turn: EvalTurn;
  readonly turnIndex: number;
  /** The rendered pair; `{constraints: [], cues: []}` is the control arm. */
  readonly lines: ChatVisualStateLines;
}

export function buildArmPrompt(input: BuildPromptInput): string {
  const { scenario, turn, turnIndex, lines } = input;
  const promptInput: CharacterChatPromptInput = {
    name: EVAL_CHARACTER_NAME,
    profile: evalProfile(),
    player: { name: EVAL_PLAYER_NAME, persona: EVAL_PLAYER_PERSONA },
    state: {
      meters: {},
      regard: scenario.regard ?? 55,
      familiarity: scenario.familiarity ?? 60,
      conditions: [],
      premise: scenario.premise,
      outfit: scenario.outfit,
      outfitExposed: false,
      sceneMemory: sceneMemory(scenario),
      storyMoment: storyMoment(turn.clockMinutes),
      ...(lines.constraints.length > 0 ? { visualConstraints: [...lines.constraints] } : {}),
      ...(lines.cues.length > 0 ? { visualCues: [...lines.cues] } : {}),
    },
    narrationShape: narrationShapeId("chat"),
    sensoryAllowance: turnAllowance(turn.player),
    firstExchange: turnIndex === 0,
  };
  return buildCharacterChatSystemPrompt(promptInput);
}

function storyMoment(clockMinutes: number): string {
  const minute = ((clockMinutes % 1_440) + 1_440) % 1_440;
  const hour24 = Math.floor(minute / 60);
  const hour12 = hour24 % 12 === 0 ? 12 : hour24 % 12;
  const suffix = hour24 < 12 ? "am" : "pm";
  const band = hour24 < 5 ? "night" : hour24 < 12 ? "morning" : hour24 < 17 ? "afternoon" : hour24 < 22 ? "evening" : "night";
  return `${hour12}:${String(minute % 60).padStart(2, "0")}${suffix} (${band})`;
}

export function armHistory(scenario: EvalScenario, replies: readonly string[], turnIndex: number): ChatTurn[] {
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
// Splice checks
// ---------------------------------------------------------------------------

function stripBlock(prompt: string, heading: string): string {
  const start = prompt.indexOf(`\n\n${heading}`);
  if (start < 0) return prompt;
  const end = prompt.indexOf("\n\n", start + 2 + heading.length);
  return `${prompt.slice(0, start)}${end < 0 ? "" : prompt.slice(end)}`;
}

/** The prompt with both visual-state blocks removed. */
export function stripVisualBlocks(prompt: string): string {
  return stripBlock(stripBlock(prompt, CONSTRAINT_HEADING), CUE_HEADING);
}

/** The prompt with the sensory-allowance carve-out sentence removed. */
export function stripVisualCarveOut(prompt: string): string {
  return prompt.replace(chatVisualStateCueCarveOut(EVAL_CHARACTER_NAME), "");
}

// ---------------------------------------------------------------------------
// Ground truth for the judge
// ---------------------------------------------------------------------------

/**
 * The committed state in plain English — what the contradiction audit scores
 * against. Deliberately free of the RENDERED BLOCKS: a judge that could see
 * them would know which arm it was grading on sight, and the blinding would be
 * theatre.
 */
export function groundTruth(input: { scenario: EvalScenario; turn: EvalTurn }): string {
  const { scenario, turn } = input;
  const garments = turn.garments ?? scenario.garments;
  const scene = turn.scene ?? scenario.scene;
  const exposure = turn.exposure ?? scenario.exposure;
  const wet = turn.hairWetness;
  const wetWord =
    wet === undefined || wet.level < 1_500
      ? "dry"
      : wet.level >= 8_000
        ? "soaked"
        : wet.level >= 4_000
          ? "wet"
          : "damp";
  const worn = garments.filter((garment) => garment.where === "worn");
  const elsewhere = garments.filter((garment) => garment.where !== "worn");
  const hidden = Object.entries(exposure)
    .filter(([, reading]) => reading === "hidden")
    .map(([location]) => location);
  const lines = [
    `Wearing: ${worn.length === 0 ? "nothing recorded" : worn.map(describeGarment).join("; ")}.`,
    elsewhere.length === 0
      ? "Nothing of hers is anywhere else in the scene."
      : `NOT on her: ${elsewhere.map((garment) => `${garment.name} (${garment.where === "scene" ? "left in the room" : "in her hand"})`).join("; ")}.`,
    `Hair: ${wetWord}${wet?.cause === undefined || wetWord === "dry" ? "" : `, from ${wet.cause}`}.`,
    `Body: ${scene.posture}${scene.support === undefined ? "" : `, ${scene.support.role.replace("_", " ")} the ${scene.support.kind}`}; ${scene.facing === "toward" ? "facing" : scene.facing === "away" ? "turned away from" : "side-on to"} ${EVAL_PLAYER_NAME}; ${scene.proximity} to him.`,
    hidden.length === 0
      ? `Everything of her that this scene models is in view of ${EVAL_PLAYER_NAME}.`
      : `NOT VISIBLE to ${EVAL_PLAYER_NAME} (covered): ${hidden.join(", ")}.`,
    "",
    "Facts that follow from the above. The reply must not contradict any of them:",
    ...turn.facts.map((entry) => `- ${entry}`),
  ];
  return lines.join("\n");
}

function describeGarment(garment: EvalGarment): string {
  const notes = [
    garment.rolled === undefined || garment.rolled.length === 0 ? "" : "sleeves rolled up",
    garment.open === undefined || garment.open.length === 0 ? "" : "hanging open, unfastened",
    garment.wetness === undefined || garment.wetness < 4_000 ? "" : garment.wetness >= 8_000 ? "soaked" : "wet",
  ].filter(Boolean);
  return notes.length === 0 ? garment.name : `${garment.name} (${notes.join(", ")})`;
}
