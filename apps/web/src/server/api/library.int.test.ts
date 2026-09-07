import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DiagnosticCollector, itemDefinitionSchema } from "@/contracts";
import { pseudoEmbed } from "@/server/ai";
import { db, items, locations } from "@/server/db";
import { endTestPool, probeIntegrationDb, purgeOwnerRows, seedTestUser } from "@/server/test-support";
import {
  connectedLocationIds,
  loadLocationLinks,
  materializeSuggestedItems,
  searchLibraryIds,
  setLocationLinks,
} from "@/server/api";

// Demo-mode integration suite for the outfit-item dedupe ladder
// (docs/authoring/character-forge.md §Saving a draft): exact-name reuse →
// conservative embedding backstop → fresh insert. pseudoEmbed is
// near-orthogonal across distinct
// strings, so the embedding path is forced by seeding an existing item's stored
// vector to the suggestion's exact text under a non-matching name. Self-skips
// when the database is unreachable, except under strict integration mode
// (`pnpm test:int:strict`), where it fails instead.

const ready = await probeIntegrationDb("library.int.test", "items");

let ownerId = "";
let facetOwnerId = "";

const suggest = (name: string) => itemDefinitionSchema.parse({ kind: "clothing", name });

afterAll(async () => {
  if (ready) await purgeOwnerRows([ownerId, facetOwnerId]);
  await endTestPool();
});

describe.skipIf(!ready)("materializeSuggestedItems dedupe", () => {
  beforeAll(async () => {
    ownerId = (await seedTestUser("library-int")).id;
  });

  it("reuses an existing same-name item without inserting a duplicate", async () => {
    const [existing] = await db()
      .insert(items)
      .values({ ownerId, kind: "clothing", name: "Green Hoodie" })
      .returning({ id: items.id });
    const sink = new DiagnosticCollector();
    const ids = await materializeSuggestedItems(ownerId, [suggest("green hoodie")], sink);
    expect(ids).toEqual([existing!.id]);
    expect(sink.items.some((d) => d.code === "api.library.suggested_item.reused")).toBe(true);
  });

  it("reuses a near-identical existing item via the embedding backstop", async () => {
    // Name dodges the exact-name query; the stored vector equals what the
    // suggestion embeds to, so the conservative backstop collapses it.
    const [existing] = await db()
      .insert(items)
      .values({ ownerId, kind: "clothing", name: "Faded Sky Shirt", searchEmbedding: pseudoEmbed("Blue Tee"), embedder: "pseudo" })
      .returning({ id: items.id });
    const sink = new DiagnosticCollector();
    const ids = await materializeSuggestedItems(ownerId, [suggest("Blue Tee")], sink);
    expect(ids).toEqual([existing!.id]);
    expect(sink.items.some((d) => d.code === "api.library.suggested_item.fuzzy_reused")).toBe(true);
  });

  it("inserts a fresh row when nothing is similar enough", async () => {
    const before = await db().select({ id: items.id }).from(items).where(eq(items.ownerId, ownerId));
    const sink = new DiagnosticCollector();
    const ids = await materializeSuggestedItems(ownerId, [suggest("Unmistakably Unique Garment 9000")], sink);
    expect(ids).toHaveLength(1);
    expect(before.map((r) => r.id)).not.toContain(ids[0]);
    expect(sink.items.some((d) => d.code === "api.library.suggested_item.fuzzy_reused")).toBe(false);
    const [row] = await db().select({ tags: items.tags }).from(items).where(eq(items.id, ids[0]!));
    expect(row?.tags).toContain("suggested");
  });

  it("resolves an uncommitted fuzzy candidate through the materialization transaction", async () => {
    await db().transaction(async (tx) => {
      const [candidate] = await tx.insert(items).values({ ownerId, kind: "clothing", name: "Uncommitted Fuzzy Mantle", searchEmbedding: pseudoEmbed("Transaction copper robe"), embedder: "pseudo" }).returning({ id: items.id });
      const sink = new DiagnosticCollector();
      const created: string[] = [];
      const ids = await materializeSuggestedItems(ownerId, [suggest("Transaction copper robe")], sink, { executor: tx, onCreated: (id) => created.push(id) });
      expect(ids).toEqual([candidate!.id]);
      expect(created).toEqual([]);
      expect(sink.items.some((item) => item.code === "api.library.suggested_item.fuzzy_reused")).toBe(true);
    });
  });

  it("persists the clothing category into the stored definition", async () => {
    // Regression: the category template anchors coverage semantics and must
    // survive materialization, not get dropped on insert
    // (docs/contracts/items/README.md §Clothing categories).
    const suggestion = itemDefinitionSchema.parse({
      kind: "clothing",
      name: "Forge Category Probe Garment",
      category: "bra",
    });
    const sink = new DiagnosticCollector();
    const ids = await materializeSuggestedItems(ownerId, [suggestion], sink);
    expect(ids).toHaveLength(1);
    const [row] = await db().select({ definition: items.definition }).from(items).where(eq(items.id, ids[0]!));
    expect((row?.definition as { category?: string }).category).toBe("bra");
  });

  it("does not collapse a deliberately-distinct same-kind garment (conservative threshold)", async () => {
    const sink = new DiagnosticCollector();
    const ids = await materializeSuggestedItems(ownerId, [suggest("Heavy Leather Trench Coat")], sink);
    expect(sink.items.some((d) => d.code === "api.library.suggested_item.fuzzy_reused")).toBe(false);
    expect(ids).toHaveLength(1);
  });

  it("never reuses across item kinds — a clothing suggestion ignores a matching object", async () => {
    // Object whose stored vector equals the clothing suggestion's text; the
    // itemKind filter must keep it out of the clothing dedupe.
    await db()
      .insert(items)
      .values({ ownerId, kind: "object", name: "Old Clay Vessel", searchEmbedding: pseudoEmbed("Ceramic Mug Special"), embedder: "pseudo" });
    const sink = new DiagnosticCollector();
    const ids = await materializeSuggestedItems(ownerId, [suggest("Ceramic Mug Special")], sink);
    expect(sink.items.some((d) => d.code === "api.library.suggested_item.fuzzy_reused")).toBe(false);
    expect(ids).toHaveLength(1);
    const [row] = await db().select({ kind: items.kind }).from(items).where(eq(items.id, ids[0]!));
    expect(row?.kind).toBe("clothing");
  });

  it("reconciles undirected location connections — set, load by name, and remove", async () => {
    const made = await db()
      .insert(locations)
      .values([
        { ownerId, name: "Conn Lobby" },
        { ownerId, name: "Conn Hallway" },
        { ownerId, name: "Conn Office" },
      ])
      .returning({ id: locations.id });
    const [lobby, hallway, office] = made.map((m) => m.id);

    await setLocationLinks(ownerId, lobby!, [hallway!, office!]);
    expect((await connectedLocationIds(ownerId, lobby!)).sort()).toEqual([hallway, office].sort());
    expect(await connectedLocationIds(ownerId, hallway!)).toEqual([lobby]); // undirected
    expect((await loadLocationLinks(ownerId, lobby!)).map((l) => l.name).sort()).toEqual(["Conn Hallway", "Conn Office"]);

    // Reconcile lobby down to just office: the hallway link is removed, office not doubled.
    await setLocationLinks(ownerId, lobby!, [office!]);
    expect(await connectedLocationIds(ownerId, lobby!)).toEqual([office]);
    expect(await connectedLocationIds(ownerId, hallway!)).toEqual([]);
  });

  it("drops self-links and unknown targets when reconciling connections", async () => {
    const [solo] = await db().insert(locations).values({ ownerId, name: "Conn Solo" }).returning({ id: locations.id });
    await setLocationLinks(ownerId, solo!.id, [solo!.id, "nonexistent-location-id"]);
    expect(await connectedLocationIds(ownerId, solo!.id)).toEqual([]);
  });
});

