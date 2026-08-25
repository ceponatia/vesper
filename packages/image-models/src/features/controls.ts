import type { ImageModel } from "@vesper/image-core";
import type { ImageFeature } from "./image-feature";

/**
 * The four single-binding normalized controls a family can compose.
 *
 * Each one's `isBound` asks the record's control bindings — the slots the probe
 * filled when it resolved this version's field aliases — so an adapter never
 * has to know whether this endpoint spells its guidance input `guidance` or
 * `cfg`. An absent slot means the active version exposes nothing for that
 * control, which is why an unprobed row reports every one of them unbound: that
 * is the truthful answer, and it matches what the control mapper actually does
 * (it sends nothing).
 *
 * Grouped in one module because they are the same shape of fact asked four
 * times; a control that needed genuine logic (see `./lora`) gets its own file.
 */

/** Reproducible output: the same request twice returns the same image. */
export function seedFeature(): ImageFeature {
  return {
    id: "seed",
    semantic: "Accepts a seed, so an identical request can be reproduced exactly.",
    isBound: (model: ImageModel) => model.advancedCapabilities.controls.seed !== undefined,
  };
}

/** How hard the sampler is pushed toward the prompt. */
export function guidanceFeature(): ImageFeature {
  return {
    id: "guidance",
    semantic: "Accepts a guidance strength controlling how closely the render follows the prompt.",
    isBound: (model: ImageModel) => model.advancedCapabilities.controls.guidance !== undefined,
  };
}

/**
 * The endpoint offers an accelerated sampling path, and the caller may choose
 * it or refuse it.
 *
 * Unlike the three controls around it, this one is a QUALITY choice wearing a
 * speed name: the wrappers that expose it turn it on by default, so a family
 * that composes this feature is saying its renders can be asked to slow down,
 * not merely to hurry. Vesper's reviewed policy already refuses it for
 * identity-critical production work; the feature is what lets a bench state
 * the opposite request instead of reaching for a raw provider value.
 */
export function fastModeFeature(): ImageFeature {
  return {
    id: "fastMode",
    semantic: "Accepts an accelerated sampling mode, so a render can trade fidelity for speed or refuse the trade.",
    isBound: (model: ImageModel) => model.advancedCapabilities.controls.fastMode !== undefined,
  };
}

/**
 * The model can be told what to EXCLUDE, and acts on it.
 *
 * Composing this feature is a claim about behavior, not about the schema. A
 * declared negative field the endpoint ignores is worse than none: exclusions
 * are dropped where nobody can see it, and the render is judged as if they had
 * been honoured. `qwen/qwen-image-2512` is exactly that case and therefore does
 * NOT compose this feature, even though its schema declares the input
 * (`docs/image-models/models/qwen-image-2512.md` §"Negative-prompt ruling").
 */
export function negativePromptFeature(): ImageFeature {
  return {
    id: "negativePrompt",
    semantic: "Acts on an authored negative prompt, so exclusions genuinely steer the render.",
    isBound: (model: ImageModel) => model.advancedCapabilities.controls.negativePrompt !== undefined,
  };
}
