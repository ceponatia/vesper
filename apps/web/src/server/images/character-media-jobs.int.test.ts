import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { REFERENCE_VIEW_GENERATION_VERSION } from "@/contracts";
import { characterReferenceViews, characters, db, jobs } from "@/server/db";
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

  it("attributes overlapping disjoint reference attempts to their exact jobs", async () => {
    const [character] = await db()
      .insert(characters)
      .values({ ownerId, name: "Disjoint result ownership" })
      .returning({ id: characters.id });
    if (!character) throw new Error("failed to seed result ownership character");

    const attempts = await db()
      .insert(characterReferenceViews)
      .values([
        {
          characterId: character.id,
          angleId: "front_full",
          wardrobe: "clothed",
          current: true,
          status: "ready",
          sourceContentHash: "a".repeat(64),
          generationVersion: REFERENCE_VIEW_GENERATION_VERSION,
          method: "rendered",
        },
        {
          characterId: character.id,
          angleId: "back_full",
          wardrobe: "clothed",
          current: true,
          status: "ready",
          sourceContentHash: "a".repeat(64),
          generationVersion: REFERENCE_VIEW_GENERATION_VERSION,
          method: "rendered",
        },
        {
          characterId: character.id,
          angleId: "side_left",
          wardrobe: "clothed",
          current: true,
          status: "ready",
          sourceContentHash: "a".repeat(64),
          generationVersion: REFERENCE_VIEW_GENERATION_VERSION,
          method: "rendered",
        },
      ])
      .returning({ id: characterReferenceViews.id });
    expect(attempts).toHaveLength(3);

    const windowStart = new Date(Date.now() - 2_000);
    const windowEnd = new Date(Date.now() + 2_000);
    const inserted = await db()
      .insert(jobs)
      .values([
        {
          ownerId,
          type: "reference_views",
          status: "done",
          payload: {
            characterId: character.id,
            targets: ["front_full:clothed"],
            referenceViewAttemptIds: [attempts[0]!.id],
            built: 1,
          },
          createdAt: windowStart,
          heartbeatAt: windowEnd,
          startedAt: windowStart,
          finishedAt: windowEnd,
        },
        {
          ownerId,
          type: "reference_views",
          status: "done",
          payload: {
            characterId: character.id,
            targets: ["back_full:clothed"],
            referenceViewAttemptIds: [attempts[1]!.id],
            built: 1,
          },
          createdAt: windowStart,
          heartbeatAt: windowEnd,
          startedAt: windowStart,
          finishedAt: windowEnd,
        },
      ])
      .returning({ id: jobs.id });

    const projected = await listCharacterMediaJobs(character.id, ownerId);
    expect(projected.find((job) => job.id === inserted[0]?.id)?.results.map((result) => result.id))
      .toEqual([attempts[0]!.id]);
    expect(projected.find((job) => job.id === inserted[1]?.id)?.results.map((result) => result.id))
      .toEqual([attempts[1]!.id]);
    expect(projected.flatMap((job) => job.results).map((result) => result.id))
      .not.toContain(attempts[2]!.id);
  });
});
