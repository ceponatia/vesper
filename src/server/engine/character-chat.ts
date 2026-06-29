import { streamText, type ModelMessage } from "ai";
import { isDemoMode, narrativeModelId, narrativeProviderOptions, openrouter } from "../ai";
import { CHARACTER_CHAT_HISTORY_TURNS } from "./constants";
import { NARRATIVE_TEMPERATURE } from "./pipeline";

/**
 * The character-chat harness (docs/developer-notes/character-chat.plan.md):
 * streaming for the 1-on-1 Chat tab. Mirrors pipeline.liveNarrativeStream — the
 * same `streamText` + `openrouter().chat()` shape (the `@openrouter`-only
 * boundary is satisfied via the `../ai` barrel exactly as the pipeline does) —
 * but with no session, no post-turn pipeline, no persistence here (the route
 * owns the transcript). A flat message window is the model's only memory.
 */

export interface ChatTurn {
  role: "user" | "assistant";
  content: string;
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
  });
  for await (const delta of result.textStream) yield delta;
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
