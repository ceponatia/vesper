import { and, desc, eq } from "drizzle-orm";
import {
  affordanceSubjectId,
  contactParticipantIds,
  DiagnosticCollector,
  type AffordanceSubjectId,
  type RomanticPermissionEvent,
} from "@/contracts";
import { newId } from "@/lib/ids";
import { characterChatMessages, characterChats, characters, chatParticipants, db } from "@/server/db";
import {
  appendChatPermissionEventsWithInvalidation,
  chatPermissionOverrideEventRef,
  chatPermissionReplyEventRef,
  CHAT_CONTACT_PLAYER_SUBJECT,
  foldChatPermissionProjection,
  listChatPermissionEvents,
  loadChatScenario,
} from "@/server/engine";
import type { PairContactSnapshot, PermissionSetup } from "./cases";

/**
 * Everything the rerun does to a database, separated from the run itself.
 *
 * The split exists so this half can be exercised against a disposable
 * development database (`driver.int.test.ts`) instead of discovering its bugs
 * inside a production flag window. Every function here is a plain async call
 * over ids — no model, no case list, no grading.
 */

export const ROMANTIC_SCOPE = "romantic_touch" as const;

export interface TrialTarget {
  readonly chatId: string;
  readonly memoryGroupId: string;
  readonly characterId: string;
  readonly characterName: string;
  readonly characterProfile: unknown;
  readonly subjectId: AffordanceSubjectId;
}

// ---------------------------------------------------------------------------
// Fixture resolution
// ---------------------------------------------------------------------------

/**
 * The chat this runs in, named explicitly, and verified to be the shape the
 * trial's assumptions rest on.
 *
 * It never CREATES one — building a chat correctly means a participant row, a
 * resolved memory group, a seeded scenario and a seeded relationship matrix, and
 * a script reproducing that approximately would run the trial against a
 * conversation subtly unlike the ones players have.
 *
 * It does insist on **one-on-one**. The runner drives `submitChatMessage`
 * directly rather than through the route, so it does not reproduce the route's
 * roster assembly, model selection or authority resolution. In a one-on-one
 * legacy chat those collapse to the single participant and the difference
 * vanishes; in an ensemble it would not, and the trial would be measuring a
 * turn assembled differently from the one players get. Refusing the ensemble is
 * the honest version of that limitation.
 */
export async function resolveTrialTarget(input: {
  readonly chatId: string;
  readonly ownerId: string;
  readonly characterName: string;
}): Promise<TrialTarget> {
  const [chat] = await db()
    .select({ id: characterChats.id, ownerId: characterChats.ownerId })
    .from(characterChats)
    .where(eq(characterChats.id, input.chatId))
    .limit(1);
  if (!chat) throw new Error(`no chat ${input.chatId}`);
  if (chat.ownerId !== input.ownerId) throw new Error(`chat ${input.chatId} is not the QA account's`);

  const roster = await db()
    .select({ characterId: chatParticipants.characterId, memoryGroupId: chatParticipants.memoryGroupId })
    .from(chatParticipants)
    .where(eq(chatParticipants.chatId, input.chatId))
    .orderBy(chatParticipants.sort);
  if (roster.length !== 1) {
    throw new Error(
      `chat ${input.chatId} has ${roster.length} participants; this trial requires a one-on-one chat, ` +
        "because it drives the pipeline directly and does not reproduce the route's roster assembly",
    );
  }
  const primary = roster[0];
  if (primary === undefined) throw new Error(`chat ${input.chatId} has no participants`);

  const [character] = await db()
    .select({ id: characters.id, name: characters.name, profile: characters.profile })
    .from(characters)
    .where(eq(characters.id, primary.characterId))
    .limit(1);
  if (!character) throw new Error(`participant character ${primary.characterId} is missing`);
  if (character.name !== input.characterName) {
    throw new Error(`chat ${input.chatId}'s primary is ${character.name}, not ${input.characterName}`);
  }

  return {
    chatId: chat.id,
    memoryGroupId: primary.memoryGroupId,
    characterId: character.id,
    characterName: character.name,
    characterProfile: character.profile,
    subjectId: affordanceSubjectId(character.id),
  };
}

