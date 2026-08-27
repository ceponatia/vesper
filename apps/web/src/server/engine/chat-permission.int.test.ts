import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  activeContactsOf,
  activeRomanticPermissionGrants,
  affordanceSubjectId,
  commitContactResolution,
  compileNarratorPhysicalGuidance,
  contactCommitEvents,
  DiagnosticCollector,
  emptyContactLifecycleState,
  emptySceneState,
  parseSceneState,
  resolveContactAttempt,
  sceneStateOf,
  withSceneContacts,
  type AffordanceSubjectId,
  type CommittedContactOutcome,
  type ContactLifecycleCommit,
  type RomanticPermissionEvent,
  type SceneState,
} from "@/contracts";
import { newId } from "@/lib/ids";
// Probe builders are deliberately out of both barrels — a probe grant or a
// probe contact that reached production would be a claim nobody made.
import {
  PROBE_ACTOR,
  PROBE_TARGET,
  probeAttempt,
  probeControl,
  probePolicy,
} from "@/contracts/affordances/contact/test-support";
import { probePermissionEvent } from "@/contracts/affordances/permission/test-support";
import { eq } from "drizzle-orm";
import { characterChatMessages, characterChats, db } from "@/server/db";
import {
  dropChatFixture,
  emptyChatFixture,
  newChat,
  probeIntegrationDb,
  seedChatFixture,
  type ChatFixture,
  type ChatSeat,
} from "@/server/test-support";
import { chatContactEventRef } from "./chat-contact-adapter";
import {
  appendChatContactEventsWithScene,
  deleteChatContactEventsForGuard,
  listChatContactEvents,
} from "./chat-contact-events";
import {
  appendChatPermissionEventsWithInvalidation,
  chatPermissionOverrideEventRef,
  chatPermissionReplyEventRef,
  chatMessageHasNpcPermissionAuthority,
  deleteChatPermissionEventsForGuard,
  foldChatPermissionProjection,
  listChatPermissionEvents,
} from "./chat-permission-events";
import { loadChatPermissionStopTransitions, CHAT_CONTACT_ENDED_CODE } from "./chat-permission-guidance";
import { renderChatPhysicalGuidance } from "./chat-physical-guidance-render";

/**
 * The permission ledger's DATABASE half — what only a real Postgres can prove:
 *
 * - a producer append is durable, keyed to its guard, and idempotent against
 *   its own retry (the same call re-derives the same keys and lands nowhere);
 * - a DIFFERENT record under this call's keys aborts the WHOLE write — the
 *   verified conflict, not the blind `onConflictDoNothing`;
 * - a withdrawal ends the permission-dependent active contact ATOMICALLY: the
 *   permission rows, the `contact_ended` row (under the permission event ref),
 *   and the swept scene land in one transaction, so the three surfaces can
 *   never expose a mixed state;
 * - a grant-only append reads no scene and ends nothing;
 * - the retake prune deletes exactly one guard's rows, leaving the null-guard
 *   developer-override rows (which have no exchange to roll back) standing;
 * - the ruled refusals refuse without writing: a foreign `branchId`, and a
 *   withdrawal that must end contacts with no guard to hang the ends on;
 * - the narrator handoff (spec step 4, `chat-permission-guidance.ts`): the
 *   NEXT reply's guidance build finds the withdrawal's ending pending, compiles
 *   it into the binding stop line, and finds nothing once a reply has landed —
 *   for the NPC-decision ref and the override ref both — and the retake prune
 *   of the guarded rows removes the pending emission with them;
 * - and that the handoff survives an ENSEMBLE revocation: one append that ends
 *   contact on two distinct pairs arms the next reply with BOTH stops, each
 *   naming its own pair, because the emission window closes for every pending
 *   ending at once and a stop that misses it is never told to anyone.
 *
 * The pure halves — row mapping, conflict judgment, fold, chronology, resolver
 * mapping, the emission rule itself — are the colocated unit suites'.
 */

const ready = await probeIntegrationDb("chat-permission.int.test", "chat_permission_events");

let fixture: ChatFixture = emptyChatFixture();

beforeAll(async () => {
  if (!ready) return;
  fixture = await seedChatFixture({ slug: "chat-permission-int", userName: "Permission Int" });
});

