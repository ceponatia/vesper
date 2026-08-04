import { and, eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  activeContactsOf,
  adapterSupported,
  affordanceSubjectId,
  contactCommitEvents,
  DiagnosticCollector,
  emptyEffectiveCoverageRead,
  emptySceneState,
  garmentActorForCharacter,
  regardBandForValue,
  sceneFacingFact,
  sceneParticipant,
  sceneProximityFact,
  withSceneContacts,
  type CommittedContactOutcome,
  type ContactEventRef,
  type DiagnosticSink,
  type SceneState,
} from "@/contracts";
import type { ChatArchivist } from "@/contracts/turns/chat-archivist";
import { characterChatMessages, characterChats, db } from "@/server/db";
import { codes } from "@/test/diagnostics";

/**
 * The affectionate integration proof (romantic-contact-affordances.plan.md
 * §"Continuation order" 1), end to end through `submitChatMessage`.
 *
 * The adapter's own unit suite already pins detection, resolution and the fold —
 * all of it pure. What only a database can prove is the half this file is about:
 *
 * - a movement turn places bodies and writes NOTHING, and the touch turn that
 *   follows leaves exactly ONE `chat_contact_events` row plus one active contact
 *   in `character_chats.scene` — the ledger and its projection agreeing through
 *   a real jsonb round trip;
 * - a held touch writes no second row: `contact_continued` is the no-op case, and
 *   ten quiet exchanges must stay ONE start;
 * - **the two halves land in ONE transaction.** An exchange frozen mid-stream —
 *   the crash window the old two-write leg had — already shows the row AND the
 *   column, agreeing, before a single token was drained;
 * - "another take" prunes the discarded take's rows and rolls the contact out of
 *   the scene together, so a retake that re-commits the same touch leaves one row
 *   under the SAME event ref rather than two — and the prune is UNCONDITIONAL, so
 *   an on→off→retake sequence cannot strand the old take's rows under the very
 *   key the next take writes;
 * - `appendChatContactEventsWithScene` is idempotent against its own retry AND
 *   verifies the conflict: a DIFFERENT record under this exchange's keys aborts
 *   the whole transaction — no rows added, the scene column untouched — which
 *   only a database can demonstrate;
 * - the leg ENDS contacts as well as starting them: the player's own release
 *   (`withdrawn`), the player's own departure (`separated` — and the distance it
 *   opens, which is the only physical claim an end ever makes), a pending
 *   story-clock skip (`separated`, owner ruling), and walking out of the scene
 *   (`scene_changed`);
 * - with `CHAT_CONTACT_ACTIONS` unset the turn is the pre-feature turn: no rows,
 *   a scene that places nobody, and a system prompt byte-identical to the one the
 *   flag-ON take of that same line builds — the leg can commit a durable contact
 *   and still spend zero prompt bytes;
 * - the silences commit nothing at all while the exchange settles normally, and
 *   file exactly the diagnostics each case is designed to file — including the
 *   MATERIAL one: a dressed body nobody enumerated is `unavailable`, not bare;
 * - a corrupt `scene` blob costs no turn and fails CLOSED;
 * - and the dev inspector explains the whole thing read-only: the same outcome, keyed
 *   to the exchange that wrote it, with no row appended and no body moved.
 *
 * ## What this fixture WEARS, and why every test says so
 *
 * The shared fixture's profile carries NO outfit preset, so `seedChatState` seeds
 * an empty worn list and `chatContactMaterialSource` answers
 * `supported(empty coverage)` — the wardrobe's own "nothing is on that shoulder".
 * Every committing touch below is therefore a genuinely BARE commit under
 * `CHAT_CONTACT_ACTIONS` alone, which is what lets those tests hold the second
 * flag off and keep proving flag-off byte-identity.
 *
 * A DRESSED body is the other half of the material rule and it is staged
 * deliberately, in the material section only: `settleChatExchange({ wornItemIds })`
 * writes one chat's state row with the seeded cardigan on. The contact leg
 * derives that body's coverage from the CURRENT exchange's resolved wardrobe
 * (the settle-race fix), so the dressed commit is reachable under
 * `CHAT_CONTACT_ACTIONS` alone, first rapid touch included — no persisted
 * capture, no second flag, no intervening settle. Only a body nothing can model
 * (a free-text look, legacy worn ids) still answers `unavailable` — silence,
 * never bare skin.
 *
 * Two mocks, both at seams the sibling chat suites already mock. `./chat-memory`
 * stubs the post-turn archivist legs (`AI_FAKE=1` alone would degrade them and
 * prove nothing about this leg). `./character-chat` WRAPS the real demo-mode
 * stream so the system prompt each turn actually built is captured. The preview
 * path runs the contact leg now (section 7), so it can prove flag-off byte-identity
 * on its own — but section 4's proof is about the prompt a live RETAKE builds, and a
 * preview reads the cut that retake settled rather than the one it rebuilt from, so
 * the capture stays.
 */

const mock = vi.hoisted(() => ({ archivist: { value: null as ChatArchivist | null, degraded: false } }));
/** Every system prompt the live turn handed the narrator, oldest first. */
const prompts = vi.hoisted(() => ({ systems: [] as string[] }));

vi.mock("./chat-memory", async () => {
  const { chatMemoryMockModule } = await import("../test-support/chat-archivist-mock");
  // Two exports beyond the shared factory's three, both reached by the paths this
  // suite drives that the preview-only siblings never touch: a regenerate
  // reconciles the discarded take's memory, and every player turn asks the
  // callback picker for a milestone.
  return {
    ...chatMemoryMockModule(mock),
    reconcileMessageMemory: () => Promise.resolve(),
    retrieveChatCallback: () => Promise.resolve(null),
  };
});

vi.mock("./character-chat", async () => {
  const actual = await vi.importActual<typeof import("./character-chat")>("./character-chat");
  return {
    ...actual,
    streamCharacterChat: (input: Parameters<typeof actual.streamCharacterChat>[0]) => {
      prompts.systems.push(input.system);
      return actual.streamCharacterChat(input);
    },
  };
});

import { submitChatMessage } from "@/server/engine";
import { previewChatPhysicalGuidance, previewChatPrompt } from "./chat-pipeline";
import { applyTimeSkipToScenario, loadChatScenario, saveChatScenario, seedChatState } from "./chat-state";
import { PHYSICAL_GUIDANCE_BLOCK_HEADING } from "./chat-physical-guidance-render";
import {
  appendChatContactEventsWithScene,
  listChatContactEvents,
  type ChatContactEventRow,
} from "./chat-contact-events";
import {
  chatContactEventRef,
  endAllChatContacts,
  planChatContactTurn,
  CHAT_CONTACT_PLAYER_SUBJECT,
  type ChatContactMaterialSource,
} from "./chat-contact-adapter";
import {
  chatArchivist,
  dropChatFixture,
  emptyChatFixture,
  GARMENT_SEEDS,
  itemId,
  newChat,
  probeIntegrationDb,
  seedChatFixture,
  settleChatExchange,
  type ChatFixture,
  type ChatSeat,
} from "@/server/test-support";

// The table argument is the migration proof: a database without
// `chat_contact_events` fails the probe exactly as an unreachable one does.
const ready = await probeIntegrationDb("chat-contact.int.test", "chat_contact_events");

let fixture: ChatFixture = emptyChatFixture();

/** The approach that states a distance — without it every touch resolves `unresolved`. */
const move = (): string => `I walk over to ${fixture.characterName}.`;
/** The one act this whole proof is built on. */
const touch = (): string => `I rest my hand on ${fixture.characterName}'s shoulder.`;
/** The player taking their own hand back — the plainest release in English. */
const RELEASE = "I pull my hand back.";
/** The player's whole body moving off, naming nobody — a departure from everyone. */
const STEP_BACK = "I step back.";
/**
 * A line every detector in the leg refuses — "her desk" is furniture, so neither
 * the approach nor the departure reads it — and that `detectSceneMovement` reads
 * as a place change. The reconciliation case: the player moved, so the touch ends.
 */
const DESK = "I walk over to her desk.";
/** A line carrying no act at all — the control for every byte-identity comparison. */
const NEUTRAL = "I ask her how the shop went today.";
/** A line `detectSceneMovement` reads as leaving the room (and no detector reads as an act). */
const LEAVE = "I walk out to the garden.";

beforeAll(async () => {
  if (!ready) return;
  fixture = await seedChatFixture({
    slug: "chat-contact-int",
    userName: "Contact Int",
    // A LIBRARY row only — no outfit preset names it, so the seeded state wears
    // nothing and every touch above section 11 is a bare commit. Section 11 puts
    // it on one chat's state row by hand, which is the only dressed body here.
    garments: [GARMENT_SEEDS.greyWoolCardigan],
  });
  mock.archivist = { value: chatArchivist(), degraded: false };
});

