"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { sessionsApi, worldsApi, type LoreChunkEntry } from "@/lib/client/api";
import { useAsyncData } from "@/components/hooks/use-async";
import { PageContainer } from "@/components/shell/app-shell";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Dialog } from "@/components/ui/dialog";
import { EntityImage } from "@/components/ui/entity-image";
import { ErrorState } from "@/components/ui/error-state";
import { Skeleton, SkeletonText } from "@/components/ui/skeleton";
import { Tag } from "@/components/ui/tag";
import { useToast } from "@/components/ui/toast";

export function WorldDetailPage({ worldId }: { worldId: string }) {
  const router = useRouter();
  const toast = useToast();
  const world = useAsyncData(() => worldsApi.get(worldId), [worldId]);
  const sessions = useAsyncData(() => sessionsApi.forWorld(worldId), [worldId]);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [duplicating, setDuplicating] = useState(false);
  const [togglingLoreId, setTogglingLoreId] = useState<string | null>(null);
  const [confirmDeleteSessionId, setConfirmDeleteSessionId] = useState<string | null>(null);
  const [deletingSession, setDeletingSession] = useState(false);

  if (world.loading) {
    return (
      <PageContainer wide>
        <Skeleton className="mb-6 h-10 w-80" />
        <SkeletonText lines={8} />
      </PageContainer>
    );
  }

  if (world.error || !world.data) {
    return (
      <PageContainer wide>
        <ErrorState
          error={world.error ?? { status: 0, code: "missing", message: "World not found" }}
          onRetry={() => world.reload()}
        />
      </PageContainer>
    );
  }

  const detail = world.data;
  const locationNameById = new Map(detail.locations.map((loc) => [loc.id, loc.name]));
  const worldSessions = (sessions.data ?? []).filter((s) => !s.worldId || s.worldId === worldId);

  const duplicate = async () => {
    setDuplicating(true);
    const result = await worldsApi.duplicate(worldId);
    setDuplicating(false);
    if (result.ok) {
      toast.push({ title: "World duplicated", tone: "success" });
      router.push(`/worlds/${result.data.id}`);
    } else {
      toast.push({ title: "Duplicate failed", description: result.error.message, tone: "error" });
    }
  };

  const remove = async () => {
    setDeleting(true);
    const result = await worldsApi.remove(worldId);
    setDeleting(false);
    if (result.ok) {
      router.push("/worlds");
    } else {
      toast.push({ title: "Delete failed", description: result.error.message, tone: "error" });
      setConfirmDelete(false);
    }
  };

  const removeSession = async () => {
    if (!confirmDeleteSessionId) return;
    setDeletingSession(true);
    const result = await sessionsApi.remove(confirmDeleteSessionId);
    setDeletingSession(false);
    setConfirmDeleteSessionId(null);
    if (result.ok) {
      toast.push({ title: "Session deleted", tone: "success" });
      sessions.reload({ silent: true });
    } else {
      toast.push({ title: "Delete failed", description: result.error.message, tone: "error" });
    }
  };

  const toggleUnlock = async (chunk: LoreChunkEntry) => {
    setTogglingLoreId(chunk.id);
    const result = await worldsApi.update(worldId, {
      loreChunks: [{ id: chunk.id, manuallyUnlocked: !chunk.manuallyUnlocked }],
    });
    setTogglingLoreId(null);
    if (result.ok) {
      world.reload({ silent: true });
    } else {
      toast.push({ title: "Couldn't toggle unlock", description: result.error.message, tone: "error" });
    }
  };

  return (
    <PageContainer wide>
      {/* Header */}
      <div className="mb-8 flex flex-wrap items-start gap-5">
        <EntityImage imageId={detail.imageId} name={detail.name} className="h-32 w-48 rounded-card text-2xl" />
        <div className="min-w-0 flex-1">
          <h1 className="prose-display text-3xl">{detail.name}</h1>
          {detail.description ? <p className="mt-2 max-w-2xl text-sm text-paper-400">{detail.description}</p> : null}
          <div className="mt-4 flex flex-wrap gap-2">
            <Link
              href={`/sessions/new?worldId=${detail.id}`}
              className="inline-flex h-9 items-center rounded-md bg-accent-500 px-4 text-sm font-medium text-ink-950 hover:bg-accent-400"
            >
              Begin session
            </Link>
            <Link
              href={`/worlds/${detail.id}/edit`}
              className="inline-flex h-9 items-center rounded-md border border-ink-600 px-3.5 text-sm text-paper-200 hover:bg-ink-800"
            >
              Edit
            </Link>
            <Button onClick={duplicate} busy={duplicating}>
              Duplicate
            </Button>
            <Button variant="danger" onClick={() => setConfirmDelete(true)}>
              Delete
            </Button>
          </div>
        </div>
      </div>

      {/* Synopsis */}
      {detail.lore.synopsis ? (
        <section className="mb-10">
          <h2 className="mb-2 text-xs font-medium tracking-wide text-paper-400 uppercase">Synopsis</h2>
          <p className="prose-display max-w-3xl text-base leading-relaxed text-paper-100">{detail.lore.synopsis}</p>
        </section>
      ) : null}

      <div className="grid grid-cols-1 gap-10 lg:grid-cols-2">
        {/* Cast */}
        <section>
          <h2 className="mb-3 text-xs font-medium tracking-wide text-paper-400 uppercase">Cast</h2>
          {detail.cast.length === 0 ? (
            <p className="text-sm text-paper-500">No cast members.</p>
          ) : (
            <ul className="flex flex-col gap-2">
              {detail.cast.map((member) => (
                <li key={member.id}>
                  <Card className="flex items-center gap-3 p-3">
                    <EntityImage
                      imageId={member.avatarImageId}
                      name={member.name || "?"}
                      className="size-11 rounded-full"
                    />
                    <div className="min-w-0">
                      {member.characterId ? (
                        <Link
                          href={`/characters/${member.characterId}`}
                          className="truncate text-sm text-paper-100 hover:text-accent-300"
                        >
                          {member.name || "Unnamed"}
                        </Link>
                      ) : (
                        <span className="truncate text-sm text-paper-100">{member.name || "Unnamed"}</span>
                      )}
                      <div className="mt-0.5 flex items-center gap-2">
                        <Tag tone={member.role === "companion" ? "accent" : "default"}>{member.role}</Tag>
                        {member.startWorldLocationId ? (
                          <span className="text-xs text-paper-500">
                            starts: {locationNameById.get(member.startWorldLocationId) ?? "—"}
                          </span>
                        ) : null}
                      </div>
                    </div>
                  </Card>
                </li>
              ))}
            </ul>
          )}
        </section>

        {/* Map */}
        <section>
          <h2 className="mb-3 text-xs font-medium tracking-wide text-paper-400 uppercase">Map</h2>
          {detail.locations.length === 0 ? (
            <p className="text-sm text-paper-500">No locations.</p>
          ) : (
            <ul className="flex flex-col gap-2">
              {detail.locations.map((loc) => {
                const connected = detail.links
                  .filter((l) => l.fromWorldLocationId === loc.id || l.toWorldLocationId === loc.id)
                  .map((l) =>
                    locationNameById.get(l.fromWorldLocationId === loc.id ? l.toWorldLocationId : l.fromWorldLocationId),
                  )
                  .filter((n): n is string => Boolean(n));
                return (
                  <li key={loc.id}>
                    <Card className="p-3">
                      <p className="text-sm font-medium text-paper-100">{loc.name}</p>
                      {loc.description ? (
                        <p className="mt-0.5 line-clamp-2 text-xs text-paper-400">{loc.description}</p>
                      ) : null}
                      {connected.length > 0 ? (
                        <p className="mt-1.5 text-xs text-paper-500">
                          ↔ {connected.join(" · ")}
                        </p>
                      ) : null}
                    </Card>
                  </li>
                );
              })}
            </ul>
          )}
        </section>
      </div>

      {/* Lore */}
      <section className="mt-10">
        <h2 className="mb-3 text-xs font-medium tracking-wide text-paper-400 uppercase">Lore</h2>
        {detail.loreChunks.length === 0 ? (
          <p className="text-sm text-paper-500">No lore chunks.</p>
        ) : (
          <div className="overflow-x-auto rounded-card border border-ink-600">
            <table className="w-full text-left text-sm">
              <thead>
                <tr className="border-b border-ink-600 text-xs text-paper-500">
                  <th className="px-3 py-2 font-medium">Title</th>
                  <th className="px-3 py-2 font-medium">Category</th>
                  <th className="px-3 py-2 font-medium">Tier</th>
                  <th className="px-3 py-2 font-medium">Visibility</th>
                  <th className="px-3 py-2 font-medium">Unlock tags</th>
                  <th className="px-3 py-2 font-medium">Unlocked</th>
                </tr>
              </thead>
              <tbody>
                {detail.loreChunks.map((chunk) => (
                  <tr key={chunk.id} className="border-b border-ink-700 last:border-0">
                    <td className="px-3 py-2 text-paper-100" title={chunk.body}>
                      {chunk.title || "Untitled"}
                    </td>
                    <td className="px-3 py-2 text-paper-400">{chunk.category}</td>
                    <td className="px-3 py-2">
                      <Tag>{chunk.tier}</Tag>
                    </td>
                    <td className="px-3 py-2">
                      <Tag tone={chunk.visibility === "secret" ? "accent" : "default"}>{chunk.visibility}</Tag>
                    </td>
                    <td className="px-3 py-2">
                      <span className="flex flex-wrap gap-1">
                        {chunk.unlockTags.map((t) => (
                          <Tag key={t}>{t}</Tag>
                        ))}
                      </span>
                    </td>
                    <td className="px-3 py-2">
                      {chunk.visibility === "secret" ? (
                        <Button
                          size="sm"
                          busy={togglingLoreId === chunk.id}
                          onClick={() => toggleUnlock(chunk)}
                          aria-pressed={chunk.manuallyUnlocked}
                        >
                          {chunk.manuallyUnlocked ? "Unlocked" : "Locked"}
                        </Button>
                      ) : (
                        <span className="text-xs text-paper-500">—</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {/* Sessions */}
      <section className="mt-10">
        <h2 className="mb-3 text-xs font-medium tracking-wide text-paper-400 uppercase">Sessions</h2>
        {sessions.loading ? (
          <SkeletonText lines={2} />
        ) : sessions.error ? (
          <ErrorState error={sessions.error} onRetry={() => sessions.reload()} />
        ) : worldSessions.length === 0 ? (
          <p className="text-sm text-paper-500">No sessions in this world yet.</p>
        ) : (
          <ul className="flex flex-col gap-1.5">
            {worldSessions.map((session) => (
              <li key={session.id} className="flex items-center gap-2">
                <Link
                  href={`/sessions/${session.id}`}
                  className="flex min-w-0 flex-1 items-center gap-3 rounded-md border border-ink-600 bg-ink-800 px-4 py-2.5 text-sm hover:border-ink-500"
                >
                  <span className="truncate text-paper-100">{session.title}</span>
                  <Tag tone={session.status === "ready" ? "ok" : "accent"}>{session.status}</Tag>
                  {session.updatedAt ? (
                    <span className="ml-auto text-xs text-paper-500">{session.updatedAt.slice(0, 10)}</span>
                  ) : null}
                </Link>
                <Button
                  size="sm"
                  variant="danger"
                  title="Delete session"
                  onClick={() => setConfirmDeleteSessionId(session.id)}
                >
                  ✕
                </Button>
              </li>
            ))}
          </ul>
        )}
      </section>

      <Dialog
        open={confirmDeleteSessionId !== null}
        onClose={() => setConfirmDeleteSessionId(null)}
        title="Delete this session?"
        footer={
          <>
            <Button onClick={() => setConfirmDeleteSessionId(null)}>Cancel</Button>
            <Button variant="danger" busy={deletingSession} onClick={removeSession}>
              Delete
            </Button>
          </>
        }
      >
        This permanently removes its play history — turns, memories, facts and scene images. The world and its
        characters are untouched.
      </Dialog>

      <Dialog
        open={confirmDelete}
        onClose={() => setConfirmDelete(false)}
        title="Delete this world?"
        footer={
          <>
            <Button onClick={() => setConfirmDelete(false)}>Cancel</Button>
            <Button variant="danger" busy={deleting} onClick={remove}>
              Delete
            </Button>
          </>
        }
      >
        This removes {detail.name} and its map, lore and placements.
      </Dialog>
    </PageContainer>
  );
}
