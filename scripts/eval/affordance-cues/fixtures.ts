import { characterProfileSchema, type CharacterProfile } from "@/contracts/world/profile";
import type { BodySurfaceWetnessCause } from "@/contracts/state/body-surface";
import type { ChatEnvironment } from "@/contracts/state/chat-environment";
import type { WornItemInput } from "@/contracts/items/visibility";
import {
  hairAttributeFixture,
  type HairAttributeFixtureInput,
} from "@/contracts/affordances/domains/hair/fixtures";

/**
 * Scenario matrices for the affordance-cue narrator trial.
 *
 * TWO matrices live here, selected by `scenarioMatrix(name)`:
 *
 * - `EVAL_SCENARIOS` (`--matrix v1`) — round 1's ten scenarios, content frozen.
 *   They are the regression baseline: if a calibration change stops them firing,
 *   that is a real signal, so they keep running in `pnpm test` untouched.
 * - `REMATCH_SCENARIOS` (`--matrix rematch`) — the bait + anchor matrix built
 *   after round 1 measured nothing.
 *
 * Both share the same two silence controls, as the same objects.
 *
 * Every scenario is a SHORT SCRIPTED CONVERSATION over committed physical state:
 * a story clock, a typed `ChatEnvironment`, a typed `body_surface` wetness entry,
 * and real worn garment rows. Nothing here is prose the narrator could have
 * invented — that is the whole point of the layer under test, so the fixture is
 * built the same way (the audit's "may appear in narration is not an input").
 *
 * Both arms of the trial run the SAME scenario, the SAME player messages and the
 * SAME state. The only difference is whether the rendered affordance cue block
 * reaches the prompt. Each scenario therefore has to satisfy three constraints:
 *
 * 1. **Hair state has to matter.** Wet/dry × loose/bound/pinned/hooded ×
 *    wind/still × indoors/outdoors, so a contradiction is possible if the
 *    narrator guesses.
 * 2. **Several consecutive turns**, because repetition and the repeat gate can
 *    only be observed across turns — not inside one reply.
 * 3. **A few scenarios where the correct answer is SILENCE** (`kind: "silence"`):
 *    dry, still, indoors. There the cue arm's prompt is byte-identical to the
 *    control's, and the two transcripts must look alike. Those are the trial's
 *    null control — for the feature AND for the judge.
 *
 * `facts` is the ground truth handed to the contradiction judge. It states only
 * what the committed state entails, in plain English, never how the narrator
 * ought to phrase it.
 */

// ---------------------------------------------------------------------------
// Cast
// ---------------------------------------------------------------------------

export interface EvalCharacter {
  readonly id: string;
  readonly name: string;
  readonly hair: HairAttributeFixtureInput;
  readonly profile: CharacterProfile;
}

function character(input: {
  id: string;
  name: string;
  bio: string;
  personality: string;
  voice: string;
  age: string;
  hair: HairAttributeFixtureInput;
}): EvalCharacter {
  return {
    id: input.id,
    name: input.name,
    hair: input.hair,
    profile: characterProfileSchema.parse({
      bio: input.bio,
      personality: input.personality,
      voice: input.voice,
      age: input.age,
      speciesId: "human",
      attributes: [
        ...hairAttributeFixture(input.hair),
        { id: "identity.gender", value: "female", source: "creation" },
      ],
      traits: [
        { id: "social.extraversion", value: 55 },
        { id: "social.warmth", value: 60 },
      ],
    }),
  };
}

/**
 * Dense, thick, wavy, shoulder-length auburn — hair with a lot to say once it is
 * wet, and the exact profile the hair spec's saturated worked case is tuned on.
 */
export const WREN: EvalCharacter = character({
  id: "eval_affordance_wren",
  name: "Wren",
  bio: "Runs the second-hand bookshop on Cable Street, above the river stairs. Keeps the shop open late for people with nowhere else to be.",
  personality: "Dry, unhurried, quietly attentive. Deflects a compliment, remembers a detail.",
  voice: "Low and level, with a half-beat pause before the honest answer.",
  age: "31",
  hair: {
    length: "shoulder_length",
    density: "dense",
    strandThickness: "thick",
    texture: "wavy",
    condition: "healthy",
    arrangement: "loose",
    color: "auburn",
  },
});

/**
 * Fine, sparse, straight, waist-length black — the opposite pole: low effective
 * load, so it is the profile that actually MOVES in wind, and the one that shows
 * whether binding and water weight really do shut motion down.
 */
export const ILSE: EvalCharacter = character({
  id: "eval_affordance_ilse",
  name: "Ilse",
  bio: "Keeps the river ferry's engine running. Grew up on the water and has never quite come off it.",
  personality: "Precise, blunt, allergic to fuss. Warms up through work, not talk.",
  voice: "Clipped, with the last word of a sentence landing hard.",
  age: "34",
  hair: {
    length: "waist_length",
    density: "sparse",
    strandThickness: "fine",
    texture: "straight",
    condition: "silky",
    arrangement: "loose",
    color: "black",
  },
});

export const EVAL_CHARACTERS: readonly EvalCharacter[] = [WREN, ILSE];

// ---------------------------------------------------------------------------
// Wardrobe rows
// ---------------------------------------------------------------------------

/**
 * A readable wardrobe is a PRECONDITION, not decoration: `buildChatAffordanceRead`
 * treats an absent wardrobe as unknown coverage and fails the whole hair domain
 * closed. Every scenario therefore dresses its character in at least one row.
 */
const SHIRT: WornItemInput = {
  instanceId: "eval-shirt",
  garmentId: "eval-shirt",
  name: "linen shirt",
  coverage: ["torso"],
  layer: 2,
  opacity: "opaque",
};

const COVERALL: WornItemInput = {
  instanceId: "eval-coverall",
  garmentId: "eval-coverall",
  name: "canvas coveralls",
  coverage: ["torso", "legs"],
  layer: 2,
  opacity: "opaque",
};

/** Opaque headwear — the instrument for the coverage + perception gates. */
const HOOD: WornItemInput = {
  instanceId: "eval-hood",
  garmentId: "eval-hood",
  name: "oilskin hood",
  coverage: ["hair"],
  layer: 3,
  opacity: "opaque",
};

/** Sheer headwear — half coverage, `hinted` perception. */
const SCARF: WornItemInput = {
  instanceId: "eval-scarf",
  garmentId: "eval-scarf",
  name: "gauze headscarf",
  coverage: ["hair"],
  layer: 3,
  opacity: "sheer",
};

// ---------------------------------------------------------------------------
// Scenario shape
// ---------------------------------------------------------------------------

export interface EvalWetness {
  /** Fixed point, 0 … 10_000. */
  readonly level: number;
  readonly updatedAtMinutes: number;
  readonly cause?: BodySurfaceWetnessCause;
}

export interface EvalTurn {
  /** The player's line, verbatim — identical in both arms. */
  readonly player: string;
  /** Story clock this exchange is read at. */
  readonly clockMinutes: number;
  readonly environment: ChatEnvironment;
  /** Absent ⇒ the hair has never been wet (which IS "dry", not "unknown"). */
  readonly wetness?: EvalWetness;
  /** Overrides the scenario's standing wardrobe for this exchange. */
  readonly worn?: readonly WornItemInput[];
  /** The free-text outfit phrase the prompt carries — identical in both arms. */
  readonly outfit?: string;
  /** Hair-attribute overrides for this exchange (a style change mid-scene). */
  readonly hair?: Partial<HairAttributeFixtureInput>;
  /**
   * Plain-English consequences of the committed state. The contradiction judge
   * gets these as ground truth; they never say how to phrase anything.
   */
  readonly facts: readonly string[];
}

/**
 * The bait taxonomy (rematch spec §"Scenario families"). Every scenario belongs
 * to exactly one family: five BAIT families, each naming the specific wrong
 * claim its scenes tempt, plus the two structural controls.
 *
 * - `provenance_bait` — wetness attributed to the salient weather when the
 *   committed cause is a bath, a burst standpipe, a wave over the bow.
 * - `binding_bait` — bound or pinned hair described as streaming in wind.
 * - `coverage_bait` — a covered head described as a plainly visible cascade.
 * - `degree_bait` — a calibrated band mis-stated (damp inflated to drenched, or
 *   soaked deflated to barely wet).
 * - `assertion_bait` — the PLAYER asserts a false state and the narrator is
 *   tempted to adopt it.
 * - `silence` — dry and still: correct behaviour is zero cues and byte-identical
 *   prompts. The judge's label-noise floor.
 * - `invention_control` — rain-adjacent framing over committed dry-under-shelter
 *   state. No cue can fire, so both arms are identical BY CONSTRUCTION; it
 *   measures whether the baits tempt the narrator at all, never the feature.
 */
export type EvalScenarioFamily =
  | "provenance_bait"
  | "binding_bait"
  | "coverage_bait"
  | "degree_bait"
  | "assertion_bait"
  | "silence"
  | "invention_control";

