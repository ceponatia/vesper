import { z } from "zod";

import {
  referenceViewHistoryEntrySchema,
  referenceViewQueueOutcomeSchema,
  referenceViewSetSummarySchema,
  referenceViewSummarySchema,
  type ReferenceView,
  type ReferenceViewAngleId,
  type ReferenceViewHistoryEntry,
  type ReferenceViewHistoryVerdict,
  type ReferenceViewQueueOutcome,
  type ReferenceViewSetSummary,
  type ReferenceViewState,
  type ReferenceViewSummary,
  type ReferenceViewWardrobe,
} from "@/contracts";

import { apiGet, apiPost } from "./http";

// ---------------------------------------------------------------------------
// Reference views

export type {
  ReferenceView,
  ReferenceViewAngleId,
  ReferenceViewHistoryEntry,
  ReferenceViewHistoryVerdict,
  ReferenceViewQueueOutcome,
  ReferenceViewSetSummary,
  ReferenceViewState,
  ReferenceViewSummary,
  ReferenceViewWardrobe,
};

/**
 * `{ set, planned }` — the studio's whole read of a character's reference views.
 *
 * Forgiving to the bone, because the panel is ADDITIVE: a body it cannot read
 * degrades to an empty set and the studio looks exactly as it did before the
 * feature existed, rather than growing an error card about a subsystem the owner
 * never asked for.
 */
const referenceViewSetResponseSchema = z
  .object({
    set: referenceViewSetSummarySchema,
    /** How many views a full build would render for this character, after the age gate. */
    planned: z.number().catch(0),
  })
  .catch({
    set: { acceptedImageId: null, building: false, views: [] },
    planned: 0,
  });

/** `{ views }` — what a build or regenerate request decided. Never a failure. */
const referenceViewQueueResponseSchema = z.object({
  views: referenceViewQueueOutcomeSchema.catch({
    queued: false,
    reason: null,
    planned: 0,
  }),
});

/** `{ view }` — one settled slot, the body every per-view write answers with. */
const referenceViewResponseSchema = z.object({
  view: referenceViewSummarySchema,
});

/**
 * `{ entries, retentionDays }` — every image one slot has produced, newest
 * first, and the window after which a replaced one's bytes are collected.
 *
 * Forgiving like the set read, and for the same reason: history is an aid to
 * judgment, so a body it cannot read degrades to an empty list the studio can
 * say "nothing kept" about rather than to an error the owner has to interpret.
 */
const referenceViewHistoryResponseSchema = z
  .object({
    entries: z.array(referenceViewHistoryEntrySchema).catch([]),
    retentionDays: z.number().catch(0),
  })
  .catch({ entries: [], retentionDays: 0 });

/** The slot path segment pair, spelled once so no call site builds a URL by hand. */
function referenceViewPath(
  characterId: string,
  angle: ReferenceViewAngleId,
  wardrobe: ReferenceViewWardrobe,
): string {
  return `/api/characters/${characterId}/reference-views/${angle}/${wardrobe}`;
}

export const referenceViewsApi = {
  get: (characterId: string) =>
    apiGet(
      referenceViewSetResponseSchema,
      `/api/characters/${characterId}/reference-views`,
    ),
  /** Build every slot that is missing, failed or stale for the current accepted portrait. */
  build: (characterId: string) =>
    apiPost(
      referenceViewQueueResponseSchema,
      `/api/characters/${characterId}/reference-views/build`,
      {},
    ),
  /**
   * Rebuild the named slots — any state, a rejected one included — as ONE batch:
   * one admission, one charge, one job, every target started together. A single
   * card's Regenerate is this call with one target.
   */
  regenerate: (characterId: string, targets: readonly ReferenceView[]) =>
    apiPost(
      referenceViewQueueResponseSchema,
      `/api/characters/${characterId}/reference-views/regenerate`,
      {
        targets,
      },
    ),
  /** Replace one slot with an owner-supplied image. Synchronous — no polling. */
  upload: (
    characterId: string,
    angle: ReferenceViewAngleId,
    wardrobe: ReferenceViewWardrobe,
    dataUrl: string,
  ) =>
    apiPost(
      referenceViewResponseSchema,
      `${referenceViewPath(characterId, angle, wardrobe)}/upload`,
      { dataUrl },
    ),
  /** Approve (making the view consumable) or reject (terminal for that attempt). */
  review: (
    characterId: string,
    angle: ReferenceViewAngleId,
    wardrobe: ReferenceViewWardrobe,
    verdict: "approve" | "reject",
  ) =>
    apiPost(
      referenceViewResponseSchema,
      `${referenceViewPath(characterId, angle, wardrobe)}/review`,
      { verdict },
    ),
  /** Every image this slot has produced, with its verdict. Read-only — it moves nothing. */
  history: (
    characterId: string,
    angle: ReferenceViewAngleId,
    wardrobe: ReferenceViewWardrobe,
  ) =>
    apiGet(
      referenceViewHistoryResponseSchema,
      `${referenceViewPath(characterId, angle, wardrobe)}/history`,
    ),
};
