import { and, eq, inArray } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { newId } from "@/lib/ids";
import {
  findViewable,
  isPublicEntityImage,
  searchLibraryIds,
  toPublicCharacter,
  toPublicEntityImage,
  toPublicItem,
  toPublicLocation,
  toPublicSocialCard,
} from "@/server/api";
import { deleteChat } from "@/server/engine";
import { deleteOwnedImage, promoteVariant } from "@/server/images";
import {
  characterChatMessages,
  characterChats,
  characters,
  chatParticipants,
  db,
  images,
  items,
  locations,
  personas,
  simBranches,
  simWorlds,
  socialCards,
  users,
} from "@/server/db";
import { probeIntegrationDb } from "@/server/test-support";
// The ownership gates these rows drive live in the route tree rather than a
// server barrel (`src/app/api/**/owned.ts`), but they are plain exported async
// functions, so the matrix calls the REAL seam the route calls instead of a
// replica. Predicates that were module-private when the matrix was written
// (`findPortrait`, `findPersona`, the chat-creation roster query) were lifted
// into these colocated `owned.ts` modules for exactly that reason — a secure
// test copy can drift away from an insecure route original.
import { loadOwnedChat, loadOwnedRoster } from "../../app/api/chats/owned";
import { requireSimChat } from "../../app/api/chats/[chatId]/sim-shared";
import { findOwnedCharacter } from "../../app/api/characters/[id]/owned";
import { findPortrait, listOwnedPortraits } from "../../app/api/characters/[id]/portraits/owned";
import { findPersona } from "../../app/api/personas/[id]/owned";

// =============================================================================
// The two-user authorization matrix (security-authz.plan.md slice 5 / S7).
//
// Two owners are seeded once — A authors everything, B is the adversary — and
// every owned resource reachable at the server-API seam is run through the same
// four questions:
//
//   read private   owner finds it            · other gets nothing (404-shaped)
//   read public    owner gets the full row   · other gets the allow-listed keys
//   update         owner writes              · other matches zero rows, and the
//                                              row stays byte-identical
//   delete         owner removes             · other matches zero rows
//   child rows     a child is unreachable through a foreign parent, AND a valid
//                  child id under the WRONG parent id resolves to nothing
//
// CONVENTION — every new owned resource adds its matrix row in the SAME change
// that adds the route. A resource that appears in `src/app/api/**` without a row
// here is an untested authorization surface; the matrix is the regression net
// that makes "did anyone remember to write the cross-user case?" a non-question.
// If a resource is enforceable only through a route handler that is awkward to
// invoke here, test the server-side query seam the route uses and name the route
// in a comment (the pattern the other int suites follow).
//
// Self-skips when the database is unreachable — EXCEPT under strict integration
// mode (`pnpm test:int:strict`, i.e. REQUIRE_INTEGRATION_DB=true), where an
// unreachable database fails the suite instead. A release gate that skips the
// whole authorization matrix is worse than no gate.
// =============================================================================

process.env.AI_FAKE = "1";

const ready = await probeIntegrationDb("authz-matrix.int.test", "characters");

/** The author. Owns every fixture unless a case says otherwise. */
let ownerA = "";
/** The adversary. Owns exactly one character and one image, so "B has a legitimate
 *  home for this id" cases (foreign image onto own character) are expressible. */
let ownerB = "";

/** Ids seeded once for the read/adversarial cases (the write cases seed per-test). */
const fixture = {
  publicCharacter: "",
  privateCharacter: "",
  otherPrivateCharacter: "",
  publicLocation: "",
  publicItem: "",
  publicSocialCard: "",
  /** A's portrait, entity-linked to `privateCharacter`. */
  portrait: "",
  /** A's legacy chat, with one participant and one message. */
  chat: "",
  chatMessage: "",
  /** A's second chat — the wrong-parent target for the message case. */
  otherChat: "",
  /** A's successor chat, branch-linked and actor-mapped. */
  successorChat: "",
  world: "",
  branch: "",
  /** B's own character + image — the "legitimate home for a foreign id" pair. */
  bCharacter: "",
  bImage: "",
};

