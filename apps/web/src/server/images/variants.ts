import { and, eq } from "drizzle-orm";
import { characterProfileSchema, emptyCharacterProfile, resolveAttributes } from "@/contracts";
import { IMAGE_TARGET_ASPECT } from "@vesper/image-core";
import { parseOr } from "@/lib/parse";
import { characters, db, images } from "../db";
import { isDemoMode } from "../ai";
import { resolveImageProfileForTask } from "./model-profiles";
import { renderImageIntent } from "./render-intent";
import { logEvent } from "../events";
import { log } from "@/server/log";
import { diag, type DiagnosticSink } from "@/contracts/diagnostics";
import { HIDDEN_IMAGE_KINDS, runImagePipeline, type ImageKind } from "./assets";
import { identityPackRenderReferences, type IdentityPackRenderReferencesResult } from "./identity-pack-consume";
import { queueIdentityPackPreparation } from "./identity-pack-preparation";
import { monogramSvg } from "./monogram";
import { apparentAgeAnchor } from "./prompts-appearance";
import { buildVariantInstruction, type VariantKind } from "./prompts-variant";

export interface GenerateVariantInput {
  characterId: string;
  userId: string;
  kind: VariantKind;
  instruction: string;
  /** Registry model id from the New Variant picker; absent uses the surface default. */
  modelId?: string;
  sink?: DiagnosticSink;
}

/**
 * Portrait-variant pipeline (docs/images/pipelines.md §Portrait variants):
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
 * The render seam reports an edit failure as `ok: false` rather than throwing, so this
 * lane's generation failure is a RETURNED failure and pushes its own
 * `images.variant.generate_failed` (the ruled normalization). Its precondition
 * miss — no character — stays diagnostic-free, exactly like the entity lane's
 * not-found; the pack evaluation pushes its own diagnostics for the rest.
 */
export async function generateVariant(input: GenerateVariantInput): Promise<string> {
  const demo = isDemoMode();
  // The New Variant section now has its OWN model picker (image-model-registry):
  // before the registry, only one provider model could edit, so this lane had no
  // choice to make and silently used it.
  const resolved = demo ? null : await resolveImageProfileForTask("variant", input.modelId, input.sink);
  const model = resolved?.model ?? null;
  const [character] = await db().select().from(characters).where(eq(characters.id, input.characterId)).limit(1);
  const profile = parseOr(
    characterProfileSchema,
    character?.profile ?? {},
    emptyCharacterProfile(),
    undefined,
    "characters.profile",
  );
  const ageAnchor = apparentAgeAnchor(character?.name ?? "", resolveAttributes(profile.attributes, []));
  const prompt = buildVariantInstruction(input.kind, input.instruction, ageAnchor);
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
        ...(packSelection ? { identityReferences: packSelection.provenance } : {}),
      },
    },
    // The row is on record for a missing character too — failed, unlogged.
    failedPrecondition: character ? null : `character ${input.characterId} not found`,
    produce: async (asset) => {
      // Only reached once the character loaded, so the name fallback never fires.
      if (demo) return { ok: true, image: monogramSvg(`${character?.name ?? ""} ${input.kind}`) };
      // Precondition this lane can't satisfy, not a generation that failed: no diagnostic.
      if (!resolved) return { ok: false, error: "no image model is registered for portrait variants" };
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
          prompt,
          // The identity the variant instruction modifies, which this lane
          // always re-rolls from rather than chaining edits: the pack's
          // candidate references for the resolved profile.
          references: packSelection.references.map((entry) => entry.reference),
          target: { aspectRatio: IMAGE_TARGET_ASPECT },
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
        return { ok: false, error };
      }
      return { ok: true, image: edit.image };
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
 * Owner-strict in its OWN queries (security-authz.plan.md §Follow-ups item 2):
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
  // from a crop of a crop (image-identity-packs.spec.data.md §"Hidden image asset").
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
