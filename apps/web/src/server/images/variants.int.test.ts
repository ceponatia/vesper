import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { newId } from "@/lib/ids";
import { characters, db, images } from "@/server/db";
import {
  canonicalImageRow,
  endTestPool,
  probeIntegrationDb,
  purgeOwnerRows,
  seedTestUser,
} from "@/server/test-support";
import { promoteVariant } from "./variants";

// Ownership coverage for the avatar-promotion seam (security-authz.plan.md
// §Follow-ups item 2). `promoteVariant` is a destructive-ish mutation — it
// repoints a character's canonical avatar — so it verifies BOTH rows against
// the caller's owner id in its own queries rather than trusting the route's
// `findOwnedCharacter` gate. Two owners, so every cross-account shape is
// expressible; the last case is the S5 shape (polymorphic entityKind/entityId
// are unverified metadata, so ownership can never be inferred from them).
// Self-skips when the database is unreachable, except under strict integration
// mode (`pnpm test:int:strict`), where it fails instead.

const ready = await probeIntegrationDb("images variants.int.test", "images");

/** The owner. Owns every fixture unless a case says otherwise. */
let ownerA = "";
/** The adversary — owns a character and an image, so "a legitimate home for this id" cases exist. */
let ownerB = "";

const fixture = {
  /** A's character, the promotion target. */
  character: "",
  /** A's SECOND character — the wrong-parent target for a valid image id. */
  otherCharacter: "",
  /** A's published character: public widens reads, never writes. */
  publicCharacter: "",
  /** A ready portrait variant of A's, entity-linked to `character`. */
  variant: "",
  /** B's character + image pair. */
  bCharacter: "",
  bImage: "",
};

async function seedCharacter(ownerId: string, name: string, visibility: "private" | "public" = "private"): Promise<string> {
  const [row] = await db().insert(characters).values({ ownerId, name, visibility }).returning({ id: characters.id });
  if (!row) throw new Error("character insert failed");
  return row.id;
}

async function seedReadyImage(ownerId: string, characterId: string): Promise<string> {
  const [row] = await db()
    .insert(images)
    .values(
      canonicalImageRow({
        ownerId,
        kind: "portrait_variant" as const,
        entityKind: "character" as const,
        entityId: characterId,
        prompt: "a portrait variant",
        status: "ready" as const,
      }),
    )
    .returning({ id: images.id });
  if (!row) throw new Error("image insert failed");
  return row.id;
}

async function avatarOf(characterId: string): Promise<string | null> {
  const [row] = await db()
    .select({ avatarImageId: characters.avatarImageId })
    .from(characters)
    .where(eq(characters.id, characterId))
    .limit(1);
  return row?.avatarImageId ?? null;
}

afterAll(async () => {
  await purgeOwnerRows([ownerA, ownerB]);
  await endTestPool();
});

describe.skipIf(!ready)("promoteVariant ownership", () => {
  beforeAll(async () => {
    ownerA = (await seedTestUser("pv-a")).id;
    ownerB = (await seedTestUser("pv-b")).id;

    fixture.character = await seedCharacter(ownerA, "Promotion target");
    fixture.otherCharacter = await seedCharacter(ownerA, "Second draft");
    fixture.publicCharacter = await seedCharacter(ownerA, "Published author", "public");
    fixture.variant = await seedReadyImage(ownerA, fixture.character);
    fixture.bCharacter = await seedCharacter(ownerB, "B's own character");
    fixture.bImage = await seedReadyImage(ownerB, fixture.bCharacter);
  });

  it("the owner promotes their own ready variant onto their own character", async () => {
    const result = await promoteVariant(fixture.character, fixture.variant, ownerA);
    expect(result.ok).toBe(true);
    expect(await avatarOf(fixture.character)).toBe(fixture.variant);
  });

  it("another user passing the same ids is rejected and the character is unchanged", async () => {
    const before = await avatarOf(fixture.character);
    const result = await promoteVariant(fixture.character, fixture.variant, ownerB);
    expect(result.ok).toBe(false);
    // The character lookup is owner-strict, so B's miss reads as "no such
    // character" — a foreign id and a nonexistent one are indistinguishable.
    expect(result.error).toBe("character not found");
    expect(await promoteVariant(newId(), fixture.variant, ownerB)).toEqual(result);
    expect(await avatarOf(fixture.character)).toBe(before);
  });

  it("the owner supplying ANOTHER user's image id is rejected", async () => {
    // A owns the character, so the route's gate would pass; the image lookup is
    // what rejects, and it reports a plain miss rather than "not yours".
    const before = await avatarOf(fixture.character);
    const result = await promoteVariant(fixture.character, fixture.bImage, ownerA);
    expect(result.ok).toBe(false);
    expect(result.error).toBe("image not found");
    expect(await promoteVariant(fixture.character, newId(), ownerA)).toEqual(result);
    expect(await avatarOf(fixture.character)).toBe(before);
  });

  it("a valid image id under the wrong (but owned) character id is rejected", async () => {
    // Both rows are A's and both exist — only the entity link disagrees, which
    // is the pre-existing eligibility check, kept.
    const result = await promoteVariant(fixture.otherCharacter, fixture.variant, ownerA);
    expect(result.ok).toBe(false);
    expect(result.error).toContain("belong");
    expect(await avatarOf(fixture.otherCharacter)).toBeNull();
  });

  it("a pending image is refused with its status, distinct from an ownership miss", async () => {
    const pending = await seedReadyImage(ownerA, fixture.character);
    await db().update(images).set({ status: "pending" }).where(eq(images.id, pending));
    const result = await promoteVariant(fixture.character, pending, ownerA);
    expect(result.ok).toBe(false);
    expect(result.error).toBe("image status is pending");
  });

  it("repointed polymorphic metadata cannot promote onto a foreign PUBLIC character", async () => {
    // The S5 shape: B rewrites their own image's entityKind/entityId to name A's
    // published character. Nothing about the row is A's, and `public` widens
    // reads only — so neither owner can drive the promotion through.
    await db()
      .update(images)
      .set({ entityKind: "character", entityId: fixture.publicCharacter })
      .where(eq(images.id, fixture.bImage));

    // B: owns the image, but not the character.
    const asB = await promoteVariant(fixture.publicCharacter, fixture.bImage, ownerB);
    expect(asB.ok).toBe(false);
    expect(asB.error).toBe("character not found");

    // A: owns the character, but not the image — even though the image's own
    // metadata now claims to belong to it.
    const asA = await promoteVariant(fixture.publicCharacter, fixture.bImage, ownerA);
    expect(asA.ok).toBe(false);
    expect(asA.error).toBe("image not found");

    expect(await avatarOf(fixture.publicCharacter)).toBeNull();
  });
});
