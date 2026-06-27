import { diag, type DiagnosticSink } from "@/contracts/diagnostics";
import { pendingCommsSchema, stagedIntentSchema, type StagedIntent } from "@/contracts/state/session-runtime";
import type { SimulantResult } from "@/contracts/turns/agent-results";
import type { DoorState } from "@/contracts/world/access";
import type { CharacterProfile } from "@/contracts/world/profile";
import { minuteOfDay, resolveGameTime } from "@/lib/clock";
import { newId } from "@/lib/ids";
import { parseOrNull } from "@/lib/parse";
import { activeLocationId } from "../../bundle";
import { SCHEDULE_JITTER_MINUTES, STAGED_INTENT_DEFAULT_BUDGET } from "../../constants";
import { findParticipant, resolveSessionLocation } from "../grounding";
import { applyStagedIntents } from "../../movement";
import type { SceneLinkInput } from "../../scene";
import type { PhaseContext } from "../types";
import type { WorkingParticipant, WorkingState } from "../working-state";

export type ScheduleEntry = CharacterProfile["schedule"][number];

/**
 * Schedule entry covering a minute-of-day; windows may wrap past midnight.
 * Entries with a `days` mask only match on those weekdays (absent ⇒ daily).
 */
export function scheduleEntryAt(
  schedule: readonly ScheduleEntry[],
  minute: number,
  weekdayIndex?: number,
): ScheduleEntry | null {
  for (const entry of schedule) {
    if (entry.days && weekdayIndex !== undefined && !entry.days.includes(weekdayIndex)) continue;
    if (entry.startMinute <= entry.endMinute) {
      if (minute >= entry.startMinute && minute < entry.endMinute) return entry;
    } else if (minute >= entry.startMinute || minute < entry.endMinute) {
      return entry;
    }
  }
  return null;
}

/**
 * Seeded daily schedule jitter (decision 33): same character + same day ⇒
 * same offset in [-max, +max], so routines read as life, not clockwork —
 * reproducibly. FNV-1a, dependency-free.
 */
export function scheduleJitter(participantId: string, dayIndex: number, max = SCHEDULE_JITTER_MINUTES): number {
  const text = `${participantId}::${dayIndex}`;
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return ((hash >>> 0) % (2 * max + 1)) - max;
}

export interface ScheduleMoveStagingInput {
  displayName: string;
  fromLocationId: string | null;
  toLocationId: string;
  /** The player's (camera's) location this turn. */
  activeLocationId: string | null;
  locationNameById: ReadonlyMap<string, string>;
}

/**
 * Arrival/departure staging (phase-2-plan T9): when an off-screen schedule
 * tick moves an NPC into or out of the player's location, the next brief
 * carries a line so the narrator stages motivated movement instead of
 * teleportation. Moves elsewhere stage nothing. V1 assumes co-located ⇒
 * perceived — the same interim rule as witnessed_by; the presence phase's
 * witness machinery gates these lines when it ships.
 */
export function scheduleMoveStaging(input: ScheduleMoveStagingInput): { arrival?: string; departure?: string } {
  if (input.activeLocationId === null || input.fromLocationId === input.toLocationId) return {};
  if (input.toLocationId === input.activeLocationId) {
    const from = input.fromLocationId ? input.locationNameById.get(input.fromLocationId) : undefined;
    return { arrival: from ? `${input.displayName} arrived from ${from}.` : `${input.displayName} arrived.` };
  }
  if (input.fromLocationId === input.activeLocationId) {
    const toward = input.locationNameById.get(input.toLocationId);
    return { departure: toward ? `${input.displayName} left toward ${toward}.` : `${input.displayName} left.` };
  }
  return {};
}

/** Did the simulant explicitly move or re-task this participant this turn? */
function simulantTouchedPlacement(
  participant: WorkingParticipant,
  simulant: SimulantResult,
  parts: readonly WorkingParticipant[],
): boolean {
  const moved = simulant.movements.some((m) => findParticipant(m.participantName, parts)?.id === participant.id);
  const reTasked = simulant.activityUpdates.some((u) => findParticipant(u.participantName, parts)?.id === participant.id);
  return moved || reTasked;
}

