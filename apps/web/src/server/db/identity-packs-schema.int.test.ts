import { readFile } from "node:fs/promises";
import path from "node:path";
import { and, eq, inArray, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { characters, db, imageIdentityLoraBindings, imageIdentityPacks, imageLoras, images } from "@/server/db";
import { isUniqueViolation } from "@/server/api";
import {
  canonicalImageRow,
  endTestPool,
  probeIntegrationDb,
  purgeOwnerRows,
  seedTestUser,
} from "@/server/test-support";

/**
 * The `image_identity_packs` constraints against a migrated database. These are
 * the four
 * guarantees the service layer is allowed to ASSUME rather than re-check, so
 * nothing short of a real Postgres can prove them:
 *
 * 1. one current revision per character (the partial unique index) — the storage
 *    half of invariant 1, so a lost promotion race fails loudly instead of
 *    leaving two "current" packs for the sweep to find;
 * 2. a revision number is used once per character;
 * 3. deleting the character deletes its packs (operational data, which does not
 *    inherit the Gallery-retention exception);
 * 4. deleting an image NULLs the pointers instead of blocking or cascading — the
 *    safety net that turns a vanished source into an unusable pack rather than a
 *    pack that keeps serving a crop it can no longer justify.
 *
 * The second describe block covers `image_identity_lora_bindings`, which lives
 * here rather than in a file of
 * its own because it is the same data family: it exists only to point at a pack
 * REVISION, its whole meaning is supersession, and it dies with the pack. Its two
 * storage guarantees are the ones `identity-lora-bindings.ts` deliberately
 * delegates to Postgres instead of pre-checking, so nothing short of a real
 * database can prove them either.
 */

const ready = await probeIntegrationDb("identity packs schema.int.test", "image_identity_packs");

let ownerId = "";

/** The columns every revision must carry, so each test states only what it varies. */
function packRow(
  characterId: string,
  over: Partial<typeof imageIdentityPacks.$inferInsert> = {},
): typeof imageIdentityPacks.$inferInsert {
  return {
    characterId,
    revision: 1,
    sourceContentHash: "a".repeat(64),
    sourceWidth: 768,
    sourceHeight: 1024,
    schemaVersion: 1,
    derivationVersion: "derive_v1",
    policyVersion: "policy_v1",
    ...over,
  };
}

/**
 * Insert one revision. A real async function rather than the bare drizzle
 * builder, so `expect(...).rejects` receives a Promise and not a thenable.
 */
async function insertPack(characterId: string, over: Partial<typeof imageIdentityPacks.$inferInsert> = {}): Promise<string> {
  const [row] = await db().insert(imageIdentityPacks).values(packRow(characterId, over)).returning({
    id: imageIdentityPacks.id,
  });
  if (!row) throw new Error("[identity-packs-schema] inserting a pack returned no row");
  return row.id;
}

async function seedCharacter(name: string): Promise<string> {
  const [row] = await db().insert(characters).values({ ownerId, name }).returning({ id: characters.id });
  if (!row) throw new Error(`[identity-packs-schema] seeding character "${name}" inserted no row`);
  return row.id;
}

/** Only the id the pack's FKs point at matters here — no file is written. */
async function seedImage(): Promise<string> {
  const [row] = await db()
    .insert(images)
    .values(canonicalImageRow({ ownerId, kind: "avatar" as const, status: "ready" as const }))
    .returning({ id: images.id });
  if (!row) throw new Error("[identity-packs-schema] seeding image inserted no row");
  return row.id;
}

async function packIds(characterId: string): Promise<string[]> {
  const rows = await db()
    .select({ id: imageIdentityPacks.id })
    .from(imageIdentityPacks)
    .where(eq(imageIdentityPacks.characterId, characterId));
  return rows.map((row) => row.id);
}

/**
 * A LoRA library row to bind to. Fixed ids, deleted either side of the run, for
 * the reason `image-lab.int.test.ts` gives: `image_loras` carries no owner, so
 * `purgeOwnerRows` cannot reach it.
 */
const FIXTURE_LORA_IDS = ["itestsdloraaaaaaaaaaaaaa1", "itestsdloraaaaaaaaaaaaaa2"];

async function seedLoras(): Promise<void> {
  await db().delete(imageLoras).where(inArray(imageLoras.id, FIXTURE_LORA_IDS));
  await db()
    .insert(imageLoras)
    .values(
      FIXTURE_LORA_IDS.map((id, index) => ({
        id,
        label: `identity-lora-binding fixture ${String(index + 1)}`,
        locatorType: "https_url" as const,
        locator: `https://example.invalid/${id}.safetensors`,
        defaultScale: 0.8,
        minimumScale: 0.6,
        maximumScale: 1,
      })),
    );
}

/** Everything a binding must carry, so each test states only what it varies. */
function bindingRow(
  identityPackId: string,
  loraId: string,
  over: Partial<typeof imageIdentityLoraBindings.$inferInsert> = {},
): typeof imageIdentityLoraBindings.$inferInsert {
  return {
    identityPackId,
    loraId,
    baseCheckpoint: "stabilityai/stable-diffusion-xl-base-1.0",
    datasetFingerprint: "deadbeef",
    datasetImageCount: 14,
    trainingRecipeId: "sdxl/character-lora-r8",
    trainingRecipeRevision: 1,
    rank: 8,
    ...over,
  };
}

/** A real async function so `expect(...).rejects` receives a Promise, not a thenable. */
async function insertBinding(
  identityPackId: string,
  loraId: string,
  over: Partial<typeof imageIdentityLoraBindings.$inferInsert> = {},
): Promise<string> {
  const [row] = await db()
    .insert(imageIdentityLoraBindings)
    .values(bindingRow(identityPackId, loraId, over))
    .returning({ id: imageIdentityLoraBindings.id });
  if (!row) throw new Error("[identity-packs-schema] inserting a binding returned no row");
  return row.id;
}

async function bindingIds(identityPackId: string): Promise<string[]> {
  const rows = await db()
    .select({ id: imageIdentityLoraBindings.id })
    .from(imageIdentityLoraBindings)
    .where(eq(imageIdentityLoraBindings.identityPackId, identityPackId));
  return rows.map((row) => row.id);
}

beforeAll(async () => {
  if (!ready) return;
  ownerId = (await seedTestUser("identity-packs-schema")).id;
  await seedLoras();
});

afterAll(async () => {
  await purgeOwnerRows([ownerId]);
  if (ready) await db().delete(imageLoras).where(inArray(imageLoras.id, FIXTURE_LORA_IDS));
  await endTestPool();
});

describe.skipIf(!ready)("image_identity_packs constraints", () => {
  it("permits only one current revision per character", async () => {
    const characterId = await seedCharacter("one-current");
    await insertPack(characterId, { revision: 1, current: true });

    await expect(insertPack(characterId, { revision: 2, current: true })).rejects.toSatisfy(
      isUniqueViolation,
      "a second current revision must fail with a unique violation",
    );

    // The index is PARTIAL: any number of non-current revisions coexist, which is
    // what makes history, superseded rows and retained failure evidence possible.
    await insertPack(characterId, { revision: 2, status: "superseded" });
    await insertPack(characterId, { revision: 3, status: "failed" });
    expect(await packIds(characterId)).toHaveLength(3);

    // And it is scoped per character, not global.
    const otherId = await seedCharacter("one-current-other");
    await insertPack(otherId, { current: true });
    const currents = await db()
      .select({ id: imageIdentityPacks.id })
      .from(imageIdentityPacks)
      .where(and(eq(imageIdentityPacks.characterId, otherId), eq(imageIdentityPacks.current, true)));
    expect(currents).toHaveLength(1);
  });

  it("uses a revision number once per character", async () => {
    const characterId = await seedCharacter("revision-unique");
    await insertPack(characterId, { revision: 4 });

    await expect(insertPack(characterId, { revision: 4, status: "failed" })).rejects.toSatisfy(
      isUniqueViolation,
      "a repeated revision number must fail with a unique violation",
    );

    // The same revision number under a different character is not a collision.
    const otherId = await seedCharacter("revision-unique-other");
    await insertPack(otherId, { revision: 4 });
    expect(await packIds(otherId)).toHaveLength(1);
  });

  it("deletes a character's packs with the character", async () => {
    const characterId = await seedCharacter("cascade");
    await insertPack(characterId, { current: true });
    await insertPack(characterId, { revision: 2, status: "superseded" });

    await db().delete(characters).where(eq(characters.id, characterId));

    expect(await packIds(characterId)).toEqual([]);
  });

  it("nulls the image pointers when their images are deleted", async () => {
    const characterId = await seedCharacter("source-set-null");
    const sourceImageId = await seedImage();
    const faceCropImageId = await seedImage();
    const packId = await insertPack(characterId, {
      current: true,
      status: "ready",
      sourceImageId,
      faceCropImageId,
    });

    await db().delete(images).where(eq(images.id, sourceImageId));

    // The pack SURVIVES its source: it stays as the record of a derivation, now
    // unusable (`source_missing`), rather than vanishing with the bytes. The crop
    // pointer is untouched — one deleted image invalidates one pointer.
    const [afterSource] = await db()
      .select({ sourceImageId: imageIdentityPacks.sourceImageId, faceCropImageId: imageIdentityPacks.faceCropImageId })
      .from(imageIdentityPacks)
      .where(eq(imageIdentityPacks.id, packId));
    expect(afterSource?.sourceImageId).toBeNull();
    expect(afterSource?.faceCropImageId).toBe(faceCropImageId);

    await db().delete(images).where(eq(images.id, faceCropImageId));
    const [afterCrop] = await db()
      .select({ faceCropImageId: imageIdentityPacks.faceCropImageId })
      .from(imageIdentityPacks)
      .where(eq(imageIdentityPacks.id, packId));
    expect(afterCrop?.faceCropImageId).toBeNull();
  });
});

describe.skipIf(!ready)("image_identity_lora_bindings constraints", () => {
  it("promotes at most one binding per pack while any number stay experimental", async () => {
    const characterId = await seedCharacter("lora-binding-active");
    const packId = await insertPack(characterId, { current: true, status: "ready" });
    const [firstLora, secondLora] = FIXTURE_LORA_IDS as [string, string];

    // Stage 4 trains rank 8 and rank 16 from one dataset and compares them, so
    // both have to be storable and renderable at once. A schema that allowed one
    // binding per pack would make the comparison unrepresentable.
    await insertBinding(packId, firstLora, { rank: 8 });
    await insertBinding(packId, secondLora, { rank: 16, trainingRecipeId: "sdxl/character-lora-r16" });
    expect(await bindingIds(packId)).toHaveLength(2);

    await db()
      .update(imageIdentityLoraBindings)
      .set({ state: "active" })
      .where(and(eq(imageIdentityLoraBindings.identityPackId, packId), eq(imageIdentityLoraBindings.loraId, firstLora)));

    // The store promotes with a bare UPDATE and no read-then-write, on the
    // strength of this index: promoting a second binding must FAIL rather than
    // quietly leaving two rows that both claim to be the character's likeness.
    await expect(
      db()
        .update(imageIdentityLoraBindings)
        .set({ state: "active" })
        .where(
          and(eq(imageIdentityLoraBindings.identityPackId, packId), eq(imageIdentityLoraBindings.loraId, secondLora)),
        ),
    ).rejects.toSatisfy(isUniqueViolation, "a second active binding must fail with a unique violation");

    // Scoped per pack, not global: another pack promoting its own is not a collision.
    const otherPackId = await insertPack(characterId, { revision: 2, status: "superseded" });
    await insertBinding(otherPackId, firstLora, { state: "active" });
    expect(await bindingIds(otherPackId)).toHaveLength(1);
  });

  it("binds one LoRA to a pack once, and drops the binding with either side", async () => {
    const characterId = await seedCharacter("lora-binding-lifecycle");
    const packId = await insertPack(characterId, { current: true, status: "ready" });
    const [firstLora, secondLora] = FIXTURE_LORA_IDS as [string, string];
    await insertBinding(packId, firstLora);

    // The same weights bound twice to one pack is not a second arm, it is two
    // rows that would both be the promotion candidate.
    await expect(insertBinding(packId, firstLora, { rank: 16 })).rejects.toSatisfy(
      isUniqueViolation,
      "a repeated (pack, LoRA) pair must fail with a unique violation",
    );

    // Removing the weights removes the claim that they are a likeness…
    await insertBinding(packId, secondLora);
    await db().delete(imageLoras).where(eq(imageLoras.id, secondLora));
    expect(await bindingIds(packId)).toHaveLength(1);

    // …and deleting the character takes the pack and its bindings with it.
    await db().delete(characters).where(eq(characters.id, characterId));
    expect(await bindingIds(packId)).toEqual([]);

    await seedLoras();
  });
});


/**
 * The 0124 backfill, run from the migration file itself rather than a copy of
 * it: deploying portrait acceptance must leave every existing character's
 * identity source exactly where it was, which means every character that already
 * had a portrait comes out of the migration with that portrait ACCEPTED. A
 * backfill that missed them would silently strip every character of its identity
 * pack on deploy — the packs read the accepted pointer.
 */
describe.skipIf(!ready)("migration 0124 — portrait acceptance backfill", () => {
  /** The UPDATE statements the shipped migration file carries, in order. */
  async function backfillStatements(): Promise<string[]> {
    const file = path.join(process.cwd(), "drizzle", "0124_portrait-acceptance.sql");
    const sqlText = await readFile(file, "utf8");
    return sqlText
      .split("--> statement-breakpoint")
      .map((statement) => statement.trim())
      .filter((statement) => statement.toUpperCase().includes("UPDATE "));
  }

  it("accepts the portrait every character already had, and invents none", async () => {
    const withPortrait = await seedCharacter("backfill-with-portrait");
    const withoutPortrait = await seedCharacter("backfill-without-portrait");
    const portraitId = await seedImage();
    // The pre-migration shape: a candidate pointer and nothing else.
    await db().update(characters).set({ avatarImageId: portraitId }).where(eq(characters.id, withPortrait));

    const statements = await backfillStatements();
    expect(statements).toHaveLength(1);
    for (const statement of statements) await db().execute(sql.raw(statement));

    const [accepted] = await db()
      .select({ acceptedAvatarImageId: characters.acceptedAvatarImageId, acceptedAt: characters.acceptedAt })
      .from(characters)
      .where(eq(characters.id, withPortrait));
    expect(accepted?.acceptedAvatarImageId).toBe(portraitId);
    expect(accepted?.acceptedAt).not.toBeNull();

    // Nothing to accept, so nothing is claimed — not an acceptance of null.
    const [untouched] = await db()
      .select({ acceptedAvatarImageId: characters.acceptedAvatarImageId, acceptedAt: characters.acceptedAt })
      .from(characters)
      .where(eq(characters.id, withoutPortrait));
    expect(untouched?.acceptedAvatarImageId).toBeNull();
    expect(untouched?.acceptedAt).toBeNull();
  });
});
