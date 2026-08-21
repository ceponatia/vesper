import { and, eq, inArray } from "drizzle-orm";
import { z } from "zod";
import { characters, db, items } from "../db";
import { isDemoMode } from "../ai";
import { logEvent } from "../events";
import { runInBatches } from "@/lib/batches";
import { parseOr } from "@/lib/parse";
import { outfitItems } from "@/contracts";
import { IMAGE_TARGET_ASPECT, type ImageSourceRevision } from "@vesper/image-core";
import { resolveImageProfileForTask } from "./model-profiles";
import { renderAttemptMeta, renderImageIntent } from "./render-intent";
import { characterProfileSchema, emptyCharacterProfile } from "@/contracts/world/profile";
import { diag, type DiagnosticSink } from "@/contracts/diagnostics";
import { standaloneCharacterReadToken } from "@/contracts/images/subject-digest";
import { IMAGE_ITEM_PROJECTION_OWNER } from "@/contracts/images/world-projection";
import { resolveGarmentVisibility } from "@/contracts/items/visibility";
import { clothingSubtypeLabel } from "@/contracts/items/subtypes";
import { runImagePipeline } from "./assets";
import { buildAvatarSegments, type AvatarSegmentAssembly, type AvatarSegmentAssemblyInput } from "./avatar-segments";
import { queueIdentityPackPreparation } from "./identity-pack-preparation";
import { monogramSvg } from "./monogram";
import {
  type AvatarStyle,
  type AvatarWardrobeItem,
  toWornInputs,
  wardrobeGarmentKey,
} from "./prompts-avatar";
import { type SceneWornItem, wardrobeOutfitSummary } from "./prompts-scene-composer";

export interface GenerateAvatarInput {
  characterId: string;
  userId: string;
  style?: AvatarStyle;
  /** Registry model id from the portrait studio; absent uses the surface default. */
  modelId?: string;
  sink?: DiagnosticSink;
}

/**
 * A refused avatar render's diagnostic: the standalone visual digest could not
 * make the character render-eligible — a required fact resolved no clause, or
 * the assembly itself failed. The row is failed BEFORE any provider spend
 * (spec.prompts.md §Failure behavior); production never falls back to the
 * legacy prose builder.
 */
export const AVATAR_DIGEST_INELIGIBLE = "images.avatar.visual_digest_ineligible";

/**
 * The pure segment assembly, run at the route boundary: a throw here is a
 * defect, but the resilient shape is a failed row carrying a diagnostic, not a
 * lost turn — so it degrades to `null` and the pipeline refuses pre-spend.
 *
 * Typed as the assembly's OWN input (minus the sink, threaded separately) so a
 * degradation flag like `wardrobeUnavailable` can never be silently dropped at
 * this seam — an inline retype here once omitted it, and a refactor could have
 * reverted the failed-load-renders-topless fix with no type error.
 */
function tryBuildAvatarSegments(
  input: Omit<AvatarSegmentAssemblyInput, "sink">,
  sink?: DiagnosticSink,
): AvatarSegmentAssembly | null {
  try {
    return buildAvatarSegments({ ...input, ...(sink === undefined ? {} : { sink }) });
  } catch (err) {
    sink?.push(
      diag("warn", AVATAR_DIGEST_INELIGIBLE, "avatar segment assembly failed", {
        path: "images.avatar",
        context: {
          characterId: input.characterId,
          error: err instanceof Error ? err.message.slice(0, 300) : String(err).slice(0, 300),
        },
      }),
    );
    return null;
  }
}

/** The refusal text for an ineligible digest, or null when the render may proceed. */
function avatarDigestRefusal(
  assembly: AvatarSegmentAssembly | null,
  characterId: string,
  sink?: DiagnosticSink,
): string | null {
  if (assembly === null) return "the avatar's visual digest could not be assembled";
  if (assembly.missingRequired.length === 0) return null;
  sink?.push(
    diag("warn", AVATAR_DIGEST_INELIGIBLE, "a required visual fact resolved no prompt clause", {
      path: "images.avatar",
      context: { characterId, missingRequired: [...assembly.missingRequired] },
    }),
  );
  return "the avatar's visual digest is missing required facts";
}

