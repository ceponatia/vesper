"use client";

import { useCallback, useEffect, useId, useState, type DragEvent } from "react";
import { relationshipStages, type Diagnostic } from "@/contracts";
import { countSpawnMajors, MAJOR_TIER_SOFT_CAP } from "@/lib/cast-tiers";
import { from12Hour, to12Hour } from "@/lib/clock";
import { moveItem } from "@/lib/reorder";
import {
  charactersApi,
  itemsApi,
  worldCastTierSchema,
  worldLocationScaleSchema,
  type WorldDraft,
  type WorldDraftCastSuggestion,
  type WorldDraftItemPlacement,
  type WorldDraftLocation,
  type WorldDraftLoreChunk,
  type WorldForgeSection,
} from "@/lib/client/api";
import { useAsyncData } from "@/components/hooks/use-async";
import { DiagnosticList } from "@/components/forge/diagnostic-list";
import { EntityPickerDialog, type EntityPickerEntry } from "@/components/library/entity-picker";
import { itemCardChips } from "@/components/library/item-facets";
import { SocialCardsEditor } from "@/components/personality/social-cards-editor";
import { Button } from "@/components/ui/button";
import { cx } from "@/components/ui/cx";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { TagInput } from "@/components/ui/tag-input";
import { Tabs, type TabDef } from "@/components/ui/tabs";
import { Tag } from "@/components/ui/tag";
import { Textarea } from "@/components/ui/textarea";

export interface WorldEditorProps {
  draft: WorldDraft;
  onChange: (next: WorldDraft) => void;
  /** Forge mode: per-section regenerate (docs/authoring.md). */
  onRegenerate?: (section: WorldForgeSection) => void;
  regenerating?: WorldForgeSection | null;
  diagnostics?: readonly Diagnostic[];
  /** One-click "Create location" for dropped-link diagnostics (UX-audit M2). */
  onCreateLocation?: (name: string) => void;
}

