import { and, eq, inArray } from "drizzle-orm";
import { z } from "zod";
import { characters, db, items } from "../db";
import { describeImageGenError, isDemoMode, veniceGenerateImage, veniceT2IModelId } from "../ai";
import { logEvent } from "../events";
import { parseOr } from "@/lib/parse";
import { DEFAULT_AVATAR_IMAGE_MODEL, type AvatarImageModel } from "@/contracts";
import { characterProfileSchema, emptyCharacterProfile } from "@/contracts/world/profile";
import { diag, type DiagnosticSink } from "@/contracts/diagnostics";
import { resolveWardrobeVisibility } from "@/contracts/items/visibility";
import { clothingSubtypeLabel } from "@/contracts/items/subtypes";
import { createImageAsset, failImage, saveImageBuffer } from "./assets";
import { monogramSvg } from "./monogram";
import {
  buildAvatarPrompt,
  toWornInputs,
  wardrobeOutfitSummary,
  type AvatarWardrobeItem,
  type AvatarStyle,
  type SceneWornItem,
} from "./prompts";

export interface GenerateAvatarInput {
  characterId: string;
  userId: string;
  style?: AvatarStyle;
  /** Venice text-to-image model key (scene-images.spec.md §5); defaults to Qwen. */
  model?: AvatarImageModel;
  sink?: DiagnosticSink;
}

/** Stored on the image row's meta for auditability (mirrors the variant label). */
function avatarModelLabel(model: AvatarImageModel): string {
  return `venice/${veniceT2IModelId(model)}`;
}

/**
 * Avatar pipeline (docs/images.md): registry prompt → Venice/Qwen uncensored
 * text-to-image (3:4), monogram in demo mode. Generation failure marks the row
 * failed and returns its id — callers poll the row, never catch.
 */
export async function generateAvatar(input: GenerateAvatarInput): Promise<string> {
  const style = input.style ?? "realistic";
  const model = input.model ?? DEFAULT_AVATAR_IMAGE_MODEL;
  const demo = isDemoMode();
  const [character] = await db().select().from(characters).where(eq(characters.id, input.characterId)).limit(1);
  const profile = parseOr(
    characterProfileSchema,
    character?.profile ?? {},
    emptyCharacterProfile(),
    input.sink,
    "characters.profile",
  );
  const wardrobe = character ? await loadDefaultWardrobe(input.userId, profile.defaultOutfit, input.sink) : [];
  // The portrait studio never renders intimate anatomy: buildAvatarPrompt drops
  // intimate categories unconditionally (plus all below-waist attributes via the
  // waist-up framing cut) — intimate detail is scene-render-only.
  const prompt = character ? buildAvatarPrompt(character.name, profile, style, wardrobe) : "";

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
    const message = describeImageGenError(err);
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
  subtype: z.string().optional().catch(undefined),
});

/**
 * The character's default outfit as RAW wardrobe items (library items in
 * profile order, carrying coverage/layer/opacity). buildAvatarPrompt does the
 * occlusion + waist-up filtering and derives region exposure from this same
 * coverage, so all the avatar's clothing logic lives in one place rather than
 * being split across loader and prompt builder. A failed lookup degrades to no
 * wardrobe with a warn diagnostic (`images.avatar.outfit_load_failed`); the
 * avatar still generates. Exported for the degradation test.
 */
export async function loadDefaultWardrobe(
  ownerId: string,
  itemIds: readonly string[],
  sink?: DiagnosticSink,
): Promise<AvatarWardrobeItem[]> {
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
          ...(extras.subtype ? { subtype: extras.subtype } : {}),
        },
      ];
    });
    return wardrobe;
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

/**
 * One readable phrase for a default outfit (pure): occlusion-filtered like every
 * other wardrobe surface — hidden layers omitted, sheer-covered pieces a vague
 * hint — with each visible garment phrased description-primary, subtype-led,
 * sensory appearance in parens (the shared `formatGarment` via
 * `wardrobeOutfitSummary`). Exported for the chat scenario seed and its test.
 */
export function wardrobeOutfitText(wardrobe: ReadonlyArray<AvatarWardrobeItem>): string {
  if (wardrobe.length === 0) return "";
  const views = resolveWardrobeVisibility(toWornInputs(wardrobe));
  const viewById = new Map(views.map((v) => [v.instanceId, v]));
  const worn = wardrobe.flatMap((item, index): SceneWornItem[] => {
    const view = viewById.get(String(index));
    if (!view || view.visibility === "hidden") return [];
    const subtypeLabel = clothingSubtypeLabel(item.subtype);
    return [
      {
        name: item.name,
        visibility: view.visibility === "hinted" ? "hinted" : "visible",
        ...(item.description ? { description: item.description } : {}),
        ...(item.appearance ? { appearance: item.appearance } : {}),
        ...(subtypeLabel ? { subtypeLabel } : {}),
      },
    ];
  });
  return wardrobeOutfitSummary(worn);
}

/**
 * The character-form default outfit (item ids) as the readable phrase the chat
 * scenario seeds its Starting Outfit with (owner report 2026-07-11: the seed
 * used to join the raw ids, which the narrator rightly ignored). A failed
 * lookup degrades to "" — composer inference — never ids.
 */
export async function defaultOutfitPhrase(
  ownerId: string,
  itemIds: readonly string[],
  sink?: DiagnosticSink,
): Promise<string> {
  if (itemIds.length === 0) return "";
  return wardrobeOutfitText(await loadDefaultWardrobe(ownerId, itemIds, sink));
}

async function generateAvatarBuffer(prompt: string, model: AvatarImageModel): Promise<Buffer> {
  // Venice uncensored text-to-image (3:4 portrait). A missing key / API error
  // throws here and the caller marks the row failed with the message.
  const result = await veniceGenerateImage({ prompt, aspectRatio: "3:4", model: veniceT2IModelId(model) });
  if (!result.ok || !result.image) throw new Error(result.error ?? "venice generate returned no image");
  return result.image;
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
