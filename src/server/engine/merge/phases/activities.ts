import { diag } from "@/contracts/diagnostics";
import { findParticipant } from "../grounding";
import type { PhaseContext } from "../types";
import type { WorkingState } from "../working-state";
import { MAX_ACTIVITY_UPDATES } from "./caps";

// Activity updates.
export function phaseActivities(ctx: PhaseContext, state: WorkingState): void {
  const { simulant, sink } = ctx;
  for (const update of simulant.activityUpdates.slice(0, MAX_ACTIVITY_UPDATES)) {
    const participant = findParticipant(update.participantName, state.participants);
    if (!participant) {
      sink.push(diag("warn", "merge.participant.unresolved", `activity update for "${update.participantName}" dropped`));
      continue;
    }
    state.setActivity(participant, update.activity, update.posture);
  }
}
