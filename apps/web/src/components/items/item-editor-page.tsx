"use client";

import { useRouter } from "next/navigation";
import { useMemo, useRef, useState } from "react";
import {
  bodyLocationRegistry,
  clothingCategories,
  clothingCategoryById,
  clothingSubtypeById,
  clothingSubtypesForCategory,
  colorFamilies,
  expandCoverage,
  objectSubtypeById,
  objectSubtypes,
  toggleCoverage,
  wearerTargets,
  type BodyLocation,
  type ItemKind,
} from "@/contracts";
import { itemsApi, type ItemDefinitionParts } from "@/lib/client/api";
import { decideDraftSeed } from "@/components/hooks/draft-seed";
import { useAsyncData } from "@/components/hooks/use-async";
import { useAutosave } from "@/components/hooks/use-autosave";
import { LibraryBackLink } from "@/components/library/back-link";
import { EntityImageStudio } from "@/components/library/entity-image-studio";
import { PublishToggle } from "@/components/library/publish-toggle";
import { PageContainer } from "@/components/shell/app-shell";
import { Button } from "@/components/ui/button";
import { cx } from "@/components/ui/cx";
import { Dialog } from "@/components/ui/dialog";
import { ErrorState } from "@/components/ui/error-state";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { SaveBar } from "@/components/ui/save-bar";
import { Select } from "@/components/ui/select";
import { Skeleton, SkeletonText } from "@/components/ui/skeleton";
import { Tabs, type TabDef } from "@/components/ui/tabs";
import { TagInput } from "@/components/ui/tag-input";
import { Textarea } from "@/components/ui/textarea";
import { useToast } from "@/components/ui/toast";

interface ItemForm {
  kind: ItemKind;
  name: string;
  description: string;
  tags: string[];
  definition: ItemDefinitionParts;
}

const itemKinds: readonly ItemKind[] = ["clothing", "object", "container"];
const layerOptions = [
  { value: 0, label: "0 · underwear" },
  { value: 1, label: "1 · base" },
  { value: 2, label: "2 · mid" },
  { value: 3, label: "3 · outerwear" },
] as const;

