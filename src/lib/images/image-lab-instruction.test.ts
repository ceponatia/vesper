import { describe, expect, it } from "vitest";
import { imageLabControlKinds } from "@/contracts";
import {
  imageLabControlRole,
  imageLabFinishingInstruction,
  imageLabProbeInstruction,
} from "./image-lab-instruction";

describe("imageLabControlRole", () => {
  it("feeds every kind under its own reference role", () => {
    // One-to-one since `edge` joined `imageReferenceRoles` with the control-role
    // slice. Edge maps used to ride the generic `control`, which meant a profile
    // could not require an edge map specifically.
    expect(imageLabControlRole("pose")).toBe("pose");
    expect(imageLabControlRole("depth")).toBe("depth");
    expect(imageLabControlRole("edge")).toBe("edge");
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

describe("imageLabFinishingInstruction", () => {
  it("names both halves of the promotion rule: correct the face, keep everything else", () => {
    const text = imageLabFinishingInstruction("");
    expect(text).toContain("Refine only the identity in the before image");
    // The plan's own list — a pass that moved any of these is not promotable, so
    // the instruction has to have asked for each of them by name.
    for (const kept of ["pose", "body proportions", "clothing", "camera angle", "lighting", "setting"]) {
      expect(text).toContain(kept);
    }
  });

  it("keeps hair on the identity side, where the drift it must fix lives", () => {
    expect(imageLabFinishingInstruction("")).toContain("hairline and hair colour");
  });

  it("sends the rule alone when the admin writes nothing", () => {
    expect(imageLabFinishingInstruction("   ")).toBe(imageLabFinishingInstruction(""));
  });

  it("appends the admin's note after the rule rather than replacing it", () => {
    const text = imageLabFinishingInstruction("  the left eye is drifting  ");
    expect(text.startsWith(imageLabFinishingInstruction(""))).toBe(true);
    expect(text.endsWith("the left eye is drifting")).toBe(true);
  });
});
