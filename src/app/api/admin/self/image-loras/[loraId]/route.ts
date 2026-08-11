import type { NextRequest } from "next/server";
import { imageLoraUpdateRequestSchema } from "@/contracts";
import { jsonError, jsonOk, readBody, withOwnerAdmin } from "@/server/api";
import { deleteImageLora, updateImageLora } from "@/server/images";

type Params = { loraId: string };

/**
 * Edit or remove one LoRA library row (image-model-capabilities.spec.md
 * §`image_loras`).
 *
 * The cross-field rules a PATCH can break — a scale triple that goes out of order
 * one field at a time, a locator whose type arrived in an earlier request — are
 * judged by the service against the MERGED row, because this route cannot see the
 * fields the request did not send.
 *
 * Deleting a LoRA that a profile or a lab experiment names is deliberately allowed,
 * on the model registry's precedent: a stored selection is a plain id, and a render
 * that cannot resolve one refuses with `image_lora.unreachable_configuration`
 * rather than quietly sending something else.
 */

export const PATCH = withOwnerAdmin<Params>(async (_user, req: NextRequest, ctx) => {
  const { loraId } = await ctx.params;
  const body = await readBody(req, imageLoraUpdateRequestSchema);
  if (!body.ok) return body.response;

  const updated = await updateImageLora(loraId, body.value);
  if (updated.ok) return jsonOk({ lora: updated.lora });
  return updated.code === "not_found"
    ? jsonError("not_found", updated.message, 404)
    : jsonError("image_lora.invalid", updated.message, 400);
});

export const DELETE = withOwnerAdmin<Params>(async (_user, _req, ctx) => {
  const { loraId } = await ctx.params;
  if (!(await deleteImageLora(loraId))) return jsonError("not_found", "image lora not found", 404);
  return jsonOk({ deleted: true, id: loraId });
});
