import { and, eq, inArray } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { characterProfileSchema } from "@/contracts";
import { newId } from "@/lib/ids";
import { deriveProvisioningStamp, provisioningPayloadHash } from "@vesper/simulation-core/provisioning";
import {
  characterChats,
  chatParticipants,
  characters,
  db,
  simActionDefinitions,
  simBranches,
  simCharacters,
  simProvisioningRequests,
  simRelationshipLedger,
  simWorlds,
} from "@/server/db";

// successor-world-lifecycle.plan.md slices 3–4 — resumable provisioning and the
// honest quota. The front door used to be a five-step non-atomic sequence whose
// world identity was minted fresh per call, so ANY failure left an unrouted chat
// plus a live orphan world and every retry built a SECOND complete world. Now the
// POST runs under `successor_provision:<ownerId>` behind a durable
// `(ownerId, requestId)` record, and the world's ids are DERIVED from that key —
// so a retry resumes, a replay returns the recorded 201, and a failure leaves
// nothing behind. Self-skips without a database (AI_FAKE keeps it zero model calls).

const authState = vi.hoisted(() => ({
  user: { id: "", email: "", name: "Provisioning Int", role: "user" as "admin" | "user" },
}));

vi.mock("@/server/auth", async () => (await import("@/server/test-support")).routeAuthModule(authState));

import {
  apiRequest,
  bindAuthUser,
  endTestPool,
  expectApiError,
  expectJson,
  probeIntegrationDb,
  purgeOwnerRows,
  routeCtx,
  seedTestUser,
} from "@/server/test-support";
import { provisionStarterWorld } from "@/server/engine";
import { POST as successorCreate } from "./route";

const ready = await probeIntegrationDb("successor-provisioning.int.test", "character_chats");
const collectionCtx = routeCtx();
const CHARACTER_NAME = "Abigail";

const ids = { user: "", characterId: "", otherCharacterId: "" };
/** Worlds to tear down after each test — the graph cascades from `sim_worlds`. */
const seededWorlds = new Set<string>();

interface CreatedWorld {
  id: string;
  worldId: string;
  branchId: string;
}

/** POST the front door with an explicit idempotency key. */
async function create(requestId: string, overrides: { characterId?: string; title?: string } = {}) {
  return successorCreate(
    apiRequest("/api/successor-chats", {
      body: {
        characterId: overrides.characterId ?? ids.characterId,
        requestId,
        ...(overrides.title === undefined ? {} : { title: overrides.title }),
      },
    }),
    collectionCtx,
  );
}

async function createOk(requestId: string, overrides: { characterId?: string; title?: string } = {}) {
  const res = await create(requestId, overrides);
  // The body carries WHY a provision refused; a bare status assertion would hide
  // it and every case downstream would then fail opaquely.
  if (res.status !== 201) throw new Error(`successor create failed: ${res.status} ${await res.text()}`);
  const body = await expectJson<CreatedWorld>(res);
  seededWorlds.add(body.worldId);
  return body;
}

/** The world identity this key WILL produce — the whole point of slice 3. */
function derivedWorldId(requestId: string): string {
  return `stw-${deriveProvisioningStamp(ids.user, requestId)}`;
}

/** Build the world for `requestId` out-of-band, as a crash would have left it. */
async function preProvision(requestId: string) {
  const world = await provisionStarterWorld({
    stamp: deriveProvisioningStamp(ids.user, requestId),
    playerName: "Provisioning",
    primaryName: CHARACTER_NAME,
  });
  seededWorlds.add(world.worldId);
  return world;
}

/** Plant the durable record a crash at `state` would have left behind. */
async function plantRecord(
  requestId: string,
  state: (typeof simProvisioningRequests.$inferInsert)["state"],
  patch: Partial<typeof simProvisioningRequests.$inferInsert> = {},
  payload: { characterId?: string; title?: string } = {},
): Promise<void> {
  await db()
    .insert(simProvisioningRequests)
    .values({
      ownerId: ids.user,
      requestId,
      payloadHash: provisioningPayloadHash({
        characterId: payload.characterId ?? ids.characterId,
        title: payload.title ?? "",
      }),
      state,
      ...patch,
    });
}

