import { and, eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { PROVISIONING_STALE_AFTER_DELETE } from "@vesper/simulation-core/provisioning";
import {
  characterChats,
  characters,
  db,
  simBranches,
  simItemHoldings,
  simPhysicalLoci,
  simProvisioningRequests,
  simWorlds,
} from "@/server/db";

// Successor deletion (owner ruling E20-1): the front door is 1:1 chat↔world, so
// deleting a successor chat must take its whole simulated world with it — the
// leak this suite pins closed. A legacy chat must still touch no `sim_*` row,
// ownership is still re-proved in-service, and a chat whose branch has vanished
// must still delete (degraded default + diagnostic, docs/resilience.md).
// The last case pins #197: the provisioning ledger outlives the graph it names,
// so deleting a world must also stop its `ready` record replaying the 201 that
// named it. Self-skips without a database.

const authState = vi.hoisted(() => ({
  user: { id: "", email: "", name: "World Deleter", role: "user" as "admin" | "user" },
}));

vi.mock("@/server/auth", async () => (await import("@/server/test-support")).routeAuthModule(authState));

import { resetRateLimits } from "@/server/api";
import { deleteChat } from "@/server/engine";
import { log } from "@/server/log";
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

const collectionCtx = routeCtx();
const ctx = (chatId: string) => routeCtx({ chatId });

const ids = { user: "", otherUser: "", characterId: "" };
/** Every world this suite provisioned — the afterAll safety net for a mid-test failure. */
const seededWorlds: string[] = [];

interface CreatedWorld {
  id: string;
  worldId: string;
  branchId: string;
}

/** POST the real front door. `requestId` is the required per-intent idempotency key. */
async function postSuccessorChat(title: string, requestId: string): Promise<Response> {
  return successorCreate(
    apiRequest("/api/successor-chats", { body: { characterId: ids.characterId, title, requestId } }),
    collectionCtx,
  );
}

/** Provision a successor chat through the real front-door route. */
async function createSuccessorChat(title: string, requestId?: string): Promise<CreatedWorld> {
  const key = requestId ?? `delete-${title.toLowerCase().replace(/\s+/gu, "-")}-${Date.now()}`;
  const body = await expectJson<CreatedWorld>(await postSuccessorChat(title, key), 201);
  seededWorlds.push(body.worldId);
  return body;
}

async function provisioningRecord(requestId: string) {
  const [row] = await db()
    .select()
    .from(simProvisioningRequests)
    .where(
      and(eq(simProvisioningRequests.ownerId, ids.user), eq(simProvisioningRequests.requestId, requestId)),
    )
    .limit(1);
  return row;
}

/** Create an ordinary legacy conversation through the real route. */
async function createLegacyChat(): Promise<string> {
  const body = await expectJson<{ id: string }>(
    await legacyCreate(
      apiRequest("/api/chats", { body: { characterIds: [ids.characterId], memory: "fresh" } }),
      collectionCtx,
    ),
    201,
  );
  return body.id;
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
  const user = await seedTestUser("world-delete");
  const other = await seedTestUser("world-delete-other");
  bindAuthUser(authState, user);
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
  if (ready && ids.user) {
    // `sim_worlds` has no owner column, so the safety net stays explicit and runs
    // before the owner sweep — its cascade clears each chat's branch link first.
    for (const worldId of seededWorlds) await db().delete(simWorlds).where(eq(simWorlds.id, worldId));
    await purgeOwnerRows([ids.user, ids.otherUser]);
  }
  await endTestPool();
});

