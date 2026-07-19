import { and, asc, eq, inArray } from "drizzle-orm";
import {
  makeDisclosureCommandSchema,
  makeDisclosureCommandResultSchema,
  type Assertion,
  type Belief,
  type MakeDisclosureCommandResult,
  type MakeDisclosureRejectionCode,
} from "@/contracts/simulation/knowledge";
import { resolveMakeDisclosure } from "@/lib/simulation/knowledge";
import { simAssertions, simBeliefs, simPhysicalLoci, type Db } from "@/server/db";
import {
  advanceLockedBranch,
  appendSimulationEvent,
  runSimulationCommand,
  type LockedBranchView,
} from "./command-runner";
import { assertionFromRow, beliefFromRow } from "./knowledge-recorder";
import type { SimTx } from "./trigger-projector";

/**
 * E4.2 — the §21 disclosure command. Validation and event minting only: the
 * assertion/belief ledgers derive in the shell's `recordCommandKnowledge`
 * step (see `knowledge-recorder`), so the live write path and a fork's replay
 * are one code path by construction.
 */

export interface KnowledgeStoreOptions {
  database?: Db;
  admitAtLockedVersion?: boolean;
}

function rejectedResult(
  commandId: string,
  code: MakeDisclosureRejectionCode,
  publicReason: string,
): MakeDisclosureCommandResult {
  return makeDisclosureCommandResultSchema.parse({
    status: "rejected",
    commandId,
    code,
    publicReason,
    legalAlternativeCommandTypes: [],
  });
}

/** The speaker's strongest live belief in one assertion, if any. */
async function loadSpeakerLiveBelief(
  tx: SimTx,
  branchId: string,
  holderActorId: string,
  assertionId: string,
): Promise<Belief | undefined> {
  const rows = await tx
    .select()
    .from(simBeliefs)
    .where(
      and(
        eq(simBeliefs.branchId, branchId),
        eq(simBeliefs.holderActorId, holderActorId),
        eq(simBeliefs.assertionId, assertionId),
        inArray(simBeliefs.status, ["active", "doubted"]),
      ),
    )
    .orderBy(asc(simBeliefs.beliefId));
  const beliefs = rows.map(beliefFromRow);
  beliefs.sort((left, right) => {
    if (left.confidenceFixedPoint !== right.confidenceFixedPoint) {
      return right.confidenceFixedPoint - left.confidenceFixedPoint;
    }
    return right.believedFrom - left.believedFrom;
  });
  return beliefs[0];
}

