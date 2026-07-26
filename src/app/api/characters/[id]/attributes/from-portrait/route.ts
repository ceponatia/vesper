import fs from "node:fs/promises";
import { eq } from "drizzle-orm";
import type { NextRequest } from "next/server";
import { z } from "zod";
import { DiagnosticCollector } from "@/contracts/diagnostics";
import { characterDraftSchema, derivePortraitAttributes } from "@/server/authoring";
import { backpressureRejection, dailyBudgetRejection, jsonError, jsonOk, readBody, withUser } from "@/server/api";
import { db, images } from "@/server/db";
import { absoluteImagePath } from "@/server/images";
import { findOwnedCharacter } from "../../owned";

type Params = { id: string };

const fromPortraitBodySchema = z.object({
  draft: characterDraftSchema,
});

/**
 * Portrait → attributes (character-sheet-forge.plan.md slice 3): a vision
 * model reads the character's canonical avatar and fills in unset appearance
 * attributes on the submitted draft; disagreements with existing values come
 * back as conflict diagnostics. The avatar id comes from the owned character
 * row, never from the client — no reading arbitrary images. Never saves.
 */
export const POST = withUser<Params>(async (user, req: NextRequest, ctx) => {
  const { id } = await ctx.params;
  const body = await readBody(req, fromPortraitBodySchema);
  if (!body.ok) return body.response;
  const character = await findOwnedCharacter(id, user.id);
  if (!character) return jsonError("not_found", "character not found", 404);
  if (!character.avatarImageId) return jsonError("no_avatar", "generate or upload a portrait first", 400);

  const shed = await backpressureRejection("text", user, req);
  if (shed) return shed;
  const overBudget = await dailyBudgetRejection("provider_text_day", user, req);
  if (overBudget) return overBudget;

  const [row] = await db().select().from(images).where(eq(images.id, character.avatarImageId)).limit(1);
  if (!row || row.status !== "ready") return jsonError("no_avatar", "the portrait is not ready yet", 400);
  let data: Uint8Array;
  try {
    data = await fs.readFile(absoluteImagePath(row));
  } catch {
    return jsonError("no_avatar", "the portrait file is missing", 400);
  }

  const sink = new DiagnosticCollector();
  const result = await derivePortraitAttributes({
    draft: body.value.draft,
    image: { data, mediaType: "image/webp" },
    sink,
  });
  // `portrait` is the review dialog's data (followups ruling 2): every
  // disagreement as current → proposed, plus what the reading auto-filled.
  return jsonOk({
    draft: result.draft,
    diagnostics: sink.items,
    portrait: { conflicts: result.conflicts, filled: result.filled },
  });
}, { limit: "forge" });
