import sharp from "sharp";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ReferenceView } from "@/contracts";
import { DiagnosticCollector } from "@/contracts/diagnostics";
import { expectDiagnostic } from "@/test/diagnostics";

/**
 * **A recovery that cannot finish never pretends it did, never leaks the
 * bytes it already fetched, and never leaves its slot claimed** (#682).
 *
 * `reference-view-recovery.ts` promises it never throws: every refusal is a
 * value. These paths prove that promise, and how each end is classified, with
 * every collaborator mocked, because replacing the store and the asset layer
 * with objects still proves the SAME claim — the module's own
 * try/catch/finally wiring and its decisions, not persistence:
 *
 * 1. An unexpected failure after the pending copy is created (a defect in a
 *    collaborator, never a documented refusal) must still answer
 *    `unavailable`, delete that orphan copy and release the slot's claim,
 *    rather than leaving the copy in the `images` table forever, the slot
 *    claimed until its lease lapses, or throwing out of a route handler that
 *    assumes this service never does.
 * 2. A failed withdrawal stamp (the provider confirmed the output is gone for
 *    good, but recording that fact failed) must still answer `expired` — the
 *    offer IS gone, whether or not Vesper managed to write that down — never
 *    `unavailable`, which would invite retrying an output that will never
 *    come back.
 * 3. Bytes sharp cannot decode are the provider's stored output and fail the
 *    same way on every fetch, so they withdraw the offer (`expired`); a disk
 *    or database failure after them is transient and leaves it standing. The
 *    implementation this kills answers `unavailable` forever for garbage
 *    bytes, re-downloading them on every click.
 * 4. A slot another writer holds refuses before anything is fetched.
 * 5. The claim is beaten while the download runs and not after: a claim that
 *    is never beaten lapses mid-download and lets a paid regenerate in.
 *
 * `reference-view-recovery.int.test.ts` owns every claim that needs the real
 * character lock, the real `images` foreign key, real lease readers, or real
 * files on disk.
 */

