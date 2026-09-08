import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  IDENTITY_PACK_DERIVATION_VERSION,
  IDENTITY_PACK_POLICY_VERSION,
  IDENTITY_PACK_SCHEMA_VERSION,
} from "@vesper/image-core";
import { REFERENCE_VIEW_GENERATION_VERSION } from "@/contracts";
import { characterReferenceViews, characters, db, imageIdentityPacks, images, jobs } from "@/server/db";
import {
  canonicalImageRow,
  endTestPool,
  probeIntegrationDb,
  purgeOwnerRows,
  seedTestUser,
} from "@/server/test-support";
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
    const [readyImage] = await db()
      .insert(images)
      .values(canonicalImageRow({
        ownerId,
        kind: "avatar" as const,
        entityKind: "character" as const,
        entityId: characterId,
        status: "ready" as const,
      }))
      .returning({ id: images.id });
    if (!readyImage) throw new Error("failed to seed ready avatar image");
    await db().insert(jobs).values([
      {
        ownerId,
        type: "avatar",
        status: "done",
        payload: { characterId, imageId: readyImage.id, prompt: "private prompt", providerToken: "secret" },
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
      results: [{ kind: "image", id: readyImage.id, imageId: readyImage.id }],
    });
    const serialized = JSON.stringify(projected);
    expect(serialized).not.toContain("private prompt");
    expect(serialized).not.toContain("secret");
    expect(serialized).not.toContain("foreign-image");
    expect(serialized).not.toContain("example.test");
  });

  it("fails settled portrait jobs whose claimed image is not a ready owned asset for this character and kind", async () => {
    const [subject, otherCharacter] = await db()
      .insert(characters)
      .values([
        { ownerId, name: "Media validation subject" },
        { ownerId, name: "Different media subject" },
      ])
      .returning({ id: characters.id });
    if (!subject || !otherCharacter) throw new Error("failed to seed media validation characters");

    const assets = await db()
      .insert(images)
      .values([
        canonicalImageRow({
          ownerId,
          kind: "portrait_variant" as const,
          entityKind: "character" as const,
          entityId: subject.id,
          status: "ready" as const,
        }),
        canonicalImageRow({
          ownerId,
          kind: "portrait_variant" as const,
          entityKind: "character" as const,
          entityId: subject.id,
          status: "failed" as const,
        }),
        canonicalImageRow({
          ownerId: foreignOwnerId,
          kind: "avatar" as const,
          entityKind: "character" as const,
          entityId: subject.id,
          status: "ready" as const,
        }),
        canonicalImageRow({
          ownerId,
          kind: "avatar" as const,
          entityKind: "character" as const,
          entityId: otherCharacter.id,
          status: "ready" as const,
        }),
      ])
      .returning({ id: images.id });
    const [readyVariant, failedVariant, foreignAvatar, otherCharacterAvatar] = assets;
    if (!readyVariant || !failedVariant || !foreignAvatar || !otherCharacterAvatar) {
      throw new Error("failed to seed media validation images");
    }

    const jobRows = await db()
      .insert(jobs)
      .values([
        {
          ownerId,
          type: "portrait_variant" as const,
          status: "done" as const,
          payload: { characterId: subject.id, kind: "pose", imageId: readyVariant.id },
          startedAt: new Date(),
          finishedAt: new Date(),
        },
        {
          ownerId,
          type: "portrait_variant" as const,
          status: "done" as const,
          payload: { characterId: subject.id, kind: "pose", imageId: failedVariant.id },
          startedAt: new Date(),
          finishedAt: new Date(),
        },
        ...[foreignAvatar.id, otherCharacterAvatar.id, readyVariant.id, "missing-image"].map((imageId) => ({
          ownerId,
          type: "avatar" as const,
          status: "done" as const,
          payload: { characterId: subject.id, imageId },
          startedAt: new Date(),
          finishedAt: new Date(),
        })),
      ])
      .returning({ id: jobs.id });
    expect(jobRows).toHaveLength(6);
    const [
      readyVariantJob,
      failedVariantJob,
      foreignImageJob,
      wrongCharacterJob,
      wrongKindJob,
      missingImageJob,
    ] = jobRows;
    if (
      !readyVariantJob
      || !failedVariantJob
      || !foreignImageJob
      || !wrongCharacterJob
      || !wrongKindJob
      || !missingImageJob
    ) {
      throw new Error("failed to seed media validation jobs");
    }

    const projected = await listCharacterMediaJobs(subject.id, ownerId);
    const byId = new Map(projected.map((job) => [job.id, job]));
    expect(byId.get(readyVariantJob.id)).toMatchObject({
      lifecycle: "succeeded",
      results: [{ kind: "image", id: readyVariant.id, imageId: readyVariant.id }],
      retry: { operation: "variant", targets: ["pose"] },
    });
    for (const job of [failedVariantJob, foreignImageJob, wrongCharacterJob, wrongKindJob, missingImageJob]) {
      expect(byId.get(job.id)).toMatchObject({
        lifecycle: "failed",
        results: [],
      });
    }
    expect(byId.get(failedVariantJob.id)?.retry).toEqual({ operation: "variant", targets: ["pose"] });
    for (const job of [foreignImageJob, wrongCharacterJob, wrongKindJob, missingImageJob]) {
      expect(byId.get(job.id)?.retry).toEqual({ operation: "portrait", targets: [] });
    }
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

  it("attributes overlapping identity packs by exact ids and bounds legacy fallback", async () => {
    const [character] = await db()
      .insert(characters)
      .values({ ownerId, name: "Identity result ownership" })
      .returning({ id: characters.id });
    if (!character) throw new Error("failed to seed identity ownership character");

    const windowStart = new Date(Date.now() - 4_000);
    const packs = await db()
      .insert(imageIdentityPacks)
      .values([1, 2, 3].map((revision) => ({
        characterId: character.id,
        revision,
        current: false,
        status: "ready" as const,
        sourceContentHash: `${revision}`.repeat(64),
        sourceWidth: 96,
        sourceHeight: 128,
        schemaVersion: IDENTITY_PACK_SCHEMA_VERSION,
        derivationVersion: IDENTITY_PACK_DERIVATION_VERSION,
        policyVersion: IDENTITY_PACK_POLICY_VERSION,
        method: "heuristic" as const,
        createdAt: new Date(windowStart.getTime() + revision * 1_000),
      })))
      .returning({ id: imageIdentityPacks.id });
    expect(packs).toHaveLength(3);
    const windowEnd = new Date(windowStart.getTime() + 4_000);

    const inserted = await db()
      .insert(jobs)
      .values([
        {
          ownerId,
          type: "identity_pack",
          status: "done",
          payload: { characterId: character.id, identityPackIds: [packs[0]!.id] },
          createdAt: windowStart,
          heartbeatAt: windowEnd,
          startedAt: windowStart,
          finishedAt: windowEnd,
        },
        {
          ownerId,
          type: "identity_pack",
          status: "done",
          payload: { characterId: character.id, identityPackIds: [packs[1]!.id] },
          createdAt: windowStart,
          heartbeatAt: windowEnd,
          startedAt: windowStart,
          finishedAt: windowEnd,
        },
        {
          ownerId,
          type: "identity_pack",
          status: "done",
          payload: { characterId: character.id },
          createdAt: windowStart,
          heartbeatAt: windowEnd,
          startedAt: windowStart,
          finishedAt: windowEnd,
        },
      ])
      .returning({ id: jobs.id });

    const projected = await listCharacterMediaJobs(character.id, ownerId);
    expect(projected.find((job) => job.id === inserted[0]?.id)?.results.map((result) => result.id))
      .toEqual([packs[0]!.id]);
    expect(projected.find((job) => job.id === inserted[1]?.id)?.results.map((result) => result.id))
      .toEqual([packs[1]!.id]);
    expect(projected.find((job) => job.id === inserted[2]?.id)?.results.map((result) => result.id))
      .toEqual([packs[2]!.id]);
    expect(projected.filter((job) => job.id !== inserted[2]?.id).flatMap((job) => job.results).map((result) => result.id))
      .not.toContain(packs[2]!.id);
  });
});