/** Speak a claim, relay gossip, or retract — the §21 disclosure command. */
export async function submitDurableMakeDisclosure(
  rawCommand: unknown,
  options: KnowledgeStoreOptions = {},
): Promise<MakeDisclosureCommandResult> {
  return runSimulationCommand({
    rawCommand,
    commandSchema: makeDisclosureCommandSchema,
    resultSchema: makeDisclosureCommandResultSchema,
    invalidResult: () => rejectedResult("invalid", "invalid_command", "That disclosure is invalid."),
    branchUnavailableResult: (commandId) =>
      rejectedResult(commandId, "branch_mismatch", "That world branch is unavailable."),
    duplicateCommandIdResult: (commandId) =>
      rejectedResult(commandId, "duplicate_command_id", "That disclosure has already been submitted."),
    conflictResult: (commandId, currentVersion) =>
      makeDisclosureCommandResultSchema.parse({
        status: "conflict",
        commandId,
        currentVersion,
        retryable: true,
      }),
    database: options.database,
    admitAtLockedVersion: options.admitAtLockedVersion,
    execute: async (tx, branch: LockedBranchView, command) => {
      const actorIds = [command.payload.speakerActorId, ...command.payload.targetActorIds];
      const locusRows = await tx
        .select({
          actorId: simPhysicalLoci.actorId,
          kind: simPhysicalLoci.kind,
          locationId: simPhysicalLoci.locationId,
        })
        .from(simPhysicalLoci)
        .where(and(eq(simPhysicalLoci.branchId, branch.id), inArray(simPhysicalLoci.actorId, actorIds)))
        .orderBy(asc(simPhysicalLoci.actorId));
      const locusByActor = new Map(locusRows.map((row) => [row.actorId, row]));

      const speakerLocus = locusByActor.get(command.payload.speakerActorId);
      const speakerLocationId =
        speakerLocus?.kind === "at" && speakerLocus.locationId !== null
          ? speakerLocus.locationId
          : undefined;
      const missingTargetIds = command.payload.targetActorIds.filter(
        (targetId) => !locusByActor.has(targetId),
      );
      const targetsCoPresent =
        speakerLocationId !== undefined &&
        command.payload.targetActorIds.every((targetId) => {
          const locus = locusByActor.get(targetId);
          return locus?.kind === "at" && locus.locationId === speakerLocationId;
        });

      const content = command.payload.content;
      let referencedAssertion: Assertion | undefined;
      let speakerBelief: Belief | undefined;
      if (content.kind === "relay" || content.kind === "retraction") {
        const [assertionRow] = await tx
          .select()
          .from(simAssertions)
          .where(
            and(eq(simAssertions.branchId, branch.id), eq(simAssertions.assertionId, content.assertionId)),
          )
          .limit(1);
        referencedAssertion = assertionRow ? assertionFromRow(assertionRow) : undefined;
        if (content.kind === "relay" && referencedAssertion) {
          speakerBelief = await loadSpeakerLiveBelief(
            tx,
            branch.id,
            command.payload.speakerActorId,
            referencedAssertion.id,
          );
        }
      }

      const resolution = resolveMakeDisclosure(
        {
          worldId: branch.worldId,
          branchId: branch.id,
          rulesetVersion: branch.rulesetVersion,
          headSequence: branch.headSequence,
          storySecond: branch.storySecond,
          speakerExists: speakerLocus !== undefined,
          missingTargetIds,
          ...(speakerLocationId === undefined ? {} : { speakerLocationId }),
          targetsCoPresent,
          ...(referencedAssertion ? { referencedAssertion } : {}),
          ...(speakerBelief ? { speakerBelief } : {}),
        },
        command,
      );
      if (!resolution.ok) return rejectedResult(command.id, resolution.code, resolution.publicReason);

      await appendSimulationEvent(tx, resolution.event);
      await advanceLockedBranch(tx, branch, resolution.event.sequence);

      return {
        status: "accepted",
        commandId: command.id,
        branchVersion: branch.version + 1,
        firstSequence: resolution.event.sequence,
        lastSequence: resolution.event.sequence,
        eventIds: [resolution.event.id],
      };
    },
  });
}

// ---------------------------------------------------------------------------
// Knowledge-gate reads (the E3.3 commitment gate's E4.2 members)
// ---------------------------------------------------------------------------

/** Whether an actor holds a live (active | doubted) belief in one assertion. */
export async function holdsLiveBeliefInAssertion(
  tx: SimTx,
  input: { branchId: string; holderActorId: string; assertionId: string },
): Promise<boolean> {
  const [row] = await tx
    .select({ beliefId: simBeliefs.beliefId })
    .from(simBeliefs)
    .where(
      and(
        eq(simBeliefs.branchId, input.branchId),
        eq(simBeliefs.holderActorId, input.holderActorId),
        eq(simBeliefs.assertionId, input.assertionId),
        inArray(simBeliefs.status, ["active", "doubted"]),
      ),
    )
    .limit(1);
  return row !== undefined;
}

/** Whether one belief row exists, is live, and belongs to the named actor. */
export async function isLiveBeliefHeldBy(
  tx: SimTx,
  input: { branchId: string; beliefId: string; holderActorId: string },
): Promise<boolean> {
  const [row] = await tx
    .select({ beliefId: simBeliefs.beliefId })
    .from(simBeliefs)
    .where(
      and(
        eq(simBeliefs.branchId, input.branchId),
        eq(simBeliefs.beliefId, input.beliefId),
        eq(simBeliefs.holderActorId, input.holderActorId),
        inArray(simBeliefs.status, ["active", "doubted"]),
      ),
    )
    .limit(1);
  return row !== undefined;
}
