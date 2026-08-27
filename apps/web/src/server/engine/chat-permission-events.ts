import { and, asc, eq, inArray, isNull, sql } from "drizzle-orm";
import { z } from "zod";
import {
  activeContactsOf,
  contactEventRef,
  diag,
  DiagnosticCollector,
  emptySceneState,
  endUnauthorizedContacts,
  contactActionRequiresPermission,
  derivePermissionPolicyRead,
  foldRomanticPermissionProjection,
  isInterpersonalContact,
  parseSceneState,
  romanticPermissionEventSchema,
  withSceneContacts,
  type ContactAuthorizationRead,
  type DiagnosticSink,
  type RomanticPermissionEvent,
  type RomanticPermissionEventKind,
  type RomanticPermissionProjection,
  type RomanticPermissionSourceKind,
  type SceneState,
} from "@/contracts";
import { parseOrNull } from "@/lib/parse";
import { characterChats, chatPermissionEvents, db, events as appEvents } from "../db";
import { CHAT_CONTACT_PLAYER_SUBJECT } from "./chat-contact-adapter";
import {
  canonicalJson,
  chatContactEventRowsFor,
  insertVerifiedChatContactRows,
  type ChatDbTransaction,
} from "./chat-contact-events";
import { insertVerifiedLedgerRows, ledgerMismatches, type LedgerKey } from "./ledger-verify";

/**
 * THE CHAT LANE'S DURABLE ROMANTIC-PERMISSION LEDGER — events and the active
 * projection, retakes and branches, and revocation during active contact.
 *
 * The one IO module of the permission seam, modeled row-for-row on
 * `chat-contact-events.ts`. Everything above it — the event schema, the
 * chronology comparator, the projection fold, the resolver mapping — is pure
 * contract code (`contracts/affordances/permission`); this file owns the rows,
 * their trust boundary, the retake delete, and the ONE atomic producer entry
 * point.
 *
 * ```text
 * chat_permission_events            the events, append-only, branch == chat  ← the only truth
 * foldRomanticPermissionProjection  the standing grants, computed on read    ← never stored
 * ```
 *
 * There is deliberately NO projection column (ruled 2026-08-04). The rows are
 * guard-pruned on retake exactly like `chat_contact_events`, so branch/retake
 * restoration is the prune plus a re-fold — no snapshot to drift.
 *
 * ## The atomic entry point
 *
 * `appendChatPermissionEventsWithInvalidation` is the single door every
 * producer uses (the future NPC decision leg, the developer override endpoint).
 * One transaction: the verified permission rows; and, when any event withdraws
 * or revokes a grant, the contact core's `endUnauthorizedContacts` sweep with
 * fresh `derivePermissionPolicyRead` reads, the resulting `contact_ended`
 * commits appended to the CONTACT ledger under the same event ref, and the
 * updated scene projection — so the permission ledger, the contact ledger, and
 * the scene can never expose a mixed state.
 *
 * ## Event-ref namespaces
 *
 * `permission-reply:<assistantMessageId>` for NPC-decision events and
 * `permission-override:<eventId>` for developer overrides — disjoint from the
 * contact ledger's `contact:` / `contact-reply:`, so the two ledgers' refs can
 * share the contact table (the invalidation's ends land under the permission
 * ref) without ever colliding with an exchange's own contact writes.
 *
 * ## Serialization
 *
 * The invalidation sweep is computed from reads taken BEFORE the transaction,
 * so a producer whose scene read is overtaken by another writer would commit a
 * sweep of a scene that no longer exists. Two mechanisms keep that from
 * happening, and BOTH are required:
 *
 * 1. **The lane's per-chat exchange lock** (`chat_exchange:<chatId>`) is HELD
 *    across the call by every producer — the NPC decision leg because it runs
 *    inside the exchange, and the developer-override endpoint because it
 *    acquires the same key around this append rather than merely probing it
 *    (probing answers the check, not the check→commit window).
 * 2. **The scene compare-and-swap below** — the sweep's scene write matches
 *    only while the column still holds the exact bytes the sweep read, and a
 *    zero-row swap is the typed `stale_scene` outcome with NOTHING committed.
 *    The lock is in-process (one machine); the CAS is the database's own answer
 *    and holds for any future producer that forgets the lock.
 *
 * ## Degradation
 *
 * An unreadable row is dropped from a read with a boundary diagnostic, never
 * thrown, and an unreadable payload can never fold into a grant — the fallback
 * direction for a permission ledger is always "less is granted"
 * (docs/resilience.md §1–2). Expected conflicts return values, not exceptions.
 */

