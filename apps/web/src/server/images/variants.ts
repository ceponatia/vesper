import { and, eq } from "drizzle-orm";
import { characterProfileSchema, emptyCharacterProfile, outfitItems, type SceneCameraSpec } from "@/contracts";
import {
  IMAGE_TARGET_ASPECT,
  type ImageLoraRenderBinding,
  type ImageSourceRevision,
  type ResolvedImageProfile,
} from "@vesper/image-core";
import { parseOr } from "@/lib/parse";
import { characters, db, images } from "../db";
import { isDemoMode } from "../ai";
import { resolveImageProfileForTask } from "./model-profiles";
import { renderAttemptMeta, renderImageIntent } from "./render-intent";
import { logEvent } from "../events";
import { log } from "@/server/log";
import { diag, type DiagnosticSink } from "@/contracts/diagnostics";
import type { PortraitVariantKind } from "@/contracts/images/portrait-variant";
import { standaloneCharacterReadToken } from "@/contracts/images/subject-digest";
import { HIDDEN_IMAGE_KINDS, runImagePipeline, type ImageKind } from "./assets";
import { loadDefaultWardrobeWithRevisions } from "./avatar";
import { identityPackRenderReferences, type IdentityPackRenderReferencesResult } from "./identity-pack-consume";
import { queueIdentityPackPreparation } from "./identity-pack-preparation";
import {
  buildCharacterPromptProgram,
  characterPromptTransport,
  characterPromptUnboundRefusal,
  variantChangeOperation,
  type CharacterPromptProgramResult,
} from "./character-prompt-program";
import { monogramSvg } from "./monogram";
import { pairProfileWithNsfwLora } from "./nsfw-lora";
import {
  buildStandaloneLaneCut,
  standaloneSubjectPromptCut,
  type StandaloneLaneCutInput,
  type StandaloneSubjectCut,
} from "./standalone-subject-visual";

/** The bench kind, named rather than spelled at the routing decision. */
export const NSFW_TEST_VARIANT_KIND: PortraitVariantKind = "nsfw_test";

export interface GenerateVariantInput {
  characterId: string;
  userId: string;
  kind: PortraitVariantKind;
  instruction: string;
  /** Registry model id from the New Variant picker; absent uses the surface default. */
  modelId?: string;
  sink?: DiagnosticSink;
}

/** The bench kind's refusal, or the wrapper + weights it will run on. */
type NsfwTestRoute = { ok: true; profile: ResolvedImageProfile; binding: ImageLoraRenderBinding } | { ok: false; error: string };

/**
 * The `nsfw_test` kind's model swap — the studio's half of the anatomy-LoRA
 * route (`nsfw-lora.ts`, shared with the chat scene lane).
 *
 * It FAILS rather than degrades, which is the one place this kind departs from
 * the scene lane. A chat render that cannot assemble the LoRA still owes the
 * player a picture, so it falls back to the stock model and says so in a
 * diagnostic. A bench render exists to exercise the weights: quietly producing
 * the tame render on the ordinary variant model would answer a question the
 * owner did not ask, bill for it, and look like a result. The failed row carries
 * the missing leg's own words, which is what the studio tile shows.
 */
async function resolveNsfwTestRoute(profile: ResolvedImageProfile, sink?: DiagnosticSink): Promise<NsfwTestRoute> {
  const paired = await pairProfileWithNsfwLora(profile, sink);
  if (!paired.ok) return { ok: false, error: `the NSFW test LoRA is unavailable (${paired.leg}): ${paired.message}` };
  return { ok: true, profile: paired.profile, binding: paired.binding };
}

// ---------------------------------------------------------------------------
// The variant's cut
// ---------------------------------------------------------------------------

/**
 * The edit's fixed viewpoint: facing the camera at full-figure distance, which
 * `visualCameraReadsOfSceneCamera` maps to the `full_figure` framing band. A
 * pose, setting or bench restage is not a waist-up portrait, and below-waist
 * morphology (a tail, digitigrade legs) is exactly the anchor the edit must
 * not lose — a waist-up frame would cut it.
 */
