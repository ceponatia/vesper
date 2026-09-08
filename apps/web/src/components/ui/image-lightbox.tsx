"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { Button } from "./button";
import { imageUrl, type ImageRecord } from "@/lib/client/api";
import { useIsAdmin } from "@/components/hooks/use-is-admin";
import { cx } from "./cx";
import { useFocusTrap } from "./use-focus-trap";
import { lightboxStateForView, updateLightboxImageStatus, type LightboxImageStatus, type LightboxView } from "./image-lightbox-state";

export interface ImageLightboxProps {
  /** Image to enlarge, or null to render nothing. */
  imageId: string | null;
  /** Reference review can stay open while a slot is pending or missing. */
  open?: boolean;
  /** Optional attempt/slot identity when multiple views can share an image id. */
  viewKey?: string;
  comparisonImageId?: string | null;
  controls?: ReactNode | ((state: { imageStatus: LightboxImageStatus }) => ReactNode);
  emptyMessage?: string;
  onPrevious?: () => void;
  onNext?: () => void;
  alt: string;
  onClose: () => void;
  /** Optional caption under the image (e.g. a short label). */
  caption?: string | null;
  /**
   * The full generation prompt for this image. Shown in a side panel for
   * troubleshooting — **admin/dev only** (gated by useIsAdmin) and **desktop
   * only** (hidden below the md breakpoint so it never crowds the image on a
   * phone). Normal users never see it. Pass it freely; the gates decide whether
   * it renders.
   */
  prompt?: string | null;
  /**
   * The image row's own `meta`, for the same admin-only panel the prompt renders
   * in: the resolved shot, the staged arrangement, and which reference view
   * anchored which person.
   *
   * A picture is the only place these decisions are visible, and reading them
   * back off a render is guesswork — a graded back-view scene and a graded
   * front-anchored one look alike until something says which was which. Pass it
   * freely; the same gates decide whether it renders.
   */
  meta?: ImageRecord["meta"] | null;
}

/**
 * Full-screen image viewer: darkened backdrop, image scaled to fit the
 * viewport. Escape/backdrop close and Tab stays inside via the shared
 * `useFocusTrap` (same idiom as Dialog — the hand-rolled Escape handler let Tab
 * escape to the page behind the overlay, codebase-review A10). For admin users a
 * side panel beside the image carries the generation `prompt` and the row's shot
 * provenance — the resolved camera, the staging, and each reference view the
 * render sent (dev troubleshooting; docs/ui/conventions.md §Image lightbox).
 */
export function ImageLightbox({ imageId, open, viewKey, alt, onClose, caption, prompt, meta, comparisonImageId, controls, emptyMessage, onPrevious, onNext }: ImageLightboxProps) {
  const panelRef = useRef<HTMLDivElement>(null);
  const isAdmin = useIsAdmin();
  const visible = open ?? Boolean(imageId);
  const view: LightboxView = { viewKey, imageId, comparisonImageId, visible };
  const [viewState, setViewState] = useState(() => lightboxStateForView(null, view));
  const currentState = lightboxStateForView(viewState, view);
  if (currentState !== viewState) setViewState(currentState);
  const { showComparison, imageStatus } = currentState;
  useEffect(() => {
    if (!visible) return;
    const trigger = document.activeElement;
    return () => { if (trigger instanceof HTMLElement && trigger.isConnected) trigger.focus(); };
  }, [visible]);
  useFocusTrap(visible, onClose, panelRef);

  if (!visible || typeof document === "undefined") return null;

  const promptText = prompt?.trim() ?? "";
  const provenance = provenanceLines(meta);
  const showPrompt = isAdmin && (promptText.length > 0 || provenance.length > 0);

  return createPortal(
    <div
      ref={panelRef}
      role="dialog"
      aria-modal="true"
      aria-label={alt}
      tabIndex={-1}
      className="fixed inset-0 z-50 flex flex-col bg-ink-950/95 pt-12 text-paper-100 backdrop-blur-[2px]"
      onKeyDown={(event) => {
        if (event.target instanceof HTMLElement && (event.target.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(event.target.tagName))) return;
        if (event.key === "ArrowLeft" && onPrevious) { event.preventDefault(); onPrevious(); }
        if (event.key === "ArrowRight" && onNext) { event.preventDefault(); onNext(); }
      }}
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <button
        type="button"
        onClick={onClose}
        aria-label="Close image"
        className="touch-target absolute top-2 right-3 z-10 cursor-pointer rounded-md px-3 py-2 text-2xl leading-none text-paper-400 hover:text-paper-50"
      >
        ×
      </button>
      {comparisonImageId ? (
        <div className="mb-2 flex justify-center md:hidden">
          <Button size="sm" variant="ghost" aria-pressed={showComparison} onClick={() => setViewState((value) => ({ ...value, showComparison: !value.showComparison }))}>
            {showComparison ? "Show reference view" : "Compare accepted portrait"}
          </Button>
        </div>
      ) : null}
      <div className="flex min-h-0 flex-1 items-stretch justify-center gap-4 overflow-auto px-3 pb-3 md:px-6" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
        <div className={cx("flex min-h-0 min-w-0 flex-1 flex-col items-center justify-center gap-2", comparisonImageId && showComparison ? "hidden md:flex" : "")} onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
          <LightboxImage key={JSON.stringify([viewKey, imageId, comparisonImageId])} imageId={imageId} alt={alt} emptyMessage={emptyMessage}
            onStatusChange={(status) => setViewState((previous) => updateLightboxImageStatus(previous, view, status))} />
          {caption ? <p className="shrink-0 text-center text-sm text-paper-300">{caption}</p> : null}
        </div>
        {comparisonImageId ? (
          <div className={cx("min-h-0 min-w-0 flex-1 flex-col items-center justify-center gap-2", showComparison ? "flex" : "hidden md:flex")} onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
            <LightboxImage key={comparisonImageId} imageId={comparisonImageId} alt="Accepted portrait" />
            <p className="shrink-0 text-center text-sm text-paper-300">Accepted portrait</p>
          </div>
        ) : null}
      {showPrompt ? (
        // Desktop only: hidden below md so the prompt panel never crowds the
        // image on a phone (docs/ui/mobile.md uses the same md breakpoint).
        <aside className="hidden max-h-[85vh] w-80 shrink-0 flex-col gap-2 self-stretch overflow-y-auto rounded-card border border-ink-600 bg-ink-900/90 p-4 md:flex">
          {promptText ? (
            <>
              <h3 className="text-xs font-medium tracking-wide text-paper-400 uppercase">
                Generation prompt
                <span className="ml-1.5 text-[10px] text-paper-600 normal-case">dev only</span>
              </h3>
              <p className="text-xs leading-relaxed break-words whitespace-pre-wrap text-paper-300">{promptText}</p>
            </>
          ) : null}
          {provenance.length > 0 ? (
            <div className={cx("flex flex-col gap-1", promptText ? "border-t border-ink-700 pt-2" : "")}>
              <h3 className="text-xs font-medium tracking-wide text-paper-400 uppercase">
                Provenance
                <span className="ml-1.5 text-[10px] text-paper-600 normal-case">dev only</span>
              </h3>
              {provenance.map((line, index) => (
                // Two people can take the same angle in the same wardrobe, so the
                // line alone is not a key.
                <p key={`${String(index)}-${line}`} className="text-xs leading-relaxed break-words text-paper-400">
                  {line}
                </p>
              ))}
            </div>
          ) : null}
        </aside>
      ) : null}
      </div>
      {controls ? <div className="max-h-[45dvh] shrink-0 overflow-y-auto border-t border-ink-600 bg-ink-900 px-3 pt-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] md:px-6">{typeof controls === "function" ? controls({ imageStatus }) : controls}</div> : null}
    </div>, document.body,
  );
}

