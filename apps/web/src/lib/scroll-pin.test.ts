import { describe, expect, it } from "vitest";
import { isPinnedToBottom, prependRestoreTop } from "./scroll-pin";

describe("isPinnedToBottom", () => {
  it("pins at the exact bottom", () => {
    expect(isPinnedToBottom({ scrollHeight: 1000, scrollTop: 600, clientHeight: 400 }, 40)).toBe(true);
  });

  it("pins within the slack", () => {
    expect(isPinnedToBottom({ scrollHeight: 1000, scrollTop: 561, clientHeight: 400 }, 40)).toBe(true);
  });

  it("releases past the slack", () => {
    expect(isPinnedToBottom({ scrollHeight: 1000, scrollTop: 559, clientHeight: 400 }, 40)).toBe(false);
  });

  it("counts an unscrollable box as pinned (content shorter than the viewport)", () => {
    expect(isPinnedToBottom({ scrollHeight: 300, scrollTop: 0, clientHeight: 400 }, 40)).toBe(true);
  });
});

describe("prependRestoreTop", () => {
  it("keeps the viewport on the same rows after a prepend", () => {
    // 500px of history prepended above: the restore point moves down by exactly that growth.
    expect(prependRestoreTop({ height: 1000, top: 120 }, 1500)).toBe(620);
  });

  it("is the identity when nothing was prepended", () => {
    expect(prependRestoreTop({ height: 1000, top: 120 }, 1000)).toBe(120);
  });

  it("restores a top-of-transcript reader to the start of the new page", () => {
    expect(prependRestoreTop({ height: 800, top: 0 }, 2000)).toBe(1200);
  });
});
