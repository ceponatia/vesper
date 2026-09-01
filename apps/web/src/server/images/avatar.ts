import { and, eq, inArray } from "drizzle-orm";
import { z } from "zod";
import { characters, db, items } from "../db";
import { isDemoMode } from "../ai";
import { logEvent } from "../events";
import { runInBatches } from "@/lib/batches";
import { parseOr } from "@/lib/parse";
import { outfitItems } from "@/contracts";
import { IMAGE_TARGET_ASPECT, type ImageSourceRevision, type ResolvedImageProfile } from "@vesper/image-core";
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
import {
  buildCharacterPromptProgram,
  characterPromptTransport,
  type CharacterPromptProgramResult,
} from "./character-prompt-program";
import { characterPortraitImageOperation } from "@/contracts/images/character-digest";
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
 * the assembly itself failed. The row is failed BEFORE any provider spend;
 * production never falls back to the legacy prose builder.
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
 * The avatar lane's ACTIVE prompt program, or null when this render has nothing
 * to compile (issue #256).
 *
 * Null covers demo mode, a lane with no resolved model, and a character row
 * that never loaded — renders with no world to compile, not models that were
 * left behind. Every portrait profile the picker offers is bound: the three
 * Qwen Image 2512 rows, Seedream 4.5, Seedream 5 Lite, both Stable Diffusion
 * 3.5 Large rows, Wan 2.7, NSFW FLUX Dev, LikeReality Pony and P-Image.
 *
 * Resolution is strict on the profile KEY, because this lane's models bind per
 * profile: 2512 carries three portrait rows (`portrait-standard`,
 * `portrait-fast`, `portrait-quality`) whose packs must stay separately
 * promotable, and SD 3.5 Large carries two. A key with no row resolves null
 * rather than borrowing a sibling profile's pack pins.
 *
 * No references: every portrait profile's reference policy allows no roles, so
 * a portrait is text-to-image and its identity travels entirely in the digest's
 * own descriptors rather than in an image.
 *
 * The operation states the honest default style — a photographic medium and no
 * descriptors — and the avatar's `realistic`/`anime` toggle does NOT become
 * style descriptors here. The toggle already reaches the prompt through the
 * segment assembly's own camera and policy inputs, and turning it into a second
 * style claim would state the medium twice, once in a channel the collision
 * linter cannot reconcile with the pack's rendering intent.
 */
function activeAvatarProgram(inputs: {
  readonly characterId: string;
  readonly characterName: string;
  readonly revision: string;
  readonly extraRevisions: readonly ImageSourceRevision[];
  readonly assembly: AvatarSegmentAssembly | null;
  readonly profile: ResolvedImageProfile | null;
  readonly sink?: DiagnosticSink;
}): CharacterPromptProgramResult | null {
  const { assembly, profile } = inputs;
  if (assembly === null || profile === null) return null;
  const visual = assembly.visual;
  return buildCharacterPromptProgram({
    lane: "avatar",
    task: "portrait",
    profile,
    bindingProfileKey: profile.profile.key,
    resolver: "active",
    cuts: [
      {
        subjectId: inputs.characterId,
        name: inputs.characterName,
        digest: visual.digest,
        attributes: visual.resolved,
        exposure: visual.exposure,
        realizedBody: visual.realizedBody,
      },
    ],
    read: {
      kind: "standalone_character",
      characters: [{ characterId: inputs.characterId, revision: inputs.revision }],
      extraRevisions: [...inputs.extraRevisions],
    },
    references: [],
    operation: () => characterPortraitImageOperation(),
    // A portrait of a specific character with a lost identity or morphology
    // anchor is a picture of somebody else. The segment assembly already
    // refuses on its own missing-required set (`avatarDigestRefusal`); this is
    // the join-level check the adapter performs, and it fails the row before
    // provider spend in exactly the same place.
    refuseOnMissingRequired: true,
    ...(inputs.sink === undefined ? {} : { sink: inputs.sink }),
  });
}

/**
 * Avatar pipeline: the standalone visual digest compiled through the picked
 * profile's prompt program → that model's text-to-image (3:4), or monogram in
 * demo mode, through the shared reserve/save/fail lifecycle.
 *
 * The prompt is the compiled program (#256, `activeAvatarProgram`); the legacy
 * segment assembly is still built — it owns the digest refusal, the
 * `meta.visualState` provenance and the realized cut the program compiles from
 * — and its prose ships only on a render that compiled no program at all. #251
 * deletes that half.
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
  const legacyPrompt = assembly?.prompt ?? "";

  // The cutover (issue #256): the prompt this render sends is the compiled
  // prompt program. Everything else about the render — profile, target,
  // controls — is unchanged, because the migration is the prompt and nothing
  // else. A render that already refused compiles nothing: a cut that could not
  // be assembled never had a program to build.
  const program =
    character && digestRefusal === null
      ? activeAvatarProgram({
          characterId: input.characterId,
          characterName: character.name,
          revision: character.updatedAt.toISOString(),
          extraRevisions: load.revisions,
          assembly,
          profile: resolved,
          ...(input.sink === undefined ? {} : { sink: input.sink }),
        })
      : null;
  const compiled = program?.kind === "compiled" ? program : null;
  // A refusal is NOT a fallback to the legacy prose. A binding resolved and then
  // could not compile — a missing pack, an unregistered dialect, a lost required
  // anchor — is a configuration or data fault on a lane that IS bound, and
  // rendering something reasonable instead would hide it behind an
  // acceptable-looking portrait. It fails the row through `failedPrecondition`,
  // so no provider is called and no generation diagnostic fires: a render that
  // never ran did not fail to generate.
  const programRefusal = program?.kind === "refused" ? program.refusal : null;
  // Prompt, segments and any compiled negative in ONE decision — a compiled
  // render must not still carry the legacy segments, which `resolveIntentPrompt`
  // would prefer over the compiled string.
  const transport = characterPromptTransport(legacyPrompt, assembly?.segments, compiled);

  const { imageId } = await runImagePipeline({
    asset: {
      ownerId: input.userId,
      kind: "avatar",
      entityKind: "character",
      entityId: input.characterId,
      prompt: transport.prompt,
      meta: {
        style,
        model: demo ? "demo" : `replicate/${model?.slug ?? "none"}`,
        demo,
        ...(assembly?.digestMeta ?? {}),
        // The compiled program's own provenance, exactly as the entity lane
        // records it. Absent on a render that compiled none, which is how a row
        // says which prompt system built it.
        ...(compiled?.meta ?? {}),
      },
    },
    // The digest refusal is checked FIRST because it is the older and more
    // specific failure, and a program refusal cannot even arise beside one — the
    // program is not built for a render the digest already doomed.
    failedPrecondition: character
      ? (digestRefusal ??
        programRefusal ??
        (demo || model ? null : "no image model is registered for portraits"))
      : `character ${input.characterId} not found`,
    // Text-to-image at Vesper's 3:4, with no references — the simplest intent
    // there is. A failure still THROWS (this lane's ruled failure shape: the
    // shell's warn diagnostic plus the error-carrying event line), which is why
    // render provenance is recorded only on success — a thrown produce has no
    // meta channel. The digest provenance already landed at reserve time.
    produce: async () => {
      if (demo || !resolved) return { ok: true, image: monogramSvg(character?.name ?? "") };
      const result = await renderImageIntent(
        {
          profile: resolved,
          // Prompt, segments and the normalized negative in one decision. On a
          // compiled render the segments are absent, or they would outrank the
          // program and ship the prose it replaced.
          ...transport,
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
      // identity-pack preparation must never fail or delay a valid portrait.
      // Returns void, so nothing here can reject.
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
