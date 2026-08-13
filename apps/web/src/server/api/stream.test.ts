import { describe, expect, it, vi } from "vitest";
import { pacedTextReveal, type PacedTextRevealOptions } from "./stream";

async function collect(text: string, options?: PacedTextRevealOptions): Promise<string[]> {
  const chunks: string[] = [];
  for await (const chunk of pacedTextReveal(text, options)) chunks.push(chunk);
  return chunks;
}

describe("pacedTextReveal", () => {
  it("preserves approved prose exactly and waits only between chunks", async () => {
    const prose = "  First line.\n\nSecond line with  spaces.\n";
    const wait = vi.fn(async (_delayMs: number) => undefined);
    const chunks = await collect(prose, { targetChunkChars: 8, delayMs: 7, wait });

    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.join("")).toBe(prose);
    expect(wait).toHaveBeenCalledTimes(chunks.length - 1);
    expect(wait).toHaveBeenCalledWith(7);
  });

  it("emits nothing for empty prose", async () => {
    const wait = vi.fn(async (_delayMs: number) => undefined);

    expect(await collect("", { wait })).toEqual([]);
    expect(wait).not.toHaveBeenCalled();
  });

  it("rejects invalid pacing options", async () => {
    await expect(collect("text", { targetChunkChars: 0 })).rejects.toThrow("targetChunkChars");
    await expect(collect("text", { delayMs: -1 })).rejects.toThrow("delayMs");
  });
});
