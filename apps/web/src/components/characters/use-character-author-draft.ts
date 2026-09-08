"use client";

import type { Diagnostic } from "@/contracts";
import { useCallback, useEffect, useRef, useState } from "react";
import { charactersApi, type CharacterDetail, type CharacterDraft } from "@/lib/client/api";
import { characterSaveConflictSchema } from "@/lib/client/api/library";
import { parseOrNull } from "@/lib/parse";
import { useToast } from "@/components/ui/toast";
import { authorRecoveryDisposition, authorSnapshotFromDetail, characterAuthorRecoverySchema, emptyAuthorRecovery, rebaseAuthorRecovery, reconcileCharacterSave, sameAuthorSnapshot, type CharacterAuthorRecovery, type CharacterAuthorSnapshot } from "./character-author-draft";
import type { ProposalChoices } from "./character-proposals";
import { useCharacterDraftStorage } from "./use-character-draft-storage";

export interface AuthorRecoveryReview { id: string; record: CharacterAuthorRecovery; server: CharacterAuthorSnapshot; updatedAt: string | null }

/** Ordinary edits have their own versioned browser record, independent of AI review.
 * An acknowledgment advances its baseline; failed/unmounted writes leave it recoverable. */
export function useCharacterAuthorDraft(characterId: string, ownerId: string, detail: CharacterDetail | null, onSaved: (sent: CharacterDraft, saved: CharacterDetail, diagnostics: readonly Diagnostic[]) => void) {
  const storage = useCharacterDraftStorage(`vesper:character-author:${ownerId}:${characterId}`, characterAuthorRecoverySchema, emptyAuthorRecovery);
  const toast = useToast();
  const [authored, setAuthored] = useState<CharacterAuthorSnapshot | null>(null);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [transitioning, setTransitioning] = useState(false);
  const transitionRef = useRef(false);
  const writeCount = useRef(0);
  const [recovery, setRecovery] = useState<AuthorRecoveryReview | null>(null);
  const current = useRef<CharacterAuthorSnapshot | null>(null);
  const baseline = useRef<{ snapshot: CharacterAuthorSnapshot; updatedAt: string | null } | null>(null);
  const pending = useRef<AuthorRecoveryReview | null>(null);
  const initialized = useRef(false);
  const alive = useRef(true);
  const dirtyRef = useRef(false);
  const tail = useRef<Promise<boolean>>(Promise.resolve(true));
  const callbacks = useRef(onSaved);
  const cleanupSave = useRef<() => Promise<boolean>>(async () => false);
  useEffect(() => { callbacks.current = onSaved; }, [onSaved]);
  useEffect(() => { alive.current = true; return () => { alive.current = false; void cleanupSave.current(); }; }, []);

  const load = useCallback((serverDetail: CharacterDetail, stored: CharacterAuthorRecovery | null) => {
    const server = authorSnapshotFromDetail(serverDetail);
    const updatedAt = serverDetail.updatedAt;
    const disposition = stored && serverDetail.mine ? authorRecoveryDisposition(server, updatedAt, stored) : "acknowledged";
    baseline.current = { snapshot: server, updatedAt };
    const next = disposition === "resume" && stored ? stored.authored : server;
    current.current = next;
    const review = disposition === "review" && stored ? { id: crypto.randomUUID(), record: stored, server, updatedAt } : null;
    pending.current = review;
    dirtyRef.current = disposition === "resume";
    if (alive.current) { setAuthored(next); setDirty(dirtyRef.current); setRecovery(review); }
    if (disposition === "acknowledged" && stored && serverDetail.mine) void storage.clear(storage.revision.current);
  }, [storage.clear, storage.revision]);

  useEffect(() => {
    if (!detail || !storage.ready || initialized.current) return;
    let cancelled = false;
    void Promise.resolve().then(() => {
      if (cancelled || !alive.current || initialized.current) return;
      initialized.current = true;
      load(detail, storage.current.current);
    });
    return () => { cancelled = true; };
  }, [detail, storage.ready, storage.current, load]);

  const persist = (snapshot: CharacterAuthorSnapshot) => {
    if (!baseline.current) return;
    storage.update({ base: baseline.current.snapshot, authored: snapshot, serverUpdatedAt: baseline.current.updatedAt });
  };
  const change = (snapshot: CharacterAuthorSnapshot) => {
    if (pending.current || storage.isBlocked() || transitionRef.current) return;
    current.current = snapshot;
    dirtyRef.current = true;
    setAuthored(snapshot);
    setDirty(true);
    persist(snapshot);
  };

  const save = (options: { silent?: boolean } = {}): Promise<boolean> => {
    writeCount.current += 1;
    const operation = tail.current.then(async () => {
      if (!current.current || !baseline.current || pending.current || storage.isBlocked() || !storage.ready || transitionRef.current) return false;
      if (!dirtyRef.current) return true;
      await storage.flush();
      if (storage.isBlocked()) return false;
      if (alive.current) setSaving(true);
      // The server compares this version while holding the row lock. A conflict
      // includes its current row, so recovery needs no racy follow-up GET.
      if (!baseline.current.updatedAt) {
        if (alive.current) toast.push({ title: "Save paused", description: "The saved character version is unavailable. Reload to recover your browser edits safely.", tone: "error" });
        return false;
      }
      let sent = current.current;
      const patch = () => charactersApi.update(characterId, { name: sent.draft.name, tags: sent.draft.tags, profile: sent.draft.profile, suggestedItems: sent.draft.suggestedItems, chatModel: sent.chatModel, expectedUpdatedAt: baseline.current!.updatedAt });
      let response = await patch();
      if (!response.ok) {
        const changed = parseOrNull(characterSaveConflictSchema, response.error.body);
        if (changed && sameAuthorSnapshot(authorSnapshotFromDetail(changed.character), baseline.current.snapshot)) {
          baseline.current = { snapshot: baseline.current.snapshot, updatedAt: changed.character.updatedAt };
          sent = current.current;
          persist(sent);
          response = await patch();
        }
      }
      if (!response.ok) {
        const conflict = parseOrNull(characterSaveConflictSchema, response.error.body);
        if (conflict) {
          const record: CharacterAuthorRecovery = { base: baseline.current.snapshot, authored: current.current, serverUpdatedAt: baseline.current.updatedAt };
          const review = { id: crypto.randomUUID(), record, server: authorSnapshotFromDetail(conflict.character), updatedAt: conflict.character.updatedAt };
          pending.current = review;
          if (alive.current) setRecovery(review);
        } else if (alive.current) toast.push({ title: "Save failed", description: `${response.error.message} Your edits are retained in this browser.`, tone: "error" });
        return false;
      }
      const acknowledged = authorSnapshotFromDetail(response.data.character);
      callbacks.current(sent.draft, response.data.character, response.data.diagnostics);
      const latest = current.current;
      const reconciled = { draft: reconcileCharacterSave(latest.draft, sent.draft, acknowledged.draft, response.data.materializedSuggestions), chatModel: latest.chatModel === sent.chatModel ? acknowledged.chatModel : latest.chatModel };
      baseline.current = { snapshot: acknowledged, updatedAt: response.data.character.updatedAt };
      current.current = reconciled;
      dirtyRef.current = !sameAuthorSnapshot(reconciled, acknowledged);
      if (alive.current) { setAuthored(reconciled); setDirty(dirtyRef.current); }
      if (dirtyRef.current) storage.update({ base: acknowledged, authored: reconciled, serverUpdatedAt: response.data.character.updatedAt });
      else await storage.clear(storage.revision.current);
      // A new edit may land during clear: it already published its own UI state.
      if (alive.current && !options.silent) toast.push({ title: "Character saved", tone: "success" });
      return true;
    }).catch(() => { if (alive.current) toast.push({ title: "Save failed", description: "Your browser draft is retained for retry.", tone: "error" }); return false; })
      .finally(() => { writeCount.current -= 1; if (alive.current && !writeCount.current) setSaving(false); });
    tail.current = operation;
    return operation;
  };
  useEffect(() => { cleanupSave.current = () => save({ silent: true }); });

  const resolveRecovery = (choices: ProposalChoices, modelChoice?: "current" | "proposed") => {
    if (!pending.current || storage.isBlocked() || transitionRef.current || writeCount.current) return;
    const review = pending.current;
    const next = rebaseAuthorRecovery(review.server, review.record, choices, modelChoice);
    if (!next) return;
    baseline.current = { snapshot: review.server, updatedAt: review.updatedAt };
    pending.current = null;
    setRecovery(null);
    current.current = next;
    dirtyRef.current = !sameAuthorSnapshot(next, review.server);
    setAuthored(next);
    setDirty(dirtyRef.current);
    persist(next);
    if (!dirtyRef.current) void storage.clear(storage.revision.current);
  };
  const discardRecovery = async () => {
    if (!pending.current || storage.isBlocked() || transitionRef.current || writeCount.current) return;
    const review = pending.current;
    if (!(await storage.clear(storage.revision.current)) || !alive.current || pending.current !== review) return;
    baseline.current = { snapshot: review.server, updatedAt: review.updatedAt };
    pending.current = null;
    current.current = review.server;
    dirtyRef.current = false;
    setRecovery(null); setAuthored(review.server); setDirty(false);
  };
  const refreshServer = async () => {
    await tail.current;
    if (!alive.current || !baseline.current || !current.current || pending.current || storage.isBlocked()) return;
    const fresh = await charactersApi.get(characterId);
    if (!fresh.ok || !alive.current || !baseline.current || !current.current || pending.current || writeCount.current) return;
    if (fresh.data.updatedAt && baseline.current.updatedAt && Date.parse(fresh.data.updatedAt) < Date.parse(baseline.current.updatedAt)) return;
    const server = authorSnapshotFromDetail(fresh.data);
    if (sameAuthorSnapshot(server, baseline.current.snapshot)) {
      baseline.current = { snapshot: server, updatedAt: fresh.data.updatedAt };
      if (dirtyRef.current) persist(current.current);
      return;
    }
    if (!dirtyRef.current) { load(fresh.data, null); return; }
    const record = { base: baseline.current.snapshot, authored: current.current, serverUpdatedAt: baseline.current.updatedAt };
    const review = { id: crypto.randomUUID(), record, server, updatedAt: fresh.data.updatedAt };
    pending.current = review; setRecovery(review);
  };
  const resumeBrowser = async (copyKey?: string) => {
    if (writeCount.current || transitionRef.current) return;
    transitionRef.current = true; setTransitioning(true);
    try {
      // Resolve the server first; a failed GET must not replace storage beneath
      // the old visible draft and allow it to save as the newly resumed version.
      const fresh = await charactersApi.get(characterId);
      if (!alive.current) return;
      if (!fresh.ok) { toast.push({ title: "Couldn't check the saved character", description: "Your recovered edits are retained. Try again.", tone: "error" }); return; }
      if (await storage.resume(copyKey)) load(fresh.data, storage.current.current);
    } finally { transitionRef.current = false; if (alive.current) setTransitioning(false); }
  };
  const resetToServer = async () => {
    if (writeCount.current || transitionRef.current) return;
    transitionRef.current = true; setTransitioning(true);
    try {
      const fresh = await charactersApi.get(characterId);
      if (!alive.current) return;
      if (!fresh.ok) { toast.push({ title: "Couldn't load the saved character", tone: "error" }); return; }
      storage.reset();
      load(fresh.data, null);
    } finally { transitionRef.current = false; if (alive.current) setTransitioning(false); }
  };
  return { draft: authored?.draft ?? null, chatModel: authored?.chatModel ?? "", dirty, saving, recovery, storage, current,
    blocked: !storage.ready || storage.conflict || recovery !== null || transitioning,
    changeDraft: (draft: CharacterDraft) => { if (current.current) change({ ...current.current, draft }); },
    changeChatModel: (chatModel: string) => { if (current.current) change({ ...current.current, chatModel }); },
    save, resolveRecovery, discardRecovery, resumeBrowser, resetToServer, refreshServer, isBlocked: () => !storage.ready || storage.isBlocked() || pending.current !== null || transitionRef.current, settled: () => tail.current,
  };
}