/** The boundary path a dropped row reports under. */
const CHAT_PERMISSION_EVENTS_PATH = "chat_permission_events";

/** The diagnostic code a caller files when an append comes back `mismatched`. */
export const CHAT_PERMISSION_LEDGER_MISMATCH = "chat_permission.ledger.mismatch";
/** The diagnostic code this module files when an append is refused outright. */
export const CHAT_PERMISSION_APPEND_REFUSED = "chat_permission.append.refused";
/** The diagnostic code the scene compare-and-swap files when its base moved. */
export const CHAT_PERMISSION_SCENE_STALE = "chat_permission.scene.stale";
/**
 * The diagnostic code a retake files when it could not prune a discarded take's
 * permission rows. `error`, not `warn`: unlike a stranded contact row — a
 * divergence the append's verification catches — a stranded grant fails OPEN,
 * so the exchange suppresses its permission reads rather than trusting a ledger
 * that still holds an authorization the story threw away.
 */
export const CHAT_PERMISSION_ROLLBACK_FAILED = "chat_permission.rollback.failed";
/** Transcript-only edits cannot rewrite a committed NPC permission decision. */
export const CHAT_PERMISSION_SOURCE_MESSAGE_IMMUTABLE = "message_has_permission_authority";

/** The NPC-decision event ref for one assistant reply's permission events. */
export function chatPermissionReplyEventRef(assistantMessageId: string): string {
  return `permission-reply:${assistantMessageId}`;
}

/** The developer-override event ref — one per override event, audit-stable. */
export function chatPermissionOverrideEventRef(eventId: string): string {
  return `permission-override:${eventId}`;
}

// ---------------------------------------------------------------------------
// Rows
// ---------------------------------------------------------------------------

/** One row to write. Pure data — `chatPermissionEventRowsFor` builds it, the append sends it. */
export interface ChatPermissionEventInsert {
  readonly chatId: string;
  readonly guardMessageId: string | null;
  readonly eventRef: string;
  readonly sequence: number;
  readonly kind: RomanticPermissionEventKind;
  readonly sourceKind: RomanticPermissionSourceKind;
  readonly permittedActorId: string;
  readonly grantingTargetId: string;
  readonly scope: string;
  readonly storyMinute: number;
  readonly payload: RomanticPermissionEvent;
}

export interface AppendChatPermissionEventsInput {
  readonly chatId: string;
  /**
   * The exchange guard (`promptMessageId ?? assistantMessageId`) — the retake
   * key. `null` ONLY for a developer override recorded before the chat has any
   * messages; production NPC events always set it.
   */
  readonly guardMessageId: string | null;
  /** The producer call's ref. EVERY row of one call shares it. */
  readonly eventRef: string;
  /** The story-clock minute the invalidation sweep (if any) is stamped at. */
  readonly storyMinute: number;
  /** The typed events, in the producer's own order. */
  readonly events: readonly RomanticPermissionEvent[];
  /**
   * Optional operator-audit record, inserted into the app `events` table INSIDE
   * the same transaction as the ledger rows (the `setChatEngineAuthority`
   * precedent) — how the developer-override endpoint records its auditable
   * `developer_override` source. The append stamps the invalidation sweep's
   * `endedContactIds` into the
   * payload before inserting, because they are computed by this call, not the
   * caller. Written only when the append commits `recorded`; a mismatched or
   * refused append audits nothing, because nothing happened. Omitted by every
   * other producer — behavior-preserving when absent.
   */
  readonly audit?: { readonly type: string; readonly payload: Record<string, unknown> };
  readonly sink?: DiagnosticSink;
}

/** One ledger row as the reader sees it. */
export interface ChatPermissionEventRow {
  readonly id: string;
  readonly guardMessageId: string | null;
  readonly eventRef: string;
  readonly sequence: number;
  readonly kind: RomanticPermissionEventKind;
  readonly sourceKind: RomanticPermissionSourceKind;
  readonly permittedActorId: string;
  readonly grantingTargetId: string;
  readonly scope: string;
  readonly storyMinute: number;
  /**
   * The serialized `RomanticPermissionEvent`, exactly as stored. Deliberately
   * `unknown`: this store records events, it does not interpret them, and the
   * permission contracts own the parser that decides what a corrupt one means
   * (it means NO event — never a grant).
   */
  readonly payload: unknown;
  readonly createdAt: Date;
}

