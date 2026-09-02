import { defineImageModel, type ImageModelAdapter, type ImageModelQuirk } from "../../composer";
import { loraFeature } from "../../features";
import { QWEN_IMAGE_FAMILY, qwenEditFeatures } from "./shared";

/**
 * The startup budget for this endpoint: eight minutes from creation to first
 * execution.
 *
 * Observed, not chosen: the Stage 0 bench run this budget exists to fix sat in a
 * cold start past its whole five-minute budget and was aborted by the provider
 * before it began, which Vesper then reported as a render failure. This endpoint
 * is run rarely enough that a cold start is the normal case rather than the
 * exception, so the startup phase needs a budget of its own rather than a share
 * of the render's.
 *
 * It is a bench-lane STARTING POINT to be tuned from observed queue behavior,
 * not a settled constant.
 */
const QWEN_EDIT_PLUS_LORA_STARTUP_BUDGET_MS = 8 * 60_000;

/**
 * The hint carrying that budget.
 *
 * `renderBudgetMs` is deliberately left unset: nothing has been observed about
 * how long this endpoint takes once it is actually running, and the lane's own
 * default is a better answer than a number invented to fill the field. An
 * absent hint means "the lane governs" (see `ImageModelExecutionHints`), so
 * leaving it out is a statement, not an omission.
 *
 * One retry, not more. A startup abort is worth one second attempt because cold
 * starts are transient; a second failure means the endpoint is not coming up,
 * and retrying it further just spends bench time discovering that slowly.
 */
function qwenEditPlusLoraColdStart(): ImageModelQuirk {
  return {
    id: "qwen.plus-lora-cold-start",
    executionHints: {
      startupBudgetMs: QWEN_EDIT_PLUS_LORA_STARTUP_BUDGET_MS,
      maxStartupRetries: 1,
    },
  };
}

/**
 * `qwen/qwen-image-edit-plus-lora` — the LoRA-capable Qwen edit wrapper
 * (`docs/image-models/models/qwen-image-edit-plus-lora.md`).
 *
 * It is the OLDER 2509-generation edit endpoint, and that is the trade this
 * adapter exists to make legible: it accepts user-supplied LoRA weights, as
 * `qwen-image-edit-2511` now does as well, but it is a generation behind that
 * model at holding a face. It stays addressable as a separate legacy and
 * comparison endpoint — notably the production intimate-scene model swap —
 * rather than as the registry's only route to a custom LoRA.
 *
 * Endpoint facts:
 *
 * - **LoRA:** one per prediction — weights plus a scale in 0–4. There is no
 *   second weights/scale pair, so multi-LoRA is not a matter of asking twice.
 *   The weights locator and the strength band are the LIBRARY row's business;
 *   this adapter only claims the endpoint can carry them.
 * - **References:** 1–3, same as 2511.
 * - **Speed preset:** the wrapper defaults its accelerated sampling path ON,
 *   and unlike 2511 this row carries no reviewed quality overlay turning it
 *   off. Comparison arms on this model should therefore be compared with each
 *   other first, not against 2511 renders.
 *
 * Both endpoints are Qwen instruction editors that address references by
 * number, so the numbered-reference lock is a family convention rather than a
 * property of one slug — and it is compiled by the family's prompt dialect in
 * `@vesper/image-core`, never rewritten here.
 */
export const qwenImageEditPlusLora: ImageModelAdapter = defineImageModel({
  family: QWEN_IMAGE_FAMILY,
  features: [...qwenEditFeatures(), loraFeature()],
  quirks: [qwenEditPlusLoraColdStart()],
});
