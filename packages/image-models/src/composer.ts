import type { ImageModel } from "@vesper/image-core";
import type { ImageFeature, ImageModelRequestFacts } from "./features";

/**
 * Rewrite a prompt at the MODEL BOUNDARY, after every prompt decision has been
 * made.
 *
 * It receives the reference count because dialects are usually about how the
 * references are addressed — "image 1 is the identity reference" reads as a
 * lie on a render carrying none.
 *
 * **A preparer MUST be idempotent**: `prepare(prepare(p)) === prepare(p)` for
 * every prompt. This is not a style preference. `compileProfileRenderPlan`
 * hashes the prepared prompt and the transport prepares again on the way out,
 * so a preparer that changed the text on a second pass would make a render
 * refuse against its own compiled prompt.
 */
export type ImagePromptPreparer = (model: ImageModel, prompt: string, referenceCount: number) => string;

/** Reasons this model may not serve this request, in plain English; empty is the normal answer. */
export type ImageRequestValidator = (model: ImageModel, request: ImageModelRequestFacts) => readonly string[];

/**
 * What a family knows about how its endpoints BEHAVE under load, as opposed to
 * what they accept.
 *
 * Every field is optional and every absent field means "the lane's own default
 * governs" — never zero, never unlimited. An adapter states a hint only where
 * it has observed something the lane's default gets wrong, because a hint is a
 * claim about a real endpoint and an unfounded one is worse than silence.
 *
 * Provider-neutral on purpose: nothing here names a transport, so an adapter
 * can carry timing knowledge without `@vesper/image-replicate` being anywhere
 * in its import graph (they are peers and may not import one another).
 */
export interface ImageModelExecutionHints {
  /** Creation → first execution. A cold start on a rarely-run endpoint can be minutes. */
  readonly startupBudgetMs?: number;
  /** Execution start → output. */
  readonly renderBudgetMs?: number;
  /** How many times an UNSTARTED prediction may be abandoned and re-created. */
  readonly maxStartupRetries?: number;
}

/**
 * One piece of a family's weirdness, packaged so that it can be shared by the
 * endpoints that have it and left off the ones that do not.
 *
 * A quirk contributes the adapter's OPTIONAL members, and it is the only thing
 * that does. That is what keeps composition readable: features say what a model
 * expresses, quirks say how this particular endpoint misbehaves while
 * expressing it, and reading a definition tells you both without opening the
 * family's shared module.
 *
 * `id` exists for the refusal message below — when two quirks fight over a
 * hook, the error has to be able to say which two.
 */
export interface ImageModelQuirk {
  /** Stable, human-readable, and unique within one definition's quirk list. */
  readonly id: string;
  readonly preparePrompt?: ImagePromptPreparer;
  readonly validateRequest?: ImageRequestValidator;
  readonly executionHints?: ImageModelExecutionHints;
}

/** One model family's endpoint, composed from features and quirks. */
export interface ImageModelAdapter {
  /**
   * The family this endpoint belongs to. Several adapters share one family
   * string — that is the point of a family — so this is not an identity.
   */
  readonly family: string;
  /** The composed feature ids, in declaration order. */
  readonly capabilities: readonly string[];
  readonly preparePrompt?: ImagePromptPreparer;
  readonly validateRequest?: ImageRequestValidator;
  readonly executionHints?: ImageModelExecutionHints;
}

/** What `defineImageModel` is given. */
export interface ImageModelDefinition {
  readonly family: string;
  /** What this endpoint expresses. Order is preserved into `capabilities`. */
  readonly features: readonly ImageFeature[];
  /** How it misbehaves while expressing it. Omit when it does not. */
  readonly quirks?: readonly ImageModelQuirk[];
}

/** The optional adapter members a quirk may claim, spelled once. */
const QUIRK_HOOKS = ["preparePrompt", "validateRequest", "executionHints"] as const;
type QuirkHook = (typeof QUIRK_HOOKS)[number];

/**
 * Compose one model family's endpoint out of the capabilities it expresses and
 * the quirks it carries.
 *
 * **Merge order.** Quirks are visited in declaration order, and each optional
 * hook may be claimed by exactly ONE of them. There is no last-wins and no
 * first-wins, because a silent override is precisely the failure this package
 * exists to prevent: two dialects quietly cancelling each other reads, from the
 * outside, as a prompt that was never rewritten. Declaration order therefore
 * decides nothing about the result — it only decides which quirk is named
 * first in the refusal — and that is the intended property. Validation is the
 * one place several contributors are legitimate, and there they ACCUMULATE
 * rather than overwrite: every feature's `validate` runs in declaration order,
 * then the quirk's, and the caller sees every reason at once instead of the
 * first one somebody happened to list.
 *
 * **The refusals throw, and throwing is correct here** even though this
 * repository's resilience rules prefer degraded defaults to failed turns
 * (`docs/resilience.md`). Those rules govern runtime DATA — a malformed row, a
 * provider's surprising response — where refusing costs a player their turn.
 * A definition is CODE: it is evaluated when the module loads, its inputs are
 * literals somebody typed, and there is no player and no turn to protect. A
 * conflict here means a developer wrote two quirks that disagree, and the only
 * useful moment to say so is before the process serves anything.
 */
export function defineImageModel(definition: ImageModelDefinition): ImageModelAdapter {
  const { family, features, quirks = [] } = definition;

  const capabilities = features.map((feature) => feature.id);
  const duplicateFeature = capabilities.find((id, index) => capabilities.indexOf(id) !== index);
  if (duplicateFeature !== undefined) {
    // `capabilities` is read as a set of claims; a repeated entry would make an
    // endpoint look like it expresses one capability twice, which means nothing.
    throw new Error(`${family}: feature "${duplicateFeature}" is composed twice.`);
  }

  const claims = claimQuirkHooks(family, quirks);
  const featureValidators = features.filter((feature) => feature.validate !== undefined);
  const quirkValidator = claims.validateRequest?.validateRequest;

  return {
    family,
    capabilities,
    ...(claims.preparePrompt === undefined ? {} : { preparePrompt: claims.preparePrompt.preparePrompt }),
    ...(featureValidators.length === 0 && quirkValidator === undefined
      ? {}
      : {
          validateRequest: (model: ImageModel, request: ImageModelRequestFacts): readonly string[] => [
            ...featureValidators.flatMap((feature) => [...(feature.validate?.(model, request) ?? [])]),
            ...(quirkValidator?.(model, request) ?? []),
          ],
        }),
    ...(claims.executionHints === undefined ? {} : { executionHints: claims.executionHints.executionHints }),
  };
}

/**
 * Which quirk owns each optional hook, refusing the moment two claim the same
 * one. Returning the QUIRK rather than the hook value is what lets the refusal
 * name both sides — "which hook broke" is far less useful to whoever wrote the
 * second quirk than "which two quirks disagree".
 */
function claimQuirkHooks(
  family: string,
  quirks: readonly ImageModelQuirk[],
): Partial<Record<QuirkHook, ImageModelQuirk>> {
  const claimed: Partial<Record<QuirkHook, ImageModelQuirk>> = {};
  for (const quirk of quirks) {
    for (const hook of QUIRK_HOOKS) {
      if (quirk[hook] === undefined) continue;
      const holder = claimed[hook];
      if (holder !== undefined) {
        throw new Error(`${family}: quirks "${holder.id}" and "${quirk.id}" both define ${hook}.`);
      }
      claimed[hook] = quirk;
    }
  }
  return claimed;
}
