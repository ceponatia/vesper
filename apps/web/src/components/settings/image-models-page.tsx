"use client";

import { useState } from "react";
import {
  adminImageModelsApi,
  meApi,
  type ImageModel,
  type ImageModelProfile,
  type ImageModelSurface,
} from "@/lib/client/api";
import { useAsyncData } from "@/components/hooks/use-async";
import { PageContainer } from "@/components/shell/app-shell";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { ErrorState } from "@/components/ui/error-state";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { useToast } from "@/components/ui/toast";
import { MODEL_SURFACES } from "./image-admin-shared";
import { ImageLoraLibrary } from "./image-lora-library";
import { ModelRow, type ImageModelPatchBody } from "./image-model-row";

/**
 * The image-model registry's management page. Admin-only: paste a Replicate
 * model path, tick the surfaces it should appear in, save. The routes beneath
 * `/api/admin/self` are the real gate — they 404 for non-admins — so the check
 * here is only so a non-admin sees an explanation instead of a page of failed
 * requests.
 *
 * One registry fetch feeds everything: the model cards, each card's nested
 * profiles and version corner (`ModelRow`), and the LoRA library's
 * compatibility list — so no two sections can disagree about which models
 * exist. Seeded models and profiles are ordinary rows: editable and deletable
 * like any other; `builtin` is a note, not a lock.
 */

export function ImageModelsPage() {
  const me = useAsyncData(() => meApi.get(), []);
  const registry = useAsyncData(() => adminImageModelsApi.list(), []);
  const toast = useToast();

  const [slug, setSlug] = useState("");
  const [surfaces, setSurfaces] = useState<ImageModelSurface[]>(["portrait"]);
  const [adding, setAdding] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [pendingDelete, setPendingDelete] = useState<ImageModel | null>(null);

  const isAdmin = me.data?.role === "admin";
  const models = registry.data?.models ?? [];
  const profiles = registry.data?.profiles ?? [];
  const profilesFor = (model: ImageModel): ImageModelProfile[] =>
    profiles.filter((profile) => profile.imageModelId === model.id);

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
    toast.push({
      title: `Added ${result.data.model.label}`,
      description: "It has no profiles yet — nothing offers a model without one. Add a profile on its card.",
      tone: "success",
    });
    registry.reload({ silent: true });
  };

  const patch = async (model: ImageModel, body: ImageModelPatchBody) => {
    setBusyId(model.id);
    const result = await adminImageModelsApi.update(model.id, body);
    setBusyId(null);
    if (!result.ok) {
      toast.push({ title: "Update failed", description: result.error.message, tone: "error" });
      return;
    }
    registry.reload({ silent: true });
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
    registry.reload({ silent: true });
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
          Which Replicate models the app can use, and how each job uses them. Adding a model reads its API to work out
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
          {MODEL_SURFACES.map((surface) => (
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

      {registry.error ? <ErrorState error={registry.error} onRetry={() => registry.reload()} /> : null}
      {registry.loading && !registry.data ? <Skeleton className="h-24 w-full" /> : null}

      <div className="flex flex-col gap-3">
        {models.map((model) => (
          <ModelRow
            key={model.id}
            model={model}
            profiles={profilesFor(model)}
            busy={busyId === model.id}
            onPatch={(body) => void patch(model, body)}
            onDelete={() => setPendingDelete(model)}
            onChanged={() => registry.reload({ silent: true })}
          />
        ))}
        {registry.data?.models.length === 0 ? (
          <p className="text-sm text-paper-500">
            No models registered. Nothing in the app can render an image until you add one.
          </p>
        ) : null}
      </div>

      {/* The registry the page already holds feeds the library's compatibility
          list — one fetch, so the two can never disagree about which models exist. */}
      <ImageLoraLibrary models={models} />

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
        It disappears from every picker, and its profiles go with it. Existing images are untouched, and any
        conversation still pointing at it falls back to the default for that job.
      </Dialog>
    </PageContainer>
  );
}
