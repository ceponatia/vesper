"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  charactersApi,
  itemsApi,
  locationsApi,
  worldsApi,
  type ApiResult,
  type CreatedRef,
} from "@/lib/client/api";
import { useAsyncData } from "@/components/hooks/use-async";
import { PageContainer } from "@/components/shell/app-shell";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { cx } from "@/components/ui/cx";
import { Dialog } from "@/components/ui/dialog";
import { EmptyState } from "@/components/ui/empty-state";
import { EntityImage } from "@/components/ui/entity-image";
import { ErrorState } from "@/components/ui/error-state";
import { Input } from "@/components/ui/input";
import { SkeletonCards } from "@/components/ui/skeleton";
import { Tag } from "@/components/ui/tag";
import { useToast } from "@/components/ui/toast";

export type LibraryEntity = "worlds" | "characters" | "locations" | "items";

interface LibraryCard {
  id: string;
  name: string;
  description?: string;
  tags: readonly string[];
  imageId: string | null;
  kind?: string;
}

interface EntityConfig {
  title: string;
  blurb: string;
  basePath: string;
  forgePath?: string;
  emptyTitle: string;
  emptyBody: string;
  newName: string;
  square: boolean;
  list: (q: string, tag: string) => Promise<ApiResult<LibraryCard[]>>;
  create: () => Promise<ApiResult<CreatedRef>>;
  /** Optional segmented type-buckets over a card field (items use `kind`). */
  buckets?: { field: (card: LibraryCard) => string | undefined; options: { id: string; label: string }[] };
  /** Optional batch image generation for the given entity ids (those visible
   *  under the active filter) that are still missing an image. */
  generateImages?: (ids: readonly string[]) => Promise<ApiResult<{ queued: number }>>;
}

const configs: Record<LibraryEntity, EntityConfig> = {
  worlds: {
    title: "Worlds",
    blurb: "Settings with their own cast, map and lore.",
    basePath: "/worlds",
    forgePath: "/worlds/forge",
    emptyTitle: "No worlds yet",
    emptyBody: "Forge one from a prose premise — the agents draft the map, lore and cast for review.",
    newName: "Untitled world",
    square: false,
    list: async (q, tag) => {
      const result = await worldsApi.list({ q, tag });
      return result.ok
        ? { ok: true, data: result.data.map((w) => ({ ...w, tags: [] as string[] })) }
        : result;
    },
    create: () => worldsApi.create({ name: "Untitled world" }),
  },
  characters: {
    title: "Characters",
    blurb: "Your cast — forge-drafted or hand-built.",
    basePath: "/characters",
    forgePath: "/characters/forge",
    emptyTitle: "No characters yet",
    emptyBody: "Forge one from a one-line concept, or start from a blank profile.",
    newName: "Untitled character",
    square: true,
    list: async (q, tag) => {
      const result = await charactersApi.list({ q, tag });
      return result.ok
        ? { ok: true, data: result.data.map((c) => ({ ...c, imageId: c.avatarImageId })) }
        : result;
    },
    create: () => charactersApi.create({ name: "Untitled character" }),
  },
  locations: {
    title: "Locations",
    blurb: "Reusable places worlds can pull from.",
    basePath: "/locations",
    emptyTitle: "No locations yet",
    emptyBody: "Locations are usually forged with a world, but you can build them by hand too.",
    newName: "Untitled location",
    square: false,
    list: (q, tag) => locationsApi.list({ q, tag }),
    create: () => locationsApi.create({ name: "Untitled location" }),
    generateImages: (ids) => locationsApi.generateMissingImages(ids),
  },
  items: {
    title: "Items",
    blurb: "Clothing, objects and containers.",
    basePath: "/items",
    emptyTitle: "No items yet",
    emptyBody: "Clothing drives wardrobe visibility in play; objects and containers furnish locations.",
    newName: "Untitled item",
    square: true,
    list: (q, tag) => itemsApi.list({ q, tag }),
    create: () => itemsApi.create({ name: "Untitled item", kind: "object" }),
    buckets: {
      field: (card) => card.kind,
      options: [
        { id: "clothing", label: "Clothing" },
        { id: "object", label: "Object" },
        { id: "container", label: "Container" },
      ],
    },
    generateImages: (ids) => itemsApi.generateMissingImages(ids),
  },
};

