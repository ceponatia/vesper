"use client";

import { EntityImage } from "@/components/ui/entity-image";
import { cx } from "@/components/ui/cx";

export interface AvatarPanelProps {
  name: string;
  avatarImageId: string | null;
  className?: string;
}

/**
 * The standing companion panel: a larger, portrait-sized view of the character's
 * canonical avatar beside the conversation / scene. Display-only — the mood-reactive
 * expression pipeline was rolled back (avatar-3d.plan.md); a missing image degrades
 * to the monogram fallback.
 */
export function AvatarPanel({ name, avatarImageId, className }: AvatarPanelProps) {
  return (
    <div
      className={cx(
        "relative aspect-[3/4] overflow-hidden rounded-card border border-ink-600 bg-ink-950/40 shadow-lift",
        className,
      )}
    >
      <EntityImage imageId={avatarImageId} name={name} className="absolute inset-0 h-full w-full object-cover" />
    </div>
  );
}
