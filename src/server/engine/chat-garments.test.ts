import { describe, expect, it } from "vitest";
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
  type GarmentPresentationState,
} from "@/contracts";
import {
  buildChatGarmentNarration,
  chatGarmentLookChanged,
  chatGarmentLookKey,
  chatGarmentNarrationActors,
  garmentReadoutsFor,
} from "./chat-garments";

/**
 * The slice-6 assembly (clothing-state-graph.plan.md): the store in, a digest +
 * ≤2 repeat-gated cues + per-scene notes out, and OQ8's pre/post key comparison.
 *
 * Pure — every read integrates lazily and nothing is written back, so building a
 * prompt can never dry a garment. The database half (rollback, the enqueue) is
 * `chat-garment-cues.int.test.ts`.
 */

const CHARACTER_ID = "char_wren";
const ACTOR = garmentActorForCharacter(CHARACTER_ID);

const SHIRT = garmentBlueprintForSeed({
  definitionId: "def_shirt",
  name: "linen shirt",
  categoryId: "top",
  coverage: ["shoulders", "chest", "back", "waist", "upper_arms"],
  materialProfileId: "woven_cotton_linen",
});
const JEANS = garmentBlueprintForSeed({
  definitionId: "def_jeans",
  name: "dark jeans",
  categoryId: "pants",
  coverage: ["pelvis", "thighs", "calves", "ankles"],
  materialProfileId: "denim",
});

function instance(input: {
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
    locus: input.locus ?? { kind: "worn", actorId: ACTOR },
    presentation: { ...emptyGarmentPresentationState(), ...input.presentation },
    condition: { ...pristineGarmentConditionState(), ...input.condition },
    lastChange: { kind: "mint", atMinutes: 0 },
  };
}

function storeOf(instances: readonly GarmentInstanceState[], cues?: ChatGarmentStore["cues"]): ChatGarmentStore {
  return {
    ...emptyChatGarmentStore(),
    seeded: true,
    blueprints: {
      [garmentBlueprintHash(SHIRT)]: SHIRT,
      [garmentBlueprintHash(JEANS)]: JEANS,
    },
    instances: [...instances],
    ...(cues ? { cues } : {}),
  };
}

const actors = () => chatGarmentNarrationActors({ characterId: CHARACTER_ID, characterName: "Wren", playerName: "Sam" });

