import { describe, expect, it } from "vitest";
import { selfieLabels, selfieSenderName } from "./scene-moment-attribution";

const character = (id: string, name: string) => ({ kind: "character" as const, id, name });

describe("selfie sender attribution", () => {
  // Regression (#436): a non-primary selfie is filed under the primary ("Ada")
  // but must be labelled with its own sender, taken from the scene's cast.
  it("names the sender from the lone character reference, never the primary", () => {
    const sender = selfieSenderName({ references: [character("c-bea", " Bea ")] });
    expect(sender).toBe("Bea");
    const labels = selfieLabels(sender);
    expect(labels).toEqual({ ariaLabel: "Photo from Bea", title: "A photo from Bea", alt: "Bea" });
    expect(JSON.stringify(labels)).not.toContain("Ada");
  });

  it("ignores a location reference when finding the sender", () => {
    const refs = [character("c-bea", "Bea"), { kind: "location" as const, id: "l-1", name: "Cafe" }];
    expect(selfieSenderName({ references: refs })).toBe("Bea");
  });

  it("falls back to neutral labels with no references", () => {
    const sender = selfieSenderName({ references: [] });
    expect(sender).toBeNull();
    expect(selfieLabels(sender)).toEqual({ ariaLabel: "Photo message", title: "A photo", alt: "Photo" });
  });

  it("falls back to neutral labels when two characters are referenced", () => {
    const sender = selfieSenderName({ references: [character("c-ada", "Ada"), character("c-bea", "Bea")] });
    expect(sender).toBeNull();
    const labels = selfieLabels(sender);
    expect(JSON.stringify(labels)).not.toMatch(/Ada|Bea/);
  });

  it("treats a blank name as unattributed", () => {
    expect(selfieSenderName({ references: [character("c-x", "  ")] })).toBeNull();
  });
});
