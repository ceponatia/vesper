"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { CHARACTER_CREATION_BRIEF_MAX, type Diagnostic } from "@/contracts";
import { characterSections, type CharacterSheetScope } from "@/lib/character-scopes";
import { charactersApi, emptyCharacterDraft, type CharacterDraft } from "@/lib/client/api";
import { characterCreationMismatchSchema, characterSaveConflictSchema } from "@/lib/client/api/library";
import { parseOrNull } from "@/lib/parse";
import { useSession } from "@/components/auth/auth-client";
import { PageContainer } from "@/components/shell/app-shell";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { Disclosure } from "@/components/ui/disclosure";
import { Field } from "@/components/ui/field";
import { SaveBar } from "@/components/ui/save-bar";
import { SkeletonText } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";
import { useToast } from "@/components/ui/toast";
import { CharacterEditor } from "./character-editor";
import { characterCreationStateSchema, completeCreationForge, creationForgeStart, emptyCharacterCreation, prepareCreationSave, recoverCreationMismatch, savedCreationHref, withCreationBrief } from "./character-creation-draft";
import { CharacterProposalReview } from "./character-proposal-review";
import { readDraft, writeDraft } from "./character-draft-storage";
import { characterReviewStateSchema, proposalChanges, reconcileMaterializedUndo, transferCreationReview } from "./character-proposals";
import { authorSnapshotFromDetail, rebaseAuthorRecovery, reconcileCharacterSave, sameAuthorSnapshot } from "./character-author-draft";
import { CharacterAuthorRecoveryNotice } from "./character-author-recovery";
import { CharacterGenerationStatus } from "./character-generation-status";
import { hasReceivedGeneration, receiveGenerationReview } from "./character-generation-record";
import { useCharacterGeneration } from "./use-character-generation";
import { useCharacterDraftStorage } from "./use-character-draft-storage";

/** New and Forge are two entry points into the same account-scoped creation draft. */
export function CharacterForgePage({ mode = "forge" }: { mode?: "forge" | "manual" }) {
  const session = useSession();
  const ownerId = session.data?.user.id;
  if (!ownerId) return <PageContainer><SkeletonText lines={6} /></PageContainer>;
  return <CharacterCreationSession key={ownerId} ownerId={ownerId} mode={mode} />;
}

