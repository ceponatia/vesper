import type { ImageRecord } from "@/lib/client/api";

/**
 * What the portrait studio tracks about the CURRENT avatar-generation
 * request, so its own completion can be judged without depending on the
 * character's canonical pointer (issue #248 codex review round 1, finding
 * A) or on a client-side snapshot of what existed before it (round 2,
 * threads 3–4).
 *
 * The pointer is the wrong signal for a two-candidate request: it
 * deliberately claims no pointer at all (the player chooses via promote), so
 * `characters.avatarImageId` never changes no matter how the render turns
 * out, and a studio that only watches the pointer stays busy forever once
 * both candidates land.
 *
 * A snapshot of "rows that already existed" is the wrong signal too: taken
 * before the portraits list has ever loaded, it is empty — every row the
 * request goes on to produce reads as "new", so a completion check can fire
 * on stale, unrelated history and clear the busy state before the request
 * even reached the provider. And a ref filled in only once the POST
 * resolves leaves a window where a completion check re-evaluates the
 * PREVIOUS request's stale record instead of the new one.
 *
 * `requestId` closes both holes: it is minted CLIENT-SIDE (needs no
 * response to exist) and tracked before either phase flips, and the server
 * stamps it on every row this exact request reserves (`meta.request.id`),
 * so completion is judged by an id match, never a count against history.
 */
export interface AvatarGenerationRequest {
  readonly requestId: string;
  readonly candidates: 1 | 2;
}

/** The current state a completion judgment reads — never more of the studio than this. */
export interface AvatarGenerationSnapshot {
  readonly rows: readonly ImageRecord[];
}

/**
 * The avatar-kind rows THIS request produced — everything of kind `avatar`
 * whose `meta.request.id` matches. Exposed separately from the completion
 * check below so a caller that needs to know WHAT happened (a failure toast
 * reading the new rows' own error text) does not have to re-derive the same
 * filter.
 */
export function avatarGenerationRows(
  request: AvatarGenerationRequest,
  rows: readonly ImageRecord[],
): ImageRecord[] {
  return rows.filter((row) => row.kind === "avatar" && row.meta?.request?.id === request.requestId);
}

/**
 * Whether `request` has finished: as many rows stamped with its id exist as
 * it asked for, and every one of them has settled (`ready` or `failed`).
 * The ONLY signal a two-candidate request ever gets, since it claims no
 * canonical pointer at all — and it covers a single-candidate SUCCESS or
 * FAILURE identically, since neither needs the pointer once the row itself
 * carries the request's own id.
 *
 * Zero matching rows is always busy, never done — including the instant
 * after the request was sent but before the server has reserved anything:
 * there is nothing here to mistake for "nothing was asked for".
 */
export function isAvatarGenerationComplete(
  request: AvatarGenerationRequest,
  current: AvatarGenerationSnapshot,
): boolean {
  const rows = avatarGenerationRows(request, current.rows);
  if (rows.length < request.candidates) return false;
  return rows.every((row) => row.status === "ready" || row.status === "failed");
}
