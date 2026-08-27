import { and, desc, eq, like, ne } from "drizzle-orm";
import { z } from "zod";
import {
  affordanceEvidence,
  contactBodySurfaceRefSchema,
  contactEndReasonSchema,
  CONTACT_LIFECYCLE_MAX_ACTIVE,
  diag,
  guidanceFingerprint,
  guidanceUnorderedPart,
  GUIDANCE_MAX_TRANSITIONS,
  type AffordanceSubjectId,
  type DiagnosticSink,
  type PhysicalStateTransition,
} from "@/contracts";
import { parseOrNull } from "@/lib/parse";
import { characterChatMessages, chatContactEvents, db } from "../db";

/**
 * THE REVOCATION STOP TRANSITION — the narrator handoff of a withdrawal
 * during active contact.
 *
 * When a withdrawal ends permission-dependent active contact, the sweep inside
 * `appendChatPermissionEventsWithInvalidation` writes `contact_ended` rows with
 * reason `policy_withdrawn` under the permission event refs
 * (`permission-reply:<assistantMessageId>` / `permission-override:<eventId>`).
 * The prose has not seen that yet: the NPC decision leg runs AFTER the reply it
 * read is committed, and an override lands between exchanges — so the NEXT
 * narrator reply must be told, or it silently continues a touch the state
 * already ended. This module is the durable "tell the next reply" half: it
 * turns those endings into `PhysicalStateTransition` candidates for the shared
 * guidance seam — the transition tier's first producer in this lane.
 *
 * ## The emission rule (no new state)
 *
 * A stop transition is emitted for a `policy_withdrawn` ending that NO
 * generated assistant reply has yet followed. That is durably decidable from
 * rows that already exist: while building guidance for the current exchange,
 * an ending is pending iff
 *
 * - there is no assistant message at all (the next reply is the first), or
 * - the ending row's `guard_message_id` IS the newest assistant row (an NPC
 *   decision's ending, written during that reply's settle — after the row it
 *   is guarded by), or
 * - the ending row's `created_at` is newer than the newest assistant row's
 *   (an override recorded between exchanges; also the settle case above, for
 *   which the guard branch is the timestamp-tie belt).
 *
 * The CURRENT exchange's own assistant row is excluded from "newest": a
 * regenerate reuses that row in place while replacing its content, so counting
 * it would let the discarded take satisfy "the stop was narrated". This
 * self-limits the emission to exactly one reply window — once the next reply
 * persists, every branch is false — and the retake prunes
 * (`deleteChatContactEventsForGuard` on both the exchange guard and the
 * assistant row) remove a discarded take's endings for free.
 *
 * ## Degradation
 *
 * A row whose payload cannot be narrowed degrades to a GENERIC stop transition
 * with a diagnostic, never to silence — losing the instruction is the worse
 * failure (a narrator that keeps a hand where the state ended it), while a
 * generic "that touch has ended" line is correct even without the pair's names
 * (docs/resilience.md §1–2). The candidates carry NO cause: the withdrawal,
 * the standing record, and the override source are policy internals the
 * narrator may never see, so `causeCodes` is empty by construction and the
 * rendered wording (chat-physical-guidance-render.ts) states only the
 * observable change.
 *
 * ## Budget interaction — why a multi-pair revocation cannot lose a stop
 *
 * The producer emits one transition per participant pair (dedup: two endings of
 * the same pair are one stop). The window above is what makes the budget
 * dangerous: an ending is pending for exactly one reply, so a pair that loses a
 * slot is not deferred — it is gone, and no reply ever carries its
 * spec-mandatory instruction. One ensemble reply can lawfully commit several
 * decisions whose sweep ends contact on several distinct pairs, so "rare" was
 * never "impossible".
 *
 * Two numbers therefore have to agree, and they do by construction:
 * `CHAT_PERMISSION_STOP_TRANSITIONS_BOUND` — everything this producer emits,
 * pairs and the degraded generic together — IS the shared tier's
 * `GUIDANCE_MAX_TRANSITIONS`. Inside a lawful exchange nothing is dropped
 * anywhere. Beyond it (more pending endings than one prompt can carry at all)
 * the trim happens HERE, with a `warn`, rather than downstream as an `info`
 * budget drop: this producer is the only layer that knows the loss is permanent.
 *
 * Gating is the CALLER's. `chatRomanticPermissionEnabled()` composes with
 * `CHAT_CONTACT_ACTIONS`, not the general `CHAT_PHYSICAL_CONSTRAINTS`
 * experiment (`prompts/constants.ts`). A pending stop still runs through the
 * shared physical-guidance compiler and renderer when that general experiment
 * is off, so permission authority never depends on a presentation flag. All
 * permission/contact flags off keep the prompt byte-identical.
 */

