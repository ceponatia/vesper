import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  affordanceSubjectId,
  commitContactResolution,
  contactCommitEvents,
  derivePermissionPolicyRead,
  DiagnosticCollector,
  emptyContactLifecycleState,
  emptySceneState,
  resolveContactAttempt,
  withSceneContacts,
  withSceneParticipant,
  type AffordanceSubjectId,
  type ContactLifecycleCommit,
  type SceneState,
} from "@/contracts";
import {
  PROBE_ACTOR,
  PROBE_TARGET,
  probeAttempt,
  probeControl,
  probePolicy,
} from "@/contracts/affordances/contact/test-support";
import { newId } from "@/lib/ids";
import { characterChatMessages, characterChats, characters, chatParticipants, db } from "@/server/db";
import {
  appendChatContactEventsWithScene,
  chatContactEventRef,
  CHAT_CONTACT_PLAYER_SUBJECT,
  foldChatPermissionProjection,
  listChatPermissionEvents,
} from "@/server/engine";
import {
  dropChatFixture,
  emptyChatFixture,
  newChat,
  probeIntegrationDb,
  seedChatFixture,
  type ChatFixture,
} from "@/server/test-support";
import {
  applyPermissionSetup,
  bindAttemptDenial,
  newestAssistantMessageId,
  newestUserMessage,
  readPairContacts,
  readPermissionState,
  resolveTrialTarget,
  ROMANTIC_SCOPE,
} from "./driver";

/**
 * The rollout rerun's DATABASE half, against a real Postgres.
 *
 * It exists because the alternative is that the live Fly run is the driver's
 * first database execution — inside a window where two production flags are
 * temporarily on. Every bug fixed here is one that would otherwise have been
 * found there, with the clock running.
 *
 * The cases are the ones a review actually caught in this driver, each written
 * as the failure it produced rather than as the function it exercises:
 *
 * - `newestUserMessage` returning the ASSISTANT reply, which makes every rerun
 *   an invalid target and stops the six-case run from completing at all;
 * - a contact snapshot counting the whole scene, so an unrelated third-party
 *   contact keeps "still live" true and silently suppresses the withdrawal
 *   verdict;
 * - an `attempt_denied` written with no attempt bound to it, which the policy
 *   read ignores — so the denial case reports a pass while the resolver was
 *   answering "nobody said" the whole time;
 * - a fixture check that accepts an ensemble chat, whose roster and authority
 *   this runner does not reproduce.
 *
 * The pure halves — the required-state assertions, the prose oracle, the case
 * list — are the colocated unit suites'.
 */

const ready = await probeIntegrationDb("romantic-contact-driver.int.test", "chat_permission_events");

let fixture: ChatFixture = emptyChatFixture();
/** A second character, so the ensemble case has a genuinely distinct participant. */
let secondCharacterId = "";

beforeAll(async () => {
  if (!ready) return;
  fixture = await seedChatFixture({ slug: "romantic-trial-driver", userName: "Trial Driver", characterName: "Sabrina Vale" });
  const [row] = await db()
    .insert(characters)
    .values({ ownerId: fixture.userId, name: "Tomas Vale" })
    .returning({ id: characters.id });
  if (!row) throw new Error("failed to seed the second character");
  secondCharacterId = row.id;
});

afterAll(async () => {
  await dropChatFixture(fixture);
});

const target = () => affordanceSubjectId(fixture.characterId);

interface ContactPair {
  readonly actor: AffordanceSubjectId;
  readonly target: AffordanceSubjectId;
}

/**
 * Live contacts on the given pairs, committed in ONE append.
 *
 * One append, not several, for two reasons the first draft of this helper hit in
 * order: the event ref derives from the guard message, so a second append under
 * the same guard lands on the first's ledger keys and is refused; and the scene
 * column is written whole, so a second append replaces the first's contacts
 * rather than joining them.
 *
 * Every participant is PLACED in the scene it writes. That is not optional —
 * `parseSceneState` drops any contact whose endpoints are not participants of
 * the scene it was stored in, so a fixture writing into a participant-less scene
 * stores contacts successfully and then reads back none.
 */
