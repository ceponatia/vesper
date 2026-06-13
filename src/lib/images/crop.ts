/**
 * Pure geometry for the avatar crop UI (components/characters/avatar-upload-dialog.tsx)
 * and the upload pipeline (server/images/upload.ts). No DOM, no IO — the
 * component drives a CSS preview from these numbers and the same numbers
 * produce the output canvas, so what the user frames is exactly what is saved.
 */

/** Canonical profile-portrait pixels — 3:4, the avatar aspect (docs/images.md). */
export const AVATAR_WIDTH = 768;
export const AVATAR_HEIGHT = 1024;
export const AVATAR_ASPECT_RATIO = AVATAR_WIDTH / AVATAR_HEIGHT; // 0.75

/** How far past cover-fit the user may zoom in. */
export const MAX_ZOOM = 4;

/** The crop window, in display pixels (a 3:4 box rendered in the dialog). */
export interface CropFrame {
  fw: number;
  fh: number;
}

/** A source image's natural pixel size. */
export interface CropImage {
  nw: number;
  nh: number;
}

export interface Offset {
  x: number;
  y: number;
}

/** Two aspect ratios are "the same" within half a percent — skip-crop tolerance. */
export function aspectMatches(image: CropImage, ratio = AVATAR_ASPECT_RATIO): boolean {
  if (image.nw <= 0 || image.nh <= 0) return false;
  return Math.abs(image.nw / image.nh - ratio) <= ratio * 0.005;
}

/** Smallest scale at which the image fully covers the frame — the zoom=1 baseline. */
export function coverScale(frame: CropFrame, image: CropImage): number {
  if (image.nw <= 0 || image.nh <= 0) return 1;
  return Math.max(frame.fw / image.nw, frame.fh / image.nh);
}

/** Displayed image size (px) at a zoom ≥ 1; at zoom 1 it just covers the frame. */
export function displaySize(frame: CropFrame, image: CropImage, zoom: number): { width: number; height: number } {
  const scale = coverScale(frame, image) * Math.max(1, zoom);
  return { width: image.nw * scale, height: image.nh * scale };
}

/**
 * Clamp the image's top-left offset so the frame is never uncovered: the image
 * may slide until one of its edges meets the frame, no further.
 */
export function clampOffset(frame: CropFrame, dispW: number, dispH: number, offset: Offset): Offset {
  const minX = frame.fw - dispW; // ≤ 0 once the image covers the frame
  const minY = frame.fh - dispH;
  return {
    x: Math.min(0, Math.max(minX, offset.x)),
    y: Math.min(0, Math.max(minY, offset.y)),
  };
}

/** The centered offset — the automatic center-crop the dialog opens on. */
export function centeredOffset(frame: CropFrame, dispW: number, dispH: number): Offset {
  return { x: (frame.fw - dispW) / 2, y: (frame.fh - dispH) / 2 };
}

export interface SourceRect {
  sx: number;
  sy: number;
  sw: number;
  sh: number;
}

/**
 * The source-pixel rectangle currently framed, for `ctx.drawImage(img, sx, sy,
 * sw, sh, 0, 0, AVATAR_WIDTH, AVATAR_HEIGHT)`. Inverts the display transform:
 * `scale` is display px per source px, so dividing display offsets by it lands
 * back in the original image.
 */
export function sourceRect(frame: CropFrame, image: CropImage, zoom: number, offset: Offset): SourceRect {
  const scale = coverScale(frame, image) * Math.max(1, zoom);
  return {
    sx: -offset.x / scale,
    sy: -offset.y / scale,
    sw: frame.fw / scale,
    sh: frame.fh / scale,
  };
}
