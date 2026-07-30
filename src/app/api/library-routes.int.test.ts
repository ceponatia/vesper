import { eq, inArray } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { characters, db, images, items, jobs, locations } from "@/server/db";
import { resetRateLimits } from "@/server/api";

// Demo-mode route-handler integration suite (docs/testing.md §api): handlers
// invoked directly with mocked auth against DATABASE_URL. Self-skips when the
// database is unreachable.

const authState = vi.hoisted(() => ({
  user: { id: "", email: "", name: "Routes Int", role: "admin" as const },
}));

vi.mock("@/server/auth", async () => (await import("@/server/test-support")).routeAuthModule(authState));

import {
  apiRequest,
  bindAuthUser,
  canonicalImageRow,
  endTestPool,
  expectApiError,
  expectJson,
  probeIntegrationDb,
  purgeOwnerRows,
  routeCtx,
  seedTestUser,
  withAuthUser,
  withTempDataRoot,
  type TempDataRoot,
} from "@/server/test-support";
import { GET as listCharactersRoute, POST as createCharacterRoute } from "./characters/route";
import {
  DELETE as deleteCharacterRoute,
  GET as getCharacterRoute,
  PATCH as patchCharacterRoute,
} from "./characters/[id]/route";
import { POST as forgeCharacterRoute } from "./characters/forge/route";
import { POST as avatarRoute } from "./characters/[id]/avatar/route";
import { GET as listPortraitsRoute, POST as portraitRoute } from "./characters/[id]/portraits/route";
import {
  DELETE as deletePortraitRoute,
  GET as getPortraitRoute,
} from "./characters/[id]/portraits/[imageId]/route";
import { POST as promotePortraitRoute } from "./characters/[id]/portraits/[imageId]/promote/route";
import { GET as listLocationsRoute, POST as createLocationRoute } from "./locations/route";
import { PATCH as patchLocationRoute } from "./locations/[id]/route";
import { GET as listItemsRoute, POST as createItemRoute } from "./items/route";
import { PATCH as patchItemRoute } from "./items/[id]/route";
import { GET as imageFileRoute } from "./images/[id]/file/route";
import { POST as itemImagesBatchRoute } from "./items/images/route";
import { POST as locationImagesBatchRoute } from "./locations/images/route";
import { POST as cloneCharacterRoute } from "./characters/[id]/clone/route";
import { GET as listPersonasRoute, POST as createPersonaRoute } from "./personas/route";
import {
  DELETE as deletePersonaRoute,
  GET as getPersonaRoute,
  PATCH as patchPersonaRoute,
} from "./personas/[id]/route";
import { GET as devMeRoute } from "./dev/me/route";

const ready = await probeIntegrationDb("library-routes.int.test", "characters");
const noParams = routeCtx();
let dataRoot: TempDataRoot | undefined;

/** The `?kind` / `?ids` item list, shared by the filter and result-cap cases. */
async function listItemRows(query: Record<string, string> = {}): Promise<{ id: string; kind: string }[]> {
  const body = await expectJson<{ items: { id: string; kind: string }[] }>(
    await listItemsRoute(apiRequest("/api/items", { query }), noParams),
  );
  return body.items;
}

async function waitForJob(jobId: string, timeoutMs = 10_000): Promise<typeof jobs.$inferSelect> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const [row] = await db().select().from(jobs).where(eq(jobs.id, jobId)).limit(1);
    if (row && row.status !== "running" && row.status !== "queued") return row;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`job ${jobId} did not settle in ${timeoutMs}ms`);
}

beforeAll(async () => {
  if (!ready) return;
  dataRoot = await withTempDataRoot("vesper-api-int");
  bindAuthUser(authState, await seedTestUser("routes-int", { role: "admin" }));
  resetRateLimits();
});

afterAll(async () => {
  await dataRoot?.cleanup();
  // Owner-scoped teardown reaches this suite's jobs too — every route here hands
  // `startJob` an `ownerId`. The old sweep deleted `jobs` by wall-clock start
  // time, which would also take rows belonging to any other suite running
  // against the same database.
  if (ready) await purgeOwnerRows([authState.user.id]);
  await endTestPool();
});

let characterId = "";
let locationId = "";
let clothingItemId = "";
let personaId = "";

