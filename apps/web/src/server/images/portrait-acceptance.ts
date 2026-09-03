import { and, eq } from "drizzle-orm";
import { type CharacterPortraitAcceptance, projectPortraitAcceptance } from "@/contracts";
import { log } from "@/server/log";
import { characters, db } from "../db";
import { queueIdentityPackPreparation } from "./identity-pack-preparation";

/**
 * Portrait acceptance: the owner's decision that the portrait on screen is the
 * character's identity source.
 *
 * The two pointers this writes are the whole feature. `avatar_image_id` moves
 * whenever a portrait is generated, uploaded, promoted or cloned;
 * `accepted_avatar_image_id` moves only here. Everything identity-sensitive —
 * the identity pack and its crop editor, chat looks, scene cast anchors, the
 * lab's identity reference — reads the accepted pointer, so an unaccepted
 * candidate changes nothing about how a character is recognized.
 *
 * Accepting is also the ONE production trigger for identity-pack preparation:
 * the pack derives from the accepted portrait, so nothing else has a source to
 * derive from. Every refusal here is a value with a code (docs/resilience.md);
 * nothing throws on a request the schema allowed.
 */

/** The columns acceptance is projected from, read under the owner. */
async function readAcceptanceRow(characterId: string, ownerId: string) {
  const [row] = await db()
    .select({
      avatarImageId: characters.avatarImageId,
      acceptedAvatarImageId: characters.acceptedAvatarImageId,
      acceptedAt: characters.acceptedAt,
    })
    .from(characters)
    .where(and(eq(characters.id, characterId), eq(characters.ownerId, ownerId)))
    .limit(1);
  return row;
}

/**
 * The character's acceptance state, or `null` when the character is not this
 * user's — the same not-yours ≡ gone indistinguishability every character
 * surface keeps.
 */
export async function readPortraitAcceptance(
  characterId: string,
  ownerId: string,
): Promise<CharacterPortraitAcceptance | null> {
  const row = await readAcceptanceRow(characterId, ownerId);
  return row === undefined ? null : projectPortraitAcceptance(row);
}

export interface AcceptPortraitInput {
  ownerId: string;
  characterId: string;
  /** The image the owner is looking at. Only this exact candidate may be accepted. */
  imageId: string;
}

export type AcceptPortraitResult =
  /** The identity source moved to `imageId`; pack preparation was queued. */
  | { status: "accepted"; acceptance: CharacterPortraitAcceptance }
  /** `imageId` was already the accepted portrait: nothing written, nothing queued. */
  | { status: "unchanged"; acceptance: CharacterPortraitAcceptance }
  /**
   * `imageId` is not the character's current candidate — a request written
   * against a portrait that has since been replaced. It travels with the CURRENT
   * acceptance so the client can show what is actually on screen instead of
   * asking again for the state it just lost.
   */
  | { status: "conflict"; acceptance: CharacterPortraitAcceptance }
  | { status: "not_found" };

/**
 * Accept the named candidate as the character's identity source.
 *
 * The request names the image deliberately: a stale Accept must never accept
 * whatever portrait happens to be current now, so the id is checked before the
 * write AND carried into the write's `WHERE` clause. A guarded UPDATE that
 * touches no row means the candidate moved between the two, which is the same
 * answer as a stale id — the owner reviews the portrait that is actually there
 * and accepts again.
 *
 * Preparation is queued strictly AFTER the pointer commits (the ordering
 * `queueIdentityPackPreparation` documents), fire-and-forget: a pack that cannot
 * be derived must never fail an acceptance the owner made.
 */
export async function acceptPortrait(input: AcceptPortraitInput): Promise<AcceptPortraitResult> {
  const { ownerId, characterId, imageId } = input;
  const row = await readAcceptanceRow(characterId, ownerId);
  if (row === undefined) return { status: "not_found" };

  if (row.avatarImageId !== imageId) {
    log.warn("images", "portrait acceptance rejected: the request names a portrait that is not current", {
      code: "images.portrait_acceptance.portrait_changed",
      characterId,
      requestedImageId: imageId,
      currentImageId: row.avatarImageId,
    });
    return { status: "conflict", acceptance: projectPortraitAcceptance(row) };
  }
  // Accepting what is already accepted is a no-op, not a re-derivation: the pack
  // for these bytes either exists or is already being prepared, and a second
  // trigger would only buy another job row.
  if (row.acceptedAvatarImageId === imageId) return { status: "unchanged", acceptance: projectPortraitAcceptance(row) };

  const [updated] = await db()
    .update(characters)
    .set({ acceptedAvatarImageId: imageId, acceptedAt: new Date() })
    .where(
      and(
        eq(characters.id, characterId),
        eq(characters.ownerId, ownerId),
        // The compare-and-set: the candidate must still be the one the owner
        // reviewed at the moment the row is written.
        eq(characters.avatarImageId, imageId),
      ),
    )
    .returning({
      avatarImageId: characters.avatarImageId,
      acceptedAvatarImageId: characters.acceptedAvatarImageId,
      acceptedAt: characters.acceptedAt,
    });
  if (updated === undefined) {
    const current = await readAcceptanceRow(characterId, ownerId);
    if (current === undefined) return { status: "not_found" };
    log.warn("images", "portrait acceptance lost the race: the candidate moved mid-request", {
      code: "images.portrait_acceptance.portrait_changed",
      characterId,
      requestedImageId: imageId,
    });
    return { status: "conflict", acceptance: projectPortraitAcceptance(current) };
  }

  queueIdentityPackPreparation(characterId, ownerId);
  return { status: "accepted", acceptance: projectPortraitAcceptance(updated) };
}

export type ClearPortraitAcceptanceResult =
  | { status: "cleared"; acceptance: CharacterPortraitAcceptance }
  | { status: "not_found" };

/**
 * Withdraw acceptance: the character keeps its candidate portrait and stops
 * having an identity source.
 *
 * It deletes nothing — not the portrait, not the pack rows, not the crop. Every
 * pack read compares against the accepted pointer, so a null pointer already
 * reads as "no usable identity reference" and the identity-critical lanes return
 * their existing refusal. Re-accepting the same portrait later reuses the
 * revision that still describes those bytes.
 */
export async function clearPortraitAcceptance(
  characterId: string,
  ownerId: string,
): Promise<ClearPortraitAcceptanceResult> {
  const [updated] = await db()
    .update(characters)
    .set({ acceptedAvatarImageId: null, acceptedAt: null })
    .where(and(eq(characters.id, characterId), eq(characters.ownerId, ownerId)))
    .returning({
      avatarImageId: characters.avatarImageId,
      acceptedAvatarImageId: characters.acceptedAvatarImageId,
      acceptedAt: characters.acceptedAt,
    });
  if (updated === undefined) return { status: "not_found" };
  return { status: "cleared", acceptance: projectPortraitAcceptance(updated) };
}
