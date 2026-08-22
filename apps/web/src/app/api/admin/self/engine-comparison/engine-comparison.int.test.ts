import { eq } from "drizzle-orm";
import type { NextRequest } from "next/server";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { newId } from "@/lib/ids";
import {
  characterChats,
  characterChatState,
  characters,
  chatParticipants,
  db,
  simBranches,
  simShadowDivergences,
  simWorlds,
} from "@/server/db";

const authState = vi.hoisted(() => ({
  user: { id: "", email: "", name: "Engine Comparison Int", role: "admin" as const },
}));
vi.mock("@/server/auth", async () => (await import("@/server/test-support")).routeAuthModule(authState));

import {
  COMPARISON_WORLD_TYPE_ID,
  readChatEngineAuthority,
  readDurableBodies,
  readDurableSpaceBranch,
} from "@/server/engine";
import {
  apiRequest,
  expectJson,
  probeIntegrationDb,
  purgeOwnerRows,
  routeCtx,
  seedTestUser,
} from "@/server/test-support";
import { DELETE, GET, POST } from "./[chatId]/route";

const ready = await probeIntegrationDb("engine-comparison.int.test", "sim_worlds");
const ids = { owner: "", primary: "", chat: "", groupChat: "" };
let comparisonWorldId = "";

const req = (chatId: string, method: "GET" | "POST" | "DELETE"): NextRequest =>
  apiRequest(`/api/admin/self/engine-comparison/${chatId}`, { method });
const ctx = (chatId: string) => routeCtx({ chatId });

beforeAll(async () => {
  if (!ready) return;
  const owner = await seedTestUser("engine-comparison-int", { name: "Comparison Owner", role: "admin" });
  ids.owner = owner.id;
  authState.user = { id: owner.id, email: owner.email, name: "Comparison Owner", role: "admin" };

  const [primary, secondary] = await db()
    .insert(characters)
    .values([
      { ownerId: owner.id, name: "Ana", profile: {} },
      { ownerId: owner.id, name: "Ben", profile: {} },
    ])
    .returning({ id: characters.id });
  if (!primary || !secondary) throw new Error("comparison characters were not seeded");
  ids.primary = primary.id;

  const [chat, groupChat] = await db()
    .insert(characterChats)
    .values([
      {
        ownerId: owner.id,
        clockMinutes: 125,
        calendarStart: { year: 2025, month: 11, day: 9, hour: 14, minute: 30 },
      },
      { ownerId: owner.id },
    ])
    .returning({ id: characterChats.id });
  if (!chat || !groupChat) throw new Error("comparison chats were not seeded");
  ids.chat = chat.id;
  ids.groupChat = groupChat.id;
  await db().insert(chatParticipants).values([
    { chatId: chat.id, characterId: primary.id, memoryGroupId: newId(), sort: 0 },
    { chatId: groupChat.id, characterId: primary.id, memoryGroupId: newId(), sort: 0 },
    { chatId: groupChat.id, characterId: secondary.id, memoryGroupId: newId(), sort: 1 },
  ]);
  // Deliberately non-default values: the provisioning test must prove it mirrors
  // the CURRENT character-chat state, not merely that a generic world can boot.
  await db().insert(characterChatState).values({
    chatId: chat.id,
    characterId: primary.id,
    presence: "away",
    meters: {
      energy: 0.41,
      hygiene: 0.68,
      arousal: 0.12,
      stress: 0.77,
      intoxication: 0.09,
      mood: 0.23,
    },
  });
});

afterAll(async () => {
  if (!ready) return;
  // If the test failed before explicit cleanup, delete the exact mirror it
  // observed rather than scanning/deleting another suite's comparison world.
  if (comparisonWorldId) {
    await db().delete(simWorlds).where(eq(simWorlds.id, comparisonWorldId)).catch(() => undefined);
  }
  await purgeOwnerRows([ids.owner]);
});

