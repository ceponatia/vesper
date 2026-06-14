import { generateImage } from "ai";
import { and, eq, inArray } from "drizzle-orm";
import { z } from "zod";
import { characters, db, items } from "../db";
import { imageModel, imageModelId, isDemoMode, veniceGenerateImage } from "../ai";
import { logEvent } from "../events";
import { parseOr } from "@/lib/parse";
import { characterProfileSchema, emptyCharacterProfile } from "@/contracts/world/profile";
import { diag, type DiagnosticSink } from "@/contracts/diagnostics";
import { createImageAsset, failImage, saveImageBuffer } from "./assets";
import { monogramSvg } from "./monogram";
import { buildAvatarPrompt, visibleAvatarOutfit, type AvatarOutfitItem, type AvatarStyle } from "./prompts";

/** Which generator backs the avatar: Flux (OpenRouter) or Qwen uncensored (Venice). */
export type AvatarImageModel = "flux" | "qwen";

export interface GenerateAvatarInput {
  characterId: string;
  userId: string;
  style?: AvatarStyle;
  /** Image model; defaults to Flux. "qwen" routes through Venice's uncensored text-to-image. */
  model?: AvatarImageModel;
  sink?: DiagnosticSink;
}

/** Stored on the image row's meta for auditability (mirrors the variant label). */
function avatarModelLabel(model: AvatarImageModel): string {
  return model === "qwen" ? `venice/${process.env.VENICE_IMAGE_MODEL || "qwen-image"}` : imageModelId();
}

/**
 * Avatar pipeline (docs/images.md): registry prompt → OpenRouter image model
 * (3:4), monogram in demo mode. Generation failure marks the row failed and
 * returns its id — callers poll the row, never catch.
 */
export async function generateAvatar(input: GenerateAvatarInput): Promise<string> {
  const style = input.style ?? "realistic";
  const model = input.model ?? "flux";
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
    meta: { style, model: demo ? "demo" : avatarModelLabel(model), demo },
  });

  if (!character) {
    await failImage(asset.id, `character ${input.characterId} not found`);
    return asset.id;
  }

  const started = Date.now();
  try {
    const buffer = demo ? monogramSvg(character.name) : await generateAvatarBuffer(prompt, model);
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
  description: z.string().catch(""),
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
          ...(extras.description ? { description: extras.description } : {}),
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

async function generateAvatarBuffer(prompt: string, model: AvatarImageModel): Promise<Buffer> {
  if (model === "qwen") {
    // Venice uncensored text-to-image (3:4 portrait). A missing key / API error
    // throws here and the caller marks the row failed with the message.
    const result = await veniceGenerateImage({ prompt, aspectRatio: "3:4" });
    if (!result.ok || !result.image) throw new Error(result.error ?? "venice generate returned no image");
    return result.image;
  }
  const result = await generateImage({
    model: imageModel(),
    prompt,
    aspectRatio: "3:4",
  });
  return Buffer.from(result.image.uint8Array);
}

/** Concurrency for batched avatar generation — matches the entity-image batch. */
const AVATAR_BATCH_SIZE = 5;

/**
 * Generate avatars for many characters in parallel batches of AVATAR_BATCH_SIZE
 * (new-world auto-generation, followups.phase3.md §4). One failure never aborts
 * the batch. Run inside a background job; returns how many completed.
 */
export async function generateAvatarsBatch(
  characterIds: readonly string[],
  userId: string,
  sink?: DiagnosticSink,
): Promise<number> {
  let done = 0;
  for (let i = 0; i < characterIds.length; i += AVATAR_BATCH_SIZE) {
    const chunk = characterIds.slice(i, i + AVATAR_BATCH_SIZE);
    await Promise.all(
      chunk.map((characterId) =>
        generateAvatar({ characterId, userId, sink })
          .then(() => {
            done += 1;
          })
          .catch(() => undefined),
      ),
    );
  }
  return done;
}