// The flags are process-global and this file drives both. Clearing them between
// tests is what keeps each one's enablement its OWN statement rather than an
// inheritance from whichever test ran before it — load-bearing for the
// byte-identity and material sections, which mean different things under each.
beforeEach(() => {
  delete process.env.CHAT_CONTACT_ACTIONS;
  delete process.env.CHAT_PHYSICAL_CONSTRAINTS;
});

afterAll(async () => {
  delete process.env.CHAT_CONTACT_ACTIONS;
  delete process.env.CHAT_PHYSICAL_CONSTRAINTS;
  await dropChatFixture(fixture);
});

// ---------------------------------------------------------------------------
// Driving one exchange
// ---------------------------------------------------------------------------

/** The character's subject id, as the pipeline's roster mints it. */
const target = () => affordanceSubjectId(fixture.characterId);

/**
 * The material answer for a body the wardrobe says is wearing NOTHING.
 *
 * `ChatContactRosterMember.material` is required and deliberately not defaulted —
 * a roster assembled without it would answer "bare skin" for every character the
 * wardrobe never enumerated. This is the explicit form of the answer the live
 * leg's `chatContactMaterialSource` derives for this fixture, and the store-level
 * tests below state it rather than inherit it.
 */
const bareMaterial = (): ChatContactMaterialSource => adapterSupported(emptyEffectiveCoverageRead());

/**
 * Run one exchange end to end and DRAIN it, which is what settles it: the ledger
 * write and the scene projection land together pre-stream, the rest of the
 * scenario at the generator's completion. Returns the streamed reply so a test
 * can prove the turn was not lost.
 */
async function drive(
  chat: ChatSeat,
  args: { kind: "send" | "regenerate"; content?: string; sink?: DiagnosticSink },
): Promise<string> {
  const result = await submitChatMessage({
    chatId: chat.chatId,
    memoryGroupId: chat.memoryGroupId,
    character: { id: fixture.characterId, name: fixture.characterName, profile: fixture.profile },
    kind: args.kind,
    ...(args.content === undefined ? {} : { content: args.content }),
    ...(args.sink === undefined ? {} : { sink: args.sink }),
  });
  if (!result.ok) throw new Error(`exchange rejected: ${result.code}`);
  let full = "";
  for await (const chunk of result.stream) full += chunk;
  return full;
}

const say = (chat: ChatSeat, content: string): Promise<string> => drive(chat, { kind: "send", content });

/**
 * One exchange, plus the diagnostic codes it filed.
 *
 * `submitChatMessage` takes an optional `sink` that it tees every diagnostic into
 * as the turn files them, which is what makes the silence paths assertable here.
 * `drive` drains the stream before returning, so the settle step — where the
 * post-turn half of the codes land — has already run by the time we read it.
 */
async function sayWithDiagnostics(chat: ChatSeat, content: string): Promise<{ reply: string; codes: string[] }> {
  const sink = new DiagnosticCollector();
  const reply = await drive(chat, { kind: "send", content, sink });
  return { reply, codes: codes(sink) };
}

/** "Another take" on the newest exchange — the retake path, guard and anchors included. */
const retake = (chat: ChatSeat): Promise<string> => drive(chat, { kind: "regenerate" });

/** The system prompt the newest turn built. */
function lastPrompt(): string {
  const system = prompts.systems.at(-1);
  if (system === undefined) throw new Error("no system prompt was built");
  return system;
}

// ---------------------------------------------------------------------------
// Reading what landed
// ---------------------------------------------------------------------------

/** The stored scene, through the same boundary the pipeline loads it through. */
async function storedScene(chatId: string, sink?: DiagnosticCollector): Promise<SceneState> {
  const scenario = await loadChatScenario(chatId, sink);
  if (!scenario) throw new Error("scenario missing");
  return scenario.scene;
}

/**
 * The `scene` COLUMN, unparsed.
 *
 * **The column is NOT null after a flag-off exchange.** `saveChatScenario` writes
 * the whole scenario blob every settled turn, `scene` included, and the scenario's
 * default is `emptySceneState()` — so a flag-off conversation materializes the
 * column with a scene that places nobody. That is the flag-off guarantee this
 * suite can actually assert: no bodies, no distances, nothing touching. What the
 * flag gates is what goes IN it.
 */
async function rawScene(chatId: string): Promise<unknown> {
  const [row] = await db().select({ scene: characterChats.scene }).from(characterChats).where(eq(characterChats.id, chatId));
  return row?.scene ?? null;
}

/** Nothing was placed, nothing is touching — the flag-off (and degraded) reading. */
async function expectEmptyScene(chatId: string): Promise<void> {
  expect(await storedScene(chatId)).toEqual(emptySceneState());
}

/** The player line carrying this exact text — the exchange guard the ledger keys on. */
async function playerLineId(chatId: string, content: string): Promise<string> {
  const rows = await db()
    .select({ id: characterChatMessages.id })
    .from(characterChatMessages)
    .where(and(eq(characterChatMessages.chatId, chatId), eq(characterChatMessages.content, content)));
  const first = rows[0];
  if (!first || rows.length > 1) throw new Error(`expected exactly one player line ${JSON.stringify(content)}`);
  return first.id;
}

/** Rewrite a stored player line, so a retake re-runs the same exchange over different words. */
async function rewriteLine(messageId: string, content: string): Promise<void> {
  await db().update(characterChatMessages).set({ content }).where(eq(characterChatMessages.id, messageId));
}

/** The single ledger row this chat holds, or a failure naming what it holds instead. */
async function soleRow(chatId: string): Promise<ChatContactEventRow> {
  const rows = await listChatContactEvents(chatId);
  const row = rows[0];
  if (!row || rows.length !== 1) throw new Error(`expected exactly one ledger row, got ${rows.length}`);
  return row;
}

/** A conversation that has walked over and touched — the arc most proofs start from. */
async function touchedChat(): Promise<{ chat: ChatSeat; guardMessageId: string }> {
  const chat = await newChat(fixture);
  await say(chat, move());
  await say(chat, touch());
  return { chat, guardMessageId: await playerLineId(chat.chatId, touch()) };
}

// ---------------------------------------------------------------------------
// 1. Durable events
// ---------------------------------------------------------------------------

describe.runIf(ready)("durable events — one touch, one row, one contact", () => {
  it("places the bodies on the movement turn and records NOTHING", async () => {
    process.env.CHAT_CONTACT_ACTIONS = "on";
    const chat = await newChat(fixture);
    expect((await say(chat, move())).length).toBeGreaterThan(0);

    // Where the bodies are is true whether or not anything touched, so it rides the
    // scenario — but a distance is not a contact, and nothing durable is claimed.
    const scene = await storedScene(chat.chatId);
    expect(sceneProximityFact(scene, CHAT_CONTACT_PLAYER_SUBJECT, target())?.value).toBe("close");
    expect(sceneFacingFact(scene, CHAT_CONTACT_PLAYER_SUBJECT, target())?.value).toBe("toward");
    // The mover's own facts only: which way SHE is turned is hers.
    expect(sceneFacingFact(scene, target(), CHAT_CONTACT_PLAYER_SUBJECT)).toBeUndefined();
    expect(sceneParticipant(scene, CHAT_CONTACT_PLAYER_SUBJECT)?.control?.value).toBe("player_controlled");
    expect(sceneParticipant(scene, target())?.control?.value).toBe("npc_controlled");
    expect(activeContactsOf(scene.contacts)).toEqual([]);
    expect(await listChatContactEvents(chat.chatId)).toEqual([]);
  });

  it("writes exactly one contact_started row, keyed to the exchange, with the projection to match", async () => {
    process.env.CHAT_CONTACT_ACTIONS = "on";
    const chat = await newChat(fixture);
    await say(chat, move());
    await say(chat, touch());
    const guardMessageId = await playerLineId(chat.chatId, touch());

    const scenario = await loadChatScenario(chat.chatId);
    if (!scenario) throw new Error("scenario missing");
    // Two settled exchanges on a one-minute tick.
    expect(scenario.clockMinutes).toBe(2);

    const row = await soleRow(chat.chatId);
    expect(row.kind).toBe("contact_started");
    expect(row.guardMessageId).toBe(guardMessageId);
    expect(row.eventRef).toBe(`contact:${guardMessageId}`);
    expect(row.eventRef).toBe(String(chatContactEventRef(guardMessageId)));
    expect(row.sequence).toBe(0);
    expect(row.storyMinute).toBe(scenario.clockMinutes);

    // The projection is a CACHE of that row, and the two name the same contact.
    const active = activeContactsOf(scenario.scene.contacts);
    expect(active).toHaveLength(1);
    const contact = active[0];
    if (!contact) throw new Error("no active contact");
    expect(row.contactId).toBe(contact.contactId);
    expect(contact.source).toEqual({ kind: "body", subjectId: CHAT_CONTACT_PLAYER_SUBJECT, locationId: "hands" });
    expect(contact.target).toEqual({ kind: "body", subjectId: target(), locationId: "shoulders" });
    expect(contact.actionKind).toBe("affectionate");
    expect(contact.startedByEventRef).toBe(row.eventRef);
    expect(contact.startedAt).toBe(scenario.clockMinutes);
    // Nothing is worn on this fixture, so the wardrobe's own answer is skin —
    // asserted here so section 11's dressed commit is a visible contrast.
    expect(contact.materialBetween).toEqual([]);

    // The payload carries the commit itself, not a summary of it.
    expect(row.payload).toMatchObject({ kind: "contact_started", contact: { contactId: contact.contactId } });
  });

  it("a third identical touch continues the contact — no second row, no moved projection", async () => {
    process.env.CHAT_CONTACT_ACTIONS = "on";
    const { chat } = await touchedChat();
    const before = await storedScene(chat.chatId);
    const beforeRows = await listChatContactEvents(chat.chatId);
    expect(beforeRows).toHaveLength(1);

    expect((await say(chat, touch())).length).toBeGreaterThan(0);

    // `contact_continued` is the no-op case by construction: a held contact keeps
    // its id AND its start event, so ten quiet exchanges are ONE start.
    const afterRows = await listChatContactEvents(chat.chatId);
    expect(afterRows.map((entry) => entry.id)).toEqual(beforeRows.map((entry) => entry.id));
    expect(activeContactsOf((await storedScene(chat.chatId)).contacts)).toEqual(
      activeContactsOf(before.contacts),
    );
  });
});

