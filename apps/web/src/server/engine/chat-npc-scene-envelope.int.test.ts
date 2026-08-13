import { and, eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  adapterSupported,
  commitContactResolution,
  contactCommitEvents,
  DiagnosticCollector,
  emptyContactLifecycleState,
  emptySceneState,
  resolveContactAttempt,
  withSceneContacts,
  type CommittableContactResolution,
  type CommittedContactOutcome,
  type ContactEventRef,
  type SceneState,
} from "@/contracts";
// The contact core's probe builders are deliberately out of the barrel (a probe
// default that reached production would become a physical claim nobody made).
import { probeAttempt } from "@/contracts/affordances/contact/test-support";
import { characterChatMessages, characterChats, chatContactEvents, chatNpcSceneDecisions, db } from "@/server/db";
import { expectDiagnostic } from "@/test/diagnostics";
import { chatReplyContactEventRef } from "./chat-contact-reply";
import {
  chatNpcDigestHash,
  chatNpcReplyHash,
  chatNpcSceneHash,
  deleteChatNpcSceneDecision,
  emptyNpcSceneDecisionPayload,
  loadChatNpcSceneDecision,
  newestChatNpcSceneDecision,
  recordChatNpcSceneDecision,
  NPC_SCENE_DECISION_PERSISTENCE_CONFLICT,
  type ChatNpcSceneDecisionEnvelope,
} from "./chat-npc-scene-envelope";
import {
  dropChatFixture,
  emptyChatFixture,
  newChat,
  probeIntegrationDb,
  seedChatFixture,
  type ChatFixture,
} from "@/server/test-support";

/**
 * The guarded decision-envelope transaction, against a real database — the half
 * the unit suite cannot claim (romantic-contact-affordances.spec.actor-control.md
 * §"Durable decision envelope and transaction"; delivery-order step 2):
 *
 * - the happy path commits all three halves — envelope, contact rows, scene
 *   CAS — in ONE transaction;
 * - an envelope-only decision (empty commits, unchanged scene) still runs and
 *   passes the CAS, because "nothing changed" is a claim about the column too;
 * - a byte-equivalent re-attempt is `reused` and writes NOTHING — proven by
 *   sabotaging the scene column first and seeing the sabotage survive;
 * - a stale scene CAS rolls back ALL halves, envelope and rows included;
 * - a deleted (or re-written) assistant row is a typed failure with nothing
 *   written — the decision was about bytes nobody kept;
 * - a conflicting contact row under the reply event ref aborts the whole
 *   transaction, exactly as the player ledger's own verification would;
 * - a NON-equivalent envelope under the unique key fails closed, which is the
 *   post-race loser's fate;
 * - the retake prune (`deleteChatNpcSceneDecision`) is unconditional, and
 *   clears the key so the regenerated take can record fresh;
 * - deleting the assistant reply CASCADES the envelope away (the hard-delete
 *   backstop);
 * - the trace read returns the NEWEST envelope, degrades a corrupt payload to
 *   the empty payload WITH a diagnostic, and drops (to `null`, with a
 *   diagnostic) a row whose status column left the vocabulary.
 *
 * Every conflict case asserts the typed result AND the
 * `npc_scene_decision.persistence_conflict` diagnostic — degradation without a
 * record is a blindfold (docs/resilience.md §8).
 */

// The table argument is the migration proof: a database without
// `chat_npc_scene_decisions` fails the probe exactly as an unreachable one does.
const ready = await probeIntegrationDb("chat-npc-scene-envelope.int.test", "chat_npc_scene_decisions");

let fixture: ChatFixture = emptyChatFixture();

beforeAll(async () => {
  if (!ready) return;
  fixture = await seedChatFixture({ slug: "chat-npc-scene-envelope-int", userName: "Envelope Int" });
});

afterAll(async () => {
  await dropChatFixture(fixture);
});

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** The one reply every happy-path envelope in this file is about. */
const REPLY = "She crosses the room and takes your hand.";
/** The post-settle story minute, truncated once for the whole envelope. */
const STORY_MINUTE = 100;

