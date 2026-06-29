import { describe, expect, it } from "vitest";
import { stripNarratorArtifacts, stripNarratorArtifactStream } from "./narrator-artifacts";

/** Feed an array of deltas through the streaming stripper and join the result. */
async function streamStrip(chunks: string[]): Promise<string> {
  async function* gen(): AsyncGenerator<string> {
    for (const c of chunks) yield c;
  }
  let out = "";
  for await (const piece of stripNarratorArtifactStream(gen())) out += piece;
  return out;
}

describe("stripNarratorArtifacts (one-shot)", () => {
  it("removes every observed Aion tag variant, opening and closing", () => {
    for (const tag of [
      "</unsensored_response>",
      "</uncensored_response>",
      "</censored_response>",
      "<uncensored_response>",
      "<unsensored_response>",
    ]) {
      // The leading whitespace glued to the tag is consumed with it.
      expect(stripNarratorArtifacts(`[Mara] "Stay." ${tag}`)).toBe('[Mara] "Stay."');
    }
  });

  it("strips multiple tags and is case-insensitive", () => {
    expect(stripNarratorArtifacts("<UNCENSORED_RESPONSE>hi</Unsensored_Response>")).toBe("hi");
  });

  it("leaves prose with ordinary angle brackets untouched", () => {
    expect(stripNarratorArtifacts("she muttered 2 < 3 and drew a <3")).toBe("she muttered 2 < 3 and drew a <3");
  });
});

describe("stripNarratorArtifactStream", () => {
  it("removes a trailing tag emitted as its own chunk", async () => {
    expect(await streamStrip(['[Mara] "Goodbye."', "</unsensored_response>"])).toBe('[Mara] "Goodbye."');
  });

  it("removes a tag split across delta boundaries", async () => {
    expect(await streamStrip(["done.", "</uncen", "sored_res", "ponse>"])).toBe("done.");
    expect(await streamStrip(["done.", "<", "/", "censored_response", ">"])).toBe("done.");
  });

  it("absorbs the newline that immediately precedes a stripped tag (no blank tail)", async () => {
    expect(await streamStrip(['[Mara] "Stay close."\n</unsensored_response>'])).toBe('[Mara] "Stay close."');
  });

  it("preserves all non-tag text, including lone angle brackets", async () => {
    const chunks = ["if x ", "< y then ", "draw <3 ", "and stop"];
    expect(await streamStrip(chunks)).toBe("if x < y then draw <3 and stop");
  });

  it("preserves a complete non-tag element split across chunks", async () => {
    expect(await streamStrip(["hello <", "world> there"])).toBe("hello <world> there");
  });

  it("flushes a held partial that never completes into a tag", async () => {
    // "</cen" looks like the start of </censored_response> but the stream ends — emit it.
    expect(await streamStrip(["bye ", "</cen"])).toBe("bye </cen");
  });

  it("strips a tag in the middle of the stream and keeps the rest", async () => {
    expect(await streamStrip(["a ", "</censored_response>", " b"])).toBe("a  b");
  });
});
