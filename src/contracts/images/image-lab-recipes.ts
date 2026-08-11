import { imageLabControlRole, type ImageLabControlKind, type ImageLabExperimentKind } from "./image-lab";
import type { ImageReferenceRole } from "./image-model-capabilities";
import {
  emptyImageControlDefaults,
  type ImageModelProfile,
  type ImageProfileTask,
  type ImageReferencePolicy,
} from "./image-model-profiles";

/**
 * The Advanced Image Lab's controlled recipes — code-defined
 * `ImageModelProfile` values for the `controlled_portrait` / `controlled_scene`
 * experiment kinds (qwen-advanced-image-subsystem.spec.md, Stages 1–2).
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
 * The two kinds that run on the render-intent path under a recipe. Declared as
 * a subset of the experiment kinds (the `satisfies` is the tie) so a renamed
 * kind breaks here at compile time instead of silently orphaning its recipe.
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
