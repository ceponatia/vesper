"use client";

import { useRouter } from "next/navigation";
import { useEffect, useMemo, useRef, useState } from "react";
import { CHARACTER_CREATION_BRIEF_MAX, VISUAL_IMAGE_AGE_ATTRIBUTE_ID, type Diagnostic } from "@/contracts";
import { characterEditorTabs, characterSections, type CharacterEditorTab, type CharacterSheetScope } from "@/lib/character-scopes";
import { charactersApi } from "@/lib/client/api";
import { useSession } from "@/components/auth/auth-client";
import { useAsyncData } from "@/components/hooks/use-async";
import { useAutosave } from "@/components/hooks/use-autosave";
import { PublishToggle } from "@/components/library/publish-toggle";
import { PageContainer } from "@/components/shell/app-shell";
import { ActionMenu } from "@/components/ui/action-menu";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { Disclosure } from "@/components/ui/disclosure";
import { EntityImage } from "@/components/ui/entity-image";
import { ErrorState } from "@/components/ui/error-state";
import { Field } from "@/components/ui/field";
import { SaveBar } from "@/components/ui/save-bar";
import { Skeleton, SkeletonText } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";
import { useToast } from "@/components/ui/toast";
import { CharacterEditor } from "./character-editor";
import { withCreationBrief } from "./character-brief";
import { CharacterProposalReview } from "./character-proposal-review";
import { characterReviewStateSchema, emptyCharacterReview, proposalChanges, reconcileMaterializedUndo } from "./character-proposals";
import { CharacterAuthorRecoveryNotice } from "./character-author-recovery";
import { useCharacterAuthorDraft } from "./use-character-author-draft";
import { CharacterGenerationStatus } from "./character-generation-status";
import { CharacterMediaStatus } from "./character-media-status";
import { isFirstForgeAutoAccept, receiveGenerationReview } from "./character-generation-record";
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
  const [preparing, setPreparing] = useState<"create" | "fill" | "redraft" | "portrait" | null>(null);
  const busyRef = useRef(false);
  const [preparingScope, setPreparingScope] = useState<CharacterSheetScope | null>(null);
  const [tab, setTab] = useState<CharacterEditorTab>("profile");
  const [forgeOpen, setForgeOpen] = useState(false);
  const [briefPrompt, setBriefPrompt] = useState("");
  const briefPrefilled = useRef(false);
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
  const pendingProposalCount = reviewStore.data.pending.length;
  const referencePlanKey = JSON.stringify(
    detail.data?.profile.attributes.find((value) => value.id === VISUAL_IMAGE_AGE_ATTRIBUTE_ID)?.value ?? null,
  );

  useEffect(() => {
    alive.current = true;
    const params = new URLSearchParams(window.location.search);
    const requestedTab = params.get("tab");
    const requestedForge = params.get("forge") === "1";
    if (characterEditorTabs.some((id) => id === requestedTab) || requestedForge) {
      void Promise.resolve().then(() => {
        if (!alive.current) return;
        if (characterEditorTabs.some((id) => id === requestedTab)) setTab(requestedTab as CharacterEditorTab);
        if (requestedForge) setForgeOpen(true);
      });
    }
    return () => { alive.current = false; };
  }, []);

  const generation = useCharacterGeneration(ownerId, { kind: "character", id: characterId }, reviewStore.ready, reviewStore.conflict || author.blocked, reviewStore.data, async (record, actions) => {
    if (reviewStore.isBlocked() || author.isBlocked() || record.ownerId !== ownerId || record.target.id !== characterId || !record.result) return false;
    const result = record.result;
    const firstReceipt = !reviewStore.current.current.pending.some((item) => item.sourceRunId === record.id || item.id === record.id)
      && !reviewStore.current.current.handledIds?.includes(record.id);
    if (isFirstForgeAutoAccept(record, firstReceipt)) {
      const accepted = await actions.decide(
        { sourceRunId: record.id, proposalRevision: record.proposal.revision },
        "accept",
        {},
        { expectedAuthoringRevision: record.source.authoringRevision },
      );
      if (accepted) {
        setForgeDiagnostics(result.diagnostics);
        reviewStore.update((review) => receiveGenerationReview(review, accepted.run));
        await author.refreshServer();
        detail.reload({ silent: true });
        await reviewStore.flush();
        return reviewStore.isPersisted();
      }
      // Refused (e.g. the character changed underneath this run) — fall through
      // and leave it as an ordinary pending proposal for review below.
    }
    const changes = proposalChanges({ id: record.id, label: record.label, base: record.base, proposed: result.proposed, undo: false });
    let projected = record;
    if (record.proposal.status === "unresolved" && changes.length === 0) {
      const current = await charactersApi.get(characterId);
      if (!current.ok) return false;
      const rejected = await actions.decide(
        { sourceRunId: record.id, proposalRevision: record.proposal.revision },
        "reject",
        {},
        { expectedAuthoringRevision: current.data.authoringRevision },
      );
      if (!rejected) return false;
      projected = rejected.run;
    }
    setForgeDiagnostics(result.diagnostics);
    reviewStore.update((review) => receiveGenerationReview(review, projected));
    if (firstReceipt && changes.length === 0) {
      toast.push({
        title: result.portrait?.outcome === "supported_match" ? "Portrait and sheet agree" : "No changes suggested",
        tone: "success",
      });
    }
    if (projected.proposal.status === "accepted" || projected.proposal.status === "undone") {
      await author.refreshServer();
      detail.reload({ silent: true });
    }
    await reviewStore.flush();
    return reviewStore.isPersisted();
  });
  const busy = preparing ?? generation.active?.operation ?? null;
  const scopeBusy = preparingScope ?? generation.active?.scope ?? null;
  const generate = async (mode: "create" | "fill" | "redraft" | "portrait", scope?: CharacterSheetScope) => {
    const currentDraft = author.current.current?.draft;
    if (!currentDraft || busyRef.current || generation.isRunning() || !reviewStore.ready || author.isBlocked() || reviewStore.isBlocked()) return;
    if (mode === "create" && !briefPrompt.trim() && !currentDraft.profile.creationBrief.trim()) return;
    busyRef.current = true;
    setPreparing(mode); setPreparingScope(scope ?? null);
    try {
      // A create run's brief is server-derived (from the saved brief, else the
      // typed prompt), so it never touches draft.profile.creationBrief here.
      if (mode !== "create") {
        const withBrief = withCreationBrief(currentDraft);
        if (withBrief !== currentDraft) changeDraft(withBrief);
      }
      const displayedPortraitId = mode === "portrait" ? detail.data?.avatarImageId ?? null : null;
      if (mode === "portrait" && pendingProposalCount > 0) {
        toast.push({ title: "Review character suggestions first", description: "Portrait completion uses only accepted, saved details.", tone: "error" });
        return;
      }
      const prepared = await author.prepareAction();
      if (!prepared || !alive.current) return;
      if (mode === "portrait" && !displayedPortraitId) {
        toast.push({ title: "Portrait unavailable", description: "Generate or upload a portrait first.", tone: "error" });
        return;
      }
      if (mode === "create") {
        await generation.start({
          operation: "create", scope: null, label: "forged character", base: prepared.draft,
          creationStart: { draft: prepared.draft, prompt: briefPrompt, initialPreview: false },
          source: { authoringRevision: prepared.authoringRevision, imageId: null },
        });
        return;
      }
      const base = prepared.draft;
      const section = scope ? characterSections[scope].label : "character";
      await generation.start({ operation: mode, scope: scope ?? null, base: structuredClone(base), creationStart: null,
        source: { authoringRevision: prepared.authoringRevision, imageId: mode === "portrait" ? displayedPortraitId : null },
        label: mode === "portrait" ? "portrait changes" : mode === "fill" ? `missing ${section} details` : `${section} rewrite` });
    } finally { if (alive.current) { busyRef.current = false; setPreparing(null); setPreparingScope(null); } }
  };

  // Nice-to-have: prefill the brief textarea from the most recent failed or
  // rejected Forge, once, so a retry after a bad first attempt isn't blank.
  useEffect(() => {
    if (briefPrefilled.current || draft?.profile.creationBrief) return;
    const retry = generation.records.find((record) => record.operation === "create"
      && (record.status === "failed" || record.proposal.status === "rejected")
      && record.creationStart?.prompt.trim());
    if (!retry?.creationStart) return;
    briefPrefilled.current = true;
    const prompt = retry.creationStart.prompt;
    void Promise.resolve().then(() => { if (alive.current) setBriefPrompt((current) => current || prompt); });
  }, [generation.records, draft?.profile.creationBrief]);

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
      <CharacterMediaStatus characterId={characterId} onRetry={() => setTab("portrait")} />
      <CharacterGenerationStatus records={generation.records} activeId={generation.active?.id} unavailable={generation.unavailable} blocked={author.blocked || reviewStore.conflict || preparing !== null} onRetry={generation.retry} onDismiss={generation.dismiss} />
      <Disclosure
        title={draft.profile.creationBrief ? "Original brief" : "Creation brief"}
        description={draft.profile.creationBrief ? "Kept as context for later suggestions" : "Describe the character to draft with the Forge"}
        defaultOpen={forgeOpen}
        className="mb-5"
      >
        <Field label={draft.profile.creationBrief ? "Original brief (read only)" : "Describe your character"}>
          {(id) => (
            <Textarea
              id={id}
              rows={5}
              maxLength={CHARACTER_CREATION_BRIEF_MAX}
              value={draft.profile.creationBrief || briefPrompt}
              readOnly={!!draft.profile.creationBrief || busy === "create"}
              onChange={(event) => setBriefPrompt(event.target.value)}
              placeholder="A human woman in her forties, a harbor-master with dry humor, auburn hair and a weathered blue coat…"
            />
          )}
        </Field>
        <Button
          className="mt-3"
          variant={draft.profile.creationBrief ? "ghost" : "primary"}
          busy={busy === "create"}
          disabled={!(briefPrompt.trim() || draft.profile.creationBrief) || busy !== null || author.blocked || !reviewStore.ready || reviewStore.conflict}
          onClick={() => void generate("create")}
        >
          {draft.profile.creationBrief ? "Regenerate character suggestions" : "Forge character"}
        </Button>
        {draft.profile.creationBrief ? (
          <p className="mt-2 text-xs text-paper-400">Use the section actions to refine one part. Regenerating proposes a full replacement for review.</p>
        ) : null}
      </Disclosure>
      <CharacterProposalReview draft={draft} review={reviewStore.data} onReviewChange={reviewStore.update} onChange={changeDraft}
        onDecision={async (proposal, action, choices) => {
          let expectedAuthoringRevision: number | undefined;
          if (action === "accept" || action === "reject" || action === "undo") {
            const prepared = await author.prepareAction();
            if (!prepared) return null;
            expectedAuthoringRevision = prepared.authoringRevision;
          }
          const decided = await generation.decide(proposal, action, choices, {
            ...(expectedAuthoringRevision === undefined ? {} : { expectedAuthoringRevision }),
          });
          if (!decided) {
            toast.push({ title: "Review changed", description: "The saved character or proposal changed. Review the latest values and try again.", tone: "error" });
            await author.refreshServer();
            return null;
          }
          if (action === "accept" || action === "undo") {
            await author.refreshServer();
            detail.reload({ silent: true });
          }
          return { applyLocally: false, appliedDraft: null, undo: decided.run.proposal.undo };
        }}
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
        referencePlanKey={referencePlanKey}
        {...(detail.data ? { acceptance: detail.data.acceptance } : {})}
        onAvatarChanged={() => { void author.refreshServer(); detail.reload({ silent: true }); }}
        chatModel={chatModel}
        onChatModelChange={changeChatModel}
        onRedraft={(scope) => void generate("redraft", scope)}
        redrafting={busy === "redraft" ? scopeBusy : null}
        onComplete={(scope) => void generate("fill", scope)}
        completing={busy === "fill" ? scopeBusy : null}
        generationDisabled={busy !== null || !reviewStore.ready || reviewStore.conflict || author.blocked}
        pendingProposalCount={pendingProposalCount}
        preparePortraitGeneration={author.prepareAction}
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
      <ConfirmDialog
        open={confirmDelete}
        onClose={() => setConfirmDelete(false)}
        onConfirm={remove}
        title="Delete this character?"
        busy={deleting}
      >
        This removes {draft.name || "the character"} from your library. Sessions keep their own snapshots.
      </ConfirmDialog>
    </PageContainer>
  );
}
