import { desc, and, eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  activeContactsOf,
  affordanceSubjectId,
  DiagnosticCollector,
  emptySceneState,
  sceneParticipant,
  sceneProximityFact,
  type DiagnosticSink,
  type SceneState,
} from "@/contracts";
import type { ChatArchivist } from "@/contracts/turns/chat-archivist";
import type { GenerateCheckedOptions, GenerateCheckedResult } from "../ai";
import { characterChatMessages, characterChats, characterChatState, chatNpcSceneDecisions, db } from "@/server/db";
import { codes, expectDiagnostic } from "@/test/diagnostics";

/**
 * The NPC reply-scene decision leg's SHADOW wiring, end to end through
 * `submitChatMessage` with a scripted assistant reply and a scripted classifier.
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
 *
 * AUTHORITY (delivery step 4 — increment 1, movement) adds the half a pure
 * suite cannot prove either: that an admitted approach's scene fact, an away
 * member's `separated` endings, and the decision envelope that explains them
 * all land through the ONE guarded transaction; that the rollout scope knob
 * turns execution off without touching admission; that a body the scene never
 * placed is seeded before it acts; and that the authority flag stays inert
 * without `CHAT_CONTACT_ACTIONS`.
 *
 * AUTHORITY (delivery step 5 — increment 2, contact starts) adds the rest: an
 * approach and a start in one reply landing as one scene fact plus one durable
 * `contact_started` row; the NPC's own glove composing into the committed
 * material from the POST-settle garment cut; a target dressed in something
 * nobody modelled resolving to silence without touching the movement beside it;
 * and a wardrobe this same reply rewrote dropping the start outright.
 *
 * AUTHORITY (delivery step 6 — increment 3, contact updates) closes it: a
 * gesture modulation on a contact she is already holding writes a
 * `contact_updated` row under the reply event ref and moves ONLY the pressure —
 * the same contact id, the same start event, and a material the post-settle
 * garment cut never touched; an unchanged gesture writes no row and leaves the
 * scene fingerprint exactly where it was.
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
import { CHAT_CONTACT_PLAYER_SUBJECT } from "./chat-contact/identity";
import { listChatContactEvents } from "./chat-contact-events";
import { chatReplyContactEventRef } from "./chat-contact-reply";
import {
  beginChatNpcSceneDecision,
  emptyChatNpcSceneSettleReport,
  finishChatNpcSceneDecision,
} from "./chat-npc-scene-decision";
import {
  chatNpcReplyHash,
  chatNpcSceneHash,
  deleteChatNpcSceneDecision,
  emptyNpcSceneDecisionPayload,
  loadChatNpcSceneDecision,
} from "./chat-npc-scene-envelope";
import {
  chatArchivist,
  dropChatFixture,
  emptyChatFixture,
  itemId,
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

/**
 * The spec's worked example, whole: she crosses the room and then takes the
 * player's hand. Both sentences in one reply, so the START only resolves because
 * the approach ahead of it in the walk already stated a distance.
 */
const START_SENTENCE = "She takes your hand.";
const APPROACH_THEN_START_REPLY = `${APPROACH_REPLY} ${START_SENTENCE}`;
const APPROACH_THEN_START = {
  version: 1,
  movement: {
    kind: "approach",
    actorRef: "npc_0",
    counterpartRef: "player",
    band: "touching",
    facing: null,
    evidence: APPROACH_REPLY,
  },
  contact: {
    kind: "start",
    actorRef: "npc_0",
    targetRef: "player",
    gesture: "rest",
    targetLocationId: "hands",
    evidence: START_SENTENCE,
  },
};

beforeAll(async () => {
  if (!ready) return;
  fixture = await seedChatFixture({
    slug: "chat-npc-scene-decision-int",
    userName: "Scene Decision Int",
    // One glove pair, so the two-sided material read has an ACTOR-side layer to
    // compose.
    garments: [{ slug: "gloves", name: "leather gloves", category: "gloves", coverage: ["hands"], layer: 1 }],
  });
  mock.archivist = { value: chatArchivist(), degraded: false };
});

