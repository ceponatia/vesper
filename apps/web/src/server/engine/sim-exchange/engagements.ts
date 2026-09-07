import { simulationHash } from "@vesper/simulation-core/hash";
import { deriveEngagementId, isStandingCoPresentEngagement } from "@vesper/simulation-core/engagements";
import { readDurableEngagements, submitDurableOpenEngagement } from "../simulation";

/**
 * The actor pair's ACTUAL standing scene: any open co-present engagement
 * holding both mapped actors, no matter which chat (or storyteller tool)
 * opened it. One body, one physical scene means a
 * per-chat derived id cannot be trusted to find it — a second chat mapped
 * to the same pair would mint a NEW open command and be refused
 * `participant_already_engaged` forever (the live-session bug). Returns
 * the branch head too, so a miss can mint a head-scoped open command:
 * stable under a same-head race, fresh after an end_scene.
 */
export async function findStandingEngagement(
  branchId: string,
  playerActorId: string,
  primaryActorId: string,
): Promise<{ engagementId: string | null; headSequence: number }> {
  const projection = await readDurableEngagements(branchId);
  const standing = projection.engagements.find((engagement) =>
    isStandingCoPresentEngagement(engagement, playerActorId, primaryActorId),
  );
  return { engagementId: standing?.id ?? null, headSequence: projection.headSequence };
}

/**
 * Find the pair's standing scene or open a fresh one. A refusal carries the
 * public face (code + public reason), never a private cause.
 */
export async function findOrOpenStandingEngagement(input: {
  branchId: string;
  playerActorId: string;
  primaryActorId: string;
  userId: string;
  correlationId: string;
}): Promise<{ ok: true; engagementId: string } | { ok: false; code: string; publicReason: string }> {
  const { branchId, playerActorId, primaryActorId } = input;
  const found = await findStandingEngagement(branchId, playerActorId, primaryActorId);
  if (found.engagementId !== null) return { ok: true, engagementId: found.engagementId };

  const openCommandId = `sim-scene-open-${simulationHash({ branchId, playerActorId, primaryActorId })}-${found.headSequence}`;
  const opened = await submitDurableOpenEngagement(
    {
      id: openCommandId,
      branchId,
      expectedVersion: 0,
      idempotencyKey: openCommandId,
      principal: { kind: "player" as const, principalId: input.userId, controlledActorIds: [playerActorId] },
      submittedAtWallClock: new Date().toISOString(),
      correlationId: input.correlationId,
      type: "open_engagement",
      schemaVersion: 1,
      payload: { participantIds: [playerActorId, primaryActorId].sort(), channel: "co_present" },
    },
    { admitAtLockedVersion: true },
  );
  if (opened.status === "accepted" || (opened.status === "rejected" && opened.code === "duplicate_command_id")) {
    return { ok: true, engagementId: deriveEngagementId(branchId, openCommandId) };
  }
  if (opened.status === "rejected" && opened.code === "participant_already_engaged") {
    // Race: another window opened the pair's scene between our read and this
    // submit — the re-read finds what the claim law just protected.
    const refound = await findStandingEngagement(branchId, playerActorId, primaryActorId);
    if (refound.engagementId !== null) return { ok: true, engagementId: refound.engagementId };
  }
  return opened.status === "rejected"
    ? { ok: false, code: opened.code, publicReason: opened.publicReason }
    : { ok: false, code: "sim_conflict", publicReason: "The world moved; try again." };
}
