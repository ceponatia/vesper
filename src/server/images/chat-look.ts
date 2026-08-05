import { and, desc, eq, inArray, ne } from "drizzle-orm";
import type { AttributeValue } from "@/contracts/attributes/value";
import type { RegionExposure } from "@/contracts/items/visibility";
import type { DiagnosticSink } from "@/contracts/diagnostics";
import { fnv1aHex } from "@/lib/hash";
import { hasReplicate, isDemoMode } from "../ai";
import { db, images } from "../db";
import { imageMeta, purgeImagesWhere, readImageBytes, runImagePipeline } from "./assets";
import { renderWithModel, resolveSurfaceModel } from "./models";
import { PORTRAIT_IDENTITY_LOCK } from "./prompts";

/**
 * Chat reference images (chat-scene-references.plan.md): the two cached anchors
 * that keep a conversation's renders visually consistent —
 *
 * - **`chat_look`**: an outfit-true, identity-locked variant of the avatar,
 *   re-minted when the fiction re-dresses the character (archivist outfit change
 *   / appearance overlays — the look KEY hashes all three, owner ruling). Scenes
 *   and selfies anchor on it instead of the always-dressed avatar, so renders
 *   stop arguing the edit model out of repainting the reference's clothes. Only
 *   the LATEST look is kept (ruled); the cache pointer is the images table
 *   itself (`meta.lookKey` on the newest ready row) — no state column, so a
 *   regenerate rollback can never desync pointer from asset.
 * - **`chat_place`**: a text-to-image establishing shot of the current
 *   scene-memory place, minted lazily from its agent-written sketch on the
 *   first render there; feeds the chat lane's multi-edit rung as the second
 *   reference so settings stay consistent across a conversation's scenes.
 *
 * Both kinds are chat-keyed, Gallery-hidden (its queries are kind-filtered),
 * and hard-deleted with the conversation.
 */

/**
 * The look cache key (chat-wardrobe-parity — new key shape, ruled): sorted structured
 * worn item ids + the free-text overlay + a coverage-computed exposure fingerprint +
 * appearance-relevant narrative overlays (a haircut invalidates the look like a change
 * of clothes). Structured worn state replaces the old free-text `outfit` string; a
 * legacy/free-text chat (empty worn list) keys on the overlay alone, so its key stays
 * stable across the change. PURE and order-stable.
 *
 * A DETERMINISM SEAM: this is the `meta.lookKey` `latestChatLook` compares, so if
 * the assembled string or its hash ever moves, every existing chat silently
 * re-renders its anchor. Golden-pinned in `chat-look.test.ts` and `lib/hash.test.ts`.
 */
export function chatLookKey(input: {
  wornItemIds: readonly string[];
  overlay: string;
  exposure: RegionExposure;
  attributeOverlays: readonly AttributeValue[];
  /**
   * The garment store's structural fingerprint (audit OQ8, `chatGarmentLookKey`):
   * worn INSTANCE set + presentation bands + wetness from `wet` up + deposit/damage
   * presence. Without it, arranging a garment — opening a placket, rolling a
   * sleeve, doffing one of two identical shirts — leaves the definition-id list
   * unchanged and the anchor stale.
   *
   * Appended only when non-empty, so an unmodelled chat hashes exactly as before
   * and no cached look invalidates on this change alone.
   */
  garmentKey?: string;
}): string {
  const worn = [...input.wornItemIds].sort().join(",");
  const { torso, pelvis, legs, feet } = input.exposure;
  const exposure = [torso, pelvis, legs, feet].map((r) => r[0]).join("");
  const overlays = [...input.attributeOverlays]
    .map((o) => `${o.id}=${JSON.stringify(o.value)}`)
    .sort()
    .join(";");
  const garments = input.garmentKey?.trim() ? `|${input.garmentKey.trim()}` : "";
  return fnv1aHex(`${worn}|${input.overlay.trim().toLowerCase()}|${exposure}|${overlays}${garments}`);
}

/** The identity-locked look-edit instruction: same person, new outfit, neutral framing — age-anchored (2026-07-29 ruling). */
export function buildChatLookPrompt(input: { outfit: string; outfitExposed: boolean; ageAnchor?: string }): string {
  const outfit = input.outfit.trim();
  const wearing = outfit
    ? `Change the outfit: now wearing ${outfit}. Depict only this clothing — remove anything the reference wears that is not listed.`
    : input.outfitExposed
      ? "Remove the outfit: undressed."
      : "Keep a simple, casual outfit.";
  return [
    PORTRAIT_IDENTITY_LOCK,
    input.ageAnchor ?? "",
    wearing,
    "Standing, relaxed neutral pose, facing the viewer; plain softly lit neutral backdrop; waist-up to three-quarter frame.",
  ]
    .filter(Boolean)
    .join(" ");
}

/** True when this conversation has ever rendered an image (the ruled mint gate). */
export async function chatHasRenders(chatId: string): Promise<boolean> {
  const [row] = await db()
    .select({ id: images.id })
    .from(images)
    .where(and(eq(images.chatId, chatId), inArray(images.kind, ["scene", "chat_look"])))
    .limit(1);
  return row !== undefined;
}

