import {
  emptyChatGarmentStore,
  emptyGarmentPresentationState,
  garmentActorForCharacter,
  garmentBlueprintForSeed,
  garmentBlueprintHash,
  pristineGarmentConditionState,
  GARMENT_DEGREE_BAND_VALUES,
  GARMENT_PLAYER_ACTOR,
  GARMENT_UNIT_ONE,
  type ChatGarmentStore,
  type GarmentBlueprint,
  type GarmentConditionState,
  type GarmentInstanceState,
  type GarmentLocus,
  type GarmentOperationProposal,
  type GarmentPresentationState,
} from "@/contracts";

/** Fixed, checked-in corpus for the clothing-state slice-6 tuning run. */

export const CHARACTER_ID = "char_wren";
export const CHARACTER_NAME = "Wren";
export const PLAYER_NAME = "Sam";
export const CHARACTER_ACTOR = garmentActorForCharacter(CHARACTER_ID);

export const SHIRT = garmentBlueprintForSeed({
  definitionId: "def_eval_linen_shirt",
  name: "linen shirt",
  categoryId: "top",
  coverage: ["shoulders", "chest", "back", "waist", "upper_arms"],
  materialProfileId: "woven_cotton_linen",
});

export const JEANS = garmentBlueprintForSeed({
  definitionId: "def_eval_dark_jeans",
  name: "dark jeans",
  categoryId: "pants",
  coverage: ["pelvis", "thighs", "calves", "ankles"],
  materialProfileId: "denim",
});

export function garmentInstance(input: {
  id: string;
  name: string;
  blueprint: GarmentBlueprint;
  locus?: GarmentLocus;
  presentation?: Partial<GarmentPresentationState>;
  condition?: Partial<GarmentConditionState>;
}): GarmentInstanceState {
  return {
    id: input.id,
    blueprintHash: garmentBlueprintHash(input.blueprint),
    name: input.name,
    locus: input.locus ?? { kind: "worn", actorId: CHARACTER_ACTOR },
    presentation: { ...emptyGarmentPresentationState(), ...input.presentation },
    condition: { ...pristineGarmentConditionState(), ...input.condition },
    lastChange: { kind: "mint", atMinutes: 0 },
  };
}

export function garmentStore(instances: readonly GarmentInstanceState[]): ChatGarmentStore {
  return {
    ...emptyChatGarmentStore(),
    seeded: true,
    blueprints: {
      [garmentBlueprintHash(SHIRT)]: SHIRT,
      [garmentBlueprintHash(JEANS)]: JEANS,
    },
    instances: [...instances],
  };
}

function plainShirt(): GarmentInstanceState {
  return garmentInstance({ id: "g_shirt", name: "linen shirt", blueprint: SHIRT });
}

function rolledShirt(): GarmentInstanceState {
  return garmentInstance({
    id: "g_shirt",
    name: "linen shirt",
    blueprint: SHIRT,
    presentation: { roll: { sleeve_left: GARMENT_DEGREE_BAND_VALUES.substantial } },
  });
}

function wetShirt(level: number): GarmentInstanceState {
  return garmentInstance({
    id: "g_shirt",
    name: "linen shirt",
    blueprint: SHIRT,
    condition: { base: { wetness: level, cleanliness: GARMENT_UNIT_ONE, crease_load: 0, wear: 0 } },
  });
}

function muddyPlayerJeans(): GarmentInstanceState {
  return garmentInstance({
    id: "g_jeans",
    name: "dark jeans",
    blueprint: JEANS,
    locus: { kind: "worn", actorId: GARMENT_PLAYER_ACTOR },
    condition: {
      deposits: [
        {
          id: "deposit_mud",
          kind: "mud",
          partIds: ["cuff_left"],
          intensity: 7_500,
          extent: 4_000,
          freshness: 0,
          atMinutes: 0,
        },
      ],
    },
  });
}