/** One persisted assistant reply — the row predicate 1 verifies. */
async function assistantMessage(chatId: string, content = REPLY): Promise<string> {
  const [row] = await db()
    .insert(characterChatMessages)
    .values({ chatId, role: "assistant", content })
    .returning({ id: characterChatMessages.id });
  if (!row) throw new Error("failed to insert assistant message");
  return row.id;
}

function committable(): CommittableContactResolution {
  const attempt = probeAttempt({ context: { material: adapterSupported({ layers: [], evidence: [] }) } });
  const resolution = resolveContactAttempt(attempt);
  if (resolution.status !== "committable") throw new Error(`fixture did not commit: ${resolution.status}`);
  return resolution;
}

/** A real started contact under this reply's event ref, from the real contact core. */
function startedFor(eventRef: ContactEventRef): CommittedContactOutcome {
  const outcome = commitContactResolution({ state: emptyContactLifecycleState(), resolution: committable(), eventRef });
  if (outcome.status !== "committed") throw new Error(`fixture was refused: ${outcome.reason}`);
  return outcome;
}

function envelopeFor(input: {
  reply?: string;
  base?: SceneState | null;
  next: SceneState;
  status?: ChatNpcSceneDecisionEnvelope["status"];
  digest?: unknown;
}): ChatNpcSceneDecisionEnvelope {
  return {
    replyHash: chatNpcReplyHash(input.reply ?? REPLY),
    digestHash: chatNpcDigestHash(input.digest ?? { roster: ["npc_0"] }),
    schemaVersion: 1,
    mode: "shadow",
    storyMinute: STORY_MINUTE,
    status: input.status ?? "evaluated",
    baseSceneHash: chatNpcSceneHash(input.base ?? emptySceneState()),
    resultSceneHash: chatNpcSceneHash(input.next),
    payload: emptyNpcSceneDecisionPayload(),
  };
}

/** Put the scene column into a known state — including the pre-feature SQL NULL. */
async function setScene(chatId: string, scene: SceneState | null): Promise<void> {
  if (scene === null) {
    await db().execute(sql`update ${characterChats} set scene = null where id = ${chatId}`);
    return;
  }
  await db().execute(sql`update ${characterChats} set scene = ${JSON.stringify(scene)}::jsonb where id = ${chatId}`);
}

/** A column value nothing in this suite ever writes through the transaction. */
async function sabotageScene(chatId: string): Promise<void> {
  await db().execute(sql`update ${characterChats} set scene = '{"sentinel":true}'::jsonb where id = ${chatId}`);
}

async function sceneColumn(chatId: string): Promise<unknown> {
  const [row] = await db()
    .select({ scene: characterChats.scene })
    .from(characterChats)
    .where(eq(characterChats.id, chatId))
    .limit(1);
  return row?.scene ?? null;
}

async function envelopeCount(chatId: string): Promise<number> {
  const rows = await db()
    .select({ id: chatNpcSceneDecisions.id })
    .from(chatNpcSceneDecisions)
    .where(eq(chatNpcSceneDecisions.chatId, chatId));
  return rows.length;
}

async function ledgerRows(chatId: string, eventRef: string): Promise<{ sequence: number; contactId: string }[]> {
  return db()
    .select({ sequence: chatContactEvents.sequence, contactId: chatContactEvents.contactId })
    .from(chatContactEvents)
    .where(and(eq(chatContactEvents.chatId, chatId), eq(chatContactEvents.eventRef, eventRef)));
}

/** Compare the raw column against a projection by the module's own fingerprint. */
function columnHash(raw: unknown): string {
  return chatNpcSceneHash(raw as SceneState);
}

// ---------------------------------------------------------------------------
// Recording
// ---------------------------------------------------------------------------