let seq = 0;
/** Unique-per-call label; `personas` carries a (ownerId, title) unique index. */
function label(what: string): string {
  seq += 1;
  return `authz ${what} ${Date.now()}-${seq}`;
}

async function seedCharacter(ownerId: string, name: string, visibility: "private" | "public" = "private"): Promise<string> {
  const [row] = await db().insert(characters).values({ ownerId, name, visibility }).returning({ id: characters.id });
  if (!row) throw new Error("character insert failed");
  return row.id;
}

/** A chat needs a character and a participant row — `loadOwnedChat` inner-joins both. */
async function seedChat(ownerId: string, title: string): Promise<{ chatId: string; characterId: string }> {
  const characterId = await seedCharacter(ownerId, `${title} cast`);
  const [chat] = await db().insert(characterChats).values({ ownerId, title }).returning({ id: characterChats.id });
  if (!chat) throw new Error("chat insert failed");
  await db().insert(chatParticipants).values({ chatId: chat.id, characterId, memoryGroupId: newId(), sort: 0 });
  return { chatId: chat.id, characterId };
}

afterAll(async () => {
  if (ready) {
    const owners = [ownerA, ownerB].filter(Boolean);
    if (owners.length > 0) {
      // Chats first (they cascade participants + messages and hold the branch
      // link), then images, then the entities images/participants point at.
      await db().delete(characterChats).where(inArray(characterChats.ownerId, owners));
      await db().delete(images).where(inArray(images.ownerId, owners));
      await db().delete(characters).where(inArray(characters.ownerId, owners));
      await db().delete(locations).where(inArray(locations.ownerId, owners));
      await db().delete(items).where(inArray(items.ownerId, owners));
      await db().delete(socialCards).where(inArray(socialCards.ownerId, owners));
      await db().delete(personas).where(inArray(personas.ownerId, owners));
      if (fixture.world) await db().delete(simWorlds).where(eq(simWorlds.id, fixture.world)); // cascades branches
      await db().delete(users).where(inArray(users.id, owners));
    }
  }
  await globalThis.__vesperPool?.end();
  globalThis.__vesperPool = undefined;
});

beforeAll(async () => {
  if (!ready) return;
  const stamp = Date.now();
  const [a] = await db().insert(users).values({ email: `authz-a-${stamp}@test.local`, name: "Authz A" }).returning({ id: users.id });
  const [b] = await db().insert(users).values({ email: `authz-b-${stamp}@test.local`, name: "Authz B" }).returning({ id: users.id });
  if (!a || !b) throw new Error("user insert failed");
  ownerA = a.id;
  ownerB = b.id;

  fixture.publicCharacter = await seedCharacter(ownerA, "Published author", "public");
  fixture.privateCharacter = await seedCharacter(ownerA, "Private draft");
  fixture.otherPrivateCharacter = await seedCharacter(ownerA, "Second private draft");
  fixture.bCharacter = await seedCharacter(ownerB, "B's own character");

  const [loc] = await db()
    .insert(locations)
    .values({ ownerId: ownerA, name: "Published terrace", description: "overlooking the bay", visibility: "public" })
    .returning({ id: locations.id });
  const [item] = await db()
    .insert(items)
    .values({ ownerId: ownerA, kind: "clothing", name: "Published coat", description: "wool", visibility: "public" })
    .returning({ id: items.id });
  const [card] = await db()
    .insert(socialCards)
    .values({
      ownerId: ownerA,
      name: "Published taboo",
      definition: { kind: "taboo", triggers: ["proposition"], severity: 80, reactionOverrides: [] },
      visibility: "public",
    })
    .returning({ id: socialCards.id });
  fixture.publicLocation = loc!.id;
  fixture.publicItem = item!.id;
  fixture.publicSocialCard = card!.id;

  const [portrait] = await db()
    .insert(images)
    .values({
      ownerId: ownerA,
      kind: "portrait_variant",
      entityKind: "character",
      entityId: fixture.privateCharacter,
      path: `images/${ownerA}/portrait.webp`,
      prompt: "the author's private generation prompt",
      status: "ready",
    })
    .returning({ id: images.id });
  const [bImage] = await db()
    .insert(images)
    .values({
      ownerId: ownerB,
      kind: "portrait_variant",
      entityKind: "character",
      entityId: fixture.bCharacter,
      path: `images/${ownerB}/own.webp`,
      status: "ready",
    })
    .returning({ id: images.id });
  fixture.portrait = portrait!.id;
  fixture.bImage = bImage!.id;

  const main = await seedChat(ownerA, "A's conversation");
  fixture.chat = main.chatId;
  const [msg] = await db()
    .insert(characterChatMessages)
    .values({ chatId: fixture.chat, role: "user", content: "a private line of A's transcript" })
    .returning({ id: characterChatMessages.id });
  fixture.chatMessage = msg!.id;
  fixture.otherChat = (await seedChat(ownerA, "A's other conversation")).chatId;

  // The successor lane: a world + root branch, and a chat routed onto it. The
  // chat row is the ONLY ownership anchor for the whole successor surface —
  // `sim_worlds` and `sim_branches` carry no owner column.
  fixture.world = newId();
  fixture.branch = newId();
  await db()
    .insert(simWorlds)
    .values({ id: fixture.world, worldTypeId: "authz-matrix", seed: "authz", rulesetVersion: "test" });
  await db().insert(simBranches).values({ id: fixture.branch, worldId: fixture.world });
  const successor = await seedChat(ownerA, "A's successor world");
  fixture.successorChat = successor.chatId;
  await db()
    .update(characterChats)
    .set({
      engineAuthority: "successor_narrative_view",
      simBranchId: fixture.branch,
      simPlayerActorId: "authz-actor-player",
      simPrimaryActorId: "authz-actor-primary",
    })
    .where(eq(characterChats.id, fixture.successorChat));
});

