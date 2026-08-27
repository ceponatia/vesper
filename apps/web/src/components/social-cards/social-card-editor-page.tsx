"use client";

import { useRouter } from "next/navigation";
import { useRef, useState } from "react";
import { severityToTier, type SocialReactionCardExtras } from "@/contracts";
import { socialCardsApi } from "@/lib/client/api";
import { decideDraftSeed } from "@/components/hooks/draft-seed";
import { useAsyncData } from "@/components/hooks/use-async";
import { useAutosave } from "@/components/hooks/use-autosave";
import { LibraryBackLink } from "@/components/library/back-link";
import { PublishToggle } from "@/components/library/publish-toggle";
import { SocialCardFields } from "@/components/personality/social-card-fields";
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

interface CardForm {
  name: string;
  description: string;
  tags: string[];
  definition: SocialReactionCardExtras;
}

/**
 * The standalone card builder. Edits one `social_cards` library
 * row: the row-level name/description/tags + a publish toggle, plus the mechanical `definition`
 * via the shared {@link SocialCardFields} (kind/severity/triggers/overrides + live preview). Same
 * form-seeding pattern as the item editor — each card seeds once so refetches can't clobber edits.
 */
export function SocialCardEditorPage({ cardId }: { cardId: string }) {
  const router = useRouter();
  const toast = useToast();
  const detail = useAsyncData(() => socialCardsApi.get(cardId), [cardId]);

  const [form, setForm] = useState<CardForm | null>(null);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [cloning, setCloning] = useState(false);
  /** Bumped on every edit so a completing save can't clear newer dirtiness. */
  const editGenRef = useRef(0);

  const [seededId, setSeededId] = useState<string | null>(null);
  const seedAction = decideDraftSeed({ entityId: cardId, seededId, loadedId: detail.data?.id ?? null });
  if (seedAction === "seed" && detail.data) {
    setSeededId(cardId);
    setDirty(false);
    setForm({
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

  const patch = (next: Partial<CardForm>) => {
    editGenRef.current += 1;
    setForm((current) => (current ? { ...current, ...next } : current));
    setDirty(true);
  };
  const patchDefinition = (next: Partial<SocialReactionCardExtras>) => {
    editGenRef.current += 1;
    setForm((current) => (current ? { ...current, definition: { ...current.definition, ...next } } : current));
    setDirty(true);
  };

  const save = async (opts: { silent?: boolean } = {}): Promise<boolean> => {
    if (!form) return false;
    const gen = editGenRef.current;
    setSaving(true);
    const result = await socialCardsApi.update(cardId, form);
    setSaving(false);
    if (result.ok) {
      if (editGenRef.current === gen) setDirty(false);
      if (!opts.silent) toast.push({ title: "Card saved", tone: "success" });
      detail.reload({ silent: true });
      return true;
    }
    toast.push({ title: "Save failed", description: result.error.message, tone: "error" });
    return false;
  };

  const remove = async () => {
    setDeleting(true);
    const result = await socialCardsApi.remove(cardId);
    setDeleting(false);
    if (result.ok) router.push("/social-cards");
    else {
      toast.push({ title: "Delete failed", description: result.error.message, tone: "error" });
      setConfirmDelete(false);
    }
  };

  // Autosave: silent saves on change/blur. No forge/staged-draft state
  // here, so there's nothing to pause it for.
  const autosave = useAutosave({
    enabled: true,
    dirty,
    saving,
    save: () => save({ silent: true }),
    signal: form,
  });

  const clone = async () => {
    setCloning(true);
    const result = await socialCardsApi.clone(cardId);
    setCloning(false);
    if (result.ok) router.push(`/social-cards/${result.data.id}`);
    else toast.push({ title: "Clone failed", description: result.error.message, tone: "error" });
  };

  if (detail.loading && !form) {
    return (
      <PageContainer>
        <LibraryBackLink href="/social-cards" label="Social cards" />
        <Skeleton className="mb-6 h-8 w-64" />
        <SkeletonText lines={5} />
      </PageContainer>
    );
  }

  if (detail.error && !form) {
    return (
      <PageContainer>
        <LibraryBackLink href="/social-cards" label="Social cards" />
        <ErrorState error={detail.error} onRetry={() => detail.reload()} />
      </PageContainer>
    );
  }

  if (!form) return null;

  // A public card owned by someone else: read-only preview + a clone-to-library CTA
  // (the discovery gallery's copy-on-use path — edits would 404 server-side anyway).
  if (detail.data && !detail.data.mine) {
    const tier = severityToTier(form.definition.severity);
    return (
      <PageContainer>
        <LibraryBackLink href="/social-cards" label="Social cards" />
        <div className="mb-6 flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between sm:gap-4">
          <h1 className="prose-display min-w-0 truncate text-2xl">{form.name || "Untitled card"}</h1>
          <Button busy={cloning} onClick={clone}>
            Clone to my library
          </Button>
        </div>
        <div className="flex flex-col gap-3 rounded-card border border-ink-700 bg-ink-850 p-4 text-sm text-paper-300">
          <p className="text-paper-400">Someone else&apos;s public card — clone it to edit your own copy.</p>
          {form.description ? <p>{form.description}</p> : null}
          <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-xs">
            <dt className="text-paper-500">Kind</dt>
            <dd>{form.definition.kind.replace(/_/g, " ")}</dd>
            <dt className="text-paper-500">Severity</dt>
            <dd>
              {form.definition.severity} · {tier}
            </dd>
            <dt className="text-paper-500">Triggers</dt>
            <dd>{form.definition.triggers.length > 0 ? form.definition.triggers.join(", ") : "—"}</dd>
          </dl>
        </div>
      </PageContainer>
    );
  }

  return (
    <PageContainer>
      <LibraryBackLink href="/social-cards" label="Social cards" />
      <div className="mb-6 flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between sm:gap-4">
        <h1 className="prose-display min-w-0 truncate text-2xl">{form.name || "Untitled card"}</h1>
        {detail.data ? <PublishToggle kind="social_card" id={cardId} visibility={detail.data.visibility} /> : null}
      </div>

      <div className="flex flex-col gap-4" onBlur={autosave.onBlur}>
        <Field label="Name">
          {(id) => <Input id={id} value={form.name} onChange={(e) => patch({ name: e.target.value })} />}
        </Field>
        <Field label="Description" hint="What the rule forbids or expects — shown to the narrator as social guidance.">
          {(id) => (
            <Textarea id={id} rows={3} value={form.description} onChange={(e) => patch({ description: e.target.value })} />
          )}
        </Field>
        <Field label="Tags">
          {(id) => <TagInput id={id} value={form.tags} onChange={(tags) => patch({ tags })} />}
        </Field>
        <SocialCardFields value={form.definition} onChange={patchDefinition} />
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
        title="Delete this card?"
        footer={
          <>
            <Button onClick={() => setConfirmDelete(false)}>Cancel</Button>
            <Button variant="danger" busy={deleting} onClick={remove}>
              Delete
            </Button>
          </>
        }
      >
        Worlds and characters keep their own inline copies — deleting the library card will not touch them.
      </Dialog>
    </PageContainer>
  );
}
