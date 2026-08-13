import { and, eq, inArray } from "drizzle-orm";
import {
  type ImageLabControlKind,
  type ImageLabInput,
  imageLabTwoCharacterRecipeProfile,
  type ImageRenderReference,
  isImageLabControlRole,
  referenceCapacity,
  withReviewedImageQuality,
} from "@vesper/image-core";
import type { DiagnosticSink } from "@/contracts/diagnostics";
import { db, images } from "../db";
import {
  carriesRawProviderBag,
  checkControlBinding,
  labFailure,
  RAW_BAG_REFUSAL,
  readOrderedInputBytes,
  resolvePinnedLabModel,
  runRecipeIntent,
  settleFailed,
} from "./image-lab-render";
import {
  type ImageLabExperimentRow,
  type ImageLabRunPayload,
  labCharacterNames,
  storedInputs,
  storedSettings,
  twoCharacterCast,
} from "./image-lab-store";

/**
 * The `two_character_scene` lane — the one kind whose references carry a named
 * subject into the prompt.
 */

// --- two-character scenes --------------------------------------------------

/**
 * The rule a two-character row must satisfy before anything else is read,
 * restated on the row when it does not.
 *
 * The create schema enforces all of it, so reaching this message means the row
 * arrived around that schema — an earlier deploy, or a caller that reached the
 * service directly. The runner stays authoritative anyway, because the failure it
 * prevents is not a broken render but a MISFILED one: two inputs and one name
 * would render something, and its verdict would be recorded against a cast the
 * experiment cannot describe.
 */
const TWO_CHARACTER_SUBJECT_RULE =
  "a two-character scene sends exactly two identity references, each naming a different character it depicts";

/** The refusal for a control-role image on a run that declares no fixture. */
const UNDECLARED_CONTROL_ROLE =
  "this experiment sends a structural control image but declares none; the record would not say what the render was " +
  "controlled by, so no verdict about the control could be filed against it";

/** Half a control pointer on a row the create schema would have refused whole. */
const HALF_CONTROL_POINTER =
  "a control image and its kind are recorded together; half a pointer names a fixture nothing can check or a check " +
  "with no fixture to run it against";

/**
 * A two-character scene: two identity references, one per character, plus an
 * OPTIONAL structural control (plan §"Two-character recipe", §"Stage 6").
 *
 * It is the controlled runner's shape with three differences, each of which is
 * the point of the kind rather than an incidental variation:
 *
 * - **Two subjects, named.** The identity inputs carry a `characterId` each, and
 *   the runner resolves both to NAMES so the compose strategy can bind a face to
 *   a numbered image ("Image 1: the identity reference for Sabrina"). Without
 *   that the request is two anonymous portraits and a hope, and every failure the
 *   stage measures — swapping above all — becomes unattributable between the
 *   model and a prompt that never distinguished them. Two refusals guard the
 *   binding rather than the reference (`subject_invalid`, both pre-spend): a name
 *   that cannot tell the two apart, and an image that is not a render of the
 *   character it is bound to.
 * - **The control is optional.** "Do two people survive?" and "can one skeleton
 *   guide both of them?" are separate questions, and the first is asked by a run
 *   that sends no fixture. A declared control still passes every Stage 0 gate
 *   unchanged.
 * - **Capacity REFUSES rather than trims**, which is the controlled runner's
 *   behaviour inverted, and deliberately: there the overflow can only reach an
 *   optional content role, while here every reference is required and a trim
 *   would silently drop a person. See the pre-check below for why this kind
 *   keeps a refusal of its own now that the intent path refuses too.
 */