afterAll(async () => {
  await dropChatFixture(fixture);
});

/** The stored scene column, through the same boundary the pipeline reads. */
async function storedScene(chatId: string): Promise<SceneState> {
  const [row] = await db()
    .select({ scene: characterChats.scene })
    .from(characterChats)
    .where(eq(characterChats.id, chatId));
  return row?.scene === null || row?.scene === undefined ? emptySceneState() : parseSceneState(row.scene);
}

/** One persisted assistant reply — what settle's `persistAssistantReply` leaves behind. */
async function insertAssistantReply(chatId: string, content: string): Promise<string> {
  const [row] = await db()
    .insert(characterChatMessages)
    .values({ chatId, role: "assistant", content })
    .returning({ id: characterChatMessages.id });
  if (!row) throw new Error("failed to insert assistant reply");
  return row.id;
}

/** A directional grant/withdrawal fixture speaking about the seeded contact's pair. */
function permissionEvent(
  chat: ChatSeat,
  overrides: Partial<RomanticPermissionEvent> = {},
): RomanticPermissionEvent {
  return probePermissionEvent({
    branchId: chat.chatId,
    permittedActorId: PROBE_ACTOR,
    grantingTargetId: PROBE_TARGET,
    ...overrides,
  });
}

/**
 * A scene that PLACES the probe bodies. `parseSceneState` enforces referential
 * integrity — a housed contact whose participants are not placed in the scene
 * is dropped as orphaned on every read — so a seeded projection must place the
 * pair or the invalidation sweep (which reads the stored scene through the same
 * boundary) sees no active contact to end.
 */
function scenePlacing(...subjectIds: readonly AffordanceSubjectId[]): SceneState {
  return sceneStateOf({ participants: subjectIds.map((subjectId) => ({ subjectId })) });
}

/**
 * A LIVE romantic contact, durably committed the way the leg commits one: the
 * contact rows and the scene projection in one transactional append, under the
 * exchange guard. The policy stored on it says a grant covered it at commit
 * time; what the sweep later believes comes from the permission ledger, not
 * from this snapshot.
 */
async function seedRomanticContact(chat: ChatSeat): Promise<CommittedContactOutcome> {
  const resolution = resolveContactAttempt(
    probeAttempt({
      intent: { actionKind: "romantic", storyTime: 100 },
      context: { policy: probePolicy("allowed", "romantic") },
    }),
  );
  if (resolution.status !== "committable") throw new Error(`fixture did not commit: ${resolution.status}`);
  const eventRef = chatContactEventRef(chat.messageId);
  const outcome = commitContactResolution({ state: emptyContactLifecycleState(), resolution, eventRef });
  if (outcome.status !== "committed") throw new Error(`fixture was refused: ${outcome.reason}`);
  const appended = await appendChatContactEventsWithScene({
    chatId: chat.chatId,
    guardMessageId: chat.messageId,
    eventRef,
    storyMinute: 100,
    commits: contactCommitEvents(outcome),
    scene: withSceneContacts(scenePlacing(PROBE_ACTOR, PROBE_TARGET), outcome.state),
  });
  expect(appended.status).toBe("recorded");
  return outcome;
}

/** A second NPC, so an ensemble revocation has two distinct pairs to end. */
const PROBE_SECOND_ACTOR = affordanceSubjectId("probe_actor_two");

/**
 * Several live romantic contacts on DISTINCT pairs, committed in ONE append —
 * the ensemble shape a multi-decision reply leaves behind. The contact id is
 * derived from the pair key plus the start event, so one event ref carries them
 * all without collision, and the ledger's `sequence` indexes the whole list.
 */
