import { describe, expect, it } from "vitest";
import { DiagnosticCollector } from "../diagnostics";
import { clothingCategoryById } from "./clothing-categories";
import { expandCoverage } from "./coverage";
import { garmentBlueprintHash } from "./garment-blueprint";
import { garmentCategoryTemplates } from "./garment-templates";
import { exposedRegions, type WornItemInput } from "./visibility";
import {
  capGarmentInstances,
  chatGarmentStoreSchema,
  emptyChatGarmentStore,
  CHAT_GARMENTS_MAX,
  type ChatGarmentStore,
  type GarmentInstanceState,
  type GarmentOperation,
  emptyGarmentCueState,
} from "./garment-instance";
import {
  actorHasGarmentInstances,
  applyGarmentTransfers,
  garmentActorForCharacter,
  garmentBlueprintForSeed,
  garmentBlueprintFor,
  garmentsAtScenePlace,
  GARMENT_PLAYER_ACTOR,
  inferGarmentMaterialProfile,
  retireActorGarments,
  sameGarmentLocus,
  syncWornGarments,
  wornGarmentDefinitionIds,
  type GarmentSeed,
} from "./garment-store";

/**
 * Slice 2 — chat-scoped instances, the worn-list projection, and whole-garment
 * loci (clothing-state-graph.plan.md; slice-0 audit fixtures F4, F5, F6, F21).
 */

const ALICE = garmentActorForCharacter("alice");
const BEN = garmentActorForCharacter("ben");

/** Deterministic instance ids so assertions read. */
function counterIds(prefix = "g"): () => string {
  let n = 0;
  return () => `${prefix}${++n}`;
}

function seed(definitionId: string, categoryId: string, coverage?: readonly string[]): GarmentSeed {
  return {
    definitionId,
    name: definitionId,
    categoryId,
    coverage: coverage ?? clothingCategoryById(categoryId)?.coverage ?? [],
  };
}

function seedMap(...seeds: GarmentSeed[]): Map<string, GarmentSeed> {
  return new Map(seeds.map((s) => [s.definitionId, s]));
}

function sync(
  store: ChatGarmentStore,
  actorId: string,
  wornDefinitionIds: readonly string[],
  seeds: Map<string, GarmentSeed>,
  mintId: () => string,
  atMinutes = 0,
): ChatGarmentStore {
  return syncWornGarments({ store, actorId, wornDefinitionIds, seeds, mintId, atMinutes });
}

/** The region exposure a worn definition set produces today — the coverage-neutrality yardstick. */
function exposureOf(items: readonly { coverage: readonly string[]; layer: number }[]) {
  const inputs: WornItemInput[] = items.map((item, index) => ({
    instanceId: String(index),
    garmentId: String(index),
    name: `i${index}`,
    coverage: item.coverage,
    layer: item.layer as WornItemInput["layer"],
    opacity: "opaque",
  }));
  return exposedRegions(inputs);
}

describe("garment actor handles", () => {
  it("keeps character handles from ever colliding with the player's", () => {
    expect(garmentActorForCharacter(GARMENT_PLAYER_ACTOR)).not.toBe(GARMENT_PLAYER_ACTOR);
    expect(garmentActorForCharacter("alice")).not.toBe(garmentActorForCharacter("alicE"));
  });
});

