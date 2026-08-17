import { streamText, type JSONValue, type ModelMessage } from "ai";
import type { ChatReplyFailureCode } from "@/contracts";
import {
  chatNarrativeModelId,
  classifyProviderError,
  collapseRepeatedBlocksStream,
  isDemoMode,
  narrativeProviderOptions,
  narratorEmptyRetryWorthwhile,
  narratorEmptyWasSilentStop,
  narratorHiddenRetryModel,
  narratorRetryFloorOptions,
  stripMisplacedSpeakerTagStream,
  stripNarratorArtifactStream,
  textModel,
  type NarratorCompletion,
  type SpeakerTagVocabulary,
} from "../ai";
import { narrativeModelProvider } from "@/lib/narrative-models";
import { CHARACTER_CHAT_HISTORY_TURNS, NARRATIVE_TEMPERATURE } from "./constants";

/**
 * The character-chat model stream (docs/character-chat/pipeline.md): the narrator leg of
 * the chat lane. Mirrors pipeline.liveNarrativeStream — the same `streamText` +
 * `textModel()` shape, which resolves the id to whichever upstream serves it (the
 * provider-construction boundary is satisfied via the `../ai` barrel exactly as the
 * pipeline does). This file only streams: the
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
  /**
   * The reply's name vocabulary (server/ai/narrator-speaker-tags.ts): `speakers`
   * is the roster the renderer accepts as a line-opening `[Name]` tag, `plain` the
   * names that are never a tag (the player, supporting cast). A known name wrapped
   * in brackets anywhere else — `"Nice to see you, [Brian]."` — is de-bracketed on
   * the way out, so the literal brackets reach neither the bubble nor the DB.
   */
  names: SpeakerTagVocabulary;
  /**
   * Narrator model override (a curated NARRATIVE_MODELS id); falls back to the chat
   * default. Resolved through `chatNarrativeModelId`, so an id whose provider has no
   * configured key falls back too rather than streaming a 401.
   */
  model?: string | null;
  /** Player Stop (spec §4.2): aborting cuts the stream; the caller keeps the accumulated prefix. */
  signal?: AbortSignal;
  /**
   * Called exactly once, when the stream finishes on its own, with how the upstream
   * generation ACTUALLY ended (`server/ai/narrator-completion.ts`) — finish reason,
   * token counts, and the raw-versus-visible text lengths. Counts and finish state
   * only; no prompt, prose or reasoning content travels in it.
   *
   * Not called when the stream is abandoned mid-flight — a player Stop or a watchdog
   * trip returns the generator early, and those paths own their own verdicts
   * (`resolveReplyFailure`) rather than needing a completion record.
   */
  onCompletion?: (completion: NarratorCompletion) => void;
}

/** Keep only the most recent CHARACTER_CHAT_HISTORY_TURNS exchanges (≈2 messages each). */
export function windowChatHistory(history: readonly ChatTurn[]): ChatTurn[] {
  return history.slice(-CHARACTER_CHAT_HISTORY_TURNS * 2);
}

/** What one raw model attempt reports about itself once its text stream runs out. */
interface RawAttemptOutcome {
  finishReason: string;
  rawFinishReason?: string;
  inputTokens?: number;
  outputTokens?: number;
  textTokens?: number;
  reasoningTokens?: number;
  /** Characters the AI SDK's `textStream` carried, before Vesper's normalizers. */
  rawTextLength: number;
  /** A provider failure the SDK reported through the stream instead of throwing. */
  providerError?: { code: ChatReplyFailureCode; detail: string };
}

/**
 * Stream the character's reply token by token. In demo mode (no API key) it
 * yields a deterministic in-character placeholder so the tab and tests work
 * without provider access — the same degradation philosophy as demoNarrative.
 *
 * ## The hidden retry
 *
 * One narrator model (`narratorHiddenRetryModel` — Fable Fusion 711) gets a SECOND
 * attempt when the first produced no visible text at all. This is safe precisely
 * because it is conditioned on zero emission: nothing reached the player, so the
 * retry cannot duplicate visible narration, and the player is spared a manual
 * "another take" for a failure they had no part in.
 *
 * The retry deliberately lives inside this generator rather than in the pipeline, so
 * it inherits the existing ownership rather than competing with it: the caller's
 * abort signal is the same one both attempts carry (a player Stop stops the retry),
 * and the first-token/overall watchdogs wrap this whole generator, so two attempts
 * share one budget instead of doubling it. An attempt that THROWS — auth, credit,
 * context window, network, or any provider exception — propagates immediately and is
 * never retried; only a clean, evidently-empty completion is.
 */
