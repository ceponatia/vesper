import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { characters, db, jobs } from "@/server/db";
import { endTestPool, probeIntegrationDb, purgeOwnerRows, seedTestUser } from "@/server/test-support";
import { listCharacterMediaJobs } from "./character-media-jobs";

const ready = await probeIntegrationDb("character-media-jobs.int.test", "jobs");
let ownerId = "";
let foreignOwnerId = "";
let characterId = "";

beforeAll(async () => {
  if (!ready) return;
  ownerId = (await seedTestUser("character-media-jobs-owner")).id;
  foreignOwnerId = (await seedTestUser("character-media-jobs-foreign")).id;
  const [character] = await db()
    .insert(characters)
    .values({ ownerId, name: "Media status subject" })
    .returning({ id: characters.id });
  if (!character) throw new Error("failed to seed media status character");
  characterId = character.id;
});

afterAll(async () => {
  if (ready) await purgeOwnerRows([ownerId, foreignOwnerId]);
  await endTestPool();
});

describe.skipIf(!ready)("owner-scoped character media jobs", () => {
  it("returns only this owner's jobs for this character and strips raw payload/error data", async () => {
    const now = new Date();
    await db().insert(jobs).values([
      {
        ownerId,
        type: "avatar",
        status: "done",
        payload: { characterId, imageId: "image-safe", prompt: "private prompt", providerToken: "secret" },
        error: "provider returned https://token@example.test",
        startedAt: new Date(now.getTime() - 2_000),
        finishedAt: new Date(now.getTime() - 1_000),
      },
      {
        ownerId: foreignOwnerId,
        type: "avatar",
        status: "failed",
        payload: { characterId, imageId: "foreign-image" },
        error: "foreign failure",
        startedAt: new Date(now.getTime() - 2_000),
        finishedAt: new Date(now.getTime() - 1_000),
      },
    ]);

    const projected = await listCharacterMediaJobs(characterId, ownerId, now);
    expect(projected).toHaveLength(1);
    expect(projected[0]).toMatchObject({
      operation: "portrait",
      lifecycle: "succeeded",
      results: [{ kind: "image", id: "image-safe", imageId: "image-safe" }],
    });
    const serialized = JSON.stringify(projected);
    expect(serialized).not.toContain("private prompt");
    expect(serialized).not.toContain("secret");
    expect(serialized).not.toContain("foreign-image");
    expect(serialized).not.toContain("example.test");
  });

  it("bounds recent history and excludes another character owned by the same user", async () => {
    const [other] = await db()
      .insert(characters)
      .values({ ownerId, name: "Other media subject" })
      .returning({ id: characters.id });
    if (!other) throw new Error("failed to seed other media character");
    await db().insert(jobs).values({
      ownerId,
      type: "portrait_variant",
      status: "done",
      payload: { characterId: other.id, imageId: "other-image" },
      startedAt: new Date(),
      finishedAt: new Date(),
    });

    const projected = await listCharacterMediaJobs(characterId, ownerId);
    expect(projected.every((job) => job.results.every((result) => result.id !== "other-image"))).toBe(true);
  });
});