describe("buildChatGarmentNarration", () => {
  it("renders the digest, the located garment, and no cue for a wardrobe that has not moved", () => {
    const store = storeOf([
      instance({ id: "g_shirt", name: "linen shirt", blueprint: SHIRT }),
      instance({
        id: "g_jacket",
        name: "denim jacket",
        blueprint: SHIRT,
        locus: { kind: "scene", placeName: "the study", anchor: "over the desk chair" },
      }),
    ]);
    const narration = buildChatGarmentNarration({ store, actors: actors(), atMinutes: 40, placeName: "the study" });
    expect(narration.digest).toContain("- Wren: linen shirt: untucked");
    expect(narration.digest).toContain("- Left in the study: denim jacket — over the desk chair");
    // Nothing but the resting tuck, which is authority and never attention.
    expect(narration.cues).toEqual([]);
  });

  it("surfaces a change once, then never again while it stands", () => {
    const rolled = storeOf([
      instance({
        id: "g_shirt",
        name: "linen shirt",
        blueprint: SHIRT,
        presentation: { roll: { sleeve_left: GARMENT_DEGREE_BAND_VALUES.substantial } },
      }),
    ]);
    const first = buildChatGarmentNarration({ store: rolled, actors: actors(), atMinutes: 10 });
    expect(first.cues).toEqual(["Wren's linen shirt is rolled back at the left sleeve"]);

    const second = buildChatGarmentNarration({
      store: { ...rolled, cues: first.nextCues },
      actors: actors(),
      atMinutes: 20,
    });
    expect(second.cues).toEqual([]);
    // …and the digest still guards it, so the narrator cannot un-roll the sleeve.
    expect(second.digest).toContain("left sleeve rolled");
  });

  it("speaks about the player in the second person, from the same block", () => {
    const store = storeOf([
      instance({
        id: "g_jeans",
        name: "dark jeans",
        blueprint: JEANS,
        locus: { kind: "worn", actorId: GARMENT_PLAYER_ACTOR },
        condition: {
          deposits: [
            { id: "d1", kind: "mud", partIds: ["cuff_left"], intensity: 7_500, extent: 4_000, freshness: 0, atMinutes: 0 },
          ],
        },
      }),
    ]);
    const narration = buildChatGarmentNarration({ store, actors: actors(), atMinutes: 5 });
    expect(narration.digest).toContain("- Sam: dark jeans: mud on the left cuff");
    expect(narration.cues).toEqual(["mud has dried into the left cuff of your dark jeans"]);
  });

  it("threads the reported bands back into the readout, so a boundary value does not oscillate", () => {
    // 4_600 reads `wet`; 4_200 is below the floor but inside the hysteresis band.
    const wet = storeOf([
      instance({
        id: "g_shirt",
        name: "linen shirt",
        blueprint: SHIRT,
        condition: { base: { wetness: 4_600, cleanliness: GARMENT_UNIT_ONE, crease_load: 0, wear: 0 } },
      }),
    ]);
    const first = buildChatGarmentNarration({ store: wet, actors: actors(), atMinutes: 0 });
    expect(first.nextCues.bands.g_shirt?.wetness).toBe("wet");

    const settling = storeOf(
      [
        instance({
          id: "g_shirt",
          name: "linen shirt",
          blueprint: SHIRT,
          condition: { base: { wetness: 4_200, cleanliness: GARMENT_UNIT_ONE, crease_load: 0, wear: 0 } },
        }),
      ],
      first.nextCues,
    );
    expect(garmentReadoutsFor(settling, ACTOR, 0, settling.cues)[0]?.condition.wetness).toBe("wet");
    // Without the memory the same value would read `damp` — the drift the cue map prevents.
    expect(garmentReadoutsFor(settling, ACTOR, 0)[0]?.condition.wetness).toBe("damp");
    // …and therefore no fresh cue fires: the first exchange already said "wet",
    // and the settling read still says "wet".
    expect(first.cues).toEqual(["Wren's linen shirt is wet through"]);
    expect(buildChatGarmentNarration({ store: settling, actors: actors(), atMinutes: 0 }).cues).toEqual([]);
  });

  it("hands the scene-image prompt the same reads, un-gated by repetition", () => {
    const store = storeOf([
      instance({
        id: "g_shirt",
        name: "linen shirt",
        blueprint: SHIRT,
        condition: { base: { wetness: GARMENT_UNIT_ONE, cleanliness: GARMENT_UNIT_ONE, crease_load: 0, wear: 0 } },
      }),
    ]);
    const first = buildChatGarmentNarration({ store, actors: actors(), atMinutes: 0 });
    const second = buildChatGarmentNarration({ store: { ...store, cues: first.nextCues }, actors: actors(), atMinutes: 30 });
    expect(second.cues).toEqual([]);
    expect(second.sceneNotes).toEqual(["Wren's linen shirt is soaked through"]);
  });
});

describe("OQ8 — the enqueue trigger is a key comparison", () => {
  const dressed = () => storeOf([instance({ id: "g_shirt", name: "linen shirt", blueprint: SHIRT })]);
  const actorIds = [ACTOR, GARMENT_PLAYER_ACTOR];

  it("fires for a structural change", () => {
    const before = dressed();
    const after = storeOf([
      instance({
        id: "g_shirt",
        name: "linen shirt",
        blueprint: SHIRT,
        presentation: { closure: { front_panel: { kind: "fastener_series", openFastenerIndexes: [0, 1, 2, 3] } } },
      }),
    ]);
    expect(chatGarmentLookChanged({ before, after, actorIds })).toBe(true);
  });

  it("fires for a doff — the garment left the worn set", () => {
    const after = storeOf([
      instance({ id: "g_shirt", name: "linen shirt", blueprint: SHIRT, locus: { kind: "wardrobe", ownerId: ACTOR } }),
    ]);
    expect(chatGarmentLookChanged({ before: dressed(), after, actorIds })).toBe(true);
  });

  it("does NOT fire for a damp → dry drift", () => {
    const before = storeOf([
      instance({
        id: "g_shirt",
        name: "linen shirt",
        blueprint: SHIRT,
        condition: { base: { wetness: 2_000, cleanliness: GARMENT_UNIT_ONE, crease_load: 0, wear: 0 } },
      }),
    ]);
    expect(chatGarmentLookChanged({ before, after: dressed(), actorIds })).toBe(false);
  });

  it("does NOT fire for lazy materialization — an unmodelled actor has no look to change", () => {
    expect(
      chatGarmentLookChanged({ before: emptyChatGarmentStore(), after: dressed(), actorIds }),
    ).toBe(false);
    // And an unmodelled actor contributes no key at all, so legacy chats hash as before.
    expect(chatGarmentLookKey(emptyChatGarmentStore(), actorIds)).toBe("");
  });
});
