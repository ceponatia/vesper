/**
 * Curated narrator model options (phase-2 T5 ruling): one pure list shared by
 * the client dropdown (components/play/world-tab.tsx) and the server's
 * narrativeModelId resolver default (server/ai/provider.ts). The planned BYOK
 * feature replaces this static list with a live-queried catalog; until then,
 * adding a narrator is one entry here.
 *
 * ## Which upstream serves a row
 *
 * Most ids are OpenRouter model slugs (`vendor/model`) and carry no `provider`
 * field. A row that names a different upstream sets one, and the model gateway
 * (`server/ai/provider.ts` → `textModel`) routes on it. **Only the narrator list
 * is multi-provider** — agents, the scene composer, embeddings, and vision stay
 * OpenRouter-only, because narration is the one leg whose quality justifies a
 * second key.
 *
 * A 2026-08-17 probe rejected three candidate second providers on measurements:
 * Civitai's LLM route is an OpenRouter proxy in disguise (it answers
 * `sao10k/l3.3-euryale-70b` with an OpenRouter `gen-…` id while its own
 * `urn:air:` models 500); Replicate's RP deployments are raw-prompt llama.cpp
 * cogs that measured 31s of prefill on a 12K-token prompt on top of a ~57s cold
 * boot; and the Hugging Face merges are weights rather than endpoints, with HF's
 * router serving only 8K-context Llama-3 8Bs — smaller than this app's ~9K-token
 * narrator system prompt. Featherless (below) is the one that passed, and it is
 * why `provider` exists at all.
 */

/** The upstream that serves a narrator id. Absent on an option ⇒ `"openrouter"`. */
export type NarrativeModelProvider = "openrouter" | "featherless";

export interface NarrativeModelOption {
  /**
   * The model id as its own upstream spells it — an OpenRouter slug
   * ("aion-labs/aion-2.0") or a Featherless/Hugging Face repo path
   * ("DavidAU/Qwen3.6-…"). Persisted verbatim on chats and characters, so it is
   * also the id the resolvers curate against; ids are unique across providers
   * (`narrative-models.test.ts` enforces it), which is what lets one id name one
   * upstream without a prefix.
   */
  id: string;
  /** Human label for the dropdown. */
  label: string;
  /** Which upstream serves {@link id}. Omit for OpenRouter — the default for every legacy row. */
  provider?: NarrativeModelProvider;
}

