import { romanticPermissionEventSchema, type DiagnosticSink } from "@/contracts";
import { parseOrNull } from "@/lib/parse";
import { jsonError } from "@/server/api";
import type { ChatPermissionEventRow } from "@/server/engine";

/**
 * Shared pieces of the `romantic_touch` developer-override endpoint
 * (romantic-contact-affordances.spec.permission.md §"Authorship and developer
 * controls") — a Next route module may export only its HTTP verbs, so the
 * constants, the wire mapping, and the serialization vocabulary live here
 * beside `validate.ts`.
 */

/**
 * The override holds `chatExchangeLockKey(chatId)` from `@/server/engine` while
 * it writes — the SAME per-chat exchange lock `submitChatMessage` and the sim
 * routes take. One writer per conversation, whatever lane it comes from: an
 * override that only probed the key would still race an exchange that acquired
 * it between the probe and the append's commit, and the exchange's finalizer
 * rewrites `character_chats.scene` from its own pre-exchange read.
 *
 * There is no local copy of that key, here or anywhere: a lane that spelled the
 * prefix differently would take a different lock and quietly stop serializing,
 * with nothing to fail a test.
 */

/**
 * How long an override waits for the exchange key before giving up. Short on
 * purpose: the fast-path probe already bounced the obvious "a reply is
 * streaming" case, so this window only has to cover the probe→acquire race
 * (another writer's sub-second transaction), never a whole generation.
 */
export const PERMISSION_OVERRIDE_LOCK_WAIT_MS = 2_000;
/** How often that wait retries — the race it covers resolves in milliseconds. */
export const PERMISSION_OVERRIDE_LOCK_POLL_MS = 25;

/**
 * The refusal when the exchange key could not be taken. Deliberately the same
 * `chat_busy` code and status the fast-path `chatBusyResponse` answers, so a
 * client cannot tell (and need not care) whether the probe or the acquire was
 * what bounced it — both mean "another writer owns this chat; nothing was
 * written; try again".
 */
export function overrideChatBusyResponse(): ReturnType<typeof jsonError> {
  return jsonError("chat_busy", "a reply is still streaming for this chat; wait for it to finish", 409);
}

/**
 * The app-`events` audit type every override records — inserted in the SAME
 * transaction as the ledger row by `appendChatPermissionEventsWithInvalidation`.
 * Payload: `{ schemaVersion, chatId, byUserId, permittedActorId,
 * grantingTargetId, scope, operation, storyMinute, endedContactIds }`.
 */
export const ROMANTIC_PERMISSION_OVERRIDE_AUDIT_TYPE = "romantic_permission_developer_override";

/** How many recent ledger events the panel's GET returns, newest first. */
export const PERMISSION_RECENT_EVENT_LIMIT = 25;

/** One ledger event as the developer panel reads it. */
export interface PermissionEventWire {
  readonly id: string;
  readonly kind: string;
  readonly sourceKind: string;
  /** The override's grant/withdraw, read from the payload; null for production kinds. */
  readonly operation: "grant" | "withdraw" | null;
  readonly permittedActorId: string;
  readonly grantingTargetId: string;
  readonly scope: string;
  readonly storyMinute: number;
  readonly createdAt: string;
}

/**
 * The newest `PERMISSION_RECENT_EVENT_LIMIT` ledger rows, newest first, as wire
 * rows. `operation` comes from the stored payload through the strict event
 * schema — a payload that no longer parses is listed from its columns with a
 * null operation rather than dropped: this is an inspection surface, and a
 * corrupt row is exactly what an operator wants to see (the FOLD is where a
 * corrupt payload must never count; docs/resilience.md §1).
 */
export function permissionEventsWire(
  rows: readonly ChatPermissionEventRow[],
  sink?: DiagnosticSink,
): PermissionEventWire[] {
  return rows
    .slice(-PERMISSION_RECENT_EVENT_LIMIT)
    .reverse()
    .map((row) => {
      const event = parseOrNull(romanticPermissionEventSchema, row.payload, sink, "chat_permission_events.payload");
      return {
        id: row.id,
        kind: row.kind,
        sourceKind: row.sourceKind,
        operation: event?.operation ?? null,
        permittedActorId: row.permittedActorId,
        grantingTargetId: row.grantingTargetId,
        scope: row.scope,
        storyMinute: row.storyMinute,
        createdAt: row.createdAt.toISOString(),
      };
    });
}
