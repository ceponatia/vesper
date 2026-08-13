import { describe, expect, it } from "vitest";
import { expectCleanSink, expectDiagnostic, expectDiagnostics } from "@/test/diagnostics";
import { DiagnosticCollector } from "../diagnostics";
import { counterIds, garmentSeed } from "../items/garment-test-fixtures";
import { buildGarmentHandleTable, type GarmentHandleTable } from "../items/garment-handles";
import { emptyChatGarmentStore, type ChatGarmentStore } from "../items/garment-instance";
import { GARMENT_UNIT_ONE } from "../items/garment-material";
import {
  garmentActorForCharacter,
  garmentInstanceById,
  syncWornGarments,
  GARMENT_PLAYER_ACTOR,
  type GarmentSeed,
} from "../items/garment-store";
import {
  applyGarmentProposals,
  garmentMutationLane,
  garmentOperationProposalListSchema,
  resolveGarmentPartHandle,
  GARMENT_INTRODUCE_MAX,
  GARMENT_PROPOSAL_MAX,
  type GarmentOperationProposal,
} from "./chat-garment-ops";

/**
 * Slice 5 — proposals over opaque handles become typed operations
 * (clothing-state-graph.plan.md §"Models propose semantic operations, never raw
 * state" / §"Typed mutation surface"; slice-0 audit OQ7 + R2, fixtures F15/F16/F21).
 *
 * The load-bearing claims: every proposal kind maps, an unresolvable handle DROPS
 * with the right stable code and leaves the store byte-identical, `introduce`
 * mints exactly once and never over an existing handle, and the whole list applies
 * in fiction order.
 */

const MARA = garmentActorForCharacter("mara");

/** Positional shorthand over the shared fixture — coverage defaults to the category's. */
const seed = (definitionId: string, name: string, categoryId: string): GarmentSeed =>
  garmentSeed({ definitionId, name, categoryId });

const ACTORS = [
  { actorId: MARA, label: "Mara" },
  { actorId: GARMENT_PLAYER_ACTOR, label: "You", slug: "you" },
];

/** Mara wearing a shirt and a jacket, plus the table the prompt would have shown. */
function scene(extra: readonly GarmentSeed[] = []): { store: ChatGarmentStore; table: GarmentHandleTable } {
  const seeds = [seed("i1", "cotton shirt", "top"), seed("i2", "denim jacket", "outerwear"), ...extra];
  const store = syncWornGarments({
    store: emptyChatGarmentStore(),
    actorId: MARA,
    wornDefinitionIds: seeds.map((s) => s.definitionId),
    seeds: new Map(seeds.map((s) => [s.definitionId, s])),
    mintId: counterIds(),
    atMinutes: 0,
  });
  return { store, table: buildGarmentHandleTable({ store, actors: ACTORS, placeName: "the study" }) };
}

function fold(proposals: readonly GarmentOperationProposal[], world = scene(), placeName = "the study") {
  const sink = new DiagnosticCollector();
  const result = applyGarmentProposals(proposals, {
    store: world.store,
    table: world.table,
    atMinutes: 120,
    mintId: counterIds("m"),
    placeName,
    sink,
  });
  return { ...result, sink, before: world.store, table: world.table };
}

describe("the proposal list schema", () => {
  it("drops one malformed proposal without voiding the rest, and caps the list", () => {
    const parsed = garmentOperationProposalListSchema.parse([
      { op: "roll", garment: "mara.shirt", part: "sleeve_left", degree: "substantial" },
      { op: "roll", garment: "mara.shirt" }, // missing part/degree
      { op: "not_an_op", garment: "mara.shirt" },
      ...Array.from({ length: GARMENT_PROPOSAL_MAX + 4 }, () => ({
        op: "tuck" as const,
        garment: "mara.shirt",
        part: "hem",
        state: "in" as const,
      })),
    ]);
    expect(parsed[0]?.op).toBe("roll");
    expect(parsed.length).toBe(GARMENT_PROPOSAL_MAX);
    expect(parsed.every((p) => p.op === "roll" || p.op === "tuck")).toBe(true);
  });

  it("a garbage value parses to the empty list rather than throwing", () => {
    expect(garmentOperationProposalListSchema.parse("nope")).toEqual([]);
    expect(garmentOperationProposalListSchema.parse(undefined)).toEqual([]);
  });
});

