import { createHash } from "node:crypto";
import { and, desc, eq, isNull, sql } from "drizzle-orm";
import { z } from "zod";
import {
  diag,
  NPC_SCENE_EVIDENCE_MAX_CHARS,
  type ContactEventRef,
  type ContactLifecycleCommit,
  type DiagnosticSink,
  type SceneState,
} from "@/contracts";
import { parseOr, parseOrNull } from "@/lib/parse";
import { characterChatMessages, characterChats, chatNpcSceneDecisions, db } from "../db";
import {
  canonicalJson,
  chatContactEventRowsFor,
  insertVerifiedChatContactRows,
  type ChatContactLedgerKey,
} from "./chat-contact-events";

/**
 * THE NPC REPLY-SCENE DECISION ENVELOPE — durable identity for every outcome of
 * the reply-scene leg, empty ones included
 * (romantic-contact-affordances.spec.actor-control.md §"Durable decision
 * envelope and transaction"; delivery-order step 2).
 *
 * `chat_contact_events` records what a decision COMMITTED; nothing recorded what
 * a decision WAS. A movement lands only in `character_chats.scene`, and a
 * trigger miss, a timeout, or an all-rejected proposal set lands nowhere at all
 * — so a retry could silently reclassify the same persisted reply into
 * different authority, and the dev inspector could explain a contact row but
 * never a movement or a silence. One row per assistant message fixes both: the
 * envelope is the tombstone the reuse check reads, and it is the TRACE the
 * inspector reads (there is deliberately no best-effort `lastSceneDecisionTrace`
 * field on the chat).
 *
 * ## The guarded transaction (`recordChatNpcSceneDecision`)
 *
 * One transaction owns the envelope, the reply's contact rows, and the scene
 * projection, under four explicit predicates — each one a WHY, not a
 * formality:
 *
 * 1. **The assistant row still exists in this chat and its stored content
 *    hashes to `reply_hash`.** The decision was made about exact reply bytes; a
 *    reply that was deleted or re-taken mid-decision is a decision about
 *    nothing, and committing it would attach authority to prose nobody kept.
 * 2. **`character_chats.scene` is JSONB-equal to the expected post-settle base
 *    scene** (compare-and-swap). The resolvers validated candidates against
 *    THAT projection; if anything else wrote the column since, the validation
 *    proves nothing about the column's current value, so zero matched rows is a
 *    typed `stale_scene` and a full rollback.
 * 3. **No envelope exists for this assistant message, or the existing one is
 *    canonical-byte-equivalent to the attempted one.** The unique
 *    (chat, assistant message) key is the first-writer race's arbiter: an
 *    equivalent loser is an idempotent retry (`reused`, nothing written); a
 *    non-equivalent loser would be a SECOND opinion about the same reply and
 *    fails closed (`envelope_conflict`).
 * 4. **Every conflicting contact row under the reply event ref matches
 *    exactly** — the same verified idempotency the player ledger runs, through
 *    the same shared helper (`insertVerifiedChatContactRows`), because "the key
 *    is taken" and "the key is taken by this very write" are different facts.
 *
 * The ONLY committing path is `recorded`. Every other outcome throws an
 * internal abort and rolls the whole transaction back, so "nothing was written"
 * is structural rather than argued case by case — an empty rollback costs
 * nothing, and a partial write can never leak past a typed result. Callers get
 * diagnostics, never exceptions (docs/resilience.md §2).
 *
 * ## The retake prune
 *
 * `deleteChatNpcSceneDecision` is UNCONDITIONAL by design — no flag checks
 * inside, mirroring `deleteChatContactEventsForGuard`'s ruling: pruning the
 * durable record of a discarded take is hygiene of state that already exists,
 * and gating it would let an on→off→retake sequence strand an old take's
 * envelope under the very key the next take must write (which predicate 3 would
 * then refuse forever). Cascade deletion on the assistant-message FK remains
 * the hard-delete backstop.
 *
 * ## Degradation
 *
 * The stored payload is parsed with `parseOr` at every read boundary: a
 * malformed blob degrades to the empty payload with a diagnostic, never a
 * throw. The envelope's semantic columns are narrowed the same way a contact
 * row is — a row this module cannot narrow is dropped from the read, and the
 * caller sees `null` plus the diagnostic rather than a crash.
 */

/** The boundary path a dropped or degraded row reports under. */
const CHAT_NPC_SCENE_DECISIONS_PATH = "chat_npc_scene_decisions";

/** The diagnostic code every persistence conflict files (spec §"Diagnostics"). */
export const NPC_SCENE_DECISION_PERSISTENCE_CONFLICT = "npc_scene_decision.persistence_conflict";

