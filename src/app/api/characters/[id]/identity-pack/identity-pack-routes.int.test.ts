import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { IdentityPackSummaryWire } from "@/contracts";
import { characters, db } from "@/server/db";

const authState = vi.hoisted(() => ({
  user: { id: "", email: "", name: "Identity Routes Int", role: "admin" as const },
}));

vi.mock("@/server/auth", async () => (await import("@/server/test-support")).routeAuthModule(authState));

import { createImageAsset, saveOwnedImageBuffer } from "@/server/images";
import {
  apiRequest,
  bindAuthUser,
  endTestPool,
  expectJson,
  probeIntegrationDb,
  purgeOwnerRows,
  routeCtx,
  seedTestUser,
  testPngBuffer,
  withTempDataRoot,
  type TempDataRoot,
} from "@/server/test-support";
import { GET as packGet } from "./route";
import { POST as packEnsure } from "./ensure/route";
import { POST as packManualCrop } from "./manual-crop/route";
import { POST as packResetAutomatic } from "./reset-automatic/route";

/**
 * The owner's four identity-pack routes against a real database and a sandboxed
 * DATA_ROOT (image-identity-packs.spec.lifecycle.md §"User routes").
 *
 * What only an integration run can prove, and the reason this suite exists
 * alongside the service's own: that the ROUTES thread the authorization root,
 * the concurrency guard and the wire shape correctly end to end — a status view
 * that says "none" before anyone asks, a prepare that answers with a settled
 * pack, a save that requires the guard the previous response handed out, and a
 * stale save that comes back as a 409 carrying the summary to reload from rather
 * than as a failure the client has to interpret.
 *
 * Self-skips when the database is unreachable, except under strict integration
 * mode (`pnpm test:int:strict`), where it fails.
 */

const ready = await probeIntegrationDb("identity-pack-routes.int.test", "image_identity_packs");

/** 3:4 like every canonical portrait, and wide enough that the crop clears the 256px floor. */
const PORTRAIT_WIDTH = 384;
const PORTRAIT_HEIGHT = 512;

/** Full width, top three-quarters: 384x384 source pixels — square, in bounds, above the minimum. */
const OWNER_CROP = { space: "normalized" as const, left: 0, top: 0, width: 1, height: 0.75 };

let temp: TempDataRoot | undefined;
let userId = "";
let characterId = "";

const packPath = (suffix = "") => `/api/characters/${characterId}/identity-pack${suffix}`;
const params = () => routeCtx({ id: characterId });

beforeAll(async () => {
  if (!ready) return;
  temp = await withTempDataRoot("vesper-identity-pack-routes-int");
  const user = await seedTestUser("identity-pack-routes-int", { name: "Identity Routes Int", role: "admin" });
  bindAuthUser(authState, user);
  userId = user.id;

  const [character] = await db()
    .insert(characters)
    .values({ ownerId: userId, name: "Route Subject", profile: { bio: "identity pack route subject" } })
    .returning({ id: characters.id });
  if (!character) throw new Error("failed to create the test character");
  characterId = character.id;

  const asset = await createImageAsset({
    ownerId: userId,
    kind: "avatar",
    entityKind: "character",
    entityId: characterId,
    prompt: "portrait",
  });
  const saved = await saveOwnedImageBuffer(asset.id, userId, await testPngBuffer(PORTRAIT_WIDTH, PORTRAIT_HEIGHT));
  if (saved?.status !== "ready") throw new Error("failed to store the test portrait");
  await db().update(characters).set({ avatarImageId: saved.id }).where(eq(characters.id, characterId));
});

afterAll(async () => {
  await temp?.cleanup();
  await purgeOwnerRows([userId]);
  await endTestPool();
});

async function readSummary(): Promise<IdentityPackSummaryWire> {
  const res = await packGet(apiRequest(packPath()), params());
  return (await expectJson<{ summary: IdentityPackSummaryWire }>(res, 200)).summary;
}

/** The optimistic-concurrency triple a write must echo back, taken from a summary. */
function guardOf(summary: IdentityPackSummaryWire): { packId: string; revision: number; sourceContentHash: string } {
  if (summary.packId === null || summary.revision === null || summary.sourceContentHash === null) {
    throw new Error("expected a prepared pack to carry a write guard");
  }
  return { packId: summary.packId, revision: summary.revision, sourceContentHash: summary.sourceContentHash };
}

