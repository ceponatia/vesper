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
