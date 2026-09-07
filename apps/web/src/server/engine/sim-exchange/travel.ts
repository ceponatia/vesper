import type { PublicFailurePresentation } from "@vesper/simulation-core/contracts/narrative";
import type { AdmittedCommand } from "@vesper/simulation-core/input-admission";
import type { planDepartureChoreography, SoloDeparture } from "@vesper/simulation-core/departure";
import { computeMoveArrivalTarget } from "@vesper/simulation-core/travel-settle";
import { placeGoPhrase } from "@vesper/simulation-core/world-read";
import { newId } from "@/lib/ids";
import { writeWorldBeat } from "../sim-beats";
import type { CompositionFallbackCollector } from "../composition-diagnostics";
import { log } from "../../log";
import { zoneLabelFromKind } from "../sim-surfaces";
import {
  readDurableSpaceBranch,
  submitDurableEndEngagement,
  submitDurableMoveActor,
  submitDurableMoveTogether,
} from "../simulation";
import { findOrOpenStandingEngagement } from "./engagements";
import { noteDrainDiagnostics, drainBranchTo, moveArrivalTarget, settleStrandedInTransit } from "./time";
import { type ResolvedSimExchange, simLoadWarn } from "./context";
import { admitIntoCoPresentTurn } from "./admission";
import type { SimChatExchangeResult } from "./types";
import { runCoPresentTurn } from "./dialogue";
import { runSimSoloTurn } from "./solo";

/**
 * The graceful-departure choreography behind an admitted natural-language MOVE
 * (the NL twin of the travel chip). The player CHOSE to leave, so:
 *
 * 1. END the standing scene as a CHOICE (`participant_choice`) — the same lawful
 *    two-step `advance_time` performs. An ended scene holds no claim,
 *    so the move that follows fires NO hard interrupt: a parting, not a rupture.
 * 2. submit the move; 3. drain the clock to the journey's expected arrival;
 *    4. leave ONE traveled beat phrased with the parting; 5. render the
 *    goodbye + walk + arrival through the SOLO renderer with a departure context.
 *
 * Degrades per docs/resilience.md — never a dead turn:
 * - the end-engagement step failing unexpectedly falls back to today's interrupt
 *   path (the still-standing scene is interrupted by the accepted move, the
 *   co-present cut renders "set off walking");
 * - a refused/undone move keeps today's behavior (no world change; a plain solo
 *   turn renders — the player is where they were).
 */
