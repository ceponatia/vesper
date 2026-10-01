import { and, asc, eq, inArray, lt } from "drizzle-orm";
import {
  bodyReferenceAttributes,
  bodyReferenceSetKey,
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
  type BodyReferenceTag,
  type CharacterProfile,
} from "@/contracts";
import { diag, type DiagnosticSink } from "@/contracts/diagnostics";
import { parseOr, parseOrNull } from "@/lib/parse";
import { characterBodyReferences, characters, db, images } from "../db";
import { readImageBytes } from "./asset-storage";

/**
 * A character's BODY REFERENCE IMAGES — every write to
 * `character_body_references`, and the reads the reference-view build, the
 * sheet's staleness projection and the studio share
 * (`docs/images/pipelines/reference-views.md` §Body reference images).
 *
 * The rules live in `contracts/images/body-references.ts`; this module supplies
 * them with rows. Every write runs under the CHARACTER row lock — the same lock
 * the reference-view store takes — so a change of body images and a view's
 * reservation cannot interleave: a reservation sees the set its worker read, or
 * refuses.
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
type BodyReferenceTransaction = Parameters<Parameters<ReturnType<typeof db>["transaction"]>[0]>[0];
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
async function currentBodyReferenceRows(characterId: string, executor: BodyReferenceExecutor): Promise<BodyReferenceRow[]> {
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
 * The character's body-image set RIGHT NOW (`bodyReferenceSetKey`): what a
 * build would send under this profile's adult gate, or null for none. The one
 * spelling the sheet projection, a reservation and a restoration compare
 * against.
 */
export async function currentBodyReferenceSetKey(
  characterId: string,
  profile: Pick<CharacterProfile, "attributes">,
  executor: BodyReferenceExecutor = db(),
): Promise<string | null> {
  return bodyReferenceSetKey(sendableBodyReferences(await currentBodyReferenceImages(characterId, executor), profile));
}

/** The owner's character with its parsed profile, or undefined when it is not theirs. */
async function readOwnedProfile(
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
  const profile = await readOwnedProfile(characterId, ownerId, db(), sink);
  return profile === undefined ? undefined : { unclothedAllowed: imageAgeAllowsIntimate(profile) };
}

function summarize(rows: readonly BodyReferenceRow[], profile: CharacterProfile): BodyReferenceSet {
  return {
    images: rows.flatMap((row) => {
      const image = imageOf(row);
      return image === null
        ? []
        : [{ ...image, withheld: bodyReferenceWithheld(image, profile), updatedAt: row.updatedAt.toISOString() }];
    }),
    unclothedAllowed: imageAgeAllowsIntimate(profile),
    attributes: bodyReferenceAttributes(profile.attributes),
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
  const profile = await readOwnedProfile(characterId, ownerId, executor, sink);
  if (profile === undefined) return emptyBodyReferenceSet();
  return summarize(await currentBodyReferenceRows(characterId, executor), profile);
}

// ---------------------------------------------------------------------------
// What a build sends
// ---------------------------------------------------------------------------

/** One sendable body image with its bytes. */
export interface LoadedBodyReference extends BodyReferenceImage {
  readonly buffer: Buffer;
}

export interface BodyReferencesForBuild {
  /** The set the build's rows record — every sendable image, readable or not. */
  readonly setKey: string | null;
  /** The sendable images whose bytes were read, slot order. */
  readonly loaded: readonly LoadedBodyReference[];
}

/**
 * The body images one build sends, read ONCE per job like the portrait's bytes.
 *
 * The set key covers every SENDABLE image, so the rows record the set the owner
 * configured rather than the subset that happened to be readable: an image
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
  return { setKey: bodyReferenceSetKey(sendable), loaded };
}

// ---------------------------------------------------------------------------
// Writes
// ---------------------------------------------------------------------------

/** Why a write did nothing. `changed`: the slot no longer holds the image the owner saw. */
export type BodyReferenceWriteRefusal = "not_found" | "ineligible" | "changed";

export type BodyReferenceWriteResult =
  | { status: "written"; set: BodyReferenceSet }
  | { status: BodyReferenceWriteRefusal };

/**
 * One body-image write under the character row lock, answering with the set it
 * left behind. The lock is the reference-view store's own, so a reservation
 * reading the set and this write changing it are serialized.
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
    const profile = await readOwnedProfile(characterId, ownerId, tx, undefined, true);
    if (profile === undefined) return { status: "not_found" };
    const refusal = await operation(tx, profile, await currentBodyReferenceRows(characterId, tx));
    if (refusal !== null) return { status: refusal };
    return { status: "written", set: summarize(await currentBodyReferenceRows(characterId, tx), profile) };
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
