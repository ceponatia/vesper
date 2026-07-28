import { describe, expect, it } from "vitest";
import { expectCleanSink, expectDiagnostics } from "@/test/diagnostics";
import { DiagnosticCollector } from "../diagnostics";
import {
  DEFAULT_FACT_CHANNEL,
  factChannelReachesNarrator,
  factDraftSchema,
  NARRATOR_VISIBLE_FACT_CHANNELS,
  parseFactChannel,
} from "./taxonomy";

const base = {
  kind: "relationship",
  subjectName: "Mara",
  subjectKind: "character",
  text: "Mara trusts the player with her workshop key.",
  tags: ["trust"],
  confidence: 0.8,
};

describe("factDraftSchema degradation", () => {
  it("parses a well-formed draft unchanged", () => {
    const draft = factDraftSchema.parse(base);
    expect(draft.kind).toBe("relationship");
    expect(draft.confidence).toBe(0.8);
    expect(draft.tags).toEqual(["trust"]);
    expect(draft.verb).toBeUndefined();
  });

  it("catches an unknown kind to knowledge", () => {
    const draft = factDraftSchema.parse({ ...base, kind: "vibes" });
    expect(draft.kind).toBe("knowledge");
  });

  it("catches an unknown verb to undefined", () => {
    const draft = factDraftSchema.parse({ ...base, verb: "dance_wildly" });
    expect(draft.verb).toBeUndefined();
  });

  it("keeps a known verb", () => {
    const draft = factDraftSchema.parse({ ...base, verb: "promise" });
    expect(draft.verb).toBe("promise");
  });

  it("catches an unknown subjectKind to character", () => {
    const draft = factDraftSchema.parse({ ...base, subjectKind: "deity" });
    expect(draft.subjectKind).toBe("character");
  });

  it("catches out-of-range and non-numeric confidence to 0.5", () => {
    expect(factDraftSchema.parse({ ...base, confidence: 1.5 }).confidence).toBe(0.5);
    expect(factDraftSchema.parse({ ...base, confidence: -0.1 }).confidence).toBe(0.5);
    expect(factDraftSchema.parse({ ...base, confidence: "high" }).confidence).toBe(0.5);
  });

  it("lowercases tags and defaults a missing array", () => {
    const { tags, ...withoutTags } = base;
    void tags;
    expect(factDraftSchema.parse({ ...base, tags: ["Trust", "WORKSHOP"] }).tags).toEqual(["trust", "workshop"]);
    expect(factDraftSchema.parse(withoutTags).tags).toEqual([]);
  });

  it("still rejects drafts missing required free-text fields", () => {
    // No catch on subjectName/text: an empty draft is a boundary failure
    // handled by parseOr upstream, not silently invented here.
    expect(factDraftSchema.safeParse({ ...base, subjectName: "" }).success).toBe(false);
    expect(factDraftSchema.safeParse({ ...base, text: "" }).success).toBe(false);
  });

  it("carries a channel through, defaulting to undefined when absent (validated at the write boundary)", () => {
    expect(factDraftSchema.parse(base).channel).toBeUndefined();
    expect(factDraftSchema.parse({ ...base, channel: "private" }).channel).toBe("private");
    // A raw (even unknown) string passes through — the fact is kept; the write boundary validates it.
    expect(factDraftSchema.parse({ ...base, channel: "telepathic" }).channel).toBe("telepathic");
    // A non-string catches to undefined ⇒ the perceived default downstream (never drops the fact).
    expect(factDraftSchema.parse({ ...base, channel: 7 }).channel).toBeUndefined();
    expect(factDraftSchema.safeParse({ ...base, channel: "private" }).success).toBe(true);
  });
});

describe("parseFactChannel — the fact-channel trust boundary (slice 6)", () => {
  it("passes a known channel through with no diagnostic", () => {
    const sink = new DiagnosticCollector();
    expect(parseFactChannel("private", sink)).toBe("private");
    expect(parseFactChannel("ooc", sink)).toBe("ooc");
    expect(parseFactChannel("perceived", sink)).toBe("perceived");
    expectCleanSink(sink);
  });

  it("degrades a missing/absent channel to perceived SILENTLY (ordinary un-classified write)", () => {
    const sink = new DiagnosticCollector();
    expect(parseFactChannel(undefined, sink)).toBe(DEFAULT_FACT_CHANNEL);
    expect(parseFactChannel(null, sink)).toBe(DEFAULT_FACT_CHANNEL);
    expect(parseFactChannel("", sink)).toBe(DEFAULT_FACT_CHANNEL);
    expectCleanSink(sink);
  });

  it("degrades an UNKNOWN channel to perceived WITH a boundary diagnostic (fail closed)", () => {
    const sink = new DiagnosticCollector();
    expect(parseFactChannel("telepathic", sink, "facts.channel")).toBe(DEFAULT_FACT_CHANNEL);
    expectDiagnostics(sink, ["parse.boundary_failed"]);
    expect(sink.items[0]?.path, "the diagnostic must name the boundary it failed at").toBe("facts.channel");
  });
});

describe("factChannelReachesNarrator — the RAG visibility fence (slice 6)", () => {
  it("admits only perceived facts to the narrator; private + ooc are fenced out", () => {
    expect(factChannelReachesNarrator("perceived")).toBe(true);
    expect(factChannelReachesNarrator("private")).toBe(false);
    expect(factChannelReachesNarrator("ooc")).toBe(false);
  });

  it("derives the narrator-visible channel set as exactly [perceived]", () => {
    expect(NARRATOR_VISIBLE_FACT_CHANNELS).toEqual(["perceived"]);
  });
});
