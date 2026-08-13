import { eq, sql } from "drizzle-orm";
import type { NextRequest } from "next/server";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  activeContactsOf,
  affordanceSubjectId,
  commitContactResolution,
  contactCommitEvents,
  contactEventRef,
  emptyContactLifecycleState,
  emptySceneState,
  parseSceneState,
  resolveContactAttempt,
  withSceneContacts,
  withSceneParticipant,
  type CommittedContactOutcome,
  type SceneState,
} from "@/contracts";
// Probe builders are deliberately out of both barrels — a probe contact that
// reached production would be a claim nobody made.
import {
  probeAttempt,
  probeBodySurface,
  probeControl,
  probePolicy,
} from "@/contracts/affordances/contact/test-support";
import { newId } from "@/lib/ids";
import {
  characterChatMessages,
  characterChats,
  characters,
  chatParticipants,
  db,
  events,
} from "@/server/db";

const authState = vi.hoisted(() => ({
  user: { id: "", email: "", name: "Permission Override Int", role: "admin" as const },
}));

vi.mock("@/server/auth", async () => (await import("@/server/test-support")).routeAuthModule(authState));

import {
  appendChatContactEventsWithScene,
  keyedLockBusy,
  listChatContactEvents,
  listChatPermissionEvents,
  tryKeyedLock,
  type ChatDbTransaction,
} from "@/server/engine";
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
  withAuthUser,
} from "@/server/test-support";
import { ROMANTIC_PERMISSION_OVERRIDE_AUDIT_TYPE } from "./shared";
import { GET as permissionsGet, POST as permissionsPost } from "./[chatId]/route";

/**
 * The `romantic_touch` developer-override endpoint, end to end
 * (romantic-contact-affordances.spec.permission.md §"Authorship and developer
 * controls"; plan rulings 1 and 5; implementation-order step 2) — what only the
 * real route + a real Postgres can prove:
 *
 * - an override records the ledger row AND its app-`events` audit row through
 *   one transactional append, stamped with the chat's clock and newest message;
 * - a withdraw override ends a seeded permission-dependent contact through the
 *   SAME invalidation sweep production events use — permission row, contact
 *   end, swept scene, and audit all present after the one call;
 * - the capability gate: `CHAT_ROMANTIC_PERMISSION_DEV_OVERRIDE` off ⇒ POST is
 *   the hidden 404 and writes nothing, while GET stays readable;
 * - direction rules: the player can never be a granting target, and granting
 *   one direction leaves the reverse untouched;
 * - no-op semantics: a redundant override still records, and says so;
 * - authorization: non-admins, the canonical (non-`/self/`) namespace, and
 *   admins who do not own the chat all collapse to the same hidden 404 for
 *   BOTH verbs (the route-level half of the authz matrix's convention);
 * - serialization: the override HOLDS the lane's `chat_exchange:<chatId>` lock
 *   across its whole write (not merely probing it), and the append's scene
 *   compare-and-swap refuses — writing nothing anywhere — when another writer
 *   moves the scene under the invalidation sweep.
 *
 * The ledger's own durability/idempotency laws are chat-permission.int.test.ts's;
 * the direction-validation table is validate.test.ts's.
 */

const ready = await probeIntegrationDb("chat-permissions.int.test", "chat_permission_events");

const selfPath = (chatId: string) => `/api/admin/self/chat-permissions/${chatId}`;
const getReq = (path: string): NextRequest => apiRequest(path);
const postReq = (path: string, body: unknown): NextRequest => apiRequest(path, { method: "POST", body });

const PLAYER = "player";
const CLOCK_MINUTES = 240;

const ids = { user: "", adversary: "", npcA: "", npcB: "" };

interface OverviewWire {
  scope: string;
  playerSubjectId: string;
  overrideEnabled: boolean;
  grants: { permittedActorId: string; grantingTargetId: string; scope: string; standing: string }[];
  events: { id: string; kind: string; operation: string | null; sourceKind: string }[];
}