// -----------------------------------------------------------------------------
// The uniform matrix: private read, foreign update, foreign delete — one row per
// owned resource. Each case seeds its OWN row so the operations never couple.
// -----------------------------------------------------------------------------

interface OwnedResource {
  /** The matrix row's name — the resource as the routes name it. */
  resource: string;
  /** Insert one row owned by `ownerId`. */
  seed: (ownerId: string) => Promise<string>;
  /** The owner-scoped read every route runs first; falsy ⇒ the route 404s. */
  read: (id: string, userId: string) => Promise<unknown>;
  /** The owner-scoped UPDATE a PATCH route writes. Returns the ids actually written. */
  update: (id: string, userId: string) => Promise<string[]>;
  /** The owner-scoped DELETE a DELETE route writes. Returns the ids actually removed. */
  remove: (id: string, userId: string) => Promise<string[]>;
  /** The persisted row with ownership IGNORED — the byte-identity witness. */
  raw: (id: string) => Promise<unknown>;
}

const resources: OwnedResource[] = [
  {
    resource: "character",
    seed: (ownerId) => seedCharacter(ownerId, label("character")),
    // src/app/api/characters/[id]/route.ts writes go through findOwnedCharacter;
    // reads widen to owner-or-public via findViewable (a private row stays owner-only).
    read: (id, userId) => findViewable("character", id, userId),
    update: async (id, userId) =>
      (
        await db()
          .update(characters)
          .set({ name: "tampered" })
          .where(and(eq(characters.id, id), eq(characters.ownerId, userId)))
          .returning({ id: characters.id })
      ).map((r) => r.id),
    remove: async (id, userId) =>
      (
        await db()
          .delete(characters)
          .where(and(eq(characters.id, id), eq(characters.ownerId, userId)))
          .returning({ id: characters.id })
      ).map((r) => r.id),
    raw: async (id) => (await db().select().from(characters).where(eq(characters.id, id)).limit(1))[0],
  },
  {
    resource: "location",
    seed: async (ownerId) => {
      const [row] = await db().insert(locations).values({ ownerId, name: label("location") }).returning({ id: locations.id });
      return row!.id;
    },
    read: (id, userId) => findViewable("location", id, userId),
    update: async (id, userId) =>
      (
        await db()
          .update(locations)
          .set({ name: "tampered" })
          .where(and(eq(locations.id, id), eq(locations.ownerId, userId)))
          .returning({ id: locations.id })
      ).map((r) => r.id),
    remove: async (id, userId) =>
      (
        await db()
          .delete(locations)
          .where(and(eq(locations.id, id), eq(locations.ownerId, userId)))
          .returning({ id: locations.id })
      ).map((r) => r.id),
    raw: async (id) => (await db().select().from(locations).where(eq(locations.id, id)).limit(1))[0],
  },
  {
    resource: "item",
    seed: async (ownerId) => {
      const [row] = await db()
        .insert(items)
        .values({ ownerId, kind: "clothing", name: label("item") })
        .returning({ id: items.id });
      return row!.id;
    },
    read: (id, userId) => findViewable("item", id, userId),
    update: async (id, userId) =>
      (
        await db()
          .update(items)
          .set({ name: "tampered" })
          .where(and(eq(items.id, id), eq(items.ownerId, userId)))
          .returning({ id: items.id })
      ).map((r) => r.id),
    remove: async (id, userId) =>
      (
        await db()
          .delete(items)
          .where(and(eq(items.id, id), eq(items.ownerId, userId)))
          .returning({ id: items.id })
      ).map((r) => r.id),
    raw: async (id) => (await db().select().from(items).where(eq(items.id, id)).limit(1))[0],
  },
  {
    resource: "social_card",
    seed: async (ownerId) => {
      const [row] = await db()
        .insert(socialCards)
        .values({
          ownerId,
          name: label("card"),
          definition: { kind: "taboo", triggers: ["proposition"], severity: 40, reactionOverrides: [] },
        })
        .returning({ id: socialCards.id });
      return row!.id;
    },
    read: (id, userId) => findViewable("social_card", id, userId),
    update: async (id, userId) =>
      (
        await db()
          .update(socialCards)
          .set({ name: "tampered" })
          .where(and(eq(socialCards.id, id), eq(socialCards.ownerId, userId)))
          .returning({ id: socialCards.id })
      ).map((r) => r.id),
    remove: async (id, userId) =>
      (
        await db()
          .delete(socialCards)
          .where(and(eq(socialCards.id, id), eq(socialCards.ownerId, userId)))
          .returning({ id: socialCards.id })
      ).map((r) => r.id),
    raw: async (id) => (await db().select().from(socialCards).where(eq(socialCards.id, id)).limit(1))[0],
  },
  {
    // Personas are owner-STRICT: no `visibility` column, so they never widen.
    // The real seam: `findPersona` (src/app/api/personas/[id]/owned.ts) is the
    // lookup every /api/personas/[id] verb runs before doing anything.
    resource: "persona",
    seed: async (ownerId) => {
      const title = label("persona");
      const [row] = await db().insert(personas).values({ ownerId, title, name: "Persona" }).returning({ id: personas.id });
      return row!.id;
    },
    read: (id, userId) => findPersona(userId, id),
    update: async (id, userId) =>
      (
        await db()
          .update(personas)
          .set({ name: "tampered" })
          .where(and(eq(personas.id, id), eq(personas.ownerId, userId)))
          .returning({ id: personas.id })
      ).map((r) => r.id),
    remove: async (id, userId) =>
      (
        await db()
          .delete(personas)
          .where(and(eq(personas.id, id), eq(personas.ownerId, userId)))
          .returning({ id: personas.id })
      ).map((r) => r.id),
    raw: async (id) => (await db().select().from(personas).where(eq(personas.id, id)).limit(1))[0],
  },
  {
    // Images are owner-strict on every owned path; the ONE widening is the
    // public-entity file read, covered separately below.
    resource: "image",
    seed: async (ownerId) => {
      const [row] = await db()
        .insert(images)
        .values({ ownerId, kind: "scene", path: `images/${ownerId}/${newId()}.webp`, status: "ready" })
        .returning({ id: images.id });
      return row!.id;
    },
    read: async (id, userId) =>
      (await db().select().from(images).where(and(eq(images.id, id), eq(images.ownerId, userId))).limit(1))[0],
    update: async (id, userId) =>
      (
        await db()
          .update(images)
          .set({ favorite: true })
          .where(and(eq(images.id, id), eq(images.ownerId, userId)))
          .returning({ id: images.id })
      ).map((r) => r.id),
    // The real exported seam (`@/server/images`), not a replica.
    remove: async (id, userId) => ((await deleteOwnedImage(id, userId)) ? [id] : []),
    raw: async (id) => (await db().select().from(images).where(eq(images.id, id)).limit(1))[0],
  },
  {
    resource: "character_chat",
    seed: async (ownerId) => (await seedChat(ownerId, label("chat"))).chatId,
    read: (id, userId) => loadOwnedChat(id, userId),
    update: async (id, userId) =>
      (
        await db()
          .update(characterChats)
          .set({ title: "tampered" })
          .where(and(eq(characterChats.id, id), eq(characterChats.ownerId, userId)))
          .returning({ id: characterChats.id })
      ).map((r) => r.id),
    // slice 2: deleteChat re-reads the chat under (id, ownerId) and no-ops with a
    // `chat.delete_denied` warn when nothing matches — it no longer trusts a
    // caller-supplied ownerId.
    remove: async (id, userId) => {
      await deleteChat(id, userId);
      const [still] = await db().select({ id: characterChats.id }).from(characterChats).where(eq(characterChats.id, id)).limit(1);
      return still ? [] : [id];
    },
    raw: async (id) => (await db().select().from(characterChats).where(eq(characterChats.id, id)).limit(1))[0],
  },
];

