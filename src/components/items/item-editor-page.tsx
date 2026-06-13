"use client";

import { useRouter } from "next/navigation";
import { useMemo, useRef, useState } from "react";
import {
  bodyLocationRegistry,
  clothingCategories,
  clothingCategoryById,
  expandCoverage,
  objectSubtypeById,
  objectSubtypes,
  toggleCoverage,
  type BodyLocation,
  type ItemKind,
} from "@/contracts";
import { itemsApi, type ItemDefinitionParts } from "@/lib/client/api";
import { decideDraftSeed } from "@/components/hooks/draft-seed";
import { useAsyncData } from "@/components/hooks/use-async";
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
  /** Bumped on every edit so a completing save can't clear newer dirtiness. */
  const editGenRef = useRef(0);

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

  const save = async () => {
    if (!form) return;
    const gen = editGenRef.current;
    setSaving(true);
    const result = await itemsApi.update(itemId, form);
    setSaving(false);
    if (result.ok) {
      // Edits made while the save was in flight stay marked unsaved.
      if (editGenRef.current === gen) setDirty(false);
      toast.push({ title: "Item saved", tone: "success" });
      detail.reload({ silent: true });
    } else {
      toast.push({ title: "Save failed", description: result.error.message, tone: "error" });
    }
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
        <Skeleton className="mb-6 h-8 w-64" />
        <SkeletonText lines={5} />
      </PageContainer>
    );
  }

  if (detail.error && !form) {
    return (
      <PageContainer>
        <ErrorState error={detail.error} onRetry={() => detail.reload()} />
      </PageContainer>
    );
  }

  if (!form) return null;

  return (
    <PageContainer>
      <h1 className="prose-display mb-6 text-2xl">{form.name || "Untitled item"}</h1>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <Field label="Name">
          {(id) => <Input id={id} value={form.name} onChange={(e) => patch({ name: e.target.value })} />}
        </Field>
        <Field label="Kind">
          <div className="flex h-9 gap-1 rounded-md border border-ink-600 bg-ink-850 p-1">
            {itemKinds.map((kind) => (
              <button
                key={kind}
                type="button"
                aria-pressed={form.kind === kind}
                onClick={() => patch({ kind })}
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

      <SaveBar
        dirty={dirty}
        saving={saving}
        onSave={save}
        secondary={
          <Button variant="danger" size="sm" onClick={() => setConfirmDelete(true)}>
            Delete
          </Button>
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
        Sessions keep their own item snapshots.
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
  const applyCategory = (id: string) => {
    if (!id) {
      onPatch({ category: null });
      return;
    }
    const category = clothingCategoryById(id);
    if (!category) return;
    onPatch({ category: id, coverage: [...category.coverage], layer: category.layer });
  };

  return (
    <div className="mt-6 flex flex-col gap-5">
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
        <Field label="Category" hint="Template: pre-fills coverage and layer.">
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