beforeEach(() => {
  process.env.CHAT_CONTACT_ACTIONS = "on";
  process.env.CHAT_NPC_SCENE_DECISION_SHADOW = "on";
  delete process.env.CHAT_NPC_SCENE_DECISIONS;
  delete process.env.CHAT_NPC_SCENE_DECISION_AUTHORITY_KINDS;
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
  delete process.env.CHAT_NPC_SCENE_DECISION_AUTHORITY_KINDS;
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

async function sceneOf(chatId: string): Promise<SceneState> {
  const scenario = await loadChatScenario(chatId);
  if (!scenario) throw new Error("scenario missing");
  return scenario.scene;
}

async function activeContacts(chatId: string) {
  return activeContactsOf((await sceneOf(chatId)).contacts);
}

/** The pair band the reply-scene leg would have written, as the narrator's projection now holds it. */
async function npcProximity(chatId: string) {
  return sceneProximityFact(await sceneOf(chatId), affordanceSubjectId(fixture.characterId), CHAT_CONTACT_PLAYER_SUBJECT);
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
      profile: fixture.profile,
    },
  ];
}

/** The settle report a direct `finish` call makes: this exchange wrote no wardrobe. */
function noWardrobeWrites() {
  return emptyChatNpcSceneSettleReport();
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
      ownerId: fixture.userId,
      roster: soloRoster(),
      scene: emptySceneState(),
      sink,
    });
    await finishChatNpcSceneDecision(handle, noWardrobeWrites());

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

// ---------------------------------------------------------------------------
// 7. Authority: increment 1 — movement
// ---------------------------------------------------------------------------

describe.runIf(ready)("authority mode commits movement", () => {
  it("an admitted approach moves the scene, and the envelope carries the committed intent", async () => {
    process.env.CHAT_NPC_SCENE_DECISIONS = "on";
    const chat = await newChat(fixture);
    classifier.output = APPROACH_PROPOSAL;

    await exchange(chat, { kind: "send", content: "I glance up from my book.", reply: APPROACH_REPLY });

    const assistantId = await lastAssistantId(chat.chatId);
    const row = await loadChatNpcSceneDecision(chat.chatId, assistantId);
    expect(row?.status).toBe("evaluated");
    expect(row?.mode).toBe("authority");
    const movement = row?.payload.actions.find((action) => action.kind === "movement");
    expect(movement?.resolution).toBe("committed");
    // A movement leaves NO ledger row, so the envelope's blob is its only
    // durable provenance — the spec's reason for storing committed intents.
    expect(movement?.committed).toBeDefined();
    expect(row?.payload.contactRows).toEqual([]);
    expect(await replyRows(chat.chatId)).toEqual([]);

    // The projection moved, and the column carries exactly what the envelope says.
    expect(row?.baseSceneHash).not.toBe(row?.resultSceneHash);
    expect(await sceneColumnHash(chat.chatId)).toBe(row?.resultSceneHash);
    const band = await npcProximity(chat.chatId);
    expect(band?.value).toBe("touching");
    expect(band?.provenance.source).toBe("npc_decision");
  });

  it("the scope knob excludes movement: the candidate records dry and the scene never moves", async () => {
    process.env.CHAT_NPC_SCENE_DECISIONS = "on";
    process.env.CHAT_NPC_SCENE_DECISION_AUTHORITY_KINDS = "start,update";
    const chat = await newChat(fixture);
    classifier.output = APPROACH_PROPOSAL;

    await exchange(chat, { kind: "send", content: "I glance up from my book.", reply: APPROACH_REPLY });

    const assistantId = await lastAssistantId(chat.chatId);
    const row = await loadChatNpcSceneDecision(chat.chatId, assistantId);
    // The knob gates EXECUTION only: the candidate was still admitted, so the
    // rollout measurement stays continuous across the step that enables it.
    expect(row?.mode).toBe("authority");
    expect(row?.payload.slots.movement).toBe("parsed");
    expect(row?.payload.drops).toEqual([]);
    const movement = row?.payload.actions.find((action) => action.kind === "movement");
    expect(movement?.resolution).toBe("unresolved");
    expect(movement?.detail).toBe("authority_scope_excluded");
    expect(row?.baseSceneHash).toBe(row?.resultSceneHash);
    expect(await npcProximity(chat.chatId)).toBeUndefined();
  });

  it("the authority flag alone is inert: without CHAT_CONTACT_ACTIONS the leg does not exist", async () => {
    delete process.env.CHAT_CONTACT_ACTIONS;
    delete process.env.CHAT_NPC_SCENE_DECISION_SHADOW;
    process.env.CHAT_NPC_SCENE_DECISIONS = "on";
    const chat = await newChat(fixture);
    classifier.output = APPROACH_PROPOSAL;

    await exchange(chat, { kind: "send", content: "I glance up.", reply: APPROACH_REPLY });

    expect(await envelopeCount(chat.chatId)).toBe(0);
    expect(classifier.calls).toBe(0);
    expect(await npcProximity(chat.chatId)).toBeUndefined();
  });
});

