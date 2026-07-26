import { eq, inArray, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  findViewable,
  isPublicEntityImage,
  toPublicCharacter,
  toPublicEntityImage,
  toPublicItem,
  toPublicLocation,
  toPublicSocialCard,
} from "@/server/api";
import { characters, db, images, items, locations, socialCards, users } from "@/server/db";

// Integration suite for the public-read hardening (security-authz.plan.md
// slices 3 + 4): the allow-listed public representation a FOREIGN viewer gets
// for each shareable kind, and the ownership binding on public-entity image
// access. The key-set assertions are the point — they are the tripwire that
// makes adding a column to one of these tables a deliberate decision about the
// public surface rather than a silent widening of it. Two owners so every
// cross-account case is exercised. Self-skips when the database is unreachable.

async function probe(): Promise<boolean> {
  let timer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      db().execute(sql`select 1 from characters limit 1`),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error("connect timeout")), 4000);
      }),
    ]);
    return true;
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    process.stderr.write(`[public-dto.int.test] skipping — database unreachable or unmigrated: ${reason}\n`);
    return false;
  } finally {
    clearTimeout(timer);
  }
}

const ready = await probe();

/** The author. */
let ownerA: string;
/** The foreign viewer — sees only the public representation. */
let ownerB: string;

let publicCharacterId: string;
let privateCharacterId: string;
let publicLocationId: string;
let publicItemId: string;
let publicSocialCardId: string;
/** A's own art on A's public character — the legitimate cross-owner read. */
let authorImageId: string;
/** B's own image, mislabelled as belonging to A's public character. */
let impostorImageId: string;

afterAll(async () => {
  if (ready) {
    const owners = [ownerA, ownerB].filter(Boolean);
    if (owners.length > 0) {
      await db().delete(images).where(inArray(images.ownerId, owners));
      await db().delete(characters).where(inArray(characters.ownerId, owners));
      await db().delete(locations).where(inArray(locations.ownerId, owners));
      await db().delete(items).where(inArray(items.ownerId, owners));
      await db().delete(socialCards).where(inArray(socialCards.ownerId, owners));
      await db().delete(users).where(inArray(users.id, owners));
    }
  }
  await globalThis.__vesperPool?.end();
  globalThis.__vesperPool = undefined;
});