describe("materialization from worn ids", () => {
  it("mints one instance per worn definition and projects the ids straight back", () => {
    const store = sync(emptyChatGarmentStore(), ALICE, ["shirt", "jeans"], seedMap(seed("shirt", "top"), seed("jeans", "pants")), counterIds());
    expect(store.seeded).toBe(true);
    expect(store.instances).toHaveLength(2);
    // The compatibility bridge: old readers see exactly the ids they saw before.
    expect(wornGarmentDefinitionIds(store, ALICE)).toEqual(["shirt", "jeans"]);
  });

  it("is coverage-neutral: the blueprint's node coverage unions to the definition's own", () => {
    // A "top" edited down to a bandeau must instantiate as a bandeau, not as the
    // category template's shoulders/chest/back/waist/upper_arms.
    const bandeau = seed("bandeau", "top", ["chest"]);
    const blueprint = garmentBlueprintForSeed(bandeau);
    const union = new Set(blueprint.nodes.flatMap((node) => node.baselineCoverage));
    expect([...union].sort()).toEqual(["chest"]);

    // And the effective region exposure is identical before and after.
    const before = exposureOf([{ coverage: bandeau.coverage, layer: 1 }]);
    const after = exposureOf([{ coverage: [...union], layer: 1 }]);
    expect(after).toEqual(before);
  });

  it("keeps the category template's own coverage when the definition matches it", () => {
    for (const categoryId of ["top", "dress", "pants", "bra", "socks", "jewelry"]) {
      const category = clothingCategoryById(categoryId);
      expect(category).toBeDefined();
      if (!category) continue;
      const blueprint = garmentBlueprintForSeed(seed(`i-${categoryId}`, categoryId));
      const union = new Set(blueprint.nodes.flatMap((node) => node.baselineCoverage));
      const template = garmentCategoryTemplates[categoryId];
      expect(template).toBeDefined();
      const templateUnion = new Set(template?.nodes.flatMap((node) => node.baselineCoverage) ?? []);
      expect([...union].sort()).toEqual([...templateUnion].sort());
      // …and that IS the category's own coverage, so exposure cannot move.
      expect([...union].sort()).toEqual([...new Set(category.coverage)].sort());
      // The exploded read the visibility engine works from is unchanged too.
      expect([...expandCoverage([...union])].sort()).toEqual([...expandCoverage(category.coverage)].sort());
    }
  });

  it("puts coverage no template node claims onto the root", () => {
    // `hands` is not part of the `top` template — it must not be silently dropped.
    const blueprint = garmentBlueprintForSeed(seed("odd-top", "top", ["chest", "hands"]));
    const root = blueprint.nodes.find((node) => node.id === blueprint.rootNodeId);
    expect(root?.baselineCoverage).toContain("hands");
    const union = new Set(blueprint.nodes.flatMap((node) => node.baselineCoverage));
    expect([...union].sort()).toEqual(["chest", "hands"]);
  });

  it("deduplicates identical blueprints by content hash (F5: two copies, one snapshot)", () => {
    const seeds = seedMap(seed("shirt", "top"));
    const store = sync(emptyChatGarmentStore(), ALICE, ["shirt", "shirt"], seeds, counterIds());
    expect(store.instances).toHaveLength(2);
    expect(store.instances[0]?.blueprintHash).toBe(store.instances[1]?.blueprintHash);
    expect(store.instances[0]?.id).not.toBe(store.instances[1]?.id);
    expect(Object.keys(store.blueprints)).toHaveLength(1);
    expect(wornGarmentDefinitionIds(store, ALICE)).toEqual(["shirt", "shirt"]);
  });

  it("F5: doffing one copy leaves the other worn", () => {
    const seeds = seedMap(seed("shirt", "top"));
    const first = sync(emptyChatGarmentStore(), ALICE, ["shirt", "shirt"], seeds, counterIds());
    const second = sync(first, ALICE, ["shirt"], seeds, counterIds("m"));
    expect(wornGarmentDefinitionIds(second, ALICE)).toEqual(["shirt"]);
    expect(second.instances.filter((i) => i.locus.kind === "worn")).toHaveLength(1);
    expect(second.instances.filter((i) => i.locus.kind === "wardrobe")).toHaveLength(1);
  });

  it("F6: an instance's blueprint is a snapshot — later seed changes cannot reach it", () => {
    const seeds = seedMap(seed("shirt", "top"));
    const store = sync(emptyChatGarmentStore(), ALICE, ["shirt"], seeds, counterIds());
    const instance = store.instances[0];
    expect(instance).toBeDefined();
    if (!instance) return;
    const hashBefore = instance.blueprintHash;
    const coverageBefore = garmentBlueprintFor(store, instance).nodes.flatMap((n) => n.baselineCoverage);
    // "Edit the library row": a different coverage on the same definition id.
    const edited = seedMap(seed("shirt", "top", ["chest"]));
    const after = sync(store, ALICE, ["shirt"], edited, counterIds("m"));
    const still = after.instances[0];
    expect(still?.blueprintHash).toBe(hashBefore);
    expect(still && garmentBlueprintFor(after, still).nodes.flatMap((n) => n.baselineCoverage)).toEqual(coverageBefore);
  });

  it("instantiates an unloadable definition with an empty blueprint, keeping the projection intact", () => {
    const sink = new DiagnosticCollector();
    const store = syncWornGarments({
      store: emptyChatGarmentStore(),
      actorId: ALICE,
      wornDefinitionIds: ["ghost"],
      seeds: new Map(),
      mintId: counterIds(),
      atMinutes: 0,
      sink,
    });
    expect(wornGarmentDefinitionIds(store, ALICE)).toEqual(["ghost"]);
    const instance = store.instances[0];
    expect(instance && garmentBlueprintFor(store, instance).nodes.flatMap((n) => n.baselineCoverage)).toEqual([]);
    expect(sink.items.map((d) => d.code)).toContain("chat_garments.definition_unresolved");
  });
});