describe.runIf(ready)("authority presence integration", () => {
  it("an away member's contacts end as `separated` on the decision transaction", async () => {
    const chat = await newChat(fixture);
    await heldTouch(chat);
    expect(await activeContacts(chat.chatId)).toHaveLength(1);
    const assistantId = await lastAssistantId(chat.chatId);

    // Re-run the leg over the SAME persisted reply in authority mode: prune the
    // shadow envelope the exchange recorded (the reuse check answers before
    // anything else), and mark her away in the cut the leg RELOADS.
    await deleteChatNpcSceneDecision(chat.chatId, assistantId);
    await db()
      .update(characterChatState)
      .set({ presence: "away" })
      .where(
        and(eq(characterChatState.chatId, chat.chatId), eq(characterChatState.characterId, fixture.characterId)),
      );
    process.env.CHAT_NPC_SCENE_DECISIONS = "on";

    const handle = await beginChatNpcSceneDecision({
      chatId: chat.chatId,
      assistantMessageId: assistantId,
      reply: NEUTRAL_REPLY,
      mode: "authority",
      ownerId: fixture.userId,
      roster: soloRoster(),
      scene: await sceneOf(chat.chatId),
    });
    await finishChatNpcSceneDecision(handle, noWardrobeWrites());

    // Presence precedence: a body the cut says has LEFT takes its contacts with
    // it, deterministically and before any proposal could resolve.
    expect(await activeContacts(chat.chatId)).toEqual([]);
    const rows = await replyRows(chat.chatId);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.kind).toBe("contact_ended");
    expect(rows[0]?.guardMessageId).toBe(assistantId);
    expect(rows[0]?.payload).toMatchObject({ kind: "contact_ended", reason: "separated" });

    const row = await loadChatNpcSceneDecision(chat.chatId, assistantId);
    expect(row?.mode).toBe("authority");
    const presence = row?.payload.actions.find((action) => action.kind === "presence_ending");
    expect(presence?.resolution).toBe("committed");
    // The held touch was made after "I walk over to Wren", so the pair carries a
    // stated distance too — and a body that left takes it with them.
    expect(presence?.detail).toBe("presence_away_separated presence_away_relations_cleared");
    expect(row?.payload.contactRows).toEqual([{ eventRef: chatReplyContactEventRef(assistantId), sequence: 0 }]);
    expect(await npcProximity(chat.chatId)).toBeUndefined();
    expect(await sceneColumnHash(chat.chatId)).toBe(row?.resultSceneHash);
  });

  it("seeds a body the scene never placed, so a newly-present member can act", async () => {
    const chat = await newChat(fixture);
    classifier.output = APPROACH_PROPOSAL;
    // Shadow first: the envelope records and the scene is left exactly as it was.
    await exchange(chat, { kind: "send", content: "I glance up.", reply: APPROACH_REPLY });
    const assistantId = await lastAssistantId(chat.chatId);
    await deleteChatNpcSceneDecision(chat.chatId, assistantId);
    // A chat whose scene column was never written — the pre-feature row shape,
    // and the shape a roster member nobody has placed leaves behind.
    await db().update(characterChats).set({ scene: null }).where(eq(characterChats.id, chat.chatId));

    process.env.CHAT_NPC_SCENE_DECISIONS = "on";
    const handle = await beginChatNpcSceneDecision({
      chatId: chat.chatId,
      assistantMessageId: assistantId,
      reply: APPROACH_REPLY,
      mode: "authority",
      ownerId: fixture.userId,
      roster: soloRoster(),
      scene: emptySceneState(),
    });
    await finishChatNpcSceneDecision(handle, noWardrobeWrites());

    const scene = await sceneOf(chat.chatId);
    // Without the seeding step her body has no control fact, and every intent
    // about it would have answered `control_unresolved`.
    expect(sceneParticipant(scene, affordanceSubjectId(fixture.characterId))?.control?.value).toBe("npc_controlled");
    expect(sceneParticipant(scene, CHAT_CONTACT_PLAYER_SUBJECT)?.control?.value).toBe("player_controlled");
    expect((await npcProximity(chat.chatId))?.value).toBe("touching");
  });
});

