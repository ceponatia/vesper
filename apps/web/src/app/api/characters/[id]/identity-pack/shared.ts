import type { NextResponse } from "next/server";
import type {
  EnsureIdentityPackResult,
  IdentityPackNormalizedCropWire,
  IdentityPackSummaryWire,
} from "@vesper/image-core";
import { jsonError, jsonOk } from "@/server/api";
import {
  getIdentityPackForOwner,
  identityPackSummaryToWire,
  type ManualIdentityCropInput,
  type SaveManualIdentityCropResult,
} from "@/server/images";
import { findOwnedCharacter } from "../owned";

/**
 * The vocabulary every identity-pack route speaks
 * (image-identity-packs.spec.lifecycle.md §"User routes", §"Admin routes").
 *
 * Four owner routes and one admin override all resolve the same character, map
 * the same service result, and answer with the same `{ summary }` body. Written
 * out five times that is five chances for one route to answer a stale save with
 * a different status, or to leak a field the privacy boundary excludes — so the
 * shape is stated once, here, and the routes are left holding only what makes
 * them different.
 */

export type IdentityPackParams = { id: string };

export type OwnedCharacter = NonNullable<Awaited<ReturnType<typeof findOwnedCharacter>>>;

/**
 * The authorization root for every pack operation: the CHARACTER, never a pack
 * or image id a client supplied (spec.lifecycle.md §"Authorization root").
 * `withAuthorizedResource` collapses "not yours" and "does not exist" into one
 * 404, which is also the shape `pnpm lint:authz` requires of a resource-ID route.
 */
export const ownedCharacter = async (user: { id: string }, params: IdentityPackParams) =>
  (await findOwnedCharacter(params.id, user.id)) ?? null;

/** The owner-safe wire summary, or `null` when the character is not this user's. */
export async function readIdentityPackSummary(
  characterId: string,
  ownerId: string,
): Promise<IdentityPackSummaryWire | null> {
  const summary = await getIdentityPackForOwner(characterId, ownerId);
  return summary === null ? null : identityPackSummaryToWire(summary);
}

/**
 * `{ summary }` — the success body of every pack route, read fresh AFTER the
 * work rather than assembled from what the service returned. A save promotes a
 * new revision and a reset supersedes one, so the row is the only honest account
 * of what the client should now be looking at.
 *
 * `outcome` is the service's typed result, and it is passed by the two routes
 * that DO work without necessarily leaving a revision behind. A refusal reached
 * before anything was persisted — no canonical portrait, a source still
 * generating, unreadable bytes, another derivation holding the lock past the
 * wait window — is invisible in the re-read summary: it reports the previous
 * pack, or `none`, and an owner who just clicked Prepare is shown the state they
 * started in with no reason for it. So the body widens by one optional field
 * (contracts §`identityPackBlockedSchema`) rather than the status changing: an
 * unusable pack stays product feedback at 200, and `{ summary }` alone stays the
 * exact shape for every route and every success.
 */
export async function identityPackSummaryResponse(
  characterId: string,
  ownerId: string,
  outcome?: EnsureIdentityPackResult,
): Promise<Response> {
  const summary = await readIdentityPackSummary(characterId, ownerId);
  if (summary === null) return jsonError("not_found", "character not found", 404);
  if (outcome?.status !== "blocked") return jsonOk({ summary });
  return jsonOk({ summary, blocked: { code: outcome.code, retryable: outcome.retryable } });
}

/**
 * The standard error envelope plus the data a client must act on.
 *
 * `jsonError` cannot carry extra fields and must not learn to — `{ error: {
 * code, message } }` is the envelope every client parses. So the BODY widens
 * here instead: a 409 travels with the fresh summary, and a 422 with the
 * measured blockers, while `error.code` stays exactly where every existing
 * error handler already looks for it.
 */
export function identityPackFailure<T extends object>(
  status: number,
  code: string,
  message: string,
  extra: T,
): NextResponse<{ error: { code: string; message: string } } & T> {
  return jsonOk({ error: { code, message }, ...extra }, status);
}

/** Normalized wire coordinates as the service's tagged crop input. */
export function manualCropInput(crop: IdentityPackNormalizedCropWire): ManualIdentityCropInput {
  return { space: "normalized", crop: { left: crop.left, top: crop.top, width: crop.width, height: crop.height } };
}

/**
 * Everything a manual save can answer other than success.
 *
 * - **conflict → 409 `stale_pack`, carrying the CURRENT summary.** A stale
 *   editor is an expected outcome (the portrait moved while it was open), and
 *   the client can only reload in place if the conflict itself says what to
 *   reload to — a second GET would race the same source it just lost.
 * - **rejected → 422 with the measured reason.** The crop was refused by
 *   geometry or by policy; every blocker travels, not just the first, because
 *   the editor explains all of them at once.
 * - **blocked → 422 with the failure code.** Nothing about the rectangle was
 *   wrong; the character's current state cannot support a save at all (no
 *   canonical portrait, unreadable bytes). `retryable` says whether asking again
 *   could change that.
 */
export async function identityPackWriteFailure(
  result: Exclude<SaveManualIdentityCropResult, { status: "ready" }>,
  characterId: string,
  ownerId: string,
): Promise<Response> {
  switch (result.status) {
    case "conflict":
      // `busy` is the one conflict where nothing moved — another derivation is
      // mid-flight — so its copy says "again in a moment", not "reload".
      return identityPackFailure(
        409,
        "stale_pack",
        result.reason === "busy"
          ? "another update to this pack is still running; try again in a moment"
          : `the pack moved on (${result.reason}); reload and crop again`,
        {
          summary: await readIdentityPackSummary(characterId, ownerId),
          conflict: {
            reason: result.reason,
            currentPackId: result.currentPackId,
            currentRevision: result.currentRevision,
            sourceContentHash: result.sourceContentHash,
          },
        },
      );
    case "rejected":
      return identityPackFailure(422, result.reason, result.message, {
        failureCode: result.code,
        blockers: result.blockers,
      });
    case "blocked":
      return identityPackFailure(422, result.code, "this character's portrait cannot carry a crop right now", {
        retryable: result.retryable,
      });
  }
}