describe.skipIf(!ready)("authorization matrix — owned resources", () => {
  for (const res of resources) {
    describe(res.resource, () => {
      it("read private: the owner finds it, the other user gets nothing", async () => {
        const id = await res.seed(ownerA);
        expect(await res.read(id, ownerA)).toBeTruthy();
        // 404-shaped at each seam's own contract: undefined (drizzle destructure)
        // or null (loadOwnedChat). Never an "exists but forbidden" signal.
        expect(await res.read(id, ownerB)).toBeFalsy();
      });

      it("update: the owner writes; the other user matches zero rows and the row is byte-identical", async () => {
        const id = await res.seed(ownerA);
        const before = await res.raw(id);
        expect(before).toBeTruthy();

        expect(await res.update(id, ownerB)).toEqual([]);
        expect(await res.raw(id)).toEqual(before);

        expect(await res.update(id, ownerA)).toEqual([id]);
        expect(await res.raw(id)).not.toEqual(before);
      });

      it("delete: the other user removes nothing; the owner removes the row", async () => {
        const id = await res.seed(ownerA);
        expect(await res.remove(id, ownerB)).toEqual([]);
        expect(await res.raw(id)).toBeTruthy();

        expect(await res.remove(id, ownerA)).toEqual([id]);
        expect(await res.raw(id)).toBeUndefined();
      });
    });
  }
});

