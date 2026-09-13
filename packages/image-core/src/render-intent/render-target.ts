import { IMAGE_TARGET_ASPECT, parseAspectValue } from "../models/image-models";
import type { ImageModelProfile, ImageProfileTask } from "../models/image-model-profiles";
import type { ImageRenderTarget } from "./render-intent";

/**
 * The closed table of DEFAULT target ratios, one per task — what a render asks
 * for when neither its profile nor its own lane names a shape.
 *
 * A `Record` over every {@link ImageProfileTask}, not a partial map with a
 * fallback: adding a task to `imageProfileTasks` without adding it here is a
 * compile error, which is what keeps this table from silently going stale the
 * way a `switch` with a `default` case would not.
 *
 * The values reproduce what every lane already hard-codes today (`avatar.ts`,
 * `scene.ts`, `chat-look.ts` at 3:4; `entity.ts` at 1 for items and 3:2 for
 * locations; the chat "place" shot at 3:2) — this table does not change a
 * single one of them, it only gives a render with no lane-specific number
 * somewhere to land.
 */
export const IMAGE_TASK_TARGET_ASPECTS: Readonly<Record<ImageProfileTask, number>> = {
  portrait: IMAGE_TARGET_ASPECT,
  variant: IMAGE_TARGET_ASPECT,
  scene: IMAGE_TARGET_ASPECT,
  chat_look: IMAGE_TARGET_ASPECT,
  item: 1,
  location: 3 / 2,
  chat_place: 3 / 2,
  text_repair: IMAGE_TARGET_ASPECT,
  example_transform: IMAGE_TARGET_ASPECT,
  image_set: IMAGE_TARGET_ASPECT,
};

/** Where a resolved target ratio came from — the provenance a stored render keeps. */
export const renderTargetSources = ["raw", "profile", "lane", "task_default"] as const;
export type RenderTargetSource = (typeof renderTargetSources)[number];

export interface ResolvedRenderTarget {
  /** The width/height ratio to render at, or `null` for the model's own default shape. */
  aspectRatio: number | null;
  source: RenderTargetSource;
}

export interface ResolveRenderTargetInput {
  /** The intent's own target, when it named one — absent is a lane that leaves the shape unsaid. */
  intentTarget: ImageRenderTarget | undefined;
  /** The profile this render resolved to, for its declared `controlDefaults.aspectRatio`. */
  profile: Pick<ImageModelProfile, "controlDefaults">;
  task: ImageProfileTask;
}

/**
 * THE one shared target resolution every render's shape negotiation starts
 * from — what `planImageRender` calls to decide `{ targetRatio, targetSource }`
 * before handing either to `chooseDimensions`.
 *
 * Precedence, each answer naming its own source:
 *
 * 1. **`raw`.** The intent explicitly asked for no shape at all
 *    (`intentTarget.aspectRatio === null`) — the Image Generator's deliberate
 *    no-shape mode. Nothing outranks this: a bench run proving what a model
 *    does on its own must stay untouched by a profile's or a lane's opinion.
 * 2. **`profile`.** The profile declares its own `controlDefaults.aspectRatio`.
 *    A profile's declared shape wins over a lane's own hard-coded request,
 *    because a profile is a deliberate per-model configuration (a reviewed
 *    custom width/height bucket, say) while a lane's number is a generic
 *    per-task default that has no idea which model it is about to run on.
 * 3. **`lane`.** The intent carries an explicit numeric target — every
 *    production lane today.
 * 4. **`task_default`.** Neither of the above named a shape: the closed table
 *    above, keyed by the profile's task.
 *
 * Pure and defensive: an unparseable stored `aspectRatio` (which the profile
 * schema's own refine should already have refused at save time) is treated as
 * absent rather than thrown over, so a render never fails for a fact this
 * function does not need to trust twice.
 */
export function resolveRenderTarget(input: ResolveRenderTargetInput): ResolvedRenderTarget {
  const { intentTarget, profile, task } = input;

  if (intentTarget && intentTarget.aspectRatio === null) {
    return { aspectRatio: null, source: "raw" };
  }

  const declared = profile.controlDefaults.aspectRatio;
  const profileRatio = declared === undefined ? null : parseAspectValue(declared);
  if (profileRatio !== null) {
    return { aspectRatio: profileRatio, source: "profile" };
  }

  if (intentTarget && typeof intentTarget.aspectRatio === "number") {
    return { aspectRatio: intentTarget.aspectRatio, source: "lane" };
  }

  return { aspectRatio: IMAGE_TASK_TARGET_ASPECTS[task], source: "task_default" };
}
