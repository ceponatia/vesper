import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { cloneToLibrary, findViewable, searchLibraryIds } from "@/server/api";
import { db, socialCards } from "@/server/db";
import { endTestPool, probeIntegrationDb, purgeOwnerRows, seedTestUser } from "@/server/test-support";

// Integration suite for the social-card library reuse slice: the discovery
// `scope` query (owned/public/all), owner-or-public `findViewable`, and
// clone-on-use. Two
// owners so cross-account visibility is exercised. Self-skips when the database
// is unreachable, except under strict integration mode (`pnpm test:int:strict`),
// where it fails instead.

const ready = await probeIntegrationDb("social-cards.int.test", "social_cards");

let ownerA = "";
let ownerB = "";
let privateId: string;
let publicId: string;

const definition = { kind: "taboo" as const, triggers: ["proposition"], severity: 80, reactionOverrides: [] };

afterAll(async () => {
  if (ready) await purgeOwnerRows([ownerA, ownerB]);
  await endTestPool();
});

describe.skipIf(!ready)("social-card library reuse", () => {
  beforeAll(async () => {
    ownerA = (await seedTestUser("sc-a")).id;
    ownerB = (await seedTestUser("sc-b")).id;

    const [priv] = await db()
      .insert(socialCards)
      .values({ ownerId: ownerA, name: "Private rule", definition, visibility: "private" })
      .returning({ id: socialCards.id });
    const [pub] = await db()
      .insert(socialCards)
      .values({ ownerId: ownerA, name: "Public taboo", definition, visibility: "public" })
      .returning({ id: socialCards.id });
    privateId = priv!.id;
    publicId = pub!.id;
  });

  it("owned scope returns the owner's rows (any visibility) and no one else's", async () => {
    const mine = await searchLibraryIds("social_card", ownerA, { scope: "owned" });
    expect(mine).toContain(privateId);
    expect(mine).toContain(publicId);
    const theirs = await searchLibraryIds("social_card", ownerB, { scope: "owned" });
    expect(theirs).not.toContain(privateId);
    expect(theirs).not.toContain(publicId);
  });

  it("public scope surfaces another owner's published card but not their private one", async () => {
    const discover = await searchLibraryIds("social_card", ownerB, { scope: "public" });
    expect(discover).toContain(publicId);
    expect(discover).not.toContain(privateId);
  });

  it("all scope is owner ∪ public", async () => {
    const all = await searchLibraryIds("social_card", ownerB, { scope: "all" });
    expect(all).toContain(publicId);
    expect(all).not.toContain(privateId);
  });

  it("findViewable is owner-or-public — a private card is invisible to others", async () => {
    expect(await findViewable("social_card", publicId, ownerB)).toBeTruthy();
    expect(await findViewable("social_card", privateId, ownerB)).toBeUndefined();
    // the owner still sees their own private card
    expect(await findViewable("social_card", privateId, ownerA)).toBeTruthy();
  });

  it("clone-on-use makes an owned, private copy with clonedFrom provenance", async () => {
    const result = await cloneToLibrary("social_card", publicId, ownerB);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const [copy] = await db().select().from(socialCards).where(eq(socialCards.id, result.id));
    expect(copy?.ownerId).toBe(ownerB);
    expect(copy?.visibility).toBe("private");
    expect(copy?.clonedFromId).toBe(publicId);
    expect(copy?.name).toBe("Public taboo");
    expect(copy?.definition).toMatchObject({ kind: "taboo", severity: 80 });
  });

  it("a non-owner cannot clone a private card (not viewable)", async () => {
    const result = await cloneToLibrary("social_card", privateId, ownerB);
    expect(result).toEqual({ ok: false, code: "not_found" });
  });
});
