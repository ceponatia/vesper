import { and, desc, eq, inArray } from "drizzle-orm";
import { z } from "zod";
import { emptySceneGenState, sceneGenStateSchema, sceneReferenceModeSchema } from "@/contracts";
import { DiagnosticCollector } from "@/contracts/diagnostics";
import { parseOr } from "@/lib/parse";
import { jsonError, jsonOk, readBody, withUser } from "@/server/api";
import { db, jobs, sessions, turns } from "@/server/db";
import { enqueueJob } from "@/server/engine";
import { findOwnedSession } from "../../_shared/access";

type Params = { id: string };

const sceneActionSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("generate") }),
  z.object({ action: z.literal("regenerate") }),
  z.object({
    action: z.literal("setInterval"),
    interval: z.number().int().min(0).max(100),
  }),
  z.object({
    action: z.literal("setReferenceMode"),
    referenceMode: sceneReferenceModeSchema,
  }),
]);

/**
 * POST /api/sessions/:id/scene (docs/images.md §Scene images): manual
 * generate / failed-image regenerate both queue a `scene_image` job (never
 * gates session readiness); setInterval edits the every-N-turns trigger.
 */
export const POST = withUser<Params>(async (user, req, ctx) => {
  const { id } = await ctx.params;
  const body = await readBody(req, sceneActionSchema);
  if (!body.ok) return body.response;
  const session = await findOwnedSession(user.id, id);
  if (!session) return jsonError("not_found", "session not found", 404);

  const sink = new DiagnosticCollector();
  const scene = parseOr(sceneGenStateSchema, session.scene, emptySceneGenState(), sink, "sessions.scene");

  if (body.value.action === "setInterval") {
    const updated = { ...scene, interval: body.value.interval };
    await db().update(sessions).set({ scene: updated }).where(eq(sessions.id, id));
    return jsonOk({ ok: true, scene: updated });
  }

  if (body.value.action === "setReferenceMode") {
    const updated = { ...scene, referenceMode: body.value.referenceMode };
    await db().update(sessions).set({ scene: updated }).where(eq(sessions.id, id));
    return jsonOk({ ok: true, scene: updated });
  }

  // generate / regenerate: one in-flight scene job per session is enough.
  const [existing] = await db()
    .select({ id: jobs.id })
    .from(jobs)
    .where(and(eq(jobs.sessionId, id), eq(jobs.type, "scene_image"), inArray(jobs.status, ["queued", "running"])))
    .limit(1);
  if (existing) return jsonOk({ ok: true, jobId: existing.id, queued: false });

  const [latestTurn] = await db()
    .select({ id: turns.id, number: turns.number })
    .from(turns)
    .where(eq(turns.sessionId, id))
    .orderBy(desc(turns.number))
    .limit(1);

  // Mark the scene "generating" now — before enqueuing, so the worker's later
  // generating→idle/failed transitions can't be overwritten by this write. The
  // client refreshes immediately after this POST; without this the stored status
  // would still read "idle" until the worker picks the job up, so the poll loop
  // never started and the button needed a second press (ideas.md UI #4).
  await db()
    .update(sessions)
    .set({ scene: { ...scene, status: "generating" } })
    .where(eq(sessions.id, id));

  const jobId = await enqueueJob({
    sessionId: id,
    type: "scene_image",
    payload: { turnId: latestTurn?.id, turnNumber: latestTurn?.number },
  });
  return jsonOk({ ok: true, jobId, queued: true }, 202);
});
