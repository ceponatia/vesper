import { z } from "zod";

/**
 * SSE turn-stream client (docs/streaming-api.md §Turn streaming). Parses
 * `event:`/`data:` frames with buffered splitting on blank lines, so partial
 * frames across network chunks are handled. Malformed frames are skipped with
 * a console.warn — a bad frame degrades the display, never throws. A stream
 * that closes without `done`/`error` fires `onIncomplete`: the server finishes
 * the turn regardless, so this is a client display problem only.
 */

// ---------------------------------------------------------------------------
// Frame parsing (pure, incremental)
// ---------------------------------------------------------------------------

export interface RawSseFrame {
  event: string;
  /** Multiple `data:` lines are joined with \n per the SSE spec. */
  data: string;
}

const FRAME_BOUNDARY = /\r?\n\r?\n/;

function parseFrameBlock(block: string): RawSseFrame | null {
  let event = "message";
  const dataLines: string[] = [];
  for (const line of block.split(/\r?\n/)) {
    if (line === "" || line.startsWith(":")) continue; // comment / keep-alive
    const colon = line.indexOf(":");
    const field = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? "" : line.slice(colon + 1);
    if (value.startsWith(" ")) value = value.slice(1);
    if (field === "event") event = value;
    else if (field === "data") dataLines.push(value);
    // id:/retry:/unknown fields are ignored (forward-compatible)
  }
  if (event === "message" && dataLines.length === 0) return null;
  return { event, data: dataLines.join("\n") };
}

export interface SseFrameParser {
  /** Feed decoded text; returns every frame completed by this chunk. */
  push(text: string): RawSseFrame[];
  /** Drain a trailing frame that was never terminated by a blank line. */
  flush(): RawSseFrame[];
}

export function createSseFrameParser(): SseFrameParser {
  let buffer = "";
  return {
    push(text: string): RawSseFrame[] {
      buffer += text;
      const frames: RawSseFrame[] = [];
      for (;;) {
        const match = FRAME_BOUNDARY.exec(buffer);
        if (!match) break;
        const block = buffer.slice(0, match.index);
        buffer = buffer.slice(match.index + match[0].length);
        const frame = parseFrameBlock(block);
        if (frame) frames.push(frame);
      }
      return frames;
    },
    flush(): RawSseFrame[] {
      const rest = buffer;
      buffer = "";
      if (rest.trim() === "") return [];
      const frame = parseFrameBlock(rest);
      return frame ? [frame] : [];
    },
  };
}

// ---------------------------------------------------------------------------
// Event payloads — forgiving: bad leaf fields fall back, a chunk without
// content is useless and gets skipped rather than coerced.
// ---------------------------------------------------------------------------

const startEventSchema = z
  .object({
    turnId: z.string().catch(""),
    turnNumber: z.number().int().catch(0),
  })
  .catch({ turnId: "", turnNumber: 0 });
export type TurnStartEvent = z.infer<typeof startEventSchema>;

const chunkEventSchema = z.object({
  segmentIndex: z.number().int().min(0).catch(0),
  speaker: z
    .string()
    .nullish()
    .catch(null)
    .transform((v) => v ?? null),
  content: z.string(),
});
export type TurnChunkPayload = z.infer<typeof chunkEventSchema>;

const statusEventSchema = z
  .object({ phase: z.string().catch("processing") })
  .catch({ phase: "processing" });
export type TurnStatusEvent = z.infer<typeof statusEventSchema>;

const doneEventSchema = z.object({ turnId: z.string().catch("") }).catch({ turnId: "" });
export type TurnDoneEvent = z.infer<typeof doneEventSchema>;

const errorEventSchema = z
  .object({
    code: z.string().catch("turn_failed"),
    message: z.string().catch("The turn failed."),
  })
  .catch({ code: "turn_failed", message: "The turn failed." });
export type TurnErrorEvent = z.infer<typeof errorEventSchema>;

export interface TurnStreamHandlers {
  onStart?: (event: TurnStartEvent) => void;
  onChunk?: (event: TurnChunkPayload) => void;
  onStatus?: (event: TurnStatusEvent) => void;
  onDone?: (event: TurnDoneEvent) => void;
  onError?: (event: TurnErrorEvent) => void;
  /** Stream closed without a terminal `done`/`error` event. */
  onIncomplete?: () => void;
}

export interface TurnStreamOutcome {
  /** True when a `done` event arrived. */
  completed: boolean;
  /** True when a terminal `error` event arrived. */
  errored: boolean;
}

type Terminal = "done" | "error";

function dispatchFrame(frame: RawSseFrame, handlers: TurnStreamHandlers): Terminal | null {
  let payload: unknown = {};
  if (frame.data !== "") {
    try {
      payload = JSON.parse(frame.data);
    } catch {
      console.warn(`[turn-stream] malformed JSON in "${frame.event}" frame; skipped`);
      return null;
    }
  }
  switch (frame.event) {
    case "start":
      handlers.onStart?.(startEventSchema.parse(payload));
      return null;
    case "chunk": {
      const parsed = chunkEventSchema.safeParse(payload);
      if (!parsed.success) {
        console.warn("[turn-stream] unusable chunk frame; skipped");
        return null;
      }
      handlers.onChunk?.(parsed.data);
      return null;
    }
    case "status":
      handlers.onStatus?.(statusEventSchema.parse(payload));
      return null;
    case "done":
      handlers.onDone?.(doneEventSchema.parse(payload));
      return "done";
    case "error":
      handlers.onError?.(errorEventSchema.parse(payload));
      return "error";
    default:
      return null; // unknown event names are ignored (forward-compatible)
  }
}

/**
 * Consume an SSE response. Never rejects on transport problems — a dropped
 * connection resolves `{ completed: false, errored: false }` after
 * `onIncomplete` fires.
 */
export async function consumeTurnStream(
  response: Response,
  handlers: TurnStreamHandlers,
): Promise<TurnStreamOutcome> {
  const body = response.body;
  if (!body) {
    handlers.onIncomplete?.();
    return { completed: false, errored: false };
  }

  const reader = body.getReader();
  const decoder = new TextDecoder();
  const parser = createSseFrameParser();
  let terminal: Terminal | null = null;

  try {
    while (terminal === null) {
      const { done, value } = await reader.read();
      if (done) break;
      for (const frame of parser.push(decoder.decode(value, { stream: true }))) {
        terminal = dispatchFrame(frame, handlers);
        if (terminal) break;
      }
    }
  } catch (err) {
    console.warn("[turn-stream] stream read failed", err);
  }

  if (terminal === null) {
    // A final frame may lack its trailing blank line; drain what remains.
    for (const frame of [...parser.push(decoder.decode()), ...parser.flush()]) {
      terminal = dispatchFrame(frame, handlers);
      if (terminal) break;
    }
  } else {
    reader.cancel().catch(() => {});
  }

  if (terminal === null) handlers.onIncomplete?.();
  return { completed: terminal === "done", errored: terminal === "error" };
}