/** The boundary path a dropped row or unreadable payload reports under. */
const CHAT_PERMISSION_STOP_PATH = "chat_permission_stop_guidance";

/** An ending's payload could not be narrowed; a generic stop line ships instead. */
export const CHAT_PERMISSION_STOP_UNREADABLE = "chat_permission.stop_guidance.unreadable";

/**
 * More pending endings than one prompt can carry. `warn`, not `info`: unlike an
 * ordinary budget drop this loss is PERMANENT — the emission window closes with
 * the next reply, so a trimmed stop is never rendered on any later one.
 */
export const CHAT_PERMISSION_STOP_OVER_BOUND = "chat_permission.stop_guidance.over_bound";

/** The domain the stop transitions belong to — the contact lane's own id. */
export const CHAT_CONTACT_DOMAIN_ID = "contact";

/** The after-state code: the contact is over. Opaque to the guidance layer. */
export const CHAT_CONTACT_ENDED_CODE = "contact.ended";

/** Both permission event-ref namespaces share this prefix (chat-permission-events.ts). */
const PERMISSION_EVENT_REF_PREFIX = "permission-";

/**
 * How many ending rows one build will consider. Tied to the contact
 * projection's capacity, NOT to a comfortable-looking number: one withdrawal
 * sweeps every contact that depended on the lapsed grant, so a single append
 * can legitimately write as many endings as there were active contacts. Read
 * fewer and the overflow is invisible — the rows that fall outside the query
 * produce no stop line AND no over-bound diagnostic, and once the next reply
 * lands their emission window is closed for good. Several loci on one pair can
 * eat the budget on their own, which is exactly how another pair's ending gets
 * pushed out.
 */
export const CHAT_PERMISSION_STOP_ROWS_BOUND = CONTACT_LIFECYCLE_MAX_ACTIVE;

/**
 * How many stop transitions one build will emit — pair candidates and the
 * degraded generic TOGETHER, not pairs alone.
 *
 * Pinned to the shared tier budget rather than picked here, because the two
 * numbers must never disagree. Anything emitted past what selection can carry is
 * dropped downstream by a budget sized for optional descriptive detail, and the
 * emission window closes with the next reply — so a stop that lost a slot there
 * is a mandatory instruction that no reply ever gets. Emitting exactly what can
 * be carried, and reporting the remainder here, makes that loss impossible in
 * every lawful case and loud in the unlawful one.
 */
export const CHAT_PERMISSION_STOP_TRANSITIONS_BOUND = GUIDANCE_MAX_TRANSITIONS;

// ---------------------------------------------------------------------------
// The pure half — pending determination and candidate building
// ---------------------------------------------------------------------------

/** One `contact_ended` ledger row, as the pending decision needs it. */
export interface ChatPermissionStopLedgerRow {
  readonly eventRef: string;
  readonly contactId: string;
  readonly guardMessageId: string;
  readonly createdAt: Date;
  /** The stored `ContactLifecycleCommit`, exactly as the ledger holds it. */
  readonly payload: unknown;
}

/** The newest PERSISTED assistant reply, excluding the current exchange's own row. */
export interface ChatPermissionStopNewestReply {
  readonly id: string;
  readonly createdAt: Date;
}

/**
 * The slice of an ended commit this producer reads — bounded, and deliberately
 * not the core's full record: the candidate needs the pair, the surface, and
 * the reason, and a payload that cannot answer those three degrades to the
 * generic line rather than failing the read. The sweep only ends body-target
 * contacts, so a non-body target fails this narrow and degrades the same way.
 */
const stopPayloadSchema = z.object({
  kind: z.literal("contact_ended"),
  reason: contactEndReasonSchema,
  contact: z.object({
    source: contactBodySurfaceRefSchema,
    target: contactBodySurfaceRefSchema,
  }),
});

/** Has NO generated assistant reply followed this ending yet? */
function stopPending(row: ChatPermissionStopLedgerRow, newest: ChatPermissionStopNewestReply | null): boolean {
  if (newest === null) return true;
  if (row.guardMessageId === newest.id) return true;
  return row.createdAt.getTime() > newest.createdAt.getTime();
}

/** One pair's accumulated stop — the newest ref wins the identity, loci merge. */
interface StopPairAccumulator {
  readonly eventRef: string;
  readonly actorId: AffordanceSubjectId;
  readonly targetId: AffordanceSubjectId;
  readonly locusIds: string[];
}