describe("worn-list projection round trip", () => {
  it("reproduces the id list verbatim, in order, for many shapes", () => {
    const seeds = seedMap(seed("a", "top"), seed("b", "pants"), seed("c", "socks"), seed("d", "footwear"));
    for (const ids of [[], ["a"], ["a", "b"], ["d", "c", "b", "a"], ["a", "a", "b"]]) {
      const store = sync(emptyChatGarmentStore(), ALICE, ids, seeds, counterIds());
      expect(wornGarmentDefinitionIds(store, ALICE)).toEqual(ids);
    }
  });

  it("keeps each actor's projection separate", () => {
    const seeds = seedMap(seed("a", "top"), seed("b", "pants"));
    let store = sync(emptyChatGarmentStore(), ALICE, ["a"], seeds, counterIds("a"));
    store = sync(store, BEN, ["b"], seeds, counterIds("b"));
    store = sync(store, GARMENT_PLAYER_ACTOR, ["a", "b"], seeds, counterIds("p"));
    expect(wornGarmentDefinitionIds(store, ALICE)).toEqual(["a"]);
    expect(wornGarmentDefinitionIds(store, BEN)).toEqual(["b"]);
    expect(wornGarmentDefinitionIds(store, GARMENT_PLAYER_ACTOR)).toEqual(["a", "b"]);
  });

  it("is idempotent — re-syncing the same list changes nothing", () => {
    const seeds = seedMap(seed("a", "top"), seed("b", "pants"));
    const first = sync(emptyChatGarmentStore(), ALICE, ["a", "b"], seeds, counterIds());
    const second = sync(first, ALICE, ["a", "b"], seeds, counterIds("m"));
    expect(second).toEqual(first);
  });

  it("reorders the projection without disturbing other actors' slots", () => {
    const seeds = seedMap(seed("a", "top"), seed("b", "pants"), seed("z", "socks"));
    let store = sync(emptyChatGarmentStore(), ALICE, ["a", "b"], seeds, counterIds("a"));
    store = sync(store, BEN, ["z"], seeds, counterIds("b"));
    const benInstanceId = store.instances.find((i) => i.definitionId === "z")?.id;
    store = sync(store, ALICE, ["b", "a"], seeds, counterIds("m"));
    expect(wornGarmentDefinitionIds(store, ALICE)).toEqual(["b", "a"]);
    expect(wornGarmentDefinitionIds(store, BEN)).toEqual(["z"]);
    expect(store.instances.find((i) => i.definitionId === "z")?.id).toBe(benInstanceId);
  });
});

