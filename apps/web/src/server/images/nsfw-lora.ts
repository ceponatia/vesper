import {
  baseImageModelSlug,
  type ImageLoraRenderBinding,
  type ImageModel,
  pinnedImageModelVersion,
  profileEligibility,
  redactImageLoraLocator,
  type ResolvedImageProfile,
} from "@vesper/image-core";
import { diag, type DiagnosticSink } from "@/contracts/diagnostics";
import {
  INTIMATE_SCENE_LORA_ID,
  INTIMATE_SCENE_LORA_MODEL_SLUG,
  intimateRoutePolicyFor,
  type IntimateRoutePolicy,
  type IntimateRouteProvenance,
} from "@/contracts/images/intimate-scene-lora";
import { resolveImageLoraForRender } from "./image-loras";
import { civitaiApiToken, loraLocatorNeedsCivitaiToken } from "./lora-credentials";
import { loadImageModels } from "./models";

/**
 * The intimate route — which model and which anatomy weights a nude-by-design
 * render takes. Shared by the three lanes that make one: the chat scene lane's
 * intimate staged render, the portrait studio's `nsfw_test` variant, and a
 * `bare` reference view.
 *
 * One entry point, {@link resolveIntimateRoute}, and two routes behind it,
 * chosen by the RESOLVED profile's model against the reviewed policy table
 * (`INTIMATE_ROUTE_POLICIES`, `@/contracts/images/intimate-scene-lora`):
 *
 * - **A model the table does not list** takes the intimate-model pairing,
 *   {@link pairProfileWithNsfwLora}: the lane's profile on
 *   `qwen/qwen-image-edit-2511` with the curated anatomy row. Its four legs and
 *   their order are the design — the model registry is one read, the library
 *   row is a second, and the credential is an environment lookup that only
 *   matters once there is a locator to complete. Nothing on that route reports:
 *   every refusal is a value, because the lanes answer it differently (the scene
 *   lane degrades to a stock render and says so in scene vocabulary; the
 *   studio's test variant and a bare view fail outright, because a tame picture
 *   silently substituted for an explicit one is exactly what they exist to
 *   prevent). One decision, two honest reports.
 * - **A listed `optional` model** renders on the lane's own resolved profile.
 *   The curated anatomy row the policy names rides along when it resolves
 *   through the same library and credential legs; when the policy names none,
 *   or the named row does not resolve, the route renders with no LoRA. That is
 *   the reviewed route working, not a degrade, so neither lane has a decision
 *   left to make about it — this module reports it, once, as an INFO line.
 *
 * What this module deliberately does NOT own is the trigger: each lane decides
 * when it wants the intimate route, and that decision — never the presence of a
 * LoRA — is what grants the lane's intimate allowance.
 */

/** Which leg was missing, for the caller's own diagnostic context. */
export type NsfwLoraMissingLeg = "model" | "model_eligibility" | "library_row" | "credential";

/** The lane's profile on the intimate model, plus the weights it may send. */
export type NsfwLoraPairing =
  | {
      ok: true;
      /**
       * The caller's own profile row — same task, prompt strategy, reference
       * policy and control defaults — paired with the intimate model, which is
       * the base model most character lanes already resolve to. The pairing
       * still goes through the registry rather than trusting the caller's copy,
       * because the registered row is the one that carries the LoRA control
       * bindings a weights-bearing render is evaluated against. Pairing a stored
       * profile with a named model is the image lab's established shape
       * (`runRecipeIntent`), which is why no route-specific profile row has to
       * exist.
       */
      profile: ResolvedImageProfile;
      binding: ImageLoraRenderBinding;
    }
  | { ok: false; leg: NsfwLoraMissingLeg; message: string };

/**
 * The route one intimate render takes: the profile it renders on, the weights it
 * sends (null when it sends none), and what its row records about both — or the
 * leg that stopped the intimate-model pairing.
 *
 * `ok: false` arises only for a model the policy table does not list: a listed
 * model always has a route, with or without its LoRA.
 */
export type IntimateRoute =
  | {
      ok: true;
      profile: ResolvedImageProfile;
      binding: ImageLoraRenderBinding | null;
      provenance: IntimateRouteProvenance;
    }
  | { ok: false; leg: NsfwLoraMissingLeg; message: string };

/**
 * A listed model is rendering intimate work with no anatomy LoRA — the reviewed
 * route, reported once so an operator can see which renders went out bare of
 * weights and why.
 */
export const INTIMATE_ROUTE_NO_ANATOMY_LORA_CODE = "images.intimate_route.no_anatomy_lora";

/**
 * Resolve the intimate route for one render from the lane's RESOLVED profile.
 *
 * Nothing here throws. A listed model always answers `ok: true`; a model the
 * table does not list answers exactly what {@link pairProfileWithNsfwLora}
 * answers, so its callers' degrade and failure behavior is unchanged.
 */
export async function resolveIntimateRoute(
  profile: ResolvedImageProfile,
  sink?: DiagnosticSink,
): Promise<IntimateRoute> {
  const policy = intimateRoutePolicyFor(profile.model.slug);
  if (policy !== null) return resolvePolicyRoute(profile, policy, sink);
  const paired = await pairProfileWithNsfwLora(profile, sink);
  if (!paired.ok) return paired;
  return {
    ok: true,
    profile: paired.profile,
    binding: paired.binding,
    provenance: { lora: paired.binding.id, reason: "anatomy_lora" },
  };
}

/**
 * Resolve the intimate model + weights for one render, or the leg that stopped it.
 *
 * Nothing here throws and nothing here reports: every refusal is a value, so the
 * caller decides between degrading and failing with the same information.
 */
