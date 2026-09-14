import { describe, expect, it } from "vitest";
import { inlineDispositionHeader, parseMediaRange, type MediaRange } from "./media-preview";

const SIZE = 26;
const WHOLE: MediaRange = { kind: "whole" };
const UNSATISFIABLE: MediaRange = { kind: "unsatisfiable" };

function bounded(start: number, end: number): MediaRange {
  return { kind: "bounded", start, end };
}

describe("parseMediaRange", () => {
  it.each([
    { label: "no header at all", header: null, expected: WHOLE },
    { label: "an empty header", header: "", expected: WHOLE },
    { label: "a player's opening request", header: "bytes=0-", expected: bounded(0, 25) },
    { label: "a single byte", header: "bytes=0-0", expected: bounded(0, 0) },
    { label: "the last byte", header: "bytes=25-25", expected: bounded(25, 25) },
    { label: "an interior window", header: "bytes=4-8", expected: bounded(4, 8) },
    { label: "an open-ended seek", header: "bytes=10-", expected: bounded(10, 25) },
    { label: "an end past the last byte", header: "bytes=20-999", expected: bounded(20, 25) },
    { label: "a suffix", header: "bytes=-5", expected: bounded(21, 25) },
    { label: "a suffix longer than the file", header: "bytes=-999", expected: bounded(0, 25) },
    { label: "the whole file asked for exactly", header: "bytes=0-25", expected: bounded(0, 25) },
    { label: "a case-insensitive unit", header: "BYTES=0-1", expected: bounded(0, 1) },
    { label: "surrounding whitespace", header: "  bytes= 0 - 1 ", expected: bounded(0, 1) },
    { label: "a zero-length suffix", header: "bytes=-0", expected: UNSATISFIABLE },
    { label: "a start at the size", header: "bytes=26-", expected: UNSATISFIABLE },
    { label: "a window past the end", header: "bytes=99-200", expected: UNSATISFIABLE },
    { label: "an unknown range unit", header: "items=0-1", expected: WHOLE },
    { label: "a multi-range request", header: "bytes=0-1,4-5", expected: WHOLE },
    { label: "an inverted range", header: "bytes=5-3", expected: WHOLE },
    { label: "a specifier with no dash", header: "bytes=5", expected: WHOLE },
    { label: "a specifier with two dashes", header: "bytes=1-2-3", expected: WHOLE },
    { label: "an empty specifier", header: "bytes=", expected: WHOLE },
    { label: "a bare dash", header: "bytes=-", expected: WHOLE },
    { label: "a non-numeric position", header: "bytes=abc-def", expected: WHOLE },
    { label: "a signed position", header: "bytes=+1-2", expected: WHOLE },
    { label: "a fractional position", header: "bytes=1.5-2", expected: WHOLE },
    { label: "an exponent", header: "bytes=-1e3", expected: WHOLE },
    { label: "an offset too large to be exact", header: "bytes=90071992547409911-", expected: WHOLE },
  ])("resolves $label", ({ header, expected }) => {
    expect(parseMediaRange(header, SIZE)).toEqual(expected);
  });

  it("never returns a window outside the file", () => {
    // The property the 206 rests on: whatever a client asks for, a bounded
    // answer stays inside the descriptor the size was stat-ed from, so no
    // arithmetic here can address a neighbouring byte.
    for (const header of ["bytes=0-", "bytes=-999", "bytes=0-999", "bytes=25-25", "bytes=24-"]) {
      const range = parseMediaRange(header, SIZE);
      expect(range.kind).toBe("bounded");
      if (range.kind !== "bounded") continue;
      expect(range.start).toBeGreaterThanOrEqual(0);
      expect(range.end).toBeLessThan(SIZE);
      expect(range.end).toBeGreaterThanOrEqual(range.start);
    }
  });

  describe("a zero-byte file", () => {
    it("has no byte any range can name", () => {
      expect(parseMediaRange("bytes=0-", 0)).toEqual(UNSATISFIABLE);
      expect(parseMediaRange("bytes=0-0", 0)).toEqual(UNSATISFIABLE);
      expect(parseMediaRange("bytes=-1", 0)).toEqual(UNSATISFIABLE);
    });

    it("is still served whole when no range is asked for", () => {
      expect(parseMediaRange(null, 0)).toEqual(WHOLE);
    });
  });
});

describe("inlineDispositionHeader", () => {
  it("carries a plain name in both forms", () => {
    expect(inlineDispositionHeader("clip.mp4")).toBe('inline; filename="clip.mp4"; filename*=UTF-8\'\'clip.mp4');
  });

  it("cannot be broken out of by a quote or a backslash", () => {
    expect(inlineDispositionHeader('a"b\\c.png')).toBe(
      'inline; filename="a_b_c.png"; filename*=UTF-8\'\'a%22b%5Cc.png',
    );
  });

  it("keeps a non-ASCII name in filename* and a safe stand-in in filename", () => {
    expect(inlineDispositionHeader("café.mp3")).toBe(
      'inline; filename="caf_.mp3"; filename*=UTF-8\'\'caf%C3%A9.mp3',
    );
    expect(inlineDispositionHeader("曲")).toBe('inline; filename="_"; filename*=UTF-8\'\'%E6%9B%B2');
  });

  it("percent-escapes the characters encodeURIComponent leaves behind", () => {
    expect(inlineDispositionHeader("it's (a) clip!*.mp3")).toBe(
      'inline; filename="it\'s (a) clip!*.mp3"; filename*=UTF-8\'\'it%27s%20%28a%29%20clip%21%2A.mp3',
    );
  });
});
