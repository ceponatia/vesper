import {
  createOpenAICompatible,
  type OpenAICompatibleProvider,
} from "@ai-sdk/openai-compatible";
import {
  createOpenRouter,
  type OpenRouterProvider,
} from "@openrouter/ai-sdk-provider";
import type { JSONValue, LanguageModel, ProviderMetadata } from "ai";
import { AGENT_MODELS, DEFAULT_AGENT_MODEL_ID } from "@/lib/agent-models";
import { DEFAULT_SCENE_COMPOSER_MODEL_ID, SCENE_COMPOSER_MODELS } from "@/lib/composer-models";
import {
  DEFAULT_CHARACTER_CHAT_MODEL_ID,
  DEFAULT_NARRATIVE_MODEL_ID,
  NARRATIVE_MODELS,
  narrativeModelProvider,
  resolveChatModelId,
} from "@/lib/narrative-models";
import { log } from "@/server/log";

export const MODEL_DEFAULTS = {
  // The curated narrator list (lib/narrative-models.ts) is the one source for
  // narrator options; the resolver below accepts any world-override id.
  narrative: DEFAULT_NARRATIVE_MODEL_ID,
  // state + tool both default to the curated in-session agent default
  // (lib/agent-models.ts). state backs the post-turn agents + authoring; tool
  // backs intake.
  state: DEFAULT_AGENT_MODEL_ID,
  tool: DEFAULT_AGENT_MODEL_ID,
  /**
   * The scene composer's OWN seam (scene-composition.plan.md slice 2), now backed by a
   * curated list (lib/composer-models.ts) so a chat can be moved onto a candidate without
   * a deploy.
   *
   * It used to ride `tool`, and that was the wrong bed for it: the shot planner reads the
   * most explicit stretch of a chat and answers with vague poses ("close to the viewer,
   * intimate") when it runs on a moderation-prone model — which is a grounding failure
   * before it is a moderation one, because the render then gets anatomy with no act. Owner
   * ruling 2026-08-10: move it to a less moderation-prone model, with the fixed session
   * narrative default as the approved refusal fallback (`composeSceneSpec`).
   *
   * The propose-then-verify architecture does not move with it: the registries still own
   * every explicit word, and `characterAppearanceSummary` still runs `allowIntimate:false`
   * for the composer, because exposure gating is code's job however bold the model is.
   */
  sceneComposer: DEFAULT_SCENE_COMPOSER_MODEL_ID,
  embedding: "openai/text-embedding-3-small",
  // Image UNDERSTANDING (portrait → attributes, character-sheet-forge.plan.md)
  // — the first vision-input capability; distinct from the Replicate image
  // GENERATION stack. Qwen3-VL 235B instruct: strong closed-vocabulary visual
  // extraction, cheap ($0.20/M prompt), no mandatory reasoning tokens.
  vision: "qwen/qwen3-vl-235b-a22b-instruct",
} as const;

export function isDemoMode(): boolean {
  return !process.env.OPENROUTER_API_KEY || process.env.AI_FAKE === "1";
}

/**
 * The upstream provider OpenRouter actually routed a generation to (e.g.
 * "DeepInfra", "Together"), read from the response's `providerMetadata`.
 * Returns null when the metadata is absent. Used for the Inspector's per-leg
 * provider attribution — correlate it with latency to spot slow providers.
 */
export function routedProvider(
  meta: ProviderMetadata | undefined,
): string | null {
  const provider = meta?.openrouter?.provider;
  return typeof provider === "string" ? provider : null;
}

/**
 * Per-model OpenRouter provider exclusions, keyed by model id. A base provider
 * slug (lowercase, e.g. "deepinfra") matches every endpoint/variant for that
 * provider.
 *
 * GLM 5.2: DeepInfra advertises a low latency but in practice streams it
 * incredibly slowly (~82s for three paragraphs of narration), so the
 * latency-sorted routing below keeps landing on it. Drop it from the candidate
 * set for that model — `allow_fallbacks` stays on, so this only narrows the
 * pool, never a reliability loss.
 */
