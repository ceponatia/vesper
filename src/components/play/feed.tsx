"use client";

import { useCallback, useLayoutEffect, useRef, useState } from "react";
import type { FeedMessage, StatusParticipant, UseSession } from "@/lib/client/use-session";
import { Button, Spinner } from "@/components/ui/button";
import { cx } from "@/components/ui/cx";
import { Dialog } from "@/components/ui/dialog";
import { EmptyState } from "@/components/ui/empty-state";
import { EntityImage } from "@/components/ui/entity-image";
import { ErrorState } from "@/components/ui/error-state";
import { SkeletonText } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";
import { useToast } from "@/components/ui/toast";
import { InlineProse } from "./prose";

/** Pinned = viewport bottom within this many px of the feed bottom (docs/ui.md). */
const PIN_THRESHOLD_PX = 80;

function findSpeaker(participants: StatusParticipant[], speaker: string | null): StatusParticipant | null {
  if (!speaker) return null;
  const lower = speaker.toLowerCase();
  return participants.find((p) => p.displayName.toLowerCase() === lower) ?? null;
}

// ---------------------------------------------------------------------------
// Message bodies by role
// ---------------------------------------------------------------------------

function NarratorBody({ content, streamingCursor }: { content: string; streamingCursor?: boolean }) {
  return (
    <div className="font-serif text-[17px] leading-7 text-paper-100">
      <InlineProse text={content} className="inline" />
      {streamingCursor ? <span className="ml-0.5 inline-block animate-pulse text-accent-400">▍</span> : null}
    </div>
  );
}

function CharacterBody({
  speaker,
  content,
  participant,
  streamingCursor,
}: {
  speaker: string;
  content: string;
  participant: StatusParticipant | null;
  streamingCursor?: boolean;
}) {
  return (
    <div className="flex max-w-[88%] items-start gap-3">
      <EntityImage
        imageId={participant?.avatarImageId ?? null}
        name={speaker}
        className="mt-1 size-8 shrink-0 rounded-full"
      />
      <div className="min-w-0 rounded-2xl rounded-tl-sm border border-ink-600 bg-ink-800 px-4 py-2.5">
        <p className="mb-1 text-xs font-medium text-accent-300">{speaker}</p>
        <div className="text-[15px] leading-6 text-paper-100">
          <InlineProse text={content} className="inline" />
          {streamingCursor ? <span className="ml-0.5 inline-block animate-pulse text-accent-400">▍</span> : null}
        </div>
      </div>
    </div>
  );
}

function PlayerBody({ content, pending = false }: { content: string; pending?: boolean }) {
  return (
    <div
      className={cx(
        "ml-auto max-w-[80%] rounded-2xl rounded-br-sm border border-accent-500/25 bg-accent-500/10 px-4 py-2.5 text-[15px] leading-6 text-paper-100",
        pending && "opacity-80",
      )}
    >
      <InlineProse text={content} />
    </div>
  );
}

function SystemDivider({ content }: { content: string }) {
  return (
    <div className="flex items-center gap-3 py-1 text-xs text-paper-500">
      <span className="h-px flex-1 bg-ink-600" aria-hidden="true" />
      <span className="max-w-[70%] text-center italic">{content}</span>
      <span className="h-px flex-1 bg-ink-600" aria-hidden="true" />
    </div>
  );
}

// ---------------------------------------------------------------------------
// A feed row with hover actions + inline edit
// ---------------------------------------------------------------------------

interface RowProps {
  message: FeedMessage;
  participants: StatusParticipant[];
  actionsDisabled: boolean;
  onEdit: (message: FeedMessage, content: string) => Promise<boolean>;
  onDelete: (message: FeedMessage) => void;
  onRerun: (message: FeedMessage) => void;
}

