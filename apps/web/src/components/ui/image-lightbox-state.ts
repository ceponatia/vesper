import type { MediaPreviewKind } from "@/lib/media-preview";

export type LightboxImageStatus = "empty" | "loading" | "loaded" | "failed";

export interface LightboxView {
  /** Separates attempts or empty slots even when they share an image id. */
  viewKey?: string;
  imageId: string | null;
  comparisonImageId?: string | null;
  visible: boolean;
}

export interface LightboxViewState extends LightboxView {
  showComparison: boolean;
  imageStatus: LightboxImageStatus;
}

function sameView(left: LightboxView, right: LightboxView): boolean {
  return left.viewKey === right.viewKey && left.imageId === right.imageId
    && left.comparisonImageId === right.comparisonImageId && left.visible === right.visible;
}

/** Reset only image-local state; the dialog and its focused controls stay mounted. */
export function lightboxStateForView(previous: LightboxViewState | null, view: LightboxView): LightboxViewState {
  if (previous && sameView(previous, view)) return previous;
  return { ...view, showComparison: false, imageStatus: view.imageId ? "loading" : "empty" };
}

/** A response from an image that has been left cannot approve the current view. */
export function updateLightboxImageStatus(state: LightboxViewState, view: LightboxView, imageStatus: LightboxImageStatus): LightboxViewState {
  if (!sameView(state, view) || !view.visible || !view.imageId || state.imageStatus === imageStatus) return state;
  return { ...state, imageStatus };
}

/**
 * The key an advisory's own review/submitting state is tracked under.
 *
 * A caller (the Gallery, reference review) commonly keeps one `ImageLightbox`
 * instance mounted across several images rather than remounting it per
 * image, so component state survives a close/reopen with a DIFFERENT
 * `imageId`. Keying solely by advisory `code` let one image's recorded
 * verdict — or its in-flight submit — leak onto a different image that
 * happens to carry the same code. Composing the image id in is the fix; no
 * effect-based reset is needed (and a synchronous `setState` in an effect
 * body is the one thing this codebase's strict react-hooks rule forbids).
 */
export function advisoryReviewKey(imageId: string | null, code: string): string {
  return `${imageId ?? ""}:${code}`;
}

/**
 * The lightbox's cache-busting query param, appended to the media `src` on
 * every retry so a browser that cached a failed load actually re-fetches
 * (docs/ui/conventions.md §Image lightbox). `imageUrl(imageId)` never carries
 * a query string, but the Admin Files preview route's `src` already carries
 * `?path=...` (#595), so this extends an existing query instead of always
 * starting a fresh one.
 */
export function appendRetryParam(url: string, retry: number): string {
  if (retry === 0) return url;
  const separator = url.includes("?") ? "&" : "?";
  return `${url}${separator}retry=${String(retry)}`;
}

/**
 * The lightbox's failed-state message for its media element. Video and audio
 * reuse the same three-state loading/loaded/failed machine as the image path
 * (`LightboxImage`), but an allowlisted file the browser's codec cannot
 * decode is a playback failure rather than a transport one, so the copy says
 * "cannot be played" instead of image's "could not be loaded" (#595's
 * codec-failure requirement). The image branch is worded identically to
 * before `media` existed, so no existing image-only lightbox caller sees new
 * copy.
 */
export function lightboxFailureMessage(media: MediaPreviewKind): string {
  return media === "image" ? "This image could not be loaded." : `This ${media} cannot be played in this browser.`;
}
