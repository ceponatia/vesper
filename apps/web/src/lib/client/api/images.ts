import { z } from "zod";

import {
  portraitVariantKindLabel,
  portraitVariantKinds,
  type PortraitVariantKind,
} from "@/contracts";
import { sceneReferenceSchema } from "@vesper/image-core";

import { apiDelete, apiGet, apiPatch, apiPost, withQuery } from "./http";
import {
  arrayOf,
  idSchema,
  listOf,
  optionalId,
  optionalText,
  textOr,
} from "./shared";

/**
 * The owner's agree/disagree verdict on one advisory, merged on by
 * `PATCH /api/images/:imageId/advisories`. Not part of the producer-side
 * `renderAdvisorySchema` (that module knows nothing about review) — layered
 * on here, the one place the client reads a reviewed advisory.
 */
const renderAdvisoryReviewSchema = z.object({
  verdict: z.enum(["agree", "disagree"]).catch("agree"),
  note: z.string().optional().catch(undefined),
  at: z.string().catch(""),
});

/**
 * One stored render advisory as the client reads it — LOOSE, the same rule
 * as `render`/`visualState` above: every field degrades independently rather
 * than failing the whole entry, so a version bump, a renamed field, or a
 * code this deployment does not recognize costs that field alone. Not built
 * on the producer-side `renderAdvisorySchema` (`@vesper/image-core`) on
 * purpose — that schema pins `version` to a literal and `code`/`level`/
 * `offers` to enums, which is exactly the shape that made a stored
 * advisory unparsable the moment `RENDER_ADVISORY_VERSION` moved, or the
 * PATCH review route's own echoed response fail to parse as `ok:false`
 * (issue #249 correction round 1).
 */
export const clientRenderAdvisorySchema = z.object({
  version: z.number().catch(1),
  code: z.string().catch(""),
  level: z.string().catch("advisory"),
  reason: z.string().catch(""),
  evidence: z.record(z.string(), z.unknown()).catch({}),
  offers: z.array(z.string()).catch([]),
  review: renderAdvisoryReviewSchema.optional().catch(undefined),
});
export type ClientRenderAdvisory = z.infer<typeof clientRenderAdvisorySchema>;

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
    /** Which explicit retry semantics produced this row, and from which source
     * (issue #248) — absent for an ordinary generation. Kept loose: a new mode
     * a future deploy adds must not fail an older client's parse. */
    retry: z
      .object({
        mode: z.string().catch(""),
        sourceImageId: z.string().optional().catch(undefined),
        seed: z.number().optional().catch(undefined),
      })
      .optional()
      .catch(undefined),
    /** This row's position in a best-of-two candidate group (issue #248) —
     * absent for a single-candidate generation. */
    candidates: z
      .object({
        group: z.string().catch(""),
        index: z.number().catch(1),
        of: z.number().catch(1),
      })
      .optional()
      .catch(undefined),
    /**
     * Advisory annotations this render measured (issue #249) — harmful crop
     * loss, a blank or severely blurred output — each with the owner's
     * agree/disagree review once one is given. `arrayOf` catches PER ENTRY:
     * one advisory a newer or older deploy wrote in a shape this client does
     * not recognize is dropped on its own, its known sibling survives, and
     * the row is never punished for a field it does not carry.
     */
    advisories: arrayOf(clientRenderAdvisorySchema).optional(),
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

export function imageUrl(imageId: string): string {
  return `/api/images/${imageId}/file`;
}

/**
 * The portraits list's per-row same-composition hint (issue #248): whether
 * "Same composition" is offered for that row's retry menu, and why not when
 * it isn't. Cheap and advisory — the server re-verifies everything against the
 * request's own resolution regardless of what this said, so a stale hint
 * degrades to a refused request with its own explanation, never a silently
 * wrong render.
 */
export const avatarReplayHintSchema = z.union([
  z.object({ ok: z.literal(true) }),
  z.object({ ok: z.literal(false), reason: z.string().catch("unavailable") }),
]);
export type AvatarReplayHint = z.infer<typeof avatarReplayHintSchema>;
export const avatarReplayMapSchema = z.record(z.string(), avatarReplayHintSchema).catch({});
export type AvatarReplayMap = z.infer<typeof avatarReplayMapSchema>;

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

// ---------------------------------------------------------------------------
// Render advisories (issue #249) — NOT re-exported through the top
// `lib/client/api.ts` barrel today, since that curated list is out of this
// change's owned paths; import from this module path directly
// (`@/lib/client/api/images`) until the barrel line is added.
// ---------------------------------------------------------------------------

/** Per-code counts plus the most recently reviewed rows — the comparison
 * record an owner reads to write a verdict (annotate / reject / propose a
 * narrow promotion check) for each advisory signal. */
export const imageAdvisorySummarySchema = z.object({
  codes: arrayOf(
    z.object({
      code: z.string(),
      annotated: z.number().catch(0),
      agreed: z.number().catch(0),
      disagreed: z.number().catch(0),
      unreviewed: z.number().catch(0),
    }),
  ),
  reviewed: arrayOf(
    z.object({
      imageId: idSchema,
      code: z.string(),
      verdict: z.enum(["agree", "disagree"]).catch("agree"),
      note: z.string().nullable().catch(null),
      reviewedAt: z.string().nullable().catch(null),
    }),
  ),
});
export type ImageAdvisorySummary = z.infer<typeof imageAdvisorySummarySchema>;

export const imageAdvisoriesApi = {
  /** Record the owner's agree/disagree verdict on one render advisory. */
  review: (imageId: string, body: { code: string; verdict: "agree" | "disagree"; note?: string }) =>
    apiPatch(z.object({ advisory: clientRenderAdvisorySchema }), `/api/images/${imageId}/advisories`, body),
  /** The comparison-record table (#249's acceptance bullet 1). */
  summary: () => apiGet(imageAdvisorySummarySchema, "/api/admin/self/image-advisories/summary"),
};
