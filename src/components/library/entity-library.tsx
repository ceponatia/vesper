"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  charactersApi,
  itemsApi,
  locationsApi,
  socialCardsApi,
  worldsApi,
  type ApiResult,
  type CreatedRef,
  type ItemDefinitionParts,
} from "@/lib/client/api";
import { visibleTags } from "@/lib/tags";
import { useAsyncData } from "@/components/hooks/use-async";
import { usePollWhile } from "@/components/hooks/use-poll-while";
import { PageContainer } from "@/components/shell/app-shell";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { cx } from "@/components/ui/cx";
import { Dialog } from "@/components/ui/dialog";
import { EmptyState } from "@/components/ui/empty-state";
import { EntityImage } from "@/components/ui/entity-image";
import { ErrorState } from "@/components/ui/error-state";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { SkeletonCards } from "@/components/ui/skeleton";
import { Tag } from "@/components/ui/tag";
import { useToast } from "@/components/ui/toast";
import { itemCardChips, itemCardGroup, itemFacetDefs, type CardGroup, type FacetDef } from "./item-facets";

export type LibraryEntity = "worlds" | "characters" | "locations" | "items" | "social-cards";

interface LibraryCard {
  id: string;
  name: string;
  description?: string;
  tags: readonly string[];
  imageId: string | null;
  kind?: string;
  /** Items only: the definition facet slice driving chips/facets/grouping. */
  definition?: ItemDefinitionParts;
}

/** Cross-account visibility scope (auth.md): `all` = owner ∪ public, `public` = discovery, `owned` = yours. */
type Scope = "all" | "public" | "owned";
type SortOption = "updated" | "name";
type ViewMode = "grid" | "list";

