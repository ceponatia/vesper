"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useRef, useState } from "react";
import { useAsyncData } from "@/components/hooks/use-async";
import { PageContainer } from "@/components/shell/app-shell";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { ErrorState } from "@/components/ui/error-state";
import { Skeleton } from "@/components/ui/skeleton";
import { Tag } from "@/components/ui/tag";
import { useToast } from "@/components/ui/toast";
import { newId } from "@/lib/ids";
import { charactersApi, chatsApi, successorChatsApi, type SuccessorChatSummary } from "@/lib/client/api";
import { formatStoryClockShort, storyClockAt } from "@/lib/simulation/clock";

/**
 * The Worlds page, repurposed (owner ruling 2026-07-22): the successor
 * engine's front door. One form spins up a complete successor chat — a fresh
 * isolated world (home + town square, the player and the chosen character in
 * the cast, a neighbor, a keepsake), the actor mapping, and the authority
 * flip — with zero backend setup. Below it, playable successor chats appear
 * with their world clock. Engine Comparison (`successor_shadow`) stays under
 * the admin comparison surface even though the historical listing API still
 * returns that authority value.
 */
export function SuccessorWorldsPage() {
  const router = useRouter();
  const toast = useToast();
  const characters = useAsyncData(() => charactersApi.list(), []);
  const chats = useAsyncData(() => successorChatsApi.list(), []);
  const [characterId, setCharacterId] = useState("");
  const [title, setTitle] = useState("");
  const [creating, setCreating] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<SuccessorChatSummary | null>(null);
  const [deleting, setDeleting] = useState(false);
  /**
   * The idempotency key for the current create INTENT
   * (successor-world-lifecycle.plan.md slice 3). Minted lazily on the first tap
   * (never during render — a render-time id would differ between the server and
   * client passes) and HELD through a failure, so tapping Create again resumes
   * the same world instead of provisioning a second one. Cleared on success and
   * whenever the form changes — a different ask is a different intent, and
   * reusing the key for it would answer `idempotency_mismatch`.
   */
  const requestIdRef = useRef<string | null>(null);
  const freshIntent = () => {
    requestIdRef.current = null;
  };

  const create = async () => {
    if (!characterId || creating) return;
    setCreating(true);
    requestIdRef.current ??= newId();
    const result = await successorChatsApi.create({
      characterId,
      requestId: requestIdRef.current,
      ...(title.trim() ? { title: title.trim() } : {}),
    });
    setCreating(false);
    if (!result.ok) {
      toast.push({ title: "Couldn't create the world", description: result.error.message, tone: "error" });
      return;
    }
    freshIntent();
    router.push(`/chat/${result.data.id}`);
  };

  /**
   * Delete a world = delete its chat (successor-world-lifecycle.plan.md slice 1,
   * owner ruling E20-1): the front door is 1:1 chat↔world, so the ordinary chat
   * DELETE is the whole verb — `deleteChat` takes the `sim_worlds` graph with the
   * chat row in one transaction. No world-specific endpoint exists or is wanted.
   */
  const confirmDelete = async () => {
    if (!deleteTarget || deleting) return;
    setDeleting(true);
    const result = await chatsApi.remove(deleteTarget.id);
    setDeleting(false);
    if (!result.ok) {
      toast.push({ title: "Couldn't delete the world", description: result.error.message, tone: "error" });
      return;
    }
    setDeleteTarget(null);
    chats.reload({ silent: true });
  };

  // The legacy GET currently returns every non-legacy authority. Comparison
  // sessions are intentionally legacy-playable experiments, not successor
  // worlds, so keep them out of this product surface even before that API is
  // narrowed by the deferred Worlds dashboard work.
  const playableChats = (chats.data?.chats ?? []).filter(
    (chat) => chat.authority === "successor_narrative_view" || chat.authority === "successor_authoritative",
  );

  return (
    <PageContainer>
      <div className="mb-6">
        <h1 className="prose-display text-2xl">Worlds</h1>
        <p className="mt-1 text-sm text-paper-400">
          Living worlds on the successor engine. Each chat here plays inside its own small world — real places, a
          real clock, characters with bodies and routines. Ordinary chats stay under Chats.
        </p>
      </div>

      <section className="mb-8 rounded-card border border-ink-600 bg-ink-850 p-4">
        <h2 className="mb-3 text-sm font-medium tracking-wide text-paper-400 uppercase">New world</h2>
        {characters.loading ? (
          <Skeleton className="h-9 w-full max-w-md" />
        ) : characters.error ? (
          <ErrorState error={characters.error} onRetry={() => characters.reload()} />
        ) : (characters.data ?? []).length === 0 ? (
          <p className="text-sm text-paper-500">
            You need a character first —{" "}
            <Link href="/characters" className="text-accent-300 hover:text-accent-200">
              create one in the Library
            </Link>
            .
          </p>
        ) : (
          <div className="flex flex-wrap items-end gap-3">
            <label className="flex flex-col gap-1">
              <span className="text-xs text-paper-400">Character</span>
              <select
                value={characterId}
                onChange={(e) => {
                  setCharacterId(e.target.value);
                  freshIntent();
                }}
                className="h-9 min-w-52 rounded-md border border-ink-600 bg-ink-900 px-2 text-sm text-paper-200"
              >
                <option value="">Choose…</option>
                {(characters.data ?? []).map((character) => (
                  <option key={character.id} value={character.id}>
                    {character.name}
                  </option>
                ))}
              </select>
            </label>
            <label className="flex flex-col gap-1">
              <span className="text-xs text-paper-400">Title (optional)</span>
              <input
                value={title}
                onChange={(e) => {
                  setTitle(e.target.value);
                  freshIntent();
                }}
                placeholder="Their world"
                maxLength={120}
                className="h-9 min-w-52 rounded-md border border-ink-600 bg-ink-900 px-2 text-sm text-paper-200 placeholder:text-paper-600"
              />
            </label>
            <Button variant="primary" busy={creating} disabled={!characterId} onClick={() => void create()}>
              Create world & chat
            </Button>
          </div>
        )}
        <p className="mt-3 text-xs text-paper-500">
          You&apos;ll get a fresh world — a home, a town square a short walk away, your character, a neighbor, and a
          keepsake in your pocket. Time moves on the world&apos;s clock; the skip chips in the chat move it further.
        </p>
      </section>

      <section>
        <h2 className="mb-3 text-sm font-medium tracking-wide text-paper-400 uppercase">Your worlds</h2>
        {chats.loading ? (
          <div className="flex flex-col gap-2" aria-hidden="true">
            {Array.from({ length: 2 }, (_, i) => (
              <Skeleton key={i} className="h-14 w-full rounded-card" />
            ))}
          </div>
        ) : chats.error ? (
          <ErrorState error={chats.error} onRetry={() => chats.reload()} />
        ) : playableChats.length === 0 ? (
          <p className="text-sm text-paper-500">No worlds yet — create one above.</p>
        ) : (
          <ul className="flex flex-col gap-2">
            {playableChats.map((chat) => (
              // The overlay Link navigates the whole row; the action cluster paints
              // above it so a slightly-off tap deletes nothing by accident (the
              // Chats hub's idiom — `.touch-target` gives a ≥44px coarse tap height).
              <li
                key={chat.id}
                className="relative rounded-card border border-ink-600 bg-ink-850 transition-colors hover:border-accent-500/50"
              >
                <Link
                  href={`/chat/${chat.id}`}
                  className="absolute inset-0 rounded-card"
                  aria-label={`Open ${chat.title || chat.characterName}`}
                />
                <div className="flex items-center justify-between gap-3 px-4 py-3">
                  <span className="min-w-0">
                    <span className="block truncate text-sm text-paper-200">{chat.title || chat.characterName}</span>
                    <span className="block text-xs text-paper-500">{chat.characterName}</span>
                  </span>
                  <span className="relative flex shrink-0 items-center gap-1.5">
                    {chat.storySecond !== null ? (
                      <Tag>{formatStoryClockShort(storyClockAt(chat.storySecond))}</Tag>
                    ) : null}
                    <Tag tone="accent">{chat.authority.replace("successor_", "").replace(/_/g, " ")}</Tag>
                    <button
                      type="button"
                      onClick={() => setDeleteTarget(chat)}
                      className="touch-target inline-flex cursor-pointer items-center justify-center rounded px-2 py-1 text-[11px] text-paper-500 hover:text-danger-400"
                    >
                      Delete…
                    </button>
                  </span>
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>

      <Dialog
        open={deleteTarget !== null}
        onClose={() => {
          if (!deleting) setDeleteTarget(null);
        }}
        title="Delete this world?"
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
        This permanently deletes{" "}
        <span className="text-paper-100">{deleteTarget?.title || deleteTarget?.characterName || "this world"}</span> —
        the conversation and the world it plays in: its people, places, and everything that has happened there. Nothing
        about the world can be recovered. Scene images stay in the Gallery.
      </Dialog>
    </PageContainer>
  );
}
