"use client";

import { useRouter } from "next/navigation";
import { useEffect, useMemo, useRef, useState } from "react";
import type { Diagnostic } from "@/contracts";
import { characterEditorTabs, characterSections, type CharacterEditorTab, type CharacterSheetScope } from "@/lib/character-scopes";
import { charactersApi } from "@/lib/client/api";
import { useSession } from "@/components/auth/auth-client";
import { useAsyncData } from "@/components/hooks/use-async";
import { useAutosave } from "@/components/hooks/use-autosave";
import { PublishToggle } from "@/components/library/publish-toggle";
import { PageContainer } from "@/components/shell/app-shell";
import { ActionMenu } from "@/components/ui/action-menu";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { EntityImage } from "@/components/ui/entity-image";
import { ErrorState } from "@/components/ui/error-state";
import { SaveBar } from "@/components/ui/save-bar";
import { Skeleton, SkeletonText } from "@/components/ui/skeleton";
import { useToast } from "@/components/ui/toast";
import { CharacterEditor } from "./character-editor";
import { withCreationBrief } from "./character-creation-draft";
import { CharacterProposalReview } from "./character-proposal-review";
import { characterReviewStateSchema, emptyCharacterReview, proposalChanges, reconcileMaterializedUndo } from "./character-proposals";
import { CharacterAuthorRecoveryNotice } from "./character-author-recovery";
import { useCharacterAuthorDraft } from "./use-character-author-draft";
import { CharacterGenerationStatus } from "./character-generation-status";
import { hasReceivedGeneration, receiveGenerationReview } from "./character-generation-record";
import { useCharacterGeneration } from "./use-character-generation";
import { useCharacterDraftStorage } from "./use-character-draft-storage";

export function CharacterEditPage({ characterId }: { characterId: string }) {
  const session = useSession();
  const ownerId = session.data?.user.id;
  if (!ownerId) return <PageContainer><SkeletonText lines={6} /></PageContainer>;
  // Param navigation and account changes remount every draft, queue and async guard.
  return <CharacterEditSession key={`${ownerId}:${characterId}`} characterId={characterId} ownerId={ownerId} />;
}

