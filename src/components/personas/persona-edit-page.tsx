"use client";

import { useRouter } from "next/navigation";
import { useRef, useState } from "react";
import { emptyPersonaProfile, personaProfileSchema } from "@/contracts";
import { personasApi } from "@/lib/client/api";
import { decideDraftSeed } from "@/components/hooks/draft-seed";
import { useAsyncData } from "@/components/hooks/use-async";
import { useAutosave } from "@/components/hooks/use-autosave";
import { PageContainer } from "@/components/shell/app-shell";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { ErrorState } from "@/components/ui/error-state";
import { SaveBar } from "@/components/ui/save-bar";
import { Skeleton, SkeletonText } from "@/components/ui/skeleton";
import { useToast } from "@/components/ui/toast";
import { PersonaEditor, type PersonaDraft } from "./persona-editor";

/**
 * The persona edit page (persona-library.plan.md slice 5) — the character-edit-page
 * shell minus everything a persona doesn't have: no forge, no re-draft, no portrait
 * studio, no clone, no publish toggle, no chat tab.
 *
 * One thing it has that the others don't: a **title collision** is a real, expected
 * outcome (the `(owner_id, title)` UNIQUE is the feature), so the 409 lands inline on
 * the Title field instead of a toast — and autosave has to hold the dirty flag rather
 * than swallow it, or the edit would be silently lost.
 */
export function PersonaEditPage({ personaId }: { personaId: string }) {
  const router = useRouter();
  const toast = useToast();
  const detail = useAsyncData(() => personasApi.get(personaId), [personaId]);

  const [draft, setDraft] = useState<PersonaDraft | null>(null);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [titleError, setTitleError] = useState<string | undefined>(undefined);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);
  /** Bumped on every edit so a completing save can't clear newer dirtiness. */
  const editGenRef = useRef(0);

  // Seed the editable draft once per persona during render (the "adjust state while
  // rendering" pattern), so a silent refetch can never clobber in-progress edits.
  const [seededId, setSeededId] = useState<string | null>(null);
  const seedAction = decideDraftSeed({ entityId: personaId, seededId, loadedId: detail.data?.id ?? null });
  if (seedAction === "seed" && detail.data) {
    setSeededId(personaId);
    setDirty(false);
    setDraft({
      title: detail.data.title,
      name: detail.data.name,
      tags: [...detail.data.tags],
      profile: personaProfileSchema.parse(detail.data.profile ?? emptyPersonaProfile()),
    });
  } else if (seedAction === "clear") {
    setSeededId(null);
    setDraft(null);
    setDirty(false);
  }

  const save = async (opts: { silent?: boolean } = {}): Promise<boolean> => {
    if (!draft) return false;
    const gen = editGenRef.current;
    setSaving(true);
    const result = await personasApi.update(personaId, {
      title: draft.title,
      name: draft.name,
      tags: draft.tags,
      profile: draft.profile,
    });
    setSaving(false);
    if (result.ok) {
      if (editGenRef.current === gen) setDirty(false);
      setTitleError(undefined);
      if (!opts.silent) toast.push({ title: "Persona saved", tone: "success" });
      detail.reload({ silent: true });
      return true;
    }
    // A title collision is expected, not exceptional — surface it on the field and
    // KEEP the draft dirty so the edit isn't silently dropped.
    if (result.error.code === "title_conflict") {
      setTitleError(result.error.message);
      if (!opts.silent) toast.push({ title: "That title is taken", description: result.error.message, tone: "error" });
      return false;
    }
    toast.push({ title: "Save failed", description: result.error.message, tone: "error" });
    return false;
  };

  // Autosave (ux-improvements slice 7): silent saves on change/blur. Paused while a
  // title collision is unresolved — retrying the same conflicting title every 1.5s
  // would just churn 409s until the user renames it.
  const autosave = useAutosave({
    enabled: titleError === undefined,
    dirty,
    saving,
    save: () => save({ silent: true }),
    signal: draft,
  });

  const remove = async () => {
    setDeleting(true);
    const result = await personasApi.remove(personaId);
    setDeleting(false);
    if (result.ok) {
      toast.push({ title: "Persona deleted" });
      router.push("/personas");
    } else {
      toast.push({ title: "Delete failed", description: result.error.message, tone: "error" });
      setConfirmDelete(false);
    }
  };

  if (detail.loading && !draft) {
    return (
      <PageContainer>
        <Skeleton className="mb-6 h-8 w-64" />
        <SkeletonText lines={6} />
      </PageContainer>
    );
  }

  if (detail.error && !draft) {
    return (
      <PageContainer>
        <ErrorState error={detail.error} onRetry={() => detail.reload()} />
      </PageContainer>
    );
  }

  if (!draft) return null;

  return (
    <PageContainer>
      <div className="mb-6 flex items-center justify-between gap-4">
        <h1 className="prose-display text-2xl">{draft.title || "Untitled persona"}</h1>
      </div>
      <div onBlur={autosave.onBlur}>
        <PersonaEditor
          draft={draft}
          titleError={titleError}
          onChange={(next) => {
            editGenRef.current += 1;
            // A title edit is the fix for a collision — clear the error so autosave resumes.
            if (next.title !== draft.title) setTitleError(undefined);
            setDraft(next);
            setDirty(true);
          }}
        />
      </div>
      <SaveBar
        dirty={dirty}
        saving={saving}
        onSave={() => void save()}
        secondary={
          <Button variant="danger" size="sm" onClick={() => setConfirmDelete(true)}>
            Delete
          </Button>
        }
      />
      <Dialog
        open={confirmDelete}
        onClose={() => setConfirmDelete(false)}
        title="Delete this persona?"
        footer={
          <>
            <Button onClick={() => setConfirmDelete(false)}>Cancel</Button>
            <Button variant="danger" busy={deleting} onClick={() => void remove()}>
              Delete
            </Button>
          </>
        }
      >
        <p className="text-sm text-paper-300">
          {draft.title || "This persona"} will be removed from your library. Chats you played as it keep their
          transcript.
        </p>
      </Dialog>
    </PageContainer>
  );
}
