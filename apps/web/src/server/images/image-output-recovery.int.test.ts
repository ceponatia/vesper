import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { CIVITAI_QWEN_IMAGE_21_SLUG } from "@vesper/image-models";
import { emptyCharacterProfile } from "@/contracts";
import { DiagnosticCollector } from "@/contracts/diagnostics";
import { expectDiagnostic } from "@/test/diagnostics";

/**
 * **A failed portrait, avatar or scene whose render was paid for is recovered
 * onto its own row, never paid for twice, and never loses its offer to a
 * recovery that did not finish** (#686).
 *
 * Each case kills one way that promise would break under the real row
 * transitions, the real sweep reclaim and real files on disk:
 *
 * - a recovery that submits a new workflow, or that a second request runs in
 *   parallel (two downloads, two installs);
 * - a failed recovery that loses the offer (a transient failure that leaves
 *   the row pending or moves retention's clock), or keeps offering an output
 *   the provider has shown is gone;
 * - a recovery whose process dies leaving a row nobody can recover again;
 * - a recovered avatar that moves the character's portrait pointer (owner
 *   ruling 2026-10-02: it lands as a ready candidate);
 * - a reference view recovered here, outside its sheet's own rules.
 *
 * The transport's read-only fetch of a paid output is the one collaborator
 * replaced: it is the provider's network call, and these claims are about the
 * rows and the bytes on disk. Everything else is real.
 */
vi.mock("../ai", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../ai")>();
  return { ...actual, recoverCivitaiOutput: vi.fn() };
});

import { recoverCivitaiOutput } from "../ai";
import { characters, db, images, JOB_STALE_MS } from "../db";
import {
  endTestPool,
  probeIntegrationDb,
  purgeOwnerRows,
  seedTestUser,
  testPngBuffer,
  withTempDataRoot,
  type TempDataRoot,
} from "@/server/test-support";
import { listOwnedPortraits } from "../../app/api/characters/[id]/portraits/owned";
import { createImageAsset, failImage, imageMeta, readImageBytes, RENDER_LEASE_META_KEY, saveImageBuffer, type ImageKind } from "./asset-storage";
import { deleteOwnedImage } from "./asset-deletion";
import { reclaimStalePendingRows } from "./asset-maintenance";
import {
  IMAGE_OUTPUT_EXPIRED,
  IMAGE_OUTPUT_RECOVERED,
  IMAGE_OUTPUT_UNAVAILABLE,
  imageOutputRecoverable,
  RECOVERY_CLAIM_META_KEY,
  recoverImageOutput,
} from "./image-output-recovery";
import { PAID_OUTPUT_UNAVAILABLE_KEY, paidOutputOffer } from "./paid-output";

// These claims depend on guarded row transitions, the sweep's own reclaim and
// the file the one webp writer leaves on disk.
const ready = await probeIntegrationDb("image-output-recovery.int.test", "images");
const mockRecover = vi.mocked(recoverCivitaiOutput);

const WORKFLOW_ID = "civitai-workflow-in-place";
const BLOB_ID = "civitai-blob-in-place";
const UNDELIVERED = "Civitai output download failed (civitai_output_undelivered; retry=reconcile)";
const RENDER = { modelSlug: CIVITAI_QWEN_IMAGE_21_SLUG, predictionId: WORKFLOW_ID, undeliveredOutputId: BLOB_ID };

let ownerId = "";
let temp: TempDataRoot | undefined;

beforeAll(async () => {
  if (!ready) return;
  temp = await withTempDataRoot("vesper-image-output-recovery-int");
  ownerId = (await seedTestUser("image-output-recovery")).id;
});
afterAll(async () => {
  if (ready) await purgeOwnerRows([ownerId]);
  await temp?.cleanup();
  await endTestPool();
});
beforeEach(() => {
  mockRecover.mockReset();
  // No network at all: the only provider call a recovery makes is the mocked
  // read-only fetch above, so any real request here would be a submit.
  vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("no network in this suite"));
});
afterEach(() => {
  expect(vi.mocked(globalThis.fetch)).not.toHaveBeenCalled();
  vi.mocked(globalThis.fetch).mockRestore();
});