const PROVIDER_IGNORE: Readonly<Record<string, readonly string[]>> = {
  "z-ai/glm-5.2": ["deepinfra"],
};

/**
 * Per-model OpenRouter provider **preference order**, keyed by model id. Entries are
 * `provider/quantization` tags, tried left to right before OpenRouter's own choice.
 *
 * Why this exists at all: OpenRouter prices a model slug by its cheapest endpoint but
 * routes an unconstrained call by its own blend of price, latency and uptime. For
 * `deepseek-v4-flash-0731` that difference is a factor of two — an unrouted probe landed
 * on CoreWeave at $0.13/$0.28 per M when endpoints at $0.07/$0.14 were up. The composer
 * runs on every scene image, so that gap is the whole cost case for moving off Aion 3.0.
 *
 * The list is **fp8-or-better on purpose.** Two endpoints undercut these by ~2%
 * (Decart, OpenInference) and both serve fp4; the composer's entire output is a
 * structured object that has to parse, this repo already refused provider-side
 * constrained decoding because models degenerate under it (followups.phase2.md #20), and
 * 2% is not worth spending on the most aggressive quantization on the board. US-hosted
 * endpoints are preferred over the two marginally cheaper CN-hosted ones (StreamLake,
 * Baidu) for the same reason: the saving is ~2% and the composer is handed the most
 * explicit stretch of a conversation. Neither exclusion is a capability judgement —
 * both would serve the model fine.
 *
 * `allow_fallbacks` stays ON. If every listed endpoint is down, a pricier DeepSeek
 * endpoint is still far better than what the alternative actually is: the composer
 * ladder degrading to its Aion 2.0 refusal rung at ~20× the token price.
 */
const PROVIDER_ORDER: Readonly<Record<string, readonly string[]>> = {
  "deepseek/deepseek-v4-flash-0731": ["gmicloud/fp8", "deepinfra/fp8"],
};

/** OpenRouter `provider` routing block (the subset of knobs we set), shaped as a JSON object for `providerOptions`. */
export type OpenRouterRouting = Record<string, JSONValue>;

/**
 * Per-model narrator `reasoning` knob, keyed by model id. Ruled from the behavioral
 * eval (narrator-prompt-focus.eval-results.md, Run 2 — the pairwise re-judge, 2026-06-29):
 *
 * - **Aion 2.0** (session default) → `effort:"low"`: Run 2 ranked it 67% vs 33% for
 *   default — it suppresses the residual "hi"-beat doting/errand-invention at no quality
 *   cost. (`enabled:false` stays **off the table** — the AionLabs endpoint rejects it,
 *   "Reasoning is mandatory for this endpoint"; all 12 `off` eval cells died.)
 * - **GLM 5.2** (chat default) → `effort:"low"`: Run 2's sharper read put `low` first
 *   (Borda 61%), default a close second, `off` worst. (`off` is the deterministic *latency*
 *   win — sub-500ms TTFT — if chat first-token latency ever outranks the marginal quality.)
 *
 * Applies to BOTH lanes (session + chat) since both build options here, so a model gets
 * its knob wherever it narrates. Models not listed send no reasoning option (model default).
 */
const NARRATOR_REASONING: Readonly<Record<string, JSONValue>> = {
  "aion-labs/aion-2.0": { effort: "low" },
  // Aion 3.0 is DELIBERATELY absent (reverted 2026-07-09, data-loss-rerun incident). Its
  // provisional `effort:"low"` was un-evaled and carried over from 2.0 by family
  // resemblance, and it is a suspect in the chat-lane hang that wedged the exchange lock.
  // Do NOT re-add a reasoning knob for Aion 3.0 without first verifying the model actually
  // accepts the reasoning param (a rejected/ignored knob can stall the stream) and running
  // its own behavioral eval — until then it sends the model default (no reasoning option).
  "z-ai/glm-5.2": { effort: "low" },
};

/**
 * Build the OpenRouter `provider` routing block for a model: latency-sorted when
 * `sortLatency` is set, plus any per-model exclusions from PROVIDER_IGNORE.
 * Returns undefined when neither knob applies, so callers can omit `provider`
 * entirely rather than send an empty object.
 */
