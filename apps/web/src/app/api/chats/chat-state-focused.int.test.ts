import { and, eq } from "drizzle-orm";
import type { NextRequest } from "next/server";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { characterChats, characterChatState, characters, db } from "@/server/db";

const authState = vi.hoisted(() => ({
  user: { id: "", email: "", name: "Focused State Int", role: "admin" as const },
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
} from "@/server/test-support";
import { POST as chatsCreate } from "./route";
import { PATCH as scenarioPatch } from "./[chatId]/scenario/route";
import { PATCH as participantStatePatch } from "./[chatId]/participants/[characterId]/state/route";

const ready = await probeIntegrationDb("chat-state-focused.int.test", "character_chat_state");

type Fixture = { characterId: string; chatId: string };
let fixture: Fixture = { characterId: "", chatId: "" };

async function stateRow() {
  const [row] = await db()
    .select()
    .from(characterChatState)
    .where(and(eq(characterChatState.chatId, fixture.chatId), eq(characterChatState.characterId, fixture.characterId)))
    .limit(1);
  return row ?? null;
}

async function premise() {
  const [row] = await db()
    .select({ premise: characterChats.premise })
    .from(characterChats)
    .where(eq(characterChats.id, fixture.chatId))
    .limit(1);
  return row?.premise ?? "";
}

beforeAll(async () => {
  if (!ready) return;
  const user = await seedTestUser("chat-state-focused-int", { name: "Focused State Int", role: "admin" });
  bindAuthUser(authState, user);
  const [character] = await db()
    .insert(characters)
    .values({ ownerId: user.id, name: "Focused Mara", profile: {} })
    .returning();
  if (!character) throw new Error("failed to seed focused-state character");
  const response = await chatsCreate(
    apiRequest("/api/chats", { body: { characterIds: [character.id], memory: "fresh" } }),
    routeCtx(),
  );
  const created = await expectJson<{ id: string }>(response, 201);
  fixture = { characterId: character.id, chatId: created.id };
});

afterAll(async () => {
  if (!ready) return;
  await purgeOwnerRows([authState.user.id]);
  await endTestPool();
});

describe.runIf(ready)("focused chat-state resources", () => {
  it("scenario-only PATCH does not seed a participant state row", async () => {
    expect(await stateRow()).toBeNull();
    const request = apiRequest(`/api/chats/${fixture.chatId}/scenario`, {
      method: "PATCH",
      body: { premise: "A quiet station platform." },
    });
    const response = await scenarioPatch(request as NextRequest, routeCtx({ chatId: fixture.chatId }));
    await expectJson(response, 200);
    expect(await premise()).toBe("A quiet station platform.");
    expect(await stateRow()).toBeNull();
  });

  it("participant-state PATCH seeds the row without rewriting scenario", async () => {
    const request = apiRequest(
      `/api/chats/${fixture.chatId}/participants/${fixture.characterId}/state`,
      { method: "PATCH", body: { regard: 23, mindNote: "Watching the departures board." } },
    );
    const response = await participantStatePatch(
      request as NextRequest,
      routeCtx({ chatId: fixture.chatId, characterId: fixture.characterId }),
    );
    const view = await expectJson<{ regard: number; mindNote: string }>(response, 200);
    expect(view.regard).toBe(23);
    expect(view.mindNote).toBe("Watching the departures board.");
    expect((await stateRow())?.regard).toBe(23);
    expect(await premise()).toBe("A quiet station platform.");
  });

  it("rejects a character outside the roster", async () => {
    const request = apiRequest(
      `/api/chats/${fixture.chatId}/participants/not-a-member/state`,
      { method: "PATCH", body: { regard: 50 } },
    );
    const response = await participantStatePatch(
      request as NextRequest,
      routeCtx({ chatId: fixture.chatId, characterId: "not-a-member" }),
    );
    expect(response.status).toBe(404);
  });
});
