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
