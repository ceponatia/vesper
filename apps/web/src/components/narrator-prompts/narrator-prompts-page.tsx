"use client";

import { useEffect, useRef, useState } from "react";
import type { NarratorPromptTemplateDetail } from "@/contracts/narrator-prompts";
import { meApi, type ApiResult } from "@/lib/client/api";
import { decideDraftSeed } from "@/components/hooks/draft-seed";
import { useAsyncData } from "@/components/hooks/use-async";
import { PageContainer } from "@/components/shell/app-shell";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { EmptyState } from "@/components/ui/empty-state";
import { ErrorState } from "@/components/ui/error-state";
import { Skeleton } from "@/components/ui/skeleton";
import { useToast } from "@/components/ui/toast";
import {
  NarratorPromptEditor,
  type NarratorPromptBusyAction,
  type NarratorPromptEditorSession,
} from "./narrator-prompt-editor";
import { NarratorPromptLibrary } from "./narrator-prompt-library";
import {
  inUseSaveWarning,
  isNarratorPromptDraftDirty,
  NARRATOR_PROMPT_STARTER_BODY,
  usageCountLabel,
  type NarratorPromptDraft,
} from "./narrator-prompt-shared";
import { narratorPromptsApi, readNarratorPromptFailure } from "./narrator-prompts-api";

/**
 * The Narrator Prompt Lab: the owner-admin master/detail screen for handwritten
 * narrator instruction prompts — library on the left, one prompt's editor on the
 * right.
 *
 * `/api/admin/self/narrator-prompts` is role-gated server-side and is the REAL
 * gate — `withOwnerAdmin` fails closed with a hidden 404. The check here is only
 * so a non-admin gets an explanation instead of a page of failed requests;
 * hiding the menu entry is tidiness, not authorization.
 *
 * Three rules shape everything below:
 *
 * - **No autosave.** A saved body is an experimental revision that reaches live
 *   conversations on their next reply, so Save is always a button someone pressed
 *   — and a save that will travel gets a confirm *before* it travels, not a toast
 *   after.
 * - **A stale save never wins quietly.** The editor sends the revision it loaded
 *   as `baseRevision`; a 409 puts up a recovery choice (reload, or keep typing)
 *   rather than overwriting a revision nobody in this tab has read, and rather
 *   than throwing away what the owner just wrote.
 * - **Unsaved work is not lost by a click.** Switching prompts, starting a new
 *   one, duplicating, and closing the tab all check the dirty state first.
 */

/** The editor pane's target while a brand-new, never-saved prompt is being written. */
const NEW_PROMPT = "__new__";

/** State and address bar move together, so a refresh or a pasted link lands back on
 *  the same prompt. `replaceState`, never `pushState`: nothing here listens for
 *  popstate, so a pushed entry would let Back rewind the URL while the view stayed. */
function mirrorPromptUrl(templateId: string | null): void {
  const url = new URL(window.location.href);
  if (templateId === null) url.searchParams.delete("prompt");
  else url.searchParams.set("prompt", templateId);
  window.history.replaceState(null, "", url);
}

function sessionFromDetail(template: NarratorPromptTemplateDetail): NarratorPromptEditorSession {
  const loaded: NarratorPromptDraft = { name: template.name, notes: template.notes, body: template.body };
  return {
    templateId: template.id,
    baseRevision: template.currentRevision,
    currentRevision: template.currentRevision,
    usageCount: template.usageCount,
    loaded,
    draft: { ...loaded },
  };
}

function newPromptSession(): NarratorPromptEditorSession {
  const loaded: NarratorPromptDraft = { name: "", notes: "", body: NARRATOR_PROMPT_STARTER_BODY };
  return { templateId: null, baseRevision: 0, currentRevision: 0, usageCount: 0, loaded, draft: { ...loaded } };
}

/** Somewhere the editor is about to go, held back until unsaved work is dealt with. */
type PendingNav = { kind: "select"; templateId: string } | { kind: "new" } | { kind: "duplicate" };

type PromptDetailEnvelope = { prompt: NarratorPromptTemplateDetail } | null;

