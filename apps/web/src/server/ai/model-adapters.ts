import {
  adapterForTextModel,
  bindTextModelProfile,
  bindTextProfileValues,
  mergeTextCallSettings,
  TEXT_MODEL_HOSTS,
  type BoundTextProfile,
  type TextCallSettings,
  type TextModelHost,
  type TextModelProfile,
  type TextRequestBody,
  type TextWireValue,
  type WithheldTextSetting,
} from "@vesper/text-models";
import type { JSONValue } from "ai";
import { narrativeModelProvider } from "@/lib/narrative-models";
import { log } from "@/server/log";

/**
 * The ONE place `@vesper/text-models` becomes a real request.
 *
 * The package describes how a model differs and binds a profile for a host; it
 * never opens a socket, holds a credential, or decides which host is in force.
 * This file is the other half of that contract: it resolves the exact adapter
 * for the model about to be called, binds it for the host that actually serves
 * it, and hands the lane back call settings and raw body fields already merged
 * in the right order.
 *
 * **One join, or the lanes disagree.** Character chat and successor chat both
 * reach a narrator through `textModel()`, and both build their call here. Two
 * call sites resolving adapters independently would eventually bind different
 * hosts or different merge orders for one model, and the difference would show
 * up as a quality change nobody could attribute — which is exactly the drift
 * the exact-model policy table this replaced was starting to accumulate.
 *
 * **A model's profile belongs to the leg that IS the narration**, not to every
 * call that happens to name a narrator model. Most of them cost nothing either
 * way — a model with no registered adapter resolves to `null` and is asked
 * exactly as it is today — but the successor deliberator asks the chat's
 * narrator model for one strict JSON object at a classifier's temperature, and a
 * prose profile applied there would reshape a call nobody measured that way. The
 * chat stream is narration by definition; `generateChecked` serves many legs and
 * takes the profile only when a caller says the call is narration.
 */

/**
 * The exact ids the application keys on, re-exported from the definitions that
 * own them rather than spelled a second time here.
 *
 * A curated row's id is a persisted value, so a second spelling of one would
 * silently mean "this model has no adapter" instead of failing — which is the
 * one failure mode an exact-id registry cannot detect for itself.
 */
export {
  ASMODEUS_24B_V3_ID,
  DARKIDOL_QWEN38_ID,
  FABLE_FUSION_711_ID,
  F451_ULTRA_PRO_WRITER_ID,
} from "@vesper/text-models";

/** Raw request-body fields keyed by the transport's own provider-options name. */
export type TextProviderOptions = Record<string, Record<string, JSONValue>>;

/**
 * The call settings a lane spreads into `streamText` / `generateText`, in the
 * generation SDK's own spelling.
 *
 * Stated here rather than imported from the package: the package holds the
 * setting NAMES as a string union on purpose (a provider-neutral description of
 * a model must not pin the application's SDK version), and this is the boundary
 * where those names become typed SDK arguments.
 */
export interface TextModelCallSettings {
  temperature?: number;
  topP?: number;
  topK?: number;
  presencePenalty?: number;
  frequencyPenalty?: number;
  seed?: number;
  stopSequences?: string[];
  maxOutputTokens?: number;
}

/** What one lane brings to the join, in the package's feature vocabulary. */
export interface TextModelCallInput {
  /**
   * What EVERY model in this lane is asked with — the narrator temperature, a
   * structured leg's output budget. Outranked by the adapter's profile, which
   * is exact-model evidence.
   *
   * A value a caller passed into a shared helper belongs here too, not in
   * `perCall`: the successor narrator asking `generateChecked` for temperature
   * 0.85 is stating its lane's setting, and a measured exact-model baseline
   * still outranks it. That ordering is what makes a Featherless narrator's
   * profile survive a call site that also sets a temperature.
   */
  readonly laneDefaults?: TextModelProfile;
  /**
   * What THIS ONE call asks for, outranking the adapter — a retry's
   * minimum-token floor, a bench's deliberate override. The only layer a human
   * or a lane chose for this single call rather than for the model or the lane.
   */
  readonly perCall?: TextModelProfile;
  /**
   * Provider options the lane already built (OpenRouter routing and the
   * eval-ruled reasoning knob). Merged with, never replaced by, the adapter's
   * bound body fields — both travel under the same provider key, and a plain
   * spread at a call site would silently drop whichever was written first.
   */
  readonly providerOptions?: TextProviderOptions;
}

