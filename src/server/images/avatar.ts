import { generateImage } from "ai";
import { and, eq, inArray } from "drizzle-orm";
import { z } from "zod";
import { characters, db, items } from "../db";
import { imageModel, imageModelId, isDemoMode } from "../ai";
import { logEvent } from "../events";
import { parseOr } from "@/lib/parse";
import { characterProfileSchema, emptyCharacterProfile } from "@/contracts/world/profile";
import { diag, type DiagnosticSink } from "@/contracts/diagnostics";
import { createImageAsset, failImage, saveImageBuffer } from "./assets";
import { monogramSvg } from "./monogram";
import { buildAvatarPrompt, visibleAvatarOutfit, type AvatarOutfitItem, type AvatarStyle } from "./prompts";

export interface GenerateAvatarInput {
  characterId: string;
  userId: string;
  style?: AvatarStyle;
  sink?: DiagnosticSink;
}

/**
 * Avatar pipeline (docs/images.md): registry prompt → OpenRouter image model
 * (3:4), monogram in demo mode. Generation failure marks the row failed and
 * returns its id — callers poll the row, never catch.
 */
export async function generateAvatar(input: GenerateAvatarInput): Promise<string> {
  const style = input.style ?? "realistic";
  const demo = isDemoMode();
  const [character] = await db().select().from(characters).where(eq(characters.id, input.characterId)).limit(1);
  const profile = parseOr(
    characterProfileSchema,
    character?.profile ?? {},
    emptyCharacterProfile(),
    input.sink,
    "characters.profile",
  );
  const outfit = character ? await loadDefaultOutfit(input.userId, profile.defaultOutfit, input.sink) : [];
  const prompt = character ? buildAvatarPrompt(character.name, profile, style, outfit) : "";

  const asset = await createImageAsset({
    ownerId: input.userId,
    kind: "avatar",
    entityKind: "character",
    entityId: input.characterId,
    prompt,
    meta: { style, model: demo ? "demo" : imageModelId(), demo },
  });

  if (!character) {
    await failImage(asset.id, `character ${input.characterId} not found`);
    return asset.id;
  }

  const started = Date.now();
  try {
    const buffer = demo ? monogramSvg(character.name) : await generateAvatarBuffer(prompt);
    const saved = await saveImageBuffer(asset.id, buffer, input.sink);
    if (saved?.status === "ready") {
      await db().update(characters).set({ avatarImageId: asset.id }).where(eq(characters.id, input.characterId));
    }
    void logEvent(null, "image.avatar", {
      imageId: asset.id,
      characterId: input.characterId,
      status: saved?.status ?? "failed",
      demo,
      durationMs: Date.now() - started,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await failImage(asset.id, message);
    void logEvent(null, "image.avatar", {
      imageId: asset.id,
      characterId: input.characterId,
      status: "failed",
      error: message.slice(0, 300),
    });
  }
  return asset.id;
}

const outfitExtrasSchema = z.object({
  coverage: z.array(z.string()).catch([]),
  layer: z
    .union([z.literal(0), z.literal(1), z.literal(2), z.literal(3)])
    .optional()
    .catch(undefined),
  opacity: z.enum(["opaque", "sheer"]).catch("opaque"),
  sensory: z.object({ appearance: z.string().optional() }).optional().catch(undefined),
});

/**
 * The character's default outfit (library items, profile order), filtered to
 * what is actually visible (visibleAvatarOutfit) — hidden under-layers never
 * reach the image model. A failed lookup degrades to no outfit lines with a
 * warn diagnostic (`images.avatar.outfit_load_failed`); the avatar still
 * generates. Exported for the degradation test.
 */
export async function loadDefaultOutfit(
  ownerId: string,
  itemIds: readonly string[],
  sink?: DiagnosticSink,
): Promise<AvatarOutfitItem[]> {
  if (itemIds.length === 0) return [];
  try {
    const rows = await db()
      .select({ id: items.id, name: items.name, definition: items.definition })
      .from(items)
      .where(and(eq(items.ownerId, ownerId), inArray(items.id, [...itemIds])));
    const byId = new Map(rows.map((row) => [row.id, row]));
    const wardrobe = itemIds.flatMap((id) => {
      const row = byId.get(id);
      if (!row) return [];
      const parsed = outfitExtrasSchema.safeParse(row.definition ?? {});
      const extras = parsed.success ? parsed.data : outfitExtrasSchema.parse({});
      return [
        {
          name: row.name,
          coverage: extras.coverage,
          layer: extras.layer,
          opacity: extras.opacity,
          ...(extras.sensory?.appearance ? { appearance: extras.sensory.appearance } : {}),
        },
      ];
    });
    return visibleAvatarOutfit(wardrobe);
  } catch (err) {
    sink?.push(
      diag("warn", "images.avatar.outfit_load_failed", "default outfit lookup failed — avatar prompt degrades to attributes only", {
        path: "items",
        context: { itemIds: [...itemIds], error: err instanceof Error ? err.message.slice(0, 300) : String(err).slice(0, 300) },
      }),
    );
    return []; // degraded: attributes-only prompt
  }
}

async function generateAvatarBuffer(prompt: string): Promise<Buffer> {
  const result = await generateImage({
    model: imageModel(),
    prompt,
    aspectRatio: "3:4",
  });
  return Buffer.from(result.image.uint8Array);
}
