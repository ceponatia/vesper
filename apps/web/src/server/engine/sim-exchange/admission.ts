import type { PublicFailurePresentation } from "@vesper/simulation-core/contracts/narrative";
import { admitPlayerCommand, type AdmittedCommand } from "@vesper/simulation-core/input-admission";
import { newId } from "@/lib/ids";
import { db, simActionDefinitions, simItemHoldings, simItems, simZones } from "@/server/db";
import { and, eq } from "drizzle-orm";
import { writeWorldBeat } from "../sim-beats";
import { zoneLabelFromKind } from "../sim-surfaces";
import { submitDurableMoveActor, submitDurableStartActivity, submitDurableTransferItem } from "../simulation";

export interface AdmissionOutcome {
  /** A one-line world-truth note for the narrator — set iff the command was ACCEPTED. */
  executed?: string;
  /** The public face (code + public reason) — set iff the admitted command was REFUSED. */
  failure?: PublicFailurePresentation;
}

/** One admitted command plus the branch zones (labels a move's destination beat without a re-read). */
interface AdmittedForChat {
  command: AdmittedCommand | null;
  zones: { zoneId: string; kind: string }[];
}

/**
 * Deterministic input admission, MATCH ONLY: read the world's legal
 * surface (held items, zones, actions) and pattern-match the player's prose to at
 * most one typed command. No submit here — the choreography branch in `runSimTurn`
 * decides how to enact it (a move drives the departure choreography; give/rest
 * submit into the co-present turn). Degrades to a null command on any read failure
 * — the exchange must never be worse off for having tried (docs/resilience.md).
 */
export async function admitPlayerCommandForChat(input: {
  branchId: string;
  playerActorId: string;
  message: string;
}): Promise<AdmittedForChat> {
  try {
    const [held, zones, actions] = await Promise.all([
      db()
        .select({ itemId: simItemHoldings.itemId, name: simItems.name })
        .from(simItemHoldings)
        .innerJoin(
          simItems,
          and(eq(simItems.branchId, simItemHoldings.branchId), eq(simItems.itemId, simItemHoldings.itemId)),
        )
        .where(
          and(
            eq(simItemHoldings.branchId, input.branchId),
            eq(simItemHoldings.locusKind, "held"),
            eq(simItemHoldings.actorId, input.playerActorId),
          ),
        ),
      db()
        .select({ zoneId: simZones.zoneId, kind: simZones.kind })
        .from(simZones)
        .where(eq(simZones.branchId, input.branchId)),
      db()
        .select({ actionDefinitionId: simActionDefinitions.actionDefinitionId })
        .from(simActionDefinitions)
        .where(eq(simActionDefinitions.branchId, input.branchId)),
    ]);
    const command = admitPlayerCommand(input.message, {
      heldItems: held,
      zones,
      actionDefinitionIds: actions.map((row) => row.actionDefinitionId),
    });
    return { command, zones };
  } catch {
    return { command: null, zones: [] };
  }
}

/**
 * Submit an admitted command in the CO-PRESENT context (the primary is here to
 * react) and return its public outcome. A committed move — only reached as the
 * departure choreography's interrupt FALLBACK — leaves
 * the same (non-parting) "You walk to …" beat the travel chip writes. Best-effort: a
 * failed submit/beat degrades to no admission (docs/resilience.md).
 */
export async function admitIntoCoPresentTurn(
  input: {
    chatId: string;
    userId: string;
    branchId: string;
    playerActorId: string;
    primaryActorId: string;
    playerName: string;
    primaryName: string;
  },
  command: Exclude<AdmittedCommand, { kind: "accompany" }>,
  zones: { zoneId: string; kind: string }[],
): Promise<AdmissionOutcome> {
  try {
    const outcome = await submitAdmittedCommand(input, command);
    if (command.kind === "move" && outcome.executed !== undefined) {
      const kind = zones.find((zone) => zone.zoneId === command.toZoneId)?.kind ?? "";
      await writeWorldBeat({
        chatId: input.chatId,
        branchId: input.branchId,
        kind: "traveled",
        destinationLabel: zoneLabelFromKind(command.toZoneId, kind),
      });
    }
    return outcome;
  } catch {
    return {};
  }
}

async function submitAdmittedCommand(
  input: { chatId: string; userId: string; branchId: string; playerActorId: string; primaryActorId: string; playerName: string; primaryName: string },
  command: Exclude<AdmittedCommand, { kind: "accompany" }>,
): Promise<AdmissionOutcome> {
  const envelope = {
    id: newId(),
    branchId: input.branchId,
    expectedVersion: 0,
    idempotencyKey: newId(),
    principal: { kind: "player" as const, principalId: input.userId, controlledActorIds: [input.playerActorId] },
    submittedAtWallClock: new Date().toISOString(),
    correlationId: `sim-admission-${input.chatId}`,
    schemaVersion: 1,
  };
  const outcome =
    command.kind === "give_item"
      ? await submitDurableTransferItem(
          {
            ...envelope,
            type: "transfer_item",
            schemaVersion: 2,
            payload: {
              actorId: input.playerActorId,
              itemId: command.itemId,
              fromLocus: { kind: "held", actorId: input.playerActorId },
              toLocus: { kind: "held", actorId: input.primaryActorId },
            },
          },
          { admitAtLockedVersion: true },
        )
      : command.kind === "move"
        ? await submitDurableMoveActor(
            {
              ...envelope,
              type: "move_actor",
              payload: { actorId: input.playerActorId, destinationZoneId: command.toZoneId, travelMode: "walk" },
            },
            { admitAtLockedVersion: true },
          )
        : await submitDurableStartActivity(
            {
              ...envelope,
              type: "start_activity",
              payload: { actorId: input.playerActorId, actionDefinitionId: command.actionDefinitionId },
            },
            { admitAtLockedVersion: true },
          );
  if (outcome.status === "accepted") {
    const executed =
      command.kind === "give_item"
        ? `${input.playerName} handed ${command.itemName} to ${input.primaryName}.`
        : command.kind === "move"
          ? `${input.playerName} set off walking toward the ${command.placeWord}.`
          : `${input.playerName} settled in to ${command.verb}.`;
    return { executed };
  }
  if (outcome.status === "rejected") {
    return {
      failure: {
        code: outcome.code,
        publicReason: outcome.publicReason,
        publicEvidence: [],
        legalAlternatives: [...(outcome.legalAlternativeCommandTypes ?? [])].map(String).slice(0, 16),
      },
    };
  }
  // A version conflict is neither an outcome nor a refusal — stay silent.
  return {};
}
