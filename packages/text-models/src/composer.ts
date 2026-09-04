import type { TextModelFeature, TextProfileValue } from "./features";
import {
  TEXT_CALL_SETTINGS,
  bindingFor,
  type TextCallSetting,
  type TextCallSettings,
  type TextModelHost,
  type TextRequestBody,
  type TextWireValue,
} from "./hosts";

/**
 * The values one model is asked with, keyed by feature id.
 *
 * A profile carries EVERY declared value, including values for features the
 * model's own host does not serve. A profile is one artefact, and a package
 * that dropped the unhosted half at authoring time would lose the record of how
 * the model was meant to be asked the moment a second host appeared. What
 * travels is decided per call, by the host in force, in
 * `bindTextModelProfile`.
 *
 * Owner ruling (2026-09-04), given for the first adapted narrator: fields its
 * host turns out not to honour are deactivated by host selection, never by
 * deleting the values. That is the origin of the structure and the whole of it.
 * It grants no model an author's published settings by default — the standing
 * rule (owner ruling 2026-08-17) is that no model receives model-card sampling
 * settings automatically, so a value in a profile is a claim that this exact
 * model was measured, and an empty profile is the ordinary starting state.
 */
export type TextModelProfile = Readonly<Record<string, TextProfileValue>>;

/**
 * What one call asks for, in the terms a quirk validator reasons about.
 *
 * Deliberately tiny. It is not the prompt, not the message list, and not the
 * lane's own settings: it is the handful of facts a model-specific refusal
 * needs before anything is sent — the motivating case being a model whose
 * context is small enough that a long history plus the requested completion
 * cannot both fit. It grows only when a validator genuinely cannot answer
 * without a new fact, because every field added here is a field every future
 * caller has to be able to supply.
 */
export interface TextModelRequestFacts {
  /** Roughly how many tokens the assembled prompt will occupy. */
  readonly estimatedInputTokens?: number;
  /** The completion budget this call intends to ask for. */
  readonly maxOutputTokens?: number;
}

/**
 * Rewrite the raw request body at the MODEL BOUNDARY, after the profile has
 * been bound and every other decision made.
 *
 * **A preparer MUST be idempotent**: `prepare(prepare(body))` deep-equals
 * `prepare(body)` for every body. A caller may prepare while planning a call
 * and again on the way out, and a preparer that appended on each pass would
 * send a body no reviewer ever read.
 */
export type TextRequestPreparer = (body: TextRequestBody) => TextRequestBody;

/** Reasons this model may not serve this call, in plain English; empty is the normal answer. */
export type TextRequestValidator = (facts: TextModelRequestFacts) => readonly string[];

/**
 * What an adapter knows about how its model BEHAVES, as opposed to what it
 * accepts.
 *
 * Every field is optional and every absent field means "the lane's own default
 * governs" — never zero, never unlimited. An adapter states a hint only where a
 * measurement earns it, because a hint is a claim about a real endpoint and an
 * unfounded one is worse than silence.
 *
 * Provider-neutral on purpose: nothing here names a transport or a credential,
 * so an adapter can carry host knowledge without any provider package being in
 * its import graph.
 */
export interface TextModelExecutionHints {
  /** Total tokens the model can attend to. Earned by the host's own model record. */
  readonly contextLength?: number;
  /** The largest completion the host will return. Earned by the host's record, or by a call that was truncated at a lower ceiling than the context implies. */
  readonly maxCompletionTokens?: number;
  /** How many concurrency slots one call costs on its host. Earned by the host's published cost for the model. */
  readonly concurrencyCost?: number;
  /** Request start to first token. Earned by a measured cold start that a lane's default budget would have abandoned. */
  readonly startupBudgetMs?: number;
  /**
   * This model earns the chat lane's ONE hidden retry for a completion with no
   * visible text.
   *
   * Earned only by a MEASURED intermittent empty on this exact model. Every
   * model without it keeps the lane's behavior of surfacing the empty reply
   * immediately, which is what stops a retry — and its latency — from spreading
   * to models that never needed one.
   */
  readonly hiddenEmptyRetry?: boolean;
  /**
   * Minimum generated tokens on that hidden retry only, and only when the first
   * attempt was a genuinely silent stop.
   *
   * Earned by proving the host honours a minimum-token floor on this model.
   * Deliberately not a global floor: a minimum response length applied to every
   * call is how narrator padding gets resurrected.
   */
  readonly retryMinTokens?: number;
}

/**
 * One piece of a model's weirdness, packaged so that it can be shared by the
 * models that have it and left off the ones that do not.
 *
 * A quirk contributes the adapter's OPTIONAL members, and it is the only thing
 * that does. That is what keeps a definition readable: features and the profile
 * say what the model is asked for, quirks say how this particular model
 * misbehaves while being asked.
 *
 * `id` exists for the refusal below — when two quirks fight over a hook, the
 * error has to be able to say which two.
 */
