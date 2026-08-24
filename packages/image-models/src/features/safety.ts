import type { ImageFeature } from "./image-feature";

/**
 * The endpoint's own content filter can be turned off by the caller.
 *
 * Worth stating as a family capability because the alternative is not "the
 * filter stays on" but "the filter cannot be reasoned about at all": a model
 * whose upstream moderation is not disableable refuses ordinary character
 * references and there is nothing a render can do about it, which is an
 * operator-facing fact (`operatorWarning` on the record carries the warning
 * itself).
 *
 * **No `isBound`.** Like output quality, this has no normalized control slot
 * and lives among a row's pinned extras; whether Vesper actually asks for it is
 * a policy decision the application makes at the render seam, never a family
 * adapter's to make.
 */
export function safetyToggleFeature(): ImageFeature {
  return {
    id: "safetyToggle",
    semantic: "Lets the caller disable the endpoint's own safety checker for a render.",
  };
}
