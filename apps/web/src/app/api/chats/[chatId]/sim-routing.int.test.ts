import { eq, sql } from "drizzle-orm";
import type { NextRequest } from "next/server";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { characterProfileSchema } from "@/contracts";
import { characterChatMessages, db, simBranches, simEvents } from "@/server/db";

/**
 * Routing parity (rulings 18-19): on a sim-routed chat every POST kind either has
 * successor semantics or is refused — never the character-chat narrator. AI_FAKE ⇒
 * zero live model calls (the deterministic render). Self-skips without a database.
 */

const authState = vi.hoisted(() => ({
  user: { id: "", email: "", name: "Routing Parity", role: "user" as const },
}));

vi.mock("@/server/auth", async () => (await import("@/server/test-support")).routeAuthModule(authState));

import {
  apiRequest,
  drainStream,
  dropRoutedSimChat,
  emptyRoutedSimChat,
  expectApiError,
  expectJson,
  probeIntegrationDb,
  routeCtx,
  seedRoutedSimChat,
} from "@/server/test-support";
import { GET as chatGet, POST as chatSend } from "./route";
import { POST as attachmentUpload } from "./attachments/route";
import { DELETE as messageDelete, PATCH as messagePatch } from "./messages/[messageId]/route";
import { POST as scenePost } from "./scene/route";
import { PATCH as statePatch } from "./state/route";
import { POST as stopReply } from "./stop/route";
import { POST as successorCreate } from "../../successor-chats/route";

const ready = await probeIntegrationDb("sim-routing.int.test", "character_chats");

const ctx = (chatId: string) => routeCtx({ chatId });
const jsonReq = (path: string, body: unknown): NextRequest => apiRequest(path, { body });

let fixture = emptyRoutedSimChat();
/** Worlds the successor-chat provisioning minted below — each one is this suite's own. */
const worldIds: string[] = [];

beforeAll(async () => {
  if (!ready) return;
  // Every conversation here is born through `POST /api/successor-chats`, which
  // provisions its OWN world — so this suite neither seeds nor clears the shared
  // fixed rollout world.
  fixture = await seedRoutedSimChat({
    slug: "routing-parity",
    authState,
    characterName: "Abigail",
    profile: characterProfileSchema.parse({ playerRelationship: { familiarity: "close", regard: "warm" } }),
    chats: 0,
    clearWorld: false,
    seedWorld: false,
  });
});

afterAll(async () => {
  if (!ready || !fixture.userId) return;
  await dropRoutedSimChat(fixture, { worldIds, rolloutWorld: false });
});

async function provision(title: string): Promise<{ chatId: string; branchId: string }> {
  const created = await successorCreate(
    // slice 3: `requestId` is the required per-intent idempotency key.
    jsonReq("/api/successor-chats", {
      characterId: fixture.characterId,
      title,
      requestId: `routing-${title.toLowerCase().replace(/\s+/gu, "-")}-${Date.now()}`,
    }),
    routeCtx(),
  );
  const body = await expectJson<{ id: string; worldId: string; branchId: string }>(created, 201);
  worldIds.push(body.worldId);
  return { chatId: body.id, branchId: body.branchId };
}

/** Post one exchange and drain the stream so the reply settles server-side. */
async function post(chatId: string, body: unknown): Promise<Response> {
  const res = await chatSend(jsonReq(`/api/chats/${chatId}`, body), ctx(chatId));
  if (res.body) await drainStream(res);
  return res;
}

async function messageRoles(chatId: string): Promise<string[]> {
  const rows = await db()
    .select({ role: characterChatMessages.role })
    .from(characterChatMessages)
    .where(eq(characterChatMessages.chatId, chatId));
  return rows.map((r) => r.role);
}

