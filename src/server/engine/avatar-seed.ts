import { z } from "zod";
import { type EmotionLabel, emotionLabelEnum } from "@/contracts";
import { DiagnosticCollector } from "@/contracts/diagnostics";
import { parseOrNull } from "@/lib/parse";
import { seedAvatarExpressions } from "../images";
import { log } from "../log";
import { enqueueJob, registerJobHandler } from "./jobs";

/**
 * The `avatar_seed` job (docs/developer-notes/avatar-3d.plan.md §"Jobs"): generate a
 * character's avatar **expression frames** off the critical path. Runs on the **engine**
 * runner (not route `startJob`) so it gets a heartbeat and the poison-job attempt cap.
 *
 * Detached (`sessionId: null`), so it never gates session readiness. NOTE: the engine's
 * stale-recovery (`recoverStaleJobs`) is session-scoped, so a process death mid-seed can
 * leave a detached row pinned `running` (same as `queueWorldImageGeneration`'s backfill — a
 * pre-existing gap; a global detached-job sweep would close both). This is harmless here
 * because `seedAvatarExpressions` is **idempotent** (deduped + negatively-cached): a later
 * trigger (avatar regen, lazy-gen) simply fills the genuinely-missing frames; the stale row
 * blocks nothing.
 */

const avatarSeedPayloadSchema = z.object({
  characterId: z.string().min(1),
  ownerId: z.string().min(1),
  /** Absent ⇒ the full seed set (seed-at-create); a single label ⇒ lazy-gen on demand. */
  emotions: z.array(emotionLabelEnum).optional(),
});

/** Enqueue an expression-seed job. Seed-at-create passes no emotions (all 11); lazy-gen one. */
export async function enqueueAvatarSeed(characterId: string, ownerId: string, emotions?: readonly EmotionLabel[]): Promise<void> {
  await enqueueJob({
    sessionId: null,
    type: "avatar_seed",
    payload: { characterId, ownerId, ...(emotions ? { emotions } : {}) },
  });
}

registerJobHandler("avatar_seed", async (job) => {
  const payload = parseOrNull(avatarSeedPayloadSchema, job.payload);
  if (!payload) throw new Error("avatar_seed job missing payload");
  const sink = new DiagnosticCollector();
  const result = await seedAvatarExpressions(payload.characterId, payload.ownerId, payload.emotions, sink);
  // No turn/session to carry diagnostics — drain the aggregate to the server log so a
  // half-blank cast is observable (mirrors drainSceneDiagnostics).
  if (result.failed > 0) {
    log.warn("avatar_seed", `seeded ${result.seeded} expression frame(s) with ${result.failed} failure(s)`, {
      characterId: payload.characterId,
      ...result,
    });
  }
});