interface ListArgs {
  q: string;
  /** Comma-joined active tags (ANDed server-side). */
  tag: string;
  scope: Scope;
  sort: SortOption;
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
  /** Shareable entities get the All/Public/Owned visibility toggle (auth.md);
   *  worlds/sessions aren't shareable, so they don't. */
  shareable?: boolean;
  /** Sort control (Recent/Name) — kinds whose list API routes through searchLibraryIds. */
  sortable?: boolean;
  /** Grid ⇄ list density toggle (items first; the list row renders cardChips). */
  viewToggle?: boolean;
  /** `scope` drives the discovery gallery; kinds whose API ignores it stay owner-scoped (cards wired first). */
  list: (args: ListArgs) => Promise<ApiResult<LibraryCard[]>>;
  create: () => Promise<ApiResult<CreatedRef>>;
  /** Optional segmented type-buckets over a card field (items use `kind`). */
  buckets?: { field: (card: LibraryCard) => string | undefined; options: { id: string; label: string }[] };
  /** Registry-backed facet chip rows (library-ux.plan.md §3) — filter the loaded set client-side. */
  facets?: FacetDef<LibraryCard>[];
  /** Grouped sections for the unfiltered browse (items: the "closet" view); null = flat. */
  groupCards?: (card: LibraryCard, bucket: string) => CardGroup | null;
  /** Compact structured chips on cards/rows (items: category + color). */
  cardChips?: (card: LibraryCard) => { label: string; swatch?: string }[];
  /** Optional per-card quick action (hover-revealed; characters use it for "Chat"). */
  cardAction?: { label: string; ariaLabel: (card: LibraryCard) => string; href: (card: LibraryCard) => string };
  /** Optional batch image generation for the given entity ids (those visible
   *  under the active filter) that are still missing an image. */
  generateImages?: (ids: readonly string[]) => Promise<ApiResult<{ queued: number }>>;
  /** Optional facet backfill (items "Organize", library-ux.plan.md §5): classify
   *  the visible entities still missing facet fields. Only absent fields are
   *  ever written server-side, so it's always safe to press again. */
  organize?: {
    run: (ids: readonly string[]) => Promise<ApiResult<{ queued: number }>>;
    isMissingFacets: (card: LibraryCard) => boolean;
  };
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
    list: async ({ q, tag }) => {
      const result = await worldsApi.list({ q, tag });
      return result.ok
        ? { ok: true, data: result.data.map((w) => ({ ...w, tags: [] as string[] })) }
        : result;
    },
    create: () => worldsApi.create({ name: "Untitled world" }),
  },
  characters: {
    title: "Characters",
    blurb: "Reusable characters your worlds can cast.",
    basePath: "/characters",
    forgePath: "/characters/forge",
    emptyTitle: "No characters yet",
    emptyBody: "Forge one from a one-line concept, or start from a blank profile.",
    newName: "Untitled character",
    square: true,
    shareable: true,
    sortable: true,
    list: async ({ q, tag, sort }) => {
      const result = await charactersApi.list({ q, tag, sort });
      return result.ok
        ? { ok: true, data: result.data.map((c) => ({ ...c, imageId: c.avatarImageId })) }
        : result;
    },
    create: () => charactersApi.create({ name: "Untitled character" }),
    // The Chats-hub entry point (character-chat-standalone.spec.md §2.2):
    // ?new= opens the new-conversation dialog pre-picked with this character.
    cardAction: {
      label: "Chat",
      ariaLabel: (card) => `Chat with ${card.name}`,
      href: (card) => `/chat?new=${card.id}`,
    },
  },
  locations: {
    title: "Locations",
    blurb: "Reusable places worlds can pull from.",
    basePath: "/locations",
    emptyTitle: "No locations yet",
    emptyBody: "Locations are usually forged with a world, but you can build them by hand too.",
    newName: "Untitled location",
    square: false,
    shareable: true,
    sortable: true,
    list: ({ q, tag, sort }) => locationsApi.list({ q, tag, sort }),
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
    shareable: true,
    sortable: true,
    viewToggle: true,
    list: ({ q, tag, sort }) => itemsApi.list({ q, tag, sort }),
    create: () => itemsApi.create({ name: "Untitled item", kind: "object" }),
    buckets: {
      field: (card) => card.kind,
      options: [
        { id: "clothing", label: "Clothing" },
        { id: "object", label: "Object" },
        { id: "container", label: "Container" },
      ],
    },
    facets: itemFacetDefs<LibraryCard>(),
    groupCards: itemCardGroup,
    cardChips: itemCardChips,
    generateImages: (ids) => itemsApi.generateMissingImages(ids),
    organize: {
      run: (ids) => itemsApi.classifyMissing(ids),
      isMissingFacets: (card) => {
        const d = card.definition;
        if (!d) return false;
        if (card.kind === "clothing") return !d.category || !d.wearer || d.layer === null || !d.color;
        if (card.kind === "object") return !d.subtype || !d.color;
        return !d.color; // container
      },
    },
  },
  "social-cards": {
    title: "Social cards",
    blurb: "Importable taboos and social rules that shape how characters react.",
    basePath: "/social-cards",
    emptyTitle: "No social cards yet",
    emptyBody: "Build a taboo or social rule, then attach it to a world's fabric or a character's lines.",
    newName: "Untitled card",
    square: true,
    shareable: true,
    sortable: true,
    list: async ({ q, tag, scope, sort }) => {
      const result = await socialCardsApi.list({ q, tag, scope, sort });
      return result.ok
        ? {
            ok: true,
            data: result.data.map((c) => ({
              id: c.id,
              name: c.name,
              description: c.description,
              tags: c.tags,
              imageId: null,
              kind: c.definition.kind,
            })),
          }
        : result;
    },
    create: () => socialCardsApi.create({ name: "Untitled card" }),
    buckets: {
      field: (card) => card.kind,
      options: [
        { id: "social_rule", label: "Social rule" },
        { id: "taboo", label: "Taboo" },
      ],
    },
  },
};

const SCOPE_OPTIONS: { id: Scope; label: string }[] = [
  { id: "all", label: "All" },
  { id: "public", label: "Public" },
  { id: "owned", label: "Owned" },
];

/** A segmented tab group (the library's toolbar control). Counts are optional. */
function Segmented<T extends string>({
  label,
  options,
  value,
  onChange,
}: {
  label: string;
  options: { id: T; label: string; count?: number }[];
  value: T;
  onChange: (id: T) => void;
}) {
  return (
    <div role="tablist" aria-label={label} className="inline-flex gap-1 rounded-md border border-ink-600 bg-ink-850 p-1">
      {options.map((opt) => {
        const active = value === opt.id;
        return (
          <button
            key={opt.id}
            type="button"
            role="tab"
            aria-selected={active}
            onClick={() => onChange(opt.id)}
            className={cx(
              "cursor-pointer rounded px-3 py-1 text-xs transition-colors",
              active ? "bg-ink-700 text-paper-50" : "text-paper-400 hover:text-paper-200",
            )}
          >
            {opt.label}
            {opt.count !== undefined ? (
              <span className={cx("ml-1.5 tabular-nums", active ? "text-paper-400" : "text-paper-500")}>{opt.count}</span>
            ) : null}
          </button>
        );
      })}
    </div>
  );
}

