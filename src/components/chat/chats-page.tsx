"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { useAsyncData } from "@/components/hooks/use-async";
import { NewChatDialog } from "@/components/chat/new-chat-dialog";
import { PageContainer } from "@/components/shell/app-shell";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { cx } from "@/components/ui/cx";
import { Dialog } from "@/components/ui/dialog";
import { EmptyState } from "@/components/ui/empty-state";
import { EntityImage } from "@/components/ui/entity-image";
import { ErrorState } from "@/components/ui/error-state";
import { Input } from "@/components/ui/input";
import { MoodChip } from "@/components/ui/mood-chip";
import { Skeleton } from "@/components/ui/skeleton";
import { Tag } from "@/components/ui/tag";
import { useToast } from "@/components/ui/toast";
import { chatsApi, type ChatSummary } from "@/lib/client/api";
import { timeAgo } from "@/lib/relative-time";

type Shelf = "active" | "archived";

/**
 * "Has something to say" marker (character-chat-standalone.spec.md §8.4, D4):
 * a small accent dot on rows whose `ChatSummary.say` is non-empty — the
 * character's top open loop, surfaced as the tooltip/aria reason. Clicking it
 * bypasses plain row navigation and opens the chat with `?say=1`, so they can
 * speak about exactly this. Shared by the Chats hub and the dashboard rows.
 */
export function ChatSayMarker({ chatId, say, className }: { chatId: string; say: string; className?: string }) {
  const router = useRouter();
  if (!say) return null;
  return (
    <button
      type="button"
      title={say}
      aria-label={`Has something to say: ${say}`}
      onClick={(e) => {
        // Hosted over (hub) or inside (dashboard) a row-navigation link — this
        // click means "open about this", not the plain row open.
        e.preventDefault();
        e.stopPropagation();
        router.push(`/chat/${chatId}?say=1`);
      }}
      className={cx(
        "relative z-10 inline-flex size-5 shrink-0 cursor-pointer items-center justify-center rounded-full transition-colors hover:bg-ink-700",
        className,
      )}
    >
      <span aria-hidden className="block size-2 rounded-full bg-accent-400" />
    </button>
  );
}

const SHELVES: { id: Shelf; label: string }[] = [
  { id: "active", label: "Active" },
  { id: "archived", label: "Archived" },
];

/**
 * The Chats hub (character-chat-standalone.spec.md §2.2): every conversation,
 * newest first — portrait, name, last-line snippet, mood + stage chips — with
 * per-row rename / archive-or-restore / delete and the "New conversation"
 * entry into `NewChatDialog`. `newCharacterId` (the `?new=` param, read by the
 * server page) opens that dialog pre-picked on mount.
 */
