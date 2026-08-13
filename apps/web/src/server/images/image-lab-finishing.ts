import {
  effectiveImageLoraSelection,
  IMAGE_LAB_FINISHING_IDENTITY_STRATEGY,
  type ImageLabFailureCode,
  imageLabFinishingInstruction,
  imageLabFinishingRecipeProfile,
  type ImageLabFinishingVariant,
  type ImageLabInputList,
  type ImageLabSettings,
  type ImageModelProfile,
  type ImageRenderReference,
} from "@vesper/image-core";
import type { DiagnosticSink } from "@/contracts/diagnostics";
import { evaluateIdentityPackForProfile } from "./identity-pack-references";
import {
  carriesRawProviderBag,
  labFailure,
  RAW_BAG_REFUSAL,
  readOwnedImageBytes,
  resolvePinnedLabModel,
  runRecipeIntent,
  settleFailed,
} from "./image-lab-render";
import {
  finishingPassVariant,
  type ImageLabExperimentRow,
  type ImageLabRunPayload,
  ownedExperiment,
  primaryChatCharacterId,
  sourceRefusal,
  storedSettings,
  storedSourceExperimentId,
} from "./image-lab-store";

/**
 * The `finishing_pass` lane: re-render another experiment's result under an
 * instruction that forbids every change but the face.
 */

// --- finishing pass --------------------------------------------------------

/**
 * The finishing pass: another experiment's RESULT, re-edited under an instruction
 * that forbids every change but the face (plan §"Stage 3 — optional identity
 * finishing", extended by §"Stage 5 — one character LoRA pilot").
 *
 * It is the one kind whose ordered inputs the RUNNER resolves rather than the
 * admin. Both of them are facts the client cannot supply honestly: the base is
 * whatever the source experiment actually rendered (which may have changed, or
 * been deleted, since the form listed it), and the identity references come from
 * the pack, whose selection is a versioned policy decision — an admin choosing
 * the "identity reference" by hand would be running a different experiment under
 * this one's name. So they are read here and WRITTEN BACK onto the row, because
 * a record that only says what the runner intended is not a record of what it
 * sent.
 *
 * TWO ARMS as of Stage 5, differing only in what accompanies the base render:
 * the `identity` arm sends the pack's references, and the `lora_only` arm sends
 * nothing beside it and leans on a character LoRA instead. Everything else here
 * is shared deliberately — same source validation, same version pin, same
 * raw-bag refusal, same LoRA pre-resolution inside `runRecipeIntent`, same
 * recorded outcome — because a difference anywhere else would show up in the
 * comparison as if it were the LoRA's doing.
 *
 * The pack gate (`imageIdentityPackReferencesEnabled`) is deliberately NOT
 * consulted, on the identity-pack trial's own precedent: that flag governs
 * whether production LANES send pack references, and a bench measuring what the
 * references are worth cannot be gated on the decision it exists to inform.
 * Nothing here is player-visible, and every render still lands as a hidden
 * `lab_output`.
 */
export async function runFinishingPass(row: ImageLabExperimentRow, sink?: DiagnosticSink): Promise<ImageLabRunPayload> {
  const variant = finishingPassVariant(row, sink);
  const sourceExperimentId = storedSourceExperimentId(row, sink);
  if (sourceExperimentId === null) {
    return await settleFailed(
      row,
      labFailure("source_invalid"),
      "a finishing pass records the experiment it refines, and this row names none",
      sink,
    );
  }
  // Re-checked at run time even though the create path checked it: a source can
  // be deleted, or its output swept, between the queue and the render — and the
  // service is authoritative for rows that predate any of these rules.
  const source = await ownedExperiment(sourceExperimentId, row.ownerId);
  const refusal = sourceRefusal(sourceExperimentId, source, sink);
  const baseImageId = source?.resultImageId ?? null;
  if (refusal !== null || source === null || baseImageId === null) {
    return await settleFailed(row, labFailure("source_invalid"), refusal?.message ?? "the source experiment is gone", sink);
  }

  const resolved = await resolvePinnedLabModel(row.modelSlug, "a finishing pass", sink);
  if (!resolved.ok) {
    return await settleFailed(row, labFailure("version_unpinned"), resolved.message, sink);
  }
  const { model, versionId } = resolved;
  const columns = { requestedVersionId: versionId, modelSlug: model.slug };

  const settings = storedSettings(row, sink);
  if (carriesRawProviderBag(settings)) {
    return await settleFailed(row, labFailure("settings_unsupported"), RAW_BAG_REFUSAL, sink, { columns });
  }

  const base = await readOwnedImageBytes(baseImageId, row.ownerId);
  if (!base) {
    return await settleFailed(
      row,
      labFailure("input_missing"),
      `the source experiment's result image ${baseImageId} could not be read`,
      sink,
      { columns },
    );
  }

  const recipeProfile = imageLabFinishingRecipeProfile(model.id, variant);
  const accompanying = await finishingAccompanyingReferences(row, variant, settings, recipeProfile, sink);
  if (!accompanying.ok) {
    return await settleFailed(row, labFailure(accompanying.code), accompanying.message, sink, { columns });
  }

  // Written down as the ordered inputs the run actually sends, so the detail
  // screen shows every reference as a thumbnail exactly as it does for a
  // hand-ordered kind, and a verdict written weeks later can see them. On the
  // LoRA-only arm that list is one entry long, which is the arm's whole claim.
  const inputs: ImageLabInputList = [
    { position: 1, role: "before", imageId: baseImageId },
    ...accompanying.identity.map((reference, index) => ({
      position: index + 2,
      role: "identity" as const,
      imageId: reference.imageId,
    })),
  ];
  const references: ImageRenderReference[] = [
    { role: "before", buffer: base, sourceImageId: baseImageId, required: true },
    ...accompanying.identity.map((reference) => ({
      role: "identity" as const,
      buffer: reference.buffer,
      sourceImageId: reference.imageId,
      required: true,
    })),
  ];

  return await runRecipeIntent(row, {
    model,
    versionId,
    recipeProfile,
    references,
    // The rule the run is judged by IS the prompt; the admin's own text narrows
    // it and never replaces it (`imageLabFinishingInstruction`). The arm decides
    // one sentence of it — the one naming what the face is corrected toward,
    // which on the LoRA-only arm cannot be a reference nothing sent.
    prompt: imageLabFinishingInstruction(row.instruction, variant),
    controls: settings.controls,
    columns: { ...columns, inputs },
    // The base render, not the identity reference: this output is that image
    // with one thing changed, and provenance should say so.
    provenanceRole: "before",
    fallbackSourceImageId: baseImageId,
    sink,
  });
}