function MessageRow({ message, participants, actionsDisabled, onEdit, onDelete, onRerun }: RowProps) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const [saving, setSaving] = useState(false);

  const startEdit = () => {
    setDraft(message.content);
    setEditing(true);
  };
  const save = async () => {
    setSaving(true);
    const ok = await onEdit(message, draft);
    setSaving(false);
    if (ok) setEditing(false);
  };

  if (message.role === "system") return <SystemDivider content={message.content} />;

  const body = editing ? (
    <div className="w-full">
      <Textarea value={draft} onChange={(e) => setDraft(e.target.value)} rows={4} autoFocus />
      <div className="mt-2 flex justify-end gap-2">
        <Button size="sm" variant="quiet" onClick={() => setEditing(false)} disabled={saving}>
          Cancel
        </Button>
        <Button size="sm" variant="primary" onClick={() => void save()} busy={saving} disabled={draft.trim() === ""}>
          Save
        </Button>
      </div>
    </div>
  ) : message.role === "player" ? (
    <PlayerBody content={message.content} />
  ) : message.role === "character" && message.speaker ? (
    <CharacterBody
      speaker={message.speaker}
      content={message.content}
      participant={findSpeaker(participants, message.speaker)}
    />
  ) : (
    <NarratorBody content={message.content} />
  );

  return (
    <div className="group relative">
      {body}
      {!editing ? (
        <div
          className={cx(
            "absolute -top-3 right-0 hidden items-center gap-0.5 rounded-md border border-ink-600 bg-ink-850 px-1 py-0.5 shadow-lift",
            !actionsDisabled && "group-hover:flex group-focus-within:flex",
          )}
        >
          <Button size="sm" variant="quiet" onClick={startEdit} aria-label="Edit message">
            Edit
          </Button>
          <Button size="sm" variant="quiet" onClick={() => onRerun(message)} aria-label="Rerun turn">
            Rerun
          </Button>
          <Button size="sm" variant="quiet" onClick={() => onDelete(message)} aria-label="Delete message">
            Delete
          </Button>
        </div>
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Streaming block (live segments + the player's pending echo)
// ---------------------------------------------------------------------------

function StreamingBlock({ session }: { session: UseSession }) {
  const { streaming } = session;
  const participants = session.status?.participants ?? [];
  if (!streaming.active && !session.incomplete) return null;
  const lastIndex = streaming.segments[streaming.segments.length - 1]?.segmentIndex;
  const showCursor = streaming.phase === "narrating";

  return (
    <div className="flex flex-col gap-4" aria-live="polite">
      {streaming.echo ? (
        streaming.echo.author === "director" ? (
          <SystemDivider content={`Direction — ${streaming.echo.input}`} />
        ) : streaming.echo.author === "companion" && streaming.echo.speakerName ? (
          <CharacterBody
            speaker={streaming.echo.speakerName}
            content={streaming.echo.input}
            participant={findSpeaker(participants, streaming.echo.speakerName)}
          />
        ) : (
          <PlayerBody content={streaming.echo.input} pending />
        )
      ) : null}
      {streaming.segments.map((segment) =>
        segment.speaker ? (
          <CharacterBody
            key={segment.segmentIndex}
            speaker={segment.speaker}
            content={segment.content}
            participant={findSpeaker(participants, segment.speaker)}
            streamingCursor={showCursor && segment.segmentIndex === lastIndex}
          />
        ) : (
          <NarratorBody
            key={segment.segmentIndex}
            content={segment.content}
            streamingCursor={showCursor && segment.segmentIndex === lastIndex}
          />
        ),
      )}
      {streaming.segments.length === 0 && streaming.phase === "narrating" ? (
        <p className="flex items-center gap-2 text-sm text-paper-500 italic">
          <Spinner /> The narrator considers…
        </p>
      ) : null}
      {session.incomplete ? (
        <div className="flex items-center justify-between gap-3 rounded-card border border-ink-500 bg-ink-850 px-4 py-3">
          <p className="text-sm text-paper-400">
            The connection dropped mid-turn. The story continues server-side.
          </p>
          <Button size="sm" onClick={() => void session.recoverIncomplete()}>
            Catch up
          </Button>
        </div>
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// The feed
// ---------------------------------------------------------------------------

export function Feed({ session }: { session: UseSession }) {
  const toast = useToast();
  const scrollRef = useRef<HTMLDivElement>(null);
  const pinnedRef = useRef(true);
  const [pinned, setPinned] = useState(true);
  // Set before loadOlder so the layout effect can restore the viewport after
  // the prepend renders (the reader is never yanked, docs/ui.md).
  const prependAnchorRef = useRef<{ height: number; top: number } | null>(null);
  const [confirming, setConfirming] = useState<FeedMessage | null>(null);
  const [deleting, setDeleting] = useState(false);

  const participants = session.status?.participants ?? [];
  const actionsDisabled = session.busy !== null;

  const measurePinned = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight <= PIN_THRESHOLD_PX;
    pinnedRef.current = nearBottom;
    setPinned(nearBottom);
  }, []);

  const streamLength = session.streaming.segments.reduce((sum, s) => sum + s.content.length, 0);

  const echoActive = session.streaming.echo !== null;
  const prevEchoActiveRef = useRef(false);

  // One layout effect owns scroll correction: restore after a prepend,
  // otherwise stick to the bottom while pinned. Unpinned appends fall
  // through to "do nothing" — content grows below the viewport.
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    // Sending your own message re-pins regardless of scroll position — the
    // echo appearing is the submit signal, and the reply should be watched
    // live. The scroll this triggers re-syncs `pinned` via measurePinned.
    if (echoActive && !prevEchoActiveRef.current) pinnedRef.current = true;
    prevEchoActiveRef.current = echoActive;
    const anchor = prependAnchorRef.current;
    if (anchor) {
      prependAnchorRef.current = null;
      el.scrollTop = el.scrollHeight - anchor.height + anchor.top;
      return;
    }
    if (pinnedRef.current) el.scrollTop = el.scrollHeight;
  }, [session.feed, streamLength, session.streaming.active, session.incomplete, echoActive]);

  const jumpToLatest = () => {
    const el = scrollRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
    pinnedRef.current = true;
    setPinned(true);
  };

  const loadOlder = async () => {
    const el = scrollRef.current;
    if (el) prependAnchorRef.current = { height: el.scrollHeight, top: el.scrollTop };
    await session.loadOlder();
  };

  const handleEdit = async (message: FeedMessage, content: string): Promise<boolean> => {
    const trimmed = content.trim();
    if (trimmed === "" || trimmed === message.content) return true;
    const result = await session.editMessage(message.id, trimmed);
    if (!result.ok) {
      toast.push({ title: "Couldn't save the edit", description: result.error.message, tone: "error" });
      return false;
    }
    return true;
  };

  const handleDelete = async () => {
    if (!confirming) return;
    setDeleting(true);
    const result = await session.deleteMessage(confirming.id);
    setDeleting(false);
    setConfirming(null);
    if (!result.ok) {
      toast.push({ title: "Couldn't delete the message", description: result.error.message, tone: "error" });
    }
  };

  const handleRerun = async (message: FeedMessage) => {
    const result = await session.rerunMessage(message.id);
    if (!result.ok) {
      toast.push({
        title: result.error.status === 409 ? "The session is busy" : "Couldn't rerun the turn",
        description: result.error.message,
        tone: "error",
      });
    }
  };

  return (
    <div className="relative min-h-0 flex-1">
      <div
        ref={scrollRef}
        onScroll={measurePinned}
        className="h-full overflow-y-auto overscroll-contain px-4 py-6 sm:px-8"
      >
        <div className="mx-auto flex max-w-3xl flex-col gap-5">
          {session.hasOlder ? (
            <div className="flex justify-center">
              <Button size="sm" variant="quiet" busy={session.loadingOlder} onClick={() => void loadOlder()}>
                Load earlier
              </Button>
            </div>
          ) : null}

          {session.feedLoading ? (
            <SkeletonText lines={6} />
          ) : session.feedError ? (
            <ErrorState error={session.feedError} onRetry={() => void session.refresh()} />
          ) : session.feed.length === 0 && !session.streaming.active ? (
            <EmptyState
              title="The story hasn't begun"
              description="Write what you do below — the narrator takes it from there."
            />
          ) : (
            session.feed.map((message) => (
              <MessageRow
                key={message.id}
                message={message}
                participants={participants}
                actionsDisabled={actionsDisabled}
                onEdit={handleEdit}
                onDelete={setConfirming}
                onRerun={(m) => void handleRerun(m)}
              />
            ))
          )}

          <StreamingBlock session={session} />
        </div>
      </div>

      {!pinned ? (
        <button
          type="button"
          onClick={jumpToLatest}
          className="absolute bottom-4 left-1/2 z-10 -translate-x-1/2 cursor-pointer rounded-full border border-ink-500 bg-ink-800 px-4 py-1.5 text-xs text-paper-200 shadow-lift transition-colors hover:border-accent-500 hover:text-paper-50"
        >
          ↓ Jump to latest
        </button>
      ) : null}

      <Dialog
        open={confirming !== null}
        onClose={() => setConfirming(null)}
        title="Delete this message?"
        footer={
          <>
            <Button size="sm" variant="quiet" onClick={() => setConfirming(null)} disabled={deleting}>
              Cancel
            </Button>
            <Button size="sm" variant="danger" onClick={() => void handleDelete()} busy={deleting}>
              Delete
            </Button>
          </>
        }
      >
        The message is removed from the story feed. World state already derived from this turn is not
        rewound.
      </Dialog>
    </div>
  );
}
