/**
 * Next.js server startup hook (runs once per server process). Starts the
 * background recovery sweep so a session wedged by a process restart — its
 * in-flight post-turn job orphaned as `running`, its UI blocked from the submit
 * that would otherwise trigger recovery — self-heals instead of staying stuck in
 * "The world is settling…" forever (docs/turn-engine.md §Recovery).
 */
export async function register(): Promise<void> {
  // Node.js runtime only — the recovery sweep touches the database; skip the
  // edge runtime and any non-server build phase.
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  const { startRecoverySweep } = await import("@/server/engine");
  startRecoverySweep();
}
