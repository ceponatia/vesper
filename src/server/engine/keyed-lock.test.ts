import { describe, expect, it } from "vitest";
import { keyedLockBusy, tryKeyedLock, withKeyedLock } from "./keyed-lock";

const tick = () => new Promise<void>((r) => setTimeout(r, 0));

describe("withKeyedLock", () => {
  it("serializes concurrent work on the same key, FIFO", async () => {
    const order: number[] = [];
    const slow = withKeyedLock("k", async () => {
      await tick();
      order.push(1);
    });
    const fast = withKeyedLock("k", async () => {
      order.push(2);
    });
    await Promise.all([slow, fast]);
    expect(order).toEqual([1, 2]);
  });

  it("does not serialize distinct keys", async () => {
    const order: number[] = [];
    const a = withKeyedLock("a", async () => {
      await tick();
      await tick();
      order.push(1);
    });
    const b = withKeyedLock("b", async () => {
      order.push(2);
    });
    await Promise.all([a, b]);
    expect(order).toEqual([2, 1]);
  });

  it("releases the key after a throwing holder, and cleans up", async () => {
    await expect(withKeyedLock("k", () => Promise.reject(new Error("boom")))).rejects.toThrow("boom");
    expect(keyedLockBusy("k")).toBe(false);
    await expect(withKeyedLock("k", () => Promise.resolve("ok"))).resolves.toBe("ok");
  });
});

describe("tryKeyedLock", () => {
  it("returns null while the key is held, acquires when free", async () => {
    let releaseHolder!: () => void;
    const gate = new Promise<void>((r) => (releaseHolder = r));
    const holder = withKeyedLock("k", () => gate);
    expect(tryKeyedLock("k", () => Promise.resolve("second"))).toBeNull();
    releaseHolder();
    await holder;
    await expect(tryKeyedLock("k", () => Promise.resolve("second"))).resolves.toBe("second");
  });

  it("two synchronous try-acquires: only the first wins", async () => {
    const first = tryKeyedLock("k", async () => {
      await tick();
      return "first";
    });
    const second = tryKeyedLock("k", () => Promise.resolve("second"));
    expect(first).not.toBeNull();
    expect(second).toBeNull();
    await expect(first).resolves.toBe("first");
  });
});
