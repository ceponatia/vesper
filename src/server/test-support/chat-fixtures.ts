import type { AffordanceCueState } from "@/contracts/affordances/core/ranking";
import { DiagnosticCollector } from "@/contracts/diagnostics";
import type { GarmentCueState } from "@/contracts/items/garment-instance";
import type { ChatPlayerState } from "@/contracts/players/chat-player-state";
import type { PersonaProfile } from "@/contracts/players/persona-profile";
import { characterProfileSchema, type CharacterProfile } from "@/contracts/world/profile";
import { newId } from "@/lib/ids";
import { characterChatMessages, characterChats, characters, chatParticipants, db, items } from "@/server/db";
import { endTestPool, purgeOwnerRows, seedTestUser } from "./db-fixtures";
import {
  finalizeChatState,
  loadChatScenario,
  loadChatState,
  seedChatScenario,
  seedChatState,
  type ChatScenario,
  type ChatState,
} from "../engine/chat-state";

/**
 * The chat-lane integration scaffold: one admin user, one character, its library
 * garment rows, and the conversation seat (chat + participant + first user
 * message) every suite opens with.
 *
 * Seven suites hand-rolled this — the same `insertItem` closure, the same
 * `newChat()`, the same four-table teardown, and an eighteen-field
 * `finalizeChatState` call repeated per test with two or three fields varying.
 *
 * `chat-state` is imported by RELATIVE path rather than through `@/server/engine`
 * on purpose: four of these suites `vi.mock("./chat-memory")` with PARTIAL
 * factories, and pulling the whole engine barrel would drag every other consumer
 * of that module's un-stubbed exports into files that never needed them. This
 * import resolves to exactly the module the suites already load themselves, so a
 * suite that imports THIS FILE relatively (`../test-support/chat-fixtures`) loads
 * nothing it did not already load. Reaching it through the `@/server/test-support`
 * barrel does pull the engine barrel in (a sibling module imports it) — fine in
 * practice, since chat-garment-cues already runs the prompt pipeline under a
 * partial chat-memory mock, but that is the one thing worth a smoke check when
 * the first chat suite converts.
 */

// ---------------------------------------------------------------------------
// Garment seeds
// ---------------------------------------------------------------------------

/** The five torso regions a top covers. */
const TORSO_COVERAGE = ["shoulders", "chest", "back", "waist", "upper_arms"] as const;
/** A jacket reaches down the arm as well — the extra two regions are what make
 * it the outer layer whose sleeve the eye can actually reach. */
const TORSO_AND_ARMS_COVERAGE = [...TORSO_COVERAGE, "forearms", "wrists"] as const;

/**
 * One clothing row for the character's library.
 *
 * Omit `category`/`coverage`/`layer` entirely to seed a BARE row (definition
 * `{}`) — chat-wardrobe's fixtures deliberately carry no garment definition,
 * because that suite is about the free-text name-matching bridge, not the
 * modelled store.
 */
export interface GarmentSeedSpec {
  /** Key this item is returned under in `ChatFixture.items`. */
  slug: string;
  /** The library name — load-bearing: the legacy bridge resolves phrases against it. */
  name: string;
  category?: string;
  coverage?: readonly string[];
  layer?: number;
}

/**
 * The canonical wardrobe the four garment suites copy. Names, coverage arrays,
 * and layers are those files' values verbatim: the names are matched by the
 * legacy outfit bridge ("a wool cardigan" vs "grey wool cardigan" resolve
 * differently), and the layers decide which sleeve is reachable.
 */
export const GARMENT_SEEDS = {
  denimJacket: {
    slug: "denimJacket",
    name: "denim jacket",
    category: "outerwear",
    coverage: TORSO_AND_ARMS_COVERAGE,
    layer: 3,
  },
  greyWoolCardigan: {
    slug: "greyWoolCardigan",
    name: "grey wool cardigan",
    category: "outerwear",
    coverage: TORSO_COVERAGE,
    layer: 2,
  },
  woolCardigan: {
    slug: "woolCardigan",
    name: "wool cardigan",
    category: "outerwear",
    coverage: TORSO_COVERAGE,
    layer: 2,
  },
  whiteCottonTee: {
    slug: "whiteCottonTee",
    name: "white cotton tee",
    category: "top",
    coverage: TORSO_COVERAGE,
    layer: 1,
  },
  cottonShirt: {
    slug: "cottonShirt",
    name: "cotton shirt",
    category: "top",
    coverage: TORSO_COVERAGE,
    layer: 1,
  },
} as const satisfies Record<string, GarmentSeedSpec>;

/** Strip a canonical seed down to a definition-less row (chat-wardrobe's shape). */
export function bareGarment(seed: GarmentSeedSpec): GarmentSeedSpec {
  return { slug: seed.slug, name: seed.name };
}