export function NarratorPromptsPage({ initialPromptId }: { initialPromptId?: string }) {
  const toast = useToast();
  const me = useAsyncData(() => meApi.get(), []);
  const list = useAsyncData(() => narratorPromptsApi.list(), []);

  const [target, setTarget] = useState<string | null>(initialPromptId ?? null);
  const [session, setSession] = useState<NarratorPromptEditorSession | null>(null);
  const [busyAction, setBusyAction] = useState<NarratorPromptBusyAction | null>(null);
  const [conflict, setConflict] = useState<{ currentRevision: number | null } | null>(null);
  const [nameError, setNameError] = useState<string | null>(null);
  const [bodyError, setBodyError] = useState<string | null>(null);
  const [pendingNav, setPendingNav] = useState<PendingNav | null>(null);
  const [pendingInUseSave, setPendingInUseSave] = useState(false);
  const [pendingDelete, setPendingDelete] = useState(false);

  const isNewTarget = target === NEW_PROMPT;
  const selectedId = isNewTarget ? null : target;

  const detail = useAsyncData<PromptDetailEnvelope>(
    () =>
      selectedId === null
        ? Promise.resolve<ApiResult<PromptDetailEnvelope>>({ ok: true, data: null })
        : narratorPromptsApi.get(selectedId),
    [selectedId],
  );

  // Seed the editor from the loaded template during render (the repo's
  // "adjust state while rendering" pattern, docs/ui.md §Conventions). Each
  // target is seeded exactly once, so a silent list refresh or a post-save
  // reload can never clobber in-progress typing, and moving to another prompt
  // drops the previous draft instead of showing it under the new name.
  const [seededTarget, setSeededTarget] = useState<string | null>(null);
  const seedAction = decideDraftSeed({
    entityId: target ?? "",
    seededId: seededTarget,
    loadedId: isNewTarget ? NEW_PROMPT : (detail.data?.prompt.id ?? null),
  });
  if (seedAction === "seed") {
    if (isNewTarget) {
      setSeededTarget(NEW_PROMPT);
      setSession(newPromptSession());
      setConflict(null);
      setNameError(null);
      setBodyError(null);
    } else if (detail.data) {
      setSeededTarget(detail.data.prompt.id);
      setSession(sessionFromDetail(detail.data.prompt));
      setConflict(null);
      setNameError(null);
      setBodyError(null);
    }
  } else if (seedAction === "clear") {
    setSeededTarget(null);
    setSession(null);
    setConflict(null);
    setNameError(null);
    setBodyError(null);
  }

  // A never-saved prompt is unsaved by definition; a saved one is dirty only
  // against the revision this editor loaded.
  const dirty =
    session !== null &&
    (session.templateId === null || isNarratorPromptDraftDirty(session.loaded, session.draft));

  // Closing the tab is the one exit the page cannot intercept with a dialog, so
  // it gets the browser's own warning. Latest-ref'd (the use-async idiom) so the
  // listener is registered once instead of on every keystroke.
  const dirtyRef = useRef(dirty);
  useEffect(() => {
    dirtyRef.current = dirty;
  });
  useEffect(() => {
    const handler = (event: BeforeUnloadEvent) => {
      if (dirtyRef.current) event.preventDefault();
    };
    window.addEventListener("beforeunload", handler);
    return () => window.removeEventListener("beforeunload", handler);
  }, []);

  /** Adopt a template the server just handed back (create, save, duplicate, conflict reload). */
  const adoptTemplate = (template: NarratorPromptTemplateDetail) => {
    setTarget(template.id);
    setSeededTarget(template.id);
    setSession(sessionFromDetail(template));
    setConflict(null);
    setNameError(null);
    setBodyError(null);
    mirrorPromptUrl(template.id);
  };

  const closeEditor = () => {
    setTarget(null);
    setSeededTarget(null);
    setSession(null);
    setConflict(null);
    setNameError(null);
    setBodyError(null);
    mirrorPromptUrl(null);
  };

  const patchDraft = (patch: Partial<NarratorPromptDraft>) => {
    setSession((current) => (current === null ? current : { ...current, draft: { ...current.draft, ...patch } }));
    if (patch.name !== undefined) setNameError(null);
    if (patch.body !== undefined) setBodyError(null);
  };

  const duplicateCurrent = async () => {
    const templateId = session?.templateId;
    if (templateId === null || templateId === undefined) return;
    setBusyAction("duplicate");
    const result = await narratorPromptsApi.duplicate(templateId);
    setBusyAction(null);
    if (!result.ok) {
      toast.push({ title: "Duplicate failed", description: result.error.message, tone: "error" });
      return;
    }
    adoptTemplate(result.data.prompt);
    list.reload({ silent: true });
    toast.push({
      title: `Copied to ${result.data.prompt.name}`,
      description: "The copy is independent — editing it never touches the prompt it came from.",
      tone: "success",
    });
  };

  const runNav = (nav: PendingNav) => {
    setPendingNav(null);
    if (nav.kind === "select") {
      setTarget(nav.templateId);
      mirrorPromptUrl(nav.templateId);
      return;
    }
    if (nav.kind === "new") {
      setTarget(NEW_PROMPT);
      mirrorPromptUrl(null);
      return;
    }
    void duplicateCurrent();
  };

  /** Every door out of the current draft goes through here. */
  const requestNav = (nav: PendingNav) => {
    if (dirty) {
      setPendingNav(nav);
      return;
    }
    runNav(nav);
  };

  const save = async (confirmedInUse = false) => {
    if (session === null) return;
    const name = session.draft.name.trim();
    const notes = session.draft.notes.trim();
    const body = session.draft.body.trim();
    setNameError(null);
    setBodyError(null);
    if (name === "") {
      setNameError("Give the prompt a name, so a result written down weeks from now still points at something.");
      return;
    }
    if (body === "") {
      setBodyError(
        "An empty body would strip the narrator’s craft instructions entirely. If that is what you mean, say so in words instead.",
      );
      return;
    }
    // The in-use warning is a step BEFORE the write, not a report after it: the
    // owner should know how far a revision travels while they can still stop it.
    if (session.templateId !== null && session.usageCount > 0 && !confirmedInUse) {
      setPendingInUseSave(true);
      return;
    }
    setPendingInUseSave(false);
    setBusyAction("save");
    const result =
      session.templateId === null
        ? await narratorPromptsApi.create({ name, notes, body })
        : await narratorPromptsApi.save(session.templateId, {
            name,
            notes,
            body,
            baseRevision: session.baseRevision,
          });
    setBusyAction(null);
    if (!result.ok) {
      const failure = readNarratorPromptFailure(result.error);
      if (failure?.kind === "conflict") {
        // Deliberately leaves the draft exactly as typed: the recovery choice is
        // the owner's, and neither overwriting nor discarding is ours to make.
        setConflict({ currentRevision: failure.currentRevision });
        list.reload({ silent: true });
        return;
      }
      if (failure?.kind === "name_taken") {
        setNameError("Another prompt already has that name. Names are unique, ignoring case.");
        return;
      }
      toast.push({ title: "Save failed", description: result.error.message, tone: "error" });
      return;
    }
    adoptTemplate(result.data.prompt);
    list.reload({ silent: true });
    toast.push({ title: `Saved revision ${String(result.data.prompt.currentRevision)}`, tone: "success" });
  };

  /** Discard the local edits and load whatever revision actually exists now. */
  const reloadFromConflict = async () => {
    const templateId = session?.templateId;
    if (templateId === null || templateId === undefined) return;
    // Reuses the save spinner: both conflict buttons are disabled while it runs,
    // and it is the same "this editor is busy with its revision" state.
    setBusyAction("save");
    const result = await narratorPromptsApi.get(templateId);
    setBusyAction(null);
    if (!result.ok) {
      toast.push({ title: "Couldn’t reload the prompt", description: result.error.message, tone: "error" });
      return;
    }
    adoptTemplate(result.data.prompt);
    list.reload({ silent: true });
  };

  const confirmDelete = async () => {
    const templateId = session?.templateId;
    if (templateId === null || templateId === undefined) return;
    setBusyAction("delete");
    const result = await narratorPromptsApi.remove(templateId);
    setBusyAction(null);
    setPendingDelete(false);
    if (!result.ok) {
      toast.push({ title: "Delete failed", description: result.error.message, tone: "error" });
      return;
    }
    closeEditor();
    list.reload({ silent: true });
    // The route reports which chats it cleared, so the confirmation says what
    // actually happened rather than a generic success: a soft delete that
    // silently changed three live conversations is exactly the kind of thing
    // that later reads as a mysterious narrator regression.
    const cleared = result.data.clearedChatIds.length;
    toast.push({
      title: "Prompt deleted",
      description:
        cleared === 0
          ? "No conversation was using it. Replies it already produced keep their provenance."
          : `${usageCountLabel(cleared)} fell back to Vesper’s production narrator prompt, starting with the next reply.`,
      tone: "success",
    });
  };

  if (me.loading && !me.data) {
    return (
      <PageContainer wide>
        <Skeleton className="h-8 w-56" />
      </PageContainer>
    );
  }

  if (me.data?.role !== "admin") {
    return (
      <PageContainer wide>
        <h1 className="prose-display text-2xl">Narrator prompts</h1>
        <p className="mt-2 text-sm text-paper-400">This page is only available to administrators.</p>
      </PageContainer>
    );
  }

  const templates = list.data?.prompts ?? [];
  const pendingNavCopy =
    pendingNav?.kind === "duplicate"
      ? "Duplicate copies the last saved revision, not the edits sitting in your editor. Save first if you want them in the copy."
      : "This prompt has edits you have not saved. There is no autosave here, so leaving now discards them.";

  return (
    <PageContainer wide>
      <header className="mb-6">
        <h1 className="prose-display text-2xl">Narrator prompts</h1>
        <p className="mt-1 max-w-3xl text-sm text-paper-400">
          Handwritten narrator instructions you can run in one conversation and compare against another. A prompt
          saved here replaces the narrator’s behavior and craft instructions; Vesper keeps supplying the character
          sheet, world and relationship state, memory, the constraints for the turn, and the response format. Every
          save creates a new immutable revision, so an older reply can still be traced to the exact text that produced
          it.
        </p>
      </header>

      <div className="grid gap-8 lg:grid-cols-[19rem_minmax(0,1fr)]">
        <div className="lg:sticky lg:top-16 lg:self-start">
          <NarratorPromptLibrary
            templates={templates}
            loading={list.loading}
            error={list.error}
            selectedId={selectedId}
            onReload={() => list.reload()}
            onSelect={(templateId) => requestNav({ kind: "select", templateId })}
            onNew={() => requestNav({ kind: "new" })}
          />
        </div>

        {session !== null ? (
          <NarratorPromptEditor
            session={session}
            dirty={dirty}
            busyAction={busyAction}
            conflict={conflict}
            nameError={nameError}
            bodyError={bodyError}
            onChange={patchDraft}
            onSave={() => void save()}
            onDuplicate={() => requestNav({ kind: "duplicate" })}
            onDelete={() => setPendingDelete(true)}
            onCancelNew={closeEditor}
            onReloadConflict={() => void reloadFromConflict()}
            onDismissConflict={() => setConflict(null)}
          />
        ) : detail.error !== null ? (
          <ErrorState error={detail.error} onRetry={() => detail.reload()} />
        ) : detail.loading && selectedId !== null ? (
          <Skeleton className="h-96 w-full" />
        ) : (
          <EmptyState
            title="No prompt open"
            description="Pick a saved prompt from the library, or start a new one. Nothing here changes a conversation until you select the prompt inside that conversation."
            action={
              <Button variant="primary" onClick={() => requestNav({ kind: "new" })}>
                New prompt
              </Button>
            }
          />
        )}
      </div>

      <Dialog
        open={pendingNav !== null}
        onClose={() => setPendingNav(null)}
        title="Unsaved changes"
        footer={
          <>
            <Button onClick={() => setPendingNav(null)}>Keep editing</Button>
            <Button
              variant="danger"
              onClick={() => {
                if (pendingNav !== null) runNav(pendingNav);
              }}
            >
              Discard and continue
            </Button>
          </>
        }
      >
        {pendingNavCopy}
      </Dialog>

      <Dialog
        open={pendingInUseSave}
        onClose={() => setPendingInUseSave(false)}
        title="This prompt is in use"
        footer={
          <>
            <Button onClick={() => setPendingInUseSave(false)}>Cancel</Button>
            <Button variant="primary" busy={busyAction === "save"} onClick={() => void save(true)}>
              Save anyway
            </Button>
          </>
        }
      >
        <p>{session === null ? "" : inUseSaveWarning(session.usageCount, session.currentRevision + 1)}</p>
        <p className="mt-2 text-paper-400">
          The revision they are on now is kept. It stays attached to the replies it already produced, so nothing
          written down about those replies stops making sense.
        </p>
      </Dialog>

      <Dialog
        open={pendingDelete}
        onClose={() => setPendingDelete(false)}
        title={session === null ? "Delete this prompt?" : `Delete “${session.loaded.name}”?`}
        footer={
          <>
            <Button onClick={() => setPendingDelete(false)}>Cancel</Button>
            <Button variant="danger" busy={busyAction === "delete"} onClick={() => void confirmDelete()}>
              Delete
            </Button>
          </>
        }
      >
        <p>
          It disappears from this library, and any conversation currently using it falls back to Vesper’s production
          narrator prompt on its next reply.
        </p>
        <p className="mt-2 text-paper-400">
          Replies it already produced keep their provenance, so you can still tell which revision wrote them. Nothing
          is purged.
        </p>
        {session !== null && session.usageCount > 0 ? (
          <p className="mt-2 text-danger-300">{`In use by ${usageCountLabel(session.usageCount)} right now.`}</p>
        ) : null}
      </Dialog>
    </PageContainer>
  );
}
