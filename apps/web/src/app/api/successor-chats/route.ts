import { and, desc, eq, inArray, ne } from "drizzle-orm";
import { NextResponse } from "next/server";
import { z } from "zod";
import { authoredRecordToLive, characterProfileSchema, emptyCharacterProfile } from "@/contracts";
import { newId } from "@/lib/ids";
import { parseOr } from "@/lib/parse";
import {
  deriveProvisioningStamp,
  provisioningPayloadHash,
  provisioningRequestIdSchema,
  PROVISIONING_STALE_AFTER_DELETE,
} from "@vesper/simulation-core/provisioning";
import { jsonError, jsonOk, readBody, withUser } from "@/server/api";
import {
  characterChats,
  characters,
  chatParticipants,
  db,
  simBranches,
  simProvisioningPendingStates,
  simProvisioningRequests,
} from "@/server/db";
import { log } from "@/server/log";
import {
  deleteSimWorldGraph,
  loadChatWardrobeWithStatus,
  provisionStarterWorld,
  seedChatState,
  setChatEngineAuthority,
  submitDurableRecordRelationshipEntry,
  tryKeyedLock,
} from "@/server/engine";
import { successorWardrobeSeed } from "./wardrobe-seed";

/**
 * The successor front door (owner ask 2026-07-22) — the Worlds page's API. POST
 * spins up a complete successor chat in one call: an ordinary character chat, a
 * starter world (isolated branch, cast named after the player and the
 * character), and the authority flip to `successor_narrative_view` with both
 * actors mapped — everything the backend setup used to require. GET lists the
 * caller's successor chats with each world's clock. Open to every signed-in user
 * (owner ruling: all users on this deployment are devs; sign-up is closed).
 *
 * Rulings E20-3 / the honest quota turned that five-step sequence into a
 * RESUMABLE one. The whole handler runs under `successor_provision:<ownerId>`,
 * so this route is the single writer per owner; inside the lock a durable
 * `sim_provisioning_requests` record advances after each committed step, and the
 * world's identity is DERIVED from the client's `requestId` — so a retry after
 * any failure finishes the world it
 * already started instead of minting a second one. The old `seed_failed` /
 * `flip_failed` half-states are gone: a step failure now runs compensating
 * cleanup (world graph + chat row) and answers ONE honest `provision_failed`.
 */

/** Per-user cap on successor chats — each one carries a whole provisioned world. */
const MAX_SUCCESSOR_CHATS = 25;

const createBodySchema = z
  .object({
    characterId: z.string().min(1).max(120),
    title: z.string().trim().max(120).optional(),
    /**
     * REQUIRED (unlike the sim-command lane's optional token): provisioning
     * cannot promise "one world per tap" without a stable key, and there is no
     * degraded default that still keeps that promise. A malformed one is a
     * plain 400 through `readBody`'s boundary parse.
     */
    requestId: provisioningRequestIdSchema,
  })
  .strict();

/** The 201 body a finished provision resolves to — recorded verbatim for replay. */
const provisionResponseSchema = z.object({
  id: z.string().min(1),
  worldId: z.string().min(1),
  branchId: z.string().min(1),
});
type ProvisionResponse = z.infer<typeof provisionResponseSchema>;

type ProvisioningState = (typeof simProvisioningRequests.$inferSelect)["state"];

/** Ordinal rank of each state, so "have we passed this step?" is one comparison. */
const STATE_RANK: Record<ProvisioningState, number> = {
  requested: 0,
  world_created: 1,
  chat_created: 2,
  relationships_seeded: 3,
  ready: 4,
  failed: 0,
};

interface ProvisioningRecord {
  state: ProvisioningState;
  payloadHash: string;
  worldId: string | null;
  branchId: string | null;
  chatId: string | null;
  response: unknown;
  httpStatus: number | null;
  /** Operator-facing failure reason; {@link PROVISIONING_STALE_AFTER_DELETE} is read as state. */
  error: string | null;
}

/**
 * What the compensating cleanup must undo if a later step fails. Tracked as the
 * flow goes rather than re-read at the end, so cleanup works even when the
 * failure is a thrown exception mid-step.
 */
interface ProvisionedSoFar {
  worldId: string | null;
  chatId: string | null;
}