// Off-screen schedule ticks: never teleport on-screen NPCs, and never
// override an explicit simulant movement/activity from this turn. Ticks
// into/out of the player's location stage arrival/departure lines for the
// next brief (phase-2-plan T9) — co-located ⇒ perceived, interim rule.
// Director-staged off-screen movement (phase-4 npc-movement minimal slice):
// carried across turns, fired beats appended to pendingComms / the next brief.
// Arrivals/departures, fired comms and staged directives accumulate on `state`.
export function phaseScheduleTick(ctx: PhaseContext, state: WorkingState): void {
  const { reconcile, bundle, results, turn, sink, simulant } = ctx;
  if (reconcile) return;
  const player = state.player;
  const activeLoc = player?.locationId ?? activeLocationId({ participants: state.participants, locations: bundle.locations });
  const locationNameById = new Map(bundle.locations.map((l) => [l.id, l.name]));
  const gameTime = resolveGameTime(ctx.clockMinutes, bundle.style.calendarStart);
  const minute = minuteOfDay(gameTime);

  // Staged-intent tick — runs BEFORE the schedule tick so a committed NPC is
  // not yanked back to its routine. The director only decides (proposes the
  // goal); this advances the NPC one hop and fires the on-arrival beat. New
  // intents the director just authored are appended AFTER the advance, so
  // their first hop is next turn (they have to set out).
  const stagedThisTick = new Set<string>();
  const cancelIds = new Set(results.director?.stageMovement?.cancel ?? []);
  const surviving = ctx.stagedIntents.filter((s) => !cancelIds.has(s.id));
  const itemById = new Map(state.items.map((i) => [i.id, i] as const));
  const doorStateForLink = (link: SceneLinkInput): DoorState | null =>
    link.doorItemId ? (itemById.get(link.doorItemId)?.state ?? null) : null;
  const tick = applyStagedIntents({
    intents: surviving,
    locationByParticipant: new Map(state.participants.map((p) => [p.id, p.locationId] as const)),
    knownParticipantIds: new Set(state.participants.map((p) => p.id)),
    links: bundle.links,
    doorStateForLink,
    minuteOfDay: minute,
    turnNumber: turn.number,
    sink,
  });
  for (const move of tick.moves) {
    const p = state.participants.find((x) => x.id === move.participantId);
    if (!p) continue;
    const staged = scheduleMoveStaging({
      displayName: p.displayName,
      fromLocationId: move.fromLocationId,
      toLocationId: move.toLocationId,
      activeLocationId: activeLoc,
      locationNameById,
    });
    if (staged.arrival) state.stageArrival(staged.arrival);
    if (staged.departure) state.stageDeparture(staged.departure);
    state.moveParticipant(p, move.toLocationId);
    // In-transit hop: a "heading toward X" activity keeps the Cast tab honest
    // (no stale clinic activity at a node that isn't the clinic). On the hop
    // that arrives, leave activity to the fired beat / narrator.
    if (!move.reachedDestination) {
      const dest = locationNameById.get(move.destinationLocationId);
      state.setActivity(p, dest ? `heading toward ${dest}` : "on the move");
    }
    stagedThisTick.add(p.id);
  }
  for (const f of tick.fired) {
    stagedThisTick.add(f.participantId);
    if (f.comms) {
      const pc = parseOrNull(
        pendingCommsSchema,
        { fromParticipantId: f.participantId, kind: f.comms.kind, gist: f.comms.gist, urgency: f.comms.urgency },
        sink,
        "merge.movement.pending_comms",
      );
      if (pc) state.fireComms(pc);
    }
    if (f.directive?.trim()) state.stageDirective(f.directive.trim());
  }

  // Open new staged intents from the director's story decision (names → ids).
  const newIntents: StagedIntent[] = [];
  for (const stage of results.director?.stageMovement?.stage ?? []) {
    const npc = findParticipant(stage.npcName, state.participants);
    const dest = resolveSessionLocation(stage.destinationName, bundle.locations);
    if (!npc || npc.isUser || !dest) {
      sink.push(
        diag("warn", "merge.movement.intent_unresolved", `staged movement "${stage.npcName}" → "${stage.destinationName}" dropped`, {
          context: { npcResolved: !!npc, destResolved: !!dest },
        }),
      );
      continue;
    }
    const dup = [...tick.intents, ...newIntents].some(
      (s) => s.participantId === npc.id && s.destinationLocationId === dest.id,
    );
    if (dup) continue;
    const threadId = stage.threadTitle
      ? bundle.runtime.storyThreads.find((t) => t.title.trim().toLowerCase() === stage.threadTitle?.trim().toLowerCase())?.id
      : undefined;
    const parsed = parseOrNull(
      stagedIntentSchema,
      {
        id: newId(),
        participantId: npc.id,
        destinationLocationId: dest.id,
        reason: stage.reason,
        threadId,
        onArrival: { comms: stage.onArrivalComms, directive: stage.onArrivalDirective },
        status: "active",
        openedAtTurn: turn.number,
        expiresInTurns: STAGED_INTENT_DEFAULT_BUDGET,
      },
      sink,
      "merge.movement.intent",
    );
    if (parsed) newIntents.push(parsed);
  }
  ctx.stagedIntents = [...tick.intents, ...newIntents];

  for (const participant of state.participants) {
    if (participant.isUser) continue;
    if (stagedThisTick.has(participant.id)) continue;
    if (participant.locationId !== null && participant.locationId === activeLoc) continue;
    if (state.touchedParticipantIds.has(participant.id) && simulantTouchedPlacement(participant, simulant, state.participants)) continue;
    // Per-character daily jitter: shifting the compared minute by -j makes
    // this character's windows start j minutes late (or early) today.
    const jitter = scheduleJitter(participant.id, gameTime.dayIndex);
    const jitteredMinute = (((minute - jitter) % 1440) + 1440) % 1440;
    const entry = scheduleEntryAt(participant.snapshot.schedule, jitteredMinute, gameTime.weekdayIndex);
    if (!entry) continue;
    const target = resolveSessionLocation(entry.locationName, bundle.locations);
    if (!target) {
      sink.push(
        diag("info", "merge.schedule.unknown_location", `schedule location "${entry.locationName}" not found`, {
          context: { participantName: participant.displayName },
        }),
      );
      continue;
    }
    if (participant.locationId !== target.id) {
      const staged = scheduleMoveStaging({
        displayName: participant.displayName,
        fromLocationId: participant.locationId,
        toLocationId: target.id,
        activeLocationId: activeLoc,
        locationNameById,
      });
      if (staged.arrival) state.stageArrival(staged.arrival);
      if (staged.departure) state.stageDeparture(staged.departure);
      state.moveParticipant(participant, target.id);
    }
    state.setActivity(participant, entry.activity);
  }
}