// ---------------------------------------------------------------------------
// The payload: bounded, self-contained, parsed defensively
// ---------------------------------------------------------------------------

/**
 * The payload's own version, INSIDE the blob — the column-level
 * `schema_version` speaks for the classifier output schema the decision was
 * made under; this literal speaks for the payload serialization itself, so the
 * two can move independently.
 *
 * Adding an OPTIONAL field does not move it: every stored payload still parses,
 * and a reader on an older deployment simply strips the key it does not know.
 */
export const NPC_SCENE_DECISION_PAYLOAD_VERSION = 1;

/**
 * What became of one raw output slot. "absent" and "malformed" are DIFFERENT
 * trace outcomes by ruling (spec §"Closed decision schema" — no `.catch(null)`),
 * which is exactly why the envelope must record which one happened.
 */
export const npcSceneDecisionSlotOutcomes = ["absent", "malformed", "parsed"] as const;
export type NpcSceneDecisionSlotOutcome = (typeof npcSceneDecisionSlotOutcomes)[number];

/**
 * Why a candidate was dropped — the spec's diagnostics vocabulary with the
 * `npc_scene_decision.` namespace factored out. A bounded enum rather than free
 * text so the shadow-gate tallies (drop reasons per hundred replies) are a
 * GROUP BY, not a regex.
 */
export const npcSceneDecisionDropReasons = [
  "slot_malformed",
  "ref_invalid",
  "evidence_ungrounded",
  "evidence_ambiguous",
  "evidence_unasserted",
  "evidence_misattributed",
  "evidence_incongruent",
  "chronology_ambiguous",
  "presence_conflict",
  "contact_conflict",
  "wardrobe_chronology_ambiguous",
] as const;
export type NpcSceneDecisionDropReason = (typeof npcSceneDecisionDropReasons)[number];

/**
 * Where an admitted, ordered action came from: the frozen deterministic ending
 * floor, a tier-2 movement proposal, a tier-2 contact proposal, or the
 * PRESENCE PRECEDENCE fold that ends an away participant's contacts before any
 * tier-2 proposal resolves (spec §"Authoritative post-settle cut" 1).
 *
 * `presence_ending` is its own kind rather than a `floor_ending` with a detail,
 * because the floor is a prose EXTRACTOR and this is not: nothing was read, a
 * roster row said the body left, and an inspector reading "floor_ending" for it
 * would be looking for a sentence that never existed. It is authority-mode only
 * — shadow grants no presence-driven authority — so no shadow envelope carries
 * one, and widening the enum leaves every stored payload parsing as before.
 */
export const npcSceneDecisionActionKinds = ["floor_ending", "presence_ending", "movement", "contact"] as const;
export type NpcSceneDecisionActionKind = (typeof npcSceneDecisionActionKinds)[number];

/**
 * What resolution did with an admitted action. `committed` wrote state;
 * `continued` is the no-row `contact_continued` outcome; `unresolved` is the
 * resolver's silence (material unavailable, geometry unsupported); `refused` is
 * a resolver law saying no; `dropped` is a post-admission chronology/presence
 * fold removing it.
 */
export const npcSceneDecisionResolutions = [
  "committed",
  "continued",
  "unresolved",
  "refused",
  "dropped",
] as const;
export type NpcSceneDecisionResolution = (typeof npcSceneDecisionResolutions)[number];

const SUMMARY_MAX = 200;
const FIELD_MAX = 64;
const MODEL_MAX = 120;
const EVENT_REF_MAX = 200;
const MAX_ACTIONS = 24;
const MAX_DROPS = 24;
/**
 * List caps a WRITER must respect, exported for the same reason the blob cap
 * is: the payload is inserted without a runtime parse, so an over-cap list
 * would sail into the column and then fail `parseNpcSceneDecisionPayload` on
 * every later read — degrading the WHOLE payload to empty. A writer with more
 * rows than fit slices the reference list and says so in the action's detail;
 * the ledger rows themselves are the authoritative record either way.
 */
export const NPC_SCENE_DECISION_MAX_CONTACT_ROWS = 24;
export const NPC_SCENE_DECISION_MAX_ROWS_PER_ACTION = 8;
const MAX_CONTACT_ROWS = NPC_SCENE_DECISION_MAX_CONTACT_ROWS;
const MAX_ROWS_PER_ACTION = NPC_SCENE_DECISION_MAX_ROWS_PER_ACTION;
/**
 * Byte cap on one action's carried commit/intent blob (serialized).
 *
 * Exported because the WRITER has to respect it too: the payload is inserted
 * without a runtime parse, so an oversized blob would sail into the column and
 * then fail `parseNpcSceneDecisionPayload` on every later read — degrading the
 * WHOLE payload to empty. A writer that cannot fit its provenance drops the
 * blob and says so in the detail instead.
 */
