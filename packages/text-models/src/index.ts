/**
 * `@vesper/text-models` — how text models DIFFER.
 *
 * Everything exported here answers one question: what must Vesper do
 * differently because this call is going to THAT model? A sampler baseline its
 * author tuned, a chat template that has to be told not to think, a context
 * small enough to refuse a long history, a model that intermittently returns
 * nothing. Without this package that knowledge has nowhere to live, and it
 * leaks back into the transport as an exact-id table every lane pays for.
 *
 * Three pieces, and the split between them is the design. A **feature** is a
 * semantic knob named in Vesper's normalized vocabulary. A **host dialect**
 * says how — or whether — that knob travels on one upstream. An **adapter** is
 * one model's whole declared call profile. Binding a profile for a host is
 * therefore a lookup, not a rewrite, and moving a model to another host is one
 * argument rather than a second table.
 *
 * **It never calls a provider and never reads the environment.** It holds no
 * credential, opens no socket, and has no opinion about which host is in force:
 * `bindTextModelProfile` takes the host as an argument so the application —
 * which owns flags, credentials and lanes — decides, and this package stays a
 * description that can be read, tested and reviewed on its own.
 *
 * `@vesper/contracts` sits below it; `@vesper/image-core` and
 * `@vesper/simulation-core` are PEERS at the same rank and are never imported
 * from here. The application is the only workspace above all three, and it is
 * where an adapter's profile becomes a real call.
 *
 * **This list is the package's entire public API, and it is deliberately
 * explicit.** Internal folder barrels may still use `export *` — they are
 * reading aids, not publication. The root may not: a wildcard here would make
 * every helper added to an internal barrel public without appearing in any
 * diff, and `pnpm lint:package-boundaries` fails the build if one appears.
 * Adding an entry below is a public-API change, and reviewers should read it as
 * one.
 */

export { bindTextModelProfile, bindTextProfileValues, defineTextModel, mergeTextCallSettings } from "./composer";
export type {
  BoundTextProfile,
  TextModelAdapter,
  TextModelDefinition,
  TextModelExecutionHints,
  TextModelProfile,
  TextModelQuirk,
  TextModelRequestFacts,
  TextRequestPreparer,
  TextRequestValidator,
  WithheldTextSetting,
} from "./composer";

export {
  dryAllowedLengthFeature,
  dryBaseFeature,
  dryMultiplierFeature,
  dryRangeFeature,
  drySequenceBreakersFeature,
  dynatempExponentFeature,
  dynatempMaxFeature,
  dynatempMinFeature,
  frequencyPenaltyFeature,
  logitBiasFeature,
  maxTokensFeature,
  minPFeature,
  minTokensFeature,
  mirostatEtaFeature,
  mirostatModeFeature,
  mirostatTauFeature,
  presencePenaltyFeature,
  repetitionPenaltyFeature,
  repetitionPenaltyRangeFeature,
  repetitionPenaltySlopeFeature,
  seedFeature,
  smoothingCurveFeature,
  smoothingFactorFeature,
  stopFeature,
  temperatureFeature,
  tfsFeature,
  topAFeature,
  topKFeature,
  topNsigmaFeature,
  topPFeature,
  typicalPFeature,
  xtcProbabilityFeature,
  xtcThresholdFeature,
} from "./features";
export type { TextModelFeature, TextProfileValue } from "./features";

export { TEXT_CALL_SETTINGS, TEXT_MODEL_HOSTS, hostsServing } from "./hosts";
export type {
  TextCallSetting,
  TextCallSettings,
  TextFeatureBinding,
  TextHostDialect,
  TextModelHost,
  TextRequestBody,
  TextWireValue,
} from "./hosts";

export { TEXT_MODEL_ADAPTERS, adapterForTextModel } from "./registry";

/**
 * The exact ids of the registered models.
 *
 * Published because an exact model id is a PERSISTED value — it sits on chats
 * and worlds, it keys the registry, and the application keys behaviour on it —
 * so every spelling of one is a place a typo reads as "no adapter" rather than
 * as a failure. One definition owns each id and everything else imports it.
 */
export { FABLE_FUSION_711_ID, F451_ULTRA_PRO_WRITER_ID } from "./families/qwen3-6-27b/davidau-non-thinking";
export { DARKIDOL_QWEN38_ID } from "./families/qwen3-8-27b/darkidol-qwen3-8-27b-v1-1";
export { ASMODEUS_24B_V3_ID } from "./families/mistral-24b/asmodeus-24b-v3";