export interface TextModelQuirk {
  /** Stable, human-readable, and unique within one definition's quirk list. */
  readonly id: string;
  readonly prepareRequest?: TextRequestPreparer;
  readonly validateRequest?: TextRequestValidator;
  readonly executionHints?: TextModelExecutionHints;
}

/** One model, composed from the features it is asked with and the quirks it carries. */
export interface TextModelAdapter {
  /**
   * The exact model id, as the host spells it. Not a family, not a base slug:
   * every setting in the profile below is exact-model evidence, and a sibling
   * checkpoint inherits nothing by name.
   */
  readonly id: string;
  /** The checkpoint family, for reading and grouping only. Several adapters may share one. */
  readonly family: string;
  /** The host this model is served from, and the default `bindTextModelProfile` binds for. */
  readonly host: TextModelHost;
  /** The chat template the model was tuned against, such as `mistral-tekken`. The host applies it; this package only records which one. */
  readonly chatTemplate: string;
  /** The composed feature ids, in declaration order. */
  readonly capabilities: readonly string[];
  /** Every declared value, hosted or not. */
  readonly profile: TextModelProfile;
  readonly prepareRequest?: TextRequestPreparer;
  readonly validateRequest?: TextRequestValidator;
  readonly executionHints?: TextModelExecutionHints;
}

/** What `defineTextModel` is given. */
export interface TextModelDefinition {
  readonly id: string;
  readonly family: string;
  readonly host: TextModelHost;
  readonly chatTemplate: string;
  /** What this model is asked with. Order is preserved into `capabilities`. */
  readonly features: readonly TextModelFeature[];
  /** The declared values. Every key must name a composed feature; an empty profile is a model asked entirely at lane defaults. */
  readonly profile: TextModelProfile;
  /** How it misbehaves while being asked. Omit when it does not. */
  readonly quirks?: readonly TextModelQuirk[];
}

/** One declared value that never reaches the request, and why. */
export interface WithheldTextSetting {
  readonly feature: string;
  readonly reason: string;
}

/**
 * A profile bound for one host: what travels as a call setting, what travels as
 * a raw body field, and what does not travel at all.
 */
export interface BoundTextProfile {
  readonly settings: TextCallSettings;
  readonly body: TextRequestBody;
  readonly withheld: readonly WithheldTextSetting[];
}

/** The optional adapter members a quirk may claim exclusively, spelled once. */
const EXCLUSIVE_QUIRK_HOOKS = ["prepareRequest", "executionHints"] as const;
type ExclusiveQuirkHook = (typeof EXCLUSIVE_QUIRK_HOOKS)[number];

/**
 * Compose one model's adapter out of the features it is asked with, the values
 * it is asked with, and the quirks it carries.
 *
 * **Merge order.** Quirks are visited in declaration order. `prepareRequest`
 * and `executionHints` may each be claimed by exactly ONE quirk: there is no
 * last-wins and no first-wins, because a silent override is precisely the
 * failure this package exists to prevent — two quirks quietly cancelling each
 * other reads, from the outside, as a body that was never rewritten.
 * Declaration order therefore decides nothing about the result; it only decides
 * which quirk is named first in the refusal.
 *
 * Refusals are the one place several contributors are legitimate, so
 * `validateRequest` ACCUMULATES instead: every quirk that defines one runs, in
 * declaration order, and the caller sees every reason a call cannot proceed
 * rather than the first one somebody happened to list. That asymmetry is the
 * whole merge law — an overriding hook that vanishes is invisible, a refusal
 * that vanishes is a call that should not have been made.
 *
 * **The refusals throw, and throwing is correct here** even though this
 * repository's resilience rules prefer degraded defaults to failed turns
 * (`docs/resilience.md`). Those rules govern runtime DATA — a malformed row, a
 * host's surprising response — where refusing costs a player their turn. A
 * definition is CODE: it is evaluated when the module loads, its inputs are
 * literals somebody typed, and there is no player and no turn to protect. A
 * value outside its band, a profile key naming no composed feature, a feature
 * composed twice, two quirks that disagree — each means a developer wrote
 * something that cannot be executed as written, and the only useful moment to
 * say so is before the process serves anything.
 *
 * Note what does NOT throw: a value the host does not serve. That is a runtime
 * question with a correct degraded answer, and `bindTextModelProfile` gives it.
 */
