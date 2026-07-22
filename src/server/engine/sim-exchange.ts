import { claimHoldingEngagementStates } from "@/contracts/simulation/engagements";
import { simCalendarStartSchema, type SimCalendarStart } from "@/lib/simulation/clock";
import { simulationHash } from "@/lib/simulation/hash";
import { deriveEngagementId } from "@/lib/simulation/engagements";
import { newId } from "@/lib/ids";
import { parseOr } from "@/lib/parse";
import { characterChatMessages, db, simBranches, simCharacters, simWorlds } from "@/server/db";
import { desc, eq } from "drizzle-orm";
import { readChatEngineAuthority } from "./chat-authority";
import { persistAssistantReply } from "./chat-pipeline";
import { buildLiveDeliberation, renderCommittedCut } from "./sim-narrator";
import { prepareEngagementTurn, readDurableEngagements, submitDurableOpenEngagement } from "./simulation";

/**
 * R3 admission wiring (engine.rollout.plan.md) — one player message becomes
 * one successor turn: the shared core behind BOTH the explicit
 * `/sim-turn` route and the ordinary chat send path (which routes here when
 * the chat's authority flag says so — the wiring R1 deferred "until a
 * successor leg exists to route to"; it does now). The legacy pipeline is
 * still never imported from here and vice versa — the lanes meet only at
 * the route fork.
 */

/**
 * The actor pair's ACTUAL standing scene: any open co-present engagement
 * holding both mapped actors, no matter which chat (or storyteller tool)
 * opened it. One body, one physical scene (engine.spec §11.3) means a
 * per-chat derived id cannot be trusted to find it — a second chat mapped
 * to the same pair would mint a NEW open command and be refused
 * `participant_already_engaged` forever (the R3 live-session bug). Returns
 * the branch head too, so a miss can mint a head-scoped open command:
 * stable under a same-head race, fresh after an end_scene.
 */
export async function findStandingEngagement(
  branchId: string,
  playerActorId: string,
  primaryActorId: string,
): Promise<{ engagementId: string | null; headSequence: number }> {
  const projection = await readDurableEngagements(branchId);
  const standing = projection.engagements.find((engagement) => {
    const participants: readonly string[] = engagement.participantIds;
    return (
      engagement.channel === "co_present" &&
      claimHoldingEngagementStates.includes(engagement.state) &&
      participants.includes(playerActorId) &&
      participants.includes(primaryActorId)
    );
  });
  return { engagementId: standing?.id ?? null, headSequence: projection.headSequence };
}

/**
 * Find the pair's standing scene or open a fresh one. A refusal carries the
 * §14.4 public face (code + public reason), never a private cause.
 */
export async function findOrOpenStandingEngagement(input: {
  branchId: string;
  playerActorId: string;
  primaryActorId: string;
  userId: string;
  correlationId: string;
}): Promise<{ ok: true; engagementId: string } | { ok: false; code: string; publicReason: string }> {
  const { branchId, playerActorId, primaryActorId } = input;
  const found = await findStandingEngagement(branchId, playerActorId, primaryActorId);
  if (found.engagementId !== null) return { ok: true, engagementId: found.engagementId };

  const openCommandId = `sim-scene-open-${simulationHash({ branchId, playerActorId, primaryActorId })}-${found.headSequence}`;
  const opened = await submitDurableOpenEngagement(
    {
      id: openCommandId,
      branchId,
      expectedVersion: 0,
      idempotencyKey: openCommandId,
      principal: { kind: "player" as const, principalId: input.userId, controlledActorIds: [playerActorId] },
      submittedAtWallClock: new Date().toISOString(),
      correlationId: input.correlationId,
      type: "open_engagement",
      schemaVersion: 1,
      payload: { participantIds: [playerActorId, primaryActorId].sort(), channel: "co_present" },
    },
    { admitAtLockedVersion: true },
  );
  if (opened.status === "accepted" || (opened.status === "rejected" && opened.code === "duplicate_command_id")) {
    return { ok: true, engagementId: deriveEngagementId(branchId, openCommandId) };
  }
  if (opened.status === "rejected" && opened.code === "participant_already_engaged") {
    // Race: another window opened the pair's scene between our read and this
    // submit — the re-read finds what the claim law just protected.
    const refound = await findStandingEngagement(branchId, playerActorId, primaryActorId);
    if (refound.engagementId !== null) return { ok: true, engagementId: refound.engagementId };
  }
  return opened.status === "rejected"
    ? { ok: false, code: opened.code, publicReason: opened.publicReason }
    : { ok: false, code: "sim_conflict", publicReason: "The world moved; try again." };
}

export interface SimChatClock {
  storySecond: number;
  /** The world's calendar anchor (R5 time domain) — null = no calendar, "Day N" display. */
  calendarStart: SimCalendarStart | null;
}

/**
 * R3 slice 4 + R5 time domain (ruling 17) — the routed chat's world clock:
 * the linked branch's `storySecond` plus the world's calendar anchor, or null
 * for a legacy chat. The chat UI shows THIS clock for sim-routed chats
 * (parity throughout the system), never the legacy scenario clock; the client
 * derives the legible label via the shared story-clock seam.
 */
export async function readSimChatClock(chatId: string): Promise<SimChatClock | null> {
  const authority = await readChatEngineAuthority(chatId);
  if (
    !authority ||
    authority.authority === "legacy_chat" ||
    authority.authority === "successor_shadow" ||
    !authority.simBranchId
  ) {
    return null;
  }
  return readBranchClock(authority.simBranchId);
}

