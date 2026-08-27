/**
 * How long one prediction may take, split into the two phases that fail for
 * completely different reasons.
 *
 * Provider-neutral on purpose. It lives here rather than in the transport so an
 * intent can CARRY a policy without importing a provider client, and so the two
 * numbers mean the same thing to whoever enforces them.
 *
 * The single-budget model this replaces could not tell two opposite outcomes
 * apart. A prediction that sat in a cold-boot queue for five minutes and was
 * aborted before it ever executed was recorded exactly like a model that ran and
 * failed — same failure, same message, same conclusion drawn about the model.
 * One of those deserves a retry and says nothing about the model; the other says
 * everything and must not be retried into the same wall.
 *
 * - `startupBudgetMs` — creation until the provider reports the prediction
 *   actually EXECUTING. This is queue time and cold-boot time: nothing about the
 *   render has begun, so it is the phase a bench can afford to wait out.
 * - `renderBudgetMs` — execution start until output. This is the model working,
 *   and it is the only phase whose length says anything about the model.
 * - `maxStartupRetries` — how many times a prediction ABORTED BEFORE IT STARTED
 *   may be recreated. Retries apply to that case alone: a render that began and
 *   then failed has already spent compute and already produced evidence, and
 *   re-running it would buy the same answer twice.
 *
 * Milliseconds, both budgets, matching every other timeout in the image stack.
 * Absent from a render entirely (`ImageRenderIntent.executionPolicy` unset) means
 * the transport's legacy single-budget behavior, byte for byte — which is what
 * production lanes deliberately keep (owner ruling 2026-08-24).
 */
export interface ProviderExecutionPolicy {
  /** Creation → first execution: queue and cold boot. */
  startupBudgetMs: number;
  /** Execution start → output: the model actually working. */
  renderBudgetMs: number;
  /** Recreations allowed after an abort that happened before execution began. */
  maxStartupRetries: number;
}
