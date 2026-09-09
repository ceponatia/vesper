import { describe, expect, it } from "vitest";
import {
  appendVoiceExemplar,
  removeVoiceExemplarsForMessage,
  voiceExemplarSchema,
  CHAT_VOICE_EXEMPLAR_CAP,
  CHAT_VOICE_EXEMPLAR_LINE_MAX,
  type VoiceExemplar,
} from "./chat-voice";

describe("appendVoiceExemplar (voice-exemplar ring — character-fidelity slice 8)", () => {
  it("appends a picked line with its clock minute and source message id", () => {
    const out = appendVoiceExemplar([], "Tell me you at least practiced the toast.", 120, "msg-1");
    expect(out).toEqual([
      { line: "Tell me you at least practiced the toast.", atClockMinutes: 120, sourceMessageId: "msg-1" },
    ]);
  });

  it("stores a null source message id for a legacy caller / pre-provenance write", () => {
    const out = appendVoiceExemplar([], "A line with no known origin.", 5, null);
    expect(out[0]?.sourceMessageId).toBeNull();
  });

  it("is a no-op for a blank/whitespace pick (the common no-distinct-line case)", () => {
    const prior: VoiceExemplar[] = [{ line: "existing", atClockMinutes: 0, sourceMessageId: "msg-0" }];
    expect(appendVoiceExemplar(prior, "", 30, "msg-1")).toEqual(prior);
    expect(appendVoiceExemplar(prior, "   ", 30, "msg-1")).toEqual(prior);
  });

  it("keeps only the newest CHAT_VOICE_EXEMPLAR_CAP entries", () => {
    let ring: VoiceExemplar[] = [];
    for (let i = 0; i < CHAT_VOICE_EXEMPLAR_CAP + 4; i++) ring = appendVoiceExemplar(ring, `line ${i}`, i, `msg-${i}`);
    expect(ring).toHaveLength(CHAT_VOICE_EXEMPLAR_CAP);
    expect(ring[0]?.line).toBe(`line 4`); // oldest 4 dropped
    expect(ring.at(-1)?.line).toBe(`line ${CHAT_VOICE_EXEMPLAR_CAP + 3}`);
  });

  it("trims and length-caps the stored line", () => {
    const long = "x".repeat(CHAT_VOICE_EXEMPLAR_LINE_MAX + 50);
    const out = appendVoiceExemplar([], `  ${long}  `, 0, "msg-1");
    expect(out[0]?.line.length).toBe(CHAT_VOICE_EXEMPLAR_LINE_MAX);
  });
});

describe("voiceExemplarSchema (provenance backward-compat)", () => {
  it("parses a pre-provenance entry {line, atClockMinutes} to sourceMessageId: null", () => {
    const parsed = voiceExemplarSchema.parse({ line: "an old line", atClockMinutes: 42 });
    expect(parsed).toEqual({ line: "an old line", atClockMinutes: 42, sourceMessageId: null });
  });

  it("keeps an explicit sourceMessageId on a current-shape entry", () => {
    const parsed = voiceExemplarSchema.parse({ line: "a line", atClockMinutes: 1, sourceMessageId: "msg-9" });
    expect(parsed.sourceMessageId).toBe("msg-9");
  });
});

describe("removeVoiceExemplarsForMessage (pure removal helper)", () => {
  it("returns an empty result for an empty history", () => {
    expect(removeVoiceExemplarsForMessage([], { id: "msg-1", content: "anything" })).toEqual({
      kept: [],
      removed: 0,
    });
  });

  it("drops only entries whose provenance id matches the message", () => {
    const history: VoiceExemplar[] = [
      { line: "line from msg-1", atClockMinutes: 1, sourceMessageId: "msg-1" },
      { line: "line from msg-2", atClockMinutes: 2, sourceMessageId: "msg-2" },
      { line: "another line from msg-1", atClockMinutes: 3, sourceMessageId: "msg-1" },
    ];
    const { kept, removed } = removeVoiceExemplarsForMessage(history, {
      id: "msg-1",
      content: "irrelevant — provenance wins over text",
    });
    expect(removed).toBe(2);
    expect(kept).toEqual([{ line: "line from msg-2", atClockMinutes: 2, sourceMessageId: "msg-2" }]);
  });

  it("drops a legacy (null-provenance) entry whose line occurs verbatim in the old content", () => {
    const history: VoiceExemplar[] = [
      { line: "Tell me you at least practiced the toast.", atClockMinutes: 1, sourceMessageId: null },
    ];
    const { kept, removed } = removeVoiceExemplarsForMessage(history, {
      id: "msg-1",
      content: "\"Tell me you at least practiced the toast.\" she said, laughing.",
    });
    expect(removed).toBe(1);
    expect(kept).toEqual([]);
  });

  it("matches a legacy entry through whitespace differences (line breaks / double spaces)", () => {
    const history: VoiceExemplar[] = [
      { line: "Tell me you at least practiced the toast.", atClockMinutes: 1, sourceMessageId: null },
    ];
    const { kept, removed } = removeVoiceExemplarsForMessage(history, {
      id: "msg-1",
      content: "\"Tell   me you\nat least   practiced the\ntoast.\" she said.",
    });
    expect(removed).toBe(1);
    expect(kept).toEqual([]);
  });

  it("matches a legacy entry through case differences", () => {
    const history: VoiceExemplar[] = [
      { line: "Tell me you at least practiced the toast.", atClockMinutes: 1, sourceMessageId: null },
    ];
    const { kept, removed } = removeVoiceExemplarsForMessage(history, {
      id: "msg-1",
      content: "TELL ME YOU AT LEAST PRACTICED THE TOAST.",
    });
    expect(removed).toBe(1);
    expect(kept).toEqual([]);
  });

  it("keeps a legacy entry whose line does not occur in the old content", () => {
    const history: VoiceExemplar[] = [
      { line: "This line was never said in the edited message.", atClockMinutes: 1, sourceMessageId: null },
    ];
    const { kept, removed } = removeVoiceExemplarsForMessage(history, {
      id: "msg-1",
      content: "Completely unrelated content.",
    });
    expect(removed).toBe(0);
    expect(kept).toEqual(history);
  });

  it("keeps a provenanced entry from another message even when its text occurs in this message's content (id wins over text)", () => {
    const sharedLine = "I always say this exact line.";
    const history: VoiceExemplar[] = [
      { line: sharedLine, atClockMinutes: 1, sourceMessageId: "msg-other" },
    ];
    const { kept, removed } = removeVoiceExemplarsForMessage(history, {
      id: "msg-1",
      content: sharedLine,
    });
    expect(removed).toBe(0);
    expect(kept).toEqual(history);
  });

  it("reports an accurate removed count across a mixed history", () => {
    const history: VoiceExemplar[] = [
      { line: "kept: unrelated text", atClockMinutes: 1, sourceMessageId: null },
      { line: "removed by id", atClockMinutes: 2, sourceMessageId: "msg-1" },
      { line: "removed by text match", atClockMinutes: 3, sourceMessageId: null },
      { line: "kept: other message's provenance", atClockMinutes: 4, sourceMessageId: "msg-2" },
    ];
    const { kept, removed } = removeVoiceExemplarsForMessage(history, {
      id: "msg-1",
      content: "this message contains removed by text match verbatim",
    });
    expect(removed).toBe(2);
    expect(kept).toEqual([
      { line: "kept: unrelated text", atClockMinutes: 1, sourceMessageId: null },
      { line: "kept: other message's provenance", atClockMinutes: 4, sourceMessageId: "msg-2" },
    ]);
  });
});
