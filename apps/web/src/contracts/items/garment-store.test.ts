import { describe, expect, it } from "vitest";
import { expectCleanSink, expectDiagnostic, expectDiagnostics } from "@/test/diagnostics";
import { DiagnosticCollector } from "../diagnostics";
import { clothingCategoryById } from "./clothing-categories";
import { expandCoverage } from "./coverage";
import { counterIds, garmentSeed, garmentSeedMap, wornGarment } from "./garment-test-fixtures";
import {
  degradedGarmentBlueprint,
  garmentBlueprintHash,
  garmentBlueprintSchema,
  isDegradedGarmentBlueprint,
  type GarmentBlueprint,
} from "./garment-blueprint";
import type { GarmentBlueprintIssueCode } from "./garment-blueprint-validation";
import { garmentCategoryTemplates } from "./garment-templates";
import { exposedRegions, type WornItemInput } from "./visibility";
import {
  capGarmentInstances,
  chatGarmentStoreSchema,
  emptyChatGarmentStore,
  CHAT_GARMENTS_MAX,
  CHAT_GARMENT_BLUEPRINTS_MAX,
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
  garmentInstanceById,
  garmentsAtScenePlace,
  GARMENT_PLAYER_ACTOR,
  inferGarmentMaterialProfile,
  instantiateGarment,
  resolveGarmentBlueprint,
  retireActorGarments,
  sameGarmentLocus,
  syncWornGarments,
  validateGarmentStoreBlueprints,
  wornGarmentDefinitionIds,
  type GarmentSeed,
} from "./garment-store";

/**
 * Chat-scoped instances, the worn-list projection, and whole-garment loci.
 */

const ALICE = garmentActorForCharacter("alice");
const BEN = garmentActorForCharacter("ben");

/**
 * Positional shorthand over the shared `garmentSeed` fixture — this suite names
 * dozens of seeds inline, where the spec-object form would bury the assertions.
 * The defaulting (name = definition id, coverage = the category's) lives in the
 * fixture, not here.
 */
const seed = (definitionId: string, categoryId: string, coverage?: readonly string[]): GarmentSeed =>
  garmentSeed(coverage === undefined ? { definitionId, categoryId } : { definitionId, categoryId, coverage });

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
    const store = sync(emptyChatGarmentStore(), ALICE, ["shirt", "jeans"], garmentSeedMap([seed("shirt", "top"), seed("jeans", "pants")]), counterIds());
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
    const seeds = garmentSeedMap([seed("shirt", "top")]);
    const store = sync(emptyChatGarmentStore(), ALICE, ["shirt", "shirt"], seeds, counterIds());
    expect(store.instances).toHaveLength(2);
    expect(store.instances[0]?.blueprintHash).toBe(store.instances[1]?.blueprintHash);
    expect(store.instances[0]?.id).not.toBe(store.instances[1]?.id);
    expect(Object.keys(store.blueprints)).toHaveLength(1);
    expect(wornGarmentDefinitionIds(store, ALICE)).toEqual(["shirt", "shirt"]);
  });

  it("F5: doffing one copy leaves the other worn", () => {
    const seeds = garmentSeedMap([seed("shirt", "top")]);
    const first = sync(emptyChatGarmentStore(), ALICE, ["shirt", "shirt"], seeds, counterIds());
    const second = sync(first, ALICE, ["shirt"], seeds, counterIds("m"));
    expect(wornGarmentDefinitionIds(second, ALICE)).toEqual(["shirt"]);
    expect(second.instances.filter((i) => i.locus.kind === "worn")).toHaveLength(1);
    expect(second.instances.filter((i) => i.locus.kind === "wardrobe")).toHaveLength(1);
  });

  it("snapshots the seed's hair-occlusion band beside the name, and a twin minted off a sibling copies it", () => {
    // The orphan read has only this snapshot once the library row is gone; a
    // mint that dropped it — from the seed, or on the sibling arm that never
    // sees a seed — would strand a still-worn hijab at `none`.
    const hijab: GarmentSeed = { ...seed("hijab", "headwear"), hairOcclusion: "full" };
    const first = sync(emptyChatGarmentStore(), ALICE, ["hijab"], garmentSeedMap([hijab]), counterIds());
    const twins = sync(first, ALICE, ["hijab", "hijab"], garmentSeedMap([]), counterIds("m"));
    expect(twins.instances.map((i) => i.hairOcclusion)).toEqual(["full", "full"]);
    // Sparse: a seed with no band mints no key at all.
    const cap = sync(emptyChatGarmentStore(), ALICE, ["cap"], garmentSeedMap([seed("cap", "headwear")]), counterIds());
    expect(cap.instances[0]).not.toHaveProperty("hairOcclusion");
  });

  it("F6: an instance's blueprint is a snapshot — later seed changes cannot reach it", () => {
    const seeds = garmentSeedMap([seed("shirt", "top")]);
    const store = sync(emptyChatGarmentStore(), ALICE, ["shirt"], seeds, counterIds());
    const instance = store.instances[0];
    expect(instance).toBeDefined();
    if (!instance) return;
    const hashBefore = instance.blueprintHash;
    const coverageBefore = garmentBlueprintFor(store, instance).nodes.flatMap((n) => n.baselineCoverage);
    // "Edit the library row": a different coverage on the same definition id.
    const edited = garmentSeedMap([seed("shirt", "top", ["chest"])]);
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
    // The stored snapshot is the MARKED sentinel: the ghost's covers-nothing
    // reads as "could not be read", never as "confirmed wearing nothing".
    expect(instance && resolveGarmentBlueprint(store, instance).reliable).toBe(false);
    expectDiagnostic(sink, "chat_garments.definition_unresolved");
  });
});

