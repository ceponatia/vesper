import "dotenv/config";
import { and, eq, inArray, sql } from "drizzle-orm";
import { characterProfileSchema, itemDefinitionSchema, type CharacterProfile } from "../src/contracts";
import { DiagnosticCollector } from "../src/contracts/diagnostics";
import { newId } from "../src/lib/ids";
import { characters, db, items, locations, users, type Db } from "../src/server/db";
import { refreshSearchEmbedding } from "../src/server/memory";
import { DEV_PASSWORD, ensureDevCredential } from "../src/server/auth";
import { harborHouse, SEED_TAG, type SeedWorldFixture } from "./fixtures/harbor-house";

/**
 * Idempotent dev seed (docs/getting-started.md): ensures the dev + UI/QA users
 * (with credentials) and (re)creates the "Harbor House" library content —
 * locations, items, characters — for the default dev user. Seed rows are marked
 * with SEED_TAG; the re-seed drops the prior tagged rows first, and
 * user-authored (untagged) content is never wiped.
 */

const DEV_EMAIL = "player@vesper.local";

/** The dedicated UI/QA admin (CLAUDE.md) — a fixed id, so it must be preserved. */
const UXTEST_ID = "uxtestmaina1b2c3d4e5f6g7";
const UXTEST_EMAIL = "uxtest-main@vesper.local";

type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

async function ensureDevUser(): Promise<{ id: string; name: string }> {
  const [existing] = await db().select().from(users).where(eq(users.email, DEV_EMAIL)).limit(1);
  if (existing) return existing;
  const [created] = await db()
    .insert(users)
    .values({ email: DEV_EMAIL, name: "Player", role: "admin", emailVerified: true })
    .onConflictDoNothing()
    .returning();
  if (created) return created;
  const [raced] = await db().select().from(users).where(eq(users.email, DEV_EMAIL)).limit(1);
  if (!raced) throw new Error("failed to ensure default dev user");
  return raced;
}

/** Ensure the UI/QA admin row exists (preserving its fixed id) — fresh DBs lack it. */
async function ensureUxtestAdmin(): Promise<string> {
  await db()
    .insert(users)
    .values({ id: UXTEST_ID, email: UXTEST_EMAIL, name: "UX Tester", role: "admin", emailVerified: true })
    .onConflictDoNothing();
  return UXTEST_ID;
}

/** ids of owner rows carrying the seed marker tag. */
async function taggedIds(tx: Tx, table: typeof characters | typeof locations | typeof items, ownerId: string): Promise<string[]> {
  const marker = JSON.stringify([SEED_TAG]);
  const rows = await tx
    .select({ id: table.id })
    .from(table)
    .where(and(eq(table.ownerId, ownerId), sql`${table.tags} @> ${marker}::jsonb`));
  return rows.map((r) => r.id);
}

/** Drop the prior seed's tagged library rows so the re-seed (fresh ids each run) stays idempotent. */
async function wipe(tx: Tx, ownerId: string): Promise<void> {
  const charIds = await taggedIds(tx, characters, ownerId);
  if (charIds.length > 0) await tx.delete(characters).where(inArray(characters.id, charIds));

  const itemIds = await taggedIds(tx, items, ownerId);
  if (itemIds.length > 0) await tx.delete(items).where(inArray(items.id, itemIds));

  const locIds = await taggedIds(tx, locations, ownerId);
  if (locIds.length > 0) await tx.delete(locations).where(inArray(locations.id, locIds));
}

interface CreatedLibrary {
  characterIds: string[];
  locationIds: string[];
  itemIds: string[];
}

function requireKey<V>(map: Map<string, V>, key: string, what: string): V {
  const value = map.get(key);
  if (value === undefined) throw new Error(`fixture references unknown ${what} key "${key}"`);
  return value;
}

