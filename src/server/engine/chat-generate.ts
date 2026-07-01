import { diag, type DiagnosticSink } from "@/contracts";
import type { GenerateCheckedResult } from "../ai";

/**
 * Race a `generateChecked` call against a hard timeout for the chat post-turn fan-out
 * (the reaction pulse ‖ the archivist-lite — character-chat-primary.spec.md §2).
 * `generateChecked` never throws (it owns the resilience ladder); on timeout we abort the
 * call — its orphaned tail then adds no diagnostics — and report a degraded miss so the
 * caller falls back (drift-only state / summary-window memory). Shared so both legs degrade
 * identically; each passes its own timeout code (`clearTimeout` in `finally` avoids a leak).
 */
export async function withGenerateTimeout<T>(
  work: Promise<GenerateCheckedResult<T>>,
  controller: AbortController,
  timeoutMs: number,
  timeoutCode: string,
  sink?: DiagnosticSink,
): Promise<{ value: T | null; degraded: boolean }> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<{ value: T | null; degraded: boolean }>((resolve) => {
    timer = setTimeout(() => {
      controller.abort();
      sink?.push(diag("warn", timeoutCode, `chat fan-out leg exceeded ${timeoutMs}ms; degrading`));
      resolve({ value: null, degraded: true });
    }, timeoutMs);
  });
  const settled = work
    .then((r) => ({ value: r.value, degraded: r.degraded }))
    .catch(() => ({ value: null as T | null, degraded: true }));
  try {
    return await Promise.race([settled, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
