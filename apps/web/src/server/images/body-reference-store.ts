import { and, asc, eq, inArray, lt } from "drizzle-orm";
import {
  bodyReferenceAttributes,
  bodyReferenceSlots,
  bodyReferenceTagSchema,
  bodyReferenceWithheld,
  characterProfileSchema,
  emptyBodyReferenceSet,
  emptyCharacterProfile,
  imageAgeAllowsIntimate,
  sendableBodyReferences,
  type BodyReferenceImage,
  type BodyReferenceSet,
  type BodyReferenceSlot,
  type CharacterProfile,
} from "@/contracts";
import { diag, type DiagnosticSink } from "@/contracts/diagnostics";
import { parseOr, parseOrNull } from "@/lib/parse";
import { characterBodyReferences, characters, db, images } from "../db";
import { readImageBytes } from "./asset-storage";

/**
 * A character's BODY REFERENCE IMAGES — the reads of
 * `character_body_references` the reference-view build, the
 * sheet's staleness projection and the studio share
 * (`docs/images/pipelines/body-reference-images.md`).
 *
 * The rules live in `contracts/images/body-references.ts`; this module supplies
 * them with rows. The writes are `body-reference-writes.ts`, which needs the
 * reference-view store's live-build check and so sits above both stores.
 *
 * Refusals are values. A character that is not the caller's reads as one with
 * no images, the same not-yours ≡ gone indistinguishability every character
 * surface keeps.
 */

/** One stored row whose slot or tag left the vocabulary — dropped, never guessed at. */
export const BODY_REFERENCE_UNKNOWN = "images.body_references.unknown_row";

/** A sendable body image whose bytes could not be read; the view renders without it. */
export const BODY_REFERENCE_UNREADABLE = "images.body_references.unreadable";

export type BodyReferenceRow = typeof characterBodyReferences.$inferSelect;
export type BodyReferenceTransaction = Parameters<Parameters<ReturnType<typeof db>["transaction"]>[0]>[0];
export type BodyReferenceExecutor = ReturnType<typeof db> | BodyReferenceTransaction;

function slotOf(value: number): BodyReferenceSlot | null {
  return bodyReferenceSlots.find((slot) => slot === value) ?? null;
}

/** A current row in the vocabulary's terms, or null when its slot or tag left it. */
function imageOf(row: BodyReferenceRow): BodyReferenceImage | null {
  const slot = slotOf(row.slot);
  const tag = parseOrNull(bodyReferenceTagSchema, row.tag);
  return slot === null || tag === null ? null : { slot, imageId: row.imageId, tag };
}

/** Every current row for this character, slot order. */
export async function currentBodyReferenceRows(characterId: string, executor: BodyReferenceExecutor): Promise<BodyReferenceRow[]> {
  return executor
    .select()
    .from(characterBodyReferences)
    .where(and(eq(characterBodyReferences.characterId, characterId), eq(characterBodyReferences.current, true)))
    .orderBy(asc(characterBodyReferences.slot));
}

/**
 * The character's current body images, slot order. Not owner-scoped: callers
 * reach it through a character they have already scoped to its owner.
 */
export async function currentBodyReferenceImages(
  characterId: string,
  executor: BodyReferenceExecutor = db(),
  sink?: DiagnosticSink,
): Promise<BodyReferenceImage[]> {
  const rows = await currentBodyReferenceRows(characterId, executor);
  return rows.flatMap((row) => {
    const image = imageOf(row);
    if (image === null) {
      sink?.push(
        diag("warn", BODY_REFERENCE_UNKNOWN, "a stored body image names a slot or tag the vocabulary dropped", {
          context: { characterId, rowId: row.id, slot: row.slot, tag: row.tag },
        }),
      );
      return [];
    }
    return [image];
  });
}

/**
 * The character's SENDABLE body images right now — what a build would send
 * under this profile's adult gate, slot order. The sheet projection, a
 * reservation and a restoration each key it per view
 * (`referenceViewBodySetKey`), exactly as the build keys what it records.
 */
export async function currentSendableBodyReferences(
  characterId: string,
  profile: Pick<CharacterProfile, "attributes">,
  executor: BodyReferenceExecutor = db(),
): Promise<BodyReferenceImage[]> {
  return sendableBodyReferences(await currentBodyReferenceImages(characterId, executor), profile);
}

/** The owner's character with its parsed profile, or undefined when it is not theirs. */
export async function readOwnedBodyReferenceProfile(
  characterId: string,
  ownerId: string,
  executor: BodyReferenceExecutor,
  sink?: DiagnosticSink,
  lock = false,
): Promise<CharacterProfile | undefined> {
  const query = executor
    .select({ profile: characters.profile })
    .from(characters)
    .where(and(eq(characters.id, characterId), eq(characters.ownerId, ownerId)))
    .limit(1);
  const [row] = lock ? await query.for("update") : await query;
  if (row === undefined) return undefined;
  return parseOr(characterProfileSchema, row.profile ?? {}, emptyCharacterProfile(), sink, "characters.profile");
}

