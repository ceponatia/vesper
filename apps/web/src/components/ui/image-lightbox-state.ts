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
