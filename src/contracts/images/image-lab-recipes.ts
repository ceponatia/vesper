import type { IdentityReferenceStrategy } from "./identity-pack";
import {
  imageLabControlRole,
  type ImageLabControlKind,
  type ImageLabExperimentKind,
  type ImageLabFinishingVariant,
} from "./image-lab";
import type { ImageReferenceRole } from "./image-model-capabilities";
import {
  emptyImageControlDefaults,
  type ImageModelProfile,
  type ImageProfileTask,
  type ImageReferencePolicy,
} from "./image-model-profiles";

/**
 * The Advanced Image Lab's recipes — code-defined `ImageModelProfile` values for
 * the `controlled_portrait` / `controlled_scene` experiment kinds
 * (qwen-advanced-image-subsystem.spec.md, Stages 1–2), for the Stage 3
 * `finishing_pass`, and for the Stage 6 `two_character_scene`.
 *
 * A recipe is CODE, deliberately not a row in `image_model_profiles`, for two
 * reasons that outweigh the convenience of editing it on the admin page:
 *
 * - A seeded row under task `variant` or `scene` would be listed by the
 *   ordinary per-task profile loaders and surface in the lane pickers — the
 *   experiment would leak into the normal site as a selectable rendering
 *   option, which the lab's ownership rules exist to forbid.
 * - A recipe IS prompt logic: it decides which roles are named to the model
 *   and in what order. The profile layer's own rule — "a profile row must
 *   never introduce prompt logic that no test has seen" — applies with full
 *   force, so recipes are versioned by the repo exactly like the prompt
 *   strategies they select.
 *
 * The per-experiment settings overlay remains the tuning knob: a recipe fixes
 * the SHAPE of the request, and the experiment's own normalized `controls`
 * move the numbers within it.
 */

/**
 * The two kinds whose recipe is a (kind × REQUIRED control) pair. Declared as a
 * subset of the experiment kinds (the `satisfies` is the tie) so a renamed kind
 * breaks here at compile time instead of silently orphaning its recipe.
 *
 * Not "every kind that runs on the render-intent path" — the finishing pass and
 * the two-character scene both do, and neither is here. What this list selects is
 * the kinds {@link imageLabRecipeProfile} serves: the ones that always declare a
 * control, so their recipe is indexed by a non-null control kind. A
 * `two_character_scene` is deliberately absent because its control is OPTIONAL
 * and it has a runner and a recipe of its own; adding it would make
 * `imageLabRecipeKey`'s non-null `controlKind` a lie for one member.
 */
export const imageLabControlledKinds = [
  "controlled_portrait",
  "controlled_scene",
] as const satisfies readonly ImageLabExperimentKind[];
export type ImageLabControlledKind = (typeof imageLabControlledKinds)[number];

/** Whether a kind names a controlled recipe. */
export function isImageLabControlledKind(kind: ImageLabExperimentKind): kind is ImageLabControlledKind {
  return imageLabControlledKinds.some((controlled) => controlled === kind);
}

/**
 * One recipe's stable identity: the kind and the control it runs, joined so
 * "controlled_portrait/pose" reads as what it is. It doubles as the profile's
 * `key` and the tail of its id, and it is what a recorded outcome cites — a
 * verdict on a controlled render has to say which recipe shaped it, and a key
 * assembled two ways would let the record and the runner disagree.
 */
export function imageLabRecipeKey(kind: ImageLabControlledKind, controlKind: ImageLabControlKind): string {
  return `${kind}/${controlKind}`;
}

/**
 * The profile task a recipe declares. Not decoration: the task drives
 * `profileEligibility`'s identity-critical screening, so a weak-identity or
 * img2img model REFUSES a controlled run rather than rendering a stranger —
 * the same protection every production variant and scene render gets.
 */
export function imageLabRecipeTask(kind: ImageLabControlledKind): Extract<ImageProfileTask, "variant" | "scene"> {
  switch (kind) {
    case "controlled_portrait":
      return "variant";
    case "controlled_scene":
      return "scene";
  }
}

/**
 * The id namespace recipe profiles live under. The slash keeps a recipe id
 * shaped unlike any database id, so a stored `profileId` citing one is legible
 * at a glance as "code-defined, not a row".
 */
export const IMAGE_LAB_RECIPE_PROFILE_ID_PREFIX = "image-lab/";