describe("worn-list projection round trip", () => {
  it("reproduces the id list verbatim, in order, for many shapes", () => {
    const seeds = garmentSeedMap([seed("a", "top"), seed("b", "pants"), seed("c", "socks"), seed("d", "footwear")]);
    for (const ids of [[], ["a"], ["a", "b"], ["d", "c", "b", "a"], ["a", "a", "b"]]) {
      const store = sync(emptyChatGarmentStore(), ALICE, ids, seeds, counterIds());
      expect(wornGarmentDefinitionIds(store, ALICE)).toEqual(ids);
    }
  });

  it("keeps each actor's projection separate", () => {
    const seeds = garmentSeedMap([seed("a", "top"), seed("b", "pants")]);
    let store = sync(emptyChatGarmentStore(), ALICE, ["a"], seeds, counterIds("a"));
    store = sync(store, BEN, ["b"], seeds, counterIds("b"));
    store = sync(store, GARMENT_PLAYER_ACTOR, ["a", "b"], seeds, counterIds("p"));
    expect(wornGarmentDefinitionIds(store, ALICE)).toEqual(["a"]);
    expect(wornGarmentDefinitionIds(store, BEN)).toEqual(["b"]);
    expect(wornGarmentDefinitionIds(store, GARMENT_PLAYER_ACTOR)).toEqual(["a", "b"]);
  });

  it("is idempotent — re-syncing the same list changes nothing", () => {
    const seeds = garmentSeedMap([seed("a", "top"), seed("b", "pants")]);
    const first = sync(emptyChatGarmentStore(), ALICE, ["a", "b"], seeds, counterIds());
    const second = sync(first, ALICE, ["a", "b"], seeds, counterIds("m"));
    expect(second).toEqual(first);
  });

  it("reorders the projection without disturbing other actors' slots", () => {
    const seeds = garmentSeedMap([seed("a", "top"), seed("b", "pants"), seed("z", "socks")]);
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
    const seeds = garmentSeedMap([seed("shirt", "top"), seed("jeans", "pants"), seed("coat", "outerwear")]);
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
    const seeds = garmentSeedMap([seed("coat", "outerwear")]);
    const worn = sync(emptyChatGarmentStore(), ALICE, ["coat"], seeds, counterIds());
    const coatId = worn.instances[0]?.id;
    const doffed = sync(worn, ALICE, [], seeds, counterIds("m"));
    const redonned = sync(doffed, ALICE, ["coat"], seeds, counterIds("n"));
    expect(redonned.instances).toHaveLength(1);
    expect(redonned.instances[0]?.id).toBe(coatId);
    expect(redonned.instances[0]?.locus).toEqual({ kind: "worn", actorId: ALICE });
  });

  it("never claims another actor's garment", () => {
    const seeds = garmentSeedMap([seed("coat", "outerwear")]);
    let store = sync(emptyChatGarmentStore(), ALICE, ["coat"], seeds, counterIds("a"));
    store = sync(store, ALICE, [], seeds, counterIds("a2")); // Alice's coat is in her wardrobe
    store = sync(store, BEN, ["coat"], seeds, counterIds("b"));
    expect(store.instances).toHaveLength(2);
    expect(store.instances.find((i) => i.locus.kind === "worn")?.locus).toEqual({ kind: "worn", actorId: BEN });
  });

  it("picks a garment up off the scene floor when it is the only copy (R3 retrieval)", () => {
    const seeds = garmentSeedMap([seed("coat", "outerwear")]);
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
    const seeds = garmentSeedMap([seed("coat", "outerwear")]);
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
  const seeds = garmentSeedMap([seed("coat", "outerwear")]);
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
      expectCleanSink(sink);
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
    expectDiagnostics(sink, ["garment_op.garment_unresolved"]);
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
    expectDiagnostics(sink, ["garment_op.transfer_from_gone"]);
  });

  it("treats a same-locus transfer as a legal no-op", () => {
    const sink = new DiagnosticCollector();
    const result = applyGarmentTransfers(base, [{ kind: "transfer", garmentId: coatId, to: { kind: "worn", actorId: ALICE } }], {
      atMinutes: 5,
      sink,
    });
    expect(result.applied).toBe(0);
    expect(result.store).toBe(base);
    expectCleanSink(sink);
  });

  it("drops the operations later slices own, with a diagnostic", () => {
    const sink = new DiagnosticCollector();
    const result = applyGarmentTransfers(
      base,
      [{ kind: "set_roll", garmentId: coatId, partId: "sleeve_left", degree: "substantial" }],
      { atMinutes: 5, sink },
    );
    expect(result.applied).toBe(0);
    expectDiagnostics(sink, ["garment_op.unsupported_kind"]);
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
  const seeds = garmentSeedMap([seed("coat", "outerwear")]);
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
    const seeds = garmentSeedMap([seed("shirt", "top")]);
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
    const seeds = garmentSeedMap([seed("dress", "dress")]);
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
    const seeds = garmentSeedMap(ids.map((id) => seed(id, "jewelry")));
    const store = sync(emptyChatGarmentStore(), ALICE, ids, seeds, counterIds());
    expect(store.instances.length).toBeLessThanOrEqual(CHAT_GARMENTS_MAX);
  });
});

