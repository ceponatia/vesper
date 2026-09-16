// Retention for the durable credential backoff. A row exists only while an
// account is being guessed at, and the guard restarts its count once the last
// failure is older than the decay window — so a row past that window decides
// nothing and is pure residue. Expiry comes from the row's own timestamp, as in
// `auth.ts`, so a large backlog is ordinary cleanup (see `pass.ts`).
import { inArray, lt } from "drizzle-orm";
import { credentialFailures, db } from "@/server/db";
// Import the owning leaf, not the `@/server/auth` barrel. The barrel also
// initializes the real Better Auth instance; retention is reached from the image
// barrel and test-support, so going through it closes an async vi.mock/module
// cycle in route and identity-pack suites before their tests can even collect.
import { decayCutoff } from "../auth/credential-guard";
import { RETENTION_BATCH_SIZE, type RetentionPass } from "./pass";

/**
 * Deletes up to {@link RETENTION_BATCH_SIZE} `credential_failures` rows whose
 * last failure predates the decay window.
 *
 * This is cleanup, **not** a bound on the table. The maintenance tick it rides
 * runs every six hours, so one batch is ~167 rows an hour, while a single
 * address admitted by the per-IP credential window can create 600. The guard's
 * address shape-check is what keeps a row from being free to mint, and the
 * per-IP window is what prices them; neither caps the total, and a determined
 * attacker rotating addresses outruns this pass. Sizing that properly is open
 * work — do not read this comment as saying the table is bounded.
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
