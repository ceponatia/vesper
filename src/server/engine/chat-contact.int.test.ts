import { and, eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  activeContactsOf,
  affordanceSubjectId,
  contactCommitEvents,
  DiagnosticCollector,
  emptySceneState,
  sceneFacingFact,
  sceneParticipant,
  sceneProximityFact,
  type SceneState,
} from "@/contracts";
import type { ChatArchivist } from "@/contracts/turns/chat-archivist";
import { characterChatMessages, characterChats, db } from "@/server/db";
import { log } from "@/server/log";

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
 * - "another take" prunes the discarded take's rows and rolls the contact out of
 *   the scene together, so a retake that re-commits the same touch leaves one row
 *   under the SAME event ref rather than two;
 * - `appendChatContactEvents` is idempotent against its own retry — the crash
 *   guarantee, which only a unique index can demonstrate;
 * - with `CHAT_CONTACT_ACTIONS` unset the turn is the pre-feature turn: no rows,
 *   a scene that places nobody, and a system prompt byte-identical to the one the
 *   flag-ON take of that same line builds — the leg can commit a durable contact
 *   and still spend zero prompt bytes;
 * - the two silences (a touch nobody walked over for, a romantically framed line)
 *   commit nothing at all while the exchange settles normally, and file exactly
 *   the diagnostics each case is designed to file;
 * - a corrupt `scene` blob costs no turn and fails CLOSED;
 * - and the dev inspector explains the whole thing read-only: the same outcome, keyed
 *   to the exchange that wrote it, with no row appended and no body moved.
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
import { loadChatScenario } from "./chat-state";
import { appendChatContactEvents, listChatContactEvents } from "./chat-contact-events";
import { chatContactEventRef, planChatContactTurn, CHAT_CONTACT_PLAYER_SUBJECT } from "./chat-contact-adapter";
import {
  chatArchivist,
  dropChatFixture,
  emptyChatFixture,
  newChat,
  probeIntegrationDb,
  seedChatFixture,
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
/** A line carrying no act at all — the control for every byte-identity comparison. */
const NEUTRAL = "I ask her how the shop went today.";

beforeAll(async () => {
  if (!ready) return;
  fixture = await seedChatFixture({ slug: "chat-contact-int", userName: "Contact Int" });
  mock.archivist = { value: chatArchivist(), degraded: false };
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
 * Run one exchange end to end and DRAIN it, which is what settles it: the ledger
 * write lands pre-stream, the scene projection with the settle at the generator's
 * completion. Returns the streamed reply so a test can prove the turn was not
 * lost.
 */
async function drive(chat: ChatSeat, args: { kind: "send" | "regenerate"; content?: string }): Promise<string> {
  const result = await submitChatMessage({
    chatId: chat.chatId,
    memoryGroupId: chat.memoryGroupId,
    character: { id: fixture.characterId, name: fixture.characterName, profile: fixture.profile },
    kind: args.kind,
    ...(args.content === undefined ? {} : { content: args.content }),
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
 * `submitChatMessage` neither returns nor accepts its `DiagnosticCollector` — it
 * LOGS the turn's codes and drops the sink — so unlike `settleChatExchange`, which
 * hands its sink back, the only seam an integration test has on the live turn's
 * diagnostics is that log line. Reading it here is deliberate and narrow: the
 * alternative is asserting nothing about the codes the silence paths are designed
 * to file.
 */
async function sayWithDiagnostics(chat: ChatSeat, content: string): Promise<{ reply: string; codes: string[] }> {
  const codes: string[] = [];
  const spy = vi.spyOn(log, "info").mockImplementation((scope, message, data) => {
    if (scope !== "engine.chat" || message !== "chat-state diagnostics") return;
    const filed: unknown = data?.codes;
    if (!Array.isArray(filed)) return;
    for (const code of filed as readonly unknown[]) if (typeof code === "string") codes.push(code);
  });
  try {
    return { reply: await say(chat, content), codes };
  } finally {
    spy.mockRestore();
  }
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

    const rows = await listChatContactEvents(chat.chatId);
    expect(rows).toHaveLength(1);
    const row = rows[0];
    if (!row) throw new Error("no ledger row");
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
// 2. Snapshot restoration — a retake leaves no duplicates
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
});

// ---------------------------------------------------------------------------
// 3. Retry / idempotency (store level)
// ---------------------------------------------------------------------------

describe.runIf(ready)("the ledger is idempotent against its own retry", () => {
  it("a re-sent event inserts nothing and leaves one row set", async () => {
    const chat = await newChat(fixture);
    const eventRef = chatContactEventRef(chat.messageId);
    // A real commit stream, planned exactly as the leg plans it.
    const planned = planChatContactTurn({
      scene: emptySceneState(),
      message: `${move()} ${touch()}`,
      narratorInput: false,
      characters: [{ subjectId: target(), name: fixture.characterName, aliases: [] }],
      eventRef,
      storyTime: 7,
    });
    const commit = planned.commit;
    if (commit?.status !== "committed") throw new Error("fixture: the shoulder touch must commit");
    const input = {
      chatId: chat.chatId,
      guardMessageId: chat.messageId,
      eventRef,
      storyMinute: 7,
      commits: contactCommitEvents(commit),
    };

    // The crash-retry guarantee: the second write re-derives the same
    // (chat, event ref, sequence) keys and lands nowhere.
    expect(await appendChatContactEvents(input)).toEqual({ inserted: 1 });
    expect(await appendChatContactEvents(input)).toEqual({ inserted: 0 });

    const rows = await listChatContactEvents(chat.chatId);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.kind).toBe("contact_started");
    expect(rows[0]?.sequence).toBe(0);
    expect(rows[0]?.contactId).toBe(commit.contact.contactId);
  });
});

// ---------------------------------------------------------------------------
// 4. The flag — off is exactly the pre-feature turn
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
    delete process.env.CHAT_CONTACT_ACTIONS;
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
    delete process.env.CHAT_CONTACT_ACTIONS;
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
// 5. Silence rules
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
});

// ---------------------------------------------------------------------------
// 6. Degradation
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
// 7. The dev inspector
// ---------------------------------------------------------------------------

/**
 * The two preview surfaces, over a conversation that has actually walked over and
 * touched.
 *
 * The preview path used to skip the contact leg outright, which left the one surface
 * built to answer "why did this turn say that" unable to answer it for a contact turn
 * — and forced the byte-identity proof in section 4 to capture the LIVE system prompt
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
    // flag-off byte-identity section 4 proves against the live prompt, provable here
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
