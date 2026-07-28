import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { db, images } from "../db";
import { endTestPool, probeIntegrationDb, purgeOwnerRows, seedTestUser } from "@/server/test-support";
import { imageRelativePath } from "./paths";

// Connectivity and seeding are deliberately SEPARATE steps: fusing them (as this
// suite once did) reported a failed user insert as "database unreachable" and
// skipped the whole containment matrix.
const ready = await probeIntegrationDb("image-path-containment.int.test", "images");

let ownerId = "";

function hasPgCode(error: unknown, code: string): boolean {
  let current: unknown = error;
  for (let depth = 0; depth < 6 && current !== null && typeof current === "object"; depth += 1) {
    if ((current as { code?: unknown }).code === code) return true;
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}

beforeAll(async () => {
  if (!ready) return;
  ownerId = (await seedTestUser("image-path-constraint")).id;
});

afterAll(async () => {
  await purgeOwnerRows([ownerId]);
  await endTestPool();
});

// The rows below are built BY HAND rather than through `canonicalImageRow`: the
// non-canonical paths are the subject of the test (they must trip the
// `images_path_canonical` CHECK), and the fixture exists precisely to make those
// paths unconstructible.
describe.skipIf(!ready)("images.path database containment", () => {
  it("accepts the exact canonical owner/id path", async () => {
    const id = `path-valid-${Date.now()}`;
    const [row] = await db()
      .insert(images)
      .values({
        id,
        ownerId,
        kind: "entity",
        path: imageRelativePath(ownerId, id),
      })
      .returning({ path: images.path });

    expect(row?.path).toBe(`images/${ownerId}/${id}.webp`);
  });

  it.each(["../outside.webp", "/tmp/outside.webp", "images/someone-else/wrong.webp"])(
    "rejects noncanonical path %s",
    async (storedPath) => {
      const id = `path-invalid-${Date.now()}-${Math.random().toString(16).slice(2)}`;
      let caught: unknown;
      try {
        await db().insert(images).values({
          id,
          ownerId,
          kind: "entity",
          path: storedPath,
        });
      } catch (error) {
        caught = error;
      }
      expect(hasPgCode(caught, "23514")).toBe(true);
    },
  );
});