interface OverrideWire {
  eventId: string;
  operation: string;
  standingBefore: string | null;
  standingAfter: string;
  standingChanged: boolean;
  endedContactIds: string[];
}

beforeAll(async () => {
  if (!ready) return;
  const user = await seedTestUser("chat-permissions-int", { name: "Permission Override Int", role: "admin" });
  bindAuthUser(authState, user);
  ids.user = user.id;
  const adversary = await seedTestUser("chat-permissions-adv", { name: "Permission Adversary", role: "admin" });
  ids.adversary = adversary.id;

  const [npcA] = await db()
    .insert(characters)
    .values({ ownerId: user.id, name: "Mara", profile: {} })
    .returning({ id: characters.id });
  const [npcB] = await db()
    .insert(characters)
    .values({ ownerId: user.id, name: "Alex", profile: {} })
    .returning({ id: characters.id });
  if (!npcA || !npcB) throw new Error("failed to seed roster characters");
  ids.npcA = npcA.id;
  ids.npcB = npcB.id;
});

afterAll(async () => {
  if (ready && ids.user) {
    await db().delete(events).where(eq(events.type, ROMANTIC_PERMISSION_OVERRIDE_AUDIT_TYPE));
    await purgeOwnerRows([ids.user, ids.adversary]);
  }
  await endTestPool();
});

afterEach(() => {
  vi.unstubAllEnvs();
});

/** The mutation capability, on for the test at hand (off is each test's default). */
const enableOverride = () => vi.stubEnv("CHAT_ROMANTIC_PERMISSION_DEV_OVERRIDE", "on");

/** A fresh two-NPC conversation with one prompting message and a set clock. */
async function newPermissionChat(): Promise<{ chatId: string; messageId: string }> {
  const [chat] = await db()
    .insert(characterChats)
    .values({ ownerId: ids.user, clockMinutes: CLOCK_MINUTES })
    .returning({ id: characterChats.id });
  if (!chat) throw new Error("failed to seed chat");
  await db()
    .insert(chatParticipants)
    .values([
      { chatId: chat.id, characterId: ids.npcA, memoryGroupId: newId(), sort: 0 },
      { chatId: chat.id, characterId: ids.npcB, memoryGroupId: newId(), sort: 1 },
    ]);
  const [message] = await db()
    .insert(characterChatMessages)
    .values({ chatId: chat.id, role: "user", content: "Hi" })
    .returning({ id: characterChatMessages.id });
  if (!message) throw new Error("failed to seed message");
  return { chatId: chat.id, messageId: message.id };
}

/** The stored scene column, through the same boundary the pipeline reads. */
async function storedScene(chatId: string): Promise<SceneState> {
  const [row] = await db()
    .select({ scene: characterChats.scene })
    .from(characterChats)
    .where(eq(characterChats.id, chatId));
  return row?.scene === null || row?.scene === undefined ? emptySceneState() : parseSceneState(row.scene);
}

/** This chat's audit rows, oldest first. */
async function auditRows(chatId: string): Promise<Record<string, unknown>[]> {
  const rows = await db()
    .select({ payload: events.payload })
    .from(events)
    .where(eq(events.type, ROMANTIC_PERMISSION_OVERRIDE_AUDIT_TYPE));
  return rows
    .map((row) => row.payload as Record<string, unknown>)
    .filter((payload) => payload.chatId === chatId);
}

/**
 * A LIVE romantic contact by the PLAYER on npcA, durably committed the way the
 * contact leg commits one — the dependent state the withdraw override must end
 * through the production sweep.
 */
