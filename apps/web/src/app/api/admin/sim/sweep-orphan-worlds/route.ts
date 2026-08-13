import { z } from "zod";
import { jsonOk, readBody, withOwnerAdmin } from "@/server/api";
import { sweepOrphanSimWorlds } from "@/server/engine";

/**
 * The orphan sweeper's maintenance surface (successor-world-lifecycle.plan.md
 * slice 2, owner ruling E20-2). Deliberately a plain admin route called by hand
 * — once at deploy to reclaim the historical leak, and again only if a later
 * dry run shows leaks recurring. No GET (a scan is cheap but the verb here is a
 * write), no cron, and no jobs-seam registration: slice 1 made new leaks
 * unreachable, so a periodic guard would be scheduling for a bug that no longer
 * exists (the plan's resolved-by-lean).
 *
 * `{"dryRun": true}` reports the candidate worlds and deletes nothing — always
 * the first call. The body is required and strict; `{}` runs a real sweep.
 *
 * Not owner-scoped, and that is the point: `sim_worlds` carries no owner column,
 * and an orphan by definition has no chat left to prove ownership through. The
 * gate is therefore the role check — `withOwnerAdmin`, valid only beneath
 * `/api/admin/self`, hidden behind a 404 for everyone else.
 */
const bodySchema = z.object({ dryRun: z.boolean().optional() }).strict();

export const POST = withOwnerAdmin(async (_user, req) => {
  const body = await readBody(req, bodySchema);
  if (!body.ok) return body.response;
  return jsonOk(await sweepOrphanSimWorlds({ dryRun: body.value.dryRun ?? false }));
});
