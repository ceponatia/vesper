import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DiagnosticCollector, itemDefinitionSchema } from "@/contracts";
import { pseudoEmbed } from "@/server/ai/embeddings";
import { db, items, users } from "@/server/db";
import { materializeSuggestedItems } from "@/server/api";

// Demo-mode integration suite for the outfit-item dedupe ladder
// (docs/authoring.md §Saving drafts): exact-name reuse → conservative embedding
// backstop → fresh insert. pseudoEmbed is near-orthogonal across distinct
// strings, so the embedding path is forced by seeding an existing item's stored
// vector to the suggestion's exact text under a non-matching name. Self-skips
// when the database is unreachable.

async function probe(): Promise<boolean> {
  let timer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      db().execute(sql`select 1 from items limit 1`),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error("connect timeout")), 4000);
      }),
    ]);
    return true;
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    process.stderr.write(`[library.int.test] skipping integration suite — database unreachable or unmigrated: ${reason}\n`);
    return false;
  } finally {
    clearTimeout(timer);
  }
}

const ready = await probe();

let ownerId: string;

const suggest = (name: string) => itemDefinitionSchema.parse({ kind: "clothing", name });

afterAll(async () => {
  if (ready && ownerId) {
    await db().delete(items).where(eq(items.ownerId, ownerId));
    await db().delete(users).where(eq(users.id, ownerId));
  }
  await globalThis.__vesperPool?.end();
  globalThis.__vesperPool = undefined;
});

describe.skipIf(!ready)("materializeSuggestedItems dedupe", () => {
  beforeAll(async () => {
    const [user] = await db()
      .insert(users)
      .values({ email: `library-int-${Date.now()}@test.local`, name: "Library Int" })
      .returning({ id: users.id });
    if (!user) throw new Error("user insert failed");
    ownerId = user.id;
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
});
