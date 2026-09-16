import { describe, expect, it } from "vitest";
import {
  backoffMs,
  credentialSubject,
  decayCutoff,
  nextFailureState,
  BASE_BACKOFF_MS,
  DECAY_MS,
  FAILURE_CAP,
  FREE_ATTEMPTS,
  MAX_BACKOFF_MS,
} from "./credential-guard";
import { credentialSubjectSource } from "./credential-hooks";

/**
 * The backoff schedule and the account key — issue #612.
 *
 * The per-IP window this sits behind is defeated by an attacker who spreads
 * guesses across addresses, and being in memory it is also cleared by any
 * restart. What bounds guessing against ONE account is the schedule below, so
 * these assertions are the policy itself: how fast an attacker may guess, how
 * long an owner is made to wait, and that no spelling of an address buys a
 * second allowance.
 *
 * The database half — atomicity, charge-before-check, clear-on-success — is in
 * `credential-guard.int.test.ts`, which needs a real Postgres.
 */

describe("backoff schedule", () => {
  it("costs a person nothing for an ordinary run of typos", () => {
    for (let failures = 1; failures <= FREE_ATTEMPTS; failures += 1) {
      expect(backoffMs(failures)).toBe(0);
    }
  });

  it("doubles each failure past the free allowance", () => {
    expect(backoffMs(FREE_ATTEMPTS + 1)).toBe(BASE_BACKOFF_MS);
    expect(backoffMs(FREE_ATTEMPTS + 2)).toBe(BASE_BACKOFF_MS * 2);
    expect(backoffMs(FREE_ATTEMPTS + 3)).toBe(BASE_BACKOFF_MS * 4);
    expect(backoffMs(FREE_ATTEMPTS + 4)).toBe(BASE_BACKOFF_MS * 8);
  });

  it("stops growing at the ceiling, however long an attack runs", () => {
    // Bounds the length of ONE wait, which is not the same as bounding how long
    // an account can be held closed: an admitted attempt re-arms the wait before
    // the password is checked, so at the ceiling there is one slot per window and
    // whoever asks first takes it. That is what `grantCredentialBypass` answers;
    // this assertion only pins that the wait itself cannot be driven upward.
    for (const failures of [12, 20, FAILURE_CAP, 1000]) {
      expect(backoffMs(failures)).toBe(MAX_BACKOFF_MS);
    }
    expect(backoffMs(Number.MAX_SAFE_INTEGER)).toBe(MAX_BACKOFF_MS);
  });

  it("bounds a sustained attack to roughly sixty guesses an hour", () => {
    // The number that decides whether this defense is worth having. Offline-scale
    // guessing against a known address ends here — while staying short enough
    // that an owner being hammered can realistically take a slot themselves,
    // which a five-minute ceiling did not.
    const perHour = 3_600_000 / backoffMs(FAILURE_CAP);
    expect(perHour).toBeLessThanOrEqual(60);
    expect(MAX_BACKOFF_MS).toBeLessThanOrEqual(60_000);
  });
});

describe("nextFailureState", () => {
  const now = 1_700_000_000_000;

  it("starts a first-ever failure at one, owing nothing", () => {
    expect(nextFailureState(null, now)).toStrictEqual({ failures: 1, retryAt: now });
  });

  it("accumulates consecutive failures and owes the schedule's delay", () => {
    const prior = { failures: FREE_ATTEMPTS, lastFailureAt: now - 1_000 };
    expect(nextFailureState(prior, now)).toStrictEqual({
      failures: FREE_ATTEMPTS + 1,
      retryAt: now + BASE_BACKOFF_MS,
    });
  });

  it("restarts the count once the account has been left alone", () => {
    // Yesterday's typos must not still be charged. The window is far longer than
    // the ceiling's own pace, so reaching it means guessing slower than the
    // backoff already forces — it is no evasion.
    const stale = { failures: 11, lastFailureAt: now - DECAY_MS };
    expect(nextFailureState(stale, now)).toStrictEqual({ failures: 1, retryAt: now });

    const justInside = { failures: 11, lastFailureAt: now - DECAY_MS + 1 };
    expect(nextFailureState(justInside, now).failures).toBe(12);
  });

  it("caps the stored count rather than letting it run away", () => {
    const pinned = { failures: FAILURE_CAP, lastFailureAt: now - 1 };
    const next = nextFailureState(pinned, now);
    expect(next.failures).toBe(FAILURE_CAP);
    expect(next.retryAt).toBe(now + MAX_BACKOFF_MS);
  });

  it("puts the decay cutoff one window behind now", () => {
    expect(decayCutoff(new Date(now)).getTime()).toBe(now - DECAY_MS);
  });
});

describe("credentialSubject", () => {
  it("gives one account one bucket however the address is spelled", () => {
    // Better Auth lowercases before looking a user up, so a key that did not
    // would hand an attacker a fresh allowance per spelling of the same account.
    const canonical = credentialSubject("player@vesper.test");
    expect(credentialSubject("PLAYER@VESPER.TEST")).toBe(canonical);
    expect(credentialSubject("  Player@Vesper.Test  ")).toBe(canonical);
  });

  it("separates different accounts", () => {
    expect(credentialSubject("a@vesper.test")).not.toBe(credentialSubject("b@vesper.test"));
  });

  it("stores a digest rather than the address", () => {
    // Rows are written for whatever a caller submits, existing account or not.
    // Keeping the address out of them keeps the table from becoming a log of
    // attempted emails and a place to park attacker-chosen text.
    const subject = credentialSubject("player@vesper.test");
    expect(subject).not.toContain("player");
    expect(subject).not.toContain("@");
    expect(subject).toMatch(/^[0-9a-f]{32}$/);
  });
});

describe("guarded paths", () => {
  it("covers every endpoint that verifies a password", () => {
    expect(credentialSubjectSource("/sign-in/email")).toBe("body");
    // Session-bound, and the sharper of the two: `verify-password` does nothing
    // but answer whether a password is right.
    expect(credentialSubjectSource("/verify-password")).toBe("session");
    expect(credentialSubjectSource("/change-password")).toBe("session");
  });

  it("leaves session and token traffic alone", () => {
    // `get-session` is refetched on every window focus. A database write here
    // would turn a security counter into a per-page-view write, and the hook
    // runs on every auth endpoint — this test is the filter.
    for (const path of ["/get-session", "/sign-out", "/callback/google", "/list-sessions"]) {
      expect(credentialSubjectSource(path)).toBeNull();
    }
    // Token paths consume a random, not a guess; charging them would let anyone
    // holding a stale link delay the account's real sign-in.
    for (const path of ["/reset-password", "/magic-link/verify", "/verify-email"]) {
      expect(credentialSubjectSource(path)).toBeNull();
    }
  });
});
