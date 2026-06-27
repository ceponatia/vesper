import { matchActions, type ActionDefinition } from "@/contracts/actions/registry";
import { diag, type DiagnosticSink } from "@/contracts/diagnostics";
import { applyMeterDrift, crossedThresholdHints, NEUTRAL_MOOD_METER, type MeterDefinition } from "@/contracts/meters/registry";
import { atmosphereMoodBaselineShift, conditionMoodBaselineShift } from "@/contracts/mood";
import { personalizeMeters } from "@/contracts/personality/modulation";
import { FALLBACK_MINUTES_ADVANCED, MAX_MINUTES_ADVANCED, MIN_MINUTES_ADVANCED, REST_CLAMP_MINUTES } from "../../constants";
import { findParticipant } from "../grounding";
import { declaredRestMinutes, detectDeclaredRest } from "../../intent";
import type { PhaseContext } from "../types";
import type { WorkingState } from "../working-state";
import { MAX_METER_ADJUSTMENTS } from "./caps";

/** Clamp simulant minutes to [MIN, MAX]; null/garbage → FALLBACK (clock always advances). */
export function clampMinutes(raw: number | null | undefined, sink?: DiagnosticSink): number {
  if (raw === null || raw === undefined || !Number.isFinite(raw)) return FALLBACK_MINUTES_ADVANCED;
  const rounded = Math.round(raw);
  if (rounded < MIN_MINUTES_ADVANCED || rounded > MAX_MINUTES_ADVANCED) {
    const clamped = Math.min(MAX_MINUTES_ADVANCED, Math.max(MIN_MINUTES_ADVANCED, rounded));
    sink?.push(diag("info", "merge.clock.clamped", `minutesAdvanced ${rounded} clamped to ${clamped}`));
    return clamped;
  }
  return rounded;
}

export function advanceClock(
  input: { clockMinutes: number; minutesAdvanced: number | null | undefined },
  sink?: DiagnosticSink,
): { clockMinutes: number; minutes: number } {
  const minutes = clampMinutes(input.minutesAdvanced, sink);
  return { clockMinutes: input.clockMinutes + minutes, minutes };
}

/** Declared rest gets its own clamp — never less than a minute, never more than REST_CLAMP_MINUTES. */
export function clampRestMinutes(raw: number, sink?: DiagnosticSink): number {
  if (!Number.isFinite(raw)) return FALLBACK_MINUTES_ADVANCED;
  const rounded = Math.round(raw);
  if (rounded < MIN_MINUTES_ADVANCED || rounded > REST_CLAMP_MINUTES) {
    const clamped = Math.min(REST_CLAMP_MINUTES, Math.max(MIN_MINUTES_ADVANCED, rounded));
    sink?.push(diag("info", "merge.clock.rest_clamped", `declared rest ${rounded} clamped to ${clamped}`));
    return clamped;
  }
  return rounded;
}

/**
 * Turn time (docs/developer-notes/time-and-travel-spec.phase3.md): authored
 * components win over the LLM estimate, composed by max — never sum — so
 * overlapping activities are not double-counted. Decision 40: the estimate
 * still participates, so narration that clearly spans longer than a
 * registered action is not undercounted. Declared rest (decision 38) joins
 * the same composition with its own clamp (REST_CLAMP_MINUTES, not 480) —
 * ordinary turns without a rest component are untouched.
 */