/** Rounded filter chip (facet options, tag filters). */
function FilterChip({
  active,
  onClick,
  children,
  swatch,
  count,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
  swatch?: string;
  count?: number;
}) {
  return (
    <button
      type="button"
      aria-pressed={active}
      onClick={onClick}
      className={cx(
        "flex cursor-pointer items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-xs transition-colors",
        active
          ? "border-accent-500/60 bg-accent-500/10 text-accent-300"
          : "border-ink-500 text-paper-400 hover:text-paper-200",
      )}
    >
      {swatch ? <span aria-hidden className="size-2.5 rounded-full border border-ink-500" style={{ backgroundColor: swatch }} /> : null}
      {children}
      {count !== undefined ? <span className="tabular-nums text-paper-500">{count}</span> : null}
    </button>
  );
}

const VIEW_STORAGE_PREFIX = "vesper:library-view:";

function readStoredView(entity: LibraryEntity): ViewMode {
  if (typeof window === "undefined") return "grid";
  return window.localStorage.getItem(VIEW_STORAGE_PREFIX + entity) === "list" ? "list" : "grid";
}

/** Library grid with debounced search, type buckets, facet chips and tag filters (docs/ui.md). */
export function EntityLibrary({ entity }: { entity: LibraryEntity }) {
  const config = configs[entity];
  const router = useRouter();
  const toast = useToast();
  const [query, setQuery] = useState("");
  const [search, setSearch] = useState(""); // debounced
  const [tagSel, setTagSel] = useState<string[]>([]);
  const [tagPanel, setTagPanel] = useState(false);
  const [tagFilter, setTagFilter] = useState("");
  const [facetSel, setFacetSel] = useState<Record<string, string>>({});
  const [sort, setSort] = useState<SortOption>("updated");
  const [view, setView] = useState<ViewMode>(() => readStoredView(entity));
  const [creating, setCreating] = useState(false);
  const [bucket, setBucketState] = useState("all");
  // Drives the discovery gallery via config.list (social-reaction-cards.plan.md
  // step 6). Wired for social cards; the other shareable kinds pass scope through
  // but their list API still ignores it (owner-scoped) until the fast-follow.
  const [scope, setScope] = useState<Scope>("all");
  const [generatingBatch, setGeneratingBatch] = useState(false);
  const [batchRunning, setBatchRunning] = useState(false);
  const [confirmGen, setConfirmGen] = useState(false);
  const [batchIds, setBatchIds] = useState<ReadonlySet<string>>(new Set());
  const [organizeStarting, setOrganizeStarting] = useState(false);
  const [organizeRunning, setOrganizeRunning] = useState(false);

  const tagKey = tagSel.join(",");
  const list = useAsyncData(
    () => config.list({ q: search, tag: tagKey, scope, sort }),
    [entity, search, tagKey, scope, sort],
  );
  const { reload } = list;

  // Debounce: schedule the search update on input. The timer lives in a ref —
  // in state, two keystrokes between renders both read the stale value, so the
  // first timeout never cleared (duplicate fetches; codebase-review A10) — and
  // is cleared on unmount so no setSearch fires on a dead component.
  const searchTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    return () => {
      if (searchTimer.current) clearTimeout(searchTimer.current);
    };
  }, []);
  const onQuery = (value: string) => {
    setQuery(value);
    if (searchTimer.current) clearTimeout(searchTimer.current);
    searchTimer.current = setTimeout(() => setSearch(value), 300);
  };

  // Switching buckets clears facet picks — a clothing category has no meaning
  // under Object, and stale invisible filters would silently empty the grid.
  const setBucket = (id: string) => {
    setBucketState(id);
    setFacetSel({});
  };

  const setViewMode = (mode: ViewMode) => {
    setView(mode);
    window.localStorage.setItem(VIEW_STORAGE_PREFIX + entity, mode);
  };

  const allTags = useMemo(() => {
    const tags = new Set<string>();
    for (const card of list.data ?? []) for (const t of visibleTags(card.tags)) tags.add(t);
    for (const t of tagSel) tags.add(t); // an active tag stays removable even when it empties the result
    return [...tags].sort();
  }, [list.data, tagSel]);

  const createBlank = async () => {
    setCreating(true);
    const result = await config.create();
    setCreating(false);
    if (result.ok) router.push(`${config.basePath}/${result.data.id}${entity === "worlds" ? "/edit" : ""}`);
    else toast.push({ title: "Couldn't create", description: result.error.message, tone: "error" });
  };

  const cardsAll = list.data ?? [];
  // Narrowed const so the per-card onClick closure keeps the defined-ness check.
  const cardAction = config.cardAction;
  const bucketCards =
    config.buckets && bucket !== "all" ? cardsAll.filter((c) => config.buckets?.field(c) === bucket) : cardsAll;

  // Facets active under this bucket, in config order.
  const activeFacetDefs = (config.facets ?? []).filter((f) => !f.forBucket || f.forBucket === bucket);
  const facetMatch = (card: LibraryCard, def: FacetDef<LibraryCard>, optionId: string) =>
    def.matches ? def.matches(def.value(card), optionId) : def.value(card) === optionId;
  const cards = bucketCards.filter((card) =>
    activeFacetDefs.every((def) => {
      const sel = facetSel[def.id];
      return !sel || facetMatch(card, def, sel);
    }),
  );
  const facetActive = Object.keys(facetSel).some((id) => activeFacetDefs.some((d) => d.id === id && facetSel[id]));

  // Option counts within the set filtered by every OTHER facet (standard
  // faceted search); options absent from the data are hidden unless selected.
  const facetOptionCounts = (def: FacetDef<LibraryCard>) => {
    const others = activeFacetDefs.flatMap((d) => {
      const sel = facetSel[d.id];
      return d.id !== def.id && sel ? [{ def: d, sel }] : [];
    });
    const base = bucketCards.filter((card) => others.every((other) => facetMatch(card, other.def, other.sel)));
    return def.options.flatMap((option) => {
      const count = base.filter((card) => facetMatch(card, def, option.id)).length;
      const selected = facetSel[def.id] === option.id;
      return count > 0 || selected ? [{ option, count, selected }] : [];
    });
  };

  const fresh = !list.loading && !list.error && cardsAll.length === 0 && search === "" && tagSel.length === 0;
  // Grouped sections only for the unfiltered browse; any narrowing goes flat.
  const groupCardsFn = config.groupCards;
  const grouping =
    groupCardsFn && search === "" && tagSel.length === 0 && !facetActive
      ? groupCards(cards, (card) => groupCardsFn(card, bucket))
      : null;
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
    pollsRef.current = 0; // rearm the poll counter for this batch
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
  // hook latest-refs the tick, so each poll sees the fresh scoped-missing count;
  // the poll count lives in a ref (reset when a batch starts) because the stop
  // condition is stateful — it flips `batchRunning` rather than just going quiet.
  const scopedMissing =
    batchIds.size === 0 ? 0 : cardsAll.filter((c) => batchIds.has(c.id) && !c.imageId).length;
  const pollsRef = useRef(0);
  usePollWhile(
    batchRunning,
    () => {
      pollsRef.current += 1;
      reload({ silent: true });
      if ((pollsRef.current >= 2 && scopedMissing === 0) || pollsRef.current >= 90) setBatchRunning(false);
    },
    5000,
  );

  // The "Organize" facet backfill (items): visible entities still missing a
  // facet field. The classify job fills absent fields only; the grid polls
  // while it runs so chips and groups appear as chunks land.
  const organize = config.organize;
  const unclassifiedIds = organize ? cards.flatMap((c) => (organize.isMissingFacets(c) ? [c.id] : [])) : [];
  const organizePollsRef = useRef(0);
  const startOrganize = async () => {
    if (!organize || unclassifiedIds.length === 0) return;
    setOrganizeStarting(true);
    const result = await organize.run(unclassifiedIds);
    setOrganizeStarting(false);
    if (!result.ok) {
      toast.push({ title: "Couldn't start organizing", description: result.error.message, tone: "error" });
      return;
    }
    if (result.data.queued === 0) {
      toast.push({ title: "Everything visible is already organized", tone: "success" });
      return;
    }
    toast.push({
      title: `Organizing ${result.data.queued} item${result.data.queued === 1 ? "" : "s"}`,
      description: "Categories, colors and fit fill in as the pass runs — you can keep working.",
    });
    organizePollsRef.current = 0;
    setOrganizeRunning(true);
  };
  usePollWhile(
    organizeRunning,
    () => {
      organizePollsRef.current += 1;
      reload({ silent: true });
      if ((organizePollsRef.current >= 2 && unclassifiedIds.length === 0) || organizePollsRef.current >= 36) {
        setOrganizeRunning(false);
      }
    },
    5000,
  );

  const shownTags = tagFilter.trim()
    ? allTags.filter((t) => t.toLowerCase().includes(tagFilter.trim().toLowerCase()))
    : allTags;

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
          {organize && (unclassifiedIds.length > 0 || organizeRunning) ? (
            <Button onClick={startOrganize} busy={organizeStarting} disabled={organizeRunning}>
              {organizeRunning ? "Organizing…" : "Organize"}
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

      {config.shareable || config.buckets ? (
        <div className="mb-4 flex flex-wrap items-center gap-3">
          {config.shareable ? (
            <Segmented label="Filter by visibility" options={SCOPE_OPTIONS} value={scope} onChange={setScope} />
          ) : null}
          {config.buckets ? (
            <Segmented
              label="Filter by type"
              value={bucket}
              onChange={setBucket}
              options={[{ id: "all", label: "All" }, ...config.buckets.options].map((opt) => ({
                ...opt,
                count: opt.id === "all" ? cardsAll.length : cardsAll.filter((c) => config.buckets?.field(c) === opt.id).length,
              }))}
            />
          ) : null}
        </div>
      ) : null}

      <div className="mb-3 flex flex-wrap items-center gap-3">
        <Input
          value={query}
          onChange={(e) => onQuery(e.target.value)}
          placeholder={`Search ${config.title.toLowerCase()}…`}
          aria-label="Search"
          className="max-w-72"
        />
        {config.sortable ? (
          <Select
            aria-label="Sort"
            value={sort}
            onChange={(e) => setSort(e.target.value === "name" ? "name" : "updated")}
            className="h-9 w-36 text-xs"
          >
            <option value="updated">Recent first</option>
            <option value="name">By name</option>
          </Select>
        ) : null}
        {config.viewToggle ? (
          <Segmented
            label="View"
            value={view}
            onChange={setViewMode}
            options={[
              { id: "grid" as const, label: "Grid" },
              { id: "list" as const, label: "List" },
            ]}
          />
        ) : null}
        {allTags.length > 0 ? (
          <button
            type="button"
            aria-expanded={tagPanel}
            onClick={() => setTagPanel((open) => !open)}
            className={cx(
              "cursor-pointer rounded-md border px-2.5 py-1.5 text-xs transition-colors",
              tagPanel || tagSel.length > 0
                ? "border-accent-500/60 text-accent-300"
                : "border-ink-500 text-paper-400 hover:text-paper-200",
            )}
          >
            Tags{tagSel.length > 0 ? ` · ${tagSel.length}` : ""}
          </button>
        ) : null}
        {!tagPanel && tagSel.length > 0
          ? tagSel.map((t) => (
              <FilterChip key={t} active onClick={() => setTagSel(tagSel.filter((x) => x !== t))}>
                {t} ×
              </FilterChip>
            ))
          : null}
      </div>

      {tagPanel && allTags.length > 0 ? (
        <div className="mb-3 rounded-md border border-ink-600 bg-ink-850 p-3">
          {allTags.length > 15 ? (
            <Input
              value={tagFilter}
              onChange={(e) => setTagFilter(e.target.value)}
              placeholder="Filter tags…"
              aria-label="Filter tags"
              className="mb-2 h-8 max-w-56 text-xs"
            />
          ) : null}
          <div className="flex flex-wrap gap-1.5">
            {shownTags.map((t) => (
              <FilterChip
                key={t}
                active={tagSel.includes(t)}
                onClick={() => setTagSel(tagSel.includes(t) ? tagSel.filter((x) => x !== t) : [...tagSel, t])}
              >
                {t}
              </FilterChip>
            ))}
          </div>
        </div>
      ) : null}

      {activeFacetDefs.length > 0 && bucketCards.length > 0 ? (
        <div className="mb-5 flex flex-col gap-2">
          {activeFacetDefs.flatMap((def) => {
            const entries = facetOptionCounts(def);
            if (entries.length === 0) return [];
            return [
              <div key={def.id} className="flex flex-wrap items-center gap-1.5">
                <span className="w-16 shrink-0 text-xs text-paper-500">{def.label}</span>
                {entries.map(({ option, count, selected }) => (
                  <FilterChip
                    key={option.id}
                    active={selected}
                    swatch={option.swatch}
                    count={count}
                    onClick={() =>
                      setFacetSel((current) => {
                        const next = { ...current };
                        if (selected) delete next[def.id];
                        else next[def.id] = option.id;
                        return next;
                      })
                    }
                  >
                    {option.label}
                  </FilterChip>
                ))}
              </div>,
            ];
          })}
        </div>
      ) : null}

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
      ) : grouping ? (
        <div className="flex flex-col gap-6">
          {grouping.map((section) => (
            <section key={section.group.id}>
              <h2 className="mb-2 text-xs font-medium tracking-wide text-paper-400 uppercase">
                {section.group.label}
                <span className="ml-1.5 font-normal tabular-nums text-paper-500">{section.cards.length}</span>
              </h2>
              <LibraryCards cards={section.cards} config={config} view={view} cardAction={cardAction} router={router} />
            </section>
          ))}
        </div>
      ) : (
        <LibraryCards cards={cards} config={config} view={view} cardAction={cardAction} router={router} />
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

/** Stable-ordered sections for the grouped browse. */
function groupCards(
  cards: readonly LibraryCard[],
  groupOf: (card: LibraryCard) => CardGroup | null,
): { group: CardGroup; cards: LibraryCard[] }[] | null {
  const sections = new Map<string, { group: CardGroup; cards: LibraryCard[] }>();
  for (const card of cards) {
    const group = groupOf(card);
    if (!group) return null; // this bucket doesn't group — render flat
    const section = sections.get(group.id) ?? { group, cards: [] };
    section.cards.push(card);
    sections.set(group.id, section);
  }
  const list = [...sections.values()].sort((a, b) => a.group.order - b.group.order);
  // A single section is noise, not organization.
  return list.length > 1 ? list : null;
}

/** The card collection, in grid (rich cards) or list (compact rows) view. */
function LibraryCards({
  cards,
  config,
  view,
  cardAction,
  router,
}: {
  cards: readonly LibraryCard[];
  config: EntityConfig;
  view: ViewMode;
  cardAction: EntityConfig["cardAction"];
  router: ReturnType<typeof useRouter>;
}) {
  if (view === "list") {
    return (
      <div className="flex flex-col gap-1.5">
        {cards.map((card) => (
          <Link key={card.id} href={`${config.basePath}/${card.id}`} className="group">
            <Card interactive className="flex items-center gap-3 px-3 py-1.5">
              <EntityImage
                imageId={card.imageId}
                name={card.name}
                className={cx("shrink-0 rounded text-[10px]", config.square ? "size-9" : "h-9 w-14")}
              />
              <span className="prose-display min-w-0 flex-none truncate text-sm group-hover:text-accent-300 sm:w-56">
                {card.name}
              </span>
              <span className="flex min-w-0 flex-wrap items-center gap-1">
                {config.cardChips?.(card).map((chip) => (
                  <Tag key={chip.label}>
                    {chip.swatch ? (
                      <span aria-hidden className="mr-1 inline-block size-2 rounded-full border border-ink-500 align-middle" style={{ backgroundColor: chip.swatch }} />
                    ) : null}
                    {chip.label}
                  </Tag>
                ))}
                {visibleTags(card.tags)
                  .slice(0, 3)
                  .map((t) => (
                    <Tag key={t}>{t}</Tag>
                  ))}
              </span>
              <span className="ml-auto hidden max-w-72 truncate text-xs text-paper-500 lg:inline">{card.description}</span>
            </Card>
          </Link>
        ))}
      </div>
    );
  }
  return (
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
                {config.cardChips?.(card).map((chip) => (
                  <Tag key={chip.label}>
                    {chip.swatch ? (
                      <span aria-hidden className="mr-1 inline-block size-2 rounded-full border border-ink-500 align-middle" style={{ backgroundColor: chip.swatch }} />
                    ) : null}
                    {chip.label}
                  </Tag>
                ))}
                {visibleTags(card.tags)
                  .slice(0, 3)
                  .map((t) => (
                    <Tag key={t}>{t}</Tag>
                  ))}
              </div>
            </div>
            {cardAction ? (
              // A button (not a nested anchor — the card is already a Link);
              // `.hover-reveal` keeps it quiet on pointer devices, always visible on touch.
              <button
                type="button"
                aria-label={cardAction.ariaLabel(card)}
                onClick={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  router.push(cardAction.href(card));
                }}
                className="hover-reveal ml-auto shrink-0 cursor-pointer self-start rounded-md border border-ink-600 bg-ink-850/90 px-2 py-1 text-xs text-paper-300 hover:border-accent-500/60 hover:text-accent-300"
              >
                {cardAction.label}
              </button>
            ) : null}
          </Card>
        </Link>
      ))}
    </div>
  );
}