async function seedRomanticContacts(
  chat: ChatSeat,
  pairs: readonly { readonly actor: AffordanceSubjectId; readonly target: AffordanceSubjectId }[],
): Promise<readonly CommittedContactOutcome[]> {
  const eventRef = chatContactEventRef(chat.messageId);
  let state = emptyContactLifecycleState();
  const commits: ContactLifecycleCommit[] = [];
  const outcomes: CommittedContactOutcome[] = [];
  for (const [index, pair] of pairs.entries()) {
    const resolution = resolveContactAttempt(
      probeAttempt({
        intent: {
          actionId: `probe_action_${index}`,
          actorId: pair.actor,
          source: { kind: "body", subjectId: pair.actor, locationId: "hands" },
          target: { kind: "body", subjectId: pair.target, locationId: "shoulders" },
          actionKind: "romantic",
          storyTime: 100,
        },
        context: {
          actorControl: probeControl("allowed", pair.actor),
          policy: probePolicy("allowed", "romantic"),
        },
      }),
    );
    if (resolution.status !== "committable") throw new Error(`fixture did not commit: ${resolution.status}`);
    const outcome = commitContactResolution({ state, resolution, eventRef });
    if (outcome.status !== "committed") throw new Error(`fixture was refused: ${outcome.reason}`);
    state = outcome.state;
    commits.push(...contactCommitEvents(outcome));
    outcomes.push(outcome);
  }
  const appended = await appendChatContactEventsWithScene({
    chatId: chat.chatId,
    guardMessageId: chat.messageId,
    eventRef,
    storyMinute: 100,
    commits,
    scene: withSceneContacts(scenePlacing(...pairs.flatMap((pair) => [pair.actor, pair.target])), state),
  });
  expect(appended.status).toBe("recorded");
  return outcomes;
}

describe.runIf(ready)("the permission append — durable, keyed, idempotent, verified", () => {
  it("records the events and is idempotent against its own retry", async () => {
    const chat = await newChat(fixture);
    const input = {
      chatId: chat.chatId,
      guardMessageId: chat.messageId,
      eventRef: chatPermissionReplyEventRef(chat.messageId),
      storyMinute: 100,
      events: [permissionEvent(chat, { eventId: "evt_grant" })],
    };
    expect(await appendChatPermissionEventsWithInvalidation(input)).toEqual({
      status: "recorded",
      inserted: 1,
      endedContactIds: [],
    });
    // The crash-retry guarantee: the same call re-derives the same
    // (chat, event ref, sequence) keys and lands nowhere.
    expect(await appendChatPermissionEventsWithInvalidation(input)).toEqual({
      status: "recorded",
      inserted: 0,
      endedContactIds: [],
    });

    const rows = await listChatPermissionEvents(chat.chatId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      guardMessageId: chat.messageId,
      eventRef: `permission-reply:${chat.messageId}`,
      sequence: 0,
      kind: "granted",
      sourceKind: "npc_decision",
      permittedActorId: String(PROBE_ACTOR),
      grantingTargetId: String(PROBE_TARGET),
      scope: "romantic_touch",
      storyMinute: 100,
    });
    // The payload survives the jsonb round trip as the event it was.
    const projection = foldChatPermissionProjection(rows);
    expect(projection.entries.map((entry) => entry.standing)).toEqual(["granted"]);
  });

  it("a DIFFERENT record under this call's keys aborts the whole write", async () => {
    const chat = await newChat(fixture);
    const eventRef = chatPermissionReplyEventRef(chat.messageId);
    const base = { chatId: chat.chatId, guardMessageId: chat.messageId, eventRef, storyMinute: 100 };
    expect(
      await appendChatPermissionEventsWithInvalidation({
        ...base,
        events: [permissionEvent(chat, { eventId: "evt_grant" })],
      }),
    ).toMatchObject({ status: "recorded", inserted: 1 });

    // The same key, claiming something else — a stale take's divergence.
    const sink = new DiagnosticCollector();
    const conflicting = await appendChatPermissionEventsWithInvalidation({
      ...base,
      events: [
        permissionEvent(chat, { eventId: "evt_denied", kind: "attempt_denied", attemptActionId: "a1" }),
      ],
      sink,
    });
    expect(conflicting).toMatchObject({
      status: "mismatched",
      mismatched: [{ eventRef, sequence: 0 }],
    });
    expect(sink.items.map((item) => item.code)).toEqual(["chat_permission.ledger.mismatch"]);

    // Nothing was added and nothing was replaced.
    const rows = await listChatPermissionEvents(chat.chatId);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.kind).toBe("granted");
  });
});