// -----------------------------------------------------------------------------
// Read public: the owner gets the persisted row, a foreign viewer gets EXACTLY
// the allow-listed keys (slice 4's enumeration, folded into the matrix). Adding
// a column to one of these tables must be a deliberate decision about the public
// surface — these key sets are the tripwire.
// -----------------------------------------------------------------------------

interface ShareableView {
  ownerId: string;
  /** Keys of the public projection, sorted. */
  publicKeys: string[];
  /** Keys of the raw persisted row, sorted. */
  rowKeys: string[];
}

const shareables: {
  /** Doubles as the `searchLibraryIds` kind — the discovery seam's vocabulary. */
  resource: "character" | "location" | "item" | "social_card";
  publicKeys: string[];
  publicId: () => string;
  privateId: () => string | undefined;
  view: (id: string, viewer: string) => Promise<ShareableView | undefined>;
}[] = [
  {
    resource: "character",
    publicKeys: ["avatarImageId", "createdAt", "id", "name", "profile", "tags", "visibility"],
    publicId: () => fixture.publicCharacter,
    privateId: () => fixture.privateCharacter,
    view: async (id, viewer) => {
      const row = await findViewable("character", id, viewer);
      return row && { ownerId: row.ownerId, publicKeys: Object.keys(toPublicCharacter(row)).sort(), rowKeys: Object.keys(row).sort() };
    },
  },
  {
    resource: "location",
    publicKeys: ["affordances", "ambient", "area", "createdAt", "description", "id", "imageId", "name", "scale", "tags", "visibility"],
    publicId: () => fixture.publicLocation,
    privateId: () => undefined,
    view: async (id, viewer) => {
      const row = await findViewable("location", id, viewer);
      return row && { ownerId: row.ownerId, publicKeys: Object.keys(toPublicLocation(row)).sort(), rowKeys: Object.keys(row).sort() };
    },
  },
  {
    resource: "item",
    publicKeys: ["createdAt", "definition", "description", "id", "imageId", "kind", "name", "tags", "visibility"],
    publicId: () => fixture.publicItem,
    privateId: () => undefined,
    view: async (id, viewer) => {
      const row = await findViewable("item", id, viewer);
      return row && { ownerId: row.ownerId, publicKeys: Object.keys(toPublicItem(row)).sort(), rowKeys: Object.keys(row).sort() };
    },
  },
  {
    resource: "social_card",
    publicKeys: ["createdAt", "definition", "description", "id", "name", "tags", "visibility"],
    publicId: () => fixture.publicSocialCard,
    privateId: () => undefined,
    view: async (id, viewer) => {
      const row = await findViewable("social_card", id, viewer);
      return row && { ownerId: row.ownerId, publicKeys: Object.keys(toPublicSocialCard(row)).sort(), rowKeys: Object.keys(row).sort() };
    },
  },
];

