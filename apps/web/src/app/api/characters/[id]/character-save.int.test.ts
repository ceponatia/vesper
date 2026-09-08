import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { itemDefinitionSchema } from "@/contracts";
import { characterSaveConflictSchema, characterSaveSchema } from "@/lib/client/api/library";
import { pseudoEmbed } from "@/server/ai";
import { characters, db, items } from "@/server/db";
import { resetRateLimits } from "@/server/api";

const authState = vi.hoisted(() => ({ user: { id: "", email: "", name: "Character save", role: "admin" as const } }));
vi.mock("@/server/auth", async () => (await import("@/server/test-support")).routeAuthModule(authState));

import { apiRequest, bindAuthUser, endTestPool, expectApiError, expectJson, probeIntegrationDb, purgeOwnerRows, routeCtx, seedTestUser, withAuthUser } from "@/server/test-support";
import { PATCH } from "./route";

const ready = await probeIntegrationDb("character-save.int.test", "characters");
let foreignId = "";
beforeAll(async () => {
  if (!ready) return;
  bindAuthUser(authState, await seedTestUser("character-save-route", { role: "admin" }));
  foreignId = (await seedTestUser("character-save-foreign", { role: "admin" })).id;
  resetRateLimits();
});
afterAll(async () => {
  if (ready) await purgeOwnerRows([authState.user.id, foreignId]);
  await endTestPool();
});
const patch = (id: string, body: unknown) => PATCH(apiRequest(`/api/characters/${id}`, { method: "PATCH", body }), routeCtx({ id }));
async function subject(name: string) {
  const [row] = await db().insert(characters).values({ ownerId: authState.user.id, name, profile: { creationBrief: "Original human concept", bio: "Before editing" } }).returning();
  return row!;
}

describe.skipIf(!ready)("character PATCH optimistic recovery", () => {
  it("returns one save and one typed conflict for competing versions without materializing the loser", async () => {
    const row = await subject("Iris");
    const names = ["Harbor copper mantle 719", "Mountain violet boots 824"];
    const responses = await Promise.all(names.map((name) => patch(row.id, { name, expectedUpdatedAt: row.updatedAt.toISOString(), suggestedItems: [itemDefinitionSchema.parse({ name, kind: "clothing" })] })));
    expect(responses.map((response) => response.status).sort()).toEqual([200, 409]);
    const winnerResponse = characterSaveSchema.parse(await expectJson(responses.find((response) => response.status === 200)!));
    const winner = winnerResponse.character;
    const conflict = characterSaveConflictSchema.parse(await expectJson(responses.find((response) => response.status === 409)!, 409));
    expect(conflict.character).toEqual(winner);
    const created = await db().select({ name: items.name }).from(items).where(eq(items.ownerId, authState.user.id));
    expect(created.filter((item) => names.includes(item.name))).toEqual([{ name: winner.name }]);
    expect(winnerResponse.materializedSuggestions).toHaveLength(1);
    expect(winner.profile.outfits[0]?.items).toContain(winnerResponse.materializedSuggestions[0]?.itemId);
  });

  it("returns monotonic tokens for immediate saves and keeps a no-op token unchanged", async () => {
    const row = await subject("Token subject");
    const first = characterSaveSchema.parse(await expectJson(await patch(row.id, { name: "First", expectedUpdatedAt: row.updatedAt.toISOString() }))).character;
    const second = characterSaveSchema.parse(await expectJson(await patch(row.id, { name: "Second", expectedUpdatedAt: first.updatedAt }))).character;
    expect(Date.parse(first.updatedAt!)).toBeGreaterThan(row.updatedAt.getTime());
    expect(Date.parse(second.updatedAt!)).toBeGreaterThan(Date.parse(first.updatedAt!));
    const noOp = characterSaveSchema.parse(await expectJson(await patch(row.id, { expectedUpdatedAt: second.updatedAt }))).character;
    expect(noOp.updatedAt).toBe(second.updatedAt);
  });

  it("rechecks fuzzy item candidates in the save transaction using the prepared embedding", async () => {
    const row = await subject("Fuzzy save subject");
    const [existing] = await db().insert(items).values({
      ownerId: authState.user.id,
      kind: "clothing",
      name: "Faded Sky Route Shirt",
      searchEmbedding: pseudoEmbed("Route blue tee 883"),
      embedder: "pseudo",
    }).returning({ id: items.id });
    const saved = characterSaveSchema.parse(await expectJson(await patch(row.id, {
      expectedUpdatedAt: row.updatedAt.toISOString(),
      suggestedItems: [itemDefinitionSchema.parse({ kind: "clothing", name: "Route blue tee 883" })],
    })));
    expect(saved.materializedSuggestions).toEqual([{ index: 0, itemId: existing!.id }]);
    expect(saved.character.profile.outfits[0]?.items).toContain(existing!.id);
    const duplicates = await db().select({ id: items.id }).from(items)
      .where(and(eq(items.ownerId, authState.user.id), eq(items.name, "Route blue tee 883")));
    expect(duplicates).toEqual([]);
  });

  it("preserves partial merges for callers without a token and owner-only writes", async () => {
    const row = await subject("Legacy subject");
    const saved = characterSaveSchema.parse(await expectJson(await patch(row.id, { profile: { bio: "After editing" } }))).character;
    expect(saved.profile.creationBrief).toBe("Original human concept");
    expect(saved.profile.bio).toBe("After editing");
    await withAuthUser(authState, { id: foreignId }, async () => {
      await expectApiError(await patch(row.id, { name: "Foreign edit", expectedUpdatedAt: saved.updatedAt }), 404, "not_found");
    });
    const [unchanged] = await db().select().from(characters).where(eq(characters.id, row.id));
    expect(unchanged?.name).toBe(row.name);
  });
});