describe("blueprint cap — a mint never points at an unstored hash", () => {
  // Falsified against the old registerBlueprint, which returned the hash of a
  // snapshot it had NOT stored: the worn instance then dangled permanently and
  // read covers-nothing — narrated and rendered as confirmed nudity.
  function fullBlueprintMap(): Record<string, GarmentBlueprint> {
    const bare = garmentBlueprintSchema.parse({ rootNodeId: "root", nodes: [{ id: "root", kind: "root" }] });
    return Object.fromEntries(Array.from({ length: CHAT_GARMENT_BLUEPRINTS_MAX }, (_, i) => [`h${i}`, bare] as const));
  }

  /** A full map in which every snapshot is pinned by one of Ben's worn instances. */
  function storeWithReferencedFullMap(): ChatGarmentStore {
    const blueprints = fullBlueprintMap();
    return {
      ...emptyChatGarmentStore(),
      seeded: true,
      blueprints,
      instances: Object.keys(blueprints).map((hash, i) => wornGarment({ id: `w${i}`, actorId: BEN, blueprintHash: hash })),
    };
  }

  it("garbage-collects orphaned snapshots at the cap instead of dangling the mint", () => {
    const full: ChatGarmentStore = { ...emptyChatGarmentStore(), seeded: true, blueprints: fullBlueprintMap() };
    const store = sync(full, ALICE, ["shirt"], garmentSeedMap([seed("shirt", "top")]), counterIds());
    expect(wornGarmentDefinitionIds(store, ALICE)).toEqual(["shirt"]);
    const minted = store.instances[0];
    expect(minted && resolveGarmentBlueprint(store, minted).reliable).toBe(true);
    expect(Object.keys(store.blueprints).length).toBeLessThanOrEqual(CHAT_GARMENT_BLUEPRINTS_MAX);
  });

  it("sync skips the mint openly when every snapshot is referenced, and the un-materialized item retries", () => {
    const full = storeWithReferencedFullMap();
    const seeds = garmentSeedMap([seed("shirt", "top")]);
    const sink = new DiagnosticCollector();
    const store = syncWornGarments({
      store: full,
      actorId: ALICE,
      wornDefinitionIds: ["shirt"],
      seeds,
      mintId: counterIds(),
      atMinutes: 0,
      sink,
    });
    // Degrade openly: no instance, unchanged map, a warn — and NO dangling hash anywhere.
    expect(wornGarmentDefinitionIds(store, ALICE)).toEqual([]);
    expect(store.blueprints).toEqual(full.blueprints);
    expect(store.instances.every((i) => store.blueprints[i.blueprintHash] !== undefined)).toBe(true);
    expectDiagnostic(sink, "chat_garments.blueprints_full");
    // The item stayed un-materialized, so the SAME reconcile succeeds once
    // instance eviction has since orphaned some snapshots.
    const retried = sync({ ...store, instances: [] }, ALICE, ["shirt"], seeds, counterIds("m"));
    expect(wornGarmentDefinitionIds(retried, ALICE)).toEqual(["shirt"]);
    const minted = retried.instances[0];
    expect(minted && resolveGarmentBlueprint(retried, minted).reliable).toBe(true);
  });

  it("instantiateGarment stores past the cap rather than dangling, and reload keeps the over-cap snapshot", () => {
    const sink = new DiagnosticCollector();
    const result = instantiateGarment(
      storeWithReferencedFullMap(),
      {
        id: "adhoc1",
        blueprint: garmentBlueprintForSeed(seed("", "outerwear")),
        name: "a borrowed hoodie",
        locus: { kind: "worn", actorId: ALICE },
        atMinutes: 3,
      },
      sink,
    );
    expectDiagnostic(sink, "chat_garments.blueprints_full");
    // A valid graph mints, so the instance is there.
    const instance = result.instance;
    expect(instance).toBeDefined();
    if (!instance) return;
    expect(resolveGarmentBlueprint(result.store, instance).reliable).toBe(true);
    // Bounded overfill: exactly one past the cap, never unbounded growth.
    expect(Object.keys(result.store.blueprints)).toHaveLength(CHAT_GARMENT_BLUEPRINTS_MAX + 1);
    // Reload trims orphans first (garment-instance's parse cap), so the
    // over-cap snapshot survives with its instance instead of being sliced off.
    const reloaded = chatGarmentStoreSchema.parse(JSON.parse(JSON.stringify(result.store)) as unknown);
    expect(Object.keys(reloaded.blueprints)).toHaveLength(CHAT_GARMENT_BLUEPRINTS_MAX);
    const still = garmentInstanceById(reloaded, "adhoc1");
    expect(still && resolveGarmentBlueprint(reloaded, still).reliable).toBe(true);
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
    const good = sync(emptyChatGarmentStore(), ALICE, ["shirt"], garmentSeedMap([seed("shirt", "top")]), counterIds());
    const store = chatGarmentStoreSchema
      .catch(emptyChatGarmentStore())
      .parse({ ...good, instances: [...good.instances, { id: "", blueprintHash: "" }] });
    // The whole `instances` array heals to [] rather than half-parsing — the
    // conservative direction: an unreadable wardrobe contributes no coverage.
    expect(store.instances.every((i) => i.id.length > 0)).toBe(true);
  });

  it("survives a blueprint hash that no longer resolves — detectably, not as covers-nothing truth", () => {
    const store = sync(emptyChatGarmentStore(), ALICE, ["shirt"], garmentSeedMap([seed("shirt", "top")]), counterIds());
    const orphan: ChatGarmentStore = { ...store, blueprints: {} };
    const instance = orphan.instances[0];
    expect(instance).toBeDefined();
    if (!instance) return;
    const { blueprint, reliable } = resolveGarmentBlueprint(orphan, instance);
    // Degraded = covers nothing and can do nothing…
    expect(blueprint.nodes.flatMap((n) => n.baselineCoverage)).toEqual([]);
    expect(blueprint.behaviors).toEqual([]);
    // …and MARKED, because on the modelled wardrobe path an unmarked empty read
    // is a nudity claim: the consumer must degrade this instance to covered.
    expect(reliable).toBe(false);
    expect(isDegradedGarmentBlueprint(blueprint)).toBe(true);
    // The same instance against the intact store still reads reliable.
    expect(resolveGarmentBlueprint(store, instance).reliable).toBe(true);
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
      coverage: {},
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

/** One graph that parses and is still structurally impossible. */
interface InvalidGraph {
  readonly label: string;
  /** The rule this case is ABOUT — asserted against the full issue list. */
  readonly rule: GarmentBlueprintIssueCode;
  /**
   * The code a bounded sink actually carries: the FIRST issue the validator
   * files. Same as `rule` except for the unreachable case — a part the root
   * cannot reach necessarily also has no `part_of` edge, and that rule is
   * checked first.
   */
  readonly reported: GarmentBlueprintIssueCode;
  readonly blueprint: GarmentBlueprint;
}

/**
 * Graphs that PARSE and are still structurally impossible — the class no shape
 * schema can catch, and the one the boundaries here have to act on. Four
 * representative rules, one per entry; the validator's own accept/reject matrix
 * lives in `garment-blueprint-validation.test.ts` and is deliberately not
 * repeated.
 */
function invalidGraphs(): readonly InvalidGraph[] {
  const node = (id: string, kind: string, baselineCoverage: readonly string[] = []) => ({ id, kind, baselineCoverage });
  const graph = (rootNodeId: string, nodes: unknown[], edges: unknown[] = []): GarmentBlueprint =>
    garmentBlueprintSchema.parse({ rootNodeId, nodes, edges, behaviors: [] });
  return [
    {
      label: "a part_of cycle",
      rule: "garment_blueprint.part_of_cycle",
      reported: "garment_blueprint.part_of_cycle",
      blueprint: graph(
        "root",
        [node("root", "root"), node("a", "panel", ["chest"]), node("b", "panel", ["waist"])],
        [
          { kind: "part_of", from: "a", to: "b" },
          { kind: "part_of", from: "b", to: "a" },
        ],
      ),
    },
    {
      label: "a rootNodeId naming no part",
      rule: "garment_blueprint.root_missing",
      reported: "garment_blueprint.root_missing",
      blueprint: graph("gone", [node("root", "root", ["chest"])]),
    },
    {
      label: "a part the root cannot reach",
      rule: "garment_blueprint.part_of_unreachable",
      reported: "garment_blueprint.part_of_missing",
      blueprint: graph("root", [node("root", "root", ["chest"]), node("stray", "panel", ["waist"])]),
    },
    {
      label: "coverage naming an unknown body location",
      rule: "garment_blueprint.unknown_body_location",
      reported: "garment_blueprint.unknown_body_location",
      blueprint: graph("root", [node("root", "root", ["chest", "atlantis"])]),
    },
  ];
}

/** A store holding one hand-built blueprint under its own hash, worn by one instance. */
function storeHolding(blueprint: GarmentBlueprint, instanceId = "g_bad"): ChatGarmentStore {
  const hash = garmentBlueprintHash(blueprint);
  return {
    ...emptyChatGarmentStore(),
    seeded: true,
    blueprints: { [hash]: blueprint },
    instances: [wornGarment({ id: instanceId, blueprintHash: hash, actorId: ALICE })],
  };
}

describe("materialization refuses a structurally invalid graph", () => {
  it("abandons the actor's reconcile rather than doffing what the bad definition replaced", () => {
    // The whole risk in one case: Alice is dressed, and the change swaps her
    // jeans for an item whose coverage names a body location that is not in the
    // registry. Reconciling to the readable remainder would leave her wearing
    // only the shirt — a modelled, persisted, PELVIS-BARE wardrobe minted from a
    // bad library row.
    const dressed = sync(
      emptyChatGarmentStore(),
      ALICE,
      ["shirt", "jeans"],
      garmentSeedMap([seed("shirt", "top"), seed("jeans", "pants")]),
      counterIds(),
    );
    const sink = new DiagnosticCollector();
    const after = syncWornGarments({
      store: dressed,
      actorId: ALICE,
      wornDefinitionIds: ["shirt", "cursed"],
      seeds: garmentSeedMap([seed("cursed", "pants", ["waist", "atlantis"])]),
      mintId: counterIds("x"),
      atMinutes: 30,
      sink,
    });
    // Two diagnostics, one each: WHAT was wrong with the graph, and what the
    // wardrobe did about it (the `chat_garments.*` family the seam's other
    // withhold arms use).
    expectDiagnostics(sink, ["garment_blueprint.unknown_body_location", "chat_garments.blueprint_invalid"]);
    expect(sink.items[1]?.context ?? {}).toMatchObject({
      actorId: ALICE,
      definitionId: "cursed",
      issues: ["garment_blueprint.unknown_body_location"],
    });
    // The store comes back by IDENTITY: nothing registered, nothing minted,
    // nothing doffed. The cost is a lost outfit change, not a bare body.
    expect(after).toBe(dressed);
    expect(wornGarmentDefinitionIds(after, ALICE)).toEqual(["shirt", "jeans"]);
    expect(Object.keys(after.blueprints)).toHaveLength(2);
    expect(after.instances.every((i) => i.definitionId !== "cursed")).toBe(true);
  });

  it("leaves an UNMODELLED actor unmaterialized so a repaired definition can retry", () => {
    const sink = new DiagnosticCollector();
    const after = syncWornGarments({
      store: emptyChatGarmentStore(),
      actorId: ALICE,
      wornDefinitionIds: ["cursed"],
      seeds: garmentSeedMap([seed("cursed", "top", ["chest", "atlantis"])]),
      mintId: counterIds(),
      atMinutes: 0,
      sink,
    });
    expectDiagnostic(sink, "garment_blueprint.unknown_body_location");
    expectDiagnostic(sink, "chat_garments.blueprint_invalid");
    expect(actorHasGarmentInstances(after, ALICE)).toBe(false);
    expect(after.blueprints).toEqual({});
    // Unseeded, so the read seam keeps reading the caller's worn-id list.
    expect(after.seeded).toBe(false);
  });

  it("instantiateGarment refuses the mint and names the refusal in the validator's codes", () => {
    for (const { label, rule, reported, blueprint } of invalidGraphs()) {
      const sink = new DiagnosticCollector();
      const result = instantiateGarment(
        emptyChatGarmentStore(),
        { id: "adhoc1", blueprint, name: "a borrowed hoodie", locus: { kind: "worn", actorId: ALICE }, atMinutes: 3 },
        sink,
      );
      expect(result.instance, label).toBeUndefined();
      expect(result.store.instances, label).toEqual([]);
      expect(result.store.blueprints, label).toEqual({});
      // The caller gets every issue…
      expect(result.rejected?.map((issue) => issue.code), label).toContain(rule);
      // …the sink gets exactly one, with the total beside it.
      expectDiagnostics(sink, [reported]);
      expect(sink.items[0]?.context ?? {}, label).toMatchObject({ issueCount: result.rejected?.length ?? 0 });
    }
  });

  it("drops a known-but-unstorable coverage id instead of refusing the graph over it", () => {
    // `vulva` is registry-valid and `coverageRelevant: false` — a contact locus,
    // not a garment slot — and the item API accepts it in a coverage list, so it
    // legitimately sits in stored definitions. Every other coverage consumer
    // drops it; so does materialization. Refusing here would abandon this
    // actor's reconcile on EVERY write, forever, over an id that changes no
    // exposure — a far worse failure than the one the gate exists for.
    const sink = new DiagnosticCollector();
    const after = syncWornGarments({
      store: emptyChatGarmentStore(),
      actorId: ALICE,
      wornDefinitionIds: ["panties"],
      seeds: garmentSeedMap([seed("panties", "pants", ["waist", "vulva"])]),
      mintId: counterIds(),
      atMinutes: 0,
      sink,
    });
    expectCleanSink(sink);
    expect(wornGarmentDefinitionIds(after, ALICE)).toEqual(["panties"]);
    const instance = after.instances[0];
    expect(instance).toBeDefined();
    if (!instance) return;
    const resolution = resolveGarmentBlueprint(after, instance);
    expect(resolution.reliable).toBe(true);
    // Coverage-neutral: the storable half survives, the unstorable id is gone.
    const union = new Set(resolution.blueprint.nodes.flatMap((node) => node.baselineCoverage));
    expect([...union]).toEqual(["waist"]);
  });
});

describe("the durable read's structural gate", () => {
  it("replaces a stored entry that parses but cannot be structurally true", () => {
    for (const { label, reported, blueprint } of invalidGraphs()) {
      const store = storeHolding(blueprint);
      const hash = garmentBlueprintHash(blueprint);
      const sink = new DiagnosticCollector();
      const after = validateGarmentStoreBlueprints(store, sink, "character_chats.garments.blueprints");
      const kept = after.blueprints[hash];
      expect(kept, label).toBeDefined();
      if (!kept) continue;
      // The MARKED safe root — covers nothing, does nothing, and says so.
      expect(isDegradedGarmentBlueprint(kept), label).toBe(true);
      expect(kept.nodes.flatMap((n) => n.baselineCoverage), label).toEqual([]);
      // ONE diagnostic per entry, never one per issue: a store full of damage
      // must not flood the turn's record off the inspector.
      expectDiagnostics(sink, [reported]);
      expect(sink.items[0]?.path, label).toBe("character_chats.garments.blueprints");
      expect(sink.items[0]?.context ?? {}, label).toMatchObject({ blueprintHash: hash });
      expect(typeof sink.items[0]?.context?.issueCount, label).toBe("number");
      // …so every instance pointing at it reads UNRELIABLE, which is what makes
      // the wardrobe seam degrade this wearer to covered rather than bare.
      const instance = after.instances[0];
      expect(instance, label).toBeDefined();
      if (!instance) continue;
      expect(resolveGarmentBlueprint(after, instance).reliable, label).toBe(false);
    }
  });

  it("degrades ONE entry alone — siblings, instances and seeded survive", () => {
    const healthy = sync(emptyChatGarmentStore(), ALICE, ["shirt"], garmentSeedMap([seed("shirt", "top")]), counterIds());
    const bad = invalidGraphs()[0]?.blueprint;
    expect(bad).toBeDefined();
    if (!bad) return;
    const badHash = garmentBlueprintHash(bad);
    const goodHash = healthy.instances[0]?.blueprintHash ?? "";
    const mixed: ChatGarmentStore = {
      ...healthy,
      blueprints: { ...healthy.blueprints, [badHash]: bad },
      instances: [...healthy.instances, wornGarment({ id: "g_bad", blueprintHash: badHash, actorId: BEN })],
    };
    const sink = new DiagnosticCollector();
    const after = validateGarmentStoreBlueprints(mixed, sink);

    expectDiagnostic(sink, "garment_blueprint.part_of_cycle");
    expect(isDegradedGarmentBlueprint(after.blueprints[badHash] ?? degradedGarmentBlueprint())).toBe(true);
    // The sibling snapshot is the very same object, not a re-parse.
    expect(after.blueprints[goodHash]).toBe(mixed.blueprints[goodHash]);
    expect(after.instances).toBe(mixed.instances);
    expect(after.seeded).toBe(true);
    const alice = after.instances[0];
    const ben = after.instances[1];
    expect(alice && resolveGarmentBlueprint(after, alice).reliable).toBe(true);
    expect(ben && resolveGarmentBlueprint(after, ben).reliable).toBe(false);
    // Alice's coverage is untouched by Ben's broken garment.
    expect(wornGarmentDefinitionIds(after, ALICE)).toEqual(["shirt"]);
  });

  it("returns a healthy store by identity and reports nothing", () => {
    const healthy = sync(
      emptyChatGarmentStore(),
      ALICE,
      ["shirt", "jeans"],
      garmentSeedMap([seed("shirt", "top"), seed("jeans", "pants")]),
      counterIds(),
    );
    const sink = new DiagnosticCollector();
    // Identity matters: the anchor round-trips byte-identically, so a retake
    // restores exactly what it snapshotted.
    expect(validateGarmentStoreBlueprints(healthy, sink)).toBe(healthy);
    expectCleanSink(sink);
  });

  it("leaves an entry the parse already marked degraded alone, and reports it once at most", () => {
    const store = storeHolding(degradedGarmentBlueprint());
    const sink = new DiagnosticCollector();
    const after = validateGarmentStoreBlueprints(store, sink);
    // Already the marked state this pass produces — the parse recorded the loss,
    // so a later load does not re-file the same warning.
    expect(after).toBe(store);
    expectCleanSink(sink);
    const instance = after.instances[0];
    expect(instance && resolveGarmentBlueprint(after, instance).reliable).toBe(false);
  });
});
