import { and, eq } from "drizzle-orm";
import { characterProfileSchema, emptyCharacterProfile, outfitItems } from "@/contracts";
import {
  IMAGE_TARGET_ASPECT,
  type ImageLoraRenderBinding,
  type ImagePromptSegment,
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
import { standaloneCharacterReadToken } from "@/contracts/images/subject-digest";
import { HIDDEN_IMAGE_KINDS, runImagePipeline, type ImageKind } from "./assets";
import { loadDefaultWardrobeWithRevisions } from "./avatar";
import { identityPackRenderReferences, type IdentityPackRenderReferencesResult } from "./identity-pack-consume";
import { queueIdentityPackPreparation } from "./identity-pack-preparation";
import {
  buildCharacterPromptProgram,
  variantChangeOperation,
  type CharacterPromptProgramResult,
} from "./character-prompt-program";
import { variantShadowMeta } from "./character-shadow";
import { monogramSvg } from "./monogram";
import { pairProfileWithNsfwLora } from "./nsfw-lora";
import { NSFW_TEST_VARIANT_KIND, type VariantKind } from "./prompts-variant";
import {
  buildVariantSegments,
  type VariantSegmentAssembly,
  type VariantSegmentAssemblyInput,
} from "./variant-segments";

export interface GenerateVariantInput {
  characterId: string;
  userId: string;
  kind: VariantKind;
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

/**
 * A refused variant render's diagnostic: the standalone visual digest could not
 * make the character render-eligible — a required fact resolved no clause, or
 * the assembly itself threw. The row is failed BEFORE any provider spend,
 * through `failedPrecondition` rather than
 * `produce`, so no `images.variant.generate_failed` fires: a render that never
 * ran did not fail to generate.
 */
export const VARIANT_DIGEST_INELIGIBLE = "images.variant.visual_digest_ineligible";

/** The assembled segments (kept even when refused, so the row records what was attempted) and the refusal. */
interface VariantDigestBuild {
  readonly assembly: VariantSegmentAssembly | null;
  /** The precondition text, or null when the render may proceed. */
  readonly refusal: string | null;
}

/**
 * The pure segment assembly, run at the route boundary with the resilient
 * shape: a throw here is a defect, but the honest outcome is a failed row
 * carrying a diagnostic rather than a lost request, so it degrades to a
 * refusal (docs/resilience.md §diagnostics over exceptions).
 *
 * Typed as the assembly's OWN input (minus the sink, threaded separately) so a
 * degradation flag like `wardrobeUnavailable` can never be silently dropped at
 * this seam — an inline retype in the avatar lane once omitted it, and a
 * refactor could have reverted the failed-load-renders-topless fix with no type
 * error.
 */
function buildVariantDigest(
  input: Omit<VariantSegmentAssemblyInput, "sink">,
  sink?: DiagnosticSink,
): VariantDigestBuild {
  let assembly: VariantSegmentAssembly;
  try {
    assembly = buildVariantSegments({ ...input, ...(sink === undefined ? {} : { sink }) });
  } catch (err) {
    sink?.push(
      diag("warn", VARIANT_DIGEST_INELIGIBLE, "variant segment assembly failed", {
        path: "images.variant",
        context: {
          characterId: input.characterId,
          error: err instanceof Error ? err.message.slice(0, 300) : String(err).slice(0, 300),
        },
      }),
    );
    return { assembly: null, refusal: "the variant's visual digest could not be assembled" };
  }
  if (assembly.missingRequired.length === 0) return { assembly, refusal: null };
  sink?.push(
    diag("warn", VARIANT_DIGEST_INELIGIBLE, "a required visual fact resolved no prompt clause", {
      path: "images.variant",
      context: { characterId: input.characterId, missingRequired: [...assembly.missingRequired] },
    }),
  );
  return { assembly, refusal: "the variant's visual digest is missing required facts" };
}

/** The prompt channels one variant render sets on its intent. */
export interface VariantPromptTransport {
  readonly prompt: string;
  /** The semantic segments, on a LEGACY render only. */
  readonly promptSegments?: readonly ImagePromptSegment[];
  /** The compiled exclusions, normalized — absent when the program compiled none. */
  readonly controls?: { readonly negativePrompt: string };
}

/**
 * The prompt channels a variant render sends, decided in ONE place because they
 * must move together.
 *
 * `resolveIntentPrompt` prefers `promptSegments` over `prompt` whenever the list
 * is non-empty, so a compiled render that still carried the legacy segments
 * would send the legacy prose while its row stored the compiled program — a
 * provider seeing one prompt and an operator reading another, with nothing
 * anywhere reporting a disagreement. Deciding the three channels separately at
 * the call site is exactly how that ships; deciding them here makes the coupling
 * structural.
 *
 * The compiled exclusions ride the normalized control so they reach a provider
 * only through the version's own probed `negative_prompt` binding and are
 * recorded as a dropped control otherwise. Null or empty means this version
 * exposes no field — every Qwen edit endpoint today — and no key is invented.
 */
export function variantPromptTransport(
  legacyPrompt: string,
  segments: readonly ImagePromptSegment[] | undefined,
  compiled: { readonly prompt: string; readonly negativePrompt: string | null } | null,
): VariantPromptTransport {
  if (compiled === null) {
    return { prompt: legacyPrompt, ...(segments === undefined ? {} : { promptSegments: segments }) };
  }
  const negative = compiled.negativePrompt;
  return {
    prompt: compiled.prompt,
    ...(negative === null || negative.length === 0 ? {} : { controls: { negativePrompt: negative } }),
  };
}

/** Everything the active-program decision needs, in the order the lane learns it. */
interface VariantProgramInputs {
  readonly character: { readonly name: string; readonly updatedAt: Date } | undefined;
  /** The FINAL resolved profile — the LoRA wrapper when the bench route swapped it. */
  readonly resolved: ResolvedImageProfile | null;
  readonly assembly: VariantSegmentAssembly | null;
  /** True when the digest already refused this render; nothing is compiled for a doomed row. */
  readonly refused: boolean;
  readonly nsfwRoute: NsfwTestRoute | null;
  /** The SUCCESSFUL pack evaluation only — a refusal carries no references to number. */
  readonly packSelection: Extract<IdentityPackRenderReferencesResult, { ok: true }> | null;
  readonly input: GenerateVariantInput;
  readonly revisions: readonly ImageSourceRevision[];
}

/**
 * The variant lane's ACTIVE prompt program, or null when this render keeps the
 * legacy prompt path.
 *
 * Null is the ordinary answer, not a failure. It covers demo mode, a lane with
 * no resolved model, a render that already refused, a render whose final
 * references are not known — and, through the shared seam's `unbound` result,
 * every variant model with no active binding: Seedream 4.5, Seedream 5 Lite,
 * Wan 2.7 and SDXL PuLID all carry the profile key `variant-standard` and would
 * be captured by a binding keyed on the profile alone. The model slug is what
 * keeps them on the prompt they have always sent.
 *
 * ## The bench kind
 *
 * `nsfw_test` pairs the picked profile with a LoRA WRAPPER model, and binding
 * resolution runs on the final resolved profile, so a successful bench route
 * resolves the wrapper's slug — which carries no binding — and stays legacy.
 * That is the correct answer and it stays correct if the wrapper is ever bound
 * on its own terms.
 *
 * A FAILED bench route is the case worth guarding explicitly. `resolved` then
 * falls back to the picked 2511 profile, which the ordinary variant binding
 * does match — but that profile is not the model this render would have run on,
 * the row is already doomed to refuse in `produce`, and compiling would store a
 * program describing a render nobody made. So it is skipped, and the row keeps
 * the legacy prompt it has always recorded for that failure.
 */
function activeVariantProgram(inputs: VariantProgramInputs): CharacterPromptProgramResult | null {
  const { character, resolved, assembly, packSelection, input } = inputs;
  if (!character || resolved === null || assembly === null || inputs.refused) return null;
  // The bench route's own failure — see above.
  if (inputs.nsfwRoute !== null && !inputs.nsfwRoute.ok) return null;
  // The compiled prompt NUMBERS its references and picks its identity-lock
  // wording by their count, so it cannot be built before the final send list is
  // known. Without a pack the render refuses in `produce` anyway.
  if (packSelection === null) return null;
  const visual = assembly.visual;
  return buildCharacterPromptProgram({
    lane: "variant",
    task: "variant",
    profile: resolved,
    // Strict on the lane's own profile key. It narrows to exactly the row the
    // evidence was gathered for, so a second `variant` profile added on this
    // model later cannot inherit a cutover nobody measured for it.
    bindingProfileKey: resolved.profile.key,
    resolver: "active",
    cut: {
      subjectId: input.characterId,
      name: character.name,
      digest: visual.digest,
      attributes: visual.resolved,
      exposure: visual.exposure,
      realizedBody: visual.realizedBody,
    },
    read: {
      kind: "standalone_character",
      characters: [{ characterId: input.characterId, revision: character.updatedAt.toISOString() }],
      extraRevisions: [...inputs.revisions],
    },
    references: packSelection.references.map((entry) => entry.reference),
    operation: variantChangeOperation(input.kind, input.instruction),
    // An identity-critical lane refuses on a lost anchor rather than rendering a
    // stranger. The segment assembly already refuses on its own missing-required
    // set; this is the join-level check the adapter performs, and it fails the
    // row before provider spend exactly as that one does.
    refuseOnMissingRequired: true,
    ...(input.sink === undefined ? {} : { sink: input.sink }),
  });
}

/**
 * Portrait-variant pipeline (docs/images/pipelines/portrait-variants.md):
 * single-reference registry edit of
 * the canonical avatar, identity-locked + age-anchored (owner ruling 2026-07-29 —
 * "preserve apparent age" alone preserves the model's over-read and each
 * generation drifts older). Always re-rolls from the canonical portrait — never
 * chains edits (drift compounds). Identity-critical, so the reference comes
 * from the identity-pack service (`identityPackRenderReferences`) — profile-aware
 * eligibility, candidate roles, owned byte reads, provenance on the row's meta —
 * and an ineligible pack refuses the render rather than substituting another
 * image. Runs on the shared reserve → generate → save-or-fail → log shell
 * (`runImagePipeline`); failures mark the row failed and return its id.
 *
 * The prompt has two possible sources, decided per render by whether an ACTIVE
 * prompt-program binding exists for the FINAL resolved model and this task
 * (`activeVariantProgram`). With none — every variant model but the cut-over
 * one — it is the semantic segments (`variant-segments.ts`), the operation
 * contract plus the standalone visual digest, set on both `prompt` and
 * `intent.promptSegments`. With one, it is the compiled program's positive text
 * and no segments at all (`variantPromptTransport`). `meta.visualState`
 * provenance is attached at reserve time either way, so the visual moment
 * survives a failed render, and a compiled render adds the program's own
 * `meta.promptProgram` and `meta.worldState` beside it.
 *
 * The render seam reports an edit failure as `ok: false` rather than throwing, so this
 * lane's generation failure is a RETURNED failure and pushes its own
 * `images.variant.generate_failed` (the ruled normalization). Its precondition
 * misses — no character, an ineligible digest — stay out of that path entirely,
 * exactly like the entity lane's not-found; the pack evaluation and the digest
 * guard push their own diagnostics for the rest.
 */
export async function generateVariant(input: GenerateVariantInput): Promise<string> {
  const demo = isDemoMode();
  // The New Variant section now has its OWN model picker (image-model-registry):
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
  // The lane had no wardrobe load before the Stage 4 cutover, and therefore no
  // honest coverage at all. It loads one now for the same reason the avatar
  // lane does: the camera's perception and the exposure the intimate gate reads
  // must come from the saved outfit, not from an assumed-bare body. No garment
  // NAME reaches this prompt — the reference image shows the clothes.
  const load = character
    ? await loadDefaultWardrobeWithRevisions(input.userId, outfitItems(profile), input.sink)
    : { wardrobe: [], revisions: [] };
  // Guarded on the character: the missing-character path used to build a prompt
  // from an empty profile, which a digest cannot honestly do — there is no row
  // to take a read token from. That path is already a failed precondition.
  const digest: VariantDigestBuild = character
    ? buildVariantDigest(
        {
          characterId: input.characterId,
          name: character.name,
          profile,
          kind: input.kind,
          instruction: input.instruction,
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
    : { assembly: null, refusal: null };
  const legacyPrompt = digest.assembly?.prompt ?? "";
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

  // The Round 2 shadow (issue #256): the compiled prompt program is built
  // BESIDE this exact request and its verdict recorded on the row's meta.
  // Observation only — nothing the render sends reads it, and any shadow
  // failure degrades to a recorded verdict (character-shadow.ts), never a
  // failed or altered render.
  const shadowMeta =
    character && resolved && digest.assembly
      ? variantShadowMeta({
          characterId: input.characterId,
          characterName: character.name,
          revision: character.updatedAt.toISOString(),
          extraRevisions: load.revisions,
          kind: input.kind,
          instruction: input.instruction,
          assembly: digest.assembly,
          profile: resolved,
          references: packSelection?.references.map((entry) => entry.reference) ?? [],
          ...(input.sink === undefined ? {} : { sink: input.sink }),
        })
      : {};

  // The Stage 4 cutover (issue #256): when an ACTIVE binding exists for the
  // FINAL resolved model and this task, the prompt this render sends is the
  // compiled program rather than the legacy segment assembly. Everything else
  // about the render — profile, references, target, LoRA decisions, controls —
  // is unchanged, because the migration is the prompt and nothing else.
  const program = activeVariantProgram({
    character,
    resolved,
    assembly: digest.assembly,
    refused: digest.refusal !== null,
    nsfwRoute,
    packSelection,
    input,
    revisions: load.revisions,
  });
  const compiled = program?.kind === "compiled" ? program : null;
  // A refusal is NOT a fallback to the legacy paragraph. A binding resolved and
  // then could not compile — a missing pack, an unregistered dialect, a lost
  // required anchor — is a configuration or data fault on a lane that HAS been
  // cut over, and rendering something reasonable instead would hide it behind
  // an acceptable-looking picture. It fails the row through `failedPrecondition`
  // like the entity lane's, so no provider is called and no generation
  // diagnostic fires: a render that never ran did not fail to generate.
  const programRefusal = program?.kind === "refused" ? program.refusal : null;
  // The three prompt channels, decided together (`variantPromptTransport`).
  const transport = variantPromptTransport(legacyPrompt, digest.assembly?.segments, compiled);

  const { imageId } = await runImagePipeline({
    asset: {
      ownerId: input.userId,
      kind: "portrait_variant",
      entityKind: "character",
      entityId: input.characterId,
      prompt: transport.prompt,
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
        ...(digest.assembly?.digestMeta ?? {}),
        // The shadow verdict, beside the provenance it was measured over. It
        // keeps being recorded AFTER cutover: the shadow resolver sees the row
        // across its promotion to `active`, so candidate→active does not make
        // the observation disappear at the exact moment it is most worth having.
        ...shadowMeta,
        // The compiled program's own provenance, exactly as the entity lane
        // records it. Absent on a legacy render, which is how a row says which
        // prompt system built it.
        ...(compiled?.meta ?? {}),
      },
    },
    // The row is on record for a missing character too — failed, unlogged. An
    // ineligible digest refuses HERE rather than in `produce`, so the row fails
    // before provider spend and no generation diagnostic fires. The digest
    // refusal is checked FIRST because it is the older and more specific
    // failure: a cut that could not be assembled never had a program to compile.
    failedPrecondition: character
      ? (digest.refusal ?? programRefusal)
      : `character ${input.characterId} not found`,
    produce: async (asset) => {
      // Only reached once the character loaded, so the name fallback never fires.
      if (demo) return { ok: true, image: monogramSvg(`${character?.name ?? ""} ${input.kind}`) };
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
      const edit = await renderImageIntent(
        {
          profile: resolved,
          // Prompt, segments and the normalized negative in one decision. On a
          // legacy render the semantic segments stay authoritative and `prompt`
          // is the same segments compiled — safe to send both, because this
          // lane's profiles run `instruction_edit`, which passes the base
          // prompt through unchanged. On a compiled render the segments are
          // absent, or they would outrank the program and ship the prose it
          // replaced.
          ...transport,
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
