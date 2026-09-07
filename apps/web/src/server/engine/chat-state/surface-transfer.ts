import type { SurfaceTransferProposal } from "@/contracts/affordances/contact";
import type { ChatState, ChatScenario } from "./types";
import type { SurfaceTransferLayerResolver } from "@/contracts/turns/chat-contact-transfer";
import { db, characterChatMessages } from "../../db";
import { eq } from "drizzle-orm";
import { upsertChatState, saveChatScenario } from "./store";
import { savePreExchangeSnapshot, savePreExchangeScenario } from "./snapshots";

/**
 * What a caller hands `finalizeChatState` to attempt a conserved surface
 * transfer: proposals and the OTHER side, never a settlement.
 * The owner transaction runs inside finalize so it settles against the same
 * folded surface that gets persisted.
 */
export interface ChatSurfaceTransferInput {
  readonly proposals: readonly SurfaceTransferProposal[];
  /**
   * The receiving character. `characterId` equal to the primary's is the way to
   * say "across one body" — finalize then settles both ends against the single
   * folded surface and writes no second row.
   */
  readonly destination: {
    readonly characterId: string;
    /**
     * The FULL state row to write for them: the settle upserts every column, so
     * a caller holding only a surface has to load the rest of that character's
     * state first. Its `bodySurface` is the pre-transfer value; finalize
     * replaces it with the credited one.
     */
    readonly state: ChatState;
    /**
     * Their rollback anchor as it stood BEFORE this exchange — supplied, never
     * derived, because finalize has no way to know what that character's row
     * looked like before this turn and guessing it would corrupt their retake.
     */
    readonly preExchangeState: ChatState | null;
  };
  /** How this lane turns a proposal's opaque layer handle into an address the garment owner can validate. */
  readonly resolveLayer: SurfaceTransferLayerResolver;
}

/**
 * Persist a transfer-bearing settle. This function is the persistence AUTHORITY
 * for the finalized values on such a settle: the state row, the scenario row,
 * the receiving character's row, and every rollback anchor are written here and
 * nowhere else for this exchange. No ordinary `saveChatState` /
 * `saveChatScenario` may run after it on the same exchange — those carry the
 * pre-transfer in-memory copies of the very rows this just debited and credited,
 * and re-writing them would restore the material the transfer removed while
 * leaving the credit standing, creating substance out of a stale object.
 *
 * The atomic boundary is the point. The conservation law requires source removal
 * and destination/intermediate deposition to commit atomically under one
 * idempotency key, and that law is simply unprovable across
 * two independent statements: skin lives in `character_chat_state.body_surface`
 * and garments in
 * `character_chats.garments`, so a crash, a lost connection, or a deploy between
 * the two writes leaves material deleted from one row and never credited to the
 * other — a silent, permanent conservation violation that no retry can detect,
 * because the transfer's receipt rides the surface that DID get written. One
 * transaction makes the pair all-or-nothing, which is the only shape in which
 * "conservation holds" is a checkable claim rather than a hope.
 *
 * The receiving character's ROLLBACK ANCHOR is inside the boundary for the same
 * reason the credit is. Conservation requires that a retake "removes both sides
 * or neither", and a retake restores each character's row from its own
 * `pre_exchange_state`: an anchor that was never written, or written outside this
 * transaction and lost to the crash that rolled the credit back, leaves the
 * retake able to undo the debit while the credit stands — precisely the
 * half-applied state the atomicity law exists to forbid. Both anchors and both
 * rows commit together or the exchange writes nothing.
 *
 * ONE GUARD DECISION, taken under a row lock before any write. Each of the six
 * writes below carries the ordinary settle's `exists (select 1 from
 * character_chat_messages …)` guard, and under READ COMMITTED each of those
 * subqueries takes its OWN snapshot. So a Clear/Reset that deletes the prompting
 * message part-way through the settlement can let the first upsert land while
 * every later write silently no-ops — and the transaction still COMMITS the
 * difference. That is the same half-applied shape conservation forbids, arrived at from
 * the other direction: a debit with no credit, and a rollback anchor that was
 * never written, so the retake has nothing to restore and "removes both sides or
 * neither" becomes unprovable. The `for update` lock below collapses the six
 * independent decisions into one: the message either exists when we take the
 * lock — in which case a concurrent delete BLOCKS on it for this transaction's
 * duration instead of racing it statement by statement, and all six guards are
 * guaranteed to agree — or it is already gone, and we throw before writing
 * anything. Throwing, not returning: a silent return is indistinguishable from a
 * successful settle to every caller, and this settlement's own diagnostics would
 * then claim material moved when nothing was written.
 *
 * The per-statement guards STAY. They are the same guards the ordinary settle
 * uses, they cost nothing, and dropping them here would fork the two paths for
 * no gain — they are simply backed by one locked decision now rather than six
 * independent ones.
 *
 * The ordinary, transfer-free settle deliberately does NOT come through here
 * (owner ruling 2026-08-26). It runs on every exchange in the chat lane, and
 * wrapping four writes that already succeed independently in a transaction would
 * hold a pooled connection open across the whole settle to buy nothing — there
 * is no cross-row invariant to protect when nothing moved between rows. Transfer
 * is fixture-only under the conservation law's escape clause, so the cost of the boundary is paid
 * only by the path that needs it and the hot path stays byte-identical.
 *
 * Fire-and-forget follow-ups (sketch/look enqueues) stay OUTSIDE: they are not
 * part of the conserved equation, and a detached job must never be able to hold
 * a transaction open or roll one back.
 *
 * Two things are knowingly outside the boundary and acceptable only while
 * transfer is fixture-only: `chatGarmentLookChanged` still compares against the
 * PRE-transfer garment store, so a transfer that credits a garment does not
 * trigger the look-refresh enqueue; and this transaction holds one pooled
 * connection across two large JSONB upserts, which would be a real contention
 * cost on a live per-exchange path.
 */
