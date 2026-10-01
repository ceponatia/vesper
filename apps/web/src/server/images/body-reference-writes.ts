import { eq } from "drizzle-orm";
import { bodyReferenceWithheld, type BodyReferenceSet, type BodyReferenceSlot, type BodyReferenceTag, type CharacterProfile } from "@/contracts";
import { characterBodyReferences, db } from "../db";
import {
  currentBodyReferenceRows,
  readOwnedBodyReferenceProfile,
  summarizeBodyReferences,
  type BodyReferenceRow,
  type BodyReferenceTransaction,
} from "./body-reference-store";
import { referenceViewBuildLive } from "./reference-view-store";

/**
 * Every write to `character_body_references` — upload into a slot, re-tag,
 * remove (`docs/images/pipelines/body-reference-images.md`).
 *
 * Each runs under the CHARACTER row lock, the same lock the reference-view
 * store takes, and names the image the owner saw. Two refusals guard the
 * views:
 *
 * - **`busy`** while a reference-view build is live for the character — a
 *   heartbeat-live leased job or a pending attempt (`referenceViewBuildLive`).
 *   A body image changed under a running build would strand its renders: the
 *   ones not yet reserved are already charged and render nothing, and the ones
 *   already rendering land stale. The view upload refuses the same way.
 * - **`changed`** when the slot no longer holds the image the owner saw.
 *
 * Refusals are values, and a character that is not the caller's is
 * `not_found`, the same not-yours ≡ gone indistinguishability every character
 * surface keeps. Nothing here renders or charges: the views read stale until
 * the owner builds them.
 */

/**
 * Why a write did nothing. `busy`: a reference-view build is live for the
 * character. `changed`: the slot no longer holds the image the owner saw.
 */
export type BodyReferenceWriteRefusal = "not_found" | "busy" | "ineligible" | "changed";

export type BodyReferenceWriteResult =
  | { status: "written"; set: BodyReferenceSet }
  | { status: BodyReferenceWriteRefusal };

/**
 * One body-image write under the character row lock, answering with the set it
 * left behind. The live-build check reads on the same transaction, so a build
 * admitted before the lock is seen and refuses the write, and one admitted after
 * it reads the new set.
 */
function withBodyReferenceLock(
  characterId: string,
  ownerId: string,
  operation: (
    tx: BodyReferenceTransaction,
    profile: CharacterProfile,
    current: BodyReferenceRow[],
  ) => Promise<BodyReferenceWriteRefusal | null>,
): Promise<BodyReferenceWriteResult> {
  return db().transaction(async (tx): Promise<BodyReferenceWriteResult> => {
    const profile = await readOwnedBodyReferenceProfile(characterId, ownerId, tx, undefined, true);
    if (profile === undefined) return { status: "not_found" };
    if (await referenceViewBuildLive(characterId, ownerId, tx)) return { status: "busy" };
    const refusal = await operation(tx, profile, await currentBodyReferenceRows(characterId, tx));
    if (refusal !== null) return { status: refusal };
    return { status: "written", set: summarizeBodyReferences(await currentBodyReferenceRows(characterId, tx), profile) };
  });
}

/** An `unclothed` tag on a character the adult gate refuses — the bare views' own refusal. */
function tagRefused(tag: BodyReferenceTag, profile: CharacterProfile): boolean {
  return bodyReferenceWithheld({ tag }, profile);
}

/**
 * Put an already-saved `body_reference` asset in a slot: fill an empty one, or
 * replace the image the owner saw there (`expectedImageId`, null for empty).
 * The replaced row is RETIRED, not rewritten — its asset is collected by the
 * sweep after the retention window. Nothing is rendered: the views read stale
 * until the owner builds them.
 */
export function installBodyReference(input: {
  characterId: string;
  ownerId: string;
  slot: BodyReferenceSlot;
  imageId: string;
  tag: BodyReferenceTag;
  expectedImageId: string | null;
}): Promise<BodyReferenceWriteResult> {
  return withBodyReferenceLock(input.characterId, input.ownerId, async (tx, profile, current) => {
    if (tagRefused(input.tag, profile)) return "ineligible";
    const occupant = current.find((row) => row.slot === input.slot);
    if ((occupant?.imageId ?? null) !== input.expectedImageId) return "changed";
    if (occupant !== undefined) {
      await tx.update(characterBodyReferences).set({ current: false }).where(eq(characterBodyReferences.id, occupant.id));
    }
    await tx.insert(characterBodyReferences).values({
      characterId: input.characterId,
      slot: input.slot,
      imageId: input.imageId,
      tag: input.tag,
      current: true,
    });
    return null;
  });
}

/** Change the tag of exactly the image the owner saw. The same tag again writes nothing. */
export function retagBodyReference(input: {
  characterId: string;
  ownerId: string;
  slot: BodyReferenceSlot;
  tag: BodyReferenceTag;
  expectedImageId: string;
}): Promise<BodyReferenceWriteResult> {
  return withBodyReferenceLock(input.characterId, input.ownerId, async (tx, profile, current) => {
    if (tagRefused(input.tag, profile)) return "ineligible";
    const occupant = current.find((row) => row.slot === input.slot);
    if (occupant === undefined || occupant.imageId !== input.expectedImageId) return "changed";
    if (occupant.tag === input.tag) return null;
    await tx.update(characterBodyReferences).set({ tag: input.tag }).where(eq(characterBodyReferences.id, occupant.id));
    return null;
  });
}

/** Retire exactly the image the owner saw; its asset waits out the retention window. */
export function removeBodyReference(input: {
  characterId: string;
  ownerId: string;
  slot: BodyReferenceSlot;
  expectedImageId: string;
}): Promise<BodyReferenceWriteResult> {
  return withBodyReferenceLock(input.characterId, input.ownerId, async (tx, _profile, current) => {
    const occupant = current.find((row) => row.slot === input.slot);
    if (occupant === undefined || occupant.imageId !== input.expectedImageId) return "changed";
    await tx.update(characterBodyReferences).set({ current: false }).where(eq(characterBodyReferences.id, occupant.id));
    return null;
  });
}
