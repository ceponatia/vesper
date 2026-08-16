import {
  baseImageModelSlug,
  type ImageLoraRenderBinding,
  pinnedImageModelVersion,
  profileEligibility,
  redactImageLoraLocator,
  type ResolvedImageProfile,
} from "@vesper/image-core";
import { diag, type DiagnosticSink } from "@/contracts/diagnostics";
import { INTIMATE_SCENE_LORA_ID, INTIMATE_SCENE_LORA_WRAPPER_SLUG } from "@/contracts/images/intimate-scene-lora";
import { resolveImageLoraForRender } from "./image-loras";
import { civitaiApiToken, loraLocatorNeedsCivitaiToken } from "./lora-credentials";
import { loadImageModels } from "./models";
import type { SceneRenderPlan } from "./prompts-scene-plan";

/**
 * The intimate-scene LoRA route (intimate-scene-lora.spec.md §Algorithm).
 *
 * ~45 owner-graded probe renders settled two things at once: the staged prompts
 * are right, and the stock scene model is the ceiling. `qwen-image-edit-2511`
 * follows every compositional instruction and cannot draw explicit anatomy, so
 * a chat that stages an act gets a picture of a near-miss. One LoRA — run
 * through Replicate's LoRA-capable Qwen edit wrapper — rendered every acceptance
 * act on the same prompts (finished/scene-composition.spec.md §Probe results).
 *
 * This module is the whole of that decision: which renders take the LoRA, and
 * what it costs when a piece of the configuration is missing. It answers with a
 * MODEL SWAP plus a binding rather than a flag, because the LoRA lives on a
 * different endpoint than the scene default — the wrapper is a generation behind
 * 2511 and off every picker, which is why nothing but this route may reach it.
 *
 * Three properties are load-bearing:
 *
 * 1. **The trigger reads the render's own facts, never a parallel guess.** The
 *    same staging, route and anchor that decide whether the explicit sentence is
 *    emitted decide whether the LoRA rides — see {@link intimateSceneLoraApplies}.
 * 2. **Every miss degrades to today.** A missing wrapper row, an unresolvable
 *    library row, a deployment with no Civitai credential: each renders exactly
 *    as it does now, on the stock profile, with one info diagnostic naming the
 *    leg. Nothing here can fail a render.
 * 3. **Silence off the trigger.** A non-intimate or unstaged render pushes no
 *    diagnostic and reads no row — most scene renders are that render, and a
 *    "no LoRA today" line on every one of them is noise nobody would read.
 */

/**
 * The row and the endpoint this route asks for are defined in contracts
 * (`@/contracts/images/intimate-scene-lora`) and re-exported here, because the
 * lab's staged-scene form needs the same two names and cannot import
 * `server/*`. Re-exported rather than moved outright so every existing
 * `from "./scene-lora"` import — the probe's `lora` arm included, which
 * `scene-lora.test.ts` pins against production — keeps resolving.
 */
export { INTIMATE_SCENE_LORA_ID, INTIMATE_SCENE_LORA_WRAPPER_SLUG };

/** An intimate staged render is going out through the LoRA wrapper. */
export const SCENE_LORA_ROUTE_CODE = "images.scene_render.lora_route";

/** The LoRA route was wanted and could not be assembled — this render is today's. */
export const SCENE_LORA_UNAVAILABLE_CODE = "images.scene_render.lora_unavailable";

/** Which leg of the route was missing, for the degrade diagnostic's context. */
export type SceneLoraMissingLeg = "wrapper_model" | "wrapper_eligibility" | "library_row" | "credential";

/** What the render path does differently when the route is on: a model, and a LoRA. */
export interface IntimateSceneLoraRoute {
  /**
   * The lane's own scene profile paired with the WRAPPER model.
   *
   * The profile row is unchanged — same task, same prompt strategy, same
   * reference policy, same control defaults — because the render is the same
   * render; only the endpoint that can draw it differs. Pairing a stored profile
   * with another model is the image lab's established shape
   * (`runRecipeIntent`), and it is why no wrapper-specific profile row has to
   * exist for this route to work.
   */
  profile: ResolvedImageProfile;
  binding: ImageLoraRenderBinding;
}

/** Everything the trigger reads, all of it already decided by the render path. */
export interface IntimateSceneLoraFacts {
  /** THIS attempt's plan — a sanitized retry has had its staging stripped. */
  plan: SceneRenderPlan;
  /** THIS attempt's uncensored flag, the same value the prompt's staging gate reads. */
  allowIntimate: boolean;
  /** A selfie is the subject's own camera; its framing suppresses staging entirely. */
  selfie: boolean;
  /** The lane resolved an edit-capable model on a reachable provider. */
  referenceRoute: boolean;
  /** At least one reference image will travel — the anchor a staged edit needs. */
  anchored: boolean;
}

export interface ResolveIntimateSceneLoraInput extends IntimateSceneLoraFacts {
  /** The scene profile the lane resolved, or null when none is offered. */
  profile: ResolvedImageProfile | null;
  sink?: DiagnosticSink;
}