async function recordOf(requestId: string) {
  const [row] = await db()
    .select()
    .from(simProvisioningRequests)
    .where(and(eq(simProvisioningRequests.ownerId, ids.user), eq(simProvisioningRequests.requestId, requestId)))
    .limit(1);
  return row;
}

async function ownerChatCount(): Promise<number> {
  const rows = await db().select({ id: characterChats.id }).from(characterChats).where(eq(characterChats.ownerId, ids.user));
  return rows.length;
}

async function worldExists(worldId: string): Promise<boolean> {
  const rows = await db().select({ id: simWorlds.id }).from(simWorlds).where(eq(simWorlds.id, worldId)).limit(1);
  return rows.length > 0;
}

async function branchCount(worldId: string): Promise<number> {
  const rows = await db().select({ id: simBranches.id }).from(simBranches).where(eq(simBranches.worldId, worldId));
  return rows.length;
}

/** Cheap stand-ins for already-owned worlds — the quota counts chats, not graphs. */
async function seedChats(count: number, authority: "successor_narrative_view" | "successor_shadow"): Promise<void> {
  await db()
    .insert(characterChats)
    .values(
      Array.from({ length: count }, (_, index) => ({
        ownerId: ids.user,
        title: `seeded ${authority} ${index}`,
        engineAuthority: authority,
      })),
    );
}

beforeAll(async () => {
  if (!ready) return;
  const user = await seedTestUser("provisioning");
  bindAuthUser(authState, user);
  ids.user = user.id;
  // An authored starting relationship, so the relationship-seeding STEP actually
  // runs (a resume must not write the authored_prior pair twice).
  const profile = characterProfileSchema.parse({ playerRelationship: { familiarity: "close", regard: "warm" } });
  const [character] = await db()
    .insert(characters)
    .values({ ownerId: user.id, name: CHARACTER_NAME, profile })
    .returning();
  if (!character) throw new Error("failed to seed character");
  ids.characterId = character.id;
  const [other] = await db()
    .insert(characters)
    .values({ ownerId: user.id, name: "Beatrix", profile: {} })
    .returning();
  if (!other) throw new Error("failed to seed the second character");
  ids.otherCharacterId = other.id;
});

// Every test starts from an owner with no worlds and no records, so the quota
// cases measure only what they seeded.
afterEach(async () => {
  if (!ready || !ids.user) return;
  const records = await db()
    .select({ worldId: simProvisioningRequests.worldId })
    .from(simProvisioningRequests)
    .where(eq(simProvisioningRequests.ownerId, ids.user));
  for (const row of records) if (row.worldId) seededWorlds.add(row.worldId);
  await db().delete(characterChats).where(eq(characterChats.ownerId, ids.user));
  await db().delete(simProvisioningRequests).where(eq(simProvisioningRequests.ownerId, ids.user));
  if (seededWorlds.size > 0) {
    await db().delete(simWorlds).where(inArray(simWorlds.id, [...seededWorlds]));
    seededWorlds.clear();
  }
});

afterAll(async () => {
  // The per-test `afterEach` already dropped every world, chat and provisioning
  // record, so this is only the owner and their cast.
  if (ready && ids.user) await purgeOwnerRows([ids.user]);
  await endTestPool();
});

