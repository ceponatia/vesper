import { eq, sql } from "drizzle-orm";
import { NextRequest } from "next/server";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  characterChats,
  characters,
  db,
  simBranches,
  simItemHoldings,
  simPhysicalLoci,
  simWorlds,
  users,
} from "@/server/db";

// Successor deletion (successor-world-lifecycle.plan.md slice 1, owner ruling
// E20-1): the front door is 1:1 chat↔world, so deleting a successor chat must
// take its whole simulated world with it — the leak this suite pins closed. A
// legacy chat must still touch no `sim_*` row, ownership is still re-proved
// in-service, and a chat whose branch has vanished must still delete (degraded
// default + diagnostic, docs/resilience.md). Self-skips without a database.

process.env.AI_FAKE = "1";

const authState = vi.hoisted(() => ({
  user: { id: "", email: "", name: "World Deleter", role: "user" as "admin" | "user" },
}));

vi.mock("@/server/auth", () => ({
  USER_COOKIE: "vesper_user",
  getCurrentUser: async () => authState.user,
  ensureDefaultUser: async () => authState.user,
  listUsers: async () => [authState.user],
}));

import { resetRateLimits } from "@/server/api";
import { deleteChat } from "@/server/engine";
import { log } from "@/server/log";
import { probeIntegrationDb } from "@/server/test-support";
import { POST as successorCreate } from "./route";
import { POST as legacyCreate } from "../chats/route";
import { DELETE as chatDelete } from "../chats/[chatId]/route";

const ready = await probeIntegrationDb("successor-chats-delete.int.test", "sim_worlds");

/**
 * The chat → branch FK (`ON DELETE set null`) makes "linked branch is gone"
 * unreachable through the app, so the degradation case below manufactures it by
 * dropping the constraint for the length of one test and restoring it in a
 * `finally`. The name is drizzle's, from `drizzle/0081_bent_brother_voodoo.sql`.
 */
const CHAT_BRANCH_FK = "character_chats_sim_branch_id_sim_branches_id_fk";
const ADD_CHAT_BRANCH_FK =
  `alter table character_chats add constraint ${CHAT_BRANCH_FK} ` +
  `foreign key (sim_branch_id) references sim_branches(id) on delete set null on update no action`;

const collectionCtx = { params: Promise.resolve({}) };
const ctx = (chatId: string) => ({ params: Promise.resolve({ chatId }) });

