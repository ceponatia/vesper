import { desc, eq } from "drizzle-orm";
import { z } from "zod";
import {
  DiagnosticCollector,
  romanticPermissionOverrideOperationSchema,
  type RomanticPermissionEvent,
  type RomanticPermissionOverrideOperation,
} from "@/contracts";
import { newId } from "@/lib/ids";
import { jsonError, jsonOk, readBody, withOwnerAdminOwnedChat } from "@/server/api";
import { characterChatMessages, characterChats, db } from "@/server/db";
import {
  acquireKeyedLockWithin,
  appendChatPermissionEventsWithInvalidation,
  CHAT_CONTACT_PLAYER_SUBJECT,
  chatExchangeLockKey,
  chatPermissionOverrideEventRef,
  chatRomanticPermissionDevOverrideEnabled,
  foldChatPermissionProjection,
  listChatPermissionEvents,
} from "@/server/engine";
import { chatBusyResponse, loadOwnedChat } from "@/app/api/chats/owned";
import {
  overrideChatBusyResponse,
  permissionEventsWire,
  PERMISSION_OVERRIDE_LOCK_POLL_MS,
  PERMISSION_OVERRIDE_LOCK_WAIT_MS,
  ROMANTIC_PERMISSION_OVERRIDE_AUDIT_TYPE,
} from "../shared";
import { resolveOverrideDirection, type OverrideDirectionResult } from "../validate";

/**
 * The `romantic_touch` permission DEVELOPER OVERRIDE endpoint — the ONE
 * structured override path, and the only one there will be: chat text is never
 * an admin command, so no chat-content parsing exists anywhere near this owner.
 *
 * - **Authorization**: `withOwnerAdminOwnedChat` — admin role, the
 *   `/api/admin/self` namespace (the canonical path here 404s by construction;
 *   the served twin is `src/app/api/admin/self/chat-permissions/[chatId]`),
 *   and chat ownership, all collapsing to the same hidden 404.
 * - **GET** — read-only inspection, available to owner-admins regardless of the
 *   capability flag: the active projection's standing per direction plus a
 *   bounded recent-event list.
 * - **POST** — ONE override per call, gated on
 *   `chatRomanticPermissionDevOverrideEnabled()` (`CHAT_ROMANTIC_PERMISSION_DEV_OVERRIDE=on`;
 *   off ⇒ the hidden 404). Records an auditable `developer_overridden` event
 *   with the `developer_override` source through
 *   `appendChatPermissionEventsWithInvalidation` — the SAME atomic append,
 *   projection fold, and contact-invalidation sweep production events use — and
 *   an app-`events` audit row in the same transaction. Each direction is set
 *   independently; a redundant override still records (the ledger is evidence),
 *   and the response says whether standing changed.
 * - **Serialization** — POST is a WRITER on the same state an exchange owns, so
 *   it takes the lane's `chat_exchange:<chatId>` lock and holds it across its
 *   reads and the append, rather than only probing it for the fast 409. The
 *   append's own scene compare-and-swap backs that up on the database side; a
 *   lost race is a 409 with nothing written, never a partial one.
 */

type Params = { chatId: string };
type OwnedChat = NonNullable<Awaited<ReturnType<typeof loadOwnedChat>>>;

const ownedChat = (user: { id: string }, params: Params) => loadOwnedChat(params.chatId, user.id);

const SCOPE = "romantic_touch" as const;

const postBodySchema = z
  .object({
    permittedActorId: z.string().trim().min(1).max(256),
    grantingTargetId: z.string().trim().min(1).max(256),
    operation: romanticPermissionOverrideOperationSchema,
  })
  .strict();

