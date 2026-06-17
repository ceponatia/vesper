"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { AuthorMode, UseSession } from "@/lib/client/use-session";
import { Button, Spinner } from "@/components/ui/button";
import { Select } from "@/components/ui/select";
import { cx } from "@/components/ui/cx";
import { useToast } from "@/components/ui/toast";

const MODES = [
  { id: "player", label: "Player", hint: "What do you do?" },
  { id: "director", label: "Director", hint: "Direct the story (out of world)…" },
  { id: "companion", label: "Companion", hint: "What do they do?" },
] as const satisfies ReadonlyArray<{ id: AuthorMode; label: string; hint: string }>;

/** A turn captured while the pipeline was busy, dispatched once it frees up. */
interface QueuedTurn {
  text: string;
  author: AuthorMode;
  speaker?: string;
}

/**
 * Composer (docs/ui.md §Play screen): Enter submits, Shift+Enter newline,
 * author-mode segmented control with a speaker picker for companion turns, and
 * an explicit Send button (for touch).
 *
 * The textarea is *never* disabled — the player can keep typing while the
 * narrator/agents run. Sending while the pipeline is busy queues the turn
 * (one slot) and clears the box; the queued turn dispatches automatically when
 * the session goes ready. While a turn is queued, sending is blocked until it
 * enters the pipeline, but typing the next one stays allowed.
 */
export function Composer({ session }: { session: UseSession }) {
  const toast = useToast();
  const { submit } = session;
  const [input, setInput] = useState("");
  const [author, setAuthor] = useState<AuthorMode>("player");
  const [speakerId, setSpeakerId] = useState("");
  const [sending, setSending] = useState(false);
  const [queued, setQueued] = useState<QueuedTurn | null>(null);
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

  // The pipeline is occupied (narrating, settling, or a submit in flight before
  // `busy` flips). A new send queues rather than dispatching while this holds.
  const active = session.busy !== null || sending;
  const statusLine =
    session.busy === "narrating"
      ? "The narrator is writing…"
      : session.busy === "processing"
        ? session.jobType === "reconcile"
          ? "Reconciling your edit…"
          : "The world is settling…"
        : null;

  const submitTurn = useCallback(
    async (turn: QueuedTurn) => {
      setSending(true);
      const result = await submit(turn.text, turn.author, turn.speaker);
      setSending(false);
      if (!result.ok) {
        // Give the words back, but only if the box is still empty — the player
        // may have started typing the next turn while this one was in flight.
        setInput((cur) => (cur === "" ? turn.text : cur));
        requestAnimationFrame(() => textareaRef.current?.focus());
        toast.push({
          title: result.error.status === 409 ? "The session is busy" : "Couldn't submit the turn",
          description: result.error.message,
          tone: "error",
        });
      }
    },
    [submit, toast],
  );

  // Hand the queued turn to the pipeline the moment it frees up. Deferred to a
  // microtask so the dispatch (clear queue + submit) runs in a callback rather
  // than synchronously cascading state inside the effect body.
  useEffect(() => {
    if (active || !queued) return;
    const turn = queued;
    let cancelled = false;
    void Promise.resolve().then(() => {
      if (cancelled) return;
      setQueued(null);
      void submitTurn(turn);
    });
    return () => {
      cancelled = true;
    };
  }, [active, queued, submitTurn]);

  const send = () => {
    const text = input.trim();
    // A queued turn blocks further sends until it enters the pipeline.
    if (text === "" || queued) return;
    let speaker: string | undefined;
    if (author === "companion") {
      speaker = speakerId || npcs[0]?.id;
      if (!speaker) {
        toast.push({ title: "No companion present", description: "There is no one here to take the turn.", tone: "info" });
        return;
      }
    }
    setInput("");
    const turn: QueuedTurn = { text, author, speaker };
    // Busy → queue (the effect dispatches it later); ready → go now.
    if (active) setQueued(turn);
    else void submitTurn(turn);
  };

  const cancelQueued = () => {
    if (!queued) return;
    setInput((cur) => (cur === "" ? queued.text : cur));
    setQueued(null);
  };

  const mode = MODES.find((m) => m.id === author) ?? MODES[0];
  const speakerName = npcs.find((n) => n.id === (speakerId || npcs[0]?.id))?.displayName;
  const canSend = input.trim() !== "" && queued === null;

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

        {queued ? (
          <div className="mb-2 flex items-center gap-2 rounded-md border border-ink-600 bg-ink-850/60 px-3 py-1.5 text-xs text-paper-400">
            <span className="shrink-0 font-medium text-paper-300">Queued</span>
            <span className="min-w-0 flex-1 truncate italic">{queued.text}</span>
            <button
              type="button"
              onClick={cancelQueued}
              aria-label="Cancel queued turn"
              className="shrink-0 cursor-pointer rounded px-1 text-paper-500 hover:text-paper-100"
            >
              ×
            </button>
          </div>
        ) : null}

        <div className="flex items-end gap-2">
          <textarea
            ref={textareaRef}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                send();
              }
            }}
            rows={2}
            placeholder={
              author === "companion" && speakerName ? `What does ${speakerName} do?` : mode.hint
            }
            aria-label="Your turn"
            className="min-w-0 flex-1 resize-none rounded-md border border-ink-600 bg-ink-850 px-3 py-2 font-serif text-[15px] leading-6 text-paper-100 placeholder:text-paper-500 hover:border-ink-500 focus:border-accent-500 focus:outline-none"
          />
          <Button
            variant="primary"
            onClick={send}
            disabled={!canSend}
            aria-label={active ? "Queue turn" : "Send turn"}
          >
            {active ? "Queue" : "Send"}
          </Button>
        </div>
        <p className="mt-1 text-[11px] text-paper-500">
          Enter to send · Shift+Enter for a new line
        </p>
      </div>
    </div>
  );
}
