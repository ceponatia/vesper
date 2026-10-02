import { describe, expect, it } from "vitest";
import {
  referenceViewFailedTileHint,
  referenceViewRecoverableHint,
  referenceViewRecoveryLapsedHint,
  referenceViewStateCopy,
} from "./reference-view-copy";

/**
 * **A failed tile never tells the owner a lapsed offer is still live, and
 * never buries a live one under a frozen message** (#682).
 *
 * The server's stored `failureMessage` is written once, while the offer is
 * still open, and never rewrites itself as the offer's state moves on — so a
 * tile that showed that message verbatim would still read "can be recovered…
 * without rendering again" long after retention collected the bytes or a
 * recovery attempt itself answered `expired`. The defect each case here kills
 * is reading that stale text instead of the live `recoverable` flag: priority
 * runs live offer, then the lapsed-offer rewrite (keyed off the same failure
 * code the stored message carries), then the raw message, then the generic
 * state hint — and only a `failed` tile ever reaches the first three.
 */
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
