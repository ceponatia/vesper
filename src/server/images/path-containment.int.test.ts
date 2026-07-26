import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import { db, images, users } from "../db";
import { imageRelativePath } from "./paths";

let available = false;
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
  await db().delete(images).where(eq(images.ownerId, ownerId));
  await db().delete(users).where(eq(users.id, ownerId));
  await globalThis.__vesperPool?.end();
});

describe("images.path database containment", () => {
  it("accepts the exact canonical owner/id path", async (ctx) => {
    if (!available) return ctx.skip();
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
      if (!available) return;
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
