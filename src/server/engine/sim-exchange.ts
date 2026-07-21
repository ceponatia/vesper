import { simulationHash } from "@/lib/simulation/hash";
import { deriveEngagementId } from "@/lib/simulation/engagements";
import { newId } from "@/lib/ids";
import { characterChatMessages, db, simCharacters } from "@/server/db";
import { desc, eq } from "drizzle-orm";
import { readChatEngineAuthority } from "./chat-authority";
import { persistAssistantReply } from "./chat-pipeline";
import { buildLiveDeliberation, renderCommittedCut } from "./sim-narrator";
import { prepareEngagementTurn, submitDurableOpenEngagement } from "./simulation";

/**
 * R3 admission wiring (engine.rollout.plan.md) — one player message becomes
 * one successor turn: the shared core behind BOTH the explicit
 * `/sim-turn` route and the ordinary chat send path (which routes here when
 * the chat's authority flag says so — the wiring R1 deferred "until a
 * successor leg exists to route to"; it does now). The legacy pipeline is
 * still never imported from here and vice versa — the lanes meet only at
 * the route fork.
 */

/** The standing scene's stable identity for one chat's mapped actor pair. */
export function simSceneIds(chatId: string, branchId: string, playerActorId: string, primaryActorId: string) {
  const openCommandId = `sim-turn-open-${simulationHash({ chatId, playerActorId, primaryActorId })}`;
  return { openCommandId, engagementId: deriveEngagementId(branchId, openCommandId) };
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
 * authority flag, find-or-open the standing scene, land the player line in
 * the transcript, prepare the turn (live deliberation included), render the
 * committed cut, persist the prose as the ordinary assistant message. A
 * withheld render leaves no assistant line — ruling 8.
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
  const { openCommandId, engagementId } = simSceneIds(input.chatId, branchId, playerActorId, primaryActorId);

  const opened = await submitDurableOpenEngagement(
    {
      id: openCommandId,
      branchId,
      expectedVersion: 0,
      idempotencyKey: openCommandId,
      principal: { kind: "player" as const, principalId: input.userId, controlledActorIds: [playerActorId] },
      submittedAtWallClock: new Date().toISOString(),
      correlationId: `sim-turn-${input.chatId}`,
      type: "open_engagement",
      schemaVersion: 1,
      payload: { participantIds: [playerActorId, primaryActorId].sort(), channel: "co_present" },
    },
    { admitAtLockedVersion: true },
  );
  if (opened.status === "rejected" && opened.code !== "duplicate_command_id") {
    return { ok: false, code: "sim_open_failed", message: `the scene could not open: ${opened.code}`, status: 409 };
  }

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

  const turn = await prepareEngagementTurn({
    branchId,
    engagementId,
    viewpointActorId: playerActorId,
    spanSeconds: 60,
    playerActorIds: [playerActorId],
    deliberation: buildLiveDeliberation(),
    workerId: `sim-turn-${input.chatId}`,
  });
  const rendered = await renderCommittedCut({
    branchId,
    engagementId,
    cutId: turn.cut.id,
    conversation: { playerUtterance: input.message, dialogueTail, viewpointIsPlayer: true, actorNames },
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
