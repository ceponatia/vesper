import { jsonError } from "@/server/api";
import type { TurnStreamEvent } from "@/server/engine";

/**
 * SSE plumbing for the turn routes (docs/streaming-api.md §Turn streaming):
 * `event: X\ndata: JSON\n\n` frames, flushed per event. A blocked/invalid
 * first event becomes a plain JSON error response instead of a stream, and a
 * client abort never interrupts the engine — the generator is drained
 * server-side regardless (docs/resilience.md §5).
 */

export function sseFrame(event: TurnStreamEvent): string {
  return `event: ${event.event}\ndata: ${JSON.stringify(event.data)}\n\n`;
}

/** HTTP status for an engine error code (stream first-events and ActionResults). */
export function engineErrorStatus(code: string): number {
  switch (code) {
    case "invalid_input":
      return 400;
    case "not_found":
      return 404;
    case "session_busy":
    case "not_latest":
      return 409;
    default:
      return 500;
  }
}

function firstEventError(event: TurnStreamEvent): Response {
  const code = typeof event.data["code"] === "string" ? event.data["code"] : "turn_failed";
  const message = typeof event.data["message"] === "string" ? event.data["message"] : "the turn failed";
  return jsonError(code, message, engineErrorStatus(code));
}

/**
 * Wrap a turn-event generator in a streaming Response. The first event is
 * awaited before committing to a stream so `session_busy` (and friends) can
 * be a clean 409 JSON response per the docs.
 */
export async function streamTurnEvents(gen: AsyncGenerator<TurnStreamEvent, void, unknown>): Promise<Response> {
  const first = await gen.next();
  if (first.done) return jsonError("turn_failed", "the turn produced no events", 500);
  if (first.value.event === "error") return firstEventError(first.value);

  const encoder = new TextEncoder();
  const firstEvent = first.value;
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      let open = true;
      const send = (event: TurnStreamEvent): void => {
        if (!open) return;
        try {
          controller.enqueue(encoder.encode(sseFrame(event)));
        } catch {
          // Client gone: SSE writes are best-effort; keep draining so the
          // engine generator finishes normally.
          open = false;
        }
      };
      send(firstEvent);
      for (;;) {
        let next: IteratorResult<TurnStreamEvent, void>;
        try {
          next = await gen.next();
        } catch {
          send({ event: "error", data: { code: "turn_failed", message: "the turn stream failed" } });
          break;
        }
        if (next.done) break;
        send(next.value);
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
      // Client abort is a display problem only; the detached engine task
      // persists the turn regardless and the start() loop drains the events.
    },
  });

  return new Response(stream, {
    status: 200,
    headers: {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      "x-accel-buffering": "no",
    },
  });
}