// ---------------------------------------------------------------------------
// 2. Atomicity — the row and the projection are ONE write
// ---------------------------------------------------------------------------

/**
 * The crash window the two-write leg had, closed by construction.
 *
 * Before `appendChatContactEventsWithScene`, the rows were appended pre-prompt
 * while `character_chats.scene` only persisted at settle — so an exchange that
 * appended and then never settled (a stream failure, a crash, a chat cleared
 * mid-turn) left a durable row describing a contact the projection had never
 * heard of. That gap is not narrow enough to test by racing it; what IS testable
 * is that it no longer exists, because a mid-stream exchange already shows both
 * halves agreeing.
 */
describe.runIf(ready)("the ledger row and the projection land together", () => {
  it("shows both halves, agreeing, on an exchange frozen mid-stream — and nothing double-applies at settle", async () => {
    process.env.CHAT_CONTACT_ACTIONS = "on";
    const chat = await newChat(fixture);
    await say(chat, move());

    // Drive the pipeline directly and pull ONE token, so the exchange is genuinely
    // mid-stream: the reply has begun and the settle step has NOT run.
    const inFlight = await submitChatMessage({
      chatId: chat.chatId,
      memoryGroupId: chat.memoryGroupId,
      character: { id: fixture.characterId, name: fixture.characterName, profile: fixture.profile },
      kind: "send",
      content: touch(),
    });
    if (!inFlight.ok) throw new Error(`exchange rejected: ${inFlight.code}`);
    expect((await inFlight.stream.next()).done).toBe(false); // mid-stream now

    // The row is already durable…
    const midRow = await soleRow(chat.chatId);
    expect(midRow.kind).toBe("contact_started");
    expect(midRow.guardMessageId).toBe(await playerLineId(chat.chatId, touch()));
    // …and so is the COLUMN it folds into — same contact, same value, no settle
    // involved. Read as raw jsonb first, so this is a claim about the column
    // rather than about the loader's defaulting.
    const midColumn = await rawScene(chat.chatId);
    expect(midColumn).not.toBeNull();
    // The contact id carries the core's own unit separators, so the needle is the
    // JSON-ESCAPED form — a raw compare would look for bytes no jsonb ever holds.
    expect(JSON.stringify(midColumn)).toContain(JSON.stringify(midRow.contactId).slice(1, -1));
    const midContacts = activeContactsOf((await storedScene(chat.chatId)).contacts);
    expect(midContacts.map((contact) => contact.contactId)).toEqual([midRow.contactId]);

    // Settle. The finalizer re-writes the same column with the same value — a
    // no-op by construction — and the ledger gains nothing.
    let drained = "";
    for await (const chunk of inFlight.stream) drained += chunk;
    expect(drained.length).toBeGreaterThan(0);

    const settledRow = await soleRow(chat.chatId);
    expect(settledRow.id).toBe(midRow.id);
    expect(settledRow.contactId).toBe(midRow.contactId);
    const settled = activeContactsOf((await storedScene(chat.chatId)).contacts);
    expect(settled).toEqual(midContacts);
  });
});

// ---------------------------------------------------------------------------
// 3. Snapshot restoration — a retake leaves no duplicates
// ---------------------------------------------------------------------------

