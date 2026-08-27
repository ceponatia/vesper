"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { charactersApi, galleryApi, type ApiError, type GalleryImage, type GalleryTab } from "@/lib/client/api";
import { useAsyncData } from "@/components/hooks/use-async";
import { PageContainer } from "@/components/shell/app-shell";
import { Button } from "@/components/ui/button";
import { cx } from "@/components/ui/cx";
import { Dialog } from "@/components/ui/dialog";
import { EmptyState } from "@/components/ui/empty-state";
import { EntityImage } from "@/components/ui/entity-image";
import { ErrorState } from "@/components/ui/error-state";
import { ImageLightbox } from "@/components/ui/image-lightbox";
import { Select } from "@/components/ui/select";
import { SkeletonCards } from "@/components/ui/skeleton";
import { useToast } from "@/components/ui/toast";

/** Scene grouping modes. */
type ViewMode = "character" | "timeline";

const TABS: { id: GalleryTab; label: string }[] = [
  { id: "scenes", label: "Scenes" },
  { id: "portraits", label: "Portraits" },
  { id: "entity", label: "Entity art" },
];

const VIEW_OPTIONS: { id: ViewMode; label: string }[] = [
  { id: "character", label: "By character" },
  { id: "timeline", label: "Timeline" },
];

const NONE_KEY = "__none__";

interface Facet {
  id: string;
  name: string;
}

interface GalleryGroup {
  key: string;
  /** Link target for the group heading (portrait groups only). */
  href: string | null;
  title: string;
  subtitle: string | null;
  images: GalleryImage[];
}

/** Display names of the characters a scene features, falling back to the chat partner. */
function characterNames(image: GalleryImage): string[] {
  const fromRefs = image.references.filter((r) => r.kind === "character").map((r) => r.name).filter(Boolean);
  if (fromRefs.length > 0) return fromRefs;
  return image.characterName ? [image.characterName] : [];
}

function shortDate(iso: string | null | undefined): string {
  if (!iso) return "";
  const date = new Date(iso);
  return Number.isNaN(date.getTime())
    ? ""
    : date.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
}

function monthLabel(iso: string | null | undefined): string {
  if (!iso) return "Undated";
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? "Undated" : date.toLocaleDateString(undefined, { month: "long", year: "numeric" });
}

/** First-wins dedupe by id, preserving encounter order. */
function uniqueFacets(pairs: Facet[]): Facet[] {
  const byId = new Map<string, string>();
  for (const pair of pairs) if (!byId.has(pair.id)) byId.set(pair.id, pair.name);
  return [...byId].map(([id, name]) => ({ id, name }));
}

/** Accumulate images into ordered groups (first appearance wins the order). */
function collectGroups(images: GalleryImage[], keyOf: (image: GalleryImage) => Omit<GalleryGroup, "images">): GalleryGroup[] {
  const groups: GalleryGroup[] = [];
  const index = new Map<string, number>();
  for (const image of images) {
    const head = keyOf(image);
    const at = index.get(head.key);
    if (at === undefined) {
      index.set(head.key, groups.length);
      groups.push({ ...head, images: [image] });
    } else {
      groups[at]?.images.push(image);
    }
  }
  return groups;
}

function groupScenes(images: GalleryImage[], view: ViewMode): GalleryGroup[] {
  switch (view) {
    case "character":
      return collectGroups(images, (s) => {
        const name = characterNames(s)[0];
        return name ? { key: name, href: null, title: name, subtitle: null } : { key: NONE_KEY, href: null, title: "No character", subtitle: null };
      });
    case "timeline":
      return collectGroups(images, (s) => {
        const label = monthLabel(s.createdAt);
        return { key: label, href: null, title: label, subtitle: null };
      });
  }
}

const ENTITY_GROUPS: Record<string, { label: string; order: number }> = {
  location: { label: "Locations", order: 0 },
  item: { label: "Items", order: 1 },
  world: { label: "Worlds", order: 2 },
};

/**
 * Gallery hub (docs/ui.md): the owner's generated art in three tabs — Scenes
 * (grouped by character / timeline), Portraits (by character) and Entity art
 * (by kind) — with avatar chip filters, favorites, multi-select delete, and
 * keyset "Load more" past each page.
 */
