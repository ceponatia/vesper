import { z } from "zod";
import { newId } from "@/lib/ids";
import { jsonError, jsonOk, readBody, withUser } from "@/server/api";
import {
  buildLiveDeliberation,
  persistAssistantReply,
  prepareEngagementTurn,
  renderCommittedCut,
  submitDurableOpenEngagement,
} from "@/server/engine";
import { characterChatMessages, db } from "@/server/db";
import { requireSimChat, simPlayerEnvelope } from "../sim-shared";

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
  const gate = await requireSimChat(chatId, user.id);
  if (!gate.ok) return gate.response;
  const { sim } = gate;
  const body = await readBody(req, bodySchema);
  if (!body.ok) return body.response;
  const { branchId, playerActorId, primaryActorId, openCommandId, engagementId } = sim;

  // Find-or-open the standing scene between the mapped pair. The open command
  // id is stable per chat, so a replay is the ordinary duplicate outcome.
  const opened = await submitDurableOpenEngagement(
    {
      ...simPlayerEnvelope(sim, user.id, openCommandId),
      type: "open_engagement",
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
    // The R2 leftover landed: rare, consequential, ambiguous departures may
    // consult one live model call; the deterministic policy remains the
    // fallback on timeout, budget exhaustion, or a malformed reply.
    deliberation: buildLiveDeliberation(),
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
    speakerCharacterId: sim.owned.character.id,
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
