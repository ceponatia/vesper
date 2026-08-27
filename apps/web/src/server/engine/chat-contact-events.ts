import { and, asc, eq, inArray, sql } from "drizzle-orm";
import { z } from "zod";
import type { ContactEventRef, ContactLifecycleCommit, DiagnosticSink, SceneState } from "@/contracts";
import { parseOrNull } from "@/lib/parse";
import { characterChats, chatContactEvents, db, type Db } from "../db";
import { insertVerifiedLedgerRows, ledgerMismatches, type LedgerKey } from "./ledger-verify";

/**
 * THE CHAT LANE'S DURABLE CONTACT LEDGER (the affectionate integration proof).
 *
 * The one IO module of the contact seam. Everything above it — resolution,
 * lifecycle, the scene fold — is pure contract code; this file owns the rows,
 * their trust boundary, and the retake delete.
 *
 * The ruled law it implements is **durable event/action provenance plus a
 * versioned active-contact projection captured in the chat's retake snapshot —
 * never prompt-local**. Two halves, and this is the first:
 *
 * ```text
 * chat_contact_events   the commits, append-only, keyed by exchange   ← provenance
 * ChatScenario.scene    the SceneState + housed contact projection    ← projection
 *   (character_chats.scene, and therefore pre_exchange_scenario)
 * ```
 *
 * The projection is a CACHE of these rows: `replayContactCommits` folds a stream
 * back into exactly the state it was produced from, which is what stops the two
 * from becoming two truths. Before this existed the lane had neither — a touch
 * lived in the rendered sentence and died with it, because per-message `meta` is
 * deliberately thin and the `events` table is fire-and-forget observability.
 *
 * **Both halves are written together.** `appendChatContactEventsWithScene` puts
 * the rows and the `character_chats.scene` they fold into in ONE transaction, so
 * the cache cannot outlive — or fall behind — the record it caches.
 *
 * ## The retake contract
 *
 * `guardMessageId` is the exchange guard (`promptMessageId ?? assistantMessageId`)
 * — the same key the state anchor, the scenario anchor and `chat_visual_memory`
 * take, so one exchange rolls back to one boundary. "Another take" restores the
 * projection through `pre_exchange_scenario` and calls
 * `deleteChatContactEventsForGuard` before the leg re-runs, so a regenerated
 * exchange leaves one ledger entry per thing that happened rather than one per
 * attempt. The `onConflictDoNothing` below is the belt to that suspenders: a
 * retried write of the SAME event re-derives identical keys and lands nowhere —
 * and the conflict is then VERIFIED rather than assumed, because "the key is
 * taken" and "the key is taken by this very write" are not the same fact.
 *
 * ## Degradation
 *
 * An unreadable row is dropped from a read with a boundary diagnostic, never
 * thrown: a ledger this module cannot narrow is a ledger the reader must do
 * without, and a lost turn would be the worse answer (docs/resilience.md §1–2).
 */

/** The boundary path a dropped row reports under. */
const CHAT_CONTACT_EVENTS_PATH = "chat_contact_events";

/**
 * The persisted commit kinds, mirroring the `kind` column's enum.
 *
 * Derived from the contract union rather than restated, so a new lifecycle case
 * cannot be added upstream and silently go unpersisted here.
 */
export const chatContactEventKinds = [
  "contact_started",
  "contact_updated",
  "contact_continued",
  "contact_ended",
] as const satisfies readonly ContactLifecycleCommit["kind"][];

export type ChatContactEventKind = ContactLifecycleCommit["kind"];

/** One row to write. Pure data — `chatContactEventRowsFor` builds it, the append sends it. */
export interface ChatContactEventInsert {
  readonly chatId: string;
  readonly guardMessageId: string;
  readonly eventRef: string;
  readonly sequence: number;
  readonly kind: ChatContactEventKind;
  readonly contactId: string;
  readonly storyMinute: number;
  readonly payload: ContactLifecycleCommit;
}