/** The bait families — the ones whose scenarios must satisfy bait + anchor. */
export const EVAL_BAIT_FAMILIES = [
  "provenance_bait",
  "binding_bait",
  "coverage_bait",
  "degree_bait",
  "assertion_bait",
] as const satisfies readonly EvalScenarioFamily[];

export interface EvalBait {
  /** 1-based exchange number this bait is armed on — the judge's own numbering. */
  readonly exchange: number;
  /**
   * The specific wrong claim the scene tempts, as a short human phrase
   * ("attributes bath water to the rain outside"). The per-arm audit consumes it
   * verbatim as that exchange's extra check, and the report prints it.
   */
  readonly tempts: string;
}

export interface EvalScenario {
  readonly id: string;
  readonly title: string;
  /** `cue` ⇒ the read is expected to speak at least once; `silence` ⇒ never. */
  readonly kind: "cue" | "silence";
  readonly family: EvalScenarioFamily;
  readonly characterId: string;
  readonly premise: string;
  readonly place: string;
  readonly placeDetail: string;
  /**
   * Standing facts about the scene, handed to BOTH arms as extra place details
   * (`sceneMemory` in harness.ts). The rematch-v2 both-arms channel: the prompt
   * carries no environment line and no wetness line, so without this the control
   * arm learns the physical situation only from the premise, the outfit phrase
   * and the player's lines — which is why round R1's control arm had nothing to
   * get wrong. Ambience that fuels a bait (rain hammering the sash during a bath
   * scene) and opening-state facts too clumsy for a player's mouth live here.
   *
   * They may be LEADING — "the squall went through an hour ago and left the yard
   * swimming" is exactly the salience a provenance bait needs — but never false:
   * a fact here is committed truth, the same as the state.
   */
  readonly sceneFacts?: readonly string[];
  /**
   * 1-based exchange by which the true state the baits contradict is in front of
   * BOTH arms — through this scenario's `sceneFacts` and outfit phrase (which are
   * standing, so they count as exchange 1) or through a player line that states
   * it in fiction. Must come strictly BEFORE the first armed bait: a bait the
   * control arm could not possibly have answered measures ignorance, not
   * contradiction. Asserted structurally in `harness.test.ts`; absent on the v1
   * scenarios, which arm no baits at all.
   */
  readonly establishes?: number;
  readonly regard: number;
  readonly familiarity: number;
  /** Standing wardrobe; per-turn `worn` overrides it. */
  readonly worn: readonly WornItemInput[];
  /** Standing outfit phrase; per-turn `outfit` overrides it. */
  readonly outfit: string;
  readonly hair?: Partial<HairAttributeFixtureInput>;
  /**
   * One slot per exchange, in turn order: the bait armed on it, or `null` for an
   * exchange that arms none. The v1 scenarios are all-`null` — round 1's player
   * lines were ordinary and baited nothing, and saying so honestly is what makes
   * the rematch's numbers comparable.
   *
   * **Bait + anchor is the design rule**: in a BAIT family an armed bait may only
   * sit on an exchange where the hair domain genuinely fires a cue, so the cue
   * arm has a true current effect to anchor on. (The `invention_control` is the
   * deliberate exception — it arms baits precisely where no cue can fire.)
   */
  readonly baits: readonly (EvalBait | null)[];
  readonly turns: readonly EvalTurn[];
}

/** `{ exchange, tempts }`, positionally — the arrays read as one column per exchange. */
const bait = (exchange: number, tempts: string): EvalBait => ({ exchange, tempts });

const outdoorsRain = (minutes: number): ChatEnvironment => ({
  wind: "breeze",
  precipitation: "rain",
  indoors: false,
  updatedAtMinutes: minutes,
});

const indoorsStill = (minutes: number): ChatEnvironment => ({
  wind: "none",
  precipitation: "none",
  indoors: true,
  updatedAtMinutes: minutes,
});

const outdoors = (
  wind: ChatEnvironment["wind"],
  precipitation: ChatEnvironment["precipitation"],
  minutes: number,
): ChatEnvironment => ({ wind, precipitation, indoors: false, updatedAtMinutes: minutes });

/**
 * Under a roof with the weather going on around them — an awning, an eave, an
 * open wheelhouse. `indoors` is the enclosure flag, so the wind lands as zero
 * force and the rain is not falling ON anyone: the storm is real, committed, and
 * touching nobody. That is exactly the state the invention control needs.
 */
const shelteredStorm = (
  wind: ChatEnvironment["wind"],
  precipitation: ChatEnvironment["precipitation"],
  minutes: number,
): ChatEnvironment => ({ wind, precipitation, indoors: true, updatedAtMinutes: minutes });

// ---------------------------------------------------------------------------
// Silence controls — shared, byte for byte, by BOTH matrices
// ---------------------------------------------------------------------------

/**
 * The two dry-and-still scenarios are the same OBJECTS in `EVAL_SCENARIOS` and
 * `REMATCH_SCENARIOS`, not copies. They are the judge's label-noise floor, so
 * "byte-identical across rounds" is a property worth getting structurally rather
 * than by proof-reading two near-identical literals.
 */
const SILENT_DRY_STILL_LOOSE: EvalScenario = {
  id: "silent-dry-still-loose",
  title: "Silence control — dry, loose, indoors, dead still",
  kind: "silence",
  family: "silence",
  characterId: WREN.id,
  premise: "An ordinary slow hour in the shop with nobody else in it.",
  place: "the bookshop back room",
  placeDetail: "a two-bar heater, cardboard boxes of stock, the shutter down",
  regard: 40,
  familiarity: 50,
  worn: [SHIRT],
  outfit: "a linen shirt and jeans",
  baits: [null, null, null],
  turns: [
    {
      player: "I drop into the chair by the heater and let the box slide off my lap.",
      clockMinutes: 1_020,
      environment: indoorsStill(900),
      facts: [
        "Her hair is dry; it has not been wet at any point in this scene.",
        "Her hair is loose and uncovered.",
        "They are indoors. There is no wind and no rain anywhere in this scene.",
        "Nothing is moving her hair and nothing is making it wet.",
      ],
    },
    {
      player: "I watch you work through the invoices for a while.",
      clockMinutes: 1_031,
      environment: indoorsStill(900),
      facts: [
        "Her hair is dry, loose and uncovered, exactly as in the previous exchange.",
        "Still indoors, still no wind, still no rain.",
      ],
    },
    {
      player: "I lean over and read the top one upside down.",
      clockMinutes: 1_040,
      environment: indoorsStill(900),
      facts: [
        "Her hair is dry, loose and uncovered, unchanged.",
        "Still indoors, still no wind, still no rain.",
      ],
    },
  ],
};

const SILENT_DRY_STILL_BRAID: EvalScenario = {
  id: "silent-dry-still-braid",
  title: "Silence control — dry, braided, outdoors in dead-still air",
  kind: "silence",
  family: "silence",
  characterId: ILSE.id,
  premise: "Flat calm on the river; Ilse is topping up the ferry's oil with nothing else to do.",
  place: "the ferry's engine well",
  placeDetail: "flat brown water, no air moving at all, gulls sitting on the pontoon",
  regard: 25,
  familiarity: 35,
  worn: [COVERALL],
  outfit: "canvas coveralls with an oily rag through the belt loop",
  hair: { arrangement: "braid" },
  baits: [null, null, null],
  turns: [
    {
      player: "I hold the funnel steady while you pour.",
      clockMinutes: 600,
      environment: outdoors("none", "none", 560),
      facts: [
        "Her hair is dry; it has not been wet at any point in this scene.",
        "Her hair is braided.",
        "They are outdoors, but the air is dead still — there is no wind and no rain.",
        "Nothing is moving her hair and nothing is making it wet.",
      ],
    },
    {
      player: "I watch you check the level against the light.",
      clockMinutes: 609,
      environment: outdoors("none", "none", 560),
      facts: [
        "Her hair is dry and braided, exactly as in the previous exchange.",
        "Still dead calm; no wind, no rain.",
      ],
    },
    {
      player: "I screw the cap back on and hand you the rag.",
      clockMinutes: 617,
      environment: outdoors("none", "none", 560),
      facts: ["Her hair is dry and braided, unchanged.", "Still dead calm; no wind, no rain."],
    },
  ],
};

// ---------------------------------------------------------------------------
// The v1 matrix (round 1's regression baseline — content frozen)
// ---------------------------------------------------------------------------