/**
 * The narrowed columns. `payload` is absent on purpose — see
 * `ChatPermissionEventRow` — and the enum columns are the ones a hand-edit
 * could put outside the vocabulary.
 */
const chatPermissionEventRowSchema = z.object({
  id: z.string(),
  guardMessageId: z.string().nullable(),
  eventRef: z.string(),
  sequence: z.number().int(),
  kind: z.enum(["granted", "attempt_denied", "withdrawn", "relationship_revoked", "developer_overridden"]),
  sourceKind: z.enum(["npc_decision", "relationship_transition", "developer_override"]),
  permittedActorId: z.string(),
  grantingTargetId: z.string(),
  scope: z.string(),
  storyMinute: z.number().int(),
  createdAt: z.date(),
});

/**
 * The event list, as rows. PURE — extracted so the idempotency identity is
 * testable without a database, exactly as `chatContactEventRowsFor` is.
 *
 * `sequence` is the event's index in the producer's list, so a retried call
 * re-derives identical (event ref, sequence) keys and conflicts harmlessly.
 * The row's `storyMinute` copies the EVENT's own `storyTime` — the payload is
 * the chronology anchor, and a column that could disagree with it would be a
 * second truth (the append input's `storyMinute` stamps only the invalidation
 * sweep).
 */
export function chatPermissionEventRowsFor(input: {
  readonly chatId: string;
  readonly guardMessageId: string | null;
  readonly eventRef: string;
  readonly events: readonly RomanticPermissionEvent[];
}): ChatPermissionEventInsert[] {
  return input.events.map((event, index) => ({
    chatId: input.chatId,
    guardMessageId: input.guardMessageId,
    eventRef: input.eventRef,
    sequence: index,
    kind: event.kind,
    sourceKind: event.sourceKind,
    permittedActorId: event.permittedActorId,
    grantingTargetId: event.grantingTargetId,
    scope: event.scope,
    storyMinute: event.storyTime,
    payload: event,
  }));
}

// ---------------------------------------------------------------------------
// The verified insert
// ---------------------------------------------------------------------------

/** One ledger row's identity, as a mismatch report names it. */
export type ChatPermissionLedgerKey = LedgerKey;

/**
 * The stored half of a comparison — the columns a conflicting row is judged on.
 * `guardMessageId` is deliberately absent for the contact ledger's reason: two
 * rows sharing a key already share their provenance, and comparing it would
 * only restate the key.
 */
export interface ChatPermissionEventStoredRow {
  readonly sequence: number;
  readonly kind: RomanticPermissionEventKind;
  readonly sourceKind: RomanticPermissionSourceKind;
  readonly permittedActorId: string;
  readonly grantingTargetId: string;
  readonly scope: string;
  readonly storyMinute: number;
  readonly payload: unknown;
}

/** Is the row already under this key the row this write meant to put there? PURE. */
export function chatPermissionRowMatches(
  attempted: ChatPermissionEventInsert,
  stored: ChatPermissionEventStoredRow,
): boolean {
  return (
    stored.kind === attempted.kind &&
    stored.sourceKind === attempted.sourceKind &&
    stored.permittedActorId === attempted.permittedActorId &&
    stored.grantingTargetId === attempted.grantingTargetId &&
    stored.scope === attempted.scope &&
    stored.storyMinute === attempted.storyMinute &&
    canonicalJson(stored.payload) === canonicalJson(attempted.payload)
  );
}

/** The permission binding of the shared mismatch judgment (`ledger-verify.ts`). PURE. */
export function chatPermissionLedgerMismatches(
  attempted: readonly ChatPermissionEventInsert[],
  stored: readonly ChatPermissionEventStoredRow[],
): readonly ChatPermissionLedgerKey[] {
  return ledgerMismatches(attempted, stored, chatPermissionRowMatches);
}