// ---------------------------------------------------------------------------
// State reads
// ---------------------------------------------------------------------------

/**
 * Live contacts between the player and THIS character, and nobody else.
 *
 * The pair filter is the whole function. An unrelated contact surviving
 * elsewhere in the scene would keep "something is still live" true and suppress
 * the withdrawal verdict; an unrelated one disappearing would manufacture one.
 */
export async function readPairContacts(chatId: string, target: AffordanceSubjectId): Promise<PairContactSnapshot> {
  const scenario = await loadChatScenario(chatId);
  const contacts = scenario?.scene.contacts.contacts ?? [];
  return {
    contactIds: contacts
      .filter((contact) => {
        const participants = contactParticipantIds(contact.source, contact.target);
        return participants.includes(CHAT_CONTACT_PLAYER_SUBJECT) && participants.includes(target);
      })
      .map((contact) => String(contact.contactId)),
  };
}

export interface PermissionState {
  readonly standing: "granted" | "withdrawn" | "none";
  /** Action ids this pair currently has recorded denials for. */
  readonly deniedAttemptActionIds: readonly string[];
  readonly eventCount: number;
}

export async function readPermissionState(chatId: string, target: AffordanceSubjectId): Promise<PermissionState> {
  const sink = new DiagnosticCollector();
  const projection = foldChatPermissionProjection(await listChatPermissionEvents(chatId, sink), sink);
  const entry = projection.entries.find(
    (candidate) =>
      candidate.permittedActorId === CHAT_CONTACT_PLAYER_SUBJECT &&
      candidate.grantingTargetId === target &&
      candidate.scope === ROMANTIC_SCOPE,
  );
  const standing = entry?.standing;
  return {
    standing: standing === "granted" ? "granted" : standing === undefined ? "none" : "withdrawn",
    deniedAttemptActionIds: projection.denials
      .filter(
        (denial) =>
          denial.permittedActorId === CHAT_CONTACT_PLAYER_SUBJECT && denial.grantingTargetId === target,
      )
      .map((denial) => denial.attemptActionId ?? "")
      .filter((id) => id.length > 0),
    eventCount: projection.entries.length + projection.denials.length,
  };
}

// ---------------------------------------------------------------------------
// Message lookups
// ---------------------------------------------------------------------------

/**
 * The newest USER message. Filtered by role on purpose: after a settled exchange
 * the newest row is the assistant's reply, and a rerun target must be a user
 * line — pointing one at the reply is rejected as an invalid target and the
 * retake case can never run.
 */
export async function newestUserMessage(chatId: string): Promise<{ id: string; content: string } | null> {
  const [row] = await db()
    .select({ id: characterChatMessages.id, content: characterChatMessages.content })
    .from(characterChatMessages)
    .where(and(eq(characterChatMessages.chatId, chatId), eq(characterChatMessages.role, "user")))
    .orderBy(desc(characterChatMessages.createdAt), desc(characterChatMessages.id))
    .limit(1);
  return row ?? null;
}

export async function newestAssistantMessageId(chatId: string): Promise<string | null> {
  const [row] = await db()
    .select({ id: characterChatMessages.id })
    .from(characterChatMessages)
    .where(and(eq(characterChatMessages.chatId, chatId), eq(characterChatMessages.role, "assistant")))
    .orderBy(desc(characterChatMessages.createdAt), desc(characterChatMessages.id))
    .limit(1);
  return row?.id ?? null;
}

async function storyMinuteOf(chatId: string): Promise<number> {
  const [row] = await db()
    .select({ clockMinutes: characterChats.clockMinutes })
    .from(characterChats)
    .where(eq(characterChats.id, chatId))
    .limit(1);
  return Math.max(0, Math.trunc(row?.clockMinutes ?? 0));
}