/**
 * Avatar pipeline: the standalone visual digest's semantic segments → the
 * picked registry model's text-to-image (3:4), or monogram in demo mode,
 * through the shared reserve/save/fail lifecycle.
 *
 * The profile is resolved BEFORE the pipeline reserves a row so the row's meta
 * can record which model produced it. A pick that is no longer offered degrades
 * to the portrait task's default rather than failing (owner ruling 5).
 *
 * The digest's `meta.visualState` provenance is attached at RESERVE time,
 * beside `style`/`model`/`demo`: a thrown produce carries no meta, and the
 * visual moment that shaped the prompt must survive a failed render.
 */
export async function generateAvatar(input: GenerateAvatarInput): Promise<string> {
  const style = input.style ?? "realistic";
  const demo = isDemoMode();
  const resolved = demo ? null : await resolveImageProfileForTask("portrait", input.modelId, input.sink);
  const model = resolved?.model ?? null;
  const [character] = await db().select().from(characters).where(eq(characters.id, input.characterId)).limit(1);
  const profile = parseOr(
    characterProfileSchema,
    character?.profile ?? {},
    emptyCharacterProfile(),
    input.sink,
    "characters.profile",
  );
  const load = character
    ? await loadDefaultWardrobeWithRevisions(input.userId, outfitItems(profile), input.sink)
    : { wardrobe: [], revisions: [] };
  const assembly = character
    ? tryBuildAvatarSegments(
        {
          characterId: input.characterId,
          name: character.name,
          profile,
          style,
          wardrobe: load.wardrobe,
          ...(load.failed === true ? { wardrobeUnavailable: true } : {}),
          ...((load.coverageUnreliableIds?.length ?? 0) > 0 ? { coverageUnreliable: true } : {}),
          // The character row's own revision plus every wardrobe row read for
          // this render — an edit to either mints a different token.
          readToken: standaloneCharacterReadToken({
            characterId: input.characterId,
            revision: character.updatedAt.toISOString(),
            extraRevisions: load.revisions,
          }),
        },
        input.sink,
      )
    : null;
  const digestRefusal = character ? avatarDigestRefusal(assembly, input.characterId, input.sink) : null;
  const prompt = assembly?.prompt ?? "";

  const { imageId } = await runImagePipeline({
    asset: {
      ownerId: input.userId,
      kind: "avatar",
      entityKind: "character",
      entityId: input.characterId,
      prompt,
      meta: {
        style,
        model: demo ? "demo" : `replicate/${model?.slug ?? "none"}`,
        demo,
        ...(assembly?.digestMeta ?? {}),
      },
    },
    failedPrecondition: character
      ? (digestRefusal ??
        (demo || model ? null : "no image model is registered for portraits"))
      : `character ${input.characterId} not found`,
    // Text-to-image at Vesper's 3:4, with no references — the simplest intent
    // there is. The semantic segments are authoritative; `prompt` is the same
    // segments compiled, stored on the row and carried as the intent's string
    // form. A failure still THROWS (this lane's ruled failure shape: the
    // shell's warn diagnostic plus the error-carrying event line), which is why
    // render provenance is recorded only on success — a thrown produce has no
    // meta channel. The digest provenance already landed at reserve time.
    produce: async () => {
      if (demo || !resolved) return { ok: true, image: monogramSvg(character?.name ?? "") };
      const result = await renderImageIntent(
        {
          profile: resolved,
          prompt,
          ...(assembly ? { promptSegments: assembly.segments } : {}),
          references: [],
          target: { aspectRatio: IMAGE_TARGET_ASPECT },
        },
        input.sink,
      );
      if (!result.ok || !result.image) throw new Error(result.error ?? `${resolved.model.slug} returned no image`);
      return { ok: true, image: result.image, ...renderAttemptMeta(result.attempt) };
    },
    onReady: async (asset) => {
      await db().update(characters).set({ avatarImageId: asset.id }).where(eq(characters.id, input.characterId));
      // Strictly AFTER the canonical pointer commits, and strictly best-effort:
      // identity-pack preparation must never fail or delay a valid portrait
      // (image-identity-packs.spec.lifecycle.md §"Creation after a canonical
      // portrait"). Returns void, so nothing here can reject.
      queueIdentityPackPreparation(input.characterId, input.userId);
    },
    onSettled: ({ imageId: id, status, startedMs }) =>
      void logEvent("image.avatar", {
        imageId: id,
        characterId: input.characterId,
        status,
        demo,
        durationMs: Date.now() - startedMs,
      }),
    onThrown: ({ imageId: id, message }) =>
      void logEvent("image.avatar", {
        imageId: id,
        characterId: input.characterId,
        status: "failed",
        error: message.slice(0, 300),
      }),
    failureDiagnostic: { code: "images.avatar.generate_failed", context: { characterId: input.characterId } },
    sink: input.sink,
  });
  return imageId;
}

