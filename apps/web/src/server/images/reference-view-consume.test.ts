import { beforeEach, describe, expect, it, vi } from "vitest";
import { DiagnosticCollector } from "@/contracts/diagnostics";
import { allReferenceViews, type ReferenceViewSetSummary, type ReferenceViewState } from "@/contracts";
import { expectCleanSink, expectDiagnostic } from "@/test/diagnostics";

/**
 * **The gate between the reference sheet and a render.**
 *
 * The whole review step exists because a rendered back nobody looked at is a
 * guess, and a guess anchoring every later scene is worse than no anchor. This
 * suite protects the two halves of that promise at the one seam that can break
 * them:
 *
 * 1. **Only an approved slot yields bytes.** Every other projected state — and a
 *    slot whose asset will not read — refuses, and refuses with the reason an
 *    operator acts on. The defect it kills is a consumer that reads `imageId`
 *    off the summary and sends it, which is how an unreviewed or stale view
 *    reaches a scene; that implementation passes a happy-path test and fails
 *    every row below.
 * 2. **A refusal is a value with a diagnostic**, never a throw and never a
 *    failed render (docs/resilience.md §2). A missing view may not become a
 *    missing image.
 *
 * The consumability RULE itself is not re-proven here — it is pure, and
 * `contracts/images/reference-views.test.ts` owns its full matrix. This suite
 * only proves that this module reads that verdict rather than recomputing it.
 */

vi.mock("./reference-view-store", () => ({ withLockedReferenceViewSet: vi.fn() }));

import { withLockedReferenceViewSet } from "./reference-view-store";
import { loadConsumableReferenceView, REFERENCE_VIEW_UNAVAILABLE } from "./reference-view-consume";

const VIEW = { angle: "back_full", wardrobe: "clothed" } as const;
const PORTRAIT = "img-portrait";
const VIEW_ASSET = "img-back-clothed";
const readReadyBytes = vi.fn<(imageId: string) => Promise<Buffer | null>>();

/** The sheet as the store projects it, with this one slot forced into a state. */
function sheet(state: ReferenceViewState, imageId: string | null = VIEW_ASSET): ReferenceViewSetSummary {
  return {
    acceptedImageId: PORTRAIT,
    building: false,
    views: allReferenceViews().map((view) => {
      const target = view.angle === VIEW.angle && view.wardrobe === VIEW.wardrobe;
      return {
        angle: view.angle,
        wardrobe: view.wardrobe,
        state: target ? state : ("missing" as const),
        imageId: target ? imageId : null,
        method: target ? "rendered" : null,
        reviewedAt: null,
        failureCode: null,
        failureMessage: null,
        updatedAt: null,
        // The store's own verdict, which this module must READ rather than
        // re-derive from the state beside it.
        consumable: target && state === "approved",
      };
    }),
  };
}

beforeEach(() => {
  vi.resetAllMocks();
  readReadyBytes.mockResolvedValue(Buffer.from("view-bytes"));
});

function project(set: ReferenceViewSetSummary) {
  vi.mocked(withLockedReferenceViewSet).mockImplementation(
    (async (_characterId, _ownerId, _sink, operation) =>
      operation({ set, readReadyBytes })) as typeof withLockedReferenceViewSet,
  );
}

describe("loadConsumableReferenceView", () => {
  it("hands over an approved view's bytes, its asset id and the portrait behind it", async () => {
    project(sheet("approved"));
    const sink = new DiagnosticCollector();

    const loaded = await loadConsumableReferenceView({
      ownerId: "user1",
      characterId: "chr1",
      view: VIEW,
      sink,
    });

    expect(loaded).toEqual({
      ok: true,
      imageId: VIEW_ASSET,
      buffer: Buffer.from("view-bytes"),
      // The accepted portrait IS the view's source — that equality is the
      // consumability rule, so provenance reads it rather than a second column.
      sourceImageId: PORTRAIT,
      faceVisibility: "hidden",
    });
    expectCleanSink(sink);
  });

  const refusals: ReadonlyArray<[ReferenceViewState, string]> = [
    ["missing", "none_built"],
    ["pending", "pending"],
    ["unreviewed", "unreviewed"],
    ["rejected", "rejected"],
    ["failed", "failed"],
    ["stale", "stale"],
    ["ineligible", "ineligible"],
  ];

  it.each(refusals)("a %s slot is never sent (%s)", async (state, reason) => {
    project(sheet(state));
    const sink = new DiagnosticCollector();

    const loaded = await loadConsumableReferenceView({ ownerId: "user1", characterId: "chr1", view: VIEW, sink });

    expect(loaded).toEqual({ ok: false, reason });
    // The bytes are never even read: a slot that may not be sent is not an
    // asset this render is allowed to open.
    expect(readReadyBytes).not.toHaveBeenCalled();
    expectDiagnostic(sink, REFERENCE_VIEW_UNAVAILABLE);
  });

  it("degrades when an approved view's bytes will not read", async () => {
    project(sheet("approved"));
    readReadyBytes.mockResolvedValue(null);
    const sink = new DiagnosticCollector();

    const loaded = await loadConsumableReferenceView({ ownerId: "user1", characterId: "chr1", view: VIEW, sink });

    expect(loaded).toEqual({ ok: false, reason: "missing_bytes" });
    expectDiagnostic(sink, REFERENCE_VIEW_UNAVAILABLE);
  });
});