export function providerRouting(
  modelId: string,
  opts: { sortLatency?: boolean } = {},
): OpenRouterRouting | undefined {
  // Endpoint selection among OpenRouter's upstreams is meaningless off OpenRouter.
  if (narrativeModelProvider(modelId) !== "openrouter") return undefined;
  const routing: OpenRouterRouting = {};
  if (opts.sortLatency) routing.sort = "latency";
  const ignore = PROVIDER_IGNORE[modelId];
  if (ignore && ignore.length > 0) routing.ignore = [...ignore];
  const order = PROVIDER_ORDER[modelId];
  if (order && order.length > 0) {
    routing.order = [...order];
    // Explicit rather than relying on the API default: a preference that silently became
    // a restriction would turn a cheap-routing tweak into an outage the day both
    // endpoints are down.
    routing.allow_fallbacks = true;
  }
  return Object.keys(routing).length > 0 ? routing : undefined;
}

/**
 * The full `providerOptions.openrouter` block for a **narrator** generation — the
 * session turn stream (pipeline.ts) and the character-chat stream
 * (engine/character-chat.ts) both build their provider options here, so the two
 * lanes never drift. Wraps latency routing + per-model provider exclusions
 * (providerRouting) and the per-model reasoning knob (NARRATOR_REASONING) in the
 * `openrouter` envelope. Returns undefined when nothing applies, so callers can omit
 * `providerOptions` entirely rather than send an empty object.
 *
 * The reasoning knob is per-model and eval-ruled (NARRATOR_REASONING above — Aion
 * `effort:low`, GLM `effort:low`). Note `effort:"minimal"` was a
 * no-op on Aion in a 2026-06-21 probe; the 2026-06-28 behavioral eval (Run 2) measured
 * *output* rather than reasoning-token usage and found `effort:"low"` a positive signal.
 */
export function narrativeProviderOptions(
  modelId: string,
  opts: { sortLatency?: boolean } = {},
): { openrouter: Record<string, JSONValue> } | undefined {
  // A non-OpenRouter narrator gets NO options block: both knobs below are
  // OpenRouter API surface, and every id in NARRATOR_REASONING/PROVIDER_* is an
  // OpenRouter slug, so there is nothing here another vendor could want.
  if (narrativeModelProvider(modelId) !== "openrouter") return undefined;
  const openrouter: Record<string, JSONValue> = {};
  const provider = providerRouting(modelId, opts);
  if (provider) openrouter.provider = provider;
  const reasoning = NARRATOR_REASONING[modelId];
  if (reasoning) openrouter.reasoning = reasoning;
  return Object.keys(openrouter).length > 0 ? { openrouter } : undefined;
}

let cachedProvider: OpenRouterProvider | undefined;

export function openrouter(): OpenRouterProvider {
  cachedProvider ??= createOpenRouter({
    apiKey: process.env.OPENROUTER_API_KEY ?? "demo",
    headers: {
      "HTTP-Referer": "http://localhost:3200",
      "X-Title": "Vesper",
    },
  });
  return cachedProvider;
}

let cachedFeatherless: OpenAICompatibleProvider | undefined;

/**
 * Featherless — the second text provider, and **narrator-only** (see
 * lib/narrative-models.ts §"Which upstream serves a row"). It serves community
 * Hugging Face merges that no OpenRouter vendor hosts, over a plain
 * OpenAI-compatible `/v1/chat/completions`, so it needs no bespoke transport: the
 * generic `@ai-sdk/openai-compatible` provider is the whole integration.
 *
 * Nothing OpenRouter-shaped travels this path. `narrativeProviderOptions` and
 * `providerRouting` both return undefined for a Featherless id, because the
 * routing block, the provider ignore/order lists and the reasoning knob are all
 * OpenRouter API surface — a Featherless model reaching for one of them would be
 * asking a different vendor to honor a stranger's query string.
 */