/**
 * Undo a failed provision (ruling E20-3). The chat row goes first (its
 * `sim_branch_id` FK is `set null`, so order only affects tidiness), then the
 * world graph — which also frees the DERIVED ids, so the same key can be
 * retried from scratch rather than colliding with its own wreckage.
 *
 * Never throws: a cleanup that fails leaves an orphan for the slice-2 sweeper,
 * and the caller still owes the player one honest error
 * (docs/resilience.md — diagnostics over exceptions).
 */
async function cleanupPartialProvision(built: ProvisionedSoFar, ownerId: string, requestId: string): Promise<void> {
  try {
    if (built.chatId !== null) {
      await db()
        .delete(characterChats)
        .where(and(eq(characterChats.id, built.chatId), eq(characterChats.ownerId, ownerId)));
    }
    if (built.worldId !== null) await deleteSimWorldGraph(built.worldId);
  } catch (error) {
    log.warn("engine.sim.provisioning", "compensating cleanup failed; the orphan sweeper is the backstop", {
      code: "provisioning.cleanup_failed",
      ownerId,
      requestId,
      worldId: built.worldId,
      chatId: built.chatId,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

/** Advance the durable record; a patch is only ever applied to this owner's own key. */
async function updateRecord(
  ownerId: string,
  requestId: string,
  patch: Partial<typeof simProvisioningRequests.$inferInsert>,
): Promise<void> {
  await db()
    .update(simProvisioningRequests)
    .set(patch)
    .where(and(eq(simProvisioningRequests.ownerId, ownerId), eq(simProvisioningRequests.requestId, requestId)));
}

/**
 * Does the world this record recorded still exist, whole, and still belong to
 * this owner? The replay guard's question (#197).
 *
 * A `ready` record stores the ids it built, but nothing in the schema keeps
 * those ids honest: `worldId` / `branchId` / `chatId` are SOFT pointers on
 * purpose, so a failed provision's audit row survives the cleanup that deleted
 * the graph it names (#283 — no cascade FK here). That same softness means a
 * later chat delete leaves a `ready` record pointing at three tombstones, and
 * replaying its stored 201 would hand the client ids for resources that are
 * gone.
 *
 * One join answers all of it: the chat must exist, be owned by this caller, and
 * still be routed at exactly the branch the record named, and that branch must
 * still hang off exactly the recorded world. Branch existence implies the world
 * exists (`sim_branches` cascades from `sim_worlds`), and the `world_id`
 * equality is what catches a re-pointed chat rather than a deleted one. Any null
 * id fails: a record that never recorded an id has nothing to prove alive.
 */
async function provisionedGraphAlive(record: ProvisioningRecord, ownerId: string): Promise<boolean> {
  const { chatId, branchId, worldId } = record;
  if (chatId === null || branchId === null || worldId === null) return false;
  const [alive] = await db()
    .select({ id: characterChats.id })
    .from(characterChats)
    .innerJoin(simBranches, eq(simBranches.id, characterChats.simBranchId))
    .where(
      and(
        eq(characterChats.id, chatId),
        eq(characterChats.ownerId, ownerId),
        eq(characterChats.simBranchId, branchId),
        eq(simBranches.worldId, worldId),
      ),
    )
    .limit(1);
  return alive !== undefined;
}

/**
 * Retire a record whose world is gone, and answer honestly (#197).
 *
 * Deliberately NOT a rebuild in this request. The caller asked to finish a
 * world they have since deleted; silently minting a second one under the same
 * key would be a surprise, and the delete is the more recent intent. So the
 * record is written into the ordinary `failed` shape — the one the failure path
 * already writes, ids and recorded response nulled — with
 * {@link PROVISIONING_STALE_AFTER_DELETE} left in `error` so the ledger says
 * why, and the caller gets a typed refusal.
 *
 * A further POST with the SAME key then takes the ordinary failed → retry path
 * and builds a fresh world from scratch: the record's derived ids are free
 * again precisely because the world graph died with the chat. That is the
 * "existing failed/retry behavior" recovery path, reached in one extra tap
 * rather than by guessing on the player's behalf. Nulling `chatId` here is also
 * what makes the refusal happen ONCE — see the stale-marked branch in
 * {@link runProvisioning}.
 */
async function retireStaleRecord(ownerId: string, requestId: string, record: ProvisioningRecord): Promise<Response> {
  await updateRecord(ownerId, requestId, {
    state: "failed",
    worldId: null,
    branchId: null,
    chatId: null,
    response: null,
    httpStatus: null,
    error: PROVISIONING_STALE_AFTER_DELETE,
    completedAt: new Date(),
  });
  log.warn("engine.sim.provisioning", "a provisioning record named a world that no longer exists; retiring it", {
    code: "provisioning.replay_stale",
    ownerId,
    requestId,
    worldId: record.worldId,
    branchId: record.branchId,
    chatId: record.chatId,
  });
  return jsonError("provision_stale", "that world was deleted; create a new one", 409);
}

/**
 * The honest quota (ruling E20-3's sibling). Counts what is REAL:
 * chats the successor engine actually owns (`successor_narrative_view` — the
 * old internal `ne("legacy_chat")` expression also counted `successor_shadow`
 * chats, which `requireSimChat` rejects as unplayable), plus this owner's other
 * in-flight provisioning records (an in-flight world is a world; a `failed`
 * one has had its graph cleaned up and holds nothing).
 *
 * A record whose chat is already counted is not counted twice — that is only
 * reachable in the one-statement window between the authority flip and the
 * `ready` write, but it should not silently cost the owner a slot.
 *
 * `successor_authoritative` is deliberately absent: nothing sets it yet, and the
 * front door only ever mints `successor_narrative_view`. Whatever promotes a
 * chat to it owns adding it here.
 *
 * Race-free by construction: provisioning is serialized per owner by the lock,
 * so the count and the write that makes it true cannot interleave (the old
 * plain SELECT let two requests at N−1 both pass).
 */
async function countUsedWorlds(ownerId: string, exceptRequestId: string): Promise<number> {
  const chats = await db()
    .select({ id: characterChats.id })
    .from(characterChats)
    .where(
      and(eq(characterChats.ownerId, ownerId), eq(characterChats.engineAuthority, "successor_narrative_view")),
    );
  const chatIds = new Set(chats.map((chat) => chat.id));
  const inFlight = await db()
    .select({ requestId: simProvisioningRequests.requestId, chatId: simProvisioningRequests.chatId })
    .from(simProvisioningRequests)
    .where(
      and(
        eq(simProvisioningRequests.ownerId, ownerId),
        inArray(simProvisioningRequests.state, [...simProvisioningPendingStates]),
        ne(simProvisioningRequests.requestId, exceptRequestId),
      ),
    );
  const pending = inFlight.filter((row) => row.chatId === null || !chatIds.has(row.chatId)).length;
  return chatIds.size + pending;
}

function tooManyWorlds(used: number): NextResponse {
  // The rate-limit family's metadata idiom, minus `retry`: like the storage
  // quota, a world slot frees when the owner deletes one — an action, not an
  // instant, so advertising a retry time would be a lie.
  return NextResponse.json(
    {
      error: {
        code: "too_many_worlds",
        message: `you already have ${MAX_SUCCESSOR_CHATS} worlds; delete one first`,
        limit: MAX_SUCCESSOR_CHATS,
        used,
      },
    },
    { status: 409 },
  );
}

interface ProvisionInput {
  ownerId: string;
  ownerName: string;
  requestId: string;
  characterId: string;
  title: string;
}

/**
 * Run (or finish) one provision under the owner lock. Returns the response to
 * send. Every step is skipped when the record says it already committed, and
 * every step is idempotent anyway — the belt for the crash-in-the-middle-of-a-
 * step case the record cannot see.
 */
async function runProvisioning(input: ProvisionInput): Promise<Response> {
  const { ownerId, requestId } = input;
  const payloadHash = provisioningPayloadHash({ characterId: input.characterId, title: input.title });

  const [existing] = await db()
    .select({
      state: simProvisioningRequests.state,
      payloadHash: simProvisioningRequests.payloadHash,
      worldId: simProvisioningRequests.worldId,
      branchId: simProvisioningRequests.branchId,
      chatId: simProvisioningRequests.chatId,
      response: simProvisioningRequests.response,
      httpStatus: simProvisioningRequests.httpStatus,
      error: simProvisioningRequests.error,
    })
    .from(simProvisioningRequests)
    .where(and(eq(simProvisioningRequests.ownerId, ownerId), eq(simProvisioningRequests.requestId, requestId)))
    .limit(1);
  const record: ProvisioningRecord | undefined = existing;

  let resumeFrom: ProvisioningState = "requested";
  const built: ProvisionedSoFar = { worldId: null, chatId: null };

  // A reused key carrying a DIFFERENT ask is a client bug — never replay an
  // unrelated world (the `sim_command_requests` guard, owner-scoped). Checked
  // before anything else, so a mismatch can never touch the library or the cap.
  if (record && record.payloadHash !== payloadHash) {
    return jsonError("idempotency_mismatch", "this request id was already used for a different world", 409);
  }
  // #197 — the ids first, the response second. Both stale paths land here,
  // ahead of the library lookup, so a deleted world answers the same way whether
  // or not the character it was born from survived.
  //
  //  * A `ready` record is the only state that TRUSTS its stored ids without
  //    rebuilding anything: the replay below returns them verbatim and the
  //    `replayUnreadable` resume below resumes ON them, so both are wrong the
  //    moment the chat and its world have been deleted. One check covers both.
  //  * A `failed` record still CARRYING ids and marked
  //    `PROVISIONING_STALE_AFTER_DELETE` is `deleteChat`'s belt: the delete
  //    already retired the row, and the refusal it implies has not been reported
  //    to this key's client yet. Retiring it nulls those ids, so the next POST
  //    with the same key is an ordinary failed → retry and rebuilds.
  if (record?.state === "ready" && !(await provisionedGraphAlive(record, ownerId))) {
    return retireStaleRecord(ownerId, requestId, record);
  }
  if (record?.state === "failed" && record.error === PROVISIONING_STALE_AFTER_DELETE && record.chatId !== null) {
    return retireStaleRecord(ownerId, requestId, record);
  }

  let replayUnreadable = false;
  if (record?.state === "ready" && record.httpStatus !== null) {
    // Verbatim replay: one world, one chat, one 201 — no matter how many taps.
    // Ahead of the library lookup too: a finished world stays replayable even if
    // the character it was born from has since been deleted.
    const replayed = parseOr(provisionResponseSchema.nullable(), record.response, null, undefined, "sim_provisioning_requests.response");
    if (replayed) return jsonOk(replayed, record.httpStatus);
    // A `ready` row whose recorded body no longer parses cannot be replayed
    // honestly; re-running is safe (every step is idempotent) so degrade to that.
    log.warn("engine.sim.provisioning", "ready record carried an unreadable response; re-running the provision", {
      code: "provisioning.replay_unreadable",
      ownerId,
      requestId,
    });
    replayUnreadable = true;
  }

  const [character] = await db()
    .select({ id: characters.id, name: characters.name, profile: characters.profile })
    .from(characters)
    .where(and(eq(characters.id, input.characterId), eq(characters.ownerId, ownerId)));
  if (!character) return jsonError("not_found", "that character is not in your library", 404);

  if (record) {
    if (replayUnreadable) {
      resumeFrom = "relationships_seeded";
      built.worldId = record.worldId;
      built.chatId = record.chatId;
    } else if (record.state === "failed") {
      // Its cleanup already removed the graph, so the derived ids are free:
      // reset and build again from scratch under the SAME stamp.
      await updateRecord(ownerId, requestId, {
        state: "requested",
        worldId: null,
        branchId: null,
        chatId: null,
        response: null,
        httpStatus: null,
        error: null,
        completedAt: null,
      });
      resumeFrom = "requested";
    } else {
      // A crash remnant: resume from where the record says it got to. The lock
      // is single-holder, so no live peer is still working this key.
      resumeFrom = record.state;
      built.worldId = record.worldId;
      built.chatId = record.chatId;
    }
  } else {
    // Only a genuinely NEW request is charged against the cap; a resume or a
    // replay of an already-counted world must never be turned away.
    const used = await countUsedWorlds(ownerId, requestId);
    if (used >= MAX_SUCCESSOR_CHATS) return tooManyWorlds(used);
    await db()
      .insert(simProvisioningRequests)
      .values({ ownerId, requestId, payloadHash, state: "requested" })
      .onConflictDoNothing();
  }

  const reached = STATE_RANK[resumeFrom];
  // R5: the character's authored default outfit becomes WORN world
  // items at birth — resolved through the same wardrobe seam the character-chat
  // seed uses, so the outfit chip shows the same clothes, now from world truth.
  const profile = parseOr(characterProfileSchema, character.profile ?? {}, emptyCharacterProfile(), undefined, "characters.profile");

  try {
    // --- Step 1: the world. Idempotent on the derived stamp, so this both
    // creates a fresh world and completes a half-built one. The wardrobe load
    // is a MINT input, not a display read: unknown coverage must refuse before
    // `provisionStarterWorld` can persist an empty/partial outfit forever.
    const wornIds = seedChatState(profile).wornItemIds;
    let primaryGarments: { name: string; slotKey: string }[] = [];
    if (reached < STATE_RANK.world_created && wornIds.length > 0) {
      const load = await loadChatWardrobeWithStatus(ownerId, wornIds);
      const seed = successorWardrobeSeed(load);
      if (!seed.ok) {
        throw new Error(
          `starter wardrobe unavailable (${seed.reason}${seed.itemIds.length > 0 ? `: ${seed.itemIds.join(",")}` : ""})`,
        );
      }
      primaryGarments = seed.garments;
    }
    const world = await provisionStarterWorld({
      stamp: deriveProvisioningStamp(ownerId, requestId),
      playerName: (input.ownerName || "").split(/\s+/)[0] ?? "",
      primaryName: character.name,
      primaryGarments,
    });
    built.worldId = world.worldId;
    if (reached < STATE_RANK.world_created) {
      await updateRecord(ownerId, requestId, {
        state: "world_created",
        worldId: world.worldId,
        branchId: world.branchId,
      });
    }

    // --- Step 2: the chat. The insert and the record advance share ONE
    // transaction, so a crash can never leave a chat row this key cannot find.
    // (`built.chatId` carries a RESUMED chat only — a reset `failed` record left
    // it null, so a rebuild never reuses the chat id its cleanup deleted.)
    let chatId = built.chatId;
    if (reached < STATE_RANK.chat_created || chatId === null) {
      chatId = newId();
      const newChatId = chatId;
      await db().transaction(async (tx) => {
        await tx.insert(characterChats).values({
          id: newChatId,
          ownerId,
          title: input.title || `${character.name}'s world`,
        });
        // Fresh memory island: successor chats never join shared character-chat history.
        await tx
          .insert(chatParticipants)
          .values({ chatId: newChatId, characterId: character.id, memoryGroupId: newId(), sort: 0 });
        await tx
          .update(simProvisioningRequests)
          .set({ state: "chat_created", chatId: newChatId })
          .where(
            and(eq(simProvisioningRequests.ownerId, ownerId), eq(simProvisioningRequests.requestId, requestId)),
          );
      });
    }
    built.chatId = chatId;

    // --- Step 3: relationships. R5: an AUTHORED starting relationship becomes
    // an authored_prior ledger entry pair, weighted so the relationship read
    // round-trips the authored regard exactly (trust 36r + attraction 8r ⇒ blended 40r ⇒
    // regard r). No authored record ⇒ no prior ⇒ the ledger starts honest-empty
    // and the chip keeps the character-chat seed until evidence accumulates. The
    // idempotency keys are branch-derived and the branch id is now stable, so a
    // resume replays the recorded acceptance instead of writing a second pair.
    if (reached < STATE_RANK.relationships_seeded) {
      if (profile.playerRelationship) {
        const live = authoredRecordToLive(profile.playerRelationship);
        const weightOverride = {
          trustFixedPoint: live.regard * 36,
          attractionFixedPoint: live.regard * 8,
          resentmentFixedPoint: 0,
        };
        const detail = profile.playerRelationship.history.trim() || "authored starting relationship";
        for (const [from, to, name] of [
          [world.playerActorId, world.primaryActorId, "prior-toward-primary"],
          [world.primaryActorId, world.playerActorId, "prior-toward-player"],
        ] as const) {
          const seeded = await submitDurableRecordRelationshipEntry(
            {
              id: `${world.branchId}-cmd-${name}`,
              branchId: world.branchId,
              expectedVersion: 0,
              idempotencyKey: `${world.branchId}-${name}`,
              principal: { kind: "storyteller" as const, principalId: ownerId, controlledActorIds: [] },
              submittedAtWallClock: new Date().toISOString(),
              correlationId: `stw-seed-${world.branchId}`,
              type: "record_relationship_entry",
              schemaVersion: 1,
              // No storySecond override: the prior lands "now" so the relationship read's
              // time decay starts from the story's first moment, not before it.
              payload: { fromActorId: from, toActorId: to, kind: "authored_prior", detail: detail.slice(0, 500), weightOverride },
            },
            { admitAtLockedVersion: true },
          );
          if (seeded.status !== "accepted") {
            throw new Error(`the authored relationship could not seed: ${JSON.stringify(seeded)}`);
          }
        }
      }
      await updateRecord(ownerId, requestId, { state: "relationships_seeded" });
    }

    // --- Step 4: the authority flip, then `ready` with the recorded response.
    // The flip is a plain UPDATE, so re-running it after a crash is a no-op.
    const flipped = await setChatEngineAuthority({
      chatId,
      byUserId: ownerId,
      authority: "successor_narrative_view",
      // R5 knowledge/memory: the recall routes for successor chats from birth.
      ragEligibility: true,
      simBranchId: world.branchId,
      simPlayerActorId: world.playerActorId,
      simPrimaryActorId: world.primaryActorId,
    });
    if (!flipped) throw new Error("the chat could not be routed to the successor engine");

    const response: ProvisionResponse = { id: chatId, worldId: world.worldId, branchId: world.branchId };
    await updateRecord(ownerId, requestId, {
      state: "ready",
      response,
      httpStatus: 201,
      completedAt: new Date(),
    });
    return jsonOk(response, 201);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    await cleanupPartialProvision(built, ownerId, requestId);
    await updateRecord(ownerId, requestId, {
      state: "failed",
      worldId: null,
      branchId: null,
      chatId: null,
      error: detail.slice(0, 1_000),
      completedAt: new Date(),
    }).catch((updateError: unknown) => {
      log.warn("engine.sim.provisioning", "could not record the provisioning failure", {
        code: "provisioning.record_failed",
        ownerId,
        requestId,
        error: updateError instanceof Error ? updateError.message : String(updateError),
      });
    });
    // ONE honest diagnostic — the old `seed_failed` / `flip_failed` pair named
    // half-states that no longer exist, because nothing partial survives.
    log.warn("engine.sim.provisioning", "world provisioning failed and was rolled back", {
      code: "provisioning.failed",
      ownerId,
      requestId,
      error: detail,
    });
    return jsonError("provision_failed", "the world could not be created; nothing was left behind — try again", 500);
  }
}

export const POST = withUser(async (user, req) => {
  const body = await readBody(req, createBodySchema);
  if (!body.ok) return body.response;

  // Serialize per OWNER. This handler is then the single writer for this
  // account's worlds — which is also what makes the quota count race-free.
  // Contention turns away with the message lane's quiet busy face (the
  // `chat_busy` idiom, ruling A1-1) rather than queueing a second world.
  const held = tryKeyedLock(`successor_provision:${user.id}`, () =>
    runProvisioning({
      ownerId: user.id,
      ownerName: user.name ?? "",
      requestId: body.value.requestId,
      characterId: body.value.characterId,
      title: body.value.title?.trim() ?? "",
    }),
  );
  if (held === null) {
    return jsonError("provision_busy", "another world is already being created for you; try again in a moment", 409);
  }
  return held;
});

/** GET /api/successor-chats — the caller's successor chats, newest first, with each world's clock. */
export const GET = withUser(async (user) => {
  const rows = await db()
    .select({
      id: characterChats.id,
      title: characterChats.title,
      authority: characterChats.engineAuthority,
      simBranchId: characterChats.simBranchId,
      lastMessageAt: characterChats.lastMessageAt,
    })
    .from(characterChats)
    .where(and(eq(characterChats.ownerId, user.id), ne(characterChats.engineAuthority, "legacy_chat")))
    .orderBy(desc(characterChats.lastMessageAt))
    .limit(100);
  if (rows.length === 0) return jsonOk({ chats: [] });

  const branchIds = rows.flatMap((row) => (row.simBranchId ? [row.simBranchId] : []));
  const branches = branchIds.length
    ? await db()
        .select({ id: simBranches.id, storySecond: simBranches.storySecond })
        .from(simBranches)
        .where(inArray(simBranches.id, branchIds))
    : [];
  const clocks = new Map(branches.map((branch) => [branch.id, branch.storySecond]));
  const primaries = await db()
    .select({ chatId: chatParticipants.chatId, sort: chatParticipants.sort, name: characters.name })
    .from(chatParticipants)
    .innerJoin(characters, eq(characters.id, chatParticipants.characterId))
    .where(inArray(chatParticipants.chatId, rows.map((row) => row.id)));
  const primaryName = new Map<string, string>();
  for (const row of primaries.sort((a, b) => b.sort - a.sort)) primaryName.set(row.chatId, row.name);

  return jsonOk({
    chats: rows.map((row) => ({
      id: row.id,
      title: row.title,
      characterName: primaryName.get(row.id) ?? "",
      authority: row.authority,
      storySecond: row.simBranchId === null ? null : (clocks.get(row.simBranchId) ?? null),
      lastMessageAt: row.lastMessageAt instanceof Date ? row.lastMessageAt.toISOString() : String(row.lastMessageAt),
    })),
  });
});