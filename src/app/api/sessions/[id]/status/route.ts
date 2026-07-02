import { and, desc, eq, gt, or, sql } from "drizzle-orm";
import { DiagnosticCollector } from "@/contracts/diagnostics";
import { jsonError, jsonOk, withUser } from "@/server/api";
import { agentModelId, narrativeModelId } from "@/server/ai";
import { db, images, jobs, sessions, turns } from "@/server/db";
import { HEARTBEAT_STALE_MS, loadSessionBundle } from "@/server/engine";
import { findOwnedSession } from "../../_shared/access";
import { buildStatusPayload, parseClockDelta, type ClockDelta, type SceneGalleryEntry } from "../../_shared/status-payload";

type Params = { id: string };

const SCENE_GALLERY_LIMIT = 24;

interface SceneImageRow extends SceneGalleryEntry {
  preRestart: boolean;
}

/** Ready scene images, newest first — pre-restart gallery images included. */
async function sceneImages(sessionId: string): Promise<SceneImageRow[]> {
  return db()
    .select({
      id: images.id,
      createdAt: images.createdAt,
      prompt: images.prompt,
      preRestart: sql<boolean>`coalesce(${images.meta} ->> 'preRestart', 'false') = 'true'`,
    })
    .from(images)
    .where(and(eq(images.sessionId, sessionId), eq(images.kind, "scene"), eq(images.status, "ready")))
    .orderBy(desc(images.createdAt))
    .limit(SCENE_GALLERY_LIMIT);
}

/** The latest completed turn's time advance, or null until a merge has written a ready turn. */
async function latestClockDelta(sessionId: string): Promise<ClockDelta | null> {
  const [turn] = await db()
    .select({ agentResults: turns.agentResults })
    .from(turns)
    .where(and(eq(turns.sessionId, sessionId), eq(turns.status, "ready")))
    .orderBy(desc(turns.number))
    .limit(1);
  return turn ? parseClockDelta(turn.agentResults) : null;
}

/**
 * Self-heal a scene-gen state orphaned by a dead runner: "generating" with no
 * live scene_image job (queued, or running with a fresh heartbeat) means the
 * render died with the process — surface "failed" instead of a forever-spinner.
 */
async function reconcileSceneGen(sessionId: string, bundle: { scene: { status: string } }): Promise<void> {
  if (bundle.scene.status !== "generating") return;
  const cutoff = new Date(Date.now() - HEARTBEAT_STALE_MS);
  const [live] = await db()
    .select({ id: jobs.id })
    .from(jobs)
    .where(
      and(
        eq(jobs.sessionId, sessionId),
        eq(jobs.type, "scene_image"),
        or(eq(jobs.status, "queued"), and(eq(jobs.status, "running"), gt(jobs.heartbeatAt, cutoff))),
      ),
    )
    .limit(1);
  if (live) return;
  bundle.scene.status = "failed";
  await db()
    .update(sessions)
    .set({ scene: { ...bundle.scene, status: "failed" } })
    .where(eq(sessions.id, sessionId));
}

/** GET /api/sessions/:id/status — the state sidebar payload (docs/streaming-api.md). */
export const GET = withUser<Params>(async (user, _req, ctx) => {
  const { id } = await ctx.params;
  const session = await findOwnedSession(user.id, id);
  if (!session) return jsonError("not_found", "session not found", 404);

  const sink = new DiagnosticCollector();
  const [bundle, sceneRows, clockDelta] = await Promise.all([
    loadSessionBundle(id, sink),
    sceneImages(id),
    latestClockDelta(id),
  ]);
  if (!bundle) return jsonError("not_found", "session not found", 404);
  await reconcileSceneGen(id, bundle);

  return jsonOk(
    buildStatusPayload(bundle, {
      // The "current" image never reaches back across a restart; the gallery does.
      latestSceneImageId: sceneRows.find((r) => !r.preRestart)?.id ?? null,
      sceneGallery: [...sceneRows].reverse().map(({ id: imageId, createdAt, prompt }) => ({ id: imageId, createdAt, prompt })),
      narrativeModel: narrativeModelId(bundle.world.narrativeModel),
      agentModel: agentModelId(bundle.world.agentModel),
      clockDelta,
    }),
  );
});