export async function runSimDepartureTurn(input: {
  chatId: string;
  userId: string;
  speakerCharacterId: string;
  mode: "send" | "continue" | "open";
  message: string;
  ctx: ResolvedSimExchange;
  command: Extract<AdmittedCommand, { kind: "move" }>;
  zones: { zoneId: string; kind: string }[];
  plan: ReturnType<typeof planDepartureChoreography>;
  sceneEngagementId: string | null;
  dialogueTail: { speaker: string; text: string }[];
  userMessageId: string | null;
  fallbacks?: CompositionFallbackCollector;
}): Promise<SimChatExchangeResult> {
  const { chatId, ctx, command, plan } = input;
  const { branchId, playerActorId, primaryActorId, actorNames, playerName } = ctx;
  const primaryName = actorNames[primaryActorId] ?? "them";
  const zoneKindOf = (zoneId: string): string => input.zones.find((zone) => zone.zoneId === zoneId)?.kind ?? "";
  const toLabel = zoneLabelFromKind(command.toZoneId, zoneKindOf(command.toZoneId));

  const soloArgs = {
    chatId,
    userId: input.userId,
    speakerCharacterId: input.speakerCharacterId,
    mode: input.mode,
    message: input.message,
    narratorInput: false,
    ctx,
    userMessageId: input.userMessageId,
    dialogueTail: input.dialogueTail,
    ...(input.fallbacks ? { fallbacks: input.fallbacks } : {}),
  };

  // The zone the player is leaving (for the departure context). Read once here;
  // The post-drain projection is passed to runSimSoloTurn to place the arrival.
  let fromLabel = "";
  try {
    const preMove = await readDurableSpaceBranch(branchId);
    const fromLocus = preMove.loci.find((locus) => locus.actorId === playerActorId);
    if (fromLocus?.kind === "at") fromLabel = zoneLabelFromKind(fromLocus.zoneId, zoneKindOf(fromLocus.zoneId));
  } catch (error) {
    simLoadWarn(chatId, "departure from-zone read degraded", error);
  }

  const envelopeBase = {
    branchId,
    expectedVersion: 0,
    principal: { kind: "player" as const, principalId: input.userId, controlledActorIds: [playerActorId] },
    submittedAtWallClock: new Date().toISOString(),
    correlationId: `sim-departure-${chatId}`,
    schemaVersion: 1,
  };

  // 1) End the standing scene as a CHOICE. An unexpected failure degrades to
  //    today's interrupt path: the accepted move interrupts the scene and the
  //    co-present cut renders — no farewell framing, no parted beat.
  if (plan.endSceneFirst && input.sceneEngagementId !== null) {
    const endId = newId();
    let ended: Awaited<ReturnType<typeof submitDurableEndEngagement>> | undefined;
    try {
      ended = await submitDurableEndEngagement(
        {
          ...envelopeBase,
          id: endId,
          idempotencyKey: endId,
          type: "end_engagement",
          payload: { engagementId: input.sceneEngagementId, reason: "participant_choice" },
        },
        { admitAtLockedVersion: true },
      );
    } catch (error) {
      simLoadWarn(chatId, "departure end-engagement threw — interrupt fallback", error);
    }
    if (ended?.status !== "accepted") {
      log.warn("engine.sim.departure", "end-engagement not accepted; interrupt fallback", {
        chatId,
        status: ended?.status ?? "threw",
      });
      input.fallbacks?.note({
        site: "departure",
        code: "end_engagement_fallback",
        detail: `end-engagement ${ended?.status ?? "threw"}`,
      });
      const admission = await admitIntoCoPresentTurn(
        { chatId, userId: input.userId, branchId, playerActorId, primaryActorId, playerName, primaryName },
        command,
        input.zones,
      );
      return runCoPresentTurn({
        chatId,
        userId: input.userId,
        speakerCharacterId: input.speakerCharacterId,
        mode: input.mode,
        message: input.message,
        narratorInput: false,
        ctx,
        engagementId: input.sceneEngagementId,
        admission,
        dialogueTail: input.dialogueTail,
        userMessageId: input.userMessageId,
        ...(input.fallbacks ? { fallbacks: input.fallbacks } : {}),
      });
    }
  }

  // 2) Submit the move. A refusal / conflict keeps today's behavior (no world
  //    change) — render a plain solo turn (never a dead turn).
  const moveId = newId();
  let move: Awaited<ReturnType<typeof submitDurableMoveActor>> | undefined;
  try {
    move = await submitDurableMoveActor(
      {
        ...envelopeBase,
        id: moveId,
        idempotencyKey: moveId,
        type: "move_actor",
        payload: { actorId: playerActorId, destinationZoneId: command.toZoneId, travelMode: "walk" },
      },
      { admitAtLockedVersion: true },
    );
  } catch (error) {
    simLoadWarn(chatId, "departure move threw — plain solo render", error);
  }
  if (move?.status !== "accepted") {
    if (move?.status === "rejected") {
      // Unreachable in the starter world when a scene had already been ended
      // above (a standing scene rules out the body claim a walk could refuse, and
      // the two zones are adjacent); render a plain solo turn regardless.
      log.warn("engine.sim.departure", "move not accepted; plain solo render", { chatId, code: move.code });
    }
    input.fallbacks?.note({
      site: "departure",
      code: "move_rejected_solo_render",
      detail: `move ${move?.status ?? "threw"}${move?.status === "rejected" ? ` code=${move.code}` : ""}`,
    });
    return runSimSoloTurn(soloArgs);
  }

  // 3) Walk the player there: drain the clock to the journey's expected arrival
  //    (ruling 20, A7). A divergent drain degrades to the current clock — the arrival
  //    trigger simply settles on a later turn (never a dead turn).
  const target = await moveArrivalTarget(branchId, playerActorId);
  const drain = await drainBranchTo(branchId, target);
  if (!drain.converged) {
    log.warn("engine.sim.departure", "arrival drain did not converge", { chatId, reason: drain.shortReason });
  }
  noteDrainDiagnostics(input.fallbacks, "departure", drain);
  // A7 arrival check: if the player never left transit, record it and escalate a durable job to
  // finish reaching the arrival (recovery, not just a next-turn settle).
  const departureSettled = await readDurableSpaceBranch(branchId);
  await settleStrandedInTransit({
    ...(input.fallbacks ? { fallbacks: input.fallbacks } : {}),
    site: "departure",
    space: departureSettled,
    actorIds: [playerActorId],
    chatId,
  });

  // 4) ONE traveled beat, phrased with the parting when a scene was ended.
  await writeWorldBeat({ chatId, branchId, kind: "traveled", destinationLabel: toLabel, parted: plan.parted });

  // 5) Render the arrival through the solo cut with the departure arc. A departure
  //    turn does NOT advance the clock again (it already drained to the arrival), so
  //    the settled projection just read is exactly what the solo cut would re-read —
  //    thread it in rather than re-materialize the same state.
  const departure: SoloDeparture = {
    ...(plan.farewell ? { farewellFrom: primaryName } : {}),
    fromLabel,
    toLabel,
  };
  return runSimSoloTurn({ ...soloArgs, departure, settledSpace: departureSettled });
}

