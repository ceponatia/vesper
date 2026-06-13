import { afterEach, describe, expect, it, vi } from "vitest";
import { consumeTurnStream, createSseFrameParser, type TurnStreamHandlers } from "./turn-stream";

function sseResponse(chunks: string[]): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
  return new Response(stream, { headers: { "content-type": "text/event-stream" } });
}

function recordingHandlers() {
  const calls: Array<{ kind: string; data?: unknown }> = [];
  const handlers: TurnStreamHandlers = {
    onStart: (e) => calls.push({ kind: "start", data: e }),
    onChunk: (e) => calls.push({ kind: "chunk", data: e }),
    onStatus: (e) => calls.push({ kind: "status", data: e }),
    onDone: (e) => calls.push({ kind: "done", data: e }),
    onError: (e) => calls.push({ kind: "error", data: e }),
    onIncomplete: () => calls.push({ kind: "incomplete" }),
  };
  return { calls, handlers };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("createSseFrameParser", () => {
  it("parses a complete frame", () => {
    const parser = createSseFrameParser();
    const frames = parser.push('event: start\ndata: {"turnId":"t1"}\n\n');
    expect(frames).toEqual([{ event: "start", data: '{"turnId":"t1"}' }]);
  });

  it("buffers partial frames across pushes (mid-line splits)", () => {
    const parser = createSseFrameParser();
    expect(parser.push("event: ch")).toEqual([]);
    expect(parser.push('unk\ndata: {"a"')).toEqual([]);
    const frames = parser.push(':1}\n\nevent: done\ndata: {}\n\n');
    expect(frames).toEqual([
      { event: "chunk", data: '{"a":1}' },
      { event: "done", data: "{}" },
    ]);
  });

  it("joins multiple data lines with newline", () => {
    const parser = createSseFrameParser();
    const frames = parser.push("data: line1\ndata: line2\n\n");
    expect(frames).toEqual([{ event: "message", data: "line1\nline2" }]);
  });

  it("ignores comments, ids, and blank keep-alive frames", () => {
    const parser = createSseFrameParser();
    expect(parser.push(": keep-alive\n\nid: 7\n\n")).toEqual([]);
  });

  it("handles CRLF separators", () => {
    const parser = createSseFrameParser();
    const frames = parser.push("event: status\r\ndata: {}\r\n\r\n");
    expect(frames).toEqual([{ event: "status", data: "{}" }]);
  });

  it("flush drains an unterminated trailing frame", () => {
    const parser = createSseFrameParser();
    expect(parser.push("event: done\ndata: {}")).toEqual([]);
    expect(parser.flush()).toEqual([{ event: "done", data: "{}" }]);
    expect(parser.flush()).toEqual([]);
  });
});

describe("consumeTurnStream", () => {
  it("dispatches the documented event sequence in order", async () => {
    const { calls, handlers } = recordingHandlers();
    const outcome = await consumeTurnStream(
      sseResponse([
        'event: start\ndata: {"turnId":"t1","turnNumber":3}\n\n',
        'event: chunk\ndata: {"segmentIndex":0,"speaker":null,"content":"The road "}\n\n',
        'event: chunk\ndata: {"segmentIndex":0,"speaker":null,"content":"bends."}\n\n',
        'event: chunk\ndata: {"segmentIndex":1,"speaker":"Maya","content":"Hello."}\n\n',
        'event: status\ndata: {"phase":"processing"}\n\n',
        'event: done\ndata: {"turnId":"t1"}\n\n',
      ]),
      handlers,
    );
    expect(outcome).toEqual({ completed: true, errored: false });
    expect(calls.map((c) => c.kind)).toEqual(["start", "chunk", "chunk", "chunk", "status", "done"]);
    expect(calls[0]?.data).toEqual({ turnId: "t1", turnNumber: 3 });
    expect(calls[3]?.data).toEqual({ segmentIndex: 1, speaker: "Maya", content: "Hello." });
    expect(calls[4]?.data).toEqual({ phase: "processing" });
  });

  it("reassembles frames split across arbitrary chunk boundaries", async () => {
    const full =
      'event: start\ndata: {"turnId":"t9","turnNumber":1}\n\n' +
      'event: chunk\ndata: {"segmentIndex":0,"speaker":null,"content":"abc"}\n\n' +
      "event: done\ndata: {}\n\n";
    const chunks: string[] = [];
    for (let i = 0; i < full.length; i += 7) chunks.push(full.slice(i, i + 7));
    const { calls, handlers } = recordingHandlers();
    const outcome = await consumeTurnStream(sseResponse(chunks), handlers);
    expect(outcome.completed).toBe(true);
    expect(calls.map((c) => c.kind)).toEqual(["start", "chunk", "done"]);
  });

  it("skips malformed JSON with a console.warn and keeps going", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { calls, handlers } = recordingHandlers();
    const outcome = await consumeTurnStream(
      sseResponse([
        "event: chunk\ndata: {not json\n\n",
        'event: chunk\ndata: {"segmentIndex":0,"speaker":null,"content":"ok"}\n\n',
        "event: done\ndata: {}\n\n",
      ]),
      handlers,
    );
    expect(outcome.completed).toBe(true);
    expect(warn).toHaveBeenCalled();
    expect(calls.map((c) => c.kind)).toEqual(["chunk", "done"]);
  });

  it("skips a chunk frame without usable content", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { calls, handlers } = recordingHandlers();
    await consumeTurnStream(
      sseResponse(['event: chunk\ndata: {"segmentIndex":0}\n\n', "event: done\ndata: {}\n\n"]),
      handlers,
    );
    expect(warn).toHaveBeenCalled();
    expect(calls.map((c) => c.kind)).toEqual(["done"]);
  });

  it("fires onIncomplete when the stream closes without done/error", async () => {
    const { calls, handlers } = recordingHandlers();
    const outcome = await consumeTurnStream(
      sseResponse(['event: chunk\ndata: {"segmentIndex":0,"speaker":null,"content":"hi"}\n\n']),
      handlers,
    );
    expect(outcome).toEqual({ completed: false, errored: false });
    expect(calls.map((c) => c.kind)).toEqual(["chunk", "incomplete"]);
  });

  it("treats a transport error as incomplete, not a rejection", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode('event: start\ndata: {"turnId":"t","turnNumber":1}\n\n'));
        controller.error(new Error("connection reset"));
      },
    });
    const { calls, handlers } = recordingHandlers();
    const outcome = await consumeTurnStream(new Response(stream), handlers);
    expect(outcome).toEqual({ completed: false, errored: false });
    // Whether the pre-error chunk is delivered is up to the runtime; the
    // contract is: no rejection, and the stream ends as incomplete.
    expect(calls.at(-1)).toEqual({ kind: "incomplete" });
  });

  it("handles a terminal error event", async () => {
    const { calls, handlers } = recordingHandlers();
    const outcome = await consumeTurnStream(
      sseResponse(['event: error\ndata: {"code":"narrative_failed","message":"boom"}\n\n']),
      handlers,
    );
    expect(outcome).toEqual({ completed: false, errored: true });
    expect(calls).toEqual([{ kind: "error", data: { code: "narrative_failed", message: "boom" } }]);
  });

  it("parses a final done frame that lacks its trailing blank line", async () => {
    const { calls, handlers } = recordingHandlers();
    const outcome = await consumeTurnStream(sseResponse(["event: done\ndata: {}"]), handlers);
    expect(outcome.completed).toBe(true);
    expect(calls.map((c) => c.kind)).toEqual(["done"]);
  });

  it("falls back to degraded defaults for bad leaf fields", async () => {
    const { calls, handlers } = recordingHandlers();
    await consumeTurnStream(
      sseResponse(['event: start\ndata: {"turnId":42,"turnNumber":"x"}\n\n', "event: done\ndata: 7\n\n"]),
      handlers,
    );
    expect(calls[0]?.data).toEqual({ turnId: "", turnNumber: 0 });
    expect(calls[1]?.data).toEqual({ turnId: "" });
  });

  it("a body-less response is incomplete", async () => {
    const { calls, handlers } = recordingHandlers();
    const outcome = await consumeTurnStream(new Response(null, { status: 200 }), handlers);
    expect(outcome).toEqual({ completed: false, errored: false });
    expect(calls.map((c) => c.kind)).toEqual(["incomplete"]);
  });

  it("ignores unknown event names", async () => {
    const { calls, handlers } = recordingHandlers();
    await consumeTurnStream(
      sseResponse(['event: heartbeat\ndata: {}\n\n', "event: done\ndata: {}\n\n"]),
      handlers,
    );
    expect(calls.map((c) => c.kind)).toEqual(["done"]);
  });
});