describe.runIf(ready)("the guarded transaction — all three halves, atomically", () => {
  it("records envelope + contact rows + scene together (the happy path)", async () => {
    const seat = await newChat(fixture);
    const assistantId = await assistantMessage(seat.chatId);
    const eventRef = chatReplyContactEventRef(assistantId);
    const outcome = startedFor(eventRef);
    const base = emptySceneState();
    const next = withSceneContacts(base, outcome.state);
    await setScene(seat.chatId, base);

    const sink = new DiagnosticCollector();
    const result = await recordChatNpcSceneDecision({
      chatId: seat.chatId,
      assistantMessageId: assistantId,
      envelope: envelopeFor({ base, next }),
      contact: { guardMessageId: assistantId, eventRef, commits: contactCommitEvents(outcome) },
      scene: { expectedBase: base, next },
      sink,
    });

    expect(result).toEqual({ status: "recorded", insertedContactRows: 1 });
    expect(sink.items).toEqual([]);
    // The envelope, as the reuse check will read it.
    const stored = await loadChatNpcSceneDecision(seat.chatId, assistantId);
    expect(stored?.status).toBe("evaluated");
    expect(stored?.replyHash).toBe(chatNpcReplyHash(REPLY));
    expect(stored?.payload).toEqual(emptyNpcSceneDecisionPayload());
    // The ledger row, under the reply event ref.
    expect(await ledgerRows(seat.chatId, eventRef)).toEqual([
      { sequence: 0, contactId: outcome.contact.contactId },
    ]);
    // The projection, swapped to the post-decision scene.
    expect(columnHash(await sceneColumn(seat.chatId))).toBe(chatNpcSceneHash(next));
  });

  it("records an envelope-only decision — no rows, unchanged scene, CAS still verified", async () => {
    const seat = await newChat(fixture);
    const assistantId = await assistantMessage(seat.chatId);
    // A fresh chat's scene column is SQL NULL — the pre-feature base the CAS
    // must also be able to name.
    const next = emptySceneState();

    const result = await recordChatNpcSceneDecision({
      chatId: seat.chatId,
      assistantMessageId: assistantId,
      envelope: envelopeFor({ base: null, next, status: "trigger_miss" }),
      contact: { guardMessageId: assistantId, eventRef: chatReplyContactEventRef(assistantId), commits: [] },
      scene: { expectedBase: null, next },
    });

    expect(result).toEqual({ status: "recorded", insertedContactRows: 0 });
    const stored = await loadChatNpcSceneDecision(seat.chatId, assistantId);
    // The tombstone is durable: a trigger miss is a decision, not an absence.
    expect(stored?.status).toBe("trigger_miss");
    expect(await ledgerRows(seat.chatId, chatReplyContactEventRef(assistantId))).toEqual([]);
    expect(columnHash(await sceneColumn(seat.chatId))).toBe(chatNpcSceneHash(next));
  });
});

// ---------------------------------------------------------------------------
// Idempotency and conflicts
// ---------------------------------------------------------------------------

