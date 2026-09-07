import { type ChatActionId } from "@/contracts";

/**
 * Client data layer (docs/streaming-api.md, docs/ui/conventions.md): typed
 * fetch helpers over the route-handler API. Every response crosses a trust boundary, so it
 * is parsed with forgiving schemas — unknown fields are stripped, bad fields
 * fall back, bad list elements are dropped. Errors use the
 * `{ error: { code, message } }` envelope.
 *
 * This module is client-safe: it imports only pure contracts and `zod`.
 */
import { toApiError, type ApiError } from "./http";

export interface ChatStreamOutcome {
  ok: boolean;
  error?: ApiError;
  /**
   * The caller aborted via `signal` (e.g. a Rerun cancelled this in-flight reply).
   * Distinct from an error: the server keeps draining + persisting the reply, so the
   * caller should just stop expecting tokens, not surface a failure toast.
   */
  aborted?: boolean;
}

/**
 * Send a message into a conversation and stream the character's reply
 * (plain-text token stream). `onChunk` fires per decoded delta; the reply is
 * persisted server-side, so a dropped stream still leaves the transcript whole on
 * the next reload. Never throws.
 *
 * Pass an `AbortSignal` to cancel the wait for a reply (Rerun): aborting stops the
 * client reading the stream but cannot stop inference already running — the server
 * drains + persists the full reply regardless, and the next transcript reload
 * reconciles. An abort surfaces as `{ ok: true, aborted: true }`, never an error.
 */
export async function sendChatMessage(
  chatId: string,
  body: {
    kind?:
      "send" | "open" | "continue" | "action_beat" | "regenerate" | "rerun";
    content?: string;
    model?: string;
    cue?: string;
    /** Target user-message id — required for kind "rerun" (the line to re-send from). */
    messageId?: string;
    /** Attached-photo ids (uploaded first via chatsApi.uploadAttachment) — send only. */
    attachmentIds?: string[];
    /** Reopen-opener initiative — continue only. */
    initiative?: boolean;
    /** Composer register (player vs narrator) — send only. */
    inputMode?: "player" | "narrator";
    /** Tapped action-chip id — required for kind "action_beat". */
    action?: ChatActionId;
  },
  onChunk: (delta: string) => void,
  signal?: AbortSignal,
): Promise<ChatStreamOutcome> {
  let res: Response;
  try {
    res = await fetch(`/api/chats/${chatId}`, {
      method: "POST",
      cache: "no-store",
      headers: { "content-type": "application/json", accept: "text/plain" },
      body: JSON.stringify(body),
      signal,
    });
  } catch (err) {
    if (signal?.aborted) return { ok: true, aborted: true };
    return {
      ok: false,
      error: {
        status: 0,
        code: "network_error",
        message: err instanceof Error ? err.message : "Network error",
      },
    };
  }
  if (!res.ok) {
    let raw: unknown = null;
    try {
      raw = await res.json();
    } catch {
      raw = null;
    }
    return { ok: false, error: toApiError(res.status, raw) };
  }
  const stream = res.body;
  if (!stream) return { ok: true };
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      const text = decoder.decode(value, { stream: true });
      if (text) onChunk(text);
    }
    const tail = decoder.decode();
    if (tail) onChunk(tail);
  } catch {
    // Stream interrupted (network drop or an explicit abort) — the partial reply
    // already reached onChunk and the server persisted the full reply; the next
    // transcript reload reconciles.
  }
  return { ok: true, aborted: signal?.aborted ?? false };
}

/** Wrapper for the entity-image GET (`{ image }`, nullable) used by the studio. */
