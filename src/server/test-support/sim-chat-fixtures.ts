import { eq } from "drizzle-orm";
import type { NextRequest } from "next/server";
import type { EngineAuthority } from "@/contracts/simulation";
import { characters, db, simWorlds } from "@/server/db";
import {
  ROLLOUT_ACTORS,
  ROLLOUT_BRANCH_ID,
  ROLLOUT_WORLD_ID,
  seedRolloutTestWorld,
  setChatEngineAuthority,
  type SetChatEngineAuthorityResult,
} from "@/server/engine";
import { bindAuthUser, type TestAuthState } from "./auth-mock";
import { endTestPool, purgeOwnerRows, seedTestUser } from "./db-fixtures";
import { apiRequest, routeCtx } from "./route-request";

/**
 * The scaffold the sim-routed CHAT suites (`sim-routes`, `sim-shadow`,
 * `sim-command-integrity`, and partly `sim-routing`) open with: reset the fixed
 * rollout world, seed one owner plus a character, create the conversation
 * through the real `POST /api/chats` handler, seed the rollout world, and flip
 * the chat onto the rollout branch with the Mara(player)/Ana(primary) mapping.
 * Four files carried that block verbatim, plus the same five-line teardown.
 *
 * **These suites CANNOT run concurrently with each other.** They all key off the
 * single fixed `ROLLOUT_WORLD_ID` / `ROLLOUT_BRANCH_ID` pair — the seed deletes
 * and recreates that one world, and the commands below advance that one branch
 * clock — so two of them in flight at once tear each other's world out from
 * under the assertions. Run them under `vitest --no-file-parallelism` (what
 * `pnpm test:int` does), and keep them in one sequential invocation when running
 * a subset by hand. Suites that want an isolated world should seed their own id
 * (see `sim-seed.ts`) rather than reach for this module.
 *
 * The `POST /api/chats` handler is passed IN rather than imported here: nothing
 * in `src/server/test-support` imports `src/app`, and keeping it that way stops
 * the barrel — which ~30 unrelated integration suites import — from dragging a
 * Next route module (and with it the Better Auth instance the route's
 * `withUser` resolves) into files that never touch either.
 */

/**
 * A collection-route handler (`POST /api/chats`), typed structurally so this
 * module needs no import from `src/app`. Matches `withUser`'s default `P`.
 */
export type CollectionRouteHandler = (
  req: NextRequest,
  ctx: { params: Promise<Record<string, never>> },
) => Promise<Response>;

/** The ids a routed-sim-chat suite tracks, plus the handler it creates chats with. */
export interface RoutedSimChatFixture {
  userId: string;
  characterId: string;
  /** The first conversation created — `""` when the suite asked for none. */
  chatId: string;
  /** Every conversation `seedRoutedSimChat` created, in creation order. */
  chatIds: string[];
  /** Retained so {@link newSimChat} needs only the fixture. */
  chatsCreate?: CollectionRouteHandler;
}

/**
 * A blank fixture, so a suite can write `let fixture = emptyRoutedSimChat(chatsCreate);`
 * and assign the real one in `beforeAll` without fighting definite assignment
 * when the database probe skipped the file.
 */
export function emptyRoutedSimChat(chatsCreate?: CollectionRouteHandler): RoutedSimChatFixture {
  return { userId: "", characterId: "", chatId: "", chatIds: [], ...(chatsCreate ? { chatsCreate } : {}) };
}

export interface SeedRoutedSimChatOptions {
  /** Suite slug — becomes the (timestamped) user email and the user's name. */
  slug: string;
  /**
   * The suite's `vi.hoisted` identity, rebound to the freshly seeded owner
   * **before** any chat is created. Not optional in practice: `POST /api/chats`
   * resolves the mocked `getCurrentUser`, so an unbound identity makes the create
   * 404 on an owner-strict roster lookup.
   */
  authState: TestAuthState;
  /** `POST /api/chats`. Required only when `chats` is non-zero, or for {@link newSimChat}. */
  chatsCreate?: CollectionRouteHandler;
  /** Default "Ana" — the primary the rollout world's mapping expects. */
  characterName?: string;
  /** Authored profile for the character; default `{}`. */
  profile?: (typeof characters.$inferInsert)["profile"];
  /** How many conversations to create through the handler; default 1. */
  chats?: number;
  /** Default "user" — the sim routes are owner-scoped, not admin-scoped. */
  role?: "user" | "admin";
  /**
   * Default true — drop the fixed rollout world FIRST, so a previous run's
   * leftover state cannot leak into this one. Pass false in a suite that never
   * touches the rollout world (it provisions its own) so it does not stomp on it.
   */
  clearWorld?: boolean;
  /**
   * Default true — seed the fixed rollout world once the chats exist. Pass false
   * when the suite seeds per test instead (see {@link resetRolloutWorld}).
   */
  seedWorld?: boolean;
  /** When set, every created conversation is routed onto the rollout branch under it. */
  authority?: EngineAuthority;
}

/**
 * Drop and re-seed the fixed rollout world.
 *
 * The delete is what makes a suite's first test deterministic: the world id is a
 * constant, so a previous run (or a previous test that advanced the clock) would
 * otherwise leak its state forward. `sim-command-integrity` calls this per test
 * for exactly that reason.
 */
export async function resetRolloutWorld(): Promise<void> {
  await db().delete(simWorlds).where(eq(simWorlds.id, ROLLOUT_WORLD_ID));
  await seedRolloutTestWorld();
}