export function ItemEditorPage({ itemId }: { itemId: string }) {
  const router = useRouter();
  const toast = useToast();
  const detail = useAsyncData(() => itemsApi.get(itemId), [itemId]);

  const [form, setForm] = useState<ItemForm | null>(null);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [cloning, setCloning] = useState(false);
  const [drafting, setDrafting] = useState(false);
  /** A ✦ draft landed and awaits review — autosave pauses (forge-draft discipline). */
  const [stagedDraft, setStagedDraft] = useState(false);
  /** Where the item is referenced — fetched when the delete dialog opens. */
  const [usage, setUsage] = useState<{
    wornBy: { id: string; name: string }[];
  } | null>(null);
  const [tab, setTab] = useState<"details" | "image">("details");
  /** Bumped on every edit so a completing save can't clear newer dirtiness. */
  const editGenRef = useRef(0);

  const editorTabs: TabDef<"details" | "image">[] = [
    { id: "details", label: "Details" },
    { id: "image", label: "Image" },
  ];

  // Seed the form from the loaded item during render (the React "adjust
  // state while rendering" pattern). Each item is seeded exactly once, so
  // refetches can never clobber in-progress edits, and navigating between
  // items drops the previous item's form instead of showing it stale.
  const [seededId, setSeededId] = useState<string | null>(null);
  const seedAction = decideDraftSeed({ entityId: itemId, seededId, loadedId: detail.data?.id ?? null });
  if (seedAction === "seed" && detail.data) {
    setSeededId(itemId);
    setDirty(false);
    setForm({
      kind: detail.data.kind,
      name: detail.data.name,
      description: detail.data.description,
      tags: [...detail.data.tags],
      definition: detail.data.definition,
    });
  } else if (seedAction === "clear") {
    setSeededId(null);
    setForm(null);
    setDirty(false);
  }

  const patch = (patch: Partial<ItemForm>) => {
    editGenRef.current += 1;
    setForm((current) => (current ? { ...current, ...patch } : current));
    setDirty(true);
  };
  const patchDefinition = (patch: Partial<ItemDefinitionParts>) => {
    editGenRef.current += 1;
    setForm((current) => (current ? { ...current, definition: { ...current.definition, ...patch } } : current));
    setDirty(true);
  };

  const save = async (opts: { silent?: boolean } = {}): Promise<boolean> => {
    if (!form) return false;
    const gen = editGenRef.current;
    setSaving(true);
    const result = await itemsApi.update(itemId, form);
    setSaving(false);
    if (result.ok) {
      // Edits made while the save was in flight stay marked unsaved.
      if (editGenRef.current === gen) setDirty(false);
      setStagedDraft(false); // a save IS the review acceptance
      if (!opts.silent) toast.push({ title: "Item saved", tone: "success" });
      detail.reload({ silent: true });
      return true;
    }
    toast.push({ title: "Save failed", description: result.error.message, tone: "error" });
    return false;
  };

  /**
   * ✦ Draft from description: the classify seam extended into the editor —
   * propose category/layer/wearer/color/
   * opacity, explicit coverage (carve-outs included) and the three sensory
   * lines from name + description. Fill-EMPTY-only merge into the unsaved
   * form; the SaveBar stays the review/undo step (Forge-the-rest discipline).
   */
  const draftFromDescription = async () => {
    if (!form || drafting) return;
    const name = form.name.trim();
    const description = form.description.trim();
    if (!name && !description) {
      toast.push({ title: "Nothing to draft from", description: "Give the item a name or a description first.", tone: "error" });
      return;
    }
    setDrafting(true);
    const result = await itemsApi.draft({ kind: form.kind, name, description });
    setDrafting(false);
    if (!result.ok) {
      toast.push({ title: "Draft failed", description: result.error.message, tone: "error" });
      return;
    }
    const drafted = result.data.draft;
    editGenRef.current += 1;
    setForm((current) => {
      if (!current) return current;
      const def = current.definition;
      return {
        ...current,
        definition: {
          ...def,
          category: def.category ?? drafted.category ?? null,
          subtype: def.subtype ?? drafted.subtype ?? null,
          wearer: def.wearer ?? drafted.wearer ?? null,
          layer: def.layer ?? drafted.layer ?? null,
          color:
            def.color ??
            (drafted.color ? { family: drafted.color.family, shade: drafted.color.shade ?? null, accent: null } : null),
          // Opacity has no empty state (default "opaque") — a proposed value
          // applies only over the default; the SaveBar review still guards it.
          opacity: def.opacity === "opaque" && drafted.opacity ? drafted.opacity : def.opacity,
          coverage: def.coverage.length > 0 ? def.coverage : (drafted.coverage ?? def.coverage),
          sensory: {
            appearance: def.sensory.appearance?.trim() ? def.sensory.appearance : drafted.sensory?.appearance,
            scent: def.sensory.scent?.trim() ? def.sensory.scent : drafted.sensory?.scent,
            tactile: def.sensory.tactile?.trim() ? def.sensory.tactile : drafted.sensory?.tactile,
          },
        },
      };
    });
    setDirty(true);
    setStagedDraft(true); // pause autosave — the SaveBar is the review step
    toast.push({ title: "Item drafted", description: "Review the filled fields, then save.", tone: "success" });
  };

  /** Save-first — the clone copies the saved row. Wardrobe variants ("same top in three colors") start here. */
  const clone = async () => {
    if (cloning || saving) return;
    if (dirty && !(await save())) return;
    setCloning(true);
    const result = await itemsApi.clone(itemId);
    setCloning(false);
    if (result.ok) {
      toast.push({ title: "Item duplicated", description: "You're now editing the copy.", tone: "success" });
      router.push(`/items/${result.data.id}`);
    } else {
      toast.push({ title: "Duplicate failed", description: result.error.message, tone: "error" });
    }
  };

  // Autosave: silent saves on change/blur; paused while a ✦ draft
  // awaits review. The SaveBar's Save stays the loud manual flush.
  const autosave = useAutosave({
    enabled: !stagedDraft,
    dirty,
    saving,
    save: () => save({ silent: true }),
    signal: form,
  });

  /** Open the delete confirm and look up references — warn, never block. */
  const openDeleteConfirm = () => {
    setUsage(null);
    setConfirmDelete(true);
    void itemsApi.usage(itemId).then((result) => {
      if (result.ok) setUsage(result.data);
      // A failed lookup degrades to the plain confirm — deleting stays possible.
      else setUsage({ wornBy: [] });
    });
  };

  const remove = async () => {
    setDeleting(true);
    const result = await itemsApi.remove(itemId);
    setDeleting(false);
    if (result.ok) router.push("/items");
    else {
      toast.push({ title: "Delete failed", description: result.error.message, tone: "error" });
      setConfirmDelete(false);
    }
  };

  if (detail.loading && !form) {
    return (
      <PageContainer>
        <LibraryBackLink href="/items" label="Items" />
        <Skeleton className="mb-6 h-8 w-64" />
        <SkeletonText lines={5} />
      </PageContainer>
    );
  }

  if (detail.error && !form) {
    return (
      <PageContainer>
        <LibraryBackLink href="/items" label="Items" />
        <ErrorState error={detail.error} onRetry={() => detail.reload()} />
      </PageContainer>
    );
  }

  if (!form) return null;

  // A public item owned by someone else: read-only preview + a clone-to-library
  // CTA (the discovery gallery's copy-on-use path — the social-card pattern;
  // edits would 404 server-side anyway).
  if (detail.data && !detail.data.mine) {
    return (
      <PageContainer>
        <LibraryBackLink href="/items" label="Items" />
        <div className="mb-6 flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between sm:gap-4">
          <h1 className="prose-display min-w-0 truncate text-2xl">{form.name || "Untitled item"}</h1>
          <Button busy={cloning} onClick={() => void clone()}>
            Clone to my library
          </Button>
        </div>
        <div className="flex flex-col gap-3 rounded-card border border-ink-700 bg-ink-850 p-4 text-sm text-paper-300">
          <p className="text-paper-400">Someone else&apos;s public item — clone it to edit your own copy.</p>
          {form.description ? <p>{form.description}</p> : null}
          <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-xs">
            <dt className="text-paper-500">Kind</dt>
            <dd>{form.kind}</dd>
            {form.definition.category ? (
              <>
                <dt className="text-paper-500">Category</dt>
                <dd>{form.definition.category.replace(/_/g, " ")}</dd>
              </>
            ) : null}
            {form.definition.color ? (
              <>
                <dt className="text-paper-500">Color</dt>
                <dd>{form.definition.color.shade ?? form.definition.color.family}</dd>
              </>
            ) : null}
          </dl>
        </div>
      </PageContainer>
    );
  }

  return (
    <PageContainer>
      <LibraryBackLink href="/items" label="Items" />
      <div className="mb-6 flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between sm:gap-4">
        <h1 className="prose-display min-w-0 truncate text-2xl">{form.name || "Untitled item"}</h1>
        <div className="flex flex-wrap items-center gap-3">
          <Button
            onClick={() => void draftFromDescription()}
            busy={drafting}
            disabled={saving || (!form.name.trim() && !form.description.trim())}
            title="Propose category, fit, coverage and sensory lines from the name + description — fills empty fields only; review, then save."
          >
            ✦ Draft from description
          </Button>
          {detail.data ? <PublishToggle kind="item" id={itemId} visibility={detail.data.visibility} /> : null}
        </div>
      </div>

      <Tabs tabs={editorTabs} value={tab} onChange={setTab} className="mb-6" />

      {tab === "image" ? (
        <EntityImageStudio
          entityKind="item"
          entityId={itemId}
          name={form.name}
          imageId={detail.data?.imageId ?? null}
          onImageChanged={() => detail.reload({ silent: true })}
        />
      ) : (
        <div onBlur={autosave.onBlur}>
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <Field label="Name" error={!form.name.trim() ? "No name yet — this item saves unnamed." : undefined}>
          {(id) => <Input id={id} value={form.name} onChange={(e) => patch({ name: e.target.value })} />}
        </Field>
        <Field label="Kind">
          <div className="flex h-9 gap-1 rounded-md border border-ink-600 bg-ink-850 p-1">
            {itemKinds.map((kind) => (
              <button
                key={kind}
                type="button"
                aria-pressed={form.kind === kind}
                // Clothing is never layerless — switching kind backfills the
                // 1 · base default (same rule as create, server-side).
                onClick={() =>
                  patch(
                    kind === "clothing" && form.definition.layer === null
                      ? { kind, definition: { ...form.definition, layer: 1 } }
                      : { kind },
                  )
                }
                className={cx(
                  "flex-1 cursor-pointer rounded text-xs transition-colors",
                  form.kind === kind ? "bg-ink-700 text-paper-50" : "text-paper-400 hover:text-paper-200",
                )}
              >
                {kind}
              </button>
            ))}
          </div>
        </Field>
        <Field label="Description" className="sm:col-span-2">
          {(id) => (
            <Textarea id={id} rows={3} value={form.description} onChange={(e) => patch({ description: e.target.value })} />
          )}
        </Field>
        <Field label="Tags" className="sm:col-span-2">
          {(id) => <TagInput id={id} value={form.tags} onChange={(tags) => patch({ tags })} />}
        </Field>
        <Field label="Color" hint="Family drives library filters and sorting.">
          {(id) => (
            <Select
              id={id}
              value={form.definition.color?.family ?? ""}
              onChange={(e) => {
                const family = e.target.value;
                patchDefinition({
                  color: family ? { family, shade: form.definition.color?.shade ?? null, accent: null } : null,
                });
              }}
            >
              <option value="">—</option>
              {colorFamilies.map((family) => (
                <option key={family.id} value={family.id}>
                  {family.label}
                </option>
              ))}
            </Select>
          )}
        </Field>
        <Field label="Shade" hint="The precise hue, e.g. “aqua”, “olive”.">
          {(id) => (
            <Input
              id={id}
              value={form.definition.color?.shade ?? ""}
              disabled={!form.definition.color}
              onChange={(e) => {
                const current = form.definition.color;
                if (current) patchDefinition({ color: { ...current, shade: e.target.value || null } });
              }}
            />
          )}
        </Field>
      </div>

      {form.kind === "clothing" ? (
        <ClothingFields definition={form.definition} onPatch={patchDefinition} />
      ) : null}

      {form.kind === "object" ? (
        <div className="mt-6 grid grid-cols-1 gap-4 sm:grid-cols-2">
          <Field
            label="Subtype"
            hint={
              form.definition.subtype && objectSubtypeById(form.definition.subtype)?.holdable
                ? "Holdable: can be carried in a hand (and stored in containers)."
                : "Vocabulary for future behavior (vehicles, weapons, …)."
            }
          >
            {(id) => (
              <Select
                id={id}
                value={form.definition.subtype ?? ""}
                onChange={(e) => patchDefinition({ subtype: e.target.value || null })}
              >
                <option value="">—</option>
                {objectSubtypes.map((subtype) => (
                  <option key={subtype.id} value={subtype.id}>
                    {subtype.label}
                  </option>
                ))}
              </Select>
            )}
          </Field>
        </div>
      ) : null}

      {form.kind === "container" ? (
        <div className="mt-6 grid grid-cols-1 gap-4 sm:grid-cols-2">
          <Field label="Capacity note" hint="Free-form: what fits inside.">
            {(id) => (
              <Input
                id={id}
                value={typeof form.definition.fields.capacity === "string" ? form.definition.fields.capacity : ""}
                onChange={(e) =>
                  patchDefinition({ fields: { ...form.definition.fields, capacity: e.target.value || undefined } })
                }
              />
            )}
          </Field>
        </div>
      ) : null}

      {/* Sensory */}
      <div className="mt-6">
        <h2 className="mb-3 text-xs font-medium tracking-wide text-paper-400 uppercase">Sensory</h2>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
          {(["appearance", "scent", "tactile"] as const).map((sense) => (
            <Field key={sense} label={sense}>
              {(id) => (
                <Input
                  id={id}
                  value={form.definition.sensory[sense] ?? ""}
                  onChange={(e) =>
                    patchDefinition({ sensory: { ...form.definition.sensory, [sense]: e.target.value || undefined } })
                  }
                />
              )}
            </Field>
          ))}
        </div>
      </div>
        </div>
      )}

      <SaveBar
        dirty={dirty}
        saving={saving}
        onSave={() => void save()}
        secondary={
          <>
            <Button
              size="sm"
              busy={cloning}
              onClick={() => void clone()}
              title="Copy this item into a new library entry and open it — the fast path for near-variants."
            >
              Duplicate
            </Button>
            <Button variant="danger" size="sm" onClick={openDeleteConfirm}>
              Delete
            </Button>
          </>
        }
      />
      <Dialog
        open={confirmDelete}
        onClose={() => setConfirmDelete(false)}
        title="Delete this item?"
        footer={
          <>
            <Button onClick={() => setConfirmDelete(false)}>Cancel</Button>
            <Button variant="danger" busy={deleting} onClick={remove}>
              Delete
            </Button>
          </>
        }
      >
        <div className="flex flex-col gap-2 text-sm">
          {usage === null ? (
            <p className="text-xs text-paper-500">Checking where it&apos;s used…</p>
          ) : (
            <>
              {usage.wornBy.length > 0 ? (
                <p className="text-xs text-danger-300">
                  Worn in the default outfit of {usage.wornBy.map((c) => c.name).join(", ")}
                  {/* String-expression children: swc in next 16.2.x drops the leading space of a multi-line JSX
                      text node containing an HTML entity (swc#11521; fixed in next 16.3.0). */}
                  {" — that outfit slot will show “not in library” after deleting."}
                </p>
              ) : (
                <p className="text-xs text-paper-500">Not referenced by any character outfit.</p>
              )}
            </>
          )}
        </div>
      </Dialog>
    </PageContainer>
  );
}