async function messages(chatId: string): Promise<Array<{ id: string; role: string; content: string }>> {
  const rows = await db()
    .select({
      id: characterChatMessages.id,
      role: characterChatMessages.role,
      content: characterChatMessages.content,
    })
    .from(characterChatMessages)
    .where(eq(characterChatMessages.chatId, chatId))
    .orderBy(sql`${characterChatMessages.createdAt} desc, ${characterChatMessages.id} desc`);
  return rows;
}

async function eventCount(branchId: string): Promise<number> {
  const rows = await db().select({ id: simEvents.id }).from(simEvents).where(eq(simEvents.branchId, branchId));
  return rows.length;
}

async function branchSecond(branchId: string): Promise<number> {
  const [row] = await db()
    .select({ storySecond: simBranches.storySecond })
    .from(simBranches)
    .where(eq(simBranches.id, branchId));
  return row?.storySecond ?? 0;
}

describe.runIf(ready)("sim routing parity", () => {
  it("advertises the successor capability manifest and refuses unproven retakes/reruns without writes", async () => {
    const { chatId, branchId } = await provision("Regen Test");
    expect((await post(chatId, { kind: "send", content: "I look around our new home." })).status).toBe(200);

    expect((await messageRoles(chatId)).sort()).toEqual(["assistant", "user"]);
    const eventsAfterSend = await eventCount(branchId);
    const before = await messages(chatId);
    const playerMessage = before.find((message) => message.role === "user");
    if (!playerMessage) throw new Error("no player message after send");

    const envelope = await expectJson<{
      chat: {
        capabilities: {
          version: number;
          canStop: boolean;
          canAttachPhotos: boolean;
          canEditHistory: boolean;
          canDeleteHistory: boolean;
          canRerunFromMessage: boolean;
          canRetakeLatest: boolean;
          canForkFromMessage: boolean;
          canUseLegacyActionBeats: boolean;
          canUseWorldActions: boolean;
        };
      };
    }>(await chatGet(apiRequest(`/api/chats/${chatId}`), ctx(chatId)));
    expect(envelope.chat.capabilities).toEqual({
      version: 1,
      canStop: false,
      canAttachPhotos: false,
      canEditHistory: false,
      canDeleteHistory: false,
      canRerunFromMessage: false,
      canRetakeLatest: false,
      canForkFromMessage: false,
      canUseLegacyActionBeats: false,
      canUseWorldActions: true,
    });

    const regen = await chatSend(jsonReq(`/api/chats/${chatId}`, { kind: "regenerate" }), ctx(chatId));
    await expectApiError(regen, 409, "sim_unsupported_operation");
    const rerun = await chatSend(
      jsonReq(`/api/chats/${chatId}`, { kind: "rerun", messageId: playerMessage.id }),
      ctx(chatId),
    );
    await expectApiError(rerun, 409, "sim_unsupported_operation");

    expect(await messages(chatId)).toEqual(before);
    expect(await eventCount(branchId)).toBe(eventsAfterSend);
  });

  it("refuses direct history edits and deletes before touching a committed successor transcript", async () => {
    const { chatId } = await provision("History Guard Test");
    expect((await post(chatId, { kind: "send", content: "Remember this exactly." })).status).toBe(200);
    const before = await messages(chatId);
    const reply = before.find((message) => message.role === "assistant");
    if (!reply) throw new Error("no assistant reply after send");

    const edited = await messagePatch(
      apiRequest(`/api/chats/${chatId}/messages/${reply.id}`, {
        method: "PATCH",
        body: { content: "rewritten history" },
      }),
      routeCtx({ chatId, messageId: reply.id }),
    );
    await expectApiError(edited, 409, "sim_unsupported_operation");

    const deleted = await messageDelete(
      apiRequest(`/api/chats/${chatId}/messages/${reply.id}`, { method: "DELETE" }),
      routeCtx({ chatId, messageId: reply.id }),
    );
    await expectApiError(deleted, 409, "sim_unsupported_operation");

    expect(await messages(chatId)).toEqual(before);
  });

  it("keeps successor wardrobe and scene imagery on one authority boundary", async () => {
    const { chatId } = await provision("Wardrobe Authority Test");

    // The character-chat state row still exists for compatibility, but it is not
    // allowed to become a second wardrobe owner for a successor-world primary.
    const wardrobeEdit = await statePatch(
      apiRequest(`/api/chats/${chatId}/state`, {
        method: "PATCH",
        body: { outfit: "a borrowed red coat" },
      }),
      ctx(chatId),
    );
    await expectApiError(wardrobeEdit, 409, "sim_wardrobe_managed_by_world");

    // Unrelated state edits remain available; the guard is field-specific, not a
    // blanket refusal of the character sheet.
    const stateOnly = await statePatch(
      apiRequest(`/api/chats/${chatId}/state`, {
        method: "PATCH",
        body: { mindNote: "thinking about the market" },
      }),
      ctx(chatId),
    );
    expect(stateOnly.status).toBe(200);

    // The current scene-image pipeline resolves character-chat wardrobe coverage.
    // Until a simulation visual wardrobe projection exists, it must refuse rather
    // than paint a different outfit from the successor narrator's world truth.
    const scene = await scenePost(jsonReq(`/api/chats/${chatId}/scene`, {}), ctx(chatId));
    await expectApiError(scene, 409, "scene_visual_authority_unavailable");
  });

  it("continue advances time with NO player utterance (ruling 19)", async () => {
    const { chatId, branchId } = await provision("Continue Test");
    expect((await post(chatId, { kind: "send", content: "Good morning." })).status).toBe(200);

    const rolesBefore = await messageRoles(chatId);
    const usersBefore = rolesBefore.filter((r) => r === "user").length;
    const assistantsBefore = rolesBefore.filter((r) => r === "assistant").length;
    const secondBefore = await branchSecond(branchId);

    const cont = await post(chatId, { kind: "continue" });
    expect(cont.status).toBe(200);

    const rolesAfter = await messageRoles(chatId);
    expect(rolesAfter.filter((r) => r === "user").length).toBe(usersBefore); // no user row
    expect(rolesAfter.filter((r) => r === "assistant").length).toBe(assistantsBefore + 1); // a fresh reply
    expect(await branchSecond(branchId)).toBeGreaterThan(secondBefore); // the span advanced (time moved)
  });

  it("refuses attachment upload, stop, attached sends, and character-chat action chips with 409 and no writes", async () => {
    const { chatId } = await provision("Refuse Test");
    // The GET envelope's client-facing routing flag (the UI hides the affordances off it).
    const envelope = await expectJson<{ chat: { simRouted: boolean } }>(
      await chatGet(apiRequest(`/api/chats/${chatId}`), ctx(chatId)),
    );
    expect(envelope.chat.simRouted).toBe(true);

    expect((await post(chatId, { kind: "send", content: "Hi." })).status).toBe(200);
    const before = (await messageRoles(chatId)).length;

    const upload = await attachmentUpload(
      jsonReq(`/api/chats/${chatId}/attachments`, { image: "data:image/png;base64,AA==" }),
      ctx(chatId),
    );
    await expectApiError(upload, 409, "sim_unsupported_operation");

    const stopped = await stopReply(apiRequest(`/api/chats/${chatId}/stop`, { method: "POST" }), ctx(chatId));
    await expectApiError(stopped, 409, "sim_unsupported_operation");

    const att = await chatSend(
      jsonReq(`/api/chats/${chatId}`, { kind: "send", content: "look at this", attachmentIds: ["not-a-real-upload"] }),
      ctx(chatId),
    );
    await expectApiError(att, 409, "sim_unsupported_operation");
    expect((await messageRoles(chatId)).length).toBe(before); // nothing written

    const act = await chatSend(jsonReq(`/api/chats/${chatId}`, { kind: "action_beat", action: "rest" }), ctx(chatId));
    await expectApiError(act, 409, "sim_unsupported_operation");
    expect((await messageRoles(chatId)).length).toBe(before); // nothing written
  });
});