export function featherless(): OpenAICompatibleProvider {
  cachedFeatherless ??= createOpenAICompatible({
    name: "featherless",
    baseURL: "https://api.featherless.ai/v1",
    apiKey: process.env.FEATHERLESS_API_TOKEN ?? "demo",
    transformRequestBody: featherlessRequestBody,
  });
  return cachedFeatherless;
}

/**
 * The exact id of the Fable Fusion 711 narrator, named once here because three
 * separate things key on it — its request policy below, the chat lane's hidden
 * empty retry, and the tests that prove no other model inherits either. A curated
 * row's id is a persisted value, so a typo'd second spelling would silently mean
 * "policy off" rather than fail.
 */
export const FABLE_FUSION_711_ID = "DavidAU/Qwen3.6-27B-Fable-Fusion-711-Uncensored-Heretic-NM-DAU-MTP";

/**
 * Per-model **runtime request policy** for a Featherless narrator, keyed by exact model
 * id. Opt-in per model, never a blanket flag — the same rule the OpenRouter reasoning
 * knobs above follow, and for the same reason: a model that does not use a thinking
 * template gains nothing from the flag, and one whose template spells it differently
 * would ignore it just as quietly.
 *
 * Runtime policy lives HERE, in the provider layer, and not on the narrator list
 * (`lib/narrative-models.ts`). That list is the UI's option registry and is pure; the
 * transport is where a call's shape is decided, and keeping the two apart is what lets a
 * row be relabelled or reordered without touching how it is asked.
 */
interface FeatherlessModelPolicy {
  /**
   * Ask with the chat template's thinking mode OFF.
   *
   * This is not a preference. A thinking narrator is unusable in the chat lane on two
   * independent counts, both measured against the live endpoint:
   *
   * - **It blows the first-token budget.** The chain runs ~1,300 tokens before any prose,
   *   which put the first visible token at ~61s — past `CHAT_STREAM_FIRST_TOKEN_MS` (50s),
   *   a ceiling that cannot be raised because it sits under Fly's ~60s proxy idle timeout.
   * - **It eats the whole reply.** Asked with a bounded output budget the model spent all
   *   of it thinking and returned an EMPTY reply with `finish_reason: "length"`. Not slow
   *   prose — no prose. Re-reproduced 2026-08-17 on a 34-token prompt with
   *   `max_tokens: 300`: `finish_reason "length"`, 298 completion tokens, **zero**
   *   characters of content, ~1,080 characters of reasoning.
   *
   * Only `chat_template_kwargs` works. `reasoning_effort: "none"` and a `/no_think` token
   * in the prompt were both probed on this model and both silently ignored, still producing
   * a full chain and no prose — which is why this rides `transformRequestBody` rather than
   * the transport's own `reasoningEffort` option.
   *
   * **One key, not three.** Featherless documents `enable_thinking`, `thinking` and
   * `do_reasoning` as normalized synonyms with `false` winning any conflict, and all three
   * were probed independently on this exact model on 2026-08-17: each alone produced
   * `finish_reason "stop"`, prose, and zero reasoning. One confirmed-sufficient key is
   * therefore what is sent; sending the other two would be redundancy against a hazard
   * the evidence says does not exist.
   */
  thinkingOff?: boolean;
  /**
   * Exact-model sampler baseline, merged over whatever the call site set. Sent as raw
   * OpenAI-compatible body fields because two of them have no AI SDK equivalent: the
   * transport drops `topK` with an "unsupported" warning, and `repetition_penalty` is not
   * in the standard call settings at all.
   */
  sampler?: Readonly<Record<string, number>>;
  /**
   * This model earns the chat lane's ONE hidden retry for a zero-visible-text completion
   * (`streamCharacterChat`). Exact-model, because the retry is only defensible where a
   * known-intermittent empty has been measured — every other narrator keeps today's
   * behaviour of surfacing the empty reply immediately.
   */
  hiddenEmptyRetry?: boolean;
  /**
   * Minimum generated tokens on the hidden retry ONLY, and only when the first attempt was
   * a genuinely silent stop. Featherless accepts `min_tokens` (probed 2026-08-17). This is
   * deliberately not a global floor: a minimum response length applied to every narrator
   * call is how narrator padding gets resurrected.
   */
  retryMinTokens?: number;
}

