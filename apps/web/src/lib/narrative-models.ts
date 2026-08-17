/**
 * Curated narrator model options (phase-2 T5 ruling): one pure list shared by
 * the client dropdown (components/play/world-tab.tsx) and the server's
 * narrativeModelId resolver default (server/ai/provider.ts). Ids are OpenRouter
 * model slugs (`vendor/model`). The planned BYOK feature replaces this static
 * list with a live-queried catalog; until then, adding a narrator is one entry
 * here.
 *
 * ## Why every id here is still an OpenRouter slug
 *
 * A second narrator provider was investigated on 2026-08-17 and rejected on
 * measurements, not preference — see `narrator-model-bench.spec.md` for the probe
 * transcript. In short:
 *
 * - **Civitai's LLM route is an OpenRouter proxy.** `/v1/chat/completions` on the
 *   orchestrator accepts our existing `CIVITAI_API_TOKEN` (401 without it), but it
 *   answers `sao10k/l3.3-euryale-70b` with an OpenRouter `gen-…` id, while its own
 *   `urn:air:` Civitai-hosted models 500. It is a slower path to this same list.
 * - **Replicate's RP deployments are too slow to narrate.** They work, but they are
 *   raw-prompt llama.cpp cogs: a 12K-token prompt measured 31s of prefill before
 *   the first token, then 41 tok/s, on top of a ~57s cold boot. The chat lane
 *   budgets its legs in seconds.
 * - **The Hugging Face merges are weights, not endpoints.** HF's router serves 2 of
 *   the ~30 candidates, and both are 8K-context Llama-3 8Bs — smaller than this
 *   app's ~9K-token narrator system prompt.
 *
 * The RP-tuned narrators that motivated that search turned out to be hosted on
 * OpenRouter already, which is why the bench below is a list edit and not a seam.
 */

export interface NarrativeModelOption {
  /** OpenRouter model id, e.g. "aion-labs/aion-2.0". */
  id: string;
  /** Human label for the dropdown. */
  label: string;
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
];

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