/** Library grid with debounced search + tag filter (docs/ui.md). */
export function EntityLibrary({ entity }: { entity: LibraryEntity }) {
  const config = configs[entity];
  const router = useRouter();
  const toast = useToast();
  const [query, setQuery] = useState("");
  const [search, setSearch] = useState(""); // debounced
  const [tag, setTag] = useState("");
  const [creating, setCreating] = useState(false);
  const [bucket, setBucket] = useState("all");
  const [generatingBatch, setGeneratingBatch] = useState(false);
  const [batchRunning, setBatchRunning] = useState(false);
  const [confirmGen, setConfirmGen] = useState(false);
  const [batchIds, setBatchIds] = useState<ReadonlySet<string>>(new Set());

  const list = useAsyncData(() => config.list(search, tag), [entity, search, tag]);
  const { reload } = list;

  // Debounce: schedule the search update on input.
  const [timer, setTimer] = useState<ReturnType<typeof setTimeout> | null>(null);
  const onQuery = (value: string) => {
    setQuery(value);
    if (timer) clearTimeout(timer);
    setTimer(setTimeout(() => setSearch(value), 300));
  };

  const allTags = useMemo(() => {
    const tags = new Set<string>();
    for (const card of list.data ?? []) for (const t of card.tags) tags.add(t);
    return [...tags].sort();
  }, [list.data]);

  const createBlank = async () => {
    setCreating(true);
    const result = await config.create();
    setCreating(false);
    if (result.ok) router.push(`${config.basePath}/${result.data.id}${entity === "worlds" ? "/edit" : ""}`);
    else toast.push({ title: "Couldn't create", description: result.error.message, tone: "error" });
  };

  const cardsAll = list.data ?? [];
  const cards = config.buckets && bucket !== "all" ? cardsAll.filter((c) => config.buckets?.field(c) === bucket) : cardsAll;
  const fresh = !list.loading && !list.error && cardsAll.length === 0 && search === "" && tag === "";
  // Entities visible under the active filter that still lack an image — the
  // exact scope the "Generate images" button (and its confirm count) act on.
  const missingIds = cards.flatMap((c) => (c.imageId ? [] : [c.id]));

  // Singular noun for the confirm copy, scoped to the active bucket.
  const entitySingular = config.title.toLowerCase().replace(/s$/, "");
  const bucketLabel =
    config.buckets && bucket !== "all" ? config.buckets.options.find((o) => o.id === bucket)?.label.toLowerCase() : null;
  const scopeNoun = bucketLabel ? `${bucketLabel} ${entitySingular}` : entitySingular;

  const requestGenerate = () => {
    if (missingIds.length === 0) {
      toast.push({ title: `Every visible ${entitySingular} already has an image`, tone: "success" });
      return;
    }
    setConfirmGen(true);
  };

  const confirmGenerate = async () => {
    if (!config.generateImages || missingIds.length === 0) return;
    setConfirmGen(false);
    setBatchIds(new Set(missingIds));
    setGeneratingBatch(true);
    const result = await config.generateImages(missingIds);
    setGeneratingBatch(false);
    if (!result.ok) {
      toast.push({ title: "Couldn't start image generation", description: result.error.message, tone: "error" });
      return;
    }
    if (result.data.queued === 0) {
      toast.push({ title: "Those already have images", tone: "success" });
      return;
    }
    toast.push({
      title: `Generating ${result.data.queued} image${result.data.queued === 1 ? "" : "s"}`,
      description: "They’ll appear as they finish — you can keep working or leave this page.",
    });
    setBatchRunning(true);
    reload({ silent: true });
  };

  // Refresh the grid while a batch runs so images appear as they land; stop
  // once every entity in the running batch has one, or after a safety cap. The
  // scoped-missing count is read through a ref so the interval sees fresh data.
  const scopedMissing =
    batchIds.size === 0 ? 0 : cardsAll.filter((c) => batchIds.has(c.id) && !c.imageId).length;
  const missingRef = useRef(scopedMissing);
  useEffect(() => {
    missingRef.current = scopedMissing;
  });
  useEffect(() => {
    if (!batchRunning) return;
    let polls = 0;
    const timer = setInterval(() => {
      polls += 1;
      reload({ silent: true });
      if ((polls >= 2 && missingRef.current === 0) || polls >= 90) setBatchRunning(false);
    }, 5000);
    return () => clearInterval(timer);
  }, [batchRunning, reload]);

  return (
    <PageContainer wide>
      <div className="mb-6 flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="prose-display text-2xl">{config.title}</h1>
          <p className="mt-1 text-sm text-paper-400">{config.blurb}</p>
        </div>
        <div className="flex gap-2">
          <Button onClick={createBlank} busy={creating} className="min-w-20">
            New
          </Button>
          {config.generateImages && cardsAll.length > 0 ? (
            <Button onClick={requestGenerate} busy={generatingBatch} disabled={batchRunning}>
              {batchRunning ? "Generating…" : "Generate images"}
            </Button>
          ) : null}
          {config.forgePath ? (
            <Link
              href={config.forgePath}
              className="inline-flex h-9 items-center rounded-md bg-accent-500 px-3.5 text-sm font-medium text-ink-950 hover:bg-accent-400"
            >
              Forge ✦
            </Link>
          ) : null}
        </div>
      </div>

      {config.buckets ? (
        <div
          role="tablist"
          aria-label="Filter by type"
          className="mb-4 inline-flex gap-1 rounded-md border border-ink-600 bg-ink-850 p-1"
        >
          {[{ id: "all", label: "All" }, ...config.buckets.options].map((opt) => {
            const count =
              opt.id === "all" ? cardsAll.length : cardsAll.filter((c) => config.buckets?.field(c) === opt.id).length;
            const active = bucket === opt.id;
            return (
              <button
                key={opt.id}
                type="button"
                role="tab"
                aria-selected={active}
                onClick={() => setBucket(opt.id)}
                className={cx(
                  "cursor-pointer rounded px-3 py-1 text-xs transition-colors",
                  active ? "bg-ink-700 text-paper-50" : "text-paper-400 hover:text-paper-200",
                )}
              >
                {opt.label}
                <span className={cx("ml-1.5 tabular-nums", active ? "text-paper-400" : "text-paper-500")}>{count}</span>
              </button>
            );
          })}
        </div>
      ) : null}

      <div className="mb-5 flex flex-wrap items-center gap-3">
        <Input
          value={query}
          onChange={(e) => onQuery(e.target.value)}
          placeholder={`Search ${config.title.toLowerCase()}…`}
          aria-label="Search"
          className="max-w-72"
        />
        {allTags.length > 0 ? (
          <div className="flex flex-wrap gap-1.5">
            {allTags.map((t) => (
              <button
                key={t}
                type="button"
                aria-pressed={tag === t}
                onClick={() => setTag(tag === t ? "" : t)}
                className={cx(
                  "cursor-pointer rounded-full border px-2.5 py-0.5 text-xs transition-colors",
                  tag === t
                    ? "border-accent-500/60 bg-accent-500/10 text-accent-300"
                    : "border-ink-500 text-paper-400 hover:text-paper-200",
                )}
              >
                {t}
              </button>
            ))}
          </div>
        ) : null}
      </div>

      {list.loading ? (
        <SkeletonCards />
      ) : list.error ? (
        <ErrorState error={list.error} onRetry={() => list.reload()} />
      ) : fresh ? (
        <EmptyState
          title={config.emptyTitle}
          description={config.emptyBody}
          action={
            config.forgePath ? (
              <Link
                href={config.forgePath}
                className="inline-flex h-9 items-center rounded-md bg-accent-500 px-3.5 text-sm font-medium text-ink-950 hover:bg-accent-400"
              >
                Open the forge
              </Link>
            ) : (
              <Button onClick={createBlank} busy={creating}>
                Create one
              </Button>
            )
          }
        />
      ) : cards.length === 0 ? (
        <EmptyState title="Nothing matches" description="Try a different search, type, or tag filter." />
      ) : (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {cards.map((card) => (
            <Link key={card.id} href={`${config.basePath}/${card.id}`} className="group">
              <Card interactive className="flex h-full gap-3 p-4">
                <EntityImage
                  imageId={card.imageId}
                  name={card.name}
                  className={cx("shrink-0 rounded-md text-lg", config.square ? "size-16" : "h-16 w-24")}
                />
                <div className="min-w-0">
                  <h2 className="prose-display truncate text-base group-hover:text-accent-300">{card.name}</h2>
                  {card.description ? (
                    <p className="mt-0.5 line-clamp-2 text-xs text-paper-400">{card.description}</p>
                  ) : null}
                  <div className="mt-1.5 flex flex-wrap gap-1">
                    {card.kind ? <Tag tone="accent">{card.kind}</Tag> : null}
                    {card.tags.slice(0, 4).map((t) => (
                      <Tag key={t}>{t}</Tag>
                    ))}
                  </div>
                </div>
              </Card>
            </Link>
          ))}
        </div>
      )}
      {config.generateImages ? (
        <Dialog
          open={confirmGen}
          onClose={() => setConfirmGen(false)}
          title="Generate images?"
          footer={
            <>
              <Button onClick={() => setConfirmGen(false)}>Cancel</Button>
              <Button variant="primary" busy={generatingBatch} onClick={confirmGenerate}>
                Ok
              </Button>
            </>
          }
        >
          This will generate {missingIds.length} image{missingIds.length === 1 ? "" : "s"} — one for each {scopeNoun}{" "}
          without one. It runs in the background, so you can keep working or leave this page.
        </Dialog>
      ) : null}
    </PageContainer>
  );
}