export const VARIANT_EDIT_CAMERA: SceneCameraSpec = {
  orientation: "toward_viewer",
  distance: "full_figure",
  height: "eye_level",
};

/** The camera id the selection fingerprints — this lane's fixed viewpoint, not a committed scene camera. */
export const VARIANT_EDIT_CAMERA_ID = "variant_edit";

export type VariantCutInput = StandaloneLaneCutInput;

/**
 * The variant lane's cut of the character sheet — the standalone cut under the
 * edit camera. The lane loads the default outfit for one reason: the camera's
 * perception and the exposure the adapter states must come from the saved
 * outfit, not from an assumed-bare body. No garment NAME reaches this prompt —
 * the reference image shows the clothes. Pure.
 */
export function buildVariantCut(input: VariantCutInput): StandaloneSubjectCut {
  return buildStandaloneLaneCut(input, { camera: VARIANT_EDIT_CAMERA, cameraId: VARIANT_EDIT_CAMERA_ID });
}

/**
 * The cut could not be assembled at all — a thrown build. The row is failed
 * BEFORE any provider spend, through `failedPrecondition` rather than
 * `produce`, so no `images.variant.generate_failed` fires: a render that never
 * ran did not fail to generate.
 */
export const VARIANT_CUT_FAILED = "images.variant.visual_cut_failed";

/**
 * The FINAL resolved model has no active prompt binding for the variant task
 * and this profile key. The row fails before provider spend naming the three
 * coordinates; nothing else is ever sent in its place.
 */
export const VARIANT_PROGRAM_UNBOUND = "images.variant.program_unbound";

/**
 * Typed as the cut's OWN input (minus the sink, threaded separately) so a
 * degradation flag like `wardrobeUnavailable` can never be silently dropped at
 * this seam — an inline retype in the avatar lane once omitted it, and a
 * refactor could have reverted the failed-load-renders-topless fix with no type
 * error.
 */