/**
 * The content roles a recipe accepts beyond its two required ones. A portrait
 * dresses and styles ONE subject (`outfit`, `style`, `object`); a scene places
 * that subject somewhere (`location` joins, `object` yields its slot — scene
 * composition is what the location reference is for).
 */
function imageLabRecipeContentRoles(kind: ImageLabControlledKind): ImageReferenceRole[] {
  switch (kind) {
    case "controlled_portrait":
      return ["outfit", "style", "object"];
    case "controlled_scene":
      return ["location", "outfit", "style"];
  }
}

/**
 * A recipe's reference policy: identity and the declared control are REQUIRED
 * (a controlled render missing either is not a controlled render of anybody),
 * the kind's content roles are allowed after them, `roleOrder` fixes the send
 * order the compose wording numbers, and every role is capped at one — a
 * second image of any role would make an unhonoured control unattributable,
 * the same argument the Stage 0 input rule makes about two identities.
 */
function imageLabRecipePolicy(kind: ImageLabControlledKind, controlKind: ImageLabControlKind): ImageReferencePolicy {
  const controlRole = imageLabControlRole(controlKind);
  const ordered: ImageReferenceRole[] = ["identity", controlRole, ...imageLabRecipeContentRoles(kind)];
  const maxPerRole: Partial<Record<ImageReferenceRole, number>> = {};
  for (const role of ordered) maxPerRole[role] = 1;
  // Each field gets its own array: the policy type is mutable, and two fields
  // sharing one instance would let an edit to either silently rewrite both.
  return { requiredRoles: ["identity", controlRole], allowedRoles: [...ordered], roleOrder: [...ordered], maxPerRole };
}

/** What a fixture of each kind is, in the label's words. */
function imageLabRecipeControlNoun(controlKind: ImageLabControlKind): string {
  switch (controlKind) {
    case "pose":
      return "pose skeleton";
    case "depth":
      return "depth map";
    case "edge":
      return "edge map";
  }
}

/** The label's leading noun — what the recipe renders. */
function imageLabRecipeSubject(kind: ImageLabControlledKind): string {
  switch (kind) {
    case "controlled_portrait":
      return "Controlled portrait";
    case "controlled_scene":
      return "Controlled scene";
  }
}

/**
 * The fully-shaped profile one controlled run executes: `edit` operation,
 * `multi_reference_compose` strategy (the wording that names every reference's
 * purpose in order — the strategy the recipe exists to exercise), the policy
 * above, inert control defaults, no overrides, no timeout of its own.
 *
 * `imageModelId` is the caller's resolved model rather than a constant because
 * a recipe is model-agnostic on purpose: the experiment names its model and
 * the fallback-connector protocol depends on being able to point the same
 * recipe at a second registration. `enabled`/`isDefault`/`builtin`/`sort` are
 * the inert values — this profile is never listed, resolved, or sorted; it is
 * handed straight to eligibility and the compile step by the lab runner.
 */
export function imageLabRecipeProfile(
  kind: ImageLabControlledKind,
  controlKind: ImageLabControlKind,
  imageModelId: string,
): ImageModelProfile {
  const key = imageLabRecipeKey(kind, controlKind);
  return {
    id: `${IMAGE_LAB_RECIPE_PROFILE_ID_PREFIX}${key}`,
    imageModelId,
    key,
    label: `${imageLabRecipeSubject(kind)} — ${imageLabRecipeControlNoun(controlKind)}`,
    task: imageLabRecipeTask(kind),
    operation: "edit",
    promptStrategy: "multi_reference_compose",
    referencePolicy: imageLabRecipePolicy(kind, controlKind),
    controlDefaults: emptyImageControlDefaults(),
    providerOverrides: {},
    timeoutMs: null,
    enabled: true,
    isDefault: false,
    builtin: false,
    sort: 0,
  };
}

// ---------------------------------------------------------------------------
// Stage 6 — the two-character recipe
// ---------------------------------------------------------------------------

/**
 * The two-character recipe's stable name, per control arm — and it has an arm
 * for NO control, which is what makes it a function of a nullable kind rather
 * than of a kind.
 *
 * The uncontrolled arm is not a degenerate case to be folded into the controlled
 * one: Stage 6 asks both "do two people survive at all?" and "can one control
 * guide both of them?", and the first is answered by a run that sends no fixture.
 * Two keys keep the two answers apart in the record, exactly as the finishing
 * arms do — "both identities held" means something different when a pose skeleton
 * was also in the send, and one key covering both would make them
 * indistinguishable a month later.
 *
 * `none` is spelled out rather than left as a bare `two_character_scene`, so
 * every key this file mints has the same shape and a reader never has to wonder
 * whether a suffix went missing.
 */