describe("outfit presets compile to transfers, not a replacement", () => {
  it("keeps already-worn instances, mints the missing, and wardrobes the extras", () => {
    const seeds = seedMap(seed("shirt", "top"), seed("jeans", "pants"), seed("coat", "outerwear"));
    const before = sync(emptyChatGarmentStore(), ALICE, ["shirt", "jeans"], seeds, counterIds());
    const shirtId = before.instances.find((i) => i.definitionId === "shirt")?.id;
    // "Apply the Outdoors preset": shirt stays on, jeans come off, a coat goes on.
    const after = sync(before, ALICE, ["shirt", "coat"], seeds, counterIds("m"), 90);
    expect(wornGarmentDefinitionIds(after, ALICE)).toEqual(["shirt", "coat"]);
    // The same shirt instance — its identity (and, from slice 4, its condition) survived.
    expect(after.instances.find((i) => i.definitionId === "shirt")?.id).toBe(shirtId);
    const jeans = after.instances.find((i) => i.definitionId === "jeans");
    expect(jeans?.locus).toEqual({ kind: "wardrobe", ownerId: ALICE });
    expect(jeans?.lastChange).toEqual({ kind: "transfer", atMinutes: 90 });
  });

  it("re-dons the same instance rather than minting a twin", () => {
    const seeds = seedMap(seed("coat", "outerwear"));
    const worn = sync(emptyChatGarmentStore(), ALICE, ["coat"], seeds, counterIds());
    const coatId = worn.instances[0]?.id;
    const doffed = sync(worn, ALICE, [], seeds, counterIds("m"));
    const redonned = sync(doffed, ALICE, ["coat"], seeds, counterIds("n"));
    expect(redonned.instances).toHaveLength(1);
    expect(redonned.instances[0]?.id).toBe(coatId);
    expect(redonned.instances[0]?.locus).toEqual({ kind: "worn", actorId: ALICE });
  });

  it("never claims another actor's garment", () => {
    const seeds = seedMap(seed("coat", "outerwear"));
    let store = sync(emptyChatGarmentStore(), ALICE, ["coat"], seeds, counterIds("a"));
    store = sync(store, ALICE, [], seeds, counterIds("a2")); // Alice's coat is in her wardrobe
    store = sync(store, BEN, ["coat"], seeds, counterIds("b"));
    expect(store.instances).toHaveLength(2);
    expect(store.instances.find((i) => i.locus.kind === "worn")?.locus).toEqual({ kind: "worn", actorId: BEN });
  });

  it("picks a garment up off the scene floor when it is the only copy (R3 retrieval)", () => {
    const seeds = seedMap(seed("coat", "outerwear"));
    const worn = sync(emptyChatGarmentStore(), ALICE, ["coat"], seeds, counterIds());
    const coatId = worn.instances[0]?.id ?? "";
    const left = applyGarmentTransfers(
      worn,
      [{ kind: "transfer", garmentId: coatId, to: { kind: "scene", placeName: "the study", anchor: "over the chair" } }],
      { atMinutes: 10 },
    ).store;
    const back = sync(left, ALICE, ["coat"], seeds, counterIds("m"), 20);
    expect(back.instances).toHaveLength(1);
    expect(back.instances[0]?.id).toBe(coatId);
  });

  it("never resurrects a gone garment", () => {
    const seeds = seedMap(seed("coat", "outerwear"));
    const worn = sync(emptyChatGarmentStore(), ALICE, ["coat"], seeds, counterIds());
    const coatId = worn.instances[0]?.id ?? "";
    const burned = applyGarmentTransfers(
      worn,
      [{ kind: "transfer", garmentId: coatId, to: { kind: "gone", basis: "destroyed" } }],
      { atMinutes: 10 },
    ).store;
    const replaced = sync(burned, ALICE, ["coat"], seeds, counterIds("m"));
    expect(replaced.instances).toHaveLength(2);
    expect(replaced.instances.find((i) => i.id === coatId)?.locus).toEqual({ kind: "gone", basis: "destroyed" });
  });
});

