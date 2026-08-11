import { describe, expect, it } from "vitest";
import { compileReferenceRolePrompt } from "./reference-role-prompt";

const BASE = "Seated on the balcony rail at dusk, wind in the hair.";

/** The closing clause's tell — asserted by fragment so a copy edit inside the
 * sentence still fails loudly here, where the change is a comparison-identity
 * change, not silently. */
const CONTROL_CLAUSE_FRAGMENT = "never render the control images themselves";

describe("compileReferenceRolePrompt", () => {
  it("names a wardrobe reference as clothing to copy onto the subject", () => {
    const compiled = compileReferenceRolePrompt({ basePrompt: BASE, roles: ["identity", "outfit"] });
    expect(compiled.startsWith("Image 1: the identity reference")).toBe(true);
    expect(compiled).toContain("Image 2: the wardrobe reference — dress the subject in exactly this clothing.");
    expect(compiled).toContain("take nothing else from it");
    expect(compiled.endsWith(BASE)).toBe(true);
  });

  it("treats an outfit as content, not a control: no closing control clause", () => {
    // The clause exists for structural maps a model might render instead of
    // obey. A wardrobe reference is drawn FROM, so emitting the clause for it
    // would tell the model its outfit image "defines layout only" — a lie that
    // costs the garment.
    const compiled = compileReferenceRolePrompt({ basePrompt: BASE, roles: ["identity", "outfit"] });
    expect(compiled).not.toContain(CONTROL_CLAUSE_FRAGMENT);
  });

  it("keeps the closing clause when a structural control rides beside the outfit", () => {
    const compiled = compileReferenceRolePrompt({ basePrompt: BASE, roles: ["identity", "pose", "outfit"] });
    expect(compiled).toContain("Image 2: a pose skeleton.");
    expect(compiled).toContain("Image 3: the wardrobe reference");
    expect(compiled).toContain(CONTROL_CLAUSE_FRAGMENT);
  });
});