export const NARRATIVE_MODELS: readonly NarrativeModelOption[] = [
  // ## The proven rows — the two lane defaults and the frontier/general models
  // that have carried narration to date. Order matters only here: the defaults
  // sit first so the dropdown opens on familiar ground.
  { id: "aion-labs/aion-2.0", label: "Aion 2.0" },
  // Aion 3.0 additionally advertises OpenRouter `tools`/`tool_choice` +
  // `response_format` — a candidate tool/agent model to test later (see
  // docs/getting-started.md §Environment "Tool-model candidate").
  { id: "aion-labs/aion-3.0", label: "Aion 3.0" },
  { id: "aion-labs/aion-3.0-mini", label: "Aion 3.0 Mini" },
  { id: "~deepseek/deepseek-v4-flash-latest", label: "DeepSeek 4 Flash" },
  { id: "z-ai/glm-5.2", label: "GLM 5.2" },
  { id: "google/gemini-3.5-flash", label: "Gemini 3.5 Flash" },
  // Owner ask, 2026-07-21 (engine.rollout.plan.md ruling 4's side note).
  { id: "x-ai/grok-4.5", label: "Grok 4.5" },

  // ## The RP/low-refusal test bench (added 2026-08-17)
  //
  // Community narration fine-tunes, one per lane rather than several per family,
  // so a comparison run varies the thing being tested instead of the checkpoint.
  // Every row is a hosted OpenRouter slug — no new provider, key or transport.
  // None is proven on this repo's prompt yet; promotion to either default needs a
  // recorded verdict the way the composer's did.
  //
  // A `(32K)` label marks the rows whose context window is the binding constraint
  // rather than a comfortable ceiling: the built narrator system prompt alone runs
  // ~9K tokens, and the chat lane adds CHARACTER_CHAT_HISTORY_TURNS (40) exchanges
  // of verbatim history on top. Typical chats land near 17K, so these hold — but a
  // verbose long-running chat can overflow them, which the unmarked 65K–1M rows
  // will not.

  // Large RP specialists. Euryale is the strongest established creative-roleplay
  // line; both versions are listed because v2.2→v2.3 is a genuine A/B (different
  // Llama base, different unalignment mix) rather than a strict upgrade.
  { id: "sao10k/l3.3-euryale-70b", label: "Euryale 70B (L3.3)" },
  { id: "sao10k/l3.1-euryale-70b", label: "Euryale 70B (L3.1)" },
  // Prose specialist: Qwen2.5-72B tuned specifically to imitate Claude Sonnet/Opus
  // prose. The most expensive row on the bench ($3/$5 per M) — sample it, don't
  // soak it.
  { id: "anthracite-org/magnum-v4-72b", label: "Magnum v4 72B (32K)" },

  // Mid-size uncensored RP — the size class most likely to win on cost×quality if
  // the simulation layer really is doing the thinking for the narrator.
  { id: "thedrummer/cydonia-24b-v4.1", label: "Cydonia 24B" },
  { id: "thedrummer/skyfall-36b-v2", label: "Skyfall 36B (32K)" },
  // Explicitly anti-"slop" tuning — the repetition/stock-phrase axis ("a shiver
  // runs down…", "the air is thick…") that a long chat exposes worst.
  { id: "thedrummer/unslopnemo-12b", label: "UnslopNemo 12B" },
  { id: "thedrummer/rocinante-12b", label: "Rocinante 12B" },

  // Low-refusal control. Dolphin lineage on Mistral Small 24B: permissive without
  // being RP-tuned, so it separates "refuses less" from "narrates better".
  { id: "cognitivecomputations/dolphin-mistral-24b-venice-edition", label: "Venice Uncensored 24B" },
  // Small RP specialist, same lab as the current defaults. Tops the character
  // portion of RPBench-Auto; the 8B rung of the "does size matter here?" question.
  { id: "aion-labs/aion-rp-llama-3.1-8b", label: "Aion-RP 8B (32K)" },
  // Instruction-obedience control, and the cheapest capable row on the bench
  // ($0.13/$0.40 per M). Not narration-tuned on purpose: it measures how much of
  // the result is the fine-tune versus Vesper's own prompt and state contract.
  { id: "nousresearch/hermes-4-70b", label: "Hermes 4 70B" },
  // Modern dialogue-first RP model on a non-Llama, non-Mistral backbone — the
  // architectural outlier that keeps the bench from being one family in wigs.
  { id: "minimax/minimax-m2-her", label: "MiniMax M2-her" },

  // ## Featherless rows (added 2026-08-17) — served by FEATHERLESS_API_TOKEN
  //
  // Featherless serves community Hugging Face merges that no OpenRouter vendor
  // hosts, over an OpenAI-compatible endpoint. Measured on this account before the
  // row was added: the model is on-plan, streams `[Name]` speaker tags correctly,
  // and returns coherent scene prose. Two operational facts a picker should know:
  //
  // - **It is a thinking model, asked with thinking OFF, on its author's sampler
  //   baseline.** Left alone it spends ~1,300 tokens of chain before any prose — which
  //   misses the chat lane's first-token budget AND, under a bounded output budget,
  //   returns an empty reply. `FEATHERLESS_MODEL_POLICY` in server/ai/provider.ts
  //   suppresses the chain and applies the merge's recommended non-thinking sampling
  //   (temp 0.7 / top-p 0.8 / top-k 20 / presence 1.5), after which warm calls measure
  //   0.7–2.8s to first token and 2–5s to a full reply. Removing that entry makes this
  //   row unusable, not merely slower. It is the ONE bench row with a sampler profile;
  //   a comparison including it must read those settings as part of the arm.
  // - **It cold-starts.** The first call to an idle model fails while Featherless loads
  //   the weights (503 `capacity_exhausted`, or an error frame on a 200). It surfaces
  //   after ~14s as a `provider_error` reply failure quoting the vendor's "temporarily
  //   at capacity" wording; the next send usually lands on a warm model. It is NOT an
  //   empty reply, and the one hidden retry below deliberately does not cover it.
  // - **It gets one hidden retry for a zero-text reply.** Exact-model, and only when
  //   nothing reached the player (`narratorHiddenRetryModel`). No other narrator has it.
  //
  // `(32K)` is the usual context marker; see the note above the RP bench for what
  // it binds.
  {
    id: "DavidAU/Qwen3.6-27B-Fable-Fusion-711-Uncensored-Heretic-NM-DAU-MTP",
    label: "Fable Fusion 27B (32K)",
    provider: "featherless",
  },
];

/**
 * Which upstream serves `id` — the one place the routing decision is read, by the
 * model gateway (`textModel`) and by the provider-options guards that must not send
 * an OpenRouter routing block to a non-OpenRouter endpoint.
 *
 * An id that is not on the list answers `"openrouter"`. That is the safe default
 * rather than a gap: the resolvers coerce an uncurated id to a curated default
 * before it can reach a provider, so the only callers that can reach here with an
 * unknown id are ones already holding an OpenRouter slug.
 */
export function narrativeModelProvider(id: string): NarrativeModelProvider {
  return NARRATIVE_MODELS.find((option) => option.id === id)?.provider ?? "openrouter";
}

/** The narrator used when neither the world nor the env override one. */
export const DEFAULT_NARRATIVE_MODEL_ID = "aion-labs/aion-2.0";

/**
 * The narrator the **character-chat** tab defaults to (the Chat-tab model
 * dropdown's initial value). Kept separate from the session narrator default
 * above so the two surfaces can diverge: chat runs Aion 3.0 (owner ruling
 * 2026-07-10, replacing GLM 5.2), while sessions stay on Aion 2.0. Must be an
 * id in {@link NARRATIVE_MODELS} so the dropdown shows it selected.
 */
export const DEFAULT_CHARACTER_CHAT_MODEL_ID = "aion-labs/aion-3.0";

/**
 * Resolve a persisted/over-the-wire character-chat model id to a curated one: a
 * known {@link NARRATIVE_MODELS} id passes through, while an empty or unrecognised
 * value (no saved pick, or an id dropped from the registry) falls back to
 * {@link DEFAULT_CHARACTER_CHAT_MODEL_ID}. Keeps the chat dropdown's `value` always
 * matching a real option and never streams a blank model to the server.
 */
export function resolveChatModelId(id: string | null | undefined): string {
  return id && NARRATIVE_MODELS.some((option) => option.id === id) ? id : DEFAULT_CHARACTER_CHAT_MODEL_ID;
}