/** Tabbed world review/editor — used by the forge and by /worlds/:id/edit. */
export function WorldEditor({
  draft,
  onChange,
  onRegenerate,
  regenerating = null,
  diagnostics = [],
  onCreateLocation,
}: WorldEditorProps) {
  const [tab, setTab] = useState<WorldForgeSection>("premise");

  const tabs: TabDef<WorldForgeSection>[] = [
    { id: "premise", label: "Premise" },
    { id: "locations", label: "Map", badge: draft.locations.length || undefined },
    { id: "lore", label: "Lore", badge: draft.loreChunks.length || undefined },
    { id: "cast", label: "Cast", badge: draft.castSuggestions.length || undefined },
    { id: "items", label: "Items", badge: draft.itemPlacements.length || undefined },
  ];

  return (
    <div className="flex flex-col gap-5">
      <DiagnosticList diagnostics={diagnostics} onCreateLocation={onCreateLocation} />

      <div className="flex flex-col gap-2 sm:flex-row sm:items-end sm:justify-between sm:gap-3">
        <Tabs tabs={tabs} value={tab} onChange={setTab} className="min-w-0 flex-1" />
        {onRegenerate ? (
          <Button
            size="sm"
            onClick={() => onRegenerate(tab)}
            busy={regenerating === tab}
            disabled={regenerating !== null && regenerating !== tab}
            className="self-start sm:mb-1 sm:self-auto"
          >
            ↻ Regenerate {tab}
          </Button>
        ) : null}
      </div>

      {tab === "premise" ? <PremiseTab draft={draft} onChange={onChange} /> : null}
      {tab === "locations" ? <MapTab draft={draft} onChange={onChange} /> : null}
      {tab === "lore" ? <LoreTab draft={draft} onChange={onChange} /> : null}
      {tab === "cast" ? <CastTab draft={draft} onChange={onChange} /> : null}
      {tab === "items" ? <ItemsTab draft={draft} onChange={onChange} /> : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Premise
// ---------------------------------------------------------------------------

function PremiseTab({ draft, onChange }: { draft: WorldDraft; onChange: (d: WorldDraft) => void }) {
  const style = draft.style;
  const patchStyle = (patch: Partial<WorldDraft["style"]>) => onChange({ ...draft, style: { ...style, ...patch } });
  const calendar = style.calendarStart;
  const characters = useAsyncData(() => charactersApi.list(), []);
  const characterOptions = characters.data ?? [];

  return (
    <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
      <Field label="Name">
        {(id) => <Input id={id} value={draft.name} onChange={(e) => onChange({ ...draft, name: e.target.value })} />}
      </Field>
      <Field label="Calendar start" hint="In-world date the first session opens on.">
        <div className="flex gap-2">
          {(
            [
              ["year", 1, 9999],
              ["month", 1, 12],
              ["day", 1, 31],
            ] as const
          ).map(([key, min, max]) => (
            <Input
              key={key}
              type="number"
              min={min}
              max={max}
              aria-label={key}
              value={calendar[key]}
              onChange={(e) => {
                const value = Number(e.target.value);
                if (Number.isFinite(value)) patchStyle({ calendarStart: { ...calendar, [key]: value } });
              }}
              className="w-20 text-center"
            />
          ))}
        </div>
      </Field>
      <Field label="Time start" hint="In-world clock the first session opens at.">
        <div className="flex items-center gap-2">
          <Input
            type="number"
            min={1}
            max={12}
            aria-label="hour"
            value={to12Hour(calendar.hour).hour12}
            onChange={(e) => {
              const h12 = Number(e.target.value);
              if (!Number.isFinite(h12)) return;
              const clamped = Math.min(12, Math.max(1, Math.round(h12)));
              patchStyle({ calendarStart: { ...calendar, hour: from12Hour(clamped, to12Hour(calendar.hour).meridiem) } });
            }}
            className="w-16 text-center"
          />
          <span className="text-paper-500">:</span>
          <Input
            type="number"
            min={0}
            max={59}
            aria-label="minute"
            value={calendar.minute}
            onChange={(e) => {
              const m = Number(e.target.value);
              if (!Number.isFinite(m)) return;
              patchStyle({ calendarStart: { ...calendar, minute: Math.min(59, Math.max(0, Math.round(m))) } });
            }}
            className="w-16 text-center"
          />
          <Select
            aria-label="am/pm"
            value={to12Hour(calendar.hour).meridiem}
            onChange={(e) =>
              patchStyle({
                calendarStart: {
                  ...calendar,
                  hour: from12Hour(to12Hour(calendar.hour).hour12, e.target.value === "pm" ? "pm" : "am"),
                },
              })
            }
            className="w-20"
          >
            <option value="am">AM</option>
            <option value="pm">PM</option>
          </Select>
        </div>
      </Field>
      <Field label="Player starts at" hint="Unset, the player starts wherever the companion is.">
        {(id) => (
          <Select
            id={id}
            value={draft.playerStartLocationName ?? ""}
            // "" is meaningful on save (clears the start); undefined would leave it unchanged
            onChange={(e) => onChange({ ...draft, playerStartLocationName: e.target.value })}
          >
            <option value="">with the companion</option>
            {draft.locations
              .filter((l) => l.name)
              .map((l) => (
                <option key={l.name} value={l.name}>
                  {l.name}
                </option>
              ))}
          </Select>
        )}
      </Field>
      <Field label="Play as" hint="Default character the player embodies; unset ⇒ observer. Pre-fills new sessions and is changeable per playthrough.">
        {(id) => (
          <Select
            id={id}
            value={draft.playerCharacterId ?? ""}
            onChange={(e) => onChange({ ...draft, playerCharacterId: e.target.value || null })}
          >
            <option value="">Observer (no character)</option>
            {characterOptions.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
            {draft.playerCharacterId && !characterOptions.some((c) => c.id === draft.playerCharacterId) ? (
              <option value={draft.playerCharacterId}>(selected character)</option>
            ) : null}
          </Select>
        )}
      </Field>
      <Field label="Description" className="sm:col-span-2">
        {(id) => (
          <Textarea id={id} rows={3} value={draft.description} onChange={(e) => onChange({ ...draft, description: e.target.value })} />
        )}
      </Field>
      <Field label="Synopsis" hint="The standing summary the narrator opens from." className="sm:col-span-2">
        {(id) => (
          <Textarea
            id={id}
            rows={4}
            value={draft.lore.synopsis}
            onChange={(e) => onChange({ ...draft, lore: { ...draft.lore, synopsis: e.target.value } })}
          />
        )}
      </Field>
      <Field label="Style directives" hint="One per line: tone, era, pacing, content notes." className="sm:col-span-2">
        {(id) => (
          <Textarea
            id={id}
            rows={4}
            value={style.directives.join("\n")}
            onChange={(e) =>
              patchStyle({ directives: e.target.value.split("\n").map((s) => s.trimEnd()).filter((s, i, arr) => s !== "" || i === arr.length - 1) })
            }
          />
        )}
      </Field>
      <Field label="Narrator guidance" className="sm:col-span-2">
        {(id) => (
          <Textarea
            id={id}
            rows={3}
            value={style.narratorGuidance ?? ""}
            onChange={(e) => patchStyle({ narratorGuidance: e.target.value || undefined })}
          />
        )}
      </Field>

      <div className="sm:col-span-2">
        <SocialCardsEditor
          cards={style.socialCards}
          onChange={(socialCards) => patchStyle({ socialCards })}
          hint="The world's social fabric — taboos and rules every present character reacts to. A character's own cards (on their Personality tab) take precedence."
          emptyText="No social cards yet. Add a taboo or social rule, or let the forge propose a starter set."
        />
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Map (location graph as a list of rooms with links)
// ---------------------------------------------------------------------------

/** Select options come from the contract enums — labels are capitalized ids. */
const optionLabel = (id: string) => id.charAt(0).toUpperCase() + id.slice(1);
const locationScales = worldLocationScaleSchema.unwrap().options;

/** Module-level sequence for map-card keys — only uniqueness matters. */
let mapCardKeySeq = 0;
const nextMapCardKey = () => `loc-${mapCardKeySeq++}`;

function MapTab({ draft, onChange }: { draft: WorldDraft; onChange: (d: WorldDraft) => void }) {
  const locations = draft.locations;

  // Stable per-card keys so expansion/DOM state survive reorders. Re-derived
  // whenever the array changes shape outside this tab (forge regenerate).
  const [keys, setKeys] = useState<string[]>(() => locations.map(nextMapCardKey));
  if (keys.length !== locations.length) setKeys(locations.map(nextMapCardKey));

  // Cards collapse by default when the draft loads; several may be open at once.
  const [expandedKeys, setExpandedKeys] = useState<ReadonlySet<string>>(new Set());
  const [autoFocusKey, setAutoFocusKey] = useState<string | null>(null);
  const detailsBaseId = useId();

  // Native drag-reorder: dragIndex is the dragged card, dropIndex the
  // insertion slot (0..length) the indicator renders at.
  const [dragIndex, setDragIndex] = useState<number | null>(null);
  const [dropIndex, setDropIndex] = useState<number | null>(null);

  // Reverse-duplicate link note ("already connected"), cleared after a beat.
  const [linkNote, setLinkNote] = useState<{ key: string; target: string } | null>(null);
  useEffect(() => {
    if (!linkNote) return;
    const timer = setTimeout(() => setLinkNote(null), 6000);
    return () => clearTimeout(timer);
  }, [linkNote]);

  const toggleCard = (key: string) =>
    setExpandedKeys((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });

  const addLocation = () => {
    const key = nextMapCardKey();
    setKeys([...keys, key]);
    setExpandedKeys((prev) => new Set(prev).add(key)); // new cards open for editing
    onChange({
      ...draft,
      locations: [...locations, { name: "New room", description: "", ambient: {}, scale: "room", tags: [], links: [] }],
    });
  };

  const removeLocation = (index: number) => {
    setKeys(keys.filter((_, i) => i !== index));
    onChange({ ...draft, locations: locations.filter((_, i) => i !== index) });
  };

  /**
   * Duplicate the place itself: description, tags, scale, area, ambient. Not
   * copied — `name` (a duplicate name breaks save resolution; left empty for
   * the author to fill), `links` (connections belong to a specific place), and
   * `id`/`locationId` (they reference the world/library row; copying them
   * would double-link it). The copy lands right below its source, expanded.
   */
  const copyLocation = (index: number) => {
    const source = locations[index];
    if (!source) return;
    const copy: WorldDraftLocation = {
      name: "",
      description: source.description,
      ambient: { ...source.ambient },
      scale: source.scale,
      area: source.area,
      tags: [...source.tags],
      links: [],
    };
    const key = nextMapCardKey();
    setKeys([...keys.slice(0, index + 1), key, ...keys.slice(index + 1)]);
    setExpandedKeys((prev) => new Set(prev).add(key));
    setAutoFocusKey(key);
    onChange({ ...draft, locations: [...locations.slice(0, index + 1), copy, ...locations.slice(index + 1)] });
  };

  /** `to` is the card's final index; keys move in lockstep with the rows. */
  const moveLocation = (from: number, to: number) => {
    if (to < 0 || to >= locations.length || from === to) return;
    setKeys([...moveItem(keys, from, to)]);
    onChange({ ...draft, locations: [...moveItem(locations, from, to)] });
  };

  const handleDragOver = (index: number) => (event: DragEvent<HTMLDivElement>) => {
    if (dragIndex === null) return; // only this tab's own drags
    event.preventDefault();
    event.dataTransfer.dropEffect = "move";
    const rect = event.currentTarget.getBoundingClientRect();
    const insertion = event.clientY < rect.top + rect.height / 2 ? index : index + 1;
    // the slots around the dragged card are no-ops; hide the indicator there
    setDropIndex(insertion === dragIndex || insertion === dragIndex + 1 ? null : insertion);
  };

  const handleDrop = (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    if (dragIndex !== null && dropIndex !== null) {
      moveLocation(dragIndex, dropIndex > dragIndex ? dropIndex - 1 : dropIndex);
    }
    setDragIndex(null);
    setDropIndex(null);
  };

  /** Names of other locations linking here that this card doesn't link back to. */
  const incomingLinks = (index: number): string[] => {
    const self = locations[index];
    if (!self?.name) return [];
    return locations
      .filter((l, i) => i !== index && l.name && l.links.includes(self.name) && !self.links.includes(l.name))
      .map((l) => l.name);
  };

  const patchLocation = (index: number, patch: Partial<WorldDraftLocation>) =>
    onChange({ ...draft, locations: locations.map((loc, i) => (i === index ? { ...loc, ...patch } : loc)) });

  const renameLocation = (index: number, name: string) => {
    const oldName = locations[index]?.name;
    onChange({
      ...draft,
      locations: locations.map((loc, i) => {
        if (i === index) return { ...loc, name };
        // keep the undirected graph consistent through renames
        if (oldName && loc.links.includes(oldName)) {
          return { ...loc, links: loc.links.map((l) => (l === oldName ? name : l)) };
        }
        return loc;
      }),
      // start-location pointers (player + cast) follow renames too
      ...(oldName && draft.playerStartLocationName === oldName ? { playerStartLocationName: name } : {}),
      castSuggestions: oldName
        ? draft.castSuggestions.map((c) => (c.startLocationName === oldName ? { ...c, startLocationName: name } : c))
        : draft.castSuggestions,
    });
  };

  return (
    <div className="flex flex-col gap-4">
      {locations.length === 0 ? <p className="text-sm text-paper-500">No locations yet.</p> : null}
      {locations.map((location, index) => {
        const key = keys[index] ?? `fallback-${index}`;
        const expanded = expandedKeys.has(key);
        const detailsId = `${detailsBaseId}-${key}`;
        const displayName = location.name || "Unnamed location";
        const incoming = incomingLinks(index);
        return (
        <div
          key={key}
          data-map-card
          onDragOver={handleDragOver(index)}
          onDrop={handleDrop}
          className={cx(
            "relative rounded-card border border-ink-600 bg-ink-800",
            dragIndex === index && "opacity-50",
          )}
        >
          {dropIndex === index ? (
            <div aria-hidden className="absolute -top-2.5 right-1 left-1 h-0.5 rounded-full bg-accent-500" />
          ) : null}
          {dropIndex === locations.length && index === locations.length - 1 ? (
            <div aria-hidden className="absolute -bottom-2.5 right-1 left-1 h-0.5 rounded-full bg-accent-500" />
          ) : null}
          <div className="flex items-center gap-1 px-2 py-1.5">
            <span
              draggable
              onDragStart={(e) => {
                e.dataTransfer.effectAllowed = "move";
                e.dataTransfer.setData("text/plain", displayName);
                const card = e.currentTarget.closest("[data-map-card]");
                if (card instanceof HTMLElement) e.dataTransfer.setDragImage(card, 16, 16);
                setDragIndex(index);
              }}
              onDragEnd={() => {
                setDragIndex(null);
                setDropIndex(null);
              }}
              aria-hidden="true"
              title="Drag to reorder"
              className="shrink-0 cursor-grab rounded px-1 py-0.5 text-sm text-paper-500 select-none hover:text-paper-200 active:cursor-grabbing"
            >
              ⠿
            </span>
            <button
              type="button"
              onClick={() => toggleCard(key)}
              aria-expanded={expanded}
              aria-controls={expanded ? detailsId : undefined}
              className="flex h-7 min-w-0 flex-1 cursor-pointer items-center gap-2 rounded-md px-1.5 text-left hover:bg-ink-700/40"
            >
              <span
                aria-hidden
                className={cx(
                  "inline-block shrink-0 text-[10px] text-paper-500 transition-transform duration-100",
                  expanded && "rotate-180",
                )}
              >
                ▾
              </span>
              <span className={cx("truncate text-sm", location.name ? "font-medium text-paper-100" : "text-paper-500 italic")}>
                {displayName}
              </span>
              {location.tags.length > 0 ? (
                <span className="hidden min-w-0 shrink items-center gap-1 overflow-hidden sm:flex">
                  {location.tags.slice(0, 3).map((tag) => (
                    <Tag key={tag} className="shrink-0">
                      {tag}
                    </Tag>
                  ))}
                  {location.tags.length > 3 ? (
                    <span className="shrink-0 text-[11px] text-paper-500">+{location.tags.length - 3}</span>
                  ) : null}
                </span>
              ) : null}
              <span className="ml-auto hidden shrink-0 pr-1 text-[11px] text-paper-500 md:inline">
                {optionLabel(location.scale)}
                {location.area ? ` · ${location.area}` : ""}
              </span>
            </button>
            <Button
              size="sm"
              variant="quiet"
              aria-label={`Move ${displayName} up`}
              disabled={index === 0}
              onClick={() => moveLocation(index, index - 1)}
              className="px-1.5"
            >
              ↑
            </Button>
            <Button
              size="sm"
              variant="quiet"
              aria-label={`Move ${displayName} down`}
              disabled={index === locations.length - 1}
              onClick={() => moveLocation(index, index + 1)}
              className="px-1.5"
            >
              ↓
            </Button>
            <Button size="sm" variant="quiet" aria-label={`Copy ${displayName}`} onClick={() => copyLocation(index)}>
              Copy
            </Button>
          </div>
          {expanded ? (
          <div id={detailsId} className="border-t border-ink-700 p-4">
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <Field label="Name">
              {(id) => (
                <Input
                  id={id}
                  value={location.name}
                  autoFocus={key === autoFocusKey}
                  onFocus={() => {
                    if (key === autoFocusKey) setAutoFocusKey(null);
                  }}
                  onChange={(e) => renameLocation(index, e.target.value)}
                />
              )}
            </Field>
            <Field label="Tags">
              {(id) => <TagInput id={id} value={location.tags} onChange={(tags) => patchLocation(index, { tags })} />}
            </Field>
            <Field label="Description" className="sm:col-span-2">
              {(id) => (
                <Textarea
                  id={id}
                  rows={2}
                  value={location.description}
                  onChange={(e) => patchLocation(index, { description: e.target.value })}
                />
              )}
            </Field>
            <Field label="Scale" hint="Spatial size: how far apart people in here can be.">
              {(id) => (
                <Select
                  id={id}
                  value={location.scale}
                  onChange={(e) => patchLocation(index, { scale: e.target.value as WorldDraftLocation["scale"] })}
                >
                  {locationScales.map((value) => (
                    <option key={value} value={value}>
                      {optionLabel(value)}
                    </option>
                  ))}
                </Select>
              )}
            </Field>
            <Field label="Area" hint="Locations sharing an area are a minute apart; crossing areas takes longer.">
              {(id) => (
                <Input
                  id={id}
                  value={location.area ?? ""}
                  placeholder="area label (optional)"
                  onChange={(e) => patchLocation(index, { area: e.target.value || undefined })}
                />
              )}
            </Field>
            {(["scent", "sound", "light"] as const).map((sense) => (
              <Field key={sense} label={`Ambient ${sense}`}>
                {(id) => (
                  <Input
                    id={id}
                    value={location.ambient[sense] ?? ""}
                    onChange={(e) =>
                      patchLocation(index, {
                        ambient: { ...location.ambient, [sense]: e.target.value || undefined },
                      })
                    }
                  />
                )}
              </Field>
            ))}
            <Field label="Connects to" className="sm:col-span-2">
              <div className="flex flex-wrap items-center gap-1.5">
                {location.links.map((link) => (
                  <Tag
                    key={link}
                    tone={locations.some((l) => l.name === link) ? "default" : "danger"}
                    onRemove={() => patchLocation(index, { links: location.links.filter((l) => l !== link) })}
                  >
                    {link}
                  </Tag>
                ))}
                <Select
                  value=""
                  aria-label="Add link"
                  onChange={(e) => {
                    const target = e.target.value;
                    if (!target) return;
                    // Links are undirected at runtime — if the target already
                    // links here, the connection exists; don't double it.
                    const reverseExists = locations.some(
                      (l, i) => i !== index && l.name === target && l.links.includes(location.name),
                    );
                    if (reverseExists) setLinkNote({ key, target });
                    else patchLocation(index, { links: [...location.links, target] });
                  }}
                  className="h-7 w-44 text-xs text-paper-400"
                >
                  <option value="">+ Link room…</option>
                  {locations
                    .filter((l, i) => i !== index && l.name && !location.links.includes(l.name))
                    .map((l) => (
                      <option key={l.name} value={l.name}>
                        {l.name}
                      </option>
                    ))}
                </Select>
              </div>
              {linkNote?.key === key ? (
                <p className="text-xs text-accent-300" role="status">
                  Already connected — “{linkNote.target}” links here, and connections work both ways.
                </p>
              ) : null}
              {incoming.length > 0 ? (
                <p className="text-xs text-paper-500">
                  Also connected from: {incoming.join(", ")} — added on{" "}
                  {incoming.length === 1 ? "that location" : "those locations"}.
                </p>
              ) : null}
            </Field>
          </div>
          <Button size="sm" variant="quiet" onClick={() => removeLocation(index)} className="mt-2">
            Remove location
          </Button>
          </div>
          ) : null}
        </div>
        );
      })}
      <Button onClick={addLocation} className="w-fit">
        + Add location
      </Button>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Lore chunks
// ---------------------------------------------------------------------------

const loreCategories = ["history", "geography", "institution", "culture", "relationship", "secret", "tone"] as const;
const loreTiers = ["always", "scene", "retrieval"] as const;
const loreVisibilities = ["public", "secret"] as const;

function LoreTab({ draft, onChange }: { draft: WorldDraft; onChange: (d: WorldDraft) => void }) {
  const chunks = draft.loreChunks;
  const patchChunk = (index: number, patch: Partial<WorldDraftLoreChunk>) =>
    onChange({ ...draft, loreChunks: chunks.map((c, i) => (i === index ? { ...c, ...patch } : c)) });

  return (
    <div className="flex flex-col gap-4">
      {chunks.length === 0 ? <p className="text-sm text-paper-500">No lore yet.</p> : null}
      {chunks.map((chunk, index) => (
        <div key={index} className="rounded-card border border-ink-600 bg-ink-800 p-4">
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
            <Field label="Title" className="sm:col-span-2">
              {(id) => <Input id={id} value={chunk.title} onChange={(e) => patchChunk(index, { title: e.target.value })} />}
            </Field>
            <Field label="Category">
              {(id) => (
                <Select id={id} value={chunk.category} onChange={(e) => patchChunk(index, { category: e.target.value as WorldDraftLoreChunk["category"] })}>
                  {loreCategories.map((c) => (
                    <option key={c} value={c}>
                      {c}
                    </option>
                  ))}
                </Select>
              )}
            </Field>
            <Field label="Body" className="sm:col-span-3">
              {(id) => (
                <Textarea id={id} rows={3} value={chunk.body} onChange={(e) => patchChunk(index, { body: e.target.value })} />
              )}
            </Field>
            <Field label="Tier" hint="always: every turn · scene: when relevant · retrieval: RAG only.">
              {(id) => (
                <Select id={id} value={chunk.tier} onChange={(e) => patchChunk(index, { tier: e.target.value as WorldDraftLoreChunk["tier"] })}>
                  {loreTiers.map((t) => (
                    <option key={t} value={t}>
                      {t}
                    </option>
                  ))}
                </Select>
              )}
            </Field>
            <Field label="Visibility">
              {(id) => (
                <Select
                  id={id}
                  value={chunk.visibility}
                  onChange={(e) => patchChunk(index, { visibility: e.target.value as WorldDraftLoreChunk["visibility"] })}
                >
                  {loreVisibilities.map((v) => (
                    <option key={v} value={v}>
                      {v}
                    </option>
                  ))}
                </Select>
              )}
            </Field>
            <Field label="Unlock tags" hint="Secrets surface when play earns one of these.">
              {(id) => <TagInput id={id} value={chunk.unlockTags} onChange={(unlockTags) => patchChunk(index, { unlockTags })} />}
            </Field>
            <Field label="Location tags" className="sm:col-span-3">
              {(id) => <TagInput id={id} value={chunk.locationTags} onChange={(locationTags) => patchChunk(index, { locationTags })} />}
            </Field>
          </div>
          <Button
            size="sm"
            variant="quiet"
            onClick={() => onChange({ ...draft, loreChunks: chunks.filter((_, i) => i !== index) })}
            className="mt-2"
          >
            Remove chunk
          </Button>
        </div>
      ))}
      <Button
        onClick={() =>
          onChange({
            ...draft,
            loreChunks: [
              ...chunks,
              {
                title: "New lore",
                body: "",
                category: "history",
                tier: "scene",
                visibility: "public",
                unlockTags: [],
                locationTags: [],
                manuallyUnlocked: false,
              },
            ],
          })
        }
        className="w-fit"
      >
        + Add lore chunk
      </Button>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Cast
// ---------------------------------------------------------------------------

const castTiers = worldCastTierSchema.unwrap().options;

function CastTab({ draft, onChange }: { draft: WorldDraft; onChange: (d: WorldDraft) => void }) {
  const cast = draft.castSuggestions;
  const patchCast = (index: number, patch: Partial<WorldDraftCastSuggestion>) =>
    onChange({ ...draft, castSuggestions: cast.map((c, i) => (i === index ? { ...c, ...patch } : c)) });

  // renaming breaks the library link on purpose — the id would lie; other
  // members' relationship `toward` pointers follow the rename (same as map renames)
  const renameCast = (index: number, name: string) => {
    const oldName = cast[index]?.name;
    onChange({
      ...draft,
      castSuggestions: cast.map((c, i) => {
        if (i === index) return { ...c, name, existingCharacterId: undefined };
        if (oldName && c.relationships.some((r) => r.toward === oldName)) {
          return { ...c, relationships: c.relationships.map((r) => (r.toward === oldName ? { ...r, toward: name } : r)) };
        }
        return c;
      }),
    });
  };

  const patchRelationship = (
    memberIndex: number,
    relIndex: number,
    patch: Partial<WorldDraftCastSuggestion["relationships"][number]>,
  ) => {
    const member = cast[memberIndex];
    if (!member) return;
    patchCast(memberIndex, {
      relationships: member.relationships.map((r, i) => (i === relIndex ? { ...r, ...patch } : r)),
    });
  };

  const locationNames = draft.locations.map((l) => l.name).filter(Boolean);

  /** "add" appends from the library; a number links that row to a library character. */
  const [picker, setPicker] = useState<"add" | number | null>(null);

  // Default-outfit names per linked character — display only. The outfit is a
  // live reference: cast members spawn wearing it in every session, so it is
  // shown here rather than duplicated into the items tab; edit it on the
  // character page.
  const [outfitsByCharacterId, setOutfitsByCharacterId] = useState<ReadonlyMap<string, string[]>>(new Map());
  const linkedIdsKey = [...new Set(cast.flatMap((c) => (c.existingCharacterId ? [c.existingCharacterId] : [])))]
    .sort()
    .join("|");
  useEffect(() => {
    const ids = linkedIdsKey.split("|").filter(Boolean);
    if (ids.length === 0) return;
    let cancelled = false;
    void (async () => {
      const itemList = await itemsApi.list({});
      const itemNameById = new Map((itemList.ok ? itemList.data : []).map((i) => [i.id, i.name]));
      const entries = await Promise.all(
        ids.map(async (id) => {
          const result = await charactersApi.get(id);
          const outfitIds = result.ok ? result.data.profile.defaultOutfit : [];
          return [id, outfitIds.map((itemId) => itemNameById.get(itemId) ?? "unnamed item")] as const;
        }),
      );
      if (!cancelled) setOutfitsByCharacterId(new Map(entries));
    })();
    return () => {
      cancelled = true;
    };
  }, [linkedIdsKey]);
  const linkedIds = new Set(cast.flatMap((c) => (c.existingCharacterId ? [c.existingCharacterId] : [])));
  const searchCharacters = useCallback(async (q: string) => {
    const result = await charactersApi.list(q ? { q } : {});
    if (!result.ok) return result;
    return {
      ok: true as const,
      data: result.data.map((c) => ({
        id: c.id,
        name: c.name,
        imageId: c.avatarImageId,
        detail: c.tags.slice(0, 3).join(", ") || undefined,
      })),
    };
  }, []);
  const pickCharacter = (entry: EntityPickerEntry) => {
    if (picker === "add") {
      onChange({
        ...draft,
        castSuggestions: [
          ...cast,
          { existingCharacterId: entry.id, name: entry.name, conceptNote: "", role: "npc", tier: "minor", relationships: [] },
        ],
      });
    } else if (typeof picker === "number") {
      patchCast(picker, { existingCharacterId: entry.id, name: entry.name });
    }
  };

  // What spawn will actually produce (lib/cast-tiers.ts mirrors engine/spawn.ts):
  // authored majors plus default-tier companions, which spawn bumps to major.
  const spawnMajorCount = countSpawnMajors(cast);

  return (
    <div className="flex flex-col gap-3">
      {spawnMajorCount > MAJOR_TIER_SOFT_CAP ? (
        <div className="rounded-card border border-accent-500/30 bg-accent-500/5 px-4 py-3 text-accent-300">
          <p className="text-xs">
            {spawnMajorCount} cast members will spawn at major tier (companions spawn major unless tiered down to
            extra) — past the soft cap of {MAJOR_TIER_SOFT_CAP}. Sessions still spawn, but every major costs prompt
            space and memory each turn; consider tiering some down.
          </p>
        </div>
      ) : null}
      {cast.length === 0 ? <p className="text-sm text-paper-500">No cast yet.</p> : null}
      {cast.map((member, index) => (
        <div key={index} className="flex flex-wrap items-start gap-3 rounded-card border border-ink-600 bg-ink-800 p-4">
          <Field label="Name" className="w-48">
            {(id) => <Input id={id} value={member.name} onChange={(e) => renameCast(index, e.target.value)} />}
          </Field>
          <Field label="Role" className="w-36">
            {(id) => (
              <Select id={id} value={member.role} onChange={(e) => patchCast(index, { role: e.target.value as WorldDraftCastSuggestion["role"] })}>
                <option value="companion">companion</option>
                <option value="npc">npc</option>
              </Select>
            )}
          </Field>
          <Field label="Tier" className="w-32">
            {(id) => (
              <Select id={id} value={member.tier} onChange={(e) => patchCast(index, { tier: e.target.value as WorldDraftCastSuggestion["tier"] })}>
                {castTiers.map((value) => (
                  <option key={value} value={value}>
                    {optionLabel(value)}
                  </option>
                ))}
              </Select>
            )}
          </Field>
          <Field label="Starts at" className="w-44">
            {(id) => (
              <Select
                id={id}
                value={member.startLocationName ?? ""}
                onChange={(e) => patchCast(index, { startLocationName: e.target.value || undefined })}
              >
                <option value="">—</option>
                {locationNames.map((name) => (
                  <option key={name} value={name}>
                    {name}
                  </option>
                ))}
              </Select>
            )}
          </Field>
          <Field label="Concept" className="min-w-56 flex-1">
            {(id) => (
              <Textarea id={id} rows={2} value={member.conceptNote} onChange={(e) => patchCast(index, { conceptNote: e.target.value })} />
            )}
          </Field>
          <div className="w-full">
            <h4 className="mb-2 text-xs font-medium tracking-wide text-paper-400 uppercase">Relationships</h4>
            <div className="flex flex-col gap-2">
              {member.relationships.map((rel, relIndex) => (
                <div key={relIndex} className="flex flex-wrap items-center gap-2">
                  <span className="text-xs text-paper-500">toward</span>
                  <Select
                    value={rel.toward}
                    aria-label="Toward"
                    onChange={(e) => patchRelationship(index, relIndex, { toward: e.target.value })}
                    className="w-44"
                  >
                    <option value="player">player</option>
                    {cast
                      .filter((c, i) => i !== index && c.name)
                      .map((c) => (
                        <option key={c.name} value={c.name}>
                          {c.name}
                        </option>
                      ))}
                    {rel.toward !== "player" && !cast.some((c, i) => i !== index && c.name === rel.toward) ? (
                      <option value={rel.toward}>{rel.toward} (missing)</option>
                    ) : null}
                  </Select>
                  <Select
                    value={rel.stage}
                    aria-label="Stage"
                    onChange={(e) => patchRelationship(index, relIndex, { stage: e.target.value })}
                    className="w-40"
                  >
                    {relationshipStages.map((stage) => (
                      <option key={stage.id} value={stage.id}>
                        {stage.label}
                      </option>
                    ))}
                  </Select>
                  <Button
                    size="sm"
                    variant="quiet"
                    onClick={() =>
                      patchCast(index, { relationships: member.relationships.filter((_, i) => i !== relIndex) })
                    }
                  >
                    Remove
                  </Button>
                </div>
              ))}
              <Button
                size="sm"
                onClick={() =>
                  patchCast(index, {
                    relationships: [...member.relationships, { toward: "player", stage: "acquaintance" }],
                  })
                }
                className="w-fit"
              >
                + Add relationship
              </Button>
            </div>
          </div>
          {member.existingCharacterId ? (
            <p className="w-full text-xs text-paper-500">
              Wears by default:{" "}
              {(() => {
                const outfit = outfitsByCharacterId.get(member.existingCharacterId);
                if (!outfit) return "…";
                return outfit.length > 0 ? outfit.join(", ") : "nothing";
              })()}{" "}
              — outfits travel with the character into every session; edit them on the character page.
            </p>
          ) : null}
          <div className="flex w-full items-center gap-2">
            {member.existingCharacterId ? <Tag tone="ok">library match</Tag> : <Tag tone="ai">new stub</Tag>}
            {member.existingCharacterId ? (
              <Button size="sm" variant="quiet" onClick={() => patchCast(index, { existingCharacterId: undefined })}>
                Unlink
              </Button>
            ) : (
              <Button size="sm" variant="quiet" onClick={() => setPicker(index)}>
                Link to library…
              </Button>
            )}
            <Button
              size="sm"
              variant="quiet"
              onClick={() => onChange({ ...draft, castSuggestions: cast.filter((_, i) => i !== index) })}
              className="ml-auto"
            >
              Remove
            </Button>
          </div>
        </div>
      ))}
      <div className="flex gap-2">
        <Button
          onClick={() =>
            onChange({
              ...draft,
              castSuggestions: [...cast, { name: "", conceptNote: "", role: "npc", tier: "minor", relationships: [] }],
            })
          }
          className="w-fit"
        >
          + Add cast member
        </Button>
        <Button onClick={() => setPicker("add")} className="w-fit">
          + From library
        </Button>
      </div>
      <EntityPickerDialog
        open={picker !== null}
        onClose={() => setPicker(null)}
        title={picker === "add" ? "Add cast from the library" : "Link to a library character"}
        search={searchCharacters}
        onPick={pickCharacter}
        disabledIds={linkedIds}
        emptyText="No saved characters match."
      />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Items
// ---------------------------------------------------------------------------

function ItemsTab({ draft, onChange }: { draft: WorldDraft; onChange: (d: WorldDraft) => void }) {
  const placements = draft.itemPlacements;
  const patchPlacement = (index: number, patch: Partial<WorldDraftItemPlacement>) =>
    onChange({ ...draft, itemPlacements: placements.map((p, i) => (i === index ? { ...p, ...patch } : p)) });

  const locationNames = draft.locations.map((l) => l.name).filter(Boolean);
  const castNames = draft.castSuggestions.map((c) => c.name).filter(Boolean);

  const [pickerOpen, setPickerOpen] = useState(false);
  const searchItems = useCallback(async (q: string) => {
    const result = await itemsApi.list(q ? { q } : {});
    if (!result.ok) return result;
    return {
      ok: true as const,
      data: result.data.map((i) => ({
        id: i.id,
        name: i.name,
        imageId: i.imageId,
        detail: i.kind,
        chips: itemCardChips(i),
        data: i.kind,
      })),
    };
  }, []);
  const pickItem = (entry: EntityPickerEntry) => {
    const kind =
      entry.data === "clothing" || entry.data === "container" || entry.data === "object" ? entry.data : "object";
    onChange({
      ...draft,
      itemPlacements: [
        ...placements,
        {
          itemName: entry.name,
          definition: { kind, name: entry.name, description: "", coverage: [], opacity: "opaque", sensory: {}, fields: {}, tags: [] },
          worn: false,
          quantity: 1,
        },
      ],
    });
  };

  return (
    <div className="flex flex-col gap-3">
      {placements.length === 0 ? <p className="text-sm text-paper-500">No item placements yet.</p> : null}
      {placements.map((placement, index) => (
        <div key={index} className="flex flex-wrap items-end gap-3 rounded-card border border-ink-600 bg-ink-800 p-4">
          <Field label="Item" className="w-48">
            {(id) => (
              <Input
                id={id}
                value={placement.itemName}
                onChange={(e) =>
                  patchPlacement(index, {
                    itemName: e.target.value,
                    definition: { ...placement.definition, name: e.target.value },
                  })
                }
              />
            )}
          </Field>
          <Field label="Kind" className="w-32">
            {(id) => (
              <Select
                id={id}
                value={placement.definition.kind}
                onChange={(e) =>
                  patchPlacement(index, {
                    definition: { ...placement.definition, kind: e.target.value as "clothing" | "object" | "container" },
                  })
                }
              >
                <option value="object">object</option>
                <option value="container">container</option>
                <option value="clothing">clothing</option>
              </Select>
            )}
          </Field>
          <Field label="In location" className="w-44">
            {(id) => (
              <Select
                id={id}
                value={placement.locationName ?? ""}
                onChange={(e) =>
                  patchPlacement(index, { locationName: e.target.value || undefined, castName: e.target.value ? undefined : placement.castName })
                }
              >
                <option value="">—</option>
                {locationNames.map((name) => (
                  <option key={name} value={name}>
                    {name}
                  </option>
                ))}
              </Select>
            )}
          </Field>
          <Field label="With cast" className="w-44">
            {(id) => (
              <Select
                id={id}
                value={placement.castName ?? ""}
                onChange={(e) =>
                  patchPlacement(index, { castName: e.target.value || undefined, locationName: e.target.value ? undefined : placement.locationName })
                }
              >
                <option value="">—</option>
                {castNames.map((name) => (
                  <option key={name} value={name}>
                    {name}
                  </option>
                ))}
              </Select>
            )}
          </Field>
          <label className="flex h-9 items-center gap-2 text-xs text-paper-300">
            <input
              type="checkbox"
              checked={placement.worn}
              disabled={!placement.castName}
              onChange={(e) => patchPlacement(index, { worn: e.target.checked })}
              className="size-4 accent-accent-500"
            />
            worn
          </label>
          <Button
            size="sm"
            variant="quiet"
            onClick={() => onChange({ ...draft, itemPlacements: placements.filter((_, i) => i !== index) })}
            className="ml-auto"
          >
            Remove
          </Button>
        </div>
      ))}
      <div className="flex gap-2">
        <Button
          onClick={() =>
            onChange({
              ...draft,
              itemPlacements: [
                ...placements,
                {
                  itemName: "",
                  definition: {
                    kind: "object",
                    name: "",
                    description: "",
                    coverage: [],
                    opacity: "opaque",
                    sensory: {},
                    fields: {},
                    tags: [],
                  },
                  worn: false,
                  quantity: 1,
                },
              ],
            })
          }
          className="w-fit"
        >
          + Add placement
        </Button>
        <Button onClick={() => setPickerOpen(true)} className="w-fit">
          + From library
        </Button>
      </div>
      <p className="text-xs text-paper-500">
        A placement whose name matches a library item reuses that item on save; anything else is created new.
      </p>
      <EntityPickerDialog
        open={pickerOpen}
        onClose={() => setPickerOpen(false)}
        title="Place an item from the library"
        search={searchItems}
        onPick={pickItem}
        emptyText="No saved items match."
      />
    </div>
  );
}
