import { describe, expect, it, vi } from "vitest";
import type { TurnStreamEvent } from "@/server/engine";
import { engineErrorStatus, sseFrame, streamTurnEvents } from "./sse";

function event(name: TurnStreamEvent["event"], data: Record<string, unknown>): TurnStreamEvent {
  return { event: name, data };
}

async function* fromArray(events: TurnStreamEvent[]): AsyncGenerator<TurnStreamEvent, void, unknown> {
  for (const e of events) yield e;
}

interface ParsedFrame {
  event: string;
  data: Record<string, unknown>;
}

function parseFrames(text: string): ParsedFrame[] {
  return text
    .split("\n\n")
    .filter((f) => f.trim().length > 0)
    .map((frame) => {
      const lines = frame.split("\n");
      const eventLine = lines.find((l) => l.startsWith("event: "));
      const dataLine = lines.find((l) => l.startsWith("data: "));
      return {
        event: eventLine?.slice("event: ".length) ?? "",
        data: dataLine ? (JSON.parse(dataLine.slice("data: ".length)) as Record<string, unknown>) : {},
      };
    });
}

describe("sseFrame", () => {
  it("encodes the documented event/data frame", () => {
    const frame = sseFrame(event("chunk", { segmentIndex: 0, speaker: null, content: "hi" }));
    expect(frame).toBe('event: chunk\ndata: {"segmentIndex":0,"speaker":null,"content":"hi"}\n\n');
  });
});

describe("engineErrorStatus", () => {
  it("maps engine codes to HTTP statuses", () => {
    expect(engineErrorStatus("invalid_input")).toBe(400);
    expect(engineErrorStatus("not_found")).toBe(404);
    expect(engineErrorStatus("session_busy")).toBe(409);
    expect(engineErrorStatus("not_latest")).toBe(409);
    expect(engineErrorStatus("narrative_failed")).toBe(500);
  });
});

describe("streamTurnEvents", () => {
  it("turns a first-event session_busy into a plain 409 JSON response", async () => {
    const res = await streamTurnEvents(
      fromArray([event("error", { code: "session_busy", message: "a turn is already in progress" })]),
    );
    expect(res.status).toBe(409);
    expect(res.headers.get("content-type")).toContain("application/json");
    const body = (await res.json()) as { error: { code: string; message: string } };
    expect(body.error.code).toBe("session_busy");
    expect(body.error.message).toBe("a turn is already in progress");
  });

  it("turns a first-event not_found into a 404", async () => {
    const res = await streamTurnEvents(fromArray([event("error", { code: "not_found", message: "nope" })]));
    expect(res.status).toBe(404);
  });

  it("streams ordered SSE frames for a normal turn", async () => {
    const res = await streamTurnEvents(
      fromArray([
        event("start", { turnId: "t1", turnNumber: 3 }),
        event("chunk", { segmentIndex: 0, speaker: null, content: "Rain " }),
        event("chunk", { segmentIndex: 0, speaker: null, content: "falls." }),
        event("status", { phase: "processing" }),
        event("done", { turnId: "t1" }),
      ]),
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    const frames = parseFrames(await res.text());
    expect(frames.map((f) => f.event)).toEqual(["start", "chunk", "chunk", "status", "done"]);
    expect(frames[0]?.data).toEqual({ turnId: "t1", turnNumber: 3 });
    expect(frames[3]?.data).toEqual({ phase: "processing" });
  });

  it("a client abort never interrupts the generator (drained server-side)", async () => {
    let finished = false;
    async function* gen(): AsyncGenerator<TurnStreamEvent, void, unknown> {
      yield event("start", { turnId: "t1", turnNumber: 1 });
      yield event("chunk", { segmentIndex: 0, speaker: null, content: "a" });
      yield event("chunk", { segmentIndex: 0, speaker: null, content: "b" });
      yield event("done", { turnId: "t1" });
      finished = true;
    }
    const res = await streamTurnEvents(gen());
    const reader = res.body?.getReader();
    expect(reader).toBeDefined();
    if (!reader) return;
    await reader.read();
    await reader.cancel(); // client walks away mid-stream
    await vi.waitFor(() => expect(finished).toBe(true));
  });

  it("an empty generator degrades to a 500 envelope, not a hung stream", async () => {
    const res = await streamTurnEvents(fromArray([]));
    expect(res.status).toBe(500);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("turn_failed");
  });
});
