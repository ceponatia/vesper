import { diag, type DiagnosticSink } from "@/contracts";
import type { AgentRunDescription } from "@/contracts/turns/agent-failure";
import { recordAgentFailure, recordAgentRun, type AgentTelemetry } from "./agent-failures";
import { generateChecked, type GenerateCheckedOptions, type GenerateCheckedResult } from "./generate-checked";

/**
 * What the race resolves to: the caller's value plus whatever spend the wrapped
 * call measured. The timeout and error paths carry none — nothing completed, and
 * an aborted tail's cost is not a figure this wrapper can honestly report.
 */
type GenerateTimeoutResult<T> = Pick<GenerateCheckedResult<T>, "value" | "degraded" | "usage" | "costUsd">;

/**
 * Race a `generateChecked` call against a hard timeout — for any best-effort agent
 * call that must not stall its caller (the chat post-turn fan-out legs, the
 * pre-narrator intake). `generateChecked` never throws (it owns the resilience
 * ladder); on timeout we abort the call — its orphaned tail then adds no
 * diagnostics — and report a degraded miss so the caller falls back to its own
 * degraded path. Each caller passes its own timeout diagnostic code
 * (`clearTimeout` in `finally` avoids a leak).
 *
 * A trip is also RECORDED (`./agent-failures.ts`), with a suspected cause, so a leg that
 * quietly times out on every exchange shows up in the inspector's tally instead of only in
 * `fly logs`. The abort is what makes this the right place for it: the aborted
 * `generateChecked` returns silently by design, so nothing downstream would ever hear about
 * the miss. Pass `telemetry` to make the record diagnosable (prompt size + model + which
 * conversation); without it the timeout is still counted, just with less to say about why.
 *
 * A clean SUCCESS (the work resolves before the timeout, un-degraded) is recorded too
 * (`recordAgentRun`) — the activity + latency half of the inspector. `describe` turns the
 * leg's value into a one-line summary AND the detail sections behind it (the click-to-open
 * "db viewer"); the measured `latencyMs`/`provider` come straight off the resolved
 * `GenerateCheckedResult`. A `done` flag guards the race so a call that resolves right as the
 * timeout fires records exactly one of the two, never both.
 */