/** One call's shape, ready to spread. */
export interface TextModelCall {
  readonly settings: TextModelCallSettings;
  /** Absent when nothing rides the raw body — so a lane can omit the key entirely. */
  readonly providerOptions?: TextProviderOptions;
  /**
   * Declared values this host does not serve. **Diagnostic, never an error**: a
   * withheld value is the expected result of asking a model through a host that
   * serves less than its author's profile, and the call proceeds without it.
   */
  readonly withheld: readonly WithheldTextSetting[];
}

/** The environment setting that names which host a profile is bound for. */
const HOST_SELECTION_ENV = "VESPER_TEXT_MODEL_HOST";

/**
 * The host that actually serves this model id — the catalog's routing decision,
 * read through the same function `textModel()` routes on so the two can never
 * disagree.
 *
 * An id the narrator catalog does not name answers `openrouter`, exactly as the
 * gateway does: the resolvers coerce an uncurated id to a curated default before
 * it can reach a provider, and every other model list in the app is
 * OpenRouter-only.
 */
export function transportTextModelHost(modelId: string): TextModelHost {
  return narrativeModelProvider(modelId) === "featherless" ? "featherless" : "openrouter";
}

/**
 * The host named by {@link HOST_SELECTION_ENV}, or null when the deployment has
 * not named one.
 *
 * Unset is the ordinary state and the honest default: the transport that serves
 * a model already knows which dialect governs it. An unrecognised value degrades
 * to null with a diagnostic rather than failing a turn — a typo in a deployment
 * variable must not take narration down.
 */
export function selectedTextModelHost(): TextModelHost | null {
  const raw = process.env[HOST_SELECTION_ENV]?.trim();
  if (!raw) return null;
  const selected = TEXT_MODEL_HOSTS.find((host) => host === raw);
  if (selected === undefined) {
    log.warn("ai.text_model_host", "unrecognised text-model host selection ignored", {
      requested: raw,
      known: [...TEXT_MODEL_HOSTS],
    });
    return null;
  }
  return selected;
}

/**
 * The host this model's profile is bound for.
 *
 * Owner ruling (2026-09-04, #473): a field its host does not honour is
 * deactivated by host SELECTION, never by deleting the value from the profile.
 * This function is where that selection happens, and it has one hard rule —
 * **selecting a host does not create a transport for it.** A selection that
 * names the host already serving the model is honoured (it changes nothing, and
 * saying so is the point); a selection that names any other host is reported and
 * ignored, because binding one host's dialect onto another's wire would send a
 * KoboldCpp spelling to an OpenAI-compatible endpoint and call it a profile.
 *
 * So the setting's value today is that it is the ONE place a future host move is
 * expressed. The day a model is served from somewhere else, its catalog row
 * changes the transport and this selection confirms the dialect; until then the
 * transport wins every disagreement.
 */
export function boundTextModelHost(modelId: string): TextModelHost {
  const transport = transportTextModelHost(modelId);
  const selected = selectedTextModelHost();
  if (selected === null || selected === transport) return transport;
  log.warn("ai.text_model_host", "selected host does not serve this model; binding for the transport that does", {
    modelId,
    selected,
    transport,
  });
  return transport;
}

/** Nothing declared, nothing withheld — what an unadapted model binds to. */
const NOTHING_BOUND: BoundTextProfile = { settings: {}, body: {}, withheld: [] };