describe("part-handle resolution", () => {
  it("accepts the fully qualified handle and the bare part id, and means the root for the garment alone", () => {
    const { table } = scene();
    const entry = table.entries[0];
    expect(entry).toBeDefined();
    if (!entry) return;
    expect(resolveGarmentPartHandle(entry, "mara.shirt.sleeve_left", "root")).toBe("sleeve_left");
    expect(resolveGarmentPartHandle(entry, "sleeve_left", "root")).toBe("sleeve_left");
    expect(resolveGarmentPartHandle(entry, "mara.shirt", "root")).toBe("root");
    // Never fuzzy: a near-miss is a miss (OQ7).
    expect(resolveGarmentPartHandle(entry, "left sleeve", "root")).toBeNull();
    expect(resolveGarmentPartHandle(entry, "sleeve_middle", "root")).toBeNull();
  });
});

describe("every proposal kind maps", () => {
  it("move — worn ⇒ left_here keeps the garment located and off the body", () => {
    const world = scene();
    const result = fold(
      [{ op: "move", garment: "mara.jacket", to: "left_here", anchor: "over the desk chair" }],
      world,
    );
    expect(result.applied).toBe(1);
    const jacketId = world.table.entries.find((e) => e.handle === "mara.jacket")?.garmentId ?? "";
    expect(garmentInstanceById(result.store, jacketId)?.locus).toEqual({
      kind: "scene",
      placeName: "the study",
      anchor: "over the desk chair",
    });
    expect(result.trace[0]).toMatchObject({ op: "move", garment: "mara.jacket", outcome: "applied", code: "" });
  });

  it("move — put_away / held / gone all resolve the current holder without a wearer", () => {
    const world = scene();
    const result = fold(
      [
        { op: "move", garment: "mara.shirt", to: "held" },
        { op: "move", garment: "mara.jacket", to: "put_away" },
      ],
      world,
    );
    const idOf = (handle: string): string => world.table.entries.find((e) => e.handle === handle)?.garmentId ?? "";
    expect(garmentInstanceById(result.store, idOf("mara.shirt"))?.locus).toEqual({ kind: "held", actorId: MARA });
    expect(garmentInstanceById(result.store, idOf("mara.jacket"))?.locus).toEqual({
      kind: "wardrobe",
      ownerId: MARA,
    });
  });

  it("closure — a fastener series opens top-down, and `openFasteners` is honored", () => {
    const world = scene();
    const result = fold(
      [{ op: "closure", garment: "mara.shirt", part: "front_panel", state: "partly_open", openFasteners: 2 }],
      world,
    );
    const shirtId = world.table.entries[0]?.garmentId ?? "";
    expect(garmentInstanceById(result.store, shirtId)?.presentation.closure.front_panel).toEqual({
      kind: "fastener_series",
      openFastenerIndexes: [0, 1],
    });
  });

  it("closure — a part with no closure BEHAVIOR is dropped, the coverage-bearing one is not", () => {
    const world = scene();
    const result = fold([{ op: "closure", garment: "mara.jacket", part: "placket", state: "open" }], world);
    // The outerwear template binds the closure to the coverage-bearing front panel
    // (OQ6), so the placket strip itself has no channel — the dispatcher says so.
    expectDiagnostic(result.sink, "garment_op.channel_unbound");
    expect(result.trace[0]?.outcome).toBe("rejected");

    const onPanel = fold([{ op: "closure", garment: "mara.jacket", part: "front_panel", state: "open" }], scene());
    const jacketId = onPanel.table.entries.find((e) => e.handle === "mara.jacket")?.garmentId ?? "";
    expect(garmentInstanceById(onPanel.store, jacketId)?.presentation.closure.front_panel).toEqual({
      kind: "fastener_series",
      openFastenerIndexes: [0, 1, 2, 3, 4],
    });
  });

  it("closure — a CONTINUOUS (zip) part takes an openness, never a fastener list", () => {
    const world = scene([seed("i3", "linen dress", "dress")]);
    const result = fold([{ op: "closure", garment: "mara.dress", part: "bodice_back", state: "open" }], world);
    const dressId = world.table.entries.find((e) => e.handle === "mara.dress")?.garmentId ?? "";
    expect(garmentInstanceById(result.store, dressId)?.presentation.closure.bodice_back).toEqual({
      kind: "continuous",
      openness: GARMENT_UNIT_ONE,
    });
    // `open` is OPEN, never REMOVED — the dress is still worn.
    expect(garmentInstanceById(result.store, dressId)?.locus).toEqual({ kind: "worn", actorId: MARA });
  });

  it("roll / tuck / displace / restore all land on the presentation graph", () => {
    const world = scene();
    const result = fold(
      [
        { op: "roll", garment: "mara.shirt", part: "sleeve_left", degree: "substantial" },
        { op: "tuck", garment: "mara.shirt", part: "hem", state: "in" },
      ],
      world,
    );
    const shirtId = world.table.entries[0]?.garmentId ?? "";
    const presentation = garmentInstanceById(result.store, shirtId)?.presentation;
    expect(presentation?.roll.sleeve_left).toBeGreaterThan(0);
    // Asymmetry is native — the right sleeve is untouched.
    expect(presentation?.roll.sleeve_right).toBeUndefined();
    expect(presentation?.tuck.hem).toBe("in");

    const restored = applyGarmentProposals([{ op: "restore", garment: "mara.shirt", parts: ["sleeve_left", "hem"] }], {
      store: result.store,
      table: world.table,
      atMinutes: 130,
      mintId: counterIds("r"),
    });
    const after = garmentInstanceById(restored.store, shirtId)?.presentation;
    expect(after?.roll.sleeve_left).toBeUndefined();
    expect(after?.tuck.hem).toBeUndefined();
  });

  it("condition with an EMPTY part list is legal and means the whole garment (F16 — not a fallback)", () => {
    const world = scene();
    const result = fold(
      [
        {
          op: "condition",
          garment: "mara.shirt",
          parts: [],
          channel: "wetness",
          direction: "increase",
          degree: "substantial",
        },
      ],
      world,
    );
    const shirtId = world.table.entries[0]?.garmentId ?? "";
    expect(garmentInstanceById(result.store, shirtId)?.condition.base.wetness).toBeGreaterThan(0);
    expect(result.trace[0]?.outcome).toBe("applied");
    // No diagnostic at all — a garment-scoped change is first class (OQ7).
    expectCleanSink(result.sink);
  });

  it("deposit / clean / damage land as located facts", () => {
    const world = scene();
    const shirtId = world.table.entries[0]?.garmentId ?? "";
    const deposited = fold(
      [{ op: "deposit", garment: "mara.shirt", parts: ["hem"], substance: "mud", degree: "substantial" }],
      world,
    );
    expect(garmentInstanceById(deposited.store, shirtId)?.condition.deposits[0]).toMatchObject({
      kind: "mud",
      partIds: ["hem"],
    });

    const damaged = applyGarmentProposals(
      [{ op: "damage", garment: "mara.shirt", part: "sleeve_left", damage: "tear", degree: "moderate" }],
      { store: deposited.store, table: world.table, atMinutes: 140, mintId: counterIds("d") },
    );
    expect(garmentInstanceById(damaged.store, shirtId)?.condition.damageMarks[0]).toMatchObject({
      kind: "tear",
      partId: "sleeve_left",
    });

    // A wash removes the deposit and RETAINS the tear (F10).
    const cleaned = applyGarmentProposals([{ op: "clean", garment: "mara.shirt", parts: [], target: "clean" }], {
      store: damaged.store,
      table: world.table,
      atMinutes: 150,
      mintId: counterIds("c"),
    });
    const condition = garmentInstanceById(cleaned.store, shirtId)?.condition;
    expect(condition?.deposits).toEqual([]);
    expect(condition?.damageMarks).toHaveLength(1);
    expect(condition?.base.cleanliness).toBeGreaterThan(GARMENT_UNIT_ONE / 2);
  });
});

