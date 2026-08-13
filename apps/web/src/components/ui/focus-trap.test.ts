import { describe, expect, it } from "vitest";
import { resolveTabTarget } from "./focus-trap";

const focusables = ["cancel", "confirm", "close"] as const;
const fallback = "panel";

describe("resolveTabTarget", () => {
  it("wraps Tab on the last focusable around to the first", () => {
    expect(resolveTabTarget({ focusables, active: "close", shiftKey: false, fallback })).toBe("cancel");
  });

  it("wraps Shift+Tab on the first focusable around to the last", () => {
    expect(resolveTabTarget({ focusables, active: "cancel", shiftKey: true, fallback })).toBe("close");
  });

  it("lets the browser handle interior moves", () => {
    expect(resolveTabTarget({ focusables, active: "cancel", shiftKey: false, fallback })).toBeNull();
    expect(resolveTabTarget({ focusables, active: "close", shiftKey: true, fallback })).toBeNull();
  });

  // Regression: Tab used to walk straight out of the dialog into the page
  // behind it — focus anywhere outside the list must be pulled back in.
  it("pulls focus from the panel or the page behind back inside", () => {
    expect(resolveTabTarget({ focusables, active: null, shiftKey: false, fallback })).toBe("cancel");
    expect(resolveTabTarget({ focusables, active: null, shiftKey: true, fallback })).toBe("close");
    expect(resolveTabTarget<string>({ focusables, active: "background-link", shiftKey: false, fallback })).toBe(
      "cancel",
    );
  });

  it("falls back to the panel when the dialog has no focusable children", () => {
    expect(resolveTabTarget<string>({ focusables: [], active: null, shiftKey: false, fallback })).toBe("panel");
  });

  it("keeps focus cycling within a single-element dialog", () => {
    expect(resolveTabTarget({ focusables: ["only"], active: "only", shiftKey: false, fallback })).toBe("only");
    expect(resolveTabTarget({ focusables: ["only"], active: "only", shiftKey: true, fallback })).toBe("only");
  });
});
