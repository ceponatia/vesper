import { streamText, type ModelMessage } from "ai";
import {
  collapseRepeatedBlocksStream,
  isDemoMode,
  narrativeModelId,
  narrativeProviderOptions,
  openrouter,
  stripNarratorArtifactStream,
} from "../ai";
import { CHARACTER_CHAT_HISTORY_TURNS } from "./constants";
import { NARRATIVE_TEMPERATURE } from "./pipeline";

/**
 * The character-chat model stream (docs/character-chat/pipeline.md): the narrator leg of
 * the chat lane. Mirrors pipeline.liveNarrativeStream — the same `streamText` +
 * `openrouter().chat()` shape (the `@openrouter`-only boundary is satisfied via
 * the `../ai` barrel exactly as the pipeline does). This file only streams: the
 * exchange orchestration (state, RAG recall, persistence, the post-turn fan-out)
 * lives in `chat-pipeline.ts`; this stream's short-term memory is the verbatim
 * window it is handed (the rolling summary + RAG recall ride in the system
 * prompt).
 */

export interface ChatTurn {
  role: "user" | "assistant";
  content: string;
  /**
   * The line was authored in NARRATOR mode (chat-supporting-cast.plan.md §Narrator
   * input, user lines only): story narration from the player as storyteller. The
   * pipeline wraps such lines with `wrapNarratorInput` at the model boundary — the
   * stored transcript stays byte-verbatim.
   */
  narrator?: boolean;
}

export interface StreamCharacterChatInput {
  /** The focused system prompt (engine/prompts/character-chat.ts). */
  system: string;
  /** The full transcript so far, oldest first; trimmed to the window here. */
  history: ChatTurn[];
  /** Character display name — only used to tag the demo-mode placeholder line. */
  name: string;
  /** Narrator model override (a curated NARRATIVE_MODELS id); falls back to the default. */
  model?: string | null;
  /** Player Stop (spec §4.2): aborting cuts the stream; the caller keeps the accumulated prefix. */
  signal?: AbortSignal;
}

/** Keep only the most recent CHARACTER_CHAT_HISTORY_TURNS exchanges (≈2 messages each). */
export function windowChatHistory(history: readonly ChatTurn[]): ChatTurn[] {
  return history.slice(-CHARACTER_CHAT_HISTORY_TURNS * 2);
}

/**
 * Stream the character's reply token by token. In demo mode (no API key) it
 * yields a deterministic in-character placeholder so the tab and tests work
 * without provider access — the same degradation philosophy as demoNarrative.
 */
export async function* streamCharacterChat(input: StreamCharacterChatInput): AsyncGenerator<string> {
  const windowed = windowChatHistory(input.history);
  if (isDemoMode()) {
    yield* demoChatReply(input.name, windowed.at(-1)?.content ?? "");
    return;
  }
  const messages: ModelMessage[] = windowed.map((m) => ({ role: m.role, content: m.content }));
  const modelId = narrativeModelId(input.model);
  // Same provider options as the session narrator (server/ai/provider.ts): drop
  // per-model bad endpoints (DeepInfra on GLM 5.2) and apply the eval-ruled per-model
  // reasoning knob (the chat default GLM 5.2 → effort:low); undefined for plain models.
  const result = streamText({
    model: openrouter().chat(modelId),
    system: input.system,
    messages,
    temperature: NARRATIVE_TEMPERATURE,
    providerOptions: narrativeProviderOptions(modelId),
    abortSignal: input.signal,
  });
  // Strip the Aion "uncensored response" wrapper tags that leak into the stream
  // (server/ai/narrator-artifacts.ts), then collapse Aion tandem-repeat blocks
  // (server/ai/narrator-repeats.ts) — both clean the live feed AND, because the
  // route persists the accumulated deltas, the stored reply + history. Tag
  // stripping runs first so a leaked tag can't break the verbatim repeat match.
  yield* collapseRepeatedBlocksStream(stripNarratorArtifactStream(result.textStream));
}

/** Deterministic placeholder for demo mode — tagged like a real narrator line. */
function* demoChatReply(name: string, lastUserMessage: string): Generator<string> {
  const who = name.trim() || "Character";
  const echo = lastUserMessage.trim().slice(0, 80);
  const line = echo
    ? `[${who}] "You said: ${echo}. (Demo mode — set OPENROUTER_API_KEY for a real reply.)"`
    : `[${who}] "Hello. (Demo mode — set OPENROUTER_API_KEY for a real reply.)"`;
  for (const word of line.split(" ")) yield `${word} `;
}
