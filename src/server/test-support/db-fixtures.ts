import { inArray, or } from "drizzle-orm";
import {
  characterChats,
  characters,
  chatScenarioPresets,
  db,
  imageIdentityPacks,
  imageIdentityPackTrialGrades,
  imageIdentityPackTrialRuns,
  imageIdentityPackTrialVerdicts,
  images,
  items,
  jobs,
  locationLinks,
  locations,
  personas,
  simProvisioningRequests,
  socialCards,
  usageCounters,
  users,
} from "@/server/db";

/**
 * Seeding and teardown for integration suites — the two blocks every
 * `.int.test.ts` file writes by hand (~59 seed sites, ~50 teardown cascades).
 *
 * The teardown order is the part worth centralizing: only a handful of the
 * owner-scoped tables cascade from `users`, so a suite that deletes users too
 * early fails on a foreign-key violation, and one that forgets a table leaves
 * rows behind that the next run's assertions can see.
 */

export interface SeededUser {
  id: string;
  email: string;
}

/**
 * Insert one user with a collision-resistant address. `name` defaults to
 * `prefix`; anything else (notably `role: "admin"`, which the admin-route suites
 * need) comes through `over`.
 *
 * Uniqueness rests on the millisecond stamp, so **two calls with the same prefix
 * in the same tick collide** on `users.email`'s unique index. Give each user its
 * own prefix (`"gallery-int"` / `"gallery-int-other"`, as the suites already do)
 * or use {@link seedTestUsers}, which varies the prefix per index.
 */
export async function seedTestUser(
  prefix: string,
  over: Partial<typeof users.$inferInsert> = {},
): Promise<SeededUser> {
  const email = `${prefix}-${Date.now()}@test.local`;
  const [row] = await db()
    .insert(users)
    .values({ email, name: prefix, ...over })
    .returning({ id: users.id, email: users.email });
  if (!row) {
    throw new Error(`[db-fixtures] seedTestUser("${prefix}") inserted no row — expected one user for ${email}`);
  }
  return row;
}

/** `count` users, each on its own `${prefix}-${index}` sub-prefix so the addresses cannot collide. */
export async function seedTestUsers(prefix: string, count: number): Promise<SeededUser[]> {
  const seeded: SeededUser[] = [];
  for (let index = 0; index < count; index += 1) {
    seeded.push(await seedTestUser(`${prefix}-${index}`));
  }
  return seeded;
}

/**
 * Delete every owner-scoped row belonging to `ownerIds`, then the users
 * themselves. Empty strings are ignored, so a suite whose `beforeAll` bailed on
 * an unreachable database can call this unconditionally.
 *
 * Order rationale — the FK graph decides it, not tidiness (`src/server/db/schema.ts`):
 *
 *   1. `images` first: `images.owner_id` has NO cascade from `users`, and its
 *      `chat_id` is `ON DELETE SET NULL`, so it neither depends on nor is
 *      cleaned by any later step.
 *   2. `characterChats` before `characters`: the chat cascade removes
 *      participants, messages, summaries, state, chat relationships, sim command
 *      requests and shadow divergences in one go, leaving the character delete
 *      nothing to fight over (`character_chat_messages.speaker_character_id` is
 *      `SET NULL`).
 *   3. `chatScenarioPresets` alongside them — owner-scoped with no inbound FK.
 *      `imageIdentityPacks` joins this step: it has NO owner column (it is owned
 *      transitively through its character) so it is deleted by a character
 *      subquery, and although `character_id` cascades, the explicit line keeps the
 *      teardown readable as the full list of tables a suite can leave rows in.
 *      `reviewed_by_user_id` is OR-ed in for the same reason `locationLinks` is
 *      explicit: that FK has no cascade (an audit trail must not erase itself), so
 *      a pack an admin suite REVIEWED on another owner's character would survive
 *      the subquery and then block the `users` delete outright.
 *      `imageIdentityPackTrialGrades` / `imageIdentityPackTrialVerdicts` /
 *      `imageIdentityPackTrialRuns` join for the same reviewer trap: grades
 *      carry the identical no-cascade `reviewed_by_user_id` and verdicts the
 *      identical no-cascade `decided_by_user_id`, so one recorded on another
 *      owner's run must go before `users`; runs (which cascade cells, grades and
 *      verdicts) are listed so the teardown reads as the full table list even
 *      though `owner_id` cascades.
 *   4. Library tables (`personas`, `socialCards`, `items`, `locationLinks`,
 *      `locations`). Links are deleted explicitly even though `locations`
 *      cascades them: `location_links.owner_id` is its own column, so a link
 *      owned by a purged user but pointing at another user's locations would
 *      otherwise survive and then block the `users` delete.
 *   5. `jobs` (nullable `owner_id`, no cascade), `usageCounters` and
 *      `simProvisioningRequests` (both cascade from `users`, listed anyway so
 *      the order is readable without cross-checking the schema).
 *   6. `users` last.
 *
 * **Not covered, by design:** `facts` / `episodes` are keyed by
 * `chat_memory_group_id` with no owner column, and `sim_worlds` / `sim_branches`
 * are owned transitively through the anchoring chat. Suites that plant those
 * directly still clean them themselves, before calling this.
 */
