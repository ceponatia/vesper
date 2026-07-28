import { describe, expect, it } from "vitest";
import {
  applyGarmentOperations,
  emptyCharacterProfile,
  emptyChatPlayerState,
  emptyGarmentPresentationState,
  exposedRegions,
  FULLY_COVERED,
  garmentActorForCharacter,
  garmentBlueprintForSeed,
  garmentBlueprintHash,
  emptyChatGarmentStore,
  personaProfileSchema,
  pristineGarmentConditionState,
  resolveGarmentVisibility,
  syncWornGarments,
  type ChatGarmentStore,
  type GarmentBlueprint,
  type GarmentInstanceState,
  type GarmentSeed,
} from "@/contracts";
import { toWornInputs, wardrobeOutfitText, type AvatarWardrobeItem } from "../images";
import { garmentWardrobeItem, playerWornIds, resolveChatWardrobe, resolvePlayerWardrobe } from "./chat-wardrobe";

/**
 * The seeded/unseeded rule (persona-library.plan.md slice 8). The pure half of the
 * player's wardrobe: `resolvePlayerWardrobe` needs a database, but the decision that
 * actually matters — *what is the player wearing right now* — is this function, and it
 * is shared by the read path and the archivist's fold so the two can't disagree.
 */
describe("playerWornIds", () => {
  const persona = personaProfileSchema.parse({
    outfits: [
      { id: "everyday", name: "Everyday", items: ["shirt", "jeans"] },
      { id: "formal", name: "Formal", items: ["suit"] },
    ],
  });
  const state = (over: Partial<ReturnType<typeof emptyChatPlayerState>> = {}) => ({
    ...emptyChatPlayerState(),
    ...over,
  });

  it("wears the persona's default preset before anything has changed the wardrobe", () => {
    // The whole point of `seeded`: an unseeded chat must not read as naked.
    expect(playerWornIds(state(), persona)).toEqual(["shirt", "jeans"]);
  });

  it("honours a named preset while still unseeded", () => {
    expect(playerWornIds(state({ outfitPresetId: "formal" }), persona)).toEqual(["suit"]);
  });

  it("an unknown preset id falls back to the default preset, never to naked", () => {
    expect(playerWornIds(state({ outfitPresetId: "no-such-preset" }), persona)).toEqual(["shirt", "jeans"]);
  });

  it("once seeded, the stored list is the truth", () => {
    expect(playerWornIds(state({ seeded: true, wornItemIds: ["jeans"] }), persona)).toEqual(["jeans"]);
  });

  // The distinction the flag exists for: the same empty list, two opposite meanings.
  it("distinguishes not-dressed-yet from stripped", () => {
    expect(playerWornIds(state({ seeded: false, wornItemIds: [] }), persona)).toEqual(["shirt", "jeans"]);
    expect(playerWornIds(state({ seeded: true, wornItemIds: [] }), persona)).toEqual([]);
  });

  it("is empty with no persona — nobody to dress", () => {
    expect(playerWornIds(state(), undefined)).toEqual([]);
    expect(playerWornIds(state({ seeded: true, wornItemIds: ["shirt"] }), undefined)).toEqual(["shirt"]);
  });

  it("is empty when the persona has no wardrobe authored (unknown, and the caller reads it as covered)", () => {
    expect(playerWornIds(state(), personaProfileSchema.parse({}))).toEqual([]);
  });

  it("does not alias the persona's preset array (a later equip must not mutate the persona)", () => {
    const ids = playerWornIds(state(), persona);
    ids.push("hat");
    expect(persona.outfits[0]?.items).toEqual(["shirt", "jeans"]);
  });
});

/**
 * `outfit_exposed` demotion (clothing-state-graph slice 2; slice-0 audit finding 6).
 *
 * The flag was an author/model-settable coverage BYPASS: with an empty worn list
 * it alone decided whether the character read as bare. Once the garment store
 * models an actor, coverage decides — including the case the flag could never
 * express, "modelled and wearing nothing".
 *
 * These exercise the EMPTY-worn-list branch only, which takes no IO (the item
 * load is skipped and `healOutfitMarker("")` returns immediately), so they stay
 * pure. The dressed branch is covered by the integration test.
 */