export const NPC_SCENE_DECISION_COMMITTED_BLOB_MAX_BYTES = 4_096;

/**
 * Character cap on a drop record's verbatim evidence excerpt.
 *
 * It IS the classifier contract's own evidence cap, deliberately: a candidate
 * that parsed carries a quote already bounded by that number, so storing it
 * whole is always in bounds and a reviewer never reads a truncated sentence and
 * mistakes the truncation for what the model claimed.
 *
 * Exported because the WRITER must respect it, exactly as the sibling caps are:
 * the payload is inserted without a runtime parse, so an over-cap excerpt would
 * sail into the column and then fail `parseNpcSceneDecisionPayload` on every
 * later read — degrading the WHOLE payload to empty.
 */
export const NPC_SCENE_DECISION_DROP_EVIDENCE_MAX = NPC_SCENE_EVIDENCE_MAX_CHARS;

/** sha256 hex, or "" when the field genuinely has nothing to fingerprint. */
const hashOrEmptySchema = z.string().regex(/^(?:[0-9a-f]{64})?$/);

/**
 * Absolute offsets into the exact persisted reply — `[start, end)`, the same
 * convention the grounding gate returns. `end > start` because a zero-width
 * action span cannot order anything.
 */
const actionSpanSchema = z
  .object({ start: z.number().int().min(0), end: z.number().int().min(1) })
  .refine((span) => span.end > span.start, { message: "span end must be past its start" });

/** One committed ledger row, by the identity a replay re-derives. */
const contactRowRefSchema = z.object({
  eventRef: z.string().min(1).max(EVENT_REF_MAX),
  sequence: z.number().int().min(0),
});

/**
 * A verbatim JSON blob carried for provenance (the actual committed scene
 * intent or lifecycle commit — spec: the envelope stores what was COMMITTED,
 * not only the model candidates). Size-capped and never interpreted here; the
 * wiring stage's own contracts parse it.
 */
const committedBlobSchema = z.unknown().superRefine((value, ctx) => {
  let serialized: string | undefined;
  try {
    serialized = JSON.stringify(value);
  } catch {
    ctx.addIssue({ code: "custom", message: "committed blob is not serializable" });
    return;
  }
  if (serialized !== undefined && serialized.length > NPC_SCENE_DECISION_COMMITTED_BLOB_MAX_BYTES) {
    ctx.addIssue({
      code: "custom",
      message: `committed blob exceeds ${NPC_SCENE_DECISION_COMMITTED_BLOB_MAX_BYTES} bytes`,
    });
  }
});

/**
 * One NORMALIZED ordered action — the chronological record the spec makes the
 * envelope's centerpiece: floor results and tier-2 candidates sorted by
 * absolute start offset, not schema slot order.
 */
const orderedActionSchema = z.object({
  kind: z.enum(npcSceneDecisionActionKinds),
  span: actionSpanSchema,
  /** sha256 hex of the normalized grounded quote; "" when the action carries none (floor results own their vocabulary). */
  quoteHash: hashOrEmptySchema.default(""),
  /** One bounded human line for the inspector ("approach npc_0 → player, close"). */
  summary: z.string().max(SUMMARY_MAX).default(""),
  resolution: z.enum(npcSceneDecisionResolutions),
  /** Bounded resolver detail beside the enum (e.g. the refusal's reason literal). */
  detail: z.string().max(SUMMARY_MAX).default(""),
  /** The committed intent/commit, verbatim — replayable provenance. */
  committed: committedBlobSchema.optional(),
  /** The ledger rows THIS action produced (chronological contact-commit order). */
  contactRows: z.array(contactRowRefSchema).max(MAX_ROWS_PER_ACTION).default([]),
});

/** One dropped candidate and the gate that dropped it. */
const droppedCandidateSchema = z.object({
  candidate: z.enum(["movement", "contact"]),
  reason: z.enum(npcSceneDecisionDropReasons),
  /** For `evidence_incongruent`: which proposed field the evidence failed to prove. */
  field: z.string().max(FIELD_MAX).default(""),
  detail: z.string().max(SUMMARY_MAX).default(""),
  /**
   * The candidate's verbatim evidence quote, length-capped; `""` when the drop
   * has no candidate to quote at all (`slot_malformed`).
   *
   * A drop is only reviewable BESIDE the quote the model grounded it on: an
   * `evidence_misattributed` over a reply holding both a player-movement
   * sentence and a pronoun-subject NPC sentence is a correct gate if it read
   * the first and an over-strict one if it read the second, and the reason code
   * alone cannot tell those apart.
   */
  evidence: z.string().max(NPC_SCENE_DECISION_DROP_EVIDENCE_MAX).default(""),
});