export interface GarmentNarratorFixtureTurn {
  id: string;
  player: string;
  atMinutes: number;
  store: ChatGarmentStore;
  /** Plain pre-graph outfit line both arms receive. */
  legacyOutfit: string;
  /** Ground truth shown only to the arm-blind judge. */
  facts: readonly string[];
  expectedDigest: readonly string[];
  expectedCues: readonly string[];
}

export interface GarmentNarratorFixture {
  id: string;
  title: string;
  premise: string;
  place: string;
  placeDetail: string;
  turns: readonly GarmentNarratorFixtureTurn[];
}

export const GARMENT_NARRATOR_FIXTURES: readonly GarmentNarratorFixture[] = [
  {
    id: "rolled-sleeve-repeat",
    title: "A newly rolled sleeve, then no change",
    premise: "Wren and Sam are packing old books in the study before a train.",
    place: "the study",
    placeDetail: "Half-filled boxes crowd the desk and the station clock is visible through the window.",
    turns: [
      {
        id: "roll-change",
        player: "You look like you're planning to carry every box yourself.",
        atMinutes: 14 * 60,
        store: garmentStore([rolledShirt()]),
        legacyOutfit: "Wren is wearing a linen shirt.",
        facts: [
          "The left sleeve of Wren's linen shirt is substantially rolled back.",
          "The right sleeve is not rolled.",
        ],
        expectedDigest: ["Wren: linen shirt", "left sleeve rolled"],
        expectedCues: ["Wren's linen shirt is rolled back at the left sleeve"],
      },
      {
        id: "roll-standing",
        player: "I can take the smaller stack. We still have time.",
        atMinutes: 14 * 60 + 5,
        store: garmentStore([rolledShirt()]),
        legacyOutfit: "Wren is wearing a linen shirt.",
        facts: [
          "The left sleeve remains substantially rolled back.",
          "Nothing about the shirt changed since the previous exchange.",
        ],
        expectedDigest: ["Wren: linen shirt", "left sleeve rolled"],
        expectedCues: [],
      },
    ],
  },
  {
    id: "wetness-false-premise",
    title: "Wet linen against a false dry premise",
    premise: "A burst pipe has just been shut off in the apartment kitchen.",
    place: "the kitchen",
    placeDetail: "Water beads on the counter while the pipe ticks behind the wall.",
    turns: [
      {
        id: "soaked",
        player: "At least your shirt stayed completely dry.",
        atMinutes: 19 * 60,
        store: garmentStore([wetShirt(GARMENT_UNIT_ONE)]),
        legacyOutfit: "Wren is wearing a linen shirt.",
        facts: [
          "Wren's linen shirt is soaked through.",
          "The player's claim that the shirt stayed dry is false.",
          "The wetness came from the burst pipe, not rain.",
        ],
        expectedDigest: ["Wren: linen shirt", "soaked"],
        expectedCues: ["Wren's linen shirt is wet through"],
      },
      {
        id: "damp-later",
        player: "The towels are in the hall closet if you want one.",
        atMinutes: 19 * 60 + 25,
        store: garmentStore([wetShirt(2_500)]),
        legacyOutfit: "Wren is wearing a linen shirt.",
        facts: ["The linen shirt is now damp, not soaked and not dry."],
        expectedDigest: ["Wren: linen shirt", "damp"],
        expectedCues: ["Wren's linen shirt is damp"],
      },
    ],
  },
  {
    id: "player-muddy-cuff",
    title: "A player garment with one visible local mark",
    premise: "Wren and Sam have come inside after carrying planters through the yard.",
    place: "the mudroom",
    placeDetail: "A rubber mat and a row of hooks sit beside the back door.",
    turns: [
      {
        id: "mud-change",
        player: "I think I escaped the worst of the mud.",
        atMinutes: 10 * 60,
        store: garmentStore([plainShirt(), muddyPlayerJeans()]),
        legacyOutfit: "Wren is wearing a linen shirt; Sam is wearing dark jeans.",
        facts: [
          "Dried mud is visible on the left cuff of Sam's dark jeans.",
          "The mud is not on the right cuff and not on Wren's shirt.",
        ],
        expectedDigest: ["Sam: dark jeans", "mud on the left cuff"],
        expectedCues: ["mud has dried into the left cuff of your dark jeans"],
      },
      {
        id: "mud-standing",
        player: "I'll brush them off once we finish moving the last pot.",
        atMinutes: 10 * 60 + 3,
        store: garmentStore([plainShirt(), muddyPlayerJeans()]),
        legacyOutfit: "Wren is wearing a linen shirt; Sam is wearing dark jeans.",
        facts: ["The same dried mud remains on the left cuff; no new garment change occurred."],
        expectedDigest: ["Sam: dark jeans", "mud on the left cuff"],
        expectedCues: [],
      },
    ],
  },
  {
    id: "digest-only-control",
    title: "Stable ordinary clothing",
    premise: "Wren and Sam are reading quietly in the study.",
    place: "the study",
    placeDetail: "Late sunlight lies across the rug and nothing has disturbed the room.",
    turns: [
      {
        id: "plain-one",
        player: "This chapter is stranger than I remembered.",
        atMinutes: 16 * 60,
        store: garmentStore([plainShirt()]),
        legacyOutfit: "Wren is wearing a linen shirt.",
        facts: ["Wren's linen shirt is ordinary, dry, clean and unchanged."],
        expectedDigest: ["Wren: linen shirt"],
        expectedCues: [],
      },
      {
        id: "plain-two",
        player: "Read the next paragraph aloud.",
        atMinutes: 16 * 60 + 2,
        store: garmentStore([plainShirt()]),
        legacyOutfit: "Wren is wearing a linen shirt.",
        facts: ["The clothing remains unchanged and should not be announced as a new detail."],
        expectedDigest: ["Wren: linen shirt"],
        expectedCues: [],
      },
    ],
  },
] as const;

