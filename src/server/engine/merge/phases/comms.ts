import { diag, type DiagnosticSink } from "@/contracts/diagnostics";
import type { CommsLink } from "@/contracts/state/session-runtime";
import type { SimulantResult } from "@/contracts/turns/agent-results";
import { findParticipant } from "../grounding";
import type { CommsChange, CommsPlanResult, PhaseContext } from "../types";
import type { WorkingParticipant, WorkingState } from "../working-state";
import { MAX_COMMS_EVENTS } from "./caps";

/**
 * Comms link persistence (presence-and-perception-spec §comms). `open` resolves
 * `withName` to a participant and adds/replaces that NPC's link (one link per
 * participant — re-opening replaces in place); `close` removes any link to that
 * participant. Unresolved names drop with a diagnostic. Pure given the resolver.
 */
export function planCommsEvents(
  events: SimulantResult["commsEvents"],
  prior: readonly CommsLink[],
  clockMinutes: number,
  parts: readonly WorkingParticipant[],
  sink?: DiagnosticSink,
): CommsPlanResult {
  const links = prior.map((l) => ({ ...l }));
  const changes: CommsChange[] = [];
  for (const event of events) {
    const target = findParticipant(event.withName, parts);
    if (!target) {
      sink?.push(
        diag("warn", "merge.comms.unresolved", `comms ${event.op} target "${event.withName}" not found`, {
          context: { withName: event.withName, op: event.op, kind: event.kind },
        }),
      );
      continue;
    }
    const idx = links.findIndex((l) => l.withParticipantId === target.id);
    if (event.op === "open") {
      const link: CommsLink = { kind: event.kind, withParticipantId: target.id, since: clockMinutes };
      if (idx >= 0) links[idx] = link;
      else links.push(link);
      changes.push({ op: "open", kind: event.kind, withParticipantId: target.id });
    } else {
      if (idx >= 0) {
        const [removed] = links.splice(idx, 1);
        changes.push({ op: "close", kind: removed?.kind ?? event.kind, withParticipantId: target.id });
      }
      // Closing a link that was never open is a no-op (no diagnostic — benign).
    }
  }
  return { links, changes };
}

// Comms links (presence-spec §comms): persist opens/closes to runtime, log
// per-turn changes. Post_turn only — reconcile leaves the link state alone
// (consistent with affinity/schedule gating).
export function phaseComms(ctx: PhaseContext, state: WorkingState): void {
  const { reconcile, simulant, bundle, clockMinutes, sink } = ctx;
  ctx.comms = reconcile
    ? { links: bundle.runtime.commsLinks, changes: [] as CommsChange[] }
    : planCommsEvents(simulant.commsEvents.slice(0, MAX_COMMS_EVENTS), bundle.runtime.commsLinks, clockMinutes, state.participants, sink);
}
