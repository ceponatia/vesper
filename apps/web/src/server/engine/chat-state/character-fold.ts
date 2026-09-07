import type { ChatState } from "./types";
import {
  splitStateCues,
  tickFamiliarity,
  appendRelationshipSample,
  regardBandForValue,
  deriveExchangeMilestones,
  applyDriveUpdates,
  planInvolvesPlayer,
  appendMilestones,
  type Milestone,
} from "@/contracts";
import { applyChatAttributeOverlays, applyChatTraitOverlays } from "./pulse-rules";
import { appendVoiceExemplar } from "../chat-voice";
import { appendSelfieEntry } from "../chat-selfie";
import type { ChatExtractionResult } from "../chat-memory";
import type { FinalizeChatStateInput } from "./finalize-types";
import type { FinalizationAgents } from "./finalize-agents";
import type { FinalizationNarrative } from "./narrative-fold";

type FoldPrimaryPersonalFieldsInput = Pick<
  FinalizeChatStateInput,
  "driftedState"
  | "sink"
  | "scenario"
>;

export function foldPrimaryPersonalFields(
  input: FoldPrimaryPersonalFieldsInput,
  archivist: ChatExtractionResult,
) {
  // Record the meter bands the narrator saw THIS turn (from the drifted, pre-pulse meters)
  // as next turn's `prevBands`, so an unchanged state never re-fires a "just shifted" beat.
  // Carry the archivist's memory queries for the
  // next turn's RAG recall (drop them on a degraded archivist so stale queries don't linger),
  // and fold any proposed attribute change into the evolving narrative overlays.
  const surfacedCues = splitStateCues(input.driftedState.meters, input.driftedState.surfacedCues).nextBands;
  const attributeOverlays = archivist.value
    ? applyChatAttributeOverlays(input.driftedState.attributeOverlays, archivist.value.attributeChanges, input.sink)
    : input.driftedState.attributeOverlays;
  // Voice-exemplar ring: the archivist's picked in-voice line joins the ≤5 ring
  // (a "" pick / degraded archivist is a no-op via appendVoiceExemplar). Rolls back with the snapshot.
  const voiceExemplars = archivist.value
    ? appendVoiceExemplar(input.driftedState.voiceExemplars, archivist.value.voiceExemplar, input.scenario.clockMinutes)
    : input.driftedState.voiceExemplars;
  // Open loops are full-list-each-time — but a degraded leg emits an empty
  // list that must NOT wipe the standing loops; keep the prior list on degrade. Keyed on
  // the CHARACTER leg specifically: a failed scribe or continuity leg has
  // nothing to say about loops, and must not cost them.
  const openLoops =
    archivist.legs.character || !archivist.value ? input.driftedState.openLoops : archivist.value.openLoops;

  return { surfacedCues, attributeOverlays, voiceExemplars, openLoops };
}

type FoldPrimaryProgressionInput = Pick<
  FinalizeChatStateInput,
  "preExchangeState"
  | "driftedState"
  | "now"
  | "skipPulse"
  | "scenario"
  | "assistantMessageId"
  | "characterName"
  | "playerName"
  | "profile"
  | "sink"
  | "selfie"
>;

