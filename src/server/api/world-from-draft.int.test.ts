import { and, eq, ilike, inArray, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { z } from "zod";
import { worldDraftSchema, type WorldDraft } from "@/server/authoring";
import {
  characters,
  db,
  items,
  jobs,
  locations,
  participantRelationships,
  sessionParticipants,
  sessions,
  users,
  worldCast,
  worldItems,
  worldLinks,
  worlds,
} from "@/server/db";
import { createSessionFromWorld } from "@/server/engine";
import { setLocationLinks, worldCreateSchema, worldPatchSchema } from "@/server/api";
import { createWorldFromDraft, MAX_GENERATED_CAST, updateWorldFromDraft } from "./world-from-draft";
import { createWorld, getWorldDetail, updateWorld } from "./worlds";

/**
 * Draft-save conversion (docs/authoring.md §World forge), called directly —
 * the route suite covers the HTTP envelope. Pins the generation cap, the
 * partial-failure stub policy (a failed forge degrades to a stub; the save
 * itself never fails), and library item reuse by name. Demo mode (AI_FAKE=1,
 * forced by the global setup) makes every forge section degrade to schema
 * defaults — the same code path a live generation failure takes, since cast
 * generation runs with useFallbacks: false.
 */

async function probe(): Promise<boolean> {
  let timer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      db().execute(sql`select 1 from worlds limit 1`),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error("connect timeout")), 4000);
      }),
    ]);
    return true;
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    process.stderr.write(`[world-from-draft.int.test] skipping: database unreachable or unmigrated: ${reason}\n`);
    return false;
  } finally {
    clearTimeout(timer);
  }
}

const ready = await probe();
let ownerId = "";

function draft(over: Partial<z.input<typeof worldDraftSchema>> = {}): WorldDraft {
  return worldDraftSchema.parse({ name: "Draft World", description: "A foggy test town.", ...over });
}

