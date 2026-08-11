import type { NextRequest } from "next/server";
import { imageLabReviewControlRequestSchema } from "@/contracts";
import { jsonError, jsonOk, readBody, withOwnerAdmin } from "@/server/api";
import { deleteImageLabControl, reviewImageLabControl } from "@/server/images";

type Params = { controlId: string };

/**
 * One Advanced Image Lab control fixture: reviewed, or retired.
 *
 * A fixture that is not this admin's answers the same 404 a nonexistent one
 * does — the service's `(id, owner)` selection is the authorization root, and
 * the route never confirms a foreign image exists — and so does an image that is
 * this admin's but is not a `lab_control`, because a fixtures endpoint addresses
 * fixtures and nothing else.
 */

/**
 * Record the admin's review — the gate the Stage 0 protocol puts in front of
 * every trial that uses a fixture.
 *
 * The note is required by the request schema, because a probe that comes back
 * `ignores_control` has to be able to rule out "the fixture was wrong" before it
 * says anything about the model, and an unreviewed skeleton makes that
 * impossible. `reviewedAt` is the server's own clock, never the request's.
 *
 * A fixture that cannot say what it is — wrong kind, or metadata that no longer
 * parses — is a 400 carrying `control_invalid`, the same reading the probe
 * runner produces when it meets one. The envelope's code is bare; the dotted
 * `image_lab.` spelling of it belongs to the diagnostic sink.
 */
export const PATCH = withOwnerAdmin<Params>(async (user, req: NextRequest, ctx) => {
  const { controlId } = await ctx.params;
  const body = await readBody(req, imageLabReviewControlRequestSchema);
  if (!body.ok) return body.response;

  const result = await reviewImageLabControl(user.id, controlId, body.value.reviewNote);
  if (result === null) return jsonError("not_found", "control fixture not found", 404);
  if (!result.ok) return jsonError(result.refusal.code, result.refusal.message, 400);
  return jsonOk({ control: result.control });
});

/**
 * Retire the fixture. Experiments that cited it stay exactly as they are, minus
 * the pointer: `control_image_id` is `on delete set null`, so a finished
 * experiment keeps its recorded settings, prompt and verdict. Refusing to delete
 * a referenced fixture would make bench equipment unretireable the moment it was
 * used once.
 */
export const DELETE = withOwnerAdmin<Params>(async (user, _req, ctx) => {
  const { controlId } = await ctx.params;
  const deleted = await deleteImageLabControl(user.id, controlId);
  if (!deleted) return jsonError("not_found", "control fixture not found", 404);
  return jsonOk({ ok: true });
});
