import { and, desc, eq, inArray, lt, or } from "drizzle-orm";
import type { ImageLabInput, ImageLabInputList } from "@vesper/image-core";
import { db, images } from "../db";
import { type ImageKind, type ImageRow, readImageBytes } from "./asset-storage";

/**
 * Generic owner-scoped image reads — moved out of the Image Lab's render kernel
 * because their
 * meaning is coherent outside any one bench: "this owner's ready image, or
 * nothing". The Lab and the Image Generator both read inputs through here, and
 * the owner predicate is the authorization root — a foreign, unready, or
 * missing image are deliberately indistinguishable, so no caller can confirm
 * another owner's asset exists.
 */

/** One image row, matched on `(id, owner)` — the authorization root. */
export async function ownedImageRow(imageId: string, ownerId: string): Promise<ImageRow | null> {
  const [row] = await db()
    .select()
    .from(images)
    .where(and(eq(images.id, imageId), eq(images.ownerId, ownerId)))
    .limit(1);
  return row ?? null;
}

/** Bytes for one owned, ready image; null for missing, foreign, unready or file-less. */
export async function readOwnedImageBytes(imageId: string, ownerId: string): Promise<Buffer | null> {
  const row = await ownedImageRow(imageId, ownerId);
  if (!row || row.status !== "ready") return null;
  return await readImageBytes(row);
}

/** One ordered input beside its bytes, so a caller never re-pairs parallel arrays. */
interface OrderedLabInput {
  input: ImageLabInput;
  buffer: Buffer;
}

type ReadOrderedInputsResult = { ok: true; ordered: OrderedLabInput[] } | { ok: false; message: string };

/**
 * Every ordered input's bytes, in recorded order, or the message naming the
 * first one that could not be read. Shared by the Lab's probe and controlled
 * runner: both refuse `input_missing` on the same message shape, and both must
 * read owner-scoped — a foreign or unready image is indistinguishable from a
 * missing one on purpose.
 */
export async function readOrderedInputBytes(inputs: ImageLabInputList, ownerId: string): Promise<ReadOrderedInputsResult> {
  const ordered: OrderedLabInput[] = [];
  for (const input of inputs) {
    const bytes = await readOwnedImageBytes(input.imageId, ownerId);
    if (!bytes) {
      return { ok: false, message: `image ${input.imageId} at position ${String(input.position)} could not be read` };
    }
    ordered.push({ input, buffer: bytes });
  }
  return { ok: true, ordered };
}

// ---------------------------------------------------------------------------
// Owned-image sources — the general picker's listing
// ---------------------------------------------------------------------------

/**
 * The source-policy allowlist for the owner-scoped image picker:
 * every stored kind EXCEPT the two pure system-bookkeeping ones. Derived from
 * the column's own enum rather than enumerated, so a new kind joins the picker
 * by default and exclusion stays the deliberate act.
 */
const OWNED_IMAGE_SOURCE_EXCLUDED = ["identity_face_crop", "identity_trial_output"] as const satisfies
  readonly ImageKind[];

export const OWNED_IMAGE_SOURCE_KINDS: readonly ImageKind[] = images.kind.enumValues.filter(
  (kind) => !OWNED_IMAGE_SOURCE_EXCLUDED.some((excluded) => excluded === kind),
);

export function isOwnedImageSourceKind(kind: string): kind is ImageKind {
  return OWNED_IMAGE_SOURCE_KINDS.some((allowed) => allowed === kind);
}

/** How much of a prompt the picker needs for a display label. */
const SOURCE_PROMPT_SNIPPET_CHARS = 140;
export const OWNED_IMAGE_SOURCE_DEFAULT_LIMIT = 60;
export const OWNED_IMAGE_SOURCE_MAX_LIMIT = 200;

/** One picker row: the id plus what a label needs — never bytes, never a path. */
export interface OwnedImageSource {
  id: string;
  kind: ImageKind;
  createdAt: string;
  /** Leading slice of the stored prompt — a label, not the record. */
  prompt: string;
  entityKind: string | null;
  entityId: string | null;
  chatId: string | null;
}

export interface ListOwnedImageSourcesOptions {
  /** Subset of {@link OWNED_IMAGE_SOURCE_KINDS}; the route validates membership. */
  kinds?: readonly ImageKind[];
  limit?: number;
  /** Exclusive `createdAt` cursor — rows strictly older than this. */
  before?: Date;
  /**
   * Tie-break half of the cursor: with `beforeId`, rows AT `before` also list
   * when their id sorts below it, so a page boundary that lands inside a set of
   * same-instant rows loses nothing. Ignored without `before`.
   */
  beforeId?: string;
}

/**
 * This owner's ready images, newest first — the sources an admin may point a
 * render input at. Ready-only because a pending or failed row has no bytes to
 * send; the entity/chat columns travel so the picker can label a row, and
 * label metadata that is missing degrades to null rather than blocking the
 * listing.
 */
export async function listOwnedImageSources(
  ownerId: string,
  options: ListOwnedImageSourcesOptions = {},
): Promise<OwnedImageSource[]> {
  const kinds = options.kinds && options.kinds.length > 0 ? options.kinds : OWNED_IMAGE_SOURCE_KINDS;
  const limit = Math.min(Math.max(1, options.limit ?? OWNED_IMAGE_SOURCE_DEFAULT_LIMIT), OWNED_IMAGE_SOURCE_MAX_LIMIT);
  const rows = await db()
    .select({
      id: images.id,
      kind: images.kind,
      createdAt: images.createdAt,
      prompt: images.prompt,
      entityKind: images.entityKind,
      entityId: images.entityId,
      chatId: images.chatId,
    })
    .from(images)
    .where(
      and(
        eq(images.ownerId, ownerId),
        eq(images.status, "ready"),
        inArray(images.kind, [...kinds]),
        // Compound (createdAt, id) cursor when the caller supplies both halves;
        // the plain exclusive createdAt cursor otherwise.
        options.before === undefined
          ? undefined
          : options.beforeId === undefined
            ? lt(images.createdAt, options.before)
            : or(
                lt(images.createdAt, options.before),
                and(eq(images.createdAt, options.before), lt(images.id, options.beforeId)),
              ),
      ),
    )
    // The id is the deterministic tie-break within one createdAt instant — the
    // order the compound cursor above resumes from exactly.
    .orderBy(desc(images.createdAt), desc(images.id))
    .limit(limit);
  return rows.map((row) => ({
    id: row.id,
    kind: row.kind,
    createdAt: row.createdAt.toISOString(),
    prompt: row.prompt.slice(0, SOURCE_PROMPT_SNIPPET_CHARS),
    entityKind: row.entityKind,
    entityId: row.entityId,
    chatId: row.chatId,
  }));
}