/**
 * The WALK-WITH-ME choreography, now ONE indivisible
 * action. When the player invites the co-present primary to travel together, the
 * whole decision + world mutation is a single branch-locked `move_together`
 * command (`submitDurableMoveTogether`): the deterministic `decideAccompany`
 * policy re-runs INSIDE the locked authority view (closing the
 * read-vs-commit agency race), and on acceptance ONE transaction commits
 * scene-end (grace), ONE shared journey carrying BOTH actors, ONE
 * departure, and ONE arrival trigger. The pair can no longer be stranded
 * mid-move — "together" is true by construction (one journey, one arrival).
 *
 * After the atomic command this only settles time: drain to the ONE journey's
 * expected arrival (A7), check nobody is stranded, and leave ONE `together` beat.
 *
 * Degradation (docs/resilience.md), never a dead turn:
 * - a DECLINE returns the command's own public face (nobody moves; the scene stands);
 * - a refused player move / not-co-present returns the matching refusal;
 * - a bare version conflict under the lock leaves the world UNCHANGED (the atomic
 *   command has no partial-commit window), so it degrades to an honest `rejected`
 *   (the standing scene is intact) with a C15 note — never a phantom solo travel.
 */
export type AccompanyResult =
  | { status: "accompanied"; toStorySecond: number; arrived: boolean; fromLabel: string; toLabel: string }
  | { status: "declined"; publicReason: string; legalAlternatives: string[] }
  | { status: "rejected"; code: string; publicReason: string; legalAlternatives: string[] }
  | { status: "not_copresent" };

