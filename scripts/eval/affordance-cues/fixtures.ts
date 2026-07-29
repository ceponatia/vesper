import { characterProfileSchema, type CharacterProfile } from "@/contracts/world/profile";
import type { BodySurfaceWetnessCause } from "@/contracts/state/body-surface";
import type { ChatEnvironment } from "@/contracts/state/chat-environment";
import type { WornItemInput } from "@/contracts/items/visibility";
import {
  hairAttributeFixture,
  type HairAttributeFixtureInput,
} from "@/contracts/affordances/domains/hair/fixtures";

/**
 * Scenario matrix for the slice-5 narrator trial
 * (`docs/developer-notes/body-attribute-affordances.plan.md` §"Slice 5 — narrator trial").
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

export interface EvalScenario {
  readonly id: string;
  readonly title: string;
  /** `cue` ⇒ the read is expected to speak at least once; `silence` ⇒ never. */
  readonly kind: "cue" | "silence";
  readonly characterId: string;
  readonly premise: string;
  readonly place: string;
  readonly placeDetail: string;
  readonly regard: number;
  readonly familiarity: number;
  /** Standing wardrobe; per-turn `worn` overrides it. */
  readonly worn: readonly WornItemInput[];
  /** Standing outfit phrase; per-turn `outfit` overrides it. */
  readonly outfit: string;
  readonly hair?: Partial<HairAttributeFixtureInput>;
  readonly turns: readonly EvalTurn[];
}

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

// ---------------------------------------------------------------------------
// The matrix
// ---------------------------------------------------------------------------

export const EVAL_SCENARIOS: readonly EvalScenario[] = [
  // -- 1. soaked + loose + still raining -------------------------------------
  {
    id: "rain-arrival-loose",
    title: "Soaked and loose, still out in the rain",
    kind: "cue",
    characterId: WREN.id,
    premise:
      "Wren has just come down the river stairs to unlock the shop's side gate; the rain has been going for an hour.",
    place: "the side gate on Cable Street",
    placeDetail: "a narrow brick passage, the gutter overflowing, rain coming straight down",
    regard: 30,
    familiarity: 40,
    worn: [SHIRT],
    outfit: "a linen shirt gone dark at the shoulders and jeans",
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
    characterId: WREN.id,
    premise: "Wren and the player are pinned under the boathouse eaves waiting out a squall.",
    place: "the boathouse eaves",
    placeDetail: "tar-smelling planks, water sheeting off the roof edge, the river invisible behind it",
    regard: 25,
    familiarity: 35,
    worn: [SHIRT, HOOD],
    outfit: "a linen shirt under a heavy oilskin, the hood up",
    hair: { arrangement: "braid" },
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
    characterId: ILSE.id,
    premise: "Ilse is up on the harbour wall checking the mooring lines before the weather turns.",
    place: "the harbour wall",
    placeDetail: "wet stone, a low grey sky, the wind coming straight off the water",
    regard: 15,
    familiarity: 25,
    worn: [COVERALL],
    outfit: "canvas coveralls with the sleeves shoved up",
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
    characterId: WREN.id,
    premise: "Wren is helping re-coil the ferry's bow line on the open deck with the wind up and spray coming over.",
    place: "the ferry's foredeck",
    placeDetail: "wet steel, spray coming over the rail, the diesel idling below",
    regard: 20,
    familiarity: 30,
    worn: [COVERALL],
    outfit: "borrowed canvas coveralls and fingerless gloves",
    hair: { arrangement: "bun" },
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
    characterId: WREN.id,
    premise: "Wren is out of the bath and wrapped up, the flat quiet around them.",
    place: "the flat above the shop",
    placeDetail: "steam on the window, a radiator ticking, the street noise shut out",
    regard: 55,
    familiarity: 65,
    worn: [SHIRT],
    outfit: "an oversized linen shirt and nothing much else",
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
    characterId: WREN.id,
    premise: "Wren got caught in a squall twenty minutes ago and is walking the towpath home with it still blowing.",
    place: "the towpath",
    placeDetail: "puddled gravel, the hedges thrashing, the rain already gone east",
    regard: 35,
    familiarity: 45,
    worn: [SHIRT],
    outfit: "a linen shirt plastered flat and jeans",
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
    characterId: WREN.id,
    premise: "The shop's back-kitchen tap has just let go over the sink and caught Wren full in the face.",
    place: "the bookshop back kitchen",
    placeDetail: "a cracked butler sink, a kettle, boxes of stock stacked to the ceiling",
    regard: 45,
    familiarity: 55,
    worn: [SHIRT, SCARF],
    outfit: "a linen shirt with a gauze scarf tied back over her hair",
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
    characterId: ILSE.id,
    premise: "Ilse is on the slipway lashing a tarp over the outboard, the drizzle just blown through.",
    place: "the slipway",
    placeDetail: "weed-slick concrete, the drizzle gone over, the wind coming up behind it",
    regard: 20,
    familiarity: 30,
    worn: [COVERALL],
    outfit: "canvas coveralls, the collar turned up",
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

  // -- 9. SILENCE control: dry, loose, indoors, still ------------------------
  {
    id: "silent-dry-still-loose",
    title: "Silence control — dry, loose, indoors, dead still",
    kind: "silence",
    characterId: WREN.id,
    premise: "An ordinary slow hour in the shop with nobody else in it.",
    place: "the bookshop back room",
    placeDetail: "a two-bar heater, cardboard boxes of stock, the shutter down",
    regard: 40,
    familiarity: 50,
    worn: [SHIRT],
    outfit: "a linen shirt and jeans",
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
  },

  // -- 10. SILENCE control: dry, braided, outdoors in still air --------------
  {
    id: "silent-dry-still-braid",
    title: "Silence control — dry, braided, outdoors in dead-still air",
    kind: "silence",
    characterId: ILSE.id,
    premise: "Flat calm on the river; Ilse is topping up the ferry's oil with nothing else to do.",
    place: "the ferry's engine well",
    placeDetail: "flat brown water, no air moving at all, gulls sitting on the pontoon",
    regard: 25,
    familiarity: 35,
    worn: [COVERALL],
    outfit: "canvas coveralls with an oily rag through the belt loop",
    hair: { arrangement: "braid" },
    turns: [
      {
        player: "I hold the funnel steady while you pour.",
        clockMinutes: 600,
        environment: { wind: "none", precipitation: "none", indoors: false, updatedAtMinutes: 560 },
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
        environment: { wind: "none", precipitation: "none", indoors: false, updatedAtMinutes: 560 },
        facts: [
          "Her hair is dry and braided, exactly as in the previous exchange.",
          "Still dead calm; no wind, no rain.",
        ],
      },
      {
        player: "I screw the cap back on and hand you the rag.",
        clockMinutes: 617,
        environment: { wind: "none", precipitation: "none", indoors: false, updatedAtMinutes: 560 },
        facts: ["Her hair is dry and braided, unchanged.", "Still dead calm; no wind, no rain."],
      },
    ],
  },
];

export function evalCharacterById(id: string): EvalCharacter {
  const found = EVAL_CHARACTERS.find((entry) => entry.id === id);
  if (!found) throw new Error(`unknown eval character: ${id}`);
  return found;
}
