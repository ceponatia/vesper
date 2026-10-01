import { describe, expect, it } from "vitest";
import { attributeRegistry } from "../attributes";
import type { AttributeValue } from "../attributes/value";
import {
  bodyReferenceAttributes,
  bodyReferenceSetKey,
  bodyReferenceSlots,
  bodyReferenceUploadRequestSchema,
  bodyReferenceUse,
  bodyReferenceWithheld,
  defaultBodyReferenceTag,
  parseBodyReferenceSlot,
  referenceViewBodyReferences,
  referenceViewBodySetKey,
  sendableBodyReferences,
  type BodyReferenceImage,
} from "./body-references";
import { characterAppearanceAspect } from "./character-adapter";
import { allReferenceViews, referenceViewWardrobeById } from "./reference-views";
import { VISUAL_IMAGE_AGE_ATTRIBUTE_ID } from "./visual-digest";

/**
 * The body-image rules (#671), every one of them silent in a passing render:
 *
 * - **Routing.** A dressed view sends every body image, dressed ones first; an
 *   undressed view sends the undressed ones only. Derived over the whole sheet
 *   and the wardrobe registry's own `intimate` flag, so a new angle or
 *   wardrobe is checked by the same rule.
 * - **The adult gate.** An undressed image is withheld from every render for a
 *   character who fails the undressed views' own gate.
 * - **The set key.** Any add, replace, remove or re-tag changes it, and no
 *   image at all is null — the value every pre-existing view row stores.
 */

// The return annotation keeps the id its registry literal: in a bare object
// literal it would widen to `string`, which no attribute id pattern accepts.
const ageAttribute = (value: string): AttributeValue => ({ id: VISUAL_IMAGE_AGE_ATTRIBUTE_ID, value, source: "creation" });
const adult = { attributes: [ageAttribute("eighteen")] };
const minor = { attributes: [ageAttribute("teen")] };
const unresolved = { attributes: [] as AttributeValue[] };

const UNCLOTHED_1: BodyReferenceImage = { slot: 1, imageId: "img-a", tag: "unclothed" };
const CLOTHED_2: BodyReferenceImage = { slot: 2, imageId: "img-b", tag: "clothed" };

describe("the slots", () => {
  it("parses exactly the vocabulary's slots from a URL segment, so a third has nowhere to go", () => {
    for (const slot of bodyReferenceSlots) expect(parseBodyReferenceSlot(String(slot))).toBe(slot);
    for (const segment of ["0", "3", "1.0", "one", ""]) expect(parseBodyReferenceSlot(segment)).toBeNull();
  });

  it("starts the first image dressed and the second undressed", () => {
    expect(bodyReferenceSlots.map(defaultBodyReferenceTag)).toEqual(["clothed", "unclothed"]);
  });
});

describe("what may be sent", () => {
  it("withholds an undressed image unless the character passes the adult gate, and never a dressed one", () => {
    expect(bodyReferenceWithheld(UNCLOTHED_1, adult)).toBe(false);
    expect(bodyReferenceWithheld(UNCLOTHED_1, minor)).toBe(true);
    expect(bodyReferenceWithheld(UNCLOTHED_1, unresolved)).toBe(true);
    for (const profile of [adult, minor, unresolved]) expect(bodyReferenceWithheld(CLOTHED_2, profile)).toBe(false);
  });

  it("sends in slot order, whatever order the rows arrive in", () => {
    expect(sendableBodyReferences([CLOTHED_2, UNCLOTHED_1], adult)).toEqual([UNCLOTHED_1, CLOTHED_2]);
    expect(sendableBodyReferences([CLOTHED_2, UNCLOTHED_1], minor)).toEqual([CLOTHED_2]);
  });
});

describe("the body-image set a view is rendered against", () => {
  const key = (images: readonly BodyReferenceImage[]) => bodyReferenceSetKey(images);

  it("is null for no image — the empty set every earlier view row records", () => {
    expect(key([])).toBeNull();
  });

  it("moves on every add, replace, remove and re-tag, and not on row order", () => {
    const base = key([UNCLOTHED_1, CLOTHED_2]);
    const changes: readonly BodyReferenceImage[][] = [
      [UNCLOTHED_1],
      [UNCLOTHED_1, { ...CLOTHED_2, imageId: "img-c" }],
      [UNCLOTHED_1, { ...CLOTHED_2, tag: "unclothed" }],
      [CLOTHED_2],
    ];
    for (const changed of changes) expect(key(changed)).not.toBe(base);
    expect(key([CLOTHED_2, UNCLOTHED_1])).toBe(base);
  });

  it("moves when the adult gate starts withholding an undressed image", () => {
    const images = [UNCLOTHED_1, CLOTHED_2];
    expect(key(sendableBodyReferences(images, minor))).not.toBe(key(sendableBodyReferences(images, adult)));
  });

  /**
   * Per wardrobe: a view is keyed by the images ROUTED to it, so a change only
   * an undressed view never sends — a Clothed image added, replaced or removed —
   * leaves an undressed view standing, while every dressed view moves. Checked
   * over the registry's own wardrobes, so a new one is held to the same rule.
   */
  it("keys each view by the images its wardrobe takes, and nothing else", () => {
    const base = [UNCLOTHED_1, CLOTHED_2];
    const clothedOnlyChanges: readonly BodyReferenceImage[][] = [
      [UNCLOTHED_1],
      [UNCLOTHED_1, { ...CLOTHED_2, imageId: "img-c" }],
    ];
    for (const view of allReferenceViews()) {
      const viewKey = (images: readonly BodyReferenceImage[]) => referenceViewBodySetKey(view.wardrobe, images);
      // The same function the routing table answers with, keyed.
      expect(viewKey(base), `${view.angle}/${view.wardrobe}`).toBe(key(referenceViewBodyReferences(view, base)));
      const undressed = referenceViewWardrobeById(view.wardrobe)?.intimate === true;
      for (const changed of clothedOnlyChanges) {
        expect(viewKey(changed) === viewKey(base), `${view.angle}/${view.wardrobe}`).toBe(undressed);
      }
      // Re-tagging the dressed image undressed reaches every view.
      expect(viewKey([UNCLOTHED_1, { ...CLOTHED_2, tag: "unclothed" }])).not.toBe(viewKey(base));
    }
  });

  it("is null for a view no image is routed to", () => {
    expect(referenceViewBodySetKey("bare", [CLOTHED_2])).toBeNull();
    expect(referenceViewBodySetKey("clothed", [])).toBeNull();
  });
});