/**
 * Model/latency telemetry, following the other structured legs' fields, plus the
 * SPEND the cost gate is stated in (spec §"Execution, flags, and cost gate").
 *
 * The spend fields are optional and absent-when-unknown rather than defaulted to
 * zero, because the gate reads them as measurements: a timed-out call and a free
 * one are different facts, and only absence tells them apart. `settleWaitMs` is
 * how long settlement actually blocked on the classifier — the added latency —
 * where `latencyMs` measures the call, which was launched before settlement and
 * may have finished inside it.
 */
const decisionTelemetrySchema = z.object({
  model: z.string().max(MODEL_MAX).default(""),
  latencyMs: z.number().min(0).default(0),
  timedOut: z.boolean().default(false),
  inputTokens: z.number().int().min(0).optional(),
  outputTokens: z.number().int().min(0).optional(),
  costUsd: z.number().min(0).optional(),
  settleWaitMs: z.number().min(0).optional(),
});

/**
 * The bounded payload. Every list is capped and every free-text field is
 * length-limited, because this blob is written once per assistant reply for the
 * life of the feature — an unbounded field here is a table that grows by prose.
 */
export const npcSceneDecisionPayloadSchema = z.object({
  version: z.literal(NPC_SCENE_DECISION_PAYLOAD_VERSION),
  /** What each raw output slot parsed to — recorded even when a sibling slot failed. */
  slots: z.object({
    movement: z.enum(npcSceneDecisionSlotOutcomes),
    contact: z.enum(npcSceneDecisionSlotOutcomes),
  }),
  /** Admitted actions in chronological (offset) order — the full ordered list, no-row continuations included. */
  actions: z.array(orderedActionSchema).max(MAX_ACTIONS).default([]),
  /** Candidates the gates dropped, with bounded reasons. */
  drops: z.array(droppedCandidateSchema).max(MAX_DROPS).default([]),
  /** Every ledger row committed under the reply event ref, in row order. */
  contactRows: z.array(contactRowRefSchema).max(MAX_CONTACT_ROWS).default([]),
  telemetry: decisionTelemetrySchema.default({ model: "", latencyMs: 0, timedOut: false }),
});

export type NpcSceneDecisionPayload = z.infer<typeof npcSceneDecisionPayloadSchema>;
export type NpcSceneDecisionAction = NpcSceneDecisionPayload["actions"][number];
export type NpcSceneDecisionDrop = NpcSceneDecisionPayload["drops"][number];

/**
 * The degraded default (docs/resilience.md §1: fallbacks are schema defaults
 * defined beside the schema). An empty payload beside a real status column is
 * still an honest tombstone — "a decision happened; its detail did not
 * survive" — which is strictly better than a throw that costs the read.
 */
export function emptyNpcSceneDecisionPayload(): NpcSceneDecisionPayload {
  return {
    version: NPC_SCENE_DECISION_PAYLOAD_VERSION,
    slots: { movement: "absent", contact: "absent" },
    actions: [],
    drops: [],
    contactRows: [],
    telemetry: { model: "", latencyMs: 0, timedOut: false },
  };
}

/** The payload's trust boundary. Malformed ⇒ the empty payload + a diagnostic, never a throw. */
export function parseNpcSceneDecisionPayload(raw: unknown, sink?: DiagnosticSink): NpcSceneDecisionPayload {
  return parseOr(
    npcSceneDecisionPayloadSchema,
    raw,
    emptyNpcSceneDecisionPayload(),
    sink,
    `${CHAT_NPC_SCENE_DECISIONS_PATH}.payload`,
  );
}

// ---------------------------------------------------------------------------
// Hashes and canonical-byte-equivalence
// ---------------------------------------------------------------------------

function sha256Hex(material: string): string {
  return createHash("sha256").update(material).digest("hex");
}

/**
 * The `reply_hash` column's value: sha256 hex over the EXACT persisted reply
 * string (utf8) — deliberately NOT canonicalized, because the decision's
 * grounding offsets index these precise bytes and a whitespace-different reply
 * is a different reply.
 */
export function chatNpcReplyHash(replyContent: string): string {
  return sha256Hex(replyContent);
}

/**
 * A scene projection fingerprint (`base_scene_hash` / `result_scene_hash`).
 * Canonicalized (sorted keys, jsonb-shaped) so the fingerprint survives the
 * column round trip: the value Postgres hands back must hash identically to
 * the value that was written, or every replay comparison would be noise.
 */
export function chatNpcSceneHash(scene: SceneState): string {
  return sha256Hex(canonicalJson(scene));
}

