import {
  type ImageModel,
  type ImagePromptPreparer,
  type ImageRenderRuntimeFacts,
  MAX_TRIAL_PREDICTION_MS,
  type ProviderExecutionPolicy,
} from "@vesper/image-core";
import { adapterForImageModel, type ImageModelRequestFacts } from "@vesper/image-models";
import { disableSafetyChecker } from "../ai";

/**
 * WHERE the application joins a model family's adapter to the render path.
 *
 * `@vesper/image-models` knows how a family behaves and `@vesper/image-core`
 * runs the render; neither may import the other, so somebody has to hold both
 * and hand one to the other. That somebody is this module, and it is one module
 * rather than a lookup repeated at each call site for a specific reason: a
 * render that compiles its prompt under one dialect and SENDS it under another
 * produces a prediction whose recorded text is not the text the provider read.
 * `compileProfileRenderPlan` hashes the compiled prompt and `renderWithModel`
 * prepares again on the way out, so the two must resolve the same preparer for
 * the same model or every identity-trial cell refuses against its own hash.
 *
 * Nothing here decides anything. It looks a model up, spreads what the adapter
 * had to say, and leaves absence — the ordinary answer for every unmigrated
 * family — meaning exactly what it always meant.
 */

/**
 * The model-boundary prompt step for this model's family, or nothing.
 *
 * Spread rather than returned bare (`{ ...preparePromptFor(model) }`) so an
 * unmigrated model contributes no key at all, and the kernel's own default —
 * the identity preparer — applies without a caller having to name it.
 */
export function preparePromptFor(model: ImageModel): { preparePrompt?: ImagePromptPreparer } {
  const preparePrompt = adapterForImageModel(model.slug)?.preparePrompt;
  return preparePrompt ? { preparePrompt } : {};
}

/**
 * Apply this model's dialect to a prompt directly, for the one caller that has
 * a finished prompt rather than a plan to compile (`renderWithModel`).
 *
 * Safe on an already-prepared prompt because {@link ImagePromptPreparer} makes
 * idempotence a contract: a prompt the compile step already rewrote passes
 * through untouched here, which is what lets the transport wrapper prepare
 * unconditionally without ever contradicting a compiled fingerprint.
 */
export function prepareModelPrompt(model: ImageModel, prompt: string, referenceCount: number): string {
  const preparePrompt = adapterForImageModel(model.slug)?.preparePrompt;
  return preparePrompt ? preparePrompt(model, prompt, referenceCount) : prompt;
}

/**
 * The family adapter's own objections to a request, or none.
 *
 * The one seam where an adapter's composed `validateRequest` actually runs
 * (owner ruling 2026-08-24: wired, not descriptive scaffolding — a feature
 * author who writes a validator must be writing an enforcement). Consumed by
 * the Generator runner pre-spend, where the facts are FINAL before planning:
 * the bench refuses rather than trims, so its reference count and LoRA choice
 * are exactly what will be sent. Production lanes are deliberately not wired
 * yet — their `allow_trim` policy means the pre-plan count is not the sent
 * count, and a validator judging the un-trimmed number would refuse renders
 * the planner would have legally trimmed (a deferred follow-up).
 *
 * An unmigrated family answers nothing, exactly like every other hook here.
 */
export function adapterRequestRefusals(model: ImageModel, facts: ImageModelRequestFacts): readonly string[] {
  const validate = adapterForImageModel(model.slug)?.validateRequest;
  return validate ? validate(model, facts) : [];
}

/**
 * The deployment facts a plan needs, with this model's dialect joined to them.
 *
 * One function for every planning caller — the production render path and both
 * benches — because the safety setting and the dialect are read at the same
 * boundary for the same reason: the pure planner may read neither an
 * environment nor a package above it, so both arrive as values from here.
 * (`captureRenderIntent` is the deliberate exception: a capture is handed its
 * runtime facts explicitly, so it can never guess a posture it did not state.)
 */
export function imageRenderRuntimeFacts(model: ImageModel): ImageRenderRuntimeFacts {
  return { safetyCheckerDisabled: disableSafetyChecker(), ...preparePromptFor(model) };
}

/**
 * The bench lanes' starting budgets: eight minutes to start, three to render,
 * one recreation after a startup abort.
 *
 * These are the Image Generator's and the Image Lab's numbers, and deliberately
 * NOT production's — production lanes pass no policy at all and keep today's
 * single budget (owner ruling 2026-08-24). A bench exists to find out what a
 * model does, and a rarely-run endpoint's cold start is a queue wait rather
 * than evidence about the model; a lane serving a player cannot afford to be
 * that patient, and has no bench operator waiting to read the answer.
 */
const BENCH_STARTUP_BUDGET_MS = 8 * 60_000;
const BENCH_RENDER_BUDGET_MS = 3 * 60_000;
const BENCH_MAX_STARTUP_RETRIES = 1;

/**
 * How one bench prediction is watched: the lane's defaults, narrowed field-wise
 * by whatever this model's adapter has actually observed.
 *
 * **Field-wise, and only where the adapter states something.** An absent hint
 * means "the lane governs" (`ImageModelExecutionHints`) rather than zero
 * or unlimited, so a family that knows its cold start is long but knows nothing
 * about its render time contributes exactly the one number it has.
 *
 * **The sum is capped at {@link MAX_TRIAL_PREDICTION_MS}.** That constant is the
 * hard ceiling everything downstream already treats as the longest a single
 * render may legitimately take, and the transport deliberately does NOT clamp —
 * it takes the numbers as decided, because a lane that had already reasoned
 * about its budgets should not be silently overruled. So the ceiling is owned
 * here, where the reasoning happens. It is a CAP rather than a refusal because
 * a bench that renders under a shorter budget still produces evidence, while a
 * refusal produces none.
 *
 * The excess comes off the STARTUP phase, never the render phase. Startup is
 * queue and cold-boot time — waiting less only means giving up sooner on a
 * prediction that has not begun — while the render phase is the model actually
 * working, and shortening it turns a slow model into a false failure. A hint
 * absurd enough to spend the entire ceiling on rendering therefore leaves no
 * startup phase at all, and the transport reads a zero budget as unusable and
 * falls back to its legacy single budget — its own documented degradation, and
 * a better outcome than a render this function refused to describe.
 */
export function benchExecutionPolicy(model: ImageModel): ProviderExecutionPolicy {
  const hints = adapterForImageModel(model.slug)?.executionHints;
  const renderBudgetMs = Math.min(hints?.renderBudgetMs ?? BENCH_RENDER_BUDGET_MS, MAX_TRIAL_PREDICTION_MS);
  const startupBudgetMs = Math.min(
    hints?.startupBudgetMs ?? BENCH_STARTUP_BUDGET_MS,
    Math.max(0, MAX_TRIAL_PREDICTION_MS - renderBudgetMs),
  );
  return {
    startupBudgetMs,
    renderBudgetMs,
    maxStartupRetries: hints?.maxStartupRetries ?? BENCH_MAX_STARTUP_RETRIES,
  };
}