/**
 * Partial proposal matcher for the extraction sub-trial. Degree/anchor fields
 * can be intentionally omitted when the fixture is judging handle and operation
 * selection rather than pretending a fuzzy phrase has one exact numeric band.
 */
export interface GarmentExtractionExpectation {
  op: GarmentOperationProposal["op"];
  garment?: string;
  part?: string;
  parts?: readonly string[];
  to?: string;
  state?: string;
  substance?: string;
}

export interface GarmentExtractionFixture {
  id: string;
  store: ChatGarmentStore;
  place: string;
  exchange: { player: string; assistant: string };
  expected: readonly GarmentExtractionExpectation[];
}

export const GARMENT_EXTRACTION_FIXTURES: readonly GarmentExtractionFixture[] = [
  {
    id: "extract-roll-left-sleeve",
    store: garmentStore([plainShirt()]),
    place: "the study",
    exchange: {
      player: "Those boxes are dusty.",
      assistant: "Wren pushes the left sleeve of her linen shirt well past her forearm before lifting the next box.",
    },
    expected: [{ op: "roll", garment: "wren.shirt", part: "wren.shirt.sleeve_left" }],
  },
  {
    id: "extract-player-mud-deposit",
    store: garmentStore([plainShirt(), garmentInstance({
      id: "g_jeans",
      name: "dark jeans",
      blueprint: JEANS,
      locus: { kind: "worn", actorId: GARMENT_PLAYER_ACTOR },
    })]),
    place: "the mudroom",
    exchange: {
      player: "I catch the left cuff of my jeans against the muddy planter.",
      assistant: "A dark smear of mud spreads across the left cuff as Sam sets the planter down.",
    },
    expected: [{ op: "deposit", garment: "you.jeans", parts: ["you.jeans.cuff_left"], substance: "mud" }],
  },
  {
    id: "extract-leave-shirt-here",
    store: garmentStore([plainShirt()]),
    place: "the bedroom",
    exchange: {
      player: "You can leave it on the chair.",
      assistant: "Wren slips out of the linen shirt and leaves it over the bedroom chair.",
    },
    expected: [{ op: "move", garment: "wren.shirt", to: "left_here" }],
  },
] as const;