describe("unresolvable handles drop with the right code (OQ7)", () => {
  it("an unknown GARMENT handle drops with `garment_op.garment_unresolved` and changes nothing", () => {
    const world = scene();
    const before = JSON.stringify(world.store);
    const result = fold([{ op: "roll", garment: "mara.trenchcoat", part: "sleeve_left", degree: "slight" }], world);
    expect(result.applied).toBe(0);
    expect(JSON.stringify(result.store)).toBe(before);
    expectDiagnostics(result.sink, ["garment_op.garment_unresolved"]);
    expect(result.trace[0]).toMatchObject({
      op: "roll",
      garment: "mara.trenchcoat",
      garmentId: "",
      outcome: "rejected",
      code: "garment_op.garment_unresolved",
    });
  });

  it("F15 — an unknown PART handle drops with `garment_op.part_unresolved`, never widened to the root", () => {
    const world = scene();
    const before = JSON.stringify(world.store);
    const result = fold([{ op: "roll", garment: "mara.shirt", part: "sleeve_middle", degree: "substantial" }], world);
    expect(result.applied).toBe(0);
    expect(JSON.stringify(result.store)).toBe(before);
    expectDiagnostics(result.sink, ["garment_op.part_unresolved"]);
    expect(result.trace[0]?.code).toBe("garment_op.part_unresolved");
  });

  it("a presentation op NEVER falls back to the root when the part list is empty", () => {
    const world = scene();
    const before = JSON.stringify(world.store);
    const result = fold([{ op: "restore", garment: "mara.shirt", parts: [] }], world);
    expect(result.applied).toBe(0);
    expect(JSON.stringify(result.store)).toBe(before);
    expectDiagnostics(result.sink, ["garment_op.restore_no_parts"]);
  });

  it("an unknown part inside a condition op's LIST drops the whole operation", () => {
    const world = scene();
    const result = fold(
      [
        {
          op: "condition",
          garment: "mara.shirt",
          parts: ["hem", "epaulette"],
          channel: "wetness",
          direction: "increase",
          degree: "slight",
        },
      ],
      world,
    );
    expect(result.applied).toBe(0);
    expectDiagnostics(result.sink, ["garment_op.part_unresolved"]);
  });

  it("`left_here` with no named place drops rather than inventing a room", () => {
    const world = scene();
    const sink = new DiagnosticCollector();
    const result = applyGarmentProposals([{ op: "move", garment: "mara.jacket", to: "left_here" }], {
      store: world.store,
      table: world.table,
      atMinutes: 120,
      mintId: counterIds("x"),
      sink,
    });
    expect(result.applied).toBe(0);
    expectDiagnostics(sink, ["garment_op.place_unresolved"]);
  });

  it("a same-locus move is a legal no-op, distinct from a rejection", () => {
    const world = scene();
    const result = fold([{ op: "move", garment: "mara.shirt", to: "worn" }], world);
    expect(result.applied).toBe(0);
    expect(result.trace[0]?.outcome).toBe("no_change");
    expect(result.trace[0]?.code).toBe("");
    expectCleanSink(result.sink);
  });
});