describe.skipIf(!ready)("characters CRUD + search", () => {
  it("creates a character and lists it via ?q and ?tag", async () => {
    const created = await expectJson<{ character: { id: string } }>(
      await createCharacterRoute(
        apiRequest("/api/characters", {
          body: {
            name: "Mireille Voss",
            tags: ["harbor", "stoic"],
            profile: { bio: "A weary harbor-master.", personality: "dry humor", aliases: ["Captain Voss"] },
          },
        }),
        noParams,
      ),
      201,
    );
    characterId = created.character.id;

    const byName = await expectJson<{ characters: unknown[] }>(
      await listCharactersRoute(apiRequest("/api/characters", { query: { q: "mireille" } }), noParams),
    );
    expect(byName.characters.length).toBe(1);
    const byTag = await expectJson<{ characters: { id: string }[] }>(
      await listCharactersRoute(apiRequest("/api/characters", { query: { tag: "harbor" } }), noParams),
    );
    expect(byTag.characters.map((c) => c.id)).toContain(characterId);
    const miss = await expectJson<{ characters: unknown[] }>(
      await listCharactersRoute(apiRequest("/api/characters", { query: { q: "zzz-nonexistent" } }), noParams),
    );
    expect(miss.characters).toEqual([]);
  });

  it("rejects an invalid create body with the envelope", async () => {
    await expectApiError(
      await createCharacterRoute(apiRequest("/api/characters", { body: { name: "" } }), noParams),
      400,
      "invalid_body",
    );
  });

  it("materializes suggested outfit items on save, reusing by name", async () => {
    const suggestion = {
      kind: "clothing",
      name: "Storm Slicker",
      description: "Oiled canvas coat.",
      coverage: ["torso", "arms"],
      layer: 3,
    };
    // Materialized ids land in the DEFAULT preset (outfits[0] — ux-improvements slice 8).
    type PresetProfile = { profile: { outfits: { id: string; items: string[] }[] } };
    const created = await expectJson<{ character: PresetProfile; diagnostics: { code: string }[] }>(
      await createCharacterRoute(
        apiRequest("/api/characters", {
          body: {
            name: "Suggestion Tester",
            suggestedItems: [suggestion, { kind: "clothing", name: "Odd Hat", coverage: ["head", "not-a-location"] }],
          },
        }),
        noParams,
      ),
      201,
    );
    const outfit = created.character.profile.outfits[0]?.items ?? [];
    expect(outfit.length).toBe(2);

    const [slicker] = await db().select().from(items).where(eq(items.id, outfit[0]!)).limit(1);
    expect(slicker?.name).toBe("Storm Slicker");
    expect(slicker?.tags).toContain("suggested");
    // invalid coverage id degrades to the valid subset, with a diagnostic
    expect(created.diagnostics.map((d) => d.code)).toContain("api.library.suggested_item.coverage_dropped");
    const [hat] = await db().select().from(items).where(eq(items.id, outfit[1]!)).limit(1);
    expect((hat?.definition as { coverage: string[] }).coverage).toEqual(["head"]);

    // a second save with the same suggestion reuses the existing item
    const again = await expectJson<{ character: PresetProfile }>(
      await createCharacterRoute(
        apiRequest("/api/characters", { body: { name: "Suggestion Tester II", suggestedItems: [suggestion] } }),
        noParams,
      ),
      201,
    );
    expect(again.character.profile.outfits[0]?.items).toEqual([outfit[0]]);
  });

  it("PATCH merges a partial profile without clobbering unsent fields", async () => {
    const patched = await expectJson<{ character: { profile: { bio: string; personality: string; aliases: string[] } } }>(
      await patchCharacterRoute(
        apiRequest(`/api/characters/${characterId}`, { method: "PATCH", body: { profile: { bio: "Updated bio." } } }),
        routeCtx({ id: characterId }),
      ),
      200,
    );
    const profile = patched.character.profile;
    expect(profile.bio).toBe("Updated bio.");
    expect(profile.personality).toBe("dry humor");
    expect(profile.aliases).toEqual(["Captain Voss"]);
  });

  it("404s for a character owned by someone else", async () => {
    const other = await seedTestUser("routes-int-other");
    try {
      await withAuthUser(authState, { id: other.id, email: other.email }, async () => {
        await expectApiError(
          await getCharacterRoute(apiRequest(`/api/characters/${characterId}`), routeCtx({ id: characterId })),
          404,
        );
      });
    } finally {
      await purgeOwnerRows([other.id]);
    }
  });
});

