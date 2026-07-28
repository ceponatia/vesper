import { and, eq, inArray } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { characterProfileSchema } from "@/contracts";
import {
  characterChats,
  characterChatMessages,
  characters,
  db,
  items,
  simBranches,
  simItemHoldings,
  simMemoryDocuments,
  simRelationshipLedger,
  simWorlds,
} from "@/server/db";

// The successor front door (engine.rollout.plan.md, owner ask 2026-07-22):
// one POST provisions a fresh starter world, creates the chat, and routes it
// to the successor lane — then an ordinary send plays a full sim turn in it
// (AI_FAKE; zero live calls). Self-skips without a database.

const authState = vi.hoisted(() => ({
  user: { id: "", email: "", name: "Front Door", role: "user" as "admin" | "user" },
}));

vi.mock("@/server/auth", async () => (await import("@/server/test-support")).routeAuthModule(authState));

import {
  apiRequest,
  bindAuthUser,
  drainStream,
  endTestPool,
  expectApiError,
  expectJson,
  probeIntegrationDb,
  purgeOwnerRows,
  routeCtx,
  seedTestUser,
} from "@/server/test-support";
import {
  STARTER_CALENDAR_START,
  STARTER_ORIGIN_STORY_SECOND,
  submitDurableApplyBodySource,
  submitDurableRecordRelationshipEntry,
  submitDurableStorytellerRelocation,
} from "@/server/engine";
import { GET as successorList, POST as successorCreate } from "./route";
import { PATCH as calendarPatch } from "./[chatId]/route";
import { GET as chatGet, POST as chatSend } from "../chats/[chatId]/route";
import { GET as stateGet } from "../chats/[chatId]/state/route";

const ready = await probeIntegrationDb("successor-chats.int.test", "character_chats");
const collectionCtx = routeCtx();
const ctx = (chatId: string) => routeCtx({ chatId });

interface CreatedWorld {
  id: string;
  worldId: string;
  branchId: string;
}

const ids = { user: "", characterId: "", worldId: "", extraWorldId: "" };

beforeAll(async () => {
  if (!ready) return;
  const user = await seedTestUser("front-door");
  bindAuthUser(authState, user);
  ids.user = user.id;
  // R5 slice 5: an authored default outfit — provisioning ports it into the
  // mirror world as WORN items, so the outfit chip reads world truth.
  const insertItem = async (name: string) => {
    const [row] = await db()
      .insert(items)
      .values({ ownerId: user.id, kind: "clothing", name, description: name })
      .returning({ id: items.id });
    if (!row) throw new Error("failed to create item");
    return row.id;
  };
  const jacketId = await insertItem("denim jacket");
  const teeId = await insertItem("white cotton tee");
  const profile = characterProfileSchema.parse({
    outfits: [{ id: "everyday", name: "Everyday", items: [jacketId, teeId] }],
    // R5 relationships: an authored WARM start (band midpoint 57) — seeds the
    // authored_prior ledger pair at provisioning.
    playerRelationship: { familiarity: "close", regard: "warm" },
  });
  const [character] = await db()
    .insert(characters)
    .values({ ownerId: user.id, name: "Abigail", profile })
    .returning();
  if (!character) throw new Error("failed to seed character");
  ids.characterId = character.id;
});

afterAll(async () => {
  if (ready && ids.user) {
    // `sim_worlds` carries no owner column — the chat is its only anchor — so the
    // worlds go first, by hand; the cascade nulls each chat's `sim_branch_id`
    // before the owner sweep removes the chats themselves.
    const worlds = [ids.worldId, ids.extraWorldId].filter(Boolean);
    if (worlds.length > 0) await db().delete(simWorlds).where(inArray(simWorlds.id, worlds));
    await purgeOwnerRows([ids.user]);
  }
  await endTestPool();
});