/**
 * Whether this attempt is the render the LoRA exists for.
 *
 * Each clause mirrors a condition the prompt builder already applies to the
 * staged sentence (`stagedShotFor`), and that mirroring is the point: the LoRA
 * is only honest on a prompt that actually describes the act, so a render whose
 * sentence would be suppressed must not carry the weights that draw it.
 *
 * - `staging.intimate` — the non-intimate stagings (a hand at the small of a
 *   back) need nothing the stock model cannot draw.
 * - `selfie` — selfie framing drops the staging sentence outright.
 * - `allowIntimate` — the rung's own uncensored flag, which the moderated
 *   fallback clears and the content-rejection retry clears with it.
 * - `referenceRoute` + `anchored` — the proven route is a reference EDIT of the
 *   character's own anchor; a bare text render on a LoRA-loaded wrapper is a
 *   composition nobody graded.
 *
 * Deliberately NOT re-derived here: the staging's per-part coverage gate. That
 * rule decides the sentence's WORDING against the player's exposure inside the
 * builder, and a second copy of it out here would be exactly the parallel guess
 * that drifts. A staged plan whose parts fall out of frame renders on the
 * wrapper with the sentence suppressed — the same picture the stock model would
 * have produced, one generation older, which is a cost worth paying to keep one
 * owner of that rule.
 */
export function intimateSceneLoraApplies(facts: IntimateSceneLoraFacts): boolean {
  if (facts.plan.staging?.intimate !== true) return false;
  if (facts.selfie) return false;
  if (!facts.allowIntimate) return false;
  return facts.referenceRoute && facts.anchored;
}

/**
 * Resolve the route for one attempt, or null to render exactly as today.
 *
 * The order of the legs is the order they cost: the trigger is free, the model
 * registry is one read the lane already pays elsewhere, the library row is a
 * second, and the credential is an environment lookup that only matters once
 * there is a locator to complete. Every one of them refuses by returning null,
 * so the caller has a single branch and no way to half-apply the route.
 */
export async function resolveIntimateSceneLoraRoute(
  input: ResolveIntimateSceneLoraInput,
): Promise<IntimateSceneLoraRoute | null> {
  const { profile, sink } = input;
  // `profile === null` is implied by `referenceRoute` at runtime (the lane's
  // route flag is derived from the resolved model) — restated so the pairing
  // below type-narrows without an assertion.
  if (!intimateSceneLoraApplies(input) || profile === null) return null;

  const models = await loadImageModels(sink);
  const wrapper = models.find((model) => baseImageModelSlug(model.slug) === INTIMATE_SCENE_LORA_WRAPPER_SLUG);
  if (!wrapper) {
    return unavailable(sink, "wrapper_model", `no registered image model matches ${INTIMATE_SCENE_LORA_WRAPPER_SLUG}`);
  }

  // The same gate the lab applies before a recipe run: a profile paired with a
  // model that cannot mechanically or safely do the job would be refused one
  // layer down anyway, and refusing here turns a failed render into a fallback.
  const eligibility = profileEligibility(profile.profile, wrapper);
  if (!eligibility.ok) {
    return unavailable(
      sink,
      "wrapper_eligibility",
      `${wrapper.slug} cannot run the ${profile.profile.key} profile: ${eligibility.reason}`,
    );
  }

  // No `scale` on the selection: the row's own curated default is the proven
  // strength (1), and stating a number here would outrank an admin who retuned
  // the band. The version asked about is whatever pins the wrapper row, the same
  // rule `renderImageIntent` uses for a caller that did not resolve its own LoRA.
  const resolved = await resolveImageLoraForRender(
    { id: INTIMATE_SCENE_LORA_ID },
    { model: wrapper, versionId: pinnedImageModelVersion(wrapper), task: profile.profile.task },
    sink,
  );
  // The refusal's own `image_lora.*` diagnostic is already on the sink, in the
  // vocabulary the library decided it in; this one says what the SCENE did about it.
  if (!resolved.ok) return unavailable(sink, "library_row", resolved.message);

  const { binding } = resolved;
  if (loraLocatorNeedsCivitaiToken(binding.locator) && civitaiApiToken() === null) {
    return unavailable(
      sink,
      "credential",
      `${binding.label} is hosted at ${redactImageLoraLocator(binding.locator)}, which needs a credential this deployment has not got`,
    );
  }

  sink?.push(
    diag("info", SCENE_LORA_ROUTE_CODE, `intimate staged scene rendering through ${binding.label} on ${wrapper.slug}`, {
      path: "image_loras",
      // Ids and a number — never the locator, which is the one field on a
      // binding that may carry a credential once the transport completes it.
      context: {
        staging: input.plan.staging?.id ?? null,
        slug: wrapper.slug,
        lora: binding.id,
        scale: binding.scale,
      },
    }),
  );
  return { profile: { profile: profile.profile, model: wrapper }, binding };
}

/** Report one missing leg and fall back to today's render. */
function unavailable(sink: DiagnosticSink | undefined, leg: SceneLoraMissingLeg, message: string): null {
  sink?.push(
    diag("info", SCENE_LORA_UNAVAILABLE_CODE, `intimate scene LoRA unavailable — rendering on the stock model: ${message}`, {
      path: "image_loras",
      context: { leg },
    }),
  );
  return null;
}