describe.skipIf(!ready)("public representations for foreign viewers", () => {
  beforeAll(async () => {
    const stamp = Date.now();
    const [a] = await db().insert(users).values({ email: `pd-a-${stamp}@test.local`, name: "PD A" }).returning({ id: users.id });
    const [b] = await db().insert(users).values({ email: `pd-b-${stamp}@test.local`, name: "PD B" }).returning({ id: users.id });
    if (!a || !b) throw new Error("user insert failed");
    ownerA = a.id;
    ownerB = b.id;

    const [pubChar] = await db()
      .insert(characters)
      .values({ ownerId: ownerA, name: "Public author", profile: { bio: "published" }, visibility: "public" })
      .returning({ id: characters.id });
    const [privChar] = await db()
      .insert(characters)
      .values({ ownerId: ownerA, name: "Private draft", visibility: "private" })
      .returning({ id: characters.id });
    const [pubLoc] = await db()
      .insert(locations)
      .values({ ownerId: ownerA, name: "Public terrace", description: "overlooking the bay", visibility: "public" })
      .returning({ id: locations.id });
    const [pubItem] = await db()
      .insert(items)
      .values({ ownerId: ownerA, kind: "clothing", name: "Public coat", description: "wool", visibility: "public" })
      .returning({ id: items.id });
    const [pubCard] = await db()
      .insert(socialCards)
      .values({
        ownerId: ownerA,
        name: "Public taboo",
        definition: { kind: "taboo", triggers: ["proposition"], severity: 80, reactionOverrides: [] },
        visibility: "public",
      })
      .returning({ id: socialCards.id });
    publicCharacterId = pubChar!.id;
    privateCharacterId = privChar!.id;
    publicLocationId = pubLoc!.id;
    publicItemId = pubItem!.id;
    publicSocialCardId = pubCard!.id;

    const [authorImage] = await db()
      .insert(images)
      .values({
        ownerId: ownerA,
        kind: "avatar",
        entityKind: "character",
        entityId: publicCharacterId,
        path: `images/${ownerA}/author.webp`,
        prompt: "the author's private generation prompt",
        status: "ready",
      })
      .returning({ id: images.id });
    // The slice-3 attack shape: B writes A's public character into their OWN
    // image's polymorphic metadata. Nothing about the row is A's.
    const [impostorImage] = await db()
      .insert(images)
      .values({
        ownerId: ownerB,
        kind: "avatar",
        entityKind: "character",
        entityId: publicCharacterId,
        path: `images/${ownerB}/impostor.webp`,
        status: "ready",
      })
      .returning({ id: images.id });
    authorImageId = authorImage!.id;
    impostorImageId = impostorImage!.id;
  });

  it("a foreign public character is exactly the allow-listed keys", async () => {
    const row = await findViewable("character", publicCharacterId, ownerB);
    expect(row).toBeTruthy();
    expect(Object.keys(toPublicCharacter(row!)).sort()).toEqual([
      "avatarImageId",
      "createdAt",
      "id",
      "name",
      "profile",
      "tags",
      "visibility",
    ]);
  });

  it("a foreign public location is exactly the allow-listed keys", async () => {
    const row = await findViewable("location", publicLocationId, ownerB);
    expect(row).toBeTruthy();
    expect(Object.keys(toPublicLocation(row!)).sort()).toEqual([
      "affordances",
      "ambient",
      "area",
      "createdAt",
      "description",
      "id",
      "imageId",
      "name",
      "scale",
      "tags",
      "visibility",
    ]);
  });

  it("a foreign public item is exactly the allow-listed keys", async () => {
    const row = await findViewable("item", publicItemId, ownerB);
    expect(row).toBeTruthy();
    expect(Object.keys(toPublicItem(row!)).sort()).toEqual([
      "createdAt",
      "definition",
      "description",
      "id",
      "imageId",
      "kind",
      "name",
      "tags",
      "visibility",
    ]);
  });

  it("a foreign public social card is exactly the allow-listed keys", async () => {
    const row = await findViewable("social_card", publicSocialCardId, ownerB);
    expect(row).toBeTruthy();
    expect(Object.keys(toPublicSocialCard(row!)).sort()).toEqual([
      "createdAt",
      "definition",
      "description",
      "id",
      "name",
      "tags",
      "visibility",
    ]);
  });

  it("the portrait shape carries no path, prompt or provider internals", async () => {
    const [row] = await db().select().from(images).where(eq(images.id, authorImageId)).limit(1);
    expect(row).toBeTruthy();
    const projected = toPublicEntityImage(row!);
    expect(Object.keys(projected).sort()).toEqual(["createdAt", "entityId", "entityKind", "id", "kind"]);
    // The row it came from really did carry the sensitive columns.
    expect(row!.prompt).toContain("prompt");
    expect(row!.path.length).toBeGreaterThan(0);
  });

  it("public-entity image access is bound to matching ownership (slice 3)", async () => {
    // The author's own art on their own published character — the case the
    // cross-owner widening exists for.
    expect(await isPublicEntityImage("character", publicCharacterId, ownerA)).toBe(true);
    // Another user's image merely NAMING that public character is not covered.
    expect(await isPublicEntityImage("character", publicCharacterId, ownerB)).toBe(false);
    // A private entity never widens, not even for its own owner.
    expect(await isPublicEntityImage("character", privateCharacterId, ownerA)).toBe(false);
    // Non-shareable kinds and unlinked images stay owner-only.
    expect(await isPublicEntityImage("world", publicCharacterId, ownerA)).toBe(false);
    expect(await isPublicEntityImage("character", null, ownerA)).toBe(false);
  });

  it("the impostor image is owned by B, so only B's own-owner rule can serve it", async () => {
    const [row] = await db().select().from(images).where(eq(images.id, impostorImageId)).limit(1);
    expect(row?.ownerId).toBe(ownerB);
    // The file route's gate is `row.ownerId === user.id || isPublicEntityImage(...)`;
    // with ownership bound, the second half is false for every viewer here.
    expect(await isPublicEntityImage(row!.entityKind, row!.entityId, row!.ownerId)).toBe(false);
  });
});