/** The chat's standing grants per direction + recent ledger events, for the dev panel. */
export const GET = withOwnerAdminOwnedChat<Params, OwnedChat>(ownedChat, async (_user, owned) => {
  const sink = new DiagnosticCollector();
  const rows = await listChatPermissionEvents(owned.chat.id, sink);
  const projection = foldChatPermissionProjection(rows, sink);
  return jsonOk({
    scope: SCOPE,
    playerSubjectId: String(CHAT_CONTACT_PLAYER_SUBJECT),
    overrideEnabled: chatRomanticPermissionDevOverrideEnabled(),
    grants: projection.entries.map((entry) => ({
      permittedActorId: String(entry.permittedActorId),
      grantingTargetId: String(entry.grantingTargetId),
      scope: entry.scope,
      standing: entry.standing,
      decidedByEventId: entry.decidedByEventId,
    })),
    events: permissionEventsWire(rows, sink),
  });
});

/** The validated direction, once `resolveOverrideDirection` has accepted it. */
type OverrideDirection = Extract<OverrideDirectionResult, { ok: true }>;

/** Apply one directional override, recorded as an audited `developer_overridden` event. */
export const POST = withOwnerAdminOwnedChat<Params, OwnedChat>(ownedChat, async (user, owned, req) => {
  // The mutation capability gate: without the explicit development/test flag the
  // write path does not exist — the same hidden 404 the authz wrapper answers.
  if (!chatRomanticPermissionDevOverrideEnabled()) return jsonError("not_found", "not found", 404);
  if (owned.chat.archivedAt) {
    return jsonError("chat_archived", "this conversation is archived; restore it to continue", 409);
  }
  // The fast path: an operator clicking mid-stream gets the lane's ordinary
  // busy 409 immediately rather than waiting on a lock it will not win.
  const busy = chatBusyResponse(owned.chat.id);
  if (busy) return busy;

  const body = await readBody(req, postBodySchema);
  if (!body.ok) return body.response;

  const direction = resolveOverrideDirection({
    permittedActorId: body.value.permittedActorId,
    grantingTargetId: body.value.grantingTargetId,
    rosterCharacterIds: owned.roster.map((member) => member.characterId),
    playerSubjectId: String(CHAT_CONTACT_PLAYER_SUBJECT),
  });
  if (!direction.ok) return jsonError(direction.code, direction.message, 400);

  // ...and the correctness backstop. The probe above answers "is the chat busy
  // NOW"; it says nothing about the window between that answer and this write's
  // commit, and a submit that wins the exchange lock inside that window runs a
  // whole exchange whose finalizer rewrites `character_chats.scene` from its own
  // earlier read — which would resurrect exactly the contacts a withdrawal's
  // sweep just ended, and a withdrawal may never leave an active contact
  // standing. So the override HOLDS the same `chat_exchange:<chatId>` key the
  // pipeline takes, across every read the append is computed from and the
  // append itself. The wait is short and bounded: this is only here to lose
  // races cleanly, never to queue behind a streaming reply, and a miss is the
  // same `chat_busy` 409 the fast path answers, having written nothing.
  const acquired = await acquireKeyedLockWithin(
    chatExchangeLockKey(owned.chat.id),
    () =>
      applyPermissionOverride({
        chatId: owned.chat.id,
        byUserId: user.id,
        direction,
        operation: body.value.operation,
      }),
    { timeoutMs: PERMISSION_OVERRIDE_LOCK_WAIT_MS, pollMs: PERMISSION_OVERRIDE_LOCK_POLL_MS },
  );
  if (acquired === null) return overrideChatBusyResponse();
  return acquired.held;
});

/**
 * The override's whole write, run with the chat's exchange lock HELD: the
 * chronology reads, the standing-before fold, the atomic append, and the
 * response. Every database read the append's invalidation sweep depends on sits
 * inside this function for that reason — a clock or newest-message id read
 * before the lock could belong to an exchange that has since moved the chat.
 */