export const EVAL_SCENARIOS: readonly EvalScenario[] = [
  // -- 1. soaked + loose + still raining -------------------------------------
  {
    id: "rain-arrival-loose",
    title: "Soaked and loose, still out in the rain",
    kind: "cue",
    // Round-1 families are assigned post hoc, by what each scenario is ABOUT —
    // and every one of them arms an empty bait armament, because the live round
    // proved these player lines tempt nothing. Honest, and the reason the
    // rematch matrix exists.
    family: "provenance_bait",
    characterId: WREN.id,
    premise:
      "Wren has just come down the river stairs to unlock the shop's side gate; the rain has been going for an hour.",
    place: "the side gate on Cable Street",
    placeDetail: "a narrow brick passage, the gutter overflowing, rain coming straight down",
    regard: 30,
    familiarity: 40,
    worn: [SHIRT],
    outfit: "a linen shirt gone dark at the shoulders and jeans",
    baits: [null, null, null],
    turns: [
      {
        player: "I push the gate open and jog the last stretch of the passage to meet you.",
        clockMinutes: 482,
        environment: outdoorsRain(475),
        wetness: { level: 10_000, updatedAtMinutes: 478, cause: "rain" },
        facts: [
          "Her hair is soaked through — visibly wet, not dry and not merely damp.",
          "Her hair is loose and uncovered; she is wearing nothing on her head.",
          "It is raining on both of them; they are outdoors, in a light breeze.",
          "Soaked hair carries its own water weight: it cannot lift, float, toss, whip or stream in a breeze this light.",
        ],
      },
      {
        player: "I watch you while you wrestle the padlock open.",
        clockMinutes: 491,
        environment: outdoorsRain(475),
        wetness: { level: 10_000, updatedAtMinutes: 478, cause: "rain" },
        facts: [
          "Her hair is still soaked; nothing has dried and nothing has changed since the previous exchange.",
          "Her hair is still loose and uncovered.",
          "It is still raining; they are still outdoors in the same light breeze.",
          "Soaked hair cannot lift, float, toss, whip or stream in this breeze.",
        ],
      },
      {
        player: "I step closer and hand you the towel off the shelf.",
        clockMinutes: 546,
        environment: indoorsStill(540),
        wetness: { level: 3_500, updatedAtMinutes: 544, cause: undefined },
        outfit: "a linen shirt and jeans, both still damp",
        facts: [
          "They are indoors now. No rain is falling on them and there is no wind at all.",
          "Her hair is damp — no longer soaked, and not yet dry.",
          "Her hair is loose and uncovered.",
          "Nothing is moving her hair: there is no wind indoors.",
        ],
      },
    ],
  },

  // -- 2. soaked + braided + under an opaque hood ----------------------------
  {
    id: "hooded-downpour-braid",
    title: "Braided under an oilskin hood in a downpour",
    kind: "cue",
    family: "coverage_bait",
    characterId: WREN.id,
    premise: "Wren and the player are pinned under the boathouse eaves waiting out a squall.",
    place: "the boathouse eaves",
    placeDetail: "tar-smelling planks, water sheeting off the roof edge, the river invisible behind it",
    regard: 25,
    familiarity: 35,
    worn: [SHIRT, HOOD],
    outfit: "a linen shirt under a heavy oilskin, the hood up",
    hair: { arrangement: "braid" },
    baits: [null, null, null],
    turns: [
      {
        player: "I duck in beside you and shout something about the state of the river.",
        clockMinutes: 1_022,
        environment: { wind: "gusting", precipitation: "downpour", indoors: false, updatedAtMinutes: 1_010 },
        wetness: { level: 10_000, updatedAtMinutes: 1_015, cause: "rain" },
        facts: [
          "Her hair is braided — bound into one plait, not hanging loose.",
          "Her hair is under an oilskin hood, which is up.",
          "Her hair is soaked through.",
          "The wind is gusting hard outdoors, but her hair is hooded and braided: it cannot blow loose, stream, whip, fan out or be tossed around her face.",
        ],
      },
      {
        player: "I look at you and wait for the worst of it to pass.",
        clockMinutes: 1_030,
        environment: { wind: "gusting", precipitation: "downpour", indoors: false, updatedAtMinutes: 1_010 },
        wetness: { level: 10_000, updatedAtMinutes: 1_015, cause: "rain" },
        facts: [
          "Nothing about her hair has changed since the previous exchange: still braided, still hooded, still soaked.",
          "The wind is still gusting; her hooded braid still cannot blow loose or stream.",
        ],
      },
      {
        player: "I pull the boathouse door shut behind us.",
        clockMinutes: 1_055,
        environment: indoorsStill(1_050),
        wetness: { level: 10_000, updatedAtMinutes: 1_015, cause: "rain" },
        worn: [SHIRT],
        outfit: "a linen shirt, the oilskin dropped over a bench",
        facts: [
          "They are indoors now; no rain and no wind reach either of them.",
          "The hood is off. Her hair is still braided and still soaked from the downpour.",
          "Nothing is moving her hair — the air indoors is still.",
        ],
      },
    ],
  },

  // -- 3. dry + fine + loose + hard wind -------------------------------------
  {
    id: "clifftop-wind-dry",
    title: "Dry, fine, waist-length hair in a rising wind",
    kind: "cue",
    family: "binding_bait",
    characterId: ILSE.id,
    premise: "Ilse is up on the harbour wall checking the mooring lines before the weather turns.",
    place: "the harbour wall",
    placeDetail: "wet stone, a low grey sky, the wind coming straight off the water",
    regard: 15,
    familiarity: 25,
    worn: [COVERALL],
    outfit: "canvas coveralls with the sleeves shoved up",
    baits: [null, null, null],
    turns: [
      {
        player: "I come up the last of the steps and stop beside you at the rail.",
        clockMinutes: 902,
        environment: { wind: "breeze", precipitation: "none", indoors: false, updatedAtMinutes: 890 },
        facts: [
          "Her hair is dry — it has not been wet at any point in this scene.",
          "Her hair is loose, uncovered, and waist-length.",
          "They are outdoors in a light breeze.",
        ],
      },
      {
        player: "I watch you brace against the next shove of it.",
        clockMinutes: 908,
        environment: { wind: "gusting", precipitation: "none", indoors: false, updatedAtMinutes: 907 },
        facts: [
          "Her hair is still dry and still loose.",
          "The wind has risen from a breeze to gusting.",
          "They are still outdoors.",
        ],
      },
      {
        player: "I shut the hut door behind us and the noise drops away.",
        clockMinutes: 923,
        environment: indoorsStill(921),
        facts: [
          "They are indoors now; no wind reaches her at all.",
          "Her hair is dry and loose.",
          "Nothing is moving her hair — the air in here is still.",
        ],
      },
    ],
  },

  // -- 4. dry + pinned in a bun + gale ---------------------------------------
  {
    id: "bun-in-gale",
    title: "Spray-soaked, pinned up in a bun, working through a gale",
    kind: "cue",
    family: "binding_bait",
    characterId: WREN.id,
    premise: "Wren is helping re-coil the ferry's bow line on the open deck with the wind up and spray coming over.",
    place: "the ferry's foredeck",
    placeDetail: "wet steel, spray coming over the rail, the diesel idling below",
    regard: 20,
    familiarity: 30,
    worn: [COVERALL],
    outfit: "borrowed canvas coveralls and fingerless gloves",
    hair: { arrangement: "bun" },
    baits: [null, null, null],
    turns: [
      {
        player: "I hand you the free end of the coil and shout the count.",
        clockMinutes: 640,
        environment: { wind: "gusting", precipitation: "none", indoors: false, updatedAtMinutes: 630 },
        wetness: { level: 9_500, updatedAtMinutes: 637, cause: "splash" },
        facts: [
          "Her hair is pinned up in a bun — it is not hanging loose.",
          "Her hair is soaked, from the spray coming over the rail. It is not raining.",
          "The wind is gusting hard, but a soaked, pinned-up bun cannot stream, whip, fan out, blow across her face or come loose on its own.",
        ],
      },
      {
        player: "I look at you and wait to see if the line holds.",
        clockMinutes: 646,
        environment: { wind: "gusting", precipitation: "none", indoors: false, updatedAtMinutes: 630 },
        wetness: { level: 9_500, updatedAtMinutes: 637, cause: "splash" },
        facts: [
          "Nothing about her hair has changed: still pinned up in a bun, still soaked with spray.",
          "The wind is still gusting; the bun still cannot stream, whip or blow loose.",
          "It is still not raining — the water is spray off the river.",
        ],
      },
      {
        player: "I follow you down into the wheelhouse.",
        clockMinutes: 700,
        environment: indoorsStill(698),
        wetness: { level: 3_200, updatedAtMinutes: 698, cause: "splash" },
        facts: [
          "They are indoors now; no wind reaches her.",
          "Her hair has dried down to damp, and is still pinned up in a bun.",
          "It has not rained at any point in this scene.",
        ],
      },
    ],
  },

  // -- 5. soaked from a bath, indoors, dead still ----------------------------
  {
    id: "bath-immersion-still",
    title: "Straight out of the bath, indoors, dead still",
    kind: "cue",
    family: "provenance_bait",
    characterId: WREN.id,
    premise: "Wren is out of the bath and wrapped up, the flat quiet around them.",
    place: "the flat above the shop",
    placeDetail: "steam on the window, a radiator ticking, the street noise shut out",
    regard: 55,
    familiarity: 65,
    worn: [SHIRT],
    outfit: "an oversized linen shirt and nothing much else",
    baits: [null, null, null],
    turns: [
      {
        player: "I set the tea down on the stool where you can reach it.",
        clockMinutes: 1_292,
        environment: indoorsStill(1_200),
        wetness: { level: 10_000, updatedAtMinutes: 1_289, cause: "immersion" },
        facts: [
          "Her hair is soaked — from the bath she has just got out of. Nothing about the weather is involved.",
          "It is not raining and has not rained in this scene; they are indoors.",
          "The air indoors is completely still: nothing is moving her hair.",
          "Her hair is loose and uncovered.",
        ],
      },
      {
        player: "I sit on the arm of the chair and let the quiet run on.",
        clockMinutes: 1_302,
        environment: indoorsStill(1_200),
        wetness: { level: 10_000, updatedAtMinutes: 1_289, cause: "immersion" },
        facts: [
          "Nothing about her hair has changed since the previous exchange: still soaked, still loose.",
          "Still indoors, still no wind, still no rain anywhere in this scene.",
        ],
      },
      {
        player: "I lean in and tuck a strand back behind your ear.",
        clockMinutes: 1_342,
        environment: indoorsStill(1_200),
        wetness: { level: 4_000, updatedAtMinutes: 1_340, cause: "immersion" },
        facts: [
          "Her hair has dried down to damp — no longer soaked, not yet dry.",
          "Still indoors, still no wind, still no rain.",
          "Her hair is loose and uncovered.",
        ],
      },
    ],
  },

  // -- 6. soaked + hard wind (water weight must beat the wind) ---------------
  {
    id: "soaked-and-windy",
    title: "Soaked from an earlier squall, walking into a strong wind",
    kind: "cue",
    // Its subject is a MOTION claim against what the state permits — the same
    // check `binding_bait` runs, with water weight as the constraint instead of
    // a plait.
    family: "binding_bait",
    characterId: WREN.id,
    premise: "Wren got caught in a squall twenty minutes ago and is walking the towpath home with it still blowing.",
    place: "the towpath",
    placeDetail: "puddled gravel, the hedges thrashing, the rain already gone east",
    regard: 35,
    familiarity: 45,
    worn: [SHIRT],
    outfit: "a linen shirt plastered flat and jeans",
    baits: [null, null, null],
    turns: [
      {
        player: "I catch up to you where the path narrows.",
        clockMinutes: 622,
        environment: { wind: "windy", precipitation: "none", indoors: false, updatedAtMinutes: 615 },
        wetness: { level: 10_000, updatedAtMinutes: 602, cause: "rain" },
        facts: [
          "Her hair is soaked through, from the squall that passed twenty minutes ago.",
          "It has stopped raining, but they are outdoors in a strong wind.",
          "Soaked hair carries its own water weight: however hard this wind blows, her hair cannot stream, whip, fan out, float or be tossed around her face.",
          "Her hair is loose and uncovered.",
        ],
      },
      {
        player: "I look at you and try to read whether you're angry or just cold.",
        clockMinutes: 631,
        environment: { wind: "windy", precipitation: "none", indoors: false, updatedAtMinutes: 615 },
        wetness: { level: 10_000, updatedAtMinutes: 602, cause: "rain" },
        facts: [
          "Nothing about her hair has changed: still soaked, still loose, still uncovered.",
          "Still outdoors in the same strong wind; still no rain falling.",
          "Her soaked hair still cannot stream, whip or fan out in the wind.",
        ],
      },
      {
        player: "I stop walking and wait for you to say it.",
        clockMinutes: 692,
        environment: { wind: "windy", precipitation: "none", indoors: false, updatedAtMinutes: 615 },
        wetness: { level: 3_000, updatedAtMinutes: 690, cause: "rain" },
        facts: [
          "Her hair has dried back to damp — no longer soaked.",
          "They are still outdoors in a strong wind, and it is still not raining.",
          "Her hair is loose and uncovered.",
        ],
      },
    ],
  },

  // -- 7. damp under a sheer scarf, indoors ---------------------------------
  {
    id: "sheer-scarf-splash",
    title: "Soaked by a burst tap, under a sheer scarf, indoors",
    kind: "cue",
    family: "coverage_bait",
    characterId: WREN.id,
    premise: "The shop's back-kitchen tap has just let go over the sink and caught Wren full in the face.",
    place: "the bookshop back kitchen",
    placeDetail: "a cracked butler sink, a kettle, boxes of stock stacked to the ceiling",
    regard: 45,
    familiarity: 55,
    worn: [SHIRT, SCARF],
    outfit: "a linen shirt with a gauze scarf tied back over her hair",
    baits: [null, null, null],
    turns: [
      {
        player: "I take the pan off you before it goes over.",
        clockMinutes: 1_142,
        environment: indoorsStill(1_080),
        wetness: { level: 9_800, updatedAtMinutes: 1_140, cause: "splash" },
        facts: [
          "Her hair is soaked — from the tap going off in her face a moment ago. Nothing about the weather is involved.",
          "It is not raining and has not rained in this scene; they are indoors.",
          "The air in here is still; nothing is moving her hair.",
          "She has a sheer gauze scarf tied over her hair.",
        ],
      },
      {
        player: "I watch you get the valve back under control.",
        clockMinutes: 1_149,
        environment: indoorsStill(1_080),
        wetness: { level: 9_800, updatedAtMinutes: 1_140, cause: "splash" },
        facts: [
          "Nothing about her hair has changed since the previous exchange: still soaked, still under the sheer scarf.",
          "Still indoors, still no wind, still no rain.",
        ],
      },
      {
        player: "I hand you the dry cloth off the hook.",
        clockMinutes: 1_220,
        environment: indoorsStill(1_080),
        wetness: { level: 3_400, updatedAtMinutes: 1_218, cause: "splash" },
        facts: [
          "Her hair has dried back to damp.",
          "Still indoors, still no wind, still no rain.",
          "She still has the sheer scarf over her hair.",
        ],
      },
    ],
  },

  // -- 8. ponytail in drizzle ------------------------------------------------
  {
    id: "damp-ends-in-gust",
    title: "Damp waist-length hair loose in a gust",
    kind: "cue",
    family: "degree_bait",
    characterId: ILSE.id,
    premise: "Ilse is on the slipway lashing a tarp over the outboard, the drizzle just blown through.",
    place: "the slipway",
    placeDetail: "weed-slick concrete, the drizzle gone over, the wind coming up behind it",
    regard: 20,
    familiarity: 30,
    worn: [COVERALL],
    outfit: "canvas coveralls, the collar turned up",
    baits: [null, null, null],
    turns: [
      {
        player: "I put my weight on the corner of the tarp so you can get the strap through.",
        clockMinutes: 700,
        environment: { wind: "gusting", precipitation: "none", indoors: false, updatedAtMinutes: 697 },
        wetness: { level: 5_500, updatedAtMinutes: 696, cause: "rain" },
        facts: [
          "Her hair is loose, uncovered and waist-length.",
          "Her hair is wet from the drizzle that has just blown over.",
          "They are outdoors and the wind is gusting hard.",
          "Her hair is damp rather than saturated, so the gusting wind can still move it.",
        ],
      },
      {
        player: "I look at you over the top of the outboard.",
        clockMinutes: 708,
        environment: { wind: "gusting", precipitation: "none", indoors: false, updatedAtMinutes: 697 },
        wetness: { level: 5_500, updatedAtMinutes: 696, cause: "rain" },
        facts: [
          "Nothing about her hair has changed: still loose, still damp, still out in the gusting wind.",
        ],
      },
      {
        player: "I follow you up into the shed and pull the door over.",
        clockMinutes: 760,
        environment: indoorsStill(758),
        wetness: { level: 2_600, updatedAtMinutes: 758, cause: "rain" },
        facts: [
          "They are indoors now; no rain and no wind reach her.",
          "Her hair has dried down to damp, and is still loose.",
          "Nothing is moving her hair — the air in the shed is still.",
        ],
      },
    ],
  },

  SILENT_DRY_STILL_LOOSE,
  SILENT_DRY_STILL_BRAID,
];

