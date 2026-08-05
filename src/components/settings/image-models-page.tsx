"use client";

import { useState } from "react";
import { adminImageModelsApi, meApi, type ImageModel, type ImageModelSurface } from "@/lib/client/api";
import { useAsyncData } from "@/components/hooks/use-async";
import { PageContainer } from "@/components/shell/app-shell";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { ErrorState } from "@/components/ui/error-state";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { Tag } from "@/components/ui/tag";
import { useToast } from "@/components/ui/toast";

/**
 * The image-model registry's management page (image-model-registry.plan.md).
 * Admin-only: paste a Replicate model path, tick the surfaces it should appear
 * in, save. The routes beneath `/api/admin/self` are the real gate — they 404
 * for non-admins — so the check here is only so a non-admin sees an explanation
 * instead of a page of failed requests.
 *
 * Seeded models are ordinary rows: editable and deletable like any other (owner
 * ruling 4). The `builtin` tag is a note about where a row came from, not a lock.
 */

const SURFACES: { key: ImageModelSurface; label: string; hint: string }[] = [
  { key: "portrait", label: "Portrait studio", hint: "Making a new portrait from a description" },
  { key: "variant", label: "New Variant", hint: "Editing an existing portrait" },
  { key: "scene", label: "Scene generator", hint: "Painting a chat moment from the avatar" },
];

export function ImageModelsPage() {
  const me = useAsyncData(() => meApi.get(), []);
  const models = useAsyncData(() => adminImageModelsApi.list(), []);
  const toast = useToast();

  const [slug, setSlug] = useState("");
  const [surfaces, setSurfaces] = useState<ImageModelSurface[]>(["portrait"]);
  const [adding, setAdding] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [pendingDelete, setPendingDelete] = useState<ImageModel | null>(null);

  const isAdmin = me.data?.role === "admin";

  const toggleSurface = (surface: ImageModelSurface) => {
    setSurfaces((current) =>
      current.includes(surface) ? current.filter((s) => s !== surface) : [...current, surface],
    );
  };

  const add = async () => {
    const trimmed = slug.trim();
    if (!trimmed) return;
    setAdding(true);
    const result = await adminImageModelsApi.create({ slug: trimmed, surfaces });
    setAdding(false);
    if (!result.ok) {
      // The probe is the one place this feature fails loudly rather than
      // degrading — a mistyped path is caught here instead of at render time.
      toast.push({ title: "Couldn't add that model", description: result.error.message, tone: "error" });
      return;
    }
    setSlug("");
    toast.push({ title: `Added ${result.data.model.label}`, tone: "success" });
    models.reload({ silent: true });
  };

  const patch = async (model: ImageModel, body: Parameters<typeof adminImageModelsApi.update>[1]) => {
    setBusyId(model.id);
    const result = await adminImageModelsApi.update(model.id, body);
    setBusyId(null);
    if (!result.ok) {
      toast.push({ title: "Update failed", description: result.error.message, tone: "error" });
      return;
    }
    models.reload({ silent: true });
  };

  const confirmDelete = async () => {
    if (!pendingDelete) return;
    setBusyId(pendingDelete.id);
    const result = await adminImageModelsApi.remove(pendingDelete.id);
    setBusyId(null);
    setPendingDelete(null);
    if (!result.ok) {
      toast.push({ title: "Delete failed", description: result.error.message, tone: "error" });
      return;
    }
    toast.push({ title: "Model removed", tone: "success" });
    models.reload({ silent: true });
  };

  if (me.loading && !me.data) {
    return (
      <PageContainer>
        <Skeleton className="h-8 w-56" />
      </PageContainer>
    );
  }

  if (!isAdmin) {
    return (
      <PageContainer>
        <h1 className="prose-display text-2xl">Image models</h1>
        <p className="mt-2 text-sm text-paper-400">This page is only available to administrators.</p>
      </PageContainer>
    );
  }

  return (
    <PageContainer>
      <header className="mb-6">
        <h1 className="prose-display text-2xl">Image models</h1>
        <p className="mt-1 text-sm text-paper-400">
          Which Replicate models the app can use, and where each one shows up. Adding a model reads its API to work out
          what it can do — a path that doesn&rsquo;t exist is rejected here rather than failing later on a render.
        </p>
      </header>

      <section className="mb-8 rounded-card border border-ink-600 bg-ink-850 p-5">
        <h2 className="mb-3 text-xs font-medium tracking-wide text-paper-400 uppercase">Add a model</h2>
        <div className="flex flex-wrap items-end gap-3">
          <Field label="Replicate model path" className="min-w-72 flex-1">
            {(id) => (
              <Input
                id={id}
                value={slug}
                onChange={(e) => setSlug(e.target.value)}
                placeholder="stability-ai/stable-diffusion-3.5-large"
                spellCheck={false}
              />
            )}
          </Field>
          <Button variant="primary" onClick={add} busy={adding} disabled={!slug.trim()}>
            Add model
          </Button>
        </div>
        <div className="mt-3 flex flex-wrap gap-4">
          {SURFACES.map((surface) => (
            <label key={surface.key} className="flex items-center gap-2 text-sm text-paper-300" title={surface.hint}>
              <input
                type="checkbox"
                checked={surfaces.includes(surface.key)}
                onChange={() => toggleSurface(surface.key)}
                className="accent-accent-500"
              />
              {surface.label}
            </label>
          ))}
        </div>
        <p className="mt-2 text-[11px] text-paper-600">
          Append <code>:version</code> to pin a specific version. Without one, the model tracks whatever Replicate
          currently publishes — which can change its inputs underneath us.
        </p>
      </section>

      {models.error ? <ErrorState error={models.error} onRetry={() => models.reload()} /> : null}
      {models.loading && !models.data ? <Skeleton className="h-24 w-full" /> : null}

      <div className="flex flex-col gap-3">
        {(models.data ?? []).map((model) => (
          <ModelRow
            key={model.id}
            model={model}
            busy={busyId === model.id}
            onPatch={(body) => void patch(model, body)}
            onDelete={() => setPendingDelete(model)}
          />
        ))}
        {models.data?.length === 0 ? (
          <p className="text-sm text-paper-500">
            No models registered. Nothing in the app can render an image until you add one.
          </p>
        ) : null}
      </div>

      <Dialog
        open={pendingDelete !== null}
        onClose={() => setPendingDelete(null)}
        title={`Remove ${pendingDelete?.label ?? "this model"}?`}
        footer={
          <>
            <Button onClick={() => setPendingDelete(null)}>Cancel</Button>
            <Button variant="danger" busy={busyId === pendingDelete?.id} onClick={() => void confirmDelete()}>
              Remove
            </Button>
          </>
        }
      >
        It disappears from every picker. Existing images are untouched, and any conversation still pointing at it falls
        back to the default for that surface.
      </Dialog>
    </PageContainer>
  );
}

