/**
 * Shared drain-despite-disconnect streaming Response (docs/resilience.md §5).
 * Both streaming lanes — the session SSE turn stream and the chat plain-text
 * token stream — must keep consuming their generator after a client disconnect,
 * because detached server-side work (turn persistence, the chat reply persist +
 * post-turn fan-out) rides the generator's completion. A failed enqueue flips
 * writes to best-effort; the drain loop never stops early.
 */
export function drainingStreamResponse<T>(opts: {
  gen: AsyncGenerator<T, void, unknown>;
  /** Serialize one generator item into stream text (identity for token streams, a frame for SSE). */
  encode: (item: T) => string;
  headers: Record<string, string>;
  /** Called when the generator itself throws mid-stream; may emit a final frame via `send`. */
  onStreamError?: (send: (text: string) => void, error: unknown) => void;
}): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      let open = true;
      const send = (text: string): void => {
        if (!open) return;
        try {
          controller.enqueue(encoder.encode(text));
        } catch {
          // Client gone: writes are best-effort from here; keep draining so the
          // generator's settle work (persistence, fan-out) still completes.
          open = false;
        }
      };
      for (;;) {
        let next: IteratorResult<T, void>;
        try {
          next = await opts.gen.next();
        } catch (error) {
          opts.onStreamError?.(send, error);
          break;
        }
        if (next.done) break;
        send(opts.encode(next.value));
      }
      if (open) {
        try {
          controller.close();
        } catch {
          // already closed by a consumer cancel — nothing to do
        }
      }
    },
    cancel() {
      // Client abort is a display problem only; start() keeps draining the
      // generator so server-side persistence always sees the whole stream.
    },
  });

  return new Response(stream, { status: 200, headers: opts.headers });
}


const DEFAULT_REVEAL_CHUNK_CHARS = 18;
const DEFAULT_REVEAL_DELAY_MS = 20;

export interface PacedTextRevealOptions {
  /** Approximate chunk size; whitespace-delimited tokens are never split. */
  targetChunkChars?: number;
  /** Pause before each chunk after the first. */
  delayMs?: number;
  /** Injectable timer seam for tests. */
  wait?: (delayMs: number) => Promise<void>;
}

function waitFor(delayMs: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, delayMs);
  });
}

/**
 * Reveal already-approved prose incrementally while preserving its bytes exactly.
 *
 * This is intentionally a presentation seam, not a provider-token stream: callers
 * can finish trust-boundary validation before yielding any text, then avoid dropping
 * the entire approved reply into the UI as one blob. The first chunk is immediate;
 * later chunks are lightly paced so browsers paint between reads.
 */
export async function* pacedTextReveal(
  text: string,
  options: PacedTextRevealOptions = {},
): AsyncGenerator<string, void, unknown> {
  const targetChunkChars = options.targetChunkChars ?? DEFAULT_REVEAL_CHUNK_CHARS;
  const delayMs = options.delayMs ?? DEFAULT_REVEAL_DELAY_MS;
  if (!Number.isSafeInteger(targetChunkChars) || targetChunkChars < 1) {
    throw new RangeError("targetChunkChars must be a positive safe integer");
  }
  if (!Number.isSafeInteger(delayMs) || delayMs < 0) {
    throw new RangeError("delayMs must be a non-negative safe integer");
  }

  const wait = options.wait ?? waitFor;
  const parts = text.match(/\s+|\S+/g) ?? [];
  let chunk = "";
  let emitted = false;

  const reveal = async function* (): AsyncGenerator<string, void, unknown> {
    if (emitted && delayMs > 0) await wait(delayMs);
    emitted = true;
    yield chunk;
    chunk = "";
  };

  for (const part of parts) {
    chunk += part;
    if (chunk.length < targetChunkChars) continue;
    yield* reveal();
  }
  if (chunk.length > 0) yield* reveal();
}