describe.skipIf(!ready)("authorization matrix — public reads", () => {
  for (const kind of shareables) {
    it(`${kind.resource}: the owner gets the full row, a foreign viewer gets the allow-listed keys`, async () => {
      const owner = await kind.view(kind.publicId(), ownerA);
      expect(owner?.ownerId).toBe(ownerA);
      // The owner's read is the persisted row — the edit surfaces need it.
      expect(owner?.rowKeys).toContain("ownerId");
      expect(owner?.rowKeys.length).toBeGreaterThan(kind.publicKeys.length);

      const foreign = await kind.view(kind.publicId(), ownerB);
      expect(foreign).toBeTruthy();
      expect(foreign?.publicKeys).toEqual(kind.publicKeys);
      // The narrowing is real, not cosmetic: never the owner id, never the
      // retrieval vectors, never a column added after this list was written.
      expect(foreign?.publicKeys).not.toContain("ownerId");
      expect(foreign?.publicKeys).not.toContain("searchEmbedding");
    });

    it(`${kind.resource}: the public row is discoverable to B, a private sibling is not`, async () => {
      const discovered = await searchLibraryIds(kind.resource, ownerB, { scope: "public" });
      expect(discovered).toContain(kind.publicId());
      const priv = kind.privateId();
      if (priv) expect(discovered).not.toContain(priv);
    });
  }

  it("a private entity is invisible to a foreign viewer at the read seam", async () => {
    expect(await findViewable("character", fixture.privateCharacter, ownerB)).toBeUndefined();
    expect(await findViewable("character", fixture.privateCharacter, ownerA)).toBeTruthy();
  });

  it("the portrait projection carries no path, prompt or provider internals", async () => {
    const [row] = await db().select().from(images).where(eq(images.id, fixture.portrait)).limit(1);
    expect(Object.keys(toPublicEntityImage(row!)).sort()).toEqual(["createdAt", "entityId", "entityKind", "id", "kind"]);
    expect(row!.prompt).toContain("prompt"); // the row really did carry the sensitive columns
  });
});

// -----------------------------------------------------------------------------
// Child resources: reachable only through a parent the caller owns, and never
// under a parent they merely name.
// -----------------------------------------------------------------------------