function tryBuildVariantCut(input: Omit<VariantCutInput, "sink">, sink?: DiagnosticSink): StandaloneSubjectCut | null {
  try {
    return buildVariantCut({ ...input, ...(sink === undefined ? {} : { sink }) });
  } catch (err) {
    sink?.push(
      diag("warn", VARIANT_CUT_FAILED, "variant visual cut failed to assemble", {
        path: "images.variant",
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
// The variant's program
// ---------------------------------------------------------------------------

/** Everything the program decision needs, in the order the lane learns it. */
interface VariantProgramInputs {
  readonly character: { readonly name: string; readonly updatedAt: Date } | undefined;
  /** The FINAL resolved profile — the LoRA wrapper when the bench route swapped it. */
  readonly resolved: ResolvedImageProfile | null;
  readonly cut: StandaloneSubjectCut | null;
  readonly nsfwRoute: NsfwTestRoute | null;
  /** The SUCCESSFUL pack evaluation only — a refusal carries no references to number. */
  readonly packSelection: Extract<IdentityPackRenderReferencesResult, { ok: true }> | null;
  readonly input: GenerateVariantInput;
  readonly revisions: readonly ImageSourceRevision[];
}

/**
 * The variant lane's prompt program, or null when this render has nothing to
 * compile.
 *
 * Null is the ordinary answer for a render with no world to compile, not a
 * failure: demo mode, a lane with no resolved model, a cut that would not
 * assemble, a render whose final references are not known. Each of those
 * fails or draws its own way below.
 *
 * Every variant profile the picker offers is bound (#256) — Qwen Edit 2511,
 * Seedream 4.5, Seedream 5 Lite, Wan 2.7, SDXL PuLID, and the LoRA wrapper the
 * bench kind swaps onto — and each resolves its own model's dialect. They all
 * share the profile key `variant-standard`, which is exactly why resolution is
 * keyed on the MODEL SLUG as well: a binding keyed on the profile alone would
 * hand one endpoint's packs to the other four.
 *
 * ## The bench kind
 *
 * `nsfw_test` pairs the picked profile with a LoRA WRAPPER model, and binding
 * resolution runs on the FINAL resolved profile — so a successful bench route
 * resolves `qwen/qwen-image-edit-plus-lora`, which has a binding of its own
 * (`packs-character-endpoints.ts`) and compiles through the wrapper's own
 * delta-edit dialect rather than borrowing 2511's row.
 *
 * A FAILED bench route is the case worth guarding explicitly. `resolved` then
 * falls back to the picked 2511 profile, which the ordinary variant binding
 * does match — but that profile is not the model this render would have run on,
 * the row is already doomed to refuse in `produce`, and compiling would store a
 * program describing a render nobody made. So it is skipped.
 */
function activeVariantProgram(inputs: VariantProgramInputs): CharacterPromptProgramResult | null {
  const { character, resolved, cut, packSelection, input } = inputs;
  if (!character || resolved === null || cut === null) return null;
  // The bench route's own failure — see above.
  if (inputs.nsfwRoute !== null && !inputs.nsfwRoute.ok) return null;
  // The compiled prompt describes its references and picks its identity-lock
  // wording by their count, so it cannot be built before the final send list is
  // known. Without a pack the render refuses in `produce` anyway.
  if (packSelection === null) return null;
  return buildCharacterPromptProgram({
    lane: "variant",
    task: "variant",
    profile: resolved,
    // Strict on the lane's own profile key. It narrows to exactly the row this
    // profile was bound for, so a second `variant` profile added on this model
    // later cannot inherit a binding nobody wired it into.
    bindingProfileKey: resolved.profile.key,
    // A cast of one: a portrait variant is always one person.
    cuts: [standaloneSubjectPromptCut(cut, { subjectId: input.characterId, name: character.name })],
    read: {
      kind: "standalone_character",
      characters: [{ characterId: input.characterId, revision: character.updatedAt.toISOString() }],
      extraRevisions: [...inputs.revisions],
    },
    // Every reference this lane sends is the subject's own identity pack, so
    // each one names the one person the variant is of.
    references: packSelection.references.map((entry) => ({
      reference: entry.reference,
      subjectId: input.characterId,
    })),
    operation: variantChangeOperation(input.kind, input.instruction),
    // An identity-critical lane refuses on a lost anchor rather than rendering a
    // stranger: the adapter's join-level check fails the row before provider
    // spend.
    refuseOnMissingRequired: true,
    ...(input.sink === undefined ? {} : { sink: input.sink }),
  });
}

/**
 * The precondition text a program answer fails the row with, or null for a
 * compiled program. A refusal already pushed its own diagnostic at the seam;
 * `unbound` pushes the lane's here, because the seam records nothing for an
 * ordinary "no row".
 */
function variantProgramPrecondition(
  program: CharacterPromptProgramResult,
  characterId: string,
  sink?: DiagnosticSink,
): string | null {
  if (program.kind === "compiled") return null;
  if (program.kind === "refused") return program.refusal;
  sink?.push(
    diag("warn", VARIANT_PROGRAM_UNBOUND, "the resolved model has no active prompt binding for the variant task", {
      path: "images.variant",
      context: { characterId, model: program.modelSlug, task: program.task, profileKey: program.profileKey },
    }),
  );
  return characterPromptUnboundRefusal(program);
}

/**
 * Portrait-variant pipeline (docs/images/pipelines/portrait-variants.md):
 * single-reference registry edit of the canonical avatar. Always re-rolls from
 * the canonical portrait — never chains edits (drift compounds).
 * Identity-critical, so the reference comes from the identity-pack service
 * (`identityPackRenderReferences`) — profile-aware eligibility, candidate
 * roles, owned byte reads, provenance on the row's meta — and an ineligible
 * pack refuses the render rather than substituting another image. Runs on the
 * shared reserve → generate → save-or-fail → log shell (`runImagePipeline`);
 * failures mark the row failed and return its id.
 *
 * The compiled prompt program is the ONLY prompt this lane has (#256): the
 * active binding for the FINAL resolved model and this task, the character
 * world digest, and the program's positive text (`characterPromptTransport`).
 * The identity lock and the age anchor are the program's own claims
 * (`subject.identity`, `subject.apparent_age`), worded by each endpoint's
 * dialect. A render that compiles none — a refused program, an unbound model,
 * a cut that would not assemble — fails its row through `failedPrecondition`,
 * so no provider is called and no generation diagnostic fires. Demo mode draws
 * the monogram and the row's `prompt` carries its label; a failed row carries
 * no prompt at all.
 *
 * `meta.visualState` provenance is attached at reserve time either way, so the
 * visual moment survives a failed render, and a compiled render adds the
 * program's own `meta.promptProgram` and `meta.worldState` beside it.
 *
 * The render seam reports an edit failure as `ok: false` rather than throwing,
 * so this lane's generation failure is a RETURNED failure and pushes its own
 * `images.variant.generate_failed` (the ruled normalization). Its precondition
 * misses — no character, a refused program — stay out of that path entirely,
 * exactly like the entity lane's not-found; the pack evaluation and the seam
 * push their own diagnostics for the rest.
 */
export async function generateVariant(input: GenerateVariantInput): Promise<string> {
  const demo = isDemoMode();
  // The New Variant section has its OWN model picker (image-model-registry):
  // before the registry, only one provider model could edit, so this lane had no
  // choice to make and silently used it.
  const picked = demo ? null : await resolveImageProfileForTask("variant", input.modelId, input.sink);
  const nsfwTest = input.kind === NSFW_TEST_VARIANT_KIND;
  // Resolved BEFORE the row is reserved, like every other model decision in this
  // lane: the row records the model it will run on, so a swap decided later would
  // be a row that lies about its own render.
  const nsfwRoute = nsfwTest && picked ? await resolveNsfwTestRoute(picked, input.sink) : null;
  // The picked profile ON the LoRA wrapper for the bench kind; the picked profile
  // itself for every other variant, unchanged.
  const resolved = nsfwRoute?.ok ? nsfwRoute.profile : picked;
  const model = resolved?.model ?? null;
  const [character] = await db().select().from(characters).where(eq(characters.id, input.characterId)).limit(1);
  const profile = parseOr(
    characterProfileSchema,
    character?.profile ?? {},
    emptyCharacterProfile(),
    undefined,
    "characters.profile",
  );
  const load = character
    ? await loadDefaultWardrobeWithRevisions(input.userId, outfitItems(profile), input.sink)
    : { wardrobe: [], revisions: [] };
  // Guarded on the character: there is no row to take a read token from, and
  // that path is already a failed precondition.
  const cut = character
    ? tryBuildVariantCut(
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
            revision: character.updatedAt.toISOString(),
            extraRevisions: load.revisions,
          }),
        },
        input.sink,
      )
    : null;
  const packIdentity: IdentityPackRenderReferencesResult | null =
    !demo && character && resolved
      ? await identityPackRenderReferences({
          ownerId: input.userId,
          characterId: input.characterId,
          profile: resolved,
          sink: input.sink,
        })
      : null;
  const packSelection = packIdentity?.ok ? packIdentity : null;

  const program = activeVariantProgram({
    character,
    resolved,
    cut,
    nsfwRoute,
    packSelection,
    input,
    revisions: load.revisions,
  });
  const compiled = program?.kind === "compiled" ? program : null;
  const programPrecondition = program === null ? null : variantProgramPrecondition(program, input.characterId, input.sink);
  const monogramLabel = `${character?.name ?? ""} ${input.kind}`;
  const prompt = compiled?.prompt ?? (demo ? monogramLabel : "");

  const { imageId } = await runImagePipeline({
    asset: {
      ownerId: input.userId,
      kind: "portrait_variant",
      entityKind: "character",
      entityId: input.characterId,
      prompt,
      sourceImageId: packSelection?.references[0]?.reference.sourceImageId,
      meta: {
        variantKind: input.kind,
        demo,
        model: demo ? "demo" : `replicate/${model?.slug ?? "none"}`,
        // The weights this row ran on, by id — the same field the scene lane
        // records, and never the locator.
        ...(nsfwRoute?.ok ? { lora: nsfwRoute.binding.id } : {}),
        ...(packSelection ? { identityReferences: packSelection.provenance } : {}),
        // The visual moment that shaped the prompt, attached at RESERVE time
        // beside the model decisions: a thrown or refused produce carries no
        // meta, and the provenance must survive a failed render.
        ...(cut?.digestMeta ?? {}),
        // The compiled program's own provenance, exactly as the entity lane
        // records it. Absent on a render that compiled none.
        ...(compiled?.meta ?? {}),
      },
    },
    // The row is on record for a missing character too — failed, unlogged. A
    // cut that would not assemble is checked FIRST: a program is never built
    // over a cut that does not exist, so the two answers cannot both arise.
    failedPrecondition: character
      ? cut === null
        ? "the variant's visual cut could not be assembled"
        : programPrecondition
      : `character ${input.characterId} not found`,
    produce: async (asset) => {
      // Only reached once the character loaded, so the name fallback never fires.
      if (demo) return { ok: true, image: monogramSvg(monogramLabel) };
      // Precondition this lane can't satisfy, not a generation that failed: no diagnostic.
      if (!resolved) return { ok: false, error: "no image model is registered for portrait variants" };
      // The bench kind IS its LoRA: a missing leg fails the row with the reason
      // rather than rendering the tame picture the owner was testing against.
      if (nsfwRoute && !nsfwRoute.ok) return { ok: false, error: nsfwRoute.error };
      // The pack refusal: an ineligible pack REFUSES the render — the
      // substitution the integration spec forbids. The evaluation already
      // pushed its diagnostic, and a character with no usable canonical
      // portrait settles here with the pack's own explanation.
      if (!packSelection) {
        return { ok: false, error: packIdentity && !packIdentity.ok ? packIdentity.error : "identity references unavailable" };
      }
      // Every other answer failed the row above, so a production render reaches
      // the provider only with a compiled program.
      if (compiled === null) return { ok: false, error: "no compiled prompt program for this variant" };
      const edit = await renderImageIntent(
        {
          profile: resolved,
          ...characterPromptTransport(compiled),
          // The identity the variant instruction modifies, which this lane
          // always re-rolls from rather than chaining edits: the pack's
          // candidate references for the resolved profile.
          references: packSelection.references.map((entry) => entry.reference),
          target: { aspectRatio: IMAGE_TARGET_ASPECT },
          // Already resolved against this model, version and task above, so the
          // render path leaves it alone and sends exactly these weights.
          ...(nsfwRoute?.ok ? { resolvedLora: nsfwRoute.binding } : {}),
        },
        input.sink,
      );
      if (!edit.ok || !edit.image) {
        const error = edit.error ?? `${resolved.model.slug} returned no image`;
        input.sink?.push(
          diag("warn", "images.variant.generate_failed", error.slice(0, 300), {
            context: { characterId: input.characterId, imageId: asset.id },
          }),
        );
        // Provenance rides the failure too — a failed prediction's id is what
        // an operator traces at the provider.
        return { ok: false, error, ...renderAttemptMeta(edit.attempt) };
      }
      return { ok: true, image: edit.image, ...renderAttemptMeta(edit.attempt) };
    },
    // Every branch past the character check logs — including the two failures,
    // which carry `durationMs` here where avatar/entity's thrown line does not.
    onSettled: ({ imageId: id, status, startedMs }) => void logVariant(id, input, status, startedMs),
    onThrown: ({ imageId: id, startedMs }) => void logVariant(id, input, "failed", startedMs),
    // The RETURNED render failure pushes this code inside produce (above); the
    // shell covers the thrown path, which nothing in this lane reaches today.
    // The two paths are exclusive, so the diagnostic can never double-fire.
    failureDiagnostic: { code: "images.variant.generate_failed", context: { characterId: input.characterId } },
    sink: input.sink,
  });
  return imageId;
}

function logVariant(imageId: string, input: GenerateVariantInput, status: string, started: number): Promise<void> {
  return logEvent("image.portrait_variant", {
    imageId,
    characterId: input.characterId,
    kind: input.kind,
    status,
    durationMs: Date.now() - started,
  });
}

export interface PromoteVariantResult {
  ok: boolean;
  error?: string;
}

/** Widened once so the membership test reads a plain `ImageKind`, not the literal tuple. */
const hiddenKinds: readonly ImageKind[] = HIDDEN_IMAGE_KINDS;

/**
 * Promotes a ready variant (or avatar) to the character's canonical avatar.
 *
 * Owner-strict in its OWN queries:
 * the promote route gates on `findOwnedCharacter` first, but a mutating service
 * must verify ownership itself rather than inherit it from a caller — and must
 * not infer it from `entityKind`/`entityId`, which are unverified metadata with
 * no FK (the S5 shape: pointing an owned image at a foreign PUBLIC entity must
 * buy nothing). Both rows are matched on `ownerId` in the same query as the id,
 * and a foreign row is reported as a plain miss, so a caller cannot use the
 * error to tell "not yours" from "does not exist".
 */
export async function promoteVariant(characterId: string, imageId: string, ownerId: string): Promise<PromoteVariantResult> {
  const [character] = await db()
    .select({ id: characters.id })
    .from(characters)
    .where(and(eq(characters.id, characterId), eq(characters.ownerId, ownerId)))
    .limit(1);
  if (!character) return denyPromotion("images.promote.character_denied", "character not found", characterId, imageId, ownerId);

  const [image] = await db()
    .select()
    .from(images)
    .where(and(eq(images.id, imageId), eq(images.ownerId, ownerId)))
    .limit(1);
  if (!image) return denyPromotion("images.promote.image_denied", "image not found", characterId, imageId, ownerId);
  // A hidden derived asset is an internal render INPUT, never a portrait. An
  // identity face crop passes every other check here — it is owned, ready, and
  // pointed at this character — so without this guard the owner's own crop could
  // be promoted to their canonical avatar, which would then derive the next pack
  // from a crop of a crop.
  if (hiddenKinds.includes(image.kind)) {
    return denyPromotion("images.promote.hidden_kind", "image is not a promotable portrait", characterId, imageId, ownerId);
  }
  // Not an authorization miss — an owned image that simply isn't paintable yet.
  if (image.status !== "ready") return { ok: false, error: `image status is ${image.status}` };
  if (image.entityKind !== "character" || image.entityId !== characterId) {
    return denyPromotion("images.promote.entity_mismatch", "image does not belong to this character", characterId, imageId, ownerId);
  }

  const updated = await db()
    .update(characters)
    .set({ avatarImageId: imageId })
    .where(and(eq(characters.id, characterId), eq(characters.ownerId, ownerId)))
    .returning({ id: characters.id });
  if (updated.length === 0) return { ok: false, error: "character not found" };
  // The canonical pointer is committed; prepare the identity pack for the new
  // source, best-effort. This is the trigger for BOTH the studio's promote and
  // the avatar upload, which promotes through here rather than writing the
  // pointer itself — so neither needs its own call.
  queueIdentityPackPreparation(characterId, ownerId);
  return { ok: true };
}

/** Diagnostic for a rejected promotion (docs/resilience.md): logged, never thrown. */
function denyPromotion(
  code: string,
  error: string,
  characterId: string,
  imageId: string,
  ownerId: string,
): PromoteVariantResult {
  log.warn("images", `promote denied: ${error}`, { code, characterId, imageId, ownerId });
  return { ok: false, error };
}
