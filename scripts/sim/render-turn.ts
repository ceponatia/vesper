import "dotenv/config";
import { deriveEngagementId } from "@/lib/simulation";
import {
  ROLLOUT_ACTORS,
  ROLLOUT_BRANCH_ID,
  prepareEngagementTurn,
  renderCommittedCut,
  seedRolloutTestWorld,
  submitDurableOpenEngagement,
} from "@/server/engine";

/**
 * R2 (engine.rollout.plan.md): one full narrated turn against the internal
 * test world — prepare the turn (deterministic), render the committed cut
 * with the LIVE narrator (Aion 3.0 default; pass --model <id> to override),
 * print prose + metrics. Runs locally or on Fly over SSH. With no API key
 * (demo mode) the render degrades to the deterministic fallback and says so.
 */
async function main() {
  const args = process.argv.slice(2);
  const modelFlag = args.indexOf("--model");
  const modelId = modelFlag === -1 ? undefined : args[modelFlag + 1];

  await seedRolloutTestWorld();
  const openCommandId = "rollout-cmd-open-ana-mara";
  const engagementId = deriveEngagementId(ROLLOUT_BRANCH_ID, openCommandId);
  const opened = await submitDurableOpenEngagement(
    {
      id: openCommandId,
      branchId: ROLLOUT_BRANCH_ID,
      expectedVersion: 0,
      idempotencyKey: openCommandId,
      principal: {
        kind: "player" as const,
        principalId: "rollout-player",
        controlledActorIds: [ROLLOUT_ACTORS.mara],
      },
      submittedAtWallClock: new Date().toISOString(),
      correlationId: "rollout-render-turn",
      type: "open_engagement",
      schemaVersion: 1,
      payload: {
        participantIds: [ROLLOUT_ACTORS.ana, ROLLOUT_ACTORS.mara].sort(),
        channel: "co_present",
      },
    },
    { admitAtLockedVersion: true },
  );
  // duplicate_command_id on a re-run means the scene is already open — fine.
  if (opened.status === "rejected" && opened.code !== "duplicate_command_id") {
    throw new Error(`open_engagement rejected: ${opened.code}`);
  }

  const turn = await prepareEngagementTurn({
    branchId: ROLLOUT_BRANCH_ID,
    engagementId,
    viewpointActorId: ROLLOUT_ACTORS.mara,
    spanSeconds: 60,
    playerActorIds: [ROLLOUT_ACTORS.mara],
    workerId: "rollout-render-turn",
  });

  const started = performance.now();
  const rendered = await renderCommittedCut({
    branchId: ROLLOUT_BRANCH_ID,
    engagementId,
    cutId: turn.cut.id,
    conversation: { viewpointIsPlayer: true },
    ...(modelId === undefined ? {} : { modelId }),
  });
  const wallMs = Math.round(performance.now() - started);

  console.log(
    JSON.stringify(
      {
        status: rendered.status,
        modelId: rendered.modelId,
        provider: rendered.provider,
        attempts: rendered.attempts,
        degraded: rendered.degraded,
        latencyMs: rendered.latencyMs,
        wallMs,
        auditVerdict: rendered.audit?.verdict,
        confirmStatus: rendered.confirmStatus,
        diagnostics: rendered.diagnostics,
        mustEnactCount: turn.cut.mustEnact.length,
        prose: rendered.prose,
      },
      null,
      2,
    ),
  );
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
