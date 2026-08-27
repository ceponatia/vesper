import { and, desc, eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { activeContactsOf, DiagnosticCollector, type DiagnosticSink } from "@/contracts";
import type { ChatArchivist } from "@/contracts/turns/chat-archivist";
import { characterChatMessages, characters, chatContactEvents, chatParticipants, db } from "@/server/db";
import { newId } from "@/lib/ids";
import { codes } from "@/test/diagnostics";

/**
 * The reply-side NPC contact ending — the DURABLE half, end to end through
 * `submitChatMessage` with a SCRIPTED assistant reply.
 *
 * The pure suite (`chat-contact-reply.test.ts`) pins detection and the fold;
 * what only a database can prove is the persistence identity and the settle
 * ordering:
 *
 * - an explicit prose withdrawal writes ONE `contact_ended` row under the
 *   reply-side event ref (`contact-reply:<assistant id>`), guarded by the
 *   assistant row, and the active-contact projection is EMPTY afterwards —
 *   the ordering invariant held: nothing re-wrote the scene after the ending;
 * - the vetoed shapes (negation, quoted dialogue, unrelated prose) write
 *   nothing and preserve the contact;
 * - one exchange can carry BOTH legs — the player's start and the NPC's end —
 *   under two disjoint event refs with no sequence collision;
 * - "another take" prunes the discarded reply's ending rows and restores the
 *   projection those rows had ended; regenerating back into the SAME reply
 *   re-lands exactly one row set (idempotent replay);
 * - a conflicting record under the reply's keys is verified and fails CLOSED:
 *   no rows, the projection unchanged, the mismatch diagnostic filed;
 * - an ensemble resolves a named subject and refuses a bare pronoun.
 */

const mock = vi.hoisted(() => ({ archivist: { value: null as ChatArchivist | null, degraded: false } }));
/** The next assistant reply, verbatim. `null` ⇒ the real (demo-mode) stream. */
const scripted = vi.hoisted(() => ({ reply: null as string | null }));

vi.mock("./chat-memory", async () => {
  const { chatMemoryMockModule } = await import("../test-support/chat-archivist-mock");
  return {
    ...chatMemoryMockModule(mock),
    reconcileMessageMemory: () => Promise.resolve(),
    retrieveChatCallback: () => Promise.resolve(null),
    // The ensemble member settle's personal pass — stubbed quiet; this suite is
    // about the reply-side contact leg, not member note-taking.
    runChatPersonalNotes: () => Promise.resolve(null),
  };
});

vi.mock("./character-chat", async () => {
  const actual = await vi.importActual<typeof import("./character-chat")>("./character-chat");
  return {
    ...actual,
    streamCharacterChat: (input: Parameters<typeof actual.streamCharacterChat>[0]) => {
      if (scripted.reply === null) return actual.streamCharacterChat(input);
      const text = scripted.reply;
      return (async function* () {
        yield text;
      })();
    },
  };
});

import { submitChatMessage } from "@/server/engine";
import { loadChatScenario } from "./chat-state";
import { listChatContactEvents } from "./chat-contact-events";
import { chatReplyContactEventRef } from "./chat-contact-reply";
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

const ready = await probeIntegrationDb("chat-contact-reply.int.test", "chat_contact_events");

let fixture: ChatFixture = emptyChatFixture();

const WITHDRAWAL = "She eases out from beneath your hand and studies the rain through the window.";
const NEUTRAL_REPLY = "She smiles and tells you about the morning rush.";

beforeAll(async () => {
  if (!ready) return;
  fixture = await seedChatFixture({ slug: "chat-contact-reply-int", userName: "Reply Int" });
  mock.archivist = { value: chatArchivist(), degraded: false };
});

beforeEach(() => {
  process.env.CHAT_CONTACT_ACTIONS = "on";
  delete process.env.CHAT_PHYSICAL_CONSTRAINTS;
  scripted.reply = NEUTRAL_REPLY;
});

afterAll(async () => {
  delete process.env.CHAT_CONTACT_ACTIONS;
  delete process.env.CHAT_PHYSICAL_CONSTRAINTS;
  await dropChatFixture(fixture);
});

// ---------------------------------------------------------------------------
// Driving exchanges with a scripted reply
// ---------------------------------------------------------------------------

interface RosterEntry {
  characterId: string;
  memoryGroupId: string;
  name: string;
  profile: unknown;
}

async function exchange(
  chat: ChatSeat,
  args: {
    kind: "send" | "regenerate";
    content?: string;
    reply: string;
    roster?: readonly RosterEntry[];
    sink?: DiagnosticSink;
  },
): Promise<void> {
  scripted.reply = args.reply;
  const result = await submitChatMessage({
    chatId: chat.chatId,
    memoryGroupId: chat.memoryGroupId,
    character: { id: fixture.characterId, name: fixture.characterName, profile: fixture.profile },
    kind: args.kind,
    ...(args.content === undefined ? {} : { content: args.content }),
    ...(args.roster === undefined ? {} : { roster: args.roster }),
    ...(args.sink === undefined ? {} : { sink: args.sink }),
  });
  if (!result.ok) throw new Error(`exchange rejected: ${result.code}`);
  // Draining is what settles the exchange — the reply-side producer included.
  for await (const chunk of result.stream) void chunk;
}

/** A held touch: walk over, rest the hand, both under neutral replies. */
async function heldTouch(chat: ChatSeat, targetName = fixture.characterName): Promise<void> {
  await exchange(chat, { kind: "send", content: `I walk over to ${targetName}.`, reply: NEUTRAL_REPLY });
  await exchange(chat, { kind: "send", content: `I rest my hand on ${targetName}'s shoulder.`, reply: NEUTRAL_REPLY });
}

async function activeContacts(chatId: string) {
  const scenario = await loadChatScenario(chatId);
  if (!scenario) throw new Error("scenario missing");
  return activeContactsOf(scenario.scene.contacts);
}

/** The newest assistant row's id — the reply the producer guards its rows on. */
async function lastAssistantId(chatId: string): Promise<string> {
  const [row] = await db()
    .select({ id: characterChatMessages.id })
    .from(characterChatMessages)
    .where(and(eq(characterChatMessages.chatId, chatId), eq(characterChatMessages.role, "assistant")))
    .orderBy(desc(characterChatMessages.createdAt), desc(characterChatMessages.id))
    .limit(1);
  if (!row) throw new Error("no assistant row");
  return row.id;
}

/** The reply-side rows only — the `contact-reply:` namespace. */
async function replyRows(chatId: string) {
  const rows = await listChatContactEvents(chatId);
  return rows.filter((row) => row.eventRef.startsWith("contact-reply:"));
}

// ---------------------------------------------------------------------------
// 1. The withdrawal lands, durably, in order
// ---------------------------------------------------------------------------

describe.runIf(ready)("an explicit prose withdrawal ends the touch", () => {
  it("(1) writes one reply-side end row and empties the projection", async () => {
    const chat = await newChat(fixture);
    await heldTouch(chat);
    expect(await activeContacts(chat.chatId)).toHaveLength(1);

    await exchange(chat, { kind: "send", content: "I tell her about the storm last night.", reply: WITHDRAWAL });

    // The projection is empty AFTER full settle — the ordering invariant held.
    expect(await activeContacts(chat.chatId)).toEqual([]);

    const assistantId = await lastAssistantId(chat.chatId);
    const rows = await replyRows(chat.chatId);
    expect(rows).toHaveLength(1);
    const row = rows[0];
    if (!row) throw new Error("no reply-side row");
    expect(row.kind).toBe("contact_ended");
    expect(row.eventRef).toBe(chatReplyContactEventRef(assistantId));
    expect(row.guardMessageId).toBe(assistantId);
    expect(row.sequence).toBe(0);
    expect(row.payload).toMatchObject({ kind: "contact_ended", reason: "withdrawn" });
  });

  it("(7) one exchange carries both legs under disjoint refs, no sequence collision", async () => {
    const chat = await newChat(fixture);
    await exchange(chat, { kind: "send", content: `I walk over to ${fixture.characterName}.`, reply: NEUTRAL_REPLY });
    await exchange(chat, {
      kind: "send",
      content: `I rest my hand on ${fixture.characterName}'s shoulder.`,
      reply: "She pulls away.",
    });

    const rows = await listChatContactEvents(chat.chatId);
    const started = rows.filter((row) => row.kind === "contact_started");
    const ended = rows.filter((row) => row.kind === "contact_ended");
    expect(started).toHaveLength(1);
    expect(ended).toHaveLength(1);
    const start = started[0];
    const end = ended[0];
    if (!start || !end) throw new Error("missing leg rows");
    // Player leg: keyed to the exchange guard. Reply leg: its own namespace.
    expect(start.eventRef.startsWith("contact:")).toBe(true);
    expect(end.eventRef).toBe(chatReplyContactEventRef(await lastAssistantId(chat.chatId)));
    expect(end.eventRef).not.toBe(start.eventRef);
    // Both at sequence 0 of their OWN events — disjoint key spaces, no collision.
    expect(start.sequence).toBe(0);
    expect(end.sequence).toBe(0);
    expect(await activeContacts(chat.chatId)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// 2. The vetoes preserve the contact
// ---------------------------------------------------------------------------

describe.runIf(ready)("vetoed reply shapes preserve the contact", () => {
  it.each([
    ["(2) a negation", "She doesn't pull away."],
    ["(3) a quoted command", '"Don\'t pull away," she murmurs, her shoulder warm under your palm.'],
    ["(4) an unrelated movement and reaction", "She laughs at that, reaching over to refill your tea."],
  ])("%s writes nothing and the touch survives", async (_label, reply) => {
    const chat = await newChat(fixture);
    await heldTouch(chat);

    await exchange(chat, { kind: "send", content: "I tell her about the storm last night.", reply });

    expect(await activeContacts(chat.chatId)).toHaveLength(1);
    expect(await replyRows(chat.chatId)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// 3. Ensemble subjects
// ---------------------------------------------------------------------------

describe.runIf(ready)("ensemble subject resolution", () => {
  /** A second seat in the same conversation, with its own character row. */
  async function ensembleChat(): Promise<{ chat: ChatSeat; roster: RosterEntry[] }> {
    const chat = await newChat(fixture);
    const [second] = await db()
      .insert(characters)
      .values({ ownerId: fixture.userId, name: "Vaelith", profile: {} })
      .returning({ id: characters.id });
    if (!second) throw new Error("failed to create second character");
    const memoryGroupId = newId();
    await db()
      .insert(chatParticipants)
      .values({ chatId: chat.chatId, characterId: second.id, memoryGroupId, sort: 1 });
    const roster: RosterEntry[] = [
      {
        characterId: fixture.characterId,
        memoryGroupId: chat.memoryGroupId,
        name: fixture.characterName,
        profile: fixture.profile,
      },
      { characterId: second.id, memoryGroupId, name: "Vaelith", profile: {} },
    ];
    return { chat, roster };
  }

  it("(5) an ambiguous pronoun in an ensemble produces NO ending", async () => {
    const { chat, roster } = await ensembleChat();
    await exchange(chat, { kind: "send", content: `I walk over to ${fixture.characterName}.`, reply: NEUTRAL_REPLY, roster });
    await exchange(chat, {
      kind: "send",
      content: `I rest my hand on ${fixture.characterName}'s shoulder.`,
      reply: NEUTRAL_REPLY,
      roster,
    });
    expect(await activeContacts(chat.chatId)).toHaveLength(1);

    await exchange(chat, { kind: "send", content: "I glance between the two of them.", reply: "She pulls away.", roster });

    expect(await activeContacts(chat.chatId)).toHaveLength(1);
    expect(await replyRows(chat.chatId)).toEqual([]);
  });

  it("(6) a NAMED ensemble subject ends that character's contact", async () => {
    const { chat, roster } = await ensembleChat();
    await exchange(chat, { kind: "send", content: `I walk over to ${fixture.characterName}.`, reply: NEUTRAL_REPLY, roster });
    await exchange(chat, {
      kind: "send",
      content: `I rest my hand on ${fixture.characterName}'s shoulder.`,
      reply: NEUTRAL_REPLY,
      roster,
    });
    expect(await activeContacts(chat.chatId)).toHaveLength(1);

    await exchange(chat, {
      kind: "send",
      content: "I glance between the two of them.",
      reply: `${fixture.characterName} eases out from beneath your hand.`,
      roster,
    });

    expect(await activeContacts(chat.chatId)).toEqual([]);
    const rows = await replyRows(chat.chatId);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.kind).toBe("contact_ended");
  });
});

// ---------------------------------------------------------------------------
// 4. Retakes, replays, and the fail-closed conflict
// ---------------------------------------------------------------------------

describe.runIf(ready)("retake, replay, and conflict behavior", () => {
  it("(8) another take removes the discarded ending and restores the held touch", async () => {
    const chat = await newChat(fixture);
    await heldTouch(chat);
    await exchange(chat, { kind: "send", content: "I tell her about the storm last night.", reply: WITHDRAWAL });
    expect(await activeContacts(chat.chatId)).toEqual([]);

    // The new take's prose does NOT end the contact — the discarded take's
    // ending goes with its projection.
    await exchange(chat, { kind: "regenerate", reply: NEUTRAL_REPLY });

    expect(await replyRows(chat.chatId)).toEqual([]);
    expect(await activeContacts(chat.chatId)).toHaveLength(1);
  });

  it("(9) regenerating back into the identical withdrawal lands exactly one row set", async () => {
    const chat = await newChat(fixture);
    await heldTouch(chat);
    await exchange(chat, { kind: "send", content: "I tell her about the storm last night.", reply: WITHDRAWAL });
    await exchange(chat, { kind: "regenerate", reply: WITHDRAWAL });

    const rows = await replyRows(chat.chatId);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.kind).toBe("contact_ended");
    expect(await activeContacts(chat.chatId)).toEqual([]);
  });

  it("(10) a conflicting record under the reply's keys fails closed: no write, projection unchanged, diagnostic filed", async () => {
    const chat = await newChat(fixture);
    await heldTouch(chat);
    await exchange(chat, { kind: "send", content: "I tell her about the storm last night.", reply: NEUTRAL_REPLY });
    expect(await activeContacts(chat.chatId)).toHaveLength(1);

    // A stale record under the exact keys the regenerated reply will derive —
    // guarded by a DIFFERENT surviving message, so the retake prune cannot
    // remove it and the append's verification must judge it.
    const assistantId = await lastAssistantId(chat.chatId);
    await db()
      .insert(chatContactEvents)
      .values({
        chatId: chat.chatId,
        guardMessageId: chat.messageId,
        eventRef: chatReplyContactEventRef(assistantId),
        sequence: 0,
        kind: "contact_ended",
        contactId: "contact_somebody_else_entirely",
        storyMinute: 0,
        payload: { kind: "contact_ended", note: "another take's record" },
      });

    const sink = new DiagnosticCollector();
    await exchange(chat, { kind: "regenerate", reply: WITHDRAWAL, sink });

    // Fail closed: the ending was NOT applied — the projection still holds the
    // touch — and the mismatch was filed rather than silently overwritten.
    expect(codes(sink)).toContain("chat_contact.ledger.mismatch");
    expect(await activeContacts(chat.chatId)).toHaveLength(1);
    const rows = await replyRows(chat.chatId);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.contactId).toBe("contact_somebody_else_entirely");
  });
});