/**
 * Resolve, bind and merge one model's call.
 *
 * Merge order is the package's law and this is the only place the application
 * states it: the lane's default, then the adapter's bound profile, then the
 * explicit per-call layer. Every layer is bound through the SAME host dialect,
 * so a lane default and an adapter value for one feature land in the same
 * column — a value cannot ride the body from one layer and a call setting from
 * another and quietly stop overriding.
 */
export function textModelCall(modelId: string, input: TextModelCallInput = {}): TextModelCall {
  const host = boundTextModelHost(modelId);
  const adapter = adapterForTextModel(modelId);

  const lane = bindTextProfileValues(input.laneDefaults ?? {}, host);
  const profile = adapter === null ? NOTHING_BOUND : bindTextModelProfile(adapter, host);
  const perCall = bindTextProfileValues(input.perCall ?? {}, host);

  const body = { ...lane.body, ...profile.body, ...perCall.body };
  const providerOptions: TextProviderOptions = { ...input.providerOptions };
  if (Object.keys(body).length > 0) {
    providerOptions[host] = { ...(providerOptions[host] ?? {}), ...requestBodyJson(body) };
  }

  if (perCall.withheld.length > 0) {
    // WARN, where an adapter's withheld values only earn debug. A per-call value
    // is the one layer chosen for this single call — a retry's token floor — so
    // a host that cannot carry it has silently dropped something a lane asked
    // for, rather than something an author published for a different runtime.
    log.warn("ai.text_model_profile", "host does not serve a value this call asked for", {
      modelId,
      host,
      withheld: perCall.withheld.map((entry) => entry.feature),
    });
  }

  if (profile.withheld.length > 0) {
    // Debug, because this is the EXPECTED answer for a model whose author tuned
    // it on a local runtime: an operator asking why a sampler seems to do
    // nothing needs to be able to read which values this host declined, and
    // nobody else needs to read it on every turn.
    log.debug("ai.text_model_profile", "host does not serve every declared profile value", {
      modelId,
      host,
      withheld: profile.withheld.map((entry) => entry.feature),
    });
  }

  return {
    settings: sdkSettings(mergeTextCallSettings(lane.settings, profile.settings, perCall.settings)),
    ...(Object.keys(providerOptions).length > 0 ? { providerOptions } : {}),
    // Only the adapter's own withheld values are reported. A lane default the
    // host does not serve is the lane's bug, and it is already visible as a
    // setting that never reached the wire; an adapter's is EXPECTED and is the
    // thing an operator needs told.
    withheld: profile.withheld,
  };
}

/**
 * Rewrite an outgoing request body with the adapter's own preparer, at the model
 * boundary.
 *
 * This is the transport's `transformRequestBody` hook, and it runs on the fully
 * assembled body — after the SDK has spelled the call settings and spread the
 * provider options — because that is the only moment a model-specific rewrite
 * can see the whole request. The id is read off the body rather than taken as an
 * argument: one client serves every model on its host.
 *
 * A preparer must be idempotent (the package's contract), so a body that has
 * already been prepared is unchanged by a second pass. A model with no adapter,
 * or an adapter with no preparer, gets its body back untouched — including a
 * body with no `model` key at all, which is a caller's bug rather than a licence
 * to guess.
 */
export function prepareTextRequestBody(body: Record<string, unknown>): Record<string, unknown> {
  const modelId = typeof body.model === "string" ? body.model : "";
  const prepare = adapterForTextModel(modelId)?.prepareRequest;
  if (prepare === undefined) return body;
  // A preparer owns the WHOLE body it is handed and returns the whole body back,
  // so its result is the request — spreading it over the original would quietly
  // resurrect a field it removed on purpose. The cast is the type boundary: the
  // assembled body is `unknown` per key because it also carries messages and
  // tools, which a preparer passes through by identity.
  return prepare(body as TextRequestBody);
}