export function GalleryPage() {
  const toast = useToast();
  const [tab, setTab] = useState<GalleryTab>("scenes");
  const [view, setView] = useState<ViewMode>("character");
  const [images, setImages] = useState<GalleryImage[] | null>(null);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [reloadNonce, setReloadNonce] = useState(0);
  const [loadingMore, setLoadingMore] = useState(false);
  const [favoritesOnly, setFavoritesOnly] = useState(false);
  const [characterFilter, setCharacterFilter] = useState("");
  const [selectMode, setSelectMode] = useState(false);
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [enlarged, setEnlarged] = useState<{ id: string; caption: string; prompt: string | null } | null>(null);
  const [pendingDelete, setPendingDelete] = useState<{ ids: string[]; label: string } | null>(null);
  const [deleting, setDeleting] = useState(false);

  // The owner's characters, for avatar chips (soft map — chips degrade to initials).
  const characterList = useAsyncData(() => charactersApi.list(), []);
  const avatarByCharacter = useMemo(
    () => new Map((characterList.data ?? []).map((c) => [c.id, c.avatarImageId])),
    [characterList.data],
  );

  // First page per tab; every setState sits past the await (hooks lint).
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const result = await galleryApi.list({ tab });
      if (cancelled) return;
      if (!result.ok) {
        setError(result.error);
        return;
      }
      setImages(result.data.images);
      setNextCursor(result.data.nextCursor);
    })();
    return () => {
      cancelled = true;
    };
  }, [tab, reloadNonce]);

  const switchTab = (next: GalleryTab) => {
    if (next === tab) return;
    setTab(next);
    setImages(null);
    setNextCursor(null);
    setError(null);
    setCharacterFilter("");
    setSelectMode(false);
    setSelected(new Set());
  };

  const loadMore = async () => {
    if (!nextCursor || loadingMore) return;
    setLoadingMore(true);
    const result = await galleryApi.list({ tab, cursor: nextCursor });
    setLoadingMore(false);
    if (!result.ok) {
      toast.push({ title: "Couldn't load more", description: result.error.message, tone: "error" });
      return;
    }
    const known = new Set((images ?? []).map((i) => i.id));
    setImages([...(images ?? []), ...result.data.images.filter((i) => !known.has(i.id))]);
    setNextCursor(result.data.nextCursor);
  };

  const toggleFavorite = async (image: GalleryImage) => {
    const next = !image.favorite;
    setImages((prev) => (prev ?? []).map((i) => (i.id === image.id ? { ...i, favorite: next } : i)));
    const result = await galleryApi.favorite(image.id, next);
    if (!result.ok) {
      setImages((prev) => (prev ?? []).map((i) => (i.id === image.id ? { ...i, favorite: !next } : i)));
      toast.push({ title: "Couldn't update favorite", description: result.error.message, tone: "error" });
    }
  };

  const confirmDelete = async () => {
    if (!pendingDelete) return;
    setDeleting(true);
    const result =
      pendingDelete.ids.length === 1 && pendingDelete.ids[0]
        ? await galleryApi.remove(pendingDelete.ids[0])
        : await galleryApi.removeMany(pendingDelete.ids);
    setDeleting(false);
    if (!result.ok) {
      toast.push({ title: "Delete failed", description: result.error.message, tone: "error" });
      return;
    }
    const gone = new Set(pendingDelete.ids);
    if (enlarged && gone.has(enlarged.id)) setEnlarged(null);
    setImages((prev) => (prev ?? []).filter((i) => !gone.has(i.id)));
    setSelected(new Set());
    setSelectMode(false);
    setPendingDelete(null);
    toast.push({ title: `Deleted ${gone.size} image${gone.size === 1 ? "" : "s"}`, tone: "success" });
  };

  const loaded = images ?? [];

  // Facets from the full loaded set so the controls stay stable while filtering.
  const characterFacets = uniqueFacets(
    loaded.flatMap((s) => [
      ...s.references.filter((r) => r.kind === "character").map((r) => ({ id: r.id, name: r.name || "Unnamed" })),
      ...(s.characterId ? [{ id: s.characterId, name: s.characterName ?? "Unnamed" }] : []),
    ]),
  );

  const matchesCharacter = (image: GalleryImage) =>
    characterFilter === "" ||
    image.characterId === characterFilter ||
    image.references.some((r) => r.kind === "character" && r.id === characterFilter);

  const filtered = loaded.filter((s) => (!favoritesOnly || s.favorite) && matchesCharacter(s));

  const entityGroupOrder = (group: GalleryGroup) => ENTITY_GROUPS[group.images[0]?.entityKind ?? ""]?.order ?? 9;
  const groups: GalleryGroup[] =
    tab === "scenes"
      ? groupScenes(filtered, view)
      : tab === "portraits"
        ? collectGroups(filtered, (p) =>
            p.characterId
              ? { key: p.characterId, href: `/characters/${p.characterId}`, title: p.characterName ?? "Unnamed", subtitle: null }
              : { key: NONE_KEY, href: null, title: "Unlinked", subtitle: null },
          )
        : collectGroups(filtered, (e) => {
            const head = ENTITY_GROUPS[e.entityKind ?? ""] ?? { label: "Other", order: 9 };
            return { key: head.label, href: null, title: head.label, subtitle: null };
          }).sort((a, b) => entityGroupOrder(a) - entityGroupOrder(b));

  const toggleSelected = (id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const captionFor = (image: GalleryImage): string => {
    if (tab === "portraits") return [image.characterName, shortDate(image.createdAt)].filter(Boolean).join(" · ");
    if (tab === "entity") return [image.entityName, shortDate(image.createdAt)].filter(Boolean).join(" · ");
    return [characterNames(image).join(", "), shortDate(image.createdAt)].filter(Boolean).join(" · ");
  };

  const tileTitle = (image: GalleryImage): string => {
    if (tab === "portraits") return image.characterName ?? "Portrait";
    if (tab === "entity") return image.entityName ?? "Entity";
    return characterNames(image).join(", ") || "Scene";
  };

  const loading = images === null && !error;
  const emptyCopy: Record<GalleryTab, { title: string; description: string }> = {
    scenes: {
      title: "No scene images yet",
      description: "Generate scene images from a character chat — the artwork it creates collects here.",
    },
    portraits: {
      title: "No portraits yet",
      description: "Generate portrait variants from a character's Portrait studio — they collect here.",
    },
    entity: {
      title: "No entity art yet",
      description: "Generate images for locations and items from their library pages — they collect here.",
    },
  };

  return (
    <PageContainer wide>
      <div className="mb-4 flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="prose-display text-3xl">Gallery</h1>
          <p className="mt-1 text-sm text-paper-400">Generated art from your chats and library.</p>
        </div>
        <div role="tablist" aria-label="Gallery section" className="inline-flex gap-1 rounded-md border border-ink-600 bg-ink-850 p-1">
          {TABS.map((t) => (
            <button
              key={t.id}
              type="button"
              role="tab"
              aria-selected={tab === t.id}
              onClick={() => switchTab(t.id)}
              className={cx(
                "cursor-pointer rounded px-3 py-1 text-xs transition-colors",
                tab === t.id ? "bg-ink-700 text-paper-50" : "text-paper-400 hover:text-paper-200",
              )}
            >
              {t.label}
            </button>
          ))}
        </div>
      </div>

      {loaded.length > 0 ? (
        <div className="mb-4 flex flex-wrap items-center gap-2">
          {tab === "scenes" ? (
            <Select
              aria-label="View mode"
              value={view}
              onChange={(e) => setView(VIEW_OPTIONS.find((v) => v.id === e.target.value)?.id ?? "character")}
              className="h-8 text-xs"
            >
              {VIEW_OPTIONS.map((v) => (
                <option key={v.id} value={v.id}>
                  {v.label}
                </option>
              ))}
            </Select>
          ) : null}
          <button
            type="button"
            aria-pressed={favoritesOnly}
            onClick={() => setFavoritesOnly((v) => !v)}
            className={cx(
              "flex h-8 cursor-pointer items-center gap-1 rounded-md border px-2.5 text-xs transition-colors",
              favoritesOnly ? "border-accent-500/60 text-accent-300" : "border-ink-500 text-paper-400 hover:text-paper-200",
            )}
          >
            ♥ Favorites
          </button>
          <div className="ml-auto flex items-center gap-2">
            {selectMode ? (
              <>
                <span className="text-xs tabular-nums text-paper-400">{selected.size} selected</span>
                <Button
                  variant="danger"
                  size="sm"
                  className="h-8"
                  disabled={selected.size === 0}
                  onClick={() => setPendingDelete({ ids: [...selected], label: "the selected images" })}
                >
                  Delete selected
                </Button>
                <Button
                  size="sm"
                  className="h-8"
                  onClick={() => {
                    setSelectMode(false);
                    setSelected(new Set());
                  }}
                >
                  Cancel
                </Button>
              </>
            ) : (
              <>
                <Button size="sm" className="h-8" onClick={() => setSelectMode(true)}>
                  Select
                </Button>
                <Button
                  variant="danger"
                  size="sm"
                  className="h-8"
                  disabled={filtered.length === 0}
                  onClick={() => setPendingDelete({ ids: filtered.map((s) => s.id), label: "every image the current filter shows" })}
                >
                  Delete all{filtered.length > 0 ? ` (${filtered.length})` : ""}
                </Button>
              </>
            )}
          </div>
        </div>
      ) : null}

      {tab !== "entity" && characterFacets.length > 0 ? (
        <div className="mb-5 flex flex-wrap items-center gap-1.5">
          <span className="text-xs text-paper-500">Featuring</span>
          {characterFacets.map((c) => {
            const active = characterFilter === c.id;
            return (
              <button
                key={c.id}
                type="button"
                aria-pressed={active}
                onClick={() => setCharacterFilter(active ? "" : c.id)}
                className={cx(
                  "flex cursor-pointer items-center gap-1.5 rounded-full border py-0.5 pr-2.5 pl-0.5 text-xs transition-colors",
                  active ? "border-accent-500/60 bg-accent-500/10 text-accent-300" : "border-ink-500 text-paper-400 hover:text-paper-200",
                )}
              >
                <EntityImage imageId={avatarByCharacter.get(c.id) ?? null} name={c.name} className="size-5 rounded-full text-[8px]" />
                {c.name}
              </button>
            );
          })}
        </div>
      ) : null}

      {loading ? (
        <SkeletonCards count={8} />
      ) : error ? (
        <ErrorState error={error} onRetry={() => setReloadNonce((n) => n + 1)} />
      ) : loaded.length === 0 ? (
        <EmptyState title={emptyCopy[tab].title} description={emptyCopy[tab].description} />
      ) : filtered.length === 0 ? (
        <EmptyState
          title="Nothing matches these filters"
          description="Try a different character, or turn off Favorites."
          action={
            <button
              type="button"
              onClick={() => {
                setCharacterFilter("");
                setFavoritesOnly(false);
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
            <section key={group.key}>
              <div className="mb-3 flex items-baseline justify-between gap-3">
                {group.href ? (
                  <Link href={group.href} className="group min-w-0">
                    <h2 className="prose-display truncate text-xl group-hover:text-accent-300">{group.title}</h2>
                  </Link>
                ) : (
                  <h2 className="prose-display min-w-0 truncate text-xl">{group.title}</h2>
                )}
                {group.subtitle ? <span className="shrink-0 text-xs text-paper-500">{group.subtitle}</span> : null}
              </div>
              <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
                {group.images.map((image) => {
                  const caption = captionFor(image);
                  const picked = selected.has(image.id);
                  return (
                    <figure key={image.id} className="group flex flex-col gap-1.5">
                      <div className="relative">
                        <button
                          type="button"
                          onClick={() =>
                            selectMode
                              ? toggleSelected(image.id)
                              : setEnlarged({ id: image.id, caption, prompt: image.prompt || null })
                          }
                          aria-label={selectMode ? (picked ? "Deselect image" : "Select image") : "Enlarge image"}
                          className={cx(
                            "block w-full cursor-pointer overflow-hidden rounded-card border transition-colors",
                            picked ? "border-accent-500" : "border-ink-600 hover:border-accent-500/60",
                          )}
                        >
                          <EntityImage imageId={image.id} name={tileTitle(image)} className="aspect-[3/4] w-full" />
                        </button>
                        {selectMode ? (
                          <span
                            aria-hidden
                            className={cx(
                              "absolute top-1.5 left-1.5 flex size-5 items-center justify-center rounded-full border text-[11px]",
                              picked ? "border-accent-500 bg-accent-500 text-ink-950" : "border-paper-400/60 bg-ink-900/70 text-transparent",
                            )}
                          >
                            ✓
                          </span>
                        ) : (
                          <>
                            {/* `.hover-reveal` (globals.css): hover-gated on pointer devices,
                                always shown on touch — the raw opacity-0 + group-hover pair
                                these used before never appeared on phones, so favoriting had
                                no path there. `.touch-target` widens the
                                coarse-pointer tap height past the size-7 (28px) glyph box. The
                                favorite heart stays unconditionally visible once set (it's a
                                state marker, not just a reveal-on-hover action). */}
                            <button
                              type="button"
                              onClick={() => void toggleFavorite(image)}
                              aria-label={image.favorite ? "Unfavorite image" : "Favorite image"}
                              aria-pressed={image.favorite}
                              className={cx(
                                "touch-target absolute top-1.5 left-1.5 flex size-7 cursor-pointer items-center justify-center rounded-md border bg-ink-900/80 backdrop-blur-sm transition-opacity",
                                image.favorite ? "border-accent-500/60 text-accent-300" : "hover-reveal border-ink-600 text-paper-300",
                              )}
                            >
                              {image.favorite ? "♥" : "♡"}
                            </button>
                            <button
                              type="button"
                              onClick={() => setPendingDelete({ ids: [image.id], label: "this image" })}
                              aria-label="Delete image"
                              className="hover-reveal touch-target absolute top-1.5 right-1.5 flex size-7 cursor-pointer items-center justify-center rounded-md border border-ink-600 bg-ink-900/80 text-paper-300 backdrop-blur-sm transition-opacity hover:border-danger-500 hover:text-danger-300"
                            >
                              ✕
                            </button>
                          </>
                        )}
                      </div>
                      <figcaption className="flex items-baseline justify-between gap-2 px-0.5 text-[11px] text-paper-500">
                        <span className="truncate text-paper-400">{tileTitle(image)}</span>
                        {shortDate(image.createdAt) ? <span className="shrink-0">{shortDate(image.createdAt)}</span> : null}
                      </figcaption>
                    </figure>
                  );
                })}
              </div>
            </section>
          ))}
          {nextCursor ? (
            <div className="flex justify-center">
              <Button onClick={() => void loadMore()} busy={loadingMore}>
                Load more
              </Button>
            </div>
          ) : null}
        </div>
      )}

      <ImageLightbox
        imageId={enlarged?.id ?? null}
        alt="Gallery image"
        caption={enlarged?.caption ?? null}
        prompt={enlarged?.prompt ?? null}
        onClose={() => setEnlarged(null)}
      />

      <Dialog
        open={pendingDelete !== null}
        onClose={() => {
          if (!deleting) setPendingDelete(null);
        }}
        title={`Delete ${pendingDelete?.ids.length ?? 0} image${(pendingDelete?.ids.length ?? 0) === 1 ? "" : "s"}?`}
        footer={
          <>
            <Button onClick={() => setPendingDelete(null)} disabled={deleting}>
              Cancel
            </Button>
            <Button variant="danger" busy={deleting} onClick={() => void confirmDelete()}>
              Delete
            </Button>
          </>
        }
      >
        This permanently removes {pendingDelete?.label ?? "these images"}
        {/* String-expression children: swc in next 16.2.x drops the leading space of a multi-line JSX text node
            containing an HTML entity (swc#11521; fixed in next 16.3.0). */}
        {" — from the gallery and anywhere it appears. It can’t be undone."}
      </Dialog>
    </PageContainer>
  );
}