export function imageLabTwoCharacterRecipeKey(controlKind: ImageLabControlKind | null): string {
  return `two_character_scene/${controlKind ?? "none"}`;
}

/**
 * The two-character recipe's reference policy: BOTH identities required, the
 * declared control required when there is one, and deliberately nothing else
 * allowed.
 *
 * Required, because the plan's own two-character rule is a refusal rather than a
 * trim — "if all required identities and the selected control do not fit, the
 * workflow is ineligible rather than silently dropping a character". A dropped
 * identity here is not a thinner render, it is a DIFFERENT experiment: the row
 * says two people and the image has one, and the verdict `character_missing`
 * would be filed against the planner rather than against the model.
 *
 * `maxPerRole` allows two identities and exactly one control. That is the first
 * policy in this file to allow two of anything, and it is what the whole kind
 * rests on — the controlled recipes cap every role at one precisely so an
 * unhonoured control stays attributable, and this kind spends that second slot on
 * purpose because two faces ARE the measurement.
 *
 * NO OPTIONAL CONTENT ROLES — no location, no outfit, no style, unlike every
 * other recipe here. Two identities and a control are three references, which is
 * the entire capacity of Qwen Image Edit 2511, so a fourth allowed role could
 * only ever be dropped. Allowing one would put a slot in the policy that the
 * model cannot honour and invite a trial arm that spends an admin's time
 * discovering it. The bound is the model's, and the policy states it plainly
 * rather than leaving it to capacity to enforce quietly.
 */
function imageLabTwoCharacterPolicy(controlKind: ImageLabControlKind | null): ImageReferencePolicy {
  const ordered: ImageReferenceRole[] =
    controlKind === null ? ["identity"] : ["identity", imageLabControlRole(controlKind)];
  const maxPerRole: Partial<Record<ImageReferenceRole, number>> = {};
  for (const role of ordered) maxPerRole[role] = role === "identity" ? 2 : 1;
  // Each field gets its own array, for the reason the controlled policy gives:
  // the policy type is mutable, and two fields sharing one instance would let an
  // edit to either silently rewrite both.
  return { requiredRoles: [...ordered], allowedRoles: [...ordered], roleOrder: [...ordered], maxPerRole };
}

/**
 * The fully-shaped profile one two-character run executes.
 *
 * Task `scene`, because that is what a render with two people in a place IS, and
 * because the scene screening is the one whose composition demands match what is
 * being asked of the model. `edit` on `multi_reference_compose` like every other
 * recipe here — and the compose strategy is doing more work in this recipe than
 * in any other, since it is the only thing in the request that says which face
 * belongs to which numbered image.
 *
 * `imageModelId` leads the parameter list, matching
 * {@link imageLabFinishingRecipeProfile}: both are recipes whose second argument
 * selects an arm rather than a kind.
 */
export function imageLabTwoCharacterRecipeProfile(
  imageModelId: string,
  controlKind: ImageLabControlKind | null,
): ImageModelProfile {
  const key = imageLabTwoCharacterRecipeKey(controlKind);
  const control = controlKind === null ? "uncontrolled" : imageLabRecipeControlNoun(controlKind);
  return {
    id: `${IMAGE_LAB_RECIPE_PROFILE_ID_PREFIX}${key}`,
    imageModelId,
    key,
    label: `Two-character scene — ${control}`,
    task: "scene",
    operation: "edit",
    promptStrategy: "multi_reference_compose",
    referencePolicy: imageLabTwoCharacterPolicy(controlKind),
    controlDefaults: emptyImageControlDefaults(),
    providerOverrides: {},
    timeoutMs: null,
    enabled: true,
    isDefault: false,
    builtin: false,
    sort: 0,
  };
}

// ---------------------------------------------------------------------------
// Stage 3 — the finishing recipe
// ---------------------------------------------------------------------------

