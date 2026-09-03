import { z } from "zod";

/**
 * PURE. Portrait acceptance: whether the portrait a character currently shows is
 * the one its identity is derived from.
 *
 * Two stored pointers say it (`characters.avatar_image_id`, the candidate on
 * screen, and `characters.accepted_avatar_image_id`, the identity source), and
 * three surfaces have to agree about what the pair means: the accept routes, the
 * character read, and the portrait studio's badge. So the projection is written
 * once, here, and the two columns are never compared at a call site.
 *
 * `isCurrent` is a derived answer, not a stored flag — acceptance is a claim
 * about an image ID and stays valid while the owner tries a different candidate,
 * which is the whole point of keeping the two pointers apart.
 */
export const characterPortraitAcceptanceSchema = z.object({
  /** The accepted portrait's image id; null when nothing has been accepted. */
  acceptedImageId: z.string().nullable(),
  /** When it was accepted, ISO-8601; null exactly when `acceptedImageId` is. */
  acceptedAt: z.string().nullable(),
  /** The candidate on screen IS the accepted portrait. */
  isCurrent: z.boolean(),
});

export type CharacterPortraitAcceptance = z.infer<typeof characterPortraitAcceptanceSchema>;

/** Nothing accepted — the schema default, and what a failed read degrades to. */
export function emptyCharacterPortraitAcceptance(): CharacterPortraitAcceptance {
  return { acceptedImageId: null, acceptedAt: null, isCurrent: false };
}

export interface CharacterPortraitAcceptanceInput {
  /** `characters.avatar_image_id` — the candidate. */
  avatarImageId: string | null;
  /** `characters.accepted_avatar_image_id` — the identity source. */
  acceptedAvatarImageId: string | null;
  /** `characters.accepted_at`, as stored (a Date column) or already serialized. */
  acceptedAt: Date | string | null;
}

/**
 * The two columns as the one acceptance value every surface reads.
 *
 * A null accepted pointer is never "current", even against a null candidate: a
 * character with no portrait at all has accepted nothing, and reporting that
 * pair as current would tell the studio a picture nobody has is the identity
 * source.
 */
export function projectPortraitAcceptance(input: CharacterPortraitAcceptanceInput): CharacterPortraitAcceptance {
  const acceptedImageId = input.acceptedAvatarImageId;
  return {
    acceptedImageId,
    acceptedAt:
      acceptedImageId === null || input.acceptedAt === null
        ? null
        : typeof input.acceptedAt === "string"
          ? input.acceptedAt
          : input.acceptedAt.toISOString(),
    isCurrent: acceptedImageId !== null && acceptedImageId === input.avatarImageId,
  };
}
