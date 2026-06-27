import { isConditionExpired, type ActiveCondition } from "@/contracts/conditions/condition";
import { diag, type DiagnosticSink } from "@/contracts/diagnostics";
import type { SimulantResult } from "@/contracts/turns/agent-results";
import { newId } from "@/lib/ids";
import { findParticipant } from "../grounding";
import type { PhaseContext } from "../types";
import type { WorkingState } from "../working-state";
import { MAX_CONDITION_EVENTS } from "./caps";

type ConditionEvent = SimulantResult["conditionEvents"][number];

export function applyConditionEvents(
  conditions: readonly ActiveCondition[],
  events: readonly ConditionEvent[],
  startedAtMinutes: number,
  sink?: DiagnosticSink,
): ActiveCondition[] {
  let next = [...conditions];
  for (const event of events) {
    const labelKey = event.label.trim().toLowerCase();
    if (!labelKey) continue;
    if (event.op === "end") {
      const before = next.length;
      next = next.filter((c) => c.label.trim().toLowerCase() !== labelKey);
      if (next.length === before) {
        sink?.push(
          diag("info", "merge.condition.unmatched", `condition "${event.label}" ended but was not active`, {
            context: { participantName: event.participantName },
          }),
        );
      }
      continue;
    }
    const existing = next.find((c) => c.label.trim().toLowerCase() === labelKey);
    if (existing) {
      // Refresh rather than duplicate.
      next = next.map((c) =>
        c === existing
          ? {
              ...c,
              severity: event.severity ?? c.severity,
              durationMinutes: event.durationMinutes ?? c.durationMinutes,
              promptHint: event.promptHint ?? c.promptHint,
              startedAtMinutes,
            }
          : c,
      );
      continue;
    }
    next.push({
      id: newId(),
      label: event.label,
      severity: event.severity,
      startedAtMinutes,
      durationMinutes: event.durationMinutes,
      source: { kind: "narrative" },
      attributeEffects: [],
      promptHint: event.promptHint,
    });
  }
  return next;
}

export function expireConditions(conditions: readonly ActiveCondition[], clockMinutes: number): ActiveCondition[] {
  return conditions.filter((c) => !isConditionExpired(c, clockMinutes));
}

// Conditions: agent ops first, then duration expiry against the new clock.
export function phaseConditions(ctx: PhaseContext, state: WorkingState): void {
  const { simulant, sink, clockMinutes } = ctx;
  const conditionsByParticipant = new Map<string, ConditionEvent[]>();
  for (const event of simulant.conditionEvents.slice(0, MAX_CONDITION_EVENTS)) {
    const participant = findParticipant(event.participantName, state.participants);
    if (!participant) {
      sink.push(diag("warn", "merge.participant.unresolved", `condition event for "${event.participantName}" dropped`));
      continue;
    }
    const list = conditionsByParticipant.get(participant.id) ?? [];
    list.push(event);
    conditionsByParticipant.set(participant.id, list);
  }
  for (const participant of state.participants) {
    const withOps = applyConditionEvents(
      participant.state.conditions,
      conditionsByParticipant.get(participant.id) ?? [],
      clockMinutes,
      sink,
    );
    state.setConditions(participant, expireConditions(withOps, clockMinutes));
  }
}
