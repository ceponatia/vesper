import { sql } from "drizzle-orm";
import { db } from "@/server/db";

/**
 * The shared connectivity probe every `.int.test.ts` suite runs at collection
 * (security-authz.plan.md slice 5 follow-up). It replaces the per-suite copies
 * of the same race-a-timeout block, and adds the mode the copies lacked:
 *
 *   default          a failed probe returns `false` and the suite self-skips
 *                    with a stderr note — the right shape for ordinary dev,
 *                    where Postgres is often simply not up.
 *   strict           a failed probe THROWS, so the file fails collection and
 *                    the run is red. This is the release/CI form: a broken or
 *                    unmigrated database must never silently skip the whole
 *                    authorization matrix and still report a green gate.
 *
 * Strict mode is on when `REQUIRE_INTEGRATION_DB=true` — what `pnpm
 * test:int:strict` sets. The two pre-existing signals (`CI=true` and
 * `VESPER_REQUIRE_TEST_DB=1`, which command-authz already honored on its own)
 * keep working so converting a suite never loosens it.
 */

/** The canonical strict-mode flag; `pnpm test:int:strict` sets it. */
const STRICT_ENV = "REQUIRE_INTEGRATION_DB";

/** A probe that hangs is a failure too — never let a suite block on a dead host. */
const PROBE_TIMEOUT_MS = 4_000;

/** True when an unreachable database must fail the run rather than skip it. */
export function requireIntegrationDb(): boolean {
  return (
    process.env[STRICT_ENV] === "true" ||
    process.env.VESPER_REQUIRE_TEST_DB === "1" ||
    process.env.CI === "true"
  );
}

/**
 * Probe the integration database for `suite`, reading one row from `table` so
 * an unmigrated database fails the same way an unreachable one does (the point
 * of the per-suite table: a suite proves ITS tables exist, not just that a
 * connection opened). Returns `true` when the suite may run, `false` when it
 * should skip — and throws instead of returning `false` in strict mode.
 */
export async function probeIntegrationDb(suite: string, table = "characters"): Promise<boolean> {
  let timer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      db().execute(sql.raw(`select 1 from ${table} limit 1`)),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error("connect timeout")), PROBE_TIMEOUT_MS);
      }),
    ]);
    return true;
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    if (requireIntegrationDb()) {
      throw new Error(
        `[${suite}] integration database unreachable or unmigrated (probe: select 1 from ${table} limit 1): ${reason}. ` +
          `Strict integration mode is ON (${STRICT_ENV}=true — the release gate, \`pnpm test:int:strict\`), so this suite fails ` +
          `instead of skipping. Start the database (\`pnpm db:up\`), apply migrations (\`pnpm db:migrate\`), or run plain ` +
          `\`pnpm test:int\` if skipping is acceptable.`,
      );
    }
    process.stderr.write(`[${suite}] skipping — database unreachable or unmigrated: ${reason}\n`);
    return false;
  } finally {
    clearTimeout(timer);
  }
}
