import { describe, expect, it } from "vitest";
import { fingerprintSdTrainingDataset } from "./dataset-fingerprint";
import type { SdTrainingDataset, SdTrainingImage } from "./training-manifest";

/**
 * **The dataset fingerprint is a persisted compatibility contract, and it is
 * order-independent.**
 *
 * Vesper stores this value on the identity-pack-to-LoRA binding and compares it
 * against a freshly computed one to decide whether a trained LoRA is stale
 * (sd-rendering-package.plan.md §9). Two bad implementations follow, and neither
 * of them throws:
 *
 * - **A serialization change.** Reorder the fields, swap a separator, start
 *   including something new, and every stored fingerprint stops matching — so
 *   every LoRA in the library is reported stale at once, and every character is
 *   retrained for nothing. The golden literal below is deliberate: it must fail
 *   a test rather than fail silently in production. A failure here means the
 *   format moved, not that the pin is out of date.
 * - **A sort that depends on input order.** The application assembles this list
 *   from a database read, and a query with no explicit ordering may return the
 *   same rows in a different order tomorrow. Without the permutation case, an
 *   implementation that hashed the list as given would pass every other test and
 *   mark packs stale at random.
 */

const FRONT_IMAGE: SdTrainingImage = {
  id: "img-1",
  uri: "https://example.invalid/a.png",
  view: "front",
  caption: "neutral expression",
  tags: ["daylight", "indoor"],
};

const PROFILE_IMAGE: SdTrainingImage = {
  id: "img-2",
  uri: "https://example.invalid/b.png",
  view: "profile",
};

const GOLDEN_DATASET: SdTrainingDataset = { images: [FRONT_IMAGE, PROFILE_IMAGE] };

/** The pinned output of `GOLDEN_DATASET`. Changing this line is changing the contract. */
const GOLDEN_FINGERPRINT = "13044efe";

function withFrontImage(over: Partial<SdTrainingImage>): SdTrainingDataset {
  return { images: [{ ...FRONT_IMAGE, ...over }, PROFILE_IMAGE] };
}

describe("SD training dataset fingerprint", () => {
  it("pins the serialization of a known dataset", () => {
    expect(fingerprintSdTrainingDataset(GOLDEN_DATASET)).toBe(GOLDEN_FINGERPRINT);
  });

  it("ignores the order the images arrive in", () => {
    const permuted: SdTrainingDataset = { images: [PROFILE_IMAGE, FRONT_IMAGE] };
    expect(fingerprintSdTrainingDataset(permuted)).toBe(GOLDEN_FINGERPRINT);
  });

  it.each([
    { name: "a re-captioned image", dataset: withFrontImage({ caption: "smiling" }) },
    { name: "a replaced image file", dataset: withFrontImage({ uri: "https://example.invalid/c.png" }) },
    { name: "a re-tagged image", dataset: withFrontImage({ tags: ["daylight", "outdoor"] }) },
  ])("treats $name as a different dataset", ({ dataset }) => {
    expect(fingerprintSdTrainingDataset(dataset)).not.toBe(GOLDEN_FINGERPRINT);
  });
});
