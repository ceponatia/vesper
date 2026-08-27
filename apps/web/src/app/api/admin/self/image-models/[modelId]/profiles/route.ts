import type { NextRequest } from "next/server";
import { imageModelProfileCreateRequestSchema } from "@vesper/image-core";
import { jsonError, jsonOk, readBody, withOwnerAdmin } from "@/server/api";
import { createImageModelProfile } from "@/server/images";

type Params = { modelId: string };

/**
 * Add one task profile beneath a registry model. Owner-admin only, beneath
 * `/api/admin/self` — `withOwnerAdmin` fails closed with a hidden 404 anywhere
 * else, so the settings page's client-side gate is UX rather than security.
 *
 * The field shapes are the contract schema's judgment (a 400 from `readBody`
 * naming the field); the rules that need the MODEL — task/operation
 * eligibility, provider-override keys against the probed field list — are the
 * service's, judged against the row as the render path will read it. The
 * duplicate-key and one-default-per-task refusals are pre-checked into
 * sentences; the table's constraints remain the backstop.
 */

export const POST = withOwnerAdmin<Params>(async (_user, req: NextRequest, ctx) => {
  const { modelId } = await ctx.params;
  const body = await readBody(req, imageModelProfileCreateRequestSchema);
  if (!body.ok) return body.response;

  const created = await createImageModelProfile(modelId, body.value);
  if (created.ok) return jsonOk({ profile: created.profile }, 201);
  switch (created.code) {
    case "not_found":
      return jsonError("not_found", created.message, 404);
    case "conflict":
      return jsonError("image_profile.conflict", created.message, 409);
    case "invalid":
      return jsonError("image_profile.invalid", created.message, 400);
  }
});