// ---------------------------------------------------------------------------
// 8. Authority: increment 2 — contact starts
// ---------------------------------------------------------------------------

describe.runIf(ready)("authority mode commits contact starts", () => {
  // Unset scope defaults to MOVEMENT ONLY (constants.authority.test.ts pins
  // it): contact authority is an explicit operator opt-in, so every test that
  // expects a start to execute names the scope it is spending.
  it("an approach and a start in one reply commit in written order, on ONE transaction", async () => {
    process.env.CHAT_NPC_SCENE_DECISIONS = "on";
    process.env.CHAT_NPC_SCENE_DECISION_AUTHORITY_KINDS = "movement,start";
    const chat = await newChat(fixture);
    classifier.output = APPROACH_THEN_START;

    await exchange(chat, { kind: "send", content: "I glance up.", reply: APPROACH_THEN_START_REPLY });

    const assistantId = await lastAssistantId(chat.chatId);
    const row = await loadChatNpcSceneDecision(chat.chatId, assistantId);
    expect(row?.status).toBe("evaluated");
    expect(row?.mode).toBe("authority");
    expect(row?.payload.slots).toEqual({ movement: "parsed", contact: "parsed" });
    // Chronological order is what the envelope records: the approach's sentence
    // comes first, so the start resolves against the scene it left behind.
    expect(row?.payload.actions.map((action) => action.kind)).toEqual(["movement", "contact"]);
    const contact = row?.payload.actions.find((action) => action.kind === "contact");
    expect(contact?.resolution).toBe("committed");
    expect(contact?.contactRows).toEqual([{ eventRef: chatReplyContactEventRef(assistantId), sequence: 0 }]);
    expect(row?.payload.contactRows).toEqual([{ eventRef: chatReplyContactEventRef(assistantId), sequence: 0 }]);
    expect(row?.payload.drops).toEqual([]);

    // The durable ledger row, under the REPLY event ref and the assistant guard.
    const rows = await replyRows(chat.chatId);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.kind).toBe("contact_started");
    expect(rows[0]?.eventRef).toBe(chatReplyContactEventRef(assistantId));
    expect(rows[0]?.guardMessageId).toBe(assistantId);

    // The projection holds it, made by HER hand — and the column is byte-for-byte
    // the scene the envelope fingerprinted, which is the one-transaction proof.
    const active = await activeContacts(chat.chatId);
    expect(active).toHaveLength(1);
    expect(active[0]?.actorId).toBe(affordanceSubjectId(fixture.characterId));
    expect(active[0]?.source).toMatchObject({
      subjectId: affordanceSubjectId(fixture.characterId),
      locationId: "hands",
    });
    expect(active[0]?.target).toMatchObject({ subjectId: CHAT_CONTACT_PLAYER_SUBJECT, locationId: "hands" });
    expect(active[0]?.actionKind).toBe("affectionate");
    expect(row?.baseSceneHash).not.toBe(row?.resultSceneHash);
    expect(await sceneColumnHash(chat.chatId)).toBe(row?.resultSceneHash);
  });

  it("the NPC's own glove composes into the committed material, ahead of the target's side", async () => {
    const chat = await newChat(fixture);
    // One neutral exchange creates her state row; then she is gloved, and the
    // NEXT exchange's settle materializes the store the material read consults.
    await exchange(chat, { kind: "send", content: "Hello.", reply: NEUTRAL_REPLY });
    await db()
      .update(characterChatState)
      .set({ wornItemIds: [itemId(fixture, "gloves")] })
      .where(
        and(eq(characterChatState.chatId, chat.chatId), eq(characterChatState.characterId, fixture.characterId)),
      );

    process.env.CHAT_NPC_SCENE_DECISIONS = "on";
    process.env.CHAT_NPC_SCENE_DECISION_AUTHORITY_KINDS = "movement,start";
    classifier.output = APPROACH_THEN_START;
    await exchange(chat, { kind: "send", content: "I glance up.", reply: APPROACH_THEN_START_REPLY });

    const active = await activeContacts(chat.chatId);
    expect(active).toHaveLength(1);
    const layers = active[0]?.materialBetween ?? [];
    // The player is unmodelled-and-undressed (bare), so the glove is the ONLY
    // layer — and it is the SOURCE side's, which is the composition this
    // increment adds.
    expect(layers.length).toBeGreaterThan(0);
    expect(layers.every((layer) => layer.layerId.startsWith("source:"))).toBe(true);
  });

  it("a target dressed in something nobody modelled resolves UNRESOLVED — no row, no contact", async () => {
    const chat = await newChat(fixture);
    // The player in a look that lives only in a phrase: something is between the
    // hand and the skin, and this lane cannot name it.
    const scenario = await loadChatScenario(chat.chatId);
    if (!scenario) throw new Error("scenario missing");
    await db()
      .update(characterChats)
      .set({ playerState: { ...scenario.playerState, overlay: "a borrowed hoodie" } })
      .where(eq(characterChats.id, chat.chatId));

    process.env.CHAT_NPC_SCENE_DECISIONS = "on";
    process.env.CHAT_NPC_SCENE_DECISION_AUTHORITY_KINDS = "movement,start";
    classifier.output = APPROACH_THEN_START;
    await exchange(chat, { kind: "send", content: "I glance up.", reply: APPROACH_THEN_START_REPLY });

    const assistantId = await lastAssistantId(chat.chatId);
    const row = await loadChatNpcSceneDecision(chat.chatId, assistantId);
    const contact = row?.payload.actions.find((action) => action.kind === "contact");
    expect(contact?.resolution).toBe("unresolved");
    expect(contact?.detail).toBe("material_unavailable");
    expect(contact?.contactRows).toEqual([]);
    expect(await replyRows(chat.chatId)).toEqual([]);
    expect(await activeContacts(chat.chatId)).toEqual([]);
    // The movement beside it still landed: one candidate's silence is not the
    // other's.
    expect((await npcProximity(chat.chatId))?.value).toBe("touching");
  });

  it("the scope knob excluding `start` records the candidate dry and writes no contact", async () => {
    process.env.CHAT_NPC_SCENE_DECISIONS = "on";
    process.env.CHAT_NPC_SCENE_DECISION_AUTHORITY_KINDS = "movement";
    const chat = await newChat(fixture);
    classifier.output = APPROACH_THEN_START;

    await exchange(chat, { kind: "send", content: "I glance up.", reply: APPROACH_THEN_START_REPLY });

    const assistantId = await lastAssistantId(chat.chatId);
    const row = await loadChatNpcSceneDecision(chat.chatId, assistantId);
    expect(row?.payload.slots.contact).toBe("parsed");
    expect(row?.payload.drops).toEqual([]);
    const contact = row?.payload.actions.find((action) => action.kind === "contact");
    expect(contact?.resolution).toBe("unresolved");
    expect(contact?.detail).toBe("authority_scope_excluded");
    expect(await replyRows(chat.chatId)).toEqual([]);
    expect(await activeContacts(chat.chatId)).toEqual([]);
    // The movement half of the knob is still on, and still committed.
    expect((await npcProximity(chat.chatId))?.value).toBe("touching");
  });

  it("a wardrobe this same reply rewrote DROPS the start — no row, no contact, no action entry", async () => {
    const chat = await newChat(fixture);
    // Get the pair placed and the envelope out of the way, then re-run the leg
    // over the SAME persisted reply with the settle reporting a wardrobe write.
    classifier.output = APPROACH_THEN_START;
    await exchange(chat, { kind: "send", content: "I glance up.", reply: APPROACH_THEN_START_REPLY });
    const assistantId = await lastAssistantId(chat.chatId);
    await deleteChatNpcSceneDecision(chat.chatId, assistantId);
    expect(await activeContacts(chat.chatId)).toEqual([]);

    process.env.CHAT_NPC_SCENE_DECISIONS = "on";
    process.env.CHAT_NPC_SCENE_DECISION_AUTHORITY_KINDS = "movement,start";
    const handle = await beginChatNpcSceneDecision({
      chatId: chat.chatId,
      assistantMessageId: assistantId,
      reply: APPROACH_THEN_START_REPLY,
      mode: "authority",
      ownerId: fixture.userId,
      roster: soloRoster(),
      scene: await sceneOf(chat.chatId),
    });
    await finishChatNpcSceneDecision(handle, {
      wardrobeChanged: new Set([CHAT_CONTACT_PLAYER_SUBJECT]),
    });

    const row = await loadChatNpcSceneDecision(chat.chatId, assistantId);
    expect(row?.payload.drops).toEqual([
      expect.objectContaining({ candidate: "contact", reason: "wardrobe_chronology_ambiguous" }),
    ]);
    // A DROP: the candidate never reached a resolver, so it earns no action entry.
    expect(row?.payload.actions.some((action) => action.kind === "contact")).toBe(false);
    expect(row?.payload.contactRows).toEqual([]);
    expect(await replyRows(chat.chatId)).toEqual([]);
    expect(await activeContacts(chat.chatId)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// 9. Authority: increment 3 — contact updates
// ---------------------------------------------------------------------------

/** The spec's own worked example, second half: the gesture on a hand she is already holding. */
const SQUEEZE_REPLY = "Wren squeezes your hand.";
/** The own-hand shape — a modulation back to a plain rest, with no surface named. */
const STILL_REPLY = "Wren stills her hand.";

function updateProposal(gesture: string, evidence: string) {
  return {
    version: 1,
    movement: null,
    contact: { kind: "update", actorRef: "npc_0", contactRef: "contact_0", gesture, evidence },
  };
}

/**
 * Exchange one, in authority mode: she crosses the room and takes the player's
 * hand. The seed names the scope its start spends (the unset default is
 * movement only); a test about updates widens or narrows it afterwards.
 */
async function npcHeldTouch(chat: ChatSeat): Promise<void> {
  process.env.CHAT_NPC_SCENE_DECISIONS = "on";
  process.env.CHAT_NPC_SCENE_DECISION_AUTHORITY_KINDS = "movement,start";
  classifier.output = APPROACH_THEN_START;
  await exchange(chat, { kind: "send", content: "I glance up.", reply: APPROACH_THEN_START_REPLY });
}

/** The reply-side rows written under ONE assistant message's event ref. */
async function rowsUnder(chatId: string, assistantId: string) {
  const rows = await replyRows(chatId);
  return rows.filter((row) => row.eventRef === chatReplyContactEventRef(assistantId));
}

describe.runIf(ready)("authority mode commits contact updates", () => {
  it("an admitted update writes a contact_updated row under the reply event, and moves only the gesture", async () => {
    const chat = await newChat(fixture);
    await npcHeldTouch(chat);
    const [before] = await activeContacts(chat.chatId);
    expect(before?.pressure).toBe("light");

    process.env.CHAT_NPC_SCENE_DECISION_AUTHORITY_KINDS = "movement,start,update";
    classifier.output = updateProposal("squeeze", SQUEEZE_REPLY);
    await exchange(chat, { kind: "send", content: "I say nothing.", reply: SQUEEZE_REPLY });

    const assistantId = await lastAssistantId(chat.chatId);
    const row = await loadChatNpcSceneDecision(chat.chatId, assistantId);
    expect(row?.status).toBe("evaluated");
    expect(row?.mode).toBe("authority");
    expect(row?.payload.slots).toEqual({ movement: "absent", contact: "parsed" });
    const contact = row?.payload.actions.find((action) => action.kind === "contact");
    expect(contact?.resolution).toBe("committed");
    expect(contact?.detail).toBe("contact_updated");
    expect(contact?.contactRows).toEqual([{ eventRef: chatReplyContactEventRef(assistantId), sequence: 0 }]);
    expect(row?.payload.drops).toEqual([]);

    // The durable row: this reply's event ref, this assistant's guard.
    const rows = await rowsUnder(chat.chatId, assistantId);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.kind).toBe("contact_updated");
    expect(rows[0]?.guardMessageId).toBe(assistantId);
    expect(rows[0]?.contactId).toBe(before?.contactId);

    // The SAME contact, firmer — never a second contact, never a new identity.
    const active = await activeContacts(chat.chatId);
    expect(active).toHaveLength(1);
    expect(active[0]?.contactId).toBe(before?.contactId);
    expect(active[0]?.pressure).toBe("moderate");
    expect(active[0]?.actorId).toBe(affordanceSubjectId(fixture.characterId));
    expect(active[0]?.startedByEventRef).toBe(before?.startedByEventRef);
    // The CAS: the column is byte-for-byte the scene the envelope fingerprinted.
    expect(row?.baseSceneHash).not.toBe(row?.resultSceneHash);
    expect(await sceneColumnHash(chat.chatId)).toBe(row?.resultSceneHash);
  });

  it("an unchanged gesture continues the contact: no row, and the scene never moves", async () => {
    const chat = await newChat(fixture);
    await npcHeldTouch(chat);

    process.env.CHAT_NPC_SCENE_DECISION_AUTHORITY_KINDS = "movement,start,update";
    classifier.output = updateProposal("rest", STILL_REPLY);
    await exchange(chat, { kind: "send", content: "I say nothing.", reply: STILL_REPLY });

    const assistantId = await lastAssistantId(chat.chatId);
    const row = await loadChatNpcSceneDecision(chat.chatId, assistantId);
    const contact = row?.payload.actions.find((action) => action.kind === "contact");
    expect(contact?.resolution).toBe("continued");
    expect(contact?.detail).toBe("contact_continued gesture_unchanged");
    expect(contact?.contactRows).toEqual([]);
    expect(row?.payload.contactRows).toEqual([]);
    expect(await rowsUnder(chat.chatId, assistantId)).toEqual([]);
    // The hand is still resting, and the projection is exactly what it was.
    const active = await activeContacts(chat.chatId);
    expect(active[0]?.pressure).toBe("light");
    expect(row?.baseSceneHash).toBe(row?.resultSceneHash);
    expect(await sceneColumnHash(chat.chatId)).toBe(row?.resultSceneHash);
  });

  it("preserves the material the touch landed through — the reason an update is not a re-resolution", async () => {
    const chat = await newChat(fixture);
    // One neutral exchange to create her state row, then gloves, so the contact
    // she starts carries a real source-side layer.
    await exchange(chat, { kind: "send", content: "Hello.", reply: NEUTRAL_REPLY });
    await db()
      .update(characterChatState)
      .set({ wornItemIds: [itemId(fixture, "gloves")] })
      .where(
        and(eq(characterChatState.chatId, chat.chatId), eq(characterChatState.characterId, fixture.characterId)),
      );
    await npcHeldTouch(chat);
    const [before] = await activeContacts(chat.chatId);
    expect(before?.materialBetween.length).toBeGreaterThan(0);

    process.env.CHAT_NPC_SCENE_DECISION_AUTHORITY_KINDS = "movement,start,update";
    classifier.output = updateProposal("squeeze", SQUEEZE_REPLY);
    await exchange(chat, { kind: "send", content: "I say nothing.", reply: SQUEEZE_REPLY });

    const [after] = await activeContacts(chat.chatId);
    expect(after?.pressure).toBe("moderate");
    // Byte-identical: the post-settle wardrobe never touched a committed contact.
    expect(after?.materialBetween).toEqual(before?.materialBetween);
    expect(after?.transmission).toEqual(before?.transmission);
    expect(after?.contactArea).toEqual(before?.contactArea);
  });

  it("the scope knob excluding `update` records the candidate dry and modulates nothing", async () => {
    const chat = await newChat(fixture);
    await npcHeldTouch(chat);
    process.env.CHAT_NPC_SCENE_DECISION_AUTHORITY_KINDS = "movement,start";

    classifier.output = updateProposal("squeeze", SQUEEZE_REPLY);
    await exchange(chat, { kind: "send", content: "I say nothing.", reply: SQUEEZE_REPLY });

    const assistantId = await lastAssistantId(chat.chatId);
    const row = await loadChatNpcSceneDecision(chat.chatId, assistantId);
    expect(row?.payload.slots.contact).toBe("parsed");
    expect(row?.payload.drops).toEqual([]);
    const contact = row?.payload.actions.find((action) => action.kind === "contact");
    expect(contact?.resolution).toBe("unresolved");
    expect(contact?.detail).toBe("authority_scope_excluded");
    expect(await rowsUnder(chat.chatId, assistantId)).toEqual([]);
    expect((await activeContacts(chat.chatId))[0]?.pressure).toBe("light");
  });
});
