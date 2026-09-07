import { z } from "zod";

import { parseOrNull } from "@/lib/parse";

import {
  type IdentityPackAdminOverrideRequest,
  type IdentityPackAdminRevision,
  identityPackAdminRevisionSchema,
  type IdentityPackBlockedWire,
  type IdentityPackManualCropRequest,
  type IdentityPackNormalizedCropWire,
  identityPackResponseSchema,
  type IdentityPackSummaryWire,
  type IdentityReferenceStrategy,
  type ImageIdentityPackFailureCode,
  imageIdentityPackFailureCodeSchema,
  type ImageIdentityPackTrialCreateRequest,
  type ImageIdentityPackTrialGradeRequest,
  type ImageIdentityPackTrialRefusalCode,
  imageIdentityPackTrialRefusalCodeSchema,
  imageIdentityPackTrialReviewPairSchema,
  imageIdentityPackTrialRunDetailSchema,
  imageIdentityPackTrialRunSummarySchema,
  imageIdentityPackTrialSummarySchema,
  trialCellCountsSchema,
  trialRunStatusSchema,
  trialVerdictSchema,
  type TrialVerdictValue,
} from "@vesper/image-core";

import { apiDelete, apiGet, apiPost, type ApiError } from "./http";
import { arrayOf, idSchema, listOf } from "./shared";

// Identity packs
// ---------------------------------------------------------------------------

export type {
  IdentityPackAdminRevision,
  IdentityPackBlockedWire,
  IdentityPackNormalizedCropWire,
  IdentityPackSummaryWire,
};

/**
 * The optimistic-concurrency triple every pack WRITE carries — the fields the
 * manual-crop and override requests share, named once so the editor can pass
 * "the thing I opened" around as one value.
 */
export type IdentityPackWriteGuard = Pick<
  IdentityPackManualCropRequest,
  "packId" | "revision" | "sourceContentHash"
>;

/**
 * The fresh summary a 409 carried back, or null if the body was not one.
 *
 * A stale save is an EXPECTED outcome — the portrait changed under an open editor —
 * so the conflict response reloads the editor in place instead of surfacing as a
 * failed request the user has to interpret.
 */
export function identityPackConflictSummary(
  error: ApiError,
): IdentityPackSummaryWire | null {
  if (error.status !== 409) return null;
  return parseOrNull(identityPackResponseSchema, error.body)?.summary ?? null;
}

const identityPackRejectionSchema = z.object({
  failureCode: imageIdentityPackFailureCodeSchema,
});

/**
 * The measured failure code behind a 422, when the refusal named one.
 *
 * `error.code` carries the narrower rejection reason (which geometry rule broke);
 * the body's `failureCode` is the stable vocabulary the UI has copy for, so the
 * editor can answer "make the square bigger" instead of echoing `below_minimum`.
 */
export function identityPackRejectionCode(
  error: ApiError,
): ImageIdentityPackFailureCode | null {
  if (error.status !== 422) return null;
  return (
    parseOrNull(identityPackRejectionSchema, error.body)?.failureCode ?? null
  );
}

/**
 * Every pack route answers with the same body, so it is parsed once
 * (contracts §`identityPackResponseSchema`). `blocked` is present only on a
 * write whose refusal never reached a revision — the summary cannot report that
 * one, because there is nothing new in the row to report.
 */
export const identityPacksApi = {
  get: (characterId: string) =>
    apiGet(
      identityPackResponseSchema,
      `/api/characters/${characterId}/identity-pack`,
    ),
  /** Prepare (or re-prepare) the pack — the none/failed/stale path. Idempotent server-side. */
  ensure: (characterId: string) =>
    apiPost(
      identityPackResponseSchema,
      `/api/characters/${characterId}/identity-pack/ensure`,
      {},
    ),
  /** Save an owner correction. 409 ⇒ stale editor (see `identityPackConflictSummary`), 422 ⇒ measured refusal. */
  manualCrop: (characterId: string, body: IdentityPackManualCropRequest) =>
    apiPost(
      identityPackResponseSchema,
      `/api/characters/${characterId}/identity-pack/manual-crop`,
      body,
    ),
  /** Drop the manual crop and re-derive automatically (a new revision, not an undo). */
  resetAutomatic: (characterId: string) =>
    apiPost(
      identityPackResponseSchema,
      `/api/characters/${characterId}/identity-pack/reset-automatic`,
      {},
    ),
};