export async function runAccompanyTogether(input: {
  chatId: string;
  userId: string;
  branchId: string;
  playerActorId: string;
  primaryActorId: string;
  primaryName: string;
  toZoneId: string;
  /** C15: collector for surface (b) events rows + the codes stamped on the beat this writes. */
  fallbacks?: CompositionFallbackCollector;
  /**
   * A deterministic `move_together` command id derived from the route request key
   * (idempotency parity with the chip path). The NL choreography omits it and
   * mints a fresh one (it runs under the lock; retry story = "the player sends again").
   */
  commandId?: string;
  /** Deterministic world-beat id (route path); omitted ⇒ a fresh id per NL turn. */
  beatDedupeId?: string;
}): Promise<AccompanyResult> {
  const { chatId, userId, branchId, playerActorId, primaryActorId, toZoneId } = input;

  // Labels for the render + beat. Co-presence and the acceptance policy are
  // re-checked AUTHORITATIVELY inside the locked resolver; this read only names
  // the places (a stale read here can never strand the pair — the command is atomic).
  const preMove = await readDurableSpaceBranch(branchId);
  const kindByZone = new Map<string, string>(preMove.zones.map((zone) => [zone.id, zone.kind]));
  const zoneKindOf = (zoneId: string): string => kindByZone.get(zoneId) ?? "";
  const toLabel = zoneLabelFromKind(toZoneId, zoneKindOf(toZoneId));
  const playerLocus = preMove.loci.find((locus) => locus.actorId === playerActorId);
  const fromLabel =
    playerLocus?.kind === "at" ? zoneLabelFromKind(playerLocus.zoneId, zoneKindOf(playerLocus.zoneId)) : "";

  // ONE atomic command: decide (locked view) + scene-end (grace) + one shared
  // journey (both actors) + one arrival trigger. The player principal
  // controls only the player; the co-traveler is authorized by `decideAccompany`.
  const commandId = input.commandId ?? newId();
  const outcome = await submitDurableMoveTogether(
    {
      id: commandId,
      branchId,
      expectedVersion: 0,
      idempotencyKey: commandId,
      principal: { kind: "player" as const, principalId: userId, controlledActorIds: [playerActorId] },
      submittedAtWallClock: new Date().toISOString(),
      correlationId: `sim-accompany-${chatId}`,
      type: "move_together" as const,
      schemaVersion: 1,
      payload: {
        actorId: playerActorId,
        coTravelerActorId: primaryActorId,
        destinationZoneId: toZoneId,
        travelMode: "walk" as const,
      },
    },
    { admitAtLockedVersion: true },
  );

  if (outcome.status === "rejected") {
    const legalAlternatives = [...outcome.legalAlternativeCommandTypes].map(String).slice(0, 16);
    if (outcome.code === "accompany_declined") {
      return { status: "declined", publicReason: outcome.publicReason, legalAlternatives };
    }
    if (outcome.code === "not_copresent") return { status: "not_copresent" };
    return { status: "rejected", code: outcome.code, publicReason: outcome.publicReason, legalAlternatives };
  }
  if (outcome.status !== "accepted") {
    // A bare version conflict — the world moved under the lock. The atomic command
    // committed NOTHING, so the honest degrade is "nobody moved" (the standing
    // scene is intact), recorded via the existing C15 fallback note.
    input.fallbacks?.note({ site: "accompany", code: "traveled_alone", detail: `move_together ${outcome.status}` });
    return { status: "rejected", code: "sim_conflict", publicReason: "The world moved; try again.", legalAlternatives: [] };
  }

  // Accepted: both are on ONE shared journey. Drain to its expected arrival (A7),
  // then check nobody stranded. (The co-traveler's `primaryName` from `input` is a
  // call-site label only — the resolver read the authoritative name under the lock.)
  const postMove = await readDurableSpaceBranch(branchId);
  const target = computeMoveArrivalTarget(postMove, playerActorId);
  const drain = await drainBranchTo(branchId, target);
  if (!drain.converged) {
    log.warn("engine.sim.accompany", "arrival drain did not converge", { chatId, reason: drain.shortReason });
  }
  noteDrainDiagnostics(input.fallbacks, "accompany", drain);

  // A7 arrival check (read settled ONCE, before the beat, so both actors' in-transit
  // state and `arrived` come from the same read and any still_in_transit code lands
  // on the beat too). Both travelers share the journey — check them together.
  const settled = await readDurableSpaceBranch(branchId);
  await settleStrandedInTransit({
    ...(input.fallbacks ? { fallbacks: input.fallbacks } : {}),
    site: "accompany",
    space: settled,
    actorIds: [playerActorId, primaryActorId],
    chatId,
  });

  // ONE world beat — "together" by construction. C15: stamp any collected codes
  // onto the beat meta (surface a). A route-derived dedupe id makes the beat
  // idempotent under a crash-window retry (A1); the NL path mints a fresh id.
  await writeWorldBeat({
    chatId,
    branchId,
    kind: "traveled",
    destinationLabel: toLabel,
    together: true,
    ...(input.fallbacks && input.fallbacks.codes().length ? { fallbacks: input.fallbacks.codes() } : {}),
    ...(input.beatDedupeId ? { dedupeId: input.beatDedupeId } : {}),
  });

  const arrived = settled.loci.some(
    (locus) => locus.actorId === playerActorId && locus.kind === "at" && locus.zoneId === toZoneId,
  );
  return { status: "accompanied", toStorySecond: target, arrived, fromLabel, toLabel };
}

/**
 * The natural-language twin of the walk-together chip.
 * An admitted ACCOMPANY while co-present runs the shared `runAccompanyTogether`
 * choreography (ONE atomic `move_together`) and then RENDERS:
 * - ACCEPTED ⇒ both walked together (true by construction); co-presence is restored
 *   at the destination, so reopen the scene and render the CO-PRESENT turn with a
 *   travel-context line (you two just walked here together from X) — prose, not a jump-cut;
 * - DECLINED / a refused move ⇒ the scene still stands; render the ordinary
 *   co-present turn with the public face (she answers in character);
 * - an unexpected reopen failure ⇒ the player is where they arrived; render a plain
 *   solo turn (never a dead turn).
 */
