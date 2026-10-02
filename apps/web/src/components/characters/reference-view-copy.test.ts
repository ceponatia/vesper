import { describe, expect, it } from "vitest";
import {
  referenceViewFailedTileHint,
  referenceViewRecoverableHint,
  referenceViewRecoveryLapsedHint,
  referenceViewStateCopy,
} from "./reference-view-copy";

describe("referenceViewFailedTileHint", () => {
  it("shows the recoverable hint while the offer is live, regardless of the stored message", () => {
    expect(
      referenceViewFailedTileHint({
        state: "failed",
        recoverable: true,
        failureMessage: "civitai_output_undelivered: the render could not be downloaded",
      }),
    ).toBe(referenceViewRecoverableHint);
  });

  it("shows the lapsed hint once the offer has ended but the stored message still names the code", () => {
    expect(
      referenceViewFailedTileHint({
        state: "failed",
        recoverable: false,
        failureMessage: "civitai_output_undelivered: the render could not be downloaded",
      }),
    ).toBe(referenceViewRecoveryLapsedHint);
  });

  it("shows the server's own failure message for an ordinary, non-recoverable failure", () => {
    expect(
      referenceViewFailedTileHint({
        state: "failed",
        recoverable: false,
        failureMessage: "The model host returned an error.",
      }),
    ).toBe("The model host returned an error.");
  });

  it("falls back to the state hint when a failed attempt has no stored message", () => {
    expect(
      referenceViewFailedTileHint({ state: "failed", recoverable: false, failureMessage: null }),
    ).toBe(referenceViewStateCopy.failed.hint);
  });

  it("ignores recoverable and failureMessage for every other state", () => {
    for (const state of ["rejected", "stale", "ineligible"] as const) {
      expect(
        referenceViewFailedTileHint({ state, recoverable: true, failureMessage: "civitai_output_undelivered" }),
      ).toBe(referenceViewStateCopy[state].hint);
    }
  });
});
