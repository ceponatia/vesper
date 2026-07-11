"use client";

import { useRouter } from "next/navigation";
import { useCallback, useRef, useState } from "react";
import { locationsApi, type Ambient, type ApiResult, type LocationConnection } from "@/lib/client/api";
import { decideDraftSeed } from "@/components/hooks/draft-seed";
import { useAsyncData } from "@/components/hooks/use-async";
import { LibraryBackLink } from "@/components/library/back-link";
import { EntityPickerDialog, type EntityPickerEntry } from "@/components/library/entity-picker";
import { PublishToggle } from "@/components/library/publish-toggle";
import { EntityImageStudio } from "@/components/library/entity-image-studio";
import { PageContainer } from "@/components/shell/app-shell";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { ErrorState } from "@/components/ui/error-state";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { SaveBar } from "@/components/ui/save-bar";
import { Select } from "@/components/ui/select";
import { Skeleton, SkeletonText } from "@/components/ui/skeleton";
import { Tabs, type TabDef } from "@/components/ui/tabs";
import { Tag } from "@/components/ui/tag";
import { TagInput } from "@/components/ui/tag-input";
import { Textarea } from "@/components/ui/textarea";
import { useToast } from "@/components/ui/toast";

const LOCATION_SCALES = ["intimate", "room", "hall", "open", "expanse"] as const;
type LocationScaleValue = (typeof LOCATION_SCALES)[number];

const SCALE_HINT = "Spatial size: how far apart people in here can be.";

interface LocationForm {
  name: string;
  description: string;
  ambient: Ambient;
  tags: string[];
  scale: LocationScaleValue;
  area: string;
  /** Undirected connections to other library locations. */
  links: LocationConnection[];
}

export function LocationEditorPage({ locationId }: { locationId: string }) {
  const router = useRouter();
  const toast = useToast();
  const detail = useAsyncData(() => locationsApi.get(locationId), [locationId]);
  const [connectOpen, setConnectOpen] = useState(false);
  // The connection picker's search (self and already-linked ids render disabled).
  const searchConnectable = useCallback(async (q: string): Promise<ApiResult<EntityPickerEntry[]>> => {
    const result = await locationsApi.list({ q });
    if (!result.ok) return result;
    return {
      ok: true,
      data: result.data.map((l) => ({ id: l.id, name: l.name, imageId: l.imageId, detail: l.description || undefined })),
    };
  }, []);

  const [form, setForm] = useState<LocationForm | null>(null);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [tab, setTab] = useState<"details" | "image">("details");
  /** Bumped on every edit so a completing save can't clear newer dirtiness. */
  const editGenRef = useRef(0);

  const editorTabs: TabDef<"details" | "image">[] = [
    { id: "details", label: "Details" },
    { id: "image", label: "Image" },
  ];

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
      scale: detail.data.scale,
      area: detail.data.area ?? "",
      links: [...detail.data.links],
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
    const result = await locationsApi.update(locationId, {
      name: form.name,
      description: form.description,
      ambient: form.ambient,
      tags: form.tags,
      scale: form.scale,
      area: form.area.trim() || null,
      links: form.links.map((l) => l.id),
    });
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
        <LibraryBackLink href="/locations" label="Locations" />
        <Skeleton className="mb-6 h-8 w-64" />
        <SkeletonText lines={5} />
      </PageContainer>
    );
  }

  if (detail.error && !form) {
    return (
      <PageContainer>
        <LibraryBackLink href="/locations" label="Locations" />
        <ErrorState error={detail.error} onRetry={() => detail.reload()} />
      </PageContainer>
    );
  }

  if (!form) return null;

  return (
    <PageContainer>
      <LibraryBackLink href="/locations" label="Locations" />
      <div className="mb-6 flex items-center justify-between gap-4">
        <h1 className="prose-display text-2xl">{form.name || "Untitled location"}</h1>
        {detail.data ? <PublishToggle kind="location" id={locationId} visibility={detail.data.visibility} /> : null}
      </div>

      <Tabs tabs={editorTabs} value={tab} onChange={setTab} className="mb-6" />

      {tab === "image" ? (
        <EntityImageStudio
          entityKind="location"
          entityId={locationId}
          name={form.name}
          imageId={detail.data?.imageId ?? null}
          onImageChanged={() => detail.reload({ silent: true })}
        />
      ) : (
        <>
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <Field label="Name">
          {(id) => <Input id={id} value={form.name} onChange={(e) => patch({ name: e.target.value })} />}
        </Field>
        <Field label="Tags">
          {(id) => <TagInput id={id} value={form.tags} onChange={(tags) => patch({ tags })} />}
        </Field>
        <Field label="Scale" hint={SCALE_HINT}>
          {(id) => (
            <Select
              id={id}
              value={form.scale}
              onChange={(e) => patch({ scale: e.target.value as LocationScaleValue })}
            >
              {LOCATION_SCALES.map((value) => (
                <option key={value} value={value}>
                  {value}
                </option>
              ))}
            </Select>
          )}
        </Field>
        <Field label="Area" hint="Locations sharing an area are a minute apart; crossing areas takes longer.">
          {(id) => (
            <Input
              id={id}
              value={form.area}
              placeholder="area label (optional)"
              onChange={(e) => patch({ area: e.target.value })}
            />
          )}
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

      <div className="mt-6 flex flex-col gap-2">
        <h2 className="text-xs font-medium tracking-wide text-paper-400 uppercase">Connections</h2>
        <p className="text-xs text-paper-500">
          Undirected links to other library locations. Designing a multi-room place here preserves its map; importing the
          set into a world recreates these connections.
        </p>
        <div className="flex flex-wrap items-center gap-1.5">
          {form.links.map((link) => (
            <Tag key={link.id} onRemove={() => patch({ links: form.links.filter((l) => l.id !== link.id) })}>
              {link.name}
            </Tag>
          ))}
          <button
            type="button"
            onClick={() => setConnectOpen(true)}
            className="cursor-pointer rounded-md border border-ink-600 px-2 py-0.5 text-xs text-paper-400 transition-colors hover:border-accent-500/60 hover:text-accent-300"
          >
            + Connect a location…
          </button>
        </div>
      </div>
      <EntityPickerDialog
        open={connectOpen}
        onClose={() => setConnectOpen(false)}
        title="Connect a location"
        search={searchConnectable}
        onPick={(entry) => patch({ links: [...form.links, { id: entry.id, name: entry.name }] })}
        disabledIds={new Set([locationId, ...form.links.map((l) => l.id)])}
        emptyText="No other locations to connect to yet."
        square={false}
      />
        </>
      )}

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