export function foldPrimaryProgression(
  input: FoldPrimaryProgressionInput,
  pulse: FinalizationAgents["pulse"],
  archivist: ChatExtractionResult,
  minor: boolean,
  planMerge: FinalizationNarrative["planMerge"],
  planAdvance: FinalizationNarrative["planAdvance"],
) {
  // The familiarity ratchet (owner ruling: moments + time). One trickle tick per
  // exchange (bounded by the acquainted ceiling), plus a moment tick when the
  // archivist recorded durable facts — a real disclosure or shared experience.
  // Both draw from the per-scene budget (`familiaritySceneGain`).
  const preFamiliarity = input.preExchangeState?.familiarity ?? input.driftedState.familiarity;
  let familiarity = pulse.state.familiarity;
  let familiaritySceneGain = pulse.state.familiaritySceneGain;
  const applyTick = (kind: "trickle" | "moment") => {
    const ticked = tickFamiliarity(familiarity, kind, familiaritySceneGain);
    familiaritySceneGain += ticked - familiarity;
    familiarity = ticked;
  };
  applyTick("trickle");
  if ((archivist.value?.facts.length ?? 0) > 0) applyTick("moment");

  // Relationship arc: sample when the exchange moved regard or crossed a
  // band (or it's the first exchange — the sparkline's baseline), and derive the
  // exchange's milestones. When the pulse was skipped (a "go on" beat) or degraded,
  // `lastPulseTrace` is stale/empty — treat the move as zero rather than re-reading it.
  const at = input.now.toISOString();
  const pulseTrace = input.skipPulse || pulse.state.lastPulseTrace.degraded ? null : pulse.state.lastPulseTrace;
  const { relationshipHistory, exchangeMilestones } = foldRelationshipArc({
    history: input.driftedState.relationshipHistory,
    at,
    clockMinutes: input.scenario.clockMinutes,
    messageId: input.assistantMessageId,
    characterName: input.characterName,
    preRegard: input.preExchangeState?.regard ?? input.driftedState.regard,
    postRegard: pulse.state.regard,
    preFamiliarity,
    postFamiliarity: familiarity,
    trace: pulseTrace,
  });
  // Drive movement: fold the archivist's driveUpdates
  // into the runtime set; a degraded archivist keeps the prior drives (the loops
  // rule). Newly-revealed secrets land as `secret_shared` milestones — the spoken
  // reveal itself files as an ordinary extracted fact (ruled: no special wiring).
  const driveResult = archivist.value
    ? applyDriveUpdates(input.driftedState.drives, archivist.value.driveUpdates)
    : { drives: input.driftedState.drives, revealed: [] };
  appendSecretMilestones(exchangeMilestones, driveResult.revealed, {
    at, characterName: input.characterName, messageId: input.assistantMessageId,
  });
  // Plan resolutions land milestones: a kept/missed plan
  // INVOLVING THE PLAYER mints `plan_kept`/`plan_missed` — callback-boosted like
  // `secret_shared`, so "remember our first real date" emerges from the callback system.
  // NPC↔NPC keeps (assume-kept) carry no player milestone (they reach the story as facts).
  for (const kept of planMerge.archivistKept) {
    if (!planInvolvesPlayer(kept, input.playerName)) continue;
    exchangeMilestones.push({ at, kind: "plan_kept", label: `Kept a plan — ${kept.what}`, messageId: input.assistantMessageId });
  }
  for (const missed of planAdvance.justMissed) {
    exchangeMilestones.push({ at, kind: "plan_missed", label: `Missed a plan — ${missed.what}`, messageId: input.assistantMessageId });
  }
  const milestones = appendMilestones(input.driftedState.milestones, exchangeMilestones);
  // Bounded personality evolution (slice 10): apply the archivist's developable-trait
  // nudges ONLY when a relationship milestone landed this exchange (first_exchange is
  // not an arc beat), clamped one band from the authored value. Off-milestone turns and a
  // degraded archivist leave the overlays untouched.
  const milestoneLanded = exchangeMilestones.some((m) => m.kind !== "first_exchange");
  const traitOverlays =
    archivist.value && milestoneLanded
      ? applyChatTraitOverlays(input.profile.traits, input.driftedState.traitOverlays, archivist.value.traitShifts, { minor }, input.sink)
      : input.driftedState.traitOverlays;
  // Selfie send: the pulse read the reply as actually sending
  // a photo AND a deterministic gate armed it. Recording the send here (the cooldown
  // ring) rides the same guarded state write; "another take" rolls it back.
  const selfieKind =
    pulseTrace?.sentPhoto && input.selfie
      ? input.selfie.requested
        ? ("request" as const)
        : input.selfie.offerEligible
          ? ("offer" as const)
          : null
      : null;
  const selfieHistory = selfieKind
    ? appendSelfieEntry(input.driftedState.selfieHistory, { kind: selfieKind, atClockMinutes: input.scenario.clockMinutes })
    : input.driftedState.selfieHistory;
  // "Big moment" (slice 9 auto scenes): a stage crossing or a strong card-driven
  // reaction — not the routine first exchange, which has barely a scene to render.
  const bigMoment = exchangeMilestones.some((m) => m.kind === "stage_up" || m.kind === "stage_down" || m.kind === "strong_reaction");
  return { familiarity, familiaritySceneGain, relationshipHistory, milestones, traitOverlays, selfieHistory, bigMoment, selfieKind, drives: driveResult.drives };
}

/**
 * Shared arc fold. Callers decide whether this exchange participates and supply
 * the actual before/after axes: primary familiarity ticks, member familiarity holds.
 * A missing trace contributes no reaction; it does not suppress a baseline sample.
 */
export function foldRelationshipArc(input: {
  history: ChatState["relationshipHistory"];
  at: string;
  clockMinutes: number;
  messageId: string;
  characterName: string;
  preRegard: number;
  postRegard: number;
  preFamiliarity: number;
  postFamiliarity: number;
  trace: ChatState["lastPulseTrace"] | null;
}) {
  // A row can exist before the first exchange; the empty history is the baseline anchor.
  const firstExchange = input.history.length === 0;
  const moved = input.postRegard !== input.preRegard || input.postFamiliarity !== input.preFamiliarity;
  const relationshipHistory = moved || firstExchange
    ? appendRelationshipSample(input.history, {
        at: input.at,
        clockMinutes: input.clockMinutes,
        regard: input.postRegard,
        band: regardBandForValue(input.postRegard).id,
        familiarity: input.postFamiliarity,
      })
    : input.history;
  const exchangeMilestones = deriveExchangeMilestones({
    at: input.at,
    messageId: input.messageId,
    characterName: input.characterName,
    firstExchange,
    preRegard: input.preRegard,
    postRegard: input.postRegard,
    preFamiliarity: input.preFamiliarity,
    postFamiliarity: input.postFamiliarity,
    regardDelta: input.trace?.regardDelta ?? 0,
    concept: input.trace?.concept ?? null,
  });
  return { relationshipHistory, exchangeMilestones };
}

/** Append revealed-drive milestones after arc milestones, before plan resolutions. */
export function appendSecretMilestones(
  milestones: Milestone[],
  revealed: ReturnType<typeof applyDriveUpdates>["revealed"],
  context: { at: string; characterName: string; messageId: string },
): void {
  for (const revealedDrive of revealed) {
    milestones.push({
      at: context.at,
      kind: "secret_shared",
      label: `${context.characterName} shared a secret — ${revealedDrive.want}`,
      messageId: context.messageId,
    });
  }
}