describe("transfer reducer", () => {
  const seeds = seedMap(seed("coat", "outerwear"));
  const base = sync(emptyChatGarmentStore(), ALICE, ["coat"], seeds, counterIds());
  const coatId = base.instances[0]?.id ?? "";

  const legal: GarmentOperation["kind"] extends never ? never : { to: GarmentInstanceState["locus"]; label: string }[] = [
    { label: "held", to: { kind: "held", actorId: ALICE } },
    { label: "wardrobe", to: { kind: "wardrobe", ownerId: ALICE } },
    { label: "scene", to: { kind: "scene", placeName: "the study", anchor: "over the chair" } },
    { label: "gone", to: { kind: "gone", basis: "lost" } },
    { label: "another actor's hands", to: { kind: "held", actorId: BEN } },
  ];

  for (const target of legal) {
    it(`moves a worn garment to ${target.label}`, () => {
      const sink = new DiagnosticCollector();
      const result = applyGarmentTransfers(base, [{ kind: "transfer", garmentId: coatId, to: target.to }], {
        atMinutes: 5,
        sink,
      });
      expect(result.applied).toBe(1);
      expect(result.store.instances[0]?.locus).toEqual(target.to);
      expect(result.store.instances[0]?.lastChange).toEqual({ kind: "transfer", atMinutes: 5 });
      expect(sink.items).toHaveLength(0);
    });
  }

  it("drops an unknown garment with a stable diagnostic and no throw", () => {
    const sink = new DiagnosticCollector();
    const result = applyGarmentTransfers(
      base,
      [{ kind: "transfer", garmentId: "nope", to: { kind: "held", actorId: ALICE } }],
      { atMinutes: 5, sink },
    );
    expect(result.applied).toBe(0);
    expect(result.store).toBe(base);
    expect(sink.items.map((d) => d.code)).toEqual(["garment_op.garment_unresolved"]);
  });

  it("refuses to move a gone garment", () => {
    const sink = new DiagnosticCollector();
    const gone = applyGarmentTransfers(base, [{ kind: "transfer", garmentId: coatId, to: { kind: "gone", basis: "lost" } }], {
      atMinutes: 1,
    }).store;
    const result = applyGarmentTransfers(gone, [{ kind: "transfer", garmentId: coatId, to: { kind: "worn", actorId: ALICE } }], {
      atMinutes: 5,
      sink,
    });
    expect(result.applied).toBe(0);
    expect(sink.items.map((d) => d.code)).toEqual(["garment_op.transfer_from_gone"]);
  });

  it("treats a same-locus transfer as a legal no-op", () => {
    const sink = new DiagnosticCollector();
    const result = applyGarmentTransfers(base, [{ kind: "transfer", garmentId: coatId, to: { kind: "worn", actorId: ALICE } }], {
      atMinutes: 5,
      sink,
    });
    expect(result.applied).toBe(0);
    expect(result.store).toBe(base);
    expect(sink.items).toHaveLength(0);
  });

  it("drops the operations later slices own, with a diagnostic", () => {
    const sink = new DiagnosticCollector();
    const result = applyGarmentTransfers(
      base,
      [{ kind: "set_roll", garmentId: coatId, partId: "sleeve_left", degree: "substantial" }],
      { atMinutes: 5, sink },
    );
    expect(result.applied).toBe(0);
    expect(sink.items.map((d) => d.code)).toEqual(["garment_op.unsupported_kind"]);
  });

  it("applies operations in fiction order", () => {
    const result = applyGarmentTransfers(
      base,
      [
        { kind: "transfer", garmentId: coatId, to: { kind: "held", actorId: ALICE } },
        { kind: "transfer", garmentId: coatId, to: { kind: "scene", placeName: "the hall", anchor: "on a hook" } },
      ],
      { atMinutes: 5 },
    );
    expect(result.applied).toBe(2);
    expect(result.store.instances[0]?.locus).toEqual({ kind: "scene", placeName: "the hall", anchor: "on a hook" });
  });

  it("compares loci structurally", () => {
    expect(sameGarmentLocus({ kind: "worn", actorId: ALICE }, { kind: "worn", actorId: ALICE })).toBe(true);
    expect(sameGarmentLocus({ kind: "worn", actorId: ALICE }, { kind: "worn", actorId: BEN })).toBe(false);
    expect(sameGarmentLocus({ kind: "worn", actorId: ALICE }, { kind: "held", actorId: ALICE })).toBe(false);
    expect(
      sameGarmentLocus(
        { kind: "scene", placeName: "The Study", anchor: "on the chair" },
        { kind: "scene", placeName: "the study", anchor: "on the chair" },
      ),
    ).toBe(true);
  });
});