export async function runTwoCharacterScene(row: ImageLabExperimentRow, sink?: DiagnosticSink): Promise<ImageLabRunPayload> {
  const inputs = storedInputs(row, sink);
  if (inputs.length === 0) {
    return await settleFailed(row, labFailure("input_missing"), "the experiment records no ordered inputs", sink);
  }

  const identities = inputs.filter((input) => input.role === "identity");
  const subjectIds = identities.flatMap((input) => (input.characterId === undefined ? [] : [input.characterId]));
  if (identities.length !== 2 || subjectIds.length !== 2 || new Set(subjectIds).size !== 2) {
    return await settleFailed(row, labFailure("input_missing"), TWO_CHARACTER_SUBJECT_RULE, sink);
  }

  // Owner-scoped, and both names are read BEFORE the version is resolved: a
  // subject this owner does not have is a fact about the row that no amount of
  // provider work would change, and the name is not decoration here — it is
  // prompt text the run cannot be assembled without.
  const cast = await labCharacterNames(subjectIds, row.ownerId);
  if (!cast) {
    return await settleFailed(
      row,
      labFailure("input_missing"),
      "an identity input names a character this owner does not have, so the render has no name to bind that face to",
      sink,
    );
  }
  // Checked here, beside the ownership read and BEFORE the version resolution,
  // for the same reason: whether two names can tell two faces apart is a fact
  // about these rows, and no amount of provider work would change it.
  const named = twoCharacterCast(subjectIds, cast);
  if (!named.ok) {
    return await settleFailed(row, labFailure("subject_invalid"), named.message, sink);
  }

  const resolved = await resolvePinnedLabModel(row.modelSlug, "a two-character scene", sink);
  if (!resolved.ok) {
    return await settleFailed(row, labFailure("version_unpinned"), resolved.message, sink);
  }
  const { model, versionId } = resolved;
  const columns = { requestedVersionId: versionId, modelSlug: model.slug };

  const controlImageId = row.controlImageId;
  if ((controlImageId === null) !== (row.controlKind === null)) {
    return await settleFailed(row, labFailure("control_invalid"), HALF_CONTROL_POINTER, sink, { columns });
  }
  if (controlImageId === null) {
    // No fixture declared, so no image may arrive under a control role. The
    // uncontrolled arm's whole claim is that nothing structural was sent, and an
    // undeclared skeleton riding along would send one the record does not name —
    // the same "verdict about an image nobody can identify" the Stage 0 binding
    // gates exist to prevent, reached from the other direction.
    if (inputs.some((input) => isImageLabControlRole(input.role))) {
      return await settleFailed(row, labFailure("control_invalid"), UNDECLARED_CONTROL_ROLE, sink, { columns });
    }
  } else {
    const controlRefusal = await checkControlBinding(row, inputs, sink);
    if (controlRefusal) {
      return await settleFailed(row, labFailure(controlRefusal.code), controlRefusal.message, sink, { columns });
    }
  }
  // Safe to read straight through now: the pairing check above refused every row
  // where exactly one half of the pointer was set.
  const recipeControl: ImageLabControlKind | null = controlImageId === null ? null : row.controlKind;

  const settings = storedSettings(row, sink);
  if (carriesRawProviderBag(settings)) {
    return await settleFailed(row, labFailure("settings_unsupported"), RAW_BAG_REFUSAL, sink, { columns });
  }

  // The plan's own two-character rule: "if all required identities and the
  // selected control do not fit, the workflow is ineligible rather than silently
  // dropping a character".
  //
  // It is no longer the only thing enforcing it: `planImageRender` now refuses a
  // plan that drops a reference the caller marked required
  // (`image_profile.required_reference_dropped`), so the hole this pre-check was
  // written against — the set-based required-ROLE check finding `identity`
  // present after the second character was trimmed, and a solo portrait going
  // out under a row that says two people — is closed for every caller.
  //
  // It stays because the answer it gives this kind is the better one, in two
  // ways. It speaks the lab's own vocabulary (`capacity_exceeded`, which the
  // panel already explains to an admin) and states the plan's ineligibility rule
  // in the plan's words, where the planner can only report a role and a reason;
  // and it fires before eligibility, the LoRA read and the recipe compile run at
  // all, so an experiment that was never going to fit settles on its row without
  // any of that work.
  //
  // Capacity is read off the EFFECTIVE model for the probe's reason — the quality
  // overlay only merges `extraInput` today, and reading through it is what keeps
  // this check about the model the provider is handed if that ever changes.
  const effectiveModel = withReviewedImageQuality(model);
  const capacity = referenceCapacity(effectiveModel);
  const requiredCount = identities.length + (recipeControl === null ? 0 : 1);
  if (requiredCount > capacity.max) {
    return await settleFailed(
      row,
      labFailure("capacity_exceeded"),
      `${effectiveModel.slug} accepts ${String(capacity.max)} reference image(s) and this experiment requires ${String(requiredCount)}; a two-character scene is ineligible rather than dropping a character to fit`,
      sink,
      { columns },
    );
  }

  const read = await readOrderedInputBytes(inputs, row.ownerId);
  if (!read.ok) {
    return await settleFailed(row, labFailure("input_missing"), read.message, sink, { columns });
  }
  // The bytes are readable and this owner's; whose FACE they are is a separate
  // question, and the one the numbered bindings answer out loud. Asked after the
  // read so an unreadable image keeps reporting as the missing input it is.
  const misbound = await identityImageSubjectRefusal(identities, row.ownerId);
  if (misbound) {
    return await settleFailed(row, labFailure("subject_invalid"), misbound, sink, { columns });
  }
  // EVERY reference is required, unlike a controlled run's optional content
  // roles: the recipe allows nothing but the two identities and the one control,
  // so there is nothing here a render could go without and still be the
  // experiment the row describes. The subject rides the identity references, so
  // the compose strategy names the right person in the right numbered slot even
  // if the policy reorders them.
  const references: ImageRenderReference[] = read.ordered.map(({ input, buffer }) => ({
    role: input.role,
    buffer,
    sourceImageId: input.imageId,
    required: true,
    ...(input.characterId === undefined ? {} : { subject: named.names.get(input.characterId) ?? input.characterId }),
  }));

  return await runRecipeIntent(row, {
    model,
    versionId,
    recipeProfile: imageLabTwoCharacterRecipeProfile(model.id, recipeControl),
    references,
    prompt: row.instruction,
    controls: settings.controls,
    columns,
    // The first character's reference: this output depicts two people and
    // provenance can only point at one, so it points at the one the send leads
    // with rather than at whichever image the policy happened to order first.
    provenanceRole: "identity",
    fallbackSourceImageId: inputs[0]?.imageId,
    sink,
  });
}


