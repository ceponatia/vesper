import type { ChatReplyFailureCause, ChatReplyFailureCode } from "@/contracts";
import {
  classifyEmptyNarratorCompletion,
  classifyProviderError,
  narratorCompletionLogFields,
  type NarratorCompletion,
} from "../ai";
import { log } from "../log";
import { saveReplyFailure } from "./chat-reply-store";
import { CHAT_STREAM_FIRST_TOKEN_MS, CHAT_STREAM_OVERALL_MS } from "./constants";

const describeError = (error: unknown): string => (error instanceof Error ? error.message : String(error));

// ---------------------------------------------------------------------------
// Stop — abort the in-flight reply, keep what streamed
// ---------------------------------------------------------------------------

/** In-flight reply aborts by chat id — in-process, like the exchange lock itself. */
const inflightReplyAborts = new Map<string, AbortController>();

/**
 * Cut the in-flight reply short: the model stream aborts server-side, the
 * accumulated prefix persists as the reply (`meta.stopped`), and the fan-out
 * runs over the truncated text. Returns false when nothing is streaming.
 */
export function stopChatReply(chatId: string): boolean {
  const controller = inflightReplyAborts.get(chatId);
  if (!controller) return false;
  controller.abort();
  return true;
}

export interface StreamTimeoutOptions {
  /** No first token within this many ms ⇒ abort (a wedged provider that never speaks). */
  firstTokenMs: number;
  /** The whole stream running past this many ms ⇒ abort (a provider that trickles forever). */
  overallMs: number;
  /** Abort the upstream call (wired to the exchange's AbortController). */
  onAbort: () => void;
  /** Record the watchdog trip (a log/diagnostic); the reply still settles via the stop path. */
  onTimeout?: (reason: "first_token" | "overall") => void;
}

/**
 * Guard a reply token stream with two watchdogs (data-loss-rerun fix): a first-token
 * timeout and an overall cap. On a trip it calls `onAbort` (aborting the upstream call)
 * and ends the stream — the caller's settle path then persists any partial with
 * `meta.stopped` and releases the chat lock, so a hung provider can never wedge the
 * conversation (the Aion 3.0 incident). Passes every token through untouched otherwise;
 * a source that finishes or throws on its own flows through unchanged.
 *
 * PURE + testable: no engine state, just the source generator and the timeout knobs. The
 * lost `next()` after a trip is fire-and-forget-swallowed, and the source is closed
 * fire-and-forget in `finally` — never awaited, so a source that stays wedged even after
 * the abort can't re-hang us here (which would defeat the whole watchdog).
 */
export async function* withStreamTimeouts(
  source: AsyncGenerator<string>,
  opts: StreamTimeoutOptions,
): AsyncGenerator<string> {
  const iterator = source[Symbol.asyncIterator]();
  const overallDeadline = Date.now() + opts.overallMs;
  let sawFirstToken = false;
  try {
    for (;;) {
      const overallBudget = overallDeadline - Date.now();
      const budget = sawFirstToken ? overallBudget : Math.min(opts.firstTokenMs, overallBudget);
      const next = iterator.next();
      let timer: ReturnType<typeof setTimeout> | undefined;
      const timeout = new Promise<"timeout">((resolve) => {
        timer = setTimeout(() => resolve("timeout"), Math.max(0, budget));
      });
      let result: IteratorResult<string> | "timeout";
      try {
        result = await Promise.race([next, timeout]);
      } finally {
        if (timer) clearTimeout(timer);
      }
      if (result === "timeout") {
        opts.onTimeout?.(sawFirstToken ? "overall" : "first_token");
        opts.onAbort();
        // The lost next() settles once the abort lands upstream — swallow it so it can't
        // surface as an unhandled rejection now that we've stopped reading.
        void next.then(
          () => {},
          () => {},
        );
        return;
      }
      if (result.done) return;
      sawFirstToken = true;
      yield result.value;
    }
  } finally {
    // Fire-and-forget close of the source — never blocking on it (a still-wedged provider
    // must not re-hang the watchdog); the abort above already unwinds it.
    void Promise.resolve(iterator.return?.(undefined)).catch(() => {});
  }
}

/**
 * Wrap the model stream so persistence + fan-out + lock release ride the
 * generator's own completion: the route (or any consumer) just drains it. A
 * model-stream failure keeps whatever accumulated (persisted if non-empty); a
 * player Stop is not a failure — the truncated prefix persists with
 * `meta.stopped`. An empty reply skips settle but records WHY it was empty
 * (`last_reply_failure` — the client's post-exchange refetch reads it for the
 * failure popup); the lock releases on every path.
 */