async function character(): Promise<string> {
  const [row] = await db()
    .insert(characters)
    .values({ ownerId, name: "In-place recovery fixture", profile: emptyCharacterProfile() })
    .returning({ id: characters.id });
  if (!row) throw new Error("the fixture character did not insert");
  return row.id;
}

/**
 * A render of `kind` that was billed and then failed undelivered, as its lane
 * leaves it: a failed row recording the workflow and the output under
 * `meta.render`, with the failure stamp retention reads.
 */
async function failedPaidRender(kind: ImageKind, characterId: string, meta: Record<string, unknown> = {}) {
  const reserved = await createImageAsset({
    ownerId,
    kind,
    entityKind: "character",
    entityId: characterId,
    prompt: `the ${kind} prompt`,
    meta: { model: CIVITAI_QWEN_IMAGE_21_SLUG, ...meta },
  });
  const failed = await failImage(reserved.id, UNDELIVERED, { render: RENDER });
  if (failed?.status !== "failed") throw new Error("the fixture render did not fail");
  return failed;
}

async function imageRow(imageId: string) {
  const [row] = await db().select().from(images).where(eq(images.id, imageId));
  return row;
}

/** A download held open until the test lets it land — a recovery caught mid-flight. */
function heldDownload() {
  let land: (answer: Awaited<ReturnType<typeof recoverCivitaiOutput>>) => void = () => undefined;
  const started = new Promise<void>((resolveStarted) => {
    mockRecover.mockImplementation(() => new Promise((resolve) => {
      land = resolve;
      resolveStarted();
    }));
  });
  return { started, land: (answer: Awaited<ReturnType<typeof recoverCivitaiOutput>>) => land(answer) };
}

