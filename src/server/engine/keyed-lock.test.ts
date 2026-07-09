import { describe, expect, it } from "vitest";
import { acquireKeyedLockWithin, keyedLockBusy, tryKeyedLock, withKeyedLock } from "./keyed-lock";

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

// The bounded waiting acquire behind the atomic rerun (data-loss-rerun fix): stop the
// in-flight reply, then wait a short window to re-acquire the lock — 409 (null) if it
// stays held, so the caller can bail having mutated nothing.
describe("acquireKeyedLockWithin", () => {
  it("acquires on the first attempt when the key is free", async () => {
    let attempts = 0;
    const acquired = await acquireKeyedLockWithin("w1", () => Promise.resolve("got"), {
      timeoutMs: 100,
      onAttempt: () => (attempts += 1),
    });
    expect(acquired).not.toBeNull();
    expect(attempts).toBe(1); // one try, won immediately
    await expect(acquired?.held).resolves.toBe("got");
    expect(keyedLockBusy("w1")).toBe(false);
  });

  it("waits out a held key, then acquires once it releases", async () => {
    let releaseHolder!: () => void;
    const gate = new Promise<void>((r) => (releaseHolder = r));
    const holder = withKeyedLock("w2", () => gate);
    const acquiring = acquireKeyedLockWithin("w2", () => Promise.resolve("after"), { timeoutMs: 1000, pollMs: 5 });
    setTimeout(() => releaseHolder(), 25); // free it after a few polls
    const acquired = await acquiring;
    expect(acquired).not.toBeNull();
    await holder;
    await expect(acquired?.held).resolves.toBe("after");
  });

  it("times out to null while the key stays held, mutating nothing — re-issuing onAttempt each poll", async () => {
    let releaseHolder!: () => void;
    const gate = new Promise<void>((r) => (releaseHolder = r));
    const holder = withKeyedLock("w3", () => gate);
    let attempts = 0;
    let ran = false;
    const acquired = await acquireKeyedLockWithin(
      "w3",
      () => {
        ran = true; // the protected fn must never run on a timeout (nothing mutated)
        return Promise.resolve("never");
      },
      { timeoutMs: 40, pollMs: 10, onAttempt: () => (attempts += 1) },
    );
    expect(acquired).toBeNull();
    expect(ran).toBe(false);
    expect(attempts).toBeGreaterThan(1); // stop re-issued on each poll, not just once
    releaseHolder();
    await holder;
  });
});
