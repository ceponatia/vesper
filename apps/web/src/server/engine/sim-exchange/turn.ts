import type { AdmittedCommand } from "@vesper/simulation-core/input-admission";
import { planDepartureChoreography } from "@vesper/simulation-core/departure";
import { newId } from "@/lib/ids";
import { characterChatMessages, db } from "@/server/db";
import { CompositionFallbackCollector } from "../composition-diagnostics";
import { findOrOpenStandingEngagement } from "./engagements";
import { type ResolvedSimExchange, loadSimDialogueTail } from "./context";
import { admitPlayerCommandForChat, admitIntoCoPresentTurn } from "./admission";
import type { SimChatExchangeResult } from "./types";
import { runCoPresentTurn } from "./dialogue";
import { runSimDepartureTurn, runSimAccompanyTurn } from "./travel";
import { runSimSoloTurn } from "./solo";

/**
 * The open-engagement rejection codes that mean the primary is genuinely NOT
 * co-present with the player — the trigger for the dual-block SOLO cut.
 * Every OTHER rejection (branch_mismatch, participant_not_found, …) is a
 * real fault and still surfaces the 409. `participant_unavailable` /
 * `participant_already_engaged` (primary present but busy / engaged elsewhere)
 * stay 409 in v1 — the solo vignette's "not here with you" framing would misread
 * a same-zone primary.
 */
const SOLO_CUT_OPEN_CODES = new Set(["participants_not_co_located", "participant_in_transit"]);

/** send / continue / open — a real turn that advances the span and renders a fresh cut. */
export async function runSimTurn(input: {
  chatId: string;
  userId: string;
  speakerCharacterId: string;
  mode: "send" | "continue" | "open";
  message?: string;
  inputMode?: "player" | "narrator";
  ctx: ResolvedSimExchange;
}): Promise<SimChatExchangeResult> {
  const { chatId, ctx } = input;
  const { branchId, playerActorId, primaryActorId, actorNames, playerName } = ctx;
  // C15: one collector per turn, threaded through the choreography. Each degradation site
  // notes it (durable events row now + a public-safe code for the reply meta at persist).
  const fallbacks = new CompositionFallbackCollector(chatId);
  // continue/open carry no utterance (ruling 19) — only a send speaks.
  const message = input.mode === "send" ? (input.message ?? "").trim() : "";
  // A "narrator" send is storyteller steering (not the player-character acting):
  // it skips input admission and reframes the player-turn block (legacy parity).
  const narratorInput = input.mode === "send" && input.inputMode === "narrator";

  // The tail is read BEFORE any insert this turn (a fresh reply doesn't exist yet).
  const dialogueTail = await loadSimDialogueTail(chatId, playerName);

  // send: land the player line first (a later refusal never deletes it). The
  // utterance-free modes insert no user row (ruling 19).
  let userMessageId: string | null = null;
  if (input.mode === "send") {
    userMessageId = newId();
    await db().insert(characterChatMessages).values({
      id: userMessageId,
      chatId,
      speakerCharacterId: null,
      role: "user",
      content: message,
      meta: { simTurn: true, ...(narratorInput ? { inputMode: "narrator" } : {}) },
    });
  }

  const scene = await findOrOpenStandingEngagement({
    branchId,
    playerActorId,
    primaryActorId,
    userId: input.userId,
    correlationId: `sim-turn-${chatId}`,
  });
  // A genuine open fault (not "simply not co-present") still 409s. Otherwise the
  // turn runs — co-present (scene.ok) or the dual-block solo cut (ruling 21).
  if (!scene.ok && !SOLO_CUT_OPEN_CODES.has(scene.code)) {
    return { ok: false, code: "sim_open_failed", message: `the scene could not open: ${scene.publicReason}`, status: 409 };
  }

  // R5 input admission (send only, never in narrator mode): the player's own
  // words may BE a legal command. Pattern-match now (no submit) so the branches
  // below can route it before the scene resolves (a MOVE → the departure
  // choreography; an ACCOMPANY → walk-with-me).
  const admitted =
    input.mode === "send" && !narratorInput && message.length > 0
      ? await admitPlayerCommandForChat({ branchId, playerActorId, message })
      : { command: null, zones: [] };
  const command = admitted.command;

  // Walk-with-me: an admitted ACCOMPANY while the
  // primary is co-present runs the acceptance policy + shared choreography, then
  // renders at the destination (co-presence restored ⇒ the co-present renderer).
  if (command?.kind === "accompany" && scene.ok) {
    return runSimAccompanyTurn({
      chatId,
      userId: input.userId,
      speakerCharacterId: input.speakerCharacterId,
      mode: input.mode,
      message,
      ctx,
      command,
      zones: admitted.zones,
      sceneEngagementId: scene.engagementId,
      dialogueTail,
      userMessageId,
      fallbacks,
    });
  }

  // A chosen DEPARTURE: an admitted MOVE, or an
  // accompany with the partner ABSENT — inviting an absent partner is future work
  // (the remote-invite command family), so it degrades to a plain solo move.
  const departureMove: Extract<AdmittedCommand, { kind: "move" }> | null =
    command?.kind === "move"
      ? command
      : command?.kind === "accompany"
        ? { kind: "move", toZoneId: command.toZoneId, placeWord: command.placeWord }
        : null;
  if (departureMove) {
    return runSimDepartureTurn({
      chatId,
      userId: input.userId,
      speakerCharacterId: input.speakerCharacterId,
      mode: input.mode,
      message,
      ctx,
      command: departureMove,
      zones: admitted.zones,
      plan: planDepartureChoreography({ admittedKind: "move", sceneStands: scene.ok }),
      sceneEngagementId: scene.ok ? scene.engagementId : null,
      dialogueTail,
      userMessageId,
      fallbacks,
    });
  }

  // Not a departure. The primary is NOT co-present ⇒ the dual-block solo cut;
  // give/rest admissions keep today's flow (never submitted from the solo path).
  if (!scene.ok) {
    return runSimSoloTurn({
      chatId,
      userId: input.userId,
      speakerCharacterId: input.speakerCharacterId,
      mode: input.mode,
      message,
      narratorInput,
      ctx,
      userMessageId,
      dialogueTail,
      fallbacks,
    });
  }

  // The primary is co-present. Submit an admitted give/rest (its public outcome
  // reaches the narrator), then render the shared co-present turn.
  const coPresentCommand =
    command?.kind === "give_item" || command?.kind === "start_activity" ? command : null;
  const admission =
    coPresentCommand !== null
      ? await admitIntoCoPresentTurn(
          {
            chatId,
            userId: input.userId,
            branchId,
            playerActorId,
            primaryActorId,
            playerName,
            primaryName: actorNames[primaryActorId] ?? "them",
          },
          coPresentCommand,
          admitted.zones,
        )
      : null;
  return runCoPresentTurn({
    chatId,
    userId: input.userId,
    speakerCharacterId: input.speakerCharacterId,
    mode: input.mode,
    message,
    narratorInput,
    ctx,
    engagementId: scene.engagementId,
    admission,
    dialogueTail,
    userMessageId,
    fallbacks,
  });
}