export function defineTextModel(definition: TextModelDefinition): TextModelAdapter {
  const { id, family, host, chatTemplate, features, profile, quirks = [] } = definition;

  const capabilities = features.map((feature) => feature.id);
  const duplicate = capabilities.find((featureId, index) => capabilities.indexOf(featureId) !== index);
  if (duplicate !== undefined) {
    // `capabilities` is read as a set of claims; a repeated entry would make a
    // model look as if it is asked for one thing twice, which means nothing.
    throw new Error(`${id}: feature "${duplicate}" is composed twice.`);
  }

  const composed = new Map(features.map((feature): [string, TextModelFeature] => [feature.id, feature]));
  for (const [featureId, value] of Object.entries(profile)) {
    const feature = composed.get(featureId);
    if (feature === undefined) {
      throw new Error(`${id}: the profile sets "${featureId}", which this model composes no feature for.`);
    }
    const reasons = feature.validate(value);
    if (reasons.length > 0) {
      throw new Error(`${id}: the profile value for "${featureId}" is not usable — ${reasons.join(" ")}`);
    }
  }

  const claims = claimQuirkHooks(id, quirks);
  const validators = quirks.filter((quirk) => quirk.validateRequest !== undefined);

  return {
    id,
    family,
    host,
    chatTemplate,
    capabilities,
    profile,
    ...(claims.prepareRequest === undefined ? {} : { prepareRequest: claims.prepareRequest.prepareRequest }),
    ...(validators.length === 0
      ? {}
      : {
          validateRequest: (facts: TextModelRequestFacts): readonly string[] =>
            validators.flatMap((quirk) => [...(quirk.validateRequest?.(facts) ?? [])]),
        }),
    ...(claims.executionHints === undefined ? {} : { executionHints: claims.executionHints.executionHints }),
  };
}

/**
 * Which quirk owns each exclusively-claimed hook, refusing the moment two claim
 * the same one. Returning the QUIRK rather than the hook value is what lets the
 * refusal name both sides — "which hook broke" is far less useful to whoever
 * wrote the second quirk than "which two quirks disagree".
 */
function claimQuirkHooks(
  id: string,
  quirks: readonly TextModelQuirk[],
): Partial<Record<ExclusiveQuirkHook, TextModelQuirk>> {
  const claimed: Partial<Record<ExclusiveQuirkHook, TextModelQuirk>> = {};
  for (const quirk of quirks) {
    for (const hook of EXCLUSIVE_QUIRK_HOOKS) {
      if (quirk[hook] === undefined) continue;
      const holder = claimed[hook];
      if (holder !== undefined) {
        throw new Error(`${id}: quirks "${holder.id}" and "${quirk.id}" both define ${hook}.`);
      }
      claimed[hook] = quirk;
    }
  }
  return claimed;
}

/**
 * Split an adapter's declared profile into what a host can carry and what it
 * cannot.
 *
 * Pure, and takes the host as an argument rather than reading one: the package
 * evaluates no environment, so the caller that knows which host is in force —
 * including a caller selecting one behind a flag — decides. Binding for a host
 * other than the adapter's own is the supported way to ask "what would this
 * profile look like over there?", which is what makes moving a model between
 * hosts a one-argument change instead of a rewrite.
 *
 * **It withholds; it does not throw.** A value the host does not serve is
 * reported in `withheld` with a reason and never appears in `settings` or
 * `body`. The value stays on the adapter, so the record of how the model was
 * meant to be asked survives a host that cannot honour it, and a later host
 * makes the same profile carry more by adding a dialect row. Refusing to
 * compose such an adapter would have forced the profile to be trimmed to the
 * poorest host it might ever run on.
 *
 * Iteration follows `capabilities`, so the result's key order is the
 * definition's declaration order and two binds of the same adapter are
 * byte-identical.
 */
export function bindTextModelProfile(
  adapter: TextModelAdapter,
  host: TextModelHost = adapter.host,
): BoundTextProfile {
  const settings: Partial<Record<TextCallSetting, TextWireValue>> = {};
  const body: Record<string, TextWireValue> = {};
  const withheld: WithheldTextSetting[] = [];

  for (const featureId of adapter.capabilities) {
    const value = adapter.profile[featureId];
    if (value === undefined) continue;

    const binding = bindingFor(host, featureId);
    if (binding === null) {
      withheld.push({
        feature: featureId,
        reason: `${host} does not serve ${featureId}, so the profile's value for it is not sent.`,
      });
      continue;
    }

    if (binding.kind === "setting") {
      settings[binding.setting] = value;
    } else {
      body[binding.field] = binding.encode === undefined ? value : binding.encode(value);
    }
  }

  return { settings, body, withheld };
}

/**
 * Apply the merge law to one call's settings: the lane's default, then the
 * adapter's bound profile, then any explicit per-call option.
 *
 * The order is law, and this is where it is stated once. The lane default is
 * what every model is asked with; the adapter's profile is exact-model evidence
 * and outranks it; an explicit per-call option — a retry's minimum-token floor,
 * a bench's deliberate override — outranks both, because it is the only layer a
 * human chose for this one call.
 *
 * A key whose value is `undefined` in a later layer does NOT erase an earlier
 * one. That is the defect this helper exists to kill: an optional field spelled
 * out as `undefined` looks identical to an absent one in a plain object spread,
 * and would silently drop the adapter's value on the floor.
 */
export function mergeTextCallSettings(
  laneDefault: TextCallSettings,
  bound: TextCallSettings,
  perCall: TextCallSettings = {},
): TextCallSettings {
  const merged: Partial<Record<TextCallSetting, TextWireValue>> = {};
  for (const layer of [laneDefault, bound, perCall]) {
    for (const setting of TEXT_CALL_SETTINGS) {
      const value = layer[setting];
      if (value !== undefined) merged[setting] = value;
    }
  }
  return merged;
}