export async function pairProfileWithNsfwLora(
  profile: ResolvedImageProfile,
  sink?: DiagnosticSink,
): Promise<NsfwLoraPairing> {
  const models = await loadImageModels(sink);
  // Exact spelling first, base slug only as a fallback — the same two steps
  // `resolveLabModel` takes. Registry uniqueness is on the FULL slug and the
  // sort is an admin-editable field, so a pinned `…-2511:<version>` row sitting
  // ahead of the built-in bare row would otherwise win a base-slug-only lookup
  // and hand this route a different version and capability record than the one
  // the constant names. The fallback still keeps a deployment whose only 2511
  // row is stored in its pinned spelling working.
  const intimateModel =
    models.find((model) => model.slug === INTIMATE_SCENE_LORA_MODEL_SLUG) ??
    models.find((model) => baseImageModelSlug(model.slug) === INTIMATE_SCENE_LORA_MODEL_SLUG);
  if (!intimateModel) {
    return { ok: false, leg: "model", message: `no registered image model matches ${INTIMATE_SCENE_LORA_MODEL_SLUG}` };
  }

  // The same gate the lab applies before a recipe run: a profile paired with a
  // model that cannot mechanically or safely do the job would be refused one
  // layer down anyway, and refusing here costs a render rather than a prediction.
  const eligibility = profileEligibility(profile.profile, intimateModel);
  if (!eligibility.ok) {
    return {
      ok: false,
      leg: "model_eligibility",
      message: `${intimateModel.slug} cannot run the ${profile.profile.key} profile: ${eligibility.reason}`,
    };
  }

  const weights = await resolveAnatomyLora(INTIMATE_SCENE_LORA_ID, intimateModel, profile, sink);
  if (!weights.ok) return weights;
  return { ok: true, profile: { profile: profile.profile, model: intimateModel }, binding: weights.binding };
}

/**
 * A listed model's route: the lane's own resolved profile, carrying the named
 * anatomy row when it resolves and nothing otherwise.
 *
 * No registry read and no eligibility leg. The profile already resolved to this
 * model through the registry, so it IS the registered row with its probed LoRA
 * bindings, and a profile is eligible for the model it resolved to by
 * construction.
 */
async function resolvePolicyRoute(
  profile: ResolvedImageProfile,
  policy: IntimateRoutePolicy,
  sink?: DiagnosticSink,
): Promise<IntimateRoute> {
  if (policy.anatomyLoraId === null) {
    return withoutLora(profile, "no_anatomy_lora_curated", `no anatomy LoRA is curated for ${profile.model.slug}`, sink);
  }
  const weights = await resolveAnatomyLora(policy.anatomyLoraId, profile.model, profile, sink);
  if (!weights.ok) {
    return withoutLora(profile, "anatomy_lora_unavailable", weights.message, sink, {
      lora: policy.anatomyLoraId,
      leg: weights.leg,
    });
  }
  return { ok: true, profile, binding: weights.binding, provenance: { lora: weights.binding.id, reason: "anatomy_lora" } };
}

/** The listed model's no-LoRA route, reported once. */
function withoutLora(
  profile: ResolvedImageProfile,
  reason: Exclude<IntimateRouteProvenance["reason"], "anatomy_lora">,
  message: string,
  sink?: DiagnosticSink,
  context: Record<string, unknown> = {},
): IntimateRoute {
  sink?.push(
    diag(
      "info",
      INTIMATE_ROUTE_NO_ANATOMY_LORA_CODE,
      `intimate render on ${profile.model.slug} without an anatomy LoRA: ${message}`,
      { path: "image_loras", context: { slug: profile.model.slug, task: profile.profile.task, reason, ...context } },
    ),
  );
  return { ok: true, profile, binding: null, provenance: { lora: null, reason } };
}

/**
 * The library and credential legs both routes share: one curated row resolved
 * against the model that will load it, then its locator checked for a
 * credential this deployment can complete.
 */
async function resolveAnatomyLora(
  loraId: string,
  model: ImageModel,
  profile: ResolvedImageProfile,
  sink?: DiagnosticSink,
): Promise<{ ok: true; binding: ImageLoraRenderBinding } | { ok: false; leg: "library_row" | "credential"; message: string }> {
  // No `scale` on the selection: the row's own curated default is the proven
  // strength, and stating a number here would outrank an admin who retuned the
  // band. The version asked about is whatever pins the registered row, the same
  // rule `renderImageIntent` uses for a caller that did not resolve its own
  // LoRA.
  const resolved = await resolveImageLoraForRender(
    { id: loraId },
    {
      model,
      versionId: pinnedImageModelVersion(model),
      // A player-facing render on every caller — the chat scene lane, the
      // portrait studio's test variant and a bare reference view — so the
      // row's `allowedTasks` curation applies, exactly as it did before
      // contexts existed.
      execution: { kind: "production", task: profile.profile.task },
    },
    sink,
  );
  // The refusal's own `image_lora.*` diagnostic is already on the sink, in the
  // vocabulary the library decided it in.
  if (!resolved.ok) return { ok: false, leg: "library_row", message: resolved.message };

  const { binding } = resolved;
  if (loraLocatorNeedsCivitaiToken(binding.locator) && civitaiApiToken() === null) {
    return {
      ok: false,
      leg: "credential",
      message: `${binding.label} is hosted at ${redactImageLoraLocator(binding.locator)}, which needs a credential this deployment has not got`,
    };
  }
  return { ok: true, binding };
}
