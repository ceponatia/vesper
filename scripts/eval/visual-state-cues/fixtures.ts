import type { ScenePosture, SceneProximityBand, SceneFacing } from "@/contracts/affordances/scene";

/**
 * The slice-7 trial matrix.
 *
 * ## Bait, not scenery — the round-1 lesson, inherited
 *
 * The affordance-cue trial's first round measured nothing because its control
 * arm had no contradictions to reduce: the scenes were true but never TEMPTED a
 * specific wrong claim, so both arms stayed vague and clean. This matrix is
 * built the rematch way instead. Every scenario belongs to a **bait family** naming
 * the wrong claim its scene invites, and arms that bait per exchange only where
 * the projection genuinely has something to say.
 *
 * The five families are the five ways prose contradicts a visual projection:
 *
 * - `garment_presence` — dressing her in what she took off, or undressing what
 *   she is wearing;
 * - `arrangement` — a rolled cuff written down, an open coat written closed;
 * - `wetness` — a damp head written soaked, a soaked coat written dry;
 * - `body_language` — a seated, supported body written standing or crossing
 *   the room;
 * - `hidden_detail` — describing a surface a garment covers, which is the
 *   leakage axis and the one where the RIGHT answer is silence.
 *
 * ## Both arms are told the same true things
 *
 * `sceneFacts` is the both-arms channel the affordance rematch had to add: the
 * narrator prompt carries no wetness line and no wardrobe-arrangement line
 * outside the visual blocks, so without it the control arm could not
 * misdescribe a state it had never been told about — it would stay vague, stay
 * clean, and the induction gate would fail for the wrong reason. These are
 * scene details, so they land identically in both arms' Scene block.
 *
 * Every scenario is built from COMMITTED TYPED STATE — real garment instances
 * with real presentation and condition, a `body_surface` wetness entry with its
 * cause, a real `SceneState` — never from prose, because prose is what the
 * layer under test refuses to treat as an input.
 */

export const evalBaitFamilies = [
  "garment_presence",
  "arrangement",
  "wetness",
  "body_language",
  "hidden_detail",
] as const;
export type EvalBaitFamily = (typeof evalBaitFamilies)[number];

/**
 * One garment as this matrix commits it, in READABLE terms. `harness.ts` turns
 * each of these into a real `GarmentInstanceState` through the production
 * fixture builder — the schema shapes (a closure discriminated union, a
 * condition vector, a scene locus with its place and anchor) belong there, not
 * in a matrix a person has to read.
 */
export interface EvalGarment {
  readonly id: string;
  readonly name: string;
  readonly categoryId?: string;
  readonly coverage?: readonly string[];
  /** Where the wardrobe owner says it is. */
  readonly where: "worn" | "held" | "scene";
  readonly layer?: number;
  /** The garment owner's own material-profile ids, verbatim. */
  readonly materialProfileId?:
    | "woven_cotton_linen"
    | "knit"
    | "wool"
    | "leather"
    | "denim"
    | "silk_satin"
    | "synthetic_shell"
    | "unknown";
  /** Part ids rolled all the way up ("sleeve_left"). */
  readonly rolled?: readonly string[];
  /** Part ids hanging fully open ("front"). */
  readonly open?: readonly string[];
  /** Tuck reading per part id, where the garment commits one. */
  readonly tuck?: Readonly<Record<string, "out" | "partial" | "in">>;
  /** Whole-garment wetness, 0…10 000. Absent ⇒ dry. */
  readonly wetness?: number;
}

/** The scene as this matrix commits it — the owner's own vocabulary, nothing invented. */
export interface EvalScene {
  readonly posture: ScenePosture;
  readonly proximity: SceneProximityBand;
  /** How the CHARACTER is oriented toward the player. */
  readonly facing: SceneFacing;
  /** A surface she is held up by / leaning on, when the scene commits one. */
  readonly support?: { readonly kind: "ground" | "seat" | "bed" | "table" | "wall" | "prop"; readonly role: "borne_by" | "leaning_on" };
}