export async function purgeOwnerRows(ownerIds: string[]): Promise<void> {
  const owners = ownerIds.filter((id) => id !== "");
  if (owners.length === 0) return;

  await db().delete(images).where(inArray(images.ownerId, owners));
  await db().delete(characterChats).where(inArray(characterChats.ownerId, owners));
  await db().delete(chatScenarioPresets).where(inArray(chatScenarioPresets.ownerId, owners));
  await db()
    .delete(imageIdentityPacks)
    .where(
      or(
        inArray(
          imageIdentityPacks.characterId,
          db().select({ id: characters.id }).from(characters).where(inArray(characters.ownerId, owners)),
        ),
        inArray(imageIdentityPacks.reviewedByUserId, owners),
      ),
    );
  await db()
    .delete(imageIdentityPackTrialGrades)
    .where(inArray(imageIdentityPackTrialGrades.reviewedByUserId, owners));
  await db()
    .delete(imageIdentityPackTrialVerdicts)
    .where(inArray(imageIdentityPackTrialVerdicts.decidedByUserId, owners));
  await db().delete(imageIdentityPackTrialRuns).where(inArray(imageIdentityPackTrialRuns.ownerId, owners));
  await db().delete(characters).where(inArray(characters.ownerId, owners));
  await db().delete(personas).where(inArray(personas.ownerId, owners));
  await db().delete(socialCards).where(inArray(socialCards.ownerId, owners));
  await db().delete(items).where(inArray(items.ownerId, owners));
  await db().delete(locationLinks).where(inArray(locationLinks.ownerId, owners));
  await db().delete(locations).where(inArray(locations.ownerId, owners));
  await db().delete(jobs).where(inArray(jobs.ownerId, owners));
  await db().delete(usageCounters).where(inArray(usageCounters.ownerId, owners));
  await db().delete(simProvisioningRequests).where(inArray(simProvisioningRequests.ownerId, owners));
  await db().delete(users).where(inArray(users.id, owners));
}

/**
 * Close the shared pg pool and clear the global that caches it.
 *
 * Clearing is the load-bearing half. Vitest's forks pool isolates the module
 * registry per test file but REUSES the worker process, so `globalThis` outlives
 * a file: a suite that ends the pool without clearing leaves the next file's
 * fresh `db()` calling `getPool()`, finding the dead handle, and failing with
 * "Cannot use a pool after calling end". Most suites got this right; three ended
 * without clearing, which is the inconsistency this replaces.
 */
export async function endTestPool(): Promise<void> {
  await globalThis.__vesperPool?.end();
  globalThis.__vesperPool = undefined;
}
