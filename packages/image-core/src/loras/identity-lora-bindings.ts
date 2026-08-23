import { z } from "zod";

/**
 * The association between one identity pack revision and the character LoRA
 * trained from it (sd-rendering-package.plan.md §9).
 *
 * **Why a binding exists at all.** The LoRA library already stores the weights
 * and the rules for sending them (`image-loras.ts`), and the identity pack
 * already stores the canonical face. What neither can answer is the question
 * that decides whether a render should use those weights: *were they trained
 * from the pack this character has today?* A LoRA is a photograph of a dataset
 * at a moment. Re-crop the pack, replace the canonical portrait, re-curate the
 * training set, and the weights keep working — they just gradually stop being a
 * likeness of the character the rest of Vesper describes. Nothing fails; the
 * renders simply drift. This row is what makes that drift detectable.
 *
 * **Why it is not on `image_loras`.** The library is model-family-neutral and
 * holds style LoRAs, NSFW LoRAs and character LoRAs alike; most of its rows have
 * no identity pack and never will. Hanging six nullable training columns off it
 * would describe training on rows that were never trained, and the plan is
 * explicit that Vesper keeps ONE LoRA library rather than growing a second one
 * (§9, §22). A binding is a separate, small row that points at both sides.
 *
 * **Why it is not in `@vesper/image-sd`.** §9 puts the association in the
 * application/database layer. The SD package receives generic training manifests
 * and hands back generic provenance; it does not know that Vesper has identity
 * packs, characters, or a LoRA library. What lives here is the shape the
 * database stores and the one decision that shape supports — both
 * provider-neutral, both pure, and neither aware of Stable Diffusion beyond an
 * opaque recipe id.
 *
 * Nothing in this module reads a row or calls a provider; the store is
 * `apps/web/src/server/images/identity-lora-bindings.ts`.
 */

/**
 * A binding's lifecycle.
 *
 * Three states rather than a boolean because the plan's Stage 4 trains SEVERAL
 * LoRAs per pack on purpose — rank 8 and rank 16 are compared against each other
 * — and both of those exist at once, un-promoted, while the comparison runs.
 * `experimental` is that state, and it is the default: a freshly trained LoRA has
 * proven nothing yet. `active` is the one the render path would reach for, and at
 * most one binding per pack may hold it (enforced by a partial unique index, not
 * by application discipline). `retired` is the losing arm, kept rather than
 * deleted so an image rendered under it can still explain itself.
 *
 * `schema.ts` imports this tuple for its `text(..., { enum })` column, so the
 * column and the parser cannot drift.
 */
export const identityLoraBindingStates = ["experimental", "active", "retired"] as const;
export const identityLoraBindingStateSchema = z.enum(identityLoraBindingStates);
export type IdentityLoraBindingState = (typeof identityLoraBindingStates)[number];

/**
 * The fields a stored row and a create request share — §9's provenance list,
 * minus the two entries that live better elsewhere.
 *
 * "Creation date" is `created_at`, storage bookkeeping like everywhere else in
 * this package's row schemas. "Model family/checkpoint compatibility" is
 * deliberately NOT restated as a family enum: {@link baseCheckpoint} answers the
 * checkpoint question exactly, `trainingRecipeId` carries its family as an id
 * prefix, and the LoRA row's own `compatibleModelSlugs` is what actually gates a
 * render. A third spelling of compatibility is how one of the three goes stale.
 */