async function guardMessageId(chatId: string): Promise<string | null> {
  const [row] = await db()
    .select({ id: characterChatMessages.id })
    .from(characterChatMessages)
    .where(eq(characterChatMessages.chatId, chatId))
    .orderBy(desc(characterChatMessages.createdAt), desc(characterChatMessages.id))
    .limit(1);
  return row?.id ?? null;
}

// ---------------------------------------------------------------------------
// Permission writes
// ---------------------------------------------------------------------------

/**
 * Move the standing grant, through the SAME atomic entry point the developer
 * override route uses — so a withdrawal's dependent-contact sweep runs exactly
 * as it does in production rather than being simulated here.
 */
export async function applyPermissionSetup(input: {
  readonly chatId: string;
  readonly target: AffordanceSubjectId;
  readonly setup: Exclude<PermissionSetup, "none">;
}): Promise<void> {
  const sink = new DiagnosticCollector();
  const storyMinute = await storyMinuteOf(input.chatId);
  const eventId = newId();
  const event: RomanticPermissionEvent = {
    eventId,
    branchId: input.chatId,
    permittedActorId: CHAT_CONTACT_PLAYER_SUBJECT,
    grantingTargetId: input.target,
    scope: ROMANTIC_SCOPE,
    kind: "developer_overridden",
    sourceKind: "developer_override",
    storyTime: storyMinute,
    orderInSource: 0,
    operation: input.setup,
  };
  const result = await appendChatPermissionEventsWithInvalidation({
    chatId: input.chatId,
    guardMessageId: await guardMessageId(input.chatId),
    eventRef: chatPermissionOverrideEventRef(eventId),
    storyMinute,
    events: [event],
    sink,
  });
  if (result.status === "refused") throw new Error(`permission ${input.setup} refused: ${result.reason}`);
}

/**
 * Record a denial BOUND TO ONE ATTEMPT, the way the NPC decision leg does.
 *
 * The binding is the entire point. `derivePermissionPolicyRead` applies a denial
 * only when its `attemptActionId` matches the attempt currently being resolved,
 * and the production decision leg drops denials that name no attempt — so an
 * unbound `attempt_denied` changes nothing, and a trial that wrote one would
 * report having tested an explicit denial while the resolver was quietly
 * answering "nobody said" the whole time.
 *
 * The action id it binds to is the one the observed exchange actually produced,
 * and the rerun that follows reuses that exchange's guard message, so the
 * attempt id is reproduced rather than guessed: the event ref derives from the
 * exchange guard and is stable across a retake of the same take.
 */
export async function bindAttemptDenial(input: {
  readonly chatId: string;
  readonly target: AffordanceSubjectId;
  readonly attemptActionId: string;
  readonly sourceMessageId: string;
}): Promise<void> {
  const sink = new DiagnosticCollector();
  const storyMinute = await storyMinuteOf(input.chatId);
  const event: RomanticPermissionEvent = {
    eventId: newId(),
    branchId: input.chatId,
    permittedActorId: CHAT_CONTACT_PLAYER_SUBJECT,
    grantingTargetId: input.target,
    scope: ROMANTIC_SCOPE,
    kind: "attempt_denied",
    sourceKind: "npc_decision",
    sourceMessageId: input.sourceMessageId,
    attemptActionId: input.attemptActionId,
    storyTime: storyMinute,
    orderInSource: 0,
  };
  const result = await appendChatPermissionEventsWithInvalidation({
    chatId: input.chatId,
    guardMessageId: await guardMessageId(input.chatId),
    eventRef: chatPermissionReplyEventRef(input.sourceMessageId),
    storyMinute,
    events: [event],
    sink,
  });
  if (result.status === "refused") throw new Error(`denial append refused: ${result.reason}`);
}