async function seedPlayerRomanticContact(chat: { chatId: string; messageId: string }): Promise<CommittedContactOutcome> {
  const player = affordanceSubjectId(PLAYER);
  const target = affordanceSubjectId(ids.npcA);
  const resolution = resolveContactAttempt(
    probeAttempt({
      intent: {
        actorId: player,
        source: probeBodySurface(player, "hands"),
        target: probeBodySurface(target, "feet", "arch"),
        actionKind: "romantic",
        storyTime: 100,
      },
      context: {
        actorControl: probeControl("allowed", player),
        policy: probePolicy("allowed", "romantic"),
      },
    }),
  );
  if (resolution.status !== "committable") throw new Error(`fixture did not commit: ${resolution.status}`);
  const eventRef = contactEventRef(`contact:${chat.messageId}`);
  const outcome = commitContactResolution({ state: emptyContactLifecycleState(), resolution, eventRef });
  if (outcome.status !== "committed") throw new Error(`fixture was refused: ${outcome.reason}`);
  const appended = await appendChatContactEventsWithScene({
    chatId: chat.chatId,
    guardMessageId: chat.messageId,
    eventRef,
    storyMinute: 100,
    commits: contactCommitEvents(outcome),
    scene: withSceneContacts(emptySceneState(), outcome.state),
  });
  expect(appended.status).toBe("recorded");
  return outcome;
}

describe.runIf(ready)("GET — read-only inspection, capability-independent", () => {
  it("answers the empty projection for a fresh chat with the capability OFF", async () => {
    vi.stubEnv("CHAT_ROMANTIC_PERMISSION_DEV_OVERRIDE", ""); // the explicit OFF state
    const chat = await newPermissionChat();
    const res = await permissionsGet(getReq(selfPath(chat.chatId)), routeCtx({ chatId: chat.chatId }));
    const body = await expectJson<OverviewWire>(res, 200);
    expect(body).toMatchObject({
      scope: "romantic_touch",
      playerSubjectId: PLAYER,
      overrideEnabled: false,
      grants: [],
      events: [],
    });
  });
});