const FEATHERLESS_MODEL_POLICY: Readonly<Record<string, FeatherlessModelPolicy>> = {
  [FABLE_FUSION_711_ID]: {
    thinkingOff: true,
    // The author's recommended non-thinking/instruct baseline for this merge, not a
    // Vesper-tuned guess. `NARRATIVE_TEMPERATURE` (0.85) is the repo default and stays
    // the default for every other narrator; this model asks for 0.7 with tight nucleus
    // and top-k, plus presence pressure, which is what its instruct template expects.
    sampler: {
      temperature: 0.7,
      top_p: 0.8,
      top_k: 20,
      presence_penalty: 1.5,
      repetition_penalty: 1.0,
    },
    hiddenEmptyRetry: true,
    retryMinTokens: 48,
  },
};

/**
 * The Featherless request-body hook: applies the exact-model policy above and changes
 * nothing for any other model. Reads the id off the outgoing body rather than taking it as
 * an argument, because the transport builds one client for every model.
 *
 * Riding the transport rather than the call sites is what gives the successor narrator
 * parity for free: `streamCharacterChat` and `generateChecked` both reach Featherless
 * through `textModel`, so a policy applied here is applied to both, and neither call site
 * has to learn a model's name. Nothing else routes here — the narrator list is the only
 * model list that may name a provider, so no agent, composer, embedding or vision call can
 * reach this function at all.
 *
 * Exported for its test. It is the only place a Featherless call's shape is decided, and
 * the difference between the branches is the difference between a narrator that answers in
 * about a second and one that returns nothing at all — worth asserting directly rather
 * than through a network round-trip.
 */
export function featherlessRequestBody(body: Record<string, unknown>): Record<string, unknown> {
  const modelId = typeof body.model === "string" ? body.model : "";
  const policy = FEATHERLESS_MODEL_POLICY[modelId];
  if (!policy) return body;
  return {
    ...body,
    ...(policy.sampler ?? {}),
    ...(policy.thinkingOff ? { chat_template_kwargs: { enable_thinking: false } } : {}),
  };
}

/**
 * Whether this narrator id earns the chat lane's one hidden retry for a
 * zero-visible-text completion. False for every model without an explicit
 * `hiddenEmptyRetry` policy entry — including every OpenRouter narrator and any other
 * Featherless row — so the retry can never spread by default.
 */
export function narratorHiddenRetryModel(modelId: string): boolean {
  return FEATHERLESS_MODEL_POLICY[modelId]?.hiddenEmptyRetry === true;
}

/**
 * The provider options for the hidden retry's minimum-generation floor, or undefined when
 * this model has no floor configured. `@ai-sdk/openai-compatible` spreads
 * `providerOptions.featherless` into the request body verbatim, which is what scopes
 * `min_tokens` to this ONE call instead of the transport-wide `transformRequestBody`
 * policy above.
 *
 * Only ever called for a retry that follows a genuinely silent stop
 * (`narratorEmptyWasSilentStop`) — see the field doc for why a length/reasoning empty must
 * not get a floor.
 */
export function narratorRetryFloorOptions(
  modelId: string,
): { featherless: Record<string, JSONValue> } | undefined {
  const minTokens = FEATHERLESS_MODEL_POLICY[modelId]?.retryMinTokens;
  return minTokens === undefined ? undefined : { featherless: { min_tokens: minTokens } };
}

/** True when a Featherless credential is configured — the gate on selecting a Featherless narrator. */
export function hasFeatherless(): boolean {
  return Boolean(process.env.FEATHERLESS_API_TOKEN?.trim());
}

/**
 * What both transports hand back for a chat model: the `ai` package's model-spec
 * type, with the bare-model-id string excluded. `LanguageModel` itself is that
 * union, and returning it would make every property access on a `textModel` result
 * look unsafe when the function always builds an object. Excluding the string here
 * rather than naming either provider's concrete class is also what lets the two
 * transports share one return type.
 */
type ChatLanguageModel = Exclude<LanguageModel, string>;

