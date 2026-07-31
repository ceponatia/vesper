import { and, asc, eq } from "drizzle-orm";
import { z } from "zod";
import type { ContactEventRef, ContactLifecycleCommit, DiagnosticSink } from "@/contracts";
import { parseOrNull } from "@/lib/parse";
import { chatContactEvents, db } from "../db";

/**
 * THE CHAT LANE'S DURABLE CONTACT LEDGER (romantic-contact-affordances — the
 * affectionate integration proof).
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
 * ## The retake contract
 *
 * `guardMessageId` is the exchange guard (`promptMessageId ?? assistantMessageId`)
 * — the same key the state anchor, the scenario anchor and `chat_visual_memory`
 * take, so one exchange rolls back to one boundary. "Another take" restores the
 * projection through `pre_exchange_scenario` and calls
 * `deleteChatContactEventsForGuard` before the leg re-runs, so a regenerated
 * exchange leaves one ledger entry per thing that happened rather than one per
 * attempt. The `onConflictDoNothing` below is the belt to that suspenders: a
 * retried write of the SAME event re-derives identical keys and lands nowhere.
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

/** One row to write. Pure data — `chatContactEventRowsFor` builds it, `appendChatContactEvents` sends it. */
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

/**
 * Append this event's commits. Idempotent: a retried write of the same event
 * re-derives the same (chat, event ref, sequence) keys and conflicts harmlessly,
 * so the caller never has to know whether it already ran.
 *
 * Returns how many rows actually landed — 0 is a perfectly ordinary answer (an
 * event that only continued existing contacts, or a re-send of one already
 * recorded), never an error.
 */
export async function appendChatContactEvents(
  input: AppendChatContactEventsInput,
): Promise<{ inserted: number }> {
  const rows = chatContactEventRowsFor(input);
  if (rows.length === 0) return { inserted: 0 };
  const inserted = await db()
    .insert(chatContactEvents)
    .values(rows)
    .onConflictDoNothing({
      target: [chatContactEvents.chatId, chatContactEvents.eventRef, chatContactEvents.sequence],
    })
    .returning({ id: chatContactEvents.id });
  return { inserted: inserted.length };
}

/**
 * The retake half: drop everything this exchange recorded, so the new take
 * writes the only ledger entries for it.
 *
 * Run BEFORE the leg re-commits, alongside the scenario rollback that restores
 * the projection those rows replay into — the two together are what make a
 * second take of one exchange indistinguishable from a first.
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
