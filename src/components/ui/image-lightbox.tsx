"use client";

import { useEffect, useRef } from "react";
import { imageUrl } from "@/lib/client/api";

export interface ImageLightboxProps {
  /** Image to enlarge, or null to render nothing. */
  imageId: string | null;
  alt: string;
  onClose: () => void;
  /** Optional caption under the image (e.g. the generation prompt). */
  caption?: string | null;
}

/**
 * Full-screen image viewer: darkened backdrop, image scaled to fit the
 * viewport. Backdrop click and Escape close (same idiom as Dialog).
 */
export function ImageLightbox({ imageId, alt, onClose, caption }: ImageLightboxProps) {
  const closeRef = useRef<HTMLButtonElement>(null);

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

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={alt}
      className="fixed inset-0 z-50 flex flex-col items-center justify-center gap-3 bg-ink-950/85 p-6 backdrop-blur-[2px]"
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
  );
}
