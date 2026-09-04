import {
  baseImageModelSlug,
  type ImageLoraRenderBinding,
  pinnedImageModelVersion,
  profileEligibility,
  redactImageLoraLocator,
  type ResolvedImageProfile,
} from "@vesper/image-core";
import type { DiagnosticSink } from "@/contracts/diagnostics";
import { INTIMATE_SCENE_LORA_ID, INTIMATE_SCENE_LORA_MODEL_SLUG } from "@/contracts/images/intimate-scene-lora";
import { resolveImageLoraForRender } from "./image-loras";
import { civitaiApiToken, loraLocatorNeedsCivitaiToken } from "./lora-credentials";
import { loadImageModels } from "./models";

/**
 * Pairing a lane's own profile with the anatomy LoRA and the model that loads
 * it — the shared half of the intimate-scene route, used by the chat scene lane
 * and by the portrait studio's `nsfw_test` variant.
 *
 * The four legs and their order are the design: the model registry is one read,
 * the library row is a second, and the credential is an environment lookup that
 * only matters once there is a locator to complete. What this module deliberately
 * does NOT own is the trigger (each lane decides when it wants the LoRA) or the
 * diagnostics (the scene lane degrades to a stock render and says so in scene
 * vocabulary; the studio's test variant fails outright, because a tame picture
 * silently substituted for an explicit one is exactly what the owner was testing
 * FOR). One decision, two honest reports.
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
  const intimateModel = models.find((model) => baseImageModelSlug(model.slug) === INTIMATE_SCENE_LORA_MODEL_SLUG);
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

  // No `scale` on the selection: the row's own curated default is the proven
  // strength (1), and stating a number here would outrank an admin who retuned
  // the band. The version asked about is whatever pins the registered row, the
  // same rule `renderImageIntent` uses for a caller that did not resolve its own
  // LoRA.
  const resolved = await resolveImageLoraForRender(
    { id: INTIMATE_SCENE_LORA_ID },
    {
      model: intimateModel,
      versionId: pinnedImageModelVersion(intimateModel),
      // A player-facing render on both callers — the chat scene lane and the
      // portrait studio's test variant — so the row's `allowedTasks` curation
      // applies, exactly as it did before contexts existed.
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

  return { ok: true, profile: { profile: profile.profile, model: intimateModel }, binding };
}