describe.runIf(ready)("deleting a successor chat deletes its world (E20-1)", () => {
  it("takes the world, its branch, and every branch-scoped row with the chat", async () => {
    const created = await createSuccessorChat("Doomed World");
    // Everything is really there first — otherwise the assertions below prove nothing.
    expect(await worldCount(created.worldId)).toBe(1);
    expect(await branchCount(created.worldId)).toBe(1);
    expect(await holdingCount(created.branchId)).toBeGreaterThan(0);
    expect(await locusCount(created.branchId)).toBeGreaterThan(0);

    const res = await chatDelete(apiRequest(`/api/chats/${created.id}`, { method: "DELETE" }), ctx(created.id));
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

    const res = await chatDelete(apiRequest(`/api/chats/${legacyChatId}`, { method: "DELETE" }), ctx(legacyChatId));
    expect(res.status).toBe(200);
    expect(await chatCount(legacyChatId)).toBe(0);

    // A chat with no `simBranchId` must never reach a `sim_*` table.
    expect(await worldCount(bystander.worldId)).toBe(1);
    expect(await branchCount(bystander.worldId)).toBe(1);
    expect(await holdingCount(bystander.branchId)).toBeGreaterThan(0);
  });

  it("refuses a successor chat the caller does not own: no-op, warn diagnostic, world intact", async () => {
    const created = await createSuccessorChat("Someone Else's World");

    // Ownership is re-proved inside the service,
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
      // the world could not be resolved. That world is now an orphan — the
      // orphan-world sweeper is what reclaims it, not a thrown delete.
      expect(await chatCount(created.id)).toBe(0);
      expect(await worldCount(created.worldId)).toBe(1);
    } finally {
      await db().execute(sql.raw(ADD_CHAT_BRANCH_FK));
    }
  });

  // #197. `sim_provisioning_requests` deliberately has no FK to the chat (#283:
  // failed records are the audit trail and must survive compensating cleanup),
  // so a `ready` record kept naming a chat, branch and world that this delete had
  // just destroyed — and the front door replayed its recorded 201 verbatim,
  // handing the client three tombstones with a 201 status. Falsified against
  // that route: the re-POST below returned `created`'s exact ids.
  it("refuses to replay a deleted world for the same request id, then rebuilds on the next tap", async () => {
    const requestId = `stale-replay-${Date.now()}`;
    const created = await createSuccessorChat("Replayed World", requestId);
    expect((await provisioningRecord(requestId))?.state).toBe("ready");

    expect(
      (await chatDelete(apiRequest(`/api/chats/${created.id}`, { method: "DELETE" }), ctx(created.id))).status,
    ).toBe(200);

    // The belt, written inside the delete's own transaction: no recorded 201
    // survives, so there is nothing left to replay even before the front door's
    // own liveness check runs. The ids stay for the audit; the marker says why.
    const retired = await provisioningRecord(requestId);
    expect(retired?.state).toBe("failed");
    expect(retired?.error).toBe(PROVISIONING_STALE_AFTER_DELETE);
    expect(retired?.response).toBeNull();
    expect(retired?.httpStatus).toBeNull();

    const replay = await postSuccessorChat("Replayed World", requestId);
    // Read the raw body once: the assertion that matters is about the WHOLE
    // payload, not just the fields an envelope helper would surface.
    const replayBody = await replay.text();
    const refusal = JSON.parse(replayBody) as { error: { code: string; message: string } };
    expect(replay.status).toBe(409);
    expect(refusal.error.code).toBe("provision_stale");
    // The point of the whole fix: not one of the dead ids reaches the client.
    for (const dead of [created.id, created.worldId, created.branchId]) expect(replayBody).not.toContain(dead);
    expect(await chatCount(created.id)).toBe(0);
    expect(await worldCount(created.worldId)).toBe(0);

    // The refusal is owed once. The same key is then an ordinary `failed` record,
    // so the next tap rebuilds from scratch — a NEW chat, under the same derived
    // world id (which is exactly why a bare 201 could never have been trusted to
    // mean "your world is there").
    const rebuilt = await createSuccessorChat("Replayed World", requestId);
    expect(rebuilt.id).not.toBe(created.id);
    expect(rebuilt.worldId).toBe(created.worldId);
    expect(await worldCount(rebuilt.worldId)).toBe(1);

    // And a genuinely new intent is untouched by any of it.
    const fresh = await createSuccessorChat("Later World");
    expect(fresh.worldId).not.toBe(created.worldId);
  });

  // The delete-time belt above is not the only protection, and the case that
  // needs the other one is this: a record still reading `ready` whose world is
  // already gone. `deleteChat` never ran (an admin orphan sweep, a repair), or
  // it committed in the window between the front door loading the record and
  // trusting it — the race Codex found on PR #437, which is why the front door
  // re-reads the record and its whole graph in ONE statement and replays only
  // the row that query returns. Falsified against the pre-#197 route, which
  // replayed the stored 201 here.
  it("refuses a ready record whose world vanished without the delete path retiring it", async () => {
    const requestId = `stale-orphan-${Date.now()}`;
    const created = await createSuccessorChat("Vanished World", requestId);

    // Straight to the database, so the ledger row keeps saying `ready` — exactly
    // what the route holds in hand when a concurrent delete has just committed.
    await db().delete(simWorlds).where(eq(simWorlds.id, created.worldId));
    await db().delete(characterChats).where(eq(characterChats.id, created.id));
    expect((await provisioningRecord(requestId))?.state).toBe("ready");

    const res = await postSuccessorChat("Vanished World", requestId);
    const body = await res.text();
    expect(res.status).toBe(409);
    expect((JSON.parse(body) as { error: { code: string } }).error.code).toBe("provision_stale");
    for (const dead of [created.id, created.worldId, created.branchId]) expect(body).not.toContain(dead);

    // …and the record it could not trust is retired, so the next tap rebuilds.
    const retired = await provisioningRecord(requestId);
    expect(retired?.state).toBe("failed");
    expect(retired?.error).toBe(PROVISIONING_STALE_AFTER_DELETE);
  });
});