describe("outfit_exposed is no longer authoritative once an actor is modelled", () => {
  const ACTOR = garmentActorForCharacter("alice");
  const profile = emptyCharacterProfile();
  const seeds = new Map<string, GarmentSeed>([
    ["shirt", { definitionId: "shirt", name: "shirt", categoryId: "top", coverage: ["chest"] }],
  ]);
  let ids = 0;
  const modelledStore = (worn: readonly string[]): ChatGarmentStore =>
    syncWornGarments({
      store: syncWornGarments({
        store: emptyChatGarmentStore(),
        actorId: ACTOR,
        wornDefinitionIds: ["shirt"],
        seeds,
        mintId: () => `g${++ids}`,
        atMinutes: 0,
      }),
      actorId: ACTOR,
      wornDefinitionIds: worn,
      seeds,
      mintId: () => `g${++ids}`,
      atMinutes: 1,
    });

  it("keeps the legacy flag for an UNMODELLED actor (a legacy chat is unknown, not naked)", async () => {
    const covered = await resolveChatWardrobe({ wornItemIds: [], outfit: "", outfitExposed: false }, "owner", profile);
    expect(covered.exposure).toEqual(FULLY_COVERED);
    expect(covered.exposed).toBe(false);
    const bare = await resolveChatWardrobe({ wornItemIds: [], outfit: "", outfitExposed: true }, "owner", profile);
    expect(bare.exposed).toBe(true);
  });

  it("a MODELLED actor wearing nothing reads as stripped, whatever the flag says", async () => {
    const resolved = await resolveChatWardrobe(
      { wornItemIds: [], outfit: "", outfitExposed: false, garments: modelledStore([]), garmentActorId: ACTOR },
      "owner",
      profile,
    );
    expect(resolved.exposed).toBe(true);
    expect(resolved.exposure).not.toEqual(FULLY_COVERED);
  });

  it("still reads conservatively while non-mechanical overlay prose stands in for the look", async () => {
    // Nothing modelled is worn, but the fiction put them in something the
    // wardrobe does not own — guessing "bare" there would be spectacularly wrong.
    const resolved = await resolveChatWardrobe(
      {
        wornItemIds: [],
        outfit: "a borrowed hoodie",
        outfitExposed: false,
        garments: modelledStore([]),
        garmentActorId: ACTOR,
      },
      "owner",
      profile,
    );
    expect(resolved.exposed).toBe(false);
    expect(resolved.exposure).toEqual(FULLY_COVERED);
  });

  it("a seeded store with no instances for THIS actor leaves them unmodelled", async () => {
    // The store-wide `seeded` flag is not per-actor: a roster member the
    // migration never touched must keep the legacy read.
    const elsewhere = modelledStore(["shirt"]);
    const resolved = await resolveChatWardrobe(
      {
        wornItemIds: [],
        outfit: "",
        outfitExposed: false,
        garments: elsewhere,
        garmentActorId: garmentActorForCharacter("never-seen"),
      },
      "owner",
      profile,
    );
    expect(resolved.exposed).toBe(false);
    expect(resolved.exposure).toEqual(FULLY_COVERED);
  });

  it("the player's modelled-but-empty wardrobe reads as stripped too", async () => {
    const store = syncWornGarments({
      store: syncWornGarments({
        store: emptyChatGarmentStore(),
        actorId: "player",
        wornDefinitionIds: ["shirt"],
        seeds,
        mintId: () => `p${++ids}`,
        atMinutes: 0,
      }),
      actorId: "player",
      wornDefinitionIds: [],
      seeds,
      mintId: () => `p${++ids}`,
      atMinutes: 1,
    });
    const resolved = await resolvePlayerWardrobe(emptyChatPlayerState(), "owner", undefined, undefined, store);
    expect(resolved.wornItemIds).toEqual([]);
    expect(resolved.exposure).not.toEqual(FULLY_COVERED);
  });
});

/**
 * ONE shared read (clothing-state-graph.plan.md slice 3 · §"Derived wardrobe and
 * observation read"; slice-0 audit finding 3).
 *
 * The garment store owns presentation-aware per-part coverage; the library
 * definition owns phrasing and the layer/opacity occlusion semantics. Everything
 * downstream — the narrator's garment phrase, the exposure gate, and the image
 * prompt — then resolves from the SAME `toWornInputs` rows, so no surface can say
 * "bare" while another says "covered".
 *
 * Pure: `garmentWardrobeItem` and the renderers take no IO. The database half of
 * this seam is the integration test.
 */
