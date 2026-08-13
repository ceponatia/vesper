import { beforeEach, describe, expect, it, vi } from "vitest";
import type { NextRequest } from "next/server";
import { HIDDEN_IMAGE_KINDS } from "@/server/images";

vi.mock("./quota", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./quota")>();
  return { ...actual, checkStorageQuota: vi.fn(), consumeDailyBudget: vi.fn() };
});
vi.mock("./backpressure", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./backpressure")>();
  return { ...actual, laneHealth: vi.fn(), queueSaturated: vi.fn() };
});
vi.mock("./abuse-log", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./abuse-log")>();
  return { ...actual, recordAbuseSignal: vi.fn() };
});

import { laneHealth, queueSaturated } from "./backpressure";
import { ESTIMATED_RENDER_BYTES, imageRenderRejection } from "./limits";
import { checkStorageQuota, consumeDailyBudget, type BudgetDecision, type StorageQuotaDecision } from "./quota";

const mockStorage = vi.mocked(checkStorageQuota);
const mockBudget = vi.mocked(consumeDailyBudget);

const user = { id: "user1" };
const req = { method: "POST", nextUrl: { pathname: "/api/test" }, headers: new Headers() } as unknown as NextRequest;

const allowedBudget: BudgetDecision = {
  allowed: true,
  kind: "provider_image_day",
  limit: 200,
  used: 1,
  remaining: 199,
  resetAt: 0,
  retryAfterSeconds: 0,
};

/** An account sitting exactly at its visible quota — the codex-flagged state. */
const atQuota: StorageQuotaDecision = { allowed: false, limit: 100, used: 100, remaining: 0 };

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(laneHealth).mockReturnValue("healthy");
  vi.mocked(queueSaturated).mockResolvedValue(false);
  mockStorage.mockResolvedValue(atQuota);
  mockBudget.mockResolvedValue(allowedBudget);
});

describe("imageRenderRejection storage leg (hidden-kind exemption)", () => {
  it("reserves storage by default, so an at-quota account is refused visible-output work", async () => {
    const response = await imageRenderRejection(user, req);
    expect(mockStorage).toHaveBeenCalledWith("user1", ESTIMATED_RENDER_BYTES);
    expect(response?.status).toBe(429);
    expect(mockBudget).not.toHaveBeenCalled(); // budget is charged last, after storage passes
  });

  it("still reserves storage for a visible outputKind — the exemption is kind-aware, not a blanket skip", async () => {
    const response = await imageRenderRejection(user, req, { outputKind: "scene" });
    expect(mockStorage).toHaveBeenCalledWith("user1", ESTIMATED_RENDER_BYTES);
    expect(response?.status).toBe(429);
  });

  it.each(HIDDEN_IMAGE_KINDS)(
    "admits hidden-kind %s work on an at-quota account — its bytes never count toward the quota",
    async (kind) => {
      expect(await imageRenderRejection(user, req, { outputKind: kind })).toBeNull();
      expect(mockStorage).not.toHaveBeenCalled();
      // The spend legs still apply: hidden work is quota-exempt, not free.
      expect(mockBudget).toHaveBeenCalledWith("user1", "provider_image_day", 1);
    },
  );

  it("an edge-only hidden batch (count 0, allowZeroCount) passes every accounting leg untouched", async () => {
    expect(
      await imageRenderRejection(user, req, { count: 0, allowZeroCount: true, outputKind: "lab_control" }),
    ).toBeNull();
    expect(mockStorage).not.toHaveBeenCalled();
    expect(mockBudget).not.toHaveBeenCalled();
  });

  it("a hidden-kind batch still charges the daily budget at its full count", async () => {
    expect(await imageRenderRejection(user, req, { count: 6, outputKind: "identity_trial_output" })).toBeNull();
    expect(mockBudget).toHaveBeenCalledWith("user1", "provider_image_day", 6);
  });
});
