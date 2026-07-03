"use client";

import { Button } from "@/components/ui/button";
import type { ChatSkipAmount } from "@/contracts";

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
 * dismiss; a skip amount hands off to the time-skip call the host owns.
 */
export function ChatPickupStrip({
  who,
  busy,
  onPick,
}: {
  who: string;
  busy: boolean;
  onPick: (amount: ChatSkipAmount | null) => void;
}) {
  return (
    <div role="group" aria-label={`Pick up with ${who}`} className="flex flex-wrap items-center gap-1.5">
      <span className="text-xs text-paper-500">Pick up:</span>
      {PICKUP_OPTIONS.map((opt) => (
        <Button key={opt.label} size="sm" variant="quiet" disabled={busy} onClick={() => onPick(opt.amount)}>
          {opt.label}
        </Button>
      ))}
    </div>
  );
}
