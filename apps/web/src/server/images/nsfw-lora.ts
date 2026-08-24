import {
  baseImageModelSlug,
  type ImageLoraRenderBinding,
  pinnedImageModelVersion,
  profileEligibility,
  redactImageLoraLocator,
  type ResolvedImageProfile,
} from "@vesper/image-core";
import type { DiagnosticSink } from "@/contracts/diagnostics";
import { INTIMATE_SCENE_LORA_ID, INTIMATE_SCENE_LORA_WRAPPER_SLUG } from "@/contracts/images/intimate-scene-lora";
import { resolveImageLoraForRender } from "./image-loras";
import { civitaiApiToken, loraLocatorNeedsCivitaiToken } from "./lora-credentials";
import { loadImageModels } from "./models";

/**
 * Pairing a lane's own profile with the anatomy LoRA and the one endpoint that
 * can load it — the shared half of the intimate-scene route
 * (intimate-scene-lora.spec.md §Algorithm), used by the chat scene lane and by
 * the portrait studio's `nsfw_test` variant.
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
export type NsfwLoraMissingLeg = "wrapper_model" | "wrapper_eligibility" | "library_row" | "credential";

/** The lane's profile on the wrapper model, plus the weights it may send. */
export type NsfwLoraPairing =
  | {
      ok: true;
      /**
       * The caller's own profile row — same task, prompt strategy, reference
       * policy and control defaults — paired with the WRAPPER model, because the
       * render is the same render and only the endpoint that can draw it differs.
       * Pairing a stored profile with another model is the image lab's
       * established shape (`runRecipeIntent`), which is why no wrapper-specific
       * profile row has to exist.
       */
      profile: ResolvedImageProfile;
      binding: ImageLoraRenderBinding;
    }
  | { ok: false; leg: NsfwLoraMissingLeg; message: string };

/**
 * Resolve the wrapper + weights for one render, or the leg that stopped it.
 *
 * Nothing here throws and nothing here reports: every refusal is a value, so the
 * caller decides between degrading and failing with the same information.
 */
export async function pairProfileWithNsfwLora(
  profile: ResolvedImageProfile,
  sink?: DiagnosticSink,
): Promise<NsfwLoraPairing> {
  const models = await loadImageModels(sink);
  const wrapper = models.find((model) => baseImageModelSlug(model.slug) === INTIMATE_SCENE_LORA_WRAPPER_SLUG);
  if (!wrapper) {
    return { ok: false, leg: "wrapper_model", message: `no registered image model matches ${INTIMATE_SCENE_LORA_WRAPPER_SLUG}` };
  }

  // The same gate the lab applies before a recipe run: a profile paired with a
  // model that cannot mechanically or safely do the job would be refused one
  // layer down anyway, and refusing here costs a render rather than a prediction.
  const eligibility = profileEligibility(profile.profile, wrapper);
  if (!eligibility.ok) {
    return {
      ok: false,
      leg: "wrapper_eligibility",
      message: `${wrapper.slug} cannot run the ${profile.profile.key} profile: ${eligibility.reason}`,
    };
  }

  // No `scale` on the selection: the row's own curated default is the proven
  // strength (1), and stating a number here would outrank an admin who retuned
  // the band. The version asked about is whatever pins the wrapper row, the same
  // rule `renderImageIntent` uses for a caller that did not resolve its own LoRA.
  const resolved = await resolveImageLoraForRender(
    { id: INTIMATE_SCENE_LORA_ID },
    {
      model: wrapper,
      versionId: pinnedImageModelVersion(wrapper),
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

  return { ok: true, profile: { profile: profile.profile, model: wrapper }, binding };
}
