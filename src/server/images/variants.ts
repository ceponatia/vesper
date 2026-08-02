import { and, eq } from "drizzle-orm";
import { characterProfileSchema, emptyCharacterProfile, resolveAttributes } from "@/contracts";
import { parseOr } from "@/lib/parse";
import { characters, db, images } from "../db";
import { isDemoMode, veniceEditImage, veniceEditModelId } from "../ai";
import { logEvent } from "../events";
import { log } from "@/server/log";
import type { DiagnosticSink } from "@/contracts/diagnostics";
import { createImageAsset, failImage, readImageBytes, saveImageBuffer, type ImageRow } from "./assets";
import { monogramSvg } from "./monogram";
import { apparentAgeAnchor, buildVariantInstruction, type VariantKind } from "./prompts";

export interface GenerateVariantInput {
  characterId: string;
  userId: string;
  kind: VariantKind;
  instruction: string;
  sink?: DiagnosticSink;
}

/**
 * Portrait-variant pipeline (docs/images.md): single-reference Venice edit of
 * the canonical avatar, identity-locked + age-anchored (owner ruling 2026-07-29 —
 * "preserve apparent age" alone preserves the model's over-read and each
 * generation drifts older). Always re-rolls from the canonical portrait — never
 * chains edits (drift compounds). Failures mark the row failed and return its id.
 */
export async function generateVariant(input: GenerateVariantInput): Promise<string> {
  const demo = isDemoMode();
  const [character] = await db().select().from(characters).where(eq(characters.id, input.characterId)).limit(1);
  const profile = parseOr(
    characterProfileSchema,
    character?.profile ?? {},
    emptyCharacterProfile(),
    undefined,
    "characters.profile",
  );
  const ageAnchor = apparentAgeAnchor(character?.name ?? "", resolveAttributes(profile.attributes, []));
  const prompt = buildVariantInstruction(input.kind, input.instruction, ageAnchor);
  const reference = character ? await loadReference(character.avatarImageId) : null;

  const asset = await createImageAsset({
    ownerId: input.userId,
    kind: "portrait_variant",
    entityKind: "character",
    entityId: input.characterId,
    prompt,
    sourceImageId: reference?.row.id,
    meta: {
      variantKind: input.kind,
      demo,
      model: demo ? "demo" : `venice/${veniceEditModelId()}`,
    },
  });

  if (!character) {
    await failImage(asset.id, `character ${input.characterId} not found`);
    return asset.id;
  }

  const started = Date.now();
  if (demo) {
    const saved = await saveImageBuffer(asset.id, monogramSvg(`${character.name} ${input.kind}`), input.sink);
    void logVariant(asset.id, input, saved?.status ?? "failed", started);
    return asset.id;
  }

  if (!reference) {
    await failImage(asset.id, "no ready canonical avatar to use as reference");
    void logVariant(asset.id, input, "failed", started);
    return asset.id;
  }

  const edit = await veniceEditImage({ prompt, reference: reference.buffer });
  if (!edit.ok || !edit.image) {
    await failImage(asset.id, edit.error ?? "venice edit returned no image");
    void logVariant(asset.id, input, "failed", started);
    return asset.id;
  }

  const saved = await saveImageBuffer(asset.id, edit.image, input.sink);
  void logVariant(asset.id, input, saved?.status ?? "failed", started);
  return asset.id;
}

async function loadReference(avatarImageId: string | null): Promise<{ row: ImageRow; buffer: Buffer } | null> {
  if (!avatarImageId) return null;
  const [row] = await db().select().from(images).where(eq(images.id, avatarImageId)).limit(1);
  if (!row || row.status !== "ready") return null;
  const buffer = await readImageBytes(row);
  return buffer ? { row, buffer } : null; // no bytes — sweepOrphans will fail the row; treat as no reference
}

function logVariant(imageId: string, input: GenerateVariantInput, status: string, started: number): Promise<void> {
  return logEvent("image.portrait_variant", {
    imageId,
    characterId: input.characterId,
    kind: input.kind,
    status,
    durationMs: Date.now() - started,
  });
}

export interface PromoteVariantResult {
  ok: boolean;
  error?: string;
}

/**
 * Promotes a ready variant (or avatar) to the character's canonical avatar.
 *
 * Owner-strict in its OWN queries (security-authz.plan.md §Follow-ups item 2):
 * the promote route gates on `findOwnedCharacter` first, but a mutating service
 * must verify ownership itself rather than inherit it from a caller — and must
 * not infer it from `entityKind`/`entityId`, which are unverified metadata with
 * no FK (the S5 shape: pointing an owned image at a foreign PUBLIC entity must
 * buy nothing). Both rows are matched on `ownerId` in the same query as the id,
 * and a foreign row is reported as a plain miss, so a caller cannot use the
 * error to tell "not yours" from "does not exist".
 */
export async function promoteVariant(characterId: string, imageId: string, ownerId: string): Promise<PromoteVariantResult> {
  const [character] = await db()
    .select({ id: characters.id })
    .from(characters)
    .where(and(eq(characters.id, characterId), eq(characters.ownerId, ownerId)))
    .limit(1);
  if (!character) return denyPromotion("images.promote.character_denied", "character not found", characterId, imageId, ownerId);

  const [image] = await db()
    .select()
    .from(images)
    .where(and(eq(images.id, imageId), eq(images.ownerId, ownerId)))
    .limit(1);
  if (!image) return denyPromotion("images.promote.image_denied", "image not found", characterId, imageId, ownerId);
  // Not an authorization miss — an owned image that simply isn't paintable yet.
  if (image.status !== "ready") return { ok: false, error: `image status is ${image.status}` };
  if (image.entityKind !== "character" || image.entityId !== characterId) {
    return denyPromotion("images.promote.entity_mismatch", "image does not belong to this character", characterId, imageId, ownerId);
  }

  const updated = await db()
    .update(characters)
    .set({ avatarImageId: imageId })
    .where(and(eq(characters.id, characterId), eq(characters.ownerId, ownerId)))
    .returning({ id: characters.id });
  if (updated.length === 0) return { ok: false, error: "character not found" };
  return { ok: true };
}

/** Diagnostic for a rejected promotion (docs/resilience.md): logged, never thrown. */
function denyPromotion(
  code: string,
  error: string,
  characterId: string,
  imageId: string,
  ownerId: string,
): PromoteVariantResult {
  log.warn("images", `promote denied: ${error}`, { code, characterId, imageId, ownerId });
  return { ok: false, error };
}