export interface AppendChatContactEventsInput {
  readonly chatId: string;
  /** The exchange guard — `promptMessageId ?? assistantMessageId`. The retake key. */
  readonly guardMessageId: string;
  /** The lane event these commits belong to. EVERY row of one event shares it. */
  readonly eventRef: ContactEventRef;
  /** The story-clock minute the exchange committed at (`ChatScenario.clockMinutes`). */
  readonly storyMinute: number;
  readonly commits: readonly ContactLifecycleCommit[];
}

/** One ledger row as the reader sees it. */
export interface ChatContactEventRow {
  readonly id: string;
  readonly guardMessageId: string;
  readonly eventRef: string;
  readonly sequence: number;
  readonly kind: ChatContactEventKind;
  readonly contactId: string;
  readonly storyMinute: number;
  /**
   * The serialized `ContactLifecycleCommit`, exactly as stored. Deliberately
   * `unknown`: this store records commits, it does not interpret them, and the
   * contact core owns the parser that decides what a corrupt one means.
   */
  readonly payload: unknown;
  readonly createdAt: Date;
}

/**
 * The narrowed columns. `payload` is absent on purpose — see `ChatContactEventRow`:
 * validating a blob this module makes no claims about would only invent an
 * opinion about it, and `kind` is the one text column a hand-edit could put
 * outside the vocabulary.
 */
const chatContactEventRowSchema = z.object({
  id: z.string(),
  guardMessageId: z.string(),
  eventRef: z.string(),
  sequence: z.number().int(),
  kind: z.enum(chatContactEventKinds),
  contactId: z.string(),
  storyMinute: z.number().int(),
  createdAt: z.date(),
});

/**
 * Which contact a commit is about. `contact_started` names it through the
 * committed read (the id is DERIVED from the pair and the start event, so a
 * replay reproduces it); every other case carries it directly.
 */
function commitContactId(commit: ContactLifecycleCommit): string {
  switch (commit.kind) {
    case "contact_started":
      return commit.contact.contactId;
    case "contact_updated":
    case "contact_continued":
    case "contact_ended":
      return commit.contactId;
  }
}

/**
 * The commit stream, as rows. PURE — extracted so the ledger's two load-bearing
 * rules are testable without a database, exactly as `visualMemoryGenerationFor`
 * is for the visual-memory store.
 *
 * **`contact_continued` is never written.** It is the no-op case by
 * construction: a held contact that nothing changed keeps its id and its start
 * event, so ten quiet exchanges are ONE start, not ten rows. Persisting holds
 * would make the ledger's size a function of how long a hand rests somewhere,
 * and a replay of it would produce the identical projection either way.
 *
 * **`sequence` indexes the WHOLE commit list**, gaps included, not the surviving
 * rows. That is what makes the idempotency key re-derivable from the event
 * alone: renumbering after the filter would mean a retry that classified one
 * commit differently wrote a row at a sequence some other commit already owns,
 * and the conflict would then hide a real divergence instead of a duplicate.
 */
export function chatContactEventRowsFor(input: AppendChatContactEventsInput): ChatContactEventInsert[] {
  return input.commits.flatMap((commit, index) =>
    commit.kind === "contact_continued"
      ? []
      : [
          {
            chatId: input.chatId,
            guardMessageId: input.guardMessageId,
            eventRef: input.eventRef,
            sequence: index,
            kind: commit.kind,
            contactId: commitContactId(commit),
            storyMinute: input.storyMinute,
            payload: commit,
          },
        ],
  );
}

// ---------------------------------------------------------------------------
// The append: rows and projection, in one transaction
// ---------------------------------------------------------------------------

/** One ledger row's identity, as a mismatch report names it. */
export type ChatContactLedgerKey = LedgerKey;

/**
 * What the append did.
 *
 * `recorded` means every attempted row is durably present AS ATTEMPTED — either
 * inserted by this call, or already there carrying identical content — and the
 * projection landed with it. `inserted` is how many rows landed THIS time, and 0
 * is an ordinary answer (an idempotent retry, or an event that only continued
 * existing contacts).
 *
 * `mismatched` is the case `onConflictDoNothing` alone cannot see: the keys are
 * taken by rows that say something ELSE. Nothing was written — not the rows, not
 * the scene — and the caller must not acknowledge a record it did not make.
 */
