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

  it("cuts a trailing parser-note block, including its leading blank line (forge-gaps gap 7)", () => {
    const reply = 'She sets the mug down. "Nutmeg."\n\nNote for the parser: This response accepts the offer of hospitality and moves the scene forward.';
    expect(stripNarratorArtifacts(reply)).toBe('She sets the mug down. "Nutmeg."');
  });

  it("cuts decorated and addressed variants at a line start", () => {
    expect(stripNarratorArtifacts('done.\n**Note to the system:** kept her guarded.')).toBe("done.");
    expect(stripNarratorArtifacts('done.\n(Note for the narrator: she stays.)')).toBe("done.");
    expect(stripNarratorArtifacts('done.\nParser note: ended on the reveal.')).toBe("done.");
  });

  it("a reply that IS only a meta note strips to empty", () => {
    expect(stripNarratorArtifacts("Note for the parser: nothing but commentary.")).toBe("");
  });

  it("leaves the phrase alone mid-line and in dialogue", () => {
    const prose = 'She slid a note for the parser of manifests across the desk.';
    expect(stripNarratorArtifacts(prose)).toBe(prose);
    const dialogue = '[Vae] "Leave a note for the parser, love."';
    expect(stripNarratorArtifacts(dialogue)).toBe(dialogue);
  });

  it("leaves an ordinary line that merely starts with Note intact", () => {
    const prose = "Notes of jasmine hung in the air.\nNote for the wall: unpaid tabs.";
    expect(stripNarratorArtifacts(prose)).toBe(prose);
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

  it("cuts a parser note arriving as one chunk and swallows everything after it", async () => {
    expect(await streamStrip(['"Stay."\n\nNote for the parser: meta.', " More meta.", " Even more."])).toBe('"Stay."');
  });

  it("cuts a parser note split across delta boundaries", async () => {
    expect(await streamStrip(['"Stay."\n\nNote fo', "r the par", "ser: This response accepts…"])).toBe('"Stay."');
  });

  it("releases a false start and streams the prose through intact", async () => {
    expect(await streamStrip(["Note fo", "r the record, she smiled.\nThe rain kept on."]))
      .toBe("Note for the record, she smiled.\nThe rain kept on.");
  });

  it("cuts a decorated note split mid-decoration", async () => {
    expect(await streamStrip(["done.\n", "**No", "te to the engine:** wrap up."])).toBe("done.");
  });

  it("holds then flushes a marker prefix left dangling at stream end", async () => {
    expect(await streamStrip(["bye.\n", "Note for the"])).toBe("bye.\nNote for the");
  });

  it("only cuts at line starts — mid-line phrases stream through", async () => {
    const prose = 'She slid a note for the parser of manifests across the desk.';
    expect(await streamStrip([prose.slice(0, 20), prose.slice(20)])).toBe(prose);
  });
});
