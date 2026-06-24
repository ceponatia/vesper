"use client";

import { useEffect, useRef } from "react";
import { imageUrl } from "@/lib/client/api";
import { useIsAdmin } from "@/components/hooks/use-is-admin";

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
}

/**
 * Full-screen image viewer: darkened backdrop, image scaled to fit the
 * viewport. Backdrop click and Escape close (same idiom as Dialog). For admin
 * users a `prompt` renders in a side panel beside the image (dev troubleshooting).
 */
export function ImageLightbox({ imageId, alt, onClose, caption, prompt }: ImageLightboxProps) {
  const closeRef = useRef<HTMLButtonElement>(null);
  const isAdmin = useIsAdmin();

  useEffect(() => {
    if (!imageId) return;
    closeRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [imageId, onClose]);

  if (!imageId) return null;

  const promptText = prompt?.trim() ?? "";
  const showPrompt = isAdmin && promptText.length > 0;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={alt}
      className="fixed inset-0 z-50 flex items-center justify-center gap-4 bg-ink-950/85 p-6 backdrop-blur-[2px]"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <button
        ref={closeRef}
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
        // image on a phone (docs/ui.md §Mobile uses the same md breakpoint).
        <aside className="hidden max-h-[85vh] w-80 shrink-0 flex-col gap-2 self-stretch overflow-y-auto rounded-card border border-ink-600 bg-ink-900/90 p-4 md:flex">
          <h3 className="text-xs font-medium tracking-wide text-paper-400 uppercase">
            Generation prompt
            <span className="ml-1.5 text-[10px] text-paper-600 normal-case">dev only</span>
          </h3>
          <p className="text-xs leading-relaxed break-words whitespace-pre-wrap text-paper-300">{promptText}</p>
        </aside>
      ) : null}
    </div>
  );
}