export type ChatContactAppendResult =
  | { readonly status: "recorded"; readonly inserted: number }
  | {
      readonly status: "mismatched";
      readonly inserted: number;
      readonly mismatched: readonly ChatContactLedgerKey[];
    };

/** The diagnostic code a caller files when an append comes back `mismatched`. */
export const CHAT_CONTACT_LEDGER_MISMATCH = "chat_contact.ledger.mismatch";

/**
 * The stored half of a comparison — the columns a conflicting row is judged on.
 *
 * `guardMessageId` is deliberately absent: the event ref is DERIVED from the
 * guard (`chatContactEventRef`), so two rows sharing a key already share a
 * guard, and comparing it would only restate the key.
 */
export interface ChatContactEventStoredRow {
  readonly sequence: number;
  readonly kind: ChatContactEventKind;
  readonly contactId: string;
  readonly storyMinute: number;
  readonly payload: unknown;
}

/**
 * Two JSON values in ONE normal form.
 *
 * Postgres `jsonb` does not preserve key order — it stores an object's keys
 * sorted by length then bytes — so a row read back is NOT byte-comparable with
 * the commit that was written, however stable this module's own serialization
 * is. Sorting keys recursively is what makes the comparison about CONTENT.
 *
 * The round-trip through `JSON.stringify`/`parse` first is the other half: it
 * drops `undefined` members and applies any `toJSON`, so a live commit object is
 * reduced to exactly the value the column received.
 *
 * Exported for the decision-envelope transaction (`chat-npc-scene-envelope.ts`),
 * whose canonical-byte-equivalence and scene fingerprints must judge jsonb
 * round-trips by exactly this rule — a second normal form living beside this one
 * is how two comparisons quietly start disagreeing.
 */
export function canonicalJson(value: unknown): string {
  if (value === undefined) return "";
  const parsed: unknown = JSON.parse(JSON.stringify(value));
  return JSON.stringify(canonicalize(parsed));
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) {
    const entries: readonly unknown[] = value;
    return entries.map((entry) => canonicalize(entry));
  }
  if (value === null || typeof value !== "object") return value;
  const record = value as Record<string, unknown>;
  const sorted: Record<string, unknown> = {};
  for (const key of Object.keys(record).sort()) sorted[key] = canonicalize(record[key]);
  return sorted;
}

/** Is the row already under this key the row this write meant to put there? PURE. */
export function chatContactRowMatches(
  attempted: ChatContactEventInsert,
  stored: ChatContactEventStoredRow,
): boolean {
  return (
    stored.kind === attempted.kind &&
    stored.contactId === attempted.contactId &&
    stored.storyMinute === attempted.storyMinute &&
    canonicalJson(stored.payload) === canonicalJson(attempted.payload)
  );
}

/**
 * The attempted rows whose key is held by a DIFFERENT record, in sequence order.
 * PURE. The judgment itself is the shared `ledgerMismatches` (`ledger-verify.ts`
 * — one algorithm for both chat ledgers); this binding supplies the contact
 * ledger's own row comparison.
 *
 * An attempted row with no stored counterpart is not a mismatch: it did not
 * conflict, so there is nothing that could disagree with it. (Inside the
 * transaction the case cannot arise — a row either inserted or collided with one
 * that is therefore visible to the same statement — but a total function is
 * cheaper than a comment promising it never happens.)
 */
export function chatContactLedgerMismatches(
  attempted: readonly ChatContactEventInsert[],
  stored: readonly ChatContactEventStoredRow[],
): readonly ChatContactLedgerKey[] {
  return ledgerMismatches(attempted, stored, chatContactRowMatches);
}

/** The transaction handle a `db().transaction` callback receives — the surface both contact-writing transactions share. */
export type ChatDbTransaction = Parameters<Parameters<Db["transaction"]>[0]>[0];

