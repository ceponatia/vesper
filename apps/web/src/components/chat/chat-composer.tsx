"use client";

import { useRef, type Dispatch, type SetStateAction, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { chatsApi } from "@/lib/client/api";
import { caretInOocBlock } from "@/components/characters/message-markup";
import { Button } from "@/components/ui/button";
import { cx } from "@/components/ui/cx";
import { EntityImage } from "@/components/ui/entity-image";
import { Textarea } from "@/components/ui/textarea";
import { useToast } from "@/components/ui/toast";
import { fileToAttachmentDataUrl } from "./attachment-file";
import type { PerChatState } from "./chat-conversation-state";

type Setter<K extends keyof PerChatState> = Dispatch<SetStateAction<PerChatState[K]>>;
interface ComposerProps {
  chatId: string;
  isCurrent: () => boolean;
  who: string;
  ready: boolean;
  archived: boolean;
  input: string;
  setInput: Setter<"input">;
  oocActive: boolean;
  setOocActive: Setter<"oocActive">;
  narratorMode: boolean;
  setNarratorMode: Setter<"narratorMode">;
  attachments: string[];
  setAttachments: Setter<"attachments">;
  attachBusy: boolean;
  setAttachBusy: Setter<"attachBusy">;
  sending: boolean;
  stopping: boolean;
  canAttachPhotos: boolean;
  canStop: boolean;
  send: () => Promise<void>;
  stopReply: () => Promise<void>;
  openRemember: (prefill: string) => void;
}

/** The composition controls consume page-owned draft state and reply actions. */
export function ChatComposer({ chatId, isCurrent, who, ready, archived, input, setInput,
  oocActive, setOocActive, narratorMode, setNarratorMode, attachments, setAttachments,
  attachBusy, setAttachBusy, sending, stopping, canAttachPhotos, canStop,
  send, stopReply, openRemember }: ComposerProps) {
  const toast = useToast();
  const attachInputRef = useRef<HTMLInputElement | null>(null);
  /** Downscale + upload picked files, staging the returned ids (cap 4 total). */
  const pickAttachments = async (files: FileList | null) => {
    if (!files?.length || archived) return;
    const picked = Array.from(files).slice(0, Math.max(0, 4 - attachments.length));
    if (!picked.length) return;
    setAttachBusy(true);
    try {
      for (const file of picked) {
        const dataUrl = await fileToAttachmentDataUrl(file);
        if (!isCurrent()) return;
        if (!dataUrl) {
          toast.push({ title: "Couldn't read that image", description: file.name, tone: "error" });
          continue;
        }
        const result = await chatsApi.uploadAttachment(chatId, dataUrl);
        if (!isCurrent()) return;
        if (result.ok) setAttachments((prev) => (prev.length < 4 ? [...prev, result.data.id] : prev));
        else toast.push({ title: "Upload failed", description: result.error.message, tone: "error" });
      }
    } finally {
      if (isCurrent()) setAttachBusy(false);
    }
  };

  /** Recompute the OOC affordance from the textarea's live value + caret. */
  const refreshOoc = (el: HTMLTextAreaElement) => {
    setOocActive(caretInOocBlock(el.value, el.selectionStart));
  };

  /**
   * Place the caret after a controlled-value edit (the auto-close / collapse below).
   * Deferred to the next frame so React has committed the new value onto the node —
   * setting the range in the same tick would fight the controlled re-render. Mirrors
   * the play composer's `requestAnimationFrame(() => …focus())` pattern.
   */
  const applyCaret = (el: HTMLTextAreaElement, caret: number) => {
    requestAnimationFrame(() => {
      if (!isCurrent()) return;
      el.setSelectionRange(caret, caret);
      refreshOoc(el);
    });
  };

  const onComposerKeyDown = (e: ReactKeyboardEvent<HTMLTextAreaElement>) => {
    const el = e.currentTarget;
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      void send();
      return;
    }
    // The composer assist only manages a collapsed caret (no selection).
    const pos = el.selectionStart;
    if (pos !== el.selectionEnd) return;
    const value = el.value;
    // OOC discoverability: typing the second "(" completes "((" → auto-insert the
    // closing "))" with the caret between them. Skipped when "))" already follows
    // (so an already-paired block isn't over-closed).
    if (e.key === "(" && value[pos - 1] === "(" && value.slice(pos, pos + 2) !== "))") {
      e.preventDefault();
      setInput(value.slice(0, pos) + "(" + "))" + value.slice(pos));
      applyCaret(el, pos + 1);
      return;
    }
    // Backspace with the caret between "(" and "))" removes the whole auto-inserted
    // pair instead of stranding the "))" (undo of the auto-close).
    if (e.key === "Backspace" && value[pos - 1] === "(" && value.slice(pos, pos + 2) === "))") {
      e.preventDefault();
      setInput(value.slice(0, pos - 1) + value.slice(pos + 2));
      applyCaret(el, pos - 1);
    }
  };

  return (
    <>
    {/* OOC affordance (slice 5): a clear amber signal the caret is inside a
        ((…)) block — a note to the storyteller no one in the scene hears. */}
    {oocActive && !archived ? (
      <div className="flex items-center gap-1.5 text-[11px]">
        <span className="rounded-sm bg-accent-500/15 px-1.5 py-0.5 font-medium tracking-wide text-accent-300 uppercase">
          OOC
        </span>
        <span className="text-paper-500">To the storyteller — no one in the scene hears this.</span>
      </div>
    ) : null}
    {narratorMode && !archived ? (
      // Narrator-register affordance.
      <div className="flex items-center gap-1.5 text-[11px]">
        <span className="rounded-sm border border-ink-500 bg-ink-750 px-1.5 py-0.5 font-medium tracking-wide text-paper-300 uppercase">
          Narrator
        </span>
        <span className="text-paper-500">
          Writing the story, not as you — narrate events, side characters, the world.
        </span>
      </div>
    ) : null}
    {attachments.length ? (
      // Staged photos for the next send.
      <div className="flex flex-wrap items-center gap-1.5">
        {attachments.map((imageId) => (
          <div key={imageId} className="relative">
            <EntityImage imageId={imageId} name="photo" alt="Photo to send" className="h-14 w-14 rounded-md object-cover" />
            <button
              type="button"
              aria-label="Remove photo"
              onClick={() => setAttachments((prev) => prev.filter((a) => a !== imageId))}
              className="absolute -top-1.5 -right-1.5 flex size-5 cursor-pointer items-center justify-center rounded-full bg-ink-700 text-xs text-paper-300 hover:bg-ink-600 hover:text-paper-100"
            >
              ×
            </button>
          </div>
        ))}
        {attachBusy ? <span className="text-xs text-paper-500">Uploading…</span> : null}
      </div>
    ) : attachBusy ? (
      <span className="text-xs text-paper-500">Uploading…</span>
    ) : null}
    {/* Below `sm` the textarea owns its own full-width row (order-1) — sharing
        it with the persona toggle + two icon buttons + Send left it ~153px
        wide at 390px; flex-wrap drops the rest to
        a row beneath (order-2+), Send pushed to that row's right edge so it
        stays the obvious primary action. At `sm`+ flex-nowrap plus each
        control's sm:order restore the original single-row layout, textarea
        back to flex-1. */}
    <div className="flex flex-wrap items-end gap-2 sm:flex-nowrap">
      {!archived ? (
        // Player ↔ narrator register toggle: narrator sends the line as story
        // narration, not the player's POV.
        <button
          type="button"
          onClick={() => setNarratorMode((v) => !v)}
          disabled={!ready || attachments.length > 0}
          aria-pressed={narratorMode}
          title={
            attachments.length > 0
              ? "Photos send as you — remove them to write narration"
              : narratorMode
                ? "Narrator: writing the story itself — tap to speak as yourself"
                : "You: speaking and acting as yourself — tap to write as the narrator"
          }
          className={cx(
            "order-2 touch-target inline-flex shrink-0 cursor-pointer items-center justify-center rounded-md border px-2 py-2 text-[11px] font-medium tracking-wide uppercase transition-colors disabled:cursor-not-allowed disabled:opacity-50 sm:order-1",
            narratorMode
              ? "border-ink-500 bg-ink-750 text-paper-200"
              : "border-transparent text-paper-500 hover:text-paper-300",
          )}
        >
          {narratorMode ? "Narrator" : "You"}
        </button>
      ) : null}
      <Textarea
        rows={2}
        value={input}
        onChange={(e) => {
          setInput(e.currentTarget.value);
          refreshOoc(e.currentTarget);
        }}
        onKeyDown={onComposerKeyDown}
        onSelect={(e) => refreshOoc(e.currentTarget)}
        disabled={archived}
        placeholder={
          archived
            ? "This conversation is archived."
            : narratorMode
              ? "Narrate the story — events, side characters' words and actions, the world…  (Enter to send)"
              : `Message ${who}…  (Enter to send, Shift+Enter for a new line)`
        }
        className={cx(
          "order-1 w-full sm:order-2 sm:w-auto sm:flex-1",
          oocActive && "border-accent-500 ring-1 ring-accent-500/40",
          narratorMode && !oocActive && "border-ink-500 ring-1 ring-ink-500/60",
        )}
      />
      {/* Attachment availability comes from the transcript policy manifest. */}
      {!archived && canAttachPhotos ? (
        <>
          <input
            ref={attachInputRef}
            type="file"
            accept="image/png,image/jpeg,image/webp,image/avif"
            multiple
            hidden
            onChange={(e) => {
              void pickAttachments(e.currentTarget.files);
              e.currentTarget.value = ""; // re-picking the same file must re-fire
            }}
          />
          <button
            type="button"
            onClick={() => attachInputRef.current?.click()}
            disabled={!ready || attachBusy || attachments.length >= 4 || narratorMode}
            aria-label="Attach a photo"
            title={narratorMode ? "Photos send as you — switch back to You to attach one" : `Show ${who} a photo (up to 4 per message)`}
            className="order-3 touch-target inline-flex cursor-pointer items-center justify-center rounded-md px-2 py-2 text-paper-500 transition-colors hover:text-accent-300 disabled:cursor-not-allowed disabled:text-paper-600"
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden className="size-4.5">
              <path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48" />
            </svg>
          </button>
        </>
      ) : null}
      {!archived ? (
        <button
          type="button"
          onClick={() => openRemember("")}
          disabled={!ready}
          aria-label="Remember this…"
          title={`Tell ${who} something to always remember`}
          className="order-4 touch-target inline-flex cursor-pointer items-center justify-center rounded-md px-2 py-2 text-paper-500 transition-colors hover:text-accent-300 disabled:cursor-not-allowed disabled:text-paper-600"
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden className="size-4.5">
            <path d="M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z" />
          </svg>
        </button>
      ) : null}
      {sending && canStop ? (
        // Stop swaps in only when the lane has a real server-side abort.
        <Button
          variant="ghost"
          busy={stopping}
          onClick={() => void stopReply()}
          title="Stop the reply — keeps what has streamed so far"
          className="order-5 ml-auto sm:ml-0"
        >
          Stop
        </Button>
      ) : sending ? (
        <Button
          variant="ghost"
          busy
          title="The successor engine is finishing this turn"
          className="order-5 ml-auto sm:ml-0"
        >
          Replying…
        </Button>
      ) : (
        <Button
          variant="primary"
          onClick={() => void send()}
          disabled={
            archived || !ready || attachBusy || (!input.trim() && (narratorMode || !attachments.length))
          }
          className="order-5 ml-auto sm:ml-0"
        >
          Send
        </Button>
      )}
    </div>
    </>
  );
}