/**
 * The `digest_hash` column's value, over the canonical serialization of the
 * classifier digest. Typed `unknown` on purpose: the digest's shape belongs to
 * the pure foundation (step 1); this module only fingerprints it.
 */
export function chatNpcDigestHash(digest: unknown): string {
  return sha256Hex(canonicalJson(digest));
}

export const npcSceneDecisionModes = ["shadow", "authority"] as const;
export type NpcSceneDecisionMode = (typeof npcSceneDecisionModes)[number];

/** All three are durable tombstones — an empty outcome is as reusable as a commit. */
export const npcSceneDecisionStatuses = ["trigger_miss", "degraded", "evaluated"] as const;
export type NpcSceneDecisionStatus = (typeof npcSceneDecisionStatuses)[number];

/** The envelope a writer attempts — the row's semantic content, identity and clock aside. */
export interface ChatNpcSceneDecisionEnvelope {
  readonly replyHash: string;
  readonly digestHash: string;
  readonly schemaVersion: number;
  readonly mode: NpcSceneDecisionMode;
  readonly storyMinute: number;
  readonly status: NpcSceneDecisionStatus;
  readonly baseSceneHash: string;
  readonly resultSceneHash: string;
  readonly payload: NpcSceneDecisionPayload;
}

/**
 * The comparison-side view of the same content: a STORED payload is a jsonb
 * round trip this module makes no shape claims about, so equivalence takes it
 * as `unknown`. An attempted envelope satisfies this structurally.
 */
export interface ChatNpcSceneDecisionContent extends Omit<ChatNpcSceneDecisionEnvelope, "payload"> {
  readonly payload: unknown;
}

/**
 * The ONE normal form the idempotency predicate compares.
 *
 * Object keys are sorted recursively (via `canonicalJson`), so jsonb's own key
 * reordering and a writer's field order are both invisible — order-insensitive
 * where order carries no meaning. Arrays are NOT reordered: the payload's
 * `actions` list is chronological by ruling, so two envelopes disagreeing about
 * action order genuinely disagree. `id` and `createdAt` are excluded — they
 * identify the ROW, not the decision — and chat/message ids are excluded
 * because equivalence is only ever asked under one (chat, assistant) key.
 */
export function canonicalNpcSceneDecisionBytes(content: ChatNpcSceneDecisionContent): string {
  return canonicalJson({
    replyHash: content.replyHash,
    digestHash: content.digestHash,
    schemaVersion: content.schemaVersion,
    mode: content.mode,
    storyMinute: content.storyMinute,
    status: content.status,
    baseSceneHash: content.baseSceneHash,
    resultSceneHash: content.resultSceneHash,
    payload: content.payload,
  });
}

/** Predicate 3's judgment: is the existing envelope THIS decision, already durable? PURE. */
export function npcSceneDecisionEquivalent(
  left: ChatNpcSceneDecisionContent,
  right: ChatNpcSceneDecisionContent,
): boolean {
  return canonicalNpcSceneDecisionBytes(left) === canonicalNpcSceneDecisionBytes(right);
}

// ---------------------------------------------------------------------------
// The guarded transaction
// ---------------------------------------------------------------------------

export interface RecordChatNpcSceneDecisionInput {
  readonly chatId: string;
  readonly assistantMessageId: string;
  readonly envelope: ChatNpcSceneDecisionEnvelope;
  /**
   * The reply-side contact half. `commits` may be empty — a movement-only,
   * no-row, `trigger_miss`, or `degraded` decision still records its envelope
   * and still runs the scene CAS. Rows are stamped with the ENVELOPE's story
   * minute (truncated once for the whole decision, per the spec).
   */
  readonly contact: {
    /** The retake guard the rows hang on (the assistant row, for reply-side events). */
    readonly guardMessageId: string;
    /** The reply event ref — `contact-reply:<assistantMessageId>` (`chatReplyContactEventRef`). */
    readonly eventRef: ContactEventRef;
    readonly commits: readonly ContactLifecycleCommit[];
  };
  /**
   * The scene CAS. `expectedBase` is the post-settle projection EXACTLY as the
   * reply-scene leg reloaded it (`null` ⇒ the column is expected to still be
   * SQL NULL — a pre-feature row). `next` may equal `expectedBase`: the CAS
   * still runs, because "the scene did not change" is only true if nothing
   * else changed it either.
   */
  readonly scene: {
    readonly expectedBase: SceneState | null;
    readonly next: SceneState;
  };
  /** Conflict outcomes file `npc_scene_decision.persistence_conflict` here. */
  readonly sink?: DiagnosticSink;
}

