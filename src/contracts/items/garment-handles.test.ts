import { describe, expect, it } from "vitest";
import { clothingCategoryById } from "./clothing-categories";
import { garmentBlueprintHash } from "./garment-blueprint";
import { emptyChatGarmentStore, type ChatGarmentStore } from "./garment-instance";
import {
  applyGarmentTransfers,
  garmentActorForCharacter,
  garmentBlueprintForSeed,
  syncWornGarments,
  GARMENT_PLAYER_ACTOR,
  type GarmentSeed,
} from "./garment-store";
import {
  buildGarmentHandleTable,
  garmentHandleActor,
  garmentHandleEntry,
  GARMENT_HANDLE_MAX_PARTS,
} from "./garment-handles";

/**
 * Slice 5 — the continuity extractor's handle table
 * (clothing-state-graph.plan.md §"Models propose semantic operations, never raw
 * state"; slice-0 audit OQ7).
 *
 * The properties that make a handle usable by a model: deterministic, bounded,
 * collision-free inside one exchange, the ROOT always addressable, and no handle
 * for a part no operation could act on.
 */

const MARA = garmentActorForCharacter("mara");

function counterIds(prefix = "g"): () => string {
  let n = 0;
  return () => `${prefix}${++n}`;
}

function seed(definitionId: string, name: string, categoryId: string): GarmentSeed {
  return {
    definitionId,
    name,
    categoryId,
    coverage: clothingCategoryById(categoryId)?.coverage ?? [],
  };
}

/** A store with the given definitions worn by an actor, in order. */
function dressed(
  actorId: string,
  seeds: readonly GarmentSeed[],
  store: ChatGarmentStore = emptyChatGarmentStore(),
  mintId: () => string = counterIds(),
): ChatGarmentStore {
  return syncWornGarments({
    store,
    actorId,
    wornDefinitionIds: seeds.map((s) => s.definitionId),
    seeds: new Map(seeds.map((s) => [s.definitionId, s])),
    mintId,
    atMinutes: 0,
  });
}

const ACTORS = [
  { actorId: MARA, label: "Mara" },
  { actorId: GARMENT_PLAYER_ACTOR, label: "You", slug: "you" },
];

