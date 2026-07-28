import { eq, sql } from "drizzle-orm";
import type { NextRequest } from "next/server";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { characterProfileSchema } from "@/contracts";
import { parseOr } from "@/lib/parse";
import { replyTakesSchema } from "@/server/engine";
import { characterChatMessages, db, simBranches, simEvents } from "@/server/db";

/**
 * Routing parity (presentation-charter.plan.md §4; engine.spec.operations.md §39
 * rulings 18-19): on a sim-routed chat every POST kind either has successor
 * semantics or is refused — never the legacy narrator. AI_FAKE ⇒ zero live model
 * calls (the deterministic render). Self-skips without a database.
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
import { POST as successorCreate } from "../../successor-chats/route";

const ready = await probeIntegrationDb("sim-routing.int.test", "character_chats");

const ctx = (chatId: string) => routeCtx({ chatId });
const jsonReq = (path: string, body: unknown): NextRequest => apiRequest(path, { body });

const cutIdMetaSchema = z.object({ cutId: z.string().catch("") }).catch({ cutId: "" });
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

async function lastAssistant(
  chatId: string,
): Promise<{ id: string; content: string; takes: unknown; meta: unknown } | undefined> {
  const rows = await db()
    .select({
      id: characterChatMessages.id,
      role: characterChatMessages.role,
      content: characterChatMessages.content,
      takes: characterChatMessages.takes,
      meta: characterChatMessages.meta,
    })
    .from(characterChatMessages)
    .where(eq(characterChatMessages.chatId, chatId))
    .orderBy(sql`${characterChatMessages.createdAt} desc, ${characterChatMessages.id} desc`);
  const a = rows.find((r) => r.role === "assistant");
  return a ? { id: a.id, content: a.content, takes: a.takes, meta: a.meta } : undefined;
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

function metaCutId(meta: unknown): string {
  return parseOr(cutIdMetaSchema, meta, { cutId: "" }, undefined, "meta").cutId;
}

describe.runIf(ready)("sim routing parity", () => {
  it("regenerate re-renders the SAME cut in place: no new rows, no truth growth, a take recorded", async () => {
    const { chatId, branchId } = await provision("Regen Test");
    expect((await post(chatId, { kind: "send", content: "I look around our new home." })).status).toBe(200);

    expect((await messageRoles(chatId)).sort()).toEqual(["assistant", "user"]);
    const eventsAfterSend = await eventCount(branchId);
    const replyBefore = await lastAssistant(chatId);
    if (!replyBefore) throw new Error("no reply after send");
    const cutIdSend = metaCutId(replyBefore.meta);
    expect(cutIdSend).not.toBe("");

    const regen = await post(chatId, { kind: "regenerate" });
    expect(regen.status).toBe(200);

    // No new transcript rows (the assistant row is replaced in place).
    expect((await messageRoles(chatId)).sort()).toEqual(["assistant", "user"]);
    // No event/truth growth — a retake creates nothing (ruling 18 / §22.3).
    expect(await eventCount(branchId)).toBe(eventsAfterSend);

    const replyAfter = await lastAssistant(chatId);
    if (!replyAfter) throw new Error("no reply after regenerate");
    expect(replyAfter.id).toBe(replyBefore.id); // same row, updated in place
    expect(metaCutId(replyAfter.meta)).toBe(cutIdSend); // the SAME committed cut
    // A fresh take was recorded (the prior take stays browsable).
    const takes = parseOr(replyTakesSchema, replyAfter.takes, { takes: [], activeId: "" }, undefined, "takes");
    expect(takes.takes.length).toBeGreaterThanOrEqual(2);
    expect(takes.activeId).not.toBe("");
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

  it("refuses attachments and legacy action chips with 409 and no writes", async () => {
    const { chatId } = await provision("Refuse Test");
    // The GET envelope's client-facing routing flag (the UI hides the affordances off it).
    const envelope = await expectJson<{ chat: { simRouted: boolean } }>(
      await chatGet(apiRequest(`/api/chats/${chatId}`), ctx(chatId)),
    );
    expect(envelope.chat.simRouted).toBe(true);

    expect((await post(chatId, { kind: "send", content: "Hi." })).status).toBe(200);
    const before = (await messageRoles(chatId)).length;

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