/**
 * What the transaction did. `recorded` is the ONLY outcome that wrote anything;
 * every other case rolled the whole transaction back (or never wrote), so a
 * caller can treat "not recorded and not reused" as "the database does not
 * carry my decision" without per-case reasoning.
 */
export type ChatNpcSceneDecisionRecordResult =
  | { readonly status: "recorded"; readonly insertedContactRows: number }
  /** An equivalent envelope already stands — the idempotent retry / lost-but-agreeing race. */
  | { readonly status: "reused" }
  /** Predicate 2 failed: something else wrote `character_chats.scene` since the base cut. */
  | { readonly status: "stale_scene" }
  /** Predicate 1 failed: the reply row is gone, not an assistant row, or carries different bytes. */
  | { readonly status: "assistant_missing"; readonly reason: "row_missing" | "content_changed" }
  /** Predicate 3 failed: a NON-equivalent envelope holds the key. */
  | { readonly status: "envelope_conflict" }
  /** Predicate 4 failed: the reply event ref's keys are held by different records. */
  | { readonly status: "ledger_conflict"; readonly mismatched: readonly ChatContactLedgerKey[] };

/**
 * The abort. Thrown INSIDE the transaction for every non-`recorded` outcome —
 * including the ones that had written nothing yet — so rollback is the uniform
 * exit and "nothing was written" is structural. Caught at the boundary below
 * and turned back into a value (docs/resilience.md §2).
 */
class ChatNpcSceneDecisionAbort extends Error {
  readonly result: Exclude<ChatNpcSceneDecisionRecordResult, { status: "recorded" }>;

  constructor(result: Exclude<ChatNpcSceneDecisionRecordResult, { status: "recorded" }>) {
    super(`npc scene decision not recorded: ${result.status}`);
    this.name = "ChatNpcSceneDecisionAbort";
    this.result = result;
  }
}

/**
 * Record one reply's decision envelope, its contact rows, and the scene
 * projection — atomically, under the four predicates the module doc lays out.
 *
 * Supports every outcome shape the spec names: envelope + rows + scene
 * together; envelope-only (empty `commits`, `next` equal to `expectedBase`);
 * movement-only (empty `commits`, changed scene). Never throws for a conflict
 * — the typed result IS the answer, and `sink` carries the diagnostic.
 */
