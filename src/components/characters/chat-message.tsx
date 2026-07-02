"use client";

import { useState } from "react";
import type { ReplyTakes } from "@/lib/client/api";
import { Button } from "@/components/ui/button";
import { EntityImage } from "@/components/ui/entity-image";
import { Textarea } from "@/components/ui/textarea";

export interface ChatLine {
  id: string;
  role: "user" | "assistant";
  content: string;
  /** Recorded alternate generations on an assistant reply (spec §4.1); absent on user/optimistic lines. */
  takes?: ReplyTakes;
  /** True when the player cut this reply short with Stop (spec §4.2). */
  stopped?: boolean;
}

/** Circular-arrow "rerun" glyph (stroke-based, 24×24 box — matches the nav icons). */
function RerunIcon({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
      className={className}
    >
      <path d="M21 12a9 9 0 1 1-2.64-6.36" />
      <path d="M21 3v5h-5" />
    </svg>
  );
}

/**
 * One chat line: the user on the right, the character (with avatar) on the left.
 * Hovering a persisted line reveals Edit / Delete — the recovery levers for a
 * refusal (edit rewrites the line in place; delete snips it out of the window) —
 * and, on the user's own lines, Rerun: re-send this prompt for a fresh reply,
 * dropping everything after it (and cancelling any in-flight reply). Rerun stays
 * available while a reply streams, precisely so it can interrupt one; Edit/Delete
 * don't (mutating mid-stream is ambiguous). Optimistic / still-streaming temp-id
 * lines expose no actions: there is no server row to target until ids reconcile.
 *
 * Beyond parity (spec §4.1–4.2): the newest reply (`takeTarget`) also offers
 * "Another take" — regenerate in place, keeping earlier takes browsable via the
 * always-visible `‹ 2/3 ›` pager in the footer — and a reply the player cut short
 * with Stop carries a subtle "stopped" chip inside the bubble.
 */
