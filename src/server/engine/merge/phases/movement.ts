import { checkLinkAccess } from "@/contracts/world/access";
import { diag } from "@/contracts/diagnostics";
import { findLink, findParticipant, isAdjacent, linkTravelMinutes } from "../grounding";
import type { PhaseContext } from "../types";
import type { WorkingState } from "../working-state";
import { MAX_MOVEMENTS } from "./caps";

// -- Step 2: movements (validated against the session location graph) --------
// Movement and declared rest both resolve against the turn-START time: the
// player walks through (or is blocked by) the door at the moment they act.
export async function phaseMovements(ctx: PhaseContext, state: WorkingState): Promise<void> {
  const { simulant, turn, bundle, sink, turnStartMinute } = ctx;
  for (const movement of simulant.movements.slice(0, MAX_MOVEMENTS)) {
    const participant = findParticipant(movement.participantName, state.participants);
    if (!participant) {
      sink.push(
        diag("warn", "merge.participant.unresolved", `movement participant "${movement.participantName}" not found`),
      );
      state.recordDrop(`${movement.participantName} did not actually move to ${movement.toLocationName} (unknown character).`);
      continue;
    }
    if (participant.isUser && turn.author !== "player") {
      sink.push(
        diag("warn", "merge.movement.player_not_author", "player movement dropped: the player only moves on player-authored turns"),
      );
      state.recordDrop(`The player did not actually move to ${movement.toLocationName}.`);
      continue;
    }
    const target = await ctx.resolveLocation(movement.toLocationName);
    if (!target) {
      sink.push(diag("warn", "merge.location.unresolved", `movement target "${movement.toLocationName}" not found`));
      state.recordDrop(`${participant.displayName} did not actually move to ${movement.toLocationName} (unknown location).`);
      continue;
    }
    if (target.id === participant.locationId) continue;
    if (!isAdjacent(participant.locationId, target.id, bundle.links)) {
      sink.push(
        diag("warn", "merge.movement.invalid", `movement to non-adjacent location "${target.name}" dropped`, {
          context: { participantName: participant.displayName },
        }),
      );
      state.recordDrop(`${participant.displayName} did not actually move to ${target.name} (not adjacent).`);
      continue;
    }
    // Link access (phase-2-plan T8, player-side only — NPC traversal reuses
    // checkLinkAccess when the drives phase ships). A link with no access
    // field parsed to public at the bundle boundary: today's behavior.
    if (participant.isUser && participant.locationId !== null) {
      const link = findLink(participant.locationId, target.id, bundle.links);
      const door = link?.doorItemId ? (state.items.find((i) => i.id === link.doorItemId)?.state ?? null) : null;
      const verdict = checkLinkAccess({
        access: link?.access ?? { kind: "public" },
        minuteOfDay: turnStartMinute,
        moverParticipantId: participant.id,
        door,
      });
      if (!verdict.passable) {
        sink.push(
          diag("warn", "merge.movement.access_denied", `player movement to "${target.name}" blocked: ${verdict.reason}`, {
            context: { participantName: participant.displayName, toLocationName: target.name, kind: verdict.kind },
          }),
        );
        state.recordDrop(
          `The player did not actually reach ${target.name} — ${verdict.reason}. Narrate the blocked way, not the arrival.`,
        );
        continue;
      }
    }
    if (participant.isUser) {
      ctx.playerTravelMinutes = Math.max(
        ctx.playerTravelMinutes,
        linkTravelMinutes(participant.locationId, target.id, bundle.links),
      );
    }
    state.moveParticipant(participant, target.id);
  }
}