export async function recordChatNpcSceneDecision(
  input: RecordChatNpcSceneDecisionInput,
): Promise<ChatNpcSceneDecisionRecordResult> {
  const rows = chatContactEventRowsFor({
    chatId: input.chatId,
    guardMessageId: input.contact.guardMessageId,
    eventRef: input.contact.eventRef,
    storyMinute: input.envelope.storyMinute,
    commits: input.contact.commits,
  });

  let result: ChatNpcSceneDecisionRecordResult;
  try {
    result = await db().transaction(async (tx): Promise<ChatNpcSceneDecisionRecordResult> => {
      // Predicate 1 — the reply this decision is about still exists, byte for byte.
      const [assistantRow] = await tx
        .select({ role: characterChatMessages.role, content: characterChatMessages.content })
        .from(characterChatMessages)
        .where(
          and(
            eq(characterChatMessages.id, input.assistantMessageId),
            eq(characterChatMessages.chatId, input.chatId),
          ),
        )
        .limit(1);
      if (assistantRow === undefined || assistantRow.role !== "assistant") {
        throw new ChatNpcSceneDecisionAbort({ status: "assistant_missing", reason: "row_missing" });
      }
      if (chatNpcReplyHash(assistantRow.content) !== input.envelope.replyHash) {
        throw new ChatNpcSceneDecisionAbort({ status: "assistant_missing", reason: "content_changed" });
      }

      // Predicate 3 — first writer wins the unique key; a loser is judged, not
      // trusted. The conflicted insert wrote nothing, so the re-read + compare
      // decides between the idempotent retry and a genuine second opinion.
      const landedEnvelope = await tx
        .insert(chatNpcSceneDecisions)
        .values({
          chatId: input.chatId,
          assistantMessageId: input.assistantMessageId,
          replyHash: input.envelope.replyHash,
          digestHash: input.envelope.digestHash,
          schemaVersion: input.envelope.schemaVersion,
          mode: input.envelope.mode,
          storyMinute: input.envelope.storyMinute,
          status: input.envelope.status,
          baseSceneHash: input.envelope.baseSceneHash,
          resultSceneHash: input.envelope.resultSceneHash,
          payload: input.envelope.payload,
        })
        .onConflictDoNothing({
          target: [chatNpcSceneDecisions.chatId, chatNpcSceneDecisions.assistantMessageId],
        })
        .returning({ id: chatNpcSceneDecisions.id });
      if (landedEnvelope.length === 0) {
        const [existing] = await tx
          .select({
            replyHash: chatNpcSceneDecisions.replyHash,
            digestHash: chatNpcSceneDecisions.digestHash,
            schemaVersion: chatNpcSceneDecisions.schemaVersion,
            mode: chatNpcSceneDecisions.mode,
            storyMinute: chatNpcSceneDecisions.storyMinute,
            status: chatNpcSceneDecisions.status,
            baseSceneHash: chatNpcSceneDecisions.baseSceneHash,
            resultSceneHash: chatNpcSceneDecisions.resultSceneHash,
            payload: chatNpcSceneDecisions.payload,
          })
          .from(chatNpcSceneDecisions)
          .where(
            and(
              eq(chatNpcSceneDecisions.chatId, input.chatId),
              eq(chatNpcSceneDecisions.assistantMessageId, input.assistantMessageId),
            ),
          )
          .limit(1);
        // A key that conflicted and then vanished is a concurrent prune — the
        // decision landscape moved under us either way. Fail closed.
        if (existing === undefined || !npcSceneDecisionEquivalent(existing, input.envelope)) {
          throw new ChatNpcSceneDecisionAbort({ status: "envelope_conflict" });
        }
        throw new ChatNpcSceneDecisionAbort({ status: "reused" });
      }

      // Predicate 4 — the reply event ref's rows, inserted idempotently and
      // VERIFIED, through the same helper the player ledger's transaction runs.
      const { inserted, mismatched } = await insertVerifiedChatContactRows(tx, {
        chatId: input.chatId,
        eventRef: input.contact.eventRef,
        rows,
      });
      if (mismatched.length > 0) {
        throw new ChatNpcSceneDecisionAbort({ status: "ledger_conflict", mismatched });
      }

      // Predicate 2 — the compare-and-swap. Runs UNCONDITIONALLY (movement-only,
      // no-row, and unchanged-scene decisions included): matching zero rows is
      // the only proof that nothing else wrote the projection since the
      // post-settle cut this decision was resolved against.
      const swapped = await tx
        .update(characterChats)
        .set({ scene: sql`${JSON.stringify(input.scene.next)}::jsonb` })
        .where(
          and(
            eq(characterChats.id, input.chatId),
            input.scene.expectedBase === null
              ? isNull(characterChats.scene)
              : sql`${characterChats.scene} = ${JSON.stringify(input.scene.expectedBase)}::jsonb`,
          ),
        )
        .returning({ id: characterChats.id });
      if (swapped.length === 0) {
        throw new ChatNpcSceneDecisionAbort({ status: "stale_scene" });
      }

      return { status: "recorded", insertedContactRows: inserted };
    });
  } catch (error) {
    if (!(error instanceof ChatNpcSceneDecisionAbort)) throw error;
    result = error.result;
  }

  // Diagnostics over exceptions: a conflict is a story the shadow gate needs to
  // hear, not a crash. `reused` is silent — it is the designed idempotent path.
  if (result.status !== "recorded" && result.status !== "reused") {
    input.sink?.push(
      diag("warn", NPC_SCENE_DECISION_PERSISTENCE_CONFLICT, `decision envelope not recorded: ${result.status}`, {
        path: CHAT_NPC_SCENE_DECISIONS_PATH,
        context: {
          chatId: input.chatId,
          assistantMessageId: input.assistantMessageId,
          status: result.status,
          ...(result.status === "assistant_missing" ? { reason: result.reason } : {}),
          ...(result.status === "ledger_conflict" ? { mismatched: result.mismatched.length } : {}),
        },
      }),
    );
  }
  return result;
}

// ---------------------------------------------------------------------------
// The retake prune
// ---------------------------------------------------------------------------

/**
 * Drop one assistant message's decision envelope — the retake half.
 *
 * Runs UNCONDITIONALLY (no flag checks in here, and none belong in any caller's
 * path to it): "another take" must prune the discarded take's envelope beside
 * the `pre_exchange_scenario` restoration and the contact-row prune EVEN IF the
 * feature flags are now off, because predicate 3 would otherwise refuse the
 * regenerated take's new envelope forever — the old tombstone would hold the
 * unique key under different reply bytes. Deleting zero rows is the ordinary
 * answer for a chat that never ran the leg, and it costs nothing.
 */