describe.runIf(ready)("successor provisioning: resume, replay, cleanup", () => {
  it("derives the world from the request key and replays a same-key re-POST verbatim", async () => {
    const key = "replay-1";
    const first = await createOk(key);
    // Identity is DERIVED, not minted — the old `newId()` stamp is what made a
    // retry build a second world.
    expect(first.worldId).toBe(derivedWorldId(key));

    expect(await expectJson<CreatedWorld>(await create(key), 201)).toEqual(first);

    // ONE world, ONE branch, ONE chat, and one cast — nothing was built twice.
    expect(await ownerChatCount()).toBe(1);
    expect(await branchCount(first.worldId)).toBe(1);
    const cast = await db()
      .select({ id: simCharacters.characterId })
      .from(simCharacters)
      .where(eq(simCharacters.branchId, first.branchId));
    expect(cast).toHaveLength(3);
    // The authored prior pair was seeded exactly once.
    const ledger = await db()
      .select({ kind: simRelationshipLedger.kind })
      .from(simRelationshipLedger)
      .where(eq(simRelationshipLedger.branchId, first.branchId));
    expect(ledger.filter((row) => row.kind === "authored_prior")).toHaveLength(2);
    expect((await recordOf(key))?.state).toBe("ready");
  });

  it("rejects a reused request key carrying a different ask (idempotency_mismatch)", async () => {
    const key = "mismatch-1";
    await createOk(key, { title: "First Ask" });

    await expectApiError(
      await create(key, { characterId: ids.otherCharacterId, title: "First Ask" }),
      409,
      "idempotency_mismatch",
    );
    await expectApiError(await create(key, { title: "Second Ask" }), 409, "idempotency_mismatch");

    // The mismatched resubmits never executed: still exactly one chat.
    expect(await ownerChatCount()).toBe(1);
  });

  // --- Crash points: kill the flow after each committed step, then re-POST the
  // SAME key. Each must converge to ONE world / ONE chat / `ready`.

  it("resumes a crash at `requested` (nothing committed yet)", async () => {
    const key = "crash-requested";
    await plantRecord(key, "requested");

    const body = await expectJson<CreatedWorld>(await create(key), 201);
    seededWorlds.add(body.worldId);
    expect(body.worldId).toBe(derivedWorldId(key));
    expect(await ownerChatCount()).toBe(1);
    expect((await recordOf(key))?.state).toBe("ready");
  });

  it("resumes a crash at `world_created` without building a second world", async () => {
    const key = "crash-world";
    const world = await preProvision(key);
    await plantRecord(key, "world_created", { worldId: world.worldId, branchId: world.branchId });

    const body = await expectJson<CreatedWorld>(await create(key), 201);
    // The SAME world finished, not a new one.
    expect(body.worldId).toBe(world.worldId);
    expect(body.branchId).toBe(world.branchId);
    expect(await branchCount(world.worldId)).toBe(1);
    expect(await ownerChatCount()).toBe(1);

    const [chat] = await db()
      .select({ authority: characterChats.engineAuthority, simBranchId: characterChats.simBranchId })
      .from(characterChats)
      .where(eq(characterChats.id, body.id));
    expect(chat).toMatchObject({ authority: "successor_narrative_view", simBranchId: world.branchId });
    expect((await recordOf(key))?.state).toBe("ready");
  });

  it("resumes a crash at `chat_created` without creating a second chat", async () => {
    const key = "crash-chat";
    const world = await preProvision(key);
    const [chatRow] = await db()
      .insert(characterChats)
      .values({ ownerId: ids.user, title: "half-built" })
      .returning({ id: characterChats.id });
    if (!chatRow) throw new Error("failed to plant the half-built chat");
    await db()
      .insert(chatParticipants)
      .values({ chatId: chatRow.id, characterId: ids.characterId, memoryGroupId: newId(), sort: 0 });
    await plantRecord(key, "chat_created", {
      worldId: world.worldId,
      branchId: world.branchId,
      chatId: chatRow.id,
    });

    const body = await expectJson<CreatedWorld>(await create(key), 201);
    // The half-built chat was ADOPTED, not abandoned for a fresh one.
    expect(body.id).toBe(chatRow.id);
    expect(await ownerChatCount()).toBe(1);
    const ledger = await db()
      .select({ kind: simRelationshipLedger.kind })
      .from(simRelationshipLedger)
      .where(eq(simRelationshipLedger.branchId, world.branchId));
    expect(ledger.filter((row) => row.kind === "authored_prior")).toHaveLength(2);
    expect((await recordOf(key))?.state).toBe("ready");
  });

  it("resumes a crash at `relationships_seeded` by only flipping authority", async () => {
    const key = "crash-seeded";
    const world = await preProvision(key);
    const [chatRow] = await db()
      .insert(characterChats)
      .values({ ownerId: ids.user, title: "awaiting the flip" })
      .returning({ id: characterChats.id });
    if (!chatRow) throw new Error("failed to plant the unflipped chat");
    await db()
      .insert(chatParticipants)
      .values({ chatId: chatRow.id, characterId: ids.characterId, memoryGroupId: newId(), sort: 0 });
    await plantRecord(key, "relationships_seeded", {
      worldId: world.worldId,
      branchId: world.branchId,
      chatId: chatRow.id,
    });

    const body = await expectJson<CreatedWorld>(await create(key), 201);
    expect(body.id).toBe(chatRow.id);
    const [chat] = await db()
      .select({ authority: characterChats.engineAuthority, simPlayerActorId: characterChats.simPlayerActorId })
      .from(characterChats)
      .where(eq(characterChats.id, chatRow.id));
    expect(chat?.authority).toBe("successor_narrative_view");
    expect(chat?.simPlayerActorId).toBe(world.playerActorId);
    expect(await ownerChatCount()).toBe(1);
    expect((await recordOf(key))?.state).toBe("ready");
  });

  it("completes a HALF-SEEDED world instead of failing on a duplicate key", async () => {
    const key = "half-seeded";
    const world = await preProvision(key);
    // Simulate a seed stage whose transaction never committed.
    await db().delete(simActionDefinitions).where(eq(simActionDefinitions.branchId, world.branchId));
    await plantRecord(key, "requested");

    const res = await create(key);
    expect(res.status).toBe(201);
    // The missing stage was re-seeded; the stages that HAD committed were skipped.
    // Both B8 actions come back — the guard is per STAGE, not per row.
    const actions = await db()
      .select({ id: simActionDefinitions.actionDefinitionId })
      .from(simActionDefinitions)
      .where(eq(simActionDefinitions.branchId, world.branchId));
    expect(actions).toHaveLength(2);
    expect(await branchCount(world.worldId)).toBe(1);
    const cast = await db()
      .select({ id: simCharacters.characterId })
      .from(simCharacters)
      .where(eq(simCharacters.branchId, world.branchId));
    expect(cast).toHaveLength(3);
  });

  // --- Failure path: a step failure rolls the whole provision back and answers
  // ONE honest diagnostic — the retired `seed_failed` / `flip_failed` half-states
  // (a live orphan world plus an unrouted chat) can no longer exist.
  it("cleans up and fails honestly when a step fails, then rebuilds on retry", async () => {
    const key = "fail-then-retry";
    const world = await preProvision(key);
    // A record that claims a chat which does not exist: the resume skips the chat
    // insert, seeds, then the authority flip finds nothing to route and fails.
    await plantRecord(key, "chat_created", {
      worldId: world.worldId,
      branchId: world.branchId,
      chatId: "chat-that-was-never-there",
    });

    // Fallback + diagnostic code (docs/resilience.md §8): one honest code, and
    // the compensating cleanup actually removed the graph.
    await expectApiError(await create(key), 500, "provision_failed");
    expect(await worldExists(world.worldId)).toBe(false);
    expect(await ownerChatCount()).toBe(0);
    const record = await recordOf(key);
    expect(record?.state).toBe("failed");
    expect(record?.error ?? "").not.toBe("");
    expect(record?.worldId).toBeNull();

    // A `failed` record is not a tombstone: the same key rebuilds from scratch,
    // because cleanup freed the ids the stamp derives.
    const retry = await createOk(key);
    expect(retry.worldId).toBe(derivedWorldId(key));
    expect(await worldExists(retry.worldId)).toBe(true);
    expect(await ownerChatCount()).toBe(1);
    expect((await recordOf(key))?.state).toBe("ready");
  });

  it("turns a concurrent create away with the busy face rather than doubling", async () => {
    // Whichever wins, its world id is derivable — so teardown needs no body read.
    seededWorlds.add(derivedWorldId("busy-a"));
    seededWorlds.add(derivedWorldId("busy-b"));
    const [a, b] = await Promise.all([create("busy-a"), create("busy-b")]);
    expect([a, b].filter((res) => res.status === 201)).toHaveLength(1);
    const bounced = [a, b].find((res) => res.status === 409);
    if (!bounced) throw new Error("expected exactly one bounce");
    await expectApiError(bounced, 409, "provision_busy");
    expect(await ownerChatCount()).toBe(1);
  });
});