/**
 * The identity finishing recipe's stable name — what a recorded outcome cites,
 * and the tail of its profile id. Unlike the controlled recipes it is not a
 * function of a control kind, because a finishing pass declares no control.
 *
 * What it IS a function of, as of Stage 5, is the arm
 * ({@link imageLabFinishingRecipeKey}): the two arms send different reference
 * sets under different reference policies, so they are two recipes and a reader
 * of a recorded outcome must be able to tell which one ran. The `/identity`
 * spelling predates the split and is kept verbatim — every Stage 3 row already
 * cites it, and renaming it would silently orphan them.
 */
export const IMAGE_LAB_FINISHING_RECIPE_KEY = "finishing_pass/identity";

/**
 * The LoRA-only finishing recipe's stable name — the Stage 5 arm that sends the
 * base render and a character LoRA and NOTHING else.
 *
 * A separate key rather than a flag on the identity recipe because the recorded
 * outcome is the whole audit trail of a comparison: "this face improved" means
 * two different things depending on whether the pack was in the send, and one key
 * covering both would make the two indistinguishable a month later.
 */
export const IMAGE_LAB_FINISHING_LORA_ONLY_RECIPE_KEY = "finishing_pass/lora_only";

/** The recipe key one finishing arm runs under. */
export function imageLabFinishingRecipeKey(variant: ImageLabFinishingVariant): string {
  switch (variant) {
    case "identity":
      return IMAGE_LAB_FINISHING_RECIPE_KEY;
    case "lora_only":
      return IMAGE_LAB_FINISHING_LORA_ONLY_RECIPE_KEY;
  }
}

/**
 * How many identity references the finishing recipe will accept.
 *
 * Two, while {@link IMAGE_LAB_FINISHING_IDENTITY_STRATEGY} sends one. The gap is
 * deliberate headroom: the pack can already produce a face-detail crop beside
 * the canonical portrait, and moving to it must stay a one-value change rather
 * than a policy rewrite — but the Stage 1/2 trial found every three-reference
 * send collapsing identity on this model, so the recipe does not spend the
 * third slot until an arm is run that says it should.
 */
const IMAGE_LAB_FINISHING_MAX_IDENTITY = 2;

/**
 * Which pack references a finishing pass sends, in send order.
 *
 * `canonical_only` because the base render already occupies one of the model's
 * three reference slots: canonical plus face detail would fill it exactly, and
 * that is the configuration the Stage 1/2 trial watched collapse identity in
 * both of its three-reference runs while every two-reference run preserved it.
 * A finishing pass that lost the face would be measuring the crowding, not the
 * finishing. The recipe allows a second identity reference so the face-detail
 * arm is a one-value change when someone runs it.
 *
 * The `lora_only` arm asks the pack for nothing at all — it does not use a
 * narrower strategy, it skips the pack entirely, because "which references would
 * the pack authorize" is not a question that arm is allowed to have an answer to.
 */
export const IMAGE_LAB_FINISHING_IDENTITY_STRATEGY: IdentityReferenceStrategy = "canonical_only";

/**
 * The roles one finishing arm sends, in send order.
 *
 * `before` is the render-intent vocabulary's own word for "the starting state
 * this render transforms", which is exactly what the source experiment's result
 * is here — and naming it so means the compose strategy's existing binding
 * describes it correctly without a word of new wording. It leads in both arms:
 * the model is being asked to keep that image and change one thing about it, and
 * the reference the instruction is about reads better named before the correction
 * it receives.
 *
 * The `lora_only` arm sends nothing after it. That is the arm's entire content —
 * the character LoRA carries the likeness, and a pack reference beside it would
 * make an improved face unattributable between the two, which is the one
 * question Stage 5 exists to answer.
 */
function imageLabFinishingRoles(variant: ImageLabFinishingVariant): ImageReferenceRole[] {
  switch (variant) {
    case "identity":
      return ["before", "identity"];
    case "lora_only":
      return ["before"];
  }
}

/**
 * The finishing pass's reference policy: every role the arm sends is REQUIRED,
 * and no other role is allowed.
 *
 * Required, because a pass missing one of its own references is not that pass:
 * with no base there is nothing to refine, and on the identity arm, with no
 * identity there is nothing to refine it toward — an unconstrained re-edit would
 * run under the name of an identity pass. Allowed is the same list rather than a
 * wider one, which is what makes `lora_only` a real isolation: identity is not
 * merely unsent there, it CANNOT be sent, so no caller and no future edit can
 * smuggle a pack reference into the arm that exists to run without one.
 */