/** The pair candidate. `causeCodes` is EMPTY by law: the cause is policy-side. */
function pairStopTransition(pair: StopPairAccumulator): PhysicalStateTransition {
  const identity = `permission-stop:${pair.eventRef}:${String(pair.actorId)}->${String(pair.targetId)}`;
  return {
    id: identity,
    subjectIds: [pair.actorId, pair.targetId],
    domainId: CHAT_CONTACT_DOMAIN_ID,
    locusIds: [...pair.locusIds],
    beforeCodes: pair.locusIds.map((locusId) => `contact.locus.${locusId}`),
    afterCodes: [CHAT_CONTACT_ENDED_CODE],
    causeCodes: [],
    relevance: "action",
    disclosure: "positive_detail_allowed",
    // Cause-free and ref-stable: a regenerate reuses the assistant row id the
    // reply ref is derived from, so the same moment re-derives the same key.
    repeatKey: identity,
    evidence: [affordanceEvidence("event", pair.eventRef, "contact_ended")],
    fingerprint: guidanceFingerprint([
      "permission-stop",
      pair.eventRef,
      String(pair.actorId),
      String(pair.targetId),
      guidanceUnorderedPart(pair.locusIds),
    ]),
  };
}

/** The degraded candidate for an unreadable ending: no pair, no locus, still a stop. */
function genericStopTransition(row: ChatPermissionStopLedgerRow): PhysicalStateTransition {
  const identity = `permission-stop:${row.eventRef}:unreadable`;
  return {
    id: identity,
    subjectIds: [],
    domainId: CHAT_CONTACT_DOMAIN_ID,
    locusIds: [],
    beforeCodes: [],
    afterCodes: [CHAT_CONTACT_ENDED_CODE],
    causeCodes: [],
    relevance: "action",
    disclosure: "positive_detail_allowed",
    repeatKey: identity,
    evidence: [affordanceEvidence("event", row.eventRef, "unreadable")],
    fingerprint: guidanceFingerprint(["permission-stop", row.eventRef, "unreadable"]),
  };
}

/**
 * The stop transitions the given ledger slice earns — PURE, so the emission
 * rule is testable without a database.
 *
 * Only `contact_ended` rows under the permission event-ref namespaces are
 * considered (the invalidation sweep is their only writer), and of those only
 * the ones no assistant reply has followed. A parseable payload must say
 * `policy_withdrawn` — the sweep writes nothing else, and a row that claims
 * otherwise is not this feature's to narrate. Endings collapse per participant
 * pair; an unreadable payload yields ONE generic candidate (however many rows
 * are unreadable) plus a diagnostic per row.
 *
 * EVERY pending pair is emitted, up to the bound the shared tier can carry — a
 * multi-pair revocation is not a "pick the best one" problem, because each pair
 * is its own binding instruction and the window that would let a loser come back
 * closes with the next reply. The newest pairs win the bound (the rows arrive
 * newest-first) and the degraded generic is trimmed first, since a named pair
 * carries strictly more instruction than "some touch ended".
 */