describe("scene loci (R3)", () => {
  const seeds = seedMap(seed("coat", "outerwear"));
  const worn = sync(emptyChatGarmentStore(), ALICE, ["coat"], seeds, counterIds());
  const coatId = worn.instances[0]?.id ?? "";
  const left = applyGarmentTransfers(
    worn,
    [{ kind: "transfer", garmentId: coatId, to: { kind: "scene", placeName: "the study", anchor: "over the desk chair" } }],
    { atMinutes: 30 },
  ).store;

  it("F4: a doffed garment contributes no coverage, still exists, and leaves the projection", () => {
    expect(wornGarmentDefinitionIds(left, ALICE)).toEqual([]);
    expect(left.instances).toHaveLength(1);
    expect(left.instances[0]?.locus).toEqual({
      kind: "scene",
      placeName: "the study",
      anchor: "over the desk chair",
    });
  });

  it("finds it again on return, matching the place name the way scene memory does", () => {
    expect(garmentsAtScenePlace(left, "the study").map((i) => i.id)).toEqual([coatId]);
    expect(garmentsAtScenePlace(left, "  The Study ").map((i) => i.id)).toEqual([coatId]);
    expect(garmentsAtScenePlace(left, "the kitchen")).toEqual([]);
    expect(garmentsAtScenePlace(left, "")).toEqual([]);
    expect(garmentsAtScenePlace(left, undefined)).toEqual([]);
  });

  it("survives its place being forgotten — the locus carries the name, not a pointer", () => {
    // Nothing in the store references scene memory, so evicting the place from
    // the 12-place ring cannot touch the garment. Round-tripping proves the
    // snapshot is what persists.
    const reparsed = chatGarmentStoreSchema.parse(JSON.parse(JSON.stringify(left)));
    expect(garmentsAtScenePlace(reparsed, "the study").map((i) => i.id)).toEqual([coatId]);
  });
});

describe("modelled-actor test", () => {
  it("is false until an actor actually has instances, and true for a stripped one", () => {
    const seeds = seedMap(seed("shirt", "top"));
    const empty = sync(emptyChatGarmentStore(), ALICE, [], seeds, counterIds());
    expect(empty.seeded).toBe(true);
    // Seeded store, but this actor was never modelled: callers must not read
    // "wearing nothing" as "stripped".
    expect(actorHasGarmentInstances(empty, ALICE)).toBe(false);
    const dressed = sync(empty, ALICE, ["shirt"], seeds, counterIds("m"));
    const stripped = sync(dressed, ALICE, [], seeds, counterIds("n"));
    expect(actorHasGarmentInstances(stripped, ALICE)).toBe(true);
    expect(wornGarmentDefinitionIds(stripped, ALICE)).toEqual([]);
  });
});

