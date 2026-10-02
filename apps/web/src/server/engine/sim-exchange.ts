import type { ExchangeOperation } from "@/contracts/turns/chat-exchange-trace";
import { startExchangeTrace } from "./chat-exchange-trace";
import { hasActiveTimeJob } from "./simulation";
import { resolveSimExchange } from "./sim-exchange/context";
import type { SimChatExchangeResult, SimChatExchangeMode } from "./sim-exchange/types";
import { runSimTurn } from "./sim-exchange/turn";
import { runSimRetake } from "./sim-exchange/retake";

/** The sim lane's four modes, mapped onto the exchange trace's closed operation vocabulary.
 * `retake` always targets the latest reply (there is no sim equivalent of regenerating an
 * older one), so it maps to `rerun` rather than `regenerate`. */
function simModeToExchangeOperation(mode: SimChatExchangeMode): ExchangeOperation {
  switch (mode) {
    case "send":
      return "send";
    case "continue":
      return "continue";
    case "open":
      return "open";
    case "retake":
      return "rerun";
  }
}

/**
 * Run one successor exchange for an OWNERSHIP-CHECKED chat (routing parity).
 * The `mode` picks the semantics; the authority
 * gate, world-truth names, dialogue tail, clock, memory/summary, render, and
 * persist are one shared path with mode-conditional steps:
 *
 * - **send** — land the player line, run input admission, advance the span, render
 *   a FRESH cut, persist a new assistant reply (existing behavior).
 * - **continue / open** — a real turn with NO player utterance (ruling 19): no
 *   user row, no admission, the span still advances (time moves), the render omits
 *   the player-turn block. `open` records `simOpening` on the reply meta.
 * - **retake** — re-render the SAME committed cut (regenerate/rerun, ruling 18):
 *   no user row, no admission, NO `prepareEngagementTurn` (time does not advance),
 *   the last assistant row replaced in place (mirroring legacy regenerate: content
 *   + browsable takes + meta on the same id).
 *
 * A withheld render writes no assistant reply (ruling 8). For send, the
 * player line persists BEFORE the scene gate: a refusal explains itself via
 * lastReplyFailure and never deletes what the player typed.
 */
export async function runSimChatExchange(input: {
  chatId: string;
  userId: string;
  speakerCharacterId: string;
  /** The primary character's display name — labels the dialogue tail. */
  speakerName?: string;
  /** Defaults to "send". */
  mode?: SimChatExchangeMode;
  /** The player's line — required for "send", ignored for the utterance-free modes. */
  message?: string;
  /**
   * The composer's Narrator input mode (`meta.inputMode`): a "narrator" send is
   * storyteller steering, not the player-character acting — it skips input
   * admission and reframes the player-turn block (parity with the legacy lane).
   */
  inputMode?: "player" | "narrator";
}): Promise<SimChatExchangeResult> {
  const resolved = await resolveSimExchange(input.userId, input.chatId);
  if (!resolved.ok) return resolved.result; // refused before admission — no trace (#637).
  const mode = input.mode ?? "send";
  // A5 slice 4: a real turn advances the span and writes — turn it away while a durable time job
  // is catching this branch's world up. The in-process reply lock does not outlive the request
  // that started the job, so the durable job state is the guard (shared by the send + sim-turn
  // routes, since both funnel through here). A retake re-renders a committed cut — it changes no
  // world state or time, so it is exempt from this gate (allowed even while the world catches up).
  if (mode !== "retake" && (await hasActiveTimeJob(resolved.ctx.branchId))) {
    return {
      ok: false,
      code: "world_catching_up",
      message: "the world is still catching up on this chat; try again in a moment",
      status: 409,
    };
  }

  // #637: one trace per ADMITTED exchange — every refusal above this line returns before a
  // trace exists. `branchId` is known for every sim-routed exchange regardless of which turn
  // shape runs, so it is annotated immediately; `cutId` and the narrator header fields land
  // later, once each path actually knows them.
  const exchangeTrace = startExchangeTrace({
    chatId: input.chatId,
    operation: simModeToExchangeOperation(mode),
    authority: resolved.ctx.authority,
    lane: "successor",
  });
  exchangeTrace.annotate({ sim: { branchId: resolved.ctx.branchId } });

  if (mode === "retake") {
    return runSimRetake({ chatId: input.chatId, userId: input.userId, ctx: resolved.ctx, exchangeTrace });
  }
  return runSimTurn({
    chatId: input.chatId,
    userId: input.userId,
    speakerCharacterId: input.speakerCharacterId,
    mode,
    message: input.message,
    ...(input.inputMode === undefined ? {} : { inputMode: input.inputMode }),
    ctx: resolved.ctx,
    exchangeTrace,
  });
}
