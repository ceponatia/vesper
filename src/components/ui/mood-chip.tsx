import { cx } from "@/components/ui/cx";

/** Glanceable glyph per `EmotionLabel` (mood.spec §2) for the mood chip. */
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
 * The derived discrete emotion as a small glyph + label (mood.spec §4). Shared by the
 * play cast card (`StatusParticipant.emotion`) and the character-chat strip
 * (`ChatStateSnapshot.emotion`) — one read, one presentation. `intensity` surfaces only
 * as a tooltip; the label is the glance.
 */
export function MoodChip({ emotion, className }: { emotion: { label: string; intensity: number }; className?: string }) {
  return (
    <span
      className={cx("flex items-center gap-1 text-paper-400", className)}
      title={`Mood — intensity ${Math.round(emotion.intensity * 100)}%`}
    >
      <span aria-hidden>{emotionGlyph[emotion.label] ?? "·"}</span>
      <span className="capitalize">{emotion.label}</span>
    </span>
  );
}