export async function deleteChatNpcSceneDecision(
  chatId: string,
  assistantMessageId: string,
): Promise<{ deleted: number }> {
  const deleted = await db()
    .delete(chatNpcSceneDecisions)
    .where(
      and(
        eq(chatNpcSceneDecisions.chatId, chatId),
        eq(chatNpcSceneDecisions.assistantMessageId, assistantMessageId),
      ),
    )
    .returning({ id: chatNpcSceneDecisions.id });
  return { deleted: deleted.length };
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

/** One envelope as a reader sees it — payload already through its boundary. */
export interface ChatNpcSceneDecisionRow {
  readonly id: string;
  readonly assistantMessageId: string;
  readonly replyHash: string;
  readonly digestHash: string;
  readonly schemaVersion: number;
  readonly mode: NpcSceneDecisionMode;
  readonly storyMinute: number;
  readonly status: NpcSceneDecisionStatus;
  readonly baseSceneHash: string;
  readonly resultSceneHash: string;
  readonly payload: NpcSceneDecisionPayload;
  readonly createdAt: Date;
}

/**
 * The narrowed semantic columns. `payload` is absent here on purpose — it has
 * its own boundary (`parseNpcSceneDecisionPayload`, which degrades instead of
 * dropping), while `mode`/`status` are the text columns a hand-edit could put
 * outside the vocabulary, and a row whose STATUS cannot be read is a row the
 * reader must do without.
 */
const chatNpcSceneDecisionRowSchema = z.object({
  id: z.string(),
  assistantMessageId: z.string(),
  replyHash: z.string(),
  digestHash: z.string(),
  schemaVersion: z.number().int(),
  mode: z.enum(npcSceneDecisionModes),
  storyMinute: z.number().int(),
  status: z.enum(npcSceneDecisionStatuses),
  baseSceneHash: z.string(),
  resultSceneHash: z.string(),
  createdAt: z.date(),
});

const decisionRowColumns = {
  id: chatNpcSceneDecisions.id,
  assistantMessageId: chatNpcSceneDecisions.assistantMessageId,
  replyHash: chatNpcSceneDecisions.replyHash,
  digestHash: chatNpcSceneDecisions.digestHash,
  schemaVersion: chatNpcSceneDecisions.schemaVersion,
  mode: chatNpcSceneDecisions.mode,
  storyMinute: chatNpcSceneDecisions.storyMinute,
  status: chatNpcSceneDecisions.status,
  baseSceneHash: chatNpcSceneDecisions.baseSceneHash,
  resultSceneHash: chatNpcSceneDecisions.resultSceneHash,
  payload: chatNpcSceneDecisions.payload,
  createdAt: chatNpcSceneDecisions.createdAt,
} as const;

/** Raw row → reader row, through both boundaries. `null` when the row cannot be narrowed. */
function narrowDecisionRow(
  row: Record<keyof typeof decisionRowColumns, unknown>,
  sink?: DiagnosticSink,
): ChatNpcSceneDecisionRow | null {
  const narrowed = parseOrNull(chatNpcSceneDecisionRowSchema, row, sink, CHAT_NPC_SCENE_DECISIONS_PATH);
  if (narrowed === null) return null;
  return { ...narrowed, payload: parseNpcSceneDecisionPayload(row.payload, sink) };
}

/**
 * The newest non-pruned envelope for a chat — the dev trace reader's read
 * (spec: "the envelope is the trace"). "Non-pruned" is structural: a pruned
 * envelope is a deleted row, so whatever exists is current. `null` for a chat
 * that never recorded one, or whose newest row cannot be narrowed (the
 * diagnostic says which).
 */
export async function newestChatNpcSceneDecision(
  chatId: string,
  sink?: DiagnosticSink,
): Promise<ChatNpcSceneDecisionRow | null> {
  const [row] = await db()
    .select(decisionRowColumns)
    .from(chatNpcSceneDecisions)
    .where(eq(chatNpcSceneDecisions.chatId, chatId))
    .orderBy(desc(chatNpcSceneDecisions.createdAt))
    .limit(1);
  if (row === undefined) return null;
  return narrowDecisionRow(row, sink);
}

/**
 * One assistant message's envelope — the reuse check's read ("before
 * classification, an existing envelope with the same reply hash is reused
 * regardless of current flags"). The wiring stage calls this before spending a
 * classifier call; landing it here keeps the read beside the write it mirrors.
 */
export async function loadChatNpcSceneDecision(
  chatId: string,
  assistantMessageId: string,
  sink?: DiagnosticSink,
): Promise<ChatNpcSceneDecisionRow | null> {
  const [row] = await db()
    .select(decisionRowColumns)
    .from(chatNpcSceneDecisions)
    .where(
      and(
        eq(chatNpcSceneDecisions.chatId, chatId),
        eq(chatNpcSceneDecisions.assistantMessageId, assistantMessageId),
      ),
    )
    .limit(1);
  if (row === undefined) return null;
  return narrowDecisionRow(row, sink);
}
