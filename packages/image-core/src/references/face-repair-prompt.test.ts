import { describe, expect, it } from "vitest";
import { faceRepairInstruction } from "./face-repair-prompt";

/**
 * Kills: a face-repair instruction that names a slot the payload does not
 * actually send, or that drops the "keep everything else unchanged" clause
 * the repair's whole safety case rests on.
 *
 * Moved from `apps/web/src/server/images/face-repair.test.ts` (issue #246
 * correction round 2) when the instruction itself moved to this package —
 * `face-repair.test.ts` keeps only the request-assembly assertions that this
 * instruction lands in the run request.
 */
describe("faceRepairInstruction", () => {
  it("names a single identity reference as Image 2", () => {
    expect(faceRepairInstruction(1)).toBe(
      "Repair the face in Image 1 to match the person shown in Image 2; keep the pose, clothing, background, lighting and composition of Image 1 unchanged.",
    );
  });

  it("names two identity references as Images 2 through 3", () => {
    expect(faceRepairInstruction(2)).toBe(
      "Repair the face in Image 1 to match the person shown in Images 2 through 3; keep the pose, clothing, background, lighting and composition of Image 1 unchanged.",
    );
  });
});
