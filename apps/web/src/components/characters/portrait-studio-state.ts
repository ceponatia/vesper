import type { ImageRecord } from "@/lib/client/api";

/**
 * What the portrait studio remembers about ONE avatar-generation request,
 * captured right before it is sent, so the request's OWN completion can be
 * judged later without depending on the character's canonical pointer
 * (codex review round 1, finding A on issue #248).
 *
 * The pointer is the wrong signal for a two-candidate request: it
 * deliberately claims no pointer at all (the player chooses via promote), so
 * `characters.avatarImageId` never changes no matter how the render turns
 * out, and a studio that only watches the pointer stays busy forever once
 * both candidates land.
 */
export interface AvatarGenerationRequest {
  /**
   * The queuing job's id, from the 202 response. Carried for traceability
   * only — no stored row records which job produced it, so the completion
   * judgment below never looks anything up by it.
   */
  readonly jobId: string;
  readonly candidates: 1 | 2;
  /** Avatar-kind row ids that already existed when this request was sent. */
  readonly priorAvatarRowIds: ReadonlySet<string>;
  /** The canonical avatar pointer id before this request was sent. */
  readonly priorAvatarImageId: string | null;
}

/** The current state a completion judgment reads — never more of the studio than this. */
export interface AvatarGenerationSnapshot {
  readonly rows: readonly ImageRecord[];
  readonly avatarImageId: string | null;
}

/**
 * The avatar-kind rows THIS request produced — everything of kind `avatar`
 * that was not already present when the request was captured. Exposed
 * separately from the completion check below so a caller that needs to know
 * WHAT happened (a failure toast reading the new rows' own error text) does
 * not have to re-derive the same filter.
 */
export function avatarGenerationRows(
  request: AvatarGenerationRequest,
  rows: readonly ImageRecord[],
): ImageRecord[] {
  return rows.filter((row) => row.kind === "avatar" && !request.priorAvatarRowIds.has(row.id));
}

/**
 * Whether `request` has finished — judged two ways, either sufficient:
 *
 * 1. The canonical pointer moved to something new (today's mechanism,
 *    unchanged): only a single-candidate success ever claims the pointer, so
 *    this is the ONLY way a single-candidate request was ever detected before
 *    this module existed, and it still is.
 * 2. As many NEW avatar-kind rows exist as this request asked for, and every
 *    one of them has settled (`ready` or `failed`). This is the ONLY signal a
 *    two-candidate request ever gets, since it claims no pointer at all — and
 *    it doubles as a same-shape check for a single-candidate FAILURE, which
 *    also never moves the pointer.
 */
export function isAvatarGenerationComplete(
  request: AvatarGenerationRequest,
  current: AvatarGenerationSnapshot,
): boolean {
  if (current.avatarImageId !== null && current.avatarImageId !== request.priorAvatarImageId) return true;
  const newRows = avatarGenerationRows(request, current.rows);
  if (newRows.length < request.candidates) return false;
  return newRows.every((row) => row.status === "ready" || row.status === "failed");
}