describe("introduce — R2's guarded mint (F21)", () => {
  it("mints a real, located instance from the category template", () => {
    const world = scene();
    const result = fold(
      [
        {
          op: "introduce",
          handle: "mara.hoodie",
          name: "a borrowed grey hoodie",
          category: "outerwear",
          material: "knit",
          wearer: "mara",
          at: "worn",
        },
      ],
      world,
    );
    expect(result.applied).toBe(1);
    const minted = result.store.instances.find((i) => i.name === "a borrowed grey hoodie");
    expect(minted).toBeDefined();
    expect(minted?.locus).toEqual({ kind: "worn", actorId: MARA });
    // No library provenance — it never had a definition row (OQ2).
    expect(minted?.definitionId).toBeUndefined();
    // The blueprint is the CATEGORY template, so it can add its own coverage and
    // nothing else: a mint can never decide intimate coverage.
    const blueprint = minted ? result.store.blueprints[minted.blueprintHash] : undefined;
    expect(blueprint?.nodes.map((n) => n.id)).toEqual(expect.arrayContaining(["root", "sleeve_left", "front_panel"]));
    expect(blueprint?.nodes.every((n) => n.materialProfileId === "knit")).toBe(true);
    expect(result.trace[0]).toMatchObject({ op: "introduce", garment: "mara.hoodie", outcome: "applied" });
  });

  it("NEVER mints when the coined handle already names a garment in scope", () => {
    const world = scene();
    const result = fold(
      [
        {
          op: "introduce",
          handle: "mara.jacket",
          name: "another jacket",
          category: "outerwear",
          wearer: "mara",
          at: "worn",
        },
      ],
      world,
    );
    expect(result.applied).toBe(0);
    expect(result.store.instances).toHaveLength(world.store.instances.length);
    expectDiagnostics(result.sink, ["garment_op.introduce_duplicate"]);
  });

  it("never mints twice under one handle inside the same exchange", () => {
    const world = scene();
    const introduce = {
      op: "introduce" as const,
      handle: "mara.hoodie",
      name: "a grey hoodie",
      category: "outerwear",
      wearer: "mara",
      at: "worn" as const,
    };
    const result = fold([introduce, introduce], world);
    expect(result.store.instances.filter((i) => i.name === "a grey hoodie")).toHaveLength(1);
    expectDiagnostics(result.sink, ["garment_op.introduce_duplicate"]);
  });

  it("an unknown category still mints — as a bare garment that covers nothing", () => {
    const world = scene();
    const result = fold(
      [
        {
          op: "introduce",
          handle: "mara.thing",
          name: "a strange wrap",
          category: "toga",
          wearer: "mara",
          at: "worn",
        },
      ],
      world,
    );
    const minted = result.store.instances.find((i) => i.name === "a strange wrap");
    const blueprint = minted ? result.store.blueprints[minted.blueprintHash] : undefined;
    expect(blueprint?.nodes).toHaveLength(1);
    expect(blueprint?.nodes[0]?.baselineCoverage).toEqual([]);
    expectDiagnostic(result.sink, "garment_op.introduce_category_unknown");
  });

  it("an ambiguous wearer drops rather than dressing the wrong body", () => {
    // Both actors modelled ⇒ an unnamed wearer is a real ambiguity.
    const world = scene();
    const store = syncWornGarments({
      store: world.store,
      actorId: GARMENT_PLAYER_ACTOR,
      wornDefinitionIds: ["p1"],
      seeds: new Map([["p1", seed("p1", "blue jeans", "pants")]]),
      mintId: counterIds("p"),
      atMinutes: 0,
    });
    const table = buildGarmentHandleTable({ store, actors: ACTORS, placeName: "the study" });
    const sink = new DiagnosticCollector();
    const result = applyGarmentProposals(
      [{ op: "introduce", handle: "x.scarf", name: "a scarf", category: "top", at: "worn" }],
      { store, table, atMinutes: 120, mintId: counterIds("m"), sink },
    );
    expect(result.applied).toBe(0);
    expectDiagnostics(sink, ["garment_op.actor_unresolved"]);
  });

  it("is capped per exchange", () => {
    const world = scene();
    const proposals = Array.from({ length: GARMENT_INTRODUCE_MAX + 2 }, (_, i) => ({
      op: "introduce" as const,
      handle: `mara.new_${i}`,
      name: `garment ${i}`,
      category: "top",
      wearer: "mara",
      at: "worn" as const,
    }));
    const result = fold(proposals, world);
    expect(result.applied).toBe(GARMENT_INTRODUCE_MAX);
    expectDiagnostic(result.sink, "garment_op.introduce_capped", { times: 2 });
  });
});

