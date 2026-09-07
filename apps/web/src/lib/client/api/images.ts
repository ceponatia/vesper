import { z } from "zod";

import {
  portraitVariantKindLabel,
  portraitVariantKinds,
  type PortraitVariantKind,
  socialReactionCardExtrasSchema,
} from "@/contracts";
import { sceneReferenceSchema } from "@vesper/image-core";

/**
 * Client data layer (docs/streaming-api.md, docs/ui/conventions.md): typed
 * fetch helpers over the route-handler API. Every response crosses a trust boundary, so it
 * is parsed with forgiving schemas — unknown fields are stripped, bad fields
 * fall back, bad list elements are dropped. Errors use the
 * `{ error: { code, message } }` envelope.
 *
 * This module is client-safe: it imports only pure contracts and `zod`.
 */

import { apiDelete, apiGet, apiPatch, apiPost, withQuery } from "./http";
import {
  arrayOf,
  idSchema,
  listOf,
  nameSchema,
  optionalId,
  optionalText,
  tagsSchema,
  textOr,
  visibilitySchema,
} from "./shared";

// ---------------------------------------------------------------------------
// Social-reaction cards
// ---------------------------------------------------------------------------

export const socialCardSummarySchema = z.object({
  id: idSchema,
  name: nameSchema,
  description: textOr(""),
  tags: tagsSchema,
  visibility: visibilitySchema,
  /** The `kind` lives in the definition JSONB; surfaced for the library bucket + tag. */
  definition: socialReactionCardExtrasSchema.catch(() =>
    socialReactionCardExtrasSchema.parse({}),
  ),
});
export type SocialCardSummary = z.infer<typeof socialCardSummarySchema>;

/** Detail adds `mine` (viewer owns it) so the builder offers edit vs clone-to-library. */
export const socialCardDetailSchema = socialCardSummarySchema.extend({
  mine: z.boolean().catch(true),
});
export type SocialCardDetail = z.infer<typeof socialCardDetailSchema>;

/**
 * One image row's `meta`, as every client surface reads it.
 *
 * Shared between the image DTO and the Gallery's, because the lightbox's
 * admin-only provenance panel is one component reading one shape: a second
 * spelling here would be a panel that shows the shot on one page and not on the
 * other. Every member is optional and every branch `catch`es — a row written by
 * a newer deploy must degrade to "that field is absent", never to an image the
 * client cannot parse.
 */
export const imageRowMetaSchema = z
  .object({
    source: z.string().optional().catch(undefined),
    model: z.string().optional().catch(undefined),
    error: z.string().optional().catch(undefined),
    /** "selfie" marks a character-sent photo message. */
    flavor: z.string().optional().catch(undefined),
    variantKind: z.string().optional().catch(undefined),
    /** The attempt provenance the lanes record (`ResolvedImageAttempt`) — kept
     * loose: the Gallery only carries it, and a strict shape here would strip
     * a record written by a newer deploy. */
    render: z.record(z.string(), z.unknown()).optional().catch(undefined),
    /** The visual-state provenance a digest-fed lane records at reserve time
     * (`VisualImageProvenance`) — loose for the same reason as `render`. */
    visualState: z.record(z.string(), z.unknown()).optional().catch(undefined),
    /** The RESOLVED shot a scene render was composed under — ids only, the
     * registries own the phrasing. Read by the lightbox's admin panel. */
    camera: z
      .object({
        orientation: z.string().catch(""),
        distance: z.string().catch(""),
        height: z.string().catch(""),
      })
      .optional()
      .catch(undefined),
    /** The staged arrangement's registry id, when the shot carried one. */
    staging: z.string().optional().catch(undefined),
    /** Which matching reference view anchored which person on this render. */
    referenceViews: z
      .array(
        z.object({
          characterId: z.string().catch(""),
          angle: z.string().catch(""),
          wardrobe: z.string().catch(""),
          imageId: z.string().catch(""),
          sourceImageId: z.string().catch(""),
          substitutedAnchor: z.boolean().catch(false),
        }),
      )
      .optional()
      .catch(undefined),
  })
  .catch({});

/** The Gallery hub's tabs. */
export type GalleryTab = "scenes" | "portraits" | "entity";

