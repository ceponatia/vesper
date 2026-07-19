"use client";

import { useState } from "react";
import { imageUrl } from "@/lib/client/api";
import { cx } from "./cx";
import { firstInitialOf, hueOf, initialsOf } from "./monogram";

export interface EntityImageProps {
  imageId: string | null | undefined;
  name: string;
  className?: string;
  /** Object-fit cover by default. */
  alt?: string;
  /** Privacy mode (mobile-ux.plan.md ruling 4): always render the plain
   *  first-initial monogram instead of the image, even when one exists —
   *  deliberately different from the missing-image fallback below (which keeps
   *  the two-letter hue gradient) so this reads as "hidden on purpose", not "no
   *  portrait uploaded". */
  privacy?: boolean;
}

/**
 * Image with monogram CSS fallback (docs/ui.md): missing/broken images render
 * a deterministic gradient + initials, never a broken-image glyph.
 */
export function EntityImage({ imageId, name, className, alt, privacy }: EntityImageProps) {
  const [failed, setFailed] = useState(false);
  // Render-adjust: a new image id gets a fresh chance to load.
  const [prevImageId, setPrevImageId] = useState(imageId);
  if (prevImageId !== imageId) {
    setPrevImageId(imageId);
    setFailed(false);
  }

  if (privacy) {
    return (
      <div
        aria-label={alt ?? name}
        role="img"
        className={cx(
          "flex items-center justify-center overflow-hidden border border-ink-500 bg-ink-750 text-paper-200 select-none",
          className,
        )}
      >
        <span className="prose-display text-[max(0.8em,12px)] tracking-widest">{firstInitialOf(name)}</span>
      </div>
    );
  }

  if (!imageId || failed) {
    const hue = hueOf(name);
    return (
      <div
        aria-label={alt ?? name}
        role="img"
        className={cx("flex items-center justify-center overflow-hidden select-none", className)}
        style={{
          background: `linear-gradient(135deg, hsl(${hue} 22% 24%), hsl(${(hue + 40) % 360} 26% 14%))`,
        }}
      >
        <span className="prose-display text-[max(0.8em,12px)] tracking-widest text-paper-300/80">
          {initialsOf(name)}
        </span>
      </div>
    );
  }

  return (
    // eslint-disable-next-line @next/next/no-img-element -- local asset route; next/image adds nothing here
    <img
      src={imageUrl(imageId)}
      alt={alt ?? name}
      onError={() => setFailed(true)}
      className={cx("object-cover", className)}
    />
  );
}
