import { diag, type DiagnosticSink } from "@/contracts";
import { recordAgentFailure, recordAgentRun, type AgentTelemetry } from "./agent-failures";
import type { GenerateCheckedResult } from "./generate-checked";

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
 * (`recordAgentRun`) — the activity + latency half of the inspector. `summarize` turns the
 * leg's value into a one-line "what it did" note; the measured `latencyMs`/`provider` come
 * straight off the resolved `GenerateCheckedResult`. A `done` flag guards the race so a call
 * that resolves right as the timeout fires records exactly one of the two, never both.
 */
export async function withGenerateTimeout<T>(
  work: Promise<GenerateCheckedResult<T>>,
  controller: AbortController,
  timeoutMs: number,
  timeoutCode: string,
  sink?: DiagnosticSink,
  telemetry?: Partial<AgentTelemetry>,
  summarize?: (value: T) => string,
): Promise<{ value: T | null; degraded: boolean }> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  // Whichever of {work resolves, timeout fires} wins the race claims the record; the loser
  // sees `done` already set and stays silent — so a success and a timeout never both fire.
  let done = false;
  const timeout = new Promise<{ value: T | null; degraded: boolean }>((resolve) => {
    timer = setTimeout(() => {
      if (done) return;
      done = true;
      controller.abort();
      sink?.push(diag("warn", timeoutCode, `generation exceeded ${timeoutMs}ms; degrading to the fallback`));
      recordAgentFailure({
        // `timeoutCode` is `${legId}.timeout` by convention at every call site.
        legId: telemetry?.legId ?? timeoutCode.replace(/\.timeout$/, ""),
        chatId: telemetry?.chatId,
        sessionId: telemetry?.sessionId,
        messageId: telemetry?.messageId,
        kind: "timeout",
        timeoutMs,
        modelId: telemetry?.modelId,
        promptChars: telemetry?.promptChars,
        maxOutputTokens: telemetry?.maxOutputTokens,
        detail: `no response within ${timeoutMs}ms`,
      });
      resolve({ value: null, degraded: true });
    }, timeoutMs);
  });
  const settled = work
    .then((r) => {
      if (!done) {
        done = true;
        // A clean, un-degraded value → record the successful run (an internally-degraded
        // result already recorded its own api_error/parse_failed in generateChecked).
        if (!r.degraded && r.value != null && telemetry?.legId) {
          recordAgentRun({
            legId: telemetry.legId,
            chatId: telemetry.chatId,
            sessionId: telemetry.sessionId,
            messageId: telemetry.messageId,
            modelId: telemetry.modelId,
            promptChars: telemetry.promptChars,
            maxOutputTokens: telemetry.maxOutputTokens,
            provider: r.provider,
            latencyMs: r.latencyMs,
            summary: summarize ? summarize(r.value) : "",
          });
        }
      }
      return { value: r.value, degraded: r.degraded };
    })
    .catch(() => ({ value: null as T | null, degraded: true }));
  try {
    return await Promise.race([settled, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