export function chatPermissionStopTransitions(input: {
  readonly rows: readonly ChatPermissionStopLedgerRow[];
  readonly newestAssistantReply: ChatPermissionStopNewestReply | null;
  readonly sink?: DiagnosticSink;
}): readonly PhysicalStateTransition[] {
  const pairs = new Map<string, StopPairAccumulator>();
  let generic: PhysicalStateTransition | null = null;
  for (const row of input.rows.slice(0, CHAT_PERMISSION_STOP_ROWS_BOUND)) {
    if (!row.eventRef.startsWith(PERMISSION_EVENT_REF_PREFIX)) continue;
    if (!stopPending(row, input.newestAssistantReply)) continue;
    const parsed = parseOrNull(stopPayloadSchema, row.payload, input.sink, CHAT_PERMISSION_STOP_PATH);
    if (parsed === null) {
      input.sink?.push(
        diag(
          "warn",
          CHAT_PERMISSION_STOP_UNREADABLE,
          "a pending contact ending could not be read; a generic stop line ships instead",
          { path: CHAT_PERMISSION_STOP_PATH, context: { eventRef: row.eventRef, contactId: row.contactId } },
        ),
      );
      generic ??= genericStopTransition(row);
      continue;
    }
    if (parsed.reason !== "policy_withdrawn") continue;
    const actorId = parsed.contact.source.subjectId;
    const targetId = parsed.contact.target.subjectId;
    // Unit-separator between the ids — a control character no subject id can
    // carry, so two pairs cannot collide by concatenation.
    const key = `${String(actorId)}\u001f${String(targetId)}`;
    const existing = pairs.get(key);
    if (existing !== undefined) {
      if (!existing.locusIds.includes(parsed.contact.target.locationId)) {
        existing.locusIds.push(parsed.contact.target.locationId);
      }
      continue;
    }
    // No cap in the loop: the row read is already bounded, and capping here
    // would make the drop invisible. The trim below is the ONE place a pending
    // stop can be lost, and it says so.
    pairs.set(key, { eventRef: row.eventRef, actorId, targetId, locusIds: [parsed.contact.target.locationId] });
  }
  // Pairs first (newest-first, the row order), the degraded generic last, so an
  // over-bound trim takes the least informative candidate first.
  const emitted = [
    ...[...pairs.values()].map((pair) => pairStopTransition(pair)),
    ...(generic === null ? [] : [generic]),
  ];
  if (emitted.length <= CHAT_PERMISSION_STOP_TRANSITIONS_BOUND) return emitted;
  input.sink?.push(
    diag(
      "warn",
      CHAT_PERMISSION_STOP_OVER_BOUND,
      "more pending contact endings than one prompt can carry; the oldest lose their stop instruction",
      {
        path: CHAT_PERMISSION_STOP_PATH,
        context: {
          pending: emitted.length,
          bound: CHAT_PERMISSION_STOP_TRANSITIONS_BOUND,
          dropped: emitted.slice(CHAT_PERMISSION_STOP_TRANSITIONS_BOUND).map((transition) => transition.id),
        },
      },
    ),
  );
  return emitted.slice(0, CHAT_PERMISSION_STOP_TRANSITIONS_BOUND);
}

// ---------------------------------------------------------------------------
// The IO half — the bounded ledger read
// ---------------------------------------------------------------------------

/** The narrowed row columns; `payload` stays raw for the pure half's parser. */
const stopRowSchema = z.object({
  eventRef: z.string(),
  contactId: z.string(),
  guardMessageId: z.string(),
  createdAt: z.date(),
});

/**
 * Load the pending stop transitions for one exchange — the bounded read plus
 * the pure emission rule.
 *
 * `assistantMessageId` is the CURRENT exchange's assistant row id, excluded
 * from the newest-reply read: a fresh exchange's id matches no row yet, and a
 * regenerate's names the row being replaced — in both cases the reply that
 * would narrate the stop has not been generated, so it must not count as
 * having followed the ending.
 */
export async function loadChatPermissionStopTransitions(input: {
  readonly chatId: string;
  readonly assistantMessageId: string;
  readonly sink?: DiagnosticSink;
}): Promise<readonly PhysicalStateTransition[]> {
  const [newest] = await db()
    .select({ id: characterChatMessages.id, createdAt: characterChatMessages.createdAt })
    .from(characterChatMessages)
    .where(
      and(
        eq(characterChatMessages.chatId, input.chatId),
        eq(characterChatMessages.role, "assistant"),
        ne(characterChatMessages.id, input.assistantMessageId),
      ),
    )
    .orderBy(desc(characterChatMessages.createdAt), desc(characterChatMessages.id))
    .limit(1);
  const rows = await db()
    .select({
      eventRef: chatContactEvents.eventRef,
      contactId: chatContactEvents.contactId,
      guardMessageId: chatContactEvents.guardMessageId,
      createdAt: chatContactEvents.createdAt,
      payload: chatContactEvents.payload,
    })
    .from(chatContactEvents)
    .where(
      and(
        eq(chatContactEvents.chatId, input.chatId),
        eq(chatContactEvents.kind, "contact_ended"),
        like(chatContactEvents.eventRef, `${PERMISSION_EVENT_REF_PREFIX}%`),
      ),
    )
    .orderBy(desc(chatContactEvents.createdAt), desc(chatContactEvents.sequence))
    .limit(CHAT_PERMISSION_STOP_ROWS_BOUND);
  const narrowed = rows.flatMap((row) => {
    const columns = parseOrNull(stopRowSchema, row, input.sink, CHAT_PERMISSION_STOP_PATH);
    return columns === null ? [] : [{ ...columns, payload: row.payload }];
  });
  return chatPermissionStopTransitions({
    rows: narrowed,
    newestAssistantReply: newest ?? null,
    ...(input.sink === undefined ? {} : { sink: input.sink }),
  });
}
