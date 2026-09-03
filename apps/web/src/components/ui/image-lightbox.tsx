"use client";

import { useRef } from "react";
import { imageUrl, type ImageRecord } from "@/lib/client/api";
import { useIsAdmin } from "@/components/hooks/use-is-admin";
import { cx } from "./cx";
import { useFocusTrap } from "./use-focus-trap";

export interface ImageLightboxProps {
  /** Image to enlarge, or null to render nothing. */
  imageId: string | null;
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
export function ImageLightbox({ imageId, alt, onClose, caption, prompt, meta }: ImageLightboxProps) {
  const panelRef = useRef<HTMLDivElement>(null);
  const isAdmin = useIsAdmin();
  useFocusTrap(Boolean(imageId), onClose, panelRef);

  if (!imageId) return null;

  const promptText = prompt?.trim() ?? "";
  const provenance = provenanceLines(meta);
  const showPrompt = isAdmin && (promptText.length > 0 || provenance.length > 0);

  return (
    <div
      ref={panelRef}
      role="dialog"
      aria-modal="true"
      aria-label={alt}
      tabIndex={-1}
      className="fixed inset-0 z-50 flex items-center justify-center gap-4 bg-ink-950/85 p-6 backdrop-blur-[2px]"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <button
        type="button"
        onClick={onClose}
        aria-label="Close image"
        className="absolute top-4 right-5 cursor-pointer rounded-md px-2 py-1 text-2xl leading-none text-paper-400 hover:text-paper-50"
      >
        ×
      </button>
      <div className="flex min-w-0 flex-col items-center gap-3">
        {/* eslint-disable-next-line @next/next/no-img-element -- local asset route; next/image adds nothing here */}
        <img
          src={imageUrl(imageId)}
          alt={alt}
          className="max-h-[85vh] max-w-full rounded-card border border-ink-600 object-contain shadow-lift"
        />
        {caption ? (
          <p className="max-w-2xl truncate text-center text-xs text-paper-400" title={caption}>
            {caption}
          </p>
        ) : null}
      </div>
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
  );
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