describe.runIf(ready)("successor provisioning: the honest quota", () => {
  const CAP = 25;

  it("counts playable successor chats, so shadow chats never hold a slot", async () => {
    // The old predicate (`ne(engine_authority, 'legacy_chat')`) counted these,
    // even though `requireSimChat` rejects a shadow chat as unplayable.
    await seedChats(CAP, "successor_shadow");
    const created = await createOk("quota-shadow");
    expect(created.id).toBeTruthy();
  });

  it("admits the world that fits and turns the next one away", async () => {
    await seedChats(CAP - 1, "successor_narrative_view");
    await createOk("quota-fits");

    // Read as the whole envelope, not via expectApiError: the refusal's `limit`
    // and `used` are the honest-quota assertion, and the helper returns only the
    // shared `{ code, message }` pair.
    const overflow = await expectJson<{ error: { code: string; limit: number; used: number } }>(
      await create("quota-overflows"),
      409,
    );
    expect(overflow.error.code).toBe("too_many_worlds");
    expect(overflow.error.limit).toBe(CAP);
    expect(overflow.error.used).toBe(CAP);
    // The refusal built nothing and recorded nothing.
    expect(await recordOf("quota-overflows")).toBeUndefined();
    expect(await worldExists(derivedWorldId("quota-overflows"))).toBe(false);
  });

  it("charges an in-flight provision a slot but never a failed one", async () => {
    await seedChats(CAP - 1, "successor_narrative_view");
    await plantRecord("quota-inflight", "world_created", { worldId: derivedWorldId("quota-inflight") });

    const blocked = await expectJson<{ error: { used: number } }>(await create("quota-after-inflight"), 409);
    expect(blocked.error.used).toBe(CAP);

    // A failed record's cleanup already released its world, so it holds nothing.
    await db()
      .update(simProvisioningRequests)
      .set({ state: "failed", worldId: null })
      .where(
        and(eq(simProvisioningRequests.ownerId, ids.user), eq(simProvisioningRequests.requestId, "quota-inflight")),
      );
    const admitted = await createOk("quota-after-inflight");
    expect(admitted.worldId).toBe(derivedWorldId("quota-after-inflight"));
  });

  it("does not charge a resume or a replay against the cap", async () => {
    const replayKey = "quota-replay";
    const resumeKey = "quota-resume";
    const created = await createOk(replayKey);
    // A crash victim, mid-provision, whose world is already built.
    const stranded = await preProvision(resumeKey);
    await plantRecord(resumeKey, "world_created", { worldId: stranded.worldId, branchId: stranded.branchId });
    // The owner is now AT the cap on paper…
    await seedChats(CAP - 1, "successor_narrative_view");

    // …but its own finished request still replays verbatim…
    expect(await expectJson<CreatedWorld>(await create(replayKey), 201)).toEqual(created);

    // …and the stranded provision still finishes: the cap gates NEW worlds, and
    // locking a half-built one out would strand it forever.
    const resumed = await expectJson<CreatedWorld>(await create(resumeKey), 201);
    expect(resumed.worldId).toBe(stranded.worldId);
    expect((await recordOf(resumeKey))?.state).toBe("ready");

    // A genuinely new world is still refused.
    await expectApiError(await create("quota-new-at-cap"), 409, "too_many_worlds");
  });
});