describe.runIf(ready)("successor-chats front door", () => {
  it("provisions a fresh world, routes the chat, and plays a full sim turn", async () => {
    const body = await expectJson<CreatedWorld>(
      await successorCreate(
        // slice 3: `requestId` is the required per-intent idempotency key.
        apiRequest("/api/successor-chats", {
          body: { characterId: ids.characterId, title: "Front Door Test", requestId: "front-door-1" },
        }),
        collectionCtx,
      ),
      201,
    );
    ids.worldId = body.worldId;

    // The chat is routed with both actors mapped, and the fresh branch sits
    // at the starter origin (Day 1 · 8:00am).
    const [chatRow] = await db()
      .select({
        authority: characterChats.engineAuthority,
        simBranchId: characterChats.simBranchId,
        simPlayerActorId: characterChats.simPlayerActorId,
        simPrimaryActorId: characterChats.simPrimaryActorId,
      })
      .from(characterChats)
      .where(eq(characterChats.id, body.id));
    expect(chatRow).toMatchObject({ authority: "successor_narrative_view", simBranchId: body.branchId });
    expect(chatRow?.simPlayerActorId).toBeTruthy();
    expect(chatRow?.simPrimaryActorId).toBeTruthy();
    const [branch] = await db()
      .select({ storySecond: simBranches.storySecond })
      .from(simBranches)
      .where(eq(simBranches.id, body.branchId));
    expect(branch?.storySecond).toBe(STARTER_ORIGIN_STORY_SECOND);

    // An ordinary send plays a successor turn in the fresh world.
    const send = await chatSend(
      apiRequest(`/api/chats/${body.id}`, { body: { kind: "send", content: "I look around our new home." } }),
      ctx(body.id),
    );
    expect(send.status).toBe(200);
    expect((await drainStream(send)).replace(/\u200B/g, "").length).toBeGreaterThan(0);
    const lines = await db()
      .select({ role: characterChatMessages.role })
      .from(characterChatMessages)
      .where(eq(characterChatMessages.chatId, body.id));
    expect(lines.map((line) => line.role).sort()).toEqual(["assistant", "user"]);

    // The list shows it with the character's name and the world clock.
    const { chats } = await expectJson<{
      chats: { id: string; characterName: string; storySecond: number | null }[];
    }>(await successorList(apiRequest("/api/successor-chats"), collectionCtx), 200);
    const listed = chats.find((chat) => chat.id === body.id);
    if (!listed) throw new Error("successor chat missing from the list");
    expect(listed.characterName).toBe("Abigail");
    // The turn's 60s span moved the clock past the origin.
    expect(listed.storySecond).toBeGreaterThanOrEqual(STARTER_ORIGIN_STORY_SECOND);

    // R5 calendar (ruling 17): fresh worlds carry the default anchor, the
    // state envelope serves it, and the editor PATCH replaces (or clears) it.
    const [world] = await db()
      .select({ calendarStart: simWorlds.calendarStart })
      .from(simWorlds)
      .where(eq(simWorlds.id, body.worldId));
    expect(world?.calendarStart).toEqual(STARTER_CALENDAR_START);
    const stateBody = await expectJson<{
      simClock: { storySecond: number; calendarStart: { year: number } | null } | null;
    }>(await stateGet(apiRequest(`/api/chats/${body.id}/state`), ctx(body.id)));
    expect(stateBody.simClock?.calendarStart).toEqual(STARTER_CALENDAR_START);
    const patched = await calendarPatch(
      apiRequest(`/api/successor-chats/${body.id}`, {
        method: "PATCH",
        body: { calendarStart: { year: 2027, month: 1, day: 15 } },
      }),
      ctx(body.id),
    );
    expect(patched.status).toBe(200);
    const [worldAfter] = await db()
      .select({ calendarStart: simWorlds.calendarStart })
      .from(simWorlds)
      .where(eq(simWorlds.id, body.worldId));
    expect(worldAfter?.calendarStart).toEqual({ year: 2027, month: 1, day: 15 });
  });

  it("rejects a character outside the caller's library", async () => {
    await expectApiError(
      await successorCreate(
        apiRequest("/api/successor-chats", {
          body: { characterId: "not-a-real-id", requestId: "foreign-character-1" },
        }),
        collectionCtx,
      ),
      404,
    );
  });

  it("input admission: 'I hand her the keepsake' executes a real transfer (R5 slice 2)", async () => {
    const body = await expectJson<CreatedWorld>(
      await successorCreate(
        apiRequest("/api/successor-chats", {
          body: { characterId: ids.characterId, title: "Admission Test", requestId: "admission-1" },
        }),
        collectionCtx,
      ),
      201,
    );
    ids.extraWorldId = body.worldId;
    const [chatRow] = await db()
      .select({ playerActorId: characterChats.simPlayerActorId, primaryActorId: characterChats.simPrimaryActorId })
      .from(characterChats)
      .where(eq(characterChats.id, body.id));
    if (!chatRow?.playerActorId || !chatRow.primaryActorId) throw new Error("actor mapping missing");

    const send = await chatSend(
      apiRequest(`/api/chats/${body.id}`, { body: { kind: "send", content: "I smile and hand her the keepsake." } }),
      ctx(body.id),
    );
    expect(send.status).toBe(200);
    expect((await drainStream(send)).replace(/\u200B/g, "").length).toBeGreaterThan(0);
    // World truth moved: the starter keepsake is now HELD by the primary actor.
    const [holding] = await db()
      .select({ actorId: simItemHoldings.actorId, locusKind: simItemHoldings.locusKind })
      .from(simItemHoldings)
      .where(and(eq(simItemHoldings.branchId, body.branchId), eq(simItemHoldings.itemId, `${body.worldId}-item-keepsake`)));
    expect(holding).toMatchObject({ locusKind: "held", actorId: chatRow.primaryActorId });

    // A refused admission (resting mid-scene fights the engagement's claim)
    // still renders a turn — the §14.4 face rides the cut, never a dead send.
    const refused = await chatSend(
      apiRequest(`/api/chats/${body.id}`, { body: { kind: "send", content: "I lie down to rest right here." } }),
      ctx(body.id),
    );
    expect(refused.status).toBe(200);
    expect((await drainStream(refused)).replace(/\u200B/g, "").length).toBeGreaterThan(0);

    // R5 slice 3 \u2014 presence reads the mirror's physical truth: co-located now\u2026
    const before = await expectJson<{ roster: { sort: number; presence: string }[] }>(
      await chatGet(apiRequest(`/api/chats/${body.id}`), ctx(body.id)),
    );
    expect(before.roster.find((m) => m.sort === 0)?.presence).toBe("present");
    // \u2026then the storyteller relocates the primary to the square \u2192 "away".
    const relocated = await submitDurableStorytellerRelocation(
      {
        id: `test-relocate-${body.branchId}`,
        branchId: body.branchId,
        expectedVersion: 0,
        idempotencyKey: `test-relocate-${body.branchId}`,
        principal: { kind: "storyteller", principalId: ids.user, controlledActorIds: [] },
        submittedAtWallClock: new Date().toISOString(),
        correlationId: `test-${body.branchId}`,
        type: "storyteller_relocate_actor",
        schemaVersion: 1,
        payload: {
          actorId: chatRow.primaryActorId,
          destinationZoneId: `${body.worldId}-zone-square`,
          reason: "surfaces test",
        },
      },
      { admitAtLockedVersion: true },
    );
    expect(relocated.status).toBe("accepted");
    const after = await expectJson<{ roster: { sort: number; presence: string }[] }>(
      await chatGet(apiRequest(`/api/chats/${body.id}`), ctx(body.id)),
    );
    expect(after.roster.find((m) => m.sort === 0)?.presence).toBe("away");

    // R5 slice 4 \u2014 the strip's meters read the ruling-15 substrate: drop the
    // primary's hygiene in WORLD truth and the state envelope must show it
    // (legacy chat-state would still say the seeded 0.9).
    const washed = await submitDurableApplyBodySource(
      {
        id: `test-hygiene-${body.branchId}`,
        branchId: body.branchId,
        expectedVersion: 0,
        idempotencyKey: `test-hygiene-${body.branchId}`,
        principal: { kind: "system", principalId: "surfaces-test", controlledActorIds: [] },
        submittedAtWallClock: new Date().toISOString(),
        correlationId: `test-${body.branchId}`,
        type: "apply_body_source",
        schemaVersion: 1,
        payload: {
          actorId: chatRow.primaryActorId,
          meterKey: "hygiene",
          sourceKind: "wash",
          operation: { kind: "set", valueFixedPoint: 2_000 },
        },
      },
      { admitAtLockedVersion: true },
    );
    expect(washed.status).toBe("accepted");
    const stateAfter = await expectJson<{ meters: Record<string, number> }>(
      await stateGet(apiRequest(`/api/chats/${body.id}/state`), ctx(body.id)),
    );
    expect(stateAfter.meters.hygiene).toBeCloseTo(0.2, 5);
    expect(stateAfter.meters.mood).toBeCloseTo(0.5, 5);

    // R5 slice 5 — the authored outfit was born as WORN world items, and the
    // outfit chip reads them (transcript roster + state envelope alike).
    const worn = await db()
      .select({ itemId: simItemHoldings.itemId })
      .from(simItemHoldings)
      .where(
        and(
          eq(simItemHoldings.branchId, body.branchId),
          eq(simItemHoldings.locusKind, "worn"),
          eq(simItemHoldings.actorId, chatRow.primaryActorId),
        ),
      );
    expect(worn).toHaveLength(2);
    const outfitEnvelope = await expectJson<{ roster: { sort: number; outfit: string }[] }>(
      await chatGet(apiRequest(`/api/chats/${body.id}`), ctx(body.id)),
    );
    const primaryOutfit = outfitEnvelope.roster.find((m) => m.sort === 0)?.outfit ?? "";
    expect(primaryOutfit).toContain("denim jacket");
    expect(primaryOutfit).toContain("white cotton tee");
    const stateOutfit = await expectJson<{ outfitLabel: string }>(
      await stateGet(apiRequest(`/api/chats/${body.id}/state`), ctx(body.id)),
    );
    expect(stateOutfit.outfitLabel).toContain("denim jacket");

    // R5 knowledge/memory: successor chats are rag-eligible from birth, and
    // the inline drain projected §24 documents (the give-transfer's events)
    // during the SECOND exchange's recall.
    const [authorityRow] = await db()
      .select({ ragEligibility: characterChats.successorRagEligibility })
      .from(characterChats)
      .where(eq(characterChats.id, body.id));
    expect(authorityRow?.ragEligibility).toBe(true);
    const docs = await db()
      .select({ docId: simMemoryDocuments.docId })
      .from(simMemoryDocuments)
      .where(eq(simMemoryDocuments.branchId, body.branchId));
    expect(docs.length).toBeGreaterThan(0);

    // R5 slice 7 — relationships: the authored WARM prior round-trips through
    // the §21 read (regard 57), and lived ledger evidence MOVES the chip
    // where the frozen legacy seed could not.
    const ledger = await db()
      .select({ kind: simRelationshipLedger.kind })
      .from(simRelationshipLedger)
      .where(eq(simRelationshipLedger.branchId, body.branchId));
    expect(ledger.filter((row) => row.kind === "authored_prior")).toHaveLength(2);
    const relStateBefore = await expectJson<{ regard: number; familiarity: number; regardBand: { label: string } }>(
      await stateGet(apiRequest(`/api/chats/${body.id}/state`), ctx(body.id)),
    );
    // The §21 read time-decays evidence, so the authored 57 reads a hair
    // lower as story time passes — the BAND is the stable assertion.
    expect(relStateBefore.regard).toBeGreaterThanOrEqual(53);
    expect(relStateBefore.regard).toBeLessThanOrEqual(57);
    expect(relStateBefore.familiarity).toBe(40);
    expect(relStateBefore.regardBand.label).toBe("Warm");
    const affection = await submitDurableRecordRelationshipEntry(
      {
        id: `test-affection-${body.branchId}`,
        branchId: body.branchId,
        expectedVersion: 0,
        idempotencyKey: `test-affection-${body.branchId}`,
        principal: { kind: "storyteller", principalId: ids.user, controlledActorIds: [] },
        submittedAtWallClock: new Date().toISOString(),
        correlationId: `test-${body.branchId}`,
        type: "record_relationship_entry",
        schemaVersion: 1,
        payload: {
          fromActorId: chatRow.playerActorId,
          toActorId: chatRow.primaryActorId,
          kind: "affection_shown",
          detail: "a kind gesture in the kitchen",
        },
      },
      { admitAtLockedVersion: true },
    );
    expect(affection.status).toBe("accepted");
    const relStateAfter = await expectJson<{ regard: number; familiarity: number }>(
      await stateGet(apiRequest(`/api/chats/${body.id}/state`), ctx(body.id)),
    );
    expect(relStateAfter.regard).toBeGreaterThan(relStateBefore.regard);
    expect(relStateAfter.familiarity).toBe(46);
  });
});
