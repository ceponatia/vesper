import type { SourcePixelCrop } from "./identity-pack";
import { heuristicCropV1, type NormalizedCrop, type SourceDimensions } from "./identity-pack-crop";
import { IDENTITY_CROP_POLICY_V1, type IdentityCropPolicy } from "./identity-pack-policy";

/**
 * Pure view geometry for the owner's face-crop editor
 * (components/characters/identity-crop-dialog.tsx). No DOM, no IO — the component
 * feeds it pointer coordinates and gets a selection back, exactly as
 * `crop.ts` serves the avatar dialog.
 *
 * The editor's state is a SQUARE in integer source pixels, never in display or
 * normalized units. Display pixels change with the viewport and normalized units
 * change meaning when the source is re-encoded at another size; source pixels are
 * what the server stores and validates (`identity-pack-crop.ts`), so keeping the
 * editor in the same space means the preview and the saved crop cannot disagree
 * about anything except rounding.
 *
 * Nothing here is authoritative. Every rule enforced below (bounds, squareness,
 * minimum side) is enforced again server-side against the real source bytes; this
 * exists so the user is not offered a rectangle that is going to be refused.
 */

/** The editor's selection: a square, in integer source pixels. */
export interface IdentitySquareSelection {
  left: number;
  top: number;
  side: number;
}

/** A size in CSS/display pixels. */
export interface DisplayBox {
  width: number;
  height: number;
}

/** A point or delta in either space — the caller keeps track of which. */
export interface ViewPoint {
  x: number;
  y: number;
}

/** The resize grips, named for the corner they live on. */
export const identityCropHandles = ["nw", "ne", "se", "sw"] as const;
export type IdentityCropHandle = (typeof identityCropHandles)[number];

function isPositive(value: number): boolean {
  return Number.isFinite(value) && value > 0;
}

function clamp(value: number, lo: number, hi: number): number {
  if (!Number.isFinite(value)) return lo;
  return Math.min(Math.max(value, lo), Math.max(lo, hi));
}

/** Contain-fit: the largest box with the source's aspect that fits inside `max`. */
export function fitDisplayBox(source: SourceDimensions, max: DisplayBox): DisplayBox {
  if (!isPositive(source.width) || !isPositive(source.height) || !isPositive(max.width) || !isPositive(max.height)) {
    return { width: 0, height: 0 };
  }
  const scale = Math.min(max.width / source.width, max.height / source.height);
  return { width: source.width * scale, height: source.height * scale };
}

/** Display pixels per source pixel for an image rendered at `display`. */
export function displayScale(source: SourceDimensions, display: DisplayBox): number {
  if (!isPositive(source.width) || !isPositive(display.width)) return 1;
  return display.width / source.width;
}

/**
 * Display space → source space. Used for both points (relative to the image's
 * top-left) and deltas, because the mapping is a pure scale either way.
 */
export function toSourceSpace(point: ViewPoint, scale: number): ViewPoint {
  if (!isPositive(scale)) return { x: 0, y: 0 };
  return { x: point.x / scale, y: point.y / scale };
}

/** The selection as a display-space square, for absolute positioning. */
export function toDisplayRect(
  selection: IdentitySquareSelection,
  scale: number,
): { left: number; top: number; size: number } {
  const k = isPositive(scale) ? scale : 1;
  return { left: selection.left * k, top: selection.top * k, size: selection.side * k };
}

/**
 * The smallest side the editor allows, in source pixels.
 *
 * Normally the policy minimum (256). A source smaller than that cannot satisfy it
 * at all, and the editor floors at what the source has rather than locking the
 * handles: the server still refuses the save with `crop_too_small`, which is a
 * clearer answer than a selection that will not shrink and never explains why.
 */
export function minimumSelectionSide(
  source: SourceDimensions,
  policy: IdentityCropPolicy = IDENTITY_CROP_POLICY_V1,
): number {
  if (!isPositive(source.width) || !isPositive(source.height)) return policy.minimumOutputSidePx;
  return Math.min(policy.minimumOutputSidePx, Math.floor(Math.min(source.width, source.height)));
}

/** Round to integer source pixels, square, inside the source, at or above the minimum. */
export function clampSelection(
  selection: IdentitySquareSelection,
  source: SourceDimensions,
  policy: IdentityCropPolicy = IDENTITY_CROP_POLICY_V1,
): IdentitySquareSelection {
  if (!isPositive(source.width) || !isPositive(source.height)) return { left: 0, top: 0, side: 0 };
  const minSide = minimumSelectionSide(source, policy);
  const maxSide = Math.floor(Math.min(source.width, source.height));
  const side = clamp(Math.round(selection.side), minSide, maxSide);
  return {
    left: clamp(Math.round(selection.left), 0, Math.floor(source.width) - side),
    top: clamp(Math.round(selection.top), 0, Math.floor(source.height) - side),
    side,
  };
}

/**
 * Where the editor opens when no crop exists yet: the same rectangle the automatic
 * heuristic would have proposed. A user correcting an absent pack starts from the
 * machine's guess rather than an arbitrary centre square, so "adjust" means the
 * same thing whether or not derivation has run.
 */