describe.runIf(ready)("another take restores the snapshot and prunes what it discarded", () => {
  it("drops the discarded take's rows, rolls the contact out of the scene, and re-commits under the same ref", async () => {
    process.env.CHAT_CONTACT_ACTIONS = "on";
    const { chat, guardMessageId } = await touchedChat();
    expect(await listChatContactEvents(chat.chatId)).toHaveLength(1);

    // A second take of that exchange whose line carries no act at all. The ledger
    // delete runs beside the scenario rollback, so the projection and its record are
    // thrown away together.
    await rewriteLine(guardMessageId, NEUTRAL);
    expect((await retake(chat)).length).toBeGreaterThan(0);

    expect(await listChatContactEvents(chat.chatId)).toEqual([]);
    const rolledBack = await storedScene(chat.chatId);
    expect(activeContactsOf(rolledBack.contacts)).toEqual([]);
    // …and the exchange BEFORE this one is untouched: the approach still stands.
    expect(sceneProximityFact(rolledBack, CHAT_CONTACT_PLAYER_SUBJECT, target())?.value).toBe("close");

    // A third take that re-commits the same touch. The event ref is derived from the
    // exchange guard, which the retake reuses — so this is one row again, not a second.
    await rewriteLine(guardMessageId, touch());
    expect((await retake(chat)).length).toBeGreaterThan(0);

    const rows = await listChatContactEvents(chat.chatId);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.eventRef).toBe(`contact:${guardMessageId}`);
    expect(rows[0]?.guardMessageId).toBe(guardMessageId);
    expect(activeContactsOf((await storedScene(chat.chatId)).contacts)).toHaveLength(1);
  });

  /**
   * The prune is UNCONDITIONAL — outside `CHAT_CONTACT_ACTIONS`, deliberately.
   *
   * Gated, this sequence was the leak: the flag going off rolls the projection back
   * (that is `rollbackScenario`, which the flag never gated) while the discarded
   * take's rows survive under the very (chat, event ref, sequence) keys the NEXT
   * take writes. The append's verification would then read them as a real
   * divergence — a `mismatched` abort on a chat whose only sin was a flag flip.
   */
  it("prunes the discarded take's rows even with the flag OFF for the retake", async () => {
    process.env.CHAT_CONTACT_ACTIONS = "on";
    const { chat, guardMessageId } = await touchedChat();
    expect(await listChatContactEvents(chat.chatId)).toHaveLength(1);
    expect(activeContactsOf((await storedScene(chat.chatId)).contacts)).toHaveLength(1);

    delete process.env.CHAT_CONTACT_ACTIONS;
    expect((await retake(chat)).length).toBeGreaterThan(0);

    // Nothing is left of the take that committed: the rows are gone with the
    // projection that cached them, not stranded behind a closed flag.
    expect(await listChatContactEvents(chat.chatId)).toEqual([]);
    const restored = await storedScene(chat.chatId);
    expect(activeContactsOf(restored.contacts)).toEqual([]);
    // The restored scenario is the PRE-exchange one, which is why the approach the
    // earlier exchange folded is still standing.
    expect(sceneProximityFact(restored, CHAT_CONTACT_PLAYER_SUBJECT, target())?.value).toBe("close");

    // …and the keys are genuinely free: turning the flag back on and re-committing
    // the same touch records cleanly rather than colliding with a stale row.
    process.env.CHAT_CONTACT_ACTIONS = "on";
    expect((await retake(chat)).length).toBeGreaterThan(0);
    const row = await soleRow(chat.chatId);
    expect(row.eventRef).toBe(`contact:${guardMessageId}`);
    expect(row.kind).toBe("contact_started");
    expect(activeContactsOf((await storedScene(chat.chatId)).contacts)).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// 4. Retry / idempotency / conflict (store level)
// ---------------------------------------------------------------------------

describe.runIf(ready)("the ledger is idempotent against its own retry, and verifies the conflict", () => {
  /** A real commit stream for one chat, planned exactly as the leg plans it. */
  async function plannedTouch(): Promise<{
    chat: ChatSeat;
    eventRef: ContactEventRef;
    commit: CommittedContactOutcome;
    scene: SceneState;
  }> {
    const chat = await newChat(fixture);
    const eventRef = chatContactEventRef(chat.messageId);
    const planned = planChatContactTurn({
      scene: emptySceneState(),
      message: `${move()} ${touch()}`,
      narratorInput: false,
      characters: [{ subjectId: target(), name: fixture.characterName, aliases: [], material: bareMaterial() }],
      eventRef,
      storyTime: 7,
    });
    const commit = planned.commit;
    if (commit?.status !== "committed") throw new Error("fixture: the shoulder touch must commit");
    return { chat, eventRef, commit, scene: withSceneContacts(planned.scene, commit.state) };
  }

  it("a re-sent event inserts nothing, leaves one row set, and re-lands the same projection", async () => {
    const { chat, eventRef, commit, scene } = await plannedTouch();
    const input = {
      chatId: chat.chatId,
      guardMessageId: chat.messageId,
      eventRef,
      storyMinute: 7,
      commits: contactCommitEvents(commit),
      scene,
    };

    // The crash-retry guarantee: the second write re-derives the same
    // (chat, event ref, sequence) keys and lands nowhere — and `recorded` still
    // means "every attempted row is durably present AS ATTEMPTED".
    expect(await appendChatContactEventsWithScene(input)).toEqual({ status: "recorded", inserted: 1 });
    const afterFirst = await rawScene(chat.chatId);
    expect(await appendChatContactEventsWithScene(input)).toEqual({ status: "recorded", inserted: 0 });
    expect(await rawScene(chat.chatId)).toEqual(afterFirst);

    const row = await soleRow(chat.chatId);
    expect(row.kind).toBe("contact_started");
    expect(row.sequence).toBe(0);
    expect(row.contactId).toBe(commit.contact.contactId);
    expect(activeContactsOf((await storedScene(chat.chatId)).contacts).map((c) => c.contactId)).toEqual([
      commit.contact.contactId,
    ]);
  });

  it("a DIFFERENT record under this exchange's keys aborts the whole write — no rows, no scene", async () => {
    const { chat, eventRef, commit, scene } = await plannedTouch();
    const base = { chatId: chat.chatId, guardMessageId: chat.messageId, eventRef, storyMinute: 7 };
    expect(
      await appendChatContactEventsWithScene({ ...base, commits: contactCommitEvents(commit), scene }),
    ).toEqual({ status: "recorded", inserted: 1 });
    const recorded = await rawScene(chat.chatId);

    // The divergence a stale take leaves: the SAME exchange re-planned with an end
    // prepended, so sequence 0 now says `contact_ended` where the ledger holds
    // `contact_started`, and sequence 1 is a key nothing has taken yet.
    const swept = endAllChatContacts(scene, { reason: "separated", eventRef, storyTime: 8 });
    expect(swept.commits).toHaveLength(1);
    const conflicting = await appendChatContactEventsWithScene({
      ...base,
      commits: [...swept.commits, ...contactCommitEvents(commit)],
      scene: swept.scene,
    });

    // `inserted: 1` is the honest report of what the statement did — and the
    // transaction then threw, so that row is gone with everything else.
    expect(conflicting).toEqual({
      status: "mismatched",
      inserted: 1,
      mismatched: [{ eventRef: String(eventRef), sequence: 0 }],
    });

    const rows = await listChatContactEvents(chat.chatId);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.kind).toBe("contact_started");
    expect(rows[0]?.sequence).toBe(0);
    // The sequence-1 row that DID insert rolled back with the abort…
    expect(rows.map((row) => row.sequence)).toEqual([0]);
    // …and the projection is exactly what the first write left. A caller must not
    // acknowledge a record it did not make, and nothing here made one.
    expect(await rawScene(chat.chatId)).toEqual(recorded);
    expect(activeContactsOf((await storedScene(chat.chatId)).contacts)).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// 5. Ending a contact
// ---------------------------------------------------------------------------

/**
 * A contact is a claim that two surfaces are in contact NOW, so the leg has to be
 * able to stop claiming it. Four ways, and only the first two are something the
 * player wrote as an act:
 *
 * - the player's own RELEASE (`withdrawn`), read by the plan — a hand coming back;
 * - the player's own DEPARTURE (`separated`), read by the same plan — a body
 *   moving off, which additionally states the distance it opened;
 * - a pending story-clock SKIP (`separated`, owner ruling 2026-07-31 — hours do
 *   not pass with a hand left resting somewhere), which ends EVERY contact;
 * - walking out of the scene (`scene_changed`).
 *
 * All four persist through the same transactional append, under the ENDING
 * exchange's own event ref — the ends are that exchange's record, not an
 * amendment to the one that started the contact.
 */
describe.runIf(ready)("the leg ends contacts as well as starting them", () => {
  /** The ended row this chat's newest exchange wrote, with the start row filtered out. */
  async function endRow(chatId: string): Promise<{ row: ChatContactEventRow; all: ChatContactEventRow[] }> {
    const rows = await listChatContactEvents(chatId);
    const ended = rows.filter((row) => row.kind === "contact_ended");
    const row = ended[0];
    if (!row || ended.length !== 1) throw new Error(`expected exactly one contact_ended row, got ${ended.length}`);
    return { row, all: rows };
  }

  it("a release ends the contact the player's own hand was making, reason `withdrawn`", async () => {
    process.env.CHAT_CONTACT_ACTIONS = "on";
    const { chat } = await touchedChat();
    const started = await soleRow(chat.chatId);

    expect((await say(chat, RELEASE)).length).toBeGreaterThan(0);
    const releaseGuardId = await playerLineId(chat.chatId, RELEASE);

    const { row, all } = await endRow(chat.chatId);
    // The start survives — the ledger is append-only, and the end is a SECOND
    // record rather than a retraction of the first.
    expect(all.map((entry) => entry.kind)).toEqual(["contact_started", "contact_ended"]);
    expect(row.contactId).toBe(started.contactId);
    expect(row.sequence).toBe(0);
    // Both the ROW and the ended record inside it are keyed to the new exchange.
    expect(row.guardMessageId).toBe(releaseGuardId);
    expect(row.eventRef).toBe(`contact:${releaseGuardId}`);
    expect(row.payload).toMatchObject({
      kind: "contact_ended",
      reason: "withdrawn",
      contact: { endReason: "withdrawn", endedByEventRef: `contact:${releaseGuardId}`, phase: "ended" },
    });

    // The projection empties with it — and the bodies stay where they were.
    const scene = await storedScene(chat.chatId);
    expect(activeContactsOf(scene.contacts)).toEqual([]);
    expect(sceneProximityFact(scene, CHAT_CONTACT_PLAYER_SUBJECT, target())?.value).toBe("close");
  });

  it("a departure ends the contact and opens the distance, reason `separated`", async () => {
    process.env.CHAT_CONTACT_ACTIONS = "on";
    const { chat } = await touchedChat();
    const started = await soleRow(chat.chatId);

    expect((await say(chat, STEP_BACK)).length).toBeGreaterThan(0);
    const departGuardId = await playerLineId(chat.chatId, STEP_BACK);

    const { row, all } = await endRow(chat.chatId);
    expect(all.map((entry) => entry.kind)).toEqual(["contact_started", "contact_ended"]);
    expect(row.contactId).toBe(started.contactId);
    expect(row.sequence).toBe(0);
    expect(row.guardMessageId).toBe(departGuardId);
    expect(row.eventRef).toBe(`contact:${departGuardId}`);
    expect(row.payload).toMatchObject({
      kind: "contact_ended",
      reason: "separated",
      contact: { endReason: "separated", endedByEventRef: `contact:${departGuardId}`, phase: "ended" },
    });

    const scene = await storedScene(chat.chatId);
    expect(activeContactsOf(scene.contacts)).toEqual([]);
    // The one physical claim an end ever makes, and only because the movement turn
    // had already stated a distance for this departure to WIDEN: `close` → `near`.
    expect(sceneProximityFact(scene, CHAT_CONTACT_PLAYER_SUBJECT, target())?.value).toBe("near");
    // Stepping back is not turning away — only an explicit turn would be.
    expect(sceneFacingFact(scene, CHAT_CONTACT_PLAYER_SUBJECT, target())?.value).toBe("toward");
  });

  it("and the hand cannot reach again until the player walks back over", async () => {
    process.env.CHAT_CONTACT_ACTIONS = "on";
    const { chat } = await touchedChat();
    await say(chat, STEP_BACK);
    const afterDeparture = await listChatContactEvents(chat.chatId);
    expect(afterDeparture.map((row) => row.kind)).toEqual(["contact_started", "contact_ended"]);

    // A step is `near` — one reposition away — so the same touch that committed two
    // exchanges ago now records nothing at all. The distance the player opened is a
    // real answer, and the leg gives it rather than letting the hand cross a gap.
    expect((await say(chat, touch())).length).toBeGreaterThan(0);
    expect(await listChatContactEvents(chat.chatId)).toEqual(afterDeparture);
    expect(activeContactsOf((await storedScene(chat.chatId)).contacts)).toEqual([]);

    // Walking back over re-establishes `close`, and the hand lands again — a NEW
    // contact under the new exchange's ref, never a resurrection of the ended one.
    await say(chat, move());
    expect(sceneProximityFact(await storedScene(chat.chatId), CHAT_CONTACT_PLAYER_SUBJECT, target())?.value).toBe(
      "close",
    );
    expect((await say(chat, touch())).length).toBeGreaterThan(0);

    const rows = await listChatContactEvents(chat.chatId);
    expect(rows.map((row) => row.kind)).toEqual(["contact_started", "contact_ended", "contact_started"]);
    const active = activeContactsOf((await storedScene(chat.chatId)).contacts);
    expect(active.map((contact) => contact.contactId)).toEqual([rows[2]?.contactId]);
    expect(active[0]?.contactId).not.toBe(rows[0]?.contactId);
  });

  /**
   * The reconciliation the possessive guard forces, and the owner's directive
   * settles.
   *
   * "I walk over to her desk" states no distance (the approach guard) and no
   * departure (the same guard, on the "…from <X>" clause) — but
   * `detectSceneMovement` reads it as a place change and mints a micro-place, so
   * the `scene_changed` hook ends the contact. That outcome is CORRECT: the
   * player moved, and a held touch does not survive the mover. Pinned here so a
   * future change to either detector has to face the question rather than
   * silently flip the answer.
   */
  it("walking over to her desk ends the held touch through the place change, and starts nothing", async () => {
    process.env.CHAT_CONTACT_ACTIONS = "on";
    const { chat } = await touchedChat();
    const started = await soleRow(chat.chatId);

    expect((await say(chat, DESK)).length).toBeGreaterThan(0);
    const deskGuardId = await playerLineId(chat.chatId, DESK);

    const { row, all } = await endRow(chat.chatId);
    expect(all.map((entry) => entry.kind)).toEqual(["contact_started", "contact_ended"]);
    expect(row.contactId).toBe(started.contactId);
    expect(row.guardMessageId).toBe(deskGuardId);
    expect(row.payload).toMatchObject({ kind: "contact_ended", reason: "scene_changed" });

    const scene = await storedScene(chat.chatId);
    expect(activeContactsOf(scene.contacts)).toEqual([]);
    // Nothing was started: walking up to her furniture is neither an approach to
    // her nor a departure from her.
    expect(all.filter((entry) => entry.kind === "contact_started")).toHaveLength(1);
    // The place CHANGED, so the distance goes with the contact (owner ruling
    // 2026-08-04). Keeping the old `close` while ending the touch on the grounds
    // that she is no longer here is the contradiction the ruling closes — and it
    // is cleared to UNKNOWN, never to an invented `distant`.
    expect(sceneProximityFact(scene, CHAT_CONTACT_PLAYER_SUBJECT, target())).toBeUndefined();
  });

  it("a pending time skip ends EVERY contact, reason `separated`, on the exchange that sees it", async () => {
    process.env.CHAT_CONTACT_ACTIONS = "on";
    const { chat } = await touchedChat();
    const started = await soleRow(chat.chatId);

    // The skip the way the product applies it: the pure scenario fold the
    // `/api/chats/:chatId/time-skip` route runs, persisted through the same save.
    // The one-shot `pendingSkipNote` it stamps is the signal the NEXT exchange reads.
    const scenario = await loadChatScenario(chat.chatId);
    if (!scenario) throw new Error("scenario missing");
    const skipped = applyTimeSkipToScenario(scenario, "hours", regardBandForValue(0).id, new Date());
    expect(skipped.pendingSkipNote.trim().length).toBeGreaterThan(0);
    await saveChatScenario(chat.chatId, skipped);

    // ANY next exchange sees it — the line itself carries no act at all.
    expect((await say(chat, NEUTRAL)).length).toBeGreaterThan(0);
    const skipGuardId = await playerLineId(chat.chatId, NEUTRAL);

    const { row, all } = await endRow(chat.chatId);
    expect(all.map((entry) => entry.kind)).toEqual(["contact_started", "contact_ended"]);
    expect(row.contactId).toBe(started.contactId);
    expect(row.guardMessageId).toBe(skipGuardId);
    expect(row.eventRef).toBe(`contact:${skipGuardId}`);
    expect(row.payload).toMatchObject({ kind: "contact_ended", reason: "separated" });
    // The end is stamped at the POST-skip clock, which is what makes it later than
    // the contact it ends rather than a time-travelling sweep the core would absorb.
    expect(row.storyMinute).toBeGreaterThan(started.storyMinute);
    const skippedScene = await storedScene(chat.chatId);
    expect(activeContactsOf(skippedScene.contacts)).toEqual([]);
    // Hours passed, so the distance is as gone as the touch (owner ruling
    // 2026-08-04) — unknown, and it stays unknown until somebody moves.
    expect(sceneProximityFact(skippedScene, CHAT_CONTACT_PLAYER_SUBJECT, target())).toBeUndefined();

    // Re-entry restores nothing: an ordinary next turn ticks the clock without
    // re-establishing a band, because only explicit movement may state one.
    expect((await say(chat, NEUTRAL)).length).toBeGreaterThan(0);
    expect(
      sceneProximityFact(await storedScene(chat.chatId), CHAT_CONTACT_PLAYER_SUBJECT, target()),
    ).toBeUndefined();
  });

  it("an ordinary clock tick is NOT a discontinuity — the distance survives an unremarkable turn", async () => {
    process.env.CHAT_CONTACT_ACTIONS = "on";
    const { chat } = await touchedChat();
    expect(sceneProximityFact(await storedScene(chat.chatId), CHAT_CONTACT_PLAYER_SUBJECT, target())?.value).toBe(
      "close",
    );

    // Minutes pass inside one continuous scene, which is what a conversation IS.
    // Clearing on this would make reach permanently unknown and silence every
    // touch that did not re-walk the room first.
    expect((await say(chat, NEUTRAL)).length).toBeGreaterThan(0);
    const scene = await storedScene(chat.chatId);
    expect(sceneProximityFact(scene, CHAT_CONTACT_PLAYER_SUBJECT, target())?.value).toBe("close");
    expect(activeContactsOf(scene.contacts)).toHaveLength(1);
  });

  it("leaving the scene ends every contact, reason `scene_changed`", async () => {
    process.env.CHAT_CONTACT_ACTIONS = "on";
    const { chat } = await touchedChat();
    const started = await soleRow(chat.chatId);

    // The place change is the pipeline's OWN `movedTo` detection over the player
    // line — the same read that switches the scene memory — so this is triggered
    // through `submitChatMessage` input, not through an edit route.
    expect((await say(chat, LEAVE)).length).toBeGreaterThan(0);
    const leaveGuardId = await playerLineId(chat.chatId, LEAVE);

    const { row, all } = await endRow(chat.chatId);
    expect(all.map((entry) => entry.kind)).toEqual(["contact_started", "contact_ended"]);
    expect(row.contactId).toBe(started.contactId);
    expect(row.guardMessageId).toBe(leaveGuardId);
    expect(row.eventRef).toBe(`contact:${leaveGuardId}`);
    expect(row.payload).toMatchObject({ kind: "contact_ended", reason: "scene_changed" });
    const movedScene = await storedScene(chat.chatId);
    expect(activeContactsOf(movedScene.contacts)).toEqual([]);
    // The room changed, so every pair's distance did too (owner ruling 2026-08-04).
    expect(sceneProximityFact(movedScene, CHAT_CONTACT_PLAYER_SUBJECT, target())).toBeUndefined();

    // The scene memory really did move — the end and the place switch read the same signal.
    const scenario = await loadChatScenario(chat.chatId);
    expect(scenario?.sceneMemory.current).toBeTruthy();
  });

  it("a retake rewinds the clearing with the rest of the exchange", async () => {
    process.env.CHAT_CONTACT_ACTIONS = "on";
    const { chat } = await touchedChat();
    expect(sceneProximityFact(await storedScene(chat.chatId), CHAT_CONTACT_PLAYER_SUBJECT, target())?.value).toBe(
      "close",
    );

    // The exchange that leaves the room clears the band along with the contact.
    expect((await say(chat, LEAVE)).length).toBeGreaterThan(0);
    const leaveGuardId = await playerLineId(chat.chatId, LEAVE);
    expect(
      sceneProximityFact(await storedScene(chat.chatId), CHAT_CONTACT_PLAYER_SUBJECT, target()),
    ).toBeUndefined();

    // Another take of that exchange, on a line that leaves nowhere. The clearing
    // rides `pre_exchange_scenario` like every other scene change, so a discarded
    // take does not leave the distance permanently forgotten.
    await rewriteLine(leaveGuardId, NEUTRAL);
    expect((await retake(chat)).length).toBeGreaterThan(0);
    const restored = await storedScene(chat.chatId);
    expect(sceneProximityFact(restored, CHAT_CONTACT_PLAYER_SUBJECT, target())?.value).toBe("close");
    expect(activeContactsOf(restored.contacts)).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// 6. The flag — off is exactly the pre-feature turn
// ---------------------------------------------------------------------------

describe.runIf(ready)("the flag — off is today, byte for byte", () => {
  /**
   * The comparison is FLAG-OFF vs FLAG-ON over the SAME player line, not a touch
   * line vs an ordinary one.
   *
   * Two different lines do not build the same prompt, and the reason has nothing
   * to do with this feature: the pre-existing "Sensory allowance this turn" block
   * classifies the raw player text, and reads a hand on a shoulder as a
   * close-range beat while an ordinary question earns "none". Diffing two lines
   * would therefore fail on a block that predates the contact leg, proving
   * nothing about it. Holding the LINE fixed and moving only the flag isolates
   * exactly the thing under test — and it is the stronger claim anyway: the leg
   * can commit a durable contact and still spend zero prompt bytes.
   */
  it("commits a real contact and STILL builds the byte-identical prompt", async () => {
    const chat = await newChat(fixture);
    // A conversation that has never settled an exchange has no scene at all.
    expect(await rawScene(chat.chatId)).toBeNull();

    // One line that both closes the distance and lands the hand — so the flag-on
    // take can commit without depending on an earlier exchange's fold.
    await say(chat, `${move()} ${touch()}`);
    expect(await listChatContactEvents(chat.chatId)).toEqual([]);
    await expectEmptyScene(chat.chatId);

    await retake(chat);
    const off = lastPrompt();
    process.env.CHAT_CONTACT_ACTIONS = "on";
    await retake(chat);
    expect(lastPrompt()).toBe(off);

    // The leg genuinely ran on that second take — same bytes to the narrator, a
    // durable row and a placed body underneath. Only `CHAT_PHYSICAL_CONSTRAINTS`
    // (off here, as it is by default) can carry the outcome into the prompt.
    expect(await listChatContactEvents(chat.chatId)).toHaveLength(1);
    const scene = await storedScene(chat.chatId);
    expect(sceneProximityFact(scene, CHAT_CONTACT_PLAYER_SUBJECT, target())?.value).toBe("close");
    expect(activeContactsOf(scene.contacts)).toHaveLength(1);
  });

  it("flag ON over a line with no act builds the identical bytes, and still records nothing", async () => {
    const chat = await newChat(fixture);
    await say(chat, move());
    await say(chat, NEUTRAL);

    await retake(chat);
    const off = lastPrompt();
    process.env.CHAT_CONTACT_ACTIONS = "on";
    await retake(chat);
    expect(lastPrompt()).toBe(off);

    // The leg ran — the scene is seeded now, which is authoritative state that must
    // ride the exchange whether or not any prompt reads it — and it committed nothing.
    expect(await listChatContactEvents(chat.chatId)).toEqual([]);
    const scene = await storedScene(chat.chatId);
    expect(scene.participants.map((entry) => entry.subjectId).sort()).toEqual(
      [CHAT_CONTACT_PLAYER_SUBJECT, target()].sort(),
    );
    // Seeding places a body; it never states a distance. The flag-off movement turn
    // above was never folded, so nobody has said where these two are.
    expect(scene.proximity).toEqual([]);
    expect(activeContactsOf(scene.contacts)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// 7. Silence rules
// ---------------------------------------------------------------------------

describe.runIf(ready)("silence beats a guess", () => {
  it("a touch nobody walked over for commits nothing, and the exchange settles anyway", async () => {
    process.env.CHAT_CONTACT_ACTIONS = "on";
    const chat = await newChat(fixture);
    const turn = await sayWithDiagnostics(chat, touch());
    expect(turn.reply.length).toBeGreaterThan(0);

    // A scene nobody has moved in answers `proximity_unknown`, the attempt resolves
    // `unresolved`, and the honest output is no contact rather than a guessed reach.
    // The gap is REPORTED rather than silently swallowed — a developer asking why a
    // touch did nothing gets an answer.
    expect(turn.codes).toContain("scene.relation_unavailable");
    expect(turn.codes).toContain("contact.pose_unavailable");
    expect(await listChatContactEvents(chat.chatId)).toEqual([]);
    const scene = await storedScene(chat.chatId);
    expect(activeContactsOf(scene.contacts)).toEqual([]);
    expect(scene.proximity).toEqual([]);
    // The bodies ARE placed — seeding is not a physical claim, and it still happened.
    expect(scene.participants).toHaveLength(2);
  });

  it("a romantically framed line produces nothing at all (the never-relabel ruling)", async () => {
    process.env.CHAT_CONTACT_ACTIONS = "on";
    const chat = await newChat(fixture);
    await say(chat, move());
    const placed = await storedScene(chat.chatId);

    for (const line of [`I kiss ${fixture.characterName}.`, `I caress ${fixture.characterName}'s thigh.`]) {
      const turn = await sayWithDiagnostics(chat, line);
      expect(turn.reply.length).toBeGreaterThan(0);
      expect(await listChatContactEvents(chat.chatId)).toEqual([]);
      // Nothing at all: no resolution ran, so unlike the out-of-reach case above there
      // is not even a `contact.*` gap to report — the sentence never became an attempt.
      expect(turn.codes.filter((code) => code.startsWith("contact."))).toEqual([]);
      // And not one fact moves: the sentence is vetoed WHOLE, so neither detector reads it.
      expect(await storedScene(chat.chatId)).toEqual(placed);
    }
  });

  /**
   * The possessed-destination guard, end to end.
   *
   * "I walk over to her desk" is an approach to FURNITURE, and the movement
   * detector's one-token capture cannot see that on its own — the possessive
   * resolves to the person who owns the thing. Left unguarded, the turn commits a
   * `close` proximity claim about a body the player walked PAST, and the touch
   * that follows then lands on that invented distance. This is the regression
   * that costs a durable row.
   */
  it("an approach to her DESK states no distance, so the touch after it commits nothing", async () => {
    process.env.CHAT_CONTACT_ACTIONS = "on";
    const chat = await newChat(fixture);
    // `her` resolves to the sole roster member, so the ONLY thing standing between
    // this line and a `close` proximity claim is the possessive guard.
    expect((await say(chat, "I walk over to her desk.")).length).toBeGreaterThan(0);

    // Nobody said how far apart these two are — the sole roster member is not made
    // reachable by the player crossing the room toward her furniture.
    const afterApproach = await storedScene(chat.chatId);
    expect(sceneProximityFact(afterApproach, CHAT_CONTACT_PLAYER_SUBJECT, target())).toBeUndefined();
    expect(afterApproach.proximity).toEqual([]);
    expect(afterApproach.participants).toHaveLength(2);

    const turn = await sayWithDiagnostics(chat, touch());
    expect(turn.reply.length).toBeGreaterThan(0);
    // The touch is UNREACHABLE, so it resolves `unresolved` and records nothing.
    expect(turn.codes).toContain("contact.pose_unavailable");
    expect(await listChatContactEvents(chat.chatId)).toEqual([]);
    const scene = await storedScene(chat.chatId);
    expect(activeContactsOf(scene.contacts)).toEqual([]);
    expect(sceneProximityFact(scene, CHAT_CONTACT_PLAYER_SUBJECT, target())).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// 8. Material honesty
// ---------------------------------------------------------------------------

/**
 * The material rule, on its CURRENT-CUT footing (the settle-race fix).
 *
 * The chat lane has three wardrobe situations and only ONE of them is bare:
 * coverage this exchange's own resolved wardrobe models (the answer — derived
 * pre-prompt, never read from the previous settle's capture), a body dressed in
 * clothes nothing can model (**unavailable** — silence), and a wardrobe that
 * says nothing is worn (`[]`, genuinely skin). Reading the second as the third
 * made "we never staged a wardrobe" indistinguishable from "she is bare"; and
 * reading the FIRST from the previous settle's capture made a rapid follow-up
 * touch no-op with `contact.material_unavailable` for a body whose wardrobe the
 * very same turn had already resolved — the trial's B-S2/B-S5 race.
 *
 * The dressed body is staged deliberately, in this section only: the cardigan
 * goes on one chat's state row and the finalizer's reconcile materializes the
 * store. NO flag other than `CHAT_CONTACT_ACTIONS` is needed for the dressed
 * commit any more — that is the fix — and no settle has to intervene between
 * the movement and the touch.
 */
describe.runIf(ready)("material honesty — the current cut answers, unmodelled stays silent", () => {
  /** A conversation whose character is wearing the seeded cardigan (which covers shoulders). */
  async function dressedChat(): Promise<ChatSeat> {
    const chat = await newChat(fixture);
    // One settled exchange that puts the garment on the state row — and, through
    // the finalizer's own reconcile, materializes the garment store for this actor.
    await settleChatExchange(fixture, { chat, wornItemIds: [itemId(fixture, "greyWoolCardigan")] });
    return chat;
  }

  it("(1) the contact flag ALONE, no persisted capture: the first rapid touch commits WITH the cloth", async () => {
    process.env.CHAT_CONTACT_ACTIONS = "on";
    const chat = await dressedChat();
    await say(chat, move());
    // Reachable — the approach landed — so material is the only question left.
    const placed = await storedScene(chat.chatId);
    expect(sceneProximityFact(placed, CHAT_CONTACT_PLAYER_SUBJECT, target())?.value).toBe("close");

    // The RACE premise, reproduced deliberately: strip the persisted capture so
    // the touch exchange begins exactly as a rapid send does — the prior
    // settle's capture not yet landed. (It has to be stripped by hand now
    // because the leg itself persists a capture at every settle: that thread is
    // part of the same fix.)
    const staged = await loadChatScenario(chat.chatId);
    if (!staged) throw new Error("scenario missing");
    await saveChatScenario(chat.chatId, { ...staged, garments: { ...staged.garments, coverage: {} } });
    const raced = await loadChatScenario(chat.chatId);
    expect(Object.keys(raced?.garments.coverage ?? {})).toEqual([]);

    const turn = await sayWithDiagnostics(chat, touch());
    expect(turn.reply.length).toBeGreaterThan(0);
    // The current cut answered — no material gap, no guidance flag needed.
    expect(turn.codes).not.toContain("contact.material_unavailable");

    const row = await soleRow(chat.chatId);
    expect(row.kind).toBe("contact_started");
    const active = activeContactsOf((await storedScene(chat.chatId)).contacts);
    expect(active).toHaveLength(1);
    const contact = active[0];
    if (!contact) throw new Error("no active contact");
    expect(contact.contactId).toBe(row.contactId);
    // The hand landed on a SLEEVE, and the committed record says so rather than
    // claiming skin (`any_material` — an affectionate hand is happy with cloth).
    expect(contact.materialBetween.length).toBeGreaterThan(0);
    expect(contact.materialBetween[0]?.tactileTransmission).toBeGreaterThan(0);
    // (5) Contact-state correctness spent ZERO prompt bytes: guidance stayed off.
    expect(lastPrompt()).not.toContain(PHYSICAL_GUIDANCE_BLOCK_HEADING);

    // And settlement persisted the very capture the leg derived: the coverage
    // is threaded to the finalizer, not recomputed at settle.
    const settled = await loadChatScenario(chat.chatId);
    expect(Object.keys(settled?.garments.coverage ?? {})).toHaveLength(1);
  });

  it("(2) a STALE persisted capture loses to the current cut", async () => {
    process.env.CHAT_CONTACT_ACTIONS = "on";
    const chat = await dressedChat();
    await say(chat, move());

    // A capture from an earlier cut, claiming the body is BARE — garments the
    // current wardrobe contradicts (the cardigan covers the shoulders now).
    const staged = await loadChatScenario(chat.chatId);
    if (!staged) throw new Error("scenario missing");
    await saveChatScenario(chat.chatId, {
      ...staged,
      garments: {
        ...staged.garments,
        coverage: { [garmentActorForCharacter(fixture.characterId)]: { atMinutes: 0, entries: [] } },
      },
    });

    const turn = await sayWithDiagnostics(chat, touch());
    expect(turn.reply.length).toBeGreaterThan(0);
    expect(turn.codes).not.toContain("contact.material_unavailable");
    // The CURRENT capture won: the contact carries the cloth the stale capture
    // said was not there.
    const active = activeContactsOf((await storedScene(chat.chatId)).contacts);
    expect(active[0]?.materialBetween.length).toBeGreaterThan(0);
  });

  it("(3) an UNMODELLED dressed body stays unavailable — silence, never bare skin", async () => {
    process.env.CHAT_CONTACT_ACTIONS = "on";
    const chat = await newChat(fixture);
    // A free-text look only: dressed, in clothes no store models. Derivation
    // cannot run for this body, and no stale capture may answer for it.
    await settleChatExchange(fixture, {
      chat,
      driftedState: { ...seedChatState(fixture.profile), outfit: "a red sundress" },
    });
    await say(chat, move());

    const turn = await sayWithDiagnostics(chat, touch());
    expect(turn.reply.length).toBeGreaterThan(0);
    expect(turn.codes).toContain("contact.material_unavailable");
    expect(turn.codes).not.toContain("contact.pose_unavailable");
    expect(await listChatContactEvents(chat.chatId)).toEqual([]);
    expect(activeContactsOf((await storedScene(chat.chatId)).contacts)).toEqual([]);
  });

  it("(7) a retake of the dressed commit keeps its identity — same ref, same contact, one row set", async () => {
    process.env.CHAT_CONTACT_ACTIONS = "on";
    const chat = await dressedChat();
    await say(chat, move());
    await say(chat, touch());
    const first = await soleRow(chat.chatId);

    await retake(chat);

    // The new take re-derived the same current-cut coverage and re-committed the
    // identical contact under the identical event ref — one row set, no drift.
    const second = await soleRow(chat.chatId);
    expect(second.eventRef).toBe(first.eventRef);
    expect(second.contactId).toBe(first.contactId);
    expect(second.sequence).toBe(first.sequence);
    const active = activeContactsOf((await storedScene(chat.chatId)).contacts);
    expect(active).toHaveLength(1);
    expect(active[0]?.materialBetween.length).toBeGreaterThan(0);
  });

  it("with CHAT_PHYSICAL_CONSTRAINTS on as well, the leg shares the affordance read's capture — same commit, same cloth", async () => {
    process.env.CHAT_CONTACT_ACTIONS = "on";
    process.env.CHAT_PHYSICAL_CONSTRAINTS = "on";
    const chat = await dressedChat();
    await say(chat, move());

    const turn = await sayWithDiagnostics(chat, touch());
    expect(turn.reply.length).toBeGreaterThan(0);
    expect(turn.codes).not.toContain("contact.material_unavailable");
    const active = activeContactsOf((await storedScene(chat.chatId)).contacts);
    expect(active).toHaveLength(1);
    expect(active[0]?.materialBetween.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// 8b. The reach premise (S3)
// ---------------------------------------------------------------------------

/**
 * The S3 finding, fixed at the narrator boundary: an unreachable touch resolves
 * `unresolved` (honest state — no row, no proximity, the designed diagnostics)
 * and, under `CHAT_PHYSICAL_CONSTRAINTS`, the prompt now carries ONE typed
 * presentation constraint saying reach is not established — never that the
 * target is far away, refused, or moved.
 */
describe.runIf(ready)("the reach premise reaches the prompt, and only the prompt", () => {
  const PREMISE = "Unestablished reach:";

  it("(1) a touch with unknown reach: constraint in the prompt, contact unresolved, state untouched", async () => {
    process.env.CHAT_CONTACT_ACTIONS = "on";
    process.env.CHAT_PHYSICAL_CONSTRAINTS = "on";
    const chat = await newChat(fixture);
    const turn = await sayWithDiagnostics(chat, touch());
    expect(turn.reply.length).toBeGreaterThan(0);

    // Honest state, exactly as before the constraint existed.
    expect(turn.codes).toContain("scene.relation_unavailable");
    expect(turn.codes).toContain("contact.pose_unavailable");
    expect(await listChatContactEvents(chat.chatId)).toEqual([]);
    const scene = await storedScene(chat.chatId);
    expect(activeContactsOf(scene.contacts)).toEqual([]);
    expect(scene.proximity).toEqual([]);

    // And the presentation half: the premise line, with the target and surface.
    const prompt = lastPrompt();
    expect(prompt).toContain(PREMISE);
    expect(prompt).toContain(`can reach ${fixture.characterName}'s shoulder`);
    expect(prompt).toContain("do not invent movement by either participant");
    // It states the GAP only — never a positive fact the scene does not own.
    expect(prompt).not.toContain("across the room");
    expect(prompt).not.toContain("far apart");
  });

  it("(2)(3) established reach — same turn or earlier — earns no premise", async () => {
    process.env.CHAT_CONTACT_ACTIONS = "on";
    process.env.CHAT_PHYSICAL_CONSTRAINTS = "on";
    const chat = await newChat(fixture);
    // Same-turn approach + touch: commits, no premise.
    await say(chat, `${move()} ${touch()}`);
    expect(lastPrompt()).not.toContain(PREMISE);
    expect(activeContactsOf((await storedScene(chat.chatId)).contacts)).toHaveLength(1);
  });

  it("(4)(5) other failures keep their own wording: out-of-reach stays typed, material stays material", async () => {
    process.env.CHAT_CONTACT_ACTIONS = "on";
    process.env.CHAT_PHYSICAL_CONSTRAINTS = "on";
    const chat = await newChat(fixture);
    await say(chat, move());
    await say(chat, touch());
    await say(chat, RELEASE);
    await say(chat, STEP_BACK);
    // `near` now: the touch needs a visible reposition — the EXISTING typed
    // requirement, not an unknown-reach premise.
    const turn = await sayWithDiagnostics(chat, touch());
    expect(turn.reply.length).toBeGreaterThan(0);
    const prompt = lastPrompt();
    expect(prompt).not.toContain(PREMISE);
    expect(prompt).toContain("the distance would have to be closed first");
  });

  it("(6) vetoed lines produce no act and no premise", async () => {
    process.env.CHAT_CONTACT_ACTIONS = "on";
    process.env.CHAT_PHYSICAL_CONSTRAINTS = "on";
    const chat = await newChat(fixture);
    for (const line of [`I kiss ${fixture.characterName}.`, `Maybe I rest my hand on her shoulder.`]) {
      await say(chat, line);
      expect(lastPrompt()).not.toContain(PREMISE);
    }
    expect(await listChatContactEvents(chat.chatId)).toEqual([]);
  });

  it("(7) with CHAT_PHYSICAL_CONSTRAINTS off, the premise spends no bytes — byte-identical prompt", async () => {
    process.env.CHAT_CONTACT_ACTIONS = "on";
    const chat = await newChat(fixture);
    // The unreachable touch, contact flag on, guidance off — the S3 state path.
    await say(chat, touch());
    const off = lastPrompt();
    expect(off).not.toContain(PREMISE);
    expect(off).not.toContain(PHYSICAL_GUIDANCE_BLOCK_HEADING);

    // The same take again with guidance ON adds exactly the guidance block; the
    // flag-off bytes never carried the premise.
    process.env.CHAT_PHYSICAL_CONSTRAINTS = "on";
    await retake(chat);
    expect(lastPrompt()).toContain(PREMISE);
  });
});

// ---------------------------------------------------------------------------
// 9. Degradation
// ---------------------------------------------------------------------------

describe.runIf(ready)("a corrupt scene blob costs no turn, and fails closed", () => {
  it("reads as the empty scene with scene.state_invalid, and the next exchange settles", async () => {
    process.env.CHAT_CONTACT_ACTIONS = "on";
    const chat = await newChat(fixture);
    await say(chat, move());
    expect(await rawScene(chat.chatId)).not.toBeNull();

    await db().execute(sql`update ${characterChats} set scene = '{"version":"weird"}'::jsonb where id = ${chat.chatId}`);

    const sink = new DiagnosticCollector();
    expect(await storedScene(chat.chatId, sink)).toEqual(emptySceneState());
    // A version this build cannot read degrades to "nobody placed" — never optimism.
    expect(sink.items.find((item) => item.code === "scene.state_invalid")).toBeDefined();

    // The next exchange runs normally AND fails closed: the distance the movement
    // stated is gone with the blob, so the touch through it commits nothing.
    expect((await say(chat, touch())).length).toBeGreaterThan(0);
    expect(await listChatContactEvents(chat.chatId)).toEqual([]);
    const healed = await storedScene(chat.chatId);
    expect(activeContactsOf(healed.contacts)).toEqual([]);
    // …and the column re-materializes: the seeded bodies are back.
    expect(healed.participants).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// 10. The dev inspector
// ---------------------------------------------------------------------------

/**
 * The two preview surfaces, over a conversation that has actually walked over and
 * touched.
 *
 * The preview path used to skip the contact leg outright, which left the one surface
 * built to answer "why did this turn say that" unable to answer it for a contact turn
 * — and forced the byte-identity proof in section 6 to capture the LIVE system prompt
 * through a module mock. It runs the leg now, and these are the claims that buys:
 *
 * - the inspector shows the outcome a live turn carries, keyed to the exchange that
 *   turn actually wrote, and the previewed PROMPT carries the same sentence;
 * - the prompt preview obeys `CHAT_CONTACT_ACTIONS` (it is showing bytes) while the
 *   inspector reports it (a developer needs the answer before flipping it);
 * - previewing writes nothing — no ledger row, no moved body — which is the whole
 *   licence for running a leg whose live half persists.
 */
describe.runIf(ready)("the inspector shows the leg, and writes nothing", () => {
  /** The sentence a committed contact puts in front of the narrator. */
  const committedSentence = (): string => `the player's hand rests on ${fixture.characterName}'s shoulder`;

  const character = () => ({ id: fixture.characterId, name: fixture.characterName, profile: fixture.profile });

  const inspect = (chat: ChatSeat) => previewChatPhysicalGuidance({ chatId: chat.chatId, character: character() });

  /** "What reaches the narrator right now", as the prompt inspector renders it. */
  async function previewedPrompt(chat: ChatSeat): Promise<string> {
    const built = await previewChatPrompt({
      chatId: chat.chatId,
      memoryGroupId: chat.memoryGroupId,
      character: character(),
    });
    return `${built.prefix}\n${built.tail}`;
  }

  it("shows the committed outcome, keyed to the exchange the live turn wrote", async () => {
    process.env.CHAT_CONTACT_ACTIONS = "on";
    process.env.CHAT_PHYSICAL_CONSTRAINTS = "on";
    const { chat, guardMessageId } = await touchedChat();

    const shown = await inspect(chat);
    expect(shown.contactFlagEnabled).toBe(true);
    const outcome = shown.candidates.actionOutcomes[0];
    expect(outcome?.status).toBe("committed");
    expect(outcome?.resultCodes).toContain("contact.locus.shoulders");
    expect(outcome?.resultCodes).toContain("contact.gesture.rest");
    // It survived the disclosure gate into the compiled block, and the block says so.
    expect(shown.selection.actionOutcomes).toEqual([outcome?.fingerprint]);
    expect(shown.rendered.join("\n")).toContain(committedSentence());

    // The preview keyed on the SAME exchange the live turn did: the action id carries
    // the event ref that turn's row was written under, so the inspector is explaining
    // THAT contact rather than a look-alike minted for the preview.
    const row = (await listChatContactEvents(chat.chatId))[0];
    expect(row?.guardMessageId).toBe(guardMessageId);
    expect(outcome?.actionId.startsWith(row?.eventRef ?? "unwritten")).toBe(true);
  });

  it("obeys the contact flag in the prompt, and spends bytes only inside the guidance block", async () => {
    process.env.CHAT_CONTACT_ACTIONS = "on";
    process.env.CHAT_PHYSICAL_CONSTRAINTS = "on";
    const { chat } = await touchedChat();

    const withContact = await previewedPrompt(chat);
    expect(withContact).toContain(committedSentence());

    // The prompt preview OBEYS the flag — unlike the inspector, it is showing bytes.
    delete process.env.CHAT_CONTACT_ACTIONS;
    expect(await previewedPrompt(chat)).not.toContain(committedSentence());

    // And with the guidance block off, the contact flag costs nothing at all: the same
    // flag-off byte-identity section 6 proves against the live prompt, provable here
    // from the preview — which is what the preview could not do before the leg was
    // threaded through it.
    delete process.env.CHAT_PHYSICAL_CONSTRAINTS;
    const neither = await previewedPrompt(chat);
    process.env.CHAT_CONTACT_ACTIONS = "on";
    expect(await previewedPrompt(chat)).toBe(neither);
  });

  it("reports the contact flag rather than obeying it", async () => {
    process.env.CHAT_CONTACT_ACTIONS = "on";
    process.env.CHAT_PHYSICAL_CONSTRAINTS = "on";
    const { chat } = await touchedChat();

    delete process.env.CHAT_CONTACT_ACTIONS;
    const shown = await inspect(chat);
    expect(shown.contactFlagEnabled).toBe(false);
    // The leg still ran: a developer asking what turning the flag on would do gets the
    // answer without turning it on.
    expect(shown.candidates.actionOutcomes.map((entry) => entry.status)).toEqual(["committed"]);
    expect(shown.rendered.join("\n")).toContain(committedSentence());
  });

  it("re-derives the outcome without appending a row or moving a body", async () => {
    process.env.CHAT_CONTACT_ACTIONS = "on";
    process.env.CHAT_PHYSICAL_CONSTRAINTS = "on";
    const { chat } = await touchedChat();
    const rowsBefore = await listChatContactEvents(chat.chatId);
    const sceneBefore = await storedScene(chat.chatId);
    expect(rowsBefore).toHaveLength(1);

    const first = await inspect(chat);
    await previewedPrompt(chat);
    const second = await inspect(chat);

    // The plan ran three times and its two writes never did.
    expect(await listChatContactEvents(chat.chatId)).toEqual(rowsBefore);
    expect(await storedScene(chat.chatId)).toEqual(sceneBefore);
    // …and it is deterministic, which is what makes it worth reading at all.
    expect(second.candidates.actionOutcomes).toEqual(first.candidates.actionOutcomes);
    expect(second.rendered).toEqual(first.rendered);
  });

  it("shows the attempt behind a silence the prompt cannot explain", async () => {
    process.env.CHAT_CONTACT_ACTIONS = "on";
    process.env.CHAT_PHYSICAL_CONSTRAINTS = "on";
    const chat = await newChat(fixture);
    // Nobody walked over, so the reach resolves `unresolved` and the seam renders
    // silence — the exact gap this panel exists to make visible.
    await say(chat, touch());

    const shown = await inspect(chat);
    const outcome = shown.candidates.actionOutcomes[0];
    expect(outcome?.status).toBe("unresolved");
    expect(outcome?.resultCodes.some((code) => code.startsWith("contact.unresolved."))).toBe(true);
    expect(shown.rendered.join("\n")).not.toMatch(/Physical fact:|Blocked contact:/u);
    expect(await previewedPrompt(chat)).not.toContain("Physical fact:");
  });
});
