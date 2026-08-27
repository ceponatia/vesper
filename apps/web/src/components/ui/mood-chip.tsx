import { cx } from "@/components/ui/cx";

/** Glanceable glyph per `EmotionLabel` for the mood chip. */
export const emotionGlyph: Record<string, string> = {
  neutral: "😐",
  happy: "🙂",
  affectionate: "🥰",
  playful: "😏",
  flustered: "😳",
  concerned: "😟",
  sad: "😢",
  angry: "😠",
  afraid: "😨",
  surprised: "😲",
  aroused: "🥵",
};

/**
 * The derived discrete emotion as a small glyph + label. Shared by the
 * play cast card (`StatusParticipant.emotion`) and the character-chat strip
 * (`ChatStateSnapshot.emotion`) — one read, one presentation. Intensity shows as a
 * small meter bar under the glyph (the old tooltip-only
 * read was invisible on touch); the tooltip keeps the precise number.
 */
export function MoodChip({ emotion, className }: { emotion: { label: string; intensity: number }; className?: string }) {
  const pct = Math.round(Math.max(0, Math.min(1, emotion.intensity)) * 100);
  return (
    <span
      className={cx("flex items-center gap-1 text-paper-400", className)}
      title={`Mood — intensity ${pct}%`}
    >
      <span className="flex flex-col items-center gap-0.5">
        <span aria-hidden>{emotionGlyph[emotion.label] ?? "·"}</span>
        <span aria-hidden className="block h-0.5 w-4 overflow-hidden rounded-full bg-ink-600">
          <span className="block h-full rounded-full bg-accent-400" style={{ width: `${pct}%` }} />
        </span>
      </span>
      <span className="capitalize">{emotion.label}</span>
      <span className="sr-only">intensity {pct}%</span>
    </span>
  );
}