describe.skipIf(!ready)("entity visibility (auth.plan.md)", () => {
  it("public entities read cross-owner but never write; private stay owner-only", async () => {
    const mkChar = async (name: string) =>
      (
        await expectJson<{ character: { id: string } }>(
          await createCharacterRoute(apiRequest("/api/characters", { body: { name } }), noParams),
        )
      ).character.id;
    const privateId = await mkChar("Secret Muse");
    const publicId = await mkChar("Public Muse");

    const published = await expectJson<{ character: { visibility: string } }>(
      await patchCharacterRoute(
        apiRequest(`/api/characters/${publicId}`, { method: "PATCH", body: { visibility: "public" } }),
        routeCtx({ id: publicId }),
      ),
      200,
    );
    expect(published.character.visibility).toBe("public");

    const other = await seedTestUser("routes-int-vis");
    try {
      await withAuthUser(authState, { id: other.id, email: other.email }, async () => {
        // Read widens to owner-or-public: a public entity reads cross-owner, a private one 404s.
        expect(
          (await getCharacterRoute(apiRequest(`/api/characters/${publicId}`), routeCtx({ id: publicId }))).status,
        ).toBe(200);
        await expectApiError(
          await getCharacterRoute(apiRequest(`/api/characters/${privateId}`), routeCtx({ id: privateId })),
          404,
        );
        // Writes never cross owner — even on a public entity (treated as not-found).
        await expectApiError(
          await patchCharacterRoute(
            apiRequest(`/api/characters/${publicId}`, { method: "PATCH", body: { name: "hijack" } }),
            routeCtx({ id: publicId }),
          ),
          404,
        );
        await expectApiError(
          await deleteCharacterRoute(apiRequest(`/api/characters/${publicId}`), routeCtx({ id: publicId })),
          404,
        );
      });
    } finally {
      await purgeOwnerRows([other.id]);
    }

    // Owner still sees the public entity, and the cross-owner PATCH never landed.
    const ownerView = await expectJson<{ character: { name: string } }>(
      await getCharacterRoute(apiRequest(`/api/characters/${publicId}`), routeCtx({ id: publicId })),
    );
    expect(ownerView.character.name).toBe("Public Muse");

    await deleteCharacterRoute(apiRequest(`/api/characters/${publicId}`), routeCtx({ id: publicId }));
    await deleteCharacterRoute(apiRequest(`/api/characters/${privateId}`), routeCtx({ id: privateId }));
  });

  it("clones a public entity into an owned, private copy that survives source deletion", async () => {
    const owner = authState.user;
    const srcId = (
      await expectJson<{ character: { id: string } }>(
        await createCharacterRoute(
          apiRequest("/api/characters", {
            body: {
              name: "Shared Muse",
              tags: ["origin"],
              // A clone copies the whole authored profile, the adult-eligibility
              // declaration included (adult-eligibility.spec.md §"Clones and imports").
              profile: { adultEligibilityDeclaration: "adult", age: "34" },
            },
          }),
          noParams,
        ),
      )
    ).character.id;
    await patchCharacterRoute(
      apiRequest(`/api/characters/${srcId}`, { method: "PATCH", body: { visibility: "public" } }),
      routeCtx({ id: srcId }),
    );

    const other = await seedTestUser("routes-int-clone");
    const asOther = { id: other.id, email: other.email };
    let cloneId = "";
    try {
      await withAuthUser(authState, asOther, async () => {
        cloneId = (
          await expectJson<{ id: string }>(
            await cloneCharacterRoute(
              apiRequest(`/api/characters/${srcId}/clone`, { body: {} }),
              routeCtx({ id: srcId }),
            ),
            201,
          )
        ).id;

        const copy = (
          await expectJson<{
            character: {
              visibility: string;
              tags: string[];
              clonedFromId: string | null;
              profile: { adultEligibilityDeclaration?: string };
            };
          }>(await getCharacterRoute(apiRequest(`/api/characters/${cloneId}`), routeCtx({ id: cloneId })))
        ).character;
        expect(copy.visibility).toBe("private");
        expect(copy.tags).toContain("origin");
        expect(copy.clonedFromId).toBe(srcId);
        expect(copy.profile.adultEligibilityDeclaration).toBe("adult");

        // Owner deletes the source; the cross-owner clone must survive intact.
        await withAuthUser(authState, owner, async () => {
          expect(
            (await deleteCharacterRoute(apiRequest(`/api/characters/${srcId}`), routeCtx({ id: srcId }))).status,
          ).toBe(200);
        });
        expect(
          (await getCharacterRoute(apiRequest(`/api/characters/${cloneId}`), routeCtx({ id: cloneId }))).status,
        ).toBe(200);
      });
    } finally {
      if (cloneId) {
        await withAuthUser(authState, asOther, () =>
          deleteCharacterRoute(apiRequest(`/api/characters/${cloneId}`), routeCtx({ id: cloneId })),
        );
      }
      await purgeOwnerRows([other.id]);
    }
  });
});