/**
 * The IO half of the idempotent-and-verified write — the permission twin of
 * `insertVerifiedChatContactRows`, sharing its orchestration through
 * `insertVerifiedLedgerRows` so the two ledgers cannot drift into two
 * judgments. Runs INSIDE the caller's transaction and returns a value rather
 * than throwing.
 */
export async function insertVerifiedChatPermissionRows(
  tx: ChatDbTransaction,
  input: {
    readonly chatId: string;
    readonly eventRef: string;
    readonly rows: readonly ChatPermissionEventInsert[];
  },
): Promise<{ inserted: number; mismatched: readonly ChatPermissionLedgerKey[] }> {
  return insertVerifiedLedgerRows({
    rows: input.rows,
    insert: (rows) =>
      tx
        .insert(chatPermissionEvents)
        .values([...rows])
        .onConflictDoNothing({
          target: [chatPermissionEvents.chatId, chatPermissionEvents.eventRef, chatPermissionEvents.sequence],
        })
        .returning({ sequence: chatPermissionEvents.sequence }),
    loadStored: (sequences) =>
      tx
        .select({
          sequence: chatPermissionEvents.sequence,
          kind: chatPermissionEvents.kind,
          sourceKind: chatPermissionEvents.sourceKind,
          permittedActorId: chatPermissionEvents.permittedActorId,
          grantingTargetId: chatPermissionEvents.grantingTargetId,
          scope: chatPermissionEvents.scope,
          storyMinute: chatPermissionEvents.storyMinute,
          payload: chatPermissionEvents.payload,
        })
        .from(chatPermissionEvents)
        .where(
          and(
            eq(chatPermissionEvents.chatId, input.chatId),
            eq(chatPermissionEvents.eventRef, input.eventRef),
            inArray(chatPermissionEvents.sequence, [...sequences]),
          ),
        ),
    matches: chatPermissionRowMatches,
  });
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

/**
 * This chat's permission ledger, in the order the fold must apply it: by when
 * the write landed, then by the event's place within its call. A row that
 * cannot be narrowed is dropped with a boundary diagnostic rather than failing
 * the read.
 */
export async function listChatPermissionEvents(
  chatId: string,
  sink?: DiagnosticSink,
): Promise<ChatPermissionEventRow[]> {
  const rows = await db()
    .select({
      id: chatPermissionEvents.id,
      guardMessageId: chatPermissionEvents.guardMessageId,
      eventRef: chatPermissionEvents.eventRef,
      sequence: chatPermissionEvents.sequence,
      kind: chatPermissionEvents.kind,
      sourceKind: chatPermissionEvents.sourceKind,
      permittedActorId: chatPermissionEvents.permittedActorId,
      grantingTargetId: chatPermissionEvents.grantingTargetId,
      scope: chatPermissionEvents.scope,
      storyMinute: chatPermissionEvents.storyMinute,
      payload: chatPermissionEvents.payload,
      createdAt: chatPermissionEvents.createdAt,
    })
    .from(chatPermissionEvents)
    .where(eq(chatPermissionEvents.chatId, chatId))
    .orderBy(asc(chatPermissionEvents.createdAt), asc(chatPermissionEvents.sequence));
  return rows.flatMap((row) => {
    const narrowed = parseOrNull(chatPermissionEventRowSchema, row, sink, CHAT_PERMISSION_EVENTS_PATH);
    return narrowed === null ? [] : [{ ...narrowed, payload: row.payload }];
  });
}

/**
 * How hard the prune tries before giving up. This delete is the ONLY thing
 * standing between a discarded take's grant and the ledger a later exchange
 * reads as authority — and the caller's suppression covers just the replacement
 * exchange, because a regenerate reuses the assistant row and the NEXT ordinary
 * exchange never enters the retake block at all. A `DELETE` is idempotent, so
 * retrying costs nothing but the wait, and the realistic failure here is a
 * transient blip rather than a durable one.
 */
const PERMISSION_PRUNE_ATTEMPTS = 3;
const PERMISSION_PRUNE_BACKOFF_MS = [50, 200];

/**
 * The retake half: drop everything this exchange recorded, so the new take
 * writes the only ledger entries for it — the twin of
 * `deleteChatContactEventsForGuard`, run beside it, and like it UNCONDITIONAL:
 * pruning a discarded take's durable rows is hygiene of state that already
 * exists, never gated on the flag that decides whether new events are produced.
 * A discarded reply's grant, denial, or withdrawal must not survive into the
 * replacement take.
 *
 * Retries, unlike its contact twin, because the two failures are not equally
 * bad: a stranded contact row is a divergence the append's verification catches
 * on the next write, while a stranded grant is silent authority nothing else
 * re-checks. Throws only when every attempt failed, which is the caller's
 * signal to refuse the retake before a replacement reply commits.
 */
export async function deleteChatPermissionEventsForGuards(
  chatId: string,
  guardMessageIds: readonly string[],
): Promise<{ deleted: number }> {
  const guards = [...new Set(guardMessageIds)];
  if (guards.length === 0) return { deleted: 0 };
  let lastError: unknown;
  for (let attempt = 0; attempt < PERMISSION_PRUNE_ATTEMPTS; attempt += 1) {
    try {
      // ONE statement is the atomic boundary. A regenerate may need both the
      // exchange guard and the reused assistant-row guard removed; deleting
      // them separately can strand half a discarded take when the second call
      // fails.
      const deleted = await db()
        .delete(chatPermissionEvents)
        .where(and(eq(chatPermissionEvents.chatId, chatId), inArray(chatPermissionEvents.guardMessageId, guards)))
        .returning({ id: chatPermissionEvents.id });
      return { deleted: deleted.length };
    } catch (error) {
      lastError = error;
      const backoff = PERMISSION_PRUNE_BACKOFF_MS[attempt];
      if (backoff !== undefined) await new Promise((resolve) => setTimeout(resolve, backoff));
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

export async function deleteChatPermissionEventsForGuard(
  chatId: string,
  guardMessageId: string,
): Promise<{ deleted: number }> {
  return deleteChatPermissionEventsForGuards(chatId, [guardMessageId]);
}

/**
 * The stored rows' payloads, as typed events, in ledger order. The trust
 * boundary: a payload that fails the event schema is dropped with a diagnostic
 * and can therefore never fold into a grant — repaired-into-permission is the
 * one failure this owner exists to prevent.
 */
export function chatPermissionEventsFromRows(
  rows: readonly ChatPermissionEventRow[],
  sink?: DiagnosticSink,
): RomanticPermissionEvent[] {
  return rows.flatMap((row) => {
    const event = parseOrNull(romanticPermissionEventSchema, row.payload, sink, CHAT_PERMISSION_EVENTS_PATH);
    return event === null ? [] : [event];
  });
}

/**
 * The active projection, straight off the ledger rows — the thin IO-side
 * wrapper over the pure fold. No chronology cutoff: a caller resolving a NEW
 * attempt sits past every committed event by construction; same-reply ordering
 * uses the fold's `effectiveBefore` directly.
 */
export function foldChatPermissionProjection(
  rows: readonly ChatPermissionEventRow[],
  sink?: DiagnosticSink,
): RomanticPermissionProjection {
  return foldRomanticPermissionProjection({
    events: chatPermissionEventsFromRows(rows, sink),
    ...(sink === undefined ? {} : { sink }),
  });
}

// ---------------------------------------------------------------------------
// The atomic producer entry point
// ---------------------------------------------------------------------------

export const chatPermissionAppendRefusalReasons = ["branch_mismatch", "invalidation_requires_guard"] as const;
export type ChatPermissionAppendRefusalReason = (typeof chatPermissionAppendRefusalReasons)[number];

/**
 * What the append did.
 *
 * `recorded` means every attempted row is durably present AS ATTEMPTED — and,
 * when the events withdrew a grant some active contact depended on, the
 * contact_ended commits and the swept scene landed in the SAME transaction;
 * `endedContactIds` names them. `mismatched` means a key is held by a DIFFERENT
 * record (permission or contact side) and NOTHING was written. `stale_scene`
 * means another writer changed `character_chats.scene` between the sweep's read
 * and its write, so the whole transaction rolled back — the sweep was computed
 * against a scene that no longer exists, and a caller that wants the withdrawal
 * recorded must re-run the append against the current one. `refused` means the
 * input contradicted the ruled invariants and nothing was attempted.
 *
 * Every non-`recorded` status therefore means the same thing to a caller: the
 * database does not carry this call's events.
 */
export type ChatPermissionAppendResult =
  | { readonly status: "recorded"; readonly inserted: number; readonly endedContactIds: readonly string[] }
  | {
      readonly status: "mismatched";
      readonly inserted: number;
      readonly mismatched: readonly ChatPermissionLedgerKey[];
    }
  | { readonly status: "stale_scene" }
  | { readonly status: "refused"; readonly reason: ChatPermissionAppendRefusalReason };

/** Does this event remove a standing grant when applied? */
function withdrawsStanding(event: RomanticPermissionEvent): boolean {
  switch (event.kind) {
    case "withdrawn":
    case "relationship_revoked":
      return true;
    case "developer_overridden":
      return event.operation === "withdraw";
    case "granted":
    case "attempt_denied":
      return false;
  }
}

/** Does this event require re-evaluating active contacts right now? */
function invalidatesActiveContact(event: RomanticPermissionEvent): boolean {
  return withdrawsStanding(event) || (event.kind === "attempt_denied" && event.attemptContactId !== undefined);
}

/** The abort — see `chat-contact-events.ts`'s twin for why it must throw inside the tx. */
class ChatPermissionLedgerMismatchError extends Error {
  readonly mismatched: readonly ChatPermissionLedgerKey[];
  readonly inserted: number;

  constructor(mismatched: readonly ChatPermissionLedgerKey[], inserted: number) {
    super(`chat permission ledger holds a different record for ${mismatched.length} key(s)`);
    this.name = "ChatPermissionLedgerMismatchError";
    this.mismatched = mismatched;
    this.inserted = inserted;
  }
}

/**
 * The scene compare-and-swap's abort. Thrown INSIDE the transaction so the
 * permission rows, the contact ends, and the audit roll back together: a sweep
 * whose base moved is a sweep of a scene that no longer exists, and half of it
 * is exactly the mixed state this append exists to prevent.
 */
class ChatPermissionSceneStaleError extends Error {
  constructor() {
    super("character_chats.scene changed under the permission invalidation sweep");
    this.name = "ChatPermissionSceneStaleError";
  }
}

/**
 * Record permission events AND everything their withdrawals invalidate,
 * atomically — THE single entry point for every producer (ruled 2026-08-04).
 *
 * One `db().transaction`:
 *
 * 1. the verified permission rows (idempotent under (chat, event ref, sequence);
 *    a conflicting key is read back and judged, and a divergence aborts);
 * 2. when any event withdraws/revokes a standing grant: the contact core's
 *    `endUnauthorizedContacts` sweep over the chat's active contacts, each
 *    permission-gated contact re-read through `derivePermissionPolicyRead`
 *    against the POST-append projection — the resulting `contact_ended` commits
 *    appended to the CONTACT ledger under this same event ref, and the swept
 *    scene written back UNDER A COMPARE-AND-SWAP on the bytes the sweep read —
 *    so the two ledgers and the projection cannot expose a mixed state;
 * 3. when the producer supplied an `audit` record (the developer-override
 *    endpoint), the app-`events` audit row, inserted after the sweep with the
 *    sweep's `endedContactIds` stamped into its payload;
 * 4. a typed result, never a thrown expected-conflict.
 *
 * The projection and the sweep are computed BEFORE the transaction (pure work),
 * from the listed ledger plus this call's own events — the fold's per-event-id
 * dedupe makes that exactly the post-append projection even on an idempotent
 * retry.
 *
 * Those pre-transaction reads are what the module doc's §Serialization is
 * about, and the claim there is deliberately narrow. Producers are EXPECTED to
 * hold the lane's per-chat exchange lock (`chat_exchange:<chatId>`) across the
 * call — the NPC decision leg does by running inside the exchange, the
 * developer-override endpoint does by acquiring the same key around it — but
 * this function does not take that lock itself and cannot verify that a caller
 * did. So the scene write is a compare-and-swap against the exact column value
 * the sweep read: a writer that slipped in between makes the swap match zero
 * rows, and the whole transaction rolls back as `stale_scene` rather than
 * resurrecting contacts the sweep just ended. Only the scene is guarded this
 * way; the two ledgers are append-only under verified keys and need no base.
 *
 * Refusals (nothing attempted): an event whose `branchId` is not this chat —
 * a grant may never leak across branches, and a producer that tries has a bug —
 * and a withdrawal that must end contacts on a `null` guard, which has no
 * exchange to hang the contact rows on (production always has one; the
 * pre-message override case cannot have active contacts to end).
 */
export async function appendChatPermissionEventsWithInvalidation(
  input: AppendChatPermissionEventsInput,
): Promise<ChatPermissionAppendResult> {
  const { sink } = input;
  const foreign = input.events.filter((event) => event.branchId !== input.chatId);
  if (foreign.length > 0) {
    sink?.push(
      diag("error", CHAT_PERMISSION_APPEND_REFUSED, "permission events name a branch other than this chat", {
        path: CHAT_PERMISSION_EVENTS_PATH,
        context: { chatId: input.chatId, eventIds: foreign.slice(0, 8).map((event) => event.eventId) },
      }),
    );
    return { status: "refused", reason: "branch_mismatch" };
  }

  const rows = chatPermissionEventRowsFor(input);

  // The invalidation sweep, computed pure-side. Only a withdrawal can end a
  // contact, so the scene is not even read for a grant or an unbound denial.
  // diagnostics are BUFFERED and surfaced only when the transaction commits —
  // an "authorization lapsed and the contact was ended" line about an end that
  // was then refused or rolled back would be a record of something that never
  // happened.
  const sweepSink = new DiagnosticCollector();
  let sweep: {
    readonly scene: SceneState;
    readonly commits: ReturnType<typeof endUnauthorizedContacts>["commits"];
    /**
     * The RAW `character_chats.scene` value the sweep was computed from — the
     * compare-and-swap's base. Raw rather than the parsed `SceneState`, because
     * the question the swap asks is "does the column still hold what I read",
     * and a normalizing parse would make a repaired-on-read scene look changed
     * (a false `stale_scene` on every withdrawal after one). `null` covers both
     * a SQL-NULL column and a chat row that has vanished.
     */
    readonly sceneBase: unknown;
  } | null = null;
  if (input.events.some(invalidatesActiveContact)) {
    const priorRows = await listChatPermissionEvents(input.chatId, sink);
    const projection = foldRomanticPermissionProjection({
      events: [...chatPermissionEventsFromRows(priorRows, sink), ...input.events],
      ...(sink === undefined ? {} : { sink }),
    });
    const [chatRow] = await db()
      .select({ scene: characterChats.scene })
      .from(characterChats)
      .where(eq(characterChats.id, input.chatId))
      .limit(1);
    const sceneBase = chatRow?.scene ?? null;
    const scene = sceneBase === null ? emptySceneState() : parseSceneState(sceneBase, sink);

    const authorizations: ContactAuthorizationRead[] = [];
    for (const contact of activeContactsOf(scene.contacts)) {
      if (!isInterpersonalContact(contact.source, contact.target)) continue;
      if (!contactActionRequiresPermission(contact.actionKind)) continue;
      if (contact.target.kind !== "body") continue;
      authorizations.push({
        contactId: contact.contactId,
        policy: derivePermissionPolicyRead({
          projection,
          permittedActorId: contact.actorId,
          grantingTargetId: contact.target.subjectId,
          actionKind: contact.actionKind,
          playerSubjectId: CHAT_CONTACT_PLAYER_SUBJECT,
          attemptContactId: contact.contactId,
        }),
      });
    }
    const swept = endUnauthorizedContacts({
      state: scene.contacts,
      authorizations,
      storyTime: Math.max(0, Math.trunc(input.storyMinute)),
      eventRef: contactEventRef(input.eventRef),
      sink: sweepSink,
    });
    sweep = { scene: withSceneContacts(scene, swept.state), commits: swept.commits, sceneBase };
  }

  if (sweep !== null && sweep.commits.length > 0 && input.guardMessageId === null) {
    sink?.push(
      diag(
        "error",
        CHAT_PERMISSION_APPEND_REFUSED,
        "a withdrawal must end active contacts but the append carries no exchange guard",
        { path: CHAT_PERMISSION_EVENTS_PATH, context: { chatId: input.chatId, ends: sweep.commits.length } },
      ),
    );
    return { status: "refused", reason: "invalidation_requires_guard" };
  }

  const endedContactIds = (sweep?.commits ?? []).map((commit) => commit.contactId);
  const guardMessageId = input.guardMessageId;
  try {
    const result = await db().transaction(async (tx): Promise<ChatPermissionAppendResult> => {
      const permission = await insertVerifiedChatPermissionRows(tx, {
        chatId: input.chatId,
        eventRef: input.eventRef,
        rows,
      });
      if (permission.mismatched.length > 0) {
        throw new ChatPermissionLedgerMismatchError(permission.mismatched, permission.inserted);
      }
      if (sweep !== null && sweep.commits.length > 0 && guardMessageId !== null) {
        const contactRows = chatContactEventRowsFor({
          chatId: input.chatId,
          guardMessageId,
          eventRef: contactEventRef(input.eventRef),
          storyMinute: Math.max(0, Math.trunc(input.storyMinute)),
          commits: sweep.commits,
        });
        const contact = await insertVerifiedChatContactRows(tx, {
          chatId: input.chatId,
          eventRef: input.eventRef,
          rows: contactRows,
        });
        if (contact.mismatched.length > 0) {
          throw new ChatPermissionLedgerMismatchError(contact.mismatched, permission.inserted);
        }
        // The swept scene, in the same transaction — the projection cannot
        // outlive the grant it depended on (spec's "one guarded sequence") —
        // and under a compare-and-swap on the value the sweep read. Matching
        // zero rows is the only proof that nothing else rewrote the scene since
        // that read; without it a concurrent exchange finalizer could restore
        // the very contacts this sweep ended, leaving the ledgers withdrawn and
        // the scene still touching.
        const swapped = await tx
          .update(characterChats)
          .set({ scene: sql`${JSON.stringify(sweep.scene)}::jsonb` })
          .where(
            and(
              eq(characterChats.id, input.chatId),
              sweep.sceneBase === null
                ? isNull(characterChats.scene)
                : sql`${characterChats.scene} = ${JSON.stringify(sweep.sceneBase)}::jsonb`,
            ),
          )
          .returning({ id: characterChats.id });
        if (swapped.length === 0) throw new ChatPermissionSceneStaleError();
      }
      // The operator audit, after the sweep and still inside the transaction:
      // it names the contacts the sweep ended, and it cannot outlive a rollback
      // of the write it records.
      if (input.audit !== undefined) {
        await tx.insert(appEvents).values({
          type: input.audit.type,
          payload: { ...input.audit.payload, endedContactIds },
        });
      }
      return { status: "recorded", inserted: permission.inserted, endedContactIds };
    });
    // Only a committed write surfaces the sweep's own record of what it ended.
    if (sink !== undefined) for (const diagnostic of sweepSink.items) sink.push(diagnostic);
    return result;
  } catch (error) {
    if (error instanceof ChatPermissionSceneStaleError) {
      // Nothing committed, so the sweep's buffered "authorization lapsed" lines
      // stay unsurfaced — only this one, naming a write that must be re-run.
      sink?.push(
        diag("error", CHAT_PERMISSION_SCENE_STALE, "the scene changed under this append's invalidation sweep", {
          path: CHAT_PERMISSION_EVENTS_PATH,
          context: { chatId: input.chatId, eventRef: input.eventRef, ends: endedContactIds.length },
        }),
      );
      return { status: "stale_scene" };
    }
    if (error instanceof ChatPermissionLedgerMismatchError) {
      sink?.push(
        diag("error", CHAT_PERMISSION_LEDGER_MISMATCH, "a ledger holds a different record under this call's keys", {
          path: CHAT_PERMISSION_EVENTS_PATH,
          context: { eventRef: input.eventRef, sequences: error.mismatched.map((key) => key.sequence) },
        }),
      );
      return { status: "mismatched", inserted: error.inserted, mismatched: error.mismatched };
    }
    throw error;
  }
}

/**
 * Whether a transcript row has authored NPC permission authority. Editing or
 * snipping such a row would let player-owned transcript tools rewrite NPC
 * agency without using the explicit retake rollback boundary.
 */
export async function chatMessageHasNpcPermissionAuthority(chatId: string, messageId: string): Promise<boolean> {
  const [row] = await db()
    .select({ id: chatPermissionEvents.id })
    .from(chatPermissionEvents)
    .where(
      and(
        eq(chatPermissionEvents.chatId, chatId),
        eq(chatPermissionEvents.guardMessageId, messageId),
        eq(chatPermissionEvents.sourceKind, "npc_decision"),
      ),
    )
    .limit(1);
  return row !== undefined;
}
