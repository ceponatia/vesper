import fs from "node:fs/promises";
import { eq } from "drizzle-orm";
import { characters, db, images } from "../db";
import { isDemoMode, veniceEditImage, veniceEditModelId } from "../ai";
import { logEvent } from "../events";
import type { DiagnosticSink } from "@/contracts/diagnostics";
import { absoluteImagePath, createImageAsset, failImage, saveImageBuffer, type ImageRow } from "./assets";
import { monogramSvg } from "./monogram";
import { buildVariantInstruction, type VariantKind } from "./prompts";

export interface GenerateVariantInput {
  characterId: string;
  userId: string;
  kind: VariantKind;
  instruction: string;
  sink?: DiagnosticSink;
}

/**
 * Portrait-variant pipeline (docs/images.md): single-reference Venice edit of
 * the canonical avatar, identity-locked. Always re-rolls from the canonical
 * portrait — never chains edits (drift compounds). Failures mark the row
 * failed and return its id.
 */
export async function generateVariant(input: GenerateVariantInput): Promise<string> {
  const demo = isDemoMode();
  const prompt = buildVariantInstruction(input.kind, input.instruction);
  const [character] = await db().select().from(characters).where(eq(characters.id, input.characterId)).limit(1);
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
  try {
    return { row, buffer: await fs.readFile(absoluteImagePath(row)) };
  } catch {
    return null; // file lost — sweepOrphans will fail the row; treat as no reference
  }
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

/** Promotes a ready variant (or avatar) to the character's canonical avatar. */
export async function promoteVariant(characterId: string, imageId: string): Promise<PromoteVariantResult> {
  const [image] = await db().select().from(images).where(eq(images.id, imageId)).limit(1);
  if (!image) return { ok: false, error: "image not found" };
  if (image.status !== "ready") return { ok: false, error: `image status is ${image.status}` };
  if (image.entityKind !== "character" || image.entityId !== characterId) {
    return { ok: false, error: "image does not belong to this character" };
  }
  const updated = await db()
    .update(characters)
    .set({ avatarImageId: imageId })
    .where(eq(characters.id, characterId))
    .returning({ id: characters.id });
  if (updated.length === 0) return { ok: false, error: "character not found" };
  return { ok: true };
}
