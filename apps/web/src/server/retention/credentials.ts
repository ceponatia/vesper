// Retention for the durable credential backoff. A row exists only while an
// account is being guessed at, and the guard restarts its count once the last
// failure is older than the decay window — so a row past that window decides
// nothing and is pure residue. Expiry comes from the row's own timestamp, as in
// `auth.ts`, so a large backlog is ordinary cleanup (see `pass.ts`).
import { inArray, lt } from "drizzle-orm";
import { credentialFailures, db } from "@/server/db";
import { decayCutoff } from "@/server/auth";
import { RETENTION_BATCH_SIZE, type RetentionPass } from "./pass";

/**
 * Deletes up to {@link RETENTION_BATCH_SIZE} `credential_failures` rows whose
 * last failure predates the decay window.
 *
 * This is also the bound on the table. The guard writes a row for whatever
 * address a caller submits, existing or not, so a flood of invented addresses
 * would otherwise accumulate; the per-IP credential window caps how fast rows
 * can be created, and this pass removes them once they stop meaning anything.
 */
export const credentialFailuresDecayed: RetentionPass = {
  name: "credentialFailuresDecayed",
  async run(now: Date): Promise<number> {
    const spent = db()
      .select({ id: credentialFailures.id })
      .from(credentialFailures)
      .where(lt(credentialFailures.lastFailureAt, decayCutoff(now)))
      .limit(RETENTION_BATCH_SIZE);
    const removed = await db()
      .delete(credentialFailures)
      .where(inArray(credentialFailures.id, spent))
      .returning({ id: credentialFailures.id });
    return removed.length;
  },
};