/**
 * Whether this narrator earns the chat lane's ONE hidden retry for a completion
 * with no visible text.
 *
 * False for every model without a measured intermittent empty, which is every
 * model that has not been probed for one — so the retry, and its latency, can
 * never spread by default to narrators that always answer.
 */
export function narratorHiddenRetryModel(modelId: string): boolean {
  return adapterForTextModel(modelId)?.executionHints?.hiddenEmptyRetry === true;
}

/**
 * The per-call floor on generated tokens for the hidden retry, or undefined when
 * this model has no floor.
 *
 * Returned as a PROFILE rather than as request fields: the lane hands it to
 * {@link textModelCall} as the per-call layer and the host dialect spells it, so
 * the application never writes a wire field name. Only ever asked for on a retry
 * that followed a genuinely silent stop — a minimum response length applied to
 * every call is how narrator padding gets resurrected.
 */
export function narratorRetryFloor(modelId: string): TextModelProfile | undefined {
  const minTokens = adapterForTextModel(modelId)?.executionHints?.retryMinTokens;
  return minTokens === undefined ? undefined : { minTokens };
}

/** A number the SDK can take as a call setting, or undefined when the value is another shape. */
function numberSetting(value: TextWireValue | undefined): number | undefined {
  return typeof value === "number" ? value : undefined;
}

/** A mutable string list for the SDK's `stopSequences`, or undefined for any other shape. */
function stringListSetting(value: TextWireValue | undefined): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const entries: string[] = [];
  for (const entry of value) {
    if (typeof entry !== "string") return undefined;
    entries.push(entry);
  }
  return entries;
}

/**
 * Turn the merged setting bag into the SDK's typed arguments, dropping a key
 * whose value is the wrong shape rather than passing it on.
 *
 * Nothing should ever be dropped here — every value came from a profile the
 * composer validated when the adapter was defined — so this is a type boundary
 * rather than a sanitizer. Written out one key at a time on purpose: the list is
 * the exact set of settings Vesper hands a generation SDK, and a new one should
 * appear in a diff.
 */
function sdkSettings(merged: TextCallSettings): TextModelCallSettings {
  const temperature = numberSetting(merged.temperature);
  const topP = numberSetting(merged.topP);
  const topK = numberSetting(merged.topK);
  const presencePenalty = numberSetting(merged.presencePenalty);
  const frequencyPenalty = numberSetting(merged.frequencyPenalty);
  const seed = numberSetting(merged.seed);
  const maxOutputTokens = numberSetting(merged.maxOutputTokens);
  const stopSequences = stringListSetting(merged.stopSequences);
  return {
    ...(temperature === undefined ? {} : { temperature }),
    ...(topP === undefined ? {} : { topP }),
    ...(topK === undefined ? {} : { topK }),
    ...(presencePenalty === undefined ? {} : { presencePenalty }),
    ...(frequencyPenalty === undefined ? {} : { frequencyPenalty }),
    ...(seed === undefined ? {} : { seed }),
    ...(stopSequences === undefined ? {} : { stopSequences }),
    ...(maxOutputTokens === undefined ? {} : { maxOutputTokens }),
  };
}

/**
 * Copy a bound body into the SDK's `JSONValue` shape.
 *
 * The package's wire values are deeply readonly — a description a reviewer reads
 * must not be mutable by the transport that sends it — and the SDK's provider
 * options are not, so the two types are structurally identical and nominally
 * incompatible. This is that one copy, and it is deep because a bound value can
 * be a record (the thinking toggle's chat-template keyword) or a list (stop
 * sequences).
 */
function requestBodyJson(body: TextRequestBody): Record<string, JSONValue> {
  return Object.fromEntries(Object.entries(body).map(([field, value]) => [field, jsonValue(value)]));
}

function jsonValue(value: TextWireValue): JSONValue {
  if (typeof value === "number" || typeof value === "string" || typeof value === "boolean") return value;
  if (Array.isArray(value)) return value.map((entry: TextWireValue) => jsonValue(entry));
  return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, jsonValue(entry)]));
}