describe.skipIf(!ready)("library list facets, sort & scope (library-ux.plan.md §Follow-up pass)", () => {
  it("character list carries speciesId/gender and honors ?sort=name", async () => {
    const mk = async (name: string) =>
      (
        await expectJson<{ character: { id: string } }>(
          await createCharacterRoute(apiRequest("/api/characters", { body: { name, tags: ["facet-sort"] } }), noParams),
        )
      ).character.id;
    // Created in reverse-alphabetical order so updated-recency and name order disagree.
    const aaId = await mk("Aa Facet Muse");
    const zzId = await mk("Zz Facet Muse");

    const byRecency = (
      await expectJson<{ characters: { id: string; speciesId: string | null; gender: string | null }[] }>(
        await listCharactersRoute(apiRequest("/api/characters", { query: { tag: "facet-sort" } }), noParams),
      )
    ).characters;
    expect(byRecency.map((c) => c.id)).toEqual([zzId, aaId]);
    const aa = byRecency.find((c) => c.id === aaId);
    // A blank-created character carries the registry defaults (human, female).
    expect(aa?.speciesId).toBe("human");
    expect(aa?.gender).toBe("female");

    const byName = (
      await expectJson<{ characters: { id: string }[] }>(
        await listCharactersRoute(
          apiRequest("/api/characters", { query: { tag: "facet-sort", sort: "name" } }),
          noParams,
        ),
      )
    ).characters;
    expect(byName.map((c) => c.id)).toEqual([aaId, zzId]);

    for (const id of [aaId, zzId]) await deleteCharacterRoute(apiRequest(`/api/characters/${id}`), routeCtx({ id }));
  });

  it("location list carries scale", async () => {
    const created = await expectJson<{ location: { id: string } }>(
      await createLocationRoute(
        apiRequest("/api/locations", { body: { name: "Facet Harbor", tags: ["facet-scale"] } }),
        noParams,
      ),
    );
    const locId = created.location.id;

    const listed = (
      await expectJson<{ locations: { id: string; scale: string }[] }>(
        await listLocationsRoute(apiRequest("/api/locations", { query: { tag: "facet-scale" } }), noParams),
      )
    ).locations;
    const row = listed.find((l) => l.id === locId);
    expect(row?.scale).toBe("room"); // the column default rides the list payload

    await db().delete(locations).where(eq(locations.id, locId));
  });

  it("?scope=public surfaces another owner's published rows; owned stays private", async () => {
    const charId = (
      await expectJson<{ character: { id: string } }>(
        await createCharacterRoute(
          apiRequest("/api/characters", { body: { name: "Scope Muse", tags: ["scope-test"] } }),
          noParams,
        ),
      )
    ).character.id;
    await patchCharacterRoute(
      apiRequest(`/api/characters/${charId}`, { method: "PATCH", body: { visibility: "public" } }),
      routeCtx({ id: charId }),
    );
    const itemId = (
      await expectJson<{ item: { id: string } }>(
        await createItemRoute(
          apiRequest("/api/items", { body: { name: "Scope Cloak", kind: "clothing", tags: ["scope-test"] } }),
          noParams,
        ),
      )
    ).item.id;
    await patchItemRoute(
      apiRequest(`/api/items/${itemId}`, { method: "PATCH", body: { visibility: "public" } }),
      routeCtx({ id: itemId }),
    );

    const other = await seedTestUser("routes-int-scope");
    try {
      await withAuthUser(authState, { id: other.id, email: other.email }, async () => {
        const pubChars = (
          await expectJson<{ characters: { id: string }[] }>(
            await listCharactersRoute(
              apiRequest("/api/characters", { query: { tag: "scope-test", scope: "public" } }),
              noParams,
            ),
          )
        ).characters;
        expect(pubChars.map((c) => c.id)).toContain(charId);
        const ownChars = (
          await expectJson<{ characters: unknown[] }>(
            await listCharactersRoute(apiRequest("/api/characters", { query: { tag: "scope-test" } }), noParams),
          )
        ).characters;
        expect(ownChars).toEqual([]);
        const pubItems = await listItemRows({ tag: "scope-test", scope: "all" });
        expect(pubItems.map((i) => i.id)).toContain(itemId);
        expect(await listItemRows({ tag: "scope-test" })).toEqual([]);
      });
    } finally {
      await purgeOwnerRows([other.id]);
    }
    await deleteCharacterRoute(apiRequest(`/api/characters/${charId}`), routeCtx({ id: charId }));
    await db().delete(items).where(eq(items.id, itemId));
  });
});

