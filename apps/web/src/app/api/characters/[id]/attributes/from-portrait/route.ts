import fs from "node:fs/promises";
import { eq } from "drizzle-orm";
import type { NextRequest } from "next/server";
import { z } from "zod";
import { DiagnosticCollector } from "@/contracts/diagnostics";
import { characterDraftSchema, derivePortraitAttributes } from "@/server/authoring";
import { backpressureRejection, dailyBudgetRejection, jsonError, jsonOk, readBody, reserveCharacterAuthoringAction, withUser } from "@/server/api";
import { db, images } from "@/server/db";
import { absoluteImagePath } from "@/server/images";
import { findOwnedCharacter } from "../../owned";

type Params = { id: string };

const fromPortraitBodySchema = z.object({
  // Kept optional for a rolling release with an older browser bundle. The
  // server always derives from its own revision-bound snapshot.
  draft: characterDraftSchema.optional(),
  authoringRevision: z.number().int().positive().max(2_147_483_647).optional(),
  imageId: z.string().min(1).optional(),
});

/**
 * Portrait → attributes: a vision model reads the exact portrait displayed by
 * the caller and fills unset appearance attributes on the revision-bound saved
 * draft. The client names the image, then the reservation proves that it is
 * still this owned character's candidate; arbitrary image ids never reach the
 * file read. Disagreements come back as review conflicts. Never saves.
 */
export const POST = withUser<Params>(async (user, req: NextRequest, ctx) => {
  const { id } = await ctx.params;
  const body = await readBody(req, fromPortraitBodySchema);
  if (!body.ok) return body.response;
  const character = await findOwnedCharacter(id, user.id);
  if (!character) return jsonError("not_found", "character not found", 404);
  if (!character.avatarImageId) return jsonError("no_avatar", "generate or upload a portrait first", 400);

  const reservation = await reserveCharacterAuthoringAction({
    characterId: id,
    ownerId: user.id,
    expectedAuthoringRevision: body.value.authoringRevision ?? character.authoringRevision,
    expectedPortraitImageId: body.value.imageId ?? character.avatarImageId,
  });
  if (reservation.status === "not_found") return jsonError("not_found", "character not found", 404);
  if (reservation.status === "authoring_revision_changed") {
    return jsonOk({
      error: {
        code: "authoring_revision_changed",
        message: "The saved character changed. Review the latest saved details, then complete from the portrait again.",
      },
      authoringRevision: reservation.currentRevision,
      avatarImageId: reservation.currentImageId,
    }, 409);
  }
  if (reservation.status === "portrait_changed") {
    return jsonOk({
      error: {
        code: "portrait_changed",
        message: "The displayed portrait changed. Review the new portrait, then complete again.",
      },
      authoringRevision: reservation.currentRevision,
      avatarImageId: reservation.currentImageId,
    }, 409);
  }
  const source = reservation.source;
  const sourceImageId = source.avatarImageId;
  if (!sourceImageId) return jsonError("portrait_changed", "the displayed portrait was removed", 409);
  const sourceDraft = characterDraftSchema.safeParse({
    name: source.name,
    profile: source.profile,
    tags: source.tags,
    suggestedItems: [],
  });
  if (!sourceDraft.success) {
    return jsonError("authoring_state_invalid", "the saved character details need to be repaired before portrait completion", 409);
  }

  const shed = await backpressureRejection("text", user, req);
  if (shed) return shed;
  const overBudget = await dailyBudgetRejection("provider_text_day", user, req);
  if (overBudget) return overBudget;

  const [row] = await db().select().from(images).where(eq(images.id, sourceImageId)).limit(1);
  if (!row || row.status !== "ready") return jsonError("no_avatar", "the portrait is not ready yet", 400);
  let data: Uint8Array;
  try {
    data = await fs.readFile(absoluteImagePath(row));
  } catch {
    return jsonError("no_avatar", "the portrait file is missing", 400);
  }

  const sink = new DiagnosticCollector();
  const result = await derivePortraitAttributes({
    draft: sourceDraft.data,
    image: { data, mediaType: "image/webp" },
    sink,
  });
  // `portrait` is the review dialog's data: every disagreement as
  // current → proposed, plus what the reading auto-filled.
  return jsonOk({
    draft: result.draft,
    diagnostics: sink.items,
    portrait: { conflicts: result.conflicts, filled: result.filled },
    source: { authoringRevision: source.authoringRevision, imageId: sourceImageId },
  });
}, { limit: "forge" });