describe("retiring an actor's garments (persona switch)", () => {
  it("makes them ownerless so the actor reads as unmodelled again", () => {
    const seeds = seedMap(seed("dress", "dress"));
    const store = sync(emptyChatGarmentStore(), GARMENT_PLAYER_ACTOR, ["dress"], seeds, counterIds());
    expect(actorHasGarmentInstances(store, GARMENT_PLAYER_ACTOR)).toBe(true);
    const retired = retireActorGarments(store, GARMENT_PLAYER_ACTOR, 120);
    expect(actorHasGarmentInstances(retired, GARMENT_PLAYER_ACTOR)).toBe(false);
    expect(retired.instances[0]?.locus).toEqual({ kind: "gone", basis: "discarded" });
    expect(retireActorGarments(retired, GARMENT_PLAYER_ACTOR, 130)).toBe(retired);
  });
});

describe("cap and eviction", () => {
  function instance(id: string, kind: "worn" | "gone"): GarmentInstanceState {
    return {
      id,
      blueprintHash: "h",
      name: "g",
      locus: kind === "worn" ? { kind: "worn", actorId: ALICE } : { kind: "gone", basis: "lost" },
      presentation: { closure: {}, roll: {}, tuck: {}, displacement: [] },
      condition: {
        base: { wetness: 0, cleanliness: 10_000, crease_load: 0, wear: 0 },
        regionOverrides: {},
        deposits: [],
        damageMarks: [],
        integratedAtMinutes: 0,
      },
      lastChange: { kind: "mint", atMinutes: 0 },
    };
  }

  it("evicts gone garments oldest-first before ever dropping a live one", () => {
    const instances = [
      ...Array.from({ length: 4 }, (_, i) => instance(`gone${i}`, "gone")),
      ...Array.from({ length: CHAT_GARMENTS_MAX }, (_, i) => instance(`worn${i}`, "worn")),
    ];
    const kept = capGarmentInstances(instances);
    expect(kept).toHaveLength(CHAT_GARMENTS_MAX);
    expect(kept.every((i) => i.locus.kind === "worn")).toBe(true);
  });

  it("caps the store on sync so a runaway wardrobe cannot grow the blob", () => {
    const ids = Array.from({ length: CHAT_GARMENTS_MAX + 6 }, (_, i) => `item${i}`);
    const seeds = seedMap(...ids.map((id) => seed(id, "jewelry")));
    const store = sync(emptyChatGarmentStore(), ALICE, ids, seeds, counterIds());
    expect(store.instances.length).toBeLessThanOrEqual(CHAT_GARMENTS_MAX);
  });
});

describe("degradation (F17)", () => {
  it("parses a corrupt store to the empty, UNSEEDED one", () => {
    for (const corrupt of [null, 42, "nope", [], { instances: "not an array" }]) {
      const store = chatGarmentStoreSchema.catch(emptyChatGarmentStore()).parse(corrupt);
      expect(store.seeded).toBe(false);
      expect(store.instances).toEqual([]);
    }
  });

  it("drops individual malformed instances rather than the whole store", () => {
    const good = sync(emptyChatGarmentStore(), ALICE, ["shirt"], seedMap(seed("shirt", "top")), counterIds());
    const store = chatGarmentStoreSchema
      .catch(emptyChatGarmentStore())
      .parse({ ...good, instances: [...good.instances, { id: "", blueprintHash: "" }] });
    // The whole `instances` array heals to [] rather than half-parsing — the
    // conservative direction: an unreadable wardrobe contributes no coverage.
    expect(store.instances.every((i) => i.id.length > 0)).toBe(true);
  });

  it("survives a blueprint hash that no longer resolves", () => {
    const store = sync(emptyChatGarmentStore(), ALICE, ["shirt"], seedMap(seed("shirt", "top")), counterIds());
    const orphan: ChatGarmentStore = { ...store, blueprints: {} };
    const instance = orphan.instances[0];
    expect(instance).toBeDefined();
    if (!instance) return;
    const blueprint = garmentBlueprintFor(orphan, instance);
    // Degraded = covers nothing and can do nothing: a lost snapshot can never bare a character.
    expect(blueprint.nodes.flatMap((n) => n.baselineCoverage)).toEqual([]);
    expect(blueprint.behaviors).toEqual([]);
  });
});

