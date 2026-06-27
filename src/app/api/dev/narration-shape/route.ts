import { z } from "zod";
import { jsonError, jsonOk, readBody, withRoute } from "@/server/api";
import { NARRATION_SHAPE_IDS, narrationShapeId, setDevNarrationShape } from "@/server/engine";

const bodySchema = z.object({ shape: z.enum(NARRATION_SHAPE_IDS).nullable() });

/**
 * Dev-only narration-shape toggle (narrator-prompt-focus.plan.md §1.1). Flips the
 * live narration *shape profile* (`concise_immersive` ↔ `aggressive_concise`) for
 * **both** the session and character-chat lanes without a restart, by setting the
 * in-memory override read by `narrationShapeId()`. Gated exactly like
 * `/api/dev/impersonate` — **404 in production** (security Cluster A1) — so it never
 * ships to players. `shape: null` clears the override (revert to the NARRATION_SHAPE
 * env / default). Flipping it busts the prefix cache for subsequent turns — intended,
 * and dev-only. GET reports the active shape (for the dev UI toggle's initial state).
 */
export const GET = withRoute(async () => {
  if (process.env.NODE_ENV === "production") return jsonError("not_found", "not found", 404);
  return jsonOk({ shape: narrationShapeId() });
});

export const POST = withRoute(async (req) => {
  if (process.env.NODE_ENV === "production") return jsonError("not_found", "not found", 404);
  const body = await readBody(req, bodySchema);
  if (!body.ok) return body.response;
  setDevNarrationShape(body.value.shape);
  return jsonOk({ shape: narrationShapeId() });
});