async function seedPairContacts(
  chatId: string,
  guardMessageId: string,
  pairs: readonly ContactPair[],
): Promise<readonly string[]> {
  const eventRef = chatContactEventRef(guardMessageId);
  let state = emptyContactLifecycleState();
  const commits: ContactLifecycleCommit[] = [];
  const contactIds: string[] = [];
  for (const pair of pairs) {
    const resolution = resolveContactAttempt(
      probeAttempt({
        intent: {
          actorId: pair.actor,
          source: { kind: "body", subjectId: pair.actor, locationId: "hands" },
          target: { kind: "body", subjectId: pair.target, locationId: "shoulders" },
          actionKind: "romantic",
          storyTime: 100,
        },
        context: { actorControl: probeControl("allowed", pair.actor), policy: probePolicy("allowed", "romantic") },
      }),
    );
    if (resolution.status !== "committable") throw new Error(`probe attempt did not commit: ${resolution.status}`);
    const outcome = commitContactResolution({ state, resolution, eventRef });
    if (outcome.status !== "committed") throw new Error(`probe commit refused: ${outcome.reason}`);
    state = outcome.state;
    commits.push(...contactCommitEvents(outcome));
    contactIds.push(String(outcome.contact.contactId));
  }
  const appended = await appendChatContactEventsWithScene({
    chatId,
    guardMessageId,
    eventRef,
    storyMinute: 100,
    commits,
    scene: withSceneContacts(scenePlacing(pairs.flatMap((pair) => [pair.actor, pair.target])), state),
  });
  if (appended.status !== "recorded") throw new Error(`probe contact append refused: ${appended.status}`);
  return contactIds;
}

/** The scene every listed body is a participant of. */
function scenePlacing(subjects: readonly AffordanceSubjectId[]): SceneState {
  return subjects.reduce<SceneState>(
    (scene, subjectId) => withSceneParticipant(scene, { subjectId }),
    emptySceneState(),
  );
}

