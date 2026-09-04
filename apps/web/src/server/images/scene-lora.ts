import type { ImageLoraRenderBinding, ResolvedImageProfile } from "@vesper/image-core";
import { diag, type DiagnosticSink } from "@/contracts/diagnostics";
import { INTIMATE_SCENE_LORA_ID, INTIMATE_SCENE_LORA_MODEL_SLUG } from "@/contracts/images/intimate-scene-lora";
import { pairProfileWithNsfwLora, type NsfwLoraMissingLeg } from "./nsfw-lora";
import type { SceneRenderPlan } from "./prompts-scene-plan";

/**
 * The intimate-scene LoRA route.
 *
 * ~45 owner-graded probe renders settled two things at once: the staged prompts
 * are right, and the base editor cannot draw explicit anatomy on its own. It
 * follows every compositional instruction, so a chat that stages an act gets a
 * picture of a near-miss — until one curated LoRA rides along, which rendered
 * every acceptance act on the same prompts.
 *
 * This module owns WHICH chat renders take the LoRA and what a missing piece of
 * the configuration costs them. Assembling the pairing itself — the intimate
 * model, the library row, the credential — is `nsfw-lora.ts`, shared with the
 * portrait studio's `nsfw_test` variant. The answer is a BINDING on the intimate
 * model rather than a flag, because weights are resolved against the model that
 * will load them: the library row states which endpoints and versions it may
 * reach, and only a resolved pairing can be checked against that.
 *
 * Three properties are load-bearing:
 *
 * 1. **The trigger reads the render's own facts, never a parallel guess.** The
 *    same staging, route and anchor that decide whether the explicit sentence is
 *    emitted decide whether the LoRA rides — see {@link intimateSceneLoraApplies}.
 * 2. **Every miss degrades to today.** A missing model row, an unresolvable
 *    library row, a deployment with no Civitai credential: each renders exactly
 *    as it does now, on the stock profile, with one info diagnostic naming the
 *    leg. Nothing here can fail a render.
 * 3. **Silence off the trigger.** A non-intimate or unstaged render pushes no
 *    diagnostic and reads no row — most scene renders are that render, and a
 *    "no LoRA today" line on every one of them is noise nobody would read.
 */

/**
 * The row and the model this route asks for are defined in contracts
 * (`@/contracts/images/intimate-scene-lora`) and re-exported here, because the
 * lab's staged-scene form needs the same two names and cannot import
 * `server/*`. Re-exported rather than moved outright so every existing
 * `from "./scene-lora"` import — the probe's `lora` arm included, which
 * `scene-lora.test.ts` pins against production — keeps resolving.
 */
export { INTIMATE_SCENE_LORA_ID, INTIMATE_SCENE_LORA_MODEL_SLUG };

/** An intimate staged render is going out carrying the anatomy LoRA. */
export const SCENE_LORA_ROUTE_CODE = "images.scene_render.lora_route";

/** The LoRA route was wanted and could not be assembled — this render is today's. */
export const SCENE_LORA_UNAVAILABLE_CODE = "images.scene_render.lora_unavailable";

/** Which leg of the route was missing, for the degrade diagnostic's context. */
export type SceneLoraMissingLeg = NsfwLoraMissingLeg;

/** What the render path does differently when the route is on: a resolved model, and a LoRA. */
export interface IntimateSceneLoraRoute {
  /**
   * The lane's own scene profile paired with the intimate model — today the
   * same base model most scene profiles already resolve to.
   *
   * The profile row is unchanged — same task, same prompt strategy, same
   * reference policy, same control defaults — because the render is the same
   * render. The pairing still goes through the registry rather than keeping the
   * lane's copy, so the row that carries the LoRA control bindings is the one
   * the weights are evaluated and sent against. Pairing a stored profile with a
   * named model is the image lab's established shape (`runRecipeIntent`), and it
   * is why no route-specific profile row has to exist for this route to work.
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
 *   character's own anchor; a bare text render on a LoRA-loaded model is a
 *   composition nobody graded.
 *
 * Deliberately NOT re-derived here: the staging's per-part coverage gate. That
 * rule decides the sentence's WORDING against the player's exposure inside the
 * builder, and a second copy of it out here would be exactly the parallel guess
 * that drifts. A staged plan whose parts fall out of frame renders on the same
 * model as any other scene, with the sentence suppressed — so it is the picture
 * the stock render would have produced anyway, and keeping one owner of that
 * rule costs nothing.
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

  const paired = await pairProfileWithNsfwLora(profile, sink);
  if (!paired.ok) return unavailable(sink, paired.leg, paired.message);

  const { binding } = paired;
  sink?.push(
    diag(
      "info",
      SCENE_LORA_ROUTE_CODE,
      `intimate staged scene rendering through ${binding.label} on ${paired.profile.model.slug}`,
      {
        path: "image_loras",
        // Ids and a number — never the locator, which is the one field on a
        // binding that may carry a credential once the transport completes it.
        context: {
          staging: input.plan.staging?.id ?? null,
          slug: paired.profile.model.slug,
          lora: binding.id,
          scale: binding.scale,
        },
      },
    ),
  );
  return { profile: paired.profile, binding };
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