describe("fiction order", () => {
  it("an introduce is addressable by a LATER proposal in the same list", () => {
    const world = scene();
    const result = fold(
      [
        {
          op: "introduce",
          handle: "mara.hoodie",
          name: "a grey hoodie",
          category: "outerwear",
          wearer: "mara",
          at: "worn",
        },
        { op: "roll", garment: "mara.hoodie", part: "sleeve_left", degree: "moderate" },
      ],
      world,
    );
    const minted = result.store.instances.find((i) => i.name === "a grey hoodie");
    expect(minted?.presentation.roll.sleeve_left).toBeGreaterThan(0);
    expect(result.trace.map((t) => t.outcome)).toEqual(["applied", "applied"]);
  });

  it("a part operation AFTER the garment is destroyed is dropped, not reordered", () => {
    const world = scene();
    const result = fold(
      [
        { op: "move", garment: "mara.jacket", to: "gone" },
        { op: "roll", garment: "mara.jacket", part: "sleeve_left", degree: "substantial" },
      ],
      world,
    );
    expect(result.trace.map((t) => t.outcome)).toEqual(["applied", "rejected"]);
    expect(result.trace[1]?.code).toBe("garment_op.presentation_on_gone");
  });

  it("the same two proposals in the OPPOSITE order both land — order is the fiction's, not ours", () => {
    const world = scene();
    const result = fold(
      [
        { op: "roll", garment: "mara.jacket", part: "sleeve_left", degree: "substantial" },
        { op: "move", garment: "mara.jacket", to: "gone" },
      ],
      world,
    );
    expect(result.trace.map((t) => t.outcome)).toEqual(["applied", "applied"]);
  });
});

describe("garmentMutationLane — which path runs", () => {
  const emptyOutfit = { description: "", removed: [], added: [] };

  it("proposals win: the legacy bridge is SKIPPED even when the free-text grammar came back too", () => {
    expect(
      garmentMutationLane({
        garmentOperations: [{ op: "roll" }],
        outfit: { description: "a black dress", removed: [], added: [] },
        playerOutfit: { description: "", removed: [], added: ["a scarf"] },
      }),
    ).toBe("operations");
  });

  it("no proposals but a free-text change ⇒ the legacy bridge", () => {
    expect(
      garmentMutationLane({ garmentOperations: [], outfit: { description: "", removed: ["her jacket"], added: [] } }),
    ).toBe("legacy");
    expect(
      garmentMutationLane({
        garmentOperations: [],
        outfit: emptyOutfit,
        playerOutfit: { description: "jeans and a tee", removed: [], added: [] },
      }),
    ).toBe("legacy");
  });

  it("nothing at all ⇒ neither path runs (the common case)", () => {
    expect(garmentMutationLane({ garmentOperations: [], outfit: emptyOutfit, playerOutfit: emptyOutfit })).toBe("none");
    expect(garmentMutationLane({ garmentOperations: [] })).toBe("none");
  });
});
