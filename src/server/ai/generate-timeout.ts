import { diag, type DiagnosticSink } from "@/contracts";
import type { GenerateCheckedResult } from "./generate-checked";

/**
 * Race a `generateChecked` call against a hard timeout — for any best-effort agent
 * call that must not stall its caller (the chat post-turn fan-out legs, the
 * pre-narrator intake). `generateChecked` never throws (it owns the resilience
 * ladder); on timeout we abort the call — its orphaned tail then adds no
 * diagnostics — and report a degraded miss so the caller falls back to its own
 * degraded path. Each caller passes its own timeout diagnostic code
 * (`clearTimeout` in `finally` avoids a leak).
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
      sink?.push(diag("warn", timeoutCode, `generation exceeded ${timeoutMs}ms; degrading to the fallback`));
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