/** An outfit preset whose `items` are garment SLUGS, resolved to library ids on seed. */
export interface OutfitSeedSpec {
  id: string;
  name: string;
  items: readonly string[];
}

// ---------------------------------------------------------------------------
// Fixture
// ---------------------------------------------------------------------------

export interface ChatFixture {
  userId: string;
  characterId: string;
  characterName: string;
  profile: CharacterProfile;
  /** Library item ids, keyed by the garment seed's `slug`. */
  items: Readonly<Record<string, string>>;
}

/**
 * A blank fixture, so a suite can write `let fixture = emptyChatFixture();` and
 * assign the real one in `beforeAll` without fighting definite assignment when
 * the database probe skipped the file.
 */
export function emptyChatFixture(): ChatFixture {
  return {
    userId: "",
    characterId: "",
    characterName: "",
    profile: characterProfileSchema.parse({}),
    items: {},
  };
}

/** A seeded item id, by slug. Throws rather than silently seeding `undefined`. */
export function itemId(fixture: ChatFixture, slug: string): string {
  const id = fixture.items[slug];
  if (id === undefined) throw new Error(`chat fixture has no garment seeded under "${slug}"`);
  return id;
}

export interface SeedChatFixtureOptions {
  /** Suite slug — becomes the (timestamped, so re-runs never collide) user email. */
  slug: string;
  garments?: readonly GarmentSeedSpec[];
  /** Presets on the character profile; `items` name garment slugs, not ids. */
  outfits?: readonly OutfitSeedSpec[];
  /** Default "Wren" — the name every chat suite's prompts and folds expect. */
  characterName?: string;
  userName?: string;
  /** Default "admin": the chat routes' owner checks are exercised elsewhere. */
  role?: "user" | "admin";
}

export async function seedChatFixture(options: SeedChatFixtureOptions): Promise<ChatFixture> {
  const characterName = options.characterName ?? "Wren";
  const user = await seedTestUser(options.slug, {
    ...(options.userName === undefined ? {} : { name: options.userName }),
    role: options.role ?? "admin",
  });

  const seededItems: Record<string, string> = {};
  for (const garment of options.garments ?? []) {
    const definition: Record<string, unknown> = {};
    if (garment.category !== undefined) definition.category = garment.category;
    if (garment.coverage !== undefined) definition.coverage = [...garment.coverage];
    if (garment.layer !== undefined) definition.layer = garment.layer;
    const [row] = await db()
      .insert(items)
      .values({
        ownerId: user.id,
        kind: "clothing",
        name: garment.name,
        description: garment.name,
        definition,
      })
      .returning({ id: items.id });
    if (!row) throw new Error(`failed to create test item "${garment.name}"`);
    seededItems[garment.slug] = row.id;
  }

  const profile = characterProfileSchema.parse({
    outfits: (options.outfits ?? []).map((outfit) => ({
      id: outfit.id,
      name: outfit.name,
      items: outfit.items.map((slug) => {
        const id = seededItems[slug];
        if (id === undefined) throw new Error(`outfit "${outfit.id}" names an unseeded garment slug "${slug}"`);
        return id;
      }),
    })),
  });

  const [character] = await db()
    .insert(characters)
    .values({ ownerId: user.id, name: characterName, profile })
    .returning();
  if (!character) throw new Error("failed to create test character");

  return {
    userId: user.id,
    characterId: character.id,
    characterName,
    profile,
    items: seededItems,
  };
}

/** The three ids one conversation is addressed by. */
export interface ChatSeat {
  chatId: string;
  memoryGroupId: string;
  messageId: string;
}

/** A fresh conversation: the chat, its one participant, and one prompting message. */
export async function newChat(fixture: ChatFixture): Promise<ChatSeat> {
  const [chat] = await db()
    .insert(characterChats)
    .values({ ownerId: fixture.userId })
    .returning({ id: characterChats.id });
  if (!chat) throw new Error("failed to create test chat");
  const memoryGroupId = newId();
  await db().insert(chatParticipants).values({ chatId: chat.id, characterId: fixture.characterId, memoryGroupId });
  const [message] = await db()
    .insert(characterChatMessages)
    .values({ chatId: chat.id, role: "user", content: "Hi" })
    .returning();
  if (!message) throw new Error("failed to create test message");
  return { chatId: chat.id, memoryGroupId, messageId: message.id };
}

// ---------------------------------------------------------------------------
// One settled exchange
// ---------------------------------------------------------------------------

export type SettleChatExchangeOutcome = Awaited<ReturnType<typeof finalizeChatState>>;

export interface SettledChatExchange {
  outcome: SettleChatExchangeOutcome;
  /** The sink the finalize AND both re-reads shared, for diagnostic-code assertions. */
  sink: DiagnosticCollector;
  scenario: ChatScenario | null;
  state: ChatState | null;
}