/**
 * The trial refusal behind a 400, when the error's code belongs to the trial
 * vocabulary (`imageIdentityPackTrialRefusalCodes`). Trial routes answer
 * refusals in the standard error envelope with the stable code as `error.code`;
 * this narrows it so the UI can hand the code to its copy map instead of
 * echoing an identifier. Null for any other failure — surface those verbatim.
 */
export function identityPackTrialRefusal(
  error: ApiError,
): { code: ImageIdentityPackTrialRefusalCode; message: string } | null {
  if (error.status !== 400) return null;
  const code = parseOrNull(imageIdentityPackTrialRefusalCodeSchema, error.code);
  return code === null ? null : { code, message: error.message };
}

/** One settled cell from an execute pass; `skipped` means another writer got there first. */
const trialExecutedCellSchema = z.object({
  cellId: idSchema,
  cellKey: z.string(),
  status: z.enum(["rendered", "failed", "refused", "skipped"]),
});

const trialExecuteResponseSchema = z.object({
  executed: arrayOf(trialExecutedCellSchema),
  remainingPlanned: z.number().int().min(0).catch(0),
  runStatus: trialRunStatusSchema,
});

const TRIAL_API_ROOT = "/api/admin/self/identity-packs/trial";

/** Admin-only pack inspection (`/api/admin/self` — 404s for non-admins). */
export const adminIdentityPacksApi = {
  /** Revision history, newest first. A row that fails the contract is dropped, not fatal. */
  history: (packId: string) =>
    apiGet(
      z.object({ history: arrayOf(identityPackAdminRevisionSchema) }),
      `/api/admin/self/identity-packs/${packId}/history`,
    ),
  /** Reviewed override: a non-empty reason is required; omitting `crop` keeps the current coordinates. */
  override: (packId: string, body: IdentityPackAdminOverrideRequest) =>
    apiPost(
      identityPackResponseSchema,
      `/api/admin/self/identity-packs/${packId}/override`,
      body,
    ),
  /**
   * The fixed identity-reference trial harness: plan a run, execute it a few
   * renders at a time, review blinded pairs, aggregate, record verdicts. Refusals come
   * back as 400s whose code `identityPackTrialRefusal` recognizes.
   */
  trial: {
    create: (body: ImageIdentityPackTrialCreateRequest) =>
      apiPost(
        z.object({ runId: idSchema, counts: trialCellCountsSchema }),
        TRIAL_API_ROOT,
        body,
      ),
    list: () =>
      apiGet(
        listOf(imageIdentityPackTrialRunSummarySchema, "runs"),
        TRIAL_API_ROOT,
      ),
    detail: (runId: string) =>
      apiGet(
        imageIdentityPackTrialRunDetailSchema,
        `${TRIAL_API_ROOT}/${runId}`,
      ),
    execute: (runId: string, maxRenders?: number) =>
      apiPost(
        trialExecuteResponseSchema,
        `${TRIAL_API_ROOT}/${runId}/execute`,
        maxRenders === undefined ? {} : { maxRenders },
      ),
    /** `pair: null` means every reviewable pair has a grade — a state, not an error. */
    nextPair: (runId: string) =>
      apiGet(
        z.object({ pair: imageIdentityPackTrialReviewPairSchema.nullable() }),
        `${TRIAL_API_ROOT}/${runId}/review`,
      ),
    grade: (runId: string, body: ImageIdentityPackTrialGradeRequest) =>
      apiPost(
        z.object({ recorded: z.boolean() }),
        `${TRIAL_API_ROOT}/${runId}/review`,
        body,
      ),
    summary: (runId: string) =>
      apiGet(
        imageIdentityPackTrialSummarySchema,
        `${TRIAL_API_ROOT}/${runId}/summary`,
      ),
    /**
     * `overrideIncompleteReview` is optional and never defaulted here: its
     * ABSENCE is what tells the server "I expect complete evidence", so a caller
     * that has not thought about the gate cannot bypass it by omission. The
     * server records the flag on the ruling, and the verdict list it hands back
     * echoes it.
     */
    verdict: (
      runId: string,
      body: {
        profileId: string;
        identityStrategy: IdentityReferenceStrategy;
        verdict: TrialVerdictValue;
        reason: string;
        overrideIncompleteReview?: boolean;
      },
    ) =>
      apiPost(
        z.object({
          runStatus: trialRunStatusSchema,
          verdicts: arrayOf(trialVerdictSchema),
        }),
        `${TRIAL_API_ROOT}/${runId}/verdict`,
        body,
      ),
    remove: (runId: string) => apiDelete(`${TRIAL_API_ROOT}/${runId}`),
  },
};
