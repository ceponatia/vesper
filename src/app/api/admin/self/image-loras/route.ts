import type { NextRequest } from "next/server";
import { imageLoraCreateRequestSchema } from "@/contracts";
import { jsonOk, readBody, withOwnerAdmin } from "@/server/api";
import { createImageLora, listImageLoras } from "@/server/images";

/**
 * The curated LoRA library's admin surface (image-model-capabilities.spec.md
 * §`image_loras`). Owner-admin only, and only beneath `/api/admin/self` —
 * `withOwnerAdmin` fails closed with a hidden 404 anywhere else, so the client-side
 * gate on the settings page is UX rather than security.
 *
 * GET lists every row. POST adds one. Both the locator's shape and the scale
 * ordering are the contract schema's judgment, not this route's: an invalid save is
 * a 400 from `readBody` naming the offending field, and the table's own check
 * constraints are the backstop beneath that.
 */

export const GET = withOwnerAdmin(async () => {
  return jsonOk({ loras: await listImageLoras() });
});

export const POST = withOwnerAdmin(async (_user, req: NextRequest) => {
  const body = await readBody(req, imageLoraCreateRequestSchema);
  if (!body.ok) return body.response;
  return jsonOk({ lora: await createImageLora(body.value) }, 201);
});
