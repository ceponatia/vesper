import { inArray } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { authSessionsExpired, verificationsExpired } from "./auth";
import { authSessions, db, verifications } from "@/server/db";
import { endTestPool, probeIntegrationDb, purgeOwnerRows, seedTestUser } from "@/server/test-support";

// Falsified against a pass that deletes unconditionally or not at all: proves
// each pass removes only the rows past `expires_at` and leaves the rest, for
// both Better Auth tables the issue covers (#285).
const ready = await probeIntegrationDb("retention/auth.int.test", "auth_sessions");

const HOUR_MS = 60 * 60 * 1000;

let ownerId = "";
let verificationIds: string[] = [];

afterAll(async () => {
  if (ready) {
    await purgeOwnerRows([ownerId]); // cascades auth_sessions via users.id
    if (verificationIds.length > 0) {
      await db().delete(verifications).where(inArray(verifications.id, verificationIds));
    }
  }
  await endTestPool();
});

describe.skipIf(!ready)("auth retention passes", () => {
  beforeAll(async () => {
    ownerId = (await seedTestUser("retention-auth")).id;
  });

  it("removes expired auth_sessions and verifications while leaving unexpired rows", async () => {
    const now = new Date();
    const expiredAt = new Date(now.getTime() - HOUR_MS);
    const notExpiredAt = new Date(now.getTime() + HOUR_MS);

    const [expiredSession] = await db()
      .insert(authSessions)
      .values({ userId: ownerId, token: `retention-auth-expired-${now.getTime()}`, expiresAt: expiredAt })
      .returning({ id: authSessions.id });
    const [liveSession] = await db()
      .insert(authSessions)
      .values({ userId: ownerId, token: `retention-auth-live-${now.getTime()}`, expiresAt: notExpiredAt })
      .returning({ id: authSessions.id });

    const [expiredVerification] = await db()
      .insert(verifications)
      .values({ identifier: `retention-auth-expired-${now.getTime()}`, value: "v", expiresAt: expiredAt })
      .returning({ id: verifications.id });
    const [liveVerification] = await db()
      .insert(verifications)
      .values({ identifier: `retention-auth-live-${now.getTime()}`, value: "v", expiresAt: notExpiredAt })
      .returning({ id: verifications.id });
    verificationIds = [expiredVerification!.id, liveVerification!.id];

    const sessionsRemoved = await authSessionsExpired.run(now);
    const verificationsRemoved = await verificationsExpired.run(now);

    // Both passes scan their whole table, not just this suite's rows, so the
    // count can exceed 1 if other expired rows already sit in the test
    // database — the row-presence assertions below are what proves the
    // pass acted correctly; the count only needs to confirm it deleted
    // something rather than silently doing nothing.
    expect(sessionsRemoved).toBeGreaterThanOrEqual(1);
    expect(verificationsRemoved).toBeGreaterThanOrEqual(1);

    const remainingSessions = await db()
      .select({ id: authSessions.id })
      .from(authSessions)
      .where(inArray(authSessions.id, [expiredSession!.id, liveSession!.id]));
    expect(remainingSessions.map((row) => row.id)).toEqual([liveSession!.id]);

    const remainingVerifications = await db()
      .select({ id: verifications.id })
      .from(verifications)
      .where(inArray(verifications.id, verificationIds));
    expect(remainingVerifications.map((row) => row.id)).toEqual([liveVerification!.id]);

    verificationIds = [liveVerification!.id];
  });
});
