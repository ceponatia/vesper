"use client";

import { useRouter } from "next/navigation";
import { useRef, useState } from "react";
import { locationsApi, type Ambient } from "@/lib/client/api";
import { decideDraftSeed } from "@/components/hooks/draft-seed";
import { useAsyncData } from "@/components/hooks/use-async";
import { PageContainer } from "@/components/shell/app-shell";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { ErrorState } from "@/components/ui/error-state";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { SaveBar } from "@/components/ui/save-bar";
import { Skeleton, SkeletonText } from "@/components/ui/skeleton";
import { TagInput } from "@/components/ui/tag-input";
import { Textarea } from "@/components/ui/textarea";
import { useToast } from "@/components/ui/toast";

interface LocationForm {
  name: string;
  description: string;
  ambient: Ambient;
  tags: string[];
}

export function LocationEditorPage({ locationId }: { locationId: string }) {
  const router = useRouter();
  const toast = useToast();
  const detail = useAsyncData(() => locationsApi.get(locationId), [locationId]);

  const [form, setForm] = useState<LocationForm | null>(null);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);
  /** Bumped on every edit so a completing save can't clear newer dirtiness. */
  const editGenRef = useRef(0);

  // Seed the form from the loaded location during render (the React "adjust
  // state while rendering" pattern). Each location is seeded exactly once, so
  // refetches can never clobber in-progress edits.
  const [seededId, setSeededId] = useState<string | null>(null);
  const seedAction = decideDraftSeed({ entityId: locationId, seededId, loadedId: detail.data?.id ?? null });
  if (seedAction === "seed" && detail.data) {
    setSeededId(locationId);
    setDirty(false);
    setForm({
      name: detail.data.name,
      description: detail.data.description,
      ambient: detail.data.ambient,
      tags: [...detail.data.tags],
    });
  } else if (seedAction === "clear") {
    setSeededId(null);
    setForm(null);
    setDirty(false);
  }

  const patch = (patch: Partial<LocationForm>) => {
    editGenRef.current += 1;
    setForm((current) => (current ? { ...current, ...patch } : current));
    setDirty(true);
  };

  const save = async () => {
    if (!form) return;
    const gen = editGenRef.current;
    setSaving(true);
    const result = await locationsApi.update(locationId, form);
    setSaving(false);
    if (result.ok) {
      // Edits made while the save was in flight stay marked unsaved.
      if (editGenRef.current === gen) setDirty(false);
      toast.push({ title: "Location saved", tone: "success" });
      detail.reload({ silent: true });
    } else {
      toast.push({ title: "Save failed", description: result.error.message, tone: "error" });
    }
  };

  const remove = async () => {
    setDeleting(true);
    const result = await locationsApi.remove(locationId);
    setDeleting(false);
    if (result.ok) router.push("/locations");
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
      <h1 className="prose-display mb-6 text-2xl">{form.name || "Untitled location"}</h1>
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <Field label="Name">
          {(id) => <Input id={id} value={form.name} onChange={(e) => patch({ name: e.target.value })} />}
        </Field>
        <Field label="Tags">
          {(id) => <TagInput id={id} value={form.tags} onChange={(tags) => patch({ tags })} />}
        </Field>
        <Field label="Description" className="sm:col-span-2">
          {(id) => (
            <Textarea id={id} rows={4} value={form.description} onChange={(e) => patch({ description: e.target.value })} />
          )}
        </Field>
        {(["scent", "sound", "light"] as const).map((sense) => (
          <Field key={sense} label={`Ambient ${sense}`} hint={sense === "scent" ? "What the room smells like." : undefined}>
            {(id) => (
              <Input
                id={id}
                value={form.ambient[sense] ?? ""}
                onChange={(e) => patch({ ambient: { ...form.ambient, [sense]: e.target.value || undefined } })}
              />
            )}
          </Field>
        ))}
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
        title="Delete this location?"
        footer={
          <>
            <Button onClick={() => setConfirmDelete(false)}>Cancel</Button>
            <Button variant="danger" busy={deleting} onClick={remove}>
              Delete
            </Button>
          </>
        }
      >
        Worlds that placed it keep their own copies.
      </Dialog>
    </PageContainer>
  );
}