function CharacterEditSession({ characterId, ownerId }: { characterId: string; ownerId: string }) {
  const router = useRouter();
  const toast = useToast();
  const detail = useAsyncData(() => charactersApi.get(characterId), [characterId]);
  const [preparing, setPreparing] = useState<"fill" | "redraft" | "portrait" | null>(null);
  const busyRef = useRef(false);
  const [preparingScope, setPreparingScope] = useState<CharacterSheetScope | null>(null);
  const [tab, setTab] = useState<CharacterEditorTab>("profile");
  const [forgeDiagnostics, setForgeDiagnostics] = useState<readonly Diagnostic[]>([]);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [cloning, setCloning] = useState(false);
  const alive = useRef(true);
  const reviewStore = useCharacterDraftStorage(`vesper:character-review:${ownerId}:${characterId}`, characterReviewStateSchema, emptyCharacterReview);
  const author = useCharacterAuthorDraft(characterId, ownerId, detail.data ?? null, (sent, saved, diagnostics) => {
    reviewStore.update((review) => reconcileMaterializedUndo(review, sent, saved.profile));
    if (alive.current) { setForgeDiagnostics(diagnostics); detail.reload({ silent: true }); }
  });
  const { draft, chatModel, dirty, saving, save, changeDraft, changeChatModel } = author;

  useEffect(() => {
    alive.current = true;
    const requested = new URLSearchParams(window.location.search).get("tab");
    if (characterEditorTabs.some((id) => id === requested)) {
      void Promise.resolve().then(() => { if (alive.current) setTab(requested as CharacterEditorTab); });
    }
    return () => { alive.current = false; };
  }, []);

  const generation = useCharacterGeneration(ownerId, { kind: "character", id: characterId }, reviewStore.ready, reviewStore.conflict || author.blocked, reviewStore.data, async (record) => {
    if (reviewStore.isBlocked() || author.isBlocked() || record.ownerId !== ownerId || record.target.id !== characterId || !record.result) return false;
    if (!hasReceivedGeneration(reviewStore.current.current, record.id)) {
      setForgeDiagnostics(record.result.diagnostics);
      reviewStore.update((review) => receiveGenerationReview(review, record));
      if (!proposalChanges({ id: record.id, label: record.label, base: record.base, proposed: record.result.proposed, undo: false }).length) toast.push({ title: "No changes suggested", tone: "success" });
    }
    await reviewStore.flush();
    return reviewStore.isPersisted();
  });
  const busy = preparing ?? generation.active?.operation ?? null;
  const scopeBusy = preparingScope ?? generation.active?.scope ?? null;
  const generate = async (mode: "fill" | "redraft" | "portrait", scope?: CharacterSheetScope) => {
    const currentDraft = author.current.current?.draft;
    if (!currentDraft || busyRef.current || generation.isRunning() || !reviewStore.ready || author.isBlocked() || reviewStore.isBlocked()) return;
    busyRef.current = true;
    setPreparing(mode); setPreparingScope(scope ?? null);
    try {
      const withBrief = withCreationBrief(currentDraft);
      if (withBrief !== currentDraft) changeDraft(withBrief);
      if (!(await save({ silent: true })) || !alive.current) return;
      const base = author.current.current?.draft;
      if (!base) return;
      const section = scope ? characterSections[scope].label : "character";
      generation.start({ operation: mode, scope: scope ?? null, base: structuredClone(base), creationStart: null,
        label: mode === "portrait" ? "portrait changes" : mode === "fill" ? `missing ${section} details` : `${section} rewrite` });
    } finally { if (alive.current) { busyRef.current = false; setPreparing(null); setPreparingScope(null); } }
  };

  const clone = async () => {
    if (cloning || author.isBlocked()) return;
    if (!(await save()) || !alive.current) return;
    setCloning(true);
    const result = await charactersApi.clone(characterId);
    if (!alive.current) return;
    setCloning(false);
    if (result.ok) { toast.push({ title: "Character duplicated", tone: "success" }); router.push(`/characters/${result.data.id}`); }
    else toast.push({ title: "Duplicate failed", description: result.error.message, tone: "error" });
  };
  const autosaveSignal = useMemo(() => ({ draft, chatModel }), [draft, chatModel]);
  const autosave = useAutosave({ enabled: (detail.data?.mine ?? false) && !author.blocked, dirty, saving, save: () => save({ silent: true }), signal: autosaveSignal });
  const remove = async () => {
    setDeleting(true);
    await author.settled();
    const result = await charactersApi.remove(characterId);
    if (!alive.current) return;
    setDeleting(false);
    if (result.ok) { toast.push({ title: "Character deleted" }); router.push("/characters"); }
    else { toast.push({ title: "Delete failed", description: result.error.message, tone: "error" }); setConfirmDelete(false); }
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

  // Someone else's public character: read-only preview + duplicate CTA (the
  // item/location slice-6 pattern). The live editor once rendered here and
  // every autosave 404'd server-side ("character not found" toasts) — the
  // owner-scoped PATCH was always going to reject it.
  if (detail.data && !detail.data.mine) {
    const profile = detail.data.profile;
    return (
      <PageContainer>
        <div className="mb-6 flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between sm:gap-4">
          <h1 className="prose-display min-w-0 truncate text-2xl">{detail.data.name || "Untitled character"}</h1>
          <div className="flex flex-wrap items-center gap-3">
            <Button onClick={() => router.push(`/chat?new=${characterId}`)}>Chat</Button>
            <Button variant="primary" busy={cloning} disabled={author.blocked} onClick={() => void clone()}>
              Duplicate to my library
            </Button>
          </div>
        </div>
        <div className="flex flex-col gap-4 rounded-card border border-ink-700 bg-ink-850 p-4 text-sm text-paper-300 sm:flex-row">
          <EntityImage
            imageId={detail.data.avatarImageId}
            name={detail.data.name}
            className="h-44 w-32 shrink-0 rounded-md"
          />
          <div className="flex min-w-0 flex-col gap-3">
            <p className="text-paper-400">
              Someone else&apos;s public character — duplicate it to edit your own copy, or start a chat as-is.
            </p>
            {detail.data.tags.length ? <p className="text-xs text-paper-500">{detail.data.tags.join(" · ")}</p> : null}
            {profile.age ? <p className="text-xs text-paper-500">Age: {profile.age}</p> : null}
            {profile.bio ? <p>{profile.bio}</p> : null}
            {profile.personality ? <p className="text-paper-400">{profile.personality}</p> : null}
          </div>
        </div>
      </PageContainer>
    );
  }

  return (
    <PageContainer>
      <div className="mb-6 flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between sm:gap-4">
        <h1 className="prose-display min-w-0 truncate text-2xl">{draft.name || "Untitled character"}</h1>
        <div className="flex flex-wrap items-center gap-3">
          <Button
            variant="primary"
            onClick={() => void generate("fill")}
            busy={busy === "fill"}
            disabled={busy !== null || author.blocked || !reviewStore.ready || reviewStore.conflict}
            title="Propose missing details for review. Your existing values stay unchanged."
          >
            Complete all missing details
          </Button>
          {detail.data ? <PublishToggle kind="character" id={characterId} visibility={detail.data.visibility} onChanged={() => { void author.refreshServer(); detail.reload({ silent: true }); }} /> : null}
          <ActionMenu
            label="Character actions"
            items={[
              {
                label: "Duplicate",
                onSelect: () => void clone(),
                busy: cloning,
                disabled: busy !== null || author.blocked,
              },
              { label: "Delete character", onSelect: () => setConfirmDelete(true), danger: true },
            ]}
          />
        </div>
      </div>
      {reviewStore.notice ? <p role="status" className="mb-3 text-sm text-warning">{reviewStore.notice}</p> : null}
      {reviewStore.conflict || reviewStore.recoveries.length ? <div className="mb-3 flex flex-wrap gap-2"><Button onClick={() => reviewStore.resume()}>Resume saved review</Button>{reviewStore.recoveries.map((copy) => <Button key={copy.key} onClick={() => reviewStore.resume(copy.key)}>Recover review from {copy.label}</Button>)}</div> : null}
      {author.storage.notice ? <p role="status" className="mb-3 text-sm text-warning">{author.storage.notice}</p> : null}
      {author.storage.conflict || author.storage.recoveries.length ? <div className="mb-3 flex flex-wrap gap-2">
        <Button disabled={saving} onClick={() => void author.resumeBrowser()}>Resume latest browser edits</Button>
        {author.storage.recoveries.map((copy) => <Button key={copy.key} disabled={saving} onClick={() => void author.resumeBrowser(copy.key)}>Recover edits from {copy.label}</Button>)}
        <Button disabled={saving} onClick={() => void author.resetToServer()}>Use saved character</Button>
      </div> : null}
      {author.recovery ? <CharacterAuthorRecoveryNotice key={author.recovery.id} recovery={author.recovery} disabled={saving || author.storage.conflict} onRestore={author.resolveRecovery} onDiscard={() => void author.discardRecovery()} /> : null}
      <CharacterGenerationStatus records={generation.records} activeId={generation.active?.id} unavailable={generation.unavailable} blocked={author.blocked || reviewStore.conflict || preparing !== null} onRetry={generation.retry} onDismiss={generation.dismiss} />
      <CharacterProposalReview draft={draft} review={reviewStore.data} onReviewChange={reviewStore.update} onChange={changeDraft}
        disabled={!reviewStore.ready || reviewStore.conflict || author.blocked} isBlocked={() => reviewStore.isBlocked() || author.isBlocked()} />
      <div onBlur={autosave.onBlur}>
      <fieldset disabled={author.blocked} className="min-w-0">
      <CharacterEditor
        draft={draft}
        onChange={changeDraft}
        tab={tab}
        onTabChange={setTab}
        characterId={characterId}
        avatarImageId={detail.data?.avatarImageId ?? null}
        {...(detail.data ? { acceptance: detail.data.acceptance } : {})}
        onAvatarChanged={() => { void author.refreshServer(); detail.reload({ silent: true }); }}
        chatModel={chatModel}
        onChatModelChange={changeChatModel}
        onRedraft={(scope) => void generate("redraft", scope)}
        redrafting={busy === "redraft" ? scopeBusy : null}
        onComplete={(scope) => void generate("fill", scope)}
        completing={busy === "fill" ? scopeBusy : null}
        generationDisabled={busy !== null || !reviewStore.ready || reviewStore.conflict || author.blocked}
        saving={saving}
        onPortraitAttributes={() => void generate("portrait")}
        derivingPortrait={busy === "portrait"}
        diagnostics={forgeDiagnostics}
      />
      </fieldset>
      </div>
      <SaveBar
        dirty={dirty}
        saving={saving}
        disabled={author.blocked}
        status={author.blocked ? "Resolve recovered edits to save" : undefined}
        onSave={() => { if (!author.isBlocked()) void save(); }}
      />
      <Dialog
        open={confirmDelete}
        onClose={() => setConfirmDelete(false)}
        title="Delete this character?"
        footer={
          <>
            <Button onClick={() => setConfirmDelete(false)}>Cancel</Button>
            <Button variant="danger" busy={deleting} onClick={remove}>
              Delete
            </Button>
          </>
        }
      >
        This removes {draft.name || "the character"} from your library. Sessions keep their own snapshots.
      </Dialog>
    </PageContainer>
  );
}