/**
 * The chat model for an already-resolved model id, pointed at whichever
 * upstream serves it. Every text generation in the app goes through here rather
 * than reaching for a provider directly, so a narrator id can name a second vendor
 * without each call site learning about providers.
 *
 * The id must already have been through a resolver (`narrativeModelId`,
 * `chatNarrativeModelId`, `agentModelId`, `sceneComposerModelId`): this function
 * routes, it does not curate, and an unknown id routes to OpenRouter.
 */
export function textModel(modelId: string): ChatLanguageModel {
  return narrativeModelProvider(modelId) === "featherless"
    ? featherless().chatModel(modelId)
    : openrouter().chat(modelId);
}

// Text-model selection is **code or UI only** — there is no env override layer.
// The narrator + in-session agent models come from the curated code defaults
// (lib/narrative-models.ts, lib/agent-models.ts) or a per-world UI choice (world
// creation + World tab); embeddings + the tool model default purely in code. A
// retired/typo'd env value can no longer silently shadow these (it once pinned the
// agent model to the pulled `openrouter/owl-alpha` stealth slug).
//
// Both resolvers are STRICT (codebase-review B3): a stored/over-the-wire id must be
// on its curated list, else it coerces to the default with a warning. Without this,
// any authenticated user could bill arbitrary OpenRouter slugs (frontier-priced
// models included) to the deployment's key via a world/character PATCH or the chat
// POST — the doc comments always claimed "a curated id"; now it's enforced at the
// one seam every call site already goes through.

/** True when `id` is on the curated list. */
function curated(list: readonly { id: string }[], id: string): boolean {
  return list.some((option) => option.id === id);
}

function resolveCurated(list: readonly { id: string }[], requested: string | null | undefined, fallback: string, scope: string): string {
  const id = requested?.trim();
  if (!id) return fallback;
  if (curated(list, id)) return id;
  log.warn(scope, "uncurated model id coerced to the default", { requested: id, fallback });
  return fallback;
}

/**
 * Second gate after curation, for narrator ids only: a curated model whose provider
 * has **no configured key** coerces to `fallback` with a diagnostic, rather than
 * spending the turn on a guaranteed 401.
 *
 * Curation and this check are deliberately separate. A dropped row is a stale
 * *choice* and coerces permanently; a missing token is a stale *deployment* — the
 * pick stays valid and stored, and setting the secret restores it without the
 * player re-choosing. Only Featherless can fail here: OpenRouter's absence is
 * demo mode (`isDemoMode`), which every generation path already branches on.
 */
function providerBackedNarrator(modelId: string, fallback: string, scope: string): string {
  if (narrativeModelProvider(modelId) !== "featherless" || hasFeatherless()) return modelId;
  log.warn(scope, "narrator provider has no configured key; coerced to the default", {
    requested: modelId,
    provider: "featherless",
    fallback,
  });
  return fallback;
}

export function narrativeModelId(worldModel?: string | null): string {
  const id = resolveCurated(NARRATIVE_MODELS, worldModel, MODEL_DEFAULTS.narrative, "ai.narrative_model");
  return providerBackedNarrator(id, MODEL_DEFAULTS.narrative, "ai.narrative_model");
}

/**
 * The **character-chat / successor** narrator resolver: `resolveChatModelId`'s
 * curation (a known id passes, anything else takes the chat default) plus the
 * provider-key gate above. The server-side counterpart to the pure lib function —
 * a lane that resolves a stored pick into a real generation calls this one, so a
 * Featherless row can never reach a provider on a deployment that cannot pay for it.
 */
export function chatNarrativeModelId(requested?: string | null): string {
  return providerBackedNarrator(
    resolveChatModelId(requested),
    DEFAULT_CHARACTER_CHAT_MODEL_ID,
    "ai.chat_narrative_model",
  );
}

export function stateModelId(): string {
  return MODEL_DEFAULTS.state;
}

export function toolModelId(): string {
  return MODEL_DEFAULTS.tool;
}