describe.runIf(ready)("POST — the audited override", () => {
  it("records the ledger row and the audit event atomically, anchored to clock and newest message", async () => {
    enableOverride();
    const chat = await newPermissionChat();
    const res = await permissionsPost(
      postReq(selfPath(chat.chatId), { permittedActorId: PLAYER, grantingTargetId: ids.npcA, operation: "grant" }),
      routeCtx({ chatId: chat.chatId }),
    );
    const body = await expectJson<OverrideWire>(res, 200);
    expect(body).toMatchObject({
      operation: "grant",
      standingBefore: null,
      standingAfter: "granted",
      standingChanged: true,
      endedContactIds: [],
    });

    const rows = await listChatPermissionEvents(chat.chatId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      guardMessageId: chat.messageId,
      eventRef: `permission-override:${body.eventId}`,
      sequence: 0,
      kind: "developer_overridden",
      sourceKind: "developer_override",
      permittedActorId: PLAYER,
      grantingTargetId: ids.npcA,
      scope: "romantic_touch",
      storyMinute: CLOCK_MINUTES,
    });
    expect(rows[0]?.payload).toMatchObject({ eventId: body.eventId, operation: "grant", storyTime: CLOCK_MINUTES });

    // The audit rode the same transaction, and names the whole decision.
    const audits = await auditRows(chat.chatId);
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({
      schemaVersion: 1,
      chatId: chat.chatId,
      byUserId: ids.user,
      permittedActorId: PLAYER,
      grantingTargetId: ids.npcA,
      scope: "romantic_touch",
      operation: "grant",
      storyMinute: CLOCK_MINUTES,
      endedContactIds: [],
    });

    // The projection agrees, and the recent-event list carries the override.
    const overview = await expectJson<OverviewWire>(
      await permissionsGet(getReq(selfPath(chat.chatId)), routeCtx({ chatId: chat.chatId })),
      200,
    );
    expect(overview.grants).toEqual([
      expect.objectContaining({ permittedActorId: PLAYER, grantingTargetId: ids.npcA, standing: "granted" }),
    ]);
    expect(overview.events).toEqual([
      expect.objectContaining({ kind: "developer_overridden", operation: "grant", sourceKind: "developer_override" }),
    ]);
  });

  it("grant A→B leaves B→A untouched — each direction is its own record", async () => {
    enableOverride();
    const chat = await newPermissionChat();
    await expectJson(
      await permissionsPost(
        postReq(selfPath(chat.chatId), { permittedActorId: ids.npcB, grantingTargetId: ids.npcA, operation: "grant" }),
        routeCtx({ chatId: chat.chatId }),
      ),
      200,
    );
    const overview = await expectJson<OverviewWire>(
      await permissionsGet(getReq(selfPath(chat.chatId)), routeCtx({ chatId: chat.chatId })),
      200,
    );
    expect(overview.grants).toEqual([
      expect.objectContaining({ permittedActorId: ids.npcB, grantingTargetId: ids.npcA, standing: "granted" }),
    ]);
    // The reverse direction has no entry at all — absence, not denial.
    expect(
      overview.grants.some((grant) => grant.permittedActorId === ids.npcA && grant.grantingTargetId === ids.npcB),
    ).toBe(false);
  });

  it("a redundant override still records, and the response says standing did not change", async () => {
    enableOverride();
    const chat = await newPermissionChat();
    const body = { permittedActorId: PLAYER, grantingTargetId: ids.npcB, operation: "grant" };
    const first = await expectJson<OverrideWire>(
      await permissionsPost(postReq(selfPath(chat.chatId), body), routeCtx({ chatId: chat.chatId })),
      200,
    );
    expect(first.standingChanged).toBe(true);

    const second = await expectJson<OverrideWire>(
      await permissionsPost(postReq(selfPath(chat.chatId), body), routeCtx({ chatId: chat.chatId })),
      200,
    );
    expect(second).toMatchObject({ standingBefore: "granted", standingAfter: "granted", standingChanged: false });
    expect(second.eventId).not.toBe(first.eventId);
    // The ledger is evidence: both overrides are rows.
    expect(await listChatPermissionEvents(chat.chatId)).toHaveLength(2);
    expect(await auditRows(chat.chatId)).toHaveLength(2);
  });

  it("a withdraw override ends the dependent contact through the production sweep — all four surfaces in one call", async () => {
    enableOverride();
    const chat = await newPermissionChat();
    await expectJson(
      await permissionsPost(
        postReq(selfPath(chat.chatId), { permittedActorId: PLAYER, grantingTargetId: ids.npcA, operation: "grant" }),
        routeCtx({ chatId: chat.chatId }),
      ),
      200,
    );
    const seeded = await seedPlayerRomanticContact(chat);
    expect(activeContactsOf((await storedScene(chat.chatId)).contacts)).toHaveLength(1);

    const withdrawal = await expectJson<OverrideWire>(
      await permissionsPost(
        postReq(selfPath(chat.chatId), { permittedActorId: PLAYER, grantingTargetId: ids.npcA, operation: "withdraw" }),
        routeCtx({ chatId: chat.chatId }),
      ),
      200,
    );
    expect(withdrawal).toMatchObject({
      standingBefore: "granted",
      standingAfter: "withdrawn",
      standingChanged: true,
      endedContactIds: [seeded.contact.contactId],
    });

    // 1. The permission ledger holds the withdraw override.
    const permissionRows = await listChatPermissionEvents(chat.chatId);
    expect(permissionRows.map((row) => row.kind)).toEqual(["developer_overridden", "developer_overridden"]);
    // 2. The contact ledger carries the end UNDER THE OVERRIDE'S event ref.
    const contactRows = await listChatContactEvents(chat.chatId);
    expect(contactRows.map((row) => row.kind)).toEqual(["contact_started", "contact_ended"]);
    expect(contactRows[1]).toMatchObject({
      eventRef: `permission-override:${withdrawal.eventId}`,
      contactId: seeded.contact.contactId,
      storyMinute: CLOCK_MINUTES,
    });
    expect(contactRows[1]?.payload).toMatchObject({ kind: "contact_ended", reason: "policy_withdrawn" });
    // 3. The scene projection agrees in the same breath: nothing is touching.
    expect(activeContactsOf((await storedScene(chat.chatId)).contacts)).toEqual([]);
    // 4. The audit names what the sweep ended.
    const audits = await auditRows(chat.chatId);
    expect(audits).toHaveLength(2);
    expect(audits[1]).toMatchObject({ operation: "withdraw", endedContactIds: [seeded.contact.contactId] });
  });

  it("rejects the player as granting target with a clear 400, writing nothing", async () => {
    enableOverride();
    const chat = await newPermissionChat();
    const res = await permissionsPost(
      postReq(selfPath(chat.chatId), { permittedActorId: ids.npcA, grantingTargetId: PLAYER, operation: "grant" }),
      routeCtx({ chatId: chat.chatId }),
    );
    await expectApiError(res, 400, "target_is_player");
    expect(await listChatPermissionEvents(chat.chatId)).toEqual([]);
    expect(await auditRows(chat.chatId)).toEqual([]);
  });

  it("rejects a non-roster granting target and a foreign permitted actor", async () => {
    enableOverride();
    const chat = await newPermissionChat();
    await expectApiError(
      await permissionsPost(
        postReq(selfPath(chat.chatId), { permittedActorId: PLAYER, grantingTargetId: newId(), operation: "grant" }),
        routeCtx({ chatId: chat.chatId }),
      ),
      400,
      "target_not_in_roster",
    );
    await expectApiError(
      await permissionsPost(
        postReq(selfPath(chat.chatId), { permittedActorId: newId(), grantingTargetId: ids.npcA, operation: "grant" }),
        routeCtx({ chatId: chat.chatId }),
      ),
      400,
      "actor_not_in_chat",
    );
    expect(await listChatPermissionEvents(chat.chatId)).toEqual([]);
  });

  it("the capability-off POST is the hidden 404 and writes nothing", async () => {
    vi.stubEnv("CHAT_ROMANTIC_PERMISSION_DEV_OVERRIDE", ""); // the explicit OFF state
    const chat = await newPermissionChat();
    const res = await permissionsPost(
      postReq(selfPath(chat.chatId), { permittedActorId: PLAYER, grantingTargetId: ids.npcA, operation: "grant" }),
      routeCtx({ chatId: chat.chatId }),
    );
    await expectApiError(res, 404, "not_found");
    expect(await listChatPermissionEvents(chat.chatId)).toEqual([]);
    expect(await auditRows(chat.chatId)).toEqual([]);
  });

  it("409s an archived conversation before writing", async () => {
    enableOverride();
    const chat = await newPermissionChat();
    await db().update(characterChats).set({ archivedAt: new Date() }).where(eq(characterChats.id, chat.chatId));
    const res = await permissionsPost(
      postReq(selfPath(chat.chatId), { permittedActorId: PLAYER, grantingTargetId: ids.npcA, operation: "grant" }),
      routeCtx({ chatId: chat.chatId }),
    );
    await expectApiError(res, 409, "chat_archived");
    expect(await listChatPermissionEvents(chat.chatId)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Serialization
// ---------------------------------------------------------------------------

/** The lane's one-writer-per-chat key — the exact key `submitChatMessage` takes. */
const lockKey = (chatId: string) => `chat_exchange:${chatId}`;

interface HeldChatRow {
  /** Resolves once the transaction holds the chat row (and ran `mutate`). */
  readonly ready: Promise<void>;
  /** Commit, releasing the row to whoever queued behind it. */
  readonly commit: () => void;
  /** Resolves once that commit has landed. */
  readonly done: Promise<void>;
}

/**
 * An OPEN transaction holding `character_chats`' row lock for this chat.
 *
 * This is how a concurrent writer is made deterministic: an override's scene
 * write queues behind the lock instead of racing it, so the test can inspect
 * the request WHILE it sits inside its append — and, when `mutate` rewrites the
 * scene, the override's sweep provably reads the pre-change value (READ
 * COMMITTED hides an uncommitted write) and then finds the column changed under
 * it at commit time. That is finding 5's race, run on purpose.
 */
function holdChatRow(chatId: string, mutate?: (tx: ChatDbTransaction) => Promise<void>): HeldChatRow {
  let markReady!: () => void;
  const ready = new Promise<void>((resolve) => {
    markReady = resolve;
  });
  let commit!: () => void;
  const gate = new Promise<void>((resolve) => {
    commit = resolve;
  });
  const done = db().transaction(async (tx) => {
    await tx.execute(sql`select id from ${characterChats} where id = ${chatId} for update`);
    if (mutate !== undefined) await mutate(tx);
    markReady();
    await gate;
  });
  return { ready, commit, done };
}

/** Wait until a backend is parked on a row lock — the queued writer, observably queued. */
async function waitForBlockedWriter(): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const result = await db().execute<{ blocked: string }>(
      sql`select count(*)::text as blocked from pg_stat_activity
          where wait_event_type = 'Lock' and datname = current_database()`,
    );
    if (Number(result.rows[0]?.blocked ?? "0") > 0) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("no writer parked on the chat row — the interleave under test never happened");
}

/** The grant the withdraw tests revoke, applied through the route itself. */
async function grantPlayerTouch(chatId: string): Promise<void> {
  await expectJson(
    await permissionsPost(
      postReq(selfPath(chatId), { permittedActorId: PLAYER, grantingTargetId: ids.npcA, operation: "grant" }),
      routeCtx({ chatId }),
    ),
    200,
  );
}

describe.runIf(ready)("serialization — the override is a writer on the exchange lane", () => {
  it("409s chat_busy while the exchange lock is held, and writes nothing", async () => {
    enableOverride();
    const chat = await newPermissionChat();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    // A streaming reply, as far as the lane is concerned.
    const heldLock = tryKeyedLock(lockKey(chat.chatId), () => gate);
    if (heldLock === null) throw new Error("the exchange key was already held");

    const body = { permittedActorId: PLAYER, grantingTargetId: ids.npcA, operation: "grant" };
    await expectApiError(
      await permissionsPost(postReq(selfPath(chat.chatId), body), routeCtx({ chatId: chat.chatId })),
      409,
      "chat_busy",
    );
    expect(await listChatPermissionEvents(chat.chatId)).toEqual([]);
    expect(await auditRows(chat.chatId)).toEqual([]);

    release();
    await heldLock;
    // The refusal was contention, not a rejection: the same call now records.
    expect(keyedLockBusy(lockKey(chat.chatId))).toBe(false);
    await expectJson(
      await permissionsPost(postReq(selfPath(chat.chatId), body), routeCtx({ chatId: chat.chatId })),
      200,
    );
    expect(await listChatPermissionEvents(chat.chatId)).toHaveLength(1);
  });

  it(
    "holds the exchange lock across the whole append, so no exchange can start mid-write",
    async () => {
      enableOverride();
      const chat = await newPermissionChat();
      await grantPlayerTouch(chat.chatId);
      const seeded = await seedPlayerRomanticContact(chat);

      // Park the override inside its append by holding the row its sweep writes.
      const row = holdChatRow(chat.chatId);
      await row.ready;
      const posting = permissionsPost(
        postReq(selfPath(chat.chatId), {
          permittedActorId: PLAYER,
          grantingTargetId: ids.npcA,
          operation: "withdraw",
        }),
        routeCtx({ chatId: chat.chatId }),
      );
      try {
        await waitForBlockedWriter();
        // Mid-append, with the lane's key in hand — a submit arriving now is
        // bounced exactly as it would be mid-stream. Probing alone could never
        // give this answer: the probe passed before this request started.
        expect(keyedLockBusy(lockKey(chat.chatId))).toBe(true);
        expect(tryKeyedLock(lockKey(chat.chatId), () => Promise.resolve())).toBeNull();
      } finally {
        row.commit();
        await row.done;
      }

      const applied = await expectJson<OverrideWire>(await posting, 200);
      expect(applied.endedContactIds).toEqual([seeded.contact.contactId]);
      expect(activeContactsOf((await storedScene(chat.chatId)).contacts)).toEqual([]);
      // Released on the way out — the next writer is free to take the lane.
      expect(keyedLockBusy(lockKey(chat.chatId))).toBe(false);
    },
    20_000,
  );

  it(
    "refuses with scene_conflict and commits NOTHING when the scene moves under the sweep",
    async () => {
      enableOverride();
      const chat = await newPermissionChat();
      await grantPlayerTouch(chat.chatId);
      await seedPlayerRomanticContact(chat);
      const rewritten = withSceneParticipant(await storedScene(chat.chatId), {
        subjectId: affordanceSubjectId(ids.npcB),
      });

      // The other writer: its scene write is done but uncommitted, so the
      // override's sweep reads the OLD scene and only collides at commit time —
      // the check→commit window a busy probe cannot see.
      const row = holdChatRow(chat.chatId, async (tx) => {
        await tx.execute(
          sql`update ${characterChats} set scene = ${JSON.stringify(rewritten)}::jsonb where id = ${chat.chatId}`,
        );
      });
      await row.ready;
      const posting = permissionsPost(
        postReq(selfPath(chat.chatId), {
          permittedActorId: PLAYER,
          grantingTargetId: ids.npcA,
          operation: "withdraw",
        }),
        routeCtx({ chatId: chat.chatId }),
      );
      try {
        await waitForBlockedWriter();
      } finally {
        row.commit();
        await row.done;
      }

      await expectApiError(await posting, 409, "scene_conflict");
      // Every surface is untouched by the refused override: the ledger holds
      // only the grant, the contact never ended, no audit row was written, and
      // the other writer's scene stands. A partial commit here — a withdrawn
      // ledger over a still-touching scene — is the mixed state the spec bans.
      expect((await listChatPermissionEvents(chat.chatId)).map((event) => event.kind)).toEqual(["developer_overridden"]);
      expect((await listChatContactEvents(chat.chatId)).map((event) => event.kind)).toEqual(["contact_started"]);
      expect(await auditRows(chat.chatId)).toHaveLength(1);
      const scene = await storedScene(chat.chatId);
      expect(activeContactsOf(scene.contacts)).toHaveLength(1);
      expect(scene.participants.map((participant) => String(participant.subjectId))).toEqual([
        String(affordanceSubjectId(ids.npcB)),
      ]);
    },
    20_000,
  );
});

describe.runIf(ready)("authorization — both verbs collapse to the hidden 404", () => {
  it("hides itself from non-admins, foreign admins, the canonical namespace, and unknown chats", async () => {
    enableOverride();
    const chat = await newPermissionChat();
    const grant = { permittedActorId: PLAYER, grantingTargetId: ids.npcA, operation: "grant" };

    // Owner-admin sanity first — the same identity the other suites bind.
    expect((await permissionsGet(getReq(selfPath(chat.chatId)), routeCtx({ chatId: chat.chatId }))).status).toBe(200);

    // A non-admin owner: role gate.
    await withAuthUser(authState, { role: "user" }, async () => {
      expect((await permissionsGet(getReq(selfPath(chat.chatId)), routeCtx({ chatId: chat.chatId }))).status).toBe(404);
      expect(
        (await permissionsPost(postReq(selfPath(chat.chatId), grant), routeCtx({ chatId: chat.chatId }))).status,
      ).toBe(404);
    });

    // An ADMIN who does not own the chat: ownership gate, same 404 shape.
    await withAuthUser(authState, { id: ids.adversary, email: "adversary@test" }, async () => {
      expect((await permissionsGet(getReq(selfPath(chat.chatId)), routeCtx({ chatId: chat.chatId }))).status).toBe(404);
      expect(
        (await permissionsPost(postReq(selfPath(chat.chatId), grant), routeCtx({ chatId: chat.chatId }))).status,
      ).toBe(404);
    });

    // The canonical (non-/self/) namespace fails closed by construction.
    expect(
      (
        await permissionsGet(getReq(`/api/admin/chat-permissions/${chat.chatId}`), routeCtx({ chatId: chat.chatId }))
      ).status,
    ).toBe(404);

    // A chat that does not exist.
    expect((await permissionsGet(getReq(selfPath("ghost")), routeCtx({ chatId: "ghost" }))).status).toBe(404);

    // Nothing was written along the way.
    expect(await listChatPermissionEvents(chat.chatId)).toEqual([]);
  });
});