export function resolveTurnMinutes(
  input: {
    estimate: number | null | undefined;
    travelMinutes: number;
    actions: readonly ActionDefinition[];
    /** Declared rest ("slept until morning"): minutes pre-wrap, clamped here. */
    rest?: { minutes: number; cause: string } | null;
  },
  sink?: DiagnosticSink,
): { minutes: number; cause: string } {
  const estimate = clampMinutes(input.estimate, sink);
  const longestAction = input.actions.reduce<ActionDefinition | null>(
    (best, a) => (best === null || a.minutes > best.minutes ? a : best),
    null,
  );
  const components: Array<{ minutes: number; cause: string }> = [
    { minutes: estimate, cause: "scene" },
    { minutes: input.travelMinutes, cause: "travel" },
    ...(longestAction ? [{ minutes: longestAction.minutes, cause: longestAction.label.toLowerCase() }] : []),
    ...(input.rest ? [{ minutes: clampRestMinutes(input.rest.minutes, sink), cause: input.rest.cause }] : []),
  ];
  // Last-wins on ties so an authored component beats an equal estimate.
  const winner = components.reduce((best, c) => (c.minutes >= best.minutes ? c : best));
  return { minutes: winner.minutes, cause: winner.cause };
}

/** Deterministic meter effects from registered actions (shower restores hygiene). Agent deltas still apply afterwards and win. */
export function applyActionMeterEffects(
  meters: Record<string, number>,
  actions: readonly ActionDefinition[],
  defs: readonly MeterDefinition[],
  sink?: DiagnosticSink,
  participantName?: string,
): Record<string, number> {
  const known = new Set(defs.map((d) => d.id));
  const next = { ...meters };
  for (const action of actions) {
    for (const effect of action.meterEffects) {
      if (!known.has(effect.meterId)) {
        sink?.push(
          diag("info", "merge.action.unknown_meter", `action "${action.id}" meter effect "${effect.meterId}" skipped (meter disabled or unknown)`, {
            context: { participantName, meterId: effect.meterId },
          }),
        );
        continue;
      }
      if (effect.set !== undefined) {
        next[effect.meterId] = Math.min(1, Math.max(0, effect.set));
      } else if (effect.delta !== undefined) {
        const current = next[effect.meterId] ?? defs.find((d) => d.id === effect.meterId)?.initial ?? 0;
        next[effect.meterId] = Math.min(1, Math.max(0, current + effect.delta));
      }
    }
  }
  return next;
}

export interface MeterAdjustment {
  meterId: string;
  delta: number;
}

/** Agent deltas applied AFTER drift (corrections win over drift), clamped twice. */
export function applyMeterAdjustments(
  meters: Record<string, number>,
  adjustments: readonly MeterAdjustment[],
  defs: readonly MeterDefinition[],
  sink?: DiagnosticSink,
  participantName?: string,
): Record<string, number> {
  const known = new Set(defs.map((d) => d.id));
  const next = { ...meters };
  for (const adj of adjustments) {
    if (!known.has(adj.meterId)) {
      sink?.push(
        diag("warn", "merge.meter.unknown", `unknown meter "${adj.meterId}" dropped`, {
          context: { participantName, meterId: adj.meterId },
        }),
      );
      continue;
    }
    const delta = Number.isFinite(adj.delta) ? Math.max(-1, Math.min(1, adj.delta)) : 0;
    const current = next[adj.meterId] ?? defs.find((d) => d.id === adj.meterId)?.initial ?? 0;
    next[adj.meterId] = Math.min(1, Math.max(0, current + delta));
  }
  return next;
}