describe.skipIf(!ready)("locations and items", () => {
  it("creates a location", async () => {
    const created = await expectJson<{ location: { id: string } }>(
      await createLocationRoute(
        apiRequest("/api/locations", {
          body: {
            name: "Harbor Office",
            description: "Cramped, salt-stained.",
            ambient: { scent: "tar and kelp" },
            tags: ["harbor"],
          },
        }),
        noParams,
      ),
      201,
    );
    locationId = created.location.id;
  });

  it("creates a clothing item and rejects unknown coverage ids", async () => {
    await expectApiError(
      await createItemRoute(
        apiRequest("/api/items", {
          body: { name: "Oilskin Coat", kind: "clothing", definition: { coverage: ["torso_dorsal_fin"], layer: 3 } },
        }),
        noParams,
      ),
      400,
      "invalid_coverage",
    );

    const good = await expectJson<{ item: { id: string } }>(
      await createItemRoute(
        apiRequest("/api/items", {
          body: {
            name: "Oilskin Coat",
            kind: "clothing",
            description: "Heavy, weatherproof.",
            definition: { coverage: ["neck"], layer: 3 },
          },
        }),
        noParams,
      ),
      201,
    );
    clothingItemId = good.item.id;
  });

  it("filters the item list by ?kind, ignoring an unknown kind", async () => {
    const obj = await expectJson<{ item: { id: string } }>(
      await createItemRoute(apiRequest("/api/items", { body: { name: "Brass Lantern", kind: "object" } }), noParams),
      201,
    );
    const objectItemId = obj.item.id;

    // ?kind=clothing returns only the coat, never the object.
    const clothing = await listItemRows({ kind: "clothing" });
    expect(clothing.every((i) => i.kind === "clothing")).toBe(true);
    expect(clothing.map((i) => i.id)).toContain(clothingItemId);
    expect(clothing.map((i) => i.id)).not.toContain(objectItemId);

    // No kind → both kinds present; an unknown kind degrades to no filter.
    const all = await listItemRows();
    expect(all.map((i) => i.id)).toEqual(expect.arrayContaining([clothingItemId, objectItemId]));
    const bogus = await listItemRows({ kind: "weapon" });
    expect(bogus.map((i) => i.id)).toEqual(expect.arrayContaining([clothingItemId, objectItemId]));
  });

  it("applies the result cap per-kind and resolves ids past the cap (defaultOutfit regression)", async () => {
    const ownerId = authState.user.id;
    // Flood the library with >LIST_LIMIT (100) NEWER items of another kind. Pre-fix,
    // the global cap (order by updated_at desc) filled with these and pushed the
    // older clothing — like a character's defaultOutfit — out of the clothing list,
    // making it render as "not in library" though it was never deleted.
    const flood = Array.from({ length: 105 }, (_, i) => ({ ownerId, kind: "object" as const, name: `Flood Object ${i}` }));
    const inserted = await db().insert(items).values(flood).returning({ id: items.id });
    try {
      // The per-kind cap keeps the (older) coat in the clothing list.
      const clothing = await listItemRows({ kind: "clothing" });
      expect(clothing.every((i) => i.kind === "clothing")).toBe(true);
      expect(clothing.map((i) => i.id)).toContain(clothingItemId);
      // ?ids resolves a specific reference (outfit item) regardless of the cap.
      const byIds = await listItemRows({ ids: clothingItemId });
      expect(byIds.map((i) => i.id)).toEqual([clothingItemId]);
      // empty ids → empty (must not fall through to the unfiltered list).
      expect(await listItemRows({ ids: "" })).toEqual([]);
    } finally {
      await db().delete(items).where(inArray(items.id, inserted.map((r) => r.id)));
    }
  });

  it("404s cross-user PATCH for character, location and item without modifying rows", async () => {
    const other = await seedTestUser("routes-int-patcher");
    try {
      await withAuthUser(authState, { id: other.id, email: other.email }, async () => {
        await expectApiError(
          await patchCharacterRoute(
            apiRequest(`/api/characters/${characterId}`, { method: "PATCH", body: { name: "Hijacked" } }),
            routeCtx({ id: characterId }),
          ),
          404,
        );
        await expectApiError(
          await patchLocationRoute(
            apiRequest(`/api/locations/${locationId}`, { method: "PATCH", body: { name: "Hijacked" } }),
            routeCtx({ id: locationId }),
          ),
          404,
        );
        await expectApiError(
          await patchItemRoute(
            apiRequest(`/api/items/${clothingItemId}`, { method: "PATCH", body: { name: "Hijacked" } }),
            routeCtx({ id: clothingItemId }),
          ),
          404,
        );
      });
    } finally {
      await purgeOwnerRows([other.id]);
    }
    // The UPDATE itself is owner-scoped (defense-in-depth), so nothing changed.
    const [charRow] = await db().select().from(characters).where(eq(characters.id, characterId)).limit(1);
    expect(charRow?.name).toBe("Mireille Voss");
    const [locRow] = await db().select().from(locations).where(eq(locations.id, locationId)).limit(1);
    expect(locRow?.name).toBe("Harbor Office");
    const [itemRow] = await db().select().from(items).where(eq(items.id, clothingItemId)).limit(1);
    expect(itemRow?.name).toBe("Oilskin Coat");
  });
});

