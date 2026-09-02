// Retention passes for Better Auth's own rows. Expiry here comes from a
// `expires_at` timestamp the row carries itself, so a large backlog is
// ordinary cleanup — see `pass.ts` for why the image sweep's mass-expiry
// refusal does not apply.
import { inArray, lt } from "drizzle-orm";
import { authSessions, db, verifications } from "@/server/db";
import { RETENTION_BATCH_SIZE, type RetentionPass } from "./pass";

/** Deletes up to {@link RETENTION_BATCH_SIZE} `auth_sessions` rows past `expires_at`. */
export const authSessionsExpired: RetentionPass = {
  name: "authSessionsExpired",
  async run(now: Date): Promise<number> {
    const expired = db()
      .select({ id: authSessions.id })
      .from(authSessions)
      .where(lt(authSessions.expiresAt, now))
      .limit(RETENTION_BATCH_SIZE);
    const removed = await db()
      .delete(authSessions)
      .where(inArray(authSessions.id, expired))
      .returning({ id: authSessions.id });
    return removed.length;
  },
};

/** Deletes up to {@link RETENTION_BATCH_SIZE} `verifications` rows past `expires_at`. */
export const verificationsExpired: RetentionPass = {
  name: "verificationsExpired",
  async run(now: Date): Promise<number> {
    const expired = db()
      .select({ id: verifications.id })
      .from(verifications)
      .where(lt(verifications.expiresAt, now))
      .limit(RETENTION_BATCH_SIZE);
    const removed = await db()
      .delete(verifications)
      .where(inArray(verifications.id, expired))
      .returning({ id: verifications.id });
    return removed.length;
  },
};