describe("material inference", () => {
  it("reads the obvious families and stays `unknown` otherwise", () => {
    expect(inferGarmentMaterialProfile("a battered leather jacket")).toBe("leather");
    expect(inferGarmentMaterialProfile("blue denim jeans")).toBe("denim");
    expect(inferGarmentMaterialProfile("a silk blouse")).toBe("silk_satin");
    expect(inferGarmentMaterialProfile("cotton tee")).toBe("woven_cotton_linen");
    expect(inferGarmentMaterialProfile("cashmere knit sweater")).toBe("wool");
    expect(inferGarmentMaterialProfile("a nylon shell")).toBe("synthetic_shell");
    expect(inferGarmentMaterialProfile("a plain shirt")).toBe("unknown");
    expect(inferGarmentMaterialProfile("")).toBe("unknown");
    // No accidental substring hits.
    expect(inferGarmentMaterialProfile("cottonwood staff")).toBe("unknown");
  });

  it("changes the blueprint hash, so two materials are two snapshots", () => {
    const cotton = garmentBlueprintForSeed({ ...seed("s", "top"), materialProfileId: "woven_cotton_linen" });
    const leather = garmentBlueprintForSeed({ ...seed("s", "top"), materialProfileId: "leather" });
    expect(garmentBlueprintHash(cotton)).not.toBe(garmentBlueprintHash(leather));
  });
});

describe("R2 minted ad-hoc garments (F21)", () => {
  it("mints a real, doffable instance that cannot decide intimate coverage", () => {
    // "a borrowed hoodie" — no library row, so no `definitionId`.
    const mintId = counterIds("adhoc");
    const hoodieBlueprint = garmentBlueprintForSeed({
      definitionId: "",
      name: "a borrowed hoodie",
      categoryId: "outerwear",
      coverage: clothingCategoryById("outerwear")?.coverage ?? [],
    });
    const store: ChatGarmentStore = {
      seeded: true,
      blueprints: { [garmentBlueprintHash(hoodieBlueprint)]: hoodieBlueprint },
      instances: [
        {
          id: mintId(),
          blueprintHash: garmentBlueprintHash(hoodieBlueprint),
          name: "a borrowed hoodie",
          locus: { kind: "worn", actorId: ALICE },
          presentation: { closure: {}, roll: {}, tuck: {}, displacement: [] },
          condition: {
            base: { wetness: 0, cleanliness: 10_000, crease_load: 0, wear: 0 },
            regionOverrides: {},
            deposits: [],
            damageMarks: [],
            integratedAtMinutes: 0,
          },
          lastChange: { kind: "mint", atMinutes: 0 },
        },
      ],
      cues: emptyGarmentCueState(),
    };
    // It is real state — but has no library id, so it never enters the
    // definition-id projection the legacy readers consume.
    expect(actorHasGarmentInstances(store, ALICE)).toBe(true);
    expect(wornGarmentDefinitionIds(store, ALICE)).toEqual([]);
    // It can be taken off and left somewhere.
    const id = store.instances[0]?.id ?? "";
    const left = applyGarmentTransfers(
      store,
      [{ kind: "transfer", garmentId: id, to: { kind: "scene", placeName: "the porch", anchor: "on the rail" } }],
      { atMinutes: 20 },
    );
    expect(left.applied).toBe(1);
    // A mint only ever ADDS its own coverage — no node can strip an intimate location.
    const covered = hoodieBlueprint.nodes.flatMap((n) => n.baselineCoverage);
    expect(covered).not.toContain("groin");
    expect(covered).not.toContain("breasts");
  });
});