function jsonReq(path: string, body: unknown, method = "POST"): NextRequest {
  return new NextRequest(`http://t${path}`, {
    method,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

const ids = { user: "", otherUser: "", characterId: "" };
/** Every world this suite provisioned — the afterAll safety net for a mid-test failure. */
const seededWorlds: string[] = [];

interface CreatedWorld {
  id: string;
  worldId: string;
  branchId: string;
}

/** Provision a successor chat through the real front-door route. */
async function createSuccessorChat(title: string): Promise<CreatedWorld> {
  const res = await successorCreate(
    // slice 3: `requestId` is the required per-intent idempotency key.
    jsonReq("/api/successor-chats", { characterId: ids.characterId, title, requestId: `delete-${title.toLowerCase().replace(/\s+/gu, "-")}-${Date.now()}` }),
    collectionCtx,
  );
  if (res.status !== 201) throw new Error(`successor create failed: ${res.status}`);
  const body = (await res.json()) as CreatedWorld;
  seededWorlds.push(body.worldId);
  return body;
}

/** Create an ordinary legacy conversation through the real route. */
async function createLegacyChat(): Promise<string> {
  const res = await legacyCreate(
    jsonReq("/api/chats", { characterIds: [ids.characterId], memory: "fresh" }),
    collectionCtx,
  );
  if (res.status !== 201) throw new Error(`legacy chat create failed: ${res.status}`);
  return ((await res.json()) as { id: string }).id;
}

const chatCount = async (chatId: string) =>
  (await db().select({ id: characterChats.id }).from(characterChats).where(eq(characterChats.id, chatId))).length;
const worldCount = async (worldId: string) =>
  (await db().select({ id: simWorlds.id }).from(simWorlds).where(eq(simWorlds.id, worldId))).length;
const branchCount = async (worldId: string) =>
  (await db().select({ id: simBranches.id }).from(simBranches).where(eq(simBranches.worldId, worldId))).length;
/** Branch-scoped spot checks: the starter world seeds a held keepsake and three actor loci. */
const holdingCount = async (branchId: string) =>
  (await db().select({ itemId: simItemHoldings.itemId }).from(simItemHoldings).where(eq(simItemHoldings.branchId, branchId)))
    .length;
const locusCount = async (branchId: string) =>
  (await db().select({ actorId: simPhysicalLoci.actorId }).from(simPhysicalLoci).where(eq(simPhysicalLoci.branchId, branchId)))
    .length;

beforeEach(() => resetRateLimits());

beforeAll(async () => {
  if (!ready) return;
  const stamp = Date.now();
  const [user] = await db()
    .insert(users)
    .values({ email: `world-delete-${stamp}@test.local`, name: "World Deleter" })
    .returning();
  const [other] = await db()
    .insert(users)
    .values({ email: `world-delete-other-${stamp}@test.local`, name: "Not Yours" })
    .returning();
  if (!user || !other) throw new Error("failed to create test users");
  authState.user = { ...authState.user, id: user.id, email: user.email };
  ids.user = user.id;
  ids.otherUser = other.id;

  const [character] = await db()
    .insert(characters)
    .values({ ownerId: user.id, name: "Coralie", profile: {} })
    .returning();
  if (!character) throw new Error("failed to seed character");
  ids.characterId = character.id;
});

afterAll(async () => {
  if (!ready || !ids.user) return;
  for (const worldId of seededWorlds) await db().delete(simWorlds).where(eq(simWorlds.id, worldId));
  await db().delete(characterChats).where(eq(characterChats.ownerId, ids.user));
  await db().delete(characters).where(eq(characters.ownerId, ids.user));
  await db().delete(users).where(eq(users.id, ids.user));
  await db().delete(users).where(eq(users.id, ids.otherUser));
});

describe.runIf(ready)("deleting a successor chat deletes its world (E20-1)", () => {
  it("takes the world, its branch, and every branch-scoped row with the chat", async () => {
    const created = await createSuccessorChat("Doomed World");
    // Everything is really there first — otherwise the assertions below prove nothing.
    expect(await worldCount(created.worldId)).toBe(1);
    expect(await branchCount(created.worldId)).toBe(1);
    expect(await holdingCount(created.branchId)).toBeGreaterThan(0);
    expect(await locusCount(created.branchId)).toBeGreaterThan(0);

    const res = await chatDelete(
      new NextRequest(`http://t/api/chats/${created.id}`, { method: "DELETE" }),
      ctx(created.id),
    );
    expect(res.status).toBe(200);

    // Pre-fix this left a permanently unreachable world on Neon: no chat points
    // at it, `sim_worlds` has no owner back-reference, nothing could ever free it.
    expect(await chatCount(created.id)).toBe(0);
    expect(await worldCount(created.worldId)).toBe(0);
    expect(await branchCount(created.worldId)).toBe(0);
    expect(await holdingCount(created.branchId)).toBe(0);
    expect(await locusCount(created.branchId)).toBe(0);
  });

  it("leaves the sim tables alone when the deleted chat is a legacy one", async () => {
    const bystander = await createSuccessorChat("Bystander World");
    const legacyChatId = await createLegacyChat();

    const res = await chatDelete(
      new NextRequest(`http://t/api/chats/${legacyChatId}`, { method: "DELETE" }),
      ctx(legacyChatId),
    );
    expect(res.status).toBe(200);
    expect(await chatCount(legacyChatId)).toBe(0);

    // A chat with no `simBranchId` must never reach a `sim_*` table.
    expect(await worldCount(bystander.worldId)).toBe(1);
    expect(await branchCount(bystander.worldId)).toBe(1);
    expect(await holdingCount(bystander.branchId)).toBeGreaterThan(0);
  });

  it("refuses a successor chat the caller does not own: no-op, warn diagnostic, world intact", async () => {
    const created = await createSuccessorChat("Someone Else's World");

    // Ownership is re-proved inside the service (security-authz.plan.md slice 2),
    // so a foreign `ownerId` cannot route a world into deletion either.
    const warnSpy = vi.spyOn(log, "warn").mockImplementation(() => undefined);
    try {
      await deleteChat(created.id, ids.otherUser);
      expect(warnSpy).toHaveBeenCalledWith(
        "engine.chat",
        expect.any(String),
        expect.objectContaining({ code: "chat.delete_denied", chatId: created.id, ownerId: ids.otherUser }),
      );
    } finally {
      warnSpy.mockRestore();
    }
    expect(await chatCount(created.id)).toBe(1);
    expect(await worldCount(created.worldId)).toBe(1);
    expect(await branchCount(created.worldId)).toBe(1);
  });

  it("degrades when the linked branch is gone: the chat still deletes, with a diagnostic", async () => {
    const created = await createSuccessorChat("Ghost Branch World");
    const ghostBranchId = `${created.branchId}-vanished`;

    await db().execute(sql.raw(`alter table character_chats drop constraint ${CHAT_BRANCH_FK}`));
    try {
      await db()
        .update(characterChats)
        .set({ simBranchId: ghostBranchId })
        .where(eq(characterChats.id, created.id));

      const warnSpy = vi.spyOn(log, "warn").mockImplementation(() => undefined);
      try {
        await deleteChat(created.id, ids.user);
        expect(warnSpy).toHaveBeenCalledWith(
          "engine.chat",
          expect.any(String),
          expect.objectContaining({
            code: "chat.delete_sim_branch_missing",
            chatId: created.id,
            simBranchId: ghostBranchId,
          }),
        );
      } finally {
        warnSpy.mockRestore();
      }

      // Degraded default over a failed operation: the chat is gone even though
      // the world could not be resolved. That world is now an orphan — slice 2's
      // sweeper is what reclaims it, not a thrown delete.
      expect(await chatCount(created.id)).toBe(0);
      expect(await worldCount(created.worldId)).toBe(1);
    } finally {
      await db().execute(sql.raw(ADD_CHAT_BRANCH_FK));
    }
  });
});
