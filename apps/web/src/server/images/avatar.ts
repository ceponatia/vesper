import { and, eq, inArray } from "drizzle-orm";
import { z } from "zod";
import { characters, db, items } from "../db";
import { isDemoMode, qualifiedImageModelIdentity } from "../ai";
import { logEvent } from "../events";
import { runInBatches } from "@/lib/batches";
import { parseOr } from "@/lib/parse";
import { outfitItems, type SceneCameraSpec } from "@/contracts";
import { IMAGE_TARGET_ASPECT, type ImageSourceRevision, type ResolvedImageProfile } from "@vesper/image-core";
import { resolveImageProfileForTask } from "./model-profiles";
import { renderAttemptMeta, renderImageIntent } from "./render-intent";
import { characterProfileSchema, emptyCharacterProfile } from "@/contracts/world/profile";
import { diag, type DiagnosticSink } from "@/contracts/diagnostics";
import { standaloneCharacterReadToken } from "@/contracts/images/subject-digest";
import { IMAGE_ITEM_PROJECTION_OWNER } from "@/contracts/images/world-projection";
import { resolveGarmentVisibility } from "@/contracts/items/visibility";
import { clothingSubtypeLabel, hairOcclusionForItem } from "@/contracts/items/subtypes";
import { HAIR_OCCLUSION_NONE, hairOcclusionSchema } from "@/contracts/items/hair-occlusion";
import { runImagePipeline } from "./assets";
import {
  buildCharacterPromptProgram,
  characterPromptTransport,
  characterPromptUnboundRefusal,
  type CharacterPromptProgramResult,
} from "./character-prompt-program";
import { characterPortraitImageOperation } from "@/contracts/images/character-digest";
import { monogramSvg } from "./monogram";
import { type AvatarStyle, type AvatarWardrobeItem, toWornInputs, wardrobeGarmentKey } from "./avatar-wardrobe";
import { type SceneWornItem, wardrobeOutfitSummary } from "./prompts-scene-composer";
import {
  buildStandaloneLaneCut,
  standaloneSubjectPromptCut,
  type StandaloneLaneCutInput,
  type StandaloneSubjectCut,
} from "./standalone-subject-visual";

export interface GenerateAvatarInput {
  characterId: string;
  userId: string;
  style?: AvatarStyle;
  /** Registry model id from the portrait studio; absent uses the surface default. */
  modelId?: string;
  /** Immutable character input reserved before the provider job starts. */
  source?: {
    readonly name: string;
    readonly profile: unknown;
    readonly revision: string;
  };
  sink?: DiagnosticSink;
}

// ---------------------------------------------------------------------------
// The avatar's cut
// ---------------------------------------------------------------------------

/**
 * The portrait studio's fixed viewpoint: facing the camera at medium distance,
 * which `visualCameraReadsOfSceneCamera` maps to the `waist_up` framing band —
 * the frame the selection cuts optional detail to and the adapter states
 * exposure within.
 */
export const AVATAR_PORTRAIT_CAMERA: SceneCameraSpec = {
  orientation: "toward_viewer",
  distance: "medium",
  height: "eye_level",
};

/** The camera id the selection fingerprints — a fixed studio viewpoint, not a committed scene camera. */
export const AVATAR_PORTRAIT_CAMERA_ID = "portrait_studio";

export type AvatarCutInput = StandaloneLaneCutInput;

/**
 * The avatar lane's cut of the character sheet — the standalone cut under the
 * portrait studio's camera. The one call `generateAvatar` makes and the one the
 * lane fixtures re-run without a database, so a test cannot quietly assemble
 * a different avatar than production does. Pure.
 */
export function buildAvatarCut(input: AvatarCutInput): StandaloneSubjectCut {
  return buildStandaloneLaneCut(input, { camera: AVATAR_PORTRAIT_CAMERA, cameraId: AVATAR_PORTRAIT_CAMERA_ID });
}