describe.skipIf(!ready)("authorization matrix — child resources", () => {
  it("B cannot read A's portraits through the owner-scoped seam", async () => {
    // `findPortrait` (src/app/api/characters/[id]/portraits/owned.ts) is the real
    // lookup GET/DELETE of portraits/[imageId] run: the image must be the
    // caller's AND entity-linked to the parent character in the URL.
    expect(await findPortrait(ownerA, fixture.privateCharacter, fixture.portrait)).toBeTruthy();
    expect(await findPortrait(ownerB, fixture.privateCharacter, fixture.portrait)).toBeUndefined();
  });

  it("a valid portrait id under the wrong parent character resolves to nothing", async () => {
    // Even for the owner: the child is addressed as (parent, child), so a real
    // portrait id hung off a different character of A's own is still a miss.
    expect(await findPortrait(ownerA, fixture.otherPrivateCharacter, fixture.portrait)).toBeUndefined();
  });

  it("B cannot list A's portraits — the studio list is scoped to the VIEWER's images", async () => {
    // src/app/api/characters/[id]/portraits/route.ts GET is two owner-scoped
    // halves: the findOwnedCharacter gate, then `listOwnedPortraits` (the same
    // module, `./owned`) keyed on the VIEWER's images + the entity link. Both
    // must miss for B, so neither alone leaks a foreign roster.
    expect(await findOwnedCharacter(fixture.privateCharacter, ownerB)).toBeUndefined();
    expect(await listOwnedPortraits(ownerB, fixture.privateCharacter)).toEqual([]);
    // The owner's own list is the case the seam exists for.
    expect((await listOwnedPortraits(ownerA, fixture.privateCharacter)).map((row) => row.id)).toContain(fixture.portrait);
  });

  it("B cannot reach A's chat messages: the chat gate blocks, and the message is chat-scoped", async () => {
    // Messages carry no ownerId — ownership is established once, by the chat
    // gate, and the transcript query is then chat-scoped
    // (src/app/api/chats/[chatId]/route.ts GET).
    expect(await loadOwnedChat(fixture.chat, ownerB)).toBeNull();
    const underOwnChat = await db()
      .select({ id: characterChatMessages.id })
      .from(characterChatMessages)
      .where(and(eq(characterChatMessages.id, fixture.chatMessage), eq(characterChatMessages.chatId, fixture.chat)));
    expect(underOwnChat).toHaveLength(1);
  });

  it("a valid message id under the wrong parent chat resolves to nothing", async () => {
    const underWrongChat = await db()
      .select({ id: characterChatMessages.id })
      .from(characterChatMessages)
      .where(and(eq(characterChatMessages.id, fixture.chatMessage), eq(characterChatMessages.chatId, fixture.otherChat)));
    expect(underWrongChat).toEqual([]);
  });
});

// -----------------------------------------------------------------------------
// The security review's named adversarial cases, as explicit rows.
// -----------------------------------------------------------------------------