describe("buildGarmentHandleTable", () => {
  it("mints `<actor>.<head noun>` handles and lists the root plus the addressable parts", () => {
    const store = dressed(MARA, [seed("i1", "white cotton tee", "top")]);
    const table = buildGarmentHandleTable({ store, actors: ACTORS });

    expect(table.entries.map((e) => e.handle)).toEqual(["mara.tee"]);
    const entry = table.entries[0];
    expect(entry?.name).toBe("white cotton tee");
    expect(entry?.where).toBe("worn by Mara");
    // The root is ALWAYS enumerated (OQ7 — "the root is an explicitly enumerated handle").
    expect(entry?.partHandles[0]).toBe("root");
    // Coverage-bearing or behavior-bound parts earn a handle…
    expect(entry?.partHandles).toEqual(
      expect.arrayContaining(["front_panel", "back_panel", "sleeve_left", "sleeve_right", "hem"]),
    );
    // …and parts that can neither be manipulated nor change a read do not.
    expect(entry?.partHandles).not.toContain("collar");
    expect(entry?.partHandles).not.toContain("placket");
    expect(entry?.partHandles).not.toContain("cuff_left");
    // The RESOLUTION set is still the whole graph: a real part is never a hallucination.
    expect(entry?.partIds).toEqual(expect.arrayContaining(["collar", "placket", "cuff_left", "cuff_right"]));
  });

  it("is deterministic — the same store builds the same table twice", () => {
    const store = dressed(MARA, [seed("i1", "denim jacket", "outerwear"), seed("i2", "white tee", "top")]);
    const first = buildGarmentHandleTable({ store, actors: ACTORS });
    const second = buildGarmentHandleTable({ store, actors: ACTORS });
    expect(JSON.stringify(second)).toBe(JSON.stringify(first));
  });

  it("keeps handles collision-free across duplicate names and across actors", () => {
    const mint = counterIds();
    let store = dressed(MARA, [seed("i1", "black jacket", "outerwear"), seed("i2", "denim jacket", "outerwear")], emptyChatGarmentStore(), mint);
    store = dressed(GARMENT_PLAYER_ACTOR, [seed("i3", "old jacket", "outerwear")], store, mint);
    const table = buildGarmentHandleTable({ store, actors: ACTORS });

    const handles = table.entries.map((e) => e.handle);
    expect(new Set(handles).size).toBe(handles.length);
    // The head noun collides for Mara's two jackets, so the second takes `_2`;
    // the player's is namespaced by its actor and needs no suffix.
    expect(handles).toEqual(["mara.jacket", "mara.jacket_2", "you.jacket"]);
    expect(garmentHandleEntry(table, "mara.jacket_2")?.name).toBe("denim jacket");
  });

  it("only lists MODELLED actors — an unmodelled one takes no handles and no introduce", () => {
    const store = dressed(MARA, [seed("i1", "wool cardigan", "outerwear")]);
    const table = buildGarmentHandleTable({ store, actors: ACTORS });
    expect(table.actors.map((a) => a.handle)).toEqual(["mara"]);
    expect(garmentHandleActor(table, "mara")?.actorId).toBe(MARA);
    // The player owns nothing, so dressing them would flip them to modelled and
    // silently drop their persona's default preset — they are not offered.
    expect(garmentHandleActor(table, "you")).toBeUndefined();
  });

  it("includes held garments and scene garments AT THIS PLACE, and nothing left elsewhere", () => {
    const mint = counterIds();
    let store = dressed(MARA, [seed("i1", "denim jacket", "outerwear"), seed("i2", "silk scarf", "top")], emptyChatGarmentStore(), mint);
    const jacket = store.instances[0]?.id ?? "";
    const scarf = store.instances[1]?.id ?? "";
    store = applyGarmentTransfers(
      store,
      [
        { kind: "transfer", garmentId: jacket, to: { kind: "scene", placeName: "the study", anchor: "over the desk chair" } },
        { kind: "transfer", garmentId: scarf, to: { kind: "held", actorId: MARA } },
      ],
      { atMinutes: 10 },
    ).store;

    const here = buildGarmentHandleTable({ store, actors: ACTORS, placeName: "the study" });
    // A garment at a scene locus belongs to nobody, so it takes the `scene` prefix.
    expect(here.entries.map((e) => e.handle)).toEqual(["mara.scarf", "scene.jacket"]);
    expect(here.entries[1]?.where).toBe("left here, over the desk chair");

    // Moved on to the kitchen: the jacket is still in the study and out of scope.
    const elsewhere = buildGarmentHandleTable({ store, actors: ACTORS, placeName: "the kitchen" });
    expect(elsewhere.entries.map((e) => e.handle)).toEqual(["mara.scarf"]);
  });

  it("is bounded, and trims scene before held before worn", () => {
    let store = dressed(MARA, [
      seed("i1", "grey tee", "top"),
      seed("i2", "blue jeans", "pants"),
      seed("i3", "wool coat", "outerwear"),
    ]);
    const idOf = (definitionId: string): string =>
      store.instances.find((i) => i.definitionId === definitionId)?.id ?? "";
    // One held and one left in the room, on top of the one still worn.
    store = applyGarmentTransfers(
      store,
      [
        { kind: "transfer", garmentId: idOf("i1"), to: { kind: "held", actorId: MARA } },
        { kind: "transfer", garmentId: idOf("i3"), to: { kind: "scene", placeName: "the study", anchor: "" } },
      ],
      { atMinutes: 5 },
    ).store;

    const table = buildGarmentHandleTable({ store, actors: ACTORS, placeName: "the study", limit: 2 });
    expect(table.trimmed).toBe(true);
    // The worn jeans lead, then the held tee; the coat in the room is the one cut.
    expect(table.entries.map((e) => e.locusKind)).toEqual(["worn", "held"]);
    expect(table.entries.map((e) => e.handle)).toEqual(["mara.jeans", "mara.tee"]);
  });

  it("caps part handles per garment", () => {
    const store = dressed(MARA, [seed("i1", "linen dress", "dress")]);
    const table = buildGarmentHandleTable({ store, actors: ACTORS });
    const entry = table.entries[0];
    expect(entry?.partHandles.length).toBeLessThanOrEqual(GARMENT_HANDLE_MAX_PARTS);
    expect(entry?.partHandles[0]).toBe("root");
  });

  it("an unnamed garment still gets a usable handle, and two identical shirts share one blueprint", () => {
    const twin = seed("i1", "", "top");
    const store = dressed(MARA, [twin]);
    const table = buildGarmentHandleTable({ store, actors: ACTORS });
    // `syncWornGarments` captures the seed's name; an empty one degrades to "garment".
    expect(table.entries[0]?.handle).toMatch(/^mara\.[a-z0-9_]+$/u);
    expect(Object.keys(store.blueprints)).toEqual([garmentBlueprintHash(garmentBlueprintForSeed(twin))]);
  });

  it("an empty store makes an empty table — the extraction field never arms", () => {
    const table = buildGarmentHandleTable({ store: emptyChatGarmentStore(), actors: ACTORS });
    expect(table.entries).toEqual([]);
    expect(table.actors).toEqual([]);
    expect(table.trimmed).toBe(false);
  });
});
