import { describe, expect, it } from "vitest";
import sharp from "sharp";
import { monogramSvg } from "./monogram";

describe("monogramSvg", () => {
  it("is deterministic for the same name", () => {
    expect(monogramSvg("Mira Vale").equals(monogramSvg("Mira Vale"))).toBe(true);
  });

  it("differs between names", () => {
    expect(monogramSvg("Mira Vale").equals(monogramSvg("Ashen Reed"))).toBe(false);
  });

  it("contains uppercased initials of the first two words", () => {
    const svg = monogramSvg("mira vale stormwood").toString("utf8");
    expect(svg).toContain(">MV</text>");
  });

  it("escapes XML-hostile names and tolerates empty input", () => {
    expect(monogramSvg("<script> &x").toString("utf8")).toContain("&lt;");
    expect(monogramSvg("   ").toString("utf8")).toContain(">?</text>");
  });

  it("rasterizes to webp at 3:4 via sharp (the saveImageBuffer path)", async () => {
    const { info } = await sharp(monogramSvg("Mira")).webp().toBuffer({ resolveWithObject: true });
    expect(info.format).toBe("webp");
    expect(info.width).toBe(768);
    expect(info.height).toBe(1024);
  });
});