export async function persistSurfaceTransferSettlement(args: {
  chatId: string;
  characterId: string;
  promptMessageId: string;
  /** The primary's finalized state, already carrying the transfer's DEBITED source surface. */
  state: ChatState;
  /** The finalized scenario, already carrying the transfer's credited garment store. */
  scenario: ChatScenario;
  preExchangeState: ChatState | null;
  preExchangeScenario: ChatScenario | null;
  /**
   * The receiving character's row and its own rollback anchor, when the
   * destination is a different character. The anchor is passed in rather than
   * derived: only the caller knows what that row held before this exchange.
   */
  destination?: {
    readonly characterId: string;
    readonly state: ChatState;
    readonly preExchangeState: ChatState | null;
  };
}): Promise<void> {
  await db().transaction(async (tx) => {
    // The single guard decision (see the doc comment): lock the prompting
    // message BEFORE any write, so the six per-statement guards below can no
    // longer disagree with each other mid-transaction. A concurrent delete now
    // waits on this lock rather than landing between two of them.
    const [prompt] = await tx
      .select({ id: characterChatMessages.id })
      .from(characterChatMessages)
      .where(eq(characterChatMessages.id, args.promptMessageId))
      .limit(1)
      .for("update");
    if (!prompt) {
      // The exchange this settlement belongs to is gone (Clear/Reset). Abort
      // before writing anything: rolling back is the only outcome that leaves
      // neither half of the transfer standing, and throwing is what stops the
      // caller from recording a settle that never happened.
      throw new Error(`surface transfer settlement: prompting message ${args.promptMessageId} no longer exists`);
    }
    // Order mirrors the ordinary settle exactly: the upserts first, then the
    // anchors. `savePreExchangeSnapshot` is a targeted UPDATE that assumes the
    // state row already exists, so it can only ever follow its own upsert.
    await upsertChatState(args.chatId, args.characterId, args.state, args.promptMessageId, tx);
    await saveChatScenario(args.chatId, args.scenario, args.promptMessageId, tx);
    const destination =
      args.destination !== undefined && args.destination.characterId !== args.characterId
        ? args.destination
        : undefined;
    if (destination !== undefined) {
      await upsertChatState(args.chatId, destination.characterId, destination.state, args.promptMessageId, tx);
    }
    await savePreExchangeSnapshot(args.chatId, args.characterId, args.preExchangeState, args.promptMessageId, tx);
    if (destination !== undefined) {
      // The credited character's retake anchor — same transaction as their
      // credit, so "removes both sides or neither" stays provable.
      await savePreExchangeSnapshot(
        args.chatId,
        destination.characterId,
        destination.preExchangeState,
        args.promptMessageId,
        tx,
      );
    }
    await savePreExchangeScenario(args.chatId, args.preExchangeScenario, args.promptMessageId, tx);
  });
}