/**
 * The scene composer's model — its own seam, not the tool default (see
 * MODEL_DEFAULTS.sceneComposer). `chatComposerModel` is the per-conversation admin
 * override (`character_chats.scene_composer_model`); empty/unknown ⇒ the curated default.
 *
 * STRICT like the other two resolvers, and for the same reason: this id reaches
 * `openrouter().chat()` on the deployment's key, so an uncurated value must never survive
 * the trip from a chat row to a billed generation.
 */
export function sceneComposerModelId(chatComposerModel?: string | null): string {
  return resolveCurated(
    SCENE_COMPOSER_MODELS,
    chatComposerModel,
    MODEL_DEFAULTS.sceneComposer,
    "ai.scene_composer_model",
  );
}

/**
 * Composer models that are asked with `reasoning:{enabled:false}` — the winning A/B
 * arm's call configuration, not a preference.
 *
 * The composer's job is a short structured extraction over a transcript, so a reasoning
 * trace is latency and tokens nobody reads. The `dsflash-off` arm scored level with the
 * `dsflash-low` arm's +1% at roughly a third of its latency, and the owner took the
 * time over the point (2026-08-15).
 *
 * **Opt-in per model, never a blanket flag**, because the option is not universally
 * accepted: the AionLabs endpoints REJECT it outright ("Reasoning is mandatory for this
 * endpoint" — it killed all 12 `off` cells of the narrator eval), and Aion 2.0 is both a
 * curated composer option and the ladder's refusal rung. A model absent from this set
 * sends no reasoning option at all, which is exactly how it was measured.
 */
const COMPOSER_REASONING_OFF: ReadonlySet<string> = new Set([
  "deepseek/deepseek-v4-flash-0731",
  "~deepseek/deepseek-v4-flash-latest",
]);

/**
 * Whether this composer model is asked with reasoning disabled. Applied per RUNG by
 * `composeSceneSpec`: the primary and the refusal fallback resolve independently, so a
 * DeepSeek primary can run reasoning-off while its Aion 2.0 rung — which would reject
 * the option — is asked without it.
 */
export function composerDisablesReasoning(modelId: string): boolean {
  return COMPOSER_REASONING_OFF.has(modelId);
}

/**
 * Resolver for the **in-session, non-narrator text agents** (intake + the four
 * post-turn agents): the world's per-session override (set from the World tab),
 * else the curated default (lib/agent-models.ts). The authoring agents and the
 * image pipeline deliberately do NOT call this — they stay on the plain
 * `stateModelId`/`toolModelId` defaults, outside the session switch.
 */
/**
 * The composer ladder's SECOND rung — the approved refusal fallback
 * (`composeSceneSpec`): a model already trusted with this repo's most explicit text,
 * asked once when the primary degrades.
 *
 * It is `narrativeModelId()` (the session narrator, Aion 2.0) except when that IS the
 * primary — which the per-chat override made reachable, since Aion 2.0 is a curated
 * composer option. Asking the same model twice is not a fallback, it is a retry of a
 * refusal, so the ladder falls back to the curated composer default instead. The one
 * invariant every caller depends on: **the two rungs are never the same id.**
 */
export function composerFallbackModelId(primaryModelId: string): string {
  const narrative = narrativeModelId();
  if (narrative !== primaryModelId) return narrative;
  // The narrator IS the primary. Prefer the curated composer default; if that collides
  // too (only reachable by setting both defaults to one id), take the first curated
  // composer option that differs — the invariant matters more than the preference order.
  if (MODEL_DEFAULTS.sceneComposer !== primaryModelId) return MODEL_DEFAULTS.sceneComposer;
  return SCENE_COMPOSER_MODELS.find((option) => option.id !== primaryModelId)?.id ?? primaryModelId;
}

export function agentModelId(worldAgentModel?: string | null): string {
  return resolveCurated(AGENT_MODELS, worldAgentModel, MODEL_DEFAULTS.state, "ai.agent_model");
}

export function embeddingModelId(): string {
  return MODEL_DEFAULTS.embedding;
}

/** The vision (image-understanding) model — code default only, no override layer. */
export function visionModelId(): string {
  return MODEL_DEFAULTS.vision;
}