describe.skipIf(!ready)("batch entity images: malformed body must 400, never widen scope (codebase-review A4)", () => {
  it("rejects invalid JSON instead of queueing an unscoped paid batch", async () => {
    for (const [route, url] of [
      [itemImagesBatchRoute, "/api/items/images"],
      [locationImagesBatchRoute, "/api/locations/images"],
    ] as const) {
      // A string body rides through verbatim, so the handler really does see
      // `{not json` rather than a JSON-encoded string of it.
      await expectApiError(await route(apiRequest(url, { body: "{not json" }), noParams), 400);
    }
  });

  it("still accepts an empty object as the deliberate generate-all scope", async () => {
    // {} (no ids) is the client's "all missing" request — must not 400. AI_FAKE
    // makes any queued render a no-op placeholder; the assertion is only the status.
    const res = await itemImagesBatchRoute(apiRequest("/api/items/images", { body: {} }), noParams);
    expect([200, 202]).toContain(res.status);
  });
});

describe.skipIf(!ready)("images: avatar job, portraits, serving", () => {
  let avatarImageId = "";
  let variantImageId = "";

  it("runs the avatar job and serves the file with immutable caching", async () => {
    const { jobId } = await expectJson<{ jobId: string }>(
      await avatarRoute(
        apiRequest(`/api/characters/${characterId}/avatar`, { body: { style: "stylized" } }),
        routeCtx({ id: characterId }),
      ),
      202,
    );
    const job = await waitForJob(jobId);
    expect(job.status).toBe("done");
    avatarImageId = (job.payload as { imageId: string }).imageId;

    const [imageRow] = await db().select().from(images).where(eq(images.id, avatarImageId)).limit(1);
    expect(imageRow?.status).toBe("ready");
    expect((imageRow?.meta as { demo?: boolean }).demo).toBe(true);
    const [charRow] = await db().select().from(characters).where(eq(characters.id, characterId)).limit(1);
    expect(charRow?.avatarImageId).toBe(avatarImageId);

    const file = await imageFileRoute(apiRequest(`/api/images/${avatarImageId}/file`), routeCtx({ id: avatarImageId }));
    expect(file.status).toBe(200);
    expect(file.headers.get("content-type")).toBe("image/webp");
    expect(file.headers.get("cache-control")).toContain("immutable");
  });

  it("404s for missing and non-ready images", async () => {
    // The file route serves bytes, not an envelope, so these stay status-only.
    const missing = await imageFileRoute(apiRequest("/api/images/nope/file"), routeCtx({ id: "nope" }));
    expect(missing.status).toBe(404);
    const [pendingRow] = await db()
      .insert(images)
      .values(canonicalImageRow({ ownerId: authState.user.id, kind: "entity" as const, entityKind: "world" as const }))
      .returning();
    if (!pendingRow) throw new Error("failed to insert pending image");
    const pending = await imageFileRoute(
      apiRequest(`/api/images/${pendingRow.id}/file`),
      routeCtx({ id: pendingRow.id }),
    );
    expect(pending.status).toBe(404);
  });

  it("generates, fetches, promotes and deletes a portrait variant", async () => {
    const { jobId } = await expectJson<{ jobId: string }>(
      await portraitRoute(
        apiRequest(`/api/characters/${characterId}/portraits`, {
          body: { kind: "pose", instruction: "leaning on the rail" },
        }),
        routeCtx({ id: characterId }),
      ),
      202,
    );
    const job = await waitForJob(jobId);
    expect(job.status).toBe("done");
    variantImageId = (job.payload as { imageId: string }).imageId;

    const listed = await expectJson<{ portraits: { id: string }[] }>(
      await listPortraitsRoute(apiRequest(`/api/characters/${characterId}/portraits`), routeCtx({ id: characterId })),
      200,
    );
    expect(listed.portraits.map((p) => p.id)).toContain(variantImageId);

    const single = await getPortraitRoute(
      apiRequest(`/api/characters/${characterId}/portraits/${variantImageId}`),
      routeCtx({ id: characterId, imageId: variantImageId }),
    );
    expect(single.status).toBe(200);

    const promoted = await promotePortraitRoute(
      apiRequest(`/api/characters/${characterId}/portraits/${variantImageId}/promote`, { method: "POST" }),
      routeCtx({ id: characterId, imageId: variantImageId }),
    );
    expect(promoted.status).toBe(200);
    const [charRow] = await db().select().from(characters).where(eq(characters.id, characterId)).limit(1);
    expect(charRow?.avatarImageId).toBe(variantImageId);

    const deleted = await deletePortraitRoute(
      apiRequest(`/api/characters/${characterId}/portraits/${variantImageId}`),
      routeCtx({ id: characterId, imageId: variantImageId }),
    );
    expect(deleted.status).toBe(200);
    const [afterDelete] = await db().select().from(characters).where(eq(characters.id, characterId)).limit(1);
    expect(afterDelete?.avatarImageId).toBeNull(); // promoted-then-deleted avatar never dangles

    // character detail lists remaining portraits (the original avatar)
    const detail = await expectJson<{ portraits: { id: string }[] }>(
      await getCharacterRoute(apiRequest(`/api/characters/${characterId}`), routeCtx({ id: characterId })),
    );
    expect(detail.portraits.map((p) => p.id)).toContain(avatarImageId);
  });
});