/** One identity reference the pack authorized, beside its bytes. */
interface FinishingIdentityReference {
  imageId: string;
  buffer: Buffer;
}

type FinishingIdentityResult =
  | { ok: true; references: FinishingIdentityReference[] }
  | { ok: false; message: string };

/**
 * What one finishing arm sends BESIDE the base render, or the reason it cannot
 * run — the only place the two arms diverge before `runRecipeIntent`.
 *
 * Exhaustive over the variant, so a third arm is a compile error here rather than
 * a silent fall-through into whichever arm happened to be written last — the
 * failure mode that would matter most, since a mislabelled arm poisons the
 * comparison rather than breaking the run.
 */
type FinishingAccompanyingResult =
  | { ok: true; identity: FinishingIdentityReference[] }
  | { ok: false; code: ImageLabFailureCode; message: string };

/**
 * The refusal that keeps the LoRA-only arm honest.
 *
 * The create schema already refuses a `lora_only` request with no LoRA, so this
 * catches exactly two things: a row stored before that rule existed, and a caller
 * that reached the service around the request schema. Both settle pre-spend,
 * because a run with neither weights nor references would return the source image
 * with a fresh id and file it as a comparison arm — the most expensive kind of
 * nothing this bench can produce.
 */
const LORA_ONLY_WITHOUT_LORA =
  "a LoRA-only pass measures the LoRA alone and this row names none; with no weights and no identity reference " +
  "the pass would only re-render the source image";

async function finishingAccompanyingReferences(
  row: ImageLabExperimentRow,
  variant: ImageLabFinishingVariant,
  settings: ImageLabSettings,
  recipeProfile: ImageModelProfile,
  sink?: DiagnosticSink,
): Promise<FinishingAccompanyingResult> {
  switch (variant) {
    case "identity": {
      const identity = await finishingIdentityReferences(row, sink);
      return identity.ok
        ? { ok: true, identity: identity.references }
        : { ok: false, code: "identity_unavailable", message: identity.message };
    }
    case "lora_only": {
      // The pack is never asked — not asked and discarded, not asked and refused.
      // `identity_unavailable` is unreachable on this arm by construction, which
      // is what makes it a measurement of the weights instead of a measurement of
      // whatever the pack happened to offer.
      //
      // The selection is read through the shared helper so the LoRA this arm
      // checks for is the same one `runRecipeIntent` then resolves; deriving it
      // twice is how a pass could pass this gate and resolve a different LoRA.
      const selection = effectiveImageLoraSelection(recipeProfile.controlDefaults, settings.controls);
      return selection === undefined
        ? { ok: false, code: "input_missing", message: LORA_ONLY_WITHOUT_LORA }
        : { ok: true, identity: [] };
    }
  }
}

/**
 * The identity references a finishing pass improves the face TOWARD, drawn from
 * the subject's identity pack.
 *
 * The pack is asked rather than the character row, because "which image is this
 * character's identity" is a versioned, measured decision the pack machinery
 * already owns — reference size, face size, policy version and provenance
 * included. Re-deriving it here would be a second answer to a settled question,
 * and the two would drift the first time either moved.
 *
 * The SUBJECT is the experiment's own character, falling back to the primary
 * character of its chat, because a finishing pass inherits its subject from a
 * source that may have been a scene (which files against a chat, not a
 * character). A pass with no subject at all is refused: there is no pack to ask.
 *
 * Every refusal carries the pack's own blocking code into the recorded message,
 * so "no usable face" and "the source portrait changed" stay tellable apart on
 * the row without the lab restating a vocabulary it does not own.
 */
async function finishingIdentityReferences(
  row: ImageLabExperimentRow,
  sink?: DiagnosticSink,
): Promise<FinishingIdentityResult> {
  const characterId = row.characterId ?? (row.chatId === null ? null : await primaryChatCharacterId(row.chatId));
  if (characterId === null) {
    return { ok: false, message: "this experiment names no character, so no identity pack can be asked for references" };
  }

  const evaluated = await evaluateIdentityPackForProfile({
    ownerId: row.ownerId,
    characterId,
    strategy: IMAGE_LAB_FINISHING_IDENTITY_STRATEGY,
    // The bench's own purpose, shared with the identity-pack trial: this is
    // measurement, not a player-visible render.
    purpose: "admin_trial",
    sink,
  });
  if (!evaluated.eligible) {
    return { ok: false, message: `the identity pack offered no reference (${evaluated.code}: ${evaluated.messageKey})` };
  }

  const references: FinishingIdentityReference[] = [];
  for (const candidate of evaluated.candidates) {
    const buffer = await readOwnedImageBytes(candidate.imageId, row.ownerId);
    if (buffer) references.push({ imageId: candidate.imageId, buffer });
  }
  if (references.length === 0) {
    return { ok: false, message: "the identity pack's references could not be read for this owner" };
  }
  return { ok: true, references };
}