/**
 * Why an identity input's IMAGE cannot stand for the character it is bound to —
 * or `null` when every one of them can.
 *
 * The bindings are what make this kind's evidence readable: the send claims
 * "Image 1 is Sabrina", and a verdict of `identities_swapped` is a statement
 * about the MODEL only if that claim held when the bytes went out. Nothing
 * upstream establishes it — the create path checks that the caller owns the
 * character, the byte read checks that they own the image, and neither asks
 * whether those pixels depict that person. A direct API caller can pair
 * character B's id with character A's portrait, and the run would send A's face
 * under B's name and record the swap it manufactured as the model's doing.
 *
 * `images.entityKind`/`entityId` is the association the app already keeps, and
 * the portrait listing the lab's picker reads (`listOwnedPortraits`) selects on
 * exactly those two columns, so every image a form can offer for a slot passes
 * here. It also closes the one-portrait-for-both case for free: an image is filed
 * against at most one entity, so two different characters — which this kind
 * requires — can never both be satisfied by a single image.
 *
 * One query for both ids, like {@link labCharacterNames}, and no byte is read
 * again: the question is which row the image is filed under, which its pixels
 * cannot answer.
 */
async function identityImageSubjectRefusal(inputs: readonly ImageLabInput[], ownerId: string): Promise<string | null> {
  const bound = inputs.flatMap((input) =>
    input.characterId === undefined ? [] : [{ ...input, characterId: input.characterId }],
  );
  if (bound.length === 0) return null;
  const rows = await db()
    .select({ id: images.id, entityKind: images.entityKind, entityId: images.entityId })
    .from(images)
    .where(
      and(
        inArray(
          images.id,
          bound.map((input) => input.imageId),
        ),
        eq(images.ownerId, ownerId),
      ),
    );
  const filed = new Map(rows.map((row) => [row.id, row]));
  for (const input of bound) {
    const image = filed.get(input.imageId);
    if (image?.entityKind !== "character" || image.entityId !== input.characterId) {
      return `the identity image at position ${String(input.position)} is not a render of character ${input.characterId}, so this scene would send one person's face under another's name and every verdict about swapping would be about the request`;
    }
  }
  return null;
}