export interface SettleChatExchangeArgs {
  chat: ChatSeat;
  /** Default: a fresh `seedChatScenario(profile)`. */
  scenario?: ChatScenario;
  /**
   * The rollback anchor. `undefined` ⇒ the same object as `scenario` (what the
   * garment suites want); pass an explicit `null` for "no anchor" (the wardrobe /
   * per-leg suites' first exchange).
   */
  preExchangeScenario?: ChatScenario | null;
  /** Default: `seedChatState(profile)` plus `wornItemIds` when given. */
  driftedState?: ChatState;
  /** `undefined` ⇒ the same value as `driftedState`; pass `null` for a first exchange. */
  preExchangeState?: ChatState | null;
  /** Convenience over `driftedState`: the pre-exchange worn list. */
  wornItemIds?: readonly string[];
  /** The player's persona sheet — arms the player-side outfit fold (persona-library slice 8). */
  playerPersona?: PersonaProfile;
  /** Convenience over `scenario`: the pre-exchange player state (worn list / seeded flag). */
  playerState?: ChatPlayerState;
  /** Slice-6 cue memory the prompt surfaced; omitted ⇒ the store's memory is untouched. */
  garmentCueState?: GarmentCueState;
  /** Affordance cue memory the prompt surfaced; omitted ⇒ the scenario's memory is untouched. */
  affordanceCueState?: AffordanceCueState;
  assistantMessageId?: string;
  exchange?: { player: string; assistant: string };
  characterName?: string;
  playerName?: string;
  now?: Date;
  sink?: DiagnosticCollector;
}

/**
 * Run one exchange through `finalizeChatState` with the defaults every suite
 * repeated — character "Wren", player "You", exchange `Hi` / `Hello.` — and
 * re-read the scenario + state through the SAME sink, because a fold's effect
 * and the diagnostic it emitted are usually asserted together.
 *
 * Both re-reads may be null (the row genuinely may not exist); callers that
 * require them narrow explicitly rather than have the helper throw on a case
 * some suite legitimately tests.
 */
export async function settleChatExchange(
  fixture: ChatFixture,
  args: SettleChatExchangeArgs,
): Promise<SettledChatExchange> {
  const sink = args.sink ?? new DiagnosticCollector();
  const seededScenario = args.scenario ?? seedChatScenario(fixture.profile);
  const scenario =
    args.playerState === undefined ? seededScenario : { ...seededScenario, playerState: args.playerState };
  const seeded: ChatState = seedChatState(fixture.profile);
  const worn = args.wornItemIds;
  const driftedState =
    args.driftedState ?? (worn === undefined ? seeded : { ...seeded, wornItemIds: [...worn] });

  const outcome = await finalizeChatState({
    assistantMessageId: args.assistantMessageId ?? newId(),
    preExchangeState: args.preExchangeState === undefined ? driftedState : args.preExchangeState,
    chatId: args.chat.chatId,
    characterId: fixture.characterId,
    ownerId: fixture.userId,
    memoryGroupId: args.chat.memoryGroupId,
    promptMessageId: args.chat.messageId,
    profile: fixture.profile,
    characterName: args.characterName ?? fixture.characterName,
    playerName: args.playerName ?? "You",
    driftedState,
    now: args.now ?? new Date(),
    exchange: args.exchange ?? { player: "Hi", assistant: "Hello." },
    scenario,
    preExchangeScenario: args.preExchangeScenario === undefined ? scenario : args.preExchangeScenario,
    ...(args.garmentCueState === undefined ? {} : { garmentCueState: args.garmentCueState }),
    ...(args.affordanceCueState === undefined ? {} : { affordanceCueState: args.affordanceCueState }),
    ...(args.playerPersona === undefined ? {} : { playerPersona: args.playerPersona }),
    sink,
  });

  return {
    outcome,
    sink,
    scenario: await loadChatScenario(args.chat.chatId, sink),
    state: await loadChatState(args.chat.chatId, fixture.characterId, sink),
  };
}

// ---------------------------------------------------------------------------
// Teardown
// ---------------------------------------------------------------------------

export interface DropChatFixtureOptions {
  /** Default true — the last thing a chat int file does. Pass false to keep querying. */
  endPool?: boolean;
}

/**
 * FK-safe teardown. The order lives in `purgeOwnerRows` (db-fixtures), which
 * owns the whole owner-scoped FK graph — chats before characters so the chat
 * cascade takes participants/messages/state with it, items and the user last.
 * A blank fixture (the probe skipped the file) deletes nothing.
 */
export async function dropChatFixture(
  fixture: ChatFixture,
  options: DropChatFixtureOptions = {},
): Promise<void> {
  await purgeOwnerRows([fixture.userId]);
  if (options.endPool === false) return;
  await endTestPool();
}
