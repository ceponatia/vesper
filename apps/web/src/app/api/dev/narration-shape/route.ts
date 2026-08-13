import { z } from "zod";
import { jsonError, jsonOk, readBody, withRoute } from "@/server/api";
import { NARRATION_LANE_DEFAULTS, NARRATION_SHAPE_IDS, readDevNarrationShape, setDevNarrationShape } from "@/server/engine";

const bodySchema = z.object({ shape: z.enum(NARRATION_SHAPE_IDS).nullable() });

/**
 * Dev-only narration-shape toggle (narrator-prompt-focus.plan.md §1.1). Flips the
 * live narration *shape profile* (`concise_immersive` ↔ `aggressive_concise`) for
 * **both** the session and character-chat lanes without a restart, by setting the
 * in-memory override read by `narrationShapeId(lane)`. Gated exactly like
 * `/api/dev/impersonate` — **404 in production** (security Cluster A1) — so it never
 * ships to players. `shape: null` clears the override, reverting each lane to its
 * resting per-lane default (NARRATION_LANE_DEFAULTS — session concise, chat aggressive,
 * per eval Run 2). Flipping it busts the prefix cache for subsequent turns — intended,
 * and dev-only. Both verbs report the raw global override (`null` ⇒ per-lane defaults)
 * plus those defaults, for the dev UI toggle's display.
 */
const state = () => ({ override: readDevNarrationShape(), laneDefaults: NARRATION_LANE_DEFAULTS });

export const GET = withRoute(async () => {
  if (process.env.NODE_ENV === "production") return jsonError("not_found", "not found", 404);
  return jsonOk(state());
});

export const POST = withRoute(async (req) => {
  if (process.env.NODE_ENV === "production") return jsonError("not_found", "not found", 404);
  const body = await readBody(req, bodySchema);
  if (!body.ok) return body.response;
  setDevNarrationShape(body.value.shape);
  return jsonOk(state());
});