function LightboxImage({ imageId, alt, emptyMessage, onStatusChange }: { imageId: string | null; alt: string; emptyMessage?: string; onStatusChange?: (status: LightboxImageStatus) => void }) {
  const imageRef = useRef<HTMLImageElement>(null);
  const [failed, setFailed] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [retry, setRetry] = useState(0);
  if (!imageId) return <p className="p-6 text-center text-paper-400">{emptyMessage ?? "No image is available."}</p>;
  if (failed) return <div className="flex flex-col items-center gap-2 p-4" role="status"><p>This image could not be loaded.</p><Button size="sm" onClick={() => { setFailed(false); setLoaded(false); setRetry((value) => value + 1); onStatusChange?.("loading"); }}>Retry image</Button></div>;
  return <>
    {!loaded ? <p role="status" className="text-sm text-paper-400">Loading image…</p> : null}
    {/* eslint-disable-next-line @next/next/no-img-element -- local asset route; review preserves the entire image */}
    <img key={retry} ref={imageRef} src={`${imageUrl(imageId)}${retry ? `?retry=${String(retry)}` : ""}`} alt={alt}
      onLoad={(event) => { if (imageRef.current !== event.currentTarget || !event.currentTarget.isConnected) return; setLoaded(true); onStatusChange?.("loaded"); }}
      onError={(event) => { if (imageRef.current !== event.currentTarget || !event.currentTarget.isConnected) return; setFailed(true); setLoaded(false); onStatusChange?.("failed"); }}
      className="min-h-0 max-h-full max-w-full rounded-card border border-ink-600 object-contain shadow-lift" />
  </>;

}

/**
 * The shot facts a scene row records, as one line each.
 *
 * Ids verbatim — the registries own the phrasing, and a second wording here
 * would be a display that disagrees with the prompt on the same panel. A row
 * with none of them (every non-scene image) produces no lines and no section.
 */
function provenanceLines(meta: ImageRecord["meta"] | null | undefined): string[] {
  if (!meta) return [];
  const lines: string[] = [];
  const camera = meta.camera;
  if (camera) {
    const shot = [camera.orientation, camera.distance, camera.height].filter(Boolean).join(" · ");
    if (shot) lines.push(`Camera: ${shot}`);
  }
  if (meta.staging) lines.push(`Staging: ${meta.staging}`);
  for (const view of meta.referenceViews ?? []) {
    const parts = [view.angle, view.wardrobe, view.substitutedAnchor ? "replaced anchor" : "extra reference"];
    lines.push(`View: ${parts.filter(Boolean).join(" · ")}`);
  }
  return lines;
}