function ModelRow({
  model,
  busy,
  onPatch,
  onDelete,
}: {
  model: ImageModel;
  busy: boolean;
  onPatch: (body: Parameters<typeof adminImageModelsApi.update>[1]) => void;
  onDelete: () => void;
}) {
  const enabled: Record<ImageModelSurface, boolean> = {
    portrait: model.forPortrait,
    variant: model.forVariant,
    scene: model.forScene,
  };
  const capable: Record<ImageModelSurface, boolean> = {
    portrait: model.canGenerate,
    variant: model.canEdit,
    scene: model.canEdit,
  };

  return (
    <div className="rounded-card border border-ink-600 bg-ink-850 p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="text-sm font-medium text-paper-200">{model.label}</h3>
            {model.builtin ? <Tag>built-in</Tag> : null}
            {model.canGenerate ? <Tag tone="ok">can generate</Tag> : null}
            {model.canEdit ? <Tag tone="ok">can edit</Tag> : null}
          </div>
          <p className="mt-0.5 font-mono text-[11px] break-all text-paper-500">{model.slug}</p>
          <p className="mt-1 text-[11px] text-paper-600">
            references: <code>{model.referenceField}</code> ({model.referenceArity}, max {model.maxReferences}) ·
            shape: {model.aspectMode} · {model.supportedAspects.length} option
            {model.supportedAspects.length === 1 ? "" : "s"}
            {model.outputFormat ? ` · ${model.outputFormat}` : ""}
          </p>
        </div>
        <div className="flex shrink-0 gap-2">
          <Button
            size="sm"
            variant="quiet"
            busy={busy}
            onClick={() => onPatch({ reprobe: true })}
            title="Re-read this model's API and refresh what it can do"
          >
            Re-probe
          </Button>
          <Button size="sm" variant="quiet" onClick={onDelete}>
            Remove
          </Button>
        </div>
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-4">
        {SURFACES.map((surface) => (
          <label
            key={surface.key}
            className={`flex items-center gap-2 text-sm ${capable[surface.key] ? "text-paper-300" : "text-paper-600"}`}
            // A ticked box on a model that lacks the capability is honoured as
            // storage but never listed — say so rather than letting it look broken.
            title={
              capable[surface.key]
                ? surface.hint
                : surface.key === "portrait"
                  ? "This model needs a reference image, so it can't make a portrait from nothing"
                  : "This model has no reference input, so it can't edit an existing image"
            }
          >
            <input
              type="checkbox"
              checked={enabled[surface.key]}
              disabled={!capable[surface.key] || busy}
              onChange={() =>
                onPatch({
                  ...(surface.key === "portrait" ? { forPortrait: !model.forPortrait } : {}),
                  ...(surface.key === "variant" ? { forVariant: !model.forVariant } : {}),
                  ...(surface.key === "scene" ? { forScene: !model.forScene } : {}),
                })
              }
              className="accent-accent-500"
            />
            {surface.label}
          </label>
        ))}
        <label className="ml-auto flex items-center gap-2 text-[11px] text-paper-500">
          max references
          <Input
            type="number"
            min={0}
            max={64}
            defaultValue={model.maxReferences}
            disabled={busy || !model.canEdit}
            onBlur={(e) => {
              const next = Number(e.target.value);
              if (Number.isFinite(next) && next !== model.maxReferences) onPatch({ maxReferences: next });
            }}
            className="h-7 w-16 text-xs"
          />
        </label>
      </div>
    </div>
  );
}
