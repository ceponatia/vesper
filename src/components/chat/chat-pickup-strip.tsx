"use client";

import { Button } from "@/components/ui/button";
import { CHAT_SKIP_MINUTES, formatChatMoment, type ChatSkipAmount } from "@/contracts";
import type { CalendarStart } from "@/lib/clock";

/**
 * The reopen strip's four choices (character-chat-standalone.spec.md §8.1, D14):
 * Continue is the default no-op (`null` — reopening never interrupts, ruled);
 * the rest map to skip amounts. "Moments" is deliberately absent here — it
 * lives in the header menu's mid-conversation options.
 */
const PICKUP_OPTIONS: { label: string; amount: ChatSkipAmount | null }[] = [
  { label: "Continue", amount: null },
  { label: "Later", amount: "hours" },
  { label: "Next morning", amount: "overnight" },
  { label: "Days later", amount: "days" },
];

/**
 * "Pick up:" strip shown above the composer on reopen (spec §8.1) — one compact
 * row of quiet chips, no modal, no forced choice. `onPick(null)` is the Continue
 * dismiss; a skip amount hands off to the time-skip call the host owns. With
 * `clock` given, each chip's title names the landing on the story calendar
 * ("→ Friday evening", chat-clock-calendar.plan.md) so a skip is never a leap
 * in the dark.
 */
export function ChatPickupStrip({
  who,
  busy,
  clock,
  onPick,
  onInitiative,
}: {
  who: string;
  busy: boolean;
  /** Current story clock + anchor, for the landing preview on each chip. */
  clock?: { clockMinutes: number; calendarStart: CalendarStart };
  onPick: (amount: ChatSkipAmount | null) => void;
  /** Reopen-opener initiative (chat-initiative.plan.md): the character reaches out first. */
  onInitiative?: () => void;
}) {
  const landing = (amount: ChatSkipAmount | null): string | undefined =>
    amount && clock
      ? `→ ${formatChatMoment(clock.clockMinutes + CHAT_SKIP_MINUTES[amount], clock.calendarStart)}`
      : undefined;
  return (
    <div role="group" aria-label={`Pick up with ${who}`} className="flex flex-wrap items-center gap-1.5">
      <span className="text-xs text-paper-500">Pick up:</span>
      {PICKUP_OPTIONS.map((opt) => (
        <Button key={opt.label} size="sm" variant="quiet" disabled={busy} title={landing(opt.amount)} onClick={() => onPick(opt.amount)}>
          {opt.label}
        </Button>
      ))}
      {onInitiative ? (
        <Button
          size="sm"
          variant="quiet"
          disabled={busy}
          onClick={onInitiative}
          title={`${who} reaches out first — with their own reasons`}
          className="text-accent-300"
        >
          Let {who} start <span aria-hidden>✦</span>
        </Button>
      ) : null}
    </div>
  );
}
