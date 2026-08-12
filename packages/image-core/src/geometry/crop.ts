/**
 * Pure geometry for the avatar crop UI (components/characters/avatar-upload-dialog.tsx)
 * and the upload pipeline (server/images/upload.ts). No DOM, no IO — the
 * component drives a CSS preview from these numbers and the same numbers
 * produce the output canvas, so what the user frames is exactly what is saved.
 */

/** Canonical profile-portrait pixels — 3:4, the avatar aspect (docs/images/pipelines.md §Avatar upload). */
export const AVATAR_WIDTH = 768;
export const AVATAR_HEIGHT = 1024;
export const AVATAR_ASPECT_RATIO = AVATAR_WIDTH / AVATAR_HEIGHT; // 0.75

/** How far past cover-fit the user may zoom in. */
export const MAX_ZOOM = 4;
/**
 * How far below cover-fit the user may zoom OUT (owner request 2026-07-29):
 * shrinking past cover letterboxes the image inside the frame so parts a 3:4
 * cover-crop would cut (a wide shot's sides, a tall shot's feet) stay in the
 * portrait; the uncovered canvas is filled with the picked flat backdrop color
 * at render time. 0.25 is generous — a quarter-size stamp — without letting the
 * slider degenerate to a dot.
 */
export const MIN_ZOOM = 0.25;

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

/** Smallest scale at which the image fully covers the frame — the zoom=1 baseline. */
export function coverScale(frame: CropFrame, image: CropImage): number {
  if (image.nw <= 0 || image.nh <= 0) return 1;
  return Math.max(frame.fw / image.nw, frame.fh / image.nh);
}

/** Displayed image size (px) at a zoom; zoom 1 just covers the frame, below 1 letterboxes. */
export function displaySize(frame: CropFrame, image: CropImage, zoom: number): { width: number; height: number } {
  const scale = coverScale(frame, image) * zoom;
  return { width: image.nw * scale, height: image.nh * scale };
}

/**
 * Clamp the image's top-left offset, per axis: while the image overflows the
 * frame it may slide until an edge meets the frame (no uncovered gap on that
 * axis); once it is SMALLER than the frame (zoomed out) the range flips — it
 * may slide within the frame but never off it, so a letterboxed image can be
 * positioned yet stays fully visible.
 */
export function clampOffset(frame: CropFrame, dispW: number, dispH: number, offset: Offset): Offset {
  const clampAxis = (frameLen: number, dispLen: number, value: number): number => {
    const lo = Math.min(0, frameLen - dispLen);
    const hi = Math.max(0, frameLen - dispLen);
    return Math.min(hi, Math.max(lo, value));
  };
  return {
    x: clampAxis(frame.fw, dispW, offset.x),
    y: clampAxis(frame.fh, dispH, offset.y),
  };
}

/** The centered offset — the automatic center-crop the dialog opens on. */
export function centeredOffset(frame: CropFrame, dispW: number, dispH: number): Offset {
  return { x: (frame.fw - dispW) / 2, y: (frame.fh - dispH) / 2 };
}

export interface CanvasRect {
  dx: number;
  dy: number;
  dw: number;
  dh: number;
}

/**
 * The DESTINATION rectangle for drawing the whole source image onto the output
 * canvas: the display transform scaled from frame px to canvas px, for
 * `ctx.drawImage(img, dx, dy, dw, dh)` after a flat backdrop fill. One formula
 * covers both regimes — zoomed in, the rect overflows the canvas and the canvas
 * clips it (the old source-rect crop); zoomed out, it sits inside the canvas
 * and the fill shows around it (the letterbox).
 */
export function canvasRect(frame: CropFrame, dispW: number, dispH: number, offset: Offset, outW: number, outH: number): CanvasRect {
  const kx = outW / frame.fw;
  const ky = outH / frame.fh;
  return { dx: offset.x * kx, dy: offset.y * ky, dw: dispW * kx, dh: dispH * ky };
}
