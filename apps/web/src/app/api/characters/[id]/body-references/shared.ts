import { parseBodyReferenceSlot, type BodyReferenceSlot } from "@/contracts";
import { jsonError, jsonOk } from "@/server/api";
import type { BodyReferenceWriteResult } from "@/server/images";
import { findOwnedCharacter } from "../owned";

/**
 * The vocabulary every body-image route speaks
 * (`docs/images/pipelines/reference-views.md` §Body reference images).
 *
 * Every route is rooted at the CHARACTER in the URL and addresses a slot of it,
 * never an image id a client supplied as the resource: `withAuthorizedResource`
 * collapses "not yours" and "does not exist" into one 404, which is also the
 * shape `pnpm lint:authz` requires of a resource-ID route.
 */

export type BodyReferenceParams = { id: string };
export type BodyReferenceSlotParams = { id: string; slot: string };

export type OwnedCharacter = NonNullable<Awaited<ReturnType<typeof findOwnedCharacter>>>;

export const ownedCharacter = async (user: { id: string }, params: BodyReferenceParams) =>
  (await findOwnedCharacter(params.id, user.id)) ?? null;

/**
 * The slot named by the URL, or null for one the vocabulary has no entry for —
 * a 404 like an unknown character, which is also how a third image is refused:
 * there is no third slot to put it in.
 */
export function parseSlotParam(params: { slot: string }): BodyReferenceSlot | null {
  return parseBodyReferenceSlot(params.slot);
}

/** What the owner reads when a body-image write did nothing. */
export const bodyReferenceWriteMessages = {
  not_found: "This character is no longer available.",
  ineligible:
    "Undressed body images require a recognized adult apparent age. Update the character profile, or tag the image Clothed.",
  changed: "This body image changed elsewhere. Refresh, then try again.",
} as const;

/**
 * One body-image write's response: the set it left behind, or the refusal as a
 * recoverable status. A changed set marks the reference views out of date and
 * builds nothing, so nothing here is ever charged.
 */
export function bodyReferenceWriteResponse(result: BodyReferenceWriteResult, created = false): Response {
  if (result.status === "written") return jsonOk({ bodyReferences: result.set }, created ? 201 : 200);
  if (result.status === "not_found") return jsonError("not_found", bodyReferenceWriteMessages.not_found, 404);
  return jsonError(result.status, bodyReferenceWriteMessages[result.status], 409);
}
