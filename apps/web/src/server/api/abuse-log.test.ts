import { beforeEach, describe, expect, it, vi } from "vitest";
import { recordAbuseSignal, resetAbuseSignals, type AbuseSignal } from "./abuse-log";

const insertedValues: Record<string, unknown>[] = [];

vi.mock("@/server/db", () => ({
  events: {},
  db: () => ({
    insert: () => ({
      values: (row: Record<string, unknown>) => {
        insertedValues.push(row);
        return { catch: () => undefined };
      },
    }),
  }),
}));

const signal: AbuseSignal = {
  kind: "rate_limited",
  route: "/api/chats/abc",
  method: "POST",
  policy: "chat",
  scope: "user",
  ownerId: "user-a",
  ipHash: "deadbeefdeadbeef",
  limit: 30,
  observed: 30,
};

const T0 = 1_000_000;

describe("recordAbuseSignal", () => {
  beforeEach(() => {
    resetAbuseSignals();
    insertedValues.length = 0;
  });

  it("logs without persisting until abuse is sustained", () => {
    for (let i = 0; i < 19; i++) recordAbuseSignal(signal, T0);
    expect(insertedValues).toHaveLength(0);
  });

  it("persists once the escalation threshold is crossed", () => {
    for (let i = 0; i < 20; i++) recordAbuseSignal(signal, T0);
    expect(insertedValues).toHaveLength(1);
  });

  it("persists at most once per window, so denials cannot amplify into writes", () => {
    for (let i = 0; i < 200; i++) recordAbuseSignal(signal, T0);
    expect(insertedValues).toHaveLength(1);
  });

  it("starts a fresh window after the escalation period lapses", () => {
    for (let i = 0; i < 20; i++) recordAbuseSignal(signal, T0);
    expect(insertedValues).toHaveLength(1);
    // A new 5-minute window: the counter restarts, so it takes another 20.
    for (let i = 0; i < 20; i++) recordAbuseSignal(signal, T0 + 5 * 60_000 + 1);
    expect(insertedValues).toHaveLength(2);
  });

  it("counts each scope separately", () => {
    for (let i = 0; i < 20; i++) recordAbuseSignal({ ...signal, ownerId: "user-a" }, T0);
    for (let i = 0; i < 19; i++) recordAbuseSignal({ ...signal, ownerId: "user-b" }, T0);
    expect(insertedValues).toHaveLength(1);
  });

  describe("what gets stored", () => {
    it("records only allow-listed structural fields — no free-form content", () => {
      for (let i = 0; i < 20; i++) recordAbuseSignal(signal, T0);
      const payload = insertedValues[0]?.payload as Record<string, unknown>;
      // An exact key set, not a subset check: the guarantee is that nothing a
      // prompt could ride in on ever reaches durable storage, so a new field has
      // to be added here deliberately.
      expect(Object.keys(payload).sort()).toEqual([
        "ipHash",
        "kind",
        "limit",
        "method",
        "observed",
        "ownerId",
        "policy",
        "route",
        "schemaVersion",
        "scope",
        "threshold",
        "windowMs",
      ]);
    });

    it("stores the hashed address, never a raw one", () => {
      for (let i = 0; i < 20; i++) recordAbuseSignal(signal, T0);
      const payload = insertedValues[0]?.payload as Record<string, unknown>;
      expect(payload.ipHash).toBe("deadbeefdeadbeef");
      expect(JSON.stringify(payload)).not.toContain("203.0.113");
    });

    it("carries the route path but never a query string or body", () => {
      for (let i = 0; i < 20; i++) recordAbuseSignal(signal, T0);
      const payload = insertedValues[0]?.payload as Record<string, unknown>;
      expect(payload.route).toBe("/api/chats/abc");
      expect(JSON.stringify(payload)).not.toContain("?");
    });
  });
});