/** Fire-and-forget embed_refresh jobs settle before cleanup deletes their rows. */
async function settleEmbedJobs(timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const rows = await db()
      .select({ id: jobs.id })
      .from(jobs)
      .where(and(eq(jobs.type, "embed_refresh"), inArray(jobs.status, ["queued", "running"])))
      .limit(1);
    if (rows.length === 0 || Date.now() > deadline) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

beforeAll(async () => {
  if (!ready) return;
  const [user] = await db()
    .insert(users)
    .values({ email: `world-from-draft-int-${Date.now()}@test.local`, name: "Drafter" })
    .returning({ id: users.id });
  if (!user) throw new Error("user insert failed");
  ownerId = user.id;
});

afterAll(async () => {
  if (ready && ownerId) {
    await settleEmbedJobs();
    await db().delete(sessions).where(eq(sessions.ownerId, ownerId));
    await db().delete(worlds).where(eq(worlds.ownerId, ownerId));
    await db().delete(characters).where(eq(characters.ownerId, ownerId));
    await db().delete(items).where(eq(items.ownerId, ownerId));
    await db().delete(locations).where(eq(locations.ownerId, ownerId));
    await db().delete(users).where(eq(users.id, ownerId));
  }
  await globalThis.__vesperPool?.end();
  globalThis.__vesperPool = undefined;
});

describe.skipIf(!ready)("createWorldFromDraft (demo mode)", () => {
  it("caps generated cast at MAX_GENERATED_CAST with a diagnostic; the world still saves", async () => {
    const names = ["Capped One", "Capped Two", "Capped Three", "Capped Four"];
    const result = await createWorldFromDraft(
      ownerId,
      draft({
        name: "Capped World",
        castSuggestions: names.map((name) => ({
          name,
          conceptNote: `${name.toLowerCase()} concept`,
          role: "npc" as const,
          tier: "minor" as const,
        })),
      }),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const capped = result.diagnostics.filter((d) => d.code === "api.world.from_draft.cast_capped");
    expect(capped).toHaveLength(1);
    expect(capped[0]?.message).toContain("Capped Four");

    const castRows = await db().select().from(worldCast).where(eq(worldCast.worldId, result.worldId));
    expect(castRows).toHaveLength(MAX_GENERATED_CAST);

    const created = await db()
      .select({ name: characters.name })
      .from(characters)
      .where(and(eq(characters.ownerId, ownerId), inArray(characters.name, names)));
    expect(created.map((c) => c.name).sort()).toEqual(["Capped One", "Capped Three", "Capped Two"]);
  });

  it("recreates library connections as world_links when linked locations are imported", async () => {
    const made = await db()
      .insert(locations)
      .values([
        { ownerId, name: "Imported Quay" },
        { ownerId, name: "Imported Market" },
      ])
      .returning({ id: locations.id, name: locations.name });
    const [quay, market] = made;
    await setLocationLinks(ownerId, quay!.id, [market!.id]);

    const result = await createWorld(
      ownerId,
      worldCreateSchema.parse({
        name: "Propagation World",
        locations: [
          { locationId: quay!.id, name: quay!.name },
          { locationId: market!.id, name: market!.name },
        ],
      }),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    // The library Quay↔Market connection propagated into the world's map.
    const links = await db().select().from(worldLinks).where(eq(worldLinks.worldId, result.worldId));
    expect(links).toHaveLength(1);
  });

  it("re-saving a world with a name-only location reuses its row instead of duplicating (§5)", async () => {
    const created = await createWorld(
      ownerId,
      worldCreateSchema.parse({ name: "Resave World", locations: [{ name: "Repeat Room" }] }),
    );
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    // Two more saves sending the SAME name-only location (no locationId) — the
    // editor-not-round-tripping case that used to spawn a fresh library row each time.
    for (let i = 0; i < 2; i++) {
      const updated = await updateWorld(
        ownerId,
        created.worldId,
        worldPatchSchema.parse({ locations: [{ name: "Repeat Room" }] }),
      );
      expect(updated.ok).toBe(true);
    }

    // One library location named "Repeat Room", reused across saves — not three.
    const rows = await db()
      .select({ id: locations.id })
      .from(locations)
      .where(and(eq(locations.ownerId, ownerId), eq(locations.name, "Repeat Room")));
    expect(rows).toHaveLength(1);
  });

  it("a failed forge degrades to a stub character (conceptNote bio, stub tag) with a diagnostic", async () => {
    const result = await createWorldFromDraft(
      ownerId,
      draft({
        name: "Stub World",
        castSuggestions: [{ name: "Stub Clerk", conceptNote: "a wary night clerk", role: "npc", tier: "minor" }],
      }),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    // The save succeeded despite generation being unavailable…
    const [worldRow] = await db().select().from(worlds).where(eq(worlds.id, result.worldId)).limit(1);
    expect(worldRow?.name).toBe("Stub World");

    // …and the degraded character is a tagged stub carrying the concept note.
    expect(result.diagnostics.map((d) => d.code)).toContain("api.world.from_draft.cast_saved_as_stub");
    const [stub] = await db()
      .select()
      .from(characters)
      .where(and(eq(characters.ownerId, ownerId), eq(characters.name, "Stub Clerk")))
      .limit(1);
    expect(stub).toBeDefined();
    expect(stub?.tags).toContain("stub");
    expect((stub?.profile as { bio: string }).bio).toBe("a wary night clerk");

    const castRows = await db().select().from(worldCast).where(eq(worldCast.worldId, result.worldId));
    expect(castRows.map((c) => c.characterId)).toContain(stub?.id);
  });

  it("cast relationship suggestions persist to world_cast and seed participant_relationships at spawn", async () => {
    // Forge-suggested edges (phase-2-plan T12): a player edge whose conceptNote
    // names a mutual bond, and an unrequited NPC→NPC edge. In demo mode the
    // cast degrades to stubs, so each stub's bio IS its conceptNote — exactly
    // the text the bond classifier reads at spawn.
    const result = await createWorldFromDraft(
      ownerId,
      draft({
        name: "Bonded World",
        locations: [{ name: "Quay", description: "A granite quay.", links: [] }],
        playerStartLocationName: "Quay",
        castSuggestions: [
          {
            name: "Anchor Anna",
            conceptNote: "Harbor-master; an old friend of the player from the ferry years.",
            role: "companion",
            tier: "major",
            startLocationName: "Quay",
            relationships: [{ toward: "player", stage: "friendly" }],
          },
          {
            name: "Clerk Bo",
            conceptNote: "A nervous customs clerk; a rival of the harbor-master Anchor Anna.",
            role: "npc",
            tier: "minor",
            startLocationName: "Quay",
            relationships: [{ toward: "Anchor Anna", stage: "wary" }],
          },
        ],
      }),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    // The suggestions rode the save into world_cast.relationships unchanged.
    const castRows = await db().select().from(worldCast).where(eq(worldCast.worldId, result.worldId));
    expect(castRows).toHaveLength(2);
    const savedRelationships = castRows.flatMap((r) => r.relationships as Array<{ toward: string; stage: string }>);
    expect(savedRelationships).toContainEqual({ toward: "player", stage: "friendly" });
    expect(savedRelationships).toContainEqual({ toward: "Anchor Anna", stage: "wary" });

    // Spawning the saved world wires participant_relationships from them.
    const created = await createSessionFromWorld({ worldId: result.worldId, userId: ownerId, title: "Bond spawn", embodied: true });
    expect(created).not.toBeNull();
    if (!created) return;

    const participants = await db().select().from(sessionParticipants).where(eq(sessionParticipants.sessionId, created.sessionId));
    const anna = participants.find((p) => p.displayName === "Anchor Anna");
    const bo = participants.find((p) => p.displayName === "Clerk Bo");
    const player = participants.find((p) => p.isUser);
    if (!anna || !bo || !player) throw new Error("participants missing");

    const rows = await db()
      .select()
      .from(participantRelationships)
      .where(eq(participantRelationships.sessionId, created.sessionId));
    const edge = (fromId: string, toId: string, kind: string) =>
      rows.find((r) => r.fromParticipantId === fromId && r.toParticipantId === toId && r.kind === kind);

    // Anna→player feeling at the friendly midpoint; perceived mirrors it
    // because her stub bio names a mutual-knowledge bond ("an old friend").
    expect(edge(anna.id, player.id, "feeling")).toMatchObject({ value: 47, stage: "friendly" });
    expect(edge(anna.id, player.id, "perceived")).toMatchObject({ value: 47, stage: "friendly" });

    // Bo→Anna wary, with the implied reverse edge at the same midpoint.
    expect(edge(bo.id, anna.id, "feeling")).toMatchObject({ value: -32, stage: "wary" });
    expect(edge(anna.id, bo.id, "feeling")).toMatchObject({ value: -32, stage: "wary" });
    expect(rows).toHaveLength(4);
  });

  it("location order survives save → detail, and a reordered edit-save persists the new order", async () => {
    // Names chosen so neither alphabetical nor reverse-insertion order could
    // accidentally pass — only world_locations.sort produces this sequence.
    const names = ["Mill", "Attic", "Quarry"];
    const result = await createWorldFromDraft(
      ownerId,
      draft({
        name: "Ordered World",
        locations: names.map((name) => ({ name, description: `${name} description.`, links: [] })),
      }),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const detail = await getWorldDetail(ownerId, result.worldId);
    expect(detail?.locations.map((l) => l.name)).toEqual(names);

    // Reorder through the edit-save path (the editor's drag-reorder persists this way).
    const reordered = ["Quarry", "Mill", "Attic"];
    const updated = await updateWorldFromDraft(
      ownerId,
      result.worldId,
      draft({
        name: "Ordered World",
        locations: reordered.map((name) => ({ name, description: `${name} description.`, links: [] })),
      }),
    );
    expect(updated.ok).toBe(true);

    const after = await getWorldDetail(ownerId, result.worldId);
    expect(after?.locations.map((l) => l.name)).toEqual(reordered);
  });

  it("reuses library items by name instead of duplicating them; unmatched names create new items", async () => {
    const [lantern] = await db()
      .insert(items)
      .values({ ownerId, kind: "object", name: "Brass Lantern", description: "Salt-pitted brass." })
      .returning({ id: items.id });
    if (!lantern) throw new Error("item insert failed");

    const result = await createWorldFromDraft(
      ownerId,
      draft({
        name: "Reuse World",
        locations: [{ name: "Shed", description: "A lean-to shed.", links: [] }],
        itemPlacements: [
          {
            itemName: "brass lantern", // case-insensitive match against the library row
            definition: { kind: "object", name: "brass lantern" },
            locationName: "Shed",
            worn: false,
            quantity: 1,
          },
          {
            itemName: "Tin Whistle",
            definition: { kind: "object", name: "Tin Whistle" },
            worn: false,
            quantity: 1,
          },
        ],
      }),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const placed = await db().select().from(worldItems).where(eq(worldItems.worldId, result.worldId));
    expect(placed).toHaveLength(2);
    expect(placed.map((p) => p.itemId)).toContain(lantern.id); // reused, not redefined

    // No duplicate lantern row was created…
    const lanternRows = await db()
      .select({ id: items.id })
      .from(items)
      .where(and(eq(items.ownerId, ownerId), ilike(items.name, "brass lantern")));
    expect(lanternRows).toHaveLength(1);
    expect(lanternRows[0]?.id).toBe(lantern.id);

    // …while the unmatched name became a new library item, linked by the placement.
    const [whistle] = await db()
      .select({ id: items.id })
      .from(items)
      .where(and(eq(items.ownerId, ownerId), eq(items.name, "Tin Whistle")))
      .limit(1);
    expect(whistle).toBeDefined();
    expect(placed.map((p) => p.itemId)).toContain(whistle?.id);
  });
});