const identityLoraBindingFields = {
  /** The pack REVISION row, not the character — supersession is the staleness signal. */
  identityPackId: z.string().min(1),
  /** The `image_loras` row holding the weights. */
  loraId: z.string().min(1),
  /**
   * The base weights the LoRA was trained against, as the training recipe names
   * them. A LoRA is only valid on the checkpoint it was trained on, so this is
   * the fact that outlives every label anyone gives the row.
   */
  baseCheckpoint: z.string().trim().min(1).max(200),
  /**
   * `fingerprintSdTrainingDataset` over the training set (§9).
   *
   * Recorded, not yet compared. It is the evidence that answers "was this LoRA
   * trained from the images the pack holds now?" the day Vesper can rebuild a
   * training set from a pack without a human curating it; until then a human
   * re-curates, and the fingerprint is how they tell two curations apart.
   */
  datasetFingerprint: z.string().trim().min(1).max(64),
  /** How many images the training set held — §8's 12–20 window, as it actually ran. */
  datasetImageCount: z.number().int().positive(),
  /** The training recipe id, opaque here (`sdxl/character-lora-r8`). */
  trainingRecipeId: z.string().trim().min(1).max(120),
  /** Its revision, so a recipe that is later re-tuned cannot rewrite history. */
  trainingRecipeRevision: z.number().int().positive(),
  /** LoRA rank — the one variable Stage 4's comparison moves. */
  rank: z.number().int().min(1).max(128),
  /**
   * The word the LoRA answers to, or null when the recipe trained none.
   *
   * Nullable rather than optional because "this LoRA has no trigger word" is a
   * fact worth storing: a render that silently appended one would be prompting
   * with a token the weights never saw.
   */
  triggerToken: z.string().trim().min(1).max(120).nullable().default(null),
  /**
   * The trainer's own id for the run that produced the weights — opaque to this
   * package, and the only way back to the logs, the cost line and the original
   * artifact after the local output directory is gone.
   */
  trainingRunRef: z.string().trim().min(1).max(200).nullable().default(null),
  state: identityLoraBindingStateSchema.default("experimental"),
};

/**
 * One binding row on the wire.
 *
 * `createdAt`/`updatedAt` are columns only, deliberately absent for the reason
 * recorded on `imageLoraSchema`: they are storage bookkeeping, and a client that
 * displayed them would start depending on them.
 */
export const identityLoraBindingSchema = z.object({
  id: z.string().min(1),
  ...identityLoraBindingFields,
});
export type IdentityLoraBinding = z.infer<typeof identityLoraBindingSchema>;

/** Degraded-safe list: a malformed payload parses to `[]` (docs/resilience.md §1). */
export const identityLoraBindingListSchema = z
  .array(identityLoraBindingSchema)
  .catch((): IdentityLoraBinding[] => []);

/** What a create accepts. `id` is the server's to mint; `state` defaults to `experimental`. */
export const identityLoraBindingCreateRequestSchema = z.object(identityLoraBindingFields);
export type IdentityLoraBindingCreateRequest = z.infer<typeof identityLoraBindingCreateRequestSchema>;

/**
 * Why a binding may not be used.
 *
 * Deliberately only two, and both decidable from rows Vesper already has. A
 * third — "the dataset changed" — is not here even though the fingerprint is
 * stored, because nothing can recompute that fingerprint yet: training sets are
 * curated by hand in Stage 4, so the only honest comparison is between two
 * recorded fingerprints, and there is no second one to compare against. A code
 * that could never fire would read as coverage this does not have.
 */
export const identityLoraUnusableReasons = ["retired", "identity_pack_superseded"] as const;
export type IdentityLoraUnusableReason = (typeof identityLoraUnusableReasons)[number];

export type IdentityLoraBindingUsability =
  | { usable: true }
  | { usable: false; reason: IdentityLoraUnusableReason };

export interface EvaluateIdentityLoraBindingInput {
  binding: Pick<IdentityLoraBinding, "identityPackId" | "state">;
  /**
   * The character's CURRENT identity pack revision id, or null when the
   * character has no current pack.
   *
   * Null makes every binding unusable, which is the conservative reading and the
   * right one: a character with no current pack has no canonical face, so
   * nothing can claim to be a likeness of it.
   */
  currentIdentityPackId: string | null;
}

/**
 * Whether a binding still describes the character it was trained for.
 *
 * The order of the two checks matters. `retired` is a decision a human made, and
 * it holds whatever the pack does — a losing trial arm does not become usable
 * again because the pack was re-cropped. Supersession is checked second, and it
 * is checked by IDENTITY rather than by revision number: pack rows are per
 * revision and only one carries `current`, so "the binding names a pack that is
 * not the current one" is the whole test, with no arithmetic to get wrong and
 * nothing to re-derive from a monotonic counter.
 *
 * `experimental` is deliberately usable. It means "not yet promoted", not "not
 * yet valid" — Stage 4's trained LoRAs have to be renderable in order to be
 * compared at all, and a comparison harness that could not run an unproven arm
 * would make promotion impossible.
 */
export function evaluateIdentityLoraBinding(input: EvaluateIdentityLoraBindingInput): IdentityLoraBindingUsability {
  if (input.binding.state === "retired") return { usable: false, reason: "retired" };
  if (input.currentIdentityPackId === null || input.binding.identityPackId !== input.currentIdentityPackId) {
    return { usable: false, reason: "identity_pack_superseded" };
  }
  return { usable: true };
}