describe.runIf(ready)("revocation during active contact — one transaction, no mixed state", () => {
  it("a withdrawal ends the permission-dependent contact, rows + scene together", async () => {
    const chat = await newChat(fixture);
    const seeded = await seedRomanticContact(chat);
    expect(activeContactsOf((await storedScene(chat.chatId)).contacts)).toHaveLength(1);

    const sink = new DiagnosticCollector();
    const result = await appendChatPermissionEventsWithInvalidation({
      chatId: chat.chatId,
      guardMessageId: chat.messageId,
      eventRef: chatPermissionReplyEventRef(chat.messageId),
      storyMinute: 120,
      events: [permissionEvent(chat, { eventId: "evt_withdraw", kind: "withdrawn", storyTime: 120 })],
      sink,
    });
    expect(result).toEqual({
      status: "recorded",
      inserted: 1,
      endedContactIds: [seeded.contact.contactId],
    });

    // The contact ledger carries the end UNDER THE PERMISSION EVENT REF — the
    // withdrawal is the thing that ended it, and the record says so.
    const contactRows = await listChatContactEvents(chat.chatId);
    expect(contactRows.map((row) => row.kind)).toEqual(["contact_started", "contact_ended"]);
    expect(contactRows[1]).toMatchObject({
      eventRef: `permission-reply:${chat.messageId}`,
      contactId: seeded.contact.contactId,
      storyMinute: 120,
    });
    expect(contactRows[1]?.payload).toMatchObject({ kind: "contact_ended", reason: "policy_withdrawn" });

    // …and the projection agrees in the same breath: nothing is touching.
    expect(activeContactsOf((await storedScene(chat.chatId)).contacts)).toEqual([]);
    // The sweep names its own lapse; the codes are the contact core's.
    expect(sink.items.map((item) => item.code)).toContain("contact.authorization_lapsed");
  });

  it("an attempt denial ends only the contact created by that attempt and keeps the standing grant", async () => {
    const chat = await newChat(fixture);
    const seeded = await seedRomanticContact(chat);
    const result = await appendChatPermissionEventsWithInvalidation({
      chatId: chat.chatId,
      guardMessageId: chat.messageId,
      eventRef: chatPermissionReplyEventRef(chat.messageId),
      storyMinute: 120,
      events: [
        permissionEvent(chat, { eventId: "evt_grant_before_denial", storyTime: 100 }),
        permissionEvent(chat, {
          eventId: "evt_denied_attempt",
          kind: "attempt_denied",
          attemptActionId: "attempt-denied-action",
          attemptContactId: seeded.contact.contactId,
          storyTime: 120,
          orderInSource: 1,
        }),
      ],
    });
    expect(result).toMatchObject({ status: "recorded", endedContactIds: [seeded.contact.contactId] });
    expect(activeContactsOf((await storedScene(chat.chatId)).contacts)).toEqual([]);
    expect(activeRomanticPermissionGrants(foldChatPermissionProjection(await listChatPermissionEvents(chat.chatId))))
      .toHaveLength(1);
  });

  it("withdrawing one direction leaves another direction's contact active", async () => {
    const chat = await newChat(fixture);
    const seeded = await seedRomanticContacts(chat, [
      { actor: PROBE_ACTOR, target: PROBE_TARGET },
      { actor: PROBE_SECOND_ACTOR, target: PROBE_TARGET },
    ]);
    const result = await appendChatPermissionEventsWithInvalidation({
      chatId: chat.chatId,
      guardMessageId: chat.messageId,
      eventRef: chatPermissionReplyEventRef(chat.messageId),
      storyMinute: 120,
      events: [
        permissionEvent(chat, { eventId: "evt_grant_a", storyTime: 100 }),
        permissionEvent(chat, {
          eventId: "evt_grant_b",
          permittedActorId: PROBE_SECOND_ACTOR,
          storyTime: 100,
          orderInSource: 1,
        }),
        permissionEvent(chat, {
          eventId: "evt_withdraw_a_only",
          kind: "withdrawn",
          storyTime: 120,
          orderInSource: 2,
        }),
      ],
    });
    expect(result).toMatchObject({ status: "recorded", endedContactIds: [seeded[0]?.contact.contactId] });
    expect(activeContactsOf((await storedScene(chat.chatId)).contacts).map((contact) => contact.contactId)).toEqual([
      seeded[1]?.contact.contactId,
    ]);
  });

  it("a grant-only append ends nothing and leaves the scene alone", async () => {
    const chat = await newChat(fixture);
    const seeded = await seedRomanticContact(chat);
    const before = await storedScene(chat.chatId);

    const result = await appendChatPermissionEventsWithInvalidation({
      chatId: chat.chatId,
      guardMessageId: chat.messageId,
      eventRef: chatPermissionReplyEventRef(chat.messageId),
      storyMinute: 120,
      events: [permissionEvent(chat, { eventId: "evt_grant" })],
    });
    expect(result).toEqual({ status: "recorded", inserted: 1, endedContactIds: [] });
    expect(await storedScene(chat.chatId)).toEqual(before);
    expect(activeContactsOf((await storedScene(chat.chatId)).contacts).map((c) => c.contactId)).toEqual([
      seeded.contact.contactId,
    ]);
    expect((await listChatContactEvents(chat.chatId)).map((row) => row.kind)).toEqual(["contact_started"]);
  });
});