export function streamExchange(
  source: AsyncGenerator<string>,
  options: {
    chatId: string;
    settle: (full: string, stopped: boolean) => Promise<void>;
    abortController: AbortController;
    completion: () => NarratorCompletion | null;
    modelId: string;
    release: () => void;
  },
): AsyncGenerator<string, void, unknown> {
  const { chatId, settle, abortController, completion, modelId, release } = options;
  // Register synchronously, before returning the generator to its consumer, so
  // Stop and rerun find this same controller even before the first next().
  inflightReplyAborts.set(chatId, abortController);
  let timedOut: "first_token" | "overall" | null = null;
  const gen = withStreamTimeouts(source, {
    firstTokenMs: CHAT_STREAM_FIRST_TOKEN_MS,
    overallMs: CHAT_STREAM_OVERALL_MS,
    onAbort: () => abortController.abort(),
    onTimeout: (reason) => {
      timedOut = reason;
      log.warn("engine.chat", "chat reply stream timed out", { chatId, reason });
    },
  });
  return drain();

  async function* drain(): AsyncGenerator<string, void, unknown> {
    let full = "";
    let stopped = false;
    let streamError: { code: ChatReplyFailureCode; detail: string } | null = null;
    try {
      try {
        for await (const delta of gen) {
          full += delta;
          yield delta;
        }
      } catch (error) {
        if (abortController.signal.aborted) {
          stopped = true;
        } else {
          const classified = classifyProviderError(error);
          streamError = { code: classified.code, detail: classified.detail };
          log.warn("engine.chat", "reply stream failed", {
            chatId,
            code: classified.code,
            status: classified.status,
            error: classified.detail,
          });
        }
      }
      if (abortController.signal.aborted) stopped = true;
      if (full.trim()) {
        try {
          await settle(full, stopped);
        } catch (error) {
          log.error("engine.chat", "failed to persist assistant reply", { error: describeError(error) });
        }
      }
      // A zero-visible-text exchange logs the generation's own numbers — the
      // structured half of the truthful story, and the only place the raw-versus-
      // visible split is recorded. Counts and finish state only.
      const narrator = completion();
      if (!full.trim() && narrator) {
        log.warn("engine.chat", "narrator produced no visible text", {
          chatId,
          ...narratorCompletionLogFields(narrator),
        });
      }
      // Record (or clear) the exchange's reply-failure verdict BEFORE the generator
      // returns — the route's drain, and so the client's refetch, wait on this.
      await saveReplyFailure(
        chatId,
        resolveReplyFailure({
          hasText: Boolean(full.trim()),
          stopped,
          streamError,
          timedOut,
          completion: narrator,
        }),
        narrator?.modelId ?? modelId,
      );
    } finally {
      inflightReplyAborts.delete(chatId);
      release();
    }
  }
}

/**
 * Resolve what a settled exchange records as its reply failure (PURE). Only an
 * exchange that produced NO text records one — a partial that persisted is a
 * visible reply. A watchdog trip aborts the same controller as a player Stop, so
 * the timeout reason outranks the stop flag; a genuine player Stop is not a
 * failure. Null ⇒ clear any prior record.
 *
 * A zero-text exchange that neither threw, timed out, nor was stopped used to
 * record a bare `empty_reply` with no detail — which asserted "the model said
 * nothing" on the strength of having no evidence either way. When the stream
 * reports how the generation actually finished, that record is built from the
 * evidence instead (`classifyEmptyNarratorCompletion`): a content filter and a
 * generation error route to the classes that already describe them, and a genuine
 * empty is told apart from a burned output budget and from Vesper's own
 * normalizers erasing the reply. With no completion record — a provider that
 * reported nothing, or a lane that supplies none — it stays the honest bare
 * `empty_reply`.
 */
export function resolveReplyFailure(input: {
  hasText: boolean;
  stopped: boolean;
  streamError: { code: ChatReplyFailureCode; detail: string } | null;
  timedOut: "first_token" | "overall" | null;
  completion?: NarratorCompletion | null;
}): { code: ChatReplyFailureCode; detail: string; cause?: ChatReplyFailureCause } | null {
  if (input.hasText) return null;
  if (input.streamError) return input.streamError;
  if (input.timedOut) {
    return {
      code: "timeout",
      detail:
        input.timedOut === "first_token"
          ? `no output within ${Math.round(CHAT_STREAM_FIRST_TOKEN_MS / 1000)}s`
          : `the reply ran past ${Math.round(CHAT_STREAM_OVERALL_MS / 1000)}s and was cut off`,
    };
  }
  if (input.stopped) return null;
  if (input.completion) return classifyEmptyNarratorCompletion(input.completion);
  return { code: "empty_reply", detail: "" };
}

