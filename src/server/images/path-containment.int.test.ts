import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { db, images, users } from "../db";
import { imageRelativePath } from "./paths";

let available = false;
let ownerId = "";

beforeAll(async () => {
  try {
    await db().execute(sql`select 1 from images limit 0`);
    const [user] = await db()
      .insert(users)
      .values({ email: `image-path-constraint-${Date.now()}@test.local`, name: "Image Path Constraint" })
      .returning({ id: users.id });
    if (!user) throw new Error("failed to seed image path constraint user");
    ownerId = user.id;
    available = true;
  } catch (error) {
    process.stderr.write(
      `[image-path-containment.int.test] skipping: ${error instanceof Error ? error.message : String(error)}\n`,
    );
  }
});

afterAll(async () => {
  if (!available) return;
  await db().delete(users).where(sql`${users.id} = ${ownerId}`);
  await globalThis.__vesperPool?.end();
});

describe.runIf(available)("images.path database containment", () => {
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
      await expect(
        db().insert(images).values({
          id,
          ownerId,
          kind: "entity",
          path: storedPath,
        }),
      ).rejects.toMatchObject({ code: "23514" });
    },
  );
});