export async function runSimAccompanyTurn(input: {
  chatId: string;
  userId: string;
  speakerCharacterId: string;
  mode: "send" | "continue" | "open";
  message: string;
  ctx: ResolvedSimExchange;
  command: Extract<AdmittedCommand, { kind: "accompany" }>;
  zones: { zoneId: string; kind: string }[];
  sceneEngagementId: string;
  dialogueTail: { speaker: string; text: string }[];
  userMessageId: string | null;
  fallbacks?: CompositionFallbackCollector;
}): Promise<SimChatExchangeResult> {
  const { chatId, ctx, command } = input;
  const { branchId, playerActorId, primaryActorId, actorNames, playerName } = ctx;
  const primaryName = actorNames[primaryActorId] ?? "them";

  const outcome = await runAccompanyTogether({
    chatId,
    userId: input.userId,
    branchId,
    playerActorId,
    primaryActorId,
    primaryName,
    toZoneId: command.toZoneId,
    ...(input.fallbacks ? { fallbacks: input.fallbacks } : {}),
  });

  // A decline (or a rare player-move refusal): the scene still stands. Render the
  // co-present turn with the public face — the primary answers the invite in character.
  if (outcome.status === "declined" || outcome.status === "rejected") {
    const failure: PublicFailurePresentation = {
      code: outcome.status === "declined" ? "accompany_declined" : outcome.code,
      publicReason: outcome.publicReason,
      publicEvidence: [],
      legalAlternatives: outcome.legalAlternatives.slice(0, 16),
    };
    return runCoPresentTurn({
      chatId,
      userId: input.userId,
      speakerCharacterId: input.speakerCharacterId,
      mode: input.mode,
      message: input.message,
      narratorInput: false,
      ctx,
      engagementId: input.sceneEngagementId,
      admission: { failure },
      dialogueTail: input.dialogueTail,
      userMessageId: input.userMessageId,
      ...(input.fallbacks ? { fallbacks: input.fallbacks } : {}),
    });
  }

  const soloArgs = {
    chatId,
    userId: input.userId,
    speakerCharacterId: input.speakerCharacterId,
    mode: input.mode,
    message: input.message,
    narratorInput: false,
    ctx,
    userMessageId: input.userMessageId,
    dialogueTail: input.dialogueTail,
    ...(input.fallbacks ? { fallbacks: input.fallbacks } : {}),
  };

  // not_copresent shouldn't reach here (a standing scene implies co-presence), but
  // degrade to a plain solo turn if it does — never a dead turn.
  if (outcome.status === "not_copresent") return runSimSoloTurn(soloArgs);

  const departure: SoloDeparture = { fromLabel: outcome.fromLabel, toLabel: outcome.toLabel };

  // Accepted: co-presence restored at the destination. Reopen the scene there and
  // render the CO-PRESENT turn with a travel-context line so it continues in prose.
  const scene = await findOrOpenStandingEngagement({
    branchId,
    playerActorId,
    primaryActorId,
    userId: input.userId,
    correlationId: `sim-accompany-${chatId}`,
  });
  if (!scene.ok) {
    log.warn("engine.sim.accompany", "co-present scene did not reopen after arrival; solo render", {
      chatId,
      code: scene.code,
    });
    input.fallbacks?.note({ site: "accompany", code: "scene_reopen_failed", detail: `reopen ${scene.code}` });
    return runSimSoloTurn({ ...soloArgs, departure });
  }
  const travelContext = outcome.fromLabel
    ? `${playerName} and ${primaryName} have just walked to ${placeGoPhrase(outcome.toLabel)} together from ${placeGoPhrase(outcome.fromLabel)}, and are here now.`
    : `${playerName} and ${primaryName} have just walked to ${placeGoPhrase(outcome.toLabel)} together, and are here now.`;
  return runCoPresentTurn({
    chatId,
    userId: input.userId,
    speakerCharacterId: input.speakerCharacterId,
    mode: input.mode,
    message: input.message,
    narratorInput: false,
    ctx,
    engagementId: scene.engagementId,
    admission: { executed: travelContext },
    dialogueTail: input.dialogueTail,
    userMessageId: input.userMessageId,
    ...(input.fallbacks ? { fallbacks: input.fallbacks } : {}),
  });
}
