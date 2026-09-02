import { and, eq, sql } from "drizzle-orm";
import {
  diag,
  emptyVisualCueState,
  visualCueStateSchema,
  visualStateScopeKey,
  type DiagnosticSink,
  type VisualCueState,
  type VisualStateScopeRef,
} from "@/contracts";
import { parseOr } from "@/lib/parse";
import { chatVisualCues, db } from "../db";
import { visualMemoryGenerationFor, type ChatVisualMemoryKey } from "./visual-memory-store";

/**
 * NARRATOR VISUAL CUE STATE, PERSISTED.
 *
 * The IO half of `contracts/visual-state/cue-state.ts`: what the narrator has
 * had in view and what it has already said, for the families observer
 * recognition memory deliberately does not hold.
 *
 * ## Why this is not a column on `chat_visual_memory`
 *
 * The two records answer different questions for disjoint feature sets, and the
 * schema comment on `chat_visual_cues` records the design reason. The mechanical
 * reason is the generation shuffle below: it decides which generation to keep by
 * comparing the stored `applied_message_id` with the incoming one, so two upserts
 * against ONE row inside one exchange would have the second see a guard the first
 * had already stamped and skip the shuffle. Two rows, two guards, one law each.
 *
 * ## The retake law, verbatim from the memory store
 *
 * ```text
 * a NEW exchange   applied_message_id ≠ prompting id
 *                  → read `cues`         → write cues_before := cues
 * a RETAKE         applied_message_id = prompting id
 *                  → read `cues_before`  → leave cues_before alone
 * ```
 *
 * `visualMemoryGenerationFor` is imported rather than restated, so the two
 * stores can never disagree about what a retake is — the guard is the same
 * `promptMessageId ?? assistantMessageId` the state and scenario rollback anchors
 * take, and all four roll back to one boundary.
 *
 * The sequence counter inside the state is what makes this matter here more than
 * it does for memory: a retake that advanced the counter twice would make every
 * family read as "newly visible" on the following cut, which is precisely the
 * repetition the cue state exists to prevent.
 */

/** The stored blob was not even an object — nothing could be recovered from it. */
export const CHAT_VISUAL_CUES_UNREADABLE = "chat.visual_cues.unreadable";

/**
 * The row's first key column, for any lane that owns cue state.
 *
 * `memory_group_id` is the column's name and the chat lane's own id, so a chat
 * scope maps to the raw group id and every stored row keeps the key it already
 * has. Every other continuity is namespaced by `visualStateScopeKey`, which
 * prefixes the kind — a successor branch files under `world_branch:<branchId>`.
 * That prefix is the whole guarantee: a branch key can never collide with a
 * memory-group id, so a successor world starts from empty state and can never
 * inherit a conversation's mention history (or another branch's, since the
 * branch id is in the key).
 *
 * One function so the two lanes cannot disagree about what a row is keyed by,
 * and pure so a test can assert the isolation without a database.
 */
export function visualCueScopeKey(scope: VisualStateScopeRef): string {
  return scope.kind === "chat" ? scope.memoryGroupId : visualStateScopeKey(scope);
}

/** The boundary path both generations report under. */
const VISUAL_CUES_PATH = "chat_visual_cues.cues";

export interface LoadChatVisualCuesInput extends ChatVisualMemoryKey {
  /** The exchange's rollback guard — `promptMessageId ?? assistantMessageId`. */
  readonly promptingMessageId: string;
  readonly sink?: DiagnosticSink;
}

/**
 * This observer's cue state for this subject, as of BEFORE the exchange being
 * run. No row means nothing has been in view yet — the same value a corrupt blob
 * heals to.
 */
export async function loadChatVisualCues(input: LoadChatVisualCuesInput): Promise<VisualCueState> {
  const [row] = await db()
    .select({
      cues: chatVisualCues.cues,
      cuesBefore: chatVisualCues.cuesBefore,
      appliedMessageId: chatVisualCues.appliedMessageId,
    })
    .from(chatVisualCues)
    .where(
      and(
        eq(chatVisualCues.memoryGroupId, input.memoryGroupId),
        eq(chatVisualCues.viewpointId, input.viewpointId),
        eq(chatVisualCues.subjectId, input.subjectId),
      ),
    )
    .limit(1);
  if (!row) return emptyVisualCueState();

  const generation = visualMemoryGenerationFor(row, input.promptingMessageId);
  const raw = generation === "features_before" ? row.cuesBefore : row.cues;
  // `visualCueStateSchema` heals field by field and catches at the root, so
  // `parseOr` cannot fail — which would leave a blob carrying no cues at all (a
  // string, an array, a number) indistinguishable from an empty state. Naming
  // that case is the difference between "nothing seen yet" and "something wrote
  // garbage here", and only the second is worth a log line.
  if (raw !== null && raw !== undefined && (typeof raw !== "object" || Array.isArray(raw))) {
    input.sink?.push(
      diag("warn", CHAT_VISUAL_CUES_UNREADABLE, "Stored visual cue state is not an object", {
        path: VISUAL_CUES_PATH,
        context: { generation, subjectId: input.subjectId },
      }),
    );
  }
  return parseOr(visualCueStateSchema, raw ?? {}, emptyVisualCueState(), input.sink, VISUAL_CUES_PATH);
}

export interface SaveChatVisualCuesInput extends ChatVisualMemoryKey {
  /** The same guard the load used — the two must agree or the retake law breaks. */
  readonly promptingMessageId: string;
  readonly next: VisualCueState;
}

/**
 * Commit this exchange's cue state, shuffling generations in ONE statement — the
 * same `insert … on conflict do update` shape `saveChatVisualMemory` uses, and
 * for the same reason: Postgres compares the stored guard with the incoming one
 * atomically, so no read-modify-write transaction is needed.
 */
export async function saveChatVisualCues(input: SaveChatVisualCuesInput): Promise<void> {
  await db()
    .insert(chatVisualCues)
    .values({
      memoryGroupId: input.memoryGroupId,
      viewpointId: input.viewpointId,
      subjectId: input.subjectId,
      cues: input.next,
      // A first write has no earlier generation: a retake of the exchange that
      // created the row correctly recomputes from "nothing seen yet".
      cuesBefore: null,
      appliedMessageId: input.promptingMessageId,
    })
    .onConflictDoUpdate({
      target: [chatVisualCues.memoryGroupId, chatVisualCues.viewpointId, chatVisualCues.subjectId],
      set: {
        cues: sql`excluded.cues`,
        cuesBefore: sql`case
          when ${chatVisualCues}.applied_message_id is distinct from excluded.applied_message_id
          then ${chatVisualCues}.cues
          else ${chatVisualCues}.cues_before
        end`,
        appliedMessageId: sql`excluded.applied_message_id`,
        updatedAt: sql`now()`,
      },
    });
}