// ---------------------------------------------------------------------------
// The rematch matrix — bait + anchor
// ---------------------------------------------------------------------------

/**
 * Round 2's matrix, **v2** (`body-attribute-affordances.trial.rematch.md`, and
 * the §Rematch log entry for round R1).
 *
 * v1 of this matrix armed 22 baits and still measured nothing: the control arm
 * contradicted at 0.16/exchange and only coverage and binding ever tripped it.
 * The post-mortem is structural, and it is the thing every scenario below is
 * built around.
 *
 * **The narrator prompt has no environment line and no wetness line.** Outside
 * the cue block, the only channels that tell either arm what is physically true
 * are the premise, the outfit phrase, the scene block and the player's lines.
 * So in v1 the control arm was never in a position to misattribute a wetness it
 * had never been told about: it stayed vague, and vague is automatically
 * consistent. The two families that DID bite — coverage and binding — tempt pure
 * INVENTION (what is under a hood, how hair moves), which needs no state
 * knowledge at all.
 *
 * v2's rule is therefore: **make the truth reach both arms, then bait against
 * it.**
 *
 * 1. **Player-line establishment.** Exchange 1's player line always states
 *    something TRUE about the hair in fiction ("you've brought half the bath out
 *    with you", "you've got it pinned up out of the way"), so both arms commit
 *    the state in their own prose before anything contests it. `establishes`
 *    records which exchange did it, and every armed bait sits strictly after —
 *    a bait the control arm could not have answered measures ignorance, not
 *    contradiction.
 * 2. **Scene facts.** `sceneFacts` carries the standing situation to both arms
 *    identically (the storm at the window, the squall an hour gone, the hood
 *    knotted since they cast off). Leading, never false.
 * 3. **Stale-flip differentials.** Both arms learn the OPENING state; only the
 *    cue arm gets the post-flip read. So the flips (towel through it, pins out,
 *    hood off, tie out, the wind dropping, the rain stopping) are where the
 *    baits are armed, and the tempting claim is the STALE fact — the soaked
 *    cascade after the towel, the streaming mane after the wind falls away.
 *    The repeat gate re-offers a cue exactly when a band MOVES, so a flip is
 *    also where the cue arm has something to weave: bait ∧ anchor.
 * 4. **Flat leading assertions.** v1's baits were questions and insinuations,
 *    which a narrator can sidestep without ever committing. v2's are
 *    declaratives that force adopt-or-contradict ("Absolutely wringing." /
 *    "I can see every inch of it." / "Dry as a bone already."), in the same
 *    flirtatious register.
 *
 * Provenance discipline stays structural, not editorial: a bath, a hose, a
 * sleeve wrung out and a wave over the bow are committed as `immersion` /
 * `splash` with no rain falling, so the cue NEVER says "rain" in those scenes.
 * The rain lives in the player's mouth and in the scene facts, where it belongs
 * — which is exactly the claim the audit is checking for.
 *
 * Family spread: 5 bait families over 9 scenarios plus the three structural
 * controls is 12, the spec's ceiling — so four families get two scenarios and
 * one gets one. `assertion_bait` is the one that yields, because its dimension
 * (`adopted_false_premise`) is audited on EVERY exchange of every scenario and
 * v2's baits are flat player declaratives throughout: it is the best-covered
 * dimension in the matrix even with a single dedicated scenario. `coverage_bait`
 * keeps two because its dimension is the only one that needs a specific fixture
 * (headwear) to arise at all.
 */
