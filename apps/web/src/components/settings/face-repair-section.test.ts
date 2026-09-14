import { describe, expect, it } from "vitest";
import { anyFaceRepairRunLive } from "./face-repair-section";

/**
 * Kills: a status-string typo (or a forgotten status) that silently stops the
 * Face repair section's run list from polling, leaving a run's status chip,
 * thumbnail and comparison stuck at `pending`/`running` until a full page
 * reload (issue #246 round-2 correction).
 *
 * `FaceRepairSection` itself has no render harness — this is the one pure
 * decision inside it, pulled out so it can be pinned without one.
 */
describe("anyFaceRepairRunLive", () => {
  it("is true while any run is pending", () => {
    expect(anyFaceRepairRunLive([{ status: "pending" }, { status: "succeeded" }])).toBe(true);
  });

  it("is true while any run is running", () => {
    expect(anyFaceRepairRunLive([{ status: "running" }])).toBe(true);
  });

  it("is false once every run has settled", () => {
    expect(anyFaceRepairRunLive([{ status: "succeeded" }, { status: "failed" }])).toBe(false);
  });

  it("is false for an empty list", () => {
    expect(anyFaceRepairRunLive([])).toBe(false);
  });
});
