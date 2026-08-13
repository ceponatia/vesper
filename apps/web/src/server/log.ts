import type { Diagnostic } from "@/contracts/diagnostics";

type Level = "debug" | "info" | "warn" | "error";

const LEVELS: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };

function threshold(): number {
  const configured = (process.env.LOG_LEVEL ?? "info") as Level;
  return LEVELS[configured] ?? LEVELS.info;
}

function emit(level: Level, scope: string, message: string, data?: Record<string, unknown>) {
  if (LEVELS[level] < threshold()) return;
  const line = `[${new Date().toISOString()}] ${level.toUpperCase()} ${scope}: ${message}`;
  const payload = data ? ` ${JSON.stringify(data)}` : "";
   
  console[level === "debug" ? "log" : level](line + payload);
}

export const log = {
  debug: (scope: string, message: string, data?: Record<string, unknown>) => emit("debug", scope, message, data),
  info: (scope: string, message: string, data?: Record<string, unknown>) => emit("info", scope, message, data),
  warn: (scope: string, message: string, data?: Record<string, unknown>) => emit("warn", scope, message, data),
  error: (scope: string, message: string, data?: Record<string, unknown>) => emit("error", scope, message, data),
};

/**
 * Replay collected diagnostics into the process log at their own severities —
 * the tail of the collector pattern for lanes with no route sink to answer to
 * (a detached job, a fire-and-forget render). A diagnostic that only ever lived
 * on an optional sink nobody supplied is a failure with no record; this is
 * where such lanes give it one.
 */
export function logDiagnostics(scope: string, items: readonly Diagnostic[], extra?: Record<string, unknown>): void {
  for (const diagnostic of items) {
    const data = {
      code: diagnostic.code,
      ...extra,
      ...(diagnostic.context ? { context: diagnostic.context } : {}),
    };
    switch (diagnostic.severity) {
      case "error":
        log.error(scope, diagnostic.message, data);
        break;
      case "warn":
        log.warn(scope, diagnostic.message, data);
        break;
      case "info":
        log.info(scope, diagnostic.message, data);
        break;
    }
  }
}