// Item facet filtering: definition-jsonb conditions applied before the result
// cap, wearer's absent/unisex-match-everything semantics, multi-tag AND, and
// name sort.
describe.skipIf(!ready)("searchLibraryIds item facets", () => {
  let blouse: string;
  let jeans: string;
  let vest: string;
  let kettle: string;

  beforeAll(async () => {
    facetOwnerId = (await seedTestUser("library-facets")).id;
    const made = await db()
      .insert(items)
      .values([
        {
          ownerId: facetOwnerId,
          kind: "clothing",
          name: "Facet Blouse",
          tags: ["work", "summer"],
          definition: { category: "top", layer: 1, wearer: "feminine", color: { family: "blue", shade: "sky" } },
        },
        {
          ownerId: facetOwnerId,
          kind: "clothing",
          name: "Facet Jeans",
          tags: ["work"],
          definition: { category: "pants", layer: 1, wearer: "unisex", color: { family: "blue" } },
        },
        {
          // No wearer, no color: must still match every wearer filter.
          ownerId: facetOwnerId,
          kind: "clothing",
          name: "Facet Vest",
          definition: { category: "top", layer: 2 },
        },
        {
          ownerId: facetOwnerId,
          kind: "object",
          name: "Facet Kettle",
          definition: { subtype: "tool", color: { family: "red" } },
        },
      ])
      .returning({ id: items.id });
    [blouse, jeans, vest, kettle] = made.map((m) => m.id) as [string, string, string, string];
  });

  it("filters by clothing category and object subtype", async () => {
    const tops = await searchLibraryIds("item", facetOwnerId, { itemFacets: { category: "top" } });
    expect(tops.sort()).toEqual([blouse, vest].sort());
    const tools = await searchLibraryIds("item", facetOwnerId, { itemFacets: { subtype: "tool" } });
    expect(tools).toEqual([kettle]);
  });

  it("wearer filter: gendered filter matches its own + unisex + unspecified", async () => {
    const womens = await searchLibraryIds("item", facetOwnerId, { itemKind: "clothing", itemFacets: { wearer: "feminine" } });
    expect(womens.sort()).toEqual([blouse, jeans, vest].sort());
    const mens = await searchLibraryIds("item", facetOwnerId, { itemKind: "clothing", itemFacets: { wearer: "masculine" } });
    expect(mens.sort()).toEqual([jeans, vest].sort());
  });

  it("filters by color family and layer", async () => {
    const blues = await searchLibraryIds("item", facetOwnerId, { itemFacets: { colorFamily: "blue" } });
    expect(blues.sort()).toEqual([blouse, jeans].sort());
    const midLayer = await searchLibraryIds("item", facetOwnerId, { itemFacets: { layer: 2 } });
    expect(midLayer).toEqual([vest]);
  });

  it("ANDs multiple tags", async () => {
    const both = await searchLibraryIds("item", facetOwnerId, { tags: ["work", "summer"] });
    expect(both).toEqual([blouse]);
    const one = await searchLibraryIds("item", facetOwnerId, { tags: ["work"] });
    expect(one.sort()).toEqual([blouse, jeans].sort());
  });

  it("sorts by name when asked", async () => {
    const named = await searchLibraryIds("item", facetOwnerId, { sort: "name" });
    expect(named).toEqual([blouse, jeans, kettle, vest]);
  });
});