vi.mock("./reference-view-store", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./reference-view-store")>();
  return {
    ...actual,
    readReferenceViewRecovery: vi.fn(),
    claimReferenceViewRecovery: vi.fn(),
    beatReferenceViewRecoveryClaim: vi.fn(),
    releaseReferenceViewRecoveryClaim: vi.fn(),
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
import { JOB_HEARTBEAT_INTERVAL_MS } from "../db";
import { deleteOwnedImage } from "./asset-deletion";
import { createImageAsset, writeWebpAtomic, type ImageRow } from "./asset-storage";
import { shapeProviderOutput } from "./provider-output-shape";
import {
  recoverReferenceView,
  REFERENCE_VIEW_OUTPUT_EXPIRED,
  REFERENCE_VIEW_OUTPUT_UNAVAILABLE,
} from "./reference-view-recovery";
import {
  beatReferenceViewRecoveryClaim,
  claimReferenceViewRecovery,
  installRecoveredReferenceView,
  readReferenceViewRecovery,
  releaseReferenceViewRecoveryClaim,
  withdrawReferenceViewOutputOffer,
} from "./reference-view-store";

const VIEW: ReferenceView = { angle: "front_full", wardrobe: "clothed" };
const INPUT = { characterId: "char-1", ownerId: "owner-1", view: VIEW, attemptId: "attempt-1" };
const CLAIM = "claim-1";

/** A real, decodable image: the decode rule runs real sharp on the fetched bytes. */
function fetchedImage(): Promise<Buffer> {
  return sharp({ create: { width: 8, height: 12, channels: 3, background: { r: 200, g: 80, b: 80 } } }).png().toBuffer();
}

/** The pre-read admits the recovery and the slot is claimed — every case here is about what happens AFTER that. */
function admitRecovery() {
  const asset = {
    id: "img-failed", status: "failed", meta: {}, prompt: "the compiled view prompt", sourceImageId: null,
  } as unknown as ImageRow;
  const output = { imageId: "img-failed", workflowId: "wf-1", blobId: "blob-1" };
  vi.mocked(readReferenceViewRecovery).mockResolvedValue(
    { ok: true, asset, output } as unknown as Awaited<ReturnType<typeof readReferenceViewRecovery>>,
  );
  vi.mocked(claimReferenceViewRecovery).mockResolvedValue({ ok: true, jobId: CLAIM });
  vi.mocked(releaseReferenceViewRecoveryClaim).mockResolvedValue(undefined);
  vi.mocked(beatReferenceViewRecoveryClaim).mockResolvedValue(true);
  return { asset, output };
}

/** The bytes fetched, shaped and handed a pending copy: everything up to the write. */
async function fetchUpToTheWrite() {
  vi.mocked(recoverCivitaiOutput).mockResolvedValue({ ok: true, image: await fetchedImage() });
  vi.mocked(shapeProviderOutput).mockResolvedValue({
    image: Buffer.from("shaped-bytes"), crop: null, providerSize: null, returned: { width: 10, height: 10 },
  });
  vi.mocked(createImageAsset).mockResolvedValue({ id: "copy-1" } as unknown as ImageRow);
  vi.mocked(deleteOwnedImage).mockResolvedValue(true);
}

beforeEach(() => {
  vi.resetAllMocks();
});
afterEach(() => {
  vi.useRealTimers();
});

describe("recoverReferenceView and an unexpected failure (#682)", () => {
  /**
   * PROTECTS: the module's own promise that it never throws. The bad
   * implementation this kills has no top-level try/catch (or one that forgets
   * to compensate the copy or release the claim), so a transient defect in a
   * collaborator — here, the commit itself — either crashes the caller, leaves
   * an unreviewable copy orphaned in the `images` table, or holds the slot
   * until its lease lapses.
   */
  it("answers unavailable, deletes its own orphan copy and releases its claim when the commit step throws", async () => {
    admitRecovery();
    await fetchUpToTheWrite();
    vi.mocked(writeWebpAtomic).mockResolvedValue({ width: 10, height: 10, bytes: 123 });
    vi.mocked(installRecoveredReferenceView).mockRejectedValue(new Error("unexpected database hiccup"));

    const result = await recoverReferenceView(INPUT);

    expect(result).toEqual({ status: "unavailable" });
    expect(deleteOwnedImage).toHaveBeenCalledWith("copy-1", "owner-1", { kind: "reference_view" });
    expect(releaseReferenceViewRecoveryClaim).toHaveBeenCalledWith(CLAIM, {
      recovered: false, code: REFERENCE_VIEW_OUTPUT_UNAVAILABLE, error: "unexpected database hiccup",
    });
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
    expect(releaseReferenceViewRecoveryClaim).toHaveBeenCalledWith(CLAIM, {
      recovered: false, code: REFERENCE_VIEW_OUTPUT_EXPIRED, error: null,
    });
  });
});

describe("recoverReferenceView and the decode rule (#682)", () => {
  it("withdraws the offer for fetched bytes sharp cannot decode, before any copy exists", async () => {
    admitRecovery();
    vi.mocked(recoverCivitaiOutput).mockResolvedValue({ ok: true, image: Buffer.from("not an image at all") });
    vi.mocked(withdrawReferenceViewOutputOffer).mockResolvedValue(true);
    const sink = new DiagnosticCollector();

    const result = await recoverReferenceView({ ...INPUT, sink });

    expect(result).toEqual({ status: "expired" });
    expect(withdrawReferenceViewOutputOffer).toHaveBeenCalledWith("img-failed", "owner-1");
    expectDiagnostic(sink, REFERENCE_VIEW_OUTPUT_EXPIRED);
    expect(shapeProviderOutput).not.toHaveBeenCalled();
    expect(createImageAsset).not.toHaveBeenCalled();
    expect(releaseReferenceViewRecoveryClaim).toHaveBeenCalledWith(CLAIM, expect.objectContaining({ code: REFERENCE_VIEW_OUTPUT_EXPIRED }));
  });

  it("keeps the offer when decodable bytes cannot be written — the disk is not the output", async () => {
    admitRecovery();
    await fetchUpToTheWrite();
    vi.mocked(writeWebpAtomic).mockRejectedValue(Object.assign(new Error("ENOSPC: no space left on device"), { code: "ENOSPC" }));
    const sink = new DiagnosticCollector();

    const result = await recoverReferenceView({ ...INPUT, sink });

    expect(result).toEqual({ status: "unavailable" });
    expect(withdrawReferenceViewOutputOffer).not.toHaveBeenCalled();
    expectDiagnostic(sink, REFERENCE_VIEW_OUTPUT_UNAVAILABLE);
    expect(sink.items.find((item) => item.code === REFERENCE_VIEW_OUTPUT_UNAVAILABLE)?.context).toMatchObject({ stage: "error" });
    expect(deleteOwnedImage).toHaveBeenCalledWith("copy-1", "owner-1", { kind: "reference_view" });
    expect(installRecoveredReferenceView).not.toHaveBeenCalled();
  });
});

describe("recoverReferenceView and its claim on the slot (#682)", () => {
  it("fetches nothing when another writer holds the slot", async () => {
    admitRecovery();
    vi.mocked(claimReferenceViewRecovery).mockResolvedValue({ ok: false, refusal: "busy" });

    expect(await recoverReferenceView(INPUT)).toEqual({ status: "busy" });
    expect(recoverCivitaiOutput).not.toHaveBeenCalled();
    expect(releaseReferenceViewRecoveryClaim).not.toHaveBeenCalled();
  });

  it("beats its claim while the download runs, and stops when the run ends", async () => {
    vi.useFakeTimers();
    admitRecovery();
    let finish: (answer: Awaited<ReturnType<typeof recoverCivitaiOutput>>) => void = () => undefined;
    vi.mocked(recoverCivitaiOutput).mockImplementation(() => new Promise((resolve) => {
      finish = resolve;
    }));
    const sink = new DiagnosticCollector();

    const pending = recoverReferenceView({ ...INPUT, sink });
    await vi.advanceTimersByTimeAsync(2 * JOB_HEARTBEAT_INTERVAL_MS);

    expect(recoverCivitaiOutput).toHaveBeenCalledTimes(1);
    expect(beatReferenceViewRecoveryClaim).toHaveBeenCalledTimes(2);
    expect(beatReferenceViewRecoveryClaim).toHaveBeenCalledWith(CLAIM);

    finish({ ok: false, permanent: false, error: "Civitai answered 503" });
    expect(await pending).toEqual({ status: "unavailable" });
    expectDiagnostic(sink, REFERENCE_VIEW_OUTPUT_UNAVAILABLE);
    expect(releaseReferenceViewRecoveryClaim).toHaveBeenCalledWith(CLAIM, {
      recovered: false, code: REFERENCE_VIEW_OUTPUT_UNAVAILABLE, error: null,
    });

    await vi.advanceTimersByTimeAsync(2 * JOB_HEARTBEAT_INTERVAL_MS);
    expect(beatReferenceViewRecoveryClaim).toHaveBeenCalledTimes(2);
  });
});