describe.skipIf(!ready)("resolving the fixture chat", () => {
  it("accepts a one-on-one chat owned by the caller with the named primary", async () => {
    const seat = await newChat(fixture);
    const resolved = await resolveTrialTarget({
      chatId: seat.chatId,
      ownerId: fixture.userId,
      characterName: fixture.characterName,
    });
    expect(resolved.characterId).toBe(fixture.characterId);
    expect(resolved.memoryGroupId).not.toBe("");
    expect(String(resolved.subjectId)).toContain(fixture.characterId);
  });

  it("refuses a chat the QA account does not own", async () => {
    const seat = await newChat(fixture);
    await expect(
      resolveTrialTarget({ chatId: seat.chatId, ownerId: "somebody-else", characterName: fixture.characterName }),
    ).rejects.toThrow(/not the QA account's/u);
  });

  it("refuses when the primary is a different character than the trial names", async () => {
    const seat = await newChat(fixture);
    await expect(
      resolveTrialTarget({ chatId: seat.chatId, ownerId: fixture.userId, characterName: "Someone Else" }),
    ).rejects.toThrow(/primary is/u);
  });

  /**
   * The runner drives the pipeline directly and does not reproduce the route's
   * roster assembly, model selection or authority resolution. In a one-on-one
   * chat those collapse to the single participant; in an ensemble they do not,
   * and the trial would be measuring a turn assembled differently from the one
   * players get.
   */
  it("refuses an ensemble chat, whose roster this runner does not reproduce", async () => {
    const seat = await newChat(fixture);
    await db()
      .insert(chatParticipants)
      .values({ chatId: seat.chatId, characterId: secondCharacterId, memoryGroupId: newId(), sort: 1 });
    await expect(
      resolveTrialTarget({ chatId: seat.chatId, ownerId: fixture.userId, characterName: fixture.characterName }),
    ).rejects.toThrow(/one-on-one/u);
  });
});

describe.skipIf(!ready)("reading messages back", () => {
  /**
   * After a settled exchange the newest row is the assistant's reply, and a
   * rerun target must be a user line. Pointing one at the reply is rejected as
   * an invalid target, so the retake case could never run.
   */
  it("returns the newest USER line, not the assistant reply that follows it", async () => {
    const seat = await newChat(fixture);
    await db()
      .insert(characterChatMessages)
      .values({ chatId: seat.chatId, role: "user", content: "I step closer to you. I caress your arm." });
    await db().insert(characterChatMessages).values({ chatId: seat.chatId, role: "assistant", content: "She goes still." });

    const user = await newestUserMessage(seat.chatId);
    expect(user?.content).toBe("I step closer to you. I caress your arm.");

    const assistant = await newestAssistantMessageId(seat.chatId);
    expect(assistant).not.toBeNull();
    expect(assistant).not.toBe(user?.id);
  });

  it("returns null on a chat with no user line at all", async () => {
    const [chat] = await db().insert(characterChats).values({ ownerId: fixture.userId }).returning({ id: characterChats.id });
    if (!chat) throw new Error("failed to create chat");
    expect(await newestUserMessage(chat.id)).toBeNull();
  });
});

describe.skipIf(!ready)("contact snapshots are scoped to the tested pair", () => {
  /**
   * The unrelated contact is the whole point. Counting the scene instead of the
   * pair would keep "something is still live" true after a withdrawal and
   * silently suppress that verdict, and an unrelated one disappearing would
   * manufacture one.
   */
  it("counts only the player↔character contact, with an unrelated pair live in the same scene", async () => {
    const seat = await newChat(fixture);
    const [mineId] = await seedPairContacts(seat.chatId, seat.messageId, [
      { actor: CHAT_CONTACT_PLAYER_SUBJECT, target: target() },
      { actor: PROBE_ACTOR, target: PROBE_TARGET },
    ]);

    const mine = await readPairContacts(seat.chatId, target());
    expect(mine.contactIds).toEqual([mineId]);

    const someoneElse = await readPairContacts(seat.chatId, affordanceSubjectId("character_unrelated"));
    expect(someoneElse.contactIds).toEqual([]);
  });
});

describe.skipIf(!ready)("the permission ledger", () => {
  it("reads a clean baseline as no answer at all", async () => {
    const seat = await newChat(fixture);
    const state = await readPermissionState(seat.chatId, target());
    expect(state).toEqual({ standing: "none", deniedAttemptActionIds: [], eventCount: 0 });
  });

  it("grants and withdraws through the production entry point", async () => {
    const seat = await newChat(fixture);
    await applyPermissionSetup({ chatId: seat.chatId, target: target(), setup: "grant" });
    expect((await readPermissionState(seat.chatId, target())).standing).toBe("granted");

    await applyPermissionSetup({ chatId: seat.chatId, target: target(), setup: "withdraw" });
    expect((await readPermissionState(seat.chatId, target())).standing).toBe("withdrawn");
  });

  /**
   * A withdrawal's dependent-contact sweep runs in the same transaction that
   * records the withdrawal, which is why the trial snapshots contacts around
   * SETUP and not only around the exchange. What is asserted here is only that
   * this driver reads the standing back correctly either side; the sweep's own
   * atomicity is `chat-permission.int.test.ts`'s invariant and is not re-proven.
   */
  it("reads the standing back either side of a withdrawal", async () => {
    const seat = await newChat(fixture);
    await applyPermissionSetup({ chatId: seat.chatId, target: target(), setup: "grant" });
    const before = await readPermissionState(seat.chatId, target());
    expect(before.standing).toBe("granted");

    await applyPermissionSetup({ chatId: seat.chatId, target: target(), setup: "withdraw" });
    const after = await readPermissionState(seat.chatId, target());
    expect(after.standing).toBe("withdrawn");
    expect(after.eventCount).toBeGreaterThan(0);
  });

  /**
   * The binding is the entire point of the denial case. `derivePermissionPolicyRead`
   * applies a denial only when it names the attempt being resolved, so an unbound
   * `attempt_denied` leaves the turn answering "nobody said" — which commits
   * nothing and reads exactly like a working denial unless the reason is checked.
   */
  it("a denial bound to an attempt is what the policy read actually applies", async () => {
    const seat = await newChat(fixture);
    const attemptActionId = `contact:${seat.messageId}#player:${fixture.characterId}:arms`;
    await bindAttemptDenial({
      chatId: seat.chatId,
      target: target(),
      attemptActionId,
      sourceMessageId: seat.messageId,
    });

    const state = await readPermissionState(seat.chatId, target());
    expect(state.deniedAttemptActionIds).toContain(attemptActionId);

    const sink = new DiagnosticCollector();
    const projection = foldChatPermissionProjection(await listChatPermissionEvents(seat.chatId, sink), sink);

    const denied = derivePermissionPolicyRead({
      projection,
      permittedActorId: CHAT_CONTACT_PLAYER_SUBJECT,
      grantingTargetId: target(),
      actionKind: "romantic",
      playerSubjectId: CHAT_CONTACT_PLAYER_SUBJECT,
      attemptActionId,
    });
    expect(denied.status).toBe("denied");

    // A DIFFERENT attempt is untouched by it — the denial refuses one attempt,
    // never the direction.
    const other = derivePermissionPolicyRead({
      projection,
      permittedActorId: CHAT_CONTACT_PLAYER_SUBJECT,
      grantingTargetId: target(),
      actionKind: "romantic",
      playerSubjectId: CHAT_CONTACT_PLAYER_SUBJECT,
      attemptActionId: `${attemptActionId}-other`,
    });
    expect(other.status).toBe("unresolved");
  });
});