describe.skipIf(!ready)("identity-pack owner routes", () => {
  it("reports no pack, prepares one on request, and reads back the same revision", async () => {
    const before = await readSummary();
    // "none" is a state, not a failure: nobody has asked for a pack yet, and the
    // status view has to be able to say exactly that.
    expect(before.status).toBe("none");
    expect(before.packId).toBeNull();
    expect(before.failureCode).toBeNull();
    expect(before.crop).toBeNull();

    const ensured = await expectJson<{ summary: IdentityPackSummaryWire }>(
      await packEnsure(apiRequest(packPath("/ensure"), { body: {} }), params()),
      200,
    );
    expect(ensured.summary.status).toBe("ready");
    expect(ensured.summary.current).toBe(true);
    expect(ensured.summary.stale).toBe(false);
    expect(ensured.summary.revision).toBe(1);
    // The shipped detector finds nothing, so a portrait-shaped source falls to
    // the deterministic heuristic — usable, and never silently so.
    expect(ensured.summary.method).toBe("heuristic");
    expect(ensured.summary.warningCodes).toContain("heuristic_crop");
    expect(ensured.summary.crop).not.toBeNull();
    expect(ensured.summary.cropImageId).not.toBeNull();
    expect(ensured.summary.source).toMatchObject({ width: PORTRAIT_WIDTH, height: PORTRAIT_HEIGHT });
    expect(ensured.summary.sourceContentHash).toMatch(/^[0-9a-f]{64}$/);

    const after = await readSummary();
    expect(after.packId).toBe(ensured.summary.packId);
    expect(after.status).toBe("ready");
  });

  it("saves an owner crop as a manual revision, then refuses the stale editor with a reloadable 409", async () => {
    const guard = guardOf(await readSummary());

    const saved = await expectJson<{ summary: IdentityPackSummaryWire }>(
      await packManualCrop(apiRequest(packPath("/manual-crop"), { body: { ...guard, crop: OWNER_CROP } }), params()),
      200,
    );
    expect(saved.summary.method).toBe("manual");
    expect(saved.summary.status).toBe("ready");
    expect(saved.summary.revision).toBe(guard.revision + 1);
    expect(saved.summary.crop).toEqual({ left: 0, top: 0, width: 384, height: 384 });
    // An owner correction is not an override: nothing was waived, so nothing is stamped.
    expect(saved.summary.warningCodes).not.toContain("manual_admin_override");

    // Replaying the FIRST guard is exactly what a second browser tab does. It must
    // not apply coordinates to a revision the user never saw.
    const stale = await packManualCrop(
      apiRequest(packPath("/manual-crop"), { body: { ...guard, crop: OWNER_CROP } }),
      params(),
    );
    const conflict = await expectJson<{
      error: { code: string; message: string };
      summary: IdentityPackSummaryWire | null;
    }>(stale, 409);
    expect(conflict.error.code).toBe("stale_pack");
    // The conflict carries what to reload TO — a second GET would race the same
    // source the save just lost.
    expect(conflict.summary?.packId).toBe(saved.summary.packId);
    expect(conflict.summary?.revision).toBe(saved.summary.revision);
  });

  it("resets to automatic as a new revision rather than resurrecting the old one", async () => {
    const manual = await readSummary();
    expect(manual.method).toBe("manual");

    const reset = await expectJson<{ summary: IdentityPackSummaryWire }>(
      await packResetAutomatic(apiRequest(packPath("/reset-automatic"), { body: {} }), params()),
      200,
    );
    expect(reset.summary.method).toBe("heuristic");
    expect(reset.summary.status).toBe("ready");
    // A NEW revision: the superseded manual crop stays in history for the
    // diagnostic window, so "what did my crop look like?" remains answerable.
    expect(reset.summary.revision).toBe((manual.revision ?? 0) + 1);
    expect(reset.summary.packId).not.toBe(manual.packId);
  });

  it("hides another owner's character behind the same 404 a nonexistent one gets", async () => {
    const intruder = await seedTestUser("identity-pack-routes-int-intruder");
    const mine = authState.user;
    bindAuthUser(authState, intruder);
    try {
      const res = await packGet(apiRequest(packPath()), params());
      expect(res.status).toBe(404);
      const body = await expectJson<{ error: { code: string } }>(res);
      // "character not found" — never "this character's pack is not yours", which
      // would confirm the character exists (spec.lifecycle.md §Authorization root).
      expect(body.error.code).toBe("not_found");
    } finally {
      authState.user = mine;
      await purgeOwnerRows([intruder.id]);
    }
  });
});
