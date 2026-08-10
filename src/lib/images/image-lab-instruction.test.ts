import { describe, expect, it } from "vitest";
import { imageLabControlKinds } from "@/contracts";
import { imageLabControlRole, imageLabProbeInstruction } from "./image-lab-instruction";

describe("imageLabControlRole", () => {
  it("feeds pose and depth under their own roles and edge under the generic control role", () => {
    expect(imageLabControlRole("pose")).toBe("pose");
    expect(imageLabControlRole("depth")).toBe("depth");
    expect(imageLabControlRole("edge")).toBe("control");
  });
});

describe("imageLabProbeInstruction", () => {
  it("binds identity and control to the positions they are sent at", () => {
    const text = imageLabProbeInstruction({ controlKind: "pose", identityPosition: 1, controlPosition: 2 });
    expect(text).toContain("Image 1 is the identity reference");
    expect(text).toContain("Image 2 is a pose skeleton diagram");
    expect(text).toContain("the person from Image 1");
  });

  it("renumbers when the control is sent first", () => {
    const text = imageLabProbeInstruction({ controlKind: "depth", identityPosition: 2, controlPosition: 1 });
    expect(text).toContain("Image 2 is the identity reference");
    expect(text).toContain("Image 1 is a depth map");
    expect(text).not.toContain("Image 3");
  });

  it("drops the identity binding when the probe sends no identity reference", () => {
    const text = imageLabProbeInstruction({ controlKind: "edge", identityPosition: null, controlPosition: 1 });
    expect(text).not.toContain("identity reference");
    expect(text).toContain("Render the person so that the outline");
  });

  it("tells every kind apart, and always says the control carries structure only", () => {
    const texts = imageLabControlKinds.map((controlKind) =>
      imageLabProbeInstruction({ controlKind, identityPosition: 1, controlPosition: 2 }),
    );
    expect(new Set(texts).size).toBe(imageLabControlKinds.length);
    for (const text of texts) {
      expect(text).toContain("not a person and not a style reference");
      expect(text).toContain("it carries structure only");
    }
  });
});
