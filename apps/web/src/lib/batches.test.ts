import { describe, expect, it } from "vitest";
import { runInBatches } from "./batches";

describe("runInBatches", () => {
  it("counts every item that completed", async () => {
    const seen: number[] = [];
    const done = await runInBatches([1, 2, 3, 4, 5, 6, 7], 5, async (n) => {
      await Promise.resolve();
      seen.push(n);
    });
    expect(done).toBe(7);
    expect(seen.sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5, 6, 7]);
  });

  it("swallows a rejection and keeps going — one failure never aborts the batch", async () => {
    const seen: number[] = [];
    const done = await runInBatches([1, 2, 3, 4], 2, async (n) => {
      seen.push(n);
      await Promise.resolve();
      if (n === 2) throw new Error("provider failed");
    });
    // Every item still ran; only the failed one is uncounted.
    expect(seen).toEqual([1, 2, 3, 4]);
    expect(done).toBe(3);
  });

  it("runs at most `size` items at once and starts a batch only after the previous settles", async () => {
    const order: string[] = [];
    let inFlight = 0;
    let peak = 0;
    const done = await runInBatches([0, 1, 2, 3, 4, 5, 6], 3, async (n) => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      order.push(`start:${n}`);
      await Promise.resolve();
      await Promise.resolve();
      inFlight -= 1;
      order.push(`end:${n}`);
    });
    expect(done).toBe(7);
    expect(peak).toBe(3);
    // The batch boundary: nothing from the second batch starts before the first
    // one has fully finished.
    expect(order.indexOf("start:3")).toBeGreaterThan(order.indexOf("end:2"));
    expect(order.indexOf("start:6")).toBeGreaterThan(order.indexOf("end:5"));
  });

  it("does no work and returns 0 for an empty list", async () => {
    let calls = 0;
    const done = await runInBatches([], 5, async () => {
      calls += 1;
      await Promise.resolve();
    });
    expect(done).toBe(0);
    expect(calls).toBe(0);
  });

  it("degrades a size below 1 to one item at a time instead of looping forever", async () => {
    let inFlight = 0;
    let peak = 0;
    const done = await runInBatches([1, 2, 3], 0, async () => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await Promise.resolve();
      inFlight -= 1;
    });
    expect(done).toBe(3);
    expect(peak).toBe(1);
  });
});
