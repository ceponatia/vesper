import { affordanceSubjectId } from "../core";
import type { RomanticPermissionEvent } from "./events";

/**
 * Fixture builders for the permission owner's own tests.
 *
 * Deliberately **not** in the barrel — the contact core's `test-support.ts` set
 * the precedent, and a probe grant that reaches production is a permission
 * nobody gave.
 *
 * The default event is the PLAINEST grant: Alex may touch Mara romantically, in
 * one branch, decided by one NPC-side event. A test that wants a withdrawal, a
 * denial, or a reversed direction states the one field it is testing.
 */

export const PROBE_PERMITTED = affordanceSubjectId("alex");
export const PROBE_GRANTOR = affordanceSubjectId("mara");
export const PROBE_BRANCH = "probe_branch";

let probeEventCounter = 0;

/** A fresh event id per call, so multi-event fixtures need not name each one. */
export function nextProbePermissionEventId(): string {
  probeEventCounter += 1;
  return `probe_permission_${probeEventCounter}`;
}

export function probePermissionEvent(overrides: Partial<RomanticPermissionEvent> = {}): RomanticPermissionEvent {
  return {
    eventId: nextProbePermissionEventId(),
    branchId: PROBE_BRANCH,
    permittedActorId: PROBE_PERMITTED,
    grantingTargetId: PROBE_GRANTOR,
    scope: "romantic_touch",
    kind: "granted",
    sourceKind: "npc_decision",
    sourceMessageId: "probe_reply_1",
    storyTime: 100,
    orderInSource: 0,
    ...overrides,
  };
}