/**
 * The IO half of the ledger's idempotent-and-verified write, factored so BOTH
 * contact-writing transactions run the identical judgment: this module's
 * `appendChatContactEventsWithScene` (the player leg and the reply-side ending
 * floor) and the decision-envelope transaction in `chat-npc-scene-envelope.ts`
 * (the reply-scene leg). Two copies of "insert, then verify every collided key"
 * would be two chances for one of them to acknowledge somebody else's record.
 *
 * Runs INSIDE the caller's transaction and returns a value rather than
 * throwing: each caller owns its own abort shape (this module's mismatch error,
 * the envelope module's conflict error), and a helper that threw one of them
 * would couple the two result vocabularies together.
 *
 * `inserted` counts the rows that landed THIS call; `mismatched` names every
 * attempted key held by a DIFFERENT record. A non-empty `mismatched` means the
 * caller must abort — rows this call DID insert are already part of its
 * transaction and roll back with it.
 */
export async function insertVerifiedChatContactRows(
  tx: ChatDbTransaction,
  input: {
    readonly chatId: string;
    readonly eventRef: string;
    readonly rows: readonly ChatContactEventInsert[];
  },
): Promise<{ inserted: number; mismatched: readonly ChatContactLedgerKey[] }> {
  return insertVerifiedLedgerRows({
    rows: input.rows,
    insert: (rows) =>
      tx
        .insert(chatContactEvents)
        .values([...rows])
        .onConflictDoNothing({
          target: [chatContactEvents.chatId, chatContactEvents.eventRef, chatContactEvents.sequence],
        })
        .returning({ sequence: chatContactEvents.sequence }),
    loadStored: (sequences) =>
      tx
        .select({
          sequence: chatContactEvents.sequence,
          kind: chatContactEvents.kind,
          contactId: chatContactEvents.contactId,
          storyMinute: chatContactEvents.storyMinute,
          payload: chatContactEvents.payload,
        })
        .from(chatContactEvents)
        .where(
          and(
            eq(chatContactEvents.chatId, input.chatId),
            eq(chatContactEvents.eventRef, input.eventRef),
            inArray(chatContactEvents.sequence, [...sequences]),
          ),
        ),
    matches: chatContactRowMatches,
  });
}

/**
 * The abort.
 *
 * Verification needs the insert's OWN result — which keys collided — so it
 * cannot run before the write. It runs inside the transaction and throws, which
 * is the only way to un-write rows that already landed. Caught at the boundary
 * below and turned back into a value: the leg above takes diagnostics, not
 * exceptions (docs/resilience.md §2).
 */
class ChatContactLedgerMismatchError extends Error {
  readonly mismatched: readonly ChatContactLedgerKey[];
  readonly inserted: number;

  constructor(mismatched: readonly ChatContactLedgerKey[], inserted: number) {
    super(`chat contact ledger holds a different record for ${mismatched.length} key(s)`);
    this.name = "ChatContactLedgerMismatchError";
    this.mismatched = mismatched;
    this.inserted = inserted;
  }
}

export interface AppendChatContactEventsWithSceneInput extends AppendChatContactEventsInput {
  /**
   * The POST-commit scene — the projection with this event's contact state
   * already folded in (`withSceneContacts(scene, commit.state)`). The caller
   * folds; this store records what it was handed, so the lifecycle rules stay in
   * one pure place.
   */
  readonly scene: SceneState;
}

/**
 * Record this event's commits AND the projection they produce, atomically.
 *
 * The two halves of the ruled law are ONE write. Before this, the rows were
 * appended pre-prompt while `character_chats.scene` only persisted at settle, so
 * an exchange that appended and then never settled (a stream failure, a crash, a
 * chat cleared mid-turn) left durable rows describing a contact the projection
 * had never heard of. Now the commits and the scene land together or neither
 * does. Settle re-writes the same column afterwards with the same value — the
 * only drift left, and a no-op by construction.
 *
 * ## Idempotent, and verified
 *
 * A retried write of the same event re-derives the same
 * (chat, event ref, sequence) keys, so `onConflictDoNothing` makes the retry
 * land nowhere and the caller never has to know whether it already ran.
 *
 * But a conflict is only evidence that the KEY is taken. `inserted: 0` covers
 * two different worlds: the ordinary idempotent retry, and a stale row recorded
 * under this key by some other take (an on→off→on flag sequence can leave one —
 * the retake delete only prunes while the flag is on). Acknowledging the second
 * would report somebody else's record as this turn's commit, and the whole point
 * of the acknowledgment is that it proves the write happened. So every
 * conflicting key is read back and compared against what was attempted; a
 * disagreement aborts the transaction and comes back as `mismatched`, leaving no
 * rows added and the scene column untouched.
 */
