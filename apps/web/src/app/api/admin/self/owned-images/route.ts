import type { NextRequest } from "next/server";
import { z } from "zod";
import { jsonError, jsonOk, withOwnerAdmin } from "@/server/api";
import {
  isOwnedImageSourceKind,
  listOwnedImageSources,
  OWNED_IMAGE_SOURCE_DEFAULT_LIMIT,
  OWNED_IMAGE_SOURCE_MAX_LIMIT,
  type OwnedImageSource,
} from "@/server/images";

/**
 * The general owner-scoped image sources listing — what the reusable picker
 * renders. Ready rows only, every kind except the two system-bookkeeping ones,
 * ids and label metadata only — bytes stay behind the authorized image file
 * route.
 */

const limitSchema = z.coerce
  .number()
  .int()
  .min(1)
  .max(OWNED_IMAGE_SOURCE_MAX_LIMIT)
  .catch(OWNED_IMAGE_SOURCE_DEFAULT_LIMIT);

export const GET = withOwnerAdmin(async (user, req: NextRequest) => {
  const params = req.nextUrl.searchParams;

  // A kinds filter is VALIDATED, not silently narrowed: a picker asking for a
  // kind this endpoint will never serve is a client bug, and an empty answer
  // would read as "you have no such images".
  const kindsParam = params.get("kinds");
  const requestedKinds = kindsParam === null ? [] : kindsParam.split(",").map((kind) => kind.trim()).filter(Boolean);
  const unknown = requestedKinds.find((kind) => !isOwnedImageSourceKind(kind));
  if (unknown !== undefined) {
    return jsonError("invalid_kind", `${unknown} is not a listable image kind`, 400);
  }
  const kinds = requestedKinds.filter(isOwnedImageSourceKind);

  const beforeParam = params.get("before");
  const before = beforeParam === null ? undefined : new Date(beforeParam);
  if (before !== undefined && Number.isNaN(before.getTime())) {
    return jsonError("invalid_cursor", "before must be a timestamp", 400);
  }

  // The cursor's tie-break half — the id of the last row the client holds, so
  // rows sharing that row's exact createdAt are not skipped at the boundary.
  // Meaningless alone: an id with no timestamp is not a position in this order.
  const beforeIdParam = params.get("beforeId");
  const beforeId = beforeIdParam === null || beforeIdParam.trim() === "" ? undefined : beforeIdParam.trim();
  if (beforeId !== undefined && before === undefined) {
    return jsonError("invalid_cursor", "beforeId requires before", 400);
  }

  const limit = limitSchema.parse(params.get("limit") ?? undefined);
  const images: OwnedImageSource[] = await listOwnedImageSources(user.id, {
    ...(kinds.length > 0 ? { kinds } : {}),
    limit,
    ...(before ? { before } : {}),
    ...(beforeId !== undefined ? { beforeId } : {}),
  });
  return jsonOk({ images });
});
