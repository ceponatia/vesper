"use client";

import { useRef, useState } from "react";
import type { AuthorMode, UseSession } from "@/lib/client/use-session";
import { Select } from "@/components/ui/select";
import { Spinner } from "@/components/ui/button";
import { cx } from "@/components/ui/cx";
import { useToast } from "@/components/ui/toast";

const MODES: ReadonlyArray<{ id: AuthorMode; label: string; hint: string }> = [
  { id: "player", label: "Player", hint: "What do you do?" },
  { id: "director", label: "Director", hint: "Direct the story (out of world)…" },
  { id: "companion", label: "Companion", hint: "What do they do?" },
];

/**
 * Composer (docs/ui.md §Play screen): Enter submits, Shift+Enter newline,
 * author-mode segmented control with a speaker picker for companion turns.
 * Disabled with a status line while the session is narrating/processing;
 * a 409 (busy) surfaces as a toast, never a crash.
 */
export function Composer({ session }: { session: UseSession }) {
  const toast = useToast();
  const [input, setInput] = useState("");
  const [author, setAuthor] = useState<AuthorMode>("player");
  const [speakerId, setSpeakerId] = useState("");
  const [sending, setSending] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const participants = session.status?.participants ?? [];
  const player = participants.find((p) => p.isUser || p.role === "player") ?? null;
  // Present NPCs: co-located with the player when locations are known.
  const npcs = participants.filter(
    (p) =>
      !p.isUser &&
      p.role !== "player" &&
      (!player?.locationId || !p.locationId || p.locationId === player.locationId),
  );

  const disabled = session.busy !== null || sending;
  const statusLine =
    session.busy === "narrating"
      ? "The narrator is writing…"
      : session.busy === "processing"
        ? session.jobType === "reconcile"
          ? "Reconciling your edit…"
          : "The world is settling…"
        : null;

  const send = async () => {
    const text = input.trim();
    if (text === "" || disabled) return;
    const speaker = author === "companion" ? speakerId || npcs[0]?.id : undefined;
    if (author === "companion" && !speaker) {
      toast.push({ title: "No companion present", description: "There is no one here to take the turn.", tone: "info" });
      return;
    }
    // Remember where the caret was so a failed submit can put it back.
    const el = textareaRef.current;
    const selection = el ? { start: el.selectionStart, end: el.selectionEnd } : null;
    setSending(true);
    setInput("");
    const result = await session.submit(text, author, speaker);
    setSending(false);
    if (!result.ok) {
      setInput(input); // give the words back…
      requestAnimationFrame(() => {
        // …with the caret where it was (after React re-enables the textarea).
        const node = textareaRef.current;
        if (!node) return;
        node.focus();
        if (selection) node.setSelectionRange(selection.start, selection.end);
      });
      toast.push({
        title: result.error.status === 409 ? "The session is busy" : "Couldn't submit the turn",
        description: result.error.message,
        tone: "error",
      });
    }
  };

  const mode = MODES.find((m) => m.id === author) ?? MODES[0]!;
  const speakerName = npcs.find((n) => n.id === (speakerId || npcs[0]?.id))?.displayName;

  return (
    <div className="border-t border-ink-600 bg-ink-900/95 px-4 py-3 sm:px-8">
      <div className="mx-auto max-w-3xl">
        <div className="mb-2 flex flex-wrap items-center gap-2">
          <div role="radiogroup" aria-label="Author mode" className="flex rounded-md border border-ink-600 p-0.5">
            {MODES.map((m) => (
              <button
                key={m.id}
                type="button"
                role="radio"
                aria-checked={author === m.id}
                onClick={() => setAuthor(m.id)}
                className={cx(
                  "cursor-pointer rounded px-2.5 py-1 text-xs transition-colors",
                  author === m.id ? "bg-ink-700 text-paper-50" : "text-paper-400 hover:text-paper-200",
                )}
              >
                {m.label}
              </button>
            ))}
          </div>
          {author === "companion" ? (
            npcs.length > 0 ? (
              <Select
                value={speakerId || npcs[0]?.id || ""}
                onChange={(e) => setSpeakerId(e.target.value)}
                aria-label="Speaking companion"
                className="h-7 w-44 text-xs"
              >
                {npcs.map((npc) => (
                  <option key={npc.id} value={npc.id}>
                    {npc.displayName}
                  </option>
                ))}
              </Select>
            ) : (
              <span className="text-xs text-paper-500 italic">no one else is here</span>
            )
          ) : null}
          {statusLine ? (
            <span className="ml-auto flex items-center gap-2 text-xs text-paper-500 italic">
              <Spinner className="size-3" />
              {statusLine}
            </span>
          ) : null}
        </div>

        <textarea
          ref={textareaRef}
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              void send();
            }
          }}
          rows={2}
          disabled={disabled}
          placeholder={
            author === "companion" && speakerName ? `What does ${speakerName} do?` : mode.hint
          }
          aria-label="Your turn"
          className="w-full resize-none rounded-md border border-ink-600 bg-ink-850 px-3 py-2 font-serif text-[15px] leading-6 text-paper-100 placeholder:text-paper-500 hover:border-ink-500 focus:border-accent-500 focus:outline-none disabled:opacity-60"
        />
        <p className="mt-1 text-[11px] text-paper-500">
          Enter to send · Shift+Enter for a new line
        </p>
      </div>
    </div>
  );
}