/**
 * One image in the tabbed Gallery hub (docs/images/pipelines/scene-images.md
 * §The Gallery hub). Scenes carry a `characterId` (character-chat, grouped
 * under "Character chats"); portraits
 * carry `characterId`; entity art carries `entityKind`/`entityName`.
 */
export const galleryImageSchema = z.object({
  id: idSchema,
  characterId: optionalId,
  characterName: optionalText,
  entityKind: optionalText,
  entityName: optionalText,
  /** Characters + location the scene features; `kind: "character"` drives the filter. */
  references: arrayOf(sceneReferenceSchema),
  prompt: textOr(""),
  favorite: z.boolean().catch(false),
  createdAt: optionalText,
  /** The row's own meta. Populated for scenes, where the shot provenance lives. */
  meta: imageRowMetaSchema,
});
export type GalleryImage = z.infer<typeof galleryImageSchema>;

// ---------------------------------------------------------------------------
// Images
// ---------------------------------------------------------------------------

export const imageRecordSchema = z.object({
  id: idSchema,
  kind: z.string().catch("portrait_variant"),
  status: z.enum(["pending", "ready", "failed"]).catch("ready"),
  prompt: textOr(""),
  sourceImageId: optionalId,
  createdAt: optionalText,
  /** Slice 9 (inline scene moments): the conversation + assistant message a chat scene anchors to. */
  chatId: optionalId,
  anchorMessageId: optionalId,
  /** Row meta — `source: "upload"` marks uploads; failed rows carry `error`. */
  meta: imageRowMetaSchema,
});
export type ImageRecord = z.infer<typeof imageRecordSchema>;

// The variant kinds are a pure contract (`contracts/images/portrait-variant`) —
// the studio dropdown, the POST body schema and the prompt builder all read that
// one tuple. Re-exported here so components keep importing them from the client
// API surface, the same way the image-model record contract is.
export { portraitVariantKindLabel, portraitVariantKinds };
export type { PortraitVariantKind };

export const ownedImageSourceSchema = z.object({
  id: idSchema,
  kind: z.string().min(1),
  createdAt: textOr(""),
  /** Leading slice of the stored prompt — a label, not the record. */
  prompt: textOr(""),
  entityKind: z.string().nullable().catch(null),
  entityId: z.string().nullable().catch(null),
  chatId: z.string().nullable().catch(null),
});
export type OwnedImageSourceRecord = z.infer<typeof ownedImageSourceSchema>;

export const ownedImagesApi = {
  /**
   * Ready owned images, newest first; `kinds` filters within the allowlist.
   * Paging is a compound (createdAt, id) cursor: `before` is the last row's
   * createdAt and `beforeId` its id, so same-instant rows at a page boundary
   * are neither skipped nor repeated. `beforeId` is only valid beside `before`.
   */
  list: (
    opts: {
      kinds?: readonly string[];
      limit?: number;
      before?: string;
      beforeId?: string;
    } = {},
  ) =>
    apiGet(
      listOf(ownedImageSourceSchema, "images"),
      withQuery("/api/admin/self/owned-images", {
        kinds:
          opts.kinds && opts.kinds.length > 0
            ? opts.kinds.join(",")
            : undefined,
        limit: opts.limit,
        before: opts.before,
        beforeId: opts.beforeId,
      }),
    ),
};

type GalleryListParams = { tab?: GalleryTab; cursor?: string };

export const galleryApi = {
  /** One keyset page of the given tab's ready images, newest first. */
  list: (params: GalleryListParams = {}) =>
    apiGet(
      z.object({
        images: arrayOf(galleryImageSchema),
        nextCursor: z.string().nullable().catch(null),
      }),
      withQuery("/api/gallery", params),
    ),
  /** Toggle the owner's favorite flag on a gallery image. */
  favorite: (id: string, favorite: boolean) =>
    apiPatch(z.unknown(), `/api/gallery/${id}`, { favorite }),
  /** Permanently delete one gallery image (row + file; drops from every view). */
  remove: (id: string) => apiDelete(`/api/gallery/${id}`),
  /** Bulk-delete gallery images (row + file each) — "Delete all" and the multi-select delete. */
  removeMany: (ids: string[]) =>
    apiPost(z.object({ deleted: z.number().catch(0) }), "/api/gallery/delete", {
      ids,
    }),
};