describe.runIf(ready)("idempotency — the same decision twice is one record", () => {
  it("reuses a byte-equivalent re-attempt and writes NOTHING", async () => {
    const seat = await newChat(fixture);
    const assistantId = await assistantMessage(seat.chatId);
    const eventRef = chatReplyContactEventRef(assistantId);
    const outcome = startedFor(eventRef);
    const base = emptySceneState();
    const next = withSceneContacts(base, outcome.state);
    await setScene(seat.chatId, base);

    const attempt = {
      chatId: seat.chatId,
      assistantMessageId: assistantId,
      envelope: envelopeFor({ base, next }),
      contact: { guardMessageId: assistantId, eventRef, commits: contactCommitEvents(outcome) },
      scene: { expectedBase: base, next },
    };
    expect((await recordChatNpcSceneDecision(attempt)).status).toBe("recorded");

    // Sabotage the column. If the retry wrote ANYTHING — rows, scene, envelope —
    // the sentinel would not survive, and the stale expectedBase would have
    // tripped the CAS instead of the reuse path answering first.
    await sabotageScene(seat.chatId);
    const sink = new DiagnosticCollector();
    const retry = await recordChatNpcSceneDecision({ ...attempt, sink });

    expect(retry).toEqual({ status: "reused" });
    // Reuse is the DESIGNED idempotent path, not a conflict — no diagnostic.
    expect(sink.items).toEqual([]);
    expect(await envelopeCount(seat.chatId)).toBe(1);
    expect(await ledgerRows(seat.chatId, eventRef)).toHaveLength(1);
    expect(columnHash(await sceneColumn(seat.chatId))).toBe(columnHash({ sentinel: true }));
  });

  it("fails closed on a NON-equivalent envelope under the key — the race loser's fate", async () => {
    const seat = await newChat(fixture);
    const assistantId = await assistantMessage(seat.chatId);
    const eventRef = chatReplyContactEventRef(assistantId);
    const next = emptySceneState();
    const first = envelopeFor({ base: null, next });
    expect(
      (
        await recordChatNpcSceneDecision({
          chatId: seat.chatId,
          assistantMessageId: assistantId,
          envelope: first,
          contact: { guardMessageId: assistantId, eventRef, commits: [] },
          scene: { expectedBase: null, next },
        })
      ).status,
    ).toBe("recorded");

    // A second opinion about the same reply: different digest, different result
    // scene. Its own CAS would pass (expectedBase matches the column), so the
    // untouched column below proves the envelope check aborted FIRST.
    const outcome = startedFor(eventRef);
    const divergentNext = withSceneContacts(emptySceneState(), outcome.state);
    const sink = new DiagnosticCollector();
    const result = await recordChatNpcSceneDecision({
      chatId: seat.chatId,
      assistantMessageId: assistantId,
      envelope: envelopeFor({ base: emptySceneState(), next: divergentNext, digest: { roster: ["npc_0", "npc_1"] } }),
      contact: { guardMessageId: assistantId, eventRef, commits: contactCommitEvents(outcome) },
      scene: { expectedBase: emptySceneState(), next: divergentNext },
      sink,
    });

    expect(result).toEqual({ status: "envelope_conflict" });
    expectDiagnostic(sink, NPC_SCENE_DECISION_PERSISTENCE_CONFLICT);
    // The standing record is still the FIRST decision, in every half.
    const stored = await loadChatNpcSceneDecision(seat.chatId, assistantId);
    expect(stored?.digestHash).toBe(first.digestHash);
    expect(await ledgerRows(seat.chatId, eventRef)).toEqual([]);
    expect(columnHash(await sceneColumn(seat.chatId))).toBe(chatNpcSceneHash(next));
  });

  it("aborts everything when a conflicting contact row holds the reply event ref's key", async () => {
    const seat = await newChat(fixture);
    const assistantId = await assistantMessage(seat.chatId);
    const eventRef = chatReplyContactEventRef(assistantId);
    const base = emptySceneState();
    await setScene(seat.chatId, base);
    // Somebody else's record under the exact key this decision must write —
    // what an on→off→on flag sequence can leave behind.
    await db().insert(chatContactEvents).values({
      chatId: seat.chatId,
      guardMessageId: assistantId,
      eventRef,
      sequence: 0,
      kind: "contact_started",
      contactId: "contact_foreign",
      storyMinute: STORY_MINUTE,
      payload: { foreign: true },
    });

    const outcome = startedFor(eventRef);
    const next = withSceneContacts(base, outcome.state);
    const sink = new DiagnosticCollector();
    const result = await recordChatNpcSceneDecision({
      chatId: seat.chatId,
      assistantMessageId: assistantId,
      envelope: envelopeFor({ base, next }),
      contact: { guardMessageId: assistantId, eventRef, commits: contactCommitEvents(outcome) },
      scene: { expectedBase: base, next },
      sink,
    });

    expect(result).toEqual({ status: "ledger_conflict", mismatched: [{ eventRef, sequence: 0 }] });
    expectDiagnostic(sink, NPC_SCENE_DECISION_PERSISTENCE_CONFLICT);
    // The envelope insert preceded the row verification — the rollback must
    // take it back out.
    expect(await envelopeCount(seat.chatId)).toBe(0);
    // The foreign row is untouched and still alone.
    expect(await ledgerRows(seat.chatId, eventRef)).toEqual([{ sequence: 0, contactId: "contact_foreign" }]);
    expect(columnHash(await sceneColumn(seat.chatId))).toBe(chatNpcSceneHash(base));
  });
});