describe.skipIf(!ready)("forge endpoints (demo mode) and rate limiting", () => {
  it("drafts a character without saving", async () => {
    resetRateLimits();
    const owned = () => db().select({ id: characters.id }).from(characters).where(eq(characters.ownerId, authState.user.id));
    const before = await owned();
    const body = await expectJson<{ draft: { name: string; profile: { bio: string } }; diagnostics: unknown }>(
      await forgeCharacterRoute(
        apiRequest("/api/characters/forge", { body: { prompt: "a weary harbor-master in her forties" } }),
        noParams,
      ),
      200,
    );
    expect(body.draft.name.length).toBeGreaterThan(0);
    expect(Array.isArray(body.diagnostics)).toBe(true);
    expect((await owned()).length).toBe(before.length); // drafts never save
  });
});

describe.skipIf(!ready)("dev identity", () => {
  it("dev/me returns the resolved user", async () => {
    const me = await expectJson<{ user: { id: string } }>(await devMeRoute(apiRequest("/api/dev/me"), noParams));
    expect(me.user.id).toBe(authState.user.id);
  });

  it("dev/me 404s in production (the dev-route gate)", async () => {
    const prev = process.env.NODE_ENV;
    // NODE_ENV is read-only in the Next types; assign through a cast for the test.
    (process.env as Record<string, string | undefined>).NODE_ENV = "production";
    try {
      const gated = await devMeRoute(apiRequest("/api/dev/me"), noParams);
      expect(gated.status).toBe(404);
    } finally {
      (process.env as Record<string, string | undefined>).NODE_ENV = prev;
    }
  });
});