/** The newest ready look for the chat WITH a matching key, loaded with its bytes; null ⇒ anchor on the avatar. */
export async function latestChatLook(
  chatId: string,
  lookKey: string,
): Promise<{ imageId: string; buffer: Buffer } | null> {
  const [row] = await db()
    .select()
    .from(images)
    .where(and(eq(images.chatId, chatId), eq(images.kind, "chat_look"), eq(images.status, "ready")))
    .orderBy(desc(images.createdAt))
    .limit(1);
  if (!row) return null;
  if (imageMeta(row.meta).lookKey !== lookKey) return null;
  const buffer = await readImageBytes(row);
  return buffer ? { imageId: row.id, buffer } : null; // no bytes — the sweep reconciles; fall back to the avatar
}

export interface RenderChatLookInput {
  chatId: string;
  userId: string;
  characterId: string;
  /** The canonical avatar's bytes — the identity source the look edit preserves. */
  avatar: Buffer;
  lookKey: string;
  outfit: string;
  outfitExposed: boolean;
  /** The sheet's apparent-age anchor (apparentAgeAnchor) — text-authoritative over the reference. */
  ageAnchor?: string;
  sink?: DiagnosticSink;
}

/**
 * Mint (or refresh) the chat's current-look reference: one identity-locked edit
 * from the avatar wearing the tracked outfit, on the shared reserve → generate →
 * save-or-fail → log shell (`runImagePipeline`). On success every OTHER
 * `chat_look` row for the chat deletes (keep-latest, ruled). Failures mark the
 * row failed and return null — the anchor loader just keeps falling back to the
 * avatar and the outfit-change trigger re-fires on the next change. Never throws.
 *
 * Both anchor lanes check their preconditions BEFORE reserving anything (a
 * keyless or demo chat leaves no row at all) and log no event — the two
 * differences from the avatar/entity shape, both deliberate.
 */
export async function renderChatLookImage(input: RenderChatLookInput): Promise<string | null> {
  if (isDemoMode() || !hasReplicate()) return null;
  // The look anchor is an identity edit of the avatar, so it rides the same
  // surface as the scene picker rather than having a control of its own.
  const model = await resolveSurfaceModel("scene", null, input.sink);
  if (!model) return null;
  const prompt = buildChatLookPrompt({ outfit: input.outfit, outfitExposed: input.outfitExposed, ageAnchor: input.ageAnchor });
  const { imageId, status } = await runImagePipeline({
    asset: {
      ownerId: input.userId,
      kind: "chat_look",
      entityKind: "character",
      entityId: input.characterId,
      chatId: input.chatId,
      prompt,
      meta: { lookKey: input.lookKey, model: `replicate/${model.slug}` },
    },
    produce: async () => {
      const edit = await renderWithModel({ model, prompt, references: [input.avatar] }, input.sink);
      if (!edit.ok || !edit.image) throw new Error(edit.error ?? `${model.slug} returned no image`);
      return { ok: true, image: edit.image };
    },
    // Keep-latest (ruled): the superseded looks go with their files.
    onReady: async (asset) => {
      await purgeImagesWhere(and(eq(images.chatId, input.chatId), eq(images.kind, "chat_look"), ne(images.id, asset.id)));
    },
    failureDiagnostic: { code: "images.chat_look.failed" },
    sink: input.sink,
  });
  // A save that never reached `ready` already pushed its own diagnostic.
  return status === "ready" ? imageId : null;
}

export interface RenderChatPlaceInput {
  chatId: string;
  userId: string;
  placeName: string;
  /** The agent-written visual sketch (chat_scene_sketch) — the whole prompt source. */
  sketch: string;
  sink?: DiagnosticSink;
}

/** The place establishing-shot prompt: the sketch verbatim, empty of people (the entity-image rule). */
export function buildChatPlacePrompt(input: { placeName: string; sketch: string }): string {
  return `An establishing shot of ${input.placeName}: ${input.sketch.trim()} No people anywhere in frame; the space itself is the subject. Natural, grounded lighting.`;
}

/**
 * Mint the current place's reference image from its sketch (text-to-image on the
 * shared scene default model). Returns the ready asset id, or null on any
 * failure — the caller's CAS simply never writes and the lazy trigger re-fires
 * on the next render there. Never throws.
 */
export async function renderChatPlaceImage(input: RenderChatPlaceInput): Promise<string | null> {
  if (isDemoMode() || !hasReplicate() || !input.sketch.trim()) return null;
  // A place shot is text-to-image with no subject to preserve, so it takes the
  // portrait surface's default the way the item/location lanes do.
  const model = await resolveSurfaceModel("portrait", null, input.sink);
  if (!model) return null;
  const prompt = buildChatPlacePrompt(input);
  const { imageId, status } = await runImagePipeline({
    asset: {
      ownerId: input.userId,
      kind: "chat_place",
      chatId: input.chatId,
      prompt,
      meta: { placeName: input.placeName, model: `replicate/${model.slug}` },
    },
    produce: async () => {
      // 3:2 landscape — an establishing shot, not a portrait.
      const shot = await renderWithModel({ model, prompt, targetRatio: 3 / 2 }, input.sink);
      if (!shot.ok || !shot.image) throw new Error(shot.error ?? `${model.slug} returned no image`);
      return { ok: true, image: shot.image };
    },
    failureDiagnostic: { code: "images.chat_place.failed" },
    sink: input.sink,
  });
  return status === "ready" ? imageId : null;
}