describe.skipIf(!ready)("recovering a paid output in place (#686)", () => {
  it.each([
    ["a portrait variant", "portrait_variant", {}],
    ["an avatar", "avatar", {}],
    ["a scene", "scene", {}],
    ["a selfie", "scene", { flavor: "selfie" }],
  ] as const)("stores %s's paid output on its own row from its stored ids, with no new render", async (_label, kind, meta) => {
    const characterId = await character();
    const failed = await failedPaidRender(kind, characterId, meta);
    expect(imageOutputRecoverable(failed)).toBe(true);
    mockRecover.mockResolvedValue({ ok: true, image: await testPngBuffer(900, 1000) });
    const sink = new DiagnosticCollector();

    const result = await recoverImageOutput({ imageId: failed.id, ownerId, sink });

    expect(result.status).toBe("recovered");
    expect(mockRecover).toHaveBeenCalledTimes(1);
    expect(mockRecover).toHaveBeenCalledWith({ workflowId: WORKFLOW_ID, blobId: BLOB_ID });
    expectDiagnostic(sink, IMAGE_OUTPUT_RECOVERED);
    const row = await imageRow(failed.id);
    expect(row?.status).toBe("ready");
    expect(row?.bytes).toBeGreaterThan(0);
    if (row === undefined) throw new Error("the recovered row is gone");
    expect(await readImageBytes(row)).not.toBeNull();
    const stored = imageMeta(row.meta);
    // In place: the row names the workflow and output, never another row.
    expect(stored.recoveredFrom).toMatchObject({ workflowId: WORKFLOW_ID, blobId: BLOB_ID });
    expect(stored.recoveredFrom).not.toHaveProperty("imageId");
    // Cropped toward the lane's 3:4 from the decoded 900x1000 original.
    expect(stored).toMatchObject({ width: 750, height: 1000, ...meta });
    for (const key of ["error", "failedAt", RENDER_LEASE_META_KEY, RECOVERY_CLAIM_META_KEY, PAID_OUTPUT_UNAVAILABLE_KEY]) {
      expect(stored).not.toHaveProperty(key);
    }
    expect(imageOutputRecoverable(row)).toBe(false);
  });

  it("never moves the character's portrait pointer: a recovered avatar is a ready candidate", async () => {
    const characterId = await character();
    const current = await createImageAsset({ ownerId, kind: "avatar", entityKind: "character", entityId: characterId });
    await saveImageBuffer(current.id, await testPngBuffer());
    await db().update(characters).set({ avatarImageId: current.id }).where(eq(characters.id, characterId));
    const failed = await failedPaidRender("avatar", characterId);
    mockRecover.mockResolvedValue({ ok: true, image: await testPngBuffer(600, 800) });

    expect((await recoverImageOutput({ imageId: failed.id, ownerId })).status).toBe("recovered");

    const [after] = await db().select({ avatarImageId: characters.avatarImageId }).from(characters).where(eq(characters.id, characterId));
    expect(after?.avatarImageId).toBe(current.id);
    // The studio's own list offers it as a ready candidate, no longer recoverable.
    const listed = (await listOwnedPortraits(ownerId, characterId)).find((row) => row.id === failed.id);
    expect(listed).toMatchObject({ status: "ready", recoverable: false });
  });

  it("answers busy while another recovery holds the row, and only one installs", async () => {
    const failed = await failedPaidRender("portrait_variant", await character());
    const held = heldDownload();

    const first = recoverImageOutput({ imageId: failed.id, ownerId });
    await held.started;
    expect((await imageRow(failed.id))?.status).toBe("pending");
    expect(await recoverImageOutput({ imageId: failed.id, ownerId })).toEqual({ status: "busy" });

    held.land({ ok: true, image: await testPngBuffer(600, 800) });
    expect((await first).status).toBe("recovered");
    expect(mockRecover).toHaveBeenCalledTimes(1);
    expect((await imageRow(failed.id))?.status).toBe("ready");
  });

  it("withdraws the offer when the provider shows the output is gone for good", async () => {
    const failed = await failedPaidRender("scene", await character());
    mockRecover.mockResolvedValue({ ok: false, permanent: true, error: "the blob is no longer available" });
    const sink = new DiagnosticCollector();

    expect(await recoverImageOutput({ imageId: failed.id, ownerId, sink })).toEqual({ status: "expired" });

    expectDiagnostic(sink, IMAGE_OUTPUT_EXPIRED);
    const row = await imageRow(failed.id);
    if (row === undefined) throw new Error("the withdrawn row is gone");
    expect(row.status).toBe("failed");
    expect(paidOutputOffer(row)).toEqual({ state: "withdrawn" });
    expect(imageOutputRecoverable(row)).toBe(false);
    // The withdrawn offer is not fetched again.
    expect(await recoverImageOutput({ imageId: failed.id, ownerId })).toEqual({ status: "expired" });
    expect(mockRecover).toHaveBeenCalledTimes(1);
  });

  it("gives the row back on a transient failure with its original error and failure time, offer standing", async () => {
    const failed = await failedPaidRender("avatar", await character());
    const before = imageMeta(failed.meta);
    mockRecover.mockResolvedValue({ ok: false, permanent: false, error: "Civitai answered 503" });
    const sink = new DiagnosticCollector();

    expect(await recoverImageOutput({ imageId: failed.id, ownerId, sink })).toEqual({ status: "unavailable" });

    expectDiagnostic(sink, IMAGE_OUTPUT_UNAVAILABLE);
    const row = await imageRow(failed.id);
    if (row === undefined) throw new Error("the given-back row is gone");
    expect(row.status).toBe("failed");
    const stored = imageMeta(row.meta);
    // Retention's clock never moved, and nothing of the claim is left.
    expect(stored.error).toBe(before.error);
    expect(stored.failedAt).toBe(before.failedAt);
    expect(stored).not.toHaveProperty(RENDER_LEASE_META_KEY);
    expect(stored).not.toHaveProperty(RECOVERY_CLAIM_META_KEY);
    expect(imageOutputRecoverable(row)).toBe(true);
  });

  it("leaves a leased pending row when its process dies, which the sweep's reclaim returns to an offer", async () => {
    const failed = await failedPaidRender("scene", await character());
    const held = heldDownload();

    const dying = recoverImageOutput({ imageId: failed.id, ownerId });
    await held.started;
    const claimed = await imageRow(failed.id);
    expect(claimed?.status).toBe("pending");
    expect(typeof imageMeta(claimed?.meta)[RENDER_LEASE_META_KEY]).toBe("number");

    // The process is gone: its lease falls silent past the stale bound, and the
    // sweep reclaims the row, keeping the render record.
    const later = new Date(Date.now() + JOB_STALE_MS + 60_000);
    expect(await reclaimStalePendingRows(later, ownerId)).toContain(failed.id);
    const reclaimed = await imageRow(failed.id);
    if (reclaimed === undefined) throw new Error("the reclaimed row is gone");
    expect(reclaimed.status).toBe("failed");
    expect(imageMeta(reclaimed.meta).render).toMatchObject(RENDER);
    expect(imageOutputRecoverable(reclaimed)).toBe(true);

    // Settle the stranded run so the suite does not leak it: a transient end
    // leaves the reclaimed row an offer.
    held.land({ ok: false, permanent: false, error: "the process is gone" });
    expect((await dying).status).toBe("unavailable");
    const after = await imageRow(failed.id);
    if (after === undefined) throw new Error("the offered row is gone");
    expect(imageOutputRecoverable(after)).toBe(true);
  });

  it("answers not_found when the owner deletes the row mid-recovery", async () => {
    const failed = await failedPaidRender("portrait_variant", await character());
    const held = heldDownload();

    const recovering = recoverImageOutput({ imageId: failed.id, ownerId });
    await held.started;
    expect(await deleteOwnedImage(failed.id, ownerId, { kind: "portrait_variant" })).toBe(true);
    held.land({ ok: true, image: await testPngBuffer(600, 800) });

    expect(await recovering).toEqual({ status: "not_found" });
    expect(await imageRow(failed.id)).toBeUndefined();
  });

  it("answers ineligible for a reference view, which keeps its own recovery, and fetches nothing", async () => {
    const failed = await failedPaidRender("reference_view", await character());

    expect(await recoverImageOutput({ imageId: failed.id, ownerId })).toEqual({ status: "ineligible" });

    expect(mockRecover).not.toHaveBeenCalled();
    expect((await imageRow(failed.id))?.status).toBe("failed");
    expect(imageOutputRecoverable(failed)).toBe(false);
  });

  it("answers not_found for another owner's row", async () => {
    const failed = await failedPaidRender("avatar", await character());

    expect(await recoverImageOutput({ imageId: failed.id, ownerId: `${ownerId}-someone-else` })).toEqual({ status: "not_found" });
    expect(mockRecover).not.toHaveBeenCalled();
  });

  it("projects recoverable on the studio's list: a paid failure true, an unpaid failure and a ready row false", async () => {
    const characterId = await character();
    const paid = await failedPaidRender("portrait_variant", characterId);
    const unpaid = await createImageAsset({ ownerId, kind: "avatar", entityKind: "character", entityId: characterId });
    await failImage(unpaid.id, "provider exploded", { render: { modelSlug: CIVITAI_QWEN_IMAGE_21_SLUG, predictionId: WORKFLOW_ID } });
    const landed = await createImageAsset({ ownerId, kind: "avatar", entityKind: "character", entityId: characterId });
    await saveImageBuffer(landed.id, await testPngBuffer());

    const listed = new Map((await listOwnedPortraits(ownerId, characterId)).map((row) => [row.id, row.recoverable]));

    expect(listed.get(paid.id)).toBe(true);
    expect(listed.get(unpaid.id)).toBe(false);
    expect(listed.get(landed.id)).toBe(false);
  });
});