/**
 * The cut could not be assembled at all — a thrown build. A throw here is a
 * defect, but the resilient shape is a failed row carrying a diagnostic rather
 * than a lost turn, so the row fails BEFORE any provider spend.
 */
export const AVATAR_CUT_FAILED = "images.avatar.visual_cut_failed";

/**
 * The picked model has no active prompt binding for the portrait task and this
 * profile key. The row fails before provider spend naming the three
 * coordinates; nothing else is ever sent in its place.
 */
export const AVATAR_PROGRAM_UNBOUND = "images.avatar.program_unbound";

/**
 * Typed as the cut's OWN input (minus the sink, threaded separately) so a
 * degradation flag like `wardrobeUnavailable` can never be silently dropped at
 * this seam — an inline retype here once omitted it, and a refactor could have
 * reverted the failed-load-renders-topless fix with no type error.
 */
function tryBuildAvatarCut(input: Omit<AvatarCutInput, "sink">, sink?: DiagnosticSink): StandaloneSubjectCut | null {
  try {
    return buildAvatarCut({ ...input, ...(sink === undefined ? {} : { sink }) });
  } catch (err) {
    sink?.push(
      diag("warn", AVATAR_CUT_FAILED, "avatar visual cut failed to assemble", {
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

// ---------------------------------------------------------------------------
// The avatar's program
// ---------------------------------------------------------------------------

/** What the avatar's program is compiled from: the row, its cut, and the picked profile. */
export interface AvatarProgramInput {
  readonly characterId: string;
  readonly characterName: string;
  /** `characters.authoringRevision`, serialized for the shared read-token contract. */
  readonly revision: string;
  /** The wardrobe rows' revisions, folded into the read. */
  readonly extraRevisions: readonly ImageSourceRevision[];
  readonly cut: StandaloneSubjectCut;
  readonly profile: ResolvedImageProfile;
  readonly sink?: DiagnosticSink;
}

/**
 * The avatar lane's prompt program over its cut (issue #256). Pure — the
 * exact call `generateAvatar` makes, exported so the lane fixtures compile a
 * portrait without a database.
 *
 * Every portrait profile the picker offers is bound: the three Qwen Image 2512
 * rows, Seedream 4.5, Seedream 5 Lite, both Stable Diffusion 3.5 Large rows,
 * Wan 2.7, NSFW FLUX Dev, LikeReality Pony and P-Image.
 *
 * Resolution is strict on the profile KEY, because this lane's models bind per
 * profile: 2512 carries three portrait rows (`portrait-standard`,
 * `portrait-fast`, `portrait-quality`) whose packs must stay separately
 * promotable, and SD 3.5 Large carries two. A key with no row resolves
 * `unbound` rather than borrowing a sibling profile's pack pins.
 *
 * No references: every portrait profile's reference policy allows no roles, so
 * a portrait is text-to-image and its identity travels entirely in the digest's
 * own descriptors rather than in an image.
 *
 * The operation states the honest default style — a photographic medium and no
 * descriptors — and the avatar's `realistic`/`stylized` toggle does NOT become
 * style descriptors here: turning it into a style claim would state the medium
 * twice, once in a channel the collision linter cannot reconcile with the
 * pack's rendering intent. The toggle is recorded on the row's meta.
 */
export function buildAvatarProgram(inputs: AvatarProgramInput): CharacterPromptProgramResult {
  const { cut, profile } = inputs;
  return buildCharacterPromptProgram({
    lane: "avatar",
    task: "portrait",
    profile,
    bindingProfileKey: profile.profile.key,
    cuts: [standaloneSubjectPromptCut(cut, { subjectId: inputs.characterId, name: inputs.characterName })],
    read: {
      kind: "standalone_character",
      characters: [{ characterId: inputs.characterId, revision: inputs.revision }],
      extraRevisions: [...inputs.extraRevisions],
    },
    references: [],
    operation: () => characterPortraitImageOperation(),
    // A portrait of a specific character with a lost identity or morphology
    // anchor is a picture of somebody else: the adapter's join-level check
    // fails the row before provider spend.
    refuseOnMissingRequired: true,
    ...(inputs.sink === undefined ? {} : { sink: inputs.sink }),
  });
}

/**
 * The precondition text a program answer fails the row with, or null for a
 * compiled program. A refusal already pushed its own diagnostic at the seam;
 * `unbound` pushes the lane's here, because the seam records nothing for an
 * ordinary "no row".
 */
function avatarProgramPrecondition(
  program: CharacterPromptProgramResult,
  characterId: string,
  sink?: DiagnosticSink,
): string | null {
  if (program.kind === "compiled") return null;
  if (program.kind === "refused") return program.refusal;
  sink?.push(
    diag("warn", AVATAR_PROGRAM_UNBOUND, "the picked model has no active prompt binding for the portrait task", {
      path: "images.avatar",
      context: { characterId, model: program.modelSlug, task: program.task, profileKey: program.profileKey },
    }),
  );
  return characterPromptUnboundRefusal(program);
}

/**
 * Avatar pipeline: the standalone visual cut compiled through the picked
 * profile's prompt program → that model's text-to-image (3:4), or monogram in
 * demo mode, through the shared reserve/save/fail lifecycle.
 *
 * The compiled program is the ONLY prompt this lane has. A render that compiles
 * none — a refused program, an unbound model, a cut that would not assemble —
 * fails its row through `failedPrecondition`, so no provider is called and no
 * generation diagnostic fires: a render that never ran did not fail to
 * generate. Demo mode compiles nothing and draws the monogram; the row's
 * `prompt` then carries the monogram's own label, so it describes the picture
 * that was drawn rather than a request nobody made, and a failed row carries no
 * prompt at all.
 *
 * The profile is resolved BEFORE the pipeline reserves a row so the row's meta
 * can record which model produced it. A pick that is no longer offered degrades
 * to the portrait task's default rather than failing (owner ruling 5).
 *
 * The cut's `meta.visualState` provenance is attached at RESERVE time, beside
 * `style`/`model`/`demo`: a thrown produce carries no meta, and the visual
 * moment that shaped the prompt must survive a failed render.
 */
export async function generateAvatar(input: GenerateAvatarInput): Promise<string> {
  const style = input.style ?? "realistic";
  const demo = isDemoMode();
  const resolved = demo ? null : await resolveImageProfileForTask("portrait", input.modelId, input.sink);
  const model = resolved?.model ?? null;
  const [storedCharacter] = input.source
    ? [undefined]
    : await db().select().from(characters).where(eq(characters.id, input.characterId)).limit(1);
  const character = input.source
    ? { name: input.source.name, profile: input.source.profile, revision: input.source.revision }
    : storedCharacter
      ? { name: storedCharacter.name, profile: storedCharacter.profile, revision: String(storedCharacter.authoringRevision) }
      : undefined;
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
  const cut = character
    ? tryBuildAvatarCut(
        {
          characterId: input.characterId,
          profile,
          wardrobe: load.wardrobe,
          ...(load.failed === true ? { wardrobeUnavailable: true } : {}),
          ...((load.coverageUnreliableIds?.length ?? 0) > 0 ? { coverageUnreliable: true } : {}),
          // The character row's own revision plus every wardrobe row read for
          // this render — an edit to either mints a different token.
          readToken: standaloneCharacterReadToken({
            characterId: input.characterId,
            revision: character.revision,
            extraRevisions: load.revisions,
          }),
        },
        input.sink,
      )
    : null;

  // The program compiles only for a render that has a world to compile: a
  // character row, a cut that assembled, and a resolved profile (demo mode and
  // a task with no registered model have none).
  const program =
    character && cut && resolved
      ? buildAvatarProgram({
          characterId: input.characterId,
          characterName: character.name,
          revision: character.revision,
          extraRevisions: load.revisions,
          cut,
          profile: resolved,
          ...(input.sink === undefined ? {} : { sink: input.sink }),
        })
      : null;
  const compiled = program?.kind === "compiled" ? program : null;
  const programPrecondition = program === null ? null : avatarProgramPrecondition(program, input.characterId, input.sink);
  const monogramLabel = character?.name ?? "";
  const prompt = compiled?.prompt ?? (demo ? monogramLabel : "");

  const { imageId } = await runImagePipeline({
    asset: {
      ownerId: input.userId,
      kind: "avatar",
      entityKind: "character",
      entityId: input.characterId,
      prompt,
      meta: {
        style,
        model: demo ? "demo" : qualifiedImageModelIdentity(model),
        demo,
        ...(cut?.digestMeta ?? {}),
        // The compiled program's own provenance, exactly as the entity lane
        // records it. Absent on a render that compiled none.
        ...(compiled?.meta ?? {}),
      },
    },
    // A cut that would not assemble is checked FIRST: a program is never built
    // over a cut that does not exist, so the two answers cannot both arise.
    failedPrecondition: character
      ? cut === null
        ? "the avatar's visual cut could not be assembled"
        : (programPrecondition ?? (demo || model ? null : "no image model is registered for portraits"))
      : `character ${input.characterId} not found`,
    // Text-to-image at Vesper's 3:4, with no references — the simplest intent
    // there is. A failure still THROWS (this lane's ruled failure shape: the
    // shell's warn diagnostic plus the error-carrying event line), which is why
    // render provenance is recorded only on success — a thrown produce has no
    // meta channel. The cut provenance already landed at reserve time.
    produce: async () => {
      if (demo || !resolved) return { ok: true, image: monogramSvg(monogramLabel) };
      // Every other answer failed the row above, so a production render reaches
      // the provider only with a compiled program.
      if (compiled === null) throw new Error("avatar render reached the provider with no compiled prompt program");
      const result = await renderImageIntent(
        {
          profile: resolved,
          ...characterPromptTransport(compiled),
          references: [],
          target: { aspectRatio: IMAGE_TARGET_ASPECT },
        },
        input.sink,
      );
      if (!result.ok || !result.image) throw new Error(result.error ?? `${resolved.model.slug} returned no image`);
      return { ok: true, image: result.image, ...renderAttemptMeta(result.attempt) };
    },
    onReady: async (asset) => {
      // The CANDIDATE pointer, and nothing else. A generated portrait is a
      // proposal: it changes what the studio and the library card show, and
      // changes nothing about the character's identity until the owner accepts
      // it (`portrait-acceptance.ts`), which is the one trigger for
      // identity-pack preparation.
      await db().update(characters).set({ avatarImageId: asset.id }).where(eq(characters.id, input.characterId));
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
  hairOcclusion: hairOcclusionSchema.optional().catch(undefined),
  tags: z.array(z.string()).catch([]),
});

/** The default outfit plus each row's revision — the read-token's wardrobe half. */
export interface AvatarWardrobeLoad {
  wardrobe: AvatarWardrobeItem[];
  /** One `items.updatedAt` revision per loaded row, in wardrobe order. */
  revisions: ImageSourceRevision[];
  /**
   * The lookup THREW — the empty wardrobe above is unknown state, not a
   * confirmed undressed character. The cut must not turn it into exposure
   * claims; coverage degrades to fully covered instead.
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
 * name. Degrades to an empty load (coverage unknown) with a diagnostic.
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
      // Resolved ONCE here (item override, else subtype default) so every
      // consumer of the row reads one band; sparse at `none`, which is what an
      // absent band resolves to anyway.
      const hairOcclusion = hairOcclusionForItem(extras.subtype, extras.hairOcclusion);
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
        ...(hairOcclusion === HAIR_OCCLUSION_NONE ? {} : { hairOcclusion }),
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
      diag("warn", "images.avatar.outfit_load_failed", "default outfit lookup failed — the cut's coverage degrades to unknown", {
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