/**
 * Whether this owner's character may hold an `unclothed` image, or undefined
 * when the character is not theirs — the upload's cheap refusal before it
 * processes any bytes. The install asks again under the lock.
 */
export async function readBodyReferenceEligibility(
  characterId: string,
  ownerId: string,
  sink?: DiagnosticSink,
): Promise<{ readonly unclothedAllowed: boolean } | undefined> {
  const profile = await readOwnedBodyReferenceProfile(characterId, ownerId, db(), sink);
  return profile === undefined ? undefined : { unclothedAllowed: imageAgeAllowsIntimate(profile) };
}

export function summarizeBodyReferences(rows: readonly BodyReferenceRow[], profile: CharacterProfile): BodyReferenceSet {
  return {
    images: rows.flatMap((row) => {
      const image = imageOf(row);
      return image === null
        ? []
        : [{ ...image, withheld: bodyReferenceWithheld(image, profile), updatedAt: row.updatedAt.toISOString() }];
    }),
    unclothedAllowed: imageAgeAllowsIntimate(profile),
    attributes: bodyReferenceAttributes(profile.attributes),
    // The route facts are resolved by the sheet read, outside any lock.
    routes: null,
  };
}

/**
 * What the studio's body-image area reads: the images by slot, whether each is
 * withheld by the adult gate, whether an `unclothed` image may be added at all,
 * and the character's body attributes in the registry's words.
 */
export async function getBodyReferenceSet(
  characterId: string,
  ownerId: string,
  sink?: DiagnosticSink,
  executor: BodyReferenceExecutor = db(),
): Promise<BodyReferenceSet> {
  const profile = await readOwnedBodyReferenceProfile(characterId, ownerId, executor, sink);
  if (profile === undefined) return emptyBodyReferenceSet();
  return summarizeBodyReferences(await currentBodyReferenceRows(characterId, executor), profile);
}

// ---------------------------------------------------------------------------
// What a build sends
// ---------------------------------------------------------------------------

/** One sendable body image with its bytes. */
export interface LoadedBodyReference extends BodyReferenceImage {
  readonly buffer: Buffer;
}

export interface BodyReferencesForBuild {
  /**
   * Every sendable image, readable or not — what each view's row records the
   * key of (`referenceViewBodySetKey`), so a row names the set the owner
   * configured rather than the subset that happened to be readable.
   */
  readonly sendable: readonly BodyReferenceImage[];
  /** The sendable images whose bytes were read, slot order. */
  readonly loaded: readonly LoadedBodyReference[];
}

/**
 * The body images one build sends, read ONCE per job like the portrait's bytes.
 *
 * The rows record keys over every SENDABLE image, so they name the set the
 * owner configured rather than the subset that happened to be readable: an image
 * whose bytes are gone is an optional reference that could not be sent, said
 * with a warning, and the views still render from the portrait. Owner-scoped
 * and kind-scoped on the asset read, so a row can only ever send its owner's
 * own body image.
 */
export async function loadBodyReferencesForBuild(input: {
  characterId: string;
  ownerId: string;
  profile: Pick<CharacterProfile, "attributes">;
  sink?: DiagnosticSink;
}): Promise<BodyReferencesForBuild> {
  const sendable = sendableBodyReferences(await currentBodyReferenceImages(input.characterId, db(), input.sink), input.profile);
  const loaded: LoadedBodyReference[] = [];
  for (const image of sendable) {
    const [asset] = await db()
      .select()
      .from(images)
      .where(and(eq(images.id, image.imageId), eq(images.ownerId, input.ownerId), eq(images.kind, "body_reference")))
      .limit(1);
    const buffer = asset?.status === "ready" ? await readImageBytes(asset) : null;
    if (buffer === null) {
      input.sink?.push(
        diag("warn", BODY_REFERENCE_UNREADABLE, "a body image's bytes could not be read, so the views render without it", {
          context: { characterId: input.characterId, imageId: image.imageId, slot: image.slot },
        }),
      );
      continue;
    }
    loaded.push({ ...image, buffer });
  }
  return { sendable, loaded };
}

// ---------------------------------------------------------------------------
// Retention
// ---------------------------------------------------------------------------

/** Retired rows older than `before`, oldest first — the sweep's input. Never a current row. */
export function retiredBodyReferenceRows(before: Date, limit: number): Promise<BodyReferenceRow[]> {
  return db()
    .select()
    .from(characterBodyReferences)
    .where(and(eq(characterBodyReferences.current, false), lt(characterBodyReferences.updatedAt, before)))
    .orderBy(asc(characterBodyReferences.updatedAt))
    .limit(limit);
}

/**
 * Drop retired rows the sweep has collected. Usually already gone — purging the
 * image cascades its row — and this is the backstop for one whose image the
 * kind-guarded purge would not touch, so no retired row lingers past its window.
 */
export async function deleteRetiredBodyReferenceRows(rowIds: readonly string[]): Promise<void> {
  if (rowIds.length === 0) return;
  await db()
    .delete(characterBodyReferences)
    .where(and(inArray(characterBodyReferences.id, [...rowIds]), eq(characterBodyReferences.current, false)));
}