describe.skipIf(!ready)("authorization matrix — adversarial cases", () => {
  it("B requests A's chat by UUID through the chat-loading seam", async () => {
    // Knowing the id is worth nothing: the gate every /api/chats/[chatId] verb
    // runs first matches (id, ownerId) in ONE query, so a foreign id and a
    // nonexistent id are indistinguishable to the caller.
    expect(await loadOwnedChat(fixture.chat, ownerB)).toBeNull();
    expect(await loadOwnedChat(newId(), ownerB)).toBeNull();
    expect(await loadOwnedChat(fixture.chat, ownerA)).not.toBeNull();
  });

  it("B supplies A's character id at chat creation", async () => {
    // `loadOwnedRoster` (src/app/api/chats/owned.ts) IS the create gate: POST
    // /api/chats 404s `character not found` on its null. The roster is fetched
    // owner-strict and the count must match the request exactly, so one foreign
    // id fails the whole create.
    expect(await loadOwnedRoster(ownerB, [fixture.privateCharacter])).toBeNull();

    // The subtler shape: B smuggles A's character in beside their own. The
    // count mismatch (1 owned, 2 requested) is what rejects it — a partial
    // roster must never become a chat.
    expect(await loadOwnedRoster(ownerB, [fixture.bCharacter, fixture.privateCharacter])).toBeNull();
    // A's public character is no better: public widens READS, never writes.
    expect(await loadOwnedRoster(ownerB, [fixture.publicCharacter])).toBeNull();

    // B's own character is the case the seam exists for, in selection order.
    const own = await loadOwnedRoster(ownerB, [fixture.bCharacter]);
    expect(own?.map((c) => c.id)).toEqual([fixture.bCharacter]);
  });

  it("B supplies a foreign image id in a context expecting their own", async () => {
    // Owner-strict delete: A's image is untouchable and survives byte-identical.
    const before = await db().select().from(images).where(eq(images.id, fixture.portrait)).limit(1);
    expect(await deleteOwnedImage(fixture.portrait, ownerB)).toBe(false);
    expect(await db().select().from(images).where(eq(images.id, fixture.portrait)).limit(1)).toEqual(before);

    // Promotion binds image → character by the entity link AND matches both
    // rows against the caller's owner id (security-authz.plan.md §Follow-ups
    // item 2), so B cannot mount A's portrait onto B's own character even
    // though B owns the character. The owner-strict image lookup is the first
    // predicate to fail, so the miss is indistinguishable from a nonexistent
    // id — no "that image exists but isn't yours" signal.
    const promoted = await promoteVariant(fixture.bCharacter, fixture.portrait, ownerB);
    expect(promoted.ok).toBe(false);
    expect(promoted.ok ? "" : (promoted.error ?? "")).toBe("image not found");
    expect(await promoteVariant(fixture.bCharacter, newId(), ownerB)).toEqual(promoted);

    // A owning the image is not enough either: the character must be A's too,
    // so the mirror attempt (A's image, A's caller, B's character) also fails.
    expect((await promoteVariant(fixture.bCharacter, fixture.portrait, ownerA)).ok).toBe(false);

    // B's character survives every attempt with no avatar mounted.
    const [bChar] = await db().select({ avatarImageId: characters.avatarImageId }).from(characters).where(eq(characters.id, fixture.bCharacter));
    expect(bChar?.avatarImageId).toBeNull();

    // And B's own image on B's own character is the case the seam exists for.
    expect((await promoteVariant(fixture.bCharacter, fixture.bImage, ownerB)).ok).toBe(true);
  });

  it("B issues a command against A's successor branch id", async () => {
    // src/app/api/chats/[chatId]/sim-command/route.ts gates on requireSimChat
    // and nothing else, so requireSimChat IS the successor authorization seam.
    // (The durable layer beneath it — submitDurable*/runSimulationCommand — is
    // deliberately ownership-blind: it takes a branchId and a principal envelope
    // and never sees a user. That is why this row matters.)
    const owner = await requireSimChat(fixture.successorChat, ownerA);
    expect(owner.ok).toBe(true);
    if (owner.ok) expect(owner.sim.branchId).toBe(fixture.branch);

    const foreign = await requireSimChat(fixture.successorChat, ownerB);
    expect(foreign.ok).toBe(false);
    if (!foreign.ok) expect(foreign.response.status).toBe(404);
  });

  it("a successor branch is reachable only through a chat its requester owns", async () => {
    // sim_worlds and sim_branches carry NO owner column — character_chats.owner_id
    // is the single anchor for the whole successor surface. Knowing a branch id
    // therefore buys nothing without an owned chat pointing at it.
    const anchors = await db()
      .select({ id: characterChats.id })
      .from(characterChats)
      .where(and(eq(characterChats.simBranchId, fixture.branch), eq(characterChats.ownerId, ownerB)));
    expect(anchors).toEqual([]);
    const own = await db()
      .select({ id: characterChats.id })
      .from(characterChats)
      .where(and(eq(characterChats.simBranchId, fixture.branch), eq(characterChats.ownerId, ownerA)));
    expect(own).toHaveLength(1);
  });

  it("polymorphic image metadata cannot expose a private entity's image", async () => {
    // slice 3, kept here as regression. entityKind/entityId are unverified
    // metadata with no FK, so the file route's widening carries two predicates:
    // the entity is public AND it belongs to the image's owner.
    expect(await isPublicEntityImage("character", fixture.privateCharacter, ownerA)).toBe(false);
    expect(await isPublicEntityImage("character", fixture.publicCharacter, ownerA)).toBe(true);
    // B naming A's public character on B's own image buys nothing.
    expect(await isPublicEntityImage("character", fixture.publicCharacter, ownerB)).toBe(false);
    // Non-shareable kinds and unlinked images never widen.
    expect(await isPublicEntityImage("world", fixture.publicCharacter, ownerA)).toBe(false);
    expect(await isPublicEntityImage("character", null, ownerA)).toBe(false);
  });

  it("owned-scope discovery never leaks another account's rows", async () => {
    for (const kind of ["character", "location", "item", "social_card", "persona"] as const) {
      const mine = await searchLibraryIds(kind, ownerB, { scope: "owned" });
      const theirs = await searchLibraryIds(kind, ownerA, { scope: "owned" });
      for (const id of mine) expect(theirs).not.toContain(id);
    }
  });
});