/** The branch clock + its world's calendar anchor (fail-open to no calendar). */
export async function readBranchClock(branchId: string): Promise<SimChatClock | null> {
  const [row] = await db()
    .select({ storySecond: simBranches.storySecond, calendarStart: simWorlds.calendarStart })
    .from(simBranches)
    .innerJoin(simWorlds, eq(simWorlds.id, simBranches.worldId))
    .where(eq(simBranches.id, branchId))
    .limit(1);
  if (!row) return null;
  return {
    storySecond: row.storySecond,
    calendarStart: parseOr(simCalendarStartSchema.nullable(), row.calendarStart ?? null, null, undefined, "sim_worlds.calendar_start"),
  };
}

export type SimChatExchangeResult =
  | {
      ok: true;
      messageId: string;
      prose: string;
      cutId: string;
      modelId: string;
      attempts: number;
      degraded: boolean;
      diagnostics: string[];
    }
  | { ok: false; code: "not_sim_enabled" | "sim_open_failed" | "render_withheld"; message: string; status: number };

/**
 * Run one successor exchange for an OWNERSHIP-CHECKED chat: gate on the
 * authority flag, land the player line in the transcript, find-or-open the
 * standing scene, prepare the turn (live deliberation included), render the
 * committed cut, persist the prose as the ordinary assistant message. A
 * withheld render leaves no assistant line — ruling 8. The player line
 * persists BEFORE the scene gate: a refusal explains itself via
 * lastReplyFailure and never deletes what the player typed.
 */
export async function runSimChatExchange(input: {
  chatId: string;
  userId: string;
  speakerCharacterId: string;
  /** The primary character's display name — labels the dialogue tail. */
  speakerName?: string;
  message: string;
}): Promise<SimChatExchangeResult> {
  const authority = await readChatEngineAuthority(input.chatId);
  if (
    !authority ||
    authority.authority === "legacy_chat" ||
    authority.authority === "successor_shadow" ||
    !authority.simBranchId ||
    !authority.simPlayerActorId ||
    !authority.simPrimaryActorId
  ) {
    return {
      ok: false,
      code: "not_sim_enabled",
      message: "this chat is not routed to the successor engine (authority + branch + actor mapping required)",
      status: 409,
    };
  }
  const branchId = authority.simBranchId;
  const playerActorId = authority.simPlayerActorId;
  const primaryActorId = authority.simPrimaryActorId;

  // World-truth display names — prose never reads actor ids well, and the
  // agency rule needs to NAME the player's character to bind.
  const nameRows = await db()
    .select({ characterId: simCharacters.characterId, name: simCharacters.name })
    .from(simCharacters)
    .where(eq(simCharacters.branchId, branchId));
  const actorNames = Object.fromEntries(nameRows.map((row) => [row.characterId, row.name]));
  const playerName = actorNames[playerActorId] ?? "the player";

  // The conversational context the narrator responds to: the last few
  // transcript lines (before this turn's insert), oldest first. Assistant
  // lines are labeled NARRATION, not a character — earlier replies may have
  // wrongly voiced the player's character and must read as narration output,
  // never as an example of that character speaking.
  const tailRows = await db()
    .select({ role: characterChatMessages.role, content: characterChatMessages.content })
    .from(characterChatMessages)
    .where(eq(characterChatMessages.chatId, input.chatId))
    .orderBy(desc(characterChatMessages.createdAt))
    .limit(6);
  const dialogueTail = tailRows
    .reverse()
    .map((row) => ({
      speaker: row.role === "user" ? `PLAYER (as ${playerName})` : "NARRATION (previous)",
      text: row.content,
    }));

  const userMessageId = newId();
  await db().insert(characterChatMessages).values({
    id: userMessageId,
    chatId: input.chatId,
    speakerCharacterId: null,
    role: "user",
    content: input.message,
    meta: { simTurn: true },
  });

  const scene = await findOrOpenStandingEngagement({
    branchId,
    playerActorId,
    primaryActorId,
    userId: input.userId,
    correlationId: `sim-turn-${input.chatId}`,
  });
  if (!scene.ok) {
    return { ok: false, code: "sim_open_failed", message: `the scene could not open: ${scene.publicReason}`, status: 409 };
  }

  const turn = await prepareEngagementTurn({
    branchId,
    engagementId: scene.engagementId,
    viewpointActorId: playerActorId,
    spanSeconds: 60,
    playerActorIds: [playerActorId],
    deliberation: buildLiveDeliberation(),
    workerId: `sim-turn-${input.chatId}`,
  });
  const clock = await readBranchClock(branchId);
  const rendered = await renderCommittedCut({
    branchId,
    engagementId: scene.engagementId,
    cutId: turn.cut.id,
    conversation: {
      playerUtterance: input.message,
      dialogueTail,
      viewpointIsPlayer: true,
      actorNames,
      calendarStart: clock?.calendarStart ?? null,
    },
  });
  if (rendered.status !== "rendered" || rendered.prose === undefined) {
    return { ok: false, code: "render_withheld", message: "the narrator could not render this turn; try again", status: 503 };
  }

  const assistantMessageId = newId();
  await persistAssistantReply({
    id: assistantMessageId,
    chatId: input.chatId,
    speakerCharacterId: input.speakerCharacterId,
    promptMessageId: userMessageId,
    content: rendered.prose,
    meta: {
      simTurn: true,
      cutId: rendered.cutId,
      modelId: rendered.modelId,
      attempts: rendered.attempts,
      ...(rendered.confirmStatus === undefined ? {} : { confirmStatus: rendered.confirmStatus }),
    },
  });
  return {
    ok: true,
    messageId: assistantMessageId,
    prose: rendered.prose,
    cutId: rendered.cutId,
    modelId: rendered.modelId,
    attempts: rendered.attempts,
    degraded: rendered.degraded,
    diagnostics: rendered.diagnostics,
  };
}