/**
 * A `coverage` column that is PRESENT but unparseable reads as this sentinel,
 * never as `[]`: covers-nothing is a positive bare claim, and a malformed row
 * is unknown state (the PR #152 bug class — bad data must not undress the body
 * it dresses). An ABSENT column keeps today's covers-nothing read: authored
 * silence, not damage.
 */
const COVERAGE_UNREADABLE = "unreadable";

const outfitExtrasSchema = z.object({
  coverage: z
    .union([z.array(z.string()), z.unknown().transform((): typeof COVERAGE_UNREADABLE => COVERAGE_UNREADABLE)])
    .optional(),
  layer: z
    .union([z.literal(0), z.literal(1), z.literal(2), z.literal(3)])
    .optional()
    .catch(undefined),
  opacity: z.enum(["opaque", "sheer"]).catch("opaque"),
  sensory: z.object({ appearance: z.string().optional() }).optional().catch(undefined),
  subtype: z.string().optional().catch(undefined),
  category: z.string().optional().catch(undefined),
  tags: z.array(z.string()).catch([]),
});

/** The default outfit plus each row's revision — the read-token's wardrobe half. */
export interface AvatarWardrobeLoad {
  wardrobe: AvatarWardrobeItem[];
  /** One `items.updatedAt` revision per loaded row, in wardrobe order. */
  revisions: ImageSourceRevision[];
  /**
   * The lookup THREW — the empty wardrobe above is unknown state, not a
   * confirmed undressed character. The segment assembly must not turn it into
   * exposure claims; it degrades to the attributes-only prompt instead.
   */
  failed?: boolean;
  /**
   * Loaded rows whose `coverage` column could not be parsed — their
   * `coverage: []` above is unknown state, not covers-nothing. Exposure
   * computed over a wardrobe containing one of these must degrade toward
   * covered, never read the regions those garments actually cover as bare
   * (`images.avatar.coverage_unreadable` fires at the load site). Absent when
   * every row parsed.
   */
  coverageUnreliableIds?: string[];
}

/**
 * Load the character's default outfit as raw coverage-bearing wardrobe items,
 * plus the item-row revisions the standalone read token folds in — so an edit
 * to a worn item mints a new token rather than reusing the old composition's
 * name. Degrades to an empty load (attributes-only prompt) with a diagnostic.
 */