/** Coverage picker over the body-location registry + layer + opacity. */
function ClothingFields({
  definition,
  onPatch,
}: {
  definition: ItemDefinitionParts;
  onPatch: (patch: Partial<ItemDefinitionParts>) => void;
}) {
  const roots = useMemo(() => bodyLocationRegistry.all.filter((loc) => !loc.parentId && loc.coverageRelevant), []);
  // Effective set: what the stored coverage implies (a minimal ["head"] from
  // the forge reads as head + all its parts until the first toggle explodes it).
  const effective = useMemo(() => expandCoverage(definition.coverage), [definition.coverage]);

  const toggle = (id: string) => {
    onPatch({ coverage: toggleCoverage(definition.coverage, id) });
  };

  // Picking a category applies its template (coverage + layer); everything
  // stays editable after — the category is a starting point, not a constraint.
  // Subtype vocabularies are per-category, so a category change clears it.
  const applyCategory = (id: string) => {
    if (!id) {
      onPatch({ category: null, subtype: null });
      return;
    }
    const category = clothingCategoryById(id);
    if (!category) return;
    onPatch({ category: id, subtype: null, coverage: [...category.coverage], layer: category.layer });
  };

  // Picking a subtype applies its coverage template when it has one (a lip
  // ring anchors to lips) — same pre-fill-then-edit semantics as categories.
  const applySubtype = (id: string) => {
    if (!id) {
      onPatch({ subtype: null });
      return;
    }
    const subtype = clothingSubtypeById(id);
    if (!subtype) return;
    onPatch({ subtype: id, ...(subtype.coverage ? { coverage: [...subtype.coverage] } : {}) });
  };

  const subtypeOptions = clothingSubtypesForCategory(definition.category);

  return (
    <div className="mt-6 flex flex-col gap-5">
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Field
          label="Category"
          hint={
            definition.category === "footwear"
              ? "Covers the whole foot by default — open sandal? Uncheck toes / top of foot below (a flip-flop keeps only the sole)."
              : "Template: pre-fills coverage and layer."
          }
        >
          {(id) => (
            <Select id={id} value={definition.category ?? ""} onChange={(e) => applyCategory(e.target.value)}>
              <option value="">—</option>
              {clothingCategories.map((category) => (
                <option key={category.id} value={category.id}>
                  {category.label}
                </option>
              ))}
            </Select>
          )}
        </Field>
        {subtypeOptions.length > 0 ? (
          <Field label="Type" hint="Sharpens image and narrator prompts (“nose ring”, not just the name).">
            {(id) => (
              <Select id={id} value={definition.subtype ?? ""} onChange={(e) => applySubtype(e.target.value)}>
                <option value="">—</option>
                {subtypeOptions.map((subtype) => (
                  <option key={subtype.id} value={subtype.id}>
                    {subtype.label}
                  </option>
                ))}
              </Select>
            )}
          </Field>
        ) : null}
        <Field label="Layer" hint="0 underwear · 3 outerwear; higher layers occlude lower.">
          {(id) => (
            <Select
              id={id}
              value={definition.layer === null ? "" : String(definition.layer)}
              onChange={(e) =>
                onPatch({ layer: e.target.value === "" ? null : (Number(e.target.value) as 0 | 1 | 2 | 3) })
              }
            >
              <option value="">unset</option>
              {layerOptions.map((opt) => (
                <option key={opt.value} value={opt.value}>
                  {opt.label}
                </option>
              ))}
            </Select>
          )}
        </Field>
        <Field label="Opacity" hint="Sheer fabric reveals what's beneath.">
          {(id) => (
            <Select
              id={id}
              value={definition.opacity}
              onChange={(e) => onPatch({ opacity: e.target.value as "opaque" | "sheer" })}
            >
              <option value="opaque">opaque</option>
              <option value="sheer">sheer</option>
            </Select>
          )}
        </Field>
        <Field label="Wearer" hint="Unisex also fits gender-neutral characters.">
          {(id) => (
            <Select
              id={id}
              value={definition.wearer ?? ""}
              onChange={(e) => onPatch({ wearer: e.target.value || null })}
            >
              <option value="">unspecified</option>
              {wearerTargets.map((target) => (
                <option key={target.id} value={target.id}>
                  {target.label}
                </option>
              ))}
            </Select>
          )}
        </Field>
      </div>
      <p className="-mt-3 text-xs text-paper-500">
        The category never reaches the story — the narrator only sees the name, description and coverage, so a
        “top” with arm coverage removed plays as a tank top.
      </p>

      <div>
        <h2 className="mb-3 text-xs font-medium tracking-wide text-paper-400 uppercase">Coverage</h2>
        <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-5">
          {roots.map((root) => (
            <div key={root.id} className="rounded-card border border-ink-600 bg-ink-800 p-3">
              <CoverageNode location={root} effective={effective} onToggle={toggle} isRoot />
            </div>
          ))}
        </div>
        <p className="mt-2 text-xs text-paper-500">
          Checking a region covers all its parts; uncheck a part to carve it out — a ski mask is “head” minus “eyes”.
          A dimmed dash means partially covered: only the checked parts count (glasses check “eyes” alone).
        </p>
      </div>
    </div>
  );
}