describe("the routing table", () => {
  // The undressed image sits in the FIRST slot, so "dressed first" is a reorder
  // a slot-order implementation would fail.
  const sendable = [UNCLOTHED_1, CLOTHED_2];

  it.each(allReferenceViews().map((view) => [`${view.angle}/${view.wardrobe}`, view] as const))(
    "sends %s the images its wardrobe takes",
    (_label, view) => {
      const routed = referenceViewBodyReferences(view, sendable).map((image) => image.imageId);
      if (referenceViewWardrobeById(view.wardrobe)?.intimate === true) {
        expect(routed).toEqual([UNCLOTHED_1.imageId]);
      } else {
        expect(routed).toEqual([CLOTHED_2.imageId, UNCLOTHED_1.imageId]);
      }
    },
  );

  it("keeps slot order within a tag, whatever order the images arrive in", () => {
    const clothed1: BodyReferenceImage = { slot: 1, imageId: "img-c", tag: "clothed" };
    const routed = referenceViewBodyReferences({ angle: "back_full", wardrobe: "clothed" }, [CLOTHED_2, clothed1]);
    expect(routed.map((image) => image.imageId)).toEqual([clothed1.imageId, CLOTHED_2.imageId]);
  });

  it("sends nothing for a wardrobe the registry dropped", () => {
    expect(referenceViewBodyReferences({ angle: "front_full", wardrobe: "sheer" as never }, sendable)).toEqual([]);
  });
});

describe("the character's body, in words", () => {
  it("states exactly the registry's build-aspect attributes the character has, in registry words", () => {
    const build = attributeRegistry.definitions.filter((definition) => characterAppearanceAspect(definition.id) === "build");
    const other = attributeRegistry.definitions.find((definition) => characterAppearanceAspect(definition.id) === "hair");
    const first = build[0];
    if (first === undefined || other === undefined) throw new Error("the registry has no build or hair attribute");
    // Any stored member that renders — "none" is elided from prompts by design.
    const sample = (definition: typeof first): AttributeValue => ({
      id: definition.id,
      value: definition.allowedValues?.find((value) => value !== "none") ?? "tall",
      source: "creation",
    });

    const stated = bodyReferenceAttributes([sample(first), sample(other)]);

    expect(stated.map((entry) => entry.id)).toEqual([first.id]);
    expect(stated[0]?.label).toBe(first.label);
    expect(stated[0]?.value.length).toBeGreaterThan(0);
    for (const entry of bodyReferenceAttributes(build.map(sample))) {
      expect(characterAppearanceAspect(entry.id)).toBe("build");
    }
  });
});

describe("the upload wire", () => {
  it("requires a tag and says which image it replaces — null for an empty slot", () => {
    const dataUrl = "data:image/jpeg;base64,AAAA";
    expect(bodyReferenceUploadRequestSchema.safeParse({ dataUrl, tag: "clothed", expectedImageId: null }).success).toBe(true);
    expect(bodyReferenceUploadRequestSchema.safeParse({ dataUrl, expectedImageId: null }).success).toBe(false);
    expect(bodyReferenceUploadRequestSchema.safeParse({ dataUrl, tag: "clothed" }).success).toBe(false);
    expect(bodyReferenceUploadRequestSchema.safeParse({ dataUrl, tag: "nude", expectedImageId: null }).success).toBe(false);
  });
});

describe("what the studio says an image is used for", () => {
  it.each([
    // tag, routes, unused, partial
    ["clothed", { clothed: true, bare: true }, false, null],
    ["clothed", { clothed: true, bare: false }, false, null],
    ["clothed", { clothed: false, bare: true }, true, null],
    ["unclothed", { clothed: true, bare: true }, false, null],
    ["unclothed", { clothed: true, bare: false }, false, "clothed_only"],
    ["unclothed", { clothed: false, bare: true }, false, "bare_only"],
    ["unclothed", { clothed: false, bare: false }, true, null],
  ] as const)("a %s image under %o: unused %s, partial %s", (tag, routes, unused, partial) => {
    expect(bodyReferenceUse(tag, routes)).toEqual({ unused, partial });
  });

  it("claims nothing when the route could not be read", () => {
    for (const tag of ["clothed", "unclothed"] as const) expect(bodyReferenceUse(tag, null)).toEqual({ unused: false, partial: null });
  });
});