// -- Step 4: clock, meters (drift THEN deltas) ------------------------------
export function phaseClockAndMeters(ctx: PhaseContext, state: WorkingState): void {
  const { reconcile, turn, results, simulant, bundle, sink, defs } = ctx;
  // Registered actions: matched in the player's own input only (companion/
  // director turns keep the pure estimate) — docs/developer-notes/time-and-travel-spec.phase3.md.
  const matchedActions = !reconcile && turn.author === "player" ? matchActions(turn.input) : [];
  // Declared rest (decision 38): "I sleep until morning" fast-forwards to a
  // schedule-aware endpoint, clamped to REST_CLAMP_MINUTES inside the clock
  // resolution. World-tick batching across the span is reserved for the
  // offscreen-simulation phase — today the single post-turn schedule tick at
  // the post-rest clock is all that runs (intermediate slots are skipped).
  const declaredRest = !reconcile && turn.author === "player" ? detectDeclaredRest(turn.input) : null;
  const resolved = reconcile
    ? { minutes: 0, cause: "reconcile" }
    : resolveTurnMinutes(
        {
          estimate: results.simulant ? simulant.minutesAdvanced : null,
          travelMinutes: ctx.playerTravelMinutes,
          actions: matchedActions,
          rest: declaredRest ? declaredRestMinutes(declaredRest, ctx.turnStartMinute) : null,
        },
        sink,
      );
  ctx.minutes = resolved.minutes;
  ctx.minutesCause = resolved.cause;
  ctx.clockMinutes = bundle.clockMinutes + ctx.minutes;

  // The active scene's tone (scene-atmosphere.spec §5) shifts the mood baseline of NPCs
  // *in the player's location* — the brief describes that scene.
  const playerLocationId = state.participants.find((p) => p.isUser)?.locationId ?? null;
  // Turn-start mood, captured before drift mutates it — the social reaction reads this
  // for its μ so the narrated hint and the applied delta agree (the §6 key invariant).
  ctx.moodAtTurnStart = new Map(state.participants.map((p) => [p.id, p.state.meters.mood ?? NEUTRAL_MOOD_METER]));
  ctx.hintsBefore = new Map(state.participants.map((p) => [p.id, crossedThresholdHints(p.state.meters, defs)]));

  const adjustmentsByParticipant = new Map<string, MeterAdjustment[]>();
  for (const adj of simulant.meterAdjustments.slice(0, MAX_METER_ADJUSTMENTS)) {
    const participant = findParticipant(adj.participantName, state.participants);
    if (!participant) {
      sink.push(diag("warn", "merge.participant.unresolved", `meter adjustment for "${adj.participantName}" dropped`));
      continue;
    }
    const list = adjustmentsByParticipant.get(participant.id) ?? [];
    list.push({ meterId: adj.meterId, delta: adj.delta });
    adjustmentsByParticipant.set(participant.id, list);
  }

  for (const participant of state.participants) {
    // Per-character drift: traits shift the resting baseline/recovery (spec §4); thresholds
    // and agent adjustments still use the global defs. *Standing* mood influences (mood.spec
    // §5) shift the mood baseline so drift pulls toward an influenced target without
    // compounding a per-turn delta: active conditions (a `hurt` companion settles lower,
    // recovers once it lifts) and the scene atmosphere (a tense room drags a present, low-
    // composure NPC down; composure-damped). Only matter in a real turn.
    const personalized = personalizeMeters(defs, participant.snapshot.traits);
    const coLocatedWithPlayer = playerLocationId !== null && participant.locationId === playerLocationId;
    const moodBaselineShift =
      conditionMoodBaselineShift(participant.state.conditions) +
      (coLocatedWithPlayer ? atmosphereMoodBaselineShift(bundle.brief.atmosphere, participant.snapshot.traits) : 0);
    const driftDefs =
      moodBaselineShift === 0
        ? personalized
        : personalized.map((d) =>
            d.id === "mood"
              ? { ...d, baseline: Math.min(1, Math.max(0, (d.baseline ?? NEUTRAL_MOOD_METER) + moodBaselineShift)) }
              : d,
          );
    const drifted = reconcile
      ? participant.state.meters
      : applyMeterDrift(participant.state.meters, ctx.minutes, driftDefs);
    // Registered-action effects (shower ⇒ hygiene) apply after drift and
    // before agent deltas, so narration-grounded corrections still win.
    const withActionEffects =
      participant.isUser && matchedActions.length > 0
        ? applyActionMeterEffects(drifted, matchedActions, defs, sink, participant.displayName)
        : drifted;
    state.setMeters(
      participant,
      applyMeterAdjustments(
        withActionEffects,
        adjustmentsByParticipant.get(participant.id) ?? [],
        defs,
        sink,
        participant.displayName,
      ),
    );
  }
}