export async function appendChatContactEventsWithScene(
  input: AppendChatContactEventsWithSceneInput,
): Promise<ChatContactAppendResult> {
  const rows = chatContactEventRowsFor(input);
  try {
    return await db().transaction(async (tx): Promise<ChatContactAppendResult> => {
      const { inserted, mismatched } = await insertVerifiedChatContactRows(tx, {
        chatId: input.chatId,
        eventRef: input.eventRef,
        rows,
      });
      if (mismatched.length > 0) throw new ChatContactLedgerMismatchError(mismatched, inserted);
      // The projection, in the same transaction. Written even when the event
      // produced no rows (an all-`contact_continued` fold): the scene still
      // advanced, and the ledger correctly has nothing to add.
      await tx.execute(sql`
        update ${characterChats} set scene = ${JSON.stringify(input.scene)}::jsonb where id = ${input.chatId}
      `);
      return { status: "recorded", inserted };
    });
  } catch (error) {
    if (error instanceof ChatContactLedgerMismatchError) {
      return { status: "mismatched", inserted: error.inserted, mismatched: error.mismatched };
    }
    throw error;
  }
}

/**
 * The retake half: drop everything this exchange recorded, so the new take
 * writes the only ledger entries for it.
 *
 * Run BEFORE the leg re-commits, alongside the scenario rollback that restores
 * the projection those rows replay into — the two together are what make a
 * second take of one exchange indistinguishable from a first.
 *
 * The caller runs this UNCONDITIONALLY, not behind the contact flag: pruning the
 * durable rows of a discarded take is hygiene of state that already exists, and
 * a chat that never recorded a contact deletes zero for free. Gating it would
 * mean an on→off→retake sequence rolled the projection back and left the old
 * take's rows behind to be verified against — or replayed — later.
 */
export async function deleteChatContactEventsForGuard(
  chatId: string,
  guardMessageId: string,
): Promise<{ deleted: number }> {
  const deleted = await db()
    .delete(chatContactEvents)
    .where(and(eq(chatContactEvents.chatId, chatId), eq(chatContactEvents.guardMessageId, guardMessageId)))
    .returning({ id: chatContactEvents.id });
  return { deleted: deleted.length };
}

/**
 * This chat's ledger, in the order a fold must apply it: by when the exchange
 * landed, then by the commit's place within its event (the ends that freed a
 * pair ahead of the start that claimed it).
 *
 * A row that cannot be narrowed is dropped with a boundary diagnostic rather
 * than failing the read — the rest of the ledger is still true.
 */
export async function listChatContactEvents(
  chatId: string,
  sink?: DiagnosticSink,
): Promise<ChatContactEventRow[]> {
  const rows = await db()
    .select({
      id: chatContactEvents.id,
      guardMessageId: chatContactEvents.guardMessageId,
      eventRef: chatContactEvents.eventRef,
      sequence: chatContactEvents.sequence,
      kind: chatContactEvents.kind,
      contactId: chatContactEvents.contactId,
      storyMinute: chatContactEvents.storyMinute,
      payload: chatContactEvents.payload,
      createdAt: chatContactEvents.createdAt,
    })
    .from(chatContactEvents)
    .where(eq(chatContactEvents.chatId, chatId))
    .orderBy(asc(chatContactEvents.createdAt), asc(chatContactEvents.sequence));
  return rows.flatMap((row) => {
    const narrowed = parseOrNull(chatContactEventRowSchema, row, sink, CHAT_CONTACT_EVENTS_PATH);
    return narrowed === null ? [] : [{ ...narrowed, payload: row.payload }];
  });
}
