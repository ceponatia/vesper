import { z } from "zod";
import { deriveEngagementId, simulationHash } from "@/lib/simulation";
import { newId } from "@/lib/ids";
import { jsonError, jsonOk, readBody, withUser } from "@/server/api";
import {
  persistAssistantReply,
  prepareEngagementTurn,
  readChatEngineAuthority,
  renderCommittedCut,
  submitDurableOpenEngagement,
} from "@/server/engine";
import { characterChatMessages, db } from "@/server/db";
import { loadOwnedChat } from "../../owned";

type Params = { chatId: string };

/**
 * R3 slice 1 (engine.rollout.plan.md) — the successor turn route. For a chat
 * whose authority is `successor_narrative_view` (or beyond) with a linked
 * branch and actor mapping, one player message becomes one engine turn: the
 * scene engagement is found-or-opened, `prepareEngagementTurn` reconciles due
 * world work through the ruling-1 span, `renderCommittedCut` narrates it
 * live, and the prose lands in the ordinary transcript. The legacy streaming
 * pipeline is untouched — this is a parallel lane, gated per chat.
 */

const bodySchema = z.object({ message: z.string().trim().min(1).max(4_000) }).strict();

export const POST = withUser<Params>(async (user, req, ctx) => {
  const { chatId } = await ctx.params;
  const owned = await loadOwnedChat(chatId, user.id);
  if (!owned) return jsonError("not_found", "chat not found", 404);
  const body = await readBody(req, bodySchema);
  if (!body.ok) return body.response;

  const authority = await readChatEngineAuthority(chatId);
  if (
    !authority ||
    authority.authority === "legacy_chat" ||
    authority.authority === "successor_shadow" ||
    !authority.simBranchId ||
    !authority.simPlayerActorId ||
    !authority.simPrimaryActorId
  ) {
    return jsonError(
      "not_sim_enabled",
      "this chat is not routed to the successor engine (authority + branch + actor mapping required)",
      409,
    );
  }
  const branchId = authority.simBranchId;
  const playerActorId = authority.simPlayerActorId;
  const primaryActorId = authority.simPrimaryActorId;

  // Find-or-open the standing scene between the mapped pair. The open command
  // id is stable per chat, so a replay is the ordinary duplicate outcome.
  const openCommandId = `sim-turn-open-${simulationHash({ chatId, playerActorId, primaryActorId })}`;
  const engagementId = deriveEngagementId(branchId, openCommandId);
  const opened = await submitDurableOpenEngagement(
    {
      id: openCommandId,
      branchId,
      expectedVersion: 0,
      idempotencyKey: openCommandId,
      principal: { kind: "player" as const, principalId: user.id, controlledActorIds: [playerActorId] },
      submittedAtWallClock: new Date().toISOString(),
      correlationId: `sim-turn-${chatId}`,
      type: "open_engagement",
      schemaVersion: 1,
      payload: { participantIds: [playerActorId, primaryActorId].sort(), channel: "co_present" },
    },
    { admitAtLockedVersion: true },
  );
  if (opened.status === "rejected" && opened.code !== "duplicate_command_id") {
    return jsonError("sim_open_failed", `the scene could not open: ${opened.code}`, 409);
  }

  // The player line enters the transcript first, exactly like a legacy send.
  const userMessageId = newId();
  await db().insert(characterChatMessages).values({
    id: userMessageId,
    chatId,
    speakerCharacterId: null,
    role: "user",
    content: body.value.message,
    meta: { simTurn: true },
  });

  const turn = await prepareEngagementTurn({
    branchId,
    engagementId,
    viewpointActorId: playerActorId,
    spanSeconds: 60,
    playerActorIds: [playerActorId],
    workerId: `sim-turn-${chatId}`,
  });
  const rendered = await renderCommittedCut({ branchId, engagementId, cutId: turn.cut.id });

  if (rendered.status !== "rendered" || rendered.prose === undefined) {
    // Ruling 8: the committed advance stands; the render is withheld, the
    // player may retry, and the transcript records no assistant line.
    return jsonError("render_withheld", "the narrator could not render this turn; try again", 503);
  }

  const assistantMessageId = newId();
  await persistAssistantReply({
    id: assistantMessageId,
    chatId,
    speakerCharacterId: owned.character.id,
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

  return jsonOk({
    messageId: assistantMessageId,
    prose: rendered.prose,
    cutId: rendered.cutId,
    modelId: rendered.modelId,
    attempts: rendered.attempts,
    degraded: rendered.degraded,
    diagnostics: rendered.diagnostics,
  });
});