function imageLabFinishingPolicy(variant: ImageLabFinishingVariant): ImageReferencePolicy {
  const ordered = imageLabFinishingRoles(variant);
  const maxPerRole: Partial<Record<ImageReferenceRole, number>> = {};
  for (const role of ordered) {
    maxPerRole[role] = role === "identity" ? IMAGE_LAB_FINISHING_MAX_IDENTITY : 1;
  }
  // Each field gets its own array, for the reason the controlled policy gives:
  // the policy type is mutable, and two fields sharing one instance would let an
  // edit to either silently rewrite both.
  return { requiredRoles: [...ordered], allowedRoles: [...ordered], roleOrder: [...ordered], maxPerRole };
}

/** The label's leading noun — which arm the reader is looking at. */
function imageLabFinishingLabel(variant: ImageLabFinishingVariant): string {
  switch (variant) {
    case "identity":
      return "Identity finishing pass";
    case "lora_only":
      return "LoRA-only finishing pass";
  }
}

/**
 * The fully-shaped profile one finishing pass executes, per arm.
 *
 * Task `variant` whatever the source kind was — including a scene, and including
 * the LoRA-only arm. The task is not a description of the picture, it is which
 * screening `profileEligibility` applies, and a finishing pass is an IDENTITY
 * operation whichever way the likeness arrives: the identity-critical screening a
 * variant render gets is exactly the gate wanted, and it is wanted no less
 * because the image behind it happens to be a scene, or because the likeness is
 * coming from weights rather than from a reference. Screening it as a scene would
 * test the model for composition the pass is under orders not to touch.
 *
 * Everything else matches the controlled recipes for the reason they match each
 * other: `edit` on `multi_reference_compose`, so the numbered role bindings are
 * compiled by the one shared compiler, and inert control defaults, no overrides,
 * no timeout of its own. The two arms differ in exactly three places — key, label
 * and policy — because everything else about them has to stay identical for the
 * comparison between them to mean anything.
 */
export function imageLabFinishingRecipeProfile(
  imageModelId: string,
  variant: ImageLabFinishingVariant,
): ImageModelProfile {
  const key = imageLabFinishingRecipeKey(variant);
  return {
    id: `${IMAGE_LAB_RECIPE_PROFILE_ID_PREFIX}${key}`,
    imageModelId,
    key,
    label: imageLabFinishingLabel(variant),
    task: "variant",
    operation: "edit",
    promptStrategy: "multi_reference_compose",
    referencePolicy: imageLabFinishingPolicy(variant),
    controlDefaults: emptyImageControlDefaults(),
    providerOverrides: {},
    timeoutMs: null,
    enabled: true,
    isDefault: false,
    builtin: false,
    sort: 0,
  };
}

/**
 * The experiment kinds a finishing pass may refine.
 *
 * A finishing pass edits a render and files its verdict against the comparison
 * the plan names — direct edit, controlled result, controlled result plus
 * finishing — so its source has to be a production-shaped render of the
 * subject. The four that qualify are the two controlled kinds and the two
 * BASELINES: the direct-edit baseline is one of the three images that
 * comparison holds, and "does a second pass earn its cost?" is asked of it on
 * exactly the same terms.
 *
 * Two kinds are refused, each for its own reason:
 *
 * - `control_probe`, because a probe is not a production-shaped render of
 *   anybody. Its inputs are hand-ordered, it may carry a raw provider bag, and
 *   it need not send an identity reference at all — finishing one would produce
 *   a ruling about the probe's ad-hoc prompt wearing Stage 3's name.
 * - `finishing_pass`, because a chain has no bottom. Each pass re-edits the last
 *   one's output, so drift accumulates with nothing to attribute it to, and the
 *   plan's promotion rule — improves identity, changes nothing else — is a
 *   judgment about ONE pass over a known base.
 */
export const imageLabFinishableKinds = [
  "baseline_portrait",
  "baseline_scene",
  "controlled_portrait",
  "controlled_scene",
] as const satisfies readonly ImageLabExperimentKind[];
export type ImageLabFinishableKind = (typeof imageLabFinishableKinds)[number];

/** Whether a finishing pass may be run over this kind's result. */
export function isImageLabFinishableKind(kind: ImageLabExperimentKind): kind is ImageLabFinishableKind {
  return imageLabFinishableKinds.some((finishable) => finishable === kind);
}
