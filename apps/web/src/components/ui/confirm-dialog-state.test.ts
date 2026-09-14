import { describe, expect, it } from "vitest";
import { confirmDialogDismissal } from "./confirm-dialog-state";

describe("confirmDialogDismissal", () => {
  it("allows dismissal once nothing is running", () => {
    expect(confirmDialogDismissal({ busy: false })).toBe(true);
  });

  it("refuses dismissal while the confirmed operation is still running", () => {
    expect(confirmDialogDismissal({ busy: true })).toBe(false);
  });
});