export interface EvalTurn {
  /** The player's line for this exchange. */
  readonly player: string;
  readonly clockMinutes: number;
  /** Committed hair wetness, 0…10 000 with its cause. Absent ⇒ dry. */
  readonly hairWetness?: { readonly level: number; readonly updatedAtMinutes: number; readonly cause?: "rain" | "splash" | "immersion" | "other" };
  /** The garments this exchange commits. Absent ⇒ the scenario's standing set. */
  readonly garments?: readonly EvalGarment[];
  /** The scene this exchange commits. Absent ⇒ the scenario's standing scene. */
  readonly scene?: EvalScene;
  /** Body locations the observer can resolve, and how. Absent ⇒ the scenario's. */
  readonly exposure?: Readonly<Record<string, "visible" | "hinted" | "hidden">>;
  /**
   * The wrong claim this exchange tempts, as a named check for the audit
   * ("attributes bath wetness to the rain"). Absent ⇒ no bait armed and only
   * the five standing dimensions apply.
   */
  readonly tempts?: string;
  /**
   * The detail the projection should be surfacing THIS exchange because it just
   * became visible or just changed — the newly-revealed axis, asked of the
   * audit as a named check. Absent ⇒ nothing is expected.
   */
  readonly reveals?: string;
  /** Plain-English facts that follow from the committed state; the audit's ground truth. */
  readonly facts: readonly string[];
}

export interface EvalScenario {
  readonly id: string;
  readonly family: EvalBaitFamily;
  readonly title: string;
  readonly premise: string;
  readonly place: string;
  readonly placeDetail: string;
  /** The both-arms channel — true scene detail, in the Scene block, identical for both arms. */
  readonly sceneFacts: readonly string[];
  readonly outfit: string;
  readonly regard?: number;
  readonly familiarity?: number;
  readonly garments: readonly EvalGarment[];
  readonly scene: EvalScene;
  readonly exposure: Readonly<Record<string, "visible" | "hinted" | "hidden">>;
  readonly turns: readonly EvalTurn[];
}

// ---------------------------------------------------------------------------
// Shared pieces
// ---------------------------------------------------------------------------

/** The actor handle every scenario dresses. Mirrors `garmentActorForCharacter`. */
export const EVAL_ACTOR_ID = "c:vs_trial_subject";
export const EVAL_SUBJECT_ID = "vs_trial_subject";
export const EVAL_CHARACTER_NAME = "Mara";
export const EVAL_PLAYER_NAME = "Sam";
export const EVAL_PLAYER_PERSONA =
  "A boat-yard carpenter who has known Mara since the spring and still knocks before coming in.";

const ALL_VISIBLE: Readonly<Record<string, "visible" | "hinted" | "hidden">> = {
  hair: "visible",
  face: "visible",
  nose: "visible",
  arms: "visible",
  hands: "visible",
};

/** Torso covered by an opaque layer — the hidden-detail family's whole point. */
const TORSO_COVERED: Readonly<Record<string, "visible" | "hinted" | "hidden">> = {
  ...ALL_VISIBLE,
  torso: "hidden",
  chest: "hidden",
  back: "hidden",
};

// ---------------------------------------------------------------------------
// The matrix
// ---------------------------------------------------------------------------

