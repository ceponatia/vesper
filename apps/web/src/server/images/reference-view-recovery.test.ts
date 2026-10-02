import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ReferenceView } from "@/contracts";
import { DiagnosticCollector } from "@/contracts/diagnostics";
import { expectDiagnostic } from "@/test/diagnostics";

/**
 * **A recovery that cannot finish never pretends it did, and never leaks the
 * bytes it already fetched** (#682).
 *
 * `reference-view-recovery.ts` promises it never throws: every refusal is a
 * value. Two paths prove that promise with every collaborator mocked, because
 * replacing the store and the asset layer with objects still proves the SAME
 * claim — the module's own try/catch/finally wiring, not persistence:
 *
 * 1. An unexpected failure after the pending copy is created (a defect in a
 *    collaborator, never a documented refusal) must still answer
 *    `unavailable` and delete that orphan copy, rather than leaving it in the
 *    `images` table forever or throwing out of a route handler that assumes
 *    this service never does.
 * 2. A failed withdrawal stamp (the provider confirmed the output is gone for
 *    good, but recording that fact failed) must still answer `expired` — the
 *    offer IS gone, whether or not Vesper managed to write that down — never
 *    `unavailable`, which would invite retrying an output that will never
 *    come back.
 *
 * `reference-view-recovery.int.test.ts` owns every claim that needs the real
 * character lock, the real `images` foreign key, or real files on disk.
 */

vi.mock("./reference-view-store", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./reference-view-store")>();
  return {
    ...actual,
    readReferenceViewRecovery: vi.fn(),
    installRecoveredReferenceView: vi.fn(),
    withdrawReferenceViewOutputOffer: vi.fn(),
  };
});
vi.mock("./asset-storage", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./asset-storage")>();
  return { ...actual, createImageAsset: vi.fn(), writeWebpAtomic: vi.fn() };
});
vi.mock("./asset-deletion", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./asset-deletion")>();
  return { ...actual, deleteOwnedImage: vi.fn() };
});
vi.mock("./provider-output-shape", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./provider-output-shape")>();
  return { ...actual, shapeProviderOutput: vi.fn() };
});
vi.mock("../ai", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../ai")>();
  return { ...actual, recoverCivitaiOutput: vi.fn() };
});
// The real implementation resolves real symlinks under DATA_ROOT — there is
// nothing for this orchestration-only suite to prove by touching a real path.
vi.mock("./paths", () => ({ absoluteImagePath: vi.fn(() => "/data/fake-owner/fake-copy.webp") }));
vi.mock("@/server/log", () => ({
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  logDiagnostics: vi.fn(),
}));

import { recoverCivitaiOutput } from "../ai";
import { deleteOwnedImage } from "./asset-deletion";
import { createImageAsset, writeWebpAtomic, type ImageRow } from "./asset-storage";
import { shapeProviderOutput } from "./provider-output-shape";
import { recoverReferenceView, REFERENCE_VIEW_OUTPUT_EXPIRED } from "./reference-view-recovery";
import { installRecoveredReferenceView, readReferenceViewRecovery, withdrawReferenceViewOutputOffer } from "./reference-view-store";

const VIEW: ReferenceView = { angle: "front_full", wardrobe: "clothed" };
const INPUT = { characterId: "char-1", ownerId: "owner-1", view: VIEW, attemptId: "attempt-1" };

/** The pre-read admits the recovery — every case here is about what happens AFTER that. */
function admitRecovery() {
  const asset = {
    id: "img-failed", status: "failed", meta: {}, prompt: "the compiled view prompt", sourceImageId: null,
  } as unknown as ImageRow;
  const output = { imageId: "img-failed", workflowId: "wf-1", blobId: "blob-1" };
  vi.mocked(readReferenceViewRecovery).mockResolvedValue(
    { ok: true, asset, output } as unknown as Awaited<ReturnType<typeof readReferenceViewRecovery>>,
  );
  return { asset, output };
}

beforeEach(() => {
  vi.resetAllMocks();
});

describe("recoverReferenceView and an unexpected failure (#682)", () => {
  /**
   * PROTECTS: the module's own promise that it never throws. The bad
   * implementation this kills has no top-level try/catch (or one that forgets
   * to compensate the copy), so a transient defect in a collaborator — here,
   * the commit itself — either crashes the caller or leaves an unreviewable,
   * un-billed-for copy orphaned in the `images` table forever.
   */
  it("answers unavailable and deletes its own orphan copy when the commit step throws", async () => {
    admitRecovery();
    vi.mocked(recoverCivitaiOutput).mockResolvedValue({ ok: true, image: Buffer.from("fetched-bytes") });
    vi.mocked(shapeProviderOutput).mockResolvedValue({
      image: Buffer.from("shaped-bytes"), crop: null, providerSize: null, returned: { width: 10, height: 10 },
    });
    vi.mocked(createImageAsset).mockResolvedValue({ id: "copy-1" } as unknown as ImageRow);
    vi.mocked(writeWebpAtomic).mockResolvedValue({ width: 10, height: 10, bytes: 123 });
    vi.mocked(installRecoveredReferenceView).mockRejectedValue(new Error("unexpected database hiccup"));
    vi.mocked(deleteOwnedImage).mockResolvedValue(true);

    const result = await recoverReferenceView(INPUT);

    expect(result).toEqual({ status: "unavailable" });
    expect(deleteOwnedImage).toHaveBeenCalledWith("copy-1", "owner-1", { kind: "reference_view" });
  });
});

describe("recoverReferenceView and a failed withdrawal stamp (#682)", () => {
  /**
   * PROTECTS: a stamp write failing must not change the ANSWER. The bad
   * implementation this kills reports `unavailable` whenever the stamp write
   * fails — conflating "Vesper could not record the withdrawal" with "the
   * output might still be there" — which invites the owner to keep retrying
   * an output the provider has already said is never coming back.
   */
  it("still answers expired, with the diagnostic recording that the stamp did not take", async () => {
    admitRecovery();
    vi.mocked(recoverCivitaiOutput).mockResolvedValue({ ok: false, permanent: true, error: "the blob is gone for good" });
    vi.mocked(withdrawReferenceViewOutputOffer).mockRejectedValue(new Error("the update timed out"));
    const sink = new DiagnosticCollector();

    const result = await recoverReferenceView({ ...INPUT, sink });

    expect(result).toEqual({ status: "expired" });
    expectDiagnostic(sink, REFERENCE_VIEW_OUTPUT_EXPIRED);
    const diagnostic = sink.items.find((item) => item.code === REFERENCE_VIEW_OUTPUT_EXPIRED);
    expect(diagnostic?.context).toMatchObject({ withdrawn: false });
    // Nothing was ever fetched into a new copy: the failure was decided
    // before any bytes were shaped or written.
    expect(createImageAsset).not.toHaveBeenCalled();
  });
});