async function create(tx: Tx, ownerId: string, fixture: SeedWorldFixture): Promise<CreatedLibrary> {
  // Library locations.
  const locIdByKey = new Map<string, string>(fixture.locations.map((l) => [l.key, newId()]));
  await tx.insert(locations).values(
    fixture.locations.map((l) => ({
      id: requireKey(locIdByKey, l.key, "location"),
      ownerId,
      name: l.name,
      description: l.description,
      ambient: l.ambient,
      tags: [...l.tags, SEED_TAG],
    })),
  );

  // Library items (items.definition holds the ItemDefinition extras slice).
  const itemIdByKey = new Map<string, string>(fixture.items.map((i) => [i.key, newId()]));
  await tx.insert(items).values(
    fixture.items.map((i) => {
      const tags = [...(i.tags ?? []), SEED_TAG];
      // Validate the composed definition so a vocabulary change fails here, not at read time.
      itemDefinitionSchema.parse({ kind: i.kind, name: i.name, description: i.description, tags, ...i.extras });
      return {
        id: requireKey(itemIdByKey, i.key, "item"),
        ownerId,
        kind: i.kind,
        name: i.name,
        description: i.description,
        definition: i.extras ?? {},
        tags,
      };
    }),
  );

  // Library characters (defaultOutfit references resolved library item ids).
  const charIdByKey = new Map<string, string>(fixture.characters.map((c) => [c.key, newId()]));
  await tx.insert(characters).values(
    fixture.characters.map((c) => {
      const profile: CharacterProfile = characterProfileSchema.parse({
        bio: c.bio,
        personality: c.personality,
        voice: c.voice,
        age: c.age,
        speciesId: "human",
        bodyPlanId: "humanoid",
        attributes: c.attributes,
        aliases: c.aliases,
        defaultOutfit: c.defaultOutfitKeys.map((k) => requireKey(itemIdByKey, k, "item")),
        schedule: c.schedule,
      });
      return {
        id: requireKey(charIdByKey, c.key, "character"),
        ownerId,
        name: c.name,
        profile,
        tags: [...c.tags, SEED_TAG],
      };
    }),
  );

  return {
    characterIds: [...charIdByKey.values()],
    locationIds: [...locIdByKey.values()],
    itemIds: [...itemIdByKey.values()],
  };
}

async function main(): Promise<void> {
  const user = await ensureDevUser();
  console.log(`seeding library content for ${DEV_EMAIL} (${user.id})`);

  // Provision the shared dev credential so sign-in / `POST /api/dev/impersonate`
  // can mint a real signed session for the Player + the UI/QA admin (auth.plan.md).
  const uxtestId = await ensureUxtestAdmin();
  const provisioned = (await ensureDevCredential(user.id)) && (await ensureDevCredential(uxtestId));
  console.log(
    provisioned
      ? `  dev credential set (password "${DEV_PASSWORD}") for ${DEV_EMAIL} + ${UXTEST_EMAIL}`
      : "  dev credential SKIPPED (production without an explicit DEV_PASSWORD — see server/auth/dev.ts)",
  );

  const created = await db().transaction(async (tx) => {
    await wipe(tx, user.id);
    return create(tx, user.id, harborHouse);
  });

  console.log(
    `  created ${created.locationIds.length} locations, ` +
      `${created.characterIds.length} characters, ${created.itemIds.length} items`,
  );

  // Search embeddings (demo mode → pseudo vectors). Failures degrade to diagnostics.
  const sink = new DiagnosticCollector();
  let refreshed = 0;
  for (const id of created.characterIds) refreshed += (await refreshSearchEmbedding("character", id, sink)) ? 1 : 0;
  for (const id of created.locationIds) refreshed += (await refreshSearchEmbedding("location", id, sink)) ? 1 : 0;
  for (const id of created.itemIds) refreshed += (await refreshSearchEmbedding("item", id, sink)) ? 1 : 0;
  console.log(`  refreshed ${refreshed} search embedding(s)`);
  for (const d of sink.items) console.log(`  diagnostic [${d.severity}] ${d.code}: ${d.message}`);

  console.log("seed complete");
}

main()
  .then(async () => {
    await globalThis.__vesperPool?.end();
  })
  .catch(async (err) => {
    console.error(err);
    await globalThis.__vesperPool?.end();
    process.exit(1);
  });