export async function loadDefaultWardrobeWithRevisions(
  ownerId: string,
  itemIds: readonly string[],
  sink?: DiagnosticSink,
): Promise<AvatarWardrobeLoad> {
  if (itemIds.length === 0) return { wardrobe: [], revisions: [] };
  try {
    const rows = await db()
      .select({
        id: items.id,
        name: items.name,
        description: items.description,
        definition: items.definition,
        updatedAt: items.updatedAt,
      })
      .from(items)
      .where(and(eq(items.ownerId, ownerId), inArray(items.id, [...itemIds])));
    const byId = new Map(rows.map((row) => [row.id, row]));
    const wardrobe: AvatarWardrobeItem[] = [];
    const revisions: ImageSourceRevision[] = [];
    const coverageUnreliableIds: string[] = [];
    for (const id of itemIds) {
      const row = byId.get(id);
      if (!row) continue;
      const parsed = outfitExtrasSchema.safeParse(row.definition ?? {});
      const extras = parsed.success ? parsed.data : outfitExtrasSchema.parse({});
      // Unparseable coverage (or an unparseable definition wholesale) loads the
      // item with no coverage rows, and the LOAD carries the id — so exposure
      // consumers degrade toward covered instead of reading a bare region off a
      // row nobody could parse.
      const coverageUnreadable = !parsed.success || extras.coverage === COVERAGE_UNREADABLE;
      if (coverageUnreadable) coverageUnreliableIds.push(row.id);
      const coverage =
        extras.coverage === undefined || extras.coverage === COVERAGE_UNREADABLE ? [] : extras.coverage;
      const description = row.description?.trim() ?? "";
      wardrobe.push({
        id: row.id,
        name: row.name,
        coverage,
        layer: extras.layer,
        opacity: extras.opacity,
        ...(description ? { description } : {}),
        ...(extras.sensory?.appearance ? { appearance: extras.sensory.appearance } : {}),
        ...(extras.subtype ? { subtype: extras.subtype } : {}),
        ...(extras.category ? { category: extras.category } : {}),
        ...(extras.tags.length > 0 ? { tags: extras.tags } : {}),
      });
      revisions.push({ owner: IMAGE_ITEM_PROJECTION_OWNER, entityId: row.id, revision: row.updatedAt.toISOString() });
    }
    if (coverageUnreliableIds.length > 0) {
      sink?.push(
        diag("warn", "images.avatar.coverage_unreadable", "worn item coverage column unreadable — exposure degrades toward covered", {
          path: "items.definition.coverage",
          context: { itemIds: coverageUnreliableIds },
        }),
      );
    }
    return { wardrobe, revisions, ...(coverageUnreliableIds.length > 0 ? { coverageUnreliableIds } : {}) };
  } catch (err) {
    sink?.push(
      diag("warn", "images.avatar.outfit_load_failed", "default outfit lookup failed — avatar prompt degrades to attributes only", {
        path: "items",
        context: {
          itemIds: [...itemIds],
          error: err instanceof Error ? err.message.slice(0, 300) : String(err).slice(0, 300),
        },
      }),
    );
    return { wardrobe: [], revisions: [], failed: true };
  }
}

/** Render the occlusion-filtered default outfit as one readable prompt phrase. */
export function wardrobeOutfitText(wardrobe: ReadonlyArray<AvatarWardrobeItem>): string {
  if (wardrobe.length === 0) return "";
  const byGarment = resolveGarmentVisibility(toWornInputs(wardrobe));
  const worn = wardrobe.flatMap((item, index): SceneWornItem[] => {
    const visibility = byGarment.get(wardrobeGarmentKey(item, index));
    if (visibility === undefined || visibility === "hidden") return [];
    const subtypeLabel = clothingSubtypeLabel(item.subtype);
    return [
      {
        name: item.name,
        visibility: visibility === "hinted" ? "hinted" : "visible",
        ...(item.description ? { description: item.description } : {}),
        ...(item.appearance ? { appearance: item.appearance } : {}),
        ...(subtypeLabel ? { subtypeLabel } : {}),
      },
    ];
  });
  return wardrobeOutfitSummary(worn);
}

/** Resolve default outfit item ids to the readable phrase used by chat seeding. */
export async function defaultOutfitPhrase(
  ownerId: string,
  itemIds: readonly string[],
  sink?: DiagnosticSink,
): Promise<string> {
  if (itemIds.length === 0) return "";
  // Phrase read only: a failed load's empty phrase degrades to composer
  // inference, and the load reports itself — the failure marker has no consumer
  // here. Exposure/mint consumers must read the full load instead.
  return wardrobeOutfitText((await loadDefaultWardrobeWithRevisions(ownerId, itemIds, sink)).wardrobe);
}

const AVATAR_BATCH_SIZE = 5;

/** Generate avatars in bounded parallel batches; one failure never aborts the batch. */
export async function generateAvatarsBatch(
  characterIds: readonly string[],
  userId: string,
  sink?: DiagnosticSink,
): Promise<number> {
  return runInBatches(characterIds, AVATAR_BATCH_SIZE, (characterId) => generateAvatar({ characterId, userId, sink }));
}