export interface RouteSimChatOptions {
  chatId: string;
  /** The acting owner — stamped on the authority audit row. */
  byUserId: string;
  authority: EngineAuthority;
  /** Defaults to the rollout branch and its Mara(player)/Ana(primary) pair. */
  branchId?: string;
  playerActorId?: string;
  primaryActorId?: string;
}

/**
 * Route one conversation onto the rollout branch. Throws when the chat does not
 * exist — a missing chat is a fixture bug, never a case under test, and the
 * `null` return would otherwise surface as a confusing `undefined` mismatch.
 */
export async function routeSimChat(options: RouteSimChatOptions): Promise<SetChatEngineAuthorityResult> {
  const result = await setChatEngineAuthority({
    chatId: options.chatId,
    byUserId: options.byUserId,
    authority: options.authority,
    simBranchId: options.branchId ?? ROLLOUT_BRANCH_ID,
    simPlayerActorId: options.playerActorId ?? ROLLOUT_ACTORS.mara,
    simPrimaryActorId: options.primaryActorId ?? ROLLOUT_ACTORS.ana,
  });
  if (!result) throw new Error(`[sim-chat-fixtures] no chat ${options.chatId} to route`);
  return result;
}

export interface NewSimChatOptions {
  /** Route the fresh conversation onto the rollout branch under this authority. */
  authority?: EngineAuthority;
}

/**
 * One more conversation for the fixture's character, created through the real
 * `POST /api/chats` handler (so it gets its participant row, scenario seed and
 * relationship matrix like any other) and optionally routed.
 */
export async function newSimChat(
  fixture: RoutedSimChatFixture,
  options: NewSimChatOptions = {},
): Promise<string> {
  const { chatsCreate } = fixture;
  if (!chatsCreate) throw new Error("[sim-chat-fixtures] newSimChat needs the chatsCreate handler on the fixture");
  const res = await chatsCreate(
    apiRequest("/api/chats", { body: { characterIds: [fixture.characterId], memory: "fresh" } }),
    routeCtx(),
  );
  if (res.status !== 201) throw new Error(`[sim-chat-fixtures] chat create failed: ${res.status}`);
  const { id } = (await res.json()) as { id: string };
  if (options.authority) {
    await routeSimChat({ chatId: id, byUserId: fixture.userId, authority: options.authority });
  }
  return id;
}

/**
 * The shared `beforeAll`. Order matters: the world is reset FIRST (so a leftover
 * from a previous run cannot be read by the create path), the chats are created
 * next, and the world is seeded LAST — `seedRolloutTestWorld` is what the
 * routing then points at.
 */
export async function seedRoutedSimChat(options: SeedRoutedSimChatOptions): Promise<RoutedSimChatFixture> {
  if (options.clearWorld !== false) await db().delete(simWorlds).where(eq(simWorlds.id, ROLLOUT_WORLD_ID));

  const user = await seedTestUser(options.slug, { role: options.role ?? "user" });
  bindAuthUser(options.authState, user);
  const [character] = await db()
    .insert(characters)
    .values({
      ownerId: user.id,
      name: options.characterName ?? "Ana",
      profile: options.profile ?? {},
    })
    .returning({ id: characters.id });
  if (!character) throw new Error("[sim-chat-fixtures] failed to seed the character");

  const fixture: RoutedSimChatFixture = {
    userId: user.id,
    characterId: character.id,
    chatId: "",
    chatIds: [],
    ...(options.chatsCreate ? { chatsCreate: options.chatsCreate } : {}),
  };

  const wanted = options.chats ?? 1;
  for (let index = 0; index < wanted; index += 1) {
    fixture.chatIds.push(await newSimChat(fixture));
  }
  fixture.chatId = fixture.chatIds[0] ?? "";

  if (options.seedWorld !== false) await seedRolloutTestWorld();
  if (options.authority) {
    for (const chatId of fixture.chatIds) {
      await routeSimChat({ chatId, byUserId: fixture.userId, authority: options.authority });
    }
  }
  return fixture;
}

export interface DropRoutedSimChatOptions {
  /** Extra owners seeded alongside the fixture's (a foreign-owner case). */
  ownerIds?: readonly string[];
  /** Dynamically provisioned worlds this suite created, dropped with the fixed one. */
  worldIds?: readonly string[];
  /** Default true — also drop the fixed rollout world. */
  rolloutWorld?: boolean;
  /** Default true — close the shared pool. Keep it the LAST statement of the LAST afterAll. */
  endPool?: boolean;
}

/**
 * FK-safe teardown. `sim_worlds` goes first: `character_chats.sim_branch_id` is
 * `ON DELETE SET NULL`, so either order links, but dropping the world first also
 * clears the sim rows (`purgeOwnerRows` owns no sim table — an orphan is anchored
 * transitively through the chat, never by an owner column). A blank fixture (the
 * probe skipped the file) deletes nothing.
 */
export async function dropRoutedSimChat(
  fixture: RoutedSimChatFixture,
  options: DropRoutedSimChatOptions = {},
): Promise<void> {
  for (const worldId of options.worldIds ?? []) {
    await db().delete(simWorlds).where(eq(simWorlds.id, worldId));
  }
  if (options.rolloutWorld !== false) {
    await db().delete(simWorlds).where(eq(simWorlds.id, ROLLOUT_WORLD_ID));
  }
  await purgeOwnerRows([fixture.userId, ...(options.ownerIds ?? [])]);
  if (options.endPool === false) return;
  await endTestPool();
}