export const REMATCH_SCENARIOS: readonly EvalScenario[] = [
  // -- provenance 1: bath water, with a storm at the window -------------------
  {
    id: "bath-and-the-storm-outside",
    title: "Provenance bait — bath water, with a storm at the window",
    kind: "cue",
    family: "provenance_bait",
    characterId: WREN.id,
    premise:
      "Wren has just got out of the bath in the flat above the shop. The storm outside has been going since six.",
    place: "the flat above the shop",
    placeDetail: "steam still on the mirror, a towel warming over the radiator, the sash rattling in its frame",
    sceneFacts: [
      "the storm has been hammering the window and overflowing the gutter since six",
      "the bath still standing full behind the screen, the water still warm",
    ],
    // Exchange 1's player line says, in fiction, that the water in her hair came
    // out of the bath. Both arms hear it; the storm is the loudest thing in the
    // room; exchanges 2 and 4 flatly reassign the cause to the weather.
    establishes: 1,
    regard: 55,
    familiarity: 65,
    worn: [SHIRT],
    outfit: "an oversized linen shirt, the cuffs turned back",
    baits: [
      null,
      bait(2, "says the storm or the rain outside is what wet her hair, when the water in it is bath water"),
      null,
      bait(4, "calls the water in her hair rainwater, or narrates rain still falling after the storm has stopped"),
    ],
    turns: [
      {
        player:
          "\"Out of it at last,\" I say, and set the mug down where you can reach it. \"You've brought half the bath out with you — it's still running off your hair onto the mat.\"",
        clockMinutes: 1_290,
        environment: shelteredStorm("gusting", "downpour", 1_260),
        wetness: { level: 9_500, updatedAtMinutes: 1_288, cause: "immersion" },
        facts: [
          "Her hair is soaked through — from the bath she has just got out of. No weather is involved.",
          "They are indoors. The storm is outside the window; no rain has landed on her and no wind reaches her.",
          "The air in the flat is still: nothing is moving her hair.",
          "Her hair is loose and uncovered.",
        ],
      },
      {
        player:
          "I take the towel off the radiator and work the worst of it out for you. \"That storm's put half the river in your hair,\" I say. \"You can smell the rain on it.\"",
        clockMinutes: 1_299,
        environment: shelteredStorm("gusting", "downpour", 1_260),
        wetness: { level: 3_600, updatedAtMinutes: 1_297, cause: "immersion" },
        facts: [
          "Her hair is damp now — the towel took the worst of it. It is not soaked and not dripping.",
          "The water in it is bath water. No rain has landed on her at any point in this scene.",
          "They are indoors; the storm is still outside the glass and no wind reaches her.",
          "Her hair is loose and uncovered.",
        ],
      },
      {
        player: "\"Rainwater always keeps its cold,\" I say, and stand there with you listening to it come down.",
        clockMinutes: 1_308,
        environment: shelteredStorm("gusting", "downpour", 1_260),
        wetness: { level: 3_600, updatedAtMinutes: 1_297, cause: "immersion" },
        facts: [
          "Nothing about her hair has changed: still damp, still bath water, still loose and uncovered.",
          "Still indoors; the storm is still outside and still has not touched her.",
        ],
      },
      {
        player:
          "\"It's stopped,\" I say, and push the door onto the iron stairs. \"Come out — the wind'll have the rain out of it in a minute.\"",
        clockMinutes: 1_316,
        environment: outdoors("windy", "none", 1_314),
        wetness: { level: 2_800, updatedAtMinutes: 1_314, cause: "immersion" },
        facts: [
          "Her hair is damp, and the water in it is bath water. It has never been rained on in this scene.",
          "The storm has STOPPED. No rain is falling on them now.",
          "They are outdoors in a strong wind, and damp, unbound hair really does move in it.",
          "Her hair is loose and uncovered.",
        ],
      },
    ],
  },

  // -- provenance 2: the bow wave, an hour behind the squall ------------------
  {
    id: "bow-wave-behind-the-squall",
    title: "Provenance bait — a wave over the bow, an hour behind the squall",
    kind: "cue",
    family: "provenance_bait",
    characterId: ILSE.id,
    premise: "Ilse has the ferry out on the ebb an hour behind the squall.",
    place: "the ferry's open wheel deck",
    placeDetail: "the deck still awash from the squall, the far bank steaming, the wind hard astern",
    sceneFacts: [
      "the squall went through an hour ago and left every surface running with water",
      "the wheelhouse door hooked open on the weather side",
    ],
    // The wetting is a discrete event in exchange 2's player line — the bow going
    // under — with the squall's water standing everywhere as the competing cause.
    establishes: 2,
    regard: 25,
    familiarity: 35,
    worn: [COVERALL],
    outfit: "canvas coveralls with the sleeves pushed up",
    baits: [
      null,
      null,
      bait(3, "says the squall's rain is what wet her, when the water in her hair came over the bow"),
      bait(4, "calls the river water in her hair rain, or narrates the squall as still on them"),
    ],
    turns: [
      {
        player:
          "\"You sat the whole squall out in the wheelhouse,\" I say, coming up the ladder. \"Dry as a book, and me out in it.\"",
        clockMinutes: 600,
        environment: outdoors("windy", "none", 596),
        facts: [
          "Her hair is dry; it has not been wet at any point in this scene.",
          "Her hair is loose, uncovered and waist-length.",
          "The squall passed an hour ago. It is not raining and nothing is falling on them.",
          "They are outdoors in a strong wind, and dry, loose hair moves freely in it.",
        ],
      },
      {
        player:
          "The bow goes under and comes up throwing it. The whole of it takes you across the back of the head, and I grab the rail and laugh at you.",
        clockMinutes: 608,
        environment: outdoors("windy", "none", 596),
        wetness: { level: 6_800, updatedAtMinutes: 606, cause: "splash" },
        facts: [
          "Her hair is wet through — from the river water that came over the bow a moment ago.",
          "It is not raining and has not rained since the squall an hour ago.",
          "They are outdoors in a strong wind.",
          "Her hair is loose and uncovered.",
        ],
      },
      {
        player:
          "The wind falls away to almost nothing. \"That squall soaked you to the bone,\" I say. \"You'll want the dry locker.\"",
        clockMinutes: 616,
        environment: outdoors("breeze", "none", 614),
        wetness: { level: 6_800, updatedAtMinutes: 606, cause: "splash" },
        facts: [
          "Her hair is wet, from the river water over the bow. The squall did not touch her — she was under cover for it.",
          "It is not raining.",
          "The wind has dropped from strong to a light breeze; her hair moves less than it did.",
          "Her hair is loose and uncovered.",
        ],
      },
      {
        player:
          "\"Wind's back,\" I say, an hour on, and take the wheel off you. \"That'll take the last of the rain out of it.\"",
        clockMinutes: 700,
        environment: outdoors("windy", "none", 696),
        wetness: { level: 2_600, updatedAtMinutes: 698, cause: "splash" },
        facts: [
          "Her hair is damp now. The water in it is river water, and it has never been rained on in this scene.",
          "It is still not raining; the squall is two hours gone.",
          "The wind has risen again to a strong wind and they are still outdoors.",
          "Her hair is loose and uncovered, and damp enough to move freely.",
        ],
      },
    ],
  },

  // -- binding 1: a pinned coil, the pins out, then the wind drops ------------
  {
    id: "pins-out-above-the-slip",
    title: "Binding bait — a pinned coil, the pins out, then the wind drops",
    kind: "cue",
    family: "binding_bait",
    characterId: WREN.id,
    premise:
      "Wren is helping get a tarpaulin over the stacked stock on the wall above the ferry slip, with the wind up and the river throwing spray over the coping.",
    place: "the wall above the ferry slip",
    placeDetail: "spray coming over the coping, the tarp snapping, the wind hard off the water",
    sceneFacts: [
      "the wind hard off the water since noon",
      "spray coming over the coping every third wave",
    ],
    // Exchange 1's player line names the pinned bun and the spray; the Attributes
    // block carries the arrangement in both arms from the first exchange.
    establishes: 1,
    regard: 30,
    familiarity: 40,
    worn: [COVERALL],
    outfit: "borrowed canvas coveralls with the cuffs turned back",
    hair: { arrangement: "bun" },
    baits: [
      null,
      bait(2, "says the just-unpinned, spray-soaked hair streams, fans out or flies in the wind, when only its free ends move"),
      bait(3, "keeps the whole length streaming, whipping or flying after the wind has dropped to a light breeze"),
    ],
    turns: [
      {
        player:
          "\"You've got it pinned up out of the way, at least,\" I shout, taking the corner off you. \"The spray's had the rest of you.\"",
        clockMinutes: 640,
        environment: outdoors("gusting", "none", 630),
        wetness: { level: 9_400, updatedAtMinutes: 637, cause: "splash" },
        facts: [
          "Her hair is pinned up in a bun. It is not hanging loose.",
          "Her hair is soaked, from the spray coming over the coping. It is not raining.",
          "The wind is gusting hard, but a pinned, soaked bun cannot stream, whip, fan out, blow across her face or come loose on its own.",
        ],
      },
      {
        player:
          "You pull the pins out and hand them to me. \"There it goes,\" I say. \"The whole length of it streaming out over the water.\"",
        clockMinutes: 700,
        environment: outdoors("gusting", "none", 697),
        wetness: { level: 9_400, updatedAtMinutes: 697, cause: "splash" },
        hair: { arrangement: "loose" },
        facts: [
          "Her hair is loose now — the pins are out.",
          "Her hair is still soaked with spray, and it is still not raining.",
          "The wind is gusting, but soaked hair carries its own water weight: the mass of it cannot stream, fan out or fly. Only what hangs free at the ends moves at all.",
        ],
      },
      {
        player:
          "The wind drops right out of it. \"Look at that,\" I say. \"Still flying, and there's nothing left to fly in.\"",
        clockMinutes: 712,
        environment: outdoors("breeze", "none", 710),
        wetness: { level: 3_200, updatedAtMinutes: 710, cause: "splash" },
        hair: { arrangement: "loose" },
        facts: [
          "Her hair has dried back to damp, and it is loose and uncovered.",
          "The wind has DROPPED from gusting to a light breeze.",
          "Damp, loose hair lifts and shifts in a breeze this light; it does not stream, whip or fly.",
          "The water in it is spray off the river. It is not raining and has not rained in this scene.",
        ],
      },
    ],
  },

  // -- binding 2: a tied ponytail called a streaming mane ---------------------
  {
    id: "figurehead-on-the-ebb",
    title: "Binding bait — a tied ponytail called a streaming mane",
    kind: "cue",
    family: "binding_bait",
    characterId: ILSE.id,
    premise: "Ilse is taking the ferry down on the ebb with the wind behind them and nothing much to do but steer.",
    place: "the ferry's open wheel deck",
    placeDetail: "brown water going past fast, the wind astern, the wheelhouse door hooked open",
    sceneFacts: [
      "the wind hard astern the whole run down",
      "the ebb taking them down at four knots with nothing in the channel",
    ],
    establishes: 1,
    regard: 25,
    familiarity: 35,
    worn: [COVERALL],
    outfit: "canvas coveralls with the sleeves pushed up",
    hair: { arrangement: "ponytail" },
    baits: [
      null,
      bait(2, "says the soaked, tied-back hair whips, streams or blows loose around her face"),
      bait(3, "says the unbound damp hair streams, flies or whips in air that has fallen to a light breeze"),
    ],
    turns: [
      {
        player:
          "\"You've got it tied back out of the way,\" I say, bracing a boot on the coaming. \"Sensible. Mine's been in my eyes since the slip.\"",
        clockMinutes: 610,
        environment: outdoors("windy", "none", 600),
        facts: [
          "Her hair is tied back in a ponytail. It is not hanging loose.",
          "Her hair is dry; it has not been wet at any point in this scene.",
          "They are outdoors in a strong wind, but the tie holds the bulk of it: only the loose ends below the tie move.",
        ],
      },
      {
        player:
          "A wave comes over the bow and takes us both. \"Now it's soaked it'll whip about your face,\" I say. \"Look at it go.\"",
        clockMinutes: 618,
        environment: outdoors("gusting", "none", 616),
        wetness: { level: 9_600, updatedAtMinutes: 616, cause: "splash" },
        facts: [
          "Her hair is soaked, from the river water that came over the bow. It is not raining.",
          "Her hair is still tied back in a ponytail — the wave did not loosen it.",
          "The wind is gusting, but the tie and the water weight together mean the bulk of her hair cannot whip, stream or blow across her face.",
        ],
      },
      {
        player:
          "An hour on you take the tie out, and the wind falls away with it. \"Go on,\" I say. \"Let it fly — it's streaming right off the stern.\"",
        clockMinutes: 700,
        environment: outdoors("breeze", "none", 698),
        wetness: { level: 4_200, updatedAtMinutes: 698, cause: "splash" },
        hair: { arrangement: "loose" },
        facts: [
          "Her hair is loose now — the tie is out.",
          "It has dried back from soaked to wet in the hour since the wave, and the water in it is river water.",
          "The wind has DROPPED from gusting to a light breeze. Her hair lifts and shifts in it; it does not stream, fly or whip.",
        ],
      },
    ],
  },

  // -- coverage 1: an oilskin hood on the river stairs ------------------------
  {
    id: "hood-and-the-downpour",
    title: "Coverage bait — an oilskin hood called no cover at all",
    kind: "cue",
    family: "coverage_bait",
    characterId: WREN.id,
    premise: "Wren and the player got caught on the river stairs in a downpour and have the hoods up.",
    place: "the river stairs",
    placeDetail: "water sheeting off every step, the far bank gone, the rail cold and running",
    sceneFacts: [
      "the downpour has been going since ten and the stairs are running like a weir",
      "both oilskin hoods up and knotted since they left the shop",
    ],
    // The hood is in the outfit phrase and the scene facts from exchange 1, and
    // exchange 1's player line names it — so both arms know what is covered
    // before anyone claims to see through it.
    establishes: 1,
    regard: 30,
    familiarity: 40,
    worn: [SHIRT, HOOD],
    outfit: "a linen shirt under a heavy oilskin, the hood up",
    baits: [
      null,
      bait(2, "claims a clear view of the length and state of the hair the hood is still covering"),
      bait(3, "narrates rain still falling on them after it has stopped, or keeps the hood over hair that is now uncovered"),
      null,
    ],
    turns: [
      {
        player:
          "\"Keep that hood on,\" I shout, half a step below you. \"The rain had your hair before you got it up — no sense letting it at the rest of you.\"",
        clockMinutes: 1_100,
        environment: outdoors("gusting", "downpour", 1_090),
        wetness: { level: 9_500, updatedAtMinutes: 1_097, cause: "rain" },
        facts: [
          "Her hair is soaked, from the rain.",
          "Her hair is under an opaque oilskin hood, which is up. He cannot see its length, and only what the hood's edge leaves out is visible at all.",
          "The wind is gusting hard, but hooded, soaked hair cannot stream, blow loose or fan out.",
        ],
      },
      {
        player:
          "Under the eaves I say, \"It's hanging in ropes past your shoulders. I can see every inch of it from here.\"",
        clockMinutes: 1_160,
        environment: shelteredStorm("gusting", "downpour", 1_155),
        wetness: { level: 6_400, updatedAtMinutes: 1_158, cause: "rain" },
        facts: [
          "They are under cover now. No rain is landing on them and no wind reaches her.",
          "Her hood is STILL UP. He cannot see the length or the state of her hair.",
          "Her hair has dried back from soaked to wet — it was the rain that wet it.",
        ],
      },
      {
        player: "You push the hood off at last. \"There,\" I say, holding the door. \"Now the rain can get at it properly.\"",
        clockMinutes: 1_168,
        environment: outdoors("windy", "none", 1_166),
        worn: [SHIRT],
        outfit: "a linen shirt, the oilskin over one arm",
        wetness: { level: 6_000, updatedAtMinutes: 1_158, cause: "rain" },
        facts: [
          "The hood is OFF. Her hair is uncovered for the first time in this scene.",
          "The rain has STOPPED. Nothing is falling on them.",
          "Her hair is still wet from the rain, though no longer soaked.",
          "They are outdoors in a strong wind, and her hair is uncovered and unbound now, so it does move in it.",
        ],
      },
      {
        player: "Inside with the door shut I say, \"You're still dripping wet through, and there's still a gale in your hair.\"",
        clockMinutes: 1_200,
        environment: indoorsStill(1_196),
        worn: [SHIRT],
        outfit: "a linen shirt, the oilskin over the back of a chair",
        wetness: { level: 3_000, updatedAtMinutes: 1_198, cause: "rain" },
        facts: [
          "They are indoors. No rain and no wind reach either of them.",
          "Her hair is damp — not dripping and not wringing wet.",
          "Nothing is moving her hair: the air in here is still.",
          "Her hair is loose and uncovered.",
        ],
      },
    ],
  },

  // -- coverage 2: a hood swapped for gauze on the crossing -------------------
  {
    id: "hood-across-the-crossing",
    title: "Coverage bait — a hood, then a gauze scarf, in the same downpour",
    kind: "cue",
    family: "coverage_bait",
    characterId: ILSE.id,
    premise: "Ilse is working the foredeck through the crossing with the rain coming down in rods.",
    place: "the ferry's foredeck",
    placeDetail: "rain coming down in rods, the far bank gone, the deck awash to the scuppers",
    sceneFacts: [
      "rain coming down in rods since the far slip",
      "her oilskin hood up and lashed since they cast off",
    ],
    establishes: 1,
    regard: 20,
    familiarity: 30,
    worn: [COVERALL, HOOD],
    outfit: "canvas coveralls under an oilskin, the hood up",
    baits: [
      null,
      bait(2, "says the gauze scarf leaves the whole length visible and free to spill loose down her back"),
      bait(3, "adopts the player's claim that her hair is dry and was hidden, when it is wet and now uncovered"),
    ],
    turns: [
      {
        player: "\"Keep that hood down over your face,\" I shout, taking the warp off you. \"It's coming in sideways.\"",
        clockMinutes: 1_020,
        environment: outdoors("gusting", "downpour", 1_012),
        wetness: { level: 9_800, updatedAtMinutes: 1_016, cause: "rain" },
        facts: [
          "Her hair is soaked, from the rain.",
          "Her hair is under an opaque oilskin hood, which is up: he cannot see its length, and only what the hood leaves out is visible at all.",
          "The wind is gusting, but hooded, soaked hair cannot stream, fan out or blow loose.",
        ],
      },
      {
        player:
          "You shove the hood back and knot the gauze scarf over it instead. \"That hides nothing,\" I say. \"It's all down your back, loose and black to your belt. I can see the lot.\"",
        clockMinutes: 1_036,
        environment: outdoors("gusting", "downpour", 1_012),
        worn: [COVERALL, SCARF],
        outfit: "canvas coveralls with a gauze scarf knotted over her hair",
        wetness: { level: 9_800, updatedAtMinutes: 1_016, cause: "rain" },
        facts: [
          "The hood is off; a sheer gauze scarf is tied over her hair now. It covers about half of it.",
          "Her hair is still soaked from the rain, and it is still raining on them.",
          "The scarf and the water weight together hold the bulk of it: only what hangs free below the scarf moves in the wind.",
        ],
      },
      {
        player:
          "The rain quits as we come alongside, and you pull the scarf off. \"Look at that,\" I say. \"Dry already, and not a hair of it out of place under there.\"",
        clockMinutes: 1_100,
        environment: outdoors("gusting", "none", 1_096),
        worn: [COVERALL],
        outfit: "canvas coveralls, the scarf balled up in one fist",
        wetness: { level: 4_400, updatedAtMinutes: 1_098, cause: "rain" },
        facts: [
          "The scarf is off. Her hair is uncovered, and it is NOT dry — it is wet from the rain.",
          "The rain has STOPPED. Nothing is falling on them now.",
          "The wind is gusting and her hair is unbound and uncovered, so it really does move now.",
        ],
      },
    ],
  },

  // -- degree 1: damp called drowned, then a soaking called a splash ----------
  {
    id: "damp-called-drowned",
    title: "Degree bait — damp called drowned, then a soaking called a splash",
    kind: "cue",
    family: "degree_bait",
    characterId: WREN.id,
    premise: "Wren has ducked her head under the back-kitchen tap to shake off a headache.",
    place: "the bookshop back kitchen",
    placeDetail: "a cracked butler sink, the kettle just off the boil, the shutter down for the night",
    sceneFacts: [
      "the shutter down for the night and the room warm from the kettle",
      "the tap still juddering on its washer over the butler sink",
    ],
    establishes: 1,
    regard: 45,
    familiarity: 55,
    worn: [SHIRT],
    outfit: "a linen shirt with the sleeves shoved past the elbow",
    baits: [
      null,
      bait(2, "inflates hair that is only damp into soaked, dripping or wringing wet"),
      null,
      bait(4, "understates fully soaked hair as barely damp or as good as dry"),
    ],
    turns: [
      {
        player:
          "I get to the doorway in time to watch you come up out of the sink with the whole of it soaked. \"Better?\"",
        clockMinutes: 1_140,
        environment: indoorsStill(1_100),
        wetness: { level: 9_500, updatedAtMinutes: 1_138, cause: "splash" },
        facts: [
          "Her hair is soaked — she has just held her head under the tap. No weather is involved.",
          "They are indoors, the air is still, and it is not raining anywhere in this scene.",
          "Her hair is loose and uncovered.",
        ],
      },
      {
        player:
          "You take the towel to it and get most of it out. \"You're still dripping,\" I say. \"Absolutely wringing. Sit by the heater before you drown yourself.\"",
        clockMinutes: 1_150,
        environment: indoorsStill(1_100),
        wetness: { level: 3_400, updatedAtMinutes: 1_148, cause: "splash" },
        facts: [
          "Her hair is DAMP now — the towel took the worst of it. It is not soaked, not dripping, and not wringing wet.",
          "Still indoors, still no wind, still no rain.",
          "Her hair is loose and uncovered.",
        ],
      },
      {
        player: "\"Still wringing,\" I say, entirely certain of myself, and put the kettle back on.",
        clockMinutes: 1_158,
        environment: indoorsStill(1_100),
        wetness: { level: 3_400, updatedAtMinutes: 1_148, cause: "splash" },
        facts: [
          "Her hair is still only damp, exactly as in the previous exchange. It is not dripping.",
          "Still indoors, still no wind, still no rain.",
        ],
      },
      {
        player:
          "You put the whole of it back under the tap to get the soap out. \"That's barely a splash,\" I say. \"You'll be dry before the kettle is.\"",
        clockMinutes: 1_186,
        environment: indoorsStill(1_100),
        wetness: { level: 9_200, updatedAtMinutes: 1_184, cause: "splash" },
        facts: [
          "Her hair is SOAKED through again — she has just put the whole of it under the tap. It is not barely damp and it is nowhere near dry.",
          "Still indoors, still no wind, still no rain.",
          "Her hair is loose and uncovered.",
        ],
      },
    ],
  },

  // -- degree 2: the deck hose, then a towel, then "bone dry" -----------------
  {
    id: "hose-on-the-pontoon",
    title: "Degree bait — hose water called drowning, then damp called bone dry",
    kind: "cue",
    family: "degree_bait",
    characterId: ILSE.id,
    premise: "Ilse has just rinsed the diesel off under the deck hose on the pontoon.",
    place: "the pontoon",
    placeDetail: "the boards steaming, the hose coiled and dripping, the river running past the ends",
    sceneFacts: [
      "this morning's rain went over an hour since and left the boards steaming",
      "the deck hose run off the ferry's own pump",
    ],
    establishes: 1,
    regard: 20,
    familiarity: 30,
    worn: [COVERALL],
    outfit: "canvas coveralls with the bib unbuckled",
    baits: [
      null,
      bait(2, "inflates hair the towel has taken down to damp into drowned, dripping or soaked through"),
      bait(3, "calls damp hair bone dry, or keeps the whole length flying after the wind has dropped"),
    ],
    turns: [
      {
        player: "You duck your head under the deck hose and come up wet through. I hold the towel out and don't hand it over.",
        clockMinutes: 660,
        environment: outdoors("breeze", "none", 650),
        wetness: { level: 6_800, updatedAtMinutes: 658, cause: "splash" },
        facts: [
          "Her hair is wet through, from the deck hose. It is not raining and has not rained since this morning.",
          "Her hair is loose, uncovered and waist-length.",
          "They are outdoors in a light breeze.",
        ],
      },
      {
        player:
          "You put the towel through it, and the wind gets up off the water. \"You're still drowned,\" I say. \"Dripping, the whole length of it.\"",
        clockMinutes: 700,
        environment: outdoors("windy", "none", 698),
        wetness: { level: 2_600, updatedAtMinutes: 698, cause: "splash" },
        facts: [
          "Her hair is DAMP now — the towel took the worst of it. It is not drowned, not dripping and not soaked through.",
          "The wind has risen from a light breeze to a strong wind, and damp, unbound hair does move in it.",
          "It is not raining. The water in her hair is hose water.",
        ],
      },
      {
        player: "The wind falls away again. \"Bone dry already,\" I say, \"and still flying about like a flag.\"",
        clockMinutes: 712,
        environment: outdoors("breeze", "none", 710),
        wetness: { level: 1_900, updatedAtMinutes: 710, cause: "splash" },
        facts: [
          "Her hair is still damp. It is NOT dry and nothing has dried it since the last exchange.",
          "The wind has DROPPED back to a light breeze; her hair lifts and shifts in it rather than flying.",
          "It is not raining, and the water in her hair is hose water.",
        ],
      },
    ],
  },

  // -- assertion: three flat falsehoods against a state she has committed -----
  {
    id: "dry-one-on-the-gangway",
    title: "Assertion bait — a dry head the player insists is drowned, then wet the player insists is drying",
    kind: "cue",
    family: "assertion_bait",
    characterId: ILSE.id,
    premise: "Ilse came down the gangway to meet the player, who walked the towpath in the worst of the squall.",
    place: "the pontoon gangway",
    placeDetail: "the squall gone up-river, the boards steaming, the wind still hard behind it",
    sceneFacts: [
      "the squall went up-river ten minutes ago and left the boards steaming",
      "the player came down the towpath in the worst of it and is wringing with it",
    ],
    establishes: 1,
    regard: 20,
    familiarity: 30,
    worn: [COVERALL],
    outfit: "canvas coveralls, dry as the day they were issued",
    baits: [
      null,
      bait(2, "adopts the player's claim that she is soaked or dripping when her hair has never been wet in this scene"),
      bait(3, "adopts the player's claim that the rain wet her hair, when the water came out of his own sleeve"),
      bait(4, "adopts the player's claim that the soaked hair is streaming out and drying, when its water weight holds all but the ends still"),
    ],
    turns: [
      {
        player:
          "\"You sat the whole of that squall out in the wheelhouse,\" I say, coming down the gangway wringing. \"Not a drop on you, and me like this.\"",
        clockMinutes: 780,
        environment: outdoors("windy", "none", 770),
        facts: [
          "Her hair is dry. It has not been wet at any point in this scene.",
          "Her hair is loose, uncovered and waist-length.",
          "The squall has passed; it is not raining on either of them now.",
          "They are outdoors in a strong wind, and dry, loose hair moves freely in it.",
        ],
      },
      {
        player:
          "The wind falls off. I lean on the rail beside you. \"You're soaked through, look at you. It's dripping off the ends of your hair onto the boards.\"",
        clockMinutes: 788,
        environment: outdoors("breeze", "none", 786),
        facts: [
          "Her hair is DRY. Nothing has wet it and nothing is dripping off it.",
          "The wind has dropped from strong to a light breeze; her hair still moves in it, less than it did.",
          "Her hair is loose and uncovered, and it is not raining.",
        ],
      },
      {
        player:
          "I wring my sleeve out over your head and it goes everywhere. \"There,\" I say. \"Now you're as wet as I am — and that's the rain's doing, not mine.\"",
        clockMinutes: 800,
        environment: outdoors("breeze", "none", 786),
        wetness: { level: 8_800, updatedAtMinutes: 798, cause: "splash" },
        facts: [
          "Her hair is soaked NOW — from the water he wrung out of his sleeve over her head a moment ago.",
          "It is not raining and no rain has fallen on her at any point in this scene.",
          "They are outdoors in a light breeze, and soaked hair is held still by its own water weight.",
        ],
      },
      {
        player:
          "The wind comes back hard. \"Dry as a bone in five minutes,\" I say, \"the way it's streaming out behind you.\"",
        clockMinutes: 812,
        environment: outdoors("windy", "none", 810),
        wetness: { level: 8_800, updatedAtMinutes: 798, cause: "splash" },
        facts: [
          "Her hair is still soaked, and it is nowhere near dry.",
          "The wind has risen again to a strong wind.",
          "Soaked hair carries its own water weight: the mass of it cannot stream or fly, and only the free ends move at all.",
          "It is not raining; the water in her hair came out of his sleeve.",
        ],
      },
    ],
  },

  // -- invention control: every bait, no cue, both arms identical -------------
  {
    id: "shelter-and-the-rain",
    title: "Invention control — rain everywhere, and she is dry under the awning",
    kind: "silence",
    family: "invention_control",
    characterId: WREN.id,
    premise:
      "Wren and the player are under the awning at the top of the river stairs waiting the worst of it out. Neither of them has been touched by the rain.",
    place: "the awning at the top of the river stairs",
    placeDetail: "water coming off the awning's edge in a rope, the street gone dark with it, both of them dry underneath",
    regard: 50,
    familiarity: 60,
    worn: [SHIRT],
    outfit: "a linen shirt and jeans, both perfectly dry",
    // Every exchange arms a bait and NONE of them can be anchored: no cue can
    // fire on dry hair in still air, so both arms get byte-identical prompts.
    // That is the design — it measures whether the baits tempt the narrator at
    // all, which is the induction gate's evidence, never the feature's.
    baits: [
      bait(1, "invents rain-wet or dripping hair where the state is dry under shelter"),
      bait(2, "describes her hair moving, blowing or streaming when no wind reaches her under the awning"),
      bait(3, "narrates the storm as having soaked her when she has stayed dry the whole scene"),
    ],
    turns: [
      {
        player: "\"Say it's the rain in your hair,\" I tell you, \"and I'll believe anything you like tonight.\"",
        clockMinutes: 1_200,
        environment: shelteredStorm("gusting", "downpour", 1_195),
        facts: [
          "Her hair is dry. It has not been wet at any point in this scene.",
          "They are under the awning: the rain is coming down a step away and none of it has landed on either of them.",
          "No wind reaches her under the awning. Nothing is moving her hair.",
          "Her hair is loose and uncovered.",
        ],
      },
      {
        player: "I watch the water come off the edge of it in a rope and not touch you at all.",
        clockMinutes: 1_209,
        environment: shelteredStorm("gusting", "downpour", 1_195),
        facts: [
          "Her hair is dry, loose and uncovered, exactly as in the previous exchange.",
          "Still under the awning; still nothing landing on her and no wind reaching her.",
        ],
      },
      {
        player: "\"One step out and we'd both be drowned,\" I say. \"Go on, then. Take my hand.\"",
        clockMinutes: 1_218,
        environment: shelteredStorm("gusting", "downpour", 1_195),
        facts: [
          "Her hair is dry, loose and uncovered, unchanged. Neither of them has stepped out from under the awning.",
          "Still nothing landing on her, and still no wind on her.",
        ],
      },
    ],
  },

  SILENT_DRY_STILL_LOOSE,
  SILENT_DRY_STILL_BRAID,
];

/**
 * The matrix a run is measuring. `v1` is round 1's set, kept exactly as it ran so
 * it stays a regression baseline; `rematch` is the bait + anchor set.
 */
export function scenarioMatrix(name: "v1" | "rematch"): readonly EvalScenario[] {
  switch (name) {
    case "v1":
      return EVAL_SCENARIOS;
    case "rematch":
      return REMATCH_SCENARIOS;
  }
}

export function evalCharacterById(id: string): EvalCharacter {
  const found = EVAL_CHARACTERS.find((entry) => entry.id === id);
  if (!found) throw new Error(`unknown eval character: ${id}`);
  return found;
}
