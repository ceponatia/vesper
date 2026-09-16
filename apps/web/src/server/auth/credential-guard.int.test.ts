import { eq } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import {
  chargeCredentialAttempt,
  clearCredentialFailures,
  credentialSubject,
  readCredentialFailures,
  BASE_BACKOFF_MS,
  DECAY_MS,
  FREE_ATTEMPTS,
  MAX_BACKOFF_MS,
} from "./credential-guard";
import { credentialFailures, db } from "@/server/db";
import { endTestPool, probeIntegrationDb } from "@/server/test-support";

/**
 * The durable half of the per-account backoff — issue #612.
 *
 * `credential-guard.test.ts` owns the schedule as arithmetic. What can only be
 * shown against a real database is here: that the record survives independently
 * of any process, that concurrent guesses cannot all slip under one threshold,
 * and that a right password clears what the wrong ones accumulated.
 *
 * Self-skips when the database is unreachable, except under strict mode
 * (`pnpm test:int:strict`).
 */

const ready = await probeIntegrationDb("credential-guard.int.test", "credential_failures");

const SUBJECT = credentialSubject("credential-guard@vesper.test");
const OTHER = credentialSubject("credential-guard-other@vesper.test");

async function purge(): Promise<void> {
  for (const subject of [SUBJECT, OTHER]) {
    await db().delete(credentialFailures).where(eq(credentialFailures.subject, subject));
  }
}

afterAll(async () => {
  if (ready) await purge();
  await endTestPool();
});

describe.skipIf(!ready)("durable credential backoff", () => {
  beforeEach(async () => {
    await purge();
  });

  it("admits the free allowance, then starts charging", async () => {
    const now = Date.now();
    for (let i = 0; i < FREE_ATTEMPTS; i += 1) {
      const decision = await chargeCredentialAttempt(SUBJECT, now);
      expect(decision.allowed).toBe(true);
    }
    // The next failure is the first that owes a wait — and the attempt after it
    // is refused for as long as the schedule says.
    expect((await chargeCredentialAttempt(SUBJECT, now)).allowed).toBe(true);
    const refused = await chargeCredentialAttempt(SUBJECT, now);
    expect(refused.allowed).toBe(false);
    expect(refused.reason).toBe("backoff");
    expect(refused.retryAfterSeconds).toBe(BASE_BACKOFF_MS / 1000);
  });

  it("keeps the count in the database, not in the process", async () => {
    const now = Date.now();
    for (let i = 0; i < 3; i += 1) await chargeCredentialAttempt(SUBJECT, now);
    // Nothing in memory is consulted to answer this — the row is the state, which
    // is the whole reason this layer exists alongside the in-process window.
    expect(await readCredentialFailures(SUBJECT)).toMatchObject({ failures: 3 });
  });

  it("admits again once the wait has actually elapsed", async () => {
    const now = Date.now();
    for (let i = 0; i <= FREE_ATTEMPTS; i += 1) await chargeCredentialAttempt(SUBJECT, now);
    expect((await chargeCredentialAttempt(SUBJECT, now)).allowed).toBe(false);
    expect((await chargeCredentialAttempt(SUBJECT, now + BASE_BACKOFF_MS)).allowed).toBe(true);
  });

  it("does not let a refused attempt extend its own wait", async () => {
    // A blocked caller hammering the endpoint must not push their own reset out;
    // otherwise an impatient owner locks themselves out further, and an attacker
    // gets a cheap way to hold an account at the ceiling.
    const now = Date.now();
    for (let i = 0; i <= FREE_ATTEMPTS; i += 1) await chargeCredentialAttempt(SUBJECT, now);
    const before = await readCredentialFailures(SUBJECT);
    for (let i = 0; i < 5; i += 1) await chargeCredentialAttempt(SUBJECT, now);
    expect(await readCredentialFailures(SUBJECT)).toStrictEqual(before);
  });

  it("clears on a correct password", async () => {
    const now = Date.now();
    for (let i = 0; i < 4; i += 1) await chargeCredentialAttempt(SUBJECT, now);
    await clearCredentialFailures(SUBJECT);
    expect(await readCredentialFailures(SUBJECT)).toBeNull();
    // And the owner's next slip starts from scratch rather than resuming the run.
    expect((await chargeCredentialAttempt(SUBJECT, now)).allowed).toBe(true);
    expect(await readCredentialFailures(SUBJECT)).toMatchObject({ failures: 1 });
  });

  it("counts every concurrent guess, so a burst cannot outrun the threshold", async () => {
    // The reason the charge is a compare-and-swap. Fired together, these must
    // land as distinct increments; a read-then-write would let them all see the
    // same "under the threshold" and all proceed.
    const now = Date.now();
    const burst = await Promise.all(
      Array.from({ length: FREE_ATTEMPTS + 4 }, () => chargeCredentialAttempt(SUBJECT, now)),
    );
    const admitted = burst.filter((decision) => decision.allowed).length;
    expect(admitted).toBeLessThanOrEqual(FREE_ATTEMPTS + 1);
    expect(await readCredentialFailures(SUBJECT)).toMatchObject({ failures: admitted });
    expect((await chargeCredentialAttempt(SUBJECT, now)).allowed).toBe(false);
  });

  it("isolates accounts", async () => {
    const now = Date.now();
    for (let i = 0; i <= FREE_ATTEMPTS + 1; i += 1) await chargeCredentialAttempt(SUBJECT, now);
    expect((await chargeCredentialAttempt(SUBJECT, now)).allowed).toBe(false);
    expect((await chargeCredentialAttempt(OTHER, now)).allowed).toBe(true);
  });

  it("restarts the count for an account left alone past the decay window", async () => {
    const now = Date.now();
    for (let i = 0; i <= FREE_ATTEMPTS + 2; i += 1) await chargeCredentialAttempt(SUBJECT, now);
    const later = now + DECAY_MS + MAX_BACKOFF_MS;
    expect((await chargeCredentialAttempt(SUBJECT, later)).allowed).toBe(true);
    expect(await readCredentialFailures(SUBJECT)).toMatchObject({ failures: 1 });
  });
});