export async function withGenerateTimeout<T>(
  work: Promise<GenerateCheckedResult<T>>,
  controller: AbortController,
  timeoutMs: number,
  timeoutCode: string,
  sink?: DiagnosticSink,
  telemetry?: Partial<AgentTelemetry>,
  describe?: (value: T) => AgentRunDescription,
): Promise<GenerateTimeoutResult<T>> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  // Whichever of {work resolves, timeout fires} wins the race claims the record; the loser
  // sees `done` already set and stays silent — so a success and a timeout never both fire.
  let done = false;
  const timeout = new Promise<GenerateTimeoutResult<T>>((resolve) => {
    timer = setTimeout(() => {
      if (done) return;
      done = true;
      controller.abort();
      sink?.push(diag("warn", timeoutCode, `generation exceeded ${timeoutMs}ms; degrading to the fallback`));
      recordAgentFailure({
        // `timeoutCode` is `${legId}.timeout` by convention at every call site.
        legId: telemetry?.legId ?? timeoutCode.replace(/\.timeout$/, ""),
        chatId: telemetry?.chatId,
        messageId: telemetry?.messageId,
        kind: "timeout",
        timeoutMs,
        modelId: telemetry?.modelId,
        promptChars: telemetry?.promptChars,
        maxOutputTokens: telemetry?.maxOutputTokens,
        reasoningProfile: telemetry?.reasoningProfile,
        reasoningEnabled: telemetry?.reasoningEnabled,
        detail: `no response within ${timeoutMs}ms`,
      });
      resolve({ value: null, degraded: true });
    }, timeoutMs);
  });
  const settled = work
    .then((r): GenerateTimeoutResult<T> => {
      if (!done) {
        done = true;
        // A clean, un-degraded value → record the successful run (an internally-degraded
        // result already recorded its own api_error/parse_failed in generateChecked).
        if (!r.degraded && r.value != null && telemetry?.legId) {
          const described = describe?.(r.value);
          recordAgentRun({
            legId: telemetry.legId,
            chatId: telemetry.chatId,
            messageId: telemetry.messageId,
            modelId: telemetry.modelId,
            promptChars: telemetry.promptChars,
            maxOutputTokens: telemetry.maxOutputTokens,
            reasoningProfile: telemetry.reasoningProfile,
            reasoningEnabled: telemetry.reasoningEnabled,
            provider: r.provider,
            latencyMs: r.latencyMs,
            summary: described?.summary ?? "",
            details: described?.details ?? [],
          });
        }
      }
      return {
        value: r.value,
        degraded: r.degraded,
        ...(r.usage === undefined ? {} : { usage: r.usage }),
        ...(r.costUsd === undefined ? {} : { costUsd: r.costUsd }),
      };
    })
    .catch((): GenerateTimeoutResult<T> => ({ value: null, degraded: true }));
  try {
    return await Promise.race([settled, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * `generateCheckedBounded`'s result: `withGenerateTimeout`'s race outcome, plus
 * whichever completed call's provider/latency were observed. Undefined on a
 * timeout or a caller abort — nothing completed, so there is nothing honest to
 * report (the same rule `GenerateTimeoutResult` already applies to usage/cost).
 */
export type GenerateCheckedBoundedResult<T> = GenerateTimeoutResult<T> & Pick<GenerateCheckedResult<T>, "provider" | "latencyMs">;

/** The deadline half of a `generateCheckedBounded` call — everything `generateChecked` itself already owns (schema, prompt, fallback, sink, telemetry, signal) travels in `opts`. */
export interface GenerateCheckedBound<T> {
  /** Hard wall-clock budget for the call, its repair round-trip included. */
  timeoutMs: number;
  /** Diagnostic code for the timeout warning + recorded failure — conventionally `${code}.timeout`. */
  timeoutCode: string;
  /** Turns a clean, un-degraded value into the Inspector's one-line summary + detail sections (see `withGenerateTimeout`). */
  describe?: (value: T) => AgentRunDescription;
}

/**
 * Compose `generateChecked` with `withGenerateTimeout` in one call — the shape
 * every non-streaming structured leg needs (docs/resilience.md §3): a bounded
 * `AbortController` drives both the deadline and, when the caller supplies one,
 * its own `opts.signal`. An already-aborted caller signal aborts the controller
 * immediately; a later abort calls `controller.abort()` as soon as it fires; the
 * listener is always removed in `finally` so a long-lived caller signal never
 * accumulates one. `controller.signal` — never the caller's own — is what
 * actually reaches `generateChecked`.
 *
 * The race itself, its timeout diagnostic, the recorded `timeout` failure and
 * the success-run record all stay exactly where they live today, in
 * `withGenerateTimeout` — this function adds no telemetry of its own. The one
 * thing it adds on top: a timeout or a caller abort resolves with
 * `{ value: null, degraded: true }` — the caller's OWN fallback rule
 * (`opts.fallback`, the same one `generateChecked`'s degrade path applies) is
 * not otherwise reachable from that branch, since the controller's abort
 * orphans the in-flight `generateChecked` call, which then returns silently by
 * design (its `abandoned()` contract — see generate-checked.ts). This function
 * fills that gap so every caller keeps its documented degraded result whether
 * the miss was a parse failure, a timeout, or a caller abort.
 */
export async function generateCheckedBounded<T>(
  opts: GenerateCheckedOptions<T>,
  bound: GenerateCheckedBound<T>,
): Promise<GenerateCheckedBoundedResult<T>> {
  const controller = new AbortController();
  const callerSignal = opts.signal;
  const onCallerAbort = () => controller.abort();
  if (callerSignal?.aborted) {
    controller.abort();
  } else {
    callerSignal?.addEventListener("abort", onCallerAbort, { once: true });
  }
  // Observed off the SAME promise `withGenerateTimeout` races — a second
  // subscriber, not a second call — so a completed call's provider/latency
  // survive the race even though `GenerateTimeoutResult` itself drops them.
  let observed: Pick<GenerateCheckedResult<T>, "provider" | "latencyMs"> = {};
  try {
    const work = generateChecked({ ...opts, signal: controller.signal });
    void work.then((r) => {
      observed = { provider: r.provider, latencyMs: r.latencyMs };
    });
    const result = await withGenerateTimeout(work, controller, bound.timeoutMs, bound.timeoutCode, opts.sink, opts.telemetry, bound.describe);
    const value = result.degraded && result.value == null ? (opts.fallback ? opts.fallback() : null) : result.value;
    return { ...result, value, ...observed };
  } finally {
    callerSignal?.removeEventListener("abort", onCallerAbort);
  }
}
