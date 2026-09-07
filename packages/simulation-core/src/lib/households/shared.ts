import { composeSimulationId } from "../../contracts/identity";
import { householdsDerivationVersion, type LotLocus } from "../../contracts/households";

export interface HouseholdsBranchMeta {
  worldId: string;
  branchId: string;
  rulesetVersion: string;
  headSequence: number;
  storySecond: number;
}

// ---------------------------------------------------------------------------
// Shared resolver plumbing (mirrors bodies/events.ts / material-condition.ts)
// ---------------------------------------------------------------------------

export interface HouseholdRejection<TCode extends string> {
  ok: false;
  code: TCode;
  publicReason: string;
}

export function rejection<TCode extends string>(code: TCode, publicReason: string): HouseholdRejection<TCode> {
  return { ok: false, code, publicReason };
}

export function isPrivilegedPrincipal(kind: string): boolean {
  return kind === "storyteller" || kind === "system";
}

export interface HouseholdEventCommandContext {
  id: string;
  correlationId: string;
  submittedAtWallClock: string;
}

export function eventEnvelope(
  view: HouseholdsBranchMeta,
  command: HouseholdEventCommandContext,
  sequence: number,
  suffix: string,
) {
  return {
    id: composeSimulationId("event", [view.branchId, command.id, suffix]),
    worldId: view.worldId,
    branchId: view.branchId,
    sequence,
    storySecond: view.storySecond,
    schemaVersion: 1,
    rulesetVersion: view.rulesetVersion,
    derivationVersion: householdsDerivationVersion,
    commandId: command.id,
    correlationId: command.correlationId,
    recordedAtWallClock: command.submittedAtWallClock,
  };
}

/** The registry id(s) a lot locus references, for an event envelope's entity set. */
export function lotLocusEntityIds(locus: LotLocus): string[] {
  switch (locus.kind) {
    case "household":
      return [locus.householdId];
    case "actor":
      return [locus.actorId];
    case "zone":
      return [locus.zoneId];
  }
}

/** Structural locus equality — the `same_locus` no-op defense. */
export function lotLociEqual(left: LotLocus, right: LotLocus): boolean {
  switch (left.kind) {
    case "household":
      return right.kind === "household" && left.householdId === right.householdId;
    case "actor":
      return right.kind === "actor" && left.actorId === right.actorId;
    case "zone":
      return right.kind === "zone" && left.zoneId === right.zoneId;
  }
}