export function defaultSelection(
  source: SourceDimensions,
  policy: IdentityCropPolicy = IDENTITY_CROP_POLICY_V1,
): IdentitySquareSelection {
  const heuristic = heuristicCropV1(source);
  const seed: IdentitySquareSelection = heuristic
    ? { left: heuristic.left, top: heuristic.top, side: heuristic.width }
    : { left: 0, top: 0, side: minimumSelectionSide(source, policy) };
  return clampSelection(seed, source, policy);
}

/**
 * The stored crop as an editor selection, falling back to the default when there is
 * none. A non-square stored crop (older revision, degraded row) collapses to its
 * shorter side rather than being rejected — the editor's job is to give the user
 * something to correct.
 */
export function selectionFromCrop(
  crop: SourcePixelCrop | null,
  source: SourceDimensions,
  policy: IdentityCropPolicy = IDENTITY_CROP_POLICY_V1,
): IdentitySquareSelection {
  if (!crop || !isPositive(crop.width) || !isPositive(crop.height)) return defaultSelection(source, policy);
  return clampSelection({ left: crop.left, top: crop.top, side: Math.min(crop.width, crop.height) }, source, policy);
}

/** Drag: translate by a source-space delta, staying inside the source. */
export function moveSelection(
  selection: IdentitySquareSelection,
  delta: ViewPoint,
  source: SourceDimensions,
  policy: IdentityCropPolicy = IDENTITY_CROP_POLICY_V1,
): IdentitySquareSelection {
  return clampSelection(
    { left: selection.left + delta.x, top: selection.top + delta.y, side: selection.side },
    source,
    policy,
  );
}

/** The corner a resize pivots around, plus which way that handle grows. */
function resizeAnchor(
  selection: IdentitySquareSelection,
  handle: IdentityCropHandle,
): { x: number; y: number; signX: number; signY: number } {
  switch (handle) {
    case "se":
      return { x: selection.left, y: selection.top, signX: 1, signY: 1 };
    case "sw":
      return { x: selection.left + selection.side, y: selection.top, signX: -1, signY: 1 };
    case "ne":
      return { x: selection.left, y: selection.top + selection.side, signX: 1, signY: -1 };
    case "nw":
      return { x: selection.left + selection.side, y: selection.top + selection.side, signX: -1, signY: -1 };
  }
}

/**
 * Resize from a corner: the opposite corner stays put and the square follows
 * whichever axis the pointer has travelled FURTHEST along.
 *
 * Taking the max (not the pointer's exact x, and not the min) is what keeps the
 * selection under the cursor when the drag goes diagonally off-axis; taking the min
 * would make the square lag behind the pointer on the leading axis. The side is
 * capped by the room between the anchor and the source edge, so a corner drag can
 * never push the square out of the image — the alternative, letting it grow and
 * then sliding it back inside, moves the anchor the user is holding still.
 */
export function resizeSelection(
  selection: IdentitySquareSelection,
  handle: IdentityCropHandle,
  pointer: ViewPoint,
  source: SourceDimensions,
  policy: IdentityCropPolicy = IDENTITY_CROP_POLICY_V1,
): IdentitySquareSelection {
  if (!isPositive(source.width) || !isPositive(source.height)) return clampSelection(selection, source, policy);
  const anchor = resizeAnchor(selection, handle);
  const reach = Math.max(anchor.signX * (pointer.x - anchor.x), anchor.signY * (pointer.y - anchor.y));
  const room = Math.min(
    anchor.signX > 0 ? source.width - anchor.x : anchor.x,
    anchor.signY > 0 ? source.height - anchor.y : anchor.y,
  );
  const minSide = minimumSelectionSide(source, policy);
  const side = clamp(Math.round(reach), minSide, Math.max(minSide, Math.floor(room)));
  return clampSelection(
    {
      left: anchor.signX > 0 ? anchor.x : anchor.x - side,
      top: anchor.signY > 0 ? anchor.y : anchor.y - side,
      side,
    },
    source,
    policy,
  );
}

/**
 * The selection as the normalized rectangle the manual-crop route accepts. The
 * server re-resolves these against the stored source dimensions
 * (`normalizedCropToSourcePixels`), so this is a lossless round trip for an integer
 * selection, not an approximation the server has to trust.
 */
export function selectionToNormalized(selection: IdentitySquareSelection, source: SourceDimensions): NormalizedCrop {
  if (!isPositive(source.width) || !isPositive(source.height)) return { left: 0, top: 0, width: 0, height: 0 };
  return {
    left: clamp(selection.left / source.width, 0, 1),
    top: clamp(selection.top / source.height, 0, 1),
    width: clamp(selection.side / source.width, 0, 1),
    height: clamp(selection.side / source.height, 0, 1),
  };
}

/**
 * How to position the full source image inside a square preview box so the box
 * shows exactly the selection — the same framing the stored crop will have, without
 * waiting for the server to encode it.
 */
export function cropPreviewLayout(
  selection: IdentitySquareSelection,
  source: SourceDimensions,
  previewSide: number,
): { width: number; height: number; left: number; top: number } {
  if (!isPositive(selection.side) || !isPositive(previewSide) || !isPositive(source.width) || !isPositive(source.height)) {
    return { width: 0, height: 0, left: 0, top: 0 };
  }
  const k = previewSide / selection.side;
  return {
    width: source.width * k,
    height: source.height * k,
    left: -selection.left * k,
    top: -selection.top * k,
  };
}