/**
 * One node of the coverage tree: select-all cascade via toggleCoverage
 * (contracts/items/coverage.ts), indeterminate when only some parts are
 * covered, children connected by an indent guide.
 */
function CoverageNode({
  location,
  effective,
  onToggle,
  isRoot = false,
}: {
  location: BodyLocation;
  effective: ReadonlySet<string>;
  onToggle: (id: string) => void;
  isRoot?: boolean;
}) {
  const children = bodyLocationRegistry.childrenOf(location.id).filter((c) => c.coverageRelevant);
  const checked = effective.has(location.id);
  const partial = !checked && bodyLocationRegistry.expand(location.id).some((id) => id !== location.id && effective.has(id));

  return (
    <div className="flex flex-col gap-1">
      <label
        className={cx("flex cursor-pointer items-center gap-2 text-xs", isRoot ? "font-medium" : undefined)}
        title={partial ? "Partially covered — only the checked parts count" : undefined}
      >
        <input
          type="checkbox"
          checked={checked}
          ref={(el) => {
            if (el) el.indeterminate = partial;
          }}
          onChange={() => onToggle(location.id)}
          className={cx("size-3.5 accent-accent-500", partial && "opacity-50")}
        />
        <span className={cx("capitalize", checked ? "text-paper-200" : "text-paper-400")}>{location.label}</span>
      </label>
      {children.length > 0 ? (
        <div className="ml-1.5 flex flex-col gap-1 border-l border-ink-600 pl-3">
          {children.map((child) => (
            <CoverageNode key={child.id} location={child} effective={effective} onToggle={onToggle} />
          ))}
        </div>
      ) : null}
    </div>
  );
}