export function ChatsPage({ newCharacterId }: { newCharacterId?: string }) {
  const router = useRouter();
  const toast = useToast();
  const [shelf, setShelf] = useState<Shelf>("active");
  const archived = shelf === "archived";
  const list = useAsyncData(() => chatsApi.list({ archived }), [archived]);
  const { reload } = list;

  const [newChat, setNewChat] = useState<{ open: boolean; characterId?: string }>(() =>
    newCharacterId ? { open: true, characterId: newCharacterId } : { open: false },
  );
  const closeNewChat = () => {
    setNewChat({ open: false });
    // Strip a consumed ?new= so a refresh doesn't reopen the dialog.
    if (newCharacterId) router.replace("/chat", { scroll: false });
  };

  const [renameTarget, setRenameTarget] = useState<ChatSummary | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const [renaming, setRenaming] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<ChatSummary | null>(null);
  const [deleting, setDeleting] = useState(false);
  /** Row whose archive/restore call is in flight — disables just that cluster. */
  const [actingId, setActingId] = useState<string | null>(null);

  const openRename = (chat: ChatSummary) => {
    setRenameTarget(chat);
    setRenameValue(chat.title);
  };

  const saveRename = async () => {
    if (!renameTarget || renaming) return;
    setRenaming(true);
    const result = await chatsApi.update(renameTarget.id, { title: renameValue.trim() });
    setRenaming(false);
    if (!result.ok) {
      toast.push({ title: "Couldn't rename", description: result.error.message, tone: "error" });
      return;
    }
    setRenameTarget(null);
    reload({ silent: true });
  };

  const toggleArchive = async (chat: ChatSummary) => {
    if (actingId) return;
    setActingId(chat.id);
    const result = await chatsApi.update(chat.id, { archived: !archived });
    setActingId(null);
    if (!result.ok) {
      toast.push({
        title: archived ? "Couldn't restore" : "Couldn't archive",
        description: result.error.message,
        tone: "error",
      });
      return;
    }
    reload({ silent: true });
  };

  const confirmDelete = async () => {
    if (!deleteTarget || deleting) return;
    setDeleting(true);
    const result = await chatsApi.remove(deleteTarget.id);
    setDeleting(false);
    if (!result.ok) {
      toast.push({ title: "Couldn't delete", description: result.error.message, tone: "error" });
      return;
    }
    setDeleteTarget(null);
    reload({ silent: true });
  };

  const chats = list.data ?? [];

  return (
    <PageContainer>
      <div className="mb-6 flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="prose-display text-2xl">Chats</h1>
          <p className="mt-1 text-sm text-paper-400">Every conversation you have going, sorted by recency.</p>
        </div>
        <Button variant="primary" onClick={() => setNewChat({ open: true })}>
          New conversation
        </Button>
      </div>

      <div role="tablist" aria-label="Active or archived conversations" className="mb-5 inline-flex gap-1 rounded-md border border-ink-600 bg-ink-850 p-1">
        {SHELVES.map((opt) => (
          <button
            key={opt.id}
            type="button"
            role="tab"
            aria-selected={shelf === opt.id}
            onClick={() => setShelf(opt.id)}
            className={cx(
              "cursor-pointer rounded px-3 py-1 text-xs transition-colors",
              shelf === opt.id ? "bg-ink-700 text-paper-50" : "text-paper-400 hover:text-paper-200",
            )}
          >
            {opt.label}
          </button>
        ))}
      </div>

      {list.loading ? (
        <div className="flex flex-col gap-3" aria-hidden="true">
          {Array.from({ length: 4 }, (_, i) => (
            <div key={i} className="flex items-center gap-3 rounded-card border border-ink-600 bg-ink-800 p-3">
              <Skeleton className="size-12 rounded-full" />
              <div className="flex-1">
                <Skeleton className="mb-2 h-4 w-40" />
                <Skeleton className="h-3 w-2/3" />
              </div>
            </div>
          ))}
        </div>
      ) : list.error ? (
        <ErrorState error={list.error} onRetry={() => list.reload()} />
      ) : chats.length === 0 ? (
        archived ? (
          <EmptyState title="Nothing archived" description="Shelved conversations land here, restorable any time." />
        ) : (
          <EmptyState
            title="No conversations yet"
            description="Pick someone to talk to — they'll remember you next time."
            action={
              <Button variant="primary" onClick={() => setNewChat({ open: true })}>
                New conversation
              </Button>
            }
          />
        )
      ) : (
        <div className="flex flex-col gap-3">
          {chats.map((chat) => {
            const stamp = chat.lastMessageAt ? timeAgo(chat.lastMessageAt) : null;
            // §8.4 marker — active shelf only (an archived chat has nothing pending to surface).
            const say = archived ? "" : chat.say;
            return (
              <Card key={chat.id} interactive className="group relative">
                {/* Overlay link = whole-row navigation; the positioned action cluster below paints above it. */}
                <Link
                  href={`/chat/${chat.id}`}
                  className="absolute inset-0 rounded-card"
                  aria-label={`Open conversation with ${chat.characterName}`}
                />
                <div className="flex items-center gap-3 p-3">
                  <EntityImage
                    imageId={chat.avatarImageId}
                    name={chat.characterName}
                    className="size-12 shrink-0 rounded-full text-sm"
                  />
                  <div className="min-w-0 flex-1">
                    <div className="flex items-baseline gap-2">
                      <span className="prose-display truncate text-base group-hover:text-accent-300">
                        {chat.characterName}
                      </span>
                      {chat.title ? <span className="min-w-0 truncate text-xs text-paper-500">{chat.title}</span> : null}
                      {say ? <ChatSayMarker chatId={chat.id} say={say} className="ml-auto self-center" /> : null}
                      {stamp ? (
                        <span className={cx("shrink-0 text-[11px] text-paper-500", !say && "ml-auto")}>{stamp}</span>
                      ) : null}
                    </div>
                    <p className="mt-0.5 truncate text-sm text-paper-400">{chat.lastLine ?? "No messages yet"}</p>
                    {chat.emotion || chat.regardBand ? (
                      <div className="mt-1 flex flex-wrap items-center gap-2">
                        {chat.emotion ? <MoodChip emotion={chat.emotion} className="text-xs" /> : null}
                        {chat.regardBand ? <Tag>{chat.regardBand.label}</Tag> : null}
                      </div>
                    ) : null}
                  </div>
                  {/* `.hover-reveal` (globals.css): hover-gated on pointer devices, always
                      shown on touch. `.touch-target` gives each button a ≥44px coarse-pointer
                      tap height and the gap widens on coarse too — these float over the
                      card's whole-row navigation Link, so a slightly-off tap must still land
                      on the intended action instead of navigating (mobile-ux W3 task 5). */}
                  <div className="hover-reveal relative flex shrink-0 items-center gap-0.5 pointer-coarse:gap-2">
                    <button
                      type="button"
                      onClick={() => openRename(chat)}
                      className="touch-target inline-flex cursor-pointer items-center justify-center rounded px-2 py-1 text-[11px] text-paper-500 hover:text-paper-200"
                    >
                      Rename
                    </button>
                    <button
                      type="button"
                      disabled={actingId === chat.id}
                      onClick={() => void toggleArchive(chat)}
                      className="touch-target inline-flex cursor-pointer items-center justify-center rounded px-2 py-1 text-[11px] text-paper-500 hover:text-paper-200 disabled:cursor-not-allowed disabled:text-paper-600"
                    >
                      {archived ? "Restore" : "Archive"}
                    </button>
                    <button
                      type="button"
                      onClick={() => setDeleteTarget(chat)}
                      className="touch-target inline-flex cursor-pointer items-center justify-center rounded px-2 py-1 text-[11px] text-paper-500 hover:text-danger-400"
                    >
                      Delete…
                    </button>
                  </div>
                </div>
              </Card>
            );
          })}
        </div>
      )}

      <NewChatDialog open={newChat.open} onClose={closeNewChat} characterId={newChat.characterId} />

      <Dialog
        open={renameTarget !== null}
        onClose={() => {
          if (!renaming) setRenameTarget(null);
        }}
        title="Rename conversation"
        footer={
          <>
            <Button onClick={() => setRenameTarget(null)} disabled={renaming}>
              Cancel
            </Button>
            <Button variant="primary" busy={renaming} onClick={() => void saveRename()}>
              Save
            </Button>
          </>
        }
      >
        <Input
          value={renameValue}
          maxLength={120}
          placeholder={renameTarget ? `Conversation with ${renameTarget.characterName}` : ""}
          onChange={(e) => setRenameValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") void saveRename();
          }}
          autoFocus
        />
      </Dialog>

      <Dialog
        open={deleteTarget !== null}
        onClose={() => {
          if (!deleting) setDeleteTarget(null);
        }}
        title="Delete conversation?"
        footer={
          <>
            <Button onClick={() => setDeleteTarget(null)} disabled={deleting}>
              Cancel
            </Button>
            <Button variant="danger" busy={deleting} onClick={() => void confirmDelete()}>
              Delete
            </Button>
          </>
        }
      >
        This permanently deletes your conversation with{" "}
        <span className="text-paper-100">{deleteTarget?.characterName ?? "this character"}</span> — the transcript and
        everything they remember from it. Scene images stay in the Gallery.
      </Dialog>
    </PageContainer>
  );
}
