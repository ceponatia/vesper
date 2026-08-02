import { desc, and, eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { activeContactsOf, DiagnosticCollector, emptySceneState, type DiagnosticSink, type SceneState } from "@/contracts";
import type { ChatArchivist } from "@/contracts/turns/chat-archivist";
import type { GenerateCheckedOptions, GenerateCheckedResult } from "../ai";
import { characterChatMessages, characterChats, chatNpcSceneDecisions, db } from "@/server/db";
import { codes, expectDiagnostic } from "@/test/diagnostics";

/**
 * The NPC reply-scene decision leg's SHADOW wiring, end to end through
 * `submitChatMessage` with a scripted assistant reply and a scripted classifier
 * (romantic-contact-affordances.spec.actor-control.md, delivery-order step 3).
 *
 * The pure suite pins the trigger and the dry evaluation; what only a database
 * can prove is the durable envelope behavior around a real settle:
 *
 * - shadow records an `evaluated` envelope and NEVER changes the scene — the
 *   column's bytes are the envelope's base AND result fingerprint, and no
 *   ledger rows appear;
 * - a reply the trigger skips still records a durable `trigger_miss` tombstone
 *   (empty payload, no classifier spend, "" digest hash);
 * - a degraded classifier records a `degraded` tombstone and files the
 *   `npc_scene_decision.degraded` diagnostic — the reply itself settles fine;
 * - an existing envelope is NEVER reclassified — the reuse check answers
 *   before any classifier spend, whatever the current flags say;
 * - the frozen floor's ending rides the NEW guarded transaction in shadow
 *   mode: the ledger row is byte-for-byte what the legacy block writes, the
 *   projection empties, and the envelope records the committed floor action;
 * - with both new flags OFF the leg does not exist: the legacy block ends the
 *   contact exactly as at HEAD and zero envelope rows appear;
 * - the retake prune deletes the discarded take's envelope EVEN with the
 *   flags off (unconditional, like the contact prunes beside it);
 * - the opening branch calls the common leg before returning, so an opening
 *   beat earns an envelope too;
 * - shadow WITHOUT `CHAT_CONTACT_ACTIONS` grants no floor authority: the
 *   envelope records, the ledger stays empty.
 */

const mock = vi.hoisted(() => ({ archivist: { value: null as ChatArchivist | null, degraded: false } }));
/** The next assistant reply, verbatim. `null` ⇒ the real (demo-mode) stream. */
const scripted = vi.hoisted(() => ({ reply: null as string | null }));
/** The scripted reply-scene classifier: raw output, a degrade switch, and a call counter. */
const classifier = vi.hoisted(() => ({ output: null as unknown, degraded: false, calls: 0 }));

vi.mock("./chat-memory", async () => {
  const { chatMemoryMockModule } = await import("../test-support/chat-archivist-mock");
  return {
    ...chatMemoryMockModule(mock),
    reconcileMessageMemory: () => Promise.resolve(),
    retrieveChatCallback: () => Promise.resolve(null),
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

// Only the reply-scene classifier call is scripted (matched by its diagnostic
// code); every other structured leg passes through to the real implementation,
// which degrades in demo mode exactly as the sibling suites rely on.
vi.mock("../ai", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../ai")>();
  const generateChecked = (<T,>(opts: GenerateCheckedOptions<T>): Promise<GenerateCheckedResult<T>> => {
    if (opts.code === "npc_scene_decision.classify") {
      classifier.calls += 1;
      if (classifier.degraded) return Promise.resolve({ value: null, degraded: true });
      return Promise.resolve({ value: classifier.output as T, degraded: false });
    }
    return actual.generateChecked(opts);
  }) as typeof actual.generateChecked;
  return { ...actual, generateChecked };
});

import { submitChatMessage } from "@/server/engine";
import { loadChatScenario } from "./chat-state";
import { listChatContactEvents } from "./chat-contact-events";
import { chatReplyContactEventRef } from "./chat-contact-reply";
import { beginChatNpcSceneDecision, finishChatNpcSceneDecision } from "./chat-npc-scene-decision";
import {
  chatNpcReplyHash,
  chatNpcSceneHash,
  emptyNpcSceneDecisionPayload,
  loadChatNpcSceneDecision,
} from "./chat-npc-scene-envelope";
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

const ready = await probeIntegrationDb("chat-npc-scene-decision.int.test", "chat_npc_scene_decisions");

let fixture: ChatFixture = emptyChatFixture();

/** Fires the trigger AND passes the approach congruence gates for npc_0. */
const APPROACH_REPLY = "Wren crosses the room and stops right beside you.";
/** No movement/contact verb stem beside a name — a measured trigger miss. */
const NEUTRAL_REPLY = "She smiles and tells you about the morning rush.";
/** The frozen floor's withdrawal shape (and a trigger hit: "eases" + sole-present "she"). */
const WITHDRAWAL = "She eases out from beneath your hand and studies the rain through the window.";

/** The classifier proposing nothing — the expected common answer. */
const NO_PROPOSALS = { version: 1, movement: null, contact: null };
/** A well-formed approach proposal whose evidence grounds in APPROACH_REPLY. */
const APPROACH_PROPOSAL = {
  version: 1,
  movement: {
    kind: "approach",
    actorRef: "npc_0",
    counterpartRef: "player",
    band: "touching",
    facing: null,
    evidence: APPROACH_REPLY,
  },
  contact: null,
};

beforeAll(async () => {
  if (!ready) return;
  fixture = await seedChatFixture({ slug: "chat-npc-scene-decision-int", userName: "Scene Decision Int" });
  mock.archivist = { value: chatArchivist(), degraded: false };
});

beforeEach(() => {
  process.env.CHAT_CONTACT_ACTIONS = "on";
  process.env.CHAT_NPC_SCENE_DECISION_SHADOW = "on";
  delete process.env.CHAT_NPC_SCENE_DECISIONS;
  delete process.env.CHAT_PHYSICAL_CONSTRAINTS;
  scripted.reply = NEUTRAL_REPLY;
  classifier.output = NO_PROPOSALS;
  classifier.degraded = false;
  classifier.calls = 0;
});

afterAll(async () => {
  delete process.env.CHAT_CONTACT_ACTIONS;
  delete process.env.CHAT_NPC_SCENE_DECISION_SHADOW;
  delete process.env.CHAT_NPC_SCENE_DECISIONS;
  delete process.env.CHAT_PHYSICAL_CONSTRAINTS;
  await dropChatFixture(fixture);
});

// ---------------------------------------------------------------------------
// Driving exchanges with a scripted reply
// ---------------------------------------------------------------------------

async function exchange(
  chat: ChatSeat,
  args: {
    kind: "send" | "open" | "regenerate";
    content?: string;
    reply: string;
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
    ...(args.sink === undefined ? {} : { sink: args.sink }),
  });
  if (!result.ok) throw new Error(`exchange rejected: ${result.code}`);
  // Draining is what settles the exchange — the reply-scene leg included.
  for await (const chunk of result.stream) void chunk;
}

/** A held touch: walk over, rest the hand, both under neutral replies. */
async function heldTouch(chat: ChatSeat): Promise<void> {
  await exchange(chat, { kind: "send", content: `I walk over to ${fixture.characterName}.`, reply: NEUTRAL_REPLY });
  await exchange(chat, {
    kind: "send",
    content: `I rest my hand on ${fixture.characterName}'s shoulder.`,
    reply: NEUTRAL_REPLY,
  });
}

async function activeContacts(chatId: string) {
  const scenario = await loadChatScenario(chatId);
  if (!scenario) throw new Error("scenario missing");
  return activeContactsOf(scenario.scene.contacts);
}

/** The newest assistant row's id — the reply the leg keys its envelope on. */
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

/** The reply-side ledger rows only — the `contact-reply:` namespace. */
async function replyRows(chatId: string) {
  const rows = await listChatContactEvents(chatId);
  return rows.filter((row) => row.eventRef.startsWith("contact-reply:"));
}

async function envelopeCount(chatId: string): Promise<number> {
  const rows = await db()
    .select({ id: chatNpcSceneDecisions.id })
    .from(chatNpcSceneDecisions)
    .where(eq(chatNpcSceneDecisions.chatId, chatId));
  return rows.length;
}

/** The raw scene column, fingerprinted by the module's own hash. */
async function sceneColumnHash(chatId: string): Promise<string> {
  const [row] = await db()
    .select({ scene: characterChats.scene })
    .from(characterChats)
    .where(eq(characterChats.id, chatId))
    .limit(1);
  return chatNpcSceneHash((row?.scene ?? emptySceneState()) as SceneState);
}

/** The leg's default 1-on-1 roster input, for direct begin/finish calls. */
function soloRoster() {
  return [
    {
      characterId: fixture.characterId,
      name: fixture.characterName,
      aliases: [] as readonly string[],
      presence: "present" as const,
    },
  ];
}

// ---------------------------------------------------------------------------
// 1. Shadow records, and never moves the scene
// ---------------------------------------------------------------------------

describe.runIf(ready)("shadow envelope-only recording", () => {
  it("records an evaluated envelope with base=result and writes NO ledger rows", async () => {
    const chat = await newChat(fixture);
    classifier.output = APPROACH_PROPOSAL;

    await exchange(chat, { kind: "send", content: "I glance up from my book.", reply: APPROACH_REPLY });

    const assistantId = await lastAssistantId(chat.chatId);
    const row = await loadChatNpcSceneDecision(chat.chatId, assistantId);
    expect(row?.status).toBe("evaluated");
    expect(row?.mode).toBe("shadow");
    expect(row?.replyHash).toBe(chatNpcReplyHash(APPROACH_REPLY));
    expect(row?.digestHash).toMatch(/^[0-9a-f]{64}$/);
    // The dry run: the admitted movement is recorded, not committed.
    expect(row?.payload.slots).toEqual({ movement: "parsed", contact: "absent" });
    const movement = row?.payload.actions.find((action) => action.kind === "movement");
    expect(movement?.resolution).toBe("unresolved");
    expect(movement?.detail).toContain("shadow_admitted_not_executed");
    expect(row?.payload.drops).toEqual([]);
    expect(row?.payload.contactRows).toEqual([]);
    // The scene NEVER changed: base and result fingerprint the same projection,
    // and the column carries exactly that projection after settle.
    expect(row?.baseSceneHash).toBe(row?.resultSceneHash);
    expect(await sceneColumnHash(chat.chatId)).toBe(row?.baseSceneHash);
    expect(await replyRows(chat.chatId)).toEqual([]);
    expect(classifier.calls).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// 2. The tombstones
// ---------------------------------------------------------------------------

describe.runIf(ready)("durable tombstones", () => {
  it("a trigger miss records a trigger_miss envelope: empty payload, no classifier spend, no digest hash", async () => {
    const chat = await newChat(fixture);

    await exchange(chat, { kind: "send", content: "How was the market?", reply: NEUTRAL_REPLY });

    const assistantId = await lastAssistantId(chat.chatId);
    const row = await loadChatNpcSceneDecision(chat.chatId, assistantId);
    expect(row?.status).toBe("trigger_miss");
    expect(row?.digestHash).toBe("");
    expect(row?.payload).toEqual(emptyNpcSceneDecisionPayload());
    expect(row?.baseSceneHash).toBe(row?.resultSceneHash);
    expect(classifier.calls).toBe(0);
  });

  it("a degraded classifier records a degraded envelope and files the diagnostic — the reply still settles", async () => {
    const chat = await newChat(fixture);
    classifier.degraded = true;
    const sink = new DiagnosticCollector();

    await exchange(chat, { kind: "send", content: "I glance up.", reply: APPROACH_REPLY, sink });

    const assistantId = await lastAssistantId(chat.chatId);
    const row = await loadChatNpcSceneDecision(chat.chatId, assistantId);
    expect(row?.status).toBe("degraded");
    expect(row?.payload.slots).toEqual({ movement: "absent", contact: "absent" });
    expect(row?.payload.actions).toEqual([]);
    expect(row?.payload.telemetry.timedOut).toBe(false);
    expect(row?.baseSceneHash).toBe(row?.resultSceneHash);
    expectDiagnostic(sink, "npc_scene_decision.degraded");
    expect(classifier.calls).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// 3. Reuse never reclassifies
// ---------------------------------------------------------------------------

describe.runIf(ready)("the reuse check", () => {
  it("an existing envelope is never reclassified — even invoked again with flags now off", async () => {
    const chat = await newChat(fixture);
    classifier.output = APPROACH_PROPOSAL;
    await exchange(chat, { kind: "send", content: "I glance up.", reply: APPROACH_REPLY });
    const assistantId = await lastAssistantId(chat.chatId);
    const before = await loadChatNpcSceneDecision(chat.chatId, assistantId);
    expect(before?.status).toBe("evaluated");
    const callsBefore = classifier.calls;

    // The reuse check answers BEFORE any flag or classifier spend — the same
    // assistant reply must never be reclassified into different authority,
    // regardless of what the flags say NOW.
    delete process.env.CHAT_NPC_SCENE_DECISION_SHADOW;
    const sink = new DiagnosticCollector();
    const handle = await beginChatNpcSceneDecision({
      chatId: chat.chatId,
      assistantMessageId: assistantId,
      reply: APPROACH_REPLY,
      mode: "shadow",
      roster: soloRoster(),
      scene: emptySceneState(),
      sink,
    });
    await finishChatNpcSceneDecision(handle);

    expect(classifier.calls).toBe(callsBefore);
    const after = await loadChatNpcSceneDecision(chat.chatId, assistantId);
    expect(after?.id).toBe(before?.id);
    expect(after?.payload).toEqual(before?.payload);
    // A matching reply hash is the designed idempotent path — silent.
    expect(codes(sink)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// 4. The floor rides the new transaction
// ---------------------------------------------------------------------------

describe.runIf(ready)("the frozen floor in shadow mode", () => {
  it("the floor's ending rides the decision transaction: legacy-identical row, emptied projection, plus the envelope", async () => {
    const chat = await newChat(fixture);
    await heldTouch(chat);
    expect(await activeContacts(chat.chatId)).toHaveLength(1);

    classifier.output = NO_PROPOSALS;
    await exchange(chat, { kind: "send", content: "I tell her about the storm last night.", reply: WITHDRAWAL });

    // The projection emptied — the ordering invariant held (nothing re-wrote
    // the scene after the leg).
    expect(await activeContacts(chat.chatId)).toEqual([]);

    // The ledger row is byte-for-byte what the legacy block writes.
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

    // Plus the envelope: the floor action committed, the scene fingerprints moved.
    const envelope = await loadChatNpcSceneDecision(chat.chatId, assistantId);
    expect(envelope?.status).toBe("evaluated");
    const floorAction = envelope?.payload.actions.find((action) => action.kind === "floor_ending");
    expect(floorAction?.resolution).toBe("committed");
    expect(floorAction?.detail).not.toContain("span_unlocated");
    expect(floorAction?.contactRows).toEqual([{ eventRef: chatReplyContactEventRef(assistantId), sequence: 0 }]);
    expect(envelope?.payload.contactRows).toEqual([{ eventRef: chatReplyContactEventRef(assistantId), sequence: 0 }]);
    expect(envelope?.baseSceneHash).not.toBe(envelope?.resultSceneHash);
    expect(await sceneColumnHash(chat.chatId)).toBe(envelope?.resultSceneHash);
  });

  it("shadow WITHOUT the contact flag grants no floor authority: envelope only, no rows", async () => {
    delete process.env.CHAT_CONTACT_ACTIONS;
    const chat = await newChat(fixture);
    classifier.output = NO_PROPOSALS;

    await exchange(chat, { kind: "send", content: "I tell her about the storm.", reply: WITHDRAWAL });

    const assistantId = await lastAssistantId(chat.chatId);
    const envelope = await loadChatNpcSceneDecision(chat.chatId, assistantId);
    expect(envelope?.status).toBe("evaluated");
    expect(envelope?.payload.actions).toEqual([]);
    expect(envelope?.baseSceneHash).toBe(envelope?.resultSceneHash);
    expect(await replyRows(chat.chatId)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// 5. Flag-off identity, and the unconditional retake prune
// ---------------------------------------------------------------------------

describe.runIf(ready)("flag-off behavior is HEAD behavior", () => {
  it("with both new flags off the legacy block runs and zero envelope rows exist", async () => {
    delete process.env.CHAT_NPC_SCENE_DECISION_SHADOW;
    const chat = await newChat(fixture);
    await heldTouch(chat);
    expect(await activeContacts(chat.chatId)).toHaveLength(1);

    await exchange(chat, { kind: "send", content: "I tell her about the storm last night.", reply: WITHDRAWAL });

    // The legacy reply-side block did its job exactly as at HEAD...
    expect(await activeContacts(chat.chatId)).toEqual([]);
    const rows = await replyRows(chat.chatId);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.kind).toBe("contact_ended");
    // ...and the leg never existed: no envelope for ANY of the chat's replies.
    expect(await envelopeCount(chat.chatId)).toBe(0);
    expect(classifier.calls).toBe(0);
  });

  it("the retake prune deletes the discarded take's envelope even with the flags now off", async () => {
    const chat = await newChat(fixture);
    classifier.output = APPROACH_PROPOSAL;
    await exchange(chat, { kind: "send", content: "I glance up.", reply: APPROACH_REPLY });
    const assistantId = await lastAssistantId(chat.chatId);
    expect(await loadChatNpcSceneDecision(chat.chatId, assistantId)).not.toBeNull();

    // Another take with the feature now OFF: the prune is unconditional — the
    // old tombstone must not hold the unique key under different reply bytes —
    // and the flag-off take records nothing new.
    delete process.env.CHAT_NPC_SCENE_DECISION_SHADOW;
    await exchange(chat, { kind: "regenerate", reply: NEUTRAL_REPLY });

    expect(await loadChatNpcSceneDecision(chat.chatId, assistantId)).toBeNull();
    expect(await envelopeCount(chat.chatId)).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// 6. The opening branch
// ---------------------------------------------------------------------------

describe.runIf(ready)("the opening branch calls the common leg", () => {
  it("an opening beat's reply earns an envelope before the branch returns", async () => {
    const chat = await newChat(fixture);
    classifier.output = APPROACH_PROPOSAL;

    await exchange(chat, { kind: "open", reply: APPROACH_REPLY });

    const assistantId = await lastAssistantId(chat.chatId);
    const row = await loadChatNpcSceneDecision(chat.chatId, assistantId);
    expect(row?.status).toBe("evaluated");
    expect(row?.mode).toBe("shadow");
    expect(row?.payload.slots.movement).toBe("parsed");
    expect(classifier.calls).toBe(1);
  });
});