describe.runIf(ready)("Engine Comparison session provisioning", () => {
  it("mirrors current state and preserves recorded evidence when stopped", async () => {
    const before = await expectJson<{ active: boolean; canStart: boolean; rows: number }>(
      await GET(req(ids.chat, "GET"), ctx(ids.chat)),
      200,
    );
    expect(before.active).toBe(false);
    expect(before.canStart).toBe(true);
    expect(before.rows).toBe(0);

    const started = await expectJson<{ active: boolean; canStart: boolean }>(
      await POST(req(ids.chat, "POST"), ctx(ids.chat)),
      200,
    );
    expect(started.active).toBe(true);
    expect(started.canStart).toBe(false);

    const authority = await readChatEngineAuthority(ids.chat);
    expect(authority?.authority).toBe("successor_shadow");
    expect(authority?.simBranchId).toBeTruthy();
    expect(authority?.simPlayerActorId).toBeTruthy();
    expect(authority?.simPrimaryActorId).toBeTruthy();
    const branchId = authority?.simBranchId ?? "";

    const [world] = await db()
      .select({ id: simWorlds.id, worldTypeId: simWorlds.worldTypeId, calendarStart: simWorlds.calendarStart })
      .from(simBranches)
      .innerJoin(simWorlds, eq(simWorlds.id, simBranches.worldId))
      .where(eq(simBranches.id, branchId));
    expect(world?.worldTypeId).toBe(COMPARISON_WORLD_TYPE_ID);
    expect(world?.calendarStart).toEqual({ year: 2025, month: 11, day: 9 });
    comparisonWorldId = world?.id ?? "";

    const space = await readDurableSpaceBranch(branchId);
    expect(space.locations).toHaveLength(1);
    expect(space.zones).toHaveLength(2);
    expect(space.loci).toHaveLength(2);
    const playerLocus = space.loci.find((locus) => locus.actorId === authority?.simPlayerActorId);
    const primaryLocus = space.loci.find((locus) => locus.actorId === authority?.simPrimaryActorId);
    expect(playerLocus?.kind).toBe("at");
    expect(primaryLocus?.kind).toBe("at");
    if (playerLocus?.kind === "at" && primaryLocus?.kind === "at") {
      // Character-chat presence was `away`, so the mirror must not seed a co-present pair.
      expect(primaryLocus.zoneId).not.toBe(playerLocus.zoneId);
    }

    const bodies = await readDurableBodies(branchId);
    // 14:30 anchor + 125 elapsed minutes = 16:35 on story day zero.
    expect(bodies.storySecond).toBe((14 * 60 + 30 + 125) * 60);
    const primaryMeters = new Map(
      bodies.meters
        .filter((meter) => meter.actorId === authority?.simPrimaryActorId)
        .map((meter) => [meter.meterKey, meter.valueFixedPoint]),
    );
    expect(primaryMeters.get("energy")).toBe(4_100);
    expect(primaryMeters.get("stress")).toBe(7_700);
    expect(primaryMeters.get("mood")).toBe(2_300);

    // The row models evidence already gathered by a real shadow exchange.
    // Recorded findings are the whole product of a session, and both the API
    // and the UI promise stopping keeps them. Falsified against the previous
    // schema, where `sim_shadow_divergences.branch_id` cascaded from
    // `sim_branches` and deleting the mirror world erased every comparison row
    // and ruling; `branch_id` is now a set-null provenance link, so Stop
    // deletes the mirror and keeps the evidence.
    const evidenceId = newId();
    await db().insert(simShadowDivergences).values({
      id: evidenceId,
      chatId: ids.chat,
      messageId: newId(),
      branchId,
      domain: "meters",
      legacy: { meters: { stress: 0.77 } },
      successor: { metersFixedPoint: { stress: 7_700 } },
      verdict: "intentional",
    });

    const stopped = await expectJson<{ active: boolean; canStart: boolean; rows: number }>(
      await DELETE(req(ids.chat, "DELETE"), ctx(ids.chat)),
      200,
    );
    expect(stopped.active).toBe(false);
    expect(stopped.canStart).toBe(true);
    expect(stopped.rows).toBe(1);
    const after = await readChatEngineAuthority(ids.chat);
    expect(after?.authority).toBe("legacy_chat");
    expect(after?.simBranchId).toBeNull();
    expect(await db().select().from(simWorlds).where(eq(simWorlds.id, comparisonWorldId))).toHaveLength(0);
    comparisonWorldId = "";

    // The row outlives the branch it was recorded against; its provenance link
    // is the only thing the mirror's deletion takes with it.
    const kept = await db()
      .select({ branchId: simShadowDivergences.branchId, verdict: simShadowDivergences.verdict })
      .from(simShadowDivergences)
      .where(eq(simShadowDivergences.id, evidenceId));
    expect(kept).toEqual([{ branchId: null, verdict: "intentional" }]);
  });

  it("refuses group chats instead of collecting pair-only evidence", async () => {
    const status = await expectJson<{ active: boolean; canStart: boolean; reason: string | null }>(
      await GET(req(ids.groupChat, "GET"), ctx(ids.groupChat)),
      200,
    );
    expect(status.active).toBe(false);
    expect(status.canStart).toBe(false);
    expect(status.reason).toContain("one-on-one");
    expect((await POST(req(ids.groupChat, "POST"), ctx(ids.groupChat))).status).toBe(409);
  });
});