export async function* streamCharacterChat(input: StreamCharacterChatInput): AsyncGenerator<string> {
  const windowed = windowChatHistory(input.history);
  if (isDemoMode()) {
    yield* demoChatReply(input.name, windowed.at(-1)?.content ?? "");
    return;
  }
  const messages: ModelMessage[] = windowed.map((m) => ({ role: m.role, content: m.content }));
  const modelId = chatNarrativeModelId(input.model);
  const maxAttempts = narratorHiddenRetryModel(modelId) ? 2 : 1;

  let previous: NarratorCompletion | null = null;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    // Attempt 2 re-asserts the same authoritative prompt, history, model and
    // exact-model policy; its only difference is the minimum-generation floor, and
    // only when attempt 1 was a genuinely silent stop.
    const retryFloor =
      previous && narratorEmptyWasSilentStop(previous) ? narratorRetryFloorOptions(modelId) : undefined;
    const { stream, outcome } = narratorAttempt({
      modelId,
      system: input.system,
      messages,
      names: input.names,
      ...(input.signal === undefined ? {} : { signal: input.signal }),
      ...(retryFloor === undefined ? {} : { retryFloor }),
    });
    let visibleTextLength = 0;
    let visibleTextChars = 0;
    for await (const delta of stream) {
      visibleTextLength += delta.length;
      visibleTextChars += inkLength(delta);
      yield delta;
    }
    const raw = outcome();
    // No outcome means the raw stream never ran out — only reachable if a normalizer
    // stopped consuming early, which none of them do. Treat it as unknown rather than
    // inventing a finish reason.
    const completion: NarratorCompletion = {
      provider: narrativeModelProvider(modelId),
      modelId,
      finishReason: raw?.finishReason ?? "unknown",
      ...(raw?.rawFinishReason === undefined ? {} : { rawFinishReason: raw.rawFinishReason }),
      ...(raw?.inputTokens === undefined ? {} : { inputTokens: raw.inputTokens }),
      ...(raw?.outputTokens === undefined ? {} : { outputTokens: raw.outputTokens }),
      ...(raw?.textTokens === undefined ? {} : { textTokens: raw.textTokens }),
      ...(raw?.reasoningTokens === undefined ? {} : { reasoningTokens: raw.reasoningTokens }),
      ...(raw?.providerError === undefined ? {} : { providerError: raw.providerError }),
      rawTextLength: raw?.rawTextLength ?? 0,
      visibleTextLength,
      visibleTextChars,
      attempts: attempt,
    };
    const retryable =
      visibleTextChars === 0 &&
      attempt < maxAttempts &&
      !(input.signal?.aborted ?? false) &&
      narratorEmptyRetryWorthwhile(completion);
    if (!retryable) {
      input.onCompletion?.(completion);
      return;
    }
    previous = completion;
  }
}

/**
 * One model attempt: a generator of NORMALIZED deltas, plus a reader for how the raw
 * generation ended. The two halves are returned together because the metadata is only
 * knowable after the raw stream runs out, which happens inside the generator.
 *
 * The stream is consumed exactly ONCE. `result.textStream` feeds a counting tap, the
 * tap feeds the three normalizers, and the AI SDK's own finish promises are awaited
 * after the tap runs dry — they resolve off the already-consumed stream rather than
 * re-reading it.
 */
