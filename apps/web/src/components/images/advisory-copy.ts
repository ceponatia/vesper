import type { RenderAdvisoryCode, RenderAdvisoryOffer } from "@vesper/image-core";

/**
 * The render-advisory vocabulary in English (issue #249).
 *
 * Same rule as `characters/identity-pack-copy.ts`: the server reasons about
 * stable codes only, so a wording change is a one-file edit that cannot alter
 * a stored advisory, and translation to English happens HERE and nowhere
 * else — a new code reaching the owner without copy is a compile error
 * (the exhaustive switch, no `default`), never a raw identifier on screen.
 */
export function renderAdvisoryCodeCopy(code: RenderAdvisoryCode): string {
  switch (code) {
    case "harmful_crop_loss":
      return "Fitting the requested frame trimmed a large share of what the model actually returned.";
    case "blank_output":
      return "This came back as a flat, near-empty image with almost no visible detail.";
    case "severe_blur":
      return "This looks severely out of focus across the whole frame.";
  }
}

/** What an advisory offers trying next, in English — never a call this
 * component makes on the owner's behalf, only the words for a button that
 * lives beside it. */
export function renderAdvisoryOfferCopy(offer: RenderAdvisoryOffer): string {
  switch (offer) {
    case "retry_same":
      return "try the same composition again";
    case "new_variation":
      return "try a new variation";
    case "repair":
      return "repair this image";
  }
}
