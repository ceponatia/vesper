"use client";

import { useState } from "react";
import Link from "next/link";
import { galleryApi, type SceneImage } from "@/lib/client/api";
import { useAsyncData } from "@/components/hooks/use-async";
import { PageContainer } from "@/components/shell/app-shell";
import { EmptyState } from "@/components/ui/empty-state";
import { EntityImage } from "@/components/ui/entity-image";
import { ErrorState } from "@/components/ui/error-state";
import { ImageLightbox } from "@/components/ui/image-lightbox";
import { Select } from "@/components/ui/select";
import { SkeletonCards } from "@/components/ui/skeleton";

interface Facet {
  id: string;
  name: string;
}

interface SessionGroup {
  sessionId: string;
  title: string;
  worldName: string | null;
  scenes: SceneImage[];
}

/** Display names of the characters a scene features (kind: "character" refs). */
function characterNames(scene: SceneImage): string[] {
  return scene.references.filter((r) => r.kind === "character").map((r) => r.name).filter(Boolean);
}

function shortDate(iso: string | null): string {
  if (!iso) return "";
  const date = new Date(iso);
  return Number.isNaN(date.getTime())
    ? ""
    : date.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
}

/** First-wins dedupe by id, preserving encounter order. */
function uniqueFacets(pairs: Facet[]): Facet[] {
  const byId = new Map<string, string>();
  for (const pair of pairs) if (!byId.has(pair.id)) byId.set(pair.id, pair.name);
  return [...byId].map(([id, name]) => ({ id, name }));
}

/**
 * Gallery (docs/ui.md): every generated scene image across the user's still-existing
 * sessions, grouped by session (recency order from the API) and filterable by world
 * and character. Filtering + facets are client-side over the one payload.
 */
export function GalleryPage() {
  const gallery = useAsyncData(() => galleryApi.list(), []);
  const [worldFilter, setWorldFilter] = useState("");
  const [characterFilter, setCharacterFilter] = useState("");
  const [enlarged, setEnlarged] = useState<{ id: string; caption: string } | null>(null);

  const scenes = gallery.data ?? [];

  // Facets from the full set so the dropdowns stay stable while filtering.
  const worldFacets = uniqueFacets(
    scenes.flatMap((s) => (s.worldId ? [{ id: s.worldId, name: s.worldName ?? "Untitled world" }] : [])),
  );
  const characterFacets = uniqueFacets(
    scenes.flatMap((s) =>
      s.references.filter((r) => r.kind === "character").map((r) => ({ id: r.id, name: r.name || "Unnamed" })),
    ),
  );

  const filtered = scenes.filter(
    (s) =>
      (worldFilter === "" || s.worldId === worldFilter) &&
      (characterFilter === "" || s.references.some((r) => r.kind === "character" && r.id === characterFilter)),
  );

  // Group by session, preserving the payload's recency order.
  const groups: SessionGroup[] = [];
  const groupIndex = new Map<string, number>();
  for (const scene of filtered) {
    const at = groupIndex.get(scene.sessionId);
    if (at === undefined) {
      groupIndex.set(scene.sessionId, groups.length);
      groups.push({ sessionId: scene.sessionId, title: scene.sessionTitle, worldName: scene.worldName, scenes: [scene] });
    } else {
      groups[at]?.scenes.push(scene);
    }
  }

  return (
    <PageContainer wide>
      <div className="mb-6 flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="prose-display text-3xl">Gallery</h1>
          <p className="mt-1 text-sm text-paper-400">Generated scene images from your sessions.</p>
        </div>
        {scenes.length > 0 ? (
          <div className="flex flex-wrap items-center gap-2">
            <Select
              aria-label="Filter by world"
              value={worldFilter}
              onChange={(e) => setWorldFilter(e.target.value)}
              className="h-8 text-xs"
            >
              <option value="">All worlds</option>
              {worldFacets.map((w) => (
                <option key={w.id} value={w.id}>
                  {w.name}
                </option>
              ))}
            </Select>
            <Select
              aria-label="Filter by character"
              value={characterFilter}
              onChange={(e) => setCharacterFilter(e.target.value)}
              className="h-8 text-xs"
            >
              <option value="">All characters</option>
              {characterFacets.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </Select>
          </div>
        ) : null}
      </div>

      {gallery.loading ? (
        <SkeletonCards count={8} />
      ) : gallery.error ? (
        <ErrorState error={gallery.error} onRetry={() => gallery.reload()} />
      ) : scenes.length === 0 ? (
        <EmptyState
          title="No scene images yet"
          description="Turn on scene generation in a session's Scene tab — the artwork it creates collects here."
        />
      ) : groups.length === 0 ? (
        <EmptyState
          title="No scenes match these filters"
          description="Try a different world or character."
          action={
            <button
              type="button"
              onClick={() => {
                setWorldFilter("");
                setCharacterFilter("");
              }}
              className="cursor-pointer text-sm text-accent-300 hover:text-accent-400"
            >
              Clear filters
            </button>
          }
        />
      ) : (
        <div className="flex flex-col gap-10">
          {groups.map((group) => (
            <section key={group.sessionId}>
              <div className="mb-3 flex items-baseline justify-between gap-3">
                <Link href={`/sessions/${group.sessionId}`} className="group min-w-0">
                  <h2 className="prose-display truncate text-xl group-hover:text-accent-300">{group.title}</h2>
                </Link>
                {group.worldName ? <span className="shrink-0 text-xs text-paper-500">{group.worldName}</span> : null}
              </div>
              <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
                {group.scenes.map((scene) => {
                  const names = characterNames(scene);
                  const date = shortDate(scene.createdAt);
                  const meta = [names.join(", "), group.worldName, group.title, date].filter(Boolean).join(" · ");
                  return (
                    <figure key={scene.id} className="flex flex-col gap-1.5">
                      <button
                        type="button"
                        onClick={() => setEnlarged({ id: scene.id, caption: scene.prompt ? `${meta} — ${scene.prompt}` : meta })}
                        aria-label="Enlarge scene image"
                        className="block cursor-pointer overflow-hidden rounded-card border border-ink-600 transition-colors hover:border-accent-500/60"
                      >
                        <EntityImage imageId={scene.id} name={names[0] ?? group.title} className="aspect-[3/4] w-full" />
                      </button>
                      <figcaption className="flex items-baseline justify-between gap-2 px-0.5 text-[11px] text-paper-500">
                        <span className="truncate text-paper-400">{names.join(", ") || "Scene"}</span>
                        {date ? <span className="shrink-0">{date}</span> : null}
                      </figcaption>
                    </figure>
                  );
                })}
              </div>
            </section>
          ))}
        </div>
      )}

      <ImageLightbox
        imageId={enlarged?.id ?? null}
        alt="Scene image"
        caption={enlarged?.caption ?? null}
        onClose={() => setEnlarged(null)}
      />
    </PageContainer>
  );
}
