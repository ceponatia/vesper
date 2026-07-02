import { drainingStreamResponse, jsonError } from "@/server/api";
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

/** Re-yield the already-awaited first event ahead of the rest of the generator. */
async function* withFirst(
  first: TurnStreamEvent,
  rest: AsyncGenerator<TurnStreamEvent, void, unknown>,
): AsyncGenerator<TurnStreamEvent, void, unknown> {
  yield first;
  yield* rest;
}

/**
 * Wrap a turn-event generator in a streaming Response. The first event is
 * awaited before committing to a stream so `session_busy` (and friends) can
 * be a clean 409 JSON response per the docs. The drain-despite-disconnect
 * discipline lives in the shared `drainingStreamResponse` (docs/resilience.md
 * §5) — a client abort never interrupts the engine.
 */
export async function streamTurnEvents(gen: AsyncGenerator<TurnStreamEvent, void, unknown>): Promise<Response> {
  const first = await gen.next();
  if (first.done) return jsonError("turn_failed", "the turn produced no events", 500);
  if (first.value.event === "error") return firstEventError(first.value);

  return drainingStreamResponse({
    gen: withFirst(first.value, gen),
    encode: sseFrame,
    onStreamError: (send) =>
      send(sseFrame({ event: "error", data: { code: "turn_failed", message: "the turn stream failed" } })),
    headers: {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      "x-accel-buffering": "no",
    },
  });
}