export function MessageBubble({
  line,
  name,
  avatarImageId,
  streaming,
  takeTarget,
  onEdit,
  onDelete,
  onRerun,
  onAnotherTake,
  onSwitchTake,
}: {
  line: ChatLine;
  name: string;
  avatarImageId: string | null;
  streaming: boolean;
  /** True on the last assistant reply when regeneration is available (parent gates archived). */
  takeTarget: boolean;
  onEdit: (id: string, content: string) => Promise<boolean>;
  onDelete: (id: string) => Promise<void>;
  onRerun: (id: string) => void;
  onAnotherTake: (id: string) => void;
  onSwitchTake: (id: string, takeId: string) => Promise<void>;
}) {
  const isUser = line.role === "user";
  const pending = !isUser && line.content === "" && streaming;
  const persisted = !pending && !line.id.startsWith("tmp-");
  // Edit/Delete only on a settled line; Rerun also mid-stream so it can interrupt.
  const canModify = persisted && !streaming;
  const canRerun = isUser && persisted;
  const canTake = takeTarget && persisted && !streaming;
  // The pager shows on any settled reply carrying multiple takes (not just the last).
  const pagerTakes = !isUser && persisted && line.takes && line.takes.takes.length > 1 ? line.takes : undefined;
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(line.content);
  const [saving, setSaving] = useState(false);
  const [switching, setSwitching] = useState(false);

  const startEdit = () => {
    setDraft(line.content);
    setEditing(true);
  };

  const save = async () => {
    const next = draft.trim();
    if (!next || next === line.content) {
      setEditing(false);
      return;
    }
    setSaving(true);
    const ok = await onEdit(line.id, next);
    setSaving(false);
    if (ok) setEditing(false);
  };

  const switchTo = async (takeId: string) => {
    if (switching) return;
    setSwitching(true);
    await onSwitchTake(line.id, takeId);
    setSwitching(false);
  };

  return (
    <div className={`group flex gap-2.5 ${isUser ? "flex-row-reverse" : "flex-row"}`}>
      {!isUser ? (
        <EntityImage imageId={avatarImageId} name={name} className="mt-0.5 size-8 shrink-0 rounded-full text-xs" />
      ) : null}
      <div className={`flex max-w-[80%] flex-col gap-1 ${isUser ? "items-end" : "items-start"}`}>
        {editing ? (
          <div className="flex w-full min-w-64 flex-col gap-1.5">
            <Textarea
              rows={2}
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              className="field-sizing-content max-h-[60vh] w-full text-sm"
              autoFocus
            />
            <div className="flex justify-end gap-1.5">
              <Button size="sm" variant="quiet" onClick={() => setEditing(false)} disabled={saving}>
                Cancel
              </Button>
              <Button size="sm" variant="primary" busy={saving} onClick={save}>
                Save
              </Button>
            </div>
          </div>
        ) : (
          <>
            <div
              className={`rounded-card px-3 py-2 text-sm whitespace-pre-wrap ${
                isUser ? "bg-accent-500/15 text-paper-100" : "bg-ink-800 text-paper-200"
              }`}
            >
              {pending ? <span className="text-paper-500">…</span> : line.content}
              {line.stopped ? (
                <span className="ml-1.5 inline-block rounded-sm border border-ink-600 px-1 text-[10px] tracking-wide text-paper-500 uppercase">
                  stopped
                </span>
              ) : null}
            </div>
            {pagerTakes !== undefined || canModify || canRerun ? (
              <div className="-mx-1 flex items-center gap-1">
                {pagerTakes ? (
                  <TakesPager
                    takes={pagerTakes}
                    disabled={streaming || switching}
                    onSwitch={(takeId) => void switchTo(takeId)}
                  />
                ) : null}
                {canModify || canRerun ? (
                  // `.hover-reveal` (globals.css): hover-gated on pointer devices,
                  // always shown on touch — the only way these reach a phone. Padded
                  // so each is a comfortable finger target, not an 11px glyph.
                  <div className="hover-reveal flex items-center gap-1">
                    {canModify ? (
                      <>
                        <button
                          type="button"
                          onClick={startEdit}
                          className="rounded px-2 py-1 text-[11px] text-paper-500 hover:text-paper-200"
                        >
                          Edit
                        </button>
                        <button
                          type="button"
                          onClick={() => void onDelete(line.id)}
                          className="rounded px-2 py-1 text-[11px] text-paper-500 hover:text-danger-400"
                        >
                          Delete
                        </button>
                      </>
                    ) : null}
                    {canTake ? (
                      <button
                        type="button"
                        onClick={() => onAnotherTake(line.id)}
                        title="Regenerate this reply — earlier takes stay browsable"
                        className="rounded px-2 py-1 text-[11px] text-paper-500 hover:text-accent-300"
                      >
                        Another take
                      </button>
                    ) : null}
                    {canRerun ? (
                      <button
                        type="button"
                        onClick={() => onRerun(line.id)}
                        aria-label="Rerun from here"
                        title="Re-send this message — replaces everything after it with a fresh reply"
                        className="rounded px-2 py-1 text-paper-500 hover:text-accent-300"
                      >
                        <RerunIcon className="size-3.5" />
                      </button>
                    ) : null}
                  </div>
                ) : null}
              </div>
            ) : null}
          </>
        )}
      </div>
    </div>
  );
}

/**
 * The `‹ 2/3 ›` take browser (spec §4.1) — always visible (not hover-gated) so
 * recorded takes stay discoverable. Switching is display-only: the conversation's
 * state and memory follow the newest generated take, so the arrows just swap which
 * take the bubble shows.
 */
function TakesPager({
  takes,
  disabled,
  onSwitch,
}: {
  takes: ReplyTakes;
  disabled: boolean;
  onSwitch: (takeId: string) => void;
}) {
  const found = takes.takes.findIndex((t) => t.id === takes.activeId);
  const active = found < 0 ? takes.takes.length - 1 : found; // unknown activeId ⇒ the newest take
  const prev = takes.takes[active - 1];
  const next = takes.takes[active + 1];
  const arrow =
    "rounded px-1.5 py-1 hover:text-paper-200 disabled:pointer-events-none disabled:text-paper-600";
  return (
    <div className="flex items-center text-[11px] text-paper-500">
      <button
        type="button"
        onClick={() => (prev ? onSwitch(prev.id) : undefined)}
        disabled={disabled || !prev}
        aria-label="Show the previous take"
        className={arrow}
      >
        ‹
      </button>
      <span className="tabular-nums">
        {active + 1}/{takes.takes.length}
      </span>
      <button
        type="button"
        onClick={() => (next ? onSwitch(next.id) : undefined)}
        disabled={disabled || !next}
        aria-label="Show the next take"
        className={arrow}
      >
        ›
      </button>
    </div>
  );
}