describe.skipIf(!ready)("personas CRUD", () => {
  it("creates a persona and lists it", async () => {
    const created = await expectJson<{ persona: { id: string } }>(
      await createPersonaRoute(
        apiRequest("/api/personas", {
          body: {
            title: "Brian, 22",
            name: "Brian",
            tags: ["young"],
            profile: { bio: "A quiet man who fixes things.", intimateRegions: ["penis"] },
          },
        }),
        noParams,
      ),
      201,
    );
    personaId = created.persona.id;

    const rows = (
      await expectJson<{ personas: { id: string; title: string; name: string }[] }>(
        await listPersonasRoute(apiRequest("/api/personas"), noParams),
      )
    ).personas;
    expect(rows.map((r) => r.id)).toContain(personaId);
    expect(rows.find((r) => r.id === personaId)?.title).toBe("Brian, 22");
  });

  // The whole reason `title` exists: `name` must be free to repeat across personas.
  it("allows a duplicate name under a different title", async () => {
    const res = await createPersonaRoute(
      apiRequest("/api/personas", { body: { title: "Brian, 40", name: "Brian" } }),
      noParams,
    );
    expect(res.status).toBe(201);
  });

  it("rejects a duplicate title with a typed 409, not a raw unique-violation 500", async () => {
    await expectApiError(
      await createPersonaRoute(
        apiRequest("/api/personas", { body: { title: "Brian, 22", name: "Someone Else" } }),
        noParams,
      ),
      409,
      "title_conflict",
    );
  });

  it("merges a partial profile PATCH instead of replacing it", async () => {
    // Seed a wardrobe, then PATCH only `attributes` — the outfits must survive.
    const seeded = await patchPersonaRoute(
      apiRequest("/api/personas/x", {
        method: "PATCH",
        body: { profile: { outfits: [{ id: "everyday", name: "Everyday", items: ["shirt"] }] } },
      }),
      routeCtx({ id: personaId }),
    );
    expect(seeded.status).toBe(200);

    const patched = await expectJson<{ persona: { profile: Record<string, unknown> } }>(
      await patchPersonaRoute(
        apiRequest("/api/personas/x", {
          method: "PATCH",
          body: { profile: { attributes: [{ id: "skin.tone", value: "tan", source: "manual" }] } },
        }),
        routeCtx({ id: personaId }),
      ),
      200,
    );
    const profile = patched.persona.profile;
    expect(profile.attributes).toHaveLength(1);
    // The invariant partialWithoutDefaults exists to protect: unsent fields keep their value.
    expect(profile.outfits).toHaveLength(1);
    expect(profile.bio).toBe("A quiet man who fixes things.");
  });

  it("gets and deletes a persona; a foreign id is a 404", async () => {
    const got = await getPersonaRoute(apiRequest("/api/personas/x"), routeCtx({ id: personaId }));
    expect(got.status).toBe(200);

    await expectApiError(
      await getPersonaRoute(apiRequest("/api/personas/x"), routeCtx({ id: "nope-not-a-real-id" })),
      404,
    );

    const gone = await deletePersonaRoute(
      apiRequest("/api/personas/x", { method: "DELETE" }),
      routeCtx({ id: personaId }),
    );
    expect(gone.status).toBe(200);
    await expectApiError(await getPersonaRoute(apiRequest("/api/personas/x"), routeCtx({ id: personaId })), 404);
  });
});