describe("the presentation-aware wardrobe read", () => {
  const definition = (id: string, name: string, coverage: readonly string[], layer: 0 | 1 | 2 | 3): AvatarWardrobeItem => ({
    id,
    name,
    coverage,
    layer,
    opacity: "opaque",
  });

  const SHIRT_DEF = definition("def_shirt", "linen shirt", ["shoulders", "chest", "back", "waist", "upper_arms", "forearms", "wrists"], 3);
  const TEE_DEF = definition("def_tee", "white tee", ["shoulders", "chest", "back", "waist", "upper_arms"], 1);

  const blueprintFor = (item: AvatarWardrobeItem, categoryId: string): GarmentBlueprint =>
    garmentBlueprintForSeed({
      definitionId: item.id ?? "",
      name: item.name,
      categoryId,
      coverage: item.coverage,
      materialProfileId: "woven_cotton_linen",
    });

  const SHIRT_BLUEPRINT = blueprintFor(SHIRT_DEF, "outerwear");
  const TEE_BLUEPRINT = blueprintFor(TEE_DEF, "top");

  const instance = (id: string, blueprint: GarmentBlueprint, definitionId: string): GarmentInstanceState => ({
    id,
    blueprintHash: garmentBlueprintHash(blueprint),
    definitionId,
    name: definitionId,
    locus: { kind: "worn", actorId: "c:alice" },
    presentation: emptyGarmentPresentationState(),
    condition: pristineGarmentConditionState(),
    lastChange: { kind: "mint", atMinutes: 0 },
  });

  /** The store the chat holds: the shirt over the tee, both worn. */
  function dressed(): ChatGarmentStore {
    return {
      seeded: true,
      blueprints: {
        [garmentBlueprintHash(SHIRT_BLUEPRINT)]: SHIRT_BLUEPRINT,
        [garmentBlueprintHash(TEE_BLUEPRINT)]: TEE_BLUEPRINT,
      },
      instances: [instance("g_shirt", SHIRT_BLUEPRINT, "def_shirt"), instance("g_tee", TEE_BLUEPRINT, "def_tee")],
    };
  }

  /** What the read seam builds: one wardrobe item per worn instance. */
  function itemsOf(store: ChatGarmentStore): AvatarWardrobeItem[] {
    const byDefinition = new Map([
      ["def_shirt", SHIRT_DEF],
      ["def_tee", TEE_DEF],
    ]);
    const blueprints: Record<string, GarmentBlueprint> = store.blueprints;
    return store.instances.map((worn) =>
      garmentWardrobeItem(
        worn,
        blueprints[worn.blueprintHash] ?? SHIRT_BLUEPRINT,
        byDefinition.get(worn.definitionId ?? ""),
      ),
    );
  }

  const open = (store: ChatGarmentStore, indexes: readonly number[]) =>
    applyGarmentOperations(
      store,
      [
        {
          kind: "set_closure",
          garmentId: "g_shirt",
          partId: "front_panel",
          state: { kind: "fastener_series", openFastenerIndexes: [...indexes] },
        },
      ],
      { atMinutes: 5 },
    ).store;

  it("keys the resolver on real instance ids and part ids — never on a position", () => {
    const inputs = toWornInputs(itemsOf(dressed()));
    expect(inputs.every((row) => row.garmentId === "g_shirt" || row.garmentId === "g_tee")).toBe(true);
    expect(inputs.some((row) => row.instanceId === "g_shirt:front_panel")).toBe(true);
    // One garment, several rows — the thing the old index-as-id scheme could not do.
    expect(inputs.filter((row) => row.garmentId === "g_shirt").length).toBeGreaterThan(1);
  });

  it("a closed shirt hides the tee, and the torso reads covered", () => {
    const items = itemsOf(dressed());
    const phrase = wardrobeOutfitText(items);
    expect(phrase).toContain("linen shirt");
    expect(phrase).not.toContain("white tee");
    expect(exposedRegions(toWornInputs(items)).torso).toBe("covered");
  });

  it("an OPEN shirt over a tee exposes the TEE, not skin", () => {
    // Four of the outerwear template's five fasteners is 0.8 — past both closure
    // thresholds, so the shirt's own front panel stops covering chest and waist.
    const items = itemsOf(open(dressed(), [0, 1, 2, 3]));
    const shirt = items.find((item) => item.garmentId === "g_shirt");
    expect(shirt?.coverage).not.toContain("chest");
    // The tee is now the outermost cover at the chest, so it becomes sayable…
    const rolled = resolveGarmentVisibility(toWornInputs(items));
    expect(rolled.get("g_tee")).toBe("visible");
    expect(wardrobeOutfitText(items)).toContain("white tee");
    // …and BOTH surfaces agree the torso is still covered — one shared read.
    expect(exposedRegions(toWornInputs(items)).torso).toBe("covered");
  });

  it("an open shirt with nothing under it does bare the torso", () => {
    const store = open(dressed(), [0, 1, 2, 3]);
    const shirtOnly = { ...store, instances: store.instances.filter((worn) => worn.id === "g_shirt") };
    const items = itemsOf(shirtOnly);
    expect(exposedRegions(toWornInputs(items)).torso).toBe("bare");
    // The shirt is still worn and still sayable — an open placket is not a doff.
    expect(wardrobeOutfitText(items)).toContain("linen shirt");
    expect(items[0]?.coverage).toContain("back");
  });

  it("two open buttons change nothing — the tee stays hidden", () => {
    const items = itemsOf(open(dressed(), [0, 1]));
    expect(items.find((item) => item.garmentId === "g_shirt")?.coverage).toContain("chest");
    expect(wardrobeOutfitText(items)).not.toContain("white tee");
    expect(exposedRegions(toWornInputs(items)).torso).toBe("covered");
  });

  it("carries the worn definition id through, so the look key still resolves", () => {
    expect(itemsOf(dressed()).map((item) => item.id)).toEqual(["def_shirt", "def_tee"]);
  });
});
