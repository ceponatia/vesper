"use client";

import { useState } from "react";
import { sessionsApi } from "@/lib/client/api";
import type { StatusThread } from "@/lib/client/use-session";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { Tag } from "@/components/ui/tag";
import { useToast } from "@/components/ui/toast";

interface ThreadModalProps {
  /** The thread to show, or null to close the modal. */
  thread: StatusThread | null;
  sessionId: string;
  /** Dev-only: show the "Close thread" control. */
  isAdmin: boolean;
  onClose: () => void;
  /** Called after a thread is force-closed so the parent can refresh the status. */
  onClosed: () => void | Promise<void>;
}

/**
 * Thread detail (docs/story-threads.md §UI): the rolling summary, what would
 * close an investigation, and the full developments timeline — everything
 * gleaned so far. Built on the shared Dialog (Esc / click-out to dismiss).
 * Admins get a confirm-gated "Close thread" control that resolves the thread
 * (it then drops from the status payload and the World tab).
 */
export function ThreadModal({ thread, sessionId, isAdmin, onClose, onClosed }: ThreadModalProps) {
  const toast = useToast();
  const [confirming, setConfirming] = useState(false);
  const [closing, setClosing] = useState(false);

  // The confirm/close affordance resets per thread via a `key` on the mount
  // (world-tab.tsx) — no reset effect needed.
  if (!thread) return null;

  const isInvestigation = thread.kind === "investigation";
  // Newest development first — the latest beat is what the player cares about.
  const developments = [...thread.developments].reverse();

  const closeThread = async () => {
    setClosing(true);
    const result = await sessionsApi.closeThread(sessionId, thread.id);
    if (result.ok) {
      await onClosed();
      onClose();
    } else {
      toast.push({ title: "Couldn't close the thread", description: result.error.message, tone: "error" });
      setClosing(false);
      setConfirming(false);
    }
  };

  const footer = isAdmin
    ? confirming
      ? [
          <span key="ask" className="mr-auto self-center text-xs text-paper-400">
            Close this thread?
          </span>,
          <Button key="cancel" variant="ghost" size="sm" onClick={() => setConfirming(false)} disabled={closing}>
            Cancel
          </Button>,
          <Button key="yes" variant="danger" size="sm" onClick={() => void closeThread()} busy={closing}>
            Yes, close
          </Button>,
        ]
      : [
          <Button key="close-thread" variant="danger" size="sm" onClick={() => setConfirming(true)}>
            Close thread
          </Button>,
        ]
    : undefined;

  return (
    <Dialog
      open={true}
      onClose={onClose}
      className="max-w-lg"
      title={
        <span className="flex items-center gap-2">
          <span className="min-w-0 flex-1 truncate">{thread.title}</span>
          <Tag tone={isInvestigation ? "accent" : "default"}>{thread.kind}</Tag>
          {thread.status === "cooling" ? <Tag>cooling</Tag> : null}
        </span>
      }
      footer={footer}
    >
      <div className="flex flex-col gap-4">
        {thread.question ? <p className="text-xs text-paper-400 italic">{thread.question}</p> : null}

        {thread.summary ? (
          <p className="leading-6 text-paper-200">{thread.summary}</p>
        ) : (
          <p className="text-xs text-paper-500 italic">No summary yet.</p>
        )}

        {isInvestigation && thread.closeConditions.length > 0 ? (
          <section className="flex flex-col gap-1.5">
            <h3 className="text-xs font-medium tracking-wide text-paper-400 uppercase">What would close this</h3>
            <ul className="flex flex-col gap-1">
              {thread.closeConditions.map((c, i) => (
                <li key={i} className="flex gap-2 text-xs text-paper-300">
                  <span className="text-paper-600">•</span>
                  <span>{c}</span>
                </li>
              ))}
            </ul>
          </section>
        ) : null}

        <section className="flex flex-col gap-1.5">
          <h3 className="text-xs font-medium tracking-wide text-paper-400 uppercase">Developments</h3>
          {developments.length === 0 ? (
            <p className="text-xs text-paper-500 italic">Nothing recorded yet.</p>
          ) : (
            <ul className="flex flex-col gap-2">
              {developments.map((d, i) => (
                <li key={i} className="flex gap-2 text-xs leading-5">
                  <span className="shrink-0 font-mono text-paper-500">T{d.turn}</span>
                  <span className="text-paper-300">{d.text}</span>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
    </Dialog>
  );
}