describe.runIf(ready)("retake pruning and the ruled refusals", () => {
  it("marks NPC permission source messages as state-authoritative", async () => {
    const chat = await newChat(fixture);
    expect(await chatMessageHasNpcPermissionAuthority(chat.chatId, chat.messageId)).toBe(false);
    expect(
      await appendChatPermissionEventsWithInvalidation({
        chatId: chat.chatId,
        guardMessageId: chat.messageId,
        eventRef: chatPermissionReplyEventRef(chat.messageId),
        storyMinute: 100,
        events: [permissionEvent(chat, { eventId: "evt_source_authority" })],
      }),
    ).toMatchObject({ status: "recorded" });
    expect(await chatMessageHasNpcPermissionAuthority(chat.chatId, chat.messageId)).toBe(true);
  });

  it("deletes exactly one guard's rows, and never the null-guard override rows", async () => {
    const chat = await newChat(fixture);
    expect(
      await appendChatPermissionEventsWithInvalidation({
        chatId: chat.chatId,
        guardMessageId: chat.messageId,
        eventRef: chatPermissionReplyEventRef(chat.messageId),
        storyMinute: 100,
        events: [permissionEvent(chat, { eventId: "evt_reply_grant" })],
      }),
    ).toMatchObject({ status: "recorded" });
    expect(
      await appendChatPermissionEventsWithInvalidation({
        chatId: chat.chatId,
        // The pre-message developer-override case: no exchange to hang on.
        guardMessageId: null,
        eventRef: chatPermissionOverrideEventRef("evt_override_grant"),
        storyMinute: 100,
        events: [
          permissionEvent(chat, {
            eventId: "evt_override_grant",
            kind: "developer_overridden",
            sourceKind: "developer_override",
            operation: "grant",
          }),
        ],
      }),
    ).toMatchObject({ status: "recorded" });
    expect(await listChatPermissionEvents(chat.chatId)).toHaveLength(2);

    // The discarded take's rows go; the override — keyed to no exchange — stays.
    expect(await deleteChatPermissionEventsForGuard(chat.chatId, chat.messageId)).toEqual({ deleted: 1 });
    const rows = await listChatPermissionEvents(chat.chatId);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.guardMessageId).toBeNull();
    expect(rows[0]?.eventRef).toBe("permission-override:evt_override_grant");
  });

  it("refuses events naming another branch, writing nothing", async () => {
    const chat = await newChat(fixture);
    const sink = new DiagnosticCollector();
    const result = await appendChatPermissionEventsWithInvalidation({
      chatId: chat.chatId,
      guardMessageId: chat.messageId,
      eventRef: chatPermissionReplyEventRef(chat.messageId),
      storyMinute: 100,
      // A grant may never leak across branches — a producer that tries has a bug.
      events: [permissionEvent(chat, { eventId: "evt_foreign", branchId: "some_other_chat" })],
      sink,
    });
    expect(result).toEqual({ status: "refused", reason: "branch_mismatch" });
    expect(sink.items.map((item) => item.code)).toEqual(["chat_permission.append.refused"]);
    expect(await listChatPermissionEvents(chat.chatId)).toEqual([]);
  });

  it("refuses a withdrawal that must end contacts but carries no guard", async () => {
    const chat = await newChat(fixture);
    const seeded = await seedRomanticContact(chat);
    const sink = new DiagnosticCollector();
    const result = await appendChatPermissionEventsWithInvalidation({
      chatId: chat.chatId,
      guardMessageId: null,
      eventRef: chatPermissionOverrideEventRef("evt_override_withdraw"),
      storyMinute: 120,
      events: [
        permissionEvent(chat, {
          eventId: "evt_override_withdraw",
          kind: "developer_overridden",
          sourceKind: "developer_override",
          operation: "withdraw",
          storyTime: 120,
        }),
      ],
      sink,
    });
    expect(result).toEqual({ status: "refused", reason: "invalidation_requires_guard" });
    expect(sink.items.map((item) => item.code)).toEqual(["chat_permission.append.refused"]);
    // Nothing moved: no permission rows, the contact still live, the scene intact.
    expect(await listChatPermissionEvents(chat.chatId)).toEqual([]);
    expect(activeContactsOf((await storedScene(chat.chatId)).contacts).map((c) => c.contactId)).toEqual([
      seeded.contact.contactId,
    ]);
  });
});

