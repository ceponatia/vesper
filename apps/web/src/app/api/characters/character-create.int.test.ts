import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { itemDefinitionSchema } from "@/contracts";
import { characterCreationMismatchSchema, characterSaveSchema } from "@/lib/client/api/library";
import { characterCreationRequests, characters, db, items } from "@/server/db";
import { resetRateLimits } from "@/server/api";

const authState = vi.hoisted(() => ({
  user: { id: "", email: "", name: "Character create", role: "admin" as const },
}));
vi.mock("@/server/auth", async () => (await import("@/server/test-support")).routeAuthModule(authState));

import {
  apiRequest,
  bindAuthUser,
  endTestPool,
  expectJson,
  probeIntegrationDb,
  purgeOwnerRows,
  routeCtx,
  seedTestUser,
  withAuthUser,
} from "@/server/test-support";
import { POST } from "./route";

const ready = await probeIntegrationDb("character-create.int.test", "character_creation_requests");
const requestId = "67546fd0-8169-4a1a-bef1-d50b94034bc0";
let otherOwnerId = "";

beforeAll(async () => {
  if (!ready) return;
  bindAuthUser(authState, await seedTestUser("character-create-route", { role: "admin" }));
  otherOwnerId = (await seedTestUser("character-create-other", { role: "admin" })).id;
  resetRateLimits();
});

afterAll(async () => {
  if (ready) await purgeOwnerRows([authState.user.id, otherOwnerId]);
  await endTestPool();
});

function create(body: unknown) {
  return POST(apiRequest("/api/characters", { method: "POST", body }), routeCtx());
}

function draft(name: string, id = requestId) {
  return {
    creationRequestId: id,
    name,
    suggestedItems: [itemDefinitionSchema.parse({ kind: "clothing", name: `${name} copper coat` })],
  };
}

describe.skipIf(!ready)("character POST creation recovery", () => {
  it("commits one character, item, and replay receipt for concurrent retries", async () => {
    const body = draft("Concurrent Iris");
    const responses = await Promise.all([create(body), create(body)]);
    expect(responses.map((response) => response.status)).toEqual([201, 201]);
    const payloads = await Promise.all(responses.map(async (response) => characterSaveSchema.parse(await expectJson(response))));
    expect(payloads[1]).toEqual(payloads[0]);
    expect(payloads[0]?.materializedSuggestions).toHaveLength(1);

    const made = await db().select({ id: characters.id }).from(characters)
      .where(and(eq(characters.ownerId, authState.user.id), eq(characters.name, body.name)));
    expect(made).toEqual([{ id: payloads[0]!.character.id }]);
    const madeItems = await db().select({ id: items.id }).from(items)
      .where(and(eq(items.ownerId, authState.user.id), eq(items.name, `${body.name} copper coat`)));
    expect(madeItems).toEqual([{ id: payloads[0]!.materializedSuggestions[0]!.itemId }]);
    const receipts = await db().select().from(characterCreationRequests)
      .where(and(eq(characterCreationRequests.ownerId, authState.user.id), eq(characterCreationRequests.requestId, requestId)));
    expect(receipts).toHaveLength(1);
    expect(receipts[0]?.characterId).toBe(payloads[0]?.character.id);
  });

  it("rejects the same request id with a different payload without creating or overwriting rows", async () => {
    const id = "3e17b15e-a882-4457-9a33-ac3762d640a8";
    const first = characterSaveSchema.parse(await expectJson(await create(draft("Stable Nora", id))));
    await db().update(characters).set({ name: "Server Nora", updatedAt: new Date("2026-09-07T19:00:00.000Z") })
      .where(eq(characters.id, first.character.id));
    const mismatch = characterCreationMismatchSchema.parse(await expectJson(
      await create(draft("Different Nora", id)),
      409,
    ));
    expect(mismatch.recovery.created.character.name).toBe("Stable Nora");
    expect(mismatch.recovery.character.name).toBe("Server Nora");
    expect(mismatch.recovery.character.id).toBe(first.character.id);

    const [stored] = await db().select({ name: characters.name }).from(characters).where(eq(characters.id, first.character.id));
    expect(stored?.name).toBe("Server Nora");
    const differentCharacters = await db().select({ id: characters.id }).from(characters)
      .where(and(eq(characters.ownerId, authState.user.id), eq(characters.name, "Different Nora")));
    const differentItems = await db().select({ id: items.id }).from(items)
      .where(and(eq(items.ownerId, authState.user.id), eq(items.name, "Different Nora copper coat")));
    expect(differentCharacters).toEqual([]);
    expect(differentItems).toEqual([]);
  });

  it("scopes the same request UUID independently per owner", async () => {
    const id = "8b95bb97-e9d1-47a1-9536-b99552ec46bd";
    const first = characterSaveSchema.parse(await expectJson(await create(draft("Owner One", id))));
    const second = await withAuthUser(authState, { id: otherOwnerId }, async () =>
      characterSaveSchema.parse(await expectJson(await create(draft("Owner Two", id)))),
    );
    expect(second.character.id).not.toBe(first.character.id);
    const receipts = await db().select({ ownerId: characterCreationRequests.ownerId }).from(characterCreationRequests)
      .where(eq(characterCreationRequests.requestId, id));
    expect(receipts.map((row) => row.ownerId).sort()).toEqual([authState.user.id, otherOwnerId].sort());
  });

  it("removes the request receipt when its character is deleted", async () => {
    const id = "1a73111b-7219-470c-960d-488b6ec35437";
    const made = characterSaveSchema.parse(await expectJson(await create(draft("Ephemeral June", id))));
    await db().delete(characters).where(eq(characters.id, made.character.id));
    const receipts = await db().select({ requestId: characterCreationRequests.requestId })
      .from(characterCreationRequests)
      .where(and(eq(characterCreationRequests.ownerId, authState.user.id), eq(characterCreationRequests.requestId, id)));
    expect(receipts).toEqual([]);
  });
});