function CharacterCreationSession({ ownerId, mode }: { ownerId: string; mode: "forge" | "manual" }) {
  const router = useRouter();
  const toast = useToast();
  const store = useCharacterDraftStorage(`vesper:character-creation:${ownerId}`, characterCreationStateSchema, emptyCharacterCreation);
  const { draft, prompt, review, tab } = store.data;
  const [diagnostics, setDiagnostics] = useState<readonly Diagnostic[]>([]);
  const [saving, setSaving] = useState(false);
  const [confirmNew, setConfirmNew] = useState(false);
  const active = useRef(true);
  const saveInFlight = useRef(false);
  useEffect(() => { active.current = true; return () => { active.current = false; }; }, []);

  const conflict = store.data.serverConflict;
  const creationRecovery = conflict ? {
    id: `${store.data.id}:${conflict.updatedAt}`,
    server: conflict.snapshot,
    updatedAt: conflict.updatedAt,
    record: { base: store.data.serverSnapshot ?? { draft: emptyCharacterDraft(), chatModel: conflict.snapshot.chatModel }, authored: { draft, chatModel: store.data.serverSnapshot?.chatModel ?? conflict.snapshot.chatModel }, serverUpdatedAt: store.data.serverUpdatedAt },
  } : null;
  const changeDraft = (next: CharacterDraft) => { if (!store.current.current.serverConflict) store.update((current) => ({ ...current, draft: next })); };
  const generation = useCharacterGeneration(ownerId, { kind: "creation", id: store.data.id }, store.ready, store.conflict || !!creationRecovery, store.data, async (record) => {
    if (store.isBlocked() || store.current.current.serverConflict || store.current.current.id !== record.target.id || record.ownerId !== ownerId || !record.result) return false;
    if (!hasReceivedGeneration(store.current.current.review, record.id)) {
      setDiagnostics(record.result.diagnostics);
      if (record.operation === "create" && record.creationStart) {
        const next = completeCreationForge(store.current.current, record.creationStart, record.base, record.result.proposed, record.id);
        const staged = hasReceivedGeneration(next.review, record.id);
        store.update(staged ? next : { ...next, review: { ...next.review, handledIds: [...(next.review.handledIds ?? []), record.id] } });
      } else store.update((current) => ({ ...current, review: receiveGenerationReview(current.review, record) }));
      if (!proposalChanges({ id: record.id, label: record.label, base: record.base, proposed: record.result.proposed, undo: false }).length) toast.push({ title: "No changes suggested", tone: "success" });
    }
    await store.flush();
    return store.isPersisted();
  });
  const busy = generation.active?.operation ?? null;
  const scopeBusy = generation.active?.scope ?? null;
  useEffect(() => {
    const warn = (event: BeforeUnloadEvent) => { if (saving || busy || store.notice) event.preventDefault(); };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [saving, busy, store.notice]);
  const generate = (kind: "create" | "fill" | "redraft", scope?: CharacterSheetScope) => {
    if (!store.ready || generation.isRunning() || saveInFlight.current || store.isBlocked() || store.current.current.serverConflict) return;
    const started = store.current.current;
    if (kind === "create" && !started.prompt.trim() && !started.draft.profile.creationBrief.trim()) return;
    const base = withCreationBrief(structuredClone(started.draft), started.prompt);
    if (kind !== "create") store.update((current) => ({ ...current, draft: base }));
    const section = scope ? characterSections[scope].label : "character";
    generation.start({ operation: kind, scope: scope ?? null, base, source: null, creationStart: kind === "create" ? creationForgeStart(started) : null,
      label: kind === "create" ? "forged character" : kind === "fill" ? `missing ${section} details` : `${section} rewrite` });
  };

  const save = async (destination: "portrait" | "chat" | null = null) => {
    if (!store.ready || saveInFlight.current || generation.isRunning() || store.isBlocked() || store.current.current.serverConflict) return;
    saveInFlight.current = true;
    setSaving(true);
    // Keep the requested next step with any retained draft, including failed transfers.
    store.update((current) => prepareCreationSave(current, destination));
    try {
      await store.flush();
      if (store.isBlocked()) return;
      const snapshot = store.current.current;
      const savedRevision = store.revision.current;
      const authored = snapshot.savedCharacterId ? withCreationBrief(snapshot.draft, snapshot.prompt) : snapshot.initialSaveDraft;
      if (!authored) {
        if (active.current) toast.push({ title: "Save paused", description: "The retained creation snapshot is unavailable. Your current draft is still here.", tone: "error" });
        return;
      }
      if (snapshot.savedCharacterId && (!snapshot.serverUpdatedAt || !snapshot.serverSnapshot)) {
        const fresh = await charactersApi.get(snapshot.savedCharacterId);
        if (!fresh.ok) { if (active.current) toast.push({ title: "Save paused", description: "Could not check the saved character. Your draft is retained.", tone: "error" }); return; }
        if (store.current.current.id === snapshot.id) store.update((current) => ({ ...current, serverConflict: { snapshot: authorSnapshotFromDetail(fresh.data), updatedAt: fresh.data.updatedAt } }));
        return;
      }
      const body = { name: authored.name || "Untitled character", tags: authored.tags, profile: authored.profile, suggestedItems: authored.suggestedItems };
      let result = snapshot.savedCharacterId
        ? await charactersApi.update(snapshot.savedCharacterId, { ...body, expectedUpdatedAt: snapshot.serverUpdatedAt })
        : await charactersApi.createDraft({ ...body, creationRequestId: snapshot.id });
      if (!result.ok && snapshot.savedCharacterId) {
        const changed = parseOrNull(characterSaveConflictSchema, result.error.body);
        if (changed && snapshot.serverSnapshot && sameAuthorSnapshot(authorSnapshotFromDetail(changed.character), snapshot.serverSnapshot)) {
          result = await charactersApi.update(snapshot.savedCharacterId, { ...body, expectedUpdatedAt: changed.character.updatedAt });
        }
      }
      if (!result.ok) {
        const creationMismatch = !snapshot.savedCharacterId
          ? parseOrNull(characterCreationMismatchSchema, result.error.body)
          : null;
        if (creationMismatch && store.current.current.id === snapshot.id) {
          store.update((current) => recoverCreationMismatch(
            current,
            creationMismatch.recovery.created.character,
            creationMismatch.recovery.character,
          ));
          await store.flush();
          if (active.current) toast.push({
            title: "Saved character found",
            description: "This draft is now linked to the character already created from it. Review your retained edits before saving again.",
            tone: "success",
          });
          return;
        }
        const changed = parseOrNull(characterSaveConflictSchema, result.error.body);
        if (store.current.current.id === snapshot.id && changed) store.update((current) => ({ ...current, serverConflict: { snapshot: authorSnapshotFromDetail(changed.character), updatedAt: changed.character.updatedAt } }));
        else {
          if (result.error.code === "invalid_body" && !snapshot.savedCharacterId && store.current.current.id === snapshot.id) store.update((current) => ({ ...current, initialSaveDraft: null }));
          if (active.current) toast.push({ title: "Save failed", description: result.error.message, tone: "error" });
        }
        return;
      }
      const saved = result.data;
      const characterId = saved.character.id;
      const unchanged = store.current.current.id === snapshot.id && store.revision.current === savedRevision;
      if (store.current.current.id !== snapshot.id) return;
      const acknowledged = authorSnapshotFromDetail(saved.character);
      const materialized = saved.materializedSuggestions;
      store.update((current) => ({ ...current, savedCharacterId: characterId, serverSnapshot: acknowledged, serverUpdatedAt: saved.character.updatedAt,
        draft: reconcileCharacterSave(current.draft, authored, acknowledged.draft, materialized), review: reconcileMaterializedUndo(current.review, authored, acknowledged.draft.profile), materializingDraft: null, initialSaveDraft: null }));
      const authoredMatchesSaved = JSON.stringify(store.current.current.draft) === JSON.stringify(acknowledged.draft);
      const boundRevision = store.revision.current;
      const carriedReview = store.current.current.review;
      await store.flush();
      if (store.isBlocked()) return;
      // Saving the authored draft carries pending reviews forward without accepting them.
      try {
        const reviewKey = `vesper:character-review:${ownerId}:${characterId}`;
        const carryReview = () => {
          const raw = localStorage.getItem(reviewKey);
          const existing = readDraft(raw, characterReviewStateSchema)?.data;
          if (raw && !existing) return "conflict" as const;
          const transferred = transferCreationReview(existing, carriedReview, snapshot.id);
          return writeDraft(localStorage, reviewKey, raw, JSON.stringify({ revision: crypto.randomUUID(), savedAt: Date.now(), data: transferred }));
        };
        const stored = navigator.locks ? await navigator.locks.request(reviewKey, carryReview) : carryReview();
        if (stored !== "saved") {
          if (active.current) toast.push({ title: "Character saved", description: "Pending reviews stay in this creation draft because another review version exists or browser storage is unavailable.", tone: "success" });
          return;
        }
      } catch {
        if (active.current) toast.push({ title: "Character saved", description: "Browser review storage is unavailable. This creation draft stays open so you can finish reviewing.", tone: "success" });
        return;
      }
      if (generation.hasOutstanding() || !unchanged || !authoredMatchesSaved || store.current.current.id !== snapshot.id || store.revision.current !== boundRevision) {
        if (active.current) toast.push({ title: "Snapshot saved", description: "Your edits and any unfinished generation remain in this draft. Open the saved character using the link below.", tone: "success" });
        return;
      }
      const cleared = await store.clear(boundRevision);
      if (!active.current) return;
      if (!cleared) {
        toast.push({ title: "Character saved", description: "The browser draft is kept because its stored version changed or storage is unavailable.", tone: "success" });
        return;
      }
      router.push(savedCreationHref(store.current.current) ?? `/characters/${characterId}`);
    } finally { if (active.current) { setSaving(false); saveInFlight.current = false; } }
  };

  if (!store.ready) return <PageContainer><SkeletonText lines={6} /></PageContainer>;
  const savedHref = savedCreationHref(store.data);
  return (
    <PageContainer>
      <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
        <h1 className="prose-display text-2xl">{draft.name || (mode === "forge" ? "Character forge" : "New character")}</h1>
        <Button variant="ghost" onClick={() => setConfirmNew(true)} disabled={saving}>Start a new draft</Button>
      </div>
      <p className="mb-5 text-sm text-paper-400">This draft resumes on this browser for your account. Edit by hand or ask the Forge for suggestions, then save to your library.</p>
      {store.notice ? <p role="status" className="mb-3 text-sm text-warning">{store.notice}</p> : null}
      {store.conflict || store.recoveries.length ? <div className="mb-4 flex flex-wrap gap-2"><Button disabled={saving || busy !== null} onClick={() => store.resume()}>Resume latest draft</Button>{store.recoveries.map((copy) => <Button key={copy.key} disabled={saving || busy !== null} onClick={() => store.resume(copy.key)}>Recover draft from {copy.label}</Button>)}</div> : null}
      {savedHref ? <p className="mb-4 text-sm"><Link className="text-accent-300 underline" href={savedHref}>Open saved character{store.data.saveDestination === "chat" ? " in Chat" : store.data.saveDestination === "portrait" ? " in Portrait Studio" : ""}</Link></p> : null}
      {creationRecovery ? <CharacterAuthorRecoveryNotice key={creationRecovery.id} recovery={creationRecovery} disabled={saving || store.conflict}
        title={conflict?.reason === "creation_mismatch" ? "Saved character found" : undefined}
        description={conflict?.reason === "creation_mismatch" ? "This creation request already saved a character. Your retained draft is linked to it; review the differences before saving again." : undefined}
        onRestore={(choices, modelChoice) => {
        if (store.isBlocked() || saveInFlight.current || store.current.current.serverConflict !== conflict) return;
        const restored = rebaseAuthorRecovery(creationRecovery.server, creationRecovery.record, choices, modelChoice);
        if (restored) store.update((current) => ({ ...current, draft: restored.draft, serverSnapshot: creationRecovery.server, serverUpdatedAt: creationRecovery.updatedAt, serverConflict: null }));
      }} onDiscard={() => {
        if (!store.isBlocked() && !saveInFlight.current && store.current.current.serverConflict === conflict) store.update((current) => ({ ...current, draft: creationRecovery.server.draft, serverSnapshot: creationRecovery.server, serverUpdatedAt: creationRecovery.updatedAt, serverConflict: null }));
      }} /> : null}
      <CharacterGenerationStatus records={generation.records} activeId={generation.active?.id} unavailable={generation.unavailable} blocked={store.conflict || !!creationRecovery || saving} onRetry={generation.retry} onDismiss={generation.dismiss} />
      <Disclosure title={draft.profile.creationBrief ? "Original creation brief" : "Creation brief"} description={draft.profile.creationBrief ? "Kept as context for later suggestions" : "Describe the character to draft with the Forge"} defaultOpen={mode === "forge"} className="mb-5">
        <Field label={draft.profile.creationBrief ? "Original brief (read only)" : "Describe your character"}>{(id) => <Textarea id={id} rows={5} maxLength={CHARACTER_CREATION_BRIEF_MAX} value={draft.profile.creationBrief || prompt} readOnly={!!draft.profile.creationBrief || busy === "create"} onChange={(event) => store.update((current) => ({ ...current, prompt: event.target.value }))} placeholder="A human woman in her forties, a harbor-master with dry humor, auburn hair and a weathered blue coat…" />}</Field>
        <Button className="mt-3" variant={draft.profile.creationBrief ? "ghost" : "primary"} busy={busy === "create"} disabled={!(prompt.trim() || draft.profile.creationBrief) || busy !== null || saving || store.conflict || !!creationRecovery} onClick={() => void generate("create")}>{draft.profile.creationBrief ? "Regenerate character suggestions" : "Forge character suggestions"}</Button>
        {draft.profile.creationBrief ? <p className="mt-2 text-xs text-paper-400">Use the section actions to refine one part. Starting a new draft creates a new original brief.</p> : null}
      </Disclosure>
      <CharacterProposalReview draft={draft} review={review} onReviewChange={(next) => store.update((current) => ({ ...current, review: next }))} onChange={changeDraft} disabled={!store.ready || store.conflict || !!creationRecovery} isBlocked={() => store.isBlocked() || !!store.current.current.serverConflict} />
      <div className="mb-4"><Button busy={busy === "fill" && scopeBusy === null} disabled={busy !== null || saving || store.conflict || !!creationRecovery} onClick={() => void generate("fill")}>Complete all missing details</Button></div>
      <fieldset disabled={!!creationRecovery} className="min-w-0">
      <CharacterEditor draft={draft} onChange={changeDraft} tab={tab} onTabChange={(next) => store.update((current) => ({ ...current, tab: next }))}
        onComplete={(scope) => void generate("fill", scope)} completing={busy === "fill" ? scopeBusy : null}
        onRedraft={(scope) => void generate("redraft", scope)} redrafting={busy === "redraft" ? scopeBusy : null}
        generationDisabled={busy !== null || saving || store.conflict || !!creationRecovery}
        saving={saving || busy !== null} onSaveAndOpen={(destination) => void save(destination)}
        diagnostics={diagnostics.filter((item) => item.severity !== "info")} />
      </fieldset>
      <SaveBar dirty={busy === null && !store.conflict} saving={saving} disabled={!!creationRecovery} status={creationRecovery ? "Resolve recovered edits to save" : undefined} onSave={() => void save()} saveLabel="Save authored character" />
      <Dialog open={confirmNew} onClose={() => setConfirmNew(false)} title="Start a new character draft?" footer={<><Button onClick={() => setConfirmNew(false)}>Keep editing</Button><Button variant="primary" onClick={() => {
        generation.records.forEach(generation.dismiss); setDiagnostics([]); store.reset(); setConfirmNew(false);
      }}>Start new draft</Button></>}>
        This replaces this browser&apos;s current creation draft and pending suggestions. Save the character first if you want to keep it in your library.
      </Dialog>
    </PageContainer>
  );
}