describe.runIf(ready)("the narrator handoff — the next reply is told to stop", () => {
  /** The names the pipeline would supply for the probe pair. */
  const stopNames = () => ({
    [String(PROBE_ACTOR)]: "the player",
    [String(PROBE_TARGET)]: fixture.characterName,
  });

  /** The next exchange's guidance build, through the real seams end to end. */
  async function nextReplyStopLines(
    chatId: string,
    sink?: DiagnosticCollector,
    names: Readonly<Record<string, string>> = stopNames(),
  ): Promise<readonly string[]> {
    const transitions = await loadChatPermissionStopTransitions({
      chatId,
      // A fresh exchange's assistant row id exists before its row does.
      assistantMessageId: newId(),
      ...(sink === undefined ? {} : { sink }),
    });
    const guidance = compileNarratorPhysicalGuidance({
      transitions,
      ...(sink === undefined ? {} : { sink }),
    });
    return renderChatPhysicalGuidance({
      guidance,
      characterName: fixture.characterName,
      possessive: `${fixture.characterName}'s`,
      subjectNames: names,
      ...(sink === undefined ? {} : { sink }),
    });
  }

  it("an NPC-decision withdrawal arms exactly the next reply with the binding stop line", async () => {
    const chat = await newChat(fixture);
    const seeded = await seedRomanticContact(chat);
    // Reply A grants (the decision leg's shape: reply ref, guarded by the reply row).
    const replyA = await insertAssistantReply(chat.chatId, "“You can hold my hand.”");
    expect(
      await appendChatPermissionEventsWithInvalidation({
        chatId: chat.chatId,
        guardMessageId: replyA,
        eventRef: chatPermissionReplyEventRef(replyA),
        storyMinute: 100,
        events: [permissionEvent(chat, { eventId: "evt_grant_a" })],
      }),
    ).toMatchObject({ status: "recorded" });

    // Reply B withdraws; the sweep ends the dependent contact in the same settle.
    const replyB = await insertAssistantReply(chat.chatId, "“Stop. Not anymore.”");
    const sink = new DiagnosticCollector();
    expect(
      await appendChatPermissionEventsWithInvalidation({
        chatId: chat.chatId,
        guardMessageId: replyB,
        eventRef: chatPermissionReplyEventRef(replyB),
        storyMinute: 120,
        events: [permissionEvent(chat, { eventId: "evt_withdraw_b", kind: "withdrawn", storyTime: 120 })],
        sink,
      }),
    ).toEqual({ status: "recorded", inserted: 1, endedContactIds: [seeded.contact.contactId] });

    // No surface exposes a mixed state: the scene, the contact ledger, and the
    // permission projection all agree in the same breath.
    expect(activeContactsOf((await storedScene(chat.chatId)).contacts)).toEqual([]);
    const projection = foldChatPermissionProjection(await listChatPermissionEvents(chat.chatId));
    expect(projection.entries.map((entry) => entry.standing)).toEqual(["withdrawn"]);
    const endedRow = (await listChatContactEvents(chat.chatId)).find((row) => row.kind === "contact_ended");
    expect(endedRow).toMatchObject({ eventRef: `permission-reply:${replyB}`, guardMessageId: replyB });

    // The NEXT reply's guidance build receives the binding stop.
    const transitions = await loadChatPermissionStopTransitions({
      chatId: chat.chatId,
      assistantMessageId: newId(),
      sink,
    });
    expect(transitions).toHaveLength(1);
    expect(transitions[0]).toMatchObject({
      subjectIds: [String(PROBE_ACTOR), String(PROBE_TARGET)],
      afterCodes: [CHAT_CONTACT_ENDED_CODE],
      relevance: "action",
      repeatKey: `permission-stop:permission-reply:${replyB}:${String(PROBE_ACTOR)}->${String(PROBE_TARGET)}`,
    });
    const lines = await nextReplyStopLines(chat.chatId, sink);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("- Ended contact:");
    expect(lines[0]).toContain("is no longer touching");
    // The spec fixture "narrator output cannot continue invalidated contact":
    // the instruction explicitly forbids continuation.
    expect(lines[0]).toContain("do not write it as continuing, resuming, or still in progress");
    // ...and exposes nothing policy-side.
    expect(lines[0]?.toLowerCase()).not.toMatch(/permission|grant|policy|override|withdraw|threshold|ledger/u);

    // Once the reply that portrayed the stop lands, the window closes for good.
    await insertAssistantReply(chat.chatId, "She steps back, folding her arms.");
    expect(await nextReplyStopLines(chat.chatId)).toEqual([]);
  });

  it("a developer-override withdrawal arms the next reply through its own ref", async () => {
    const chat = await newChat(fixture);
    const seeded = await seedRomanticContact(chat);
    // The endpoint anchors an override to the NEWEST message — here the reply row.
    const replyA = await insertAssistantReply(chat.chatId, "Her hand stays in yours.");
    const overrideId = "evt_override_withdraw_now";
    expect(
      await appendChatPermissionEventsWithInvalidation({
        chatId: chat.chatId,
        guardMessageId: replyA,
        eventRef: chatPermissionOverrideEventRef(overrideId),
        storyMinute: 120,
        events: [
          permissionEvent(chat, {
            eventId: overrideId,
            kind: "developer_overridden",
            sourceKind: "developer_override",
            operation: "withdraw",
            storyTime: 120,
          }),
        ],
      }),
    ).toMatchObject({ status: "recorded", endedContactIds: [seeded.contact.contactId] });

    const transitions = await loadChatPermissionStopTransitions({
      chatId: chat.chatId,
      assistantMessageId: newId(),
    });
    expect(transitions).toHaveLength(1);
    expect(transitions[0]?.repeatKey).toBe(
      `permission-stop:permission-override:${overrideId}:${String(PROBE_ACTOR)}->${String(PROBE_TARGET)}`,
    );
    expect((await nextReplyStopLines(chat.chatId))[0]).toContain("- Ended contact:");

    // The reply that follows the override closes the window.
    await insertAssistantReply(chat.chatId, "She lets go and looks away.");
    expect(await nextReplyStopLines(chat.chatId)).toEqual([]);
  });

  it("an ensemble revocation ending TWO pairs loses neither pair's stop", async () => {
    // The multi-pair case a budget of one used to eat: one reply's decisions end
    // contact on two distinct pairs, both endings land under the same permission
    // event ref, and the emission window closes as soon as the next reply
    // persists — so a pair that does not render on THIS build is never rendered
    // on any build. Both must reach the prompt, each naming its own pair.
    const chat = await newChat(fixture);
    const seeded = await seedRomanticContacts(chat, [
      { actor: PROBE_ACTOR, target: PROBE_TARGET },
      { actor: PROBE_SECOND_ACTOR, target: PROBE_TARGET },
    ]);
    expect(activeContactsOf((await storedScene(chat.chatId)).contacts)).toHaveLength(2);

    const replyB = await insertAssistantReply(chat.chatId, "“Both of you — stop.”");
    const sink = new DiagnosticCollector();
    const appended = await appendChatPermissionEventsWithInvalidation({
      chatId: chat.chatId,
      guardMessageId: replyB,
      eventRef: chatPermissionReplyEventRef(replyB),
      storyMinute: 120,
      events: [
        permissionEvent(chat, { eventId: "evt_withdraw_pair_a", kind: "withdrawn", storyTime: 120 }),
        permissionEvent(chat, {
          eventId: "evt_withdraw_pair_b",
          kind: "withdrawn",
          permittedActorId: PROBE_SECOND_ACTOR,
          storyTime: 120,
          orderInSource: 1,
        }),
      ],
      sink,
    });
    expect(appended).toMatchObject({ status: "recorded" });
    expect(appended.status === "recorded" ? [...appended.endedContactIds].sort() : []).toEqual(
      seeded.map((outcome) => outcome.contact.contactId).sort(),
    );
    expect(activeContactsOf((await storedScene(chat.chatId)).contacts)).toEqual([]);
    // One lapse named per contact the sweep ended, not one for the batch.
    expect(sink.items.filter((item) => item.code === "contact.authorization_lapsed")).toHaveLength(2);

    // TWO pending stops, one per pair — not one merged claim about everyone in
    // the room, which would end contacts nothing ended.
    const transitions = await loadChatPermissionStopTransitions({
      chatId: chat.chatId,
      assistantMessageId: newId(),
    });
    expect(transitions).toHaveLength(2);
    expect(new Set(transitions.map((transition) => transition.repeatKey))).toEqual(
      new Set([
        `permission-stop:permission-reply:${replyB}:${String(PROBE_ACTOR)}->${String(PROBE_TARGET)}`,
        `permission-stop:permission-reply:${replyB}:${String(PROBE_SECOND_ACTOR)}->${String(PROBE_TARGET)}`,
      ]),
    );

    const lines = await nextReplyStopLines(chat.chatId, undefined, {
      ...stopNames(),
      [String(PROBE_SECOND_ACTOR)]: "Mira",
    });
    expect(lines).toHaveLength(2);
    for (const actor of ["the player", "Mira"]) {
      expect(lines).toContain(
        `- Ended contact: ${actor} is no longer touching ${fixture.characterName}'s shoulder. ` +
          "That contact is over now — do not write it as continuing, resuming, or still in progress. " +
          "If the stop has not already been shown, portray it naturally (an in-character reaction is fine); " +
          "do not decide how the player responds.",
      );
    }
    // The safety sweep applies to the whole block, not just its first line.
    const joined = lines.join(" ").toLowerCase();
    for (const banned of [
      "permission",
      "grant",
      "policy",
      "override",
      "revoked",
      "withdraw",
      "threshold",
      "ledger",
      "standing",
      "invalidated",
    ]) {
      expect(joined, banned).not.toContain(banned);
    }

    // …and the window still closes for BOTH once a reply has portrayed them.
    await insertAssistantReply(chat.chatId, "They both let go.");
    expect(await nextReplyStopLines(chat.chatId)).toEqual([]);
  });

  it("the retake prune of the guarded rows removes the pending emission", async () => {
    const chat = await newChat(fixture);
    await seedRomanticContact(chat);
    const replyB = await insertAssistantReply(chat.chatId, "“Enough.”");
    expect(
      await appendChatPermissionEventsWithInvalidation({
        chatId: chat.chatId,
        guardMessageId: replyB,
        eventRef: chatPermissionReplyEventRef(replyB),
        storyMinute: 120,
        events: [permissionEvent(chat, { eventId: "evt_withdraw_retake", kind: "withdrawn", storyTime: 120 })],
      }),
    ).toMatchObject({ status: "recorded" });
    expect(await loadChatPermissionStopTransitions({ chatId: chat.chatId, assistantMessageId: newId() })).toHaveLength(1);

    // The pipeline's regenerate block: the reply-keyed contact AND permission
    // rows go before the new take runs (chat-pipeline.ts retake prune).
    await deleteChatContactEventsForGuard(chat.chatId, replyB);
    await deleteChatPermissionEventsForGuard(chat.chatId, replyB);

    // The regenerate reuses reply B's row in place — the new take's build
    // excludes it as the current assistant row, and nothing is pending.
    expect(
      await loadChatPermissionStopTransitions({ chatId: chat.chatId, assistantMessageId: replyB }),
    ).toEqual([]);
  });
});