export const scenarioMatrix: readonly EvalScenario[] = [
  // --- garment_presence ----------------------------------------------------
  {
    id: "coat-on-the-chair",
    family: "garment_presence",
    title: "The coat came off an hour ago",
    premise: "Mara came in out of the weather and has been at the table since.",
    place: "The back room of the boat yard",
    placeDetail: "A long table, a stove that never quite catches, one window onto the slip.",
    sceneFacts: [
      "Mara's oilskin coat is over the back of the chair by the door, where she hung it when she came in.",
      "It rained hard for most of the afternoon and has only just stopped.",
    ],
    outfit: "a wool jumper and work trousers",
    garments: [
      { id: "g_coat", name: "oilskin coat", where: "scene", categoryId: "outerwear", materialProfileId: "synthetic_shell", wetness: 7_000 },
      { id: "g_jumper", name: "wool jumper", where: "worn", layer: 1, materialProfileId: "wool" },
    ],
    scene: { posture: "sitting", proximity: "close", facing: "toward", support: { kind: "seat", role: "borne_by" } },
    exposure: ALL_VISIBLE,
    turns: [
      {
        player: "*I shoulder the door open, arms full of rope.* You waited out the worst of it, then.",
        clockMinutes: 17 * 60,
        facts: [
          "The oilskin coat is NOT on Mara — it is over the chair by the door.",
          "Mara is wearing the wool jumper.",
          "Mara is sitting, borne by the chair.",
        ],
        tempts: "describe Mara as still wearing or wrapped in her coat",
        reveals: "the coat is off and on the chair, not on her",
      },
      {
        player: "*I drop the coil by the stove.* You look like you're settled in. That coat of yours dry yet?",
        clockMinutes: 17 * 60 + 6,
        facts: [
          "The coat is still soaked and still on the chair, not on Mara.",
          "Mara has not moved from the chair.",
        ],
        tempts: "have Mara pull her coat around her, or describe her as wearing it",
        reveals: "the coat is still wet where it hangs",
      },
      {
        player: "Come look at this splice before I set it.",
        clockMinutes: 17 * 60 + 11,
        facts: ["The coat is on the chair.", "Mara is in the wool jumper only."],
      },
    ],
  },
  {
    id: "sleeves-and-the-cold",
    family: "garment_presence",
    title: "Nothing over the shirt",
    premise: "A cold evening in the loft; Mara has been sorting hardware for an hour.",
    place: "The sail loft",
    placeDetail: "Bare boards, a bench under the north light, trays of brass fittings.",
    sceneFacts: [
      "There is no coat or jumper in the loft — Mara came up in her shirt.",
      "The loft has no stove and the north light leaks cold.",
    ],
    outfit: "a linen shirt and canvas trousers",
    garments: [
      { id: "g_shirt", name: "linen shirt", where: "worn", layer: 1, materialProfileId: "woven_cotton_linen" },
    ],
    scene: { posture: "standing", proximity: "near", facing: "side_on" },
    exposure: ALL_VISIBLE,
    turns: [
      {
        player: "*I come up the ladder with two mugs.* You must be freezing up here.",
        clockMinutes: 20 * 60,
        facts: ["Mara is wearing ONLY the linen shirt and trousers.", "There is no coat, jumper or shawl anywhere in this scene."],
        tempts: "give Mara a coat, jumper, shawl or blanket she does not have",
      },
      {
        player: "Here. *I hold out the mug.* Take it before I drop it.",
        clockMinutes: 20 * 60 + 4,
        facts: ["Still only the linen shirt.", "Mara is standing, side-on to Sam."],
        tempts: "describe Mara pulling a wrap or coat closer around herself",
      },
      {
        player: "What's left in the tray?",
        clockMinutes: 20 * 60 + 9,
        facts: ["Still only the linen shirt."],
      },
    ],
  },

  // --- arrangement ---------------------------------------------------------
  {
    id: "rolled-to-the-elbow",
    family: "arrangement",
    title: "Sleeves rolled since noon",
    premise: "Mara is bedding varnish onto a tiller and has been at it since noon.",
    place: "The finishing shed",
    placeDetail: "Trestles, a tiller clamped at waist height, the smell of spirit.",
    sceneFacts: [
      "Mara rolled her shirt sleeves to the elbow before she started and has not put them down.",
      "There is varnish on the backs of both her hands.",
    ],
    outfit: "a linen shirt with the sleeves rolled",
    garments: [
      {
        id: "g_shirt",
        name: "linen shirt",
        where: "worn",
        layer: 1,
        materialProfileId: "woven_cotton_linen",
        rolled: ["sleeve_left", "sleeve_right"],
      },
    ],
    scene: { posture: "standing", proximity: "close", facing: "toward" },
    exposure: ALL_VISIBLE,
    turns: [
      {
        player: "*I catch her wrist before she can put another coat on.* That's enough. Look at the light.",
        clockMinutes: 15 * 60,
        facts: [
          "BOTH of Mara's shirt sleeves are rolled to the elbow.",
          "Her forearms are bare.",
        ],
        tempts: "describe a cuff at her wrist, a buttoned cuff, or a sleeve covering her forearm",
        reveals: "the sleeves are rolled and her forearms bare",
      },
      {
        player: "You've got it on your hands. *I turn her palm over.*",
        clockMinutes: 15 * 60 + 5,
        facts: ["The sleeves are STILL rolled — nothing has changed them.", "Her forearms are still bare."],
        tempts: "have a sleeve fall down over her hand, or describe her shaking a cuff loose",
      },
      {
        player: "Leave it till morning.",
        clockMinutes: 15 * 60 + 10,
        facts: ["The sleeves are still rolled."],
      },
    ],
  },
  {
    id: "the-open-coat",
    family: "arrangement",
    title: "Unbuttoned and hanging open",
    premise: "Mara stopped on the quay to talk and has not done her coat up.",
    place: "The quay",
    placeDetail: "Bollards, a stack of pallets, the tide well out.",
    sceneFacts: [
      "Mara's coat has been hanging open since she stopped walking.",
      "The wind is coming straight up the channel.",
    ],
    outfit: "an open oilskin coat over a jumper",
    garments: [
      {
        id: "g_coat",
        name: "oilskin coat",
        where: "worn",
        categoryId: "outerwear",
        layer: 2,
        materialProfileId: "synthetic_shell",
        open: ["front"],
      },
      { id: "g_jumper", name: "wool jumper", where: "worn", layer: 1, materialProfileId: "wool" },
    ],
    scene: { posture: "standing", proximity: "close", facing: "toward" },
    exposure: ALL_VISIBLE,
    turns: [
      {
        player: "*I nod at the channel.* You'll not get across tonight.",
        clockMinutes: 18 * 60,
        facts: ["Mara's coat is OPEN — unfastened, hanging loose.", "The jumper is underneath it."],
        tempts: "describe the coat as buttoned, fastened, done up, or wrapped tight",
        reveals: "the coat is hanging open",
      },
      {
        player: "That wind's got teeth. *I turn my collar up.*",
        clockMinutes: 18 * 60 + 4,
        facts: ["The coat is STILL open — nobody has fastened it."],
        tempts: "have Mara button, zip, or pull her coat closed against the wind",
      },
      {
        player: "Walk back with me.",
        clockMinutes: 18 * 60 + 8,
        facts: ["The coat is still open."],
      },
    ],
  },

  // --- wetness -------------------------------------------------------------
  {
    id: "damp-not-drenched",
    family: "wetness",
    title: "Damp, an hour after the rain",
    premise: "Mara got caught in a shower on the way over and has been inside since.",
    place: "The chandlery",
    placeDetail: "Shelves of shackles and line, a counter worn pale, one bulb.",
    sceneFacts: [
      "It poured for ten minutes around four and has been dry since.",
      "Mara walked here through the end of it and has been in the warm for an hour.",
    ],
    outfit: "a wool jumper",
    garments: [{ id: "g_jumper", name: "wool jumper", where: "worn", layer: 1, materialProfileId: "wool" }],
    scene: { posture: "standing", proximity: "close", facing: "toward" },
    exposure: ALL_VISIBLE,
    turns: [
      {
        player: "*I shake the rain off my cap.* You got the worst of that, by the look of you.",
        clockMinutes: 17 * 60,
        hairWetness: { level: 3_600, updatedAtMinutes: 16 * 60 + 50, cause: "rain" },
        facts: [
          "Mara's hair is DAMP — not soaked, not dripping, not wet through.",
          "The jumper is dry.",
        ],
        tempts: "call her hair soaked, drenched, dripping, sodden, or plastered to her head",
        reveals: "her hair is damp from the rain",
      },
      {
        player: "Sit by the heater a minute.",
        clockMinutes: 17 * 60 + 7,
        hairWetness: { level: 3_600, updatedAtMinutes: 16 * 60 + 50, cause: "rain" },
        facts: ["Her hair is still only damp.", "It is drying, not getting wetter."],
        tempts: "escalate the wetness, or have water run or drip from her hair",
      },
      {
        player: "What did you come for, anyway?",
        clockMinutes: 17 * 60 + 14,
        facts: ["Her hair is nearly dry now."],
      },
    ],
  },
  {
    id: "soaked-from-the-tank",
    family: "wetness",
    title: "Soaked, and not by the weather",
    premise: "A hose let go while Mara was bleeding the header tank.",
    place: "The engine shop",
    placeDetail: "A stripped diesel on the bench, a floor drain, strip lights.",
    sceneFacts: [
      "A hose let go on the header tank five minutes ago and caught Mara across the head and shoulders.",
      "It has been dry and still outside all day.",
    ],
    outfit: "a soaked cotton shirt",
    garments: [
      {
        id: "g_shirt",
        name: "cotton shirt",
        where: "worn",
        layer: 1,
        materialProfileId: "woven_cotton_linen",
        wetness: 9_000,
      },
    ],
    scene: { posture: "standing", proximity: "close", facing: "toward" },
    exposure: ALL_VISIBLE,
    turns: [
      {
        player: "*I get the stopcock over.* Christ. Are you hurt?",
        clockMinutes: 12 * 60 + 30,
        hairWetness: { level: 9_200, updatedAtMinutes: 12 * 60 + 25, cause: "splash" },
        facts: [
          "Mara is soaked — hair and shirt both — from the burst hose.",
          "It has NOT rained today; the weather outside is dry and still.",
        ],
        tempts: "blame the rain or the weather for how wet she is",
        reveals: "she is soaked through, and her shirt is clinging",
      },
      {
        player: "Here—take my jacket off the hook.",
        clockMinutes: 12 * 60 + 34,
        hairWetness: { level: 8_500, updatedAtMinutes: 12 * 60 + 25, cause: "splash" },
        facts: ["Still soaked.", "Still nothing to do with weather — the day is dry."],
        tempts: "attribute the wet to rain, a storm, or going out in the weather",
      },
      {
        player: "Sit down before you fall down.",
        clockMinutes: 12 * 60 + 40,
        hairWetness: { level: 7_500, updatedAtMinutes: 12 * 60 + 25, cause: "splash" },
        facts: ["Still wet through."],
      },
    ],
  },

  // --- body_language -------------------------------------------------------
  {
    id: "she-is-not-standing",
    family: "body_language",
    title: "Down on the boards, not standing",
    premise: "Mara is under the counter chasing a leak.",
    place: "The chandlery",
    placeDetail: "A counter with the kick-board off, a torch on its side, a bucket.",
    sceneFacts: [
      "Mara is kneeling on the boards with her shoulder under the counter.",
      "There is a bucket half under the trap catching the drip.",
    ],
    outfit: "a cotton shirt and canvas trousers",
    garments: [{ id: "g_shirt", name: "cotton shirt", where: "worn", layer: 1, materialProfileId: "woven_cotton_linen" }],
    scene: { posture: "kneeling", proximity: "close", facing: "away", support: { kind: "ground", role: "borne_by" } },
    exposure: ALL_VISIBLE,
    turns: [
      {
        player: "*I put my head round the door.* Any joy?",
        clockMinutes: 11 * 60,
        facts: [
          "Mara is KNEELING on the floor, turned away from Sam, shoulder under the counter.",
          "She is not standing and has not stood up.",
        ],
        tempts: "have Mara standing, straightening up to face him, or crossing the room",
        reveals: "she is down on the boards with her back to the door",
      },
      {
        player: "Pass me the torch, I'll hold it.",
        clockMinutes: 11 * 60 + 3,
        facts: ["Mara is STILL kneeling and still turned away.", "Only her arm comes out from under the counter."],
        tempts: "have her get up, turn round to face him, or walk over",
      },
      {
        player: "Left a bit. There.",
        clockMinutes: 11 * 60 + 6,
        facts: ["Still kneeling, still turned away."],
      },
    ],
  },
  {
    id: "one-hand-is-busy",
    family: "body_language",
    title: "A hand already full",
    premise: "Mara has a length of hot shrink-wrap pinched closed and cannot let go.",
    place: "The engine shop",
    placeDetail: "A loom of cable on the bench, a heat gun cooling, the smell of it.",
    sceneFacts: [
      "Mara is holding a joint pinched shut with her right hand while it cools.",
      "If she lets go before it sets the whole loom has to come apart again.",
    ],
    outfit: "a cotton shirt",
    garments: [{ id: "g_shirt", name: "cotton shirt", where: "worn", layer: 1, materialProfileId: "woven_cotton_linen" }],
    scene: { posture: "sitting", proximity: "close", facing: "toward", support: { kind: "seat", role: "borne_by" } },
    exposure: ALL_VISIBLE,
    turns: [
      {
        player: "*I set the tea down beside her.* Two minutes and it's stewed.",
        clockMinutes: 14 * 60,
        facts: [
          "Mara's right hand is occupied holding the joint closed and cannot be freed.",
          "Mara is sitting.",
        ],
        tempts: "have Mara take the mug, or use both hands for something",
        reveals: "her right hand is not free",
      },
      {
        player: "*I hold the mug out anyway.* Go on.",
        clockMinutes: 14 * 60 + 3,
        facts: ["Her right hand is STILL holding the joint.", "She has at most one free hand."],
        tempts: "have her take the mug in both hands, or clap, or fold her arms",
      },
      {
        player: "Fine. I'll drink it.",
        clockMinutes: 14 * 60 + 6,
        facts: ["Her right hand is still occupied."],
      },
    ],
  },

  // --- hidden_detail -------------------------------------------------------
  {
    id: "under-the-jumper",
    family: "hidden_detail",
    title: "What the jumper covers",
    premise: "Mara is going over a list at the table, covered to the throat.",
    place: "The back room of the boat yard",
    placeDetail: "The long table, the stove going properly for once, a list gone soft with handling.",
    sceneFacts: [
      "Mara's jumper is a heavy one, buttoned to the throat, with nothing showing below the collar.",
      "There is a scar on her collarbone from the winch, but nobody can see it under that jumper.",
    ],
    outfit: "a heavy wool jumper buttoned to the throat",
    garments: [
      {
        id: "g_jumper",
        name: "heavy wool jumper",
        where: "worn",
        layer: 1,
        materialProfileId: "wool",
        coverage: ["torso", "chest", "back", "arms"],
      },
    ],
    scene: { posture: "sitting", proximity: "close", facing: "toward", support: { kind: "seat", role: "borne_by" } },
    exposure: TORSO_COVERED,
    turns: [
      {
        player: "*I sit down opposite.* You're quiet tonight.",
        clockMinutes: 21 * 60,
        facts: [
          "Mara's torso, chest, back and collarbone are COVERED by the jumper and cannot be seen.",
          "Her face, hair and hands are visible.",
        ],
        tempts: "describe her collarbone, her chest, her shoulders bare, or the scar under the jumper",
      },
      {
        player: "That winch business still bothering you?",
        clockMinutes: 21 * 60 + 4,
        facts: [
          "The scar is still covered. Nothing about it is visible in this scene.",
          "Naming it in dialogue is fine; SEEING it is not.",
        ],
        tempts: "have the narrator describe the scar as visible, or her hand at her bare collarbone",
      },
      {
        player: "You'd tell me if it was.",
        clockMinutes: 21 * 60 + 8,
        facts: ["Still covered."],
      },
    ],
  },
  {
    id: "back-to-the-room",
    family: "hidden_detail",
    title: "Turned away at the window",
    premise: "Mara is at the window with her back to the room.",
    place: "The sail loft",
    placeDetail: "The north light, a bench of trays, the slip below.",
    sceneFacts: [
      "Mara has been standing at the window with her back to the room since Sam came up.",
      "The glass is old and gives back nothing but shape.",
    ],
    outfit: "a linen shirt",
    garments: [{ id: "g_shirt", name: "linen shirt", where: "worn", layer: 1, materialProfileId: "woven_cotton_linen" }],
    scene: { posture: "standing", proximity: "near", facing: "away" },
    exposure: ALL_VISIBLE,
    turns: [
      {
        player: "*I stop at the top of the ladder.* They've hauled her out, then.",
        clockMinutes: 19 * 60,
        facts: [
          "Mara is turned AWAY from Sam, facing the window.",
          "Sam cannot see her face or her expression.",
        ],
        tempts: "describe Mara's face, her eyes, or an expression Sam has no way of seeing",
        reveals: "she has her back to him",
      },
      {
        player: "Mara.",
        clockMinutes: 19 * 60 + 3,
        facts: ["She is STILL turned away — she has not turned round.", "Her face is still not visible to Sam."],
        tempts: "describe her expression, her eyes, or a look she gives him without turning",
      },
      {
        player: "*I wait.*",
        clockMinutes: 19 * 60 + 6,
        facts: ["Still turned away."],
      },
    ],
  },
];

export function scenarioById(id: string): EvalScenario {
  const found = scenarioMatrix.find((scenario) => scenario.id === id);
  if (!found) throw new Error(`unknown scenario: ${id}`);
  return found;
}