describe.runIf(ready)("the CAS and the assistant guard", () => {
  it("returns stale_scene and rolls back ALL halves when the column moved", async () => {
    const seat = await newChat(fixture);
    const assistantId = await assistantMessage(seat.chatId);
    const eventRef = chatReplyContactEventRef(assistantId);
    const outcome = startedFor(eventRef);
    const base = emptySceneState();
    const next = withSceneContacts(base, outcome.state);
    // The column carries something OTHER than the expected base cut.
    await sabotageScene(seat.chatId);

    const sink = new DiagnosticCollector();
    const result = await recordChatNpcSceneDecision({
      chatId: seat.chatId,
      assistantMessageId: assistantId,
      envelope: envelopeFor({ base, next }),
      contact: { guardMessageId: assistantId, eventRef, commits: contactCommitEvents(outcome) },
      scene: { expectedBase: base, next },
      sink,
    });

    expect(result).toEqual({ status: "stale_scene" });
    expectDiagnostic(sink, NPC_SCENE_DECISION_PERSISTENCE_CONFLICT);
    // The CAS is the LAST predicate — the envelope and the row had already
    // landed inside the transaction, so this is the full-rollback proof.
    expect(await envelopeCount(seat.chatId)).toBe(0);
    expect(await ledgerRows(seat.chatId, eventRef)).toEqual([]);
    expect(columnHash(await sceneColumn(seat.chatId))).toBe(columnHash({ sentinel: true }));
  });

  it("returns assistant_missing when the reply row is gone, writing nothing", async () => {
    const seat = await newChat(fixture);
    const assistantId = await assistantMessage(seat.chatId);
    await db().delete(characterChatMessages).where(eq(characterChatMessages.id, assistantId));

    const sink = new DiagnosticCollector();
    const result = await recordChatNpcSceneDecision({
      chatId: seat.chatId,
      assistantMessageId: assistantId,
      envelope: envelopeFor({ base: null, next: emptySceneState() }),
      contact: { guardMessageId: assistantId, eventRef: chatReplyContactEventRef(assistantId), commits: [] },
      scene: { expectedBase: null, next: emptySceneState() },
      sink,
    });

    expect(result).toEqual({ status: "assistant_missing", reason: "row_missing" });
    expectDiagnostic(sink, NPC_SCENE_DECISION_PERSISTENCE_CONFLICT);
    expect(await envelopeCount(seat.chatId)).toBe(0);
    expect(await sceneColumn(seat.chatId)).toBeNull();
  });

  it("returns assistant_missing when the stored reply no longer hashes to reply_hash", async () => {
    const seat = await newChat(fixture);
    const assistantId = await assistantMessage(seat.chatId, "The reply the decision never saw.");

    const sink = new DiagnosticCollector();
    const result = await recordChatNpcSceneDecision({
      chatId: seat.chatId,
      assistantMessageId: assistantId,
      // The envelope hashes REPLY — bytes the row does not carry.
      envelope: envelopeFor({ base: null, next: emptySceneState() }),
      contact: { guardMessageId: assistantId, eventRef: chatReplyContactEventRef(assistantId), commits: [] },
      scene: { expectedBase: null, next: emptySceneState() },
      sink,
    });

    expect(result).toEqual({ status: "assistant_missing", reason: "content_changed" });
    expectDiagnostic(sink, NPC_SCENE_DECISION_PERSISTENCE_CONFLICT);
    expect(await envelopeCount(seat.chatId)).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Prune, cascade, and the trace read
// ---------------------------------------------------------------------------

describe.runIf(ready)("the retake prune and the cascade backstop", () => {
  it("deletes the envelope unconditionally, clearing the key for the regenerated take", async () => {
    const seat = await newChat(fixture);
    const assistantId = await assistantMessage(seat.chatId);
    const next = emptySceneState();
    const record = (envelope: ChatNpcSceneDecisionEnvelope) =>
      recordChatNpcSceneDecision({
        chatId: seat.chatId,
        assistantMessageId: assistantId,
        envelope,
        contact: { guardMessageId: assistantId, eventRef: chatReplyContactEventRef(assistantId), commits: [] },
        scene: { expectedBase: null, next },
      });
    expect((await record(envelopeFor({ base: null, next }))).status).toBe("recorded");

    expect(await deleteChatNpcSceneDecision(seat.chatId, assistantId)).toEqual({ deleted: 1 });
    // Deleting nothing is the ordinary answer, not an error.
    expect(await deleteChatNpcSceneDecision(seat.chatId, assistantId)).toEqual({ deleted: 0 });
    expect(await loadChatNpcSceneDecision(seat.chatId, assistantId)).toBeNull();

    // The regenerated take records a DIFFERENT decision under the freed key —
    // exactly what predicate 3 would have refused had the tombstone survived.
    await setScene(seat.chatId, null);
    const regenerated = await record(
      envelopeFor({ base: null, next, status: "degraded", digest: { roster: [] } }),
    );
    expect(regenerated.status).toBe("recorded");
  });

  it("cascades the envelope away with a hard-deleted assistant reply", async () => {
    const seat = await newChat(fixture);
    const assistantId = await assistantMessage(seat.chatId);
    const next = emptySceneState();
    expect(
      (
        await recordChatNpcSceneDecision({
          chatId: seat.chatId,
          assistantMessageId: assistantId,
          envelope: envelopeFor({ base: null, next }),
          contact: { guardMessageId: assistantId, eventRef: chatReplyContactEventRef(assistantId), commits: [] },
          scene: { expectedBase: null, next },
        })
      ).status,
    ).toBe("recorded");
    expect(await envelopeCount(seat.chatId)).toBe(1);

    await db().delete(characterChatMessages).where(eq(characterChatMessages.id, assistantId));
    expect(await envelopeCount(seat.chatId)).toBe(0);
  });
});

describe.runIf(ready)("the dev trace read — the envelope IS the trace", () => {
  it("returns the newest envelope, degrades a corrupt payload, and drops an unnarrowable row", async () => {
    const seat = await newChat(fixture);
    const first = await assistantMessage(seat.chatId, "An earlier take.");
    const second = await assistantMessage(seat.chatId, "A later take.");
    const next = emptySceneState();
    const recordFor = (assistantMessageId: string, reply: string, expectedBase: SceneState | null) =>
      recordChatNpcSceneDecision({
        chatId: seat.chatId,
        assistantMessageId,
        envelope: envelopeFor({ reply, base: expectedBase, next }),
        contact: { guardMessageId: assistantMessageId, eventRef: chatReplyContactEventRef(assistantMessageId), commits: [] },
        scene: { expectedBase, next },
      });
    expect((await recordFor(first, "An earlier take.", null)).status).toBe("recorded");
    expect((await recordFor(second, "A later take.", next)).status).toBe("recorded");
    // Same-microsecond inserts could tie on created_at; make "older" explicit.
    await db().execute(sql`
      update ${chatNpcSceneDecisions} set created_at = created_at - interval '1 minute'
      where chat_id = ${seat.chatId} and assistant_message_id = ${first}
    `);

    const newest = await newestChatNpcSceneDecision(seat.chatId);
    expect(newest?.assistantMessageId).toBe(second);

    // A corrupt payload costs the DETAIL, never the read: the empty payload
    // arrives beside the intact columns, with the diagnostic that says why.
    await db().execute(sql`
      update ${chatNpcSceneDecisions} set payload = '"garbage"'::jsonb
      where chat_id = ${seat.chatId} and assistant_message_id = ${second}
    `);
    const degradedSink = new DiagnosticCollector();
    const degraded = await newestChatNpcSceneDecision(seat.chatId, degradedSink);
    expect(degraded?.assistantMessageId).toBe(second);
    expect(degraded?.payload).toEqual(emptyNpcSceneDecisionPayload());
    expectDiagnostic(degradedSink, "parse.boundary_failed");

    // A status outside the vocabulary makes the whole row unreadable — the
    // reader gets null and the diagnostic, not a crash and not a guess.
    await db().execute(sql`
      update ${chatNpcSceneDecisions} set status = 'improvised'
      where chat_id = ${seat.chatId} and assistant_message_id = ${second}
    `);
    const droppedSink = new DiagnosticCollector();
    expect(await newestChatNpcSceneDecision(seat.chatId, droppedSink)).toBeNull();
    expectDiagnostic(droppedSink, "parse.boundary_failed");
  });
});
