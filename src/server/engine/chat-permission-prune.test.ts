import { beforeEach, describe, expect, it, vi } from "vitest";
import { deleteChatPermissionEventsForGuard } from "./chat-permission-events";

/**
 * The retake prune's fail-closed retry (spec.permission.md §"Build hardening").
 *
 * This delete is the only thing between a discarded take's grant and the ledger
 * a later exchange reads as authority, and the caller's suppression covers just
 * the replacement exchange — a regenerate reuses the assistant row, so the next
 * ordinary exchange never enters the retake block. Hence: retry a delete that
 * is idempotent anyway, and throw only once every attempt has failed, which is
 * the caller's signal to refuse the retake.
 */

const dbState = vi.hoisted(() => ({
  /** How many deletes have been attempted. */
  attempts: 0,
  /** How many of them should fail before one is allowed to succeed. */
  failures: 0,
}));

vi.mock("../db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../db")>();
  const db = () =>
    ({
      delete: () => ({
        where: () => ({
          returning: () => {
            dbState.attempts += 1;
            if (dbState.attempts <= dbState.failures) return Promise.reject(new Error("connection reset"));
            return Promise.resolve([{ id: "row-1" }]);
          },
        }),
      }),
    }) as unknown as ReturnType<typeof actual.db>;
  return { ...actual, db };
});

beforeEach(() => {
  dbState.attempts = 0;
  dbState.failures = 0;
});

describe("deleteChatPermissionEventsForGuard", () => {
  it("deletes on the first attempt when the database is healthy", async () => {
    const result = await deleteChatPermissionEventsForGuard("chat-1", "msg-1");
    expect(result).toEqual({ deleted: 1 });
    expect(dbState.attempts).toBe(1);
  });

  it("rides out a transient failure rather than stranding the discarded take's grant", async () => {
    dbState.failures = 2;
    const result = await deleteChatPermissionEventsForGuard("chat-1", "msg-1");
    expect(result).toEqual({ deleted: 1 });
    expect(dbState.attempts).toBe(3);
  });

  it("throws once every attempt has failed, so the caller refuses the retake", async () => {
    dbState.failures = Number.MAX_SAFE_INTEGER;
    await expect(deleteChatPermissionEventsForGuard("chat-1", "msg-1")).rejects.toThrow("connection reset");
    // Bounded: a retake must not hang on a database that is simply down.
    expect(dbState.attempts).toBe(3);
  });
});