async function applyPermissionOverride(input: {
  readonly chatId: string;
  readonly byUserId: string;
  readonly direction: OverrideDirection;
  readonly operation: RomanticPermissionOverrideOperation;
}): Promise<Response> {
  const { chatId, direction } = input;
  // The event's chronology anchors: the chat's current scenario-clock minute
  // (the same column `loadChatScenario` reads) and the NEWEST message as the
  // retake guard — null only when the conversation has no messages yet.
  const [chatRow] = await db()
    .select({ clockMinutes: characterChats.clockMinutes })
    .from(characterChats)
    .where(eq(characterChats.id, chatId))
    .limit(1);
  const storyMinute = Math.max(0, Math.trunc(chatRow?.clockMinutes ?? 0));
  const [newestMessage] = await db()
    .select({ id: characterChatMessages.id })
    .from(characterChatMessages)
    .where(eq(characterChatMessages.chatId, chatId))
    .orderBy(desc(characterChatMessages.createdAt), desc(characterChatMessages.id))
    .limit(1);
  const guardMessageId = newestMessage?.id ?? null;

  // Standing before, for the no-op report: a redundant override still records
  // — the ledger is evidence — but the response says what changed.
  const sink = new DiagnosticCollector();
  const priorRows = await listChatPermissionEvents(chatId, sink);
  const before = foldChatPermissionProjection(priorRows, sink);
  const standingBefore =
    before.entries.find(
      (entry) =>
        entry.permittedActorId === direction.permittedActorId &&
        entry.grantingTargetId === direction.grantingTargetId &&
        entry.scope === SCOPE,
    )?.standing ?? null;

  const eventId = newId();
  const event: RomanticPermissionEvent = {
    eventId,
    branchId: chatId,
    permittedActorId: direction.permittedActorId,
    grantingTargetId: direction.grantingTargetId,
    scope: SCOPE,
    kind: "developer_overridden",
    sourceKind: "developer_override",
    storyTime: storyMinute,
    orderInSource: 0,
    operation: input.operation,
  };

  const result = await appendChatPermissionEventsWithInvalidation({
    chatId,
    guardMessageId,
    eventRef: chatPermissionOverrideEventRef(eventId),
    storyMinute,
    events: [event],
    sink,
    // The auditable `developer_override` source, in the same transaction as the
    // ledger row; the append stamps `endedContactIds` into this payload.
    audit: {
      type: ROMANTIC_PERMISSION_OVERRIDE_AUDIT_TYPE,
      payload: {
        schemaVersion: 1,
        chatId,
        byUserId: input.byUserId,
        permittedActorId: String(direction.permittedActorId),
        grantingTargetId: String(direction.grantingTargetId),
        scope: SCOPE,
        operation: input.operation,
        storyMinute,
      },
    },
  });

  if (result.status === "refused") {
    // `branch_mismatch` cannot happen (the event names this chat by construction);
    // `invalidation_requires_guard` can, on a message-less chat whose scene
    // somehow carries active contacts — an inconsistency to surface, not repair.
    return jsonError(
      "override_refused",
      "the override would end active contacts but the conversation has no message to anchor the ends on",
      409,
    );
  }
  if (result.status === "mismatched") {
    return jsonError("ledger_conflict", "the permission ledger holds a different record under this override's key", 409);
  }
  if (result.status === "stale_scene") {
    // The append's scene compare-and-swap lost: something rewrote the scene
    // between the sweep's read and its commit, so the whole transaction rolled
    // back and NOTHING was written. Holding the exchange lock should make this
    // unreachable from here — it is the database's independent guarantee, and
    // it is reported as the retryable conflict it is rather than as a write.
    return jsonError(
      "scene_conflict",
      "the scene changed while this override was being applied; nothing was recorded — try again",
      409,
    );
  }

  const standingAfter = input.operation === "grant" ? ("granted" as const) : ("withdrawn" as const);
  return jsonOk({
    eventId,
    operation: input.operation,
    standingBefore,
    standingAfter,
    standingChanged: (standingBefore === "granted") !== (standingAfter === "granted"),
    endedContactIds: [...result.endedContactIds],
  });
}