function narratorAttempt(args: {
  modelId: string;
  system: string;
  messages: ModelMessage[];
  names: SpeakerTagVocabulary;
  signal?: AbortSignal;
  /** Featherless `providerOptions` for the retry-only minimum-generation floor. */
  retryFloor?: { featherless: Record<string, JSONValue> };
}): { stream: AsyncGenerator<string>; outcome: () => RawAttemptOutcome | null } {
  let recorded: RawAttemptOutcome | null = null;
  // Same provider options as the session narrator (server/ai/provider.ts): drop
  // per-model bad endpoints (DeepInfra on GLM 5.2) and apply the eval-ruled per-model
  // reasoning knob (the chat default GLM 5.2 → effort:low); undefined for plain models.
  // A Featherless narrator gets no OpenRouter block at all — its exact-model policy
  // (sampler + thinking off) rides the transport's request-body hook instead — except
  // for the retry floor, which is per-call by nature.
  const openrouterOptions = narrativeProviderOptions(args.modelId);
  const providerOptions = { ...(openrouterOptions ?? {}), ...(args.retryFloor ?? {}) };
  // Not every provider failure throws. The AI SDK reports some — a Featherless cold
  // start's `503 capacity_exhausted` among them — as an error stream part, which ends
  // `textStream` cleanly with zero deltas and `finishReason: "error"`. Capturing it here
  // is what lets that reach the player as the provider failure it is instead of as an
  // unexplained empty reply, and it replaces the SDK's default console-logging handler.
  let providerError: { code: ChatReplyFailureCode; detail: string } | undefined;
  const result = streamText({
    model: textModel(args.modelId),
    system: args.system,
    messages: args.messages,
    temperature: NARRATIVE_TEMPERATURE,
    ...(Object.keys(providerOptions).length > 0 ? { providerOptions } : {}),
    abortSignal: args.signal,
    onError: ({ error }) => {
      const classified = classifyProviderError(error);
      providerError = { code: classified.code, detail: classified.detail };
    },
  });
  // Strip the Aion "uncensored response" wrapper tags that leak into the stream
  // (server/ai/narrator-artifacts.ts), de-bracket a name wrapped in `[…]` where a
  // speaker tag can't go (server/ai/narrator-speaker-tags.ts), then collapse Aion
  // tandem-repeat blocks (server/ai/narrator-repeats.ts) — all three clean the live
  // feed AND, because the route persists the accumulated deltas, the stored reply +
  // history. Both normalizers run before the repeat collapse so a leaked tag or a
  // stray bracket can't break its verbatim block match.
  const stream = collapseRepeatedBlocksStream(
    stripMisplacedSpeakerTagStream(
      stripNarratorArtifactStream(
        observeRawStream(result, (outcome) => {
          // A captured provider failure IS the error finish, and outranks whatever the
          // result promises managed to report — when the initial request is the thing
          // that failed (a cold start's 503), the SDK rejects those promises rather
          // than resolving them to "error", and "unknown" would lose the whole story.
          recorded =
            providerError === undefined
              ? outcome
              : { ...outcome, finishReason: "error", providerError };
        }),
      ),
      args.names,
    ),
  );
  return { stream, outcome: () => recorded };
}

/**
 * Pass the raw model deltas straight through while counting them, then read the
 * generation's finish metadata off the AI SDK's result promises and hand it to
 * `record`. Sits UPSTREAM of Vesper's normalizers on purpose: this is the
 * measurement of what the provider actually produced, which is the only way to tell
 * "the model said nothing" apart from "we deleted everything the model said".
 *
 * Nothing is buffered — each delta is yielded as it arrives, so a successful reply
 * reaches the player exactly as fast as before. The metadata read happens after the
 * last delta and each promise is settled INDEPENDENTLY: these reject rather than
 * resolve when the request itself failed, and one unavailable field must not cost the
 * others (docs/resilience.md — degraded defaults, and unknown is never zero).
 */
async function* observeRawStream(
  result: ReturnType<typeof streamText>,
  record: (outcome: RawAttemptOutcome) => void,
): AsyncGenerator<string> {
  let rawTextLength = 0;
  for await (const delta of result.textStream) {
    rawTextLength += delta.length;
    yield delta;
  }
  const [finishReason, rawFinishReason, usage] = await Promise.allSettled([
    result.finishReason,
    result.rawFinishReason,
    result.totalUsage,
  ]);
  const counts = usage.status === "fulfilled" ? usage.value : undefined;
  record({
    finishReason: finishReason.status === "fulfilled" ? finishReason.value : "unknown",
    ...(rawFinishReason.status === "fulfilled" && rawFinishReason.value !== undefined
      ? { rawFinishReason: rawFinishReason.value }
      : {}),
    ...(counts?.inputTokens === undefined ? {} : { inputTokens: counts.inputTokens }),
    ...(counts?.outputTokens === undefined ? {} : { outputTokens: counts.outputTokens }),
    ...(counts?.outputTokenDetails?.textTokens === undefined
      ? {}
      : { textTokens: counts.outputTokenDetails.textTokens }),
    ...(counts?.outputTokenDetails?.reasoningTokens === undefined
      ? {}
      : { reasoningTokens: counts.outputTokenDetails.reasoningTokens }),
    rawTextLength,
  });
}

/** Non-whitespace characters in a delta — the streaming equivalent of `text.trim().length > 0`. */
function inkLength(delta: string): number {
  return delta.replace(/\s+/g, "").length;
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